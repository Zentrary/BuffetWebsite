// Import the collections used by dashboard and sales reports.
const Payment = require('../models/Payment');
const Order = require('../models/Order');
const Session = require('../models/Session');
const Queue = require('../models/Queue');
const ShopSettings = require('../models/ShopSettings');
const {
  getBusinessDateKeys,
  getBusinessDayRange,
  getBusinessDayRangeForKeys,
  openMinutesOf,
  timezoneOf,
} = require('../utils/businessDay');

// A seated queue closes as `completed` when the meal ends, so "seated" totals
// must count both states or today's numbers would drop after every payment.
const SEATED_QUEUE_STATUSES = ['seated', 'completed'];

// Wrap any async operation. If it fails, log the exact error and return a safe default
// so a single failure does not crash the entire report.
async function safe(promise, label, fallback = []) {
  try {
    return await promise;
  } catch (err) {
    console.error(`[report:${label}] failed:`, err.message);
    return fallback;
  }
}

// Reports follow the shop's business day (10:30 -> 03:00) instead of the
// calendar day, so an 01:00 payment belongs to the evening that just ended.
let cachedSettings = { value: null, at: 0 };

async function loadReportSettings() {
  const now = Date.now();
  if (cachedSettings.value && now - cachedSettings.at < 30_000) return cachedSettings.value;
  try {
    const settings = await ShopSettings.findById('shop-settings').lean();
    cachedSettings = { value: settings || {}, at: now };
  } catch (error) {
    console.error('[report] settings load failed:', error.message);
    cachedSettings = { value: cachedSettings.value || {}, at: now };
  }
  return cachedSettings.value;
}

function getRangeFromDates(from, to) {
  const start = new Date(from); start.setHours(0, 0, 0, 0);
  const end = new Date(to); end.setHours(24, 0, 0, 0);
  return { start, end };
}

/**
 * Business-day range for the last `days` business days (current day last).
 * @param {number} days - Number of business days to include.
 * @returns {Promise<{start: Date, end: Date, businessDate: string, days: number}>} Range.
 */
async function getBusinessRange(days = 1) {
  const settings = await loadReportSettings();
  const range = getBusinessDayRange(settings, new Date(), days);
  return { ...range, startKey: range.startKey };
}

async function getTodayRange(days = 1) {
  return getBusinessRange(days);
}

// Mongo expression that maps a date field to its business date key.
function businessDateGroupExpression(settings) {
  const offsetMinutes = openMinutesOf(settings);
  return {
    $dateToString: {
      format: '%Y-%m-%d',
      date: { $subtract: ['$paidAt', offsetMinutes * 60 * 1000] },
      timezone: timezoneOf(settings),
    },
  };
}

function getReportDays(req) {
  const days = Number.parseInt(req.query.days, 10) || 1;
  return [1, 7, 30].includes(days) ? days : 1;
}

async function resolveRange(req) {
  const { from, to } = req.query;
  if (from && to) {
    // Custom ranges are expressed in business dates, so "to" includes the whole
    // trading day that opens on that date (e.g. 10-07 ends at 10:30 on 10-08).
    const settings = await loadReportSettings();
    const businessRange = getBusinessDayRangeForKeys(settings, String(from).slice(0, 10), String(to).slice(0, 10));
    if (businessRange) {
      return {
        start: businessRange.start,
        end: businessRange.end,
        days: businessRange.days,
        businessDate: businessRange.businessDate,
        dateKeys: businessRange.dateKeys,
      };
    }
    const { start, end } = getRangeFromDates(from, to);
    const days = Math.max(1, Math.ceil((end - start) / (24 * 60 * 60 * 1000)));
    return { start, end, days };
  }
  const days = getReportDays(req);
  const range = await getBusinessRange(days);
  const settings = await loadReportSettings();
  return {
    start: range.start,
    end: range.end,
    days,
    businessDate: range.businessDate,
    dateKeys: getBusinessDateKeys(settings, new Date(), days),
  };
}

function getPreviousRange(range) {
  const length = range.end - range.start;
  return { start: new Date(range.start.getTime() - length), end: new Date(range.start) };
}

function diff(current, previous) {
  const curr = Number(current) || 0;
  const prev = Number(previous) || 0;
  const change = curr - prev;
  const percent = prev > 0 ? (change / prev) * 100 : (curr > 0 ? 100 : 0);
  return { change, percent };
}

// ---------- legacy endpoints ----------

async function getDailySales(req, res) {
  try {
    const range = await resolveRange(req);
    const { start, end } = range;
    const settings = await loadReportSettings();
    const salesByDay = await Payment.aggregate([
      { $match: { status: 'completed', paidAt: { $gte: start, $lt: end } } },
      { $group: {
        _id: businessDateGroupExpression(settings),
        totalSales: { $sum: '$amount' },
        paymentCount: { $sum: 1 },
      } },
      { $sort: { _id: 1 } },
    ]);
    const totalSales = salesByDay.reduce((s, r) => s + r.totalSales, 0);
    const paymentCount = salesByDay.reduce((s, r) => s + r.paymentCount, 0);
    return res.json({
      success: true,
      data: {
        totalSales, paymentCount,
        salesByDay: salesByDay.map((r) => ({ date: r._id, totalSales: r.totalSales })),
        // Business-date labels for the chart (oldest first) so the browser never
        // has to guess where midnight falls for this shop.
        dates: range.dateKeys || getBusinessDateKeys(settings, new Date(), range.days),
        businessDate: range.businessDate || null,
        days: range.days, date: start,
      },
      message: 'ดึงยอดขายสำเร็จ',
    });
  } catch (e) { console.error('getDailySales:', e.message); return res.status(500).json({ success: false, code: 'REQUEST_FAILED', message: 'Request failed.' }); }
}

async function getTopMenus(req, res) {
  try {
    const { start, end } = await getTodayRange(getReportDays(req));
    const menus = await Order.aggregate([
      { $match: { createdAt: { $gte: start, $lt: end }, status: { $ne: 'cancelled' } } },
      { $unwind: '$items' },
      { $match: { 'items.itemStatus': { $ne: 'cancelled' } } },
      { $group: { _id: '$items.menuId', name: { $first: '$items.name' }, quantitySold: { $sum: '$items.quantity' }, sales: { $sum: { $multiply: ['$items.price', '$items.quantity'] } } } },
      { $sort: { quantitySold: -1, sales: -1 } },
      { $limit: 5 },
      { $project: { _id: 0, menuId: '$_id', name: 1, quantitySold: 1, sales: 1 } },
    ]);
    return res.json({ success: true, data: menus, message: 'ดึงเมนูขายดีสำเร็จ' });
  } catch (e) { console.error('getTopMenus:', e.message); return res.status(500).json({ success: false, code: 'REQUEST_FAILED', message: 'Request failed.' }); }
}

async function getAverageDiningTime(req, res) {
  try {
    const { start, end } = await getTodayRange(getReportDays(req));
    const [s] = await Session.aggregate([
      { $match: { status: 'completed', actualEndTime: { $type: 'date' }, startTime: { $type: 'date', $gte: start, $lt: end } } },
      { $group: { _id: null, avgMs: { $avg: { $subtract: ['$actualEndTime', '$startTime'] } }, sessionCount: { $sum: 1 } } },
    ]);
    return res.json({ success: true, data: { averageMinutes: s ? s.avgMs / 60000 : 0, sessionCount: s ? s.sessionCount : 0 }, message: 'คำนวณเวลาทานเฉลี่ยสำเร็จ' });
  } catch (e) { console.error('getAverageDiningTime:', e.message); return res.status(500).json({ success: false, code: 'REQUEST_FAILED', message: 'Request failed.' }); }
}

async function getQueueStats(req, res) {
  try {
    const { start, end } = await getTodayRange(getReportDays(req));
    const [totalQueues, noShowCount, waitingCount, seatedCount, customerCount] = await Promise.all([
      Queue.countDocuments({ createdAt: { $gte: start, $lt: end } }),
      Queue.countDocuments({ createdAt: { $gte: start, $lt: end }, status: 'no_show' }),
      Queue.countDocuments({ createdAt: { $gte: start, $lt: end }, status: 'waiting' }),
      Queue.countDocuments({ createdAt: { $gte: start, $lt: end }, status: { $in: SEATED_QUEUE_STATUSES } }),
      Queue.aggregate([{ $match: { createdAt: { $gte: start, $lt: end }, status: { $nin: ['cancelled', 'no_show'] } } }, { $group: { _id: null, total: { $sum: '$customerCount' } } }]),
    ]);
    return res.json({ success: true, data: { totalQueues, noShowCount, waitingCount, seatedCount, customerCount: customerCount[0]?.total || 0 }, message: 'ดึงสถิติคิวสำเร็จ' });
  } catch (e) { console.error('getQueueStats:', e.message); return res.status(500).json({ success: false, code: 'REQUEST_FAILED', message: 'Request failed.' }); }
}

async function getDashboardSummary(req, res) {
  try {
    const { start, end } = await getTodayRange(getReportDays(req));
    const [salesResult, topMenus, diningResult, totalQueues, noShowCount, waitingCount, seatedCount, customerCount] = await Promise.all([
      Payment.aggregate([{ $match: { status: 'completed', paidAt: { $gte: start, $lt: end } } }, { $group: { _id: null, totalSales: { $sum: '$amount' }, paymentCount: { $sum: 1 } } }]),
      Order.aggregate([
        { $match: { createdAt: { $gte: start, $lt: end }, status: { $ne: 'cancelled' } } },
        { $unwind: '$items' },
        { $match: { 'items.itemStatus': { $ne: 'cancelled' } } },
        { $group: { _id: '$items.menuId', name: { $first: '$items.name' }, quantitySold: { $sum: '$items.quantity' }, sales: { $sum: { $multiply: ['$items.price', '$items.quantity'] } } } },
        { $sort: { quantitySold: -1, sales: -1 } },
        { $limit: 5 },
        { $project: { _id: 0, menuId: '$_id', name: 1, quantitySold: 1, sales: 1 } },
      ]),
      Session.aggregate([{ $match: { status: 'completed', actualEndTime: { $type: 'date' }, startTime: { $type: 'date' } } }, { $group: { _id: null, avgMs: { $avg: { $subtract: ['$actualEndTime', '$startTime'] } }, sessionCount: { $sum: 1 } } }]),
      Queue.countDocuments({ createdAt: { $gte: start, $lt: end } }),
      Queue.countDocuments({ createdAt: { $gte: start, $lt: end }, status: 'no_show' }),
      Queue.countDocuments({ createdAt: { $gte: start, $lt: end }, status: 'waiting' }),
      Queue.countDocuments({ createdAt: { $gte: start, $lt: end }, status: { $in: SEATED_QUEUE_STATUSES } }),
      Queue.aggregate([{ $match: { createdAt: { $gte: start, $lt: end }, status: { $nin: ['cancelled', 'no_show'] } } }, { $group: { _id: null, total: { $sum: '$customerCount' } } }]),
    ]);
    const sales = salesResult[0] || { totalSales: 0, paymentCount: 0 };
    const dining = diningResult[0] || { avgMs: 0, sessionCount: 0 };
    return res.json({ success: true, data: { dailySales: { ...sales, date: start }, topMenus, averageDiningTime: { averageMinutes: dining.avgMs / 60000, sessionCount: dining.sessionCount }, queueStats: { totalQueues, noShowCount, waitingCount, seatedCount, customerCount: customerCount[0]?.total || 0 } }, message: 'ดึงข้อมูล Dashboard สำเร็จ' });
  } catch (e) { console.error('getDashboardSummary:', e.message); return res.status(500).json({ success: false, code: 'REQUEST_FAILED', message: 'Request failed.' }); }
}

// ---------- summary (defensive) ----------

async function getSummaryReport(req, res) {
  try {
    const range = await resolveRange(req);
    const prev = getPreviousRange(range);
    const { start, end, days } = range;

    // Each aggregation is wrapped in safe() so one failure does not break the whole report.
    const curS = await safe(Payment.aggregate([
      { $match: { status: 'completed', paidAt: { $gte: start, $lt: end } } },
      { $group: { _id: null, totalSales: { $sum: '$amount' }, paymentCount: { $sum: 1 } } },
    ]), 'curSales');
    const prevS = await safe(Payment.aggregate([
      { $match: { status: 'completed', paidAt: { $gte: prev.start, $lt: prev.end } } },
      { $group: { _id: null, totalSales: { $sum: '$amount' }, paymentCount: { $sum: 1 } } },
    ]), 'prevSales');
    const curSess = await safe(Session.countDocuments({ status: 'completed', startTime: { $gte: start, $lt: end } }), 'curSessions', 0);
    const prevSess = await safe(Session.countDocuments({ status: 'completed', startTime: { $gte: prev.start, $lt: prev.end } }), 'prevSessions', 0);
    const curQ = await safe(Queue.aggregate([
      { $match: { createdAt: { $gte: start, $lt: end } } },
      { $group: { _id: null, total: { $sum: 1 }, noShow: { $sum: { $cond: [{ $eq: ['$status', 'no_show'] }, 1, 0] } }, customers: { $sum: { $cond: [{ $in: ['$status', ['cancelled', 'no_show']] }, 0, '$customerCount'] } } } },
    ]), 'curQueue');
    const prevQ = await safe(Queue.aggregate([
      { $match: { createdAt: { $gte: prev.start, $lt: prev.end } } },
      { $group: { _id: null, total: { $sum: 1 }, noShow: { $sum: { $cond: [{ $eq: ['$status', 'no_show'] }, 1, 0] } }, customers: { $sum: { $cond: [{ $in: ['$status', ['cancelled', 'no_show']] }, 0, '$customerCount'] } } } },
    ]), 'prevQueue');
    const curD = await safe(Session.aggregate([
      { $match: { status: 'completed', actualEndTime: { $type: 'date' }, startTime: { $type: 'date', $gte: start, $lt: end } } },
      { $group: { _id: null, avgMs: { $avg: { $subtract: ['$actualEndTime', '$startTime'] } } } },
    ]), 'curDining');
    const prevD = await safe(Session.aggregate([
      { $match: { status: 'completed', actualEndTime: { $type: 'date' }, startTime: { $type: 'date', $gte: prev.start, $lt: prev.end } } },
      { $group: { _id: null, avgMs: { $avg: { $subtract: ['$actualEndTime', '$startTime'] } } } },
    ]), 'prevDining');
    const curPay = await safe(Payment.aggregate([
      { $match: { status: 'completed', paidAt: { $gte: start, $lt: end } } },
      { $group: { _id: '$method', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]), 'paymentMethods');
    const summarySettings = await loadReportSettings();
    const peak = await safe(Payment.aggregate([
      { $match: { status: 'completed', paidAt: { $gte: start, $lt: end } } },
      { $group: { _id: { $hour: { date: '$paidAt', timezone: timezoneOf(summarySettings) } }, total: { $sum: '$amount' } } },
      { $sort: { total: -1 } },
      { $limit: 1 },
    ]), 'peakHour');
    const top = await safe(Order.aggregate([
      { $match: { createdAt: { $gte: start, $lt: end }, status: { $ne: 'cancelled' } } },
      { $unwind: '$items' },
      { $match: { 'items.itemStatus': { $ne: 'cancelled' } } },
      { $group: { _id: '$items.name', qty: { $sum: '$items.quantity' } } },
      { $sort: { qty: -1 } },
      { $limit: 1 },
    ]), 'topMenu');
    // Use aggregate instead of distinct for maximum compatibility.
    const tableRows = await safe(Session.aggregate([
      { $match: { status: 'completed', startTime: { $gte: start, $lt: end } } },
      { $group: { _id: '$tableId' } },
    ]), 'uniqueTables');

    const cur = (curS && curS[0]) || { totalSales: 0, paymentCount: 0 };
    const prv = (prevS && prevS[0]) || { totalSales: 0, paymentCount: 0 };
    const cq = (curQ && curQ[0]) || { total: 0, noShow: 0, customers: 0 };
    const pq = (prevQ && prevQ[0]) || { total: 0, noShow: 0, customers: 0 };
    const cd = (curD && curD[0] && curD[0].avgMs) || 0;
    const pd = (prevD && prevD[0] && prevD[0].avgMs) || 0;
    const cash = (curPay && curPay.find((m) => m._id === 'cash')) || { total: 0, count: 0 };
    const qr = (curPay && curPay.find((m) => m._id === 'qr_payment')) || { total: 0, count: 0 };
    const totalAmount = (cash.total + qr.total) || 1;
    const avgBill = cur.paymentCount > 0 ? cur.totalSales / cur.paymentCount : 0;
    const prevAvgBill = prv.paymentCount > 0 ? prv.totalSales / prv.paymentCount : 0;
    const noShowRate = cq.total > 0 ? (cq.noShow / cq.total) * 100 : 0;
    const prevNoShowRate = pq.total > 0 ? (pq.noShow / pq.total) * 100 : 0;
    const tableCount = Array.isArray(tableRows) ? tableRows.length : 0;
    const turnover = tableCount > 0 ? curSess / tableCount : 0;

    return res.json({
      success: true,
      data: {
        range: { from: start, to: new Date(end.getTime() - 1), days },
        previous: { from: prev.start, to: new Date(prev.end.getTime() - 1) },
        metrics: {
          totalSales: { value: cur.totalSales, ...diff(cur.totalSales, prv.totalSales) },
          paymentCount: { value: cur.paymentCount, ...diff(cur.paymentCount, prv.paymentCount) },
          avgBill: { value: avgBill, ...diff(avgBill, prevAvgBill) },
          customers: { value: cq.customers, ...diff(cq.customers, pq.customers) },
          totalQueues: { value: cq.total, ...diff(cq.total, pq.total) },
          noShowRate: { value: noShowRate, change: noShowRate - prevNoShowRate, percent: prevNoShowRate > 0 ? ((noShowRate - prevNoShowRate) / prevNoShowRate) * 100 : 0 },
          avgDiningMinutes: { value: cd / 60000, change: (cd - pd) / 60000, percent: pd > 0 ? ((cd - pd) / pd) * 100 : 0 },
          turnover: { value: turnover, change: 0, percent: 0 },
          sessionCount: { value: curSess, ...diff(curSess, prevSess) },
        },
        payment: {
          cash: { total: cash.total, count: cash.count, percent: (cash.total / totalAmount) * 100 },
          qr: { total: qr.total, count: qr.count, percent: (qr.total / totalAmount) * 100 },
        },
        peakHour: peak[0] ? { hour: peak[0]._id, total: peak[0].total } : null,
        topMenu: top[0] ? { name: top[0]._id, qty: top[0].qty } : null,
      },
      message: 'ดึงรายงานสรุปสำเร็จ',
    });
  } catch (e) {
    console.error('getSummaryReport fatal:', e.message, e.stack);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', message: 'Request failed: ' + e.message });
  }
}

// ---------- Round B endpoints (defensive) ----------

async function getHourlySales(req, res) {
  try {
    const { start, end } = await resolveRange(req);
    const settings = await loadReportSettings();
    const rows = await Payment.aggregate([
      { $match: { status: 'completed', paidAt: { $gte: start, $lt: end } } },
      { $group: { _id: { $hour: { date: '$paidAt', timezone: timezoneOf(settings) } }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    const map = new Map(rows.map((r) => [r._id, r]));
    const data = Array.from({ length: 24 }, (_, h) => ({ hour: h, total: (map.get(h) && map.get(h).total) || 0, count: (map.get(h) && map.get(h).count) || 0 }));
    return res.json({ success: true, data, message: 'ดึงยอดขายรายชั่วโมงสำเร็จ' });
  } catch (e) { console.error('getHourlySales:', e.message); return res.status(500).json({ success: false, code: 'REQUEST_FAILED', message: 'Request failed.' }); }
}

async function getPaymentMethods(req, res) {
  try {
    const { start, end } = await resolveRange(req);
    const rows = await Payment.aggregate([
      { $match: { status: 'completed', paidAt: { $gte: start, $lt: end } } },
      { $group: { _id: '$method', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);
    const cash = rows.find((r) => r._id === 'cash') || { total: 0, count: 0 };
    const qr = rows.find((r) => r._id === 'qr_payment') || { total: 0, count: 0 };
    return res.json({ success: true, data: { cash, qr }, message: 'ดึงสถิติวิธีชำระสำเร็จ' });
  } catch (e) { console.error('getPaymentMethods:', e.message); return res.status(500).json({ success: false, code: 'REQUEST_FAILED', message: 'Request failed.' }); }
}

async function getSessionDurations(req, res) {
  try {
    const { start, end } = await resolveRange(req);
    const sessions = await Session.aggregate([
      { $match: { status: 'completed', actualEndTime: { $type: 'date' }, startTime: { $type: 'date', $gte: start, $lt: end } } },
      { $project: { minutes: { $divide: [{ $subtract: ['$actualEndTime', '$startTime'] }, 60000] } } },
    ]);
    const buckets = [
      { label: '0-30 นาที', min: 0, max: 30, count: 0 },
      { label: '31-60 นาที', min: 30, max: 60, count: 0 },
      { label: '61-90 นาที', min: 60, max: 90, count: 0 },
      { label: '91-120 นาที', min: 90, max: 120, count: 0 },
      { label: '> 120 นาที', min: 120, max: Infinity, count: 0 },
    ];
    for (const s of sessions) {
      const b = buckets.find((bk) => s.minutes > bk.min && s.minutes <= bk.max) || buckets[0];
      b.count += 1;
    }
    return res.json({ success: true, data: buckets, message: 'ดึงการกระจายเวลาทานสำเร็จ' });
  } catch (e) { console.error('getSessionDurations:', e.message); return res.status(500).json({ success: false, code: 'REQUEST_FAILED', message: 'Request failed.' }); }
}

async function getZoneSales(req, res) {
  try {
    const { start, end } = await resolveRange(req);
    const rows = await Payment.aggregate([
      { $match: { status: 'completed', paidAt: { $gte: start, $lt: end } } },
      { $lookup: { from: 'sessions', localField: 'sessionId', foreignField: '_id', as: 'session' } },
      { $unwind: { path: '$session', preserveNullAndEmptyArrays: true } },
      { $lookup: { from: 'tables', localField: 'session.tableId', foreignField: '_id', as: 'table' } },
      { $unwind: { path: '$table', preserveNullAndEmptyArrays: true } },
      { $group: { _id: '$table.zone', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);
    const ZONE_ALIAS = { indoor: 'small', outdoor: 'medium', vip: 'large' };
    const normalized = { small: { total: 0, count: 0 }, medium: { total: 0, count: 0 }, large: { total: 0, count: 0 } };
    for (const r of rows) {
      const key = ZONE_ALIAS[r._id] || r._id;
      if (!key || !normalized[key]) continue;
      normalized[key].total += r.total;
      normalized[key].count += r.count;
    }
    return res.json({ success: true, data: normalized, message: 'ดึงยอดขายตามโซนสำเร็จ' });
  } catch (e) { console.error('getZoneSales:', e.message); return res.status(500).json({ success: false, code: 'REQUEST_FAILED', message: 'Request failed.' }); }
}

async function getBills(req, res) {
  try {
    const range = await resolveRange(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const filter = { status: 'completed', paidAt: { $gte: range.start, $lt: range.end } };
    if (req.query.method && ['cash', 'qr_payment'].includes(req.query.method)) filter.method = req.query.method;

    const [rows, total] = await Promise.all([
      Payment.find(filter)
        .populate({ path: 'sessionId', select: 'startTime endTime actualEndTime subtotal serviceCharge vat discount grandTotal tableId queueId', populate: [{ path: 'tableId', select: 'tableNumber zone' }, { path: 'queueId', select: 'queueNumber customerCount' }] })
        .populate('receivedBy', 'username fullName')
        .sort({ paidAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Payment.countDocuments(filter),
    ]);

    const items = rows.map((p) => {
      const s = p.sessionId || {};
      const t = s.tableId || {};
      const q = s.queueId || {};
      const startT = s.startTime ? new Date(s.startTime) : null;
      const endT = s.actualEndTime ? new Date(s.actualEndTime) : null;
      const duration = (startT && endT) ? Math.round((endT - startT) / 60000) : null;
      const staff = p.receivedBy ? { username: p.receivedBy.username || '', fullName: p.receivedBy.fullName || '' } : null;
      return {
        _id: String(p._id),
        paidAt: p.paidAt,
        amount: p.amount,
        method: p.method,
        cashReceived: p.cashReceived,
        changeDue: p.changeDue,
        tableNumber: t.tableNumber || '—',
        zone: t.zone || null,
        queueNumber: q.queueNumber || null,
        customerCount: q.customerCount || null,
        durationMinutes: duration,
        subtotal: s.subtotal || 0,
        serviceCharge: s.serviceCharge || 0,
        vat: s.vat || 0,
        discount: s.discount || 0,
        grandTotal: s.grandTotal || 0,
        staff,
      };
    });

    return res.json({ success: true, data: { items, total, page, limit, pages: Math.ceil(total / limit) || 1 }, message: 'ดึงรายการบิลสำเร็จ' });
  } catch (e) { console.error('getBills:', e.message); return res.status(500).json({ success: false, code: 'REQUEST_FAILED', message: 'Request failed.' }); }
}

// ---------- Round C endpoints ----------

/**
 * Top/Bottom menu and category breakdown for the selected range.
 * Compares to the previous period to show trend.
 */
async function getMenuTrends(req, res) {
  try {
    const range = await resolveRange(req);
    const prev = getPreviousRange(range);
    const { start, end } = range;

    const [curItems, prevItems] = await Promise.all([
      Order.aggregate([
        { $match: { createdAt: { $gte: start, $lt: end }, status: { $ne: 'cancelled' } } },
        { $unwind: '$items' },
        { $match: { 'items.itemStatus': { $ne: 'cancelled' } } },
        { $group: {
          _id: '$items.menuId',
          name: { $first: '$items.name' },
          qty: { $sum: '$items.quantity' },
          sales: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
        } },
      ]).catch((e) => { console.error('menuTrends curItems:', e.message); return []; }),
      Order.aggregate([
        { $match: { createdAt: { $gte: prev.start, $lt: prev.end }, status: { $ne: 'cancelled' } } },
        { $unwind: '$items' },
        { $match: { 'items.itemStatus': { $ne: 'cancelled' } } },
        { $group: { _id: '$items.menuId', qty: { $sum: '$items.quantity' } } },
      ]).catch((e) => { console.error('menuTrends prevItems:', e.message); return []; }),
    ]);

    const prevMap = new Map(prevItems.map((r) => [String(r._id), r.qty]));
    const enriched = curItems.map((r) => {
      const p = prevMap.get(String(r._id)) || 0;
      const change = r.qty - p;
      const percent = p > 0 ? (change / p) * 100 : (r.qty > 0 ? 100 : 0);
      return { name: r.name, qty: r.qty, sales: r.sales, prevQty: p, change, percent };
    });

    const top = [...enriched].sort((a, b) => b.qty - a.qty).slice(0, 10);
    const bottom = [...enriched].filter((m) => m.qty > 0).sort((a, b) => a.qty - b.qty).slice(0, 10);
    const categoryAgg = await Order.aggregate([
      { $match: { createdAt: { $gte: start, $lt: end }, status: { $ne: 'cancelled' } } },
      { $unwind: '$items' },
      { $match: { 'items.itemStatus': { $ne: 'cancelled' } } },
      { $group: { _id: '$items.menuId', sales: { $sum: { $multiply: ['$items.price', '$items.quantity'] } } } },
      { $lookup: { from: 'menus', localField: '_id', foreignField: '_id', as: 'menu' } },
      { $unwind: { path: '$menu', preserveNullAndEmptyArrays: true } },
      { $group: { _id: '$menu.category', total: { $sum: '$sales' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]).catch((e) => { console.error('menuTrends category:', e.message); return []; });

    return res.json({
      success: true,
      data: { top, bottom, categories: categoryAgg.map((c) => ({ category: c._id || 'unknown', total: c.total, count: c.count })) },
      message: 'ดึงข้อมูลเมนูสำเร็จ',
    });
  } catch (e) {
    console.error('getMenuTrends fatal:', e.message);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', message: 'Request failed.' });
  }
}

/**
 * Staff performance: bill count, total collected, avg per bill.
 */
async function getStaffPerformance(req, res) {
  try {
    const { start, end } = await resolveRange(req);
    const rows = await Payment.aggregate([
      { $match: { status: 'completed', paidAt: { $gte: start, $lt: end }, receivedBy: { $ne: null } } },
      { $group: {
        _id: '$receivedBy',
        billCount: { $sum: 1 },
        totalSales: { $sum: '$amount' },
        avgBill: { $avg: '$amount' },
        cashCount: { $sum: { $cond: [{ $eq: ['$method', 'cash'] }, 1, 0] } },
        qrCount: { $sum: { $cond: [{ $eq: ['$method', 'qr_payment'] }, 1, 0] } },
      } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $project: {
        _id: 0,
        userId: '$_id',
        username: { $ifNull: ['$user.username', 'ไม่ทราบ'] },
        fullName: { $ifNull: ['$user.fullName', ''] },
        role: { $ifNull: ['$user.role', ''] },
        billCount: 1, totalSales: 1, avgBill: 1, cashCount: 1, qrCount: 1,
      } },
      { $sort: { totalSales: -1 } },
      { $limit: 20 },
    ]).catch((e) => { console.error('staffPerformance:', e.message); return []; });

    return res.json({ success: true, data: rows, message: 'ดึงผลงานพนักงานสำเร็จ' });
  } catch (e) {
    console.error('getStaffPerformance fatal:', e.message);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', message: 'Request failed.' });
  }
}

/**
 * Peak hours: day-of-week × hour grid of completed payments.
 */
async function getPeakHours(req, res) {
  try {
    const { start, end } = await resolveRange(req);
    const settings = await loadReportSettings();
    const rows = await Payment.aggregate([
      { $match: { status: 'completed', paidAt: { $gte: start, $lt: end } } },
      { $group: {
        _id: {
          dow: { $dayOfWeek: { date: '$paidAt', timezone: timezoneOf(settings) } },
          hour: { $hour: { date: '$paidAt', timezone: timezoneOf(settings) } },
        },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      } },
    ]).catch((e) => { console.error('peakHours:', e.message); return []; });

    // Grid: 7 rows (Sun..Sat) × 24 cols
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ total: 0, count: 0 })));
    let maxTotal = 0;
    for (const r of rows) {
      const d = (r._id.dow || 1) - 1; // 1 = Sunday in Mongo
      const h = r._id.hour;
      if (d >= 0 && d < 7 && h >= 0 && h < 24) {
        grid[d][h] = { total: r.total, count: r.count };
        if (r.total > maxTotal) maxTotal = r.total;
      }
    }
    return res.json({ success: true, data: { grid, maxTotal }, message: 'ดึงช่วงเวลาขายดีสำเร็จ' });
  } catch (e) {
    console.error('getPeakHours fatal:', e.message);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', message: 'Request failed.' });
  }
}

/**
 * Feedback summary: average rating, distribution, latest comments.
 */
async function getFeedbackSummary(req, res) {
  try {
    const { start, end } = await resolveRange(req);
    const Feedback = require('../models/Feedback');
    const [dist, agg, recent] = await Promise.all([
      Feedback.aggregate([
        { $match: { createdAt: { $gte: start, $lt: end } } },
        { $group: { _id: '$rating', count: { $sum: 1 } } },
      ]).catch((e) => { console.error('feedback dist:', e.message); return []; }),
      Feedback.aggregate([
        { $match: { createdAt: { $gte: start, $lt: end } } },
        { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
      ]).catch((e) => { console.error('feedback agg:', e.message); return []; }),
      Feedback.find({ createdAt: { $gte: start, $lt: end }, comment: { $ne: '' } })
        .sort({ createdAt: -1 })
        .limit(20)
        .select('rating comment createdAt')
        .lean()
        .catch((e) => { console.error('feedback recent:', e.message); return []; }),
    ]);

    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const d of dist) {
      if (distribution[d._id] !== undefined) distribution[d._id] = d.count;
    }
    const average = agg[0] && agg[0].avg ? agg[0].avg : 0;
    const total = agg[0] && agg[0].count ? agg[0].count : 0;

    return res.json({
      success: true,
      data: { average, total, distribution, recent },
      message: 'ดึงข้อมูลรีวิวสำเร็จ',
    });
  } catch (e) {
    console.error('getFeedbackSummary fatal:', e.message);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', message: 'Request failed.' });
  }
}

// ---------- Round D endpoints ----------

/**
 * Compare current period vs previous period on key metrics.
 * Returns both series aligned by index for side-by-side bar.
 */
async function getComparison(req, res) {
  try {
    const range = await resolveRange(req);
    const prev = getPreviousRange(range);
    const { start, end } = range;

    const build = async (from, to) => {
      const [sales, bills, customers] = await Promise.all([
        Payment.aggregate([
          { $match: { status: 'completed', paidAt: { $gte: from, $lt: to } } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
        Payment.countDocuments({ status: 'completed', paidAt: { $gte: from, $lt: to } }),
        Queue.aggregate([
          { $match: { createdAt: { $gte: from, $lt: to }, status: { $nin: ['cancelled', 'no_show'] } } },
          { $group: { _id: null, total: { $sum: '$customerCount' } } },
        ]),
      ]);
      return {
        totalSales: sales[0]?.total || 0,
        billCount: bills || 0,
        customerCount: customers[0]?.total || 0,
      };
    };

    const [current, previous] = await Promise.all([
      build(start, end),
      build(prev.start, prev.end),
    ]);

    // Daily series for line overlay.
    const settings = await loadReportSettings();
    const buildDaily = async (from, to) => {
      const rows = await Payment.aggregate([
        { $match: { status: 'completed', paidAt: { $gte: from, $lt: to } } },
        { $group: { _id: businessDateGroupExpression(settings), total: { $sum: '$amount' } } },
        { $sort: { _id: 1 } },
      ]);
      const map = new Map(rows.map((r) => [r._id, r.total]));
      // Buckets follow business dates, matching getDailySales labels.
      return getBusinessDateKeys(settings, new Date(to.getTime() - 1), Math.max(1, Math.round((to - from) / 86400000)))
        .map((key) => map.get(key) || 0);
    };
    const [curDaily, prevDaily] = await Promise.all([
      buildDaily(start, end),
      buildDaily(prev.start, prev.end),
    ]);

    return res.json({
      success: true,
      data: {
        current,
        previous,
        curDaily,
        prevDaily,
        range: { from: start, to: end, days: range.days },
        previousRange: { from: prev.start, to: prev.end },
      },
      message: 'เปรียบเทียบสำเร็จ',
    });
  } catch (e) {
    console.error('getComparison fatal:', e.message);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', message: 'Request failed.' });
  }
}

/**
 * Export report to Excel (.xlsx) using exceljs.
 * Sheets: Summary, Daily Sales, Bills, Top Menus, Staff.
 */
async function exportExcel(req, res) {
  try {
    const ExcelJS = require('exceljs');
    const range = await resolveRange(req);
    const { start, end } = range;

    // Fetch data
    const [payments, orders, sessions, users] = await Promise.all([
      Payment.find({ status: 'completed', paidAt: { $gte: start, $lt: end } })
        .populate({ path: 'sessionId', select: 'startTime actualEndTime tableId queueId', populate: [{ path: 'tableId', select: 'tableNumber zone' }, { path: 'queueId', select: 'queueNumber customerCount' }] })
        .populate('receivedBy', 'username fullName')
        .sort({ paidAt: 1 })
        .lean(),
      Order.find({ createdAt: { $gte: start, $lt: end }, status: { $ne: 'cancelled' } }).lean(),
      Session.find({ status: 'completed', startTime: { $gte: start, $lt: end } }).lean(),
      require('../models/User').find({}).select('username fullName role').lean(),
    ]);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TEEHID Buffet';
    wb.created = new Date();

    // --- Sheet 1: Summary ---
    const summary = wb.addWorksheet('Summary');
    summary.columns = [
      { header: 'รายการ', key: 'label', width: 30 },
      { header: 'ค่า', key: 'value', width: 25 },
    ];
    const totalSales = payments.reduce((s, p) => s + (p.amount || 0), 0);
    const cashTotal = payments.filter((p) => p.method === 'cash').reduce((s, p) => s + (p.amount || 0), 0);
    const qrTotal = payments.filter((p) => p.method === 'qr_payment').reduce((s, p) => s + (p.amount || 0), 0);
    summary.addRows([
      { label: 'ช่วง', value: `${start.toLocaleDateString('th-TH')} — ${end.toLocaleDateString('th-TH')}` },
      { label: 'ยอดขายรวม', value: totalSales },
      { label: 'จำนวนบิล', value: payments.length },
      { label: 'บิลเฉลี่ย', value: payments.length > 0 ? totalSales / payments.length : 0 },
      { label: 'เงินสด', value: cashTotal },
      { label: 'QR Payment', value: qrTotal },
    ]);
    summary.getRow(1).font = { bold: true, size: 12 };
    summary.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEA580C' } };
    summary.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // --- Sheet 2: Daily Sales ---
    const daily = wb.addWorksheet('Daily Sales');
    daily.columns = [
      { header: 'วันที่', key: 'date', width: 15 },
      { header: 'ยอดขาย (บาท)', key: 'amount', width: 20 },
    ];
    const dailyMap = new Map();
    for (const p of payments) {
      if (!p.paidAt) continue;
      const d = new Date(p.paidAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      dailyMap.set(key, (dailyMap.get(key) || 0) + (p.amount || 0));
    }
    [...dailyMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([d, a]) => {
      daily.addRow({ date: d, amount: a });
    });
    daily.getRow(1).font = { bold: true };

    // --- Sheet 3: Bills ---
    const bills = wb.addWorksheet('Bills');
    bills.columns = [
      { header: 'เวลา', key: 'time', width: 20 },
      { header: 'โต๊ะ', key: 'table', width: 12 },
      { header: 'โซน', key: 'zone', width: 12 },
      { header: 'คิว', key: 'queue', width: 12 },
      { header: 'ลูกค้า', key: 'customers', width: 10 },
      { header: 'วิธีชำระ', key: 'method', width: 12 },
      { header: 'พนักงาน', key: 'staff', width: 22 },
      { header: 'ยอด (บาท)', key: 'amount', width: 15 },
    ];
    for (const p of payments) {
      const s = p.sessionId || {};
      const t = s.tableId || {};
      const q = s.queueId || {};
      bills.addRow({
        time: p.paidAt ? new Date(p.paidAt).toLocaleString('th-TH') : '',
        table: t.tableNumber || '',
        zone: { small: 'เล็ก', medium: 'กลาง', large: 'ใหญ่' }[t.zone] || t.zone || '',
        queue: q.queueNumber || '',
        customers: q.customerCount || '',
        method: p.method === 'cash' ? 'เงินสด' : 'QR',
        staff: p.receivedBy ? (p.receivedBy.fullName || p.receivedBy.username) : '',
        amount: p.amount || 0,
      });
    }
    bills.getRow(1).font = { bold: true };

    // --- Sheet 4: Top Menus ---
    const menuMap = new Map();
    for (const order of orders) {
      for (const it of order.items || []) {
        if (it.itemStatus === 'cancelled') continue;
        const key = String(it.name);
        const cur = menuMap.get(key) || { name: it.name, qty: 0, sales: 0 };
        cur.qty += Number(it.quantity) || 0;
        cur.sales += (Number(it.price) || 0) * (Number(it.quantity) || 0);
        menuMap.set(key, cur);
      }
    }
    const menus = wb.addWorksheet('Top Menus');
    menus.columns = [
      { header: 'อันดับ', key: 'rank', width: 8 },
      { header: 'เมนู', key: 'name', width: 30 },
      { header: 'จำนวน', key: 'qty', width: 12 },
      { header: 'ยอดขาย (บาท)', key: 'sales', width: 18 },
    ];
    [...menuMap.values()].sort((a, b) => b.qty - a.qty).forEach((m, i) => {
      menus.addRow({ rank: i + 1, name: m.name, qty: m.qty, sales: m.sales });
    });
    menus.getRow(1).font = { bold: true };

    // --- Sheet 5: Staff ---
    const staffMap = new Map();
    for (const p of payments) {
      if (!p.receivedBy) continue;
      const key = String(p.receivedBy._id || p.receivedBy.username);
      const cur = staffMap.get(key) || { name: p.receivedBy.fullName || p.receivedBy.username, bills: 0, sales: 0 };
      cur.bills += 1;
      cur.sales += p.amount || 0;
      staffMap.set(key, cur);
    }
    const staff = wb.addWorksheet('Staff');
    staff.columns = [
      { header: 'พนักงาน', key: 'name', width: 25 },
      { header: 'จำนวนบิล', key: 'bills', width: 12 },
      { header: 'ยอดขาย (บาท)', key: 'sales', width: 18 },
      { header: 'เฉลี่ยต่อบิล', key: 'avg', width: 15 },
    ];
    [...staffMap.values()].sort((a, b) => b.sales - a.sales).forEach((s) => {
      staff.addRow({ name: s.name, bills: s.bills, sales: s.sales, avg: s.bills > 0 ? s.sales / s.bills : 0 });
    });
    staff.getRow(1).font = { bold: true };

    const fromStr = `${start.getFullYear()}${String(start.getMonth() + 1).padStart(2, '0')}${String(start.getDate()).padStart(2, '0')}`;
    const toStr = `${end.getFullYear()}${String(end.getMonth() + 1).padStart(2, '0')}${String(end.getDate()).padStart(2, '0')}`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="report-${fromStr}_to_${toStr}.xlsx"`);
    await wb.xlsx.write(res);
    return res.end();
  } catch (e) {
    console.error('exportExcel fatal:', e.message, e.stack);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', message: 'Export ไม่สำเร็จ: ' + e.message });
  }
}

// Then extend module.exports:
module.exports = {
  getDailySales, getTopMenus, getAverageDiningTime, getQueueStats,
  getDashboardSummary, getSummaryReport,
  getHourlySales, getPaymentMethods, getSessionDurations, getZoneSales, getBills,
  getMenuTrends, getStaffPerformance, getPeakHours, getFeedbackSummary,  getComparison,
  exportExcel,
};