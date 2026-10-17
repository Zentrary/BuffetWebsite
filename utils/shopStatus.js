function parseTime(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function getMinutesInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  return get('hour') * 60 + get('minute');
}

function getDateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = (type) => Number(parts.find((part) => part.type === type).value);
  return { year: value('year'), month: value('month'), day: value('day') };
}

function timezoneOffsetMs(date, timezone) {
  const parts = getDateParts(date, timezone);
  const minutes = getMinutesInTimezone(date, timezone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, Math.floor(minutes / 60), minutes % 60) - date.getTime();
}

function nextClosingTime(settings, now = new Date()) {
  const close = parseTime(settings.closeTime);
  const open = parseTime(settings.openTime);
  if (close === null || open === null || close === open) return null;
  const timezone = settings.timezone || 'Asia/Bangkok';
  const local = getDateParts(now, timezone);
  const current = getMinutesInTimezone(now, timezone);
  const target = new Date(Date.UTC(local.year, local.month - 1, local.day, Math.floor(close / 60), close % 60));
  if ((open < close && current >= close) || (open > close && current >= close)) target.setUTCDate(target.getUTCDate() + 1);
  let timestamp = target.getTime();
  // Resolve the intended wall-clock time for the configured timezone (including DST zones).
  timestamp -= timezoneOffsetMs(new Date(timestamp), timezone);
  timestamp -= timezoneOffsetMs(new Date(timestamp), timezone) - timezoneOffsetMs(new Date(target.getTime()), timezone);
  return new Date(timestamp);
}

function isWithinSchedule(settings, now = new Date()) {
  const open = parseTime(settings.openTime);
  const close = parseTime(settings.closeTime);
  if (open === null || close === null || open === close) return false;
  const current = getMinutesInTimezone(now, settings.timezone);
  return open < close ? current >= open && current < close : current >= open || current < close;
}

function getShopStatus(settings, now = new Date()) {
  const scheduledOpen = isWithinSchedule(settings, now);
  return {
    isOpen: Boolean(settings.manualOpenAt) || scheduledOpen,
    scheduledOpen,
    isTestMode: Boolean(settings.isTestMode),
    closesAt: nextClosingTime(settings, now),
  };
}

module.exports = { parseTime, isWithinSchedule, getShopStatus, nextClosingTime };
