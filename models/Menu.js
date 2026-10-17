// Import Mongoose to define menu items and validate their categories.
const mongoose = require('mongoose');

// Define food and drink offered by the restaurant.
const menuSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    category: {
      type: String,
      enum: [
        // อัปเดตหมวดหมู่ใหม่ทั้ง 14 หมวด
        'set_menu',
        'sukiyaki_hotpan',
        'sushi_roll',
        'japanese_main',
        'chinese_stirfry',
        'fried_appetizer',
        'salad_yum',
        'fresh_meat',
        'fresh_seafood',
        'vegetable_tofu',
        'noodle_rice_side',
        'soup_sauce',
        'dessert',
        'drink',
        // เก็บของเก่าไว้เผื่อมีข้อมูลเดิมใน DB (ถ้าไม่ต้องการลบออกได้ครับ)
        'appetizer', 'main', 'side', 'meat', 'seafood', 'vegetable', 'noodle', 'soup', 'sauce'
      ],
      required: true,
    },
    imageUrl: {
      type: String,
      default: '/assets/images/default-food.jpg',
    },
    isAvailable: {
      type: Boolean,
      default: true,
    },
    preparationTime: {
      type: Number,
      default: 10,
      min: 0,
    },
    stockQuantity: {
      type: Number,
      default: null,
      min: 0,
      validate: {
        validator: (value) => value === null || Number.isInteger(value),
        message: 'จำนวนคงเหลือต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป',
      },
    },
    lowStockThreshold: {
      type: Number,
      default: 5,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'จำนวนแจ้งเตือนใกล้หมดต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป',
      },
    },
    maxOrderQuantity: {
      type: Number,
      default: 99,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: 'จำนวนสั่งสูงสุดต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป',
      },
    },
  },
  {
    // Let Mongoose manage createdAt and updatedAt automatically.
    timestamps: true,
  }
);

// Export the Menu model for use by application modules.
module.exports = mongoose.model('Menu', menuSchema);