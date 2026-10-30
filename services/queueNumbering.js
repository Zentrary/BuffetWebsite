// Queue number allocation per business day.
//
// Queue numbers restart at Q001 every business day, which means `queueNumber`
// alone can no longer be unique. Databases created before that change still carry
// the legacy `queueNumber_1` unique index, and any new day's Q001..Qnnn would
// collide with the previous days' tickets (Mongo duplicate key -> HTTP 400).
//
// This module therefore:
//   1. allocates from a per-day counter (`queue-number:YYYY-MM-DD`),
//   2. never goes below the highest number already stored for that day,
//   3. keeps going above the highest number stored for *all* days while the
//      legacy unique index is still present (graceful degradation),
//   4. lets the index repair in services/queueIndexes.js drop that index so the
//      daily restart works as designed.
const Queue = require('../models/Queue');
const QueueCounter = require('../models/QueueCounter');

const LEGACY_INDEX_NAME = 'queueNumber_1';
const LEGACY_CACHE_TTL_MS = 30_000;

let legacyCache = { value: null, at: 0 };

function queueCounterId(businessDate) {
  return `queue-number:${businessDate}`;
}

function formatQueueNumber(sequence) {
  return `Q${String(sequence).padStart(3, '0')}`;
}

function numericPart(queueNumber) {
  const value = Number(String(queueNumber || '').replace(/\D/g, ''));
  return Number.isSafeInteger(value) ? value : 0;
}

/**
 * Highest sequence stored for one business day.
 * @param {string} businessDate - Business date key.
 * @returns {Promise<number>} Highest sequence, 0 when the day is empty.
 */
async function highestSequenceFor(businessDate) {
  const [latest] = await Queue.find({ businessDate })
    .select('sequence queueNumber')
    .sort({ sequence: -1 })
    .limit(1)
    .lean();
  if (!latest) return 0;
  return Math.max(
    Number.isSafeInteger(latest.sequence) ? latest.sequence : 0,
    numericPart(latest.queueNumber)
  );
}

/**
 * Highest number used by any queue, regardless of business day.
 * Only needed while the legacy unique index still spans all documents.
 * @returns {Promise<number>} Highest queue number in use.
 */
async function highestGlobalSequence() {
  try {
    const [row] = await Queue.aggregate([
      { $match: { queueNumber: /^Q\d+$/ } },
      {
        $project: {
          value: {
            $convert: {
              input: { $substrBytes: ['$queueNumber', 1, { $subtract: [{ $strLenBytes: '$queueNumber' }, 1] }] },
              to: 'long',
              onError: 0,
              onNull: 0,
            },
          },
        },
      },
      { $sort: { value: -1 } },
      { $limit: 1 },
    ]);
    const value = Number(row && row.value);
    return Number.isFinite(value) ? value : 0;
  } catch (error) {
    // Aggregate unsupported (e.g. a test double): fall back to a cheap max scan.
    const rows = await Queue.find({ queueNumber: /^Q\d+$/ })
      .select('queueNumber')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
    return list.reduce((max, item) => Math.max(max, numericPart(item.queueNumber)), 0);
  }
}

/**
 * Whether the database still has the old global unique index on queueNumber.
 * Cached briefly so a hot Vercel instance does not list indexes on every ticket.
 * @param {{force?: boolean}} [options] - Bypass the cache.
 * @returns {Promise<boolean>} True when the legacy index is still present.
 */
async function hasLegacyUniqueQueueNumberIndex({ force = false } = {}) {
  const now = Date.now();
  if (!force && legacyCache.value !== null && now - legacyCache.at < LEGACY_CACHE_TTL_MS) {
    return legacyCache.value;
  }
  try {
    const indexes = await Queue.collection.indexes();
    const legacy = indexes.find((index) => (
      index.name === LEGACY_INDEX_NAME
      && index.unique === true
      && !index.partialFilterExpression
    ));
    legacyCache = { value: Boolean(legacy), at: now };
    return legacyCache.value;
  } catch (error) {
    // No connection / no permissions: assume the safe (legacy) behaviour.
    console.warn('[queueNumbering] index inspection failed:', error.message);
    legacyCache = { value: true, at: now };
    return true;
  }
}

/** Forget the cached legacy-index state (called after the index is repaired). */
function resetLegacyIndexCache() {
  legacyCache = { value: null, at: 0 };
}

async function bumpCounter(counterId, amount = 1) {
  try {
    return await QueueCounter.findOneAndUpdate(
      { _id: counterId },
      { $inc: { sequence: amount } },
      { new: true, upsert: true }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    return QueueCounter.findOneAndUpdate(
      { _id: counterId },
      { $inc: { sequence: amount } },
      { new: true }
    );
  }
}

/**
 * Allocate the next queue number of a business day.
 * @param {string} businessDate - Business date key ("YYYY-MM-DD").
 * @returns {Promise<{queueNumber: string, sequence: number, businessDate: string}>} Allocated number.
 */
async function allocateQueueNumber(businessDate) {
  if (!businessDate) throw new Error('A business date is required to allocate a queue number.');
  const counterId = queueCounterId(businessDate);
  const bumped = await bumpCounter(counterId, 1);
  if (!bumped || !Number.isSafeInteger(bumped.sequence)) {
    throw new Error('Queue sequence counter is not available.');
  }

  let sequence = bumped.sequence;
  const dayHighest = await highestSequenceFor(businessDate);
  if (dayHighest >= sequence) sequence = dayHighest + 1;

  // Safety net: a database that still carries the legacy global unique index
  // cannot reuse a number from an earlier day. Numbers keep running until the
  // repair in services/queueIndexes.js drops that index.
  if (await hasLegacyUniqueQueueNumberIndex()) {
    const globalHighest = await highestGlobalSequence();
    if (globalHighest >= sequence) sequence = globalHighest + 1;
  }

  if (sequence !== bumped.sequence) {
    // Persist the jump so concurrent tickets continue from here.
    const persisted = await QueueCounter.findOneAndUpdate(
      { _id: counterId },
      { $set: { sequence } },
      { new: true, upsert: true }
    );
    if (persisted && Number.isSafeInteger(persisted.sequence) && persisted.sequence > sequence) {
      sequence = persisted.sequence;
    }
  }

  return { queueNumber: formatQueueNumber(sequence), sequence, businessDate };
}

/**
 * Push a day's counter past a number that just collided, used on duplicate-key retries.
 * @param {string} businessDate - Business date key.
 * @param {number} sequence - Sequence that must not be handed out again.
 * @returns {Promise<void>} Resolves once the counter is advanced.
 */
async function skipSequence(businessDate, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return;
  await QueueCounter.findOneAndUpdate(
    { _id: queueCounterId(businessDate) },
    { $max: { sequence } },
    { upsert: true }
  );
}

module.exports = {
  LEGACY_INDEX_NAME,
  allocateQueueNumber,
  formatQueueNumber,
  hasLegacyUniqueQueueNumberIndex,
  highestGlobalSequence,
  highestSequenceFor,
  numericPart,
  queueCounterId,
  resetLegacyIndexCache,
  skipSequence,
};
