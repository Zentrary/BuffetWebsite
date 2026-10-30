// Close seated queue entries once a dining session ends, so the staff board
// never shows ghosts ("นั่งโต๊ะแล้ว" stuck at 0:00 after payment).
//
// The queue lifecycle is:
//   waiting -> called -> seated -> completed
// `completed` is the normal end of the meal (paid, table cleared, or staff
// closed it). `cancelled` / `no_show` remain the exceptional endings.
const Queue = require('../models/Queue');

const ACTIVE_DINING_SESSION_STATUSES = ['active', 'expired'];

function notifyQueueBoard(io) {
  if (!io) return;
  io.to('admin').to('waiter').emit('queue_board_updated');
}

/**
 * Mark every seated queue matching a filter as completed.
 * Safe to call repeatedly: only rows still in `seated` are touched.
 * @param {object} filter - Extra Mongo filter (e.g. { sessionId }, { tableId }).
 * @param {{io?: object, reason?: string}} [options] - Socket.IO server and log reason.
 * @returns {Promise<number>} Number of queues closed.
 */
async function completeSeatedQueues(filter = {}, { io, reason = '' } = {}) {
  const ids = await Queue.find({ ...filter, status: 'seated' }).distinct('_id');
  if (!ids.length) return 0;
  const result = await Queue.updateMany(
    { _id: { $in: ids }, status: 'seated' },
    { $set: { status: 'completed', completedAt: new Date() } }
  );
  const closed = result.modifiedCount || 0;
  if (closed > 0) {
    console.log(`[queueLifecycle] closed ${closed} seated queue(s)${reason ? ` (${reason})` : ''}`);
    notifyQueueBoard(io);
  }
  return closed;
}

/**
 * Close the seated queue attached to a dining session.
 * @param {string|object} sessionId - Session identifier.
 * @param {{io?: object, reason?: string}} [options] - Extra options.
 * @returns {Promise<number>} Number of queues closed.
 */
function completeSeatedQueuesForSession(sessionId, options = {}) {
  if (!sessionId) return Promise.resolve(0);
  return completeSeatedQueues({ sessionId }, { reason: 'session finished', ...options });
}

/**
 * Close seated queues that still point at a table (used after the table is cleared).
 * @param {string|object} tableId - Table identifier.
 * @param {{io?: object, reason?: string}} [options] - Extra options.
 * @returns {Promise<number>} Number of queues closed.
 */
function completeSeatedQueuesForTable(tableId, options = {}) {
  if (!tableId) return Promise.resolve(0);
  return completeSeatedQueues({ tableId }, { reason: 'table cleared', ...options });
}

/**
 * Close one specific seated queue by id (staff action).
 * @param {string} queueId - Queue identifier.
 * @param {{io?: object}} [options] - Extra options.
 * @returns {Promise<object|null>} Updated queue, or null when it was not seated anymore.
 */
async function completeQueueById(queueId, { io } = {}) {
  const updated = await Queue.findOneAndUpdate(
    { _id: queueId, status: 'seated' },
    { $set: { status: 'completed', completedAt: new Date() } },
    { new: true }
  );
  if (updated) notifyQueueBoard(io);
  return updated;
}

/**
 * Find seated queues whose dining session is missing, paid, cancelled or otherwise
 * no longer live. These are exactly the rows that used to linger forever.
 * @param {object} Session - Session model (injected to keep this module testable).
 * @param {Date} [now] - Reference time.
 * @returns {Promise<Array<object>>} Ids of stale seated queues.
 */
async function findStaleSeatedQueueIds(Session, now = new Date()) {
  const seated = await Queue.find({ status: 'seated' }).select('_id sessionId seatedAt').lean();
  if (!seated.length) return [];
  const sessionIds = [...new Set(seated.map((queue) => queue.sessionId).filter(Boolean).map(String))];
  const liveSessions = sessionIds.length
    ? await Session.find({
      _id: { $in: sessionIds },
      isPaid: false,
      status: { $in: ACTIVE_DINING_SESSION_STATUSES },
    }).select('_id').lean()
    : [];
  const liveSet = new Set(liveSessions.map((session) => String(session._id)));
  return seated
    .filter((queue) => !queue.sessionId || !liveSet.has(String(queue.sessionId)))
    .map((queue) => queue._id);
}

module.exports = {
  ACTIVE_DINING_SESSION_STATUSES,
  completeQueueById,
  completeSeatedQueues,
  completeSeatedQueuesForSession,
  completeSeatedQueuesForTable,
  findStaleSeatedQueueIds,
  notifyQueueBoard,
};
