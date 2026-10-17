// Import order models and the kitchen notification formatter.
const Order = require('../models/Order');
const Menu = require('../models/Menu');
const Session = require('../models/Session');
const { formatOrderForKitchen } = require('../utils/notification');
const { decrementStockForItems, restoreStockDeductions } = require('../utils/inventory');

const ORDER_STATUSES = ['pending', 'accepted', 'cooking', 'ready', 'served', 'paid', 'cancelled'];
const ITEM_STATUSES = ['pending', 'accepted', 'cooking', 'ready', 'served', 'cancelled'];
const STATUS_TRANSITIONS = {
  pending: 'accepted',
  accepted: 'cooking',
  cooking: 'ready',
  ready: 'served',
};

function emitStockChanges(io, stockChanges) {
  if (!io) return;
  for (const change of stockChanges) {
    const payload = {
      menuId: change.menuId,
      name: change.name,
      stockQuantity: change.stockQuantity,
      lowStockThreshold: change.lowStockThreshold,
      isAvailable: change.isAvailable,
    };
    io.to('customer').emit('menu_stock_changed', payload);
    io.to('admin').emit('menu_stock_changed', payload);
    io.to('kitchen').emit('menu_stock_changed', payload);
  }
}

/**
 * Create an order from currently available menu items in an active session.
 * @param {import('express').Request} req - Request containing sessionId and items.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the new order ID.
 */
async function createOrder(req, res) {
  try {
    const { sessionId, items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'กรุณาระบุรายการอาหาร' });
    }

    const session = await Session.findById(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, code: 'SESSION_NOT_FOUND', data: null, message: 'Session not found.' });
    }
    if (session.status !== 'active' || new Date() > session.endTime) {
      return res.status(400).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'เซสชันนี้สิ้นสุดแล้ว' });
    }
    if (session.checkoutRequestedAt || session.isPaid) {
      return res.status(409).json({
        success: false,
        code: 'CHECKOUT_IN_PROGRESS',
        data: null,
        message: 'รอบนี้แจ้งจบมื้อแล้ว ไม่สามารถสั่งอาหารเพิ่มได้',
      });
    }

    const menuIds = items.map((item) => item.menuId);
    const seenMenuIds = new Set();
    for (const item of items) {
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        return res.status(400).json({ success: false, code: 'INVALID_ORDER_QUANTITY', data: null, message: 'จำนวนสินค้าต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป' });
      }
      const menuId = String(item.menuId);
      if (seenMenuIds.has(menuId)) {
        return res.status(400).json({ success: false, code: 'DUPLICATE_MENU_ITEM', data: null, message: 'พบเมนูซ้ำในออเดอร์ กรุณารวมจำนวนของเมนูเดียวกัน' });
      }
      seenMenuIds.add(menuId);
    }
    const menus = await Menu.find({ _id: { $in: menuIds } });
    const menuById = new Map(menus.map((menu) => [menu._id.toString(), menu]));

    // Use prices from the database rather than trusting client-supplied amounts.
    const orderItems = [];
    for (const item of items) {
      const menu = menuById.get(String(item.menuId));
      if (!menu) {
        return res.status(400).json({
          success: false,
          code: 'MENU_NOT_FOUND',
          data: null,
          message: `ไม่พบเมนู (${item.menuId})`,
        });
      }
      if (!menu.isAvailable) {
        return res.status(409).json({
          success: false,
          code: 'MENU_UNAVAILABLE',
          data: null,
          message: `เมนู ${menu.name} ปิดขายอยู่`,
        });
      }
      if (item.quantity > menu.maxOrderQuantity) {
        return res.status(409).json({
          success: false,
          code: 'MAX_ORDER_QUANTITY_EXCEEDED',
          data: null,
          message: `เมนู ${menu.name} สั่งได้ไม่เกิน ${menu.maxOrderQuantity} ต่อออเดอร์`,
        });
      }
      if (menu.stockQuantity !== null && typeof menu.stockQuantity !== 'undefined'
        && item.quantity > menu.stockQuantity) {
        return res.status(409).json({
          success: false,
          code: 'INSUFFICIENT_STOCK',
          data: null,
          message: `เมนู ${menu.name} เหลือ ${menu.stockQuantity} เท่านั้น`,
        });
      }
      orderItems.push({
        menuId: menu._id,
        name: menu.name,
        price: menu.price,
        quantity: item.quantity,
        note: item.note || '',
      });
    }

    const totalPrice = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const order = await Order.create({
      sessionId: session._id,
      tableId: session.tableId,
      items: orderItems,
      totalPrice,
      status: 'pending',
    });
    const io = req.app.get('io');
    if (io) {
      io.to('kitchen').emit('new_order', formatOrderForKitchen(order));
    }

    return res.status(201).json({
      success: true,
      data: { orderId: order._id, order },
      message: 'สร้างออเดอร์สำเร็จ',
    });
  } catch (error) {
    console.error('Create order failed:', error);
    const status = error.name === 'CastError' || error.name === 'ValidationError' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? error.message : 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

/**
 * Retrieve a single order by its identifier.
 * @param {import('express').Request} req - Request with orderId or id in route params.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the order.
 */
async function getOrderById(req, res) {
  try {
    const order = await Order.findById(req.params.orderId || req.params.id)
      .populate('items.menuId')
      .populate('tableId');
    if (!order) {
      return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', data: null, message: 'Order not found.' });
    }
    return res.status(200).json({ success: true, data: order, message: 'ดึงข้อมูลออเดอร์สำเร็จ' });
  } catch (error) {
    console.error('Get order failed:', error);
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
 * Retrieve every order belonging to a session.
 * @param {import('express').Request} req - Request with sessionId in route params or query.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with session orders.
 */
async function getOrdersBySession(req, res) {
  try {
    const sessionId = req.params.sessionId || req.query.sessionId;
    const orders = await Order.find({ sessionId }).populate('items.menuId').sort({ createdAt: 1 });
    return res.status(200).json({ success: true, data: orders, message: 'ดึงออเดอร์ของเซสชันสำเร็จ' });
  } catch (error) {
    console.error('Get session orders failed:', error);
    const status = error.name === 'CastError' ? 400 : 500;
               emitStockChanges(io, stockChanges);
    return res.status(status).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'รูปแบบ ID ไม่ถูกต้อง' : 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

/**
 * Retrieve staff-visible orders filtered by one or more workflow statuses.
 * @param {import('express').Request} req - Request with an optional comma-separated status query.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with populated orders.
 */
async function getOrdersForStaff(req, res) {
  try {
    const requestedStatuses = req.query.status
      ? String(req.query.status).split(',').map((status) => status.trim())
      : ['pending', 'accepted', 'cooking', 'ready'];
    const validStatuses = ['pending', 'accepted', 'cooking', 'ready', 'served'];
    if (
      requestedStatuses.length === 0
      || requestedStatuses.some((status) => !validStatuses.includes(status))
    ) {
      return res.status(400).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'ตัวกรองสถานะออเดอร์ไม่ถูกต้อง' });
    }

    const orders = await Order.find({ status: { $in: requestedStatuses } })
      .populate('tableId')
      .populate('items.menuId')
      .sort({ createdAt: 1 });
    return res.status(200).json({ success: true, data: orders, message: 'ดึงรายการออเดอร์สำเร็จ' });
  } catch (error) {
    console.error('Get staff orders failed:', error);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'Request failed.' });
  }
}

/**
 * Advance an order through the kitchen state machine and notify staff/customer rooms.
 * @param {import('express').Request} req - Request containing orderId and newStatus.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the updated order.
 */
async function updateOrderStatus(req, res) {
  let pendingDeductions = [];
  try {
    const orderId = req.body.orderId || req.params.orderId || req.params.id;
    const { newStatus } = req.body;
    if (!ORDER_STATUSES.includes(newStatus)) {
      return res.status(400).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'สถานะออเดอร์ไม่ถูกต้อง' });
    }

    let order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', data: null, message: 'Order not found.' });
    }
    if (STATUS_TRANSITIONS[order.status] !== newStatus) {
      return res.status(400).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'ไม่สามารถเปลี่ยนสถานะออเดอร์ในลำดับนี้ได้' });
    }

    const timestampFields = {
      accepted: 'acceptedAt',
      cooking: 'cookingAt',
      ready: 'readyAt',
      served: 'servedAt',
    };
    const updateSet = {
      status: newStatus,
      [timestampFields[newStatus]]: new Date(),
    };
    let stockChanges = [];
    if (newStatus === 'accepted') {
      const inventory = await decrementStockForItems(order.items);
      pendingDeductions = inventory.deductions;
      stockChanges = inventory.changes;
      updateSet.stockDeductions = pendingDeductions;
    }
    const updatedOrder = await Order.findOneAndUpdate(
      { _id: order._id, status: order.status, __v: order.__v },
      { $set: updateSet, $inc: { __v: 1 } },
      { new: true }
    );
    if (!updatedOrder) {
      if (pendingDeductions.length > 0) {
        const restoredChanges = await restoreStockDeductions(pendingDeductions);
        emitStockChanges(req.app.get('io'), restoredChanges);
        pendingDeductions = [];
      }
      return res.status(409).json({
        success: false,
        code: 'ORDER_STATE_CHANGED',
        data: null,
        message: 'สถานะออเดอร์เปลี่ยนไปแล้ว กรุณาโหลดรายการใหม่',
      });
    }
    order = updatedOrder;
    pendingDeductions = [];

    const io = req.app.get('io');
    if (io) {
      const payload = { orderId: order._id, sessionId: order.sessionId, status: order.status };
      io.to(`customer_${order.sessionId}`).emit('order_status_changed', payload);
      io.to('waiter').emit('order_status_changed', payload);
      if (newStatus === 'ready') {
        io.to('waiter').emit('order_ready', {
          ...payload,
          tableId: order.tableId,
          items: order.items,
        });
      }
      emitStockChanges(io, stockChanges);
    }
    return res.status(200).json({ success: true, data: order, message: 'อัปเดตสถานะออเดอร์สำเร็จ' });
  } catch (error) {
    if (pendingDeductions.length > 0) {
      try {
        const restoredChanges = await restoreStockDeductions(pendingDeductions);
        emitStockChanges(req.app.get('io'), restoredChanges);
      } catch (rollbackError) {
        console.error('Order acceptance stock rollback failed:', rollbackError);
        return res.status(500).json({
          success: false,
          code: 'STOCK_ROLLBACK_FAILED',
          data: null,
          message: 'คืนสต็อกหลังรับออเดอร์ไม่สำเร็จ กรุณาตรวจสอบสต็อก',
        });
      }
    }
    const status = error.name === 'CastError'
      ? 400
      : ['INSUFFICIENT_STOCK', 'MENU_UNAVAILABLE', 'MAX_ORDER_QUANTITY_EXCEEDED'].includes(error.code)
        ? 409
        : 500;
    if (status === 500) console.error('Update order status failed:', error);
    return res.status(status).json({
      success: false,
      code: error.code || 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'รูปแบบ ID ไม่ถูกต้อง' : error.message || 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

/**
 * Update the lifecycle status of one embedded order item.
 * @param {import('express').Request} req - Request containing itemId and itemStatus.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the updated order item.
 */
async function updateItemStatus(req, res) {
  try {
    const order = await Order.findById(req.params.orderId || req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', data: null, message: 'Order not found.' });
    }

    const itemId = req.body.itemId || req.params.itemId;
    const { itemStatus } = req.body;
    const item = order.items.id(itemId);
    if (!item) {
      return res.status(404).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'ไม่พบรายการอาหาร' });
    }
    if (order.status === 'cancelled' || item.itemStatus === 'cancelled') {
      return res.status(409).json({ success: false, code: 'ORDER_ITEM_ALREADY_CANCELLED', data: null, message: 'รายการนี้ถูกยกเลิกแล้ว' });
    }
    if (itemStatus === 'cancelled' && item.itemStatus === 'served') {
      return res.status(409).json({ success: false, code: 'SERVED_ITEM_CANNOT_BE_CANCELLED', data: null, message: 'รายการที่เสิร์ฟแล้วไม่สามารถยกเลิกหรือคืนสต็อกได้' });
    }
    if (!ITEM_STATUSES.includes(itemStatus)) {
      return res.status(400).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'สถานะรายการอาหารไม่ถูกต้อง' });
    }
    if (itemStatus !== 'cancelled' && STATUS_TRANSITIONS[item.itemStatus] !== itemStatus) {
      return res.status(400).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'ไม่สามารถเปลี่ยนสถานะรายการอาหารในลำดับนี้ได้' });
    }

    const previousItemStatus = item.itemStatus;
    const previousDeductions = (order.stockDeductions || []).map((deduction) => ({
      menuId: deduction.menuId,
      quantity: deduction.quantity,
    }));
    const stockDeduction = previousDeductions.find((deduction) => String(deduction.menuId) === String(item.menuId));
    let stockRefundQuantity = 0;
    const updateSet = { 'items.$.itemStatus': itemStatus };
    if (itemStatus === 'cancelled' && stockDeduction && !['served', 'paid'].includes(order.status)) {
      stockRefundQuantity = Math.min(Number(item.quantity) || 0, stockDeduction.quantity);
      const remainingQuantity = stockDeduction.quantity - stockRefundQuantity;
      updateSet.stockDeductions = previousDeductions
        .filter((deduction) => deduction !== stockDeduction || remainingQuantity > 0)
        .map((deduction) => deduction === stockDeduction
          ? { menuId: deduction.menuId, quantity: remainingQuantity }
          : deduction);
    }
    const itemIndex = order.items.findIndex((orderItem) => String(orderItem._id) === String(item._id));
    const updatedOrder = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: order.status,
        __v: order.__v,
        items: { $elemMatch: { _id: item._id, itemStatus: previousItemStatus } },
      },
      { $set: updateSet, $inc: { __v: 1 } },
      { new: true }
    );
    if (!updatedOrder) {
      return res.status(409).json({ success: false, code: 'ORDER_STATE_CHANGED', data: null, message: 'สถานะออเดอร์เปลี่ยนไปแล้ว กรุณาโหลดรายการใหม่' });
    }
    let stockChanges = [];
    if (stockRefundQuantity > 0) {
      try {
        stockChanges = await restoreStockDeductions([{
          menuId: stockDeduction.menuId,
          quantity: stockRefundQuantity,
        }]);
      } catch (restoreError) {
        const rollbackSet = {
          [`items.${itemIndex}.itemStatus`]: previousItemStatus,
          stockDeductions: previousDeductions,
        };
        await Order.findOneAndUpdate(
          { _id: updatedOrder._id, status: order.status, __v: updatedOrder.__v },
          { $set: rollbackSet, $inc: { __v: 1 } }
        );
        throw restoreError;
      }
    }
    emitStockChanges(req.app.get('io'), stockChanges);
    const updatedItem = updatedOrder.items.id(itemId);
    return res.status(200).json({
      success: true,
      data: { orderId: updatedOrder._id, item: updatedItem },
      message: 'อัปเดตสถานะรายการอาหารสำเร็จ',
    });
  } catch (error) {
    const status = error.name === 'CastError' ? 400 : error.code === 'STOCK_RESTORE_FAILED' ? 409 : 500;
    if (status === 500) console.error('Update item status failed:', error);
    return res.status(status).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'รูปแบบ ID ไม่ถูกต้อง' : 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

/**
 * Cancel an order that has not entered preparation or been served.
 * @param {import('express').Request} req - Request with orderId or id in route params.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the cancelled order.
 */
async function cancelOrder(req, res) {
  try {
    const order = await Order.findById(req.params.orderId || req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', data: null, message: 'Order not found.' });
    }
    if (!['pending', 'accepted'].includes(order.status)) {
      return res.status(400).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'ไม่สามารถยกเลิกออเดอร์ที่เริ่มทำแล้วได้' });
    }

    const cancelledOrder = await Order.findOneAndUpdate(
      { _id: order._id, status: order.status, __v: order.__v },
      { $set: { status: 'cancelled', 'items.$[].itemStatus': 'cancelled' }, $inc: { __v: 1 } },
      { new: true }
    );
    if (!cancelledOrder) {
      return res.status(409).json({
        success: false,
        code: 'ORDER_STATE_CHANGED',
        data: null,
        message: 'สถานะออเดอร์เปลี่ยนไปแล้ว กรุณาโหลดรายการใหม่',
      });
    }

    let stockChanges = [];
    if (order.status === 'accepted' && order.stockDeductions && order.stockDeductions.length > 0) {
      try {
        stockChanges = await restoreStockDeductions(order.stockDeductions);
      } catch (restoreError) {
        const rollbackSet = { status: 'accepted' };
        order.items.forEach((item, index) => {
          rollbackSet[`items.${index}.itemStatus`] = item.itemStatus;
        });
        await Order.findOneAndUpdate(
          { _id: cancelledOrder._id, status: 'cancelled' },
          { $set: rollbackSet }
        );
        throw restoreError;
      }
    }
    emitStockChanges(req.app.get('io'), stockChanges);
    return res.status(200).json({ success: true, data: cancelledOrder, message: 'ยกเลิกออเดอร์สำเร็จ' });
  } catch (error) {
    console.error('Cancel order failed:', error);
    const status = error.name === 'CastError'
      ? 400
      : error.code === 'STOCK_RESTORE_FAILED'
        ? 409
        : 500;
    return res.status(status).json({
      success: false,
      code: error.code || 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'รูปแบบ ID ไม่ถูกต้อง' : error.message || 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

/**
 * Cancel an order on behalf of the customer who owns the session.
 * Only the order's own session may cancel, and only while the order is
 * still in the "pending" state (kitchen has not accepted it yet).
 * @param {import('express').Request} req - Request with orderId and sessionId.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the cancelled order.
 */
async function cancelOrderByCustomer(req, res) {
  try {
    const orderId = req.params.id || req.params.orderId;
    const sessionId = (req.body && req.body.sessionId) || req.query.sessionId;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        code: 'REQUEST_FAILED',
        data: null,
        message: 'ไม่พบรหัสรอบรับประทาน',
      });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', data: null, message: 'ไม่พบออเดอร์นี้' });
    }
    if (String(order.sessionId) !== String(sessionId)) {
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        data: null,
        message: 'ไม่สามารถยกเลิกออเดอร์ของรอบอื่นได้',
      });
    }
    if (order.status === 'cancelled') {
      return res.status(409).json({
        success: false,
        code: 'ORDER_ALREADY_CANCELLED',
        data: null,
        message: 'ออเดอร์นี้ถูกยกเลิกอยู่แล้ว',
      });
    }
    if (order.status !== 'pending') {
      return res.status(409).json({
        success: false,
        code: 'ORDER_ALREADY_ACCEPTED',
        data: null,
        message: 'ครัวรับออเดอร์แล้ว จึงยกเลิกได้ไม่ กรุณาติดต่อพนักงาน',
      });
    }

    const cancelledOrder = await Order.findOneAndUpdate(
      { _id: order._id, status: 'pending', __v: order.__v },
      { $set: { status: 'cancelled', 'items.$[].itemStatus': 'cancelled' }, $inc: { __v: 1 } },
      { new: true }
    );
    if (!cancelledOrder) {
      return res.status(409).json({
        success: false,
        code: 'ORDER_STATE_CHANGED',
        data: null,
        message: 'สถานะออเดอร์เปลี่ยนไปแล้ว กรุณาโหลดรายการใหม่',
      });
    }

    const io = req.app.get('io');
    if (io) {
      const payload = {
        orderId: cancelledOrder._id,
        sessionId: cancelledOrder.sessionId,
        status: 'cancelled',
      };
      io.to(`customer_${cancelledOrder.sessionId}`).emit('order_status_changed', payload);
      io.to('kitchen').to('waiter').to('admin').emit('order_status_changed', payload);
    }

    return res.status(200).json({
      success: true,
      data: cancelledOrder,
      message: 'ยกเลิกออเดอร์แล้ว',
    });
  } catch (error) {
    console.error('Customer cancel order failed:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'รูปแบบ ID ไม่ถูกต้อง' : 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

// Export order handlers for customer, kitchen, and waiter routes.
module.exports = {
  createOrder,
  getOrderById,
  getOrdersBySession,
  getOrdersForStaff,
  updateOrderStatus,
  updateItemStatus,
  cancelOrder,
  cancelOrderByCustomer,
};