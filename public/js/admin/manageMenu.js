// Manage menu records, their availability, and the administrator-only delete action.
(() => {
  const Admin = window.Admin;
  if (!Admin) return;
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);
  const Categories = window.MenuCategories;

  const form = document.getElementById('menu-form');
  const $ = (id) => document.getElementById(id);
  const fields = {
    menuId: $('menu-form-id'),
    name: $('menu-form-name'),
    description: $('menu-form-description'),
    price: $('menu-form-price'),
    preparationTime: $('menu-form-preparationTime'),
    category: $('menu-form-category'),
    imageUrl: $('menu-form-imageUrl'),
    stockQuantity: $('menu-form-stockQuantity'),
    lowStockThreshold: $('menu-form-lowStockThreshold'),
    maxOrderQuantity: $('menu-form-maxOrderQuantity'),
    imageFile: $('menuImageFile'),
  };

  let menus = [];
  let searchForm;
  let menuView = localStorage.getItem('menuView') || 'table';
  let editingMenu = null;
  let categoryManuallySelected = false;

  function updateMenuModalTitle() {
    const titleEl = document.getElementById('menu-modal-title');
    if (!titleEl) return;
    titleEl.textContent = editingMenu ? T('form.editMenuTitle') : T('form.addMenuTitle');
  }

  function setMenuModalOpen(open) {
    const modal = document.getElementById('menu-modal');
    if (!modal) return;
    modal.classList.toggle('hidden', !open);
    modal.classList.toggle('flex', open);
    document.body.classList.toggle('overflow-hidden', open);
  }

  const catLabel = (category) => Categories.label(category, T);

  // ระบบทายหมวดหมู่อัตโนมัติ (Auto-Categorize) จากชื่อเมนู
  function guessCategory(name) {
    if (!name) return null;
    const n = name.toLowerCase().trim();

    if (/ชุด|เซ็ต|signature|premium|deluxe|ครอบครัว|อิ่มคุ้ม|อิ่มคู่/.test(n)) return 'set';
    if (/น้ำจิ้ม/.test(n)) return 'sauce';
    if (/น้ำซุป|ซุป/.test(n)) return 'soup';
    if (/ชา|น้ำ|เครื่องดื่ม/.test(n)) return 'drink';
    if (/ไอศกรีม|บัวลอย|บิงซู|ผลไม้|เฉาก๊วย|น้ำแข็งใส/.test(n)) return 'dessert';
    
    if (/ขนมจีบ|เกี๊ยวกุ้ง|เกี๊ยวปลา|ทอด|นักเก็ต|ปอเปี๊ยะ|ฟองเต้าหู้|มันบด|เฟรนช์ฟรายส์|เกี๊ยวซ่า|ฮือแซ|ทอดมัน|หอยจ้อ|แฮกึ้น|แฮ่กึ๊น|ยำ|สลัด/.test(n)) return 'appetizer';
    
    if (/ซูชิ|อินาริ|มากิ|โรล|บอล|เบอร์เกอร์|ซาซิมิ|ดองซีอิ๊ว/.test(n)) return 'sushi';
    
    if (/สุกี้|กระทะ|ราเมน|ยากิโซบะ|ข้าว|ก๋วยเตี๋ยว|ขาห่าน|คากิ|ซี่โครง|ปลาทรงเครื่อง|ลิ้นห่าน|ออส่วน|เป๋า|แปรก้วย|แปะก๊วย|เอ็นหมู|หัวปลา|ไก่บ้าน/.test(n)) return 'main';
    
    if (/หูหมู|ตับ|เซี่ยงจี๊|ตั้งโอ๋|กระเพาะ|ลำไส้|เอ็น|เนื้อ|หมู|ไก่|เป็ด|เบคอน/.test(n)) return 'meat';
    
    if (/กุ้ง|ปลาหมึก|ปลา|ปู|หอย|แมงกะพรุน|ทาโกะ/.test(n)) return 'seafood';
    
    if (/ผัก|กวางตุ้ง|กะหล่ำ|ขึ้นฉ่าย|คะน้า|ข้าวโพด|ฟักทอง|มันฝรั่ง|เผือก|หัวไชเท้า|เห็ด|เต้าหู้/.test(n)) return 'veg';
    
    if (/วุ้นเส้น|เส้น|บะหมี่|มาม่า/.test(n)) return 'noodle';
    
    // เพิ่มการทายหมวดหมู่เครื่องเคียง
    if (/ไข่|สาหร่าย|กิมจิ|ขิง|ไชเท้าดอง/.test(n)) return 'side';

    return 'uncategorized';
  }

  function addFormField(parent, labelText, name, type, options = {}) {
    const label = document.createElement('label');
    label.className = 'block text-sm font-semibold';
    label.textContent = labelText;
    let input;
    if (type === 'select') {
      input = document.createElement('select');
      for (const option of options.options) {
        const element = document.createElement('option');
        element.value = option.value;
        element.textContent = option.label;
        input.append(element);
      }
    } else {
      input = document.createElement('input');
      input.type = type;
      if (options.min !== undefined) input.min = String(options.min);
      if (options.step !== undefined) input.step = String(options.step);
      if (options.placeholder) input.placeholder = options.placeholder;
    }
    input.name = name;
    input.className = 'input input-bordered mt-1 w-full';
    label.append(input);
    parent.append(label);
    return input;
  }

  function installInventoryControls() {
    const previousFilters = searchForm ? Object.fromEntries(new FormData(searchForm)) : {};
    const rowsEl = document.getElementById('menu-rows');
    if (!rowsEl) return;
    const table = rowsEl.closest('table');
    if (!table) return;
    table.classList.remove('min-w-[760px]');
    table.classList.add('min-w-[960px]');
    const headerRow = table.querySelector('thead tr');
    if (!headerRow) return;

    headerRow.querySelectorAll('[data-injected-stock-header]').forEach((el) => el.remove());
    const stockHeader = document.createElement('th');
    stockHeader.className = 'p-4';
    stockHeader.dataset.injectedStockHeader = '1';
    stockHeader.textContent = T('admin.stock');
    stockHeader.dataset.i18n = 'admin.stock';
    headerRow.insertBefore(stockHeader, headerRow.children[3]);

    const existingSearch = document.getElementById('menu-search-form');
    if (existingSearch) {
      const existingSection = existingSearch.closest('section');
      if (existingSection) existingSection.remove();
    }
    const existingCards = document.getElementById('menu-cards');
    if (existingCards) existingCards.remove();

    const searchSection = document.createElement('section');
    searchSection.className = 'mb-5 rounded-2xl border border-orange-100 bg-white p-5 shadow-sm';
    const searchTitle = document.createElement('h2');
    searchTitle.className = 'mb-3 font-bold';
    searchTitle.textContent = T('admin.search');
    searchTitle.dataset.i18n = 'admin.search';
    searchForm = document.createElement('form');
    searchForm.id = 'menu-search-form';
    searchForm.className = 'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6';
    addFormField(searchForm, T('admin.searchQuery'), 'query', 'search', { placeholder: T('admin.searchPlaceholder') });
    
    addFormField(searchForm, T('admin.filterCategory'), 'category', 'select', {
      options: [{ value: '', label: T('admin.filterAllCategories') }]
    });

    addFormField(searchForm, T('admin.filterAvailability'), 'availability', 'select', {
      options: [
        { value: '', label: T('admin.filterAllStatus') },
        { value: 'available', label: T('admin.available') },
        { value: 'unavailable', label: T('admin.soldOut') },
      ],
    });
    addFormField(searchForm, T('admin.filterStockStatus'), 'stockStatus', 'select', {
      options: [
        { value: '', label: T('admin.filterAllStock') },
        { value: 'tracked', label: T('admin.filterStockTracked') },
        { value: 'low', label: T('admin.filterStockLow') },
        { value: 'out', label: T('admin.filterStockOut') },
        { value: 'unset', label: T('admin.filterStockUnset') },
      ],
    });
    addFormField(searchForm, T('admin.filterMinPrice'), 'minPrice', 'number', { min: 0, step: 0.01 });
    addFormField(searchForm, T('admin.filterMaxPrice'), 'maxPrice', 'number', { min: 0, step: 0.01 });
    const searchActions = document.createElement('div');
    searchActions.className = 'hidden';
    const clearButton = document.createElement('button');
    clearButton.type = 'reset';
    clearButton.className = 'min-h-11 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 shadow-sm transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-800';
    clearButton.textContent = T('admin.filterClear');
    searchActions.append(clearButton);
    searchForm.append(searchActions);
    const toolbar = document.createElement('div');
    toolbar.className = 'mt-5 flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between';
    const resultCount = document.createElement('p');
    resultCount.id = 'menu-result-count';
    resultCount.className = 'text-sm font-medium text-slate-500';
    resultCount.setAttribute('aria-live', 'polite');
    const viewButtons = document.createElement('div');
    viewButtons.className = 'inline-flex w-full rounded-xl border border-slate-200 bg-slate-50 p-1 sm:w-auto';
    viewButtons.setAttribute('aria-label', 'View');
    viewButtons.innerHTML = `<button type="button" data-menu-view="table" class="min-h-10 flex-1 rounded-lg px-4 py-2 text-sm font-bold transition sm:flex-none">${T('admin.viewTable')}</button><button type="button" data-menu-view="cards" class="min-h-10 flex-1 rounded-lg px-4 py-2 text-sm font-bold transition sm:flex-none">${T('admin.viewCards')}</button>`;
    viewButtons.addEventListener('click', (event) => {
      const button = event.target.closest('[data-menu-view]');
      if (!button) return;
      menuView = button.dataset.menuView;
      localStorage.setItem('menuView', menuView);
      renderMenus();
    });
    const toolbarActions = document.createElement('div');
    toolbarActions.className = 'flex flex-col gap-2 sm:flex-row sm:items-center';
    toolbarActions.append(clearButton, viewButtons);
    toolbar.append(resultCount, toolbarActions);
    searchSection.append(searchTitle, searchForm, toolbar);
    const tableWrapper = table.closest('section');
    if (tableWrapper && tableWrapper.parentNode) {
      tableWrapper.parentNode.insertBefore(searchSection, tableWrapper);
    }

    const cards = document.createElement('div');
    cards.id = 'menu-cards';
    cards.className = 'hidden grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3';
    if (tableWrapper && tableWrapper.parentNode) {
      tableWrapper.parentNode.insertBefore(cards, tableWrapper.nextSibling);
    }

    searchForm.addEventListener('input', renderMenus);
    searchForm.addEventListener('change', renderMenus);
    searchForm.addEventListener('submit', (event) => event.preventDefault());
    searchForm.addEventListener('reset', () => window.setTimeout(renderMenus, 0));
    syncCategoryFilterOptions();
    for (const [name, value] of Object.entries(previousFilters)) {
      const input = searchForm.elements.namedItem(name);
      if (input && (name !== 'category' || [...input.options].some((option) => option.value === value))) {
        input.value = value;
      }
    }
  }

  function stockState(menu) {
    if (menu.stockQuantity === null || typeof menu.stockQuantity === 'undefined') return 'unset';
    if (menu.stockQuantity <= 0) return 'out';
    if (menu.stockQuantity <= Number(menu.lowStockThreshold || 0)) return 'low';
    return 'tracked';
  }

  function stockMarkup(menu) {
    const state = stockState(menu);
    if (state === 'unset') return `<span class="text-sm text-slate-400">${T('admin.stockUnset')}</span>`;
    if (state === 'out') return `<span class="rounded-md bg-red-100 px-2 py-1 text-xs font-bold text-red-800">${T('admin.stockOut')}</span>`;
    if (state === 'low') return `<span class="rounded-md bg-amber-100 px-2 py-1 text-xs font-bold text-amber-900">${T('admin.stockLow', { n: menu.stockQuantity })}</span>`;
    return `<span class="font-semibold text-green-800">${Number(menu.stockQuantity)}</span>`;
  }

  function filteredMenus() {
    if (!searchForm) return menus;
    const filters = Object.fromEntries(new FormData(searchForm));
    const query = String(filters.query || '').trim().toLocaleLowerCase();
    return menus.filter((menu) => {
      const stock = stockState(menu);
      const category = catLabel(menu.category);
      const available = Boolean(menu.isAvailable) && stock !== 'out';
      const searchable = [menu.name, category, menu.category, menu.price, menu.stockQuantity ?? T('admin.stockUnset'),
        available ? T('admin.available') : T('admin.soldOut')].join(' ').toLocaleLowerCase();
      const price = Number(menu.price) || 0;
      return (!query || searchable.includes(query))
        && (!filters.category || Categories.key(menu.category) === filters.category)
        && (!filters.availability || (filters.availability === 'available' ? available : !available))
        && (!filters.stockStatus || stock === filters.stockStatus)
        && (filters.minPrice === '' || price >= Number(filters.minPrice))
        && (filters.maxPrice === '' || price <= Number(filters.maxPrice));
    });
  }

  function syncCategoryFilterOptions() {
    if (!searchForm) return;
    const select = searchForm.querySelector('select[name="category"]');
    if (!select) return;
    const next = Categories.orderedKeys(menus.map((menu) => menu.category));
    const selected = select.value;
    select.replaceChildren();
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = T('admin.filterAllCategories');
    allOption.dataset.i18n = 'admin.filterAllCategories';
    select.append(allOption);
    for (const category of next) {
      const option = document.createElement('option');
      option.value = category;
      option.textContent = catLabel(category);
      option.dataset.i18nSkip = '';
      select.append(option);
    }
    select.value = next.includes(selected) ? selected : '';
  }

  function syncCategoryEditorOptions(selectedCategory = fields.category && fields.category.value) {
    if (!fields.category) return;
    const selected = Categories.key(selectedCategory);
    const categories = Categories.orderedKeys([
      ...Categories.MENU_CATEGORIES,
      ...menus.map((menu) => menu.category),
      selected,
    ]);
    fields.category.replaceChildren();
    for (const category of categories) {
      const option = document.createElement('option');
      option.value = category;
      option.textContent = catLabel(category);
      option.dataset.i18nSkip = '';
      fields.category.append(option);
    }
    // An unknown/custom category is deliberately an option too. Assigning a
    // value that isn't in a <select> would otherwise erase it on the next save.
    fields.category.value = selected;
  }

  async function loadMenus() {
    document.getElementById('menu-loading').classList.remove('hidden');
    try {
      const payload = await Admin.api('/api/menu');
      menus = Array.isArray(payload.data) ? payload.data : [];
      syncCategoryFilterOptions();
      syncCategoryEditorOptions();
      renderMenus();
    } catch (error) {
      Admin.message(error.message || T('kitchen.loadMenuFailed'), true);
    } finally {
      document.getElementById('menu-loading').classList.add('hidden');
    }
  }

  function renderMenus() {
    const rows = document.getElementById('menu-rows');
    const cards = document.getElementById('menu-cards');
    if (!rows) return;
    const tableSection = rows.closest('section');
    rows.replaceChildren();
    if (cards) cards.replaceChildren();
    const visibleMenus = filteredMenus();
    const emptyMessage = document.getElementById('menu-empty');
    if (emptyMessage) {
      emptyMessage.classList.toggle('hidden', visibleMenus.length > 0);
      emptyMessage.textContent = menus.length > 0 ? T('admin.filterNoMatch') : T('admin.noMenus');
    }
    const resultCount = document.getElementById('menu-result-count');
    if (resultCount) resultCount.textContent = T('admin.filterShowing', { n: visibleMenus.length, total: menus.length });
    
    document.querySelectorAll('[data-menu-view]').forEach((button) => {
      const selected = button.dataset.menuView === menuView;
      button.classList.toggle('bg-orange-600', selected);
      button.classList.toggle('text-white', selected);
      button.classList.toggle('shadow-sm', selected);
      button.classList.toggle('text-slate-600', !selected);
      button.classList.toggle('hover:bg-white', !selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    
    visibleMenus.forEach((menu) => {
      const available = Boolean(menu.isAvailable) && stockState(menu) !== 'out';
      const canEnable = stockState(menu) !== 'out';
      const toggleLabel = available ? T('admin.closeSale') : (canEnable ? T('admin.openSale') : T('admin.refillFirst'));
      
      const priceDisplay = Number(menu.price) > 0 
        ? Admin.currency(menu.price) 
        : '<span class="text-sm font-normal text-slate-400">ยังไม่กำหนดราคา</span>';

      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="p-4"><div class="flex items-center gap-3"><img src="${Admin.escapeHTML(menu.imageUrl || '')}" alt="" class="h-12 w-12 rounded-lg bg-slate-100 object-cover"><span class="font-bold">${Admin.escapeHTML(menu.name)}</span></div></td>
        <td class="p-4" data-i18n-skip>${Admin.escapeHTML(catLabel(menu.category))}</td>
        <td class="p-4 font-semibold">${priceDisplay}</td>
        <td class="p-4">${stockMarkup(menu)}</td>
        <td class="p-4"><span class="rounded-md px-3 py-1 text-xs font-bold ${available ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">${available ? T('admin.available') : T('admin.soldOut')}</span></td>
        <td class="p-4"><div class="flex justify-end gap-2"><button type="button" data-edit="${Admin.escapeHTML(menu._id)}" class="rounded-lg bg-blue-50 px-3 py-2 text-sm font-bold text-blue-700">${T('admin.edit')}</button><button type="button" data-toggle="${Admin.escapeHTML(menu._id)}" class="rounded-lg bg-amber-50 px-3 py-2 text-sm font-bold text-amber-800" ${!available && !canEnable ? `disabled title="${T('admin.refillFirst')}"` : ''}>${toggleLabel}</button>${Admin.isAdmin ? `<button type="button" data-delete="${Admin.escapeHTML(menu._id)}" class="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-700">${T('admin.delete')}</button>` : ''}</div></td>`;
      const image = row.querySelector('img');
      image.onerror = () => { image.onerror = null; image.src = '/assets/images/default-food.jpg'; };
      row.querySelector('[data-edit]').addEventListener('click', () => openEditor(menu));
      row.querySelector('[data-toggle]').addEventListener('click', () => toggleAvailability(menu));
      const deleteButton = row.querySelector('[data-delete]');
      if (deleteButton) deleteButton.addEventListener('click', () => deleteMenu(menu));
      rows.append(row);

      if (cards) {
        const card = document.createElement('article');
        card.className = 'flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm';
        card.innerHTML = `
          <img src="${Admin.escapeHTML(menu.imageUrl || '')}" alt="" class="h-40 w-full bg-slate-100 object-cover">
          <div class="flex flex-1 flex-col p-4">
            <div class="flex items-start justify-between gap-2">
              <h3 class="min-w-0 flex-1 font-black leading-tight">${Admin.escapeHTML(menu.name)}</h3>
              <span class="mt-1 inline-block shrink-0 rounded-md px-2 py-0.5 text-[10px] font-bold ${available ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">${available ? T('admin.available') : T('admin.unavailable')}</span>
            </div>
            <p class="mt-1 text-xs text-slate-500" data-i18n-skip>${Admin.escapeHTML(catLabel(menu.category))}</p>
            <p class="mt-1 text-sm text-slate-500">${Admin.escapeHTML(menu.description || '')}</p>
            <p class="mt-3 font-bold text-orange-700">${priceDisplay}</p>
            <p class="mt-1 text-xs">${stockMarkup(menu)}</p>
            <div class="mt-3 flex flex-wrap gap-2">
              <button type="button" data-edit class="rounded-lg bg-blue-50 px-3 py-2 text-sm font-bold text-blue-700">${T('admin.edit')}</button>
              <button type="button" data-toggle class="rounded-lg bg-amber-50 px-3 py-2 text-sm font-bold text-amber-800" ${!available && !canEnable ? `disabled title="${T('admin.refillFirst')}"` : ''}>${toggleLabel}</button>
              ${Admin.isAdmin ? `<button type="button" data-delete class="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-700">${T('admin.delete')}</button>` : ''}
            </div>
          </div>`;
        const cardImage = card.querySelector('img');
        cardImage.onerror = () => { cardImage.onerror = null; cardImage.src = '/assets/images/default-food.jpg'; };
        card.querySelector('[data-edit]').addEventListener('click', () => openEditor(menu));
        card.querySelector('[data-toggle]').addEventListener('click', () => toggleAvailability(menu));
        const cardDelete = card.querySelector('[data-delete]');
        if (cardDelete) cardDelete.addEventListener('click', () => deleteMenu(menu));
        cards.append(card);
      }
    });
    if (tableSection) tableSection.classList.toggle('hidden', menuView === 'cards');
    if (cards) cards.classList.toggle('hidden', menuView !== 'cards');
  }

  function setPreview(src) {
    const img = document.getElementById('menu-image-preview');
    if (img) {
      img.onerror = () => { img.onerror = null; img.src = '/assets/images/default-food.jpg'; };
      img.src = src || '/assets/images/default-food.jpg';
    }
  }

  function openEditor(menu = null) {
    if (!form) return;
    form.reset();
    if (fields.menuId) fields.menuId.value = menu ? menu._id : '';
    if (fields.name) fields.name.value = menu ? menu.name : '';
    if (fields.description) fields.description.value = menu ? menu.description || '' : '';
    
    if (fields.price) fields.price.value = (menu && menu.price > 0) ? menu.price : '';
    if (fields.preparationTime) fields.preparationTime.value = menu ? menu.preparationTime : 10;
    
    syncCategoryEditorOptions(menu ? menu.category : Categories.DEFAULT_CATEGORY);
    categoryManuallySelected = false;

    if (fields.imageUrl) fields.imageUrl.value = menu ? menu.imageUrl || '' : '';
    if (fields.stockQuantity) {
      fields.stockQuantity.value = menu && menu.stockQuantity !== null && typeof menu.stockQuantity !== 'undefined' ? menu.stockQuantity : '';
    }
    if (fields.lowStockThreshold) fields.lowStockThreshold.value = menu ? menu.lowStockThreshold ?? 5 : 5;
    if (fields.maxOrderQuantity) fields.maxOrderQuantity.value = menu ? menu.maxOrderQuantity ?? 99 : 99;
    
    editingMenu = menu || null;
    updateMenuModalTitle();
    setPreview(menu ? menu.imageUrl : '/assets/images/default-food.jpg');
    const fileName = document.querySelector('[data-file-name="menuImageFile"]');
    if (fileName) fileName.textContent = '';
    setMenuModalOpen(true);
  }

  async function saveMenu(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const menuId = values.menuId;
    delete values.menuId;
    
    if (!values.category) {
      Admin.message(T('error.INVALID_MENU_CATEGORY'), true);
      return;
    }

    const imageFile = fields.imageFile && fields.imageFile.files[0];
    delete values.imageFile;
    if (imageFile) {
      const upload = new FormData();
      upload.append('image', imageFile);
      values.imageUrl = (await Admin.api('/api/menu/image', { method: 'POST', body: upload })).data.imageUrl;
    }
    values.price = values.price === '' ? 0 : Number(values.price);
    values.preparationTime = Number(values.preparationTime);
    values.stockQuantity = values.stockQuantity === '' ? null : Number(values.stockQuantity);
    values.lowStockThreshold = Number(values.lowStockThreshold);
    values.maxOrderQuantity = Number(values.maxOrderQuantity);
    try {
      await Admin.api(menuId ? `/api/menu/${encodeURIComponent(menuId)}` : '/api/menu', {
        method: menuId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      setMenuModalOpen(false);
      Admin.message(menuId ? T('admin.tables.editSuccess') : T('admin.tables.createSuccess'));
      await loadMenus();
    } catch (error) {
      Admin.message(error.message || T('form.saveMenu'), true);
    }
  }

  async function toggleAvailability(menu) {
    try {
      await Admin.api(`/api/menu/${encodeURIComponent(menu._id)}/availability`, { method: 'PUT' });
      Admin.message(`${menu.name}: ${T('admin.availability')}`);
      await loadMenus();
    } catch (error) {
      Admin.message(error.message || T('kitchen.toggleFailed'), true);
    }
  }

  async function deleteMenu(menu) {
    const ok = await Admin.confirm(`${T('admin.delete')} "${menu.name}"?`, {
      title: T('admin.delete'),
      okText: T('admin.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await Admin.api(`/api/menu/${encodeURIComponent(menu._id)}`, { method: 'DELETE' });
      Admin.message(T('admin.tables.deleteSuccess'));
      await loadMenus();
    } catch (error) {
      Admin.message(error.message || T('admin.tables.deleteFailed'), true);
    }
  }

  document.getElementById('add-menu-button').addEventListener('click', () => openEditor());
  installInventoryControls();
  
  // Auto-categorize new items only until the user explicitly selects a category.
  if (fields.category) fields.category.addEventListener('change', () => { categoryManuallySelected = true; });
  if (fields.name) {
    fields.name.addEventListener('input', (e) => {
      if (!editingMenu && !categoryManuallySelected && fields.category) {
        const guessed = guessCategory(e.target.value);
        if (guessed) {
          fields.category.value = guessed;
        }
      }
    });
  }

  if (form) form.addEventListener('submit', saveMenu);
  document.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', () => setMenuModalOpen(false));
  });
  if (fields.imageUrl) fields.imageUrl.addEventListener('input', () => setPreview(fields.imageUrl.value.trim()));
  if (Admin.bindFileInput) Admin.bindFileInput('menuImageFile');
  if (fields.imageFile) {
    fields.imageFile.addEventListener('change', () => {
      const f = fields.imageFile.files && fields.imageFile.files[0];
      if (f) setPreview(URL.createObjectURL(f));
    });
  }
  loadMenus();
  const socket = Admin.connectSocket();
  if (socket) {
    socket.on('menu_stock_changed', loadMenus);
    socket.on('menu_availability_changed', loadMenus);
  }
  window.setInterval(() => {
    if (!socket || !socket.connected) loadMenus();
  }, 30000);

  let langTimer = null;
  window.addEventListener('languageChanged', () => {
    if (langTimer) window.clearTimeout(langTimer);
    langTimer = window.setTimeout(() => {
      langTimer = null;
      installInventoryControls();
      syncCategoryEditorOptions();
      const addBtn = document.getElementById('add-menu-button');
      if (addBtn) addBtn.textContent = T('admin.addMenu');
      updateMenuModalTitle();
      renderMenus();
    }, 50);
  });
})();