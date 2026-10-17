// Kitchen order board with compact cards and a detail modal.
(() => {
  const token = sessionStorage.getItem('token');
  if (!token) { window.location.replace(window.StaffAuth.loginUrl()); return; }
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);

  const allowedStatuses = ['pending', 'accepted', 'cooking', 'ready'];
  const statusDetails = {
    pending: { key: 'kitchen.order.status.pending', className: 'bg-amber-400 text-slate-950', bar: 'bg-amber-400', next: 'accepted', actionKey: 'kitchen.order.action.accept' },
    accepted: { key: 'kitchen.order.status.accepted', className: 'bg-blue-400 text-slate-950', bar: 'bg-blue-400', next: 'cooking', actionKey: 'kitchen.order.action.cook' },
    cooking: { key: 'kitchen.order.status.cooking', className: 'bg-orange-400 text-slate-950', bar: 'bg-orange-400', next: 'ready', actionKey: 'kitchen.order.action.ready' },
    ready: { key: 'kitchen.order.status.ready', className: 'bg-green-400 text-slate-950', bar: 'bg-green-400' },
  };
  const socket = typeof io === 'function' ? io({ auth: { token } }) : null;
  const orderContainer = document.getElementById('kitchen-orders');
  const errorElement = document.getElementById('kitchen-error');
  const loadingElement = document.getElementById('orders-loading');
  const emptyElement = document.getElementById('orders-empty');
  const statusElement = document.getElementById('connection-status');
  const connectionLabel = document.getElementById('connection-label');
  const orderModal = document.getElementById('order-modal');
  const orderModalBody = document.getElementById('order-modal-body');
  const menuSearchForm = document.getElementById('kitchen-menu-search');
  let audioContext;
  let audioArmed = false;
  let lastOrdersSignature = '';
  let lastOrdersData = [];

  // Menu state
  let menus = [];
  const menuFilters = { query: '', availability: '' };
  let menuView = localStorage.getItem('kitchenMenuView') || 'cards';

  function currentLocale() {
    return localStorage.getItem('lang') === 'en' ? 'en-US' : 'th-TH';
  }

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
    } catch (err) { /* ignore */ }
  }

  ['click', 'keydown', 'touchstart', 'pointerdown'].forEach((evt) => {
    document.addEventListener(evt, armAudio, { passive: true });
  });

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
      o.frequency.setValueAtTime(880, audioContext.currentTime);
      o.frequency.setValueAtTime(1174, audioContext.currentTime + 0.13);
      g.gain.setValueAtTime(0.0001, audioContext.currentTime);
      g.gain.exponentialRampToValueAtTime(0.18, audioContext.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.45);
      o.connect(g); g.connect(audioContext.destination);
      o.start(); o.stop(audioContext.currentTime + 0.46);
    } catch {}
  }

  function elapsedTime(createdAt) {
    const s = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
    const payload = await response.json();
    if (response.status === 401 || response.status === 403) { window.StaffAuth.clearCredentials(); window.location.replace(window.StaffAuth.loginUrl()); throw new Error(payload.message || T('error.UNAUTHORIZED')); }
    if (!response.ok || payload.success === false) throw new Error((payload.code && T(`error.${payload.code}`)) || payload.message || T('error.REQUEST_FAILED'));
    return payload;
  }

  function updateElapsedLabels() {
    if (!orderContainer) return;
    orderContainer.querySelectorAll('[data-created-at]').forEach((el) => { el.textContent = elapsedTime(el.dataset.createdAt); });
  }

  // ---------- Orders ----------

  function renderOrders(orders) {
    lastOrdersData = orders;
    const active = orders
      .filter((o) => allowedStatuses.includes(o.status))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    const signature = active.map((o) => `${o._id}:${o.status}:${o.items?.length || 0}`).join('|');
    if (signature === lastOrdersSignature && orderContainer.children.length === active.length) {
      updateElapsedLabels();
      emptyElement.classList.toggle('hidden', active.length > 0);
      loadingElement.classList.add('hidden');
      return;
    }
    lastOrdersSignature = signature;

    const currentCards = new Map([...orderContainer.children].map((c) => [c.dataset.orderId, c]));
    const incomingIds = new Set(active.map((o) => String(o._id)));
    for (const [id, card] of currentCards) if (!incomingIds.has(id)) card.remove();

    for (const order of active) {
      const id = String(order._id);
      const detail = statusDetails[order.status];
      const tableNumber = order.tableId && order.tableId.tableNumber ? order.tableId.tableNumber : '—';
      const itemCount = (order.items || []).reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
      const previewItems = (order.items || []).slice(0, 2).map((it) => `${it.name}×${it.quantity}`).join(', ');
      const more = (order.items || []).length > 2 ? ' …' : '';

      const card = document.createElement('div');
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.dataset.orderId = id;
      card.className = 'group flex min-w-0 cursor-pointer overflow-hidden rounded-xl border border-slate-200 bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:border-orange-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500';
      card.innerHTML = `
        <span class="w-2 shrink-0 ${detail.bar}" aria-hidden="true"></span>
        <div class="flex min-w-0 flex-1 flex-col gap-2.5 p-3">
          <div class="flex items-center justify-between gap-2">
            <span class="inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${detail.className}">${escapeHTML(T(detail.key))}</span>
            <span class="inline-flex items-center gap-1 text-[11px] font-bold text-slate-500">
              <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
              <span class="font-mono tabular-nums" data-created-at="${escapeHTML(order.createdAt)}">${elapsedTime(order.createdAt)}</span>
            </span>
          </div>
          <div class="min-w-0">
            <p class="text-[10px] font-bold uppercase tracking-widest text-slate-400">${escapeHTML(T('kitchen.order.table'))}</p>
            <p class="mt-0.5 truncate text-4xl font-black leading-none text-slate-900">${escapeHTML(tableNumber)}</p>
          </div>
          <div class="border-t border-slate-100 pt-2">
            <p class="flex items-center gap-1.5 text-[11px] font-bold text-slate-600">
              <svg viewBox="0 0 24 24" class="h-3 w-3 opacity-60" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
              ${escapeHTML(T('kitchen.order.items', { n: itemCount }))}
            </p>
            <p class="mt-1 line-clamp-2 text-[11px] text-slate-500">${escapeHTML(previewItems)}${more}</p>
          </div>
        </div>`;

      const previous = currentCards.get(id);
      if (previous) previous.replaceWith(card);
      else orderContainer.append(card);

      const activate = () => openOrderModal(order);
      card.addEventListener('click', activate);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
      });
    }

    emptyElement.classList.toggle('hidden', active.length > 0);
    loadingElement.classList.add('hidden');
    updateElapsedLabels();
  }

  function openOrderModal(order) {
    const detail = statusDetails[order.status];
    const tableNumber = order.tableId && order.tableId.tableNumber ? order.tableId.tableNumber : '—';
    const items = (order.items || []).map((it) => `
      <li class="border-b border-slate-700 py-2 last:border-0">
        <div class="flex items-center justify-between gap-3">
          <span class="min-w-0 text-base font-bold">${escapeHTML(it.name)}</span>
          <span class="shrink-0 rounded-md bg-slate-700 px-2 py-0.5 text-base font-black tabular-nums">× ${Number(it.quantity) || 0}</span>
        </div>
        ${it.note ? `<p class="mt-1 rounded-md bg-amber-950/60 px-2 py-1 text-xs font-semibold text-amber-200">${escapeHTML(T('kitchen.order.notes'))}: ${escapeHTML(it.note)}</p>` : ''}
      </li>`).join('');

    orderModalBody.innerHTML = `
      <div class="flex items-start justify-between gap-3 pr-10">
        <div>
          <p class="text-[11px] font-bold uppercase tracking-widest text-slate-400">${escapeHTML(T('kitchen.order.table'))}</p>
          <p class="text-5xl font-black leading-none text-white">${escapeHTML(tableNumber)}</p>
        </div>
        <div class="text-right">
          <span class="inline-block rounded-lg px-3 py-1.5 text-sm font-black ${detail.className}">${escapeHTML(T(detail.key))}</span>
          <p class="mt-1 font-mono text-xs text-slate-400">${escapeHTML(T('kitchen.order.receivedAt'))} <span data-created-at="${escapeHTML(order.createdAt)}">${elapsedTime(order.createdAt)}</span></p>
        </div>
      </div>
      <ul class="mt-4 divide-y divide-slate-700">${items || `<li class="py-4 text-slate-400">${escapeHTML(T('kitchen.order.noItems'))}</li>`}</ul>
      ${detail.next ? `<button type="button" data-status-action="${detail.next}" class="mt-5 flex w-full items-center justify-center rounded-xl bg-orange-500 px-5 py-4 text-lg font-black leading-none text-slate-950 transition hover:bg-orange-400 disabled:opacity-50"><span>${escapeHTML(T(detail.actionKey))}</span></button>` : ''}`;

    const actionBtn = orderModalBody.querySelector('[data-status-action]');
    if (actionBtn) {
      actionBtn.addEventListener('click', () => updateOrderStatus(order._id, actionBtn.dataset.statusAction, actionBtn));
    }
    orderModal.classList.replace('hidden', 'flex');
  }

  function closeOrderModal() {
    orderModal.classList.replace('flex', 'hidden');
  }

  async function updateOrderStatus(orderId, newStatus, button) {
    button.disabled = true;
    const labelEl = button.querySelector('span') || button;
    const originalText = labelEl.textContent;
    labelEl.textContent = T('kitchen.order.saving');
    try {
      await api(`/api/order/${encodeURIComponent(orderId)}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newStatus }),
      });
      closeOrderModal();
      await loadOrders();
    } catch (error) {
      errorElement.textContent = error.message || T('kitchen.updateFailed');
      errorElement.classList.remove('hidden');
      button.disabled = false;
      labelEl.textContent = originalText;
    }
  }

  async function loadOrders() {
    try {
      const payload = await api('/api/order?status=pending,accepted,cooking,ready');
      renderOrders(Array.isArray(payload.data) ? payload.data : []);
      errorElement.classList.add('hidden');
    } catch (error) {
      errorElement.textContent = error.message || T('kitchen.loadOrdersFailed');
      errorElement.classList.remove('hidden');
    } finally {
      loadingElement.classList.add('hidden');
    }
  }

  // ---------- Menus with view switcher + search ----------

  function switchMenuView(view) {
    menuView = view === 'list' ? 'list' : 'cards';
    localStorage.setItem('kitchenMenuView', menuView);
    document.querySelectorAll('[data-kitchen-menu-view]').forEach((btn) => {
      const selected = btn.dataset.kitchenMenuView === menuView;
      btn.classList.toggle('bg-orange-600', selected);
      btn.classList.toggle('text-white', selected);
      btn.classList.toggle('shadow-sm', selected);
      btn.classList.toggle('text-slate-600', !selected);
      btn.classList.toggle('hover:bg-slate-100', !selected);
      btn.setAttribute('aria-pressed', String(selected));
    });
    renderMenus();
  }

  function filteredMenus() {
    const q = menuFilters.query.trim().toLowerCase();
    return menus.filter((menu) => {
      if (q && !String(menu.name || '').toLowerCase().includes(q)) return false;
      const available = Boolean(menu.isAvailable);
      if (menuFilters.availability === 'available' && !available) return false;
      if (menuFilters.availability === 'unavailable' && available) return false;
      return true;
    });
  }

  function buildMenuToggleButton(menu, available) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.toggleMenu = menu._id;
    btn.className = `shrink-0 rounded-md px-3 py-1.5 text-xs font-black transition ${available ? 'bg-red-600 text-white hover:bg-red-500' : 'bg-green-600 text-white hover:bg-green-500'}`;
    btn.textContent = available ? T('kitchen.menuClose') : T('kitchen.menuOpen');
    btn.addEventListener('click', (e) => toggleAvailability(menu._id, e.currentTarget));
    return btn;
  }

  function buildMenuCard(menu) {
    const available = Boolean(menu.isAvailable);
    const card = document.createElement('div');
    card.className = 'flex min-w-0 flex-col gap-2 overflow-hidden rounded-lg border border-slate-200 bg-white p-3 shadow-sm';
    const header = document.createElement('div');
    header.className = 'flex items-start justify-between gap-2';
    header.innerHTML = `
      <p class="min-w-0 flex-1 truncate text-sm font-bold text-slate-900">${escapeHTML(menu.name)}</p>
      <span class="shrink-0 rounded-md px-2 py-0.5 text-[10px] font-bold ${available ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">${available ? T('kitchen.menuAvailable') : T('kitchen.menuUnavailable')}</span>`;
    card.append(header, buildMenuToggleButton(menu, available));
    return card;
  }

  function buildMenuList(menu) {
    const available = Boolean(menu.isAvailable);
    const row = document.createElement('div');
    row.className = 'flex min-w-0 items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm';
    row.innerHTML = `
      <img src="${escapeHTML(menu.imageUrl || '/assets/images/default-food.jpg')}" onerror="this.onerror=null;this.src='/assets/images/default-food.jpg'" alt="" loading="lazy" class="h-12 w-12 shrink-0 rounded-md object-cover">
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-bold text-slate-900">${escapeHTML(menu.name)}</p>
        <p class="mt-0.5 text-xs text-slate-500">${escapeHTML(T(`menu.category.${menu.category}`) || menu.category)}</p>
      </div>
      <span class="shrink-0 rounded-md px-2.5 py-1 text-[11px] font-bold ${available ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">${available ? T('kitchen.menuAvailable') : T('kitchen.menuUnavailable')}</span>`;
    row.append(buildMenuToggleButton(menu, available));
    return row;
  }

  function renderMenus() {
    const container = document.getElementById('kitchen-menus');
    const countEl = document.getElementById('kitchen-menu-count');
    const emptyEl = document.getElementById('kitchen-menu-empty');
    if (!container) return;
    const visible = filteredMenus();
    container.replaceChildren();
    if (countEl) countEl.textContent = T('kitchen.filter.showing', { n: visible.length, total: menus.length });
    if (menuView === 'list') {
      container.className = 'space-y-2';
      for (const menu of visible) container.append(buildMenuList(menu));
    } else {
      container.className = 'grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6';
      for (const menu of visible) container.append(buildMenuCard(menu));
    }
    if (emptyEl) emptyEl.classList.toggle('hidden', visible.length > 0);
  }

  async function loadMenus() {
    const loading = document.getElementById('menu-loading');
    if (loading) { loading.classList.remove('hidden'); loading.classList.add('flex'); }
    try {
      const response = await fetch('/api/menu');
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || T('kitchen.loadMenuFailed'));
      menus = Array.isArray(payload.data) ? payload.data : [];
      renderMenus();
    } catch (error) {
      errorElement.textContent = error.message || T('kitchen.loadMenuFailed');
      errorElement.classList.remove('hidden');
    } finally {
      if (loading) { loading.classList.add('hidden'); loading.classList.remove('flex'); }
    }
  }

  async function toggleAvailability(menuId, button) {
    button.disabled = true;
    try {
      await api(`/api/menu/${encodeURIComponent(menuId)}/availability`, { method: 'PUT' });
      await loadMenus();
    } catch (error) {
      errorElement.textContent = error.message || T('kitchen.toggleFailed');
      errorElement.classList.remove('hidden');
      button.disabled = false;
    }
  }

  // ---------- Wiring ----------

  document.getElementById('refresh-orders').addEventListener('click', loadOrders);
  document.getElementById('refresh-menus').addEventListener('click', loadMenus);
  document.getElementById('logout-button').addEventListener('click', () => { window.StaffAuth.clearCredentials(); window.location.replace('/login.html'); });
  document.getElementById('order-modal-close').addEventListener('click', closeOrderModal);
  orderModal.addEventListener('click', (e) => { if (e.target === orderModal) closeOrderModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !orderModal.classList.contains('hidden')) closeOrderModal(); });

  document.querySelectorAll('[data-kitchen-menu-view]').forEach((btn) => {
    btn.addEventListener('click', () => switchMenuView(btn.dataset.kitchenMenuView));
  });
  switchMenuView(menuView);

  if (menuSearchForm) {
    const readFilters = () => {
      const fd = new FormData(menuSearchForm);
      menuFilters.query = String(fd.get('query') || '');
      menuFilters.availability = String(fd.get('availability') || '');
    };
    menuSearchForm.addEventListener('input', () => { readFilters(); renderMenus(); });
    menuSearchForm.addEventListener('change', () => { readFilters(); renderMenus(); });
    menuSearchForm.addEventListener('submit', (e) => e.preventDefault());
    menuSearchForm.addEventListener('reset', () => {
      menuFilters.query = '';
      menuFilters.availability = '';
      window.setTimeout(renderMenus, 0);
    });
  }

  if (socket) {
    const dot = document.getElementById('connection-dot');
    socket.on('connect', () => {
      statusElement.className = 'inline-flex h-9 items-center gap-1.5 rounded-lg bg-green-900/60 px-3 text-xs font-bold text-green-300';
      if (dot) dot.className = 'h-2 w-2 rounded-full bg-green-400 animate-pulse';
      if (connectionLabel) connectionLabel.textContent = T('kitchen.socketOnline');
      socket.emit('joinRoom', 'kitchen');
    });
    socket.on('disconnect', () => {
      statusElement.className = 'inline-flex h-9 items-center gap-1.5 rounded-lg bg-red-900/60 px-3 text-xs font-bold text-red-300';
      if (dot) dot.className = 'h-2 w-2 rounded-full bg-red-400';
      if (connectionLabel) connectionLabel.textContent = T('kitchen.socketOffline');
    });
    socket.on('new_order', () => { loadOrders(); playNotification(); });
    socket.on('order_status_changed', loadOrders);
    socket.on('connect_error', (error) => {
      statusElement.textContent = T('kitchen.socketError');
      statusElement.className = 'rounded-lg bg-red-800 px-3 py-1.5 text-sm font-bold';
      console.warn('Kitchen socket connection failed:', error.message);
    });
  } else {
    statusElement.textContent = T('kitchen.socketUnavailable');
    statusElement.className = 'rounded-lg bg-amber-700 px-3 py-1.5 text-sm font-bold';
  }

  window.addEventListener('languageChanged', () => {
    // Re-render orders to update labels and re-render menus.
    lastOrdersSignature = '';
    if (orderContainer) orderContainer.replaceChildren();
    renderOrders(lastOrdersData);
    renderMenus();
  });

  window.setInterval(updateElapsedLabels, 1000);
  window.setInterval(loadOrders, 20000);
  window.setInterval(loadMenus, 60000);
  loadOrders();
  loadMenus();
})();