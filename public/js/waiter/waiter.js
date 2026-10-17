// Provide the waiter's ready-order list, checkout requests, and table map.
(() => {
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);
  const token = sessionStorage.getItem('token');
  if (!token) { window.location.replace(window.StaffAuth.loginUrl()); return; }

  const socket = typeof io === 'function' ? io({ auth: { token } }) : null;
  const statusElement = document.getElementById('connection-status');
  const connectionLabel = document.getElementById('connection-label');
  const errorElement = document.getElementById('waiter-error');
  const successElement = document.getElementById('waiter-success');
  const loadingElement = document.getElementById('waiter-loading');
  const orderModal = document.getElementById('order-modal');
  const orderModalBody = document.getElementById('order-modal-body');
  let audioContext;
  let audioArmed = false;
  let lastReadyOrders = [];
  let lastTables = [];

  async function armAudio() {
    if (audioArmed) return;
    try {
      audioContext = audioContext || new window.AudioContext();
      if (audioContext.state === 'suspended') await audioContext.resume();
      if (audioContext.state === 'running') {
        audioArmed = true;
        const toast = document.getElementById('audio-toast');
        if (toast) toast.classList.add('hidden');
      }
    } catch {}
  }

  ['click', 'keydown', 'touchstart', 'pointerdown'].forEach((evt) => {
    document.addEventListener(evt, armAudio, { passive: true });
  });

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function elapsed(createdAt) {
    const s = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  async function playNotification() {
    try {
      await armAudio();
      if (!audioArmed) {
        const toast = document.getElementById('audio-toast');
        if (toast) toast.classList.remove('hidden');
        return;
      }
      const o = audioContext.createOscillator();
      const g = audioContext.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(784, audioContext.currentTime);
      o.frequency.setValueAtTime(1046, audioContext.currentTime + 0.14);
      g.gain.setValueAtTime(0.0001, audioContext.currentTime);
      g.gain.exponentialRampToValueAtTime(0.16, audioContext.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.5);
      o.connect(g); g.connect(audioContext.destination);
      o.start(); o.stop(audioContext.currentTime + 0.51);
    } catch {}
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
    } catch (error) {
      if (error instanceof TypeError) throw new Error(`Cannot reach server at ${window.location.host}`);
      throw error;
    }
    const payload = await response.json();
    if (response.status === 401 || response.status === 403) {
      window.StaffAuth.clearCredentials();
      window.location.replace(window.StaffAuth.loginUrl());
      throw new Error(payload.message || T('error.UNAUTHORIZED'));
    }
    if (!response.ok || payload.success === false) {
      throw new Error((payload.code && T(`error.${payload.code}`)) || payload.message || T('error.REQUEST_FAILED'));
    }
    return payload;
  }

  function showError(message) { successElement.classList.add('hidden'); errorElement.textContent = message; errorElement.classList.remove('hidden'); }
  function showSuccess(message) { errorElement.classList.add('hidden'); successElement.textContent = message; successElement.classList.remove('hidden'); }

  // ---------- Ready orders ----------

  async function loadReadyOrders() {
    try {
      const payload = await api('/api/order?status=ready');
      const orders = Array.isArray(payload.data) ? payload.data : [];
      lastReadyOrders = orders;
      const container = document.getElementById('ready-orders');
      container.replaceChildren();
      document.getElementById('ready-count').textContent = String(orders.length);
      document.getElementById('ready-empty').classList.toggle('hidden', orders.length > 0);

      for (const order of orders) {
        const card = document.createElement('button');
        card.type = 'button';
        const tableNumber = order.tableId && order.tableId.tableNumber ? order.tableId.tableNumber : '—';
        const items = (order.items || []).filter((it) => it.itemStatus !== 'cancelled');
        const itemCount = items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
        card.className = 'flex min-w-0 max-w-full flex-col gap-1 overflow-hidden rounded-lg border border-slate-200 bg-white p-2 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-green-300 hover:shadow-md';
        card.innerHTML = `
          <div class="flex items-center justify-between gap-1">
            <span class="truncate text-[10px] font-bold uppercase tracking-widest text-slate-400">${escapeHTML(T('waiter.table'))}</span>
            <span class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-black bg-green-100 text-green-800">${escapeHTML(T('waiter.ready'))}</span>
          </div>
          <p class="truncate text-2xl font-black leading-none text-slate-900">${escapeHTML(tableNumber)}</p>
          <p class="w-full truncate text-[10px] text-slate-500">
            <span class="font-bold">${escapeHTML(T('kitchen.order.items', { n: itemCount }))}</span> · <span class="font-mono">${elapsed(order.createdAt)}</span>
          </p>
          <p class="w-full truncate text-[10px] font-semibold text-slate-600">
            ${escapeHTML(items.slice(0, 2).map((it) => `${it.name}×${it.quantity}`).join(', '))}${items.length > 2 ? ' …' : ''}
          </p>`;
        card.addEventListener('click', () => openOrderModal(order));
        container.append(card);
      }
      errorElement.classList.add('hidden');
    } catch (error) {
      showError(error.message || T('waiter.loadReadyFailed'));
    }
  }

  function openOrderModal(order) {
    const tableNumber = order.tableId && order.tableId.tableNumber ? order.tableId.tableNumber : '—';
    const items = (order.items || []).filter((it) => it.itemStatus !== 'cancelled');
    const itemRows = items.map((it) => `
      <li class="flex items-center justify-between gap-3 border-b border-slate-100 py-2 last:border-0">
        <span class="min-w-0 font-semibold">${escapeHTML(it.name)}</span>
        <span class="shrink-0 font-bold">× ${Number(it.quantity) || 0}</span>
      </li>`).join('');

    orderModalBody.innerHTML = `
      <div class="pr-10">
        <p class="text-[11px] font-bold uppercase tracking-widest text-slate-400">${escapeHTML(T('waiter.serveTo'))}</p>
        <h3 class="mt-0.5 text-3xl font-black text-slate-900">${escapeHTML(T('waiter.table'))} ${escapeHTML(tableNumber)}</h3>
      </div>
      <ul class="mt-3 max-h-[50vh] overflow-y-auto">${itemRows || `<li class="py-4 text-center text-slate-400">${escapeHTML(T('kitchen.order.noItems'))}</li>`}</ul>
      <button type="button" data-served="${escapeHTML(order._id)}" class="mt-4 w-full rounded-xl bg-green-700 px-4 py-3 text-base font-black text-white hover:bg-green-600 disabled:opacity-50">${escapeHTML(T('waiter.serve'))}</button>`;

    const serveBtn = orderModalBody.querySelector('[data-served]');
    serveBtn.addEventListener('click', () => markOrderServed(order._id, serveBtn));
    orderModal.classList.replace('hidden', 'flex');
  }

  function closeOrderModal() { orderModal.classList.replace('flex', 'hidden'); }

  async function markOrderServed(orderId, button) {
    button.disabled = true;
    button.textContent = T('waiter.serving');
    try {
      await api(`/api/order/${encodeURIComponent(orderId)}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newStatus: 'served' }),
      });
      closeOrderModal();
      await loadReadyOrders();
    } catch (error) {
      showError(error.message || T('waiter.servedFailed'));
      button.disabled = false;
      button.textContent = T('waiter.serve');
    }
  }

  // ---------- Cleaning & tables ----------

  function renderCleaningTables(tables) {
    const container = document.getElementById('cleaning-tables');
    const cleaningTables = tables
      .filter((t) => t.status === 'cleaning')
      .sort((a, b) => (Object.keys(['small', 'medium', 'large']).indexOf(a.zone) - Object.keys(['small', 'medium', 'large']).indexOf(b.zone)) || String(a.tableNumber).localeCompare(String(b.tableNumber), 'th', { numeric: true }));
    container.replaceChildren();
    document.getElementById('cleaning-count').textContent = String(cleaningTables.length);
    document.getElementById('cleaning-empty').classList.toggle('hidden', cleaningTables.length > 0);

    const zones = ['small', 'medium', 'large'];
    for (const zone of zones) {
      const zoneLabel = T(`table.zone.${zone}`);
      const zoneTables = cleaningTables.filter((t) => t.zone === zone);
      if (zoneTables.length === 0) continue;
      const section = document.createElement('section');
      section.innerHTML = `<h3 class="mb-2 text-sm font-bold text-slate-600">${escapeHTML(zoneLabel)}<span class="ml-2 text-xs font-semibold text-slate-400">(${zoneTables.length})</span></h3>`;
      const grid = document.createElement('div');
      grid.className = 'grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6';
      for (const table of zoneTables) {
        const card = document.createElement('article');
        card.className = 'flex min-w-0 flex-col gap-1.5 rounded-lg border border-sky-200 bg-white p-2.5 shadow-sm';
        card.innerHTML = `
          <p class="text-[10px] font-bold uppercase tracking-widest text-sky-700">${escapeHTML(T('waiter.cleaning'))}</p>
          <p class="text-2xl font-black leading-none">${escapeHTML(table.tableNumber)}</p>
          <p class="text-[10px] text-slate-500">${escapeHTML(zoneLabel)} · ${Number(table.capacity) || 0} ${escapeHTML(T('common.people'))}</p>
          <button type="button" data-clear-table="${escapeHTML(table._id)}" class="mt-1 w-full rounded-md bg-slate-900 px-2 py-1.5 text-xs font-bold text-white hover:bg-slate-700 disabled:opacity-50">${escapeHTML(T('waiter.done'))}</button>`;
        card.querySelector('[data-clear-table]').addEventListener('click', (e) => clearTable(table._id, e.currentTarget));
        grid.append(card);
      }
      section.append(grid);
      container.append(section);
    }
  }

  async function loadTables() {
    try {
      const payload = await api('/api/table');
      const tables = Array.isArray(payload.data) ? payload.data : [];
      lastTables = tables;
      renderCleaningTables(tables);

      const container = document.getElementById('table-map');
      container.replaceChildren();
      container.className = 'space-y-6';
      document.getElementById('tables-empty').classList.toggle('hidden', tables.length > 0);

      const statusStyles = {
        available: 'border-green-500 bg-green-50 text-green-900',
        reserved: 'border-amber-500 bg-amber-50 text-amber-900',
        occupied: 'border-red-500 bg-red-50 text-red-900',
        cleaning: 'border-blue-500 bg-blue-50 text-blue-900',
      };

      const zones = ['small', 'medium', 'large'];
      for (const zone of zones) {
        const zoneLabel = T(`table.zone.${zone}`);
        const zoneTables = tables
          .filter((t) => t.zone === zone)
          .sort((a, b) => String(a.tableNumber).localeCompare(String(b.tableNumber), 'th', { numeric: true }));
        if (zoneTables.length === 0) continue;

        const section = document.createElement('section');
        const heading = document.createElement('h3');
        heading.className = 'mb-3 text-base font-black text-slate-700';
        heading.innerHTML = `${escapeHTML(zoneLabel)}<span class="ml-2 text-sm font-semibold text-slate-400">(${zoneTables.length} ${escapeHTML(T('table.count', { n: '' })).trim()})</span>`;

        const grid = document.createElement('div');
        grid.className = 'grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6';

        for (const table of zoneTables) {
          const card = document.createElement('article');
          card.className = `flex min-h-[7.5rem] min-w-0 flex-col items-center justify-center gap-1 rounded-2xl border-l-4 p-4 text-center shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${statusStyles[table.status] || 'border-slate-400 bg-white'}`;
          card.innerHTML = `
            <p class="truncate text-[11px] font-bold uppercase tracking-widest opacity-70">${escapeHTML(zoneLabel)}</p>
            <p class="truncate text-4xl font-black leading-none">${escapeHTML(table.tableNumber)}</p>
            <p class="truncate text-sm font-bold">${escapeHTML(T(`table.status.${table.status}`) || table.status)}</p>
            <p class="truncate text-xs text-slate-500">${Number(table.minCapacity) || 1}-${Number(table.capacity) || 0} ${escapeHTML(T('common.people'))}</p>`;
          grid.append(card);
        }
        section.append(heading, grid);
        container.append(section);
      }
    } catch (error) {
      showError(error.message || T('waiter.loadTablesFailed'));
    }
  }

  async function clearTable(tableId, button) {
    button.disabled = true;
    button.textContent = T('waiter.clearing');
    try {
      await api(`/api/table/${encodeURIComponent(tableId)}/clear`, { method: 'POST' });
      showSuccess(T('waiter.cleared'));
      await loadTables();
    } catch (error) {
      showError(error.message || T('waiter.clearFailed'));
      button.disabled = false;
      button.textContent = T('waiter.done');
    }
  }

  async function loadTab(tabName) {
    loadingElement.classList.remove('hidden');
    loadingElement.classList.add('flex');
    try {
      if (tabName === 'ready') await loadReadyOrders();
      if (tabName === 'cleaning') await loadTables();
      if (tabName === 'tables') await loadTables();
    } finally {
      loadingElement.classList.add('hidden');
      loadingElement.classList.remove('flex');
    }
  }

  document.querySelectorAll('.waiter-tab').forEach((button) => {
    button.addEventListener('click', () => {
      const selectedTab = button.dataset.tab;
      document.querySelectorAll('.waiter-tab').forEach((tab) => {
        const selected = tab === button;
        tab.setAttribute('aria-selected', String(selected));
        tab.classList.toggle('bg-orange-600', selected);
        tab.classList.toggle('text-white', selected);
        tab.classList.toggle('text-slate-600', !selected);
      });
      document.querySelectorAll('.waiter-panel').forEach((panel) => {
        panel.classList.toggle('hidden', panel.id !== `tab-${selectedTab}`);
      });
      loadTab(selectedTab);
    });
  });

  document.getElementById('refresh-waiter').addEventListener('click', loadReadyOrders);
  document.getElementById('refresh-tables').addEventListener('click', loadTables);
  document.getElementById('refresh-cleaning').addEventListener('click', loadTables);
  document.getElementById('logout-button').addEventListener('click', () => {
    window.StaffAuth.clearCredentials();
    window.location.replace('/login.html');
  });
  document.getElementById('order-modal-close').addEventListener('click', closeOrderModal);
  orderModal.addEventListener('click', (e) => { if (e.target === orderModal) closeOrderModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !orderModal.classList.contains('hidden')) closeOrderModal(); });

  if (socket) {
    const dot = document.getElementById('connection-dot');
    socket.on('connect', () => {
      statusElement.className = 'inline-flex h-9 items-center gap-1.5 rounded-lg bg-green-900/60 px-3 text-xs font-bold text-green-300';
      if (dot) dot.className = 'h-2 w-2 rounded-full bg-green-400 animate-pulse';
      if (connectionLabel) connectionLabel.textContent = T('kitchen.socketOnline');
      socket.emit('joinRoom', 'waiter');
    });
    socket.on('disconnect', () => {
      statusElement.className = 'inline-flex h-9 items-center gap-1.5 rounded-lg bg-red-900/60 px-3 text-xs font-bold text-red-300';
      if (dot) dot.className = 'h-2 w-2 rounded-full bg-red-400';
      if (connectionLabel) connectionLabel.textContent = T('kitchen.socketOffline');
    });
    socket.on('order_ready', () => { playNotification(); loadReadyOrders(); });
    socket.on('order_status_changed', (payload) => { if (payload && payload.status === 'served') loadReadyOrders(); });
    socket.on('table_waiting_for_cleaning', () => { playNotification(); loadTables(); });
    socket.on('table_cleared', loadTables);
    socket.on('table_board_updated', loadTables);
    socket.on('connect_error', (error) => {
      statusElement.textContent = T('kitchen.socketError');
      statusElement.className = 'rounded-lg bg-red-800 px-3 py-1.5 text-sm font-bold';
      console.warn('Waiter socket connection failed:', error.message);
    });
  } else {
    statusElement.textContent = T('kitchen.socketUnavailable');
    statusElement.className = 'rounded-lg bg-amber-700 px-3 py-1.5 text-sm font-bold';
  }

  window.addEventListener('languageChanged', () => {
    renderCleaningTables(lastTables);
    loadReadyOrders();
    loadTables();
  });

  window.setInterval(() => { loadReadyOrders(); loadTables(); }, 30000);
  loadReadyOrders();
  loadTables();
})();