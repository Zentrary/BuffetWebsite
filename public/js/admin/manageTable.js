// Display tables by zone and handle table creation, rename, and delete.
(() => {
  const Admin = window.Admin;
  if (!Admin) return;
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);

  const ZONE_RULES = {
    small: { minCapacity: 1, maxCapacity: 2 },
    medium: { minCapacity: 3, maxCapacity: 6 },
    large: { minCapacity: 7, maxCapacity: 12 },
  };
  let tables = [];
  let selectedTable = null;
  let pendingDeleteId = null;
  let editingTableNumber = '';

  function zoneLabel(zone) {
    return T(`admin.tables.zone.${zone}`) || zone;
  }

  function statusLabel(status) {
    return T(`table.status.${status}`) || status;
  }

  function renderTables() {
    const root = document.getElementById('table-zones');
    root.replaceChildren();
    const statusClasses = {
      available: 'border-green-400 bg-green-50 text-green-900',
      reserved: 'border-amber-400 bg-amber-50 text-amber-900',
      occupied: 'border-red-400 bg-red-50 text-red-900',
      cleaning: 'border-blue-400 bg-blue-50 text-blue-900',
    };
    for (const [zone, rule] of Object.entries(ZONE_RULES)) {
      const zoneTables = tables.filter((t) => t.zone === zone);
      const section = document.createElement('section');
      section.innerHTML = `<h2 class="mb-3 text-xl font-black">${T(`table.zone.${zone}`)} <span class="text-sm font-semibold text-slate-400">(${zoneTables.length}) · ${T('admin.tables.zoneRangeShort', { min: rule.minCapacity, max: rule.maxCapacity })}</span></h2>`;
      const grid = document.createElement('div');
      grid.className = 'grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5';
      zoneTables.forEach((table) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = `flex min-h-[7.5rem] flex-col justify-between rounded-2xl border-l-8 p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${statusClasses[table.status] || 'border-slate-300 bg-white'}`;
        card.innerHTML = `
          <span class="block text-xs font-bold uppercase tracking-widest opacity-70">${Admin.escapeHTML(statusLabel(table.status))}</span>
          <span class="block text-3xl font-black leading-none">${Admin.escapeHTML(table.tableNumber)}</span>
          <span class="block text-sm font-semibold leading-none">${table.minCapacity || 1}-${table.capacity} ${T('common.people')}</span>`;
        card.addEventListener('click', () => openTableModal(table));
        grid.append(card);
      });
      if (zoneTables.length === 0) {
        grid.innerHTML = `<p class="col-span-full rounded-xl bg-white p-4 text-slate-400">${T('admin.tables.noInZone')}</p>`;
      }
      section.append(grid);
      root.append(section);
    }
  }

  async function loadTables() {
    document.getElementById('tables-loading').classList.remove('hidden');
    try {
      const payload = await Admin.api('/api/table');
      tables = Array.isArray(payload.data) ? payload.data : [];
      renderTables();
    } catch (error) {
      Admin.message(error.message || T('admin.tables.loadFailed'), true);
    } finally {
      document.getElementById('tables-loading').classList.add('hidden');
    }
  }

  function openTableModal(table) {
    selectedTable = table;
    updateTableDetailTitle();
    document.getElementById('table-details').innerHTML = `
      <p><strong>${T('admin.tables.zoneLabel')}:</strong> ${zoneLabel(table.zone)}</p>
      <p><strong>${T('admin.tables.capacity')}:</strong> ${table.minCapacity || 1}-${table.capacity} ${T('common.people')}</p>
      <p><strong>${T('admin.tables.status')}:</strong> ${Admin.escapeHTML(statusLabel(table.status))}</p>
      <p><strong>${T('admin.tables.session')}:</strong> ${table.currentSessionId ? Admin.escapeHTML(table.currentSessionId._id || table.currentSessionId) : T('admin.tables.none')}</p>`;
    const isFree = table.status === 'available' && !table.currentSessionId && !table.reservedForQueueId;
    document.getElementById('clear-table').classList.toggle('hidden', table.status !== 'cleaning');
    document.getElementById('edit-table').classList.toggle('hidden', !isFree);
    document.getElementById('delete-table').classList.toggle('hidden', !isFree || !Admin.isAdmin);
    document.getElementById('table-modal').classList.replace('hidden', 'flex');
  }

  async function clearTable() {
    if (!selectedTable) return;
    try {
      await Admin.api(`/api/table/${encodeURIComponent(selectedTable._id)}/clear`, { method: 'POST' });
      document.getElementById('table-modal').classList.replace('flex', 'hidden');
      Admin.message(T('admin.tables.cleared'));
      await loadTables();
    } catch (error) {
      Admin.message(error.message || T('admin.tables.clearFailed'), true);
    }
  }

  function openDeleteModal(table) {
    pendingDeleteId = table._id;
    document.getElementById('delete-confirm-target').textContent = `${table.tableNumber} (${zoneLabel(table.zone)})`;
    document.getElementById('delete-confirm-modal').classList.replace('hidden', 'flex');
  }

  function closeDeleteModal() {
    pendingDeleteId = null;
    document.getElementById('delete-confirm-modal').classList.replace('flex', 'hidden');
    document.getElementById('delete-confirm-ok').disabled = false;
  }

  async function confirmDelete() {
    if (!pendingDeleteId) return;
    const okButton = document.getElementById('delete-confirm-ok');
    okButton.disabled = true;
    okButton.textContent = T('admin.tables.deleting');
    try {
      await Admin.api(`/api/table/${encodeURIComponent(pendingDeleteId)}`, { method: 'DELETE' });
      closeDeleteModal();
      document.getElementById('table-modal').classList.replace('flex', 'hidden');
      Admin.message(T('admin.tables.deleteSuccess'));
      await loadTables();
    } catch (error) {
      Admin.message(error.message || T('admin.tables.deleteFailed'), true);
      okButton.disabled = false;
    } finally {
      okButton.textContent = T('admin.tables.confirmDeleteOk');
    }
  }

  function zoneRuleFor(zone) {
    return ZONE_RULES[zone] || ZONE_RULES.small;
  }

  // Empty inputs get the zone default; existing values are only clamped into
  // the zone range so an edited table keeps what the user saved.
  function clampCapacity(value, rule, fallback) {
    const number = Number(value);
    if (value === '' || value === null || value === undefined || !Number.isFinite(number)) return fallback;
    return Math.min(Math.max(Math.round(number), rule.minCapacity), rule.maxCapacity);
  }

  /**
   * Keep the two capacity inputs in sync with the selected table zone.
   * @param {object} [options] - Behaviour flags.
   * @param {boolean} [options.autofill] - Fill the whole zone range (new table or zone change).
   * @param {boolean} [options.preserveValues] - Only refresh labels/limits, never touch values.
   */
  function updateCapacityHint(options = {}) {
    const form = document.getElementById('add-table-form');
    const zoneSelect = document.getElementById('table-zone-select');
    if (!form || !zoneSelect) return;
    const rule = zoneRuleFor(zoneSelect.value);
    const minInput = form.elements.minCapacity;
    const capacityInput = form.elements.capacity;
    if (!minInput || !capacityInput) return;

    minInput.min = rule.minCapacity;
    minInput.max = rule.maxCapacity;
    capacityInput.min = rule.minCapacity;
    capacityInput.max = rule.maxCapacity;
    minInput.placeholder = String(rule.minCapacity);
    capacityInput.placeholder = String(rule.maxCapacity);

    if (!options.preserveValues) {
      if (options.autofill) {
        // Creating a table (or switching zone) fills the range automatically:
        // small 1-2, medium 3-6, large 7-12.
        minInput.value = rule.minCapacity;
        capacityInput.value = rule.maxCapacity;
      } else {
        minInput.value = clampCapacity(minInput.value, rule, rule.minCapacity);
        capacityInput.value = clampCapacity(capacityInput.value, rule, rule.maxCapacity);
        if (Number(minInput.value) > Number(capacityInput.value)) {
          capacityInput.value = minInput.value;
        }
      }
    }

    const hint = document.getElementById('capacity-hint');
    if (hint) hint.textContent = T('admin.tables.zoneRange', { min: rule.minCapacity, max: rule.maxCapacity });
  }

  function updateAddTableTitle() {
    const title = document.getElementById('add-table-modal-title');
    if (!title) return;
    const form = document.getElementById('add-table-form');
    if (!form || !form.elements.tableId.value) {
      title.textContent = T('admin.tables.addTitle');
      return;
    }
    const typedNumber = String(form.elements.tableNumber.value || '').trim();
    title.textContent = T('admin.tables.editTitle', { table: typedNumber || editingTableNumber });
  }

  function updateTableDetailTitle() {
    const title = document.getElementById('table-modal-title');
    if (!title) return;
    title.textContent = selectedTable && selectedTable.tableNumber
      ? T('admin.tables.detailTitle', { table: selectedTable.tableNumber })
      : T('admin.tables.detailTitleFallback');
  }

  function openAddTable() {
    const form = document.getElementById('add-table-form');
    form.reset();
    form.elements.tableId.value = '';
    editingTableNumber = '';
    document.getElementById('table-number-error').classList.add('hidden');
    form.elements.tableNumber.readOnly = false;
    form.elements.zone.value = 'small';
    // Auto-fill the capacity for the selected zone (small = 1-2) instead of
    // leaving both inputs empty.
    updateCapacityHint({ autofill: true });
    updateAddTableTitle();
    document.getElementById('add-table-modal').classList.replace('hidden', 'flex');
  }

  function openEditTable(table) {
    if (!table) return;
    const form = document.getElementById('add-table-form');
    const rule = zoneRuleFor(table.zone);
    form.reset();
    form.elements.tableId.value = table._id;
    form.elements.tableNumber.value = table.tableNumber;
    form.elements.tableNumber.readOnly = false;
    form.elements.zone.value = table.zone;
    form.elements.minCapacity.value = table.minCapacity || rule.minCapacity;
    form.elements.capacity.value = table.capacity || rule.maxCapacity;
    editingTableNumber = table.tableNumber;
    document.getElementById('table-number-error').classList.add('hidden');
    updateCapacityHint();
    updateAddTableTitle();
    document.getElementById('table-modal').classList.replace('flex', 'hidden');
    document.getElementById('add-table-modal').classList.replace('hidden', 'flex');
  }

  document.getElementById('add-table-button').addEventListener('click', openAddTable);
  document.getElementById('edit-table').addEventListener('click', () => openEditTable(selectedTable));
  document.getElementById('delete-table').addEventListener('click', () => {
    if (selectedTable) openDeleteModal(selectedTable);
  });
  document.getElementById('delete-confirm-cancel').addEventListener('click', closeDeleteModal);
  document.getElementById('delete-confirm-ok').addEventListener('click', confirmDelete);

  document.getElementById('add-table-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const tableId = values.tableId;
    delete values.tableId;
    values.tableNumber = String(values.tableNumber || '').trim();
    values.capacity = Number(values.capacity);
    values.minCapacity = Number(values.minCapacity);

    const numberError = document.getElementById('table-number-error');
    if (!tableId) {
      const duplicate = tables.some((t) => String(t.tableNumber || '').trim() === values.tableNumber);
      if (duplicate) {
        numberError.textContent = T('admin.tables.numberExists');
        numberError.classList.remove('hidden');
        form.elements.tableNumber.focus();
        return;
      }
    }
    numberError.classList.add('hidden');

    try {
      await Admin.api(
        tableId ? `/api/table/${encodeURIComponent(tableId)}` : '/api/table',
        { method: tableId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) }
      );
      document.getElementById('add-table-modal').classList.replace('flex', 'hidden');
      form.elements.tableId.value = '';
      editingTableNumber = '';
      Admin.message(tableId ? T('admin.tables.editSuccess') : T('admin.tables.createSuccess'));
      await loadTables();
    } catch (error) {
      Admin.message(error.message || (tableId ? T('admin.tables.editFailed') : T('admin.tables.createFailed')), true);
    }
  });

  document.querySelector('[name="tableNumber"]').addEventListener('input', () => {
    document.getElementById('table-number-error').classList.add('hidden');
    updateAddTableTitle();
  });
  document.getElementById('table-zone-select').addEventListener('change', () => {
    // Switching zone re-fills the range for the new zone (e.g. large = 7-12).
    updateCapacityHint({ autofill: true });
  });
  document.getElementById('clear-table').addEventListener('click', clearTable);

  document.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', () => {
      document.getElementById('table-modal').classList.replace('flex', 'hidden');
      document.getElementById('add-table-modal').classList.replace('flex', 'hidden');
    });
  });

  const socket = Admin.connectSocket();
  if (socket) {
    socket.on('table_cleared', loadTables);
    socket.on('table_waiting_for_cleaning', loadTables);
    socket.on('table_board_updated', loadTables);
  }
  window.setInterval(loadTables, 30000);

  window.addEventListener('languageChanged', () => {
    renderTables();
    document.getElementById('add-table-button').textContent = T('admin.tables.addTable');
    document.getElementById('clear-table').textContent = T('admin.tables.clearDone');
    document.getElementById('edit-table').textContent = T('admin.tables.editRename');
    document.getElementById('delete-table').textContent = T('admin.tables.deleteTable');
    document.getElementById('delete-confirm-title').textContent = T('admin.tables.confirmDeleteTitle');
    document.getElementById('delete-confirm-cancel').textContent = T('admin.tables.confirmDeleteCancel');
    document.getElementById('delete-confirm-ok').textContent = T('admin.tables.confirmDeleteOk');
    // Re-populate zone select options without losing the current selection
    // (assigning innerHTML resets the select to its first option).
    const zoneSelect = document.getElementById('table-zone-select');
    if (zoneSelect) {
      const currentZone = ZONE_RULES[zoneSelect.value] ? zoneSelect.value : 'small';
      zoneSelect.innerHTML = `
        <option value="small">${T('admin.tables.zone.small')}</option>
        <option value="medium">${T('admin.tables.zone.medium')}</option>
        <option value="large">${T('admin.tables.zone.large')}</option>`;
      zoneSelect.value = currentZone;
    }
    updateCapacityHint({ preserveValues: true });
    updateAddTableTitle();
    updateTableDetailTitle();
  });

  loadTables();
})();