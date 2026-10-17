// Load the active session, render menus, and manage customer orders and cart.
(() => {
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('sessionId') || localStorage.getItem('sessionId');
  // Display order of the menu categories (must match config/menuCategories.js).
  const CATEGORY_KEYS = [
    'set_menu', 'sukiyaki', 'hotpan', 'sushi', 'maki', 'sashimi',
    'japanese_main', 'chinese', 'fried', 'dim_sum', 'yum', 'salad',
    'fresh_meat', 'offal', 'seafood', 'vegetable', 'mushroom', 'tofu',
    'noodle', 'rice', 'side', 'soup', 'sauce', 'dessert', 'drink',
  ];

  // Keep any unexpected/legacy category visible instead of silently dropping it.
  function orderedCategoryKeys(menuList) {
    const known = new Set(CATEGORY_KEYS);
    const extras = [];
    for (const menu of menuList) {
      const category = menu && menu.category;
      if (category && !known.has(category) && !extras.includes(category)) extras.push(category);
    }
    return [...CATEGORY_KEYS, ...extras];
  }

  const cart = new Map();
  let menuView = localStorage.getItem('menuView') || 'list';
  let mainTab = localStorage.getItem('menuTab') || 'menu';
  const socket = typeof io === 'function' ? io() : null;
  let menus = [];
  let toastTimeout;
  const shownSessionWarnings = new Set();
  let audioContext;
  let paymentRedirected = false;
  let activeCategory = null;
  let categoryObserver = null;
  let scrollPause = false;
  let scrollPauseTimer = null;
  const HEADER_OFFSET = 88;

  function currentLocale() {
    return localStorage.getItem('lang') === 'en' ? 'en-US' : 'th-TH';
  }

  async function armNotificationAudio() {
    try {
      audioContext = audioContext || new window.AudioContext();
      if (audioContext.state === 'suspended') await audioContext.resume();
    } catch (error) { console.warn('Notification audio is unavailable.', error); }
  }

  async function playNotification() {
    try {
      await armNotificationAudio();
      if (!audioContext || audioContext.state !== 'running') return;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
      oscillator.frequency.setValueAtTime(1174, audioContext.currentTime + 0.12);
      gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, audioContext.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.4);
      oscillator.connect(gain); gain.connect(audioContext.destination);
      oscillator.start(); oscillator.stop(audioContext.currentTime + 0.41);
    } catch (error) { console.warn('Notification sound blocked.', error); }
  }

  window.addEventListener('pointerdown', armNotificationAudio, { once: true });

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));
  }

  function currency(amount) {
    return `฿${new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)}`;
  }

  function showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.remove('hidden', 'bg-slate-900', 'bg-red-700');
    toast.classList.add(isError ? 'bg-red-700' : 'bg-slate-900');
    window.clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(() => toast.classList.add('hidden'), 3200);
  }

  function showConfirm({ title = T('common.ok'), message = '', okText = T('common.ok'), cancelText = T('common.cancel'), danger = false } = {}) {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'fixed inset-0 z-[300] hidden items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.innerHTML = `
        <section class="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
          <div class="flex items-start gap-3 p-5">
            <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${danger ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'}">
              <svg viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></svg>
            </span>
            <div class="min-w-0 flex-1">
              <h2 class="text-lg font-black text-slate-900" data-title></h2>
              <p class="mt-1.5 whitespace-pre-line text-sm text-slate-600" data-message></p>
            </div>
          </div>
          <div class="flex gap-2 border-t border-slate-100 bg-slate-50/50 px-5 py-4">
            <button type="button" data-cancel class="min-h-11 flex-1 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 transition hover:bg-slate-100">${cancelText}</button>
            <button type="button" data-ok class="min-h-11 flex-1 rounded-xl ${danger ? 'bg-red-700 hover:bg-red-800' : 'bg-orange-600 hover:bg-orange-700'} px-4 py-2.5 text-sm font-bold text-white transition">${okText}</button>
          </div>
        </section>`;
      document.body.append(el);
      el.querySelector('[data-title]').textContent = title;
      el.querySelector('[data-message]').textContent = message;

      const cleanup = () => {
        el.remove();
        document.removeEventListener('keydown', onKey);
      };
      const onKey = (e) => { if (e.key === 'Escape') { cleanup(); resolve(false); } };

      el.querySelector('[data-ok]').addEventListener('click', () => { cleanup(); resolve(true); });
      el.querySelector('[data-cancel]').addEventListener('click', () => { cleanup(); resolve(false); });
      el.addEventListener('click', (e) => { if (e.target === el) { cleanup(); resolve(false); } });
      document.addEventListener('keydown', onKey);

      el.classList.replace('hidden', 'flex');
      window.setTimeout(() => el.querySelector('[data-ok]').focus(), 50);
    });
  }

  function showSessionWarning(minutes) {
    const warningWindow = minutes <= 5 ? 5 : 15;
    if (shownSessionWarnings.has(warningWindow)) return;
    shownSessionWarnings.add(warningWindow);
    showToast(warningWindow === 5 ? T('menu.timeLeft5') : T('menu.timeLeft15'));
  }

  function goToFeedback() {
    if (paymentRedirected) return;
    paymentRedirected = true;
    window.location.replace(`/feedback.html?sessionId=${encodeURIComponent(sessionId)}`);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, options);
    const payload = await response.json();
    if (!response.ok || payload.success === false) {
      throw new Error((payload.code && T(`error.${payload.code}`)) || payload.message || T('error.REQUEST_FAILED'));
    }
    return payload;
  }

  // ---- Main tabs ----

  function switchMainTab(tab) {
    mainTab = tab === 'orders' ? 'orders' : 'menu';
    localStorage.setItem('menuTab', mainTab);
    document.querySelectorAll('[data-main-tab]').forEach((btn) => {
      const selected = btn.dataset.mainTab === mainTab;
      btn.setAttribute('aria-selected', String(selected));
      btn.classList.toggle('bg-orange-600', selected);
      btn.classList.toggle('text-white', selected);
      btn.classList.toggle('text-slate-600', !selected);
      btn.classList.toggle('hover:bg-orange-50', !selected);
    });
    document.getElementById('view-menu').classList.toggle('hidden', mainTab !== 'menu');
    document.getElementById('view-orders').classList.toggle('hidden', mainTab !== 'orders');
    if (mainTab === 'orders') loadOrders();
  }

  function updateOrdersCount(count) {
    const badge = document.getElementById('main-orders-count');
    if (!badge) return;
    const active = Number(count) || 0;
    if (active > 0) {
      badge.textContent = String(active);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // ---- Cart ----

  function renderCartSummary() {
    const itemCount = [...cart.values()].reduce((sum, item) => sum + item.quantity, 0);
    const total = [...cart.values()].reduce((sum, item) => sum + item.price * item.quantity, 0);
    document.getElementById('cart-count').textContent = String(itemCount);
    document.getElementById('cart-total').textContent = currency(total);
    document.getElementById('modal-total').textContent = currency(total);
  }

  function renderCart() {
    const container = document.getElementById('cart-items');
    const empty = document.getElementById('cart-empty');
    container.replaceChildren();
    empty.classList.toggle('hidden', cart.size > 0);

    for (const item of cart.values()) {
      const trackedStock = item.stockQuantity !== null && typeof item.stockQuantity !== 'undefined';
      const maximum = Math.min(Number(item.maxOrderQuantity) || 99, trackedStock ? Number(item.stockQuantity) : 99);
      const canInc = item.quantity < maximum;
      const canDec = item.quantity > 1;
      const row = document.createElement('article');
      row.className = 'rounded-xl border border-slate-200 bg-white p-4 shadow-sm';
      row.innerHTML = `
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="truncate font-bold text-slate-900">${escapeHTML(item.name)}</h3>
            <p class="mt-0.5 text-xs text-slate-500">${escapeHTML(T('menu.pricePerItem', { price: currency(item.price) }))}</p>
          </div>
          <button type="button" data-remove="${escapeHTML(item.menuId)}" class="shrink-0 rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs font-bold text-red-700 transition hover:bg-red-50">${escapeHTML(T('menu.removeItem'))}</button>
        </div>
        <div class="mt-3 flex items-center justify-between gap-3">
          <div class="inline-flex items-center overflow-hidden rounded-lg border border-slate-200 bg-white">
            <button type="button" data-qty-dec="${escapeHTML(item.menuId)}" ${canDec ? '' : 'disabled'} aria-label="-"
              class="flex h-10 w-10 items-center justify-center text-lg font-black text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-white">−</button>
            <span class="flex h-10 w-12 items-center justify-center border-x border-slate-200 text-base font-black tabular-nums text-slate-900">${item.quantity}</span>
            <button type="button" data-qty-inc="${escapeHTML(item.menuId)}" ${canInc ? '' : 'disabled'} aria-label="+"
              class="flex h-10 w-10 items-center justify-center text-lg font-black text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-white">+</button>
          </div>
          <span class="font-black text-slate-900 tabular-nums">${currency(item.price * item.quantity)}</span>
        </div>
        <label class="mt-3 block text-sm">
          <span class="mb-1 block font-semibold text-slate-700">${escapeHTML(T('menu.note'))}</span>
          <input data-note="${escapeHTML(item.menuId)}" type="text" maxlength="160" value="${escapeHTML(item.note)}" placeholder="${escapeHTML(T('menu.notePlaceholder'))}" class="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-100">
        </label>`;
      container.append(row);
    }

    container.querySelectorAll('[data-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        cart.delete(button.dataset.remove);
        renderCart();
      });
    });
    container.querySelectorAll('[data-qty-dec]').forEach((button) => {
      button.addEventListener('click', () => {
        const item = cart.get(button.dataset.qtyDec);
        if (!item || item.quantity <= 1) return;
        item.quantity -= 1;
        renderCart();
      });
    });
    container.querySelectorAll('[data-qty-inc]').forEach((button) => {
      button.addEventListener('click', () => {
        const item = cart.get(button.dataset.qtyInc);
        if (!item) return;
        const maximum = Math.min(Number(item.maxOrderQuantity) || 99,
          item.stockQuantity === null || typeof item.stockQuantity === 'undefined' ? 99 : Number(item.stockQuantity));
        if (item.quantity >= maximum) {
          showToast(T('menu.stockMaxed', { max: maximum }), true);
          return;
        }
        item.quantity += 1;
        renderCart();
      });
    });
    container.querySelectorAll('[data-note]').forEach((input) => {
      input.addEventListener('input', () => {
        const item = cart.get(input.dataset.note);
        if (item) item.note = input.value;
      });
    });
    renderCartSummary();
  }

  // ---- Category navigation (vertical sidebar) ----

  const CAT_BASE = 'flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm font-bold leading-tight transition';
  const CAT_ACTIVE = 'bg-orange-600 text-white shadow-sm';
  const CAT_IDLE = 'text-slate-600 hover:bg-orange-50 hover:text-orange-800';

  function catLabel(cat) { return T(`menu.category.${cat}`) || cat; }

  function buildCategoryButton(group) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.category = group.category;
    button.className = `${CAT_BASE} ${activeCategory === group.category ? CAT_ACTIVE : CAT_IDLE}`;
    button.innerHTML = `
      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60" aria-hidden="true"></span>
      <span class="min-w-0 flex-1 truncate">${escapeHTML(catLabel(group.category))}</span>`;
    button.addEventListener('click', () => scrollToCategory(group.category));
    return button;
  }

  function updateCategoryButtons() {
    const nav = document.getElementById('category-nav');
    if (!nav) return;
    // Only auto-scroll the sidebar on mobile drawer (which has its own scrollbar).
    // On desktop the sidebar is sticky and non-scrollable — scrollIntoView there
    // would hijack the page scroll and cause the page to jump.
    const isSidebarScrollable = window.innerWidth < 1024;
    nav.querySelectorAll('[data-category]').forEach((btn) => {
      const isActive = btn.dataset.category === activeCategory;
      btn.className = `${CAT_BASE} ${isActive ? CAT_ACTIVE : CAT_IDLE}`;
      if (isActive && isSidebarScrollable) {
        btn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }

  function scrollToCategory(category) {
    const target = document.getElementById(`category-${category}`);
    if (!target) return;
    activeCategory = category;
    updateCategoryButtons();
    const top = target.getBoundingClientRect().top + window.scrollY - HEADER_OFFSET;
    scrollPause = true;
    window.clearTimeout(scrollPauseTimer);
    scrollPauseTimer = window.setTimeout(() => { scrollPause = false; }, 700);
    window.scrollTo({ top, behavior: 'smooth' });
  }

  function setupCategoryObserver(groupIds) {
    if (categoryObserver) categoryObserver.disconnect();
    if (!groupIds.length || typeof IntersectionObserver !== 'function') return;
    categoryObserver = new IntersectionObserver((entries) => {
      if (scrollPause) return;
      const visible = entries.filter((e) => e.isIntersecting);
      if (!visible.length) return;
      visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      const next = visible[0].target.id.replace('category-', '');
      if (next !== activeCategory) {
        activeCategory = next;
        updateCategoryButtons();
      }
    }, { rootMargin: `-${HEADER_OFFSET}px 0px -60% 0px`, threshold: 0 });
    for (const id of groupIds) {
      const el = document.getElementById(`category-${id}`);
      if (el) categoryObserver.observe(el);
    }
  }

  // ---- Menu rendering ----

  function renderMenus() {
    const content = document.getElementById('menu-content');
    const categoryNav = document.getElementById('category-nav');
    const groups = orderedCategoryKeys(menus)
      .map((category) => ({ category, items: menus.filter((menu) => menu.category === category) }))
      .filter((group) => group.items.length > 0);

    document.querySelectorAll('[data-menu-view]').forEach((btn) => {
      const selected = btn.dataset.menuView === menuView;
      btn.classList.toggle('bg-orange-600', selected);
      btn.classList.toggle('text-white', selected);
      btn.classList.toggle('text-slate-600', !selected);
      btn.setAttribute('aria-pressed', String(selected));
    });

    const groupIds = groups.map((g) => g.category);
    if (!activeCategory || !groupIds.includes(activeCategory)) {
      activeCategory = groupIds[0] || null;
    }

    categoryNav.replaceChildren();
    content.replaceChildren();
    for (const group of groups) {
      const sectionId = `category-${group.category}`;
      categoryNav.append(buildCategoryButton(group));

      const section = document.createElement('section');
      section.id = sectionId;
      section.className = 'scroll-mt-24';
      section.innerHTML = `<h2 class="mb-3 flex items-center gap-2 text-lg font-extrabold text-slate-900">
        <span class="h-5 w-1.5 rounded-md bg-orange-500"></span>
        ${escapeHTML(catLabel(group.category))}
      </h2>`;

      if (menuView === 'cards') {
        const grid = document.createElement('div');
        grid.className = 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4';
        for (const menu of group.items) grid.append(buildMenuCard(menu));
        section.append(grid);
      } else {
        const list = document.createElement('div');
        list.className = 'space-y-2';
        for (const menu of group.items) list.append(buildMenuRow(menu));
        section.append(list);
      }
      content.append(section);
    }
    document.getElementById('menu-loading').classList.add('hidden');
    content.classList.remove('hidden');
    setupCategoryObserver(groupIds);
    updateCategoryButtons();
  }

  function stockInfoOf(menu) {
    const trackedStock = menu.stockQuantity !== null && typeof menu.stockQuantity !== 'undefined';
    const stockQuantity = Number(menu.stockQuantity) || 0;
    const maxOrderQuantity = Math.max(1, Number(menu.maxOrderQuantity) || 99);
    const isAvailable = Boolean(menu.isAvailable) && (!trackedStock || stockQuantity > 0);
    let notice, noticeClass;
    if (!trackedStock) {
      notice = T('menu.maxPerOrder', { max: maxOrderQuantity });
      noticeClass = 'text-slate-500';
    } else if (stockQuantity === 0) {
      notice = T('menu.stockOut');
      noticeClass = 'text-red-600';
    } else if (stockQuantity <= Number(menu.lowStockThreshold || 0)) {
      notice = T('menu.stockLow', { n: stockQuantity });
      noticeClass = 'text-amber-700';
    } else {
      notice = T('menu.stockRemaining', { n: stockQuantity });
      noticeClass = 'text-slate-500';
    }
    return { trackedStock, stockQuantity, maxOrderQuantity, isAvailable, notice, noticeClass };
  }

  function buildMenuRow(menu) {
    const { isAvailable, notice, noticeClass } = stockInfoOf(menu);
    const row = document.createElement('article');
    row.className = 'flex items-center gap-3 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-100 transition hover:shadow-md';
    row.innerHTML = `
      <img src="${escapeHTML(menu.imageUrl || '/assets/images/default-food.jpg')}" onerror="this.onerror=null;this.src='/assets/images/default-food.jpg'" alt="" loading="lazy" class="h-16 w-16 shrink-0 rounded-lg object-cover">
      <div class="min-w-0 flex-1">
        <h3 class="truncate text-sm font-bold text-slate-900">${escapeHTML(menu.name)}</h3>
        <p class="mt-0.5 text-sm font-black text-orange-700 tabular-nums">${currency(Number(menu.price) || 0)}</p>
        <p class="mt-0.5 text-[11px] ${noticeClass}">${escapeHTML(notice)}</p>
      </div>
      <button type="button" data-add="${escapeHTML(menu._id)}" class="shrink-0 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-bold text-white transition hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50" ${isAvailable ? '' : 'disabled'}>
        ${isAvailable ? escapeHTML(T('menu.addShort')) : escapeHTML(T('menu.soldOutShort'))}
      </button>`;
    row.querySelector('[data-add]').addEventListener('click', () => addToCart(menu));
    return row;
  }

  function buildMenuCard(menu) {
    const { isAvailable, notice, noticeClass } = stockInfoOf(menu);
    const card = document.createElement('article');
    card.className = 'flex flex-col overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-100 transition hover:shadow-md';
    card.innerHTML = `
      <img src="${escapeHTML(menu.imageUrl || '/assets/images/default-food.jpg')}" onerror="this.onerror=null;this.src='/assets/images/default-food.jpg'" alt="" loading="lazy" class="h-40 w-full object-cover sm:h-44">
      <div class="flex flex-1 flex-col p-3">
        <h3 class="line-clamp-2 min-h-10 text-sm font-bold text-slate-900">${escapeHTML(menu.name)}</h3>
        <p class="mt-1 text-sm font-black text-orange-700 tabular-nums">${currency(Number(menu.price) || 0)}</p>
        <p class="mt-0.5 text-[11px] ${noticeClass}">${escapeHTML(notice)}</p>
        <button type="button" data-add="${escapeHTML(menu._id)}" class="mt-2 w-full rounded-lg bg-orange-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50" ${isAvailable ? '' : 'disabled'}>
          ${isAvailable ? escapeHTML(T('menu.addToCart')) : escapeHTML(T('menu.soldOut'))}
        </button>
      </div>`;
    card.querySelector('[data-add]').addEventListener('click', () => addToCart(menu));
    return card;
  }

  function addToCart(menu) {
    const existing = cart.get(String(menu._id));
    const trackedStock = menu.stockQuantity !== null && typeof menu.stockQuantity !== 'undefined';
    const maximum = Math.min(Number(menu.maxOrderQuantity) || 99, trackedStock ? Number(menu.stockQuantity) : 99);
    const currentQuantity = existing ? existing.quantity : 0;
    if (currentQuantity >= maximum) {
      showToast(maximum < 1 ? T('menu.stockNoStock') : T('menu.stockMaxed', { max: maximum }), true);
      return;
    }
    if (existing) {
      existing.quantity += 1;
    } else {
      cart.set(String(menu._id), {
        menuId: String(menu._id),
        name: menu.name,
        price: Number(menu.price),
        quantity: 1,
        note: '',
        stockQuantity: trackedStock ? Number(menu.stockQuantity) : null,
        maxOrderQuantity: Number(menu.maxOrderQuantity) || 99,
      });
    }
    renderCartSummary();
    showToast(T('menu.stockAdded', { name: menu.name }));
  }

  function renderOrders(orders) {
    const list = document.getElementById('orders-list');
    list.replaceChildren();
    document.getElementById('orders-empty').classList.toggle('hidden', orders.length > 0);

    const activeCount = orders.filter((o) => ['pending', 'accepted', 'cooking', 'ready'].includes(o.status)).length;
    updateOrdersCount(activeCount);

    const badgeClass = {
      pending: 'bg-amber-100 text-amber-900',
      accepted: 'bg-blue-100 text-blue-900',
      cooking: 'bg-orange-100 text-orange-900',
      ready: 'bg-green-100 text-green-900',
      served: 'bg-slate-100 text-slate-700',
      paid: 'bg-slate-200 text-slate-700',
      cancelled: 'bg-red-100 text-red-800',
    };

    for (const order of orders) {
      const card = document.createElement('article');
      card.className = 'rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-100';
      const itemText = (order.items || [])
        .filter((item) => item.itemStatus !== 'cancelled')
        .map((item) => `${escapeHTML(item.name)} × ${Number(item.quantity) || 0}`)
        .join(', ');
      const stage = order.status;
      const statusLabel = T(`menu.orderStatus.${stage}`) || stage;
      card.innerHTML = `
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="font-bold text-slate-900">${escapeHTML(T('menu.orderId', { id: String(order._id || '').slice(-6) }))}</p>
            <p class="mt-1 break-words text-sm text-slate-500">${itemText || escapeHTML(T('status.noItems'))}</p>
          </div>
          <span class="shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-bold leading-none ${badgeClass[stage] || 'bg-slate-100 text-slate-700'}">
            ${escapeHTML(statusLabel)}
          </span>
        </div>
        <div class="mt-3 flex items-center justify-between gap-3">
          <span class="font-black text-slate-900 tabular-nums">${currency(Number(order.totalPrice) || 0)}</span>
          ${stage === 'pending' ? `<button type="button" data-cancel-order="${escapeHTML(order._id)}" class="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-bold text-red-700 transition hover:bg-red-50">${escapeHTML(T('menu.cancelOrder'))}</button>` : ''}
        </div>`;
      const cancelBtn = card.querySelector('[data-cancel-order]');
      if (cancelBtn) cancelBtn.addEventListener('click', () => cancelOrderByCustomer(order._id, cancelBtn));
      list.append(card);
    }
  }

  async function cancelOrderByCustomer(orderId, button) {
    const ok = await showConfirm({
      title: T('menu.confirmCancelOrderTitle'),
      message: T('menu.confirmCancelOrderMessage'),
      okText: T('menu.confirmCancelOrderOk'),
      cancelText: T('menu.confirmCancelOrderCancel'),
      danger: true,
    });
    if (!ok) return;
    button.disabled = true;
    button.textContent = T('menu.cancelling');
    try {
      await api(`/api/order/${encodeURIComponent(orderId)}/customer-cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      showToast(T('menu.cancelled'));
      await loadOrders();
    } catch (error) {
      showToast(error.message || T('error.REQUEST_FAILED'), true);
      button.disabled = false;
      button.textContent = T('menu.cancelOrder');
    }
  }

  async function loadSession() {
    if (!sessionId) {
      window.location.replace('/queue.html?from=menu');
      return;
    }
    localStorage.setItem('sessionId', sessionId);
    try {
      const response = await api(`/api/session/${encodeURIComponent(sessionId)}`);
      const session = response.data;
      if (!session || !session.endTime) throw new Error(T('error.SESSION_NOT_FOUND'));
      if (session.isPaid || session.status === 'completed') {
        goToFeedback();
        return;
      }
      if (session.checkoutRequestedAt) {
        window.location.replace(`/checkout.html?sessionId=${encodeURIComponent(sessionId)}`);
        return;
      }
      localStorage.setItem('sessionEndTime', session.endTime);
      startTimer(session.endTime, (remaining) => {
        if (remaining.isExpired) {
          document.getElementById('submit-order').disabled = true;
          showToast(T('menu.expired'), true);
        }
      });
    } catch (error) {
      const cachedEndTime = localStorage.getItem('sessionEndTime');
      if (cachedEndTime && new Date(cachedEndTime).getTime() > Date.now()) {
        startTimer(cachedEndTime);
        showToast(error.message || T('error.REQUEST_FAILED'), true);
        return;
      }
      showToast(error.message || T('error.SESSION_NOT_FOUND'), true);
    }
  }

  async function loadMenus() {
    try {
      const response = await api('/api/menu');
      menus = Array.isArray(response.data) ? response.data : [];
      renderMenus();
      if (menus.length === 0) {
        document.getElementById('menu-content').innerHTML =
          `<p class="rounded-xl bg-white p-5 text-slate-500">${escapeHTML(T('admin.noMenus'))}</p>`;
      }
    } catch (error) {
      document.getElementById('menu-loading').classList.add('hidden');
      const errorElement = document.getElementById('menu-error');
      errorElement.textContent = error.message || T('kitchen.loadMenuFailed');
      errorElement.classList.remove('hidden');
    }
  }

  async function loadOrders() {
    if (!sessionId) return;
    const loading = document.getElementById('orders-loading');
    loading.classList.remove('hidden');
    loading.classList.add('flex');
    try {
      const response = await api(`/api/order/session/${encodeURIComponent(sessionId)}`);
      renderOrders(Array.isArray(response.data) ? response.data : []);
    } catch (error) {
      showToast(error.message || T('kitchen.loadOrdersFailed'), true);
    } finally {
      loading.classList.add('hidden');
      loading.classList.remove('flex');
    }
  }

  document.querySelectorAll('[data-main-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchMainTab(btn.dataset.mainTab));
  });

  document.getElementById('open-cart').addEventListener('click', () => {
    renderCart();
    document.getElementById('cart-modal').classList.replace('hidden', 'flex');
  });
  document.getElementById('close-cart').addEventListener('click', () => {
    document.getElementById('cart-modal').classList.replace('flex', 'hidden');
  });
  document.getElementById('cart-modal').addEventListener('click', (event) => {
    if (event.target.id === 'cart-modal') event.currentTarget.classList.replace('flex', 'hidden');
  });
  document.getElementById('submit-order').addEventListener('click', async () => {
    if (!sessionId || cart.size === 0) {
      showToast(cart.size === 0 ? T('menu.selectMenuFirst') : T('menu.noSession'), true);
      return;
    }
    const button = document.getElementById('submit-order');
    const spinner = document.getElementById('order-spinner');
    button.disabled = true;
    spinner.classList.remove('hidden');
    try {
      await api('/api/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          items: [...cart.values()].map(({ menuId, quantity, note }) => ({ menuId, quantity, note })),
        }),
      });
      cart.clear();
      renderCart();
      document.getElementById('cart-modal').classList.replace('flex', 'hidden');
      showToast(T('menu.orderSubmitted'));
      await loadOrders();
    } catch (error) {
      showToast(error.message || T('menu.orderFailed'), true);
    } finally {
      button.disabled = false;
      spinner.classList.add('hidden');
    }
  });

  document.getElementById('request-checkout').addEventListener('click', async () => {
    const button = document.getElementById('request-checkout');
    button.disabled = true;
    try {
      await api('/api/payment/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      window.location.assign(`/checkout.html?sessionId=${encodeURIComponent(sessionId)}`);
    } catch (error) {
      button.disabled = false;
      showToast(error.message || T('error.REQUEST_FAILED'), true);
    }
  });

  if (socket) {
    socket.on('connect', () => {
      socket.emit('joinRoom', 'customer');
      if (sessionId) socket.emit('joinSession', sessionId);
    });
    socket.on('order_status_changed', (payload) => {
      if (!payload || String(payload.sessionId) !== String(sessionId)) return;
      playNotification();
      const message = T(`menu.orderStatus.short.${payload.status}`) || payload.status;
      showToast(message);
      if (typeof window.notifyCustomer === 'function') window.notifyCustomer(T('notification.orderUpdate'), message);
      loadOrders();
    });
    socket.on('menu_availability_changed', (payload) => {
      if (!payload) return;
      const menu = menus.find((item) => String(item._id) === String(payload.menuId));
      if (menu) {
        menu.isAvailable = Boolean(payload.isAvailable);
        renderMenus();
        showToast(`${menu.name}: ${menu.isAvailable ? T('menu.available') : T('menu.unavailable')}`);
      }
    });
    socket.on('menu_stock_changed', (payload) => {
      if (!payload) return;
      const menu = menus.find((item) => String(item._id) === String(payload.menuId));
      if (!menu) return;
      menu.stockQuantity = payload.stockQuantity;
      menu.lowStockThreshold = payload.lowStockThreshold;
      menu.maxOrderQuantity = payload.maxOrderQuantity || menu.maxOrderQuantity;
      menu.isAvailable = Boolean(payload.isAvailable);
      const cartItem = cart.get(String(menu._id));
      if (cartItem) cartItem.stockQuantity = menu.stockQuantity;
      renderMenus();
      renderCart();
      if (menu.stockQuantity === null || typeof menu.stockQuantity === 'undefined') {
        showToast(T('menu.stockUpdated', { name: menu.name }));
      } else if (menu.stockQuantity === 0) {
        showToast(T('menu.stockOutNotify', { name: menu.name }), true);
      } else {
        showToast(T('menu.stockLeft', { name: menu.name, n: menu.stockQuantity }));
      }
    });
    socket.on('session_expiring', (payload) => {
      showSessionWarning(Number(payload && payload.minutes) || 15);
    });
    socket.on('payment_completed', (payload) => {
      if (!payload || String(payload.sessionId) !== String(sessionId)) return;
      showToast(T('menu.paymentSuccess'));
      window.setTimeout(goToFeedback, 800);
    });
    socket.on('connect_error', () => console.warn('Live menu updates are temporarily unavailable.'));
  }
  window.setInterval(() => {
    if (!socket || !socket.connected) loadMenus();
  }, 30000);

  window.addEventListener('session-expiring', (event) => {
    const { minutes } = event.detail;
    showSessionWarning(minutes);
  });
  window.addEventListener('languageChanged', () => {
    renderMenus();
    renderCart();
    if (lastOrdersCache.length) renderOrders(lastOrdersCache);
    document.querySelectorAll('[data-main-tab]').forEach((btn) => {
      const label = btn.querySelector('[data-i18n]');
      if (label) label.textContent = T(label.dataset.i18n);
    });
  });
  window.addEventListener('menu:add-to-cart', (event) => {
    const menuId = event.detail && String(event.detail.menuId || '');
    const menu = menus.find((item) => String(item._id) === menuId);
    if (menu && menu.isAvailable) addToCart(menu);
  });

  let lastOrdersCache = [];
  const _origRenderOrders = renderOrders;
  renderOrders = function(orders) {
    lastOrdersCache = orders;
    return _origRenderOrders(orders);
  };

  const viewSwitcher = document.getElementById('menu-view-switcher');
  if (viewSwitcher) {
    viewSwitcher.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-menu-view]');
      if (!btn) return;
      menuView = btn.dataset.menuView;
      localStorage.setItem('menuView', menuView);
      renderMenus();
    });
  }

  renderCartSummary();
  switchMainTab(mainTab);
  loadSession();
  loadMenus();
  loadOrders();
})();