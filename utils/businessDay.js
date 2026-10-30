// Business-day helpers shared by queue numbering, queue acceptance, and reports.
//
// A "business day" is not a calendar day: the shop opens at `openTime` and closes
// at `closeTime`, which may be after midnight (10:30 -> 03:00). Every instant
// belongs to the business day whose `openTime` most recently passed, so a queue
// taken at 02:00 still belongs to the previous day's trade.
//
// The single rule used everywhere (Mongo aggregations included):
//   businessDate(instant) = local date of (instant - openTime minutes)
const { parseTime, getShopStatus } = require('./shopStatus');

const DEFAULT_TIMEZONE = 'Asia/Bangkok';
const DEFAULT_OPEN_TIME = '10:30';
const DEFAULT_CLOSE_TIME = '03:00';
const DAY_MS = 24 * 60 * 60 * 1000;

function timezoneOf(settings) {
  return (settings && settings.timezone) || DEFAULT_TIMEZONE;
}

function openMinutesOf(settings) {
  const parsed = parseTime(settings && settings.openTime);
  return parsed === null ? parseTime(DEFAULT_OPEN_TIME) : parsed;
}

function closeMinutesOf(settings) {
  const parsed = parseTime(settings && settings.closeTime);
  return parsed === null ? parseTime(DEFAULT_CLOSE_TIME) : parsed;
}

// Last moment a new queue is accepted for the business day.
function lastQueueMinutesOf(settings) {
  const parsed = parseTime(settings && settings.lastQueueTime);
  return parsed === null ? closeMinutesOf(settings) : parsed;
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = (type) => Number(parts.find((part) => part.type === type).value);
  return { year: value('year'), month: value('month'), day: value('day') };
}

function zonedMinutes(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  return get('hour') * 60 + get('minute');
}

function offsetMs(date, timezone) {
  const { year, month, day } = zonedParts(date, timezone);
  const minutes = zonedMinutes(date, timezone);
  return Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60) - date.getTime();
}

/**
 * Convert wall-clock date parts + minutes to a real UTC instant in `timezone`.
 * @param {{year: number, month: number, day: number}} parts - Local calendar date.
 * @param {number} minutes - Minutes after local midnight.
 * @param {string} timezone - IANA timezone.
 * @returns {Date} UTC instant matching the requested wall clock.
 */
function zonedDateTimeToUtc(parts, minutes, timezone) {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, Math.floor(minutes / 60), minutes % 60);
  // Two passes: the first offset gets us close, the second corrects DST edges.
  let timestamp = guess - offsetMs(new Date(guess), timezone);
  timestamp = guess - offsetMs(new Date(timestamp), timezone);
  return new Date(timestamp);
}

function shiftDate(parts, days) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function formatDateKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function parseDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * Business date key ("YYYY-MM-DD") for an instant.
 * @param {object} settings - Shop settings with openTime/timezone.
 * @param {Date} [now] - Instant to classify.
 * @returns {string} Business date key.
 */
function getBusinessDateKey(settings, now = new Date()) {
  const shifted = new Date(now.getTime() - openMinutesOf(settings) * 60 * 1000);
  return formatDateKey(zonedParts(shifted, timezoneOf(settings)));
}

/**
 * Start instant (openTime) of a business date key.
 * @param {object} settings - Shop settings.
 * @param {string} dateKey - Business date key.
 * @returns {Date} UTC instant at local openTime on that date.
 */
function getBusinessDayStart(settings, dateKey) {
  const parts = parseDateKey(dateKey);
  if (!parts) return null;
  return zonedDateTimeToUtc(parts, openMinutesOf(settings), timezoneOf(settings));
}

/**
 * Business-day range covering the last `days` business days, ending with the one
 * that contains `now`. Half-open: [start, end).
 * @param {object} settings - Shop settings.
 * @param {Date} [now] - Reference instant.
 * @param {number} [days] - How many business days to include (1 = current day).
 * @returns {{businessDate: string, startKey: string, start: Date, end: Date, days: number}}
 */
function getBusinessDayRange(settings, now = new Date(), days = 1) {
  const count = Math.max(1, Number(days) || 1);
  const currentKey = getBusinessDateKey(settings, now);
  const currentParts = parseDateKey(currentKey);
  const startKey = formatDateKey(shiftDate(currentParts, -(count - 1)));
  const endKey = formatDateKey(shiftDate(currentParts, 1));
  return {
    businessDate: currentKey,
    startKey,
    start: getBusinessDayStart(settings, startKey),
    end: getBusinessDayStart(settings, endKey),
    days: count,
  };
}

/**
 * Range covering an inclusive span of business dates, e.g. a report filtered
 * "from 2026-10-01 to 2026-10-07" covers [open 10-01, open 10-08).
 * @param {object} settings - Shop settings.
 * @param {string} fromKey - First business date key.
 * @param {string} toKey - Last business date key.
 * @returns {{businessDate: string, startKey: string, start: Date, end: Date, days: number, dateKeys: string[]}}
 */
function getBusinessDayRangeForKeys(settings, fromKey, toKey) {
  const from = parseDateKey(fromKey);
  const to = parseDateKey(toKey);
  if (!from || !to) return null;
  const dateKeys = [];
  for (let cursor = from, guard = 0; guard < 400; guard += 1) {
    dateKeys.push(formatDateKey(cursor));
    if (formatDateKey(cursor) === formatDateKey(to)) break;
    cursor = shiftDate(cursor, 1);
  }
  return {
    businessDate: formatDateKey(to),
    startKey: formatDateKey(from),
    start: getBusinessDayStart(settings, formatDateKey(from)),
    end: getBusinessDayStart(settings, formatDateKey(shiftDate(to, 1))),
    days: dateKeys.length,
    dateKeys,
  };
}

/**
 * Business date keys for a range, oldest first (used for chart labels).
 * @param {object} settings - Shop settings.
 * @param {Date} [now] - Reference instant.
 * @param {number} [days] - Number of business days.
 * @returns {string[]} Date keys.
 */
function getBusinessDateKeys(settings, now = new Date(), days = 1) {
  const count = Math.max(1, Number(days) || 1);
  const currentParts = parseDateKey(getBusinessDateKey(settings, now));
  return Array.from({ length: count }, (_, index) => formatDateKey(shiftDate(currentParts, -(count - 1 - index))));
}

/**
 * When new queues stop being accepted for the business day containing `now`.
 * A cutoff earlier than openTime (e.g. 02:00 with a 10:30 open) belongs to the
 * next calendar day, the same way closeTime does.
 * @param {object} settings - Shop settings.
 * @param {Date} [now] - Reference instant.
 * @returns {Date} UTC instant of the queue cutoff.
 */
function getQueueCutoff(settings, now = new Date()) {
  const timezone = timezoneOf(settings);
  const open = openMinutesOf(settings);
  const cutoff = lastQueueMinutesOf(settings);
  const businessParts = parseDateKey(getBusinessDateKey(settings, now));
  const dayOffset = cutoff >= open ? 0 : 1;
  return zonedDateTimeToUtc(shiftDate(businessParts, dayOffset), cutoff, timezone);
}

/**
 * Whether the shop accepts new queue tickets right now.
 * Test mode and closing time are handled here so every caller agrees.
 * @param {object} settings - Shop settings document.
 * @param {Date} [now] - Reference instant.
 * @returns {{accepting: boolean, reason: string, businessDate: string, cutoffAt: Date, closesAt: Date|null}}
 */
function getQueueAcceptance(settings, now = new Date()) {
  const businessDate = settings ? getBusinessDateKey(settings, now) : null;
  const cutoffAt = settings ? getQueueCutoff(settings, now) : null;
  const status = settings ? getShopStatus(settings, now) : null;
  const base = {
    businessDate,
    cutoffAt,
    closesAt: (status && status.closesAt) || null,
  };
  if (settings && settings.isTestMode) return { ...base, accepting: false, reason: 'test_mode' };
  if (!status || !status.isOpen) return { ...base, accepting: false, reason: 'closed' };
  if (cutoffAt && now.getTime() >= cutoffAt.getTime()) return { ...base, accepting: false, reason: 'cutoff' };
  return { ...base, accepting: true, reason: 'open' };
}

module.exports = {
  DAY_MS,
  DEFAULT_CLOSE_TIME,
  DEFAULT_OPEN_TIME,
  DEFAULT_TIMEZONE,
  closeMinutesOf,
  formatDateKey,
  getBusinessDateKey,
  getBusinessDateKeys,
  getBusinessDayRange,
  getBusinessDayRangeForKeys,
  getBusinessDayStart,
  getQueueAcceptance,
  getQueueCutoff,
  lastQueueMinutesOf,
  openMinutesOf,
  parseDateKey,
  shiftDate,
  zonedDateTimeToUtc,
  timezoneOf,
};
