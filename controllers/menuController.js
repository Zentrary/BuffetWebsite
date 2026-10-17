// Import the menu model used by menu management endpoints.
const Menu = require('../models/Menu');

function validImageUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '/assets/images/default-food.jpg';
  if (url.startsWith('/assets/') || url.startsWith('/uploads/')) return url;
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '/assets/images/default-food.jpg'; } catch { return '/assets/images/default-food.jpg'; }
}

/**
 * Verify that the current request belongs to an administrator.
 * @param {import('express').Request} req - HTTP request.
 * @returns {boolean} True only for an authenticated admin.
 */
function isAdmin(req) {
  return Boolean(req.user && req.user.role === 'admin');
}

function menuResponse(menu) {
  const data = typeof menu.toObject === 'function' ? menu.toObject() : { ...menu };
  if (data.stockQuantity !== null && typeof data.stockQuantity !== 'undefined' && data.stockQuantity <= 0) {
    data.isAvailable = false;
  }
  return data;
}

function emitMenuStock(io, menu) {
  if (!io) return;
  const payload = {
    menuId: menu._id,
    stockQuantity: menu.stockQuantity,
    lowStockThreshold: menu.lowStockThreshold,
    maxOrderQuantity: menu.maxOrderQuantity,
    isAvailable: menu.isAvailable && (menu.stockQuantity === null || menu.stockQuantity > 0),
  };
  io.to('customer').emit('menu_stock_changed', payload);
  io.to('admin').emit('menu_stock_changed', payload);
}

/**
 * Retrieve menus with optional category and availability filters.
 * @param {import('express').Request} req - Request with optional category/isAvailable query.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with menu items.
 */
async function getAllMenus(req, res) {
  try {
    const filter = {};
    if (req.query.category) {
      const categories = String(req.query.category).split(',').map((category) => category.trim()).filter(Boolean);
      // ลบ allowedCategories ออกแล้ว เพื่อให้ค้นหาหมวดหมู่ที่แอดมินพิมพ์เองได้
      filter.category = categories.length === 1 ? categories[0] : { $in: categories };
    }
    if (req.query.isAvailable !== undefined) {
      if (!['true', 'false'].includes(req.query.isAvailable)) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_AVAILABILITY_FILTER',
          data: null,
          message: 'Invalid availability filter.',
        });
      }
      filter.isAvailable = req.query.isAvailable === 'true';
    }
    const menus = await Menu.find(filter).sort({ category: 1, name: 1 });
    return res.status(200).json({ success: true, data: menus.map(menuResponse), message: 'ดึงรายการเมนูสำเร็จ' });
  } catch (error) {
    console.error('Get menus failed:', error);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'Request failed.' });
  }
}

/**
 * Retrieve a menu item by its MongoDB identifier.
 * @param {import('express').Request} req - Request with menuId or id in route params.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the menu item.
 */
async function getMenuById(req, res) {
  try {
    const menu = await Menu.findById(req.params.menuId || req.params.id);
    if (!menu) {
      return res.status(404).json({ success: false, code: 'MENU_NOT_FOUND', data: null, message: 'Menu not found.' });
    }
    return res.status(200).json({ success: true, data: menuResponse(menu), message: 'ดึงข้อมูลเมนูสำเร็จ' });
  } catch (error) {
    console.error('Get menu failed:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'รูปแบบ ID ไม่ถูกต้อง' : 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

/**
 * Create a menu item; administrators and managers may use this endpoint.
 * @param {import('express').Request} req - Request with menu fields in its body.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the created menu.
 */
async function createMenu(req, res) {
  try {
    if (!req.user || !['admin', 'manager'].includes(req.user.role)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', data: null, message: 'You are not allowed to perform this action.' });
    }
    const menu = await Menu.create({
      name: req.body.name,
      description: req.body.description,
      price: req.body.price,
      category: req.body.category,
      imageUrl: validImageUrl(req.body.imageUrl),
      isAvailable: req.body.isAvailable,
      preparationTime: req.body.preparationTime,
      stockQuantity: req.body.stockQuantity,
      lowStockThreshold: req.body.lowStockThreshold,
      maxOrderQuantity: req.body.maxOrderQuantity,
    });
    emitMenuStock(req.app.get('io'), menu);
    return res.status(201).json({ success: true, data: menu, message: 'เพิ่มเมนูสำเร็จ' });
  } catch (error) {
    console.error('Create menu failed:', error);
    const status = error.name === 'ValidationError' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? error.message : 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

/**
 * Update a menu item; administrators and managers may use this endpoint.
 * @param {import('express').Request} req - Request with menu fields and menu ID.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the updated menu.
 */
async function updateMenu(req, res) {
  try {
    if (!req.user || !['admin', 'manager'].includes(req.user.role)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', data: null, message: 'You are not allowed to perform this action.' });
    }
    const menu = await Menu.findByIdAndUpdate(
      req.params.menuId || req.params.id,
      {
        name: req.body.name,
        description: req.body.description,
        price: req.body.price,
        category: req.body.category,
        imageUrl: validImageUrl(req.body.imageUrl),
        isAvailable: req.body.isAvailable,
        preparationTime: req.body.preparationTime,
        stockQuantity: req.body.stockQuantity,
        lowStockThreshold: req.body.lowStockThreshold,
        maxOrderQuantity: req.body.maxOrderQuantity,
      },
      { new: true, runValidators: true }
    );
    if (!menu) {
      return res.status(404).json({ success: false, code: 'MENU_NOT_FOUND', data: null, message: 'Menu item not found.' });
    }
    emitMenuStock(req.app.get('io'), menu);
    return res.status(200).json({ success: true, data: menuResponse(menu), message: 'แก้ไขเมนูสำเร็จ' });
  } catch (error) {
    console.error('Update menu failed:', error);
    const status = error.name === 'ValidationError' || error.name === 'CastError' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? error.message : 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

/**
 * Delete a menu item; only administrators may use this endpoint.
 * @param {import('express').Request} req - Request with menu ID in route params.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response confirming deletion.
 */
async function deleteMenu(req, res) {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', data: null, message: 'You are not allowed to perform this action.' });
    }
    const menu = await Menu.findByIdAndDelete(req.params.menuId || req.params.id);
    if (!menu) {
      return res.status(404).json({ success: false, code: 'MENU_NOT_FOUND', data: null, message: 'Menu item not found.' });
    }
    return res.status(200).json({ success: true, data: menu, message: 'ลบเมนูสำเร็จ' });
  } catch (error) {
    console.error('Delete menu failed:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'รูปแบบ ID ไม่ถูกต้อง' : 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

/**
 * Toggle menu availability and notify connected customers.
 * @param {import('express').Request} req - Request with menu ID in route params.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with updated availability.
 */
async function toggleAvailability(req, res) {
  try {
    const menu = await Menu.findById(req.params.menuId || req.params.id);
    if (!menu) {
      return res.status(404).json({ success: false, code: 'MENU_NOT_FOUND', data: null, message: 'Menu item not found.' });
    }
    if (!menu.isAvailable && menu.stockQuantity !== null && menu.stockQuantity <= 0) {
      return res.status(409).json({
        success: false,
        code: 'INSUFFICIENT_STOCK',
        data: null,
        message: `เมนู ${menu.name} หมดสต็อก กรุณาเติมจำนวนก่อนเปิดขาย`,
      });
    }

    menu.isAvailable = !menu.isAvailable;
    await menu.save();
    const io = req.app.get('io');
    if (io) {
      io.to('customer').emit('menu_availability_changed', {
        menuId: menu._id,
        isAvailable: menu.isAvailable && (menu.stockQuantity === null || menu.stockQuantity > 0),
      });
      emitMenuStock(io, menu);
    }
    return res.status(200).json({ success: true, data: menu, message: 'เปลี่ยนสถานะเมนูสำเร็จ' });
  } catch (error) {
    console.error('Toggle menu availability failed:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'รูปแบบ ID ไม่ถูกต้อง' : 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

// Export menu management handlers for route registration.
module.exports = { getAllMenus, getMenuById, createMenu, updateMenu, deleteMenu, toggleAvailability };