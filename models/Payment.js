// Import Mongoose to define payments and their session/user references.
const mongoose = require('mongoose');

// Define a payment recorded against a dine-in session.
const paymentSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    method: {
      type: String,
      enum: ['cash', 'qr_payment'],
      default: 'cash',
    },
    cashReceived: {
      type: Number,
      min: 0,
    },
    changeDue: {
      type: Number,
      min: 0,
      default: 0,
    },
    status: {
      type: String,
      // awaiting_confirmation: QR shown to customer, waiting for staff to verify slip.
      enum: ['awaiting_confirmation', 'pending', 'completed', 'failed'],
      default: 'pending',
    },
    paidAt: {
      type: Date,
    },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    confirmedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    confirmedAt: {
      type: Date,
    },
    note: {
      type: String,
      default: '',
    },
  },
  {
    // Let Mongoose manage createdAt and updatedAt automatically.
    timestamps: true,
  }
);

module.exports = mongoose.model('Payment', paymentSchema);