// Reports: date range, summary metrics, charts, bills table, menu, staff, customer tabs.
(() => {
  const Admin = window.Admin;
  if (!Admin) return;

  const T = (key, vars) => (window.t ? window.t(key, vars) : key);
  const $ = (id) => document.getElementById(id);
  const on = (target, event, handler) => {
    const el = typeof target === 'string' ? $(target) : target;
    if (el && el.addEventListener) el.addEventListener(event, handler);
  };
  const currentLang = () => (localStorage.getItem('lang') === 'en' ? 'en' : 'th');
  const currentLocale = () => (currentLang() === 'en' ? 'en-US' : 'th-TH');

  const els = {
    from: $('range-from'),
    to: $('range-to'),
    apply: $('apply-range'),
    export: $('export-csv'),
    rangeLabel: $('report-range-label'),
    loading: $('report-loading'),
    content: $('report-content'),
  };

  let currentRange = { from: null, to: null, preset: 'today' };
  let summaryCache = null;
  let dailyCache = null;
  let csvRows = [];
  let billsPage = 1;
  let billsLimit = 20;
  let billsMethod = '';
  let billsCache = [];
  const charts = {};

  const catLabel = (category) => window.MenuCategories.label(category, T);
  const roleLabel = (r) => T(`staff.role.${r}Short`) || T(`staff.role.${r}`) || r;
  const zoneLabel = (z) => T(`table.zone.${z}`) || z;

  function pad(n) { return String(n).padStart(2, '0'); }
  function toInputDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

  function presetRange(preset) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const end = new Date(today);
    let start = new Date(today);
    switch (preset) {
      case 'today': break;
      case 'yesterday': start.setDate(start.getDate() - 1); end.setDate(end.getDate() - 1); break;
      case '7d': start.setDate(start.getDate() - 6); break;
      case '30d': start.setDate(start.getDate() - 29); break;
      case 'this-month': start = new Date(today.getFullYear(), today.getMonth(), 1); break;
      case 'last-month': start = new Date(today.getFullYear(), today.getMonth() - 1, 1); end.setDate(0); break;
      default: break;
    }
    return { from: toInputDate(start), to: toInputDate(end), preset };
  }

  function markPresetButtons() {
    document.querySelectorAll('[data-range]').forEach((btn) => {
      const selected = btn.dataset.range === currentRange.preset;
      btn.classList.toggle('bg-orange-600', selected);
      btn.classList.toggle('text-white', selected);
      btn.classList.toggle('border-orange-600', selected);
      btn.classList.toggle('text-slate-600', !selected);
      btn.classList.toggle('bg-white', !selected);
    });
  }

  function setRange(range, { reload = true } = {}) {
    currentRange = range;
    if (els.from) els.from.value = range.from;
    if (els.to) els.to.value = range.to;
    markPresetButtons();
    const from = new Date(`${range.from}T00:00:00`);
    const to = new Date(`${range.to}T00:00:00`);
    const days = Math.max(1, Math.round((to - from) / 86400000) + 1);
    if (els.rangeLabel) {
      const fmtDate = (d) => d.toLocaleDateString(currentLocale(), { day: 'numeric', month: 'short', year: '2-digit' });
      els.rangeLabel.textContent = T('reports.rangeLabelValue', { from: fmtDate(from), to: fmtDate(to), days });
    }
    if (reload) {
      loadSummary();
      if (billsPage > 1) billsPage = 1;
      billsCache = [];
    }
  }

  function setDelta(el, percent, { invertGood = false } = {}) {
    if (!el) return;
    if (!Number.isFinite(percent)) {
      el.textContent = '—';
      el.classList.remove('text-green-600', 'text-red-600');
      el.classList.add('text-slate-400');
      return;
    }
    if (percent === 0) {
      el.textContent = T('reports.deltaEqual');
    } else {
      el.textContent = T('reports.deltaCompare', {
        sign: percent > 0 ? '+' : '',
        percent: percent.toFixed(1),
      });
    }
    const isGood = invertGood ? percent <= 0 : percent > 0;
    el.classList.remove('text-green-600', 'text-red-600', 'text-slate-400');
    if (percent === 0) el.classList.add('text-slate-400');
    else if (isGood) el.classList.add('text-green-600');
    else el.classList.add('text-red-600');
  }

  function setText(id, value) { const el = $(id); if (el) el.textContent = value; }

  function rangeParams() {
    return new URLSearchParams({ from: currentRange.from, to: currentRange.to });
  }

  function renderSummary(data) {
    summaryCache = data;
    const m = data.metrics;
    setText('m-sales', Admin.currency(m.totalSales.value));
    setDelta($('m-sales-delta'), m.totalSales.percent);
    setText('m-bills', String(m.paymentCount.value || 0));
    setDelta($('m-bills-delta'), m.paymentCount.percent);
    setText('m-avg-bill', Admin.currency(m.avgBill.value));
    setDelta($('m-avg-bill-delta'), m.avgBill.percent);
    setText('m-customers', String(m.customers.value || 0));
    setDelta($('m-customers-delta'), m.customers.percent);
    setText('m-queues', String(m.totalQueues.value || 0));
    setDelta($('m-queues-delta'), m.totalQueues.percent);
    setText('m-noshow', `${m.noShowRate.value.toFixed(1)}%`);
    setDelta($('m-noshow-delta'), m.noShowRate.percent, { invertGood: true });
    setText('m-dining', T('reports.minutesShort', { n: Math.round(m.avgDiningMinutes.value) }));
    setDelta($('m-dining-delta'), m.avgDiningMinutes.percent);
    setText('m-turnover', m.turnover.value.toFixed(1));
    setText('m-turnover-unit', T('reports.turnoverUnit'));
  }

  async function loadSummary() {
    if (els.loading) els.loading.classList.remove('hidden');

    let summaryData = null;
    let dailyData = null;
    try {
      const s = await Admin.api(`/api/report/summary?${rangeParams().toString()}`);
      summaryData = s.data;
    } catch (e) {
      console.error('[reports] summary failed:', e);
      Admin.message(T('reports.loadFailed', { message: e.message }), true);
    }
    try {
      const d = await Admin.api(`/api/report/daily-sales?${rangeParams().toString()}`);
      dailyData = d.data;
    } catch (e) {
      console.error('[reports] daily-sales failed:', e);
    }

    if (els.content) els.content.classList.remove('hidden');
    if (els.loading) els.loading.classList.add('hidden');

    await new Promise((resolve) => requestAnimationFrame(resolve));

    if (summaryData) renderSummary(summaryData);
    if (dailyData) {
      dailyCache = dailyData;
      drawDailyChart(dailyData.salesByDay || []);
    }
    if (summaryData && dailyData) buildCsv(summaryData, dailyData);

    loadComparison();
  }

  function destroyChart(key) {
    if (charts[key]) { charts[key].destroy(); charts[key] = null; }
  }

  function drawDailyChart(data) {
    if (typeof Chart !== 'function') return;
    const canvas = $('chart-daily');
    if (!canvas) return;

    const labels = data.map((r) => new Date(`${r.date}T00:00:00`).toLocaleDateString(currentLocale(), { day: 'numeric', month: 'short' }));
    const values = data.map((r) => r.totalSales);

    destroyChart('daily');

    if (labels.length === 0) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = '14px sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'center';
      ctx.fillText(T('reports.noData'), canvas.width / 2, canvas.height / 2);
      return;
    }

    charts.daily = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: T('reports.chartSalesLabel'),
          data: values,
          backgroundColor: '#ea580c',
          borderColor: '#ea580c',
          borderWidth: 0,
          borderRadius: 6,
          maxBarThickness: 48,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        plugins: {
          legend: { display: true, position: 'top' },
          tooltip: {
            callbacks: {
              label: (ctx) => `${T('reports.chartSalesLabel')}: ${Admin.currency(ctx.parsed.y)}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, ticks: { callback: (v) => `฿${v}` } },
        },
      },
    });
  }

  async function loadBills() {
    const rows = $('bills-rows');
    const empty = $('bills-empty');
    const loading = $('bills-loading');
    const count = $('bills-count');
    const pageEl = $('bills-page');
    const prevBtn = $('bills-prev');
    const nextBtn = $('bills-next');
    if (!rows) return;
    if (loading) loading.classList.remove('hidden');
    if (empty) empty.classList.add('hidden');
    rows.replaceChildren();
    try {
      const params = rangeParams();
      params.set('page', String(billsPage));
      params.set('limit', String(billsLimit));
      if (billsMethod) params.set('method', billsMethod);
      const payload = await Admin.api(`/api/report/bills?${params.toString()}`);
      const { items, total, page, pages } = payload.data;
      billsCache = items;
      if (count) count.textContent = T('reports.billsCount', { n: total });
      if (pageEl) pageEl.textContent = T('reports.billsPage', { page, pages });
      if (prevBtn) prevBtn.disabled = page <= 1;
      if (nextBtn) nextBtn.disabled = page >= pages;
      if (empty) empty.classList.toggle('hidden', items.length > 0);
      for (const b of items) {
        const tr = document.createElement('tr');
        tr.className = 'border-b border-slate-100';
        const time = new Date(b.paidAt).toLocaleString(currentLocale(), { dateStyle: 'short', timeStyle: 'short' });
        const method = b.method === 'cash' ? T('admin.checkout.cash') : 'QR';
        const methodCls = b.method === 'cash' ? 'bg-green-100 text-green-800' : 'bg-cyan-100 text-cyan-800';
        const zoneShort = b.zone ? T(`reports.zoneShort.${b.zone}`) : '';
        const queueLine = b.queueNumber
          ? `${Admin.escapeHTML(b.queueNumber)}${b.customerCount ? ` · ${b.customerCount} ${T('common.people')}` : ''}`
          : (b.customerCount ? `${b.customerCount} ${T('common.people')}` : '—');
        const durLine = b.durationMinutes != null
          ? T('reports.minutesShort', { n: b.durationMinutes })
          : '—';
        tr.innerHTML = `
          <td class="py-3 pr-3 text-xs text-slate-500">${time}</td>
          <td class="py-3 pr-3 font-bold">${Admin.escapeHTML(b.tableNumber)}<span class="ml-1 text-xs font-normal text-slate-400">${zoneShort}</span></td>
          <td class="py-3 pr-3 text-xs">${queueLine}</td>
          <td class="py-3 pr-3 text-xs text-slate-500">${durLine}</td>
          <td class="py-3 pr-3"><span class="rounded-full px-2 py-0.5 text-[11px] font-bold ${methodCls}">${method}</span></td>
          <td class="py-3 pr-3 text-xs text-slate-500">${b.staff ? Admin.escapeHTML(b.staff.fullName || b.staff.username) : '—'}</td>
          <td class="py-3 pr-3 text-right font-bold text-orange-700">${Admin.currency(b.amount)}</td>`;
        rows.append(tr);
      }
    } catch (error) {
      Admin.message(error.message || T('reports.loadFailed', { message: '' }), true);
    } finally {
      if (loading) loading.classList.add('hidden');
    }
  }

  async function loadMenuTab() {
    try {
      const res = await Admin.api(`/api/report/menu-trends?${rangeParams().toString()}`);
      const { top, bottom } = res.data;

      const topBody = $('menu-top-rows');
      const botBody = $('menu-bottom-rows');
      const topEmpty = $('menu-top-empty');
      const botEmpty = $('menu-bottom-empty');

      if (topBody) {
        topBody.replaceChildren();
        if (topEmpty) topEmpty.classList.toggle('hidden', top.length > 0);
        top.forEach((m) => {
          const tr = document.createElement('tr');
          tr.className = 'border-b border-slate-100';
          const arrow = m.change > 0
            ? `<span class="text-green-600">▲ ${m.percent.toFixed(0)}%</span>`
            : m.change < 0
              ? `<span class="text-red-600">▼ ${Math.abs(m.percent).toFixed(0)}%</span>`
              : '<span class="text-slate-400">—</span>';
          tr.innerHTML = `
            <td class="py-2 pr-2 font-semibold">${Admin.escapeHTML(m.name)}</td>
            <td class="py-2 pr-2 text-right">${m.qty}</td>
            <td class="py-2 pr-2 text-right font-bold text-orange-700">${Admin.currency(m.sales)}</td>
            <td class="py-2 pr-2 text-right text-xs">${arrow}</td>`;
          topBody.append(tr);
        });
      }

      if (botBody) {
        botBody.replaceChildren();
        if (botEmpty) botEmpty.classList.toggle('hidden', bottom.length > 0);
        bottom.forEach((m) => {
          const tr = document.createElement('tr');
          tr.className = 'border-b border-slate-100';
          tr.innerHTML = `
            <td class="py-2 pr-2 font-semibold">${Admin.escapeHTML(m.name)}</td>
            <td class="py-2 pr-2 text-right">${m.qty}</td>
            <td class="py-2 pr-2 text-right font-bold text-orange-700">${Admin.currency(m.sales)}</td>`;
          botBody.append(tr);
        });
      }
    } catch (e) {
      console.warn('[reports] menu-trends failed:', e.message);
    }
  }

  async function loadStaffTab() {
    try {
      const res = await Admin.api(`/api/report/staff-performance?${rangeParams().toString()}`);
      const rows = $('staff-rows');
      const empty = $('staff-empty');
      if (!rows) return;
      rows.replaceChildren();
      if (empty) empty.classList.toggle('hidden', res.data.length > 0);
      res.data.forEach((s, i) => {
        const tr = document.createElement('tr');
        tr.className = 'border-b border-slate-100';
        tr.innerHTML = `
          <td class="py-3 pr-3 font-bold text-slate-400">${i + 1}</td>
          <td class="py-3 pr-3 font-semibold">${Admin.escapeHTML(s.fullName || s.username)}<span class="ml-1 text-xs text-slate-400">@${Admin.escapeHTML(s.username)}</span></td>
          <td class="py-3 pr-3 text-xs">${roleLabel(s.role) || '—'}</td>
          <td class="py-3 pr-3 text-right font-bold">${s.billCount}</td>
          <td class="py-3 pr-3 text-right font-bold text-orange-700">${Admin.currency(s.totalSales)}</td>
          <td class="py-3 pr-3 text-right text-sm">${Admin.currency(s.avgBill)}</td>
          <td class="py-3 pr-3 text-right text-xs">${s.cashCount} / ${s.qrCount}</td>`;
        rows.append(tr);
      });
    } catch (e) {
      console.warn('[reports] staff-performance failed:', e.message);
    }
  }

  async function loadCustomerTab() {
    let fb = null;
    let peak = null;
    try { fb = (await Admin.api(`/api/report/feedback-summary?${rangeParams().toString()}`)).data; }
    catch (e) { console.warn('[reports] feedback-summary failed:', e.message); }
    try { peak = (await Admin.api(`/api/report/peak-hours?${rangeParams().toString()}`)).data; }
    catch (e) { console.warn('[reports] peak-hours failed:', e.message); }

    if (fb) {
      setText('fb-avg', fb.average.toFixed(1));
      setText('fb-total', String(fb.total));
      const distEl = $('fb-dist');
      if (distEl) {
        distEl.replaceChildren();
        for (let star = 5; star >= 1; star -= 1) {
          const count = fb.distribution[star] || 0;
          const percent = fb.total > 0 ? (count / fb.total) * 100 : 0;
          const row = document.createElement('div');
          row.className = 'flex items-center gap-2';
          row.innerHTML = `
            <span class="w-8 shrink-0 text-xs font-bold">${star}★</span>
            <div class="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
              <div class="h-full bg-orange-500" style="width:${percent.toFixed(1)}%"></div>
            </div>
            <span class="w-10 shrink-0 text-right text-xs text-slate-500">${count}</span>`;
          distEl.append(row);
        }
      }
      const recentEl = $('fb-recent');
      const emptyEl = $('fb-recent-empty');
      if (recentEl) {
        recentEl.replaceChildren();
        if (emptyEl) emptyEl.classList.toggle('hidden', fb.recent.length > 0);
        for (const c of fb.recent) {
          const card = document.createElement('div');
          card.className = 'rounded-xl border border-slate-200 bg-slate-50 p-3';
          const stars = '★'.repeat(c.rating) + '☆'.repeat(Math.max(0, 5 - c.rating));
          const time = new Date(c.createdAt).toLocaleString(currentLocale(), { dateStyle: 'short', timeStyle: 'short' });
          card.innerHTML = `
            <div class="flex items-center justify-between gap-2">
              <span class="text-base font-bold text-amber-500">${stars}</span>
              <span class="text-xs text-slate-400">${time}</span>
            </div>
            <p class="mt-1 text-sm text-slate-700">${Admin.escapeHTML(c.comment)}</p>`;
          recentEl.append(card);
        }
      }
    }

    if (peak) {
      const heatEl = $('peak-heatmap');
      if (heatEl) {
        heatEl.replaceChildren();
        const { grid, maxTotal } = peak;
        const dowLabels = currentLang() === 'en'
          ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
          : ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
        const table = document.createElement('table');
        table.className = 'w-full border-collapse text-xs';
        const thead = document.createElement('thead');
        const trh = document.createElement('tr');
        trh.innerHTML = '<th></th>' + Array.from({ length: 24 }, (_, h) => `<th class="px-1 py-0.5 text-center font-normal text-slate-400">${pad(h)}</th>`).join('');
        thead.append(trh);
        table.append(thead);
        const tbody = document.createElement('tbody');
        for (let d = 0; d < 7; d += 1) {
          const tr = document.createElement('tr');
          const tdLabel = document.createElement('td');
          tdLabel.className = 'pr-2 text-right font-bold text-slate-500';
          tdLabel.textContent = dowLabels[d];
          tr.append(tdLabel);
          for (let h = 0; h < 24; h += 1) {
            const cell = document.createElement('td');
            cell.className = 'p-0.5';
            const v = grid[d][h].total;
            const intensity = maxTotal > 0 ? v / maxTotal : 0;
            const bg = v === 0 ? '#f1f5f9' : `rgba(234, 88, 12, ${0.15 + intensity * 0.85})`;
            const tooltip = `${dowLabels[d]} ${pad(h)}:00 · ${Admin.currency(v)} · ${grid[d][h].count} ${T('reports.tabBills')}`;
            cell.innerHTML = `<div class="h-6 rounded" style="background:${bg}" title="${tooltip}"></div>`;
            tr.append(cell);
          }
          tbody.append(tr);
        }
        table.append(tbody);
        heatEl.append(table);
      }
    }
  }

  function buildCsv(summary, daily) {
    const m = summary.metrics;
    csvRows = [
      [T('reports.title')],
      [T('reports.rangeFrom'), `${currentRange.from} → ${currentRange.to}`],
      [],
      [T('reports.metricTotalSales'), 'Value', '%'],
      [T('reports.metricTotalSales'), m.totalSales.value, m.totalSales.percent.toFixed(2)],
      [T('reports.metricBills'), m.paymentCount.value, m.paymentCount.percent.toFixed(2)],
      [T('reports.metricAvgBill'), m.avgBill.value, m.avgBill.percent.toFixed(2)],
      [T('reports.metricCustomers'), m.customers.value, m.customers.percent.toFixed(2)],
      [T('reports.metricQueues'), m.totalQueues.value, m.totalQueues.percent.toFixed(2)],
      [T('reports.metricNoShow'), `${m.noShowRate.value.toFixed(2)}%`, m.noShowRate.percent.toFixed(2)],
      [T('reports.metricDiningTime'), Math.round(m.avgDiningMinutes.value), m.avgDiningMinutes.percent.toFixed(2)],
      [T('reports.metricTurnover'), m.turnover.value.toFixed(2), ''],
      [],
      [T('reports.paymentMethods'), 'Value', '%'],
      [T('admin.checkout.cash'), summary.payment.cash.total, summary.payment.cash.percent.toFixed(2)],
      ['QR', summary.payment.qr.total, summary.payment.qr.percent.toFixed(2)],
      [],
      [T('reports.dailySales'), T('reports.chartSalesLabel')],
      ...(daily.salesByDay || []).map((r) => [r.date, r.totalSales]),
    ];
  }

  function downloadCsv(rows, filename) {
    const csv = rows.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportSummaryCsv() {
    downloadCsv(csvRows, `report-${currentRange.from}_to_${currentRange.to}.csv`);
  }

  function exportBillsCsv() {
    if (!billsCache.length) { Admin.message(T('reports.noDataToExport'), true); return; }
    const rows = [[
      T('reports.billsTime'), T('reports.billsTable'), T('reports.billsQueue'),
      T('common.people'), T('reports.billsDuration'), T('reports.billsMethodCol'),
      T('reports.billsStaff'), T('reports.billsTotal'),
    ]];
    for (const b of billsCache) {
      rows.push([
        new Date(b.paidAt).toLocaleString(currentLocale()),
        b.tableNumber,
        b.zone ? T(`reports.zoneShort.${b.zone}`) : '',
        b.queueNumber || '',
        b.customerCount || '',
        b.durationMinutes != null ? b.durationMinutes : '',
        b.method === 'cash' ? T('admin.checkout.cash') : 'QR',
        b.staff ? b.staff.fullName || b.staff.username : '',
        b.amount,
      ]);
    }
    downloadCsv(rows, `bills-${currentRange.from}_to_${currentRange.to}.csv`);
  }

  async function loadComparison() {
    try {
      const res = await Admin.api(`/api/report/comparison?${rangeParams().toString()}`);
      const { current, previous, range, previousRange } = res.data;

      const cmpRange = document.getElementById('comparison-range');
      if (cmpRange) {
        const fmt = (d) => new Date(d).toLocaleDateString(currentLocale(), { day: 'numeric', month: 'short' });
        cmpRange.textContent = T('reports.comparisonLabel', {
          prevFrom: fmt(previousRange.from),
          prevTo: fmt(previousRange.to),
          curFrom: fmt(range.from),
          curTo: fmt(range.to),
        });
      }

      if (typeof Chart !== 'function') return;

      await new Promise((resolve) => requestAnimationFrame(resolve));

      const makeMini = (canvasId, key) => {
        const canvas = $(canvasId);
        if (!canvas) return;
        destroyChart(canvasId);
        charts[canvasId] = new Chart(canvas, {
          type: 'bar',
          data: {
            labels: [T('reports.previous'), T('reports.current')],
            datasets: [{
              data: [previous[key], current[key]],
              backgroundColor: ['#94a3b8', '#ea580c'],
              borderRadius: 6,
              maxBarThickness: 72,
            }],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true } },
          },
        });
      };
      makeMini('chart-cmp-sales', 'totalSales');
      makeMini('chart-cmp-bills', 'billCount');
      makeMini('chart-cmp-customers', 'customerCount');
    } catch (e) {
      console.warn('[reports] comparison failed:', e.message);
    }
  }

  function exportExcel() {
    const url = `/api/report/export-excel?${rangeParams().toString()}`;
    fetch(url, { headers: { Authorization: `Bearer ${Admin.token}` } })
      .then((res) => {
        if (!res.ok) throw new Error(T('reports.exportFailed'));
        return res.blob();
      })
      .then((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `report-${currentRange.from}_to_${currentRange.to}.xlsx`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch((err) => Admin.message(err.message || T('reports.exportFailed'), true));
  }

  function printReport() {
    window.print();
  }

  document.querySelectorAll('.report-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.report-tab').forEach((b) => {
        const selected = b === btn;
        b.classList.toggle('bg-orange-600', selected);
        b.classList.toggle('text-white', selected);
        b.classList.toggle('text-slate-600', !selected);
      });
      document.querySelectorAll('.report-panel').forEach((p) => {
        p.classList.toggle('hidden', p.id !== `panel-${btn.dataset.tab}`);
      });
      if (btn.dataset.tab === 'menu') loadMenuTab();
      if (btn.dataset.tab === 'staff') loadStaffTab();
      if (btn.dataset.tab === 'bills' && !billsCache.length) loadBills();
      if (btn.dataset.tab === 'customer') loadCustomerTab();
    });
  });

  document.querySelectorAll('[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => setRange(presetRange(btn.dataset.range)));
  });

  if (els.apply) els.apply.addEventListener('click', () => {
    if (!els.from.value || !els.to.value) return;
    if (new Date(els.from.value) > new Date(els.to.value)) {
      Admin.message(T('reports.invalidDateRange'), true);
      return;
    }
    setRange({ from: els.from.value, to: els.to.value, preset: 'custom' });
  });

  if (els.export) els.export.addEventListener('click', exportSummaryCsv);
  on('bills-export', 'click', exportBillsCsv);
  on('bills-refresh', 'click', () => { billsPage = 1; loadBills(); });
  on('bills-method', 'change', (e) => { billsMethod = e.target.value; billsPage = 1; loadBills(); });
  on('bills-limit', 'change', (e) => { billsLimit = Number(e.target.value) || 20; billsPage = 1; loadBills(); });
  on('bills-prev', 'click', () => { if (billsPage > 1) { billsPage -= 1; loadBills(); } });
  on('bills-next', 'click', () => { billsPage += 1; loadBills(); });
  on('export-excel', 'click', exportExcel);
  on('print-report', 'click', printReport);

  window.addEventListener('languageChanged', () => {
    if (summaryCache) renderSummary(summaryCache);
    if (dailyCache) drawDailyChart(dailyCache.salesByDay || []);
    loadComparison();
    if (!$('panel-menu')?.classList.contains('hidden')) loadMenuTab();
    if (!$('panel-staff')?.classList.contains('hidden')) loadStaffTab();
    if (!$('panel-bills')?.classList.contains('hidden') && billsCache.length) loadBills();
    if (!$('panel-customer')?.classList.contains('hidden')) loadCustomerTab();
    setRange(currentRange, { reload: false });
  });

  setRange(presetRange('today'));
})();