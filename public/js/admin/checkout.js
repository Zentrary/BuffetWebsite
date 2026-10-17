// Select active dining sessions, calculate bills, accept payment, and print receipts.
(() => {
  const Admin = window.Admin;
  if (!Admin) return;
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);
  const sessionCards = document.getElementById('session-cards');
  const sessionRows = document.getElementById('session-rows');
  const sessionTableWrap = document.getElementById('session-table-wrap');
  const paymentModal = document.getElementById('payment-modal');
  const paymentForm = document.getElementById('payment-form');
  let selectedSessionId = '';
  let selectedSession = null;
  let selectedBill = null;
  let selectedQrPayment = null;
  let initialSessionLinkHandled = false;
  let checkoutView = localStorage.getItem('checkoutView') || 'cards';

  function currentLocale() {
    return localStorage.getItem('lang') === 'en' ? 'en-US' : 'th-TH';
  }

  async function loadSessions() {
    try {
      const payload = await Admin.api('/api/payment/sessions');
      const sessions = Array.isArray(payload.data) ? payload.data : [];
      renderSessionCards(sessions);
      const requestedId = new URLSearchParams(window.location.search).get('sessionId');
      const requestedSession = sessions.find((session) => session._id === requestedId);
      if (!initialSessionLinkHandled && requestedSession && requestedSession.checkoutRequestedAt) {
        initialSessionLinkHandled = true;
        await openPayment(requestedSession);
      }
    } catch (error) {
      Admin.message(error.message || T('admin.checkout.loadSessionsFailed'), true);
      sessionCards.replaceChildren();
      document.getElementById('sessions-loading').classList.add('hidden');
    }
  }

  function isSessionExpired(session) {
    if (!session.endTime) return false;
    return new Date(session.endTime).getTime() <= Date.now();
  }

  async function forceCompleteSession(sessionId, button) {
    const ok = await Admin.confirm(T('admin.checkout.confirmForceComplete'), {
      title: T('admin.checkout.confirmForceCompleteTitle'),
      okText: T('admin.checkout.confirmForceCompleteOk'),
      danger: true,
    });
    if (!ok) return;
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = T('admin.checkout.loading');
    try {
      await Admin.api(`/api/admin/session/${encodeURIComponent(sessionId)}/force-complete`, { method: 'POST' });
      Admin.message(T('admin.checkout.forceCompleteDone'));
      await loadSessions();
    } catch (error) {
      Admin.message(error.message || T('admin.checkout.forceCompleteFailed'), true);
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  async function forceFreeSession(sessionId, button) {
    const ok = await Admin.confirm(T('admin.checkout.confirmForceFree'), {
      title: T('admin.checkout.confirmForceFreeTitle'),
      okText: T('admin.checkout.confirmForceFreeOk'),
      danger: true,
    });
    if (!ok) return;
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = T('admin.checkout.loading');
    try {
      await Admin.api(`/api/admin/session/${encodeURIComponent(sessionId)}/force-free`, { method: 'POST' });
      Admin.message(T('admin.checkout.forceFreeDone'));
      await loadSessions();
    } catch (error) {
      Admin.message(error.message || T('admin.checkout.forceFreeFailed'), true);
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  function renderSessionCards(sessions) {
    sessionCards.replaceChildren();
    sessionRows.replaceChildren();
    sessionCards.classList.toggle('hidden', checkoutView === 'table');
    sessionTableWrap.classList.toggle('hidden', checkoutView !== 'table');
    document.getElementById('sessions-empty').classList.toggle('hidden', sessions.length > 0);
    document.getElementById('sessions-loading').classList.add('hidden');

    for (const session of sessions) {
      const card = document.createElement('article');
      card.className = 'flex min-h-[16rem] flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm';
      const tableNumber = session.table && session.table.tableNumber || '—';
      const zoneLabel = T(`table.zone.${session.table && session.table.zone}`) || '—';
      const queueNumber = session.queue && session.queue.queueNumber;
      const items = session.items || [];
      const itemCount = Number(session.itemCount) || 0;
      const visibleItems = items.slice(0, 3);
      const extraCount = Math.max(0, items.length - visibleItems.length);
      const itemRows = visibleItems.map((item) => `
        <li class="flex justify-between gap-3 border-b border-slate-100 py-1 last:border-0">
          <span class="min-w-0 truncate">${Admin.escapeHTML(item.name)} × ${Number(item.quantity) || 0}</span>
          <span class="shrink-0 font-medium">${Admin.currency((Number(item.price) || 0) * (Number(item.quantity) || 0))}</span>
        </li>`).join('');

      const hasCheckout = Boolean(session.checkoutRequestedAt);
      const expired = isSessionExpired(session);
      const canPay = hasCheckout;
      const isQrWaiting = session.pendingPayment && session.pendingPayment.status === 'awaiting_confirmation';
      const stuck = expired && !hasCheckout;

      let mainLabel;
      if (isQrWaiting) mainLabel = T('admin.checkout.waitingSlip');
      else if (canPay) mainLabel = T('admin.checkout.pay');
      else if (expired) mainLabel = T('admin.checkout.expired');
      else mainLabel = T('admin.checkout.waitConfirm');

      const mainClass = canPay ? 'bg-green-700 hover:bg-green-800' : 'cursor-not-allowed bg-slate-400';

      card.innerHTML = `
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-xs font-bold uppercase tracking-widest text-slate-500">${Admin.escapeHTML(zoneLabel)}</p>
            <h2 class="text-2xl font-black leading-tight">${Admin.escapeHTML(T('queue.table'))} ${Admin.escapeHTML(tableNumber)}</h2>
            <p class="mt-0.5 text-xs text-slate-500">${queueNumber ? `${Admin.escapeHTML(queueNumber)} · ` : ''}${Admin.escapeHTML(T('admin.checkout.startedAt', { time: new Date(session.startTime).toLocaleTimeString(currentLocale()) }))}</p>
          </div>
          <span class="shrink-0 rounded-md px-2 py-1 text-xs font-bold ${session.status === 'expired' ? 'bg-red-100 text-red-800' : 'bg-orange-100 text-orange-900'}" data-endtime="${Admin.escapeHTML(session.endTime)}">${remaining(session.endTime)}</span>
        </div>
        <p class="mt-2 text-xs font-bold uppercase text-slate-500">${Admin.escapeHTML(T('admin.checkout.itemsCount', { n: itemCount }))}</p>
        <ul class="mt-1 flex-1 overflow-hidden text-sm">${itemRows || `<li class="py-2 text-slate-400">${Admin.escapeHTML(T('admin.checkout.noItems'))}</li>`}${extraCount > 0 ? `<li class="py-1 text-xs text-slate-400">${Admin.escapeHTML(T('admin.checkout.moreItems', { n: extraCount }))}</li>` : ''}</ul>
        <div class="mt-2 flex items-end justify-between border-t border-slate-100 pt-2">
          <span class="text-xs text-slate-500">${Admin.escapeHTML(T('admin.checkout.netTotal'))}</span><strong class="text-lg text-orange-700">${Admin.currency(session.bill && session.bill.grandTotal)}</strong>
        </div>
        <button type="button" data-pay-session="${Admin.escapeHTML(session._id)}" class="mt-2 min-h-10 w-full rounded-lg px-4 py-2 text-sm font-bold text-white ${mainClass}" ${canPay ? '' : 'disabled'}>
          ${mainLabel}
        </button>
        ${stuck ? `
        <button type="button" data-force-session="${Admin.escapeHTML(session._id)}" data-force-mode="${itemCount > 0 ? 'complete' : 'free'}" class="mt-1.5 min-h-9 w-full rounded-lg border border-red-200 bg-white px-4 py-1.5 text-xs font-bold text-red-700 hover:bg-red-50">
          ${itemCount > 0 ? Admin.escapeHTML(T('admin.checkout.forceComplete')) : Admin.escapeHTML(T('admin.checkout.forceFree'))}
        </button>` : ''}`;

      const payButton = card.querySelector('[data-pay-session]');
      if (canPay) payButton.addEventListener('click', () => openPayment(session));

      const forceButton = card.querySelector('[data-force-session]');
      if (forceButton) {
        forceButton.addEventListener('click', () => {
          const mode = forceButton.dataset.forceMode;
          if (mode === 'complete') forceCompleteSession(session._id, forceButton);
          else forceFreeSession(session._id, forceButton);
        });
      }

      sessionCards.append(card);

      const row = document.createElement('tr');
      row.innerHTML = `<td class="p-3"><p class="font-black">${Admin.escapeHTML(T('queue.table'))} ${Admin.escapeHTML(tableNumber)}</p><p class="text-xs text-slate-500">${Admin.escapeHTML(zoneLabel)}</p></td>
        <td class="max-w-sm p-3 text-xs text-slate-600">${items.length ? items.slice(0, 4).map((item) => `${Admin.escapeHTML(item.name)} × ${Number(item.quantity) || 0}`).join(', ') + (items.length > 4 ? ` …+${items.length - 4}` : '') : Admin.escapeHTML(T('admin.checkout.noItems'))}</td>
        <td class="p-3"><span class="inline-block rounded-xl px-2 py-1 text-xs font-bold ${session.status === 'expired' ? 'bg-red-100 text-red-800' : 'bg-orange-100 text-orange-900'}" data-endtime="${Admin.escapeHTML(session.endTime)}">${remaining(session.endTime)}</span></td>
        <td class="p-3 text-right font-bold text-orange-700">${Admin.currency(session.bill && session.bill.grandTotal)}</td>
        <td class="p-3 text-right space-y-1">
          <button type="button" class="min-h-9 w-full rounded-lg px-3 py-1.5 text-xs font-bold text-white ${canPay ? 'bg-green-700 hover:bg-green-800' : 'cursor-not-allowed bg-slate-400'}" ${canPay ? '' : 'disabled'}>${isQrWaiting ? Admin.escapeHTML(T('admin.checkout.viewQr')) : canPay ? Admin.escapeHTML(T('admin.checkout.pay')) : Admin.escapeHTML(T('admin.checkout.waitCustomer'))}</button>
          ${stuck ? `<button type="button" data-force-row="${Admin.escapeHTML(session._id)}" data-force-row-mode="${itemCount > 0 ? 'complete' : 'free'}" class="min-h-9 w-full rounded-lg border border-red-200 bg-white px-3 py-1.5 text-[11px] font-bold text-red-700 hover:bg-red-50">${itemCount > 0 ? Admin.escapeHTML(T('admin.checkout.forceComplete')) : Admin.escapeHTML(T('admin.checkout.forceFree'))}</button>` : ''}
        </td>`;

      const rowButton = row.querySelector('button:not([data-force-row])');
      if (canPay) rowButton.addEventListener('click', () => openPayment(session));

      const forceRow = row.querySelector('[data-force-row]');
      if (forceRow) {
        forceRow.addEventListener('click', () => {
          const mode = forceRow.dataset.forceRowMode;
          if (mode === 'complete') forceCompleteSession(session._id, forceRow);
          else forceFreeSession(session._id, forceRow);
        });
      }

      sessionRows.append(row);
    }
    document.querySelectorAll('[data-checkout-view]').forEach((button) => {
      const selected = button.dataset.checkoutView === checkoutView;
      button.classList.toggle('bg-orange-600', selected);
      button.classList.toggle('text-white', selected);
      button.classList.toggle('text-slate-600', !selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }

  function remaining(endTime) {
    const seconds = Math.max(0, Math.ceil((new Date(endTime).getTime() - Date.now()) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function updateCountdowns() {
    sessionCards.querySelectorAll('[data-endtime]').forEach((element) => {
      element.textContent = remaining(element.dataset.endtime);
    });
    sessionRows.querySelectorAll('[data-endtime]').forEach((element) => {
      element.textContent = remaining(element.dataset.endtime);
    });
  }

  async function openPayment(session) {
    selectedSession = session;
    selectedSessionId = String(session._id);
    selectedBill = session.bill;
    selectedQrPayment = session.pendingPayment || null;
    paymentModal.classList.replace('hidden', 'flex');
    document.getElementById('payment-error').classList.add('hidden');
    document.getElementById('receipt-paid').classList.add('hidden');
    document.getElementById('print-receipt').classList.add('hidden');
    paymentForm.classList.remove('hidden');
    paymentForm.elements.method.value = 'cash';
    paymentForm.elements.method.disabled = false;
    document.getElementById('cash-received').disabled = false;
    document.getElementById('confirm-payment').classList.remove('hidden');
    document.getElementById('receipt-cash-row').classList.add('hidden');
    document.getElementById('receipt-change-row').classList.add('hidden');
    document.getElementById('cash-received').value = '';
    updateCashPreview();
    document.getElementById('qr-payment-amount').textContent = Admin.currency(session.bill && session.bill.grandTotal);
    await loadPaymentQrImage();
    setPaymentMethodView();
    await loadBill();
  }

  async function loadPaymentQrImage() {
    const image = document.getElementById('payment-qr-image');
    const missing = document.getElementById('payment-qr-missing');
    try {
      const payload = await Admin.api('/api/settings/shop');
      const url = (payload.data && payload.data.paymentQrImageUrl) || '/assets/images/payment/promptpay.png';
      image.src = url;
      image.classList.remove('hidden');
      missing.classList.add('hidden');
    } catch {}
    image.onerror = () => {
      image.classList.add('hidden');
      missing.classList.remove('hidden');
    };
  }

  async function renderItems(sessionId) {
    const payload = await Admin.api(`/api/order/session/${encodeURIComponent(sessionId)}`);
    const container = document.getElementById('receipt-items');
    container.replaceChildren();
    let count = 0;
    for (const order of payload.data || []) {
      for (const item of order.items || []) {
        if (item.itemStatus === 'cancelled' || order.status === 'cancelled') continue;
        count += 1;
        const row = document.createElement('div');
        row.className = 'flex justify-between gap-4 text-sm';
        row.innerHTML = `<span>${Admin.escapeHTML(item.name)} × ${Number(item.quantity) || 0}</span><span class="font-semibold">${Admin.currency((Number(item.price) || 0) * (Number(item.quantity) || 0))}</span>`;
        container.append(row);
      }
    }
    document.getElementById('receipt-empty').classList.toggle('hidden', count > 0);
  }

  async function loadBill() {
    if (!selectedSessionId) return;
    document.getElementById('page-message').classList.add('hidden');
    try {
      const [bill, session] = await Promise.all([
        Admin.api('/api/payment/calculate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: selectedSessionId }),
        }),
        Admin.api(`/api/session/${encodeURIComponent(selectedSessionId)}`),
      ]);
      await renderItems(selectedSessionId);
      const pendingPayment = selectedSession && selectedSession.pendingPayment;
      selectedSession = { ...session.data, pendingPayment };
      selectedBill = bill.data;
      const tableNumber = session.data.tableId && session.data.tableId.tableNumber;
      document.getElementById('receipt-session').textContent = T('admin.checkout.receiptSession', { table: tableNumber || '—', id: selectedSessionId });
      document.getElementById('receipt-time').textContent = T('admin.checkout.receiptStarted', { time: new Date(session.data.startTime).toLocaleString(currentLocale()) });
      document.getElementById('bill-subtotal').textContent = Admin.currency(bill.data.subtotal);
      document.getElementById('bill-service').textContent = Admin.currency(bill.data.serviceCharge);
      document.getElementById('bill-vat').textContent = Admin.currency(bill.data.vat);
      document.getElementById('bill-total').textContent = Admin.currency(bill.data.grandTotal);
      document.getElementById('qr-payment-amount').textContent = Admin.currency(bill.data.grandTotal);
      const serviceLabel = document.querySelector('[data-bill-service-label]');
      const vatLabel = document.querySelector('[data-bill-vat-label]');
      const serviceMode = bill.data.serviceChargeMode === 'excluded' ? T('checkout.serviceExcluded') : T('checkout.serviceIncluded');
      const vatMode = bill.data.vatMode === 'excluded' ? T('checkout.vatExcluded') : T('checkout.vatIncluded');
      if (serviceLabel) serviceLabel.textContent = T('checkout.serviceLabel', { mode: serviceMode });
      if (vatLabel) vatLabel.textContent = T('checkout.vatLabel', { mode: vatMode });
      const discount = Number(bill.data.discount) || 0;
      document.getElementById('bill-discount-row').classList.toggle('hidden', discount <= 0);
      document.getElementById('bill-discount').textContent = `-${Admin.currency(discount)}`;
      paymentForm.classList.toggle('hidden', !session.data.checkoutRequestedAt && !pendingPayment);
      if (pendingPayment) {
        selectedQrPayment = pendingPayment;
        paymentForm.elements.method.value = 'qr_payment';
        setPaymentMethodView();
      } else {
        setPaymentMethodView();
      }
      document.getElementById('confirm-payment').disabled = false;
    } catch (error) {
      const paymentError = document.getElementById('payment-error');
      paymentError.textContent = error.message || T('admin.checkout.loadBillFailed');
      paymentError.classList.remove('hidden');
    }
  }

  function updateCashPreview() {
    const input = document.getElementById('cash-received');
    const preview = document.getElementById('cash-change-preview');
    if (!selectedBill || input.value === '') {
      preview.textContent = T('admin.checkout.cashChangePlaceholder');
      preview.className = 'mt-2 rounded-lg bg-slate-50 p-3 text-sm';
      return;
    }
    const received = Math.round((Number(input.value) + Number.EPSILON) * 100) / 100;
    const total = Number(selectedBill.grandTotal) || 0;
    if (!Number.isFinite(received) || received < total) {
      preview.textContent = T('admin.checkout.cashInsufficient', { amount: Admin.currency(Math.max(0, total - received)) });
      preview.className = 'mt-2 rounded-lg bg-red-100 p-3 text-sm font-semibold text-red-800';
      return;
    }
    preview.textContent = T('admin.checkout.cashChange', { amount: Admin.currency(received - total) });
    preview.className = 'mt-2 rounded-lg bg-green-100 p-3 text-sm font-semibold text-green-800';
  }

  function setPaymentMethodView() {
    const isQr = paymentForm.elements.method.value === 'qr_payment';
    document.getElementById('cash-received-field').classList.toggle('hidden', isQr);
    document.getElementById('cash-received').required = !isQr;
    document.getElementById('cash-change-preview').classList.toggle('hidden', isQr);
    document.getElementById('qr-payment-panel').classList.toggle('hidden', !isQr);
    document.getElementById('confirm-payment').classList.toggle('hidden', isQr);
    document.getElementById('confirm-payment-label').textContent = T('admin.checkout.confirmCash');
    document.getElementById('payment-workflow-hint').textContent = isQr ? T('admin.checkout.qrHint') : T('admin.checkout.cashHint');
    if (isQr) ensureQrPayment();
  }

  async function ensureQrPayment() {
    if (!selectedSessionId) return;
    if (selectedQrPayment && ['pending', 'awaiting_confirmation'].includes(selectedQrPayment.status)) {
      document.getElementById('qr-payment-status').textContent = `${T('admin.checkout.amountDue')} ${Admin.currency(selectedQrPayment.amount)} · ${T('admin.checkout.waitingSlip')}`;
      return;
    }
    try {
      const payload = await Admin.api('/api/payment/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: selectedSessionId, method: 'qr_payment' }),
      });
      selectedQrPayment = payload.data;
      if (selectedSession) selectedSession.pendingPayment = payload.data;
      document.getElementById('qr-payment-status').textContent = `${T('admin.checkout.amountDue')} ${Admin.currency(payload.data.amount)} · ${T('admin.checkout.waitingSlip')}`;
    } catch (error) {
      const paymentError = document.getElementById('payment-error');
      paymentError.textContent = error.message || T('admin.checkout.processFailed');
      paymentError.classList.remove('hidden');
    }
  }

  async function confirmQrPayment() {
    if (!selectedQrPayment || !selectedQrPayment._id) {
      Admin.message(T('admin.checkout.noQrPending'), true);
      return;
    }
    const button = document.getElementById('confirm-qr-payment');
    const spinner = document.getElementById('confirm-qr-spinner');
    const paymentError = document.getElementById('payment-error');
    paymentError.classList.add('hidden');
    button.disabled = true;
    spinner.classList.remove('hidden');
    try {
      const payload = await Admin.api(`/api/payment/confirm-qr/${encodeURIComponent(selectedQrPayment._id)}`, { method: 'POST' });
      const receiptPaid = document.getElementById('receipt-paid');
      receiptPaid.textContent = `${T('admin.checkout.receiptPaid', { amount: Admin.currency(payload.data.amount), change: Admin.currency(0) })}`;
      receiptPaid.classList.remove('hidden');
      paymentForm.classList.add('hidden');
      document.getElementById('print-receipt').classList.remove('hidden');
      await loadSessions();
    } catch (error) {
      paymentError.textContent = error.message || T('admin.checkout.confirmQrFailed');
      paymentError.classList.remove('hidden');
      button.disabled = false;
    } finally {
      spinner.classList.add('hidden');
    }
  }

  async function processPayment(event) {
    event.preventDefault();
    if (!selectedSessionId) {
      Admin.message(T('admin.checkout.selectSession'), true);
      return;
    }
    const button = document.getElementById('confirm-payment');
    const spinner = document.getElementById('payment-spinner');
    const paymentError = document.getElementById('payment-error');
    paymentError.classList.add('hidden');
    button.disabled = true;
    spinner.classList.remove('hidden');
    try {
      const payload = await Admin.api('/api/payment/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: selectedSessionId,
          method: paymentForm.elements.method.value,
          receivedAmount: Number(document.getElementById('cash-received').value),
        }),
      });
      document.getElementById('receipt-cash').textContent = Admin.currency(payload.data.cashReceived);
      document.getElementById('receipt-change').textContent = Admin.currency(payload.data.changeDue);
      document.getElementById('receipt-cash-row').classList.remove('hidden');
      document.getElementById('receipt-change-row').classList.remove('hidden');
      const receiptPaid = document.getElementById('receipt-paid');
      receiptPaid.textContent = T('admin.checkout.receiptPaid', { amount: Admin.currency(payload.data.amount), change: Admin.currency(payload.data.changeDue) });
      receiptPaid.classList.remove('hidden');
      paymentForm.classList.add('hidden');
      document.getElementById('print-receipt').classList.remove('hidden');
      await loadSessions();
    } catch (error) {
      paymentError.textContent = error.message || T('admin.checkout.processFailed');
      paymentError.classList.remove('hidden');
      button.disabled = false;
    } finally {
      spinner.classList.add('hidden');
    }
  }

  document.getElementById('cash-received').addEventListener('input', updateCashPreview);
  document.getElementById('checkout-view-switcher').addEventListener('click', (event) => {
    const button = event.target.closest('[data-checkout-view]');
    if (!button) return;
    checkoutView = button.dataset.checkoutView;
    localStorage.setItem('checkoutView', checkoutView);
    loadSessions();
  });
  paymentForm.elements.method.addEventListener('change', setPaymentMethodView);
  paymentForm.addEventListener('submit', processPayment);
  document.getElementById('print-receipt').addEventListener('click', printReceipt);
  document.getElementById('confirm-qr-payment').addEventListener('click', confirmQrPayment);
  document.getElementById('close-payment-modal').addEventListener('click', () => paymentModal.classList.replace('flex', 'hidden'));
  paymentModal.addEventListener('click', (event) => {
    if (event.target === paymentModal) paymentModal.classList.replace('flex', 'hidden');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') paymentModal.classList.replace('flex', 'hidden');
  });
  window.setInterval(updateCountdowns, 1000);
  window.setInterval(loadSessions, 30000);
  const socket = Admin.connectSocket();
  if (socket) {
    socket.on('payment_completed', loadSessions);
    socket.on('table_waiting_for_cleaning', loadSessions);
    socket.on('queue_seated', loadSessions);
    socket.on('table_board_updated', loadSessions);
  }
  window.addEventListener('languageChanged', loadSessions);
  loadSessions();

    /**
   * Print the receipt via an off-screen iframe.
   * The iframe document carries its own @page rule, which locks paper size
   * to 80mm thermal paper without requiring the user to change print settings.
   */
  function printReceipt() {
    const source = document.querySelector('#payment-modal .receipt-print');
    if (!source) {
      Admin.message('ไม่พบข้อมูลใบเสร็จ', true);
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.append(iframe);

    const doc = iframe.contentDocument;
    doc.open();
    doc.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Receipt</title>
  <style>
    /* Lock paper size to 80mm thermal roll — user no longer needs to pick size. */
    @page { size: 80mm auto; margin: 3mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body {
      margin: 0;
      padding: 0;
      background: #fff;
      color: #000;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      font-size: 10pt;
      line-height: 1.4;
      width: 74mm;
    }
    .receipt-print { width: 74mm; }
    .receipt-print * { color: #000 !important; background: transparent !important; box-shadow: none !important; }
    .text-orange-700, .text-slate-600, .text-slate-500, .text-slate-400 { color: #000 !important; }
    .text-xs { font-size: 8pt; }
    .text-sm { font-size: 9pt; }
    .text-lg, .text-xl { font-size: 11pt; font-weight: 700; }
    .font-black, .font-bold { font-weight: 700; }
    .border-dashed, .border-t, .border-slate-100, .border-slate-300 { border-color: #666 !important; }
    .my-4 { margin: 4mm 0; }
    .mt-4, .mt-5 { margin-top: 3mm; }
    .pt-3, .pt-4 { padding-top: 2mm; }
    ul, ol { padding-left: 0; list-style: none; }
    .flex { display: flex; }
    .justify-between { justify-content: space-between; }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .hidden { display: none !important; }
  </style>
</head>
<body>${source.outerHTML}</body>
</html>`);
    doc.close();

    const cleanup = () => {
      window.setTimeout(() => {
        try { document.body.removeChild(iframe); } catch {}
      }, 300);
    };

    // Wait a moment for the iframe to layout, then print.
    iframe.onload = () => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (error) {
        console.error('Receipt iframe print failed:', error);
      } finally {
        cleanup();
      }
    };

    // Fallback in case onload doesn't fire on already-loaded iframes.
    window.setTimeout(() => {
      if (document.body.contains(iframe)) {
        try {
          iframe.contentWindow.focus();
          iframe.contentWindow.print();
        } catch {}
        cleanup();
      }
    }, 400);
  }

})();