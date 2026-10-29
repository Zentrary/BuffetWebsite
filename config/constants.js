const { MENU_CATEGORIES, LEGACY_MENU_CATEGORIES, ALL_MENU_CATEGORIES } = require('./menuCategories');

function getNumberFromEnv(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === '') return fallback;
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : fallback;
}

// These values are shared by session creation and billing logic. They can be
// overridden with deployment environment variables (including Vercel).
const SESSION_DURATION = getNumberFromEnv('SESSION_DURATION_MINUTES', 90);
const SERVICE_CHARGE = getNumberFromEnv('SERVICE_CHARGE_PERCENT', 10);
const VAT = getNumberFromEnv('VAT_PERCENT', 7);

module.exports = {
  MENU_CATEGORIES,
  LEGACY_MENU_CATEGORIES,
  ALL_MENU_CATEGORIES,
  SESSION_DURATION,
  SERVICE_CHARGE,
  VAT,
};
