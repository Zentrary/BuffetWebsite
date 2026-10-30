// Reconcile stale session/table/queue states after restarts or crashes.
const Session = require('../models/Session');
const Table = require('../models/Table');
const Queue = require('../models/Queue');
const Order = require('../models/Order');
const Payment = require('../models/Payment');
const { completeSeatedQueues, findStaleSeatedQueueIds } = require('./queueLifecycle');

// Extended TTL: 15 minutes for the customer to confirm a called queue.
const QUEUE_CALL_TTL_MS = 15 * 60 * 1000;

async function reconcileStaleState(io) {
  const now = new Date();
  const report = {
    expiredSessions: 0,
    orphanTables: 0,
    noShowQueues: 0,
    releasedReservations: 0,
    orphanSessions: 0,
    completedQueues: 0,
  };

  // 1. Sessions past endTime still active → expired
  const expired = await Session.updateMany(
    { status: 'active', endTime: { $lt: now }, isPaid: false },
    { $set: { status: 'expired', actualEndTime: now } }
  );
  report.expiredSessions = expired.modifiedCount || 0;

  // 2. Sessions expired > 2h → cancelled (orphan)
  const orphanCutoff = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const orphanSessions = await Session.updateMany(
    { status: 'expired', isPaid: false, endTime: { $lt: orphanCutoff } },
    { $set: { status: 'cancelled', actualEndTime: now } }
  );
  report.orphanSessions = orphanSessions.modifiedCount || 0;

  // 3. Tables occupied but session missing/terminal → cleaning
  const occupied = await Table.find({ status: 'occupied' }).lean();
  const occupiedIds = occupied.map((t) => t.currentSessionId).filter(Boolean);
  const liveSessions = occupiedIds.length
    ? await Session.find({ _id: { $in: occupiedIds }, status: { $in: ['active', 'expired'] }, isPaid: false }).select('_id').lean()
    : [];
  const liveSet = new Set(liveSessions.map((s) => String(s._id)));
  for (const table of occupied) {
    if (table.currentSessionId && liveSet.has(String(table.currentSessionId))) continue;
    await Table.updateOne(
      { _id: table._id, status: 'occupied' },
      { $set: { status: 'cleaning' } }
    );
    report.orphanTables += 1;
  }

  // 4. Mark called queues past TTL as no_show FIRST (before releasing tables).
  const noShow = await Queue.updateMany(
    { status: 'called', calledAt: { $lt: new Date(now.getTime() - QUEUE_CALL_TTL_MS) } },
    { $set: { status: 'no_show', noShowAt: now } }
  );
  report.noShowQueues = noShow.modifiedCount || 0;

  // 5. NOW release reserved tables that have no active queue.
  //    Active = 'called' or 'seated' (customer hasn't been confirmed yet).
  const reserved = await Table.find({ status: 'reserved' }).lean();
  for (const table of reserved) {
    const activeQueue = await Queue.findOne({
      tableId: table._id,
      status: { $in: ['called', 'seated'] },
    }).lean();
    if (activeQueue) continue;
    await Table.updateOne(
      { _id: table._id, status: 'reserved' },
      { $set: { status: 'available' } }
    );
    report.releasedReservations += 1;
  }

  // 6. Seated queues whose dining session is gone/paid/finished -> completed.
  //    Without this they stayed on the staff board forever as "นั่งโต๊ะแล้ว 0:00".
  const staleSeatedQueueIds = await findStaleSeatedQueueIds(Session, now);
  if (staleSeatedQueueIds.length) {
    report.completedQueues = await completeSeatedQueues(
      { _id: { $in: staleSeatedQueueIds } },
      { reason: 'stale seated queue' }
    );
  }

  // 7. Clean up orders of cancelled sessions
  if (report.orphanSessions > 0) {
    const cancelledIds = await Session.find({ status: 'cancelled', actualEndTime: { $gte: now } }).select('_id').lean();
    const ids = cancelledIds.map((s) => s._id);
    if (ids.length) {
      await Order.updateMany(
        { sessionId: { $in: ids }, status: { $in: ['pending', 'accepted', 'cooking', 'ready', 'served'] } },
        { $set: { status: 'cancelled' } }
      );
      await Payment.updateMany(
        { sessionId: { $in: ids }, status: 'pending' },
        { $set: { status: 'failed' } }
      );
    }
  }

  if (io && (report.expiredSessions + report.orphanTables + report.noShowQueues
    + report.releasedReservations + report.completedQueues) > 0) {
    io.to('admin').to('waiter').to('kitchen').emit('state_reconciled', report);
  }

  console.log('[reconcile]', JSON.stringify(report));
  return report;
}

let intervalHandle = null;

function startReconcileLoop(io, intervalMs = 60_000) {
  if (intervalHandle) return intervalHandle;
  reconcileStaleState(io).catch((error) => console.error('[reconcile] initial run failed:', error));
  intervalHandle = setInterval(() => {
    reconcileStaleState(io).catch((error) => console.error('[reconcile] run failed:', error));
  }, intervalMs);
  return intervalHandle;
}

module.exports = { reconcileStaleState, startReconcileLoop };