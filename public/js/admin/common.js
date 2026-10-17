// Shared staff authentication, API, navigation, and formatting helpers.
(() => {
  const token = sessionStorage.getItem('token');
  let user = null;
  try {
    user = JSON.parse(sessionStorage.getItem('staffUser') || 'null');
  } catch (error) {
    console.warn('Stored staff profile is invalid:', error);
  }

  const adminRoles = ['admin', 'manager'];
  if (!token) {
    window.location.replace(window.StaffAuth.loginUrl());
    return;
  }
  if (!user || !adminRoles.includes(user.role)) {
    if (user && user.role === 'kitchen') window.location.replace('/kitchen/kitchen.html');
    else if (user && user.role === 'waiter') window.location.replace('/waiter/waiter.html');
    else window.location.replace(window.StaffAuth.loginUrl());
    return;
  }

  const T = (key, vars) => (window.t ? window.t(key, vars) : key);

  const NAV_ITEMS = [
    ['dashboard.html', 'admin.dashboard', 'dashboard'],
    ['manage-queue.html', 'admin.queue', 'queue'],
    ['manage-tables.html', 'admin.tables', 'tables'],
    ['manage-menu.html', 'admin.menu', 'menu'],
    ['manage-staff.html', 'admin.staff', 'staff', 'admin'],
    ['admin-setting.html', 'admin.settings', 'settings', 'admin'],
    ['reports.html', 'admin.reports', 'reports'],
    ['checkout.html', 'admin.checkout', 'payment'],
  ];

  const navIcon = (name) => {
    const paths = {
      dashboard: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
      queue: '<path d="M7 5h14M7 12h14M7 19h14"/><path d="M3 5h.01M3 12h.01M3 19h.01"/>',
      tables: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M10 4v16"/>',
      menu: '<path d="M5 6h14M5 12h14M5 18h14"/>',
      staff: '<circle cx="12" cy="8" r="3"/><path d="M5 21a7 7 0 0 1 14 0"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.1 2.1-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.04 1.56v.1h-3v-.1A1.7 1.7 0 0 0 10.68 18.6a1.7 1.7 0 0 0-1.88.34l-.06.06-2.1-2.1.06-.06A1.7 1.7 0 0 0 7.04 15 1.7 1.7 0 0 0 5.48 14H5.4v-3h.08A1.7 1.7 0 0 0 7.04 10a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.1-2.1.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 11.72 4.8v-.1h3v.1a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.1 2.1-.06.06A1.7 1.7 0 0 0 19.4 10a1.7 1.7 0 0 0 1.56 1h.08v3h-.08A1.7 1.7 0 0 0 19.4 15Z"/>',
      reports: '<path d="M4 20V4M4 20h16M8 16v-5M12 16V7M16 16v-8"/>',
      payment: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h3"/>',
      display: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
      logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    };
    return `<svg viewBox="0 0 24 24" class="h-full w-full" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
  };

  function openDisplayWindow() {
    const width = Math.min(screen.availWidth, 1920);
    const height = Math.min(screen.availHeight, 1080);
    const left = Math.round((screen.availWidth - width) / 2);
    const top = Math.round((screen.availHeight - height) / 2);
    const features = [
      `width=${width}`,
      `height=${height}`,
      `left=${left}`,
      `top=${top}`,
      'menubar=no', 'toolbar=no', 'location=no', 'status=no', 'scrollbars=no', 'resizable=yes',
    ].join(',');

    const popup = window.open('/display.html', 'queueDisplayWindow', features);
    if (!popup) {
      window.alert(T('admin.openDisplayBlocked'));
      return;
    }
    try { popup.focus(); } catch {}
  }

  const sidebar = document.getElementById('admin-sidebar');
  if (sidebar) {
    const currentPage = window.location.pathname.split('/').pop();
    sidebar.className = 'fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] -translate-x-full flex-col bg-slate-950 text-white shadow-2xl transition-transform duration-200 lg:sticky lg:top-0 lg:h-screen lg:min-h-screen lg:w-64 lg:shrink-0 lg:translate-x-0';

    document.body.insertAdjacentHTML('afterbegin', `
      <button id="admin-drawer-toggle" type="button" data-no-btn class="btn btn-square fixed left-3 top-3 z-50 border-0 bg-slate-950 text-white shadow-lg hover:bg-slate-800 lg:hidden" aria-label="Open navigation" aria-expanded="false">
        <svg viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
      </button>
      <button id="admin-drawer-overlay" type="button" data-no-btn class="fixed inset-0 z-30 hidden bg-black/50 lg:hidden" aria-label="Close navigation"></button>`);

    function renderNavItem([href, labelKey, icon, role]) {
      if (role === 'admin' && user.role !== 'admin') return '';
      const isActive = currentPage === href;
      return `
        <a href="/admin/${href}"
          class="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition ${
            isActive
              ? 'bg-orange-600 text-white shadow-lg shadow-orange-950/30'
              : 'text-slate-300 hover:bg-slate-800 hover:text-white'
          }"
          ${isActive ? 'aria-current="page"' : ''}>
          <span class="flex h-5 w-5 shrink-0 items-center justify-center ${isActive ? 'text-white' : 'text-slate-400'}" aria-hidden="true">${navIcon(icon)}</span>
          <span class="min-w-0 flex-1 truncate">${T(labelKey)}</span>
        </a>`;
    }

    const renderNavigation = () => {
      const navHtml = NAV_ITEMS.map(renderNavItem).filter(Boolean).join('');

      sidebar.innerHTML = `
        <!-- Header -->
        <div class="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-5">
          <a href="/admin/dashboard.html" class="flex min-w-0 items-center gap-3">
            <img src="/assets/images/logo.png" alt="" class="h-10 w-10 shrink-0 rounded-xl bg-white p-1">
            <span data-sidebar-brand class="truncate text-base font-black">Smart Queue</span>
          </a>
        </div>

        <!-- User card (white background, no avatar, plain text role) -->
        <div class="shrink-0 px-3 pt-4">
          <div class="rounded-xl bg-white px-4 py-3.5">
            <p class="truncate text-sm font-bold leading-tight text-slate-900">
              ${escapeHTML(user.fullName || user.username)}
            </p>
            <p class="mt-1 truncate text-[11px] font-semibold leading-tight text-orange-600">
              ${T(`staff.role.${user.role}`)}
            </p>
          </div>
        </div>

        <!-- Nav (scrollable middle) -->
        <nav id="admin-nav" class="flex-1 space-y-1 overflow-y-auto px-3 py-4" aria-label="Staff navigation">
          ${navHtml}
        </nav>

        <!-- Footer (pinned bottom): display + divider + logout -->
        <div class="shrink-0 border-t border-white/10 px-3 py-4">
          <button id="admin-open-display" type="button" data-no-btn
            class="group flex min-h-11 w-full items-center gap-3 rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2.5 text-left text-sm font-semibold text-orange-200 transition hover:border-orange-500/60 hover:bg-orange-600 hover:text-white">
            <span class="flex h-5 w-5 shrink-0 items-center justify-center text-orange-400 transition group-hover:text-white" aria-hidden="true">${navIcon('display')}</span>
            <span class="min-w-0 flex-1 truncate">${T('admin.openDisplay')}</span>
            <svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0 opacity-60 transition group-hover:opacity-100" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/>
            </svg>
          </button>

          <div class="my-4 border-t border-white/10"></div>

          <button id="admin-logout" type="button" data-no-btn
            class="flex min-h-11 w-full items-center gap-3 rounded-lg border border-red-500/40 px-3 py-2.5 text-left text-sm font-bold text-red-200 transition hover:border-red-500/70 hover:bg-red-950/60 hover:text-red-100">
            <span class="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">${navIcon('logout')}</span>
            <span class="min-w-0 flex-1 truncate">${T('common.logout')}</span>
          </button>
        </div>`;

      document.getElementById('admin-open-display').addEventListener('click', openDisplayWindow);
      document.getElementById('admin-logout').addEventListener('click', () => {
        window.StaffAuth.clearCredentials();
        window.location.replace('/login.html');
      });
    };

    const closeDrawer = () => {
      sidebar.classList.add('-translate-x-full');
      document.getElementById('admin-drawer-overlay').classList.add('hidden');
      document.getElementById('admin-drawer-toggle').setAttribute('aria-expanded', 'false');
    };
    document.getElementById('admin-drawer-toggle').addEventListener('click', () => {
      const isOpen = !sidebar.classList.contains('-translate-x-full');
      if (isOpen) closeDrawer();
      else {
        sidebar.classList.remove('-translate-x-full');
        document.getElementById('admin-drawer-overlay').classList.remove('hidden');
        document.getElementById('admin-drawer-toggle').setAttribute('aria-expanded', 'true');
      }
    });
    document.getElementById('admin-drawer-overlay').addEventListener('click', closeDrawer);
    sidebar.addEventListener('click', (event) => {
      if (event.target.closest('a')) closeDrawer();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeDrawer();
    });
    renderNavigation();
    window.addEventListener('languageChanged', renderNavigation);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    let payload;
    try { payload = await response.json(); }
    catch (error) { throw new Error('Invalid server response'); }
    if (response.status === 401 || response.status === 403) {
      window.StaffAuth.clearCredentials();
      window.location.replace(window.StaffAuth.loginUrl());
      throw new Error((payload.code && T(`error.${payload.code}`)) || payload.message || 'Unauthorized');
    }
    if (!response.ok || payload.success === false) {
      throw new Error((payload.code && T(`error.${payload.code}`)) || payload.message || 'Request failed');
    }
    return payload;
  }

  function currency(amount) {
    return `฿${new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(amount) || 0)}`;
  }

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));
  }

  function message(message, isError = false) {
    const element = document.getElementById('page-message');
    if (!element) { window.alert(message); return; }
    element.textContent = message;
    element.className = `mb-4 rounded-xl p-4 ${isError ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'}`;
  }

  let confirmModalEl = null;

  function ensureConfirmModal() {
    if (confirmModalEl) return confirmModalEl;
    const el = document.createElement('div');
    el.id = 'admin-confirm-modal';
    el.className = 'fixed inset-0 z-[300] hidden items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `
      <section class="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div class="flex items-start gap-3 p-5">
          <span data-confirm-icon class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-orange-100 text-2xl text-orange-700">
            <svg viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></svg>
          </span>
          <div class="min-w-0 flex-1">
            <h2 data-confirm-title class="text-lg font-black text-slate-900"></h2>
            <p data-confirm-message class="mt-1.5 whitespace-pre-line text-sm text-slate-600"></p>
          </div>
        </div>
        <div class="flex gap-2 border-t border-slate-100 bg-slate-50/50 px-5 py-4">
          <button type="button" data-no-btn data-confirm-cancel class="min-h-11 flex-1 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 transition hover:bg-slate-100"></button>
          <button type="button" data-no-btn data-confirm-ok class="min-h-11 flex-1 rounded-xl bg-orange-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-orange-700"></button>
        </div>
      </section>`;
    document.body.append(el);
    confirmModalEl = el;
    return el;
  }

  function confirm(prompt, opts = {}) {
    return new Promise((resolve) => {
      const el = ensureConfirmModal();
      const titleEl = el.querySelector('[data-confirm-title]');
      const msgEl = el.querySelector('[data-confirm-message]');
      const okBtn = el.querySelector('[data-confirm-ok]');
      const cancelBtn = el.querySelector('[data-confirm-cancel]');
      const iconEl = el.querySelector('[data-confirm-icon]');

      titleEl.textContent = opts.title || T('common.ok');
      msgEl.textContent = prompt || '';
      okBtn.textContent = opts.okText || T('common.ok');
      cancelBtn.textContent = opts.cancelText || T('common.cancel');

      okBtn.classList.remove('bg-orange-600', 'hover:bg-orange-700', 'bg-red-700', 'hover:bg-red-800');
      iconEl.classList.remove('bg-orange-100', 'text-orange-700', 'bg-red-100', 'text-red-700');
      if (opts.danger) {
        okBtn.classList.add('bg-red-700', 'hover:bg-red-800');
        iconEl.classList.add('bg-red-100', 'text-red-700');
      } else {
        okBtn.classList.add('bg-orange-600', 'hover:bg-orange-700');
        iconEl.classList.add('bg-orange-100', 'text-orange-700');
      }

      const cleanup = () => {
        el.classList.replace('flex', 'hidden');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        el.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
      };
      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      const onBackdrop = (e) => { if (e.target === el) onCancel(); };
      const onKey = (e) => { if (e.key === 'Escape') onCancel(); };

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      el.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);

      el.classList.replace('hidden', 'flex');
      window.setTimeout(() => okBtn.focus(), 50);
    });
  }

  function bindFileInput(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const display = document.querySelector(`[data-file-name="${inputId}"]`);
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (display) display.textContent = file ? file.name : '';
    });
  }

  window.Admin = {
    token, user, api, currency, escapeHTML, message, confirm, bindFileInput, openDisplayWindow,
    t: T,
    isAdmin: user.role === 'admin',
    connectSocket() {
      if (typeof io !== 'function') return null;
      const socket = io({ auth: { token } });
      socket.on('connect', () => socket.emit('joinRoom', 'admin'));
      return socket;
    },
  };
})();