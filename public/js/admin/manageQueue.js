// Manage queue states and print 80mm tickets with a QR that opens the queue.
(() => {
  const Admin = window.Admin;
  if (!Admin) return;
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);
  const loading = document.getElementById('queue-loading');
  const callButton = document.getElementById('call-next');
  const createEntryQrButton = document.getElementById('create-entry-qr');
  const printEntryQrButton = document.getElementById('print-entry-qr');
  const hideEntryQrButton = document.getElementById('hide-entry-qr');
  const ticketModal = document.getElementById('ticket-modal');
  const ticketPreview = document.getElementById('ticket-preview');
  const ticketPrintContent = document.getElementById('ticket-print-content');
  const ticketPrintButton = document.getElementById('ticket-modal-print');
  let queues = [];
  let currentTicketData = null;

  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function elapsed(createdAt) {
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000));
    const hours = Math.floor(minutes / 60);
    return hours ? `${hours} ${T('common.hours')} ${minutes % 60} ${T('common.minutes')}` : `${minutes} ${T('common.minutes')}`;
  }

  function remaining(endTime) {
    const seconds = Math.max(0, Math.ceil((new Date(endTime).getTime() - Date.now()) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function renderQueues() {
    const groups = {
      waiting: document.getElementById('queue-waiting'),
      called: document.getElementById('queue-called'),
      seated: document.getElementById('queue-seated'),
    };
    Object.values(groups).forEach((c) => c.replaceChildren());
    const activeQueues = queues
      .filter((queue) => Object.hasOwn(groups, queue.status))
      .sort((a, b) => {
        if (a.status !== b.status) return 0;
        if (a.status === 'seated') {
          const aEnd = a.sessionId && a.sessionId.endTime ? new Date(a.sessionId.endTime).getTime() : Number.MAX_SAFE_INTEGER;
          const bEnd = b.sessionId && b.sessionId.endTime ? new Date(b.sessionId.endTime).getTime() : Number.MAX_SAFE_INTEGER;
          return aEnd - bEnd;
        }
        return new Date(a.createdAt) - new Date(b.createdAt);
      });

    for (const queue of activeQueues) {
      const card = document.createElement('article');
      card.className = 'rounded-xl border border-slate-100 bg-slate-50 p-4';
      const tableNumber = queue.tableId && queue.tableId.tableNumber;
      const preferredTable = queue.preferredTableId && queue.preferredTableId.tableNumber;
      const preferredZone = queue.preferredZone ? T(`table.zone.${queue.preferredZone}`) : '';
      const preferenceLine = preferredTable
        ? `${T('queue.preferredZone')}: ${preferredZone} · ${preferredTable}`
        : (preferredZone ? `${T('queue.preferredZone')}: ${preferredZone}` : '');
      card.innerHTML = `
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="text-3xl font-black text-orange-700">${escapeHtml(queue.queueNumber)}</p>
            <p class="mt-1 text-sm text-slate-500">${escapeHtml(queue.customerName || T('queue.customer'))} · ${Number(queue.customerCount) || 0} ${T('common.people')}</p>
            ${preferenceLine ? `<p class="mt-1 text-sm font-semibold text-slate-700">${escapeHtml(preferenceLine)}</p>` : ''}
            ${tableNumber ? `<p class="mt-1 font-semibold">${T('queue.table')} ${escapeHtml(tableNumber)}</p>` : ''}
            ${queue.assignmentNote ? `<p class="mt-1 text-xs text-amber-700">${escapeHtml(queue.assignmentNote)}</p>` : ''}
            ${queue.status === 'called' ? `<p class="mt-1 text-sm font-bold text-blue-700">${T('queue.awaitingConfirm')}</p>` : ''}
          </div>
          ${queue.status === 'seated'
            ? `<span class="shrink-0 rounded-lg bg-white px-2 py-1 text-xs font-semibold text-orange-700" data-endtime="${escapeHtml(queue.sessionId && queue.sessionId.endTime || '')}">${queue.sessionId && queue.sessionId.endTime ? remaining(queue.sessionId.endTime) : '—'}</span>`
            : `<span class="shrink-0 rounded-lg bg-white px-2 py-1 text-xs font-semibold text-slate-500" data-waiting="${escapeHtml(queue.createdAt)}">${elapsed(queue.createdAt)}</span>`}
        </div>
        ${queue.customerPhone ? `<p class="mt-2 text-sm text-slate-500">${escapeHtml(queue.customerPhone)}</p>` : ''}
        <div class="mt-3 flex flex-wrap gap-2">
          <button type="button" data-ticket="${escapeHtml(queue._id)}" class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100">${T('queue.ticket.print')}</button>
          ${queue.status !== 'seated' ? `<button type="button" data-cancel="${escapeHtml(queue._id)}" class="rounded-lg border border-red-200 px-3 py-2 text-sm font-bold text-red-700 hover:bg-red-50">${T('queue.cancelButton')}</button>` : ''}
        </div>`;
      const cancelButton = card.querySelector('[data-cancel]');
      if (cancelButton) cancelButton.addEventListener('click', () => cancelQueue(queue._id, cancelButton));
      const ticketButton = card.querySelector('[data-ticket]');
      if (ticketButton) ticketButton.addEventListener('click', () => openTicket(queue._id, ticketButton));
      groups[queue.status].append(card);
    }
    for (const status of Object.keys(groups)) {
      const count = queues.filter((q) => q.status === status).length;
      document.getElementById(`${status}-count`).textContent = String(count);
      document.getElementById(`empty-${status}`).classList.toggle('hidden', count > 0);
    }
  }

  async function loadQueues() {
    try {
      const payload = await Admin.api('/api/queue');
      queues = Array.isArray(payload.data) ? payload.data : [];
      renderQueues();
    } catch (error) {
      Admin.message(error.message || 'Failed to load queues', true);
    } finally {
      loading.classList.add('hidden');
    }
  }

  function renderTicketHtml(data) {
    const created = new Date(data.calledAt || data.createdAt || Date.now());
    const locale = localStorage.getItem('lang') === 'en' ? 'en-US' : 'th-TH';
    const dt = created.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
    const tableLine = data.tableNumber ? `<tr><td class="text-left">${T('queue.table')}</td><td class="text-right">${escapeHtml(data.tableNumber)}</td></tr>` : '';
    const phoneAddress = [data.phone, data.address].filter(Boolean).join(' · ');
    const recoveryCode = data._id || '';
    const recoveryLabel = T('queue.recoveryCodeLabel');
    return `
      <div style="padding: 3mm 0;">
        <img src="${escapeHtml(data.logoUrl)}" alt="" onerror="this.style.display='none'" style="width:20mm;height:20mm;object-fit:contain;margin:0 auto;">
        <div style="font-size:13pt;font-weight:900;margin-top:1.5mm;">${escapeHtml(data.restaurantName || 'Restaurant')}</div>
        ${phoneAddress ? `<div style="font-size:8pt;color:#444;margin-top:0.5mm;">${escapeHtml(phoneAddress)}</div>` : ''}
      </div>
      <div style="border-top:1px dashed #999;margin:2mm 0;"></div>
      <div style="font-size:9pt;color:#333;">${dt}</div>
      <div style="border-top:1px dashed #999;margin:2mm 0;"></div>
      <div style="font-size:10pt;color:#666;">${T('queue.number')}</div>
      <div style="font-size:40pt;font-weight:900;letter-spacing:2px;line-height:1;margin:1mm 0;">${escapeHtml(data.queueNumber)}</div>
      <div style="border-top:1px dashed #999;margin:2mm 0;"></div>
      <table style="width:100%;font-size:11pt;">
        <tr><td class="text-left">${T('queue.partySize')}</td><td class="text-right">${Number(data.customerCount) || 0}</td></tr>
        ${tableLine}
      </table>
      <div style="border-top:1px dashed #999;margin:2mm 0;"></div>
      <div style="text-align:left;font-size:8pt;color:#666;">${escapeHtml(recoveryLabel)}</div>
      <div style="text-align:center;font-size:9pt;font-weight:700;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0.4px;margin-top:0.5mm;word-break:break-all;">${escapeHtml(recoveryCode)}</div>
      <div style="border-top:1px dashed #999;margin:2mm 0;"></div>
      <div>
        <img src="${escapeHtml(data.qrCodeData)}" alt="QR" style="width:42mm;height:42mm;margin:0 auto;">
      </div>
      <div style="font-size:9pt;margin-top:1mm;">${T('queue.staffQrDescription').split('.')[0]}</div>
      <div style="border-top:1px dashed #999;margin:2mm 0;"></div>
      <div style="font-size:8pt;color:#555;line-height:1.5;">
        * ${T('queue.ticket.hint')}<br>
      </div>`;
  }

  async function openTicket(queueId, button) {
    if (button) button.disabled = true;
    try {
      const payload = await Admin.api(`/api/queue/${encodeURIComponent(queueId)}/ticket`);
      currentTicketData = payload.data;
      const html = renderTicketHtml(currentTicketData);
      ticketPreview.innerHTML = html;
      ticketPrintContent.innerHTML = html;
      ticketModal.classList.replace('hidden', 'flex');
    } catch (error) {
      Admin.message(error.message || 'Failed to load ticket', true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function closeTicket() {
    ticketModal.classList.replace('flex', 'hidden');
    currentTicketData = null;
  }

  function printTicket() {
    if (!currentTicketData) return;

    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.append(iframe);

    const innerHtml = renderTicketHtml(currentTicketData);
    const doc = iframe.contentDocument;
    doc.open();
    doc.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Queue Ticket</title>
  <style>
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
    .text-left { text-align: left; }
    .text-right { text-align: right; }
    img { max-width: 100%; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 1mm 0; }
  </style>
</head>
<body>${innerHtml}</body>
</html>`);
    doc.close();

    iframe.onload = () => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (error) {
        console.error('Ticket iframe print failed:', error);
      } finally {
        window.setTimeout(() => {
          try { document.body.removeChild(iframe); } catch {}
        }, 300);
      }
    };
  }

  async function callNextQueue() {
    callButton.disabled = true;
    try {
      const payload = await Admin.api('/api/queue/call', { method: 'POST' });
      const note = payload.data.assignmentNote ? ` (${payload.data.assignmentNote})` : '';
      Admin.message(T('queue.callResult', { queue: payload.data.queue.queueNumber, table: payload.data.table.tableNumber }) + note);
      await loadQueues();
      openTicket(payload.data.queue._id);
    } catch (error) {
      Admin.message(error.message || 'Failed to call next queue', true);
    } finally {
      callButton.disabled = false;
    }
  }

  async function cancelQueue(queueId, button) {
    const ok = await Admin.confirm(T('queue.cancelModalDesc'), {
      title: T('queue.cancelModalTitle'),
      okText: T('queue.cancelConfirm'),
      cancelText: T('queue.cancelGoback'),
      danger: true,
    });
    if (!ok) return;
    button.disabled = true;
    try {
      await Admin.api(`/api/queue/cancel/${encodeURIComponent(queueId)}`, { method: 'POST' });
      Admin.message(T('queue.status.cancelled'));
      await loadQueues();
    } catch (error) {
      Admin.message(error.message || 'Failed to cancel queue', true);
      button.disabled = false;
    }
  }

  async function createEntryQr() {
    createEntryQrButton.disabled = true;
    createEntryQrButton.textContent = T('queue.staffQrCreating');
    try {
      const payload = await Admin.api('/api/queue/entry-qr');
      const image = document.getElementById('queue-entry-qr');
      image.src = payload.data.qrCodeData;
      image.classList.remove('hidden');
      document.getElementById('queue-entry-url').textContent = payload.data.queueUrl;
      printEntryQrButton.classList.remove('hidden');
      hideEntryQrButton.classList.remove('hidden');
      Admin.message(T('queue.staffQrReady'));
    } catch (error) {
      Admin.message(error.message || 'Failed to create QR', true);
    } finally {
      createEntryQrButton.disabled = false;
      createEntryQrButton.textContent = T('queue.staffQrCreate');
    }
  }

  callButton.addEventListener('click', callNextQueue);
  createEntryQrButton.addEventListener('click', createEntryQr);
  printEntryQrButton.addEventListener('click', () => {
    document.body.classList.add('print-entry-qr');
    window.print();
    window.setTimeout(() => document.body.classList.remove('print-entry-qr'), 200);
  });
  hideEntryQrButton.addEventListener('click', () => {
    document.getElementById('queue-entry-qr').classList.add('hidden');
    document.getElementById('queue-entry-qr').removeAttribute('src');
    document.getElementById('queue-entry-url').textContent = '';
    printEntryQrButton.classList.add('hidden');
    hideEntryQrButton.classList.add('hidden');
    Admin.message(T('queue.staffQrHidden'));
  });

  document.getElementById('ticket-modal-close').addEventListener('click', closeTicket);
  document.getElementById('ticket-modal-cancel').addEventListener('click', closeTicket);
  ticketPrintButton.addEventListener('click', printTicket);
  ticketModal.addEventListener('click', (event) => {
    if (event.target === ticketModal) closeTicket();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !ticketModal.classList.contains('hidden')) closeTicket();
  });

  const socket = Admin.connectSocket();
  if (socket) {
    socket.on('connect', loadQueues);
    socket.on('new_queue', loadQueues);
    socket.on('queue_called', loadQueues);
    socket.on('queue_seated', loadQueues);
    socket.on('queue_board_updated', loadQueues);
  }
  window.setInterval(() => {
    document.querySelectorAll('[data-waiting]').forEach((el) => {
      el.textContent = elapsed(el.dataset.waiting);
    });
    document.querySelectorAll('[data-endtime]').forEach((el) => {
      if (el.dataset.endtime) el.textContent = remaining(el.dataset.endtime);
    });
    loadQueues();
  }, 30000);

  window.addEventListener('languageChanged', () => {
    renderQueues();
    callButton.textContent = T('queue.manage.callNext');
    createEntryQrButton.textContent = T('queue.staffQrCreate');
    printEntryQrButton.textContent = T('queue.staffQrPrint');
    hideEntryQrButton.textContent = T('queue.staffQrHide');
  });

  loadQueues();
})();