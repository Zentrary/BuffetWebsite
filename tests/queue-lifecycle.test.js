// Queue lifecycle rules: a seated queue must stop being "active" once its dining
// session is paid/finished, and only seated queues can be closed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CLOSED_QUEUE_STATUSES,
  canCompleteQueue,
  isSeatedQueueActive,
  isSeatedQueueOverdue,
} = require('../utils/sessionLifecycle');

const session = (overrides = {}) => ({ status: 'active', isPaid: false, endTime: null, ...overrides });
const seated = (sessionDoc) => ({ status: 'seated', sessionId: sessionDoc });

test('a seated queue with a live dining session stays on the staff board', () => {
  assert.equal(isSeatedQueueActive(seated(session())), true);
  assert.equal(isSeatedQueueActive(seated(session({ status: 'expired' }))), true, 'overtime guests are still seated');
});

test('seated queues disappear once the session is paid, cancelled or gone', () => {
  assert.equal(isSeatedQueueActive(seated(session({ isPaid: true, status: 'completed' }))), false);
  assert.equal(isSeatedQueueActive(seated(session({ status: 'cancelled' }))), false);
  assert.equal(isSeatedQueueActive(seated(null)), false, 'missing session must not render as "seated"');
  assert.equal(isSeatedQueueActive(seated('64b7f0c2c0ffee0000000000')), false, 'unpopulated id has no status');
});

test('non-seated queues are unaffected by the seated filter', () => {
  for (const status of ['waiting', 'called', 'completed', 'cancelled', 'no_show']) {
    assert.equal(isSeatedQueueActive({ status }), true);
  }
});

test('only a seated queue can be completed', () => {
  assert.equal(canCompleteQueue('seated'), true);
  for (const status of ['waiting', 'called', 'completed', 'cancelled', 'no_show']) {
    assert.equal(canCompleteQueue(status), false, `${status} must not be completed`);
  }
  assert.deepEqual(CLOSED_QUEUE_STATUSES, ['completed', 'cancelled', 'no_show']);
});

test('an overrun table is flagged instead of showing a frozen 0:00', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  assert.equal(isSeatedQueueOverdue(seated(session({ endTime: '2026-10-30T11:00:00Z' })), now), true);
  assert.equal(isSeatedQueueOverdue(seated(session({ endTime: '2026-10-30T13:00:00Z' })), now), false);
  assert.equal(isSeatedQueueOverdue(seated(session()), now), false);
  assert.equal(isSeatedQueueOverdue({ status: 'seated' }, now), false);
});

test('every place that ends a meal also closes the seated queue', () => {
  const read = (file) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const payment = read('controllers/paymentController.js');
  assert.equal(payment.match(/completeSeatedQueuesForSession/g)?.length >= 2, true, 'cash + QR payment must both close the queue');
  assert.match(read('controllers/tableController.js'), /completeSeatedQueues\(/);
  assert.match(read('services/reconcileState.js'), /findStaleSeatedQueueIds/);
  assert.match(read('routes/queueRoutes.js'), /queueController\.completeQueue/);
});

test('queue status enum accepts the completed state used by the lifecycle', () => {
  const model = fs.readFileSync(path.resolve(__dirname, '../models/Queue.js'), 'utf8');
  assert.match(model, /enum: \['waiting', 'called', 'seated', 'completed', 'cancelled', 'no_show'\]/);
  assert.match(model, /completedAt/);
});

test('seated totals in reports still count the closed queues', () => {
  const report = fs.readFileSync(path.resolve(__dirname, '../controllers/reportController.js'), 'utf8');
  assert.doesNotMatch(report, /status: 'seated' \}\),/);
  assert.match(report, /SEATED_QUEUE_STATUSES/);
});

test('completeSeatedQueues touches only seated rows and announces one board refresh', async () => {
  const Queue = require('../models/Queue');
  const updates = [];
  Queue.find = () => ({ distinct: async () => ['queue-a', 'queue-b'] });
  Queue.updateMany = async (filter, update) => {
    updates.push({ filter, update });
    return { modifiedCount: 2 };
  };
  const events = [];
  const io = { to: () => ({ to: () => ({ emit: (event) => events.push(event) }) }) };
  const { completeSeatedQueues } = require('../services/queueLifecycle');

  const closed = await completeSeatedQueues({ sessionId: 'session-1' }, { io, reason: 'test' });
  assert.equal(closed, 2);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].filter, { _id: { $in: ['queue-a', 'queue-b'] }, status: 'seated' });
  assert.equal(updates[0].update.$set.status, 'completed');
  assert.ok(updates[0].update.$set.completedAt instanceof Date);
  assert.deepEqual(events, ['queue_board_updated']);

  // Nothing seated -> no write, no refresh.
  Queue.find = () => ({ distinct: async () => [] });
  updates.length = 0;
  assert.equal(await completeSeatedQueues({ tableId: 'table-1' }, { io }), 0);
  assert.equal(updates.length, 0);
  assert.deepEqual(events, ['queue_board_updated']);
});

test('findStaleSeatedQueueIds flags queues whose session is gone or no longer live', async () => {
  const Queue = require('../models/Queue');
  Queue.find = () => ({
    select: () => ({
      lean: async () => [
        { _id: 'q-live', sessionId: 's-live' },
        { _id: 'q-paid', sessionId: 's-paid' },
        { _id: 'q-missing', sessionId: null },
      ],
    }),
  });
  const Session = { find: () => ({ select: () => ({ lean: async () => [{ _id: 's-live' }] }) }) };
  const { findStaleSeatedQueueIds } = require('../services/queueLifecycle');

  const stale = await findStaleSeatedQueueIds(Session);
  assert.deepEqual(stale, ['q-paid', 'q-missing']);
});
