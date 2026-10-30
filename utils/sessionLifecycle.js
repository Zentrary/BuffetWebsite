const DINING_SESSION_STATUSES = ['active', 'expired'];

// Queue states that mean the customer's turn is over. `completed` is the
// normal end of a seated queue (paid, table cleared, or staff closed it), so it
// must never be treated as "still waiting" or as a cancellation.
const CLOSED_QUEUE_STATUSES = ['completed', 'cancelled', 'no_show'];

function canRequestCheckout(session) {
  return Boolean(
    session
    && DINING_SESSION_STATUSES.includes(session.status)
    && !session.isPaid
    && !session.checkoutRequestedAt
  );
}

function canTransitionQueue(from, to) {
  if (from === 'waiting' && ['called', 'cancelled', 'no_show'].includes(to)) return true;
  if (from === 'called' && ['seated', 'cancelled', 'no_show'].includes(to)) return true;
  return false;
}

/**
 * Only a seated queue can be closed by staff or automation.
 * @param {string} from - Current queue status.
 * @returns {boolean} True when the transition to `completed` is allowed.
 */
function canCompleteQueue(from) {
  return from === 'seated';
}

/**
 * Decide whether a seated queue still belongs on the staff board.
 * A queue is live only while its dining session is running (active/expired) and
 * unpaid. Missing, paid or finished sessions mean the meal is over, which is
 * what used to leave ghost cards stuck at 0:00 under "นั่งโต๊ะแล้ว".
 * @param {object} queue - Queue document (sessionId may be populated or absent).
 * @returns {boolean} True for non-seated queues, or for seated queues still in use.
 */
function isSeatedQueueActive(queue) {
  if (!queue || queue.status !== 'seated') return true;
  const session = queue.sessionId;
  if (!session || typeof session !== 'object' || !session.status) return false;
  if (session.isPaid) return false;
  return DINING_SESSION_STATUSES.includes(session.status);
}

/**
 * Detect a seated party that has passed its booked end time.
 * @param {object} queue - Queue document with a populated sessionId.endTime.
 * @param {Date} [now] - Reference time.
 * @returns {boolean} True when the session end time is in the past.
 */
function isSeatedQueueOverdue(queue, now = new Date()) {
  const session = queue && queue.sessionId;
  if (!session || typeof session !== 'object' || !session.endTime) return false;
  return new Date(session.endTime).getTime() < now.getTime();
}

function canResumeDining(session, now = new Date()) {
  return Boolean(
    session
    && session.status === 'active'
    && !session.isPaid
    && session.checkoutRequestedAt
    && new Date(session.endTime).getTime() > now.getTime()
  );
}

function canCompletePayment(session) {
  return Boolean(
    session
    && DINING_SESSION_STATUSES.includes(session.status)
    && !session.isPaid
    && session.checkoutRequestedAt
  );
}

function canTransitionTable(from, to, { isPaid = false } = {}) {
  if (from === 'available' && to === 'reserved') return true;
  if (from === 'reserved' && to === 'occupied') return true;
  if (from === 'reserved' && to === 'available') return true;
  if (from === 'occupied' && to === 'cleaning') return isPaid;
  if (from === 'cleaning' && to === 'available') return isPaid;
  return false;
}

module.exports = {
  CLOSED_QUEUE_STATUSES,
  canCompletePayment,
  canCompleteQueue,
  canRequestCheckout,
  canResumeDining,
  canTransitionQueue,
  canTransitionTable,
  isSeatedQueueActive,
  isSeatedQueueOverdue,
};
