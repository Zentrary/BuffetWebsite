function roundCurrency(amount) {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function calculateCashChange(total, receivedAmount) {
  if (!Number.isFinite(total) || total < 0) {
    throw new RangeError('ยอดชำระไม่ถูกต้อง');
  }
  if (!Number.isFinite(receivedAmount) || receivedAmount < 0) {
    throw new RangeError('กรุณาระบุจำนวนเงินที่รับเป็นตัวเลขตั้งแต่ 0 ขึ้นไป');
  }

  const normalizedTotal = roundCurrency(total);
  const cashReceived = roundCurrency(receivedAmount);
  if (cashReceived < normalizedTotal) {
    throw new RangeError('จำนวนเงินที่รับยังไม่ครบยอดชำระ');
  }

  return {
    cashReceived,
    changeDue: roundCurrency(cashReceived - normalizedTotal),
  };
}

module.exports = { calculateCashChange };