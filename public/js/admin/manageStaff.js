// Manage staff accounts using administrator-only staff endpoints.
(() => {
  const Admin = window.Admin;
  if (!Admin) return;
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);
  if (!Admin.isAdmin) {
    window.location.replace('/admin/dashboard.html');
    return;
  }
  const form = document.getElementById('staff-form');
  let staff = [];

  function roleLabel(role) {
    return T(`staff.role.${role}Short`) || T(`staff.role.${role}`) || role;
  }

  async function loadStaff() {
    document.getElementById('staff-loading').classList.remove('hidden');
    try {
      const payload = await Admin.api('/api/auth/staff');
      staff = Array.isArray(payload.data) ? payload.data : [];
      renderStaff();
    } catch (error) {
      Admin.message(error.message || T('admin.staff.saveFailed'), true);
    } finally {
      document.getElementById('staff-loading').classList.add('hidden');
    }
  }

  function renderStaff() {
    const rows = document.getElementById('staff-rows');
    rows.replaceChildren();
    document.getElementById('staff-empty').classList.toggle('hidden', staff.length > 0);
    staff.forEach((person) => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="p-4 font-bold">${Admin.escapeHTML(person.username)}</td>
        <td class="p-4">${Admin.escapeHTML(person.fullName || '—')}</td>
        <td class="p-4">${roleLabel(person.role)}</td>
        <td class="p-4"><span class="rounded-md px-3 py-1 text-xs font-bold ${person.isActive ? 'bg-green-100 text-green-800' : 'bg-slate-200 text-slate-600'}">${person.isActive ? T('admin.statusActive') : T('admin.statusInactive')}</span></td>
        <td class="p-4"><div class="flex justify-end gap-2"><button type="button" data-edit="${Admin.escapeHTML(person._id)}" class="rounded-lg bg-blue-50 px-3 py-2 text-sm font-bold text-blue-700">${T('admin.edit')}</button><button type="button" data-delete="${Admin.escapeHTML(person._id)}" class="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-700">${T('admin.delete')}</button></div></td>`;
      row.querySelector('[data-edit]').addEventListener('click', () => openEditor(person));
      row.querySelector('[data-delete]').addEventListener('click', () => deleteStaff(person));
      rows.append(row);
    });
  }

  // Managed in JS (not by data-i18n) so a re-render cannot flip "edit" to "add".
  let editingPerson = null;

  function updateStaffModalTitle() {
    const titleEl = document.getElementById('staff-modal-title');
    if (!titleEl) return;
    titleEl.textContent = editingPerson ? T('admin.staff.edit') : T('admin.staff.add');
  }

  function openEditor(person = null) {
    form.reset();
    form.elements.staffId.value = person ? person._id : '';
    form.elements.username.value = person ? person.username : '';
    form.elements.username.readOnly = Boolean(person);
    form.elements.password.required = !person;
    form.elements.password.value = '';
    form.elements.fullName.value = person ? person.fullName || '' : '';
    form.elements.role.value = person ? person.role : 'waiter';
    editingPerson = person || null;
    updateStaffModalTitle();
    document.getElementById('password-hint').textContent =
      person ? T('admin.staff.passwordOptional') : T('admin.staff.passwordMin');
    document.getElementById('staff-modal').classList.replace('hidden', 'flex');
  }

  async function saveStaff(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const staffId = values.staffId;
    delete values.staffId;
    if (staffId && !values.password) delete values.password;
    if (staffId) values.isActive = staff.find((person) => person._id === staffId).isActive;
    try {
      await Admin.api(staffId ? `/api/auth/staff/${encodeURIComponent(staffId)}` : '/api/auth/register', {
        method: staffId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      document.getElementById('staff-modal').classList.replace('flex', 'hidden');
      Admin.message(staffId ? T('admin.staff.editSuccess') : T('admin.staff.addSuccess'));
      await loadStaff();
    } catch (error) {
      Admin.message(error.message || T('admin.staff.saveFailed'), true);
    }
  }

  async function deleteStaff(person) {
    const ok = await Admin.confirm(T('admin.staff.confirmDeleteMsg', { username: person.username }), {
      title: T('admin.staff.confirmDeleteTitle'),
      okText: T('admin.staff.confirmDeleteOk'),
      cancelText: T('admin.staff.confirmDeleteCancel'),
      danger: true,
    });
    if (!ok) return;
    try {
      await Admin.api(`/api/auth/staff/${encodeURIComponent(person._id)}`, { method: 'DELETE' });
      Admin.message(T('admin.staff.deleteSuccess'));
      await loadStaff();
    } catch (error) {
      Admin.message(error.message || T('admin.staff.deleteFailed'), true);
    }
  }

  document.getElementById('add-staff-button').addEventListener('click', () => openEditor());
  form.addEventListener('submit', saveStaff);
  document.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', () => document.getElementById('staff-modal').classList.replace('flex', 'hidden'));
  });

  window.addEventListener('languageChanged', () => {
    renderStaff();
    document.getElementById('add-staff-button').textContent = T('admin.staff.add');
    updateStaffModalTitle();
    const passwordHint = document.getElementById('password-hint');
    if (passwordHint) {
      passwordHint.textContent = editingPerson ? T('admin.staff.passwordOptional') : T('admin.staff.passwordMin');
    }
  });

  loadStaff();
})();