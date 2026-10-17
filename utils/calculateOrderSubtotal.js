function calculateOrderSubtotal(orders) {
  return orders.reduce((orderTotal, order) => {
    if (order.status === 'cancelled') return orderTotal;
    const itemTotal = (order.items || []).reduce((sum, item) => {
      if (item.itemStatus === 'cancelled') return sum;
      return sum + (Number(item.price) || 0) * (Number(item.quantity) || 0);
    }, 0);
    return orderTotal + itemTotal;
  }, 0);
}

module.exports = { calculateOrderSubtotal };