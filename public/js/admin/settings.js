(() => {
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);
  const form = document.getElementById('shop-settings-form');
  const openButton = document.getElementById('open-shop-button');
  const statusElement = document.getElementById('shop-status');
  const countdownElement = document.getElementById('closing-countdown');
  const billingPreviewBody = document.getElementById('billing-preview-body');
  const CACHE_KEY = 'shopStatusCache';
  let current;
  let countdownTimer;

  function setPreview(type, source) {
    const image = document.querySelector(`[data-preview="${type}"]`);
    if (image && source) image.src = source;
  }

  function bindFileName(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const display = document.querySelector(`[data-file-name="${inputId}"]`);
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (display) display.textContent = file ? file.name : '';
    });
  }

  function bindImagePreview(fieldName, previewType, fallback) {
    const field = form.elements[fieldName];
    const fileField = form.elements[`${previewType}File`];
    if (field) field.addEventListener('input', () => setPreview(previewType, field.value.trim() || fallback));
    if (fileField) {
      fileField.addEventListener('change', () => {
        const file = fileField.files && fileField.files[0];
        if (file) setPreview(previewType, URL.createObjectURL(file));
      });
    }
  }

  function renderCountdown() {
    if (!current || !current.status || !current.status.isOpen || current.status.isTestMode || !current.status.closesAt) {
      countdownElement.classList.add('hidden');
      return;
    }
    const remaining = Math.max(0, new Date(current.status.closesAt).getTime() - Date.now());
    const h = Math.floor(remaining / 3_600_000);
    const m = Math.floor((remaining % 3_600_000) / 60_000);
    const s = Math.floor((remaining % 60_000) / 1000);
    countdownElement.textContent = T('admin.settings.closingIn', {
      time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`,
    });
    countdownElement.classList.remove('hidden');
  }

  function applyStatusLabel() {
    if (!current || !current.status) {
      statusElement.textContent = T('admin.settings.statusUnknown');
      openButton.classList.add('hidden');
      return;
    }
    const { status } = current;
    let label;
    if (status.isTestMode) label = T('admin.settings.statusTest');
    else if (status.isOpen) label = T('admin.settings.statusOpen', { time: current.closeTime || '--:--' });
    else label = T('admin.settings.statusClosed');
    statusElement.textContent = label;
    openButton.classList.toggle('hidden', Boolean(status.isOpen));
  }

  const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
  const fmt = (v) => `฿${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v || 0)}`;

  function renderBillingPreview() {
    if (!billingPreviewBody) return;
    const sample = 100;
    const vatPercent = Number(form.elements.vatPercent.value) || 0;
    const servicePercent = Number(form.elements.serviceChargePercent.value) || 0;
    const vatMode = form.elements.vatMode.value;
    const serviceMode = form.elements.serviceChargeMode.value;
    const s = servicePercent / 100;
    const v = vatPercent / 100;
    let serviceCharge = 0, vat = 0, grandTotal = 0;
    if (serviceMode === 'included' && vatMode === 'included') {
      const denom = (1 + s) * (1 + v);
      const base = denom > 0 ? sample / denom : sample;
      serviceCharge = round(base * s);
      vat = round(base * (1 + s) * v);
      grandTotal = sample;
    } else if (serviceMode === 'excluded' && vatMode === 'excluded') {
      serviceCharge = round(sample * s);
      vat = round((sample + serviceCharge) * v);
      grandTotal = round(sample + serviceCharge + vat);
    } else if (serviceMode === 'excluded' && vatMode === 'included') {
      serviceCharge = round(sample * s);
      const withService = round(sample + serviceCharge);
      const baseForVat = v > 0 ? withService / (1 + v) : withService;
      vat = round(withService - baseForVat);
      grandTotal = withService;
    } else {
      const base = 1 + s > 0 ? sample / (1 + s) : sample;
      serviceCharge = round(sample - base);
      vat = round(sample * v);
      grandTotal = round(sample + vat);
    }
    billingPreviewBody.innerHTML = `
      <div class="flex justify-between"><span>${T('admin.settings.previewFood')}</span><span>${fmt(sample)}</span></div>
      <div class="flex justify-between"><span>${T('admin.settings.previewService', { percent: servicePercent, mode: serviceMode === 'included' ? T('checkout.serviceIncluded') : T('checkout.serviceExcluded') })}</span><span>${fmt(serviceCharge)}</span></div>
      <div class="flex justify-between"><span>${T('admin.settings.previewVat', { percent: vatPercent, mode: vatMode === 'included' ? T('checkout.vatIncluded') : T('checkout.vatExcluded') })}</span><span>${fmt(vat)}</span></div>
      <div class="flex justify-between font-bold text-slate-800"><span>${T('admin.settings.previewCustomerPays')}</span><span>${fmt(grandTotal)}</span></div>`;
  }

  function bindBillingPreview() {
    ['vatPercent', 'serviceChargePercent', 'vatMode', 'serviceChargeMode'].forEach((n) => {
      const f = form.elements[n];
      if (f) { f.addEventListener('input', renderBillingPreview); f.addEventListener('change', renderBillingPreview); }
    });
  }

  window.addEventListener('languageChanged', () => {
    applyStatusLabel();
    renderCountdown();
    renderBillingPreview();
  });

  function render(data) {
    current = data;
    if (!data) { statusElement.textContent = T('admin.settings.statusUnknown'); return; }
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ restaurantName: data.restaurantName, openTime: data.openTime, closeTime: data.closeTime, status: data.status, savedAt: Date.now() })); } catch {}

    if (form.elements.openTime) form.elements.openTime.value = data.openTime || '10:30';
    if (form.elements.closeTime) form.elements.closeTime.value = data.closeTime || '03:00';
    if (form.elements.isTestMode) form.elements.isTestMode.checked = Boolean(data.isTestMode);
    ['restaurantName', 'welcomeMessage', 'phone', 'address', 'diningDurationMinutes', 'logoUrl', 'heroImageUrl'].forEach((n) => {
      if (form.elements[n]) form.elements[n].value = data[n] || '';
    });
    if (form.elements.vatPercent) form.elements.vatPercent.value = data.vatPercent ?? 7;
    if (form.elements.serviceChargePercent) form.elements.serviceChargePercent.value = data.serviceChargePercent ?? 10;
    if (form.elements.vatMode) form.elements.vatMode.value = data.vatMode || 'included';
    if (form.elements.serviceChargeMode) form.elements.serviceChargeMode.value = data.serviceChargeMode || 'included';
    if (form.elements.paymentQrImageUrl) form.elements.paymentQrImageUrl.value = data.paymentQrImageUrl || '/assets/images/payment/promptpay.png';

    setPreview('logo', data.logoUrl || '/assets/images/logo.png');
    setPreview('hero', data.heroImageUrl || '/assets/images/default-food.jpg');
    setPreview('paymentQr', data.paymentQrImageUrl || '/assets/images/payment/promptpay.png');

    applyStatusLabel();
    renderCountdown();
    renderBillingPreview();
  }

  function applyCachedStatus() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (cached && cached.status) {
        current = { ...cached };
        applyStatusLabel();
      }
    } catch {}
  }

  function syncBrand(name) {
    if (!name) return;
    try { localStorage.setItem('shopBrand', name); } catch {}
    if (typeof window.applyBrandName === 'function') window.applyBrandName(name);
    const sidebarBrand = document.querySelector('[data-sidebar-brand]');
    if (sidebarBrand) sidebarBrand.textContent = name;
  }

  async function load() {
    try {
      const data = (await Admin.api('/api/settings/shop')).data;
      render(data);
      syncBrand(data.restaurantName);
    } catch (error) {
      // หากโหลดไม่สำเร็จ ให้แสดงข้อความแจ้งเตือน ไม่ให้ค้างที่ "กำลังโหลด..."
      statusElement.textContent = T('admin.settings.statusUnknown');
      Admin.message(error.message, true);
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const uploads = [
        ['logoFile', 'logoUrl'],
        ['heroFile', 'heroImageUrl'],
        ['paymentQrFile', 'paymentQrImageUrl'],
      ];
      for (const [fileName, target] of uploads) {
        const input = form.elements[fileName];
        if (!input) continue;
        const file = input.files && input.files[0];
        if (!file) continue;
        const body = new FormData();
        body.append('image', file);
        const res = await Admin.api('/api/settings/shop/image', { method: 'POST', body });
        form.elements[target].value = res.data.imageUrl;
      }

      const data = Object.fromEntries(new FormData(form));
      data.isTestMode = form.elements.isTestMode.checked;
      delete data.logoFile;
      delete data.heroFile;
      delete data.paymentQrFile;

      const saved = (await Admin.api('/api/settings/shop', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      })).data;
      render(saved);
      syncBrand(saved.restaurantName);
      Admin.message(T('admin.settings.saveSuccess'));

      document.querySelectorAll('[data-file-name]').forEach((el) => { el.textContent = ''; });
      const icon = document.querySelector('link[rel="icon"]');
      if (icon) icon.href = `/api/settings/favicon?v=${Date.now()}`;
    } catch (error) {
      Admin.message(error.message, true);
    }
  });

  openButton.addEventListener('click', async () => {
    const ok = await Admin.confirm(T('admin.settings.confirmOpenMsg'), {
      title: T('admin.settings.confirmOpenTitle'),
      okText: T('admin.settings.confirmOpenOk'),
      cancelText: T('admin.settings.confirmOpenCancel'),
    });
    if (!ok) return;
    try {
      const data = (await Admin.api('/api/settings/shop/open', { method: 'POST' })).data;
      render(data); syncBrand(data.restaurantName);
      Admin.message(T('admin.settings.openSuccess'));
    } catch (error) { Admin.message(error.message, true); }
  });

  const socket = Admin.connectSocket();
  if (socket) socket.on('shop_status_changed', load);

  applyCachedStatus();
  load();
  bindImagePreview('logoUrl', 'logo', '/assets/images/logo.png');
  bindImagePreview('heroImageUrl', 'hero', '/assets/images/default-food.jpg');
  bindImagePreview('paymentQrImageUrl', 'paymentQr', '/assets/images/payment/promptpay.png');
  bindFileName('logoFileInput');
  bindFileName('heroFileInput');
  bindFileName('paymentQrFileInput');
  bindBillingPreview();
  countdownTimer = window.setInterval(renderCountdown, 1000);
  window.addEventListener('beforeunload', () => window.clearInterval(countdownTimer));
})();