// Import Mongoose to define dine-in sessions and their related documents.
const mongoose = require('mongoose');

// Define a customer's active or completed dine-in session at a table.
const sessionSchema = new mongoose.Schema(
  {
    queueId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Queue',
      required: true,
    },
    tableId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Table',
      required: true,
    },
    startTime: {
      type: Date,
      default: Date.now,
    },
    endTime: {
      type: Date,
      required: true,
    },
    actualEndTime: {
      type: Date,
    },
    checkoutRequestedAt: {
      type: Date,
    },
    status: {
      type: String,
      enum: ['active', 'completed', 'expired', 'cancelled'],
      default: 'active',
    },
    subtotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    serviceCharge: {
      type: Number,
      default: 0,
      min: 0,
    },
    vat: {
      type: Number,
      default: 0,
      min: 0,
    },
    discount: {
      type: Number,
      default: 0,
      min: 0,
    },
    grandTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    isPaid: {
      type: Boolean,
      default: false,
    },
    paidAt: {
      type: Date,
    },
    // Optional SQL Membership & Loyalty reference fields linked at checkout.
    memberId: {
      type: Number,
      default: null,
    },
    memberPhone: {
      type: String,
      default: '',
    },
    memberName: {
      type: String,
      default: '',
    },
    memberTierName: {
      type: String,
      default: '',
    },
    benefitType: {
      type: String,
      enum: ['', 'NONE', 'TIER', 'PROMO'],
      default: '',
    },
    appliedPromotionId: {
      type: Number,
      default: null,
    },
    appliedPromoCode: {
      type: String,
      default: '',
    },
    appliedPromoTitle: {
      type: String,
      default: '',
    },
    pointsToRedeem: {
      type: Number,
      default: 0,
      min: 0,
    },
    pointsEarned: {
      type: Number,
      default: 0,
      min: 0,
    },
    loyaltyProcessedAt: {
      type: Date,
      default: null,
    },
  },
  {
    // Let Mongoose manage createdAt and updatedAt automatically.
    timestamps: true,
  }
);

// Export the Session model for use by application modules.
module.exports = mongoose.model('Session', sessionSchema);
