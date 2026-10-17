// Import Mongoose to define order documents and their embedded line items.
const mongoose = require('mongoose');

// Define individual items ordered by a dine-in session.
const orderItemSchema = new mongoose.Schema({
  menuId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Menu',
  },
  name: {
    type: String,
  },
  price: {
    type: Number,
    min: 0,
  },
  quantity: {
    type: Number,
    min: 1,
  },
  note: {
    type: String,
  },
  itemStatus: {
    type: String,
    enum: ['pending', 'accepted', 'cooking', 'ready', 'served', 'cancelled'],
    default: 'pending',
  },
});

const stockDeductionSchema = new mongoose.Schema({
  menuId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Menu',
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    min: 1,
  },
}, { _id: false });

// Define order documents, their items, and the preparation lifecycle.
const orderSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
      required: true,
    },
    tableId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Table',
      required: true,
    },
    items: {
      type: [orderItemSchema],
      default: [],
    },
    stockDeductions: {
      type: [stockDeductionSchema],
      default: [],
    },
    totalPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'cooking', 'ready', 'served', 'paid', 'cancelled'],
      default: 'pending',
    },
    acceptedAt: {
      type: Date,
    },
    cookingAt: {
      type: Date,
    },
    readyAt: {
      type: Date,
    },
    servedAt: {
      type: Date,
    },
  },
  {
    // Let Mongoose manage createdAt and updatedAt automatically.
    timestamps: true,
  }
);

// Export the Order model for use by application modules.
module.exports = mongoose.model('Order', orderSchema);
