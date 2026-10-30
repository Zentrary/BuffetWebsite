// Regression tests for "cannot take a queue after the per-day numbering deploy".
//
// Root cause: the database kept the legacy global unique index `queueNumber_1`,
// so a new business day's Q001 collided with older tickets, Mongo raised E11000,
// createQueue turned it into HTTP 400 REQUEST_FAILED and the customer only saw
// "คำขอไม่สำเร็จ กรุณาลองใหม่".
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Queue = require('../models/Queue');
const QueueCounter = require('../models/QueueCounter');
const numbering = require('../services/queueNumbering');

const read = (file) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

// ---- stub helpers ---------------------------------------------------------

function stubCounters(initial = {}) {
  const counters = new Map(Object.entries(initial));
  QueueCounter.findOneAndUpdate = async (filter, update) => {
    const current = counters.get(filter._id) || 0;
    let next = current;
    if (update.$inc) next = current + (update.$inc.sequence || 0);
    if (update.$set && Number.isFinite(update.$set.sequence)) next = update.$set.sequence;
    if (update.$max && Number.isFinite(update.$max.sequence)) next = Math.max(current, update.$max.sequence);
    counters.set(filter._id, next);
    return { _id: filter._id, sequence: next };
  };
  return counters;
}

function stubQueues(rows) {
  // rows: [{ queueNumber, businessDate, sequence, createdAt }]
  Queue.find = (filter = {}) => {
    const daily = filter.businessDate;
    let matches = rows.filter((row) => (daily ? row.businessDate === daily : true));
    const api = {
      select() { return api; },
      sort(spec) {
        if (spec.sequence) matches = matches.slice().sort((a, b) => (b.sequence || 0) - (a.sequence || 0));
        if (spec.createdAt) matches = matches.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        return api;
      },
      limit(n) { matches = matches.slice(0, n); return api; },
      lean: async () => matches,
      then: (resolve, reject) => Promise.resolve(matches).then(resolve, reject),
    };
    return api;
  };
}

function stubIndexes(indexes) {
  Queue.collection.indexes = async () => indexes;
}

// ---- numbering ------------------------------------------------------------

test('a fresh day restarts at Q001 when the legacy index is gone', async () => {
  stubCounters();
  stubQueues([{ queueNumber: 'Q001', businessDate: '2026-10-29', sequence: 1, createdAt: '2026-10-29T05:00:00Z' }]);
  stubIndexes([{ name: 'businessDate_1_queueNumber_1', key: { businessDate: 1, queueNumber: 1 }, unique: true }]);
  numbering.resetLegacyIndexCache();

  const first = await numbering.allocateQueueNumber('2026-10-30');
  const second = await numbering.allocateQueueNumber('2026-10-30');
  assert.equal(first.queueNumber, 'Q001');
  assert.equal(first.sequence, 1);
  assert.equal(second.queueNumber, 'Q002');
});

test('with the legacy unique index still present, numbers never collide with older days', async () => {
  // Yesterday ended at Q025 and the old global index is still there.
  stubCounters();
  stubQueues([
    { queueNumber: 'Q001', businessDate: '2026-10-28', sequence: 1, createdAt: '2026-10-28T05:00:00Z' },
    { queueNumber: 'Q025', businessDate: '2026-10-29', sequence: 25, createdAt: '2026-10-29T05:00:00Z' },
  ]);
  stubIndexes([{ name: 'queueNumber_1', key: { queueNumber: 1 }, unique: true }]);
  numbering.resetLegacyIndexCache();

  const allocation = await numbering.allocateQueueNumber('2026-10-30');
  assert.equal(allocation.queueNumber, 'Q026', 'must continue above the highest number already stored');
  assert.equal(allocation.sequence, 26);

  // Once the legacy index is repaired, the next day restarts at Q001 again.
  stubIndexes([{ name: 'businessDate_1_queueNumber_1', key: { businessDate: 1, queueNumber: 1 }, unique: true }]);
  numbering.resetLegacyIndexCache();
  const nextDay = await numbering.allocateQueueNumber('2026-10-31');
  assert.equal(nextDay.queueNumber, 'Q001');
});

test('a lagging counter is lifted above the numbers already stored for the day', async () => {
  // Counter was reset/migrated but the day already has Q010 in the database.
  stubCounters();
  stubQueues([{ queueNumber: 'Q010', businessDate: '2026-10-30', sequence: 10, createdAt: '2026-10-30T05:00:00Z' }]);
  stubIndexes([{ name: 'businessDate_1_queueNumber_1', key: { businessDate: 1, queueNumber: 1 }, unique: true }]);
  numbering.resetLegacyIndexCache();

  const allocation = await numbering.allocateQueueNumber('2026-10-30');
  assert.equal(allocation.queueNumber, 'Q011');
});

test('index inspection failures fall back to the collision-free behaviour', async () => {
  stubCounters();
  stubQueues([{ queueNumber: 'Q007', businessDate: '2026-10-29', sequence: 7, createdAt: '2026-10-29T05:00:00Z' }]);
  Queue.collection.indexes = async () => { throw new Error('not authorized'); };
  numbering.resetLegacyIndexCache();

  const allocation = await numbering.allocateQueueNumber('2026-10-30');
  assert.equal(allocation.queueNumber, 'Q008', 'assume the legacy index when it cannot be inspected');
});

test('skipSequence pushes the counter past a collided number', async () => {
  const counters = stubCounters();
  await numbering.skipSequence('2026-10-30', 42);
  assert.equal(counters.get('queue-number:2026-10-30'), 42);
  await numbering.skipSequence('2026-10-30', 7); // never goes backwards
  assert.equal(counters.get('queue-number:2026-10-30'), 42);
});

// ---- index repair ---------------------------------------------------------

test('the repair drops the legacy index and backfills old queues', async () => {
  const dropped = [];
  Queue.collection.indexes = async () => ([
    { name: 'queueNumber_1', key: { queueNumber: 1 }, unique: true },
    { name: 'status_1_createdAt_1', key: { status: 1, createdAt: 1 } },
  ]);
  Queue.collection.dropIndex = async (name) => { dropped.push(name); };
  Queue.countDocuments = async () => 2;
  Queue.findOne = () => ({ select: () => ({ lean: async () => ({ _id: 'a' }) }) });
  Queue.find = () => ({
    select() { return this; },
    sort() { return this; },
    limit() { return this; },
    lean: async () => ([
      { _id: 'a', queueNumber: 'Q001', createdAt: '2026-10-29T05:00:00Z' },
      { _id: 'b', queueNumber: 'Q002', createdAt: '2026-10-29T06:00:00Z' },
    ]),
    then: (resolve) => Promise.resolve([]).then(resolve),
  });
  const writes = [];
  Queue.bulkWrite = async (ops) => { writes.push(...ops); return { modifiedCount: ops.length }; };
  let synced = false;
  Queue.syncIndexes = async () => { synced = true; };
  const ShopSettings = require('../models/ShopSettings');
  ShopSettings.findById = () => ({ lean: async () => ({ openTime: '10:30', closeTime: '03:00', timezone: 'Asia/Bangkok' }) });

  const { repairQueueIndexes } = require('../services/queueIndexes');
  const summary = await repairQueueIndexes({ logger: { log() {}, warn() {}, error() {} } });

  assert.deepEqual(dropped, ['queueNumber_1']);
  assert.equal(summary.droppedLegacyIndex, true);
  assert.equal(summary.backfilled, 2);
  assert.equal(summary.indexesSynced, true);
  assert.equal(synced, true);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].updateOne.update.$set.businessDate, '2026-10-29');
  assert.equal(writes[1].updateOne.update.$set.sequence, 2);
  numbering.resetLegacyIndexCache();
});

test('the repair stays quiet when there is nothing to fix', async () => {
  Queue.collection.indexes = async () => ([{ name: 'businessDate_1_queueNumber_1', key: { businessDate: 1, queueNumber: 1 }, unique: true }]);
  Queue.syncIndexes = async () => {};
  const { repairQueueIndexes } = require('../services/queueIndexes');
  const summary = await repairQueueIndexes({ logger: { log() {}, warn() {}, error() {} }, backfill: false });
  assert.equal(summary.droppedLegacyIndex, false);
  assert.equal(summary.indexesSynced, true);
});

test('the backfill skips the write path when every queue already has a business date', async () => {
  Queue.findOne = () => ({ select: () => ({ lean: async () => null }) });
  let wrote = false;
  Queue.bulkWrite = async () => { wrote = true; return { modifiedCount: 0 }; };
  const { backfillBusinessDates } = require('../services/queueIndexes');
  const result = await backfillBusinessDates({ openTime: '10:30', closeTime: '03:00', timezone: 'Asia/Bangkok' });
  assert.deepEqual(result, { scanned: 0, updated: 0 });
  assert.equal(wrote, false);
});

// ---- wiring ---------------------------------------------------------------

test('the app repairs queue indexes right after connecting', () => {
  const db = read('config/db.js');
  assert.match(db, /repairQueueIndexesOnce\(\)/);
  const service = read('services/queueIndexes.js');
  assert.match(service, /dropIndex\(LEGACY_INDEX_NAME\)/);
  assert.match(service, /Queue\.syncIndexes\(\)/);
});

test('createQueue reports numbering conflicts clearly instead of a generic 400', () => {
  const controller = read('controllers/queueController.js');
  assert.match(controller, /allocateQueueNumber\(businessDate\)/);
  assert.match(controller, /skipSequence\(businessDate, allocation\.sequence\)/);
  assert.match(controller, /QUEUE_NUMBER_CONFLICT/);
  assert.match(controller, /INVALID_QUEUE_PAYLOAD/);
  assert.doesNotMatch(controller, /error\.code === 11000 \? 400 : 500/);
});

test('the customer form shows the server message instead of the generic fallback', () => {
  const client = read('public/js/customer/queue.js');
  assert.match(client, /function apiErrorMessage\(payload\)/);
  assert.match(client, /throw new Error\(apiErrorMessage\(payload\)\)/);
  const th = JSON.parse(read('public/locales/th.json'));
  assert.equal(typeof th['error.QUEUE_NUMBER_CONFLICT'], 'string');
  assert.equal(typeof th['error.INVALID_QUEUE_PAYLOAD'], 'string');
});
