// TV queue display — public screen, no staff login required.
// The board loads /api/queue/display, refreshes over Socket.IO, and also polls
// periodically so a called queue still appears if the socket connection drops.
(() => {
  'use strict';

  const POLL_INTERVAL_MS = 15000;
  const RETRY_INTERVAL_MS = 6000;
  const MAX_SERVING_CARDS = 8;
  const MAX_WAITING_CHIPS = 14;
  const SOUND_PREFERENCE_KEY = 'queueDisplaySound';

  const T = (key, vars) => (window.t ? window.t(key, vars) : key);

  const dom = {
    serving: document.getElementById('now-serving'),
    waitingCount: document.getElementById('waiting-count'),
    waitingList: document.getElementById('waiting-list'),
    liveIndicator: document.getElementById('live-indicator'),
    liveDot: document.getElementById('live-dot'),
    liveLabel: document.getElementById('live-label'),
    clock: document.getElementById('clock'),
    soundButton: document.getElementById('sound-btn'),
    soundOnIcon: document.getElementById('sound-on-icon'),
    soundOffIcon: document.getElementById('sound-off-icon'),
    audioPrompt: document.getElementById('audio-prompt'),
    fullscreenButton: document.getElementById('fullscreen-btn'),
  };

  const Live = window.LiveUpdates;
  const connection = Live.createStatus({
    element: dom.liveIndicator, label: dom.liveLabel, dot: dom.liveDot,
    intervalMs: POLL_INTERVAL_MS, resources: ['queue'], theme: 'dark',
    baseClass: 'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-bold sm:text-xs',
  });

  let soundEnabled = readPreference(SOUND_PREFERENCE_KEY) !== 'off';
  let audioContext = null;
  let audioArmed = false;

  let socket = null;
  let fetchFailed = false;
  let latestData = null;
  let lastSignature = '';
  let announcedCalled = new Set();
  let hasLoadedOnce = false;

  let refreshInFlight = false;
  let refreshQueued = false;
  let pollTimer = null;
  let retryTimer = null;
  let refreshDebounceTimer = null;
  let clockTimer = null;

  function readPreference(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function writePreference(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage may be blocked */ }
  }

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));
  }

  function translated(key, fallback) {
    const value = T(key);
    return value && value !== key ? value : fallback;
  }

  // ---------------------------------------------------------------------------
  // Header: clock, connection indicator, sound + fullscreen controls
  // ---------------------------------------------------------------------------

  function updateClock() {
    if (!dom.clock) return;
    dom.clock.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
  }

  function updateSoundButton() {
    if (!dom.soundButton) return;
    const label = translated(soundEnabled ? 'display.mute' : 'display.unmute', soundEnabled ? 'Mute' : 'Unmute');
    dom.soundButton.setAttribute('aria-label', label);
    dom.soundButton.setAttribute('aria-pressed', String(soundEnabled));
    dom.soundButton.title = label;
    if (dom.soundOnIcon) dom.soundOnIcon.classList.toggle('hidden', !soundEnabled);
    if (dom.soundOffIcon) dom.soundOffIcon.classList.toggle('hidden', soundEnabled);
  }

  function updateAudioPrompt() {
    if (!dom.audioPrompt) return;
    dom.audioPrompt.classList.toggle('hidden', !soundEnabled || audioArmed);
  }

  // ---------------------------------------------------------------------------
  // Notification sound (Web Audio, same approach as the kitchen/waiter boards)
  // ---------------------------------------------------------------------------

  function ensureAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!audioContext) audioContext = new AudioContextClass();
    return audioContext;
  }

  async function armAudio() {
    if (audioArmed) return;
    const context = ensureAudioContext();
    if (!context) return;
    try {
      if (context.state === 'suspended') await context.resume();
      if (context.state === 'running') {
        audioArmed = true;
        updateAudioPrompt();
      }
    } catch {
      // Browsers only allow audio after a trusted gesture; the prompt stays.
    }
  }

  function playChime() {
    if (!soundEnabled) return;
    const context = audioContext;
    if (!audioArmed || !context || context.state !== 'running') {
      updateAudioPrompt();
      return;
    }

    const tones = [
      { offset: 0, frequency: 880, duration: 0.22 },
      { offset: 0.28, frequency: 1174.66, duration: 0.3 },
      { offset: 0.64, frequency: 880, duration: 0.22 },
      { offset: 0.92, frequency: 1174.66, duration: 0.34 },
    ];

    try {
      for (const tone of tones) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const startAt = context.currentTime + tone.offset;
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(tone.frequency, startAt);
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(0.16, startAt + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + tone.duration);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(startAt);
        oscillator.stop(startAt + tone.duration + 0.02);
      }
    } catch {
      // Audio is decorative; never break the display because of it.
    }
  }

  ['pointerdown', 'touchstart', 'keydown'].forEach((eventName) => {
    document.addEventListener(eventName, armAudio, { passive: true });
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function renderLoading() {
    if (latestData || !dom.serving) return;
    dom.serving.removeAttribute('data-count');
    dom.serving.setAttribute('aria-busy', 'true');
    dom.serving.innerHTML = `
      <div class="serving-empty">
        <p class="serving-empty-hint">${escapeHTML(translated('common.loading', 'Loading...'))}</p>
      </div>`;
  }

  function renderUnavailable() {
    if (!dom.serving) return;
    dom.serving.removeAttribute('data-count');
    dom.serving.setAttribute('aria-busy', 'false');
    dom.serving.innerHTML = `
      <div class="serving-empty">
        <span class="serving-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" class="h-10 w-10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 9v4M12 17h.01"/>
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/>
          </svg>
        </span>
        <p class="serving-empty-title">${escapeHTML(translated('display.loadError', 'Unable to load queue data'))}</p>
        <p class="serving-empty-hint">${escapeHTML(translated('display.loadErrorHint', 'Retrying automatically...'))}</p>
      </div>`;
  }

  function renderEmptyServing() {
    dom.serving.innerHTML = `
      <div class="serving-empty">
        <span class="serving-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" class="h-10 w-10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
        </span>
        <p class="serving-empty-title">${escapeHTML(translated('display.noServing', 'No queue is being served'))}</p>
        <p class="serving-empty-hint">${escapeHTML(translated('display.noServingHint', 'Please wait for your queue number to be called.'))}</p>
      </div>`;
  }

  function servingCardHTML(queue, isNew) {
    const queueNumber = escapeHTML(queue.queueNumber || '—');
    const tableNumber = queue.tableNumber ? escapeHTML(queue.tableNumber) : '';
    const people = Number(queue.customerCount) || 0;
    const zoneKey = queue.zone ? `table.zone.${queue.zone}` : '';
    const zone = zoneKey ? translated(zoneKey, '') : '';
    const peopleLabel = people === 1
      ? translated('common.person', 'person')
      : translated('common.people', 'people');
    const meta = [`${people} ${peopleLabel}`, zone].filter(Boolean).join(' · ');

    const tableLine = tableNumber
      ? `<p class="serving-table"><span>${escapeHTML(translated('queue.table', 'Table'))}</span>${tableNumber}</p>`
      : `<p class="serving-table serving-table-pending">${escapeHTML(translated('display.assigningTable', 'Assigning a table'))}</p>`;

    return `
      <article class="serving-card${isNew ? ' card-flash' : ''}">
        <p class="serving-kicker">${escapeHTML(translated('display.queue', 'Queue'))}</p>
        <p class="serving-number">${queueNumber}</p>
        ${tableLine}
        <p class="serving-people">${escapeHTML(meta)}</p>
      </article>`;
  }

  function renderServing(queues, newlyCalledIds) {
    if (!dom.serving) return;

    if (!queues.length) {
      dom.serving.removeAttribute('data-count');
      dom.serving.setAttribute('aria-busy', 'false');
      renderEmptyServing();
      return;
    }

    const visible = queues.slice(0, MAX_SERVING_CARDS);
    const columns = Math.min(visible.length, 4);
    dom.serving.dataset.count = String(columns);
    dom.serving.setAttribute('aria-busy', 'false');
    dom.serving.innerHTML = visible
      .map((queue) => servingCardHTML(queue, newlyCalledIds.has(String(queue._id || ''))))
      .join('');

    if (queues.length > visible.length) {
      const more = document.createElement('p');
      more.className = 'serving-more';
      more.textContent = translated('display.moreServing', `+${queues.length - visible.length} more`)
        .replace('{count}', String(queues.length - visible.length));
      dom.serving.append(more);
    }
  }

  function renderWaiting(waiting, totalWaiting) {
    if (dom.waitingCount) dom.waitingCount.textContent = String(totalWaiting);
    if (!dom.waitingList) return;
    dom.waitingList.replaceChildren();

    if (!waiting.length) {
      const empty = document.createElement('span');
      empty.className = 'waiting-empty';
      empty.textContent = translated('display.noWaiting', 'No queues waiting');
      dom.waitingList.append(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    waiting.slice(0, MAX_WAITING_CHIPS).forEach((queue) => {
      const chip = document.createElement('span');
      chip.className = 'waiting-chip';
      chip.textContent = queue.queueNumber || '—';
      const people = Number(queue.customerCount) || 0;
      if (people) {
        const count = document.createElement('small');
        count.textContent = `${people}`;
        chip.append(count);
      }
      fragment.append(chip);
    });

    const remaining = Math.max(0, totalWaiting - Math.min(waiting.length, MAX_WAITING_CHIPS));
    if (remaining > 0) {
      const more = document.createElement('span');
      more.className = 'waiting-more';
      more.textContent = translated('display.moreWaiting', `+${remaining} more`)
        .replace('{count}', String(remaining));
      fragment.append(more);
    }
    dom.waitingList.append(fragment);
  }

  function renderData(data) {
    latestData = data;
    const serving = Array.isArray(data.nowServing) ? data.nowServing.slice() : [];
    const waiting = Array.isArray(data.waiting) ? data.waiting : [];
    const totalWaiting = Number.isFinite(Number(data.totalWaiting))
      ? Number(data.totalWaiting)
      : waiting.length;

    const signature = JSON.stringify({
      serving: serving.map((queue) => [
        queue._id, queue.queueNumber, queue.tableNumber, queue.customerCount, queue.zone, queue.calledAt,
      ]),
      waiting: waiting.map((queue) => [queue._id, queue.queueNumber, queue.customerCount]),
      totalWaiting,
    });
    if (signature === lastSignature) return;
    lastSignature = signature;

    // Newest call first so the latest number is the easiest to spot on the TV.
    serving.sort((a, b) => {
      const aTime = a.calledAt ? new Date(a.calledAt).getTime() : 0;
      const bTime = b.calledAt ? new Date(b.calledAt).getTime() : 0;
      return bTime - aTime;
    });

    const newlyCalled = hasLoadedOnce
      ? new Set(serving
        .filter((queue) => !announcedCalled.has(String(queue._id || '')))
        .map((queue) => String(queue._id || '')))
      : new Set();
    serving.forEach((queue) => announcedCalled.add(String(queue._id || '')));
    if (announcedCalled.size > 1000) announcedCalled = new Set();

    renderServing(serving, newlyCalled);
    renderWaiting(waiting, totalWaiting);

    if (hasLoadedOnce && newlyCalled.size && soundEnabled) playChime();
    hasLoadedOnce = true;
  }

  function forceRerender() {
    if (!latestData) {
      if (fetchFailed) renderUnavailable();
      else renderLoading();
      return;
    }
    lastSignature = '';
    renderData(latestData);
  }

  // ---------------------------------------------------------------------------
  // Data loading: Socket.IO events + periodic polling fallback
  // ---------------------------------------------------------------------------

  async function refreshData() {
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }
    refreshInFlight = true;
    clearTimeout(retryTimer);
    retryTimer = null;

    try {
      const { response, payload } = await Live.fetchJSON('/api/queue/display', {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!payload || payload.success === false || !Array.isArray(payload.data?.nowServing) || !Array.isArray(payload.data?.waiting)) {
        throw new Error((payload && payload.message) || 'Invalid queue display payload');
      }
      fetchFailed = false;
      renderData(payload.data);
      connection.success('queue');
    } catch (error) {
      fetchFailed = true;
      connection.failure('queue');
      console.warn('Queue display refresh failed:', error);
      if (!latestData) renderUnavailable();
      clearTimeout(retryTimer);
      retryTimer = setTimeout(refreshData, RETRY_INTERVAL_MS);
    } finally {
      refreshInFlight = false;
      if (refreshQueued) {
        refreshQueued = false;
        setTimeout(refreshData, 120);
      }
    }
  }

  function scheduleRefresh(delay = 250) {
    clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = setTimeout(refreshData, delay);
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!refreshInFlight) refreshData();
    }, POLL_INTERVAL_MS);
  }

  function connectSocket() {
    socket = Live.openSocket({
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
    if (!socket) return;
    socket.on('connect', () => {
      connection.setSocketConnected(true);
      socket.emit('joinRoom', 'customer');
      scheduleRefresh(100);
    });
    socket.on('disconnect', () => connection.setSocketConnected(false));
    socket.on('connect_error', () => connection.setSocketConnected(false));

    // Every queue change emits queue_board_updated to the public customer room.
    ['queue_board_updated', 'queue_called', 'queue_seated', 'queue_cancelled', 'new_queue'].forEach((eventName) => {
      socket.on(eventName, () => scheduleRefresh(200));
    });
  }

  // ---------------------------------------------------------------------------
  // Wire up controls and boot
  // ---------------------------------------------------------------------------

  if (dom.soundButton) {
    dom.soundButton.addEventListener('click', async () => {
      soundEnabled = !soundEnabled;
      writePreference(SOUND_PREFERENCE_KEY, soundEnabled ? 'on' : 'off');
      updateSoundButton();
      updateAudioPrompt();
      if (soundEnabled) {
        await armAudio();
        if (audioArmed) playChime();
      }
    });
  }

  if (dom.fullscreenButton) {
    dom.fullscreenButton.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      } catch {
        // Fullscreen can be blocked by the browser; ignore.
      }
    });
  }

  window.addEventListener('languageChanged', () => {
    updateClock();
    updateSoundButton();
    connection.render();
    forceRerender();
  });

  window.addEventListener('online', () => refreshData());
  window.addEventListener('offline', () => {
    fetchFailed = true;
    connection.failure('queue');
  });

  function start() {
    updateClock();
    clearInterval(clockTimer);
    clockTimer = setInterval(updateClock, 1000);
    updateSoundButton();
    updateAudioPrompt();
    connection.render();
    renderLoading();
    connectSocket();
    refreshData();
    startPolling();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
