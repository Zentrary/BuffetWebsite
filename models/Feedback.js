// Import Mongoose to define feedback and its session/table references.
const mongoose = require('mongoose');

// Define customer feedback submitted for a completed dine-in session.
const feedbackSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
      required: true,
    },
    tableId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Table',
    },
    rating: {
      type: Number,
      min: 1,
      max: 5,
      required: true,
    },
    comment: {
      type: String,
      trim: true,
    },
  },
  {
    // Let Mongoose manage createdAt and updatedAt automatically.
    timestamps: true,
  }
);

// Export the Feedback model for use by application modules.
module.exports = mongoose.model('Feedback', feedbackSchema);
