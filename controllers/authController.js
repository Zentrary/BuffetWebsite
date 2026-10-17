// Import authentication dependencies and the staff account model.
const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Create a staff account; this endpoint must be mounted behind admin authorization.
 * @param {import('express').Request} req - HTTP request with user fields in its body.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the created user.
 */
async function register(req, res) {
  try {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', data: null, message: 'You are not allowed to perform this action.' });
    }

    const { username, password, fullName, role } = req.body;
    const user = await User.create({ username, password, fullName, role });
    const userData = user.toObject();
    delete userData.password;

    return res.status(201).json({ success: true, data: userData, message: 'สร้างบัญชีผู้ใช้สำเร็จ' });
  } catch (error) {
    console.error('Register failed:', error);
    const status = error.code === 11000 ? 400 : error.name === 'ValidationError' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: status === 400 ? 'INVALID_REQUEST' : 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'Invalid staff account details.' : 'Request failed.',
    });
  }
}

/**
 * Verify credentials and return an eight-hour JWT.
 * @param {import('express').Request} req - HTTP request with username and password.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with token and user details.
 */
async function login(req, res) {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });

    if (!user || !await user.comparePassword(password)) {
      return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', data: null, message: 'Invalid username or password.' });
    }
    if (!user.isActive) {
      return res.status(403).json({ success: false, code: 'ACCOUNT_DISABLED', data: null, message: 'This account is disabled.' });
    }
    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET is not configured.');
    }

    const token = jwt.sign(
      { id: user._id.toString(), username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    return res.status(200).json({
      success: true,
      data: {
        token,
        user: {
          id: user._id,
          username: user.username,
          fullName: user.fullName,
          role: user.role,
        },
      },
      message: 'เข้าสู่ระบบสำเร็จ',
    });
  } catch (error) {
    console.error('Login failed:', error);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'Request failed.' });
  }
}

/**
 * Return the currently authenticated account without its password hash.
 * @param {import('express').Request} req - Authenticated HTTP request.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the current user.
 */
async function getMe(req, res) {
  try {
    const userId = req.user && (req.user.id || req.user._id);
    const user = userId ? await User.findById(userId).select('-password') : null;

    if (!user) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', data: null, message: 'User not found.' });
    }
    return res.status(200).json({ success: true, data: user, message: 'ดึงข้อมูลผู้ใช้สำเร็จ' });
  } catch (error) {
    console.error('Get current user failed:', error);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'Request failed.' });
  }
}

/**
 * List staff accounts without exposing password hashes.
 * @param {import('express').Request} req - Authenticated administrator request.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response containing staff accounts.
 */
async function getStaff(req, res) {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    return res.status(200).json({ success: true, data: users, message: 'ดึงรายชื่อพนักงานสำเร็จ' });
  } catch (error) {
    console.error('Get staff failed:', error);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'Request failed.' });
  }
}

/**
 * Update a staff profile and hash a replacement password when one is supplied.
 * @param {import('express').Request} req - Request with staff ID and editable profile fields.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the updated staff member.
 */
async function updateStaff(req, res) {
  try {
    const allowedFields = ['username', 'password', 'fullName', 'role', 'isActive'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([key]) => allowedFields.includes(key))
    );
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', data: null, message: 'User not found.' });
    }
    Object.assign(user, updates);
    await user.save();
    const userData = user.toObject();
    delete userData.password;
    return res.status(200).json({ success: true, data: userData, message: 'แก้ไขข้อมูลพนักงานสำเร็จ' });
  } catch (error) {
    console.error('Update staff failed:', error);
    const status = error.name === 'ValidationError' || error.name === 'CastError' || error.code === 11000 ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: status === 400 ? 'INVALID_REQUEST' : 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'Invalid staff account details.' : 'Request failed.',
    });
  }
}

/**
 * Delete a staff account without allowing an administrator to delete themselves.
 * @param {import('express').Request} req - Request with staff ID in route params.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response confirming deletion.
 */
async function deleteStaff(req, res) {
  try {
    const currentUserId = req.user && (req.user.id || req.user._id);
    if (String(currentUserId) === String(req.params.id)) {
      return res.status(400).json({ success: false, code: 'SELF_DELETE_NOT_ALLOWED', data: null, message: 'You cannot delete your own account.' });
    }
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', data: null, message: 'User not found.' });
    }
    return res.status(200).json({ success: true, data: { id: user._id }, message: 'ลบบัญชีพนักงานสำเร็จ' });
  } catch (error) {
    console.error('Delete staff failed:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: status === 400 ? 'INVALID_REQUEST' : 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'Invalid ID.' : 'Request failed.',
    });
  }
}

// Export controller handlers for authentication routes.
module.exports = { register, login, getMe, getStaff, updateStaff, deleteStaff };
