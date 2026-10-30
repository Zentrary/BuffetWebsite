// Business-day rules: queue numbering restarts per trading day, the queue
// cut-off is earlier than closing time, and reports follow the same day.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  getBusinessDateKey,
  getBusinessDateKeys,
  getBusinessDayRange,
  getBusinessDayStart,
  getQueueAcceptance,
  getQueueCutoff,
} = require('../utils/businessDay');

// Shop opens 10:30 and closes 03:00 Asia/Bangkok (UTC+7); queues stop at 02:00.
const settings = { openTime: '10:30', closeTime: '03:00', lastQueueTime: '02:00', timezone: 'Asia/Bangkok' };
const at = (iso) => new Date(iso);

test('after midnight is still the previous business day', () => {
  // 2026-10-31T18:30Z = 2026-11-01 01:30 Bangkok
  assert.equal(getBusinessDateKey(settings, at('2026-10-31T18:30:00Z')), '2026-10-31');
  // 2026-10-31T20:00Z = 2026-11-01 03:00 Bangkok (just closed)
  assert.equal(getBusinessDateKey(settings, at('2026-10-31T20:00:00Z')), '2026-10-31');
  // 2026-11-01T03:30Z = 10:30 Bangkok, the new business day starts
  assert.equal(getBusinessDateKey(settings, at('2026-11-01T03:30:00Z')), '2026-11-01');
  // 2026-10-31T02:00Z = 09:00 Bangkok, before opening -> previous day
  assert.equal(getBusinessDateKey(settings, at('2026-10-31T02:00:00Z')), '2026-10-30');
});

test('business day start is the opening time of that trading day', () => {
  const start = getBusinessDayStart(settings, '2026-10-30');
  assert.equal(start.toISOString(), '2026-10-30T03:30:00.000Z'); // 10:30 Bangkok
  const range = getBusinessDayRange(settings, at('2026-10-30T18:00:00Z'), 1);
  assert.equal(range.businessDate, '2026-10-30');
  assert.equal(range.start.toISOString(), '2026-10-30T03:30:00.000Z');
  assert.equal(range.end.toISOString(), '2026-10-31T03:30:00.000Z');
});

test('a seven day range covers seven trading days ending today', () => {
  const range = getBusinessDayRange(settings, at('2026-10-30T18:00:00Z'), 7);
  assert.equal(range.startKey, '2026-10-24');
  assert.equal(range.end.toISOString(), '2026-10-31T03:30:00.000Z');
  assert.deepEqual(getBusinessDateKeys(settings, at('2026-10-30T18:00:00Z'), 3), ['2026-10-28', '2026-10-29', '2026-10-30']);
});

test('the queue cut-off sits inside the business day, before closing', () => {
  // Cut-off 02:00 Bangkok on 2026-10-31 = 2026-10-30T19:00Z.
  assert.equal(getQueueCutoff(settings, at('2026-10-30T18:00:00Z')).toISOString(), '2026-10-30T19:00:00.000Z');
  // Same cut-off applies to a ticket at 01:00 the next calendar morning.
  assert.equal(getQueueCutoff(settings, at('2026-10-31T18:00:00Z')).toISOString(), '2026-10-31T19:00:00.000Z');
});

test('new queues are refused after the cut-off but the shop stays open', () => {
  const before = getQueueAcceptance(settings, at('2026-10-30T17:00:00Z')); // 00:00 Bangkok
  assert.equal(before.accepting, true);
  assert.equal(before.reason, 'open');

  const afterCutoff = getQueueAcceptance(settings, at('2026-10-30T19:30:00Z')); // 02:30 Bangkok
  assert.equal(afterCutoff.accepting, false);
  assert.equal(afterCutoff.reason, 'cutoff');
  assert.equal(afterCutoff.businessDate, '2026-10-30');
});

test('closed hours and test mode block queues for their own reasons', () => {
  const closed = getQueueAcceptance(settings, at('2026-10-31T02:00:00Z')); // 09:00 Bangkok
  assert.equal(closed.accepting, false);
  assert.equal(closed.reason, 'closed');

  const testMode = getQueueAcceptance({ ...settings, isTestMode: true }, at('2026-10-30T10:00:00Z'));
  assert.equal(testMode.accepting, false);
  assert.equal(testMode.reason, 'test_mode');
});

test('a shop that closes before midnight still gets one business day', () => {
  const daytime = { openTime: '10:00', closeTime: '22:00', lastQueueTime: '21:30', timezone: 'Asia/Bangkok' };
  assert.equal(getBusinessDateKey(daytime, at('2026-10-30T09:00:00Z')), '2026-10-30'); // 16:00 Bangkok
  assert.equal(getBusinessDateKey(daytime, at('2026-10-30T16:00:00Z')), '2026-10-30'); // 23:00 Bangkok
  assert.equal(getBusinessDateKey(daytime, at('2026-10-30T02:00:00Z')), '2026-10-29'); // 09:00 Bangkok
  const range = getBusinessDayRange(daytime, at('2026-10-30T09:00:00Z'), 1);
  assert.equal(range.start.toISOString(), '2026-10-30T03:00:00.000Z'); // 10:00 Bangkok
  assert.equal(range.end.toISOString(), '2026-10-31T03:00:00.000Z');
});

test('queue numbers are allocated per business day through a dated counter', () => {
  const controller = fs.readFileSync(path.resolve(__dirname, '../controllers/queueController.js'), 'utf8');
  assert.match(controller, /function queueCounterId\(businessDate\)/);
  assert.match(controller, /queue-number:\$\{businessDate\}/);
  // createQueue stores the business date and sequence with the ticket.
  assert.match(controller, /const businessDate = getBusinessDateKey\(shopSettings, now\);/);
  assert.match(controller, /businessDate,\n\s+sequence: Number\(queueNumber\.slice\(1\)\),/);
  // It no longer falls back to a single global counter id.
  assert.doesNotMatch(controller, /_id: 'queue-number'/);
});

test('the queue model scopes uniqueness to the business day', () => {
  const model = fs.readFileSync(path.resolve(__dirname, '../models/Queue.js'), 'utf8');
  assert.match(model, /\{ businessDate: 1, queueNumber: 1 \}, \{ unique: true/);
  assert.doesNotMatch(model, /queueNumber: \{\s*\n\s*type: String,\s*\n\s*required: true,\s*\n\s*unique: true/);
  assert.match(model, /businessDate: \{/);
  assert.match(model, /sequence: \{/);
});

test('queue creation respects the cut-off middleware', () => {
  const routes = fs.readFileSync(path.resolve(__dirname, '../routes/queueRoutes.js'), 'utf8');
  assert.match(routes, /requireQueueAccepting/);
  const middleware = fs.readFileSync(path.resolve(__dirname, '../middlewares/requireQueueAccepting.js'), 'utf8');
  assert.match(middleware, /QUEUE_CLOSED/);
  // Orders keep their own opening-hours guard; dining may continue after cut-off.
  assert.match(fs.readFileSync(path.resolve(__dirname, '../routes/orderRoutes.js'), 'utf8'), /requireShopOpen/);
});

test('reports use business days and expose chart labels', () => {
  const report = fs.readFileSync(path.resolve(__dirname, '../controllers/reportController.js'), 'utf8');
  assert.match(report, /getBusinessDayRange/);
  assert.match(report, /businessDateGroupExpression/);
  assert.match(report, /dates: range\.dateKeys/);
  // Calendar-day buckets are gone; hour/day-of-week stats still use $paidAt.
  assert.doesNotMatch(report, /format: '%Y-%m-%d', date: '\$paidAt'/);
  assert.doesNotMatch(report, /timezone: 'Asia\/Bangkok'/);
});

test('settings expose the cut-off time and current business day', () => {
  const controller = fs.readFileSync(path.resolve(__dirname, '../controllers/settingsController.js'), 'utf8');
  assert.match(controller, /lastQueueTime/);
  assert.match(controller, /queueStatus: getQueueAcceptance/);
  const model = fs.readFileSync(path.resolve(__dirname, '../models/ShopSettings.js'), 'utf8');
  assert.match(model, /lastQueueTime: \{ type: String, default: '02:00'/);
});

test('custom report ranges are inclusive business dates', () => {
  const { getBusinessDayRangeForKeys } = require('../utils/businessDay');
  const range = getBusinessDayRangeForKeys(settings, '2026-10-01', '2026-10-07');
  // Trading day 10-07 runs until 10:30 on 10-08.
  assert.equal(range.start.toISOString(), '2026-10-01T03:30:00.000Z');
  assert.equal(range.end.toISOString(), '2026-10-08T03:30:00.000Z');
  assert.equal(range.days, 7);
  assert.deepEqual(range.dateKeys, [
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
  ]);
  assert.equal(getBusinessDayRangeForKeys(settings, 'bad', '2026-10-07'), null);
});
