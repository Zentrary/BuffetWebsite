// Fetch a session bill, render its order lines, and request staff assistance.
(() => {
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('sessionId') || localStorage.getItem('sessionId');
  const socket = typeof io === 'function' ? io() : null;
  const loading = document.getElementById('checkout-loading');
  const content = document.getElementById('checkout-content');
  const errorElement = document.getElementById('checkout-error');
  const requestButton = document.getElementById('request-checkout');
  const spinner = document.getElementById('checkout-spinner');
  let sessionData = null;
  let checkoutRequested = false;
  let countdownTimer = null;
  let paymentRedirected = false;
  let lastBillData = null;
  let lastOrdersData = [];

  function currency(amount) {
    return `฿${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(amount) || 0)}`;
  }
  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  async function api(path, options = {}) {
    const response = await fetch(path, options);
    const payload = await response.json();
    if (!response.ok || payload.success === false) {
      throw new Error((payload.code && T(`error.${payload.code}`)) || payload.message || T('error.REQUEST_FAILED'));
    }
    return payload;
  }

  function goToFeedback() {
    if (paymentRedirected) return;
    paymentRedirected = true;
    window.location.replace(`/feedback.html?sessionId=${encodeURIComponent(sessionId)}`);
  }

  function renderBill(bill, orders) {
    lastBillData = bill;
    lastOrdersData = orders;
    const orderContainer = document.getElementById('checkout-orders');
    orderContainer.replaceChildren();
    let itemCount = 0;
    for (const order of orders) {
      for (const item of order.items || []) {
        if (item.itemStatus === 'cancelled' || order.status === 'cancelled') continue;
        itemCount += 1;
        const row = document.createElement('div');
        row.className = 'flex justify-between gap-4 text-sm';
        row.innerHTML = `<span class="min-w-0">${escapeHTML(item.name)} × ${Number(item.quantity) || 0}</span><span class="shrink-0 font-medium">${currency((Number(item.price) || 0) * (Number(item.quantity) || 0))}</span>`;
        orderContainer.append(row);
      }
    }
    document.getElementById('checkout-no-orders').classList.toggle('hidden', itemCount > 0);
    document.getElementById('bill-subtotal').textContent = currency(bill.subtotal);
    document.getElementById('bill-service').textContent = currency(bill.serviceCharge);
    document.getElementById('bill-vat').textContent = currency(bill.vat);
    document.getElementById('bill-total').textContent = currency(bill.grandTotal);
    const discount = Number(bill.discount) || 0;
    document.getElementById('discount-row').classList.toggle('hidden', discount <= 0);
    document.getElementById('bill-discount').textContent = `-${currency(discount)}`;
    const serviceLabel = document.querySelector('[data-bill-service-label]');
    const vatLabel = document.querySelector('[data-bill-vat-label]');
    const serviceMode = bill.serviceChargeMode === 'excluded' ? T('checkout.serviceExcluded') : T('checkout.serviceIncluded');
    const vatMode = bill.vatMode === 'excluded' ? T('checkout.vatExcluded') : T('checkout.vatIncluded');
    if (serviceLabel) serviceLabel.textContent = T('checkout.serviceLabel', { mode: serviceMode });
    if (vatLabel) vatLabel.textContent = T('checkout.vatLabel', { mode: vatMode });
  }

  function updateCountdown(endTime) {
    const remainingSeconds = Math.max(0, Math.ceil((new Date(endTime).getTime() - Date.now()) / 1000));
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = String(remainingSeconds % 60).padStart(2, '0');
    document.getElementById('checkout-countdown').textContent = `${minutes}:${seconds}`;
    document.getElementById('checkout-time-message').textContent = remainingSeconds > 0
      ? T('checkout.timeRunning')
      : T('checkout.timeExpired');
  }

  async function loadBill() {
    if (!sessionId) {
      window.location.replace('/queue.html?from=menu');
      return;
    }
    localStorage.setItem('sessionId', sessionId);
    try {
      const [billResponse, ordersResponse, sessionResponse] = await Promise.all([
        api('/api/payment/calculate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) }),
        api(`/api/order/session/${encodeURIComponent(sessionId)}`),
        api(`/api/session/${encodeURIComponent(sessionId)}`),
      ]);
      sessionData = sessionResponse.data;
      checkoutRequested = Boolean(sessionData.checkoutRequestedAt);

      if (sessionData.isPaid || sessionData.status === 'completed') {
        goToFeedback();
        return;
      }

      let tableNumber = sessionData.tableId && sessionData.tableId.tableNumber;
      if (!tableNumber) {
        const tableId = sessionData.tableId
          ? (typeof sessionData.tableId === 'object' ? sessionData.tableId._id : sessionData.tableId)
          : null;
        if (tableId) {
          try {
            const tablesRes = await fetch('/api/table', { cache: 'no-store' });
            const tablesPayload = await tablesRes.json();
            const match = (tablesPayload.data || []).find((t) => String(t._id) === String(tableId));
            if (match) tableNumber = match.tableNumber;
          } catch {}
        }
      }
      document.getElementById('checkout-table-number').textContent = tableNumber ? `${T('queue.table')} ${tableNumber}` : T('checkout.noTable');
      updateCountdown(sessionData.endTime);
      window.clearInterval(countdownTimer);
      countdownTimer = window.setInterval(() => updateCountdown(sessionData.endTime), 1000);
      renderBill(billResponse.data, Array.isArray(ordersResponse.data) ? ordersResponse.data : []);
      content.classList.remove('hidden');
      loading.classList.add('hidden');
      if (checkoutRequested) {
        requestButton.classList.add('hidden');
        document.getElementById('wait-staff').classList.remove('hidden');
        document.getElementById('resume-dining').classList.toggle(
          'hidden',
          sessionData.status !== 'active'
            || new Date(sessionData.endTime).getTime() <= Date.now()
            || sessionData.isPaid
        );
      }
    } catch (error) {
      loading.classList.add('hidden');
      errorElement.textContent = error.message || T('error.REQUEST_FAILED');
      errorElement.classList.remove('hidden');
    }
  }

  if (sessionId) {
    document.getElementById('back-to-menu').addEventListener('click', async () => {
      if (checkoutRequested) {
        try {
          await api(`/api/session/${encodeURIComponent(sessionId)}/resume`, { method: 'POST' });
          window.location.assign(`/menu.html?sessionId=${encodeURIComponent(sessionId)}`);
        } catch (error) {
          window.location.assign('/');
        }
        return;
      }
      window.location.assign(`/menu.html?sessionId=${encodeURIComponent(sessionId)}`);
    });
  }

  const confirmModal = document.getElementById('checkout-confirm-modal');
  const confirmOk = document.getElementById('checkout-confirm-ok');
  const confirmCancel = document.getElementById('checkout-confirm-cancel');

  function openConfirm() { confirmModal.classList.replace('hidden', 'flex'); }
  function closeConfirm() {
    confirmModal.classList.replace('flex', 'hidden');
    confirmOk.disabled = false;
    confirmOk.textContent = T('checkout.confirmOk');
  }

  requestButton.addEventListener('click', openConfirm);
  confirmCancel.addEventListener('click', closeConfirm);

  confirmOk.addEventListener('click', async () => {
    confirmOk.disabled = true;
    confirmOk.textContent = T('common.loading');
    requestButton.disabled = true;
    spinner.classList.remove('hidden');
    try {
      await api(`/api/session/${encodeURIComponent(sessionId)}/checkout`, { method: 'POST' });
      closeConfirm();
      checkoutRequested = true;
      if (typeof schedulePoll === 'function') schedulePoll();
      errorElement.classList.add('hidden');
      document.getElementById('wait-staff').classList.remove('hidden');
      requestButton.classList.add('hidden');
      const resumeButton = document.getElementById('resume-dining');
      const canResume = sessionData
        && sessionData.status === 'active'
        && new Date(sessionData.endTime).getTime() > Date.now()
        && !sessionData.isPaid;
      resumeButton.classList.toggle('hidden', !canResume);
    } catch (error) {
      errorElement.textContent = error.message || T('error.REQUEST_FAILED');
      errorElement.classList.remove('hidden');
      requestButton.disabled = false;
      closeConfirm();
    } finally {
      spinner.classList.add('hidden');
    }
  });

  document.getElementById('resume-dining').addEventListener('click', async () => {
    const resumeButton = document.getElementById('resume-dining');
    resumeButton.disabled = true;
    try {
      await api(`/api/session/${encodeURIComponent(sessionId)}/resume`, { method: 'POST' });
      window.location.assign(`/menu.html?sessionId=${encodeURIComponent(sessionId)}`);
    } catch (error) {
      if (String(error.message || '').includes('ชำระ') || String(error.message || '').includes('หมด')) {
        goToFeedback();
        return;
      }
      errorElement.textContent = error.message || T('error.REQUEST_FAILED');
      errorElement.classList.remove('hidden');
      resumeButton.disabled = false;
    }
  });

  if (socket) {
    socket.on('connect', () => {
      socket.emit('joinRoom', 'customer');
      if (sessionId) socket.emit('joinSession', sessionId);
    });
    socket.on('payment_completed', (payload) => {
      if (!payload || String(payload.sessionId) !== String(sessionId)) return;
      goToFeedback();
    });
    socket.on('bill_updated', (payload) => {
      if (!payload || String(payload.sessionId) !== String(sessionId)) return;
      loadBill();
    });
    socket.on('connect_error', () => console.warn('Staff request connection is unavailable.'));
  }

  let pollTimer = null;
  function schedulePoll() {
    if (pollTimer) window.clearInterval(pollTimer);
    const interval = checkoutRequested ? 2000 : 5000;
    pollTimer = window.setInterval(async () => {
      if (paymentRedirected || !sessionId) {
        if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
        return;
      }
      try {
        const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
        const payload = await res.json();
        if (payload && payload.success && payload.data) {
          if (payload.data.isPaid || payload.data.status === 'completed') {
            goToFeedback();
            return;
          }
          if (lastBillData && Number(payload.data.discount || 0) !== Number(lastBillData.discount || 0)) {
            await loadBill();
          }
        }
      } catch {}
    }, interval);
  }
  schedulePoll();

  if (socket) {
    socket.on('reconnect', async () => {
      if (paymentRedirected || !sessionId) return;
      try {
        const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
        const payload = await res.json();
        if (payload && payload.success && payload.data && (payload.data.isPaid || payload.data.status === 'completed')) {
          goToFeedback();
        }
      } catch {}
    });
  }

  window.addEventListener('languageChanged', () => {
    if (lastBillData) renderBill(lastBillData, lastOrdersData);
    if (sessionData) updateCountdown(sessionData.endTime);
    document.getElementById('checkout-time-message').textContent = T('checkout.timeRunning');
  });

  loadBill();
})();