// Load dashboard metrics, chart the last week, and refresh after live events.
(() => {
  const Admin = window.Admin;
  if (!Admin) return;
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);
  const loading = document.getElementById('dashboard-loading');
  const content = document.getElementById('dashboard-content');
  const error = document.getElementById('admin-error');
  const live = document.getElementById('dashboard-live');
  let chart;
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
    if (live && !live.dataset.state) live.textContent = T('status.connecting');
    else if (live && live.dataset.state === 'online') live.textContent = T('status.live');
    else if (live && live.dataset.state === 'offline') live.textContent = T('status.offline');
    if (chart) chart.data.datasets[0].label = `${T('admin.todaySales')} (${T('common.baht')})`;
    if (chart) chart.update();
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

  async function loadDashboard() {
    loading.classList.remove('hidden');
    try {
      const [salesToday, salesWeek, queueStats, dining, topMenus] = await Promise.all([
        Admin.api('/api/report/daily-sales'),
        Admin.api('/api/report/daily-sales?days=7'),
        Admin.api('/api/report/queue-stats'),
        Admin.api('/api/report/dining-time'),
        Admin.api('/api/report/top-menus'),
      ]);
      document.getElementById('sales-today').textContent = Admin.currency(salesToday.data.totalSales);
      document.getElementById('customers-today').textContent =
        String(queueStats.data.customerCount ?? queueStats.data.totalQueues ?? 0);
      document.getElementById('queues-waiting').textContent = String(queueStats.data.waitingCount || 0);
      document.getElementById('average-dining').textContent =
        `${Math.round(dining.data.averageMinutes || 0)} ${T('common.minutes')}`;

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
    } catch (loadError) {
      error.textContent = loadError.message || 'Failed to load dashboard';
      error.classList.remove('hidden');
    } finally {
      loading.classList.add('hidden');
      document.getElementById('dashboard-date').textContent =
        new Date().toLocaleDateString(currentLocale(), { dateStyle: 'full' });
    }
  }

  const socket = Admin.connectSocket();
  if (socket) {
    socket.on('connect', () => {
      live.dataset.state = 'online';
      live.textContent = T('status.live');
      live.className = 'rounded-xl bg-green-100 px-4 py-2 font-semibold text-green-800';
    });
    socket.on('disconnect', () => {
      live.dataset.state = 'offline';
      live.textContent = T('status.connecting');
      live.className = 'rounded-xl bg-amber-100 px-4 py-2 font-semibold text-amber-800';
    });
    ['payment_completed', 'new_queue', 'queue_called', 'order_status_changed'].forEach((eventName) => {
      socket.on(eventName, loadDashboard);
    });
  } else {
    live.textContent = 'Auto-refresh 30s';
  }

  window.setInterval(loadDashboard, 30000);
  loadDashboard();
})();