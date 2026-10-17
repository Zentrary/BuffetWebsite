// Format order details and currency values for staff-facing notifications.

/**
 * Select the kitchen-relevant fields from an individual order item.
 * @param {object} item - Embedded order item.
 * @returns {{name: string|undefined, quantity: number|undefined, note: string, itemStatus: string|undefined}} Kitchen display item.
 */
function formatKitchenItem(item) {
  return {
    name: item.name,
    quantity: item.quantity,
    note: item.note || '',
    itemStatus: item.itemStatus,
  };
}

/**
 * Convert an order document into a concise kitchen display payload.
 * @param {object} order - Order document or plain order object.
 * @returns {{orderId: string|null, tableNumber: string|null, items: Array<object>, status: string|undefined, createdAt: Date|undefined, totalPrice: number|undefined}} Kitchen display data.
 */
function formatOrderForKitchen(order) {
  const table = order.tableId && typeof order.tableId === 'object' ? order.tableId : null;

  return {
    orderId: order._id ? String(order._id) : null,
    tableNumber: table && table.tableNumber ? table.tableNumber : null,
    items: (order.items || []).map(formatKitchenItem),
    status: order.status,
    createdAt: order.createdAt,
    totalPrice: order.totalPrice,
  };
}

/**
 * Format a numeric amount as Thai Baht with two decimal places.
 * @param {number} amount - Amount to format.
 * @returns {string} Currency string such as "฿1,234.50".
 */
function formatCurrency(amount) {
  return `฿${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)}`;
}

// Export formatters for kitchen updates and customer/staff notifications.
module.exports = { formatOrderForKitchen, formatCurrency };
