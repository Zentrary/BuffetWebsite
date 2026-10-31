// Admin UI controller for SQL-backed Membership, Loyalty Points & Promotions.
(() => {
  const Admin = window.Admin;
  if (!Admin) return;

  const loadingEl = document.getElementById('loyalty-loading');
  const memberRows = document.getElementById('member-rows');
  const promoRows = document.getElementById('promo-rows');
  const txRows = document.getElementById('tx-rows');
  const tierCards = document.getElementById('tier-cards');

  const memberModal = document.getElementById('member-modal');
  const memberForm = document.getElementById('member-form');
  const promoModal = document.getElementById('promo-modal');
  const promoForm = document.getElementById('promo-form');
  const pointsModal = document.getElementById('points-modal');
  const pointsAdjustForm = document.getElementById('points-adjust-form');
  const ssmsModal = document.getElementById('ssms-guide-modal');

  let currentTab = localStorage.getItem('loyaltyAdminTab') || 'members';
  let cachedMembers = [];
  let cachedPromos = [];
  let latestSqlStatus = null;

  function currentLocale() {
    return localStorage.getItem('lang') === 'en' ? 'en-US' : 'th-TH';
  }

  function formatInt(n) {
    return new Intl.NumberFormat('en-US').format(Number(n) || 0);
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString(currentLocale());
  }

  function tierBadgeHTML(tierCode, tierName, discountPercent) {
    const styles = {
      VIP: 'bg-purple-100 text-purple-800 border-purple-200',
      GOLD: 'bg-amber-100 text-amber-900 border-amber-300',
      SILVER: 'bg-slate-200 text-slate-800 border-slate-300',
      MEMBER: 'bg-orange-50 text-orange-800 border-orange-200',
    };
    const cls = styles[tierCode] || styles.MEMBER;
    const pct = Number(discountPercent) > 0 ? ` · ลด ${Number(discountPercent)}%` : '';
    return `<span class="inline-flex items-center rounded-lg border px-2.5 py-1 text-xs font-bold ${cls}">${Admin.escapeHTML(tierName || tierCode)}${Admin.escapeHTML(pct)}</span>`;
  }

  function txTypeBadgeHTML(type) {
    const map = {
      EARN: ['รับแต้ม', 'bg-green-100 text-green-800'],
      REDEEM: ['แลกคูปอง', 'bg-orange-100 text-orange-800'],
      BONUS: ['แต้มพิเศษ', 'bg-blue-100 text-blue-800'],
      ADJUST: ['ปรับแต้ม', 'bg-slate-200 text-slate-800'],
      REFUND: ['คืนแต้ม', 'bg-purple-100 text-purple-800'],
    };
    const [label, cls] = map[type] || [type, 'bg-slate-100 text-slate-700'];
    return `<span class="inline-block rounded-lg px-2.5 py-1 text-xs font-bold ${cls}">${Admin.escapeHTML(label)}</span>`;
  }

  function renderSqlStatus(status) {
    latestSqlStatus = status;
    const dot = document.getElementById('sql-status-dot');
    const text = document.getElementById('sql-status-text');
    const badge = document.getElementById('sql-status-badge');
    const box = document.getElementById('ssms-current-status-box');

    if (!status) return;

    if (status.mode === 'mssql' && status.connected) {
      dot.className = 'h-2.5 w-2.5 rounded-full bg-green-600';
      badge.className = 'inline-flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-3.5 py-2.5 text-xs font-bold text-green-900 shadow-sm transition hover:bg-green-100';
      text.textContent = `SQL Server (SSMS): ${status.database} @ ${status.server}`;
      box.innerHTML = `<p class="font-bold text-green-800">เชื่อมต่อ Microsoft SQL Server (SSMS) สำเร็จแล้ว</p>
        <p class="mt-1 text-slate-600">เซิร์ฟเวอร์: <code>${Admin.escapeHTML(status.server)}</code> · ฐานข้อมูล: <code>${Admin.escapeHTML(status.database)}</code></p>`;
    } else if (status.mode === 'mssql_error') {
      dot.className = 'h-2.5 w-2.5 rounded-full bg-red-600';
      badge.className = 'inline-flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-bold text-red-900 shadow-sm transition hover:bg-red-100';
      text.textContent = `เชื่อมต่อ SSMS ไม่สำเร็จ (${status.server})`;
      box.innerHTML = `<p class="font-bold text-red-800">เชื่อมต่อ SQL Server ไม่สำเร็จ</p>
        <p class="mt-1 text-red-700">${Admin.escapeHTML(status.error || 'Unknown error')}</p>`;
    } else {
      dot.className = 'h-2.5 w-2.5 rounded-full bg-amber-500';
      badge.className = 'inline-flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs font-bold text-amber-900 shadow-sm transition hover:bg-amber-100';
      text.textContent = 'SQL Demo Mode (คลิกดูวิธีเชื่อม SSMS)';
      box.innerHTML = `<p class="font-bold text-amber-900">ขณะนี้ทำงานด้วย Local SQL Engine อัตโนมัติ</p>
        <p class="mt-1 text-slate-600">ระบบกำลังรันคำสั่ง SQL จริงในเครื่อง หากต้องการให้ข้อมูลบันทึกลงโปรแกรม <strong>SQL Server Management Studio (SSMS)</strong> ให้ทำตาม 3 ขั้นตอนด้านล่าง</p>`;
    }
  }

  function switchTab(tab) {
    currentTab = ['members', 'promos', 'logs'].includes(tab) ? tab : 'members';
    localStorage.setItem('loyaltyAdminTab', currentTab);

    document.querySelectorAll('#loyalty-tabs [data-tab]').forEach((btn) => {
      const active = btn.dataset.tab === currentTab;
      btn.setAttribute('aria-selected', String(active));
      btn.className = active
        ? 'rounded-lg bg-orange-600 px-4 py-2.5 text-sm font-bold text-white'
        : 'rounded-lg px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-100';
    });

    document.getElementById('panel-members').classList.toggle('hidden', currentTab !== 'members');
    document.getElementById('panel-promos').classList.toggle('hidden', currentTab !== 'promos');
    document.getElementById('panel-logs').classList.toggle('hidden', currentTab !== 'logs');
  }

  function renderOverview(data) {
    renderSqlStatus(data.sqlStatus);
    const s = data.summary || {};
    const tiers = Array.isArray(data.tiers) ? data.tiers : [];

    document.getElementById('kpi-total-members').textContent = `${formatInt(s.totalMembers)} คน`;
    document.getElementById('kpi-tier-breakdown').textContent = tiers
      .map((t) => `${t.tierName}: ${formatInt(t.memberCount)}`)
      .join(' · ') || '—';

    document.getElementById('kpi-points-pool').textContent = `${formatInt(s.totalCurrentPoints)} แต้ม`;
    document.getElementById('kpi-points-issued').textContent = `แจกสะสมทั้งหมด ${formatInt(s.totalPointsIssued)} แต้ม`;

    document.getElementById('kpi-active-promos').textContent = `${formatInt(s.activePromotions)} / ${formatInt(s.totalPromotions)}`;
    document.getElementById('kpi-redemptions').textContent = `ถูกแลกใช้งานแล้ว ${formatInt(s.totalRedemptions)} ครั้ง`;

    document.getElementById('kpi-total-saved').textContent = Admin.currency(s.totalDiscountSaved);
    document.getElementById('kpi-member-spend').textContent = `ยอดใช้จ่ายสมาชิกรวม ${Admin.currency(s.totalMemberSpend)}`;

    tierCards.replaceChildren();
    for (const tier of tiers) {
      const card = document.createElement('article');
      card.className = 'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm';
      card.innerHTML = `
        <div class="flex items-center justify-between gap-2">
          ${tierBadgeHTML(tier.tierCode, tier.tierName, tier.discountPercent)}
          <span class="text-xs font-bold text-slate-500">${formatInt(tier.memberCount)} คน</span>
        </div>
        <dl class="mt-3 space-y-1 text-xs text-slate-600">
          <div class="flex justify-between"><dt>แต้มสะสมขั้นต่ำ:</dt><dd class="font-bold text-slate-900">${formatInt(tier.minPoints)} แต้ม</dd></div>
          <div class="flex justify-between"><dt>ส่วนลดประจำบัตร:</dt><dd class="font-bold text-orange-700">${tier.discountPercent}%</dd></div>
          <div class="flex justify-between"><dt>ตัวคูณรับแต้ม:</dt><dd class="font-bold text-slate-900">×${Number(tier.pointsMultiplier).toFixed(2)}</dd></div>
        </dl>`;
      tierCards.append(card);
    }
  }

  function renderMembers(members) {
    cachedMembers = members;
    memberRows.replaceChildren();
    document.getElementById('members-empty').classList.toggle('hidden', members.length > 0);

    for (const m of members) {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-50/80';
      tr.innerHTML = `
        <td class="p-4 font-mono text-xs font-bold text-slate-600">${Admin.escapeHTML(m.memberCode)}</td>
        <td class="p-4">
          <p class="font-bold text-slate-900">${Admin.escapeHTML(m.fullName)}</p>
          <p class="text-xs text-slate-500">${Admin.escapeHTML(m.phone)}${m.email ? ` · ${Admin.escapeHTML(m.email)}` : ''}</p>
        </td>
        <td class="p-4">${tierBadgeHTML(m.tierCode, m.tierName, m.discountPercent)}</td>
        <td class="p-4 text-right">
          <p class="font-black text-orange-700">${formatInt(m.currentPoints)} แต้ม</p>
          <p class="text-xs text-slate-400">สะสมรวม ${formatInt(m.lifetimePoints)}</p>
        </td>
        <td class="p-4 text-right">
          <p class="font-bold text-slate-800">${Admin.currency(m.totalSpent)}</p>
          <p class="text-xs text-slate-400">${formatInt(m.visitCount)} ครั้ง</p>
        </td>
        <td class="p-4">
          <span class="inline-block rounded-lg px-2.5 py-1 text-xs font-bold ${m.isActive ? 'bg-green-100 text-green-800' : 'bg-slate-200 text-slate-600'}">
            ${m.isActive ? 'ใช้งานปกติ' : 'ระงับ'}
          </span>
        </td>
        <td class="p-4 text-right">
          <div class="inline-flex flex-wrap justify-end gap-1.5">
            <button type="button" data-points-member="${m.memberId}" class="rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-bold text-orange-800 hover:bg-orange-100">
              แต้ม/ประวัติ
            </button>
            <button type="button" data-edit-member="${m.memberId}" class="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50">
              แก้ไข
            </button>
            <button type="button" data-delete-member="${m.memberId}" class="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-bold text-red-700 hover:bg-red-50">
              ลบ
            </button>
          </div>
        </td>`;
      memberRows.append(tr);
    }
  }

  function renderPromotions(promos) {
    cachedPromos = promos;
    promoRows.replaceChildren();
    document.getElementById('promos-empty').classList.toggle('hidden', promos.length > 0);

    for (const p of promos) {
      const discountLabel = p.discountType === 'PERCENT'
        ? `ลด ${p.discountValue}%${p.maxDiscount ? ` (สูงสุด ${Admin.currency(p.maxDiscount)})` : ''}`
        : `ลด ${Admin.currency(p.discountValue)}`;
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-50/80';
      tr.innerHTML = `
        <td class="p-4">
          <span class="rounded-lg bg-slate-900 px-2.5 py-1 font-mono text-xs font-bold text-white">${Admin.escapeHTML(p.promoCode)}</span>
        </td>
        <td class="p-4">
          <p class="font-bold text-slate-900">${Admin.escapeHTML(p.title)}</p>
          ${p.description ? `<p class="mt-0.5 text-xs text-slate-500">${Admin.escapeHTML(p.description)}</p>` : ''}
        </td>
        <td class="p-4 font-bold text-orange-700">${Admin.escapeHTML(discountLabel)}</td>
        <td class="p-4 text-right font-bold">${p.pointsCost > 0 ? `${formatInt(p.pointsCost)} แต้ม` : '<span class="text-emerald-700">ฟรี (0 แต้ม)</span>'}</td>
        <td class="p-4 text-right text-slate-600">${p.minSpend > 0 ? Admin.currency(p.minSpend) : 'ไม่มีขั้นต่ำ'}</td>
        <td class="p-4 text-right">
          <p class="font-bold">${formatInt(p.usageCount)} ครั้ง</p>
          <p class="text-xs text-slate-400">${Admin.currency(p.totalDiscountGiven)}</p>
        </td>
        <td class="p-4">
          <span class="inline-block rounded-lg px-2.5 py-1 text-xs font-bold ${p.isActive ? 'bg-green-100 text-green-800' : 'bg-slate-200 text-slate-600'}">
            ${p.isActive ? 'เปิดใช้' : 'ปิด'}
          </span>
        </td>
        <td class="p-4 text-right">
          <div class="inline-flex flex-wrap justify-end gap-1.5">
            <button type="button" data-edit-promo="${p.promotionId}" class="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50">
              แก้ไข
            </button>
            <button type="button" data-delete-promo="${p.promotionId}" class="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-bold text-red-700 hover:bg-red-50">
              ลบ
            </button>
          </div>
        </td>`;
      promoRows.append(tr);
    }
  }

  function renderTransactions(transactions) {
    txRows.replaceChildren();
    document.getElementById('logs-empty').classList.toggle('hidden', transactions.length > 0);

    for (const tx of transactions) {
      const deltaText = tx.pointsDelta > 0 ? `+${formatInt(tx.pointsDelta)}` : formatInt(tx.pointsDelta);
      const deltaClass = tx.pointsDelta > 0 ? 'text-green-700' : (tx.pointsDelta < 0 ? 'text-red-700' : 'text-slate-600');
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="p-4 text-xs text-slate-500">${Admin.escapeHTML(formatDateTime(tx.createdAt))}</td>
        <td class="p-4">
          <p class="font-bold text-slate-900">${Admin.escapeHTML(tx.memberName)}</p>
          <p class="text-xs text-slate-500">${Admin.escapeHTML(tx.memberCode)} · ${Admin.escapeHTML(tx.memberPhone)}</p>
        </td>
        <td class="p-4">${txTypeBadgeHTML(tx.transactionType)}</td>
        <td class="p-4 text-right font-black ${deltaClass}">${Admin.escapeHTML(String(deltaText))}</td>
        <td class="p-4 text-right font-semibold">${tx.discountAmount > 0 ? `-${Admin.currency(tx.discountAmount)}` : '—'}</td>
        <td class="p-4 text-xs text-slate-600">
          ${tx.promoCode ? `<span class="mr-1 rounded bg-slate-200 px-1.5 py-0.5 font-mono font-bold text-slate-800">${Admin.escapeHTML(tx.promoCode)}</span>` : ''}
          ${Admin.escapeHTML(tx.note || '—')}
        </td>
        <td class="p-4 text-xs font-semibold text-slate-600">${Admin.escapeHTML(tx.createdBy || '—')}</td>`;
      txRows.append(tr);
    }
  }

  async function loadAllData() {
    const search = document.getElementById('member-search-input').value.trim();
    const tierCode = document.getElementById('member-tier-filter').value;
    const memberQuery = new URLSearchParams();
    if (search) memberQuery.set('search', search);
    if (tierCode) memberQuery.set('tierCode', tierCode);

    try {
      const [overviewRes, membersRes, promosRes, txRes] = await Promise.all([
        Admin.api('/api/members/overview'),
        Admin.api(`/api/members?${memberQuery.toString()}`),
        Admin.api('/api/members/promotions'),
        Admin.api('/api/members/transactions?limit=50'),
      ]);
      renderOverview(overviewRes.data || {});
      renderMembers(Array.isArray(membersRes.data) ? membersRes.data : []);
      renderPromotions(Array.isArray(promosRes.data) ? promosRes.data : []);
      renderTransactions(Array.isArray(txRes.data) ? txRes.data : []);
    } catch (error) {
      Admin.message(error.message || 'ไม่สามารถโหลดข้อมูลระบบสมาชิก SQL ได้', true);
      try {
        const statusRes = await Admin.api('/api/members/status');
        renderSqlStatus(statusRes.data);
      } catch {}
    } finally {
      loadingEl.classList.add('hidden');
    }
  }

  function openMemberModal(member = null) {
    memberForm.reset();
    memberForm.elements.memberId.value = member ? member.memberId : '';
    document.getElementById('member-modal-title').textContent = member ? 'แก้ไขข้อมูลสมาชิก' : 'สมัครสมาชิกใหม่';
    document.getElementById('member-initial-points-wrap').classList.toggle('hidden', Boolean(member));
    const statusWrap = document.getElementById('member-status-wrap');
    statusWrap.classList.toggle('hidden', !member);
    statusWrap.classList.toggle('flex', Boolean(member));

    if (member) {
      memberForm.elements.fullName.value = member.fullName || '';
      memberForm.elements.phone.value = member.phone || '';
      memberForm.elements.email.value = member.email || '';
      memberForm.elements.isActive.checked = Boolean(member.isActive);
    }
    memberModal.classList.replace('hidden', 'flex');
  }

  function closeMemberModal() {
    memberModal.classList.replace('flex', 'hidden');
  }

  function openPromoModal(promo = null) {
    promoForm.reset();
    promoForm.elements.promotionId.value = promo ? promo.promotionId : '';
    document.getElementById('promo-modal-title').textContent = promo ? 'แก้ไขคูปองโปรโมชัน' : 'เพิ่มคูปองโปรโมชัน';
    promoForm.elements.isActive.checked = promo ? Boolean(promo.isActive) : true;

    if (promo) {
      promoForm.elements.promoCode.value = promo.promoCode || '';
      promoForm.elements.pointsCost.value = promo.pointsCost ?? 0;
      promoForm.elements.title.value = promo.title || '';
      promoForm.elements.description.value = promo.description || '';
      promoForm.elements.discountType.value = promo.discountType || 'FIXED';
      promoForm.elements.discountValue.value = promo.discountValue ?? '';
      promoForm.elements.minSpend.value = promo.minSpend ?? 0;
      promoForm.elements.maxDiscount.value = promo.maxDiscount ?? '';
    }
    promoModal.classList.replace('hidden', 'flex');
  }

  function closePromoModal() {
    promoModal.classList.replace('flex', 'hidden');
  }

  async function openPointsModal(member) {
    pointsAdjustForm.reset();
    pointsAdjustForm.elements.memberId.value = member.memberId;
    document.getElementById('points-modal-code').textContent = `${member.memberCode} · ${member.tierName}`;
    document.getElementById('points-modal-name').textContent = member.fullName;
    document.getElementById('points-modal-meta').textContent = `เบอร์ ${member.phone} · แต้มคงเหลือ ${formatInt(member.currentPoints)} แต้ม (สะสมตลอดชีพ ${formatInt(member.lifetimePoints)} แต้ม)`;

    const tbody = document.getElementById('member-tx-rows');
    tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-slate-400">กำลังโหลด...</td></tr>';
    pointsModal.classList.replace('hidden', 'flex');

    try {
      const res = await Admin.api(`/api/members/transactions?memberId=${encodeURIComponent(member.memberId)}&limit=30`);
      const list = Array.isArray(res.data) ? res.data : [];
      tbody.replaceChildren();
      if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-slate-400">ยังไม่มีประวัติแต้ม</td></tr>';
        return;
      }
      for (const tx of list) {
        const deltaText = tx.pointsDelta > 0 ? `+${formatInt(tx.pointsDelta)}` : formatInt(tx.pointsDelta);
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="p-3 text-slate-500">${Admin.escapeHTML(formatDateTime(tx.createdAt))}</td>
          <td class="p-3">${txTypeBadgeHTML(tx.transactionType)}</td>
          <td class="p-3 text-right font-bold ${tx.pointsDelta >= 0 ? 'text-green-700' : 'text-red-700'}">${Admin.escapeHTML(String(deltaText))}</td>
          <td class="p-3 text-right">${tx.discountAmount > 0 ? `-${Admin.currency(tx.discountAmount)}` : '—'}</td>
          <td class="p-3 text-slate-600">${Admin.escapeHTML(tx.note || '—')}</td>`;
        tbody.append(tr);
      }
    } catch (error) {
      tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-red-700">${Admin.escapeHTML(error.message)}</td></tr>`;
    }
  }

  function closePointsModal() {
    pointsModal.classList.replace('flex', 'hidden');
  }

  // Event bindings
  document.getElementById('loyalty-tabs').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-tab]');
    if (btn) switchTab(btn.dataset.tab);
  });

  document.getElementById('add-member-button').addEventListener('click', () => openMemberModal(null));
  document.getElementById('add-promo-button').addEventListener('click', () => openPromoModal(null));

  document.querySelector('[data-close-member-modal]').addEventListener('click', closeMemberModal);
  document.querySelector('[data-close-promo-modal]').addEventListener('click', closePromoModal);
  document.querySelector('[data-close-points-modal]').addEventListener('click', closePointsModal);

  const openGuide = () => ssmsModal.classList.replace('hidden', 'flex');
  const closeGuide = () => ssmsModal.classList.replace('flex', 'hidden');
  document.getElementById('open-ssms-guide').addEventListener('click', openGuide);
  document.getElementById('sql-status-badge').addEventListener('click', openGuide);
  document.querySelector('[data-close-ssms-modal]').addEventListener('click', closeGuide);

  [memberModal, promoModal, pointsModal, ssmsModal].forEach((modal) => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.replace('flex', 'hidden');
    });
  });

  document.getElementById('member-filter-form').addEventListener('submit', (event) => {
    event.preventDefault();
    loadAllData();
  });

  document.getElementById('member-reset-btn').addEventListener('click', () => {
    document.getElementById('member-search-input').value = '';
    document.getElementById('member-tier-filter').value = '';
    loadAllData();
  });

  memberForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = memberForm.elements.memberId.value;
    const payload = {
      fullName: memberForm.elements.fullName.value.trim(),
      phone: memberForm.elements.phone.value.trim(),
      email: memberForm.elements.email.value.trim(),
    };
    if (id) {
      payload.isActive = memberForm.elements.isActive.checked;
    } else {
      payload.initialPoints = Number(memberForm.elements.initialPoints.value) || 0;
    }

    try {
      const res = await Admin.api(id ? `/api/members/${encodeURIComponent(id)}` : '/api/members', {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      closeMemberModal();
      Admin.message(res.message || 'บันทึกข้อมูลสมาชิกสำเร็จ');
      await loadAllData();
    } catch (error) {
      Admin.message(error.message || 'บันทึกข้อมูลสมาชิกไม่สำเร็จ', true);
    }
  });

  promoForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = promoForm.elements.promotionId.value;
    const maxVal = promoForm.elements.maxDiscount.value.trim();
    const payload = {
      promoCode: promoForm.elements.promoCode.value.trim().toUpperCase(),
      pointsCost: Number(promoForm.elements.pointsCost.value) || 0,
      title: promoForm.elements.title.value.trim(),
      description: promoForm.elements.description.value.trim(),
      discountType: promoForm.elements.discountType.value,
      discountValue: Number(promoForm.elements.discountValue.value),
      minSpend: Number(promoForm.elements.minSpend.value) || 0,
      maxDiscount: maxVal === '' ? null : Number(maxVal),
      isActive: promoForm.elements.isActive.checked,
    };

    try {
      const res = await Admin.api(id ? `/api/members/promotions/${encodeURIComponent(id)}` : '/api/members/promotions', {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      closePromoModal();
      switchTab('promos');
      Admin.message(res.message || 'บันทึกคูปองโปรโมชันสำเร็จ');
      await loadAllData();
    } catch (error) {
      Admin.message(error.message || 'บันทึกคูปองโปรโมชันไม่สำเร็จ', true);
    }
  });

  pointsAdjustForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const memberId = pointsAdjustForm.elements.memberId.value;
    const pointsDelta = Number.parseInt(pointsAdjustForm.elements.pointsDelta.value, 10);
    const note = pointsAdjustForm.elements.note.value.trim();

    try {
      const res = await Admin.api(`/api/members/${encodeURIComponent(memberId)}/points`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pointsDelta, note }),
      });
      Admin.message(res.message || 'ปรับปรุงแต้มสำเร็จ');
      await loadAllData();
      if (res.data) {
        await openPointsModal(res.data);
      }
    } catch (error) {
      Admin.message(error.message || 'ปรับปรุงแต้มไม่สำเร็จ', true);
    }
  });

  memberRows.addEventListener('click', async (event) => {
    const pointsBtn = event.target.closest('[data-points-member]');
    if (pointsBtn) {
      const m = cachedMembers.find((item) => String(item.memberId) === pointsBtn.dataset.pointsMember);
      if (m) openPointsModal(m);
      return;
    }

    const editBtn = event.target.closest('[data-edit-member]');
    if (editBtn) {
      const m = cachedMembers.find((item) => String(item.memberId) === editBtn.dataset.editMember);
      if (m) openMemberModal(m);
      return;
    }

    const delBtn = event.target.closest('[data-delete-member]');
    if (delBtn) {
      const m = cachedMembers.find((item) => String(item.memberId) === delBtn.dataset.deleteMember);
      if (!m) return;
      const ok = await Admin.confirm(`ต้องการลบสมาชิก "${m.fullName}" (${m.phone}) ออกจากฐานข้อมูล SQL ใช่หรือไม่?`, {
        title: 'ยืนยันลบสมาชิก',
        okText: 'ลบสมาชิก',
        danger: true,
      });
      if (!ok) return;
      try {
        await Admin.api(`/api/members/${encodeURIComponent(m.memberId)}`, { method: 'DELETE' });
        Admin.message('ลบข้อมูลสมาชิกสำเร็จ');
        await loadAllData();
      } catch (error) {
        Admin.message(error.message || 'ลบสมาชิกไม่สำเร็จ', true);
      }
    }
  });

  promoRows.addEventListener('click', async (event) => {
    const editBtn = event.target.closest('[data-edit-promo]');
    if (editBtn) {
      const p = cachedPromos.find((item) => String(item.promotionId) === editBtn.dataset.editPromo);
      if (p) openPromoModal(p);
      return;
    }

    const delBtn = event.target.closest('[data-delete-promo]');
    if (delBtn) {
      const p = cachedPromos.find((item) => String(item.promotionId) === delBtn.dataset.deletePromo);
      if (!p) return;
      const ok = await Admin.confirm(`ต้องการลบคูปอง "${p.promoCode} - ${p.title}" ออกจากฐานข้อมูล SQL ใช่หรือไม่?`, {
        title: 'ยืนยันลบคูปองโปรโมชัน',
        okText: 'ลบคูปอง',
        danger: true,
      });
      if (!ok) return;
      try {
        await Admin.api(`/api/members/promotions/${encodeURIComponent(p.promotionId)}`, { method: 'DELETE' });
        Admin.message('ลบคูปองโปรโมชันสำเร็จ');
        await loadAllData();
      } catch (error) {
        Admin.message(error.message || 'ลบคูปองโปรโมชันไม่สำเร็จ', true);
      }
    }
  });

  switchTab(currentTab);
  window.addEventListener('languageChanged', () => {
    if (latestSqlStatus) renderSqlStatus(latestSqlStatus);
    loadAllData();
  });
  loadAllData();
})();
