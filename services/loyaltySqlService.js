// SQL-backed business logic for Membership Tiers, Members, Promotions, and Point Transactions.
// All data operations execute real parameterized SQL queries against SQL Server (SSMS)
// (or the local SQL fallback engine when SQL_SERVER is not set).

const { querySql, insertSql, getSqlStatus } = require('../config/sqlDb');

const roundMoney = (val) => Math.round(((Number(val) || 0) + Number.EPSILON) * 100) / 100;

function createAppError(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function normalizePhone(rawPhone) {
  const digits = String(rawPhone || '').replace(/[^\d]/g, '');
  if (!/^\d{9,15}$/.test(digits)) {
    throw createAppError('INVALID_MEMBER_PHONE', 'กรุณากรอกเบอร์โทรศัพท์เป็นตัวเลข 9–15 หลัก');
  }
  return digits;
}

function normalizeMemberRow(row) {
  if (!row) return null;
  return {
    memberId: Number(row.MemberId),
    memberCode: row.MemberCode,
    fullName: row.FullName,
    phone: row.Phone,
    email: row.Email || '',
    currentPoints: Number(row.CurrentPoints) || 0,
    lifetimePoints: Number(row.LifetimePoints) || 0,
    totalSpent: roundMoney(row.TotalSpent),
    visitCount: Number(row.VisitCount) || 0,
    isActive: Boolean(row.IsActive),
    createdAt: row.CreatedAt,
    tierId: Number(row.TierId),
    tierCode: row.TierCode,
    tierName: row.TierName,
    discountPercent: roundMoney(row.DiscountPercent),
    pointsMultiplier: Number(row.PointsMultiplier) || 1,
    totalTransactions: Number(row.TotalTransactions) || 0,
    totalDiscountSaved: roundMoney(row.TotalDiscountSaved),
  };
}

function normalizePromotionRow(row) {
  if (!row) return null;
  return {
    promotionId: Number(row.PromotionId),
    promoCode: row.PromoCode,
    title: row.Title,
    description: row.Description || '',
    discountType: row.DiscountType,
    discountValue: roundMoney(row.DiscountValue),
    pointsCost: Number(row.PointsCost) || 0,
    minSpend: roundMoney(row.MinSpend),
    maxDiscount: row.MaxDiscount !== null && row.MaxDiscount !== undefined ? roundMoney(row.MaxDiscount) : null,
    isActive: Boolean(row.IsActive),
    createdAt: row.CreatedAt,
    usageCount: Number(row.UsageCount) || 0,
    totalDiscountGiven: roundMoney(row.TotalDiscountGiven),
  };
}

function normalizeTransactionRow(row) {
  if (!row) return null;
  return {
    transactionId: Number(row.TransactionId),
    memberId: Number(row.MemberId),
    memberCode: row.MemberCode || '',
    memberName: row.FullName || '',
    memberPhone: row.Phone || '',
    promotionId: row.PromotionId !== null && row.PromotionId !== undefined ? Number(row.PromotionId) : null,
    promoCode: row.PromoCode || '',
    promoTitle: row.PromoTitle || '',
    sessionRef: row.SessionRef || '',
    transactionType: row.TransactionType,
    pointsDelta: Number(row.PointsDelta) || 0,
    discountAmount: roundMoney(row.DiscountAmount),
    billAmount: roundMoney(row.BillAmount),
    note: row.Note || '',
    createdBy: row.CreatedBy || '',
    createdAt: row.CreatedAt,
  };
}

function calculateEarnedPoints(netPaidAmount, pointsMultiplier = 1) {
  const paid = Math.max(0, Number(netPaidAmount) || 0);
  const multiplier = Math.max(1, Number(pointsMultiplier) || 1);
  // Base rate: 1 point per 100 THB paid, multiplied by member tier multiplier.
  return Math.floor((paid / 100) * multiplier);
}

function computePromoDiscountAmount(promo, subtotal) {
  const safeSubtotal = Math.max(0, roundMoney(subtotal));
  if (safeSubtotal <= 0) return 0;
  let discount = 0;
  if (promo.discountType === 'PERCENT') {
    discount = roundMoney((safeSubtotal * promo.discountValue) / 100);
    if (promo.maxDiscount !== null && promo.maxDiscount > 0) {
      discount = Math.min(discount, promo.maxDiscount);
    }
  } else {
    discount = roundMoney(promo.discountValue);
  }
  return Math.min(discount, safeSubtotal);
}

async function resolveTierForPoints(lifetimePoints) {
  const pts = Math.max(0, Math.floor(Number(lifetimePoints) || 0));
  const { rows } = await querySql(
    `SELECT TierId, TierCode, TierName, MinPoints, DiscountPercent, PointsMultiplier
     FROM MembershipTiers
     WHERE MinPoints <= @points
     ORDER BY MinPoints DESC`,
    { points: pts },
    { limit: 1 }
  );
  if (rows.length > 0) return rows[0];

  const fallback = await querySql(
    `SELECT TierId, TierCode, TierName, MinPoints, DiscountPercent, PointsMultiplier
     FROM MembershipTiers
     ORDER BY MinPoints ASC`,
    {},
    { limit: 1 }
  );
  return fallback.rows[0];
}

async function generateNextMemberCode() {
  const { rows } = await querySql('SELECT COALESCE(MAX(MemberId), 0) AS MaxId FROM Members');
  let nextNum = (Number(rows[0]?.MaxId) || 0) + 1;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = `MB${String(nextNum + attempt).padStart(4, '0')}`;
    const check = await querySql(
      'SELECT MemberId FROM Members WHERE MemberCode = @code',
      { code: candidate },
      { limit: 1 }
    );
    if (check.rows.length === 0) return candidate;
  }
  return `MB${Date.now().toString().slice(-6)}`;
}

async function listTiers() {
  const { rows } = await querySql(`
    SELECT
      t.TierId,
      t.TierCode,
      t.TierName,
      t.MinPoints,
      t.DiscountPercent,
      t.PointsMultiplier,
      COUNT(m.MemberId) AS MemberCount
    FROM MembershipTiers AS t
    LEFT JOIN Members AS m ON t.TierId = m.TierId AND m.IsActive = 1
    GROUP BY t.TierId, t.TierCode, t.TierName, t.MinPoints, t.DiscountPercent, t.PointsMultiplier
    ORDER BY t.MinPoints ASC
  `);
  return rows.map((row) => ({
    tierId: Number(row.TierId),
    tierCode: row.TierCode,
    tierName: row.TierName,
    minPoints: Number(row.MinPoints) || 0,
    discountPercent: roundMoney(row.DiscountPercent),
    pointsMultiplier: Number(row.PointsMultiplier) || 1,
    memberCount: Number(row.MemberCount) || 0,
  }));
}

async function getLoyaltyOverview() {
  const [status, tiers, memberStatsRes, promoStatsRes, txStatsRes] = await Promise.all([
    getSqlStatus(),
    listTiers(),
    querySql(`
      SELECT
        COUNT(*) AS TotalMembers,
        COALESCE(SUM(CASE WHEN IsActive = 1 THEN 1 ELSE 0 END), 0) AS ActiveMembers,
        COALESCE(SUM(CurrentPoints), 0) AS TotalCurrentPoints,
        COALESCE(SUM(LifetimePoints), 0) AS TotalLifetimePoints,
        COALESCE(SUM(TotalSpent), 0) AS TotalMemberSpend
      FROM Members
    `),
    querySql(`
      SELECT
        COUNT(*) AS TotalPromotions,
        COALESCE(SUM(CASE WHEN IsActive = 1 THEN 1 ELSE 0 END), 0) AS ActivePromotions
      FROM Promotions
    `),
    querySql(`
      SELECT
        COUNT(*) AS TotalTransactions,
        COALESCE(SUM(CASE WHEN TransactionType = 'REDEEM' THEN 1 ELSE 0 END), 0) AS TotalRedemptions,
        COALESCE(SUM(CASE WHEN PointsDelta > 0 THEN PointsDelta ELSE 0 END), 0) AS TotalPointsIssued,
        COALESCE(SUM(DiscountAmount), 0) AS TotalDiscountSaved
      FROM PointTransactions
    `),
  ]);

  const m = memberStatsRes.rows[0] || {};
  const p = promoStatsRes.rows[0] || {};
  const tx = txStatsRes.rows[0] || {};

  return {
    sqlStatus: status,
    summary: {
      totalMembers: Number(m.TotalMembers) || 0,
      activeMembers: Number(m.ActiveMembers) || 0,
      totalCurrentPoints: Number(m.TotalCurrentPoints) || 0,
      totalLifetimePoints: Number(m.TotalLifetimePoints) || 0,
      totalMemberSpend: roundMoney(m.TotalMemberSpend),
      totalPromotions: Number(p.TotalPromotions) || 0,
      activePromotions: Number(p.ActivePromotions) || 0,
      totalTransactions: Number(tx.TotalTransactions) || 0,
      totalRedemptions: Number(tx.TotalRedemptions) || 0,
      totalPointsIssued: Number(tx.TotalPointsIssued) || 0,
      totalDiscountSaved: roundMoney(tx.TotalDiscountSaved),
    },
    tiers,
  };
}

async function listMembers({ search = '', tierCode = '', activeOnly = false } = {}) {
  const conditions = [];
  const params = {};

  const trimmedSearch = String(search || '').trim();
  if (trimmedSearch) {
    const digitsOnly = trimmedSearch.replace(/[^\d]/g, '');
    params.searchLike = `%${trimmedSearch}%`;
    if (digitsOnly) {
      params.phoneLike = `%${digitsOnly}%`;
      conditions.push('(FullName LIKE @searchLike OR Phone LIKE @phoneLike OR MemberCode LIKE @searchLike)');
    } else {
      conditions.push('(FullName LIKE @searchLike OR MemberCode LIKE @searchLike)');
    }
  }

  const trimmedTier = String(tierCode || '').trim().toUpperCase();
  if (trimmedTier) {
    params.tierCode = trimmedTier;
    conditions.push('TierCode = @tierCode');
  }

  if (activeOnly) {
    conditions.push('IsActive = 1');
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await querySql(
    `SELECT * FROM vw_MemberSummary ${whereClause} ORDER BY MemberId DESC`,
    params,
    { limit: 200 }
  );
  return rows.map(normalizeMemberRow);
}

async function getMemberById(memberId) {
  const id = Number.parseInt(memberId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw createAppError('INVALID_MEMBER_ID', 'รหัสสมาชิกไม่ถูกต้อง');
  }
  const { rows } = await querySql(
    'SELECT * FROM vw_MemberSummary WHERE MemberId = @id',
    { id },
    { limit: 1 }
  );
  return normalizeMemberRow(rows[0]);
}

async function listPromotions({ activeOnly = false } = {}) {
  const whereClause = activeOnly ? 'WHERE p.IsActive = 1' : '';
  const { rows } = await querySql(`
    SELECT
      p.PromotionId,
      p.PromoCode,
      p.Title,
      p.Description,
      p.DiscountType,
      p.DiscountValue,
      p.PointsCost,
      p.MinSpend,
      p.MaxDiscount,
      p.IsActive,
      p.CreatedAt,
      COUNT(pt.TransactionId) AS UsageCount,
      COALESCE(SUM(pt.DiscountAmount), 0) AS TotalDiscountGiven
    FROM Promotions AS p
    LEFT JOIN PointTransactions AS pt
      ON p.PromotionId = pt.PromotionId AND pt.TransactionType = 'REDEEM'
    ${whereClause}
    GROUP BY
      p.PromotionId, p.PromoCode, p.Title, p.Description,
      p.DiscountType, p.DiscountValue, p.PointsCost, p.MinSpend,
      p.MaxDiscount, p.IsActive, p.CreatedAt
    ORDER BY p.IsActive DESC, p.PointsCost ASC, p.PromotionId ASC
  `);
  return rows.map(normalizePromotionRow);
}

async function lookupMemberByPhone(rawPhone, subtotal = 0) {
  const phone = normalizePhone(rawPhone);
  const { rows } = await querySql(
    'SELECT * FROM vw_MemberSummary WHERE Phone = @phone',
    { phone },
    { limit: 1 }
  );
  const member = normalizeMemberRow(rows[0]);
  if (!member) {
    return { found: false, phone, member: null, availablePromotions: [] };
  }

  const activePromotions = await listPromotions({ activeOnly: true });
  const safeSubtotal = Math.max(0, roundMoney(subtotal));

  const tierDiscountAmount = member.discountPercent > 0
    ? Math.min(roundMoney((safeSubtotal * member.discountPercent) / 100), safeSubtotal)
    : 0;

  const availablePromotions = activePromotions.map((promo) => {
    const enoughPoints = member.currentPoints >= promo.pointsCost;
    const meetsMinSpend = safeSubtotal >= promo.minSpend;
    const estimatedDiscount = computePromoDiscountAmount(promo, safeSubtotal);
    let ineligibleReason = '';
    if (!member.isActive) {
      ineligibleReason = 'บัญชีสมาชิกถูกระงับชั่วคราว';
    } else if (!enoughPoints) {
      ineligibleReason = `แต้มไม่พอ (ต้องใช้ ${promo.pointsCost} แต้ม)`;
    } else if (!meetsMinSpend) {
      ineligibleReason = `ยอดอาหารขั้นต่ำ ฿${promo.minSpend.toFixed(2)}`;
    }
    return {
      ...promo,
      eligible: member.isActive && enoughPoints && meetsMinSpend,
      estimatedDiscount,
      ineligibleReason,
    };
  });

  const estimatedEarnedPoints = calculateEarnedPoints(safeSubtotal, member.pointsMultiplier);

  return {
    found: true,
    phone,
    member,
    tierBenefit: {
      available: member.isActive && member.discountPercent > 0 && safeSubtotal > 0,
      discountPercent: member.discountPercent,
      estimatedDiscount: tierDiscountAmount,
    },
    estimatedEarnedPoints,
    availablePromotions,
  };
}

async function createMember({ fullName, phone, email = '', initialPoints = 0, createdBy = 'staff' }) {
  const cleanName = String(fullName || '').trim();
  if (!cleanName) {
    throw createAppError('INVALID_MEMBER_NAME', 'กรุณากรอกชื่อ-นามสกุลสมาชิก');
  }
  const cleanPhone = normalizePhone(phone);
  const cleanEmail = String(email || '').trim() || null;
  const startPoints = Math.max(0, Math.floor(Number(initialPoints) || 0));

  const existing = await querySql(
    'SELECT MemberId FROM Members WHERE Phone = @phone',
    { phone: cleanPhone },
    { limit: 1 }
  );
  if (existing.rows.length > 0) {
    throw createAppError('DUPLICATE_MEMBER_PHONE', 'เบอร์โทรศัพท์นี้เป็นสมาชิกอยู่ในระบบแล้ว', 409);
  }

  const tier = await resolveTierForPoints(startPoints);
  const memberCode = await generateNextMemberCode();
  const now = new Date();

  const { insertedId } = await insertSql(
    `INSERT INTO Members (
      MemberCode, FullName, Phone, Email, TierId,
      CurrentPoints, LifetimePoints, TotalSpent, VisitCount, IsActive, CreatedAt, UpdatedAt
    ) VALUES (
      @memberCode, @fullName, @phone, @email, @tierId,
      @currentPoints, @lifetimePoints, 0, 0, 1, @now, @now
    )`,
    {
      memberCode,
      fullName: cleanName,
      phone: cleanPhone,
      email: cleanEmail,
      tierId: Number(tier.TierId),
      currentPoints: startPoints,
      lifetimePoints: startPoints,
      now,
    }
  );

  if (startPoints > 0 && insertedId) {
    await insertSql(
      `INSERT INTO PointTransactions (
        MemberId, PromotionId, SessionRef, TransactionType,
        PointsDelta, DiscountAmount, BillAmount, Note, CreatedBy, CreatedAt
      ) VALUES (
        @memberId, NULL, NULL, 'BONUS',
        @pointsDelta, 0, 0, @note, @createdBy, @now
      )`,
      {
        memberId: insertedId,
        pointsDelta: startPoints,
        note: 'แต้มเริ่มต้นตอนสมัครสมาชิก',
        createdBy: createdBy || 'staff',
        now,
      }
    );
  }

  return getMemberById(insertedId);
}

async function updateMember(memberId, { fullName, phone, email, isActive }) {
  const existing = await getMemberById(memberId);
  if (!existing) {
    throw createAppError('MEMBER_NOT_FOUND', 'ไม่พบข้อมูลสมาชิกในระบบ', 404);
  }

  const cleanName = fullName !== undefined ? String(fullName).trim() : existing.fullName;
  if (!cleanName) {
    throw createAppError('INVALID_MEMBER_NAME', 'กรุณากรอกชื่อ-นามสกุลสมาชิก');
  }
  const cleanPhone = phone !== undefined ? normalizePhone(phone) : existing.phone;
  const cleanEmail = email !== undefined ? (String(email).trim() || null) : (existing.email || null);
  const nextActive = isActive !== undefined ? Boolean(isActive) : existing.isActive;

  if (cleanPhone !== existing.phone) {
    const duplicate = await querySql(
      'SELECT MemberId FROM Members WHERE Phone = @phone AND MemberId <> @memberId',
      { phone: cleanPhone, memberId: existing.memberId },
      { limit: 1 }
    );
    if (duplicate.rows.length > 0) {
      throw createAppError('DUPLICATE_MEMBER_PHONE', 'เบอร์โทรศัพท์นี้ถูกใช้งานโดยสมาชิกท่านอื่นแล้ว', 409);
    }
  }

  await querySql(
    `UPDATE Members
     SET FullName = @fullName,
         Phone = @phone,
         Email = @email,
         IsActive = @isActive,
         UpdatedAt = @now
     WHERE MemberId = @memberId`,
    {
      fullName: cleanName,
      phone: cleanPhone,
      email: cleanEmail,
      isActive: nextActive ? 1 : 0,
      now: new Date(),
      memberId: existing.memberId,
    }
  );

  return getMemberById(existing.memberId);
}

async function deleteMember(memberId) {
  const existing = await getMemberById(memberId);
  if (!existing) {
    throw createAppError('MEMBER_NOT_FOUND', 'ไม่พบข้อมูลสมาชิกในระบบ', 404);
  }
  await querySql('DELETE FROM Members WHERE MemberId = @memberId', { memberId: existing.memberId });
  return existing;
}

async function adjustMemberPoints(memberId, { pointsDelta, note = '', createdBy = 'admin' }) {
  const existing = await getMemberById(memberId);
  if (!existing) {
    throw createAppError('MEMBER_NOT_FOUND', 'ไม่พบข้อมูลสมาชิกในระบบ', 404);
  }

  const delta = Number.parseInt(pointsDelta, 10);
  if (!Number.isInteger(delta) || delta === 0) {
    throw createAppError('INVALID_POINTS_DELTA', 'จำนวนแต้มที่ปรับต้องเป็นจำนวนเต็มที่ไม่ใช่ 0');
  }
  const newCurrent = existing.currentPoints + delta;
  if (newCurrent < 0) {
    throw createAppError('INSUFFICIENT_MEMBER_POINTS', `แต้มคงเหลือไม่พอสำหรับการหัก (มีอยู่ ${existing.currentPoints} แต้ม)`);
  }

  const newLifetime = delta > 0 ? existing.lifetimePoints + delta : existing.lifetimePoints;
  const newTier = await resolveTierForPoints(newLifetime);
  const now = new Date();

  await querySql(
    `UPDATE Members
     SET CurrentPoints = @currentPoints,
         LifetimePoints = @lifetimePoints,
         TierId = @tierId,
         UpdatedAt = @now
     WHERE MemberId = @memberId`,
    {
      currentPoints: newCurrent,
      lifetimePoints: newLifetime,
      tierId: Number(newTier.TierId),
      now,
      memberId: existing.memberId,
    }
  );

  await insertSql(
    `INSERT INTO PointTransactions (
      MemberId, PromotionId, SessionRef, TransactionType,
      PointsDelta, DiscountAmount, BillAmount, Note, CreatedBy, CreatedAt
    ) VALUES (
      @memberId, NULL, NULL, @txType,
      @pointsDelta, 0, 0, @note, @createdBy, @now
    )`,
    {
      memberId: existing.memberId,
      txType: delta > 0 ? 'BONUS' : 'ADJUST',
      pointsDelta: delta,
      note: String(note || '').trim() || (delta > 0 ? 'เพิ่มแต้มพิเศษโดยผู้ดูแล' : 'ปรับลดแต้มโดยผู้ดูแล'),
      createdBy: createdBy || 'admin',
      now,
    }
  );

  return getMemberById(existing.memberId);
}

async function listTransactions({ memberId = null, limit = 50 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));
  const params = {};
  let whereClause = '';
  if (memberId !== null && memberId !== undefined && String(memberId).trim() !== '') {
    const id = Number.parseInt(memberId, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw createAppError('INVALID_MEMBER_ID', 'รหัสสมาชิกไม่ถูกต้อง');
    }
    params.memberId = id;
    whereClause = 'WHERE pt.MemberId = @memberId';
  }

  const { rows } = await querySql(
    `SELECT
      pt.TransactionId,
      pt.MemberId,
      m.MemberCode,
      m.FullName,
      m.Phone,
      pt.PromotionId,
      p.PromoCode,
      p.Title AS PromoTitle,
      pt.SessionRef,
      pt.TransactionType,
      pt.PointsDelta,
      pt.DiscountAmount,
      pt.BillAmount,
      pt.Note,
      pt.CreatedBy,
      pt.CreatedAt
    FROM PointTransactions AS pt
    INNER JOIN Members AS m ON pt.MemberId = m.MemberId
    LEFT JOIN Promotions AS p ON pt.PromotionId = p.PromotionId
    ${whereClause}
    ORDER BY pt.TransactionId DESC`,
    params,
    { limit: safeLimit }
  );

  return rows.map(normalizeTransactionRow);
}

async function getPromotionById(promotionId) {
  const id = Number.parseInt(promotionId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw createAppError('INVALID_PROMOTION_ID', 'รหัสโปรโมชันไม่ถูกต้อง');
  }
  const { rows } = await querySql(
    `SELECT
      p.*,
      COUNT(pt.TransactionId) AS UsageCount,
      COALESCE(SUM(pt.DiscountAmount), 0) AS TotalDiscountGiven
     FROM Promotions AS p
     LEFT JOIN PointTransactions AS pt
       ON p.PromotionId = pt.PromotionId AND pt.TransactionType = 'REDEEM'
     WHERE p.PromotionId = @id
     GROUP BY
       p.PromotionId, p.PromoCode, p.Title, p.Description,
       p.DiscountType, p.DiscountValue, p.PointsCost, p.MinSpend,
       p.MaxDiscount, p.IsActive, p.CreatedAt`,
    { id },
    { limit: 1 }
  );
  return normalizePromotionRow(rows[0]);
}

function validatePromotionPayload(payload, partial = false) {
  const out = {};
  if (!partial || payload.promoCode !== undefined) {
    const code = String(payload.promoCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,30}$/.test(code)) {
      throw createAppError('INVALID_PROMO_CODE', 'รหัสคูปองต้องเป็นภาษาอังกฤษหรือตัวเลข 3–30 ตัวอักษร (เช่น SAVE50)');
    }
    out.promoCode = code;
  }
  if (!partial || payload.title !== undefined) {
    const title = String(payload.title || '').trim();
    if (!title) {
      throw createAppError('INVALID_PROMO_TITLE', 'กรุณากรอกชื่อโปรโมชัน/คูปอง');
    }
    out.title = title;
  }
  if (!partial || payload.description !== undefined) {
    out.description = String(payload.description || '').trim() || null;
  }
  if (!partial || payload.discountType !== undefined) {
    const type = String(payload.discountType || 'FIXED').trim().toUpperCase();
    if (!['FIXED', 'PERCENT'].includes(type)) {
      throw createAppError('INVALID_DISCOUNT_TYPE', 'ประเภทส่วนลดต้องเป็น FIXED หรือ PERCENT');
    }
    out.discountType = type;
  }
  if (!partial || payload.discountValue !== undefined) {
    const val = roundMoney(payload.discountValue);
    if (!Number.isFinite(val) || val <= 0) {
      throw createAppError('INVALID_DISCOUNT_VALUE', 'มูลค่าส่วนลดต้องมากกว่า 0');
    }
    if ((out.discountType || payload.discountType) === 'PERCENT' && val > 100) {
      throw createAppError('INVALID_DISCOUNT_VALUE', 'ส่วนลดแบบเปอร์เซ็นต์ต้องไม่เกิน 100%');
    }
    out.discountValue = val;
  }
  if (!partial || payload.pointsCost !== undefined) {
    const pts = Number.parseInt(payload.pointsCost ?? 0, 10);
    if (!Number.isInteger(pts) || pts < 0) {
      throw createAppError('INVALID_POINTS_COST', 'แต้มที่ใช้แลกต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป');
    }
    out.pointsCost = pts;
  }
  if (!partial || payload.minSpend !== undefined) {
    const minSpend = roundMoney(payload.minSpend ?? 0);
    if (!Number.isFinite(minSpend) || minSpend < 0) {
      throw createAppError('INVALID_MIN_SPEND', 'ยอดขั้นต่ำต้องไม่ติดลบ');
    }
    out.minSpend = minSpend;
  }
  if (!partial || payload.maxDiscount !== undefined) {
    const rawMax = payload.maxDiscount;
    if (rawMax === '' || rawMax === null || rawMax === undefined) {
      out.maxDiscount = null;
    } else {
      const maxVal = roundMoney(rawMax);
      if (!Number.isFinite(maxVal) || maxVal <= 0) {
        throw createAppError('INVALID_MAX_DISCOUNT', 'เพดานส่วนลดสูงสุดต้องมากกว่า 0 หรือเว้นว่าง');
      }
      out.maxDiscount = maxVal;
    }
  }
  if (!partial || payload.isActive !== undefined) {
    out.isActive = payload.isActive === undefined ? true : Boolean(payload.isActive);
  }
  return out;
}

async function createPromotion(payload) {
  const clean = validatePromotionPayload(payload, false);
  const existing = await querySql(
    'SELECT PromotionId FROM Promotions WHERE PromoCode = @promoCode',
    { promoCode: clean.promoCode },
    { limit: 1 }
  );
  if (existing.rows.length > 0) {
    throw createAppError('DUPLICATE_PROMO_CODE', 'รหัสคูปองนี้มีอยู่ในระบบแล้ว', 409);
  }

  const { insertedId } = await insertSql(
    `INSERT INTO Promotions (
      PromoCode, Title, Description, DiscountType, DiscountValue,
      PointsCost, MinSpend, MaxDiscount, IsActive, CreatedAt
    ) VALUES (
      @promoCode, @title, @description, @discountType, @discountValue,
      @pointsCost, @minSpend, @maxDiscount, @isActive, @now
    )`,
    {
      ...clean,
      isActive: clean.isActive ? 1 : 0,
      now: new Date(),
    }
  );
  return getPromotionById(insertedId);
}

async function updatePromotion(promotionId, payload) {
  const existing = await getPromotionById(promotionId);
  if (!existing) {
    throw createAppError('PROMOTION_NOT_FOUND', 'ไม่พบโปรโมชันนี้ในระบบ', 404);
  }
  const clean = validatePromotionPayload({
    promoCode: payload.promoCode ?? existing.promoCode,
    title: payload.title ?? existing.title,
    description: payload.description ?? existing.description,
    discountType: payload.discountType ?? existing.discountType,
    discountValue: payload.discountValue ?? existing.discountValue,
    pointsCost: payload.pointsCost ?? existing.pointsCost,
    minSpend: payload.minSpend ?? existing.minSpend,
    maxDiscount: payload.maxDiscount !== undefined ? payload.maxDiscount : existing.maxDiscount,
    isActive: payload.isActive !== undefined ? payload.isActive : existing.isActive,
  }, false);

  if (clean.promoCode !== existing.promoCode) {
    const dup = await querySql(
      'SELECT PromotionId FROM Promotions WHERE PromoCode = @promoCode AND PromotionId <> @promotionId',
      { promoCode: clean.promoCode, promotionId: existing.promotionId },
      { limit: 1 }
    );
    if (dup.rows.length > 0) {
      throw createAppError('DUPLICATE_PROMO_CODE', 'รหัสคูปองนี้มีอยู่ในระบบแล้ว', 409);
    }
  }

  await querySql(
    `UPDATE Promotions
     SET PromoCode = @promoCode,
         Title = @title,
         Description = @description,
         DiscountType = @discountType,
         DiscountValue = @discountValue,
         PointsCost = @pointsCost,
         MinSpend = @minSpend,
         MaxDiscount = @maxDiscount,
         IsActive = @isActive
     WHERE PromotionId = @promotionId`,
    {
      ...clean,
      isActive: clean.isActive ? 1 : 0,
      promotionId: existing.promotionId,
    }
  );
  return getPromotionById(existing.promotionId);
}

async function deletePromotion(promotionId) {
  const existing = await getPromotionById(promotionId);
  if (!existing) {
    throw createAppError('PROMOTION_NOT_FOUND', 'ไม่พบโปรโมชันนี้ในระบบ', 404);
  }
  await querySql('DELETE FROM Promotions WHERE PromotionId = @promotionId', { promotionId: existing.promotionId });
  return existing;
}

/**
 * Validate and calculate the discount & point cost to attach to an unpaid dining session.
 */
async function evaluateBenefitForBill({ memberId, benefitType = 'NONE', promotionId = null, subtotal = 0 }) {
  const member = await getMemberById(memberId);
  if (!member) {
    throw createAppError('MEMBER_NOT_FOUND', 'ไม่พบข้อมูลสมาชิกในระบบ', 404);
  }
  if (!member.isActive) {
    throw createAppError('MEMBER_INACTIVE', 'บัญชีสมาชิกนี้ถูกระงับการใช้งานชั่วคราว');
  }

  const safeSubtotal = Math.max(0, roundMoney(subtotal));
  const mode = String(benefitType || 'NONE').toUpperCase();

  if (mode === 'NONE') {
    return {
      member,
      benefitType: 'NONE',
      discountAmount: 0,
      pointsToRedeem: 0,
      appliedPromotionId: null,
      appliedPromoCode: '',
      appliedPromoTitle: 'สะสมแต้มสมาชิก (ไม่ใช้คูปอง)',
    };
  }

  if (mode === 'TIER') {
    if (member.discountPercent <= 0) {
      throw createAppError('TIER_NO_DISCOUNT', 'ระดับบัตรสมาชิกปัจจุบันยังไม่มีส่วนลดประจำบัตร');
    }
    const discountAmount = Math.min(roundMoney((safeSubtotal * member.discountPercent) / 100), safeSubtotal);
    return {
      member,
      benefitType: 'TIER',
      discountAmount,
      pointsToRedeem: 0,
      appliedPromotionId: null,
      appliedPromoCode: `TIER_${member.tierCode}`,
      appliedPromoTitle: `สิทธิ์บัตร ${member.tierName} ลด ${member.discountPercent}%`,
    };
  }

  if (mode === 'PROMO') {
    const promo = await getPromotionById(promotionId);
    if (!promo || !promo.isActive) {
      throw createAppError('PROMOTION_UNAVAILABLE', 'คูปองหรือโปรโมชันนี้ไม่เปิดใช้งาน');
    }
    if (safeSubtotal < promo.minSpend) {
      throw createAppError(
        'PROMOTION_MIN_SPEND_NOT_MET',
        `คูปอง ${promo.promoCode} ต้องมียอดอาหารขั้นต่ำ ฿${promo.minSpend.toFixed(2)}`
      );
    }
    if (member.currentPoints < promo.pointsCost) {
      throw createAppError(
        'INSUFFICIENT_MEMBER_POINTS',
        `แต้มสะสมไม่พอสำหรับคูปอง ${promo.promoCode} (ต้องใช้ ${promo.pointsCost} แต้ม แต่มี ${member.currentPoints} แต้ม)`
      );
    }
    const discountAmount = computePromoDiscountAmount(promo, safeSubtotal);
    return {
      member,
      benefitType: 'PROMO',
      discountAmount,
      pointsToRedeem: promo.pointsCost,
      appliedPromotionId: promo.promotionId,
      appliedPromoCode: promo.promoCode,
      appliedPromoTitle: promo.title,
    };
  }

  throw createAppError('INVALID_BENEFIT_TYPE', 'รูปแบบการใช้สิทธิ์ไม่ถูกต้อง');
}

/**
 * Finalize point redemption, point earning, total spend, and automatic tier upgrades in SQL
 * once a dining session payment is confirmed (Cash or QR).
 */
async function settleSessionLoyalty(session, { username = 'staff' } = {}) {
  if (!session || !session.memberId) {
    return null;
  }

  const sessionRef = String(session._id);
  const existingTx = await querySql(
    `SELECT TransactionId FROM PointTransactions
     WHERE SessionRef = @sessionRef AND TransactionType IN ('EARN', 'REDEEM')`,
    { sessionRef },
    { limit: 1 }
  );
  if (existingTx.rows.length > 0) {
    const currentMember = await getMemberById(session.memberId);
    return {
      alreadySettled: true,
      member: currentMember,
      pointsRedeemed: Number(session.pointsToRedeem) || 0,
      pointsEarned: Number(session.pointsEarned) || 0,
    };
  }

  const member = await getMemberById(session.memberId);
  if (!member) {
    return null;
  }

  const now = new Date();
  const paidAmount = Math.max(0, roundMoney(session.grandTotal));
  const discountAmount = Math.max(0, roundMoney(session.discount));
  const requestedRedeem = Math.max(0, Math.floor(Number(session.pointsToRedeem) || 0));
  const actualRedeem = Math.min(requestedRedeem, member.currentPoints);

  const earnedPoints = calculateEarnedPoints(paidAmount, member.pointsMultiplier);
  const nextCurrentPoints = Math.max(0, member.currentPoints - actualRedeem + earnedPoints);
  const nextLifetimePoints = member.lifetimePoints + earnedPoints;
  const nextTotalSpent = roundMoney(member.totalSpent + paidAmount);
  const nextVisitCount = member.visitCount + 1;

  const targetTier = await resolveTierForPoints(nextLifetimePoints);
  const nextTierId = Number(targetTier.TierId);
  const tierUpgraded = nextTierId !== member.tierId;

  await querySql(
    `UPDATE Members
     SET CurrentPoints = @currentPoints,
         LifetimePoints = @lifetimePoints,
         TotalSpent = @totalSpent,
         VisitCount = @visitCount,
         TierId = @tierId,
         UpdatedAt = @now
     WHERE MemberId = @memberId`,
    {
      currentPoints: nextCurrentPoints,
      lifetimePoints: nextLifetimePoints,
      totalSpent: nextTotalSpent,
      visitCount: nextVisitCount,
      tierId: nextTierId,
      now,
      memberId: member.memberId,
    }
  );

  if (actualRedeem > 0 || discountAmount > 0) {
    await insertSql(
      `INSERT INTO PointTransactions (
        MemberId, PromotionId, SessionRef, TransactionType,
        PointsDelta, DiscountAmount, BillAmount, Note, CreatedBy, CreatedAt
      ) VALUES (
        @memberId, @promotionId, @sessionRef, 'REDEEM',
        @pointsDelta, @discountAmount, @billAmount, @note, @createdBy, @now
      )`,
      {
        memberId: member.memberId,
        promotionId: session.appliedPromotionId || null,
        sessionRef,
        pointsDelta: -actualRedeem,
        discountAmount,
        billAmount: paidAmount,
        note: session.appliedPromoTitle
          ? `ใช้สิทธิ์: ${session.appliedPromoTitle}`
          : 'ใช้ส่วนลดสมาชิกท้ายบิล',
        createdBy: username || 'staff',
        now,
      }
    );
  }

  if (earnedPoints > 0) {
    await insertSql(
      `INSERT INTO PointTransactions (
        MemberId, PromotionId, SessionRef, TransactionType,
        PointsDelta, DiscountAmount, BillAmount, Note, CreatedBy, CreatedAt
      ) VALUES (
        @memberId, NULL, @sessionRef, 'EARN',
        @pointsDelta, 0, @billAmount, @note, @createdBy, @now
      )`,
      {
        memberId: member.memberId,
        sessionRef,
        pointsDelta: earnedPoints,
        billAmount: paidAmount,
        note: `สะสมแต้มจากยอดชำระ ฿${paidAmount.toFixed(2)} (${targetTier.TierName})`,
        createdBy: username || 'staff',
        now,
      }
    );
  }

  const updatedMember = await getMemberById(member.memberId);
  return {
    alreadySettled: false,
    member: updatedMember,
    pointsRedeemed: actualRedeem,
    pointsEarned: earnedPoints,
    newBalance: nextCurrentPoints,
    previousTierName: member.tierName,
    newTierName: updatedMember.tierName,
    tierUpgraded,
  };
}

module.exports = {
  normalizePhone,
  calculateEarnedPoints,
  computePromoDiscountAmount,
  listTiers,
  getLoyaltyOverview,
  listMembers,
  getMemberById,
  lookupMemberByPhone,
  createMember,
  updateMember,
  deleteMember,
  adjustMemberPoints,
  listTransactions,
  listPromotions,
  getPromotionById,
  createPromotion,
  updatePromotion,
  deletePromotion,
  evaluateBenefitForBill,
  settleSessionLoyalty,
};
