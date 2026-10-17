const ShopSettings = require('../models/ShopSettings');
const { getShopStatus } = require('../utils/shopStatus');

// Public traffic is never admitted merely because staff enabled test mode.
async function requireShopOpen(req, res, next) {
  try {
    const settings = await ShopSettings.findById('shop-settings');
    const status = settings && getShopStatus(settings);
    if (!status || !status.isOpen || status.isTestMode) {
      return res.status(503).json({
        success: false,
        code: 'SHOP_CLOSED',
        data: status || { isOpen: false, isTestMode: false },
        message: status && status.isTestMode
          ? 'ร้านกำลังทดสอบระบบ จึงยังไม่เปิดรับลูกค้าจริง'
          : 'ร้านยังไม่เปิดให้บริการในขณะนี้',
      });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = requireShopOpen;
