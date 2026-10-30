// Load dashboard metrics, chart the last week, and refresh after live events.
(() => {
  const Admin = window.Admin;
  if (!Admin) return;
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);
  const loading = document.getElementById('dashboard-loading');
  const content = document.getElementById('dashboard-content');
  const error = document.getElementById('admin-error');
  const live = document.getElementById('dashboard-live');
  const POLL_INTERVAL_MS = 30000;
  const REQUEST_TIMEOUT_MS = 15000;
  const Live = window.LiveUpdates;
  const connection = Live.createStatus({
    element: live, intervalMs: POLL_INTERVAL_MS, resources: ['reports'],
    baseClass: 'inline-flex max-w-full items-center rounded-md px-4 py-2 text-sm font-semibold',
  });
  let chart;
  let averageDiningMinutes = null;
  const role = Admin.user.role;
  const rolePrefix = role === 'manager' ? 'admin.dashboardManager' : 'admin.dashboardAdmin';

  document.getElementById('manager-quick-actions').classList.toggle('hidden', role !== 'manager');
  document.getElementById('admin-quick-actions').classList.toggle('hidden', role !== 'admin');

  const roleCopy = {
    admin: {
      th: ['ภาพรวมผู้ดูแลระบบ', 'แดชบอร์ดผู้ดูแลระบบ', 'ภาพรวมยอดขาย ลูกค้า และผลการดำเนินงานของร้าน'],
      en: ['Administrator overview', 'Administrator Dashboard', 'A high-level view of sales, customers, and restaurant performance.'],
    },
    manager: {
      th: ['ศูนย์ปฏิบัติการผู้จัดการ', 'แดชบอร์ดผู้จัดการร้าน', 'จัดการคิว โต๊ะ เมนู และติดตามการให้บริการประจำวัน'],
      en: ['Manager operations', 'Restaurant Manager Dashboard', 'Manage queues, tables, menus, and daily service operations.'],
    },
  };

  function currentLang() {
    return localStorage.getItem('lang') === 'en' ? 'en' : 'th';
  }
  function currentLocale() {
    return currentLang() === 'en' ? 'en-US' : 'th-TH';
  }

  // The average dining card mixes a number with a translated unit ("นาที"), so
  // it is rendered from data instead of data-i18n; otherwise the translation
  // pass overwrites the number with the bare unit.
  function renderAverageDining() {
    const element = document.getElementById('average-dining');
    if (!element) return;
    const minutes = Number.isFinite(averageDiningMinutes) ? Math.round(averageDiningMinutes) : 0;
    element.textContent = `${minutes} ${T('common.minutes')}`;
  }

  function updateRoleHeader() {
    const fallback = roleCopy[role][currentLang()];
    const keys = [`${rolePrefix}Label`, `${rolePrefix}Title`, `${rolePrefix}Description`];
    const elements = [
      document.getElementById('dashboard-role-label'),
      document.getElementById('dashboard-title'),
      document.getElementById('dashboard-role-description'),
    ];
    elements.forEach((element, index) => {
      const translation = T(keys[index]);
      element.textContent = translation && translation !== keys[index] ? translation : fallback[index];
    });
    const dateEl = document.getElementById('dashboard-date');
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString(currentLocale(), { dateStyle: 'full' });
    if (chart) chart.data.datasets[0].label = `${T('admin.todaySales')} (${T('common.baht')})`;
    if (chart) chart.update();
    renderAverageDining();
  }
  updateRoleHeader();
  window.addEventListener('languageChanged', updateRoleHeader);

  function lastSevenDays() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - 6 + index);
      return date;
    });
  }

  const loadDashboard = Live.createLoader(async () => {
    loading.classList.remove('hidden');
    // Treat the five reports as one snapshot: no healthy badge or partial
    // metric replacement until every required report has loaded successfully.
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const options = { cache: 'no-store', signal: controller.signal };
    try {
      const [salesToday, salesWeek, queueStats, dining, topMenus] = await Promise.all([
        Admin.api('/api/report/daily-sales', options),
        Admin.api('/api/report/daily-sales?days=7', options),
        Admin.api('/api/report/queue-stats', options),
        Admin.api('/api/report/dining-time', options),
        Admin.api('/api/report/top-menus', options),
      ]);
      if (!Number.isFinite(salesToday?.data?.totalSales)
        || !Array.isArray(salesWeek?.data?.salesByDay)
        || !salesWeek.data.salesByDay.every((row) => typeof row?.date === 'string' && Number.isFinite(row.totalSales))
        || !Number.isFinite(queueStats?.data?.customerCount ?? queueStats?.data?.totalQueues)
        || !Number.isFinite(queueStats?.data?.waitingCount)
        || !Number.isFinite(dining?.data?.averageMinutes)
        || !Array.isArray(topMenus?.data)
        || !topMenus.data.every((menu) => menu && typeof menu.name === 'string'
          && Number.isFinite(menu.quantitySold) && Number.isFinite(menu.sales))) {
        throw new Error(T('error.REQUEST_FAILED'));
      }
      document.getElementById('sales-today').textContent = Admin.currency(salesToday.data.totalSales);
      document.getElementById('customers-today').textContent =
        String(queueStats.data.customerCount ?? queueStats.data.totalQueues ?? 0);
      document.getElementById('queues-waiting').textContent = String(queueStats.data.waitingCount || 0);
      averageDiningMinutes = dining.data.averageMinutes || 0;
      renderAverageDining();

      const salesByDay = new Map((salesWeek.data.salesByDay || []).map((row) => [row.date, row.totalSales]));
      const dates = lastSevenDays();
      const labels = dates.map((date) => date.toLocaleDateString(currentLocale(), { day: 'numeric', month: 'short' }));
      const values = dates.map((date) => {
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        return salesByDay.get(key) || 0;
      });
      if (typeof Chart === 'function') {
        if (chart) {
          chart.data.labels = labels;
          chart.data.datasets[0].data = values;
          chart.data.datasets[0].label = `${T('admin.todaySales')} (${T('common.baht')})`;
          chart.update();
        } else {
          chart = new Chart(document.getElementById('sales-chart'), {
            type: 'bar',
            data: {
              labels,
              datasets: [{
                label: `${T('admin.todaySales')} (${T('common.baht')})`,
                data: values,
                backgroundColor: '#f97316',
                borderRadius: 8,
              }],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              scales: { y: { beginAtZero: true, ticks: { callback: (value) => `฿${value}` } } },
              plugins: { legend: { display: false } },
            },
          });
        }
      }

      const rows = document.getElementById('top-menu-rows');
      rows.replaceChildren();
      const menus = Array.isArray(topMenus.data) ? topMenus.data : [];
      document.getElementById('top-menu-empty').classList.toggle('hidden', menus.length > 0);
      for (const menu of menus) {
        const row = document.createElement('tr');
        row.className = 'border-b border-slate-100 last:border-0';
        row.innerHTML = `<td class="py-3 pr-3 font-semibold">${Admin.escapeHTML(menu.name)}</td><td class="py-3 text-right">${Number(menu.quantitySold) || 0}</td><td class="py-3 text-right">${Admin.currency(menu.sales)}</td>`;
        rows.append(row);
      }

      error.classList.add('hidden');
      content.classList.remove('hidden');
      connection.success('reports');
    } catch (loadError) {
      connection.failure('reports');
      error.textContent = loadError.name === 'AbortError' ? T('error.REQUEST_FAILED')
        : loadError.message || T('error.REQUEST_FAILED');
      error.classList.remove('hidden');
    } finally {
      window.clearTimeout(timeout);
      controller.abort(); // Cancel any sibling reads left pending after failure.
      loading.classList.add('hidden');
      document.getElementById('dashboard-date').textContent =
        new Date().toLocaleDateString(currentLocale(), { dateStyle: 'full' });
    }
  });

  const socket = Live.openSocket({ auth: { token: Admin.token } });
  if (socket) {
    socket.on('connect', () => {
      socket.emit('joinRoom', 'admin');
      connection.setSocketConnected(true);
      loadDashboard();
    });
    socket.on('disconnect', () => connection.setSocketConnected(false));
    socket.on('connect_error', () => connection.setSocketConnected(false));
    ['payment_completed', 'new_queue', 'queue_called', 'order_status_changed'].forEach((eventName) => {
      socket.on(eventName, loadDashboard);
    });
  }

  window.addEventListener('online', loadDashboard);
  window.setInterval(loadDashboard, POLL_INTERVAL_MS);
  loadDashboard();
})();
