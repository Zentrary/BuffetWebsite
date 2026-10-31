// Recover a queue ticket and confirm the seat after staff calls it.
(() => {
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);
  const statusElement = document.getElementById('scan-status');
  const errorElement = document.getElementById('scan-error');
  const spinner = document.getElementById('scan-spinner');
  const form = document.getElementById('queue-id-form');
  const queueIdInput = document.getElementById('queue-id-input');
  const accessInput = document.getElementById('queue-access-input');
  const confirmButton = document.getElementById('scan-confirm-button');
  const url = new URL(window.location.href);
  const socket = typeof io === 'function' ? io() : null;
  let queueId = url.searchParams.get('queueId') || '';
  let accessToken = localStorage.getItem('queueAccessToken') || url.searchParams.get('accessToken') || '';
  let pollTimer = null;
  let isChecking = false;
  let isConfirming = false;

  if (queueId) queueIdInput.value = queueId;
  if (accessToken) accessInput.value = accessToken;

  function showError(message) {
    errorElement.textContent = message;
    errorElement.classList.remove('hidden');
  }

  async function refreshQueue() {
    if (!queueId || !accessToken || isChecking) return;
    isChecking = true;
    try {
      const response = await fetch(`/api/queue/${encodeURIComponent(queueId)}`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error((payload.code && T(`error.${payload.code}`)) || payload.message || T('error.REQUEST_FAILED'));
      }
      const queue = payload.data;
      if (queue.status === 'seated' && queue.sessionId) {
        localStorage.setItem('sessionId', queue.sessionId);
        if (queue.endTime) localStorage.setItem('sessionEndTime', queue.endTime);
        window.location.assign(`/menu.html?sessionId=${encodeURIComponent(queue.sessionId)}`);
        return;
      }
      const called = queue.status === 'called';
      confirmButton.classList.toggle('hidden', !called);
      statusElement.textContent = called
        ? `${T('queue.called')}${queue.tableNumber ? ` ${T('queue.table')} ${queue.tableNumber}` : ''}`
        : queue.status === 'waiting'
          ? T('scan.waitingForCall')
          : T('scan.waitingForCall');
      if (queue.status === 'cancelled' || queue.status === 'no_show') {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    } catch (error) {
      showError(error.message || T('error.REQUEST_FAILED'));
    } finally {
      isChecking = false;
    }
  }

  function startTracking() {
    queueId = queueIdInput.value.trim();
    accessToken = accessInput.value.trim();
    if (!/^[a-f\d]{24}$/i.test(queueId)
      || !(/^[A-Za-z0-9_-]{32}$/.test(accessToken) || /^[a-f\d]{24}$/i.test(accessToken))) {
      showError(T('error.INVALID_QUEUE_RECOVERY_CODE'));
      return false;
    }
    errorElement.classList.add('hidden');
    statusElement.textContent = T('scan.following');
    if (socket && socket.connected) socket.emit('joinQueue', { queueId, accessToken });
    refreshQueue();
    if (!pollTimer) pollTimer = window.setInterval(refreshQueue, 8000);
    return true;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    startTracking();
  });

  confirmButton.addEventListener('click', async () => {
    if (!queueId || !accessToken || isConfirming) return;
    isConfirming = true;
    confirmButton.disabled = true;
    spinner.classList.remove('hidden');
    try {
      const response = await fetch('/api/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueId, accessToken }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error((payload.code && T(`error.${payload.code}`)) || payload.message || T('error.REQUEST_FAILED'));
      }
      await refreshQueue();
    } catch (error) {
      showError(error.message || T('error.REQUEST_FAILED'));
    } finally {
      isConfirming = false;
      confirmButton.disabled = false;
      spinner.classList.add('hidden');
    }
  });

  if (socket) {
    socket.on('connect', () => {
      if (queueId && accessToken) {
        socket.emit('joinQueue', { queueId, accessToken });
        refreshQueue();
      }
    });
    socket.on('queue_called', (payload) => {
      if (payload && payload.queue && payload.queue._id === queueId) refreshQueue();
    });
    socket.on('queue_seated', refreshQueue);
  }

  window.addEventListener('languageChanged', () => {
    if (queueId && accessToken) refreshQueue();
  });

  if (queueId && accessToken) {
    startTracking();
  }
})();