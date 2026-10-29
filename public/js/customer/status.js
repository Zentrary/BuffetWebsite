// Show the session progress and per-order status for a customer.
(() => {
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('sessionId') || localStorage.getItem('sessionId');
  const POLL_INTERVAL_MS = 30000;
  const Live = window.LiveUpdates;
  const socket = Live.openSocket();

  const tableLabel = document.getElementById('table-label');
  const queueLabel = document.getElementById('queue-label');
  const sessionStages = document.getElementById('session-stages');
  const ordersList = document.getElementById('orders-list');
  const ordersEmpty = document.getElementById('orders-empty');
  const ordersCount = document.getElementById('orders-count');
  const orderModal = document.getElementById('order-modal');
  const orderModalTitle = document.getElementById('order-modal-title');
  const orderModalSub = document.getElementById('order-modal-sub');
  const orderTimeline = document.getElementById('order-timeline');
  const orderModalItems = document.getElementById('order-modal-items');
  const liveBadge = document.getElementById('live-badge');
  const backLink = document.getElementById('back-link');
  const connection = Live.createStatus({
    element: liveBadge, intervalMs: POLL_INTERVAL_MS, resources: ['session', 'orders'],
    baseClass: 'shrink-0 rounded-full px-3 py-1 text-xs font-bold',
  });

  let sessionData = null;
  let ordersData = [];
  let countdownTimer = null;

  const SESSION_STAGES = [
    { labelKey: 'status.stage.waiting', descKey: 'status.stage.waitingDesc' },
    { labelKey: 'status.stage.called', descKey: 'status.stage.calledDesc' },
    { labelKey: 'status.stage.seated', descKey: 'status.stage.seatedDesc' },
    { labelKey: 'status.stage.pay', descKey: 'status.stage.payDesc' },
  ];

  const ORDER_STAGES = [
    { key: 'pending', labelKey: 'menu.orderStatus.pending', ts: 'createdAt' },
    { key: 'accepted', labelKey: 'menu.orderStatus.accepted', ts: 'acceptedAt' },
    { key: 'cooking', labelKey: 'menu.orderStatus.cooking', ts: 'cookingAt' },
    { key: 'ready', labelKey: 'menu.orderStatus.ready', ts: 'readyAt' },
    { key: 'served', labelKey: 'menu.orderStatus.served', ts: 'servedAt' },
  ];

  const ORDER_INDEX = {
    pending: 0,
    accepted: 1,
    cooking: 2,
    ready: 3,
    served: 4,
    paid: 4,
    cancelled: -1,
  };

  function fmtTime(d) {
    if (!d) return '';
    const date = new Date(d);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function currency(amount) {
    return `฿${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(amount) || 0)}`;
  }

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function stageIndexFromSession(s) {
    if (!s) return 0;
    if (s.isPaid || s.status === 'completed') return 3;
    if (s.checkoutRequestedAt) return 3;
    if (s.status === 'active') return 2;
    return 1;
  }

  function renderStages() {
    const current = stageIndexFromSession(sessionData);
    sessionStages.replaceChildren();
    SESSION_STAGES.forEach((stage, idx) => {
      const isDone = idx < current;
      const isCurrent = idx === current;
      let bg = 'bg-slate-50 border-slate-200 text-slate-400';
      let circle = 'bg-slate-200 text-slate-500';
      if (isDone) {
        bg = 'bg-green-50 border-green-200 text-green-700';
        circle = 'bg-green-500 text-white';
      } else if (isCurrent) {
        bg = 'bg-orange-50 border-orange-300 text-orange-800';
        circle = 'bg-orange-500 text-white';
      }
      const li = document.createElement('li');
      li.className = `flex flex-1 flex-col items-center rounded-xl border-2 px-1.5 py-2.5 text-center ${bg}`;
      li.innerHTML = `
        <span class="flex h-7 w-7 items-center justify-center rounded-full text-xs font-black ${circle}">
          ${isDone ? '✓' : idx + 1}
        </span>
        <span class="mt-1.5 text-xs font-black leading-tight">${escapeHTML(T(stage.labelKey))}</span>
        <span class="mt-0.5 text-[10px] leading-tight opacity-70">${escapeHTML(T(stage.descKey))}</span>`;
      sessionStages.append(li);
    });
  }

  function renderOrders() {
    ordersList.replaceChildren();
    ordersEmpty.classList.toggle('hidden', ordersData.length > 0);
    ordersCount.textContent = String(ordersData.length);
    for (const order of ordersData) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'flex w-full items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-left transition hover:border-orange-300 hover:bg-orange-50';
      const stage = ORDER_INDEX[order.status] ?? 0;
      const label = order.status === 'cancelled'
        ? T('menu.orderStatus.cancelled')
        : T(ORDER_STAGES[Math.min(Math.max(stage, 0), ORDER_STAGES.length - 1)].labelKey);
      const badgeClass = order.status === 'cancelled'
        ? 'bg-red-100 text-red-800'
        : (order.status === 'served' || order.status === 'paid')
          ? 'bg-green-100 text-green-800'
          : 'bg-orange-100 text-orange-900';
      card.innerHTML = `
        <div class="min-w-0">
          <p class="font-bold text-slate-800">${escapeHTML(T('menu.orderId', { id: String(order._id || '').slice(-6) }))}</p>
          <p class="mt-0.5 text-xs text-slate-500">${fmtTime(order.createdAt)} · ${currency(order.totalPrice)}</p>
        </div>
        <span class="shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs font-bold ${badgeClass}">${escapeHTML(label)}</span>`;
      card.addEventListener('click', () => openOrderModal(order));
      ordersList.append(card);
    }
  }

  function openOrderModal(order) {
    orderModalTitle.textContent = T('menu.orderId', { id: String(order._id || '').slice(-6) });
    orderModalSub.textContent = `${fmtTime(order.createdAt)} · ${currency(order.totalPrice)}`;

    const current = order.status === 'cancelled' ? -1 : (ORDER_INDEX[order.status] ?? 0);

    orderTimeline.replaceChildren();
    ORDER_STAGES.forEach((stage, idx) => {
      const done = order.status !== 'cancelled' && idx <= current;
      const isCurrent = order.status !== 'cancelled' && idx === current;
      const dot = done ? 'bg-green-500' : isCurrent ? 'bg-orange-500' : 'bg-slate-300';
      const ring = isCurrent ? 'ring-4 ring-orange-100' : '';
      const color = done ? 'text-slate-900' : 'text-slate-400';
      const timeStr = fmtTime(order[stage.ts]);
      const li = document.createElement('li');
      li.className = 'flex items-start gap-3';
      li.innerHTML = `
        <span class="mt-1.5 flex h-3 w-3 shrink-0 rounded-full ${dot} ${ring}"></span>
        <div class="flex flex-1 items-center justify-between gap-2 border-b border-slate-100 pb-2 last:border-0">
          <div class="min-w-0">
            <p class="text-sm font-bold ${color}">${escapeHTML(T(stage.labelKey))}</p>
          </div>
          <span class="shrink-0 font-mono text-xs text-slate-500">${timeStr}</span>
        </div>`;
      orderTimeline.append(li);
    });

    if (order.status === 'cancelled') {
      const li = document.createElement('li');
      li.className = 'flex items-start gap-3';
      li.innerHTML = `
        <span class="mt-1.5 flex h-3 w-3 shrink-0 rounded-full bg-red-500"></span>
        <div class="flex-1"><p class="text-sm font-bold text-red-700">${escapeHTML(T('menu.orderStatus.cancelled'))}</p></div>`;
      orderTimeline.append(li);
    }

    const items = (order.items || [])
      .filter((it) => it.itemStatus !== 'cancelled')
      .map((it) => `${escapeHTML(it.name)} × ${Number(it.quantity) || 0}`)
      .join('<br>');
    orderModalItems.innerHTML = `<strong class="text-slate-800">${escapeHTML(T('status.orderItems'))}</strong><div class="mt-1 leading-6">${items || escapeHTML(T('status.noItems'))}</div>`;

    orderModal.classList.replace('hidden', 'flex');
  }

  function closeOrderModal() {
    orderModal.classList.replace('flex', 'hidden');
  }

  function updateTimerDisplay(endTime) {
    const remaining = Math.max(0, Math.ceil((new Date(endTime).getTime() - Date.now()) / 1000));
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    const s = remaining % 60;
    document.getElementById('timer-display').textContent =
      `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  async function resolveTableNumber(session) {
    if (!session) return null;
    const t = session.tableId;
    if (!t) return null;
    if (typeof t === 'object' && t.tableNumber) return t.tableNumber;
    const id = typeof t === 'object' && t._id ? t._id : t;
    if (!id) return null;
    try {
      const { response, payload } = await Live.fetchJSON('/api/table');
      if (!response.ok || payload.success === false) return null;
      const list = Array.isArray(payload.data) ? payload.data : [];
      const match = list.find((row) => String(row._id) === String(id));
      if (match && match.tableNumber) return match.tableNumber;
    } catch {}
    return null;
  }

  const loadSession = Live.createLoader(async () => {
    try {
      const { response, payload } = await Live.fetchJSON(`/api/session/${encodeURIComponent(sessionId)}`);
      if (!response.ok || !payload.success || !payload.data || Array.isArray(payload.data) || typeof payload.data !== 'object') {
        throw new Error(payload.message || T('error.REQUEST_FAILED'));
      }
      sessionData = payload.data;

      if (sessionData.isPaid || sessionData.status === 'completed') {
        backLink.textContent = T('status.backToHome');
        backLink.href = '/';
      } else {
        backLink.textContent = T('status.backToMenu');
        backLink.href = `/menu.html?sessionId=${encodeURIComponent(sessionId)}`;
      }

      const tableNumber = await resolveTableNumber(sessionData);
      tableLabel.textContent = tableNumber ? `${T('queue.table')} ${tableNumber}` : T('status.noTable');

      const queueNumber = sessionData.queueId && sessionData.queueId.queueNumber;
      queueLabel.textContent = queueNumber ? `${T('queue.number')} ${queueNumber}` : '';

      if (sessionData.endTime) {
        updateTimerDisplay(sessionData.endTime);
        if (countdownTimer) window.clearInterval(countdownTimer);
        countdownTimer = window.setInterval(() => updateTimerDisplay(sessionData.endTime), 1000);
      }
      renderStages();
      connection.success('session');
    } catch (error) {
      connection.failure('session');
      tableLabel.textContent = T('status.loadFailed');
      queueLabel.textContent = error.message || '';
    }
  });

  const loadOrders = Live.createLoader(async () => {
    try {
      const { response, payload } = await Live.fetchJSON(`/api/order/session/${encodeURIComponent(sessionId)}`);
      if (!response.ok || payload.success === false || !Array.isArray(payload.data)) {
        throw new Error(payload.message || T('error.REQUEST_FAILED'));
      }
      ordersData = payload.data;
      renderOrders();
      connection.success('orders');
    } catch {
      // Retain the last successful snapshot, but make its failed refresh visible.
      connection.failure('orders');
    }
  });

  if (!sessionId) {
    window.location.replace('/queue.html');
    return;
  }

  document.getElementById('order-modal-close').addEventListener('click', closeOrderModal);
  orderModal.addEventListener('click', (e) => { if (e.target === orderModal) closeOrderModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOrderModal(); });

  if (socket) {
    socket.on('connect', () => {
      socket.emit('joinRoom', 'customer');
      socket.emit('joinSession', sessionId);
      connection.setSocketConnected(true);
      loadSession();
      loadOrders();
    });
    socket.on('disconnect', () => connection.setSocketConnected(false));
    socket.on('connect_error', () => connection.setSocketConnected(false));
    socket.on('order_status_changed', (payload) => {
      if (payload && String(payload.sessionId) === String(sessionId)) {
        loadOrders();
        loadSession();
      }
    });
    socket.on('payment_completed', loadSession);
  }

  window.addEventListener('languageChanged', () => {
    if (sessionData) renderStages();
    if (ordersData.length) renderOrders();
  });

  window.addEventListener('online', () => { loadOrders(); loadSession(); });
  window.setInterval(() => { loadOrders(); loadSession(); }, POLL_INTERVAL_MS);

  loadSession();
  loadOrders();
})();
