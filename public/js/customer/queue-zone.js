// Zone selection and live availability badges for the customer queue form.
(() => {
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);
  const ZONE_RULES = {
    small: { min: 1, max: 2 },
    medium: { min: 3, max: 6 },
    large: { min: 7, max: 12 },
  };

  let state = {
    availability: {},
    preferredZone: '',
    preferredTableId: null,
  };
  let socket = null;
  let refreshTimer = null;

  function zoneForCount(count) {
    if (count <= 2) return 'small';
    if (count <= 6) return 'medium';
    if (count <= 12) return 'large';
    return null;
  }

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function syncZoneCardState() {
    document.querySelectorAll('[data-zone-option]').forEach((label) => {
      const input = label.querySelector('input[type="radio"]');
      const checked = Boolean(input && input.checked);
      label.classList.toggle('border-orange-500', checked);
      label.classList.toggle('bg-orange-50', checked);
      label.classList.toggle('shadow-md', checked);
      label.classList.toggle('border-slate-200', !checked);
      label.classList.toggle('bg-white', !checked);
    });
    const autoCard = document.querySelector('[data-zone-auto-card]');
    if (autoCard) {
      const autoInput = autoCard.querySelector('[data-zone-auto]');
      const checked = Boolean(autoInput && autoInput.checked);
      autoCard.classList.toggle('border-orange-500', checked);
      autoCard.classList.toggle('bg-orange-50', checked);
      autoCard.classList.toggle('shadow-md', checked);
      autoCard.classList.toggle('border-slate-200', !checked);
      autoCard.classList.toggle('bg-white', !checked);
    }
  }

  async function fetchAvailability() {
    try {
      const response = await fetch('/api/table/availability-by-zone', { cache: 'no-store' });
      const payload = await response.json();
      if (!payload.success) throw new Error(payload.message || T('error.REQUEST_FAILED'));
      state.availability = payload.data || {};
      renderZoneBadges();
    } catch (error) {
      console.warn('Zone availability load failed:', error.message);
    }
  }

  async function fetchTablesForZone(zone) {
    try {
      const response = await fetch(`/api/table/zone/${encodeURIComponent(zone)}`, { cache: 'no-store' });
      const payload = await response.json();
      if (!payload.success) throw new Error(payload.message || T('error.REQUEST_FAILED'));
      return Array.isArray(payload.data) ? payload.data : [];
    } catch (error) {
      console.warn('Tables for zone load failed:', error.message);
      return [];
    }
  }

  function renderZoneBadges() {
    document.querySelectorAll('[data-zone-option]').forEach((label) => {
      const zone = label.dataset.zoneOption;
      const info = state.availability[zone];
      const badge = label.querySelector('[data-zone-badge]');
      if (!badge) return;
      if (!info) {
        badge.textContent = '—';
        badge.className = 'rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600';
        return;
      }
      const isFull = info.available === 0;
      badge.textContent = T('queue.zone.availableOf', { available: info.available, total: info.total });
      badge.className = isFull
        ? 'rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-800'
        : 'rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-800';
    });
  }

  function applyCapacityGating(count) {
    const recommended = zoneForCount(count);
    document.querySelectorAll('[data-zone-option]').forEach((label) => {
      const zone = label.dataset.zoneOption;
      const rule = ZONE_RULES[zone];
      const input = label.querySelector('input[type="radio"]');
      const inRange = count >= rule.min && count <= rule.max;
      label.classList.toggle('opacity-40', !inRange);
      label.classList.toggle('cursor-not-allowed', !inRange);
      label.classList.toggle('cursor-pointer', inRange);
      if (!inRange && input && input.checked) {
        input.checked = false;
        state.preferredZone = '';
        state.preferredTableId = null;
        const auto = document.querySelector('[data-zone-auto]');
        if (auto) auto.checked = true;
      }
      if (input) input.disabled = !inRange || !recommended;
    });
    document.querySelectorAll('[data-zone-recommended]').forEach((el) => {
      el.classList.toggle('hidden', el.dataset.zoneRecommended !== recommended);
    });
    syncZoneCardState();
  }

  function clearZone() {
    state.preferredZone = '';
    state.preferredTableId = null;
    document.querySelectorAll('[data-zone-option] input[type="radio"]').forEach((input) => { input.checked = false; });
    const auto = document.querySelector('[data-zone-auto]');
    if (auto) auto.checked = true;
    syncZoneCardState();
    renderTablePicker();
  }

  function wireZoneRadios() {
    document.querySelectorAll('[data-zone-option] input[type="radio"]').forEach((input) => {
      input.addEventListener('change', () => {
        state.preferredZone = input.value;
        state.preferredTableId = null;
        syncZoneCardState();
        renderTablePicker();
      });
    });
    const auto = document.querySelector('[data-zone-auto]');
    if (auto) {
      auto.addEventListener('change', () => {
        if (auto.checked) clearZone();
      });
    }
    const autoCard = document.querySelector('[data-zone-auto-card]');
    if (autoCard) {
      autoCard.addEventListener('click', (e) => {
        if (e.target.tagName !== 'INPUT') {
          if (auto) auto.checked = true;
          clearZone();
        }
      });
    }
  }

  function tableStatusLabel(status) {
    if (status === 'available') return { text: T('queue.zone.tableAvailable'), chip: 'bg-green-100 text-green-800' };
    if (status === 'reserved') return { text: T('table.status.reserved'), chip: 'bg-amber-100 text-amber-800' };
    if (status === 'occupied') return { text: T('queue.zone.tableOccupied'), chip: 'bg-red-100 text-red-800' };
    if (status === 'cleaning') return { text: T('table.status.cleaning'), chip: 'bg-sky-100 text-sky-800' };
    return { text: status, chip: 'bg-slate-100 text-slate-700' };
  }

  async function renderTablePicker() {
    const container = document.getElementById('zone-table-picker');
    if (!container) return;
    if (!state.preferredZone) {
      container.classList.add('hidden');
      container.replaceChildren();
      return;
    }

    const zoneLabel = T(`table.zone.${state.preferredZone}`) || state.preferredZone;
    container.classList.remove('hidden');
    container.innerHTML = `
      <div class="mb-3 flex items-center justify-between gap-2 border-t border-slate-200 pt-3">
        <p class="text-xs font-bold text-slate-700">${escapeHTML(T('queue.zone.pickTableTitle', { zone: zoneLabel }))}</p>
        <button type="button" data-change-zone class="text-xs font-semibold text-slate-500 underline transition hover:text-orange-700">${escapeHTML(T('queue.zone.changeZone'))}</button>
      </div>
      <p class="text-xs text-slate-500">${escapeHTML(T('common.loading'))}</p>`;
    container.querySelector('[data-change-zone]').addEventListener('click', clearZone);

    const tables = await fetchTablesForZone(state.preferredZone);
    container.replaceChildren();

    const header = document.createElement('div');
    header.className = 'mb-3 flex items-center justify-between gap-2 border-t border-slate-200 pt-3';
    header.innerHTML = `
      <p class="text-xs font-bold text-slate-700">${escapeHTML(T('queue.zone.pickTableTitle', { zone: zoneLabel }))}</p>
      <button type="button" data-change-zone class="text-xs font-semibold text-slate-500 underline transition hover:text-orange-700">${escapeHTML(T('queue.zone.changeZone'))}</button>`;
    header.querySelector('[data-change-zone]').addEventListener('click', clearZone);
    container.append(header);

    if (tables.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'rounded-xl bg-white p-3 text-center text-xs text-slate-500';
      empty.textContent = T('queue.zone.noTables');
      container.append(empty);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-2 gap-2 sm:grid-cols-3';
    for (const table of tables) {
      const isAvailable = table.status === 'available';
      const status = tableStatusLabel(table.status);
      const label = document.createElement('label');
      label.className = `flex flex-col gap-0.5 rounded-xl border-2 p-3 text-sm transition ${isAvailable ? 'cursor-pointer border-slate-200 bg-white hover:border-orange-400 hover:shadow-md' : 'cursor-not-allowed border-slate-100 bg-slate-50 opacity-60'}`;
      label.innerHTML = `
        <span class="flex items-center justify-between gap-2">
          <span class="text-lg font-black leading-none text-slate-900">${escapeHTML(table.tableNumber)}</span>
          <input type="radio" name="tableChoice" value="${escapeHTML(table._id)}" ${isAvailable ? '' : 'disabled'} class="h-4 w-4 accent-orange-600">
        </span>
        <span class="text-[11px] text-slate-500">${escapeHTML(T('queue.zone.capacityRange', { min: table.minCapacity, max: table.capacity }))}</span>
        <span class="mt-0.5 w-fit rounded-full px-2 py-0.5 text-[10px] font-bold ${status.chip}">${escapeHTML(status.text)}</span>`;
      const input = label.querySelector('input');
      input.addEventListener('change', () => {
        state.preferredTableId = input.value;
      });
      grid.append(label);
    }
    container.append(grid);
  }

  function connectSocket() {
    if (typeof io !== 'function') return;
    socket = io();
    socket.on('connect', () => socket.emit('joinRoom', 'customer'));
    socket.on('table_board_updated', () => fetchAvailability());
    socket.on('queue_board_updated', () => fetchAvailability());
  }

  function init() {
    wireZoneRadios();
    syncZoneCardState();
    fetchAvailability();
    connectSocket();
    refreshTimer = window.setInterval(fetchAvailability, 30000);
    window.addEventListener('beforeunload', () => {
      if (refreshTimer) window.clearInterval(refreshTimer);
      if (socket) socket.disconnect();
    });
  }

  window.QueueZone = {
    state,
    init,
    applyCapacityGating,
    getPreferredZone: () => state.preferredZone,
    getPreferredTableId: () => state.preferredTableId,
    reset: () => {
      state.preferredZone = '';
      state.preferredTableId = null;
      document.querySelectorAll('[data-zone-option] input[type="radio"]').forEach((input) => { input.checked = false; });
      const auto = document.querySelector('[data-zone-auto]');
      if (auto) auto.checked = true;
      syncZoneCardState();
      renderTablePicker();
    },
  };

  window.addEventListener('languageChanged', () => {
    renderZoneBadges();
    renderTablePicker();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();