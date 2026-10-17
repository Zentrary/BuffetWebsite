const ShopSettings = require('../models/ShopSettings');
const { getShopStatus } = require('../utils/shopStatus');

let interval;

async function reconcileShopSchedule(io, now = new Date()) {
  const settings = await ShopSettings.findById('shop-settings');
  if (!settings) return null;
  const before = Boolean(settings.manualOpenAt) || Boolean(settings.lastAutomaticOpenDate);
  const status = getShopStatus(settings, now);
  // The persisted manual marker is only valid through this schedule window.
  if (settings.manualOpenAt && status.scheduledOpen && !settings.manualOpenSawScheduledWindow) {
    settings.manualOpenSawScheduledWindow = true;
    await settings.save();
  }
  if (settings.manualOpenAt && settings.manualOpenSawScheduledWindow && !status.scheduledOpen) {
    settings.manualOpenAt = null;
    settings.manualOpenSawScheduledWindow = false;
    settings.lastAutomaticCloseDate = now.toISOString();
    await settings.save();
    if (io) io.to('admin').emit('shop_status_changed', getShopStatus(settings, now));
    return getShopStatus(settings, now);
  }
  if (status.scheduledOpen && !settings.lastAutomaticOpenDate) {
    settings.lastAutomaticOpenDate = now.toISOString();
    await settings.save();
    if (io) io.to('admin').to('customer').emit('shop_status_changed', getShopStatus(settings, now));
  }
  if (!status.scheduledOpen && settings.lastAutomaticOpenDate && !settings.manualOpenAt) {
    settings.lastAutomaticOpenDate = null;
    settings.lastAutomaticCloseDate = now.toISOString();
    await settings.save();
    if (io && before) io.to('admin').to('customer').emit('shop_status_changed', getShopStatus(settings, now));
  }
  return getShopStatus(settings, now);
}

function startShopSchedule(io) {
  if (interval) clearInterval(interval);
  interval = setInterval(() => reconcileShopSchedule(io).catch((error) => console.error('Shop schedule failed:', error)), 30_000);
  if (typeof interval.unref === 'function') interval.unref();
  reconcileShopSchedule(io).catch((error) => console.error('Initial shop schedule failed:', error));
}

module.exports = { reconcileShopSchedule, startShopSchedule };
