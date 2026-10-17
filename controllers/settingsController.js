const ShopSettings = require('../models/ShopSettings');
const { parseTime, getShopStatus } = require('../utils/shopStatus');

async function loadSettings() {
  return ShopSettings.findByIdAndUpdate(
    'shop-settings',
    { $setOnInsert: { _id: 'shop-settings' } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
}

function output(settings) {
  return { ...settings.toObject(), status: getShopStatus(settings) };
}

async function getSettings(req, res, next) {
  try { return res.json({ success: true, data: output(await loadSettings()) }); } catch (error) { return next(error); }
}

async function getPublicSettings(req, res, next) {
  try {
    const settings = await loadSettings();
    return res.json({ success: true, data: {
      restaurantName: settings.restaurantName,
      welcomeMessage: settings.welcomeMessage,
      phone: settings.phone,
      address: settings.address,
      logoUrl: settings.logoUrl,
      heroImageUrl: settings.heroImageUrl,
      diningDurationMinutes: settings.diningDurationMinutes,
      vatPercent: settings.vatPercent,
      serviceChargePercent: settings.serviceChargePercent,
      vatMode: settings.vatMode,
      serviceChargeMode: settings.serviceChargeMode,
    } });
  } catch (error) { return next(error); }
}

function clampPercent(value, fallback, max = 30) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(num, 0), max);
}

async function updateSettings(req, res, next) {
  try {
    const {
      openTime, closeTime, isTestMode, restaurantName, welcomeMessage, phone, address,
      diningDurationMinutes, logoUrl, heroImageUrl,
      vatPercent, serviceChargePercent, vatMode, serviceChargeMode, paymentQrImageUrl,
    } = req.body;

    if (parseTime(openTime) === null || parseTime(closeTime) === null || openTime === closeTime) {
      return res.status(400).json({ success: false, code: 'INVALID_SHOP_TIME', message: 'เวลาเปิดและปิดต้องเป็น HH:MM และต้องไม่เท่ากัน' });
    }

    const settings = await loadSettings();
    settings.openTime = openTime;
    settings.closeTime = closeTime;
    settings.isTestMode = Boolean(isTestMode);
    settings.restaurantName = String(restaurantName || '').trim() || 'Smart Queue';
    settings.welcomeMessage = String(welcomeMessage || '').trim();
    settings.phone = String(phone || '').trim();
    settings.address = String(address || '').trim();
    settings.diningDurationMinutes = Number(diningDurationMinutes) || 90;
    settings.logoUrl = validImageUrl(logoUrl) || '/assets/images/logo.png';
    settings.heroImageUrl = validImageUrl(heroImageUrl);

    // Billing policy — values are clamped to safe ranges and modes validated.
    settings.vatPercent = clampPercent(vatPercent, settings.vatPercent ?? 7);
    settings.serviceChargePercent = clampPercent(serviceChargePercent, settings.serviceChargePercent ?? 10);
    settings.vatMode = vatMode === 'excluded' ? 'excluded' : 'included';
    settings.serviceChargeMode = serviceChargeMode === 'excluded' ? 'excluded' : 'included';
    if (paymentQrImageUrl !== undefined) {
      settings.paymentQrImageUrl = validImageUrl(paymentQrImageUrl) || settings.paymentQrImageUrl;
    }

    await settings.save();
    req.app.get('io').to('admin').to('customer').emit('shop_status_changed', getShopStatus(settings));
    return res.json({ success: true, data: output(settings), message: 'บันทึกการตั้งค่าร้านแล้ว' });
  } catch (error) { return next(error); }
}

function validImageUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (url.startsWith('/assets/') || url.startsWith('/uploads/')) return url;
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : ''; } catch { return ''; }
}

async function uploadShopImage(req, res) {
  if (!req.file) return res.status(400).json({ success: false, code: 'INVALID_IMAGE', message: 'รองรับเฉพาะ JPG, PNG, WEBP หรือ GIF ขนาดไม่เกิน 5 MB' });
  return res.status(201).json({ success: true, data: { imageUrl: `/uploads/${req.file.filename}` } });
}

async function openShopEarly(req, res, next) {
  try {
    const settings = await loadSettings();
    const status = getShopStatus(settings);
    if (status.isOpen) return res.status(409).json({ success: false, code: 'SHOP_ALREADY_OPEN', message: 'ร้านเปิดให้บริการอยู่แล้ว' });
    settings.manualOpenAt = new Date();
    settings.manualOpenSawScheduledWindow = status.scheduledOpen;
    await settings.save();
    req.app.get('io').to('admin').to('customer').emit('shop_status_changed', getShopStatus(settings));
    return res.json({ success: true, data: output(settings), message: 'เปิดร้านก่อนเวลาตามที่ยืนยันแล้ว' });
  } catch (error) { return next(error); }
}

async function getFavicon(req, res) {
  try {
    const settings = await loadSettings();
    const target = (settings && settings.logoUrl) || '/assets/images/favicon.png';
    res.set('Cache-Control', 'public, max-age=60');
    return res.redirect(302, target);
  } catch (error) {
    return res.redirect(302, '/assets/images/favicon.png');
  }
}

module.exports = { getPublicSettings, getSettings, updateSettings, openShopEarly, uploadShopImage, getFavicon };