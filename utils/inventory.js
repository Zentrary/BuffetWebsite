const Menu = require('../models/Menu');

function inventoryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function aggregateMenuQuantities(items) {
  const quantities = new Map();
  for (const item of items || []) {
    if (!item.menuId) continue;
    const menuId = String(item.menuId);
    quantities.set(menuId, (quantities.get(menuId) || 0) + Number(item.quantity || 0));
  }
  return quantities;
}

async function applyStockRestoration(deductions) {
  const changes = [];
  try {
    for (const deduction of deductions) {
      const menu = await Menu.findOneAndUpdate(
        { _id: deduction.menuId, stockQuantity: { $ne: null } },
        { $inc: { stockQuantity: deduction.quantity } },
        { new: true }
      );
      if (!menu) {
        throw inventoryError(
          'STOCK_RESTORE_FAILED',
          `คืนสต็อกเมนู ${deduction.name || deduction.menuId} ไม่สำเร็จ กรุณาตรวจสอบรายการนี้`
        );
      }
      changes.push({
        menuId: menu._id,
        name: menu.name,
        quantity: deduction.quantity,
        stockQuantity: menu.stockQuantity,
        lowStockThreshold: menu.lowStockThreshold,
        isAvailable: menu.isAvailable && menu.stockQuantity > 0,
      });
    }
    return changes;
  } catch (error) {
    let rollbackFailed = false;
    for (const change of changes.reverse()) {
      try {
        const reverted = await Menu.findOneAndUpdate(
          { _id: change.menuId, stockQuantity: { $gte: change.quantity } },
          { $inc: { stockQuantity: -change.quantity } },
          { new: true }
        );
        if (!reverted) rollbackFailed = true;
      } catch (rollbackError) {
        rollbackFailed = true;
        console.error('Stock restoration rollback failed:', rollbackError);
      }
    }
    if (rollbackFailed) {
      throw inventoryError('STOCK_RESTORE_ROLLBACK_FAILED', 'คืนสต็อกไม่สำเร็จและย้อนการเปลี่ยนแปลงไม่ครบ กรุณาตรวจสอบสต็อก');
    }
    throw error;
  }
}

async function restoreStockDeductions(deductions) {
  return applyStockRestoration(deductions || []);
}

async function decrementStockForItems(items) {
  const quantities = aggregateMenuQuantities(items);
  if (quantities.size === 0) return { deductions: [], changes: [] };

  const menuIds = [...quantities.keys()];
  const menus = await Menu.find({ _id: { $in: menuIds } })
    .select('_id name isAvailable stockQuantity lowStockThreshold');
  const menusById = new Map(menus.map((menu) => [String(menu._id), menu]));
  const deductions = [];
  const changes = [];

  try {
    for (const [menuId, quantity] of quantities) {
      const menu = menusById.get(menuId);
      if (!menu) {
        throw inventoryError('MENU_NOT_FOUND', `ไม่พบเมนู ${menuId} สำหรับตัดสต็อก`);
      }
      if (!menu.isAvailable) {
        throw inventoryError('MENU_UNAVAILABLE', `เมนู ${menu.name} ปิดขายอยู่`);
      }
      if (quantity > Number(menu.maxOrderQuantity || 99)) {
        throw inventoryError('MAX_ORDER_QUANTITY_EXCEEDED', `เมนู ${menu.name} เกินจำนวนสูงสุดต่อออเดอร์`);
      }
      if (menu.stockQuantity === null || typeof menu.stockQuantity === 'undefined') continue;

      const updatedMenu = await Menu.findOneAndUpdate(
        { _id: menu._id, isAvailable: true, stockQuantity: { $gte: quantity } },
        { $inc: { stockQuantity: -quantity } },
        { new: true }
      );
      if (!updatedMenu) {
        throw inventoryError('INSUFFICIENT_STOCK', `สต็อกเมนู ${menu.name} ไม่พอสำหรับออเดอร์นี้`);
      }
      const deduction = { menuId: updatedMenu._id, quantity, name: updatedMenu.name };
      deductions.push(deduction);
      changes.push({
        menuId: updatedMenu._id,
        name: updatedMenu.name,
        stockQuantity: updatedMenu.stockQuantity,
        lowStockThreshold: updatedMenu.lowStockThreshold,
        isAvailable: updatedMenu.isAvailable && updatedMenu.stockQuantity > 0,
      });
    }
    return { deductions, changes };
  } catch (error) {
    if (deductions.length > 0) {
      try {
        await applyStockRestoration(deductions);
      } catch (rollbackError) {
        console.error('Stock rollback failed:', rollbackError);
        throw inventoryError('STOCK_ROLLBACK_FAILED', 'ตัดสต็อกไม่สำเร็จและคืนสต็อกอัตโนมัติไม่ครบ กรุณาตรวจสอบสต็อก');
      }
    }
    throw error;
  }
}

module.exports = {
  aggregateMenuQuantities,
  decrementStockForItems,
  restoreStockDeductions,
};