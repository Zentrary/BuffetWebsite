// Import Mongoose for the user schema and bcryptjs for secure password hashing.
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Define staff accounts and their permitted application roles.
const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
    },
    fullName: {
      type: String,
      trim: true,
    },
    role: {
      type: String,
      enum: ['admin', 'manager', 'kitchen', 'waiter'],
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    // Let Mongoose manage createdAt and updatedAt automatically.
    timestamps: true,
  }
);

// Hash new or changed passwords before saving a user document.
userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) {
    return;
  }

  this.password = await bcrypt.hash(this.password, 12);
});

// Compare a candidate password with the stored bcrypt hash.
userSchema.methods.comparePassword = async function comparePassword(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Export the User model for use by application modules.
module.exports = mongoose.model('User', userSchema);
