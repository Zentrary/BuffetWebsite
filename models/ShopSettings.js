const mongoose = require('mongoose');

// A singleton document holding the public opening policy for the restaurant.
const shopSettingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'shop-settings' },
  openTime: { type: String, default: '10:30', match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  closeTime: { type: String, default: '03:00', match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  // New queue tickets stop at `lastQueueTime` (business day), which is usually
  // earlier than `closeTime` so the kitchen stops taking tables before closing.
  lastQueueTime: { type: String, default: '02:00', match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  timezone: { type: String, default: 'Asia/Bangkok' },
  isTestMode: { type: Boolean, default: false },
  manualOpenAt: { type: Date, default: null },
  manualOpenSawScheduledWindow: { type: Boolean, default: false },
  lastAutomaticOpenDate: { type: String, default: null },
  lastAutomaticCloseDate: { type: String, default: null },
  restaurantName: { type: String, default: 'Smart Queue', trim: true, maxlength: 120 },
  welcomeMessage: { type: String, default: '', trim: true, maxlength: 500 },
  phone: { type: String, default: '', trim: true, maxlength: 40 },
  address: { type: String, default: '', trim: true, maxlength: 500 },
  diningDurationMinutes: { type: Number, default: 90, min: 1, max: 1440 },
  logoUrl: { type: String, default: '/assets/images/logo.png' },
  heroImageUrl: { type: String, default: '' },
  // Billing policy — vatMode and serviceChargeMode control whether the
  // displayed menu price already contains the charge (included) or it is
  // added on top at checkout (excluded).
  vatPercent: { type: Number, default: 7, min: 0, max: 30 },
  serviceChargePercent: { type: Number, default: 10, min: 0, max: 30 },
  vatMode: { type: String, enum: ['included', 'excluded'], default: 'included' },
  serviceChargeMode: { type: String, enum: ['included', 'excluded'], default: 'included' },
  // QR image shown to the customer during checkout. Admin uploads via settings.
  paymentQrImageUrl: { type: String, default: '/assets/images/payment/promptpay.png' },
}, { timestamps: true, versionKey: false });

module.exports = mongoose.model('ShopSettings', shopSettingsSchema);