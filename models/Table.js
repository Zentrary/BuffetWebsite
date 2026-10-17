// Import Mongoose to define table fields and references.
const mongoose = require('mongoose');

// Zone definitions shared across the application.
const ZONE_ENUM = ['small', 'medium', 'large'];

// Define restaurant tables, their locations, availability, and active session.
const tableSchema = new mongoose.Schema(
  {
    tableNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    capacity: {
      type: Number,
      required: true,
      min: 1,
    },
    minCapacity: {
      type: Number,
      default: 1,
      min: 1,
    },
    zone: {
      type: String,
      enum: ZONE_ENUM,
      default: 'small',
    },
    status: {
      type: String,
      enum: ['available', 'reserved', 'occupied', 'cleaning'],
      default: 'available',
    },
    currentSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
      default: null,
    },
    reservedForQueueId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Queue',
      default: null,
    },
    lastSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
      default: null,
    },
  },
  {
    // Let Mongoose manage createdAt and updatedAt automatically.
    timestamps: true,
  }
);

tableSchema.index({ zone: 1, status: 1 });
tableSchema.index({ minCapacity: 1, capacity: 1 });

// Export the Table model and shared enum for use by application modules.
module.exports = mongoose.model('Table', tableSchema);
module.exports.ZONE_ENUM = ZONE_ENUM;