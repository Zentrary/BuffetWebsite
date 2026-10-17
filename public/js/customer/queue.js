// Handle the customer queue form, cancel flow, and live queue-call notifications.
(() => {
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);
  const form = document.getElementById('queue-form');
  const submitButton = document.getElementById('queue-submit');
  const spinner = document.getElementById('queue-spinner');
  const submitLabel = document.getElementById('queue-submit-label');
  const errorElement = document.getElementById('queue-error');
  const result = document.getElementById('queue-result');
  const recoveryForm = document.getElementById('queue-recovery-form');
  const recoveryInput = document.getElementById('queue-recovery-input');
  const recoverySubmit = document.getElementById('queue-recovery-submit');
  const confirmButton = document.getElementById('queue-confirm');
  const countdownElement = document.getElementById('queue-countdown');
  const confirmModal = document.getElementById('queue-confirm-modal');
  const confirmSummary = document.getElementById('queue-confirm-summary');
  const confirmGoBack = document.getElementById('queue-confirm-goback');
  const confirmSubmit = document.getElementById('queue-confirm-submit');
  const zoneSection = document.getElementById('zone-section');
  const cancelQueueButton = document.getElementById('queue-cancel');
  const cancelQueueModal = document.getElementById('queue-cancel-modal');
  const cancelQueueGoback = document.getElementById('queue-cancel-goback');
  const cancelQueueConfirm = document.getElementById('queue-cancel-confirm');
  const cancelQueueNumber = document.getElementById('cancel-queue-number');

  const socket = typeof io === 'function' ? io() : null;
  let activeQueueId = localStorage.getItem('activeQueueId') || sessionStorage.getItem('activeQueueId');
  let accessToken = localStorage.getItem('queueAccessToken')
    || (/^[a-f\d]{24}$/i.test(activeQueueId || '') ? activeQueueId : null);
  let queuePollTimer = null;
  let isCheckingQueue = false;
  let isConfirmingQueue = false;
  let isCancellingQueue = false;
  let queueEndTime = null;
  let pendingPayload = null;

  if (new URLSearchParams(window.location.search).get('from') === 'menu') {
    document.getElementById('menu-access-notice').classList.remove('hidden');
  }

  function setLoading(loading) {
    submitButton.disabled = loading;
    spinner.classList.toggle('hidden', !loading);
    submitLabel.textContent = loading ? T('queue.submit') : T('queue.submit');
  }

  function showError(message) {
    errorElement.textContent = message;
    errorElement.classList.remove('hidden');
  }

  function hideError() {
    errorElement.classList.add('hidden');
  }

  function hideCancelButton() {
    if (cancelQueueButton) cancelQueueButton.classList.add('hidden');
  }

  function showCancelButton() {
    if (cancelQueueButton) cancelQueueButton.classList.remove('hidden');
  }

  function renderQueue(queue) {
    document.getElementById('queue-number').textContent = queue.queueNumber || '—';
    document.getElementById('queue-ahead').textContent = String(Number(queue.waitingAhead) || 0);
    document.getElementById('queue-remaining').textContent = String(Number(queue.waitingCount) || 0);
    result.classList.remove('hidden');
    form.classList.add('hidden');
    if (zoneSection) zoneSection.classList.add('hidden');
    recoveryForm.classList.add('hidden');
    confirmButton.classList.add('hidden');
    countdownElement.classList.add('hidden');
    hideCancelButton();

    if (queue.status === 'cancelled' || queue.status === 'no_show') {
      clearQueueState();
      form.classList.remove('hidden');
      if (zoneSection) zoneSection.classList.remove('hidden');
      recoveryForm.classList.remove('hidden');
      result.classList.add('hidden');
      document.getElementById('queue-called').classList.add('hidden');
      document.getElementById('queue-access-code').classList.add('hidden');
      if (window.QueueZone) window.QueueZone.reset();
      return;
    }

    if (queue.status === 'seated' && queue.sessionId) {
      clearQueueState();
      document.getElementById('queue-access-code').classList.add('hidden');
      if (queue.endTime) localStorage.setItem('sessionEndTime', queue.endTime);
      localStorage.setItem('sessionId', queue.sessionId);
      document.getElementById('queue-called').textContent =
        `${T('queue.called')}${queue.tableNumber ? ` • ${T('queue.table')} ${queue.tableNumber}` : ''}`;
      document.getElementById('queue-called').classList.remove('hidden');
      document.getElementById('queue-status').textContent = T('queue.openingMenu');
      window.clearInterval(queuePollTimer);
      window.location.assign(`/menu.html?sessionId=${encodeURIComponent(queue.sessionId)}`);
      return;
    }

    if (queue.status === 'called') {
      const calledMessage = `${T('queue.called')}${queue.tableNumber ? ` • ${T('queue.table')} ${queue.tableNumber}` : ''}`;
      document.getElementById('queue-called').textContent = calledMessage;
      document.getElementById('queue-called').classList.remove('hidden');
      const note = queue.assignmentNote ? ` (${queue.assignmentNote})` : '';
      document.getElementById('queue-status').textContent = T('queue.calledInstructions') + note;
      confirmButton.classList.remove('hidden');
      showCancelButton();
      updateCountdown(queue.endTime);
      return;
    }

    queueEndTime = null;
    document.getElementById('queue-called').classList.add('hidden');
    document.getElementById('queue-status').textContent = T('queue.waitingNotice');
    showCancelButton();
  }

  function clearQueueState() {
    localStorage.removeItem('activeQueueId');
    localStorage.removeItem('queueAccessToken');
    sessionStorage.removeItem('activeQueueId');
    activeQueueId = null;
    accessToken = null;
    queueEndTime = null;
    window.clearInterval(queuePollTimer);
    queuePollTimer = null;
  }

  function updateCountdown(endTime) {
    if (!endTime) return;
    queueEndTime = endTime;
    const remaining = Math.max(0, new Date(endTime).getTime() - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    countdownElement.textContent = seconds > 0
      ? T('queue.timerRunning', { time })
      : T('queue.timerExpired');
    countdownElement.classList.remove('hidden');
    confirmButton.disabled = seconds <= 0;
  }

  function saveTicket(queueId, token) {
    activeQueueId = queueId;
    accessToken = token;
    localStorage.setItem('activeQueueId', queueId);
    localStorage.setItem('queueAccessToken', token);
    sessionStorage.removeItem('activeQueueId');
    if (socket && socket.connected) socket.emit('joinQueue', { queueId, accessToken: token });
    refreshQueue();
    if (!queuePollTimer) queuePollTimer = window.setInterval(refreshQueue, 8000);
  }

  async function refreshQueue() {
    if (!activeQueueId || !accessToken || isCheckingQueue) return;
    isCheckingQueue = true;
    try {
      const response = await fetch(`/api/queue/${encodeURIComponent(activeQueueId)}`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        if (response.status === 404) {
          clearQueueState();
          form.classList.remove('hidden');
          if (zoneSection) zoneSection.classList.remove('hidden');
          recoveryForm.classList.remove('hidden');
          result.classList.add('hidden');
          showError(T('queue.notFound'));
          if (window.QueueZone) window.QueueZone.reset();
        }
        throw new Error((payload.code && T(`error.${payload.code}`)) || payload.message || T('error.REQUEST_FAILED'));
      }
      hideError();
      renderQueue(payload.data);
    } catch (error) {
      console.warn('Queue status refresh failed:', error);
      showError(error.message || T('error.REQUEST_FAILED'));
    } finally {
      isCheckingQueue = false;
    }
  }

  // ---- Confirm modal ----

  const ICON_USER = '<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>';
  const ICON_PEOPLE = '<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20a6 6 0 0 1 12 0M15 20a5 5 0 0 1 6-4.9"/></svg>';
  const ICON_ZONE = '<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>';
  const ICON_TABLE = '<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10h18M5 10v10M19 10v10M8 10V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v4"/></svg>';

  function confirmRow({ icon, label, value, highlight = false }) {
    const wrap = document.createElement('div');
    wrap.className = 'flex items-center gap-3 py-3';
    const iconWrap = document.createElement('span');
    iconWrap.className = `flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${highlight ? 'bg-orange-100 text-orange-700' : 'bg-slate-100 text-slate-500'}`;
    iconWrap.innerHTML = icon;
    const labelEl = document.createElement('span');
    labelEl.className = 'min-w-0 flex-1 text-xs font-semibold uppercase tracking-wide text-slate-500';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.className = `shrink-0 text-right text-sm ${highlight ? 'font-black text-orange-700' : 'font-bold text-slate-900'}`;
    valueEl.textContent = value;
    wrap.append(iconWrap, labelEl, valueEl);
    return wrap;
  }

  function openConfirmModal(payload) {
    pendingPayload = payload;
    confirmSummary.replaceChildren();

    confirmSummary.append(confirmRow({
      icon: ICON_USER,
      label: T('queue.name'),
      value: payload.customerName || '—',
    }));
    confirmSummary.append(confirmRow({
      icon: ICON_PEOPLE,
      label: T('queue.partySize'),
      value: `${payload.customerCount} ${T('common.people')}`,
      highlight: true,
    }));
    const zoneLabel = payload.preferredZone
      ? T(`table.zone.${payload.preferredZone}`)
      : T('queue.zone.autoDesc');
    confirmSummary.append(confirmRow({
      icon: ICON_ZONE,
      label: T('queue.zone.sectionTitle'),
      value: zoneLabel,
      highlight: true,
    }));
    if (payload.preferredTableId && payload.preferredTableLabel) {
      confirmSummary.append(confirmRow({
        icon: ICON_TABLE,
        label: T('queue.table'),
        value: payload.preferredTableLabel,
      }));
    }

    confirmModal.classList.replace('hidden', 'flex');
  }

  function closeConfirmModal() {
    confirmModal.classList.replace('flex', 'hidden');
    pendingPayload = null;
  }

  function openCancelModal() {
    if (!activeQueueId) return;
    if (cancelQueueNumber) {
      cancelQueueNumber.textContent = document.getElementById('queue-number').textContent || '—';
    }
    cancelQueueModal.classList.replace('hidden', 'flex');
    if (cancelQueueConfirm) {
      cancelQueueConfirm.disabled = false;
      cancelQueueConfirm.textContent = T('queue.cancelConfirm');
    }
  }

  function closeCancelModal() {
    cancelQueueModal.classList.replace('flex', 'hidden');
    if (cancelQueueConfirm) {
      cancelQueueConfirm.disabled = false;
      cancelQueueConfirm.textContent = T('queue.cancelConfirm');
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    hideError();
    const formData = new FormData(form);
    const count = Number(formData.get('customerCount'));
    if (!Number.isInteger(count) || count < 1 || count > 12) {
      showError(T('error.INVALID_PARTY_SIZE_1_TO_12'));
      return;
    }
    const preferredZone = window.QueueZone ? window.QueueZone.getPreferredZone() : '';
    const preferredTableId = window.QueueZone ? window.QueueZone.getPreferredTableId() : null;
    const preferredTableLabel = preferredTableId
      ? (document.querySelector(`input[name="tableChoice"][value="${preferredTableId}"]`)?.closest('label')?.querySelector('.text-lg')?.textContent || '')
      : '';
    openConfirmModal({
      customerCount: count,
      customerName: String(formData.get('customerName') || '').trim(),
      customerPhone: String(formData.get('customerPhone') || '').trim(),
      preferredZone,
      preferredTableId,
      preferredTableLabel,
    });
  });

  confirmGoBack.addEventListener('click', closeConfirmModal);

  confirmSubmit.addEventListener('click', async () => {
    if (!pendingPayload) return;
    confirmSubmit.disabled = true;
    setLoading(true);
    try {
      const response = await fetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pendingPayload),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error((payload.code && T(`error.${payload.code}`)) || payload.message || T('error.REQUEST_FAILED'));
      }
      closeConfirmModal();
      const queue = payload.data;
      document.getElementById('queue-access-code').textContent = T('queue.recoveryCodeOnce', { code: queue.accessToken });
      document.getElementById('queue-access-code').classList.remove('hidden');
      renderQueue(queue);
      result.scrollIntoView({ behavior: 'smooth', block: 'center' });
      saveTicket(queue._id, queue.accessToken);
    } catch (error) {
      showError(error.message || T('error.REQUEST_FAILED'));
    } finally {
      confirmSubmit.disabled = false;
      setLoading(false);
    }
  });

  recoveryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    recoverySubmit.disabled = true;
    hideError();
    try {
      const response = await fetch('/api/queue/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: recoveryInput.value.trim() }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error((payload.code && T(`error.${payload.code}`)) || payload.message || T('error.REQUEST_FAILED'));
      }
      document.getElementById('queue-access-code').classList.add('hidden');
      saveTicket(payload.data._id, recoveryInput.value.trim());
      renderQueue(payload.data);
    } catch (error) {
      showError(error.message || T('error.REQUEST_FAILED'));
    } finally {
      recoverySubmit.disabled = false;
    }
  });

  confirmButton.addEventListener('click', async () => {
    if (!activeQueueId || !accessToken || isConfirmingQueue) return;
    isConfirmingQueue = true;
    confirmButton.disabled = true;
    try {
      const response = await fetch(`/api/queue/${encodeURIComponent(activeQueueId)}/confirm`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error((payload.code && T(`error.${payload.code}`)) || payload.message || T('error.REQUEST_FAILED'));
      }
      renderQueue(payload.data);
    } catch (error) {
      showError(error.message || T('error.REQUEST_FAILED'));
      confirmButton.disabled = false;
    } finally {
      isConfirmingQueue = false;
    }
  });

  if (cancelQueueButton) cancelQueueButton.addEventListener('click', openCancelModal);
  if (cancelQueueGoback) cancelQueueGoback.addEventListener('click', closeCancelModal);
  if (cancelQueueModal) {
    cancelQueueModal.addEventListener('click', (event) => {
      if (event.target === cancelQueueModal) closeCancelModal();
    });
  }
  if (cancelQueueConfirm) {
    cancelQueueConfirm.addEventListener('click', async () => {
      if (!activeQueueId || !accessToken || isCancellingQueue) return;
      isCancellingQueue = true;
      cancelQueueConfirm.disabled = true;
      cancelQueueConfirm.textContent = T('queue.cancelConfirm');
      try {
        const response = await fetch(`/api/queue/${encodeURIComponent(activeQueueId)}/customer-cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ accessToken }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.success) {
          throw new Error((payload.code && T(`error.${payload.code}`)) || payload.message || T('error.REQUEST_FAILED'));
        }
        closeCancelModal();
        clearQueueState();
        form.classList.remove('hidden');
        if (zoneSection) zoneSection.classList.remove('hidden');
        recoveryForm.classList.remove('hidden');
        result.classList.add('hidden');
        document.getElementById('queue-access-code').classList.add('hidden');
        if (window.QueueZone) window.QueueZone.reset();
        showError(T('queue.cancelled'));
      } catch (error) {
        showError(error.message || T('error.REQUEST_FAILED'));
        cancelQueueConfirm.disabled = false;
      } finally {
        isCancellingQueue = false;
      }
    });
  }

  if (socket) {
    socket.on('connect', () => {
      if (activeQueueId && accessToken) socket.emit('joinQueue', { queueId: activeQueueId, accessToken });
      socket.emit('joinRoom', 'customer');
      refreshQueue();
    });
    socket.on('queue_called', (payload) => {
      if (payload && payload.queue && payload.queue._id === activeQueueId) refreshQueue();
    });
    socket.on('queue_seated', refreshQueue);
    socket.on('queue_board_updated', refreshQueue);
    socket.on('queue_cancelled', (payload) => {
      if (payload && String(payload.queueId) === String(activeQueueId)) {
        clearQueueState();
        form.classList.remove('hidden');
        if (zoneSection) zoneSection.classList.remove('hidden');
        recoveryForm.classList.remove('hidden');
        result.classList.add('hidden');
        if (window.QueueZone) window.QueueZone.reset();
      }
    });
    socket.on('connect_error', () => {
      console.warn('Live queue notifications are temporarily unavailable.');
    });
  }

  const countInput = document.getElementById('customer-count');
  if (countInput && window.QueueZone) {
    countInput.addEventListener('input', () => {
      const count = Number(countInput.value) || 0;
      window.QueueZone.applyCapacityGating(count);
    });
    window.QueueZone.applyCapacityGating(Number(countInput.value) || 1);
  }

  (async () => {
    const urlRecoverId = new URLSearchParams(window.location.search).get('recover');
    if (!urlRecoverId) return;
    if (activeQueueId) return;
    if (!/^[a-f\d]{24}$/i.test(urlRecoverId)) return;
    recoverySubmit.disabled = true;
    try {
      const response = await fetch('/api/queue/recover-by-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueId: urlRecoverId }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error((payload.code && T(`error.${payload.code}`)) || payload.message || T('queue.notFound'));
      }
      saveTicket(payload.data._id, urlRecoverId);
      renderQueue(payload.data);
      const clean = new URL(window.location.href);
      clean.searchParams.delete('recover');
      window.history.replaceState({}, '', clean.pathname + clean.search);
    } catch (error) {
      showError(error.message || T('queue.notFound'));
    } finally {
      recoverySubmit.disabled = false;
    }
  })();

  if (activeQueueId && accessToken) {
    if (localStorage.getItem('activeQueueId') !== activeQueueId) {
      localStorage.setItem('activeQueueId', activeQueueId);
      localStorage.setItem('queueAccessToken', accessToken);
    }
    sessionStorage.removeItem('activeQueueId');
    submitButton.disabled = true;
    submitLabel.textContent = T('queue.restoring');
    result.classList.remove('hidden');
    if (socket && socket.connected) socket.emit('joinQueue', { queueId: activeQueueId, accessToken });
    refreshQueue().finally(() => { submitButton.disabled = false; submitLabel.textContent = T('queue.submit'); });
    queuePollTimer = window.setInterval(refreshQueue, 8000);
  } else if (activeQueueId) {
    localStorage.removeItem('activeQueueId');
    recoveryInput.value = '';
    result.classList.add('hidden');
    form.classList.remove('hidden');
    if (zoneSection) zoneSection.classList.remove('hidden');
    recoveryForm.classList.remove('hidden');
    showError(T('queue.recoveryLabel'));
    activeQueueId = null;
  }
  window.setInterval(() => {
    if (queueEndTime && !countdownElement.classList.contains('hidden')) updateCountdown(queueEndTime);
  }, 1000);
})();