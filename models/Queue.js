// Import Mongoose to define queue entries and their table/session references.
const mongoose = require('mongoose');

// Define customer queue entries and the lifecycle timestamps for each entry.
const queueSchema = new mongoose.Schema(
  {
    queueNumber: {
      type: String,
      required: true,
      unique: true,
      match: /^Q\d{3,}$/,
    },
    customerCount: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },
    customerName: {
      type: String,
      trim: true,
    },
    customerPhone: {
      type: String,
      trim: true,
    },
    accessTokenHash: {
      type: String,
      select: false,
    },
    // `completed` closes the lifecycle of a seated queue (paid, table cleared or
    // closed by staff) so it stops appearing as an active "seated" card forever.
    status: {
      type: String,
      enum: ['waiting', 'called', 'seated', 'completed', 'cancelled', 'no_show'],
      default: 'waiting',
    },
    preferredZone: {
      type: String,
      enum: ['small', 'medium', 'large'],
      default: null,
    },
    preferredTableId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Table',
      default: null,
    },
    autoAssign: {
      type: Boolean,
      default: true,
    },
    assignedTableId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Table',
      default: null,
    },
    assignmentNote: {
      type: String,
      default: '',
    },
    qrCodeData: {
      type: String,
    },
    calledAt: {
      type: Date,
    },
    seatedAt: {
      type: Date,
    },
    completedAt: {
      type: Date,
    },
    noShowAt: {
      type: Date,
    },
    tableId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Table',
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
    },
  },
  {
    // Let Mongoose manage createdAt and updatedAt automatically.
    timestamps: true,
  }
);

queueSchema.index({ accessTokenHash: 1 }, { unique: true, sparse: true });
queueSchema.index({ status: 1, createdAt: 1 });
queueSchema.index({ status: 1, seatedAt: 1 });
queueSchema.index({ preferredZone: 1, status: 1 });

// Export the Queue model for use by application modules.
module.exports = mongoose.model('Queue', queueSchema);