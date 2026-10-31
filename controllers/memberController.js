// HTTP controller for SQL-based Membership, Loyalty Points & Promotions endpoints.

const { getSqlStatus } = require('../config/sqlDb');
const loyaltyService = require('../services/loyaltySqlService');

function sendSqlError(res, error, fallbackMessage = 'ไม่สามารถดำเนินการกับข้อมูลสมาชิกได้') {
  const status = error.status
    || (error.code === 'SQL_CREDENTIALS_MISSING' ? 503 : 500);
  if (status >= 500) {
    console.error('[memberController]', error.message);
  }
  return res.status(status).json({
    success: false,
    code: error.code || 'SQL_REQUEST_FAILED',
    data: null,
    message: error.message || fallbackMessage,
  });
}

async function getStatus(_req, res) {
  try {
    const status = await getSqlStatus();
    return res.status(200).json({
      success: true,
      data: status,
      message: 'ตรวจสอบสถานะฐานข้อมูล SQL สำเร็จ',
    });
  } catch (error) {
    return sendSqlError(res, error);
  }
}

async function getOverview(_req, res) {
  try {
    const data = await loyaltyService.getLoyaltyOverview();
    return res.status(200).json({
      success: true,
      data,
      message: 'ดึงภาพรวมระบบสมาชิกและโปรโมชันสำเร็จ',
    });
  } catch (error) {
    return sendSqlError(res, error);
  }
}

async function getTiers(_req, res) {
  try {
    const data = await loyaltyService.listTiers();
    return res.status(200).json({
      success: true,
      data,
      message: 'ดึงข้อมูลระดับบัตรสมาชิกสำเร็จ',
    });
  } catch (error) {
    return sendSqlError(res, error);
  }
}

async function getMembers(req, res) {
  try {
    const data = await loyaltyService.listMembers({
      search: req.query.search || '',
      tierCode: req.query.tierCode || '',
      activeOnly: req.query.activeOnly === 'true',
    });
    return res.status(200).json({
      success: true,
      data,
      message: 'ดึงรายชื่อสมาชิกสำเร็จ',
    });
  } catch (error) {
    return sendSqlError(res, error);
  }
}

async function lookupMember(req, res) {
  try {
    const phone = req.query.phone || '';
    const subtotal = Number(req.query.subtotal) || 0;
    const data = await loyaltyService.lookupMemberByPhone(phone, subtotal);
    return res.status(200).json({
      success: true,
      data,
      message: data.found ? 'พบข้อมูลสมาชิก' : 'ไม่พบเบอร์โทรศัพท์นี้ในระบบสมาชิก',
    });
  } catch (error) {
    return sendSqlError(res, error);
  }
}

async function createMember(req, res) {
  try {
    const createdBy = (req.user && req.user.username) || 'staff';
    const data = await loyaltyService.createMember({
      fullName: req.body.fullName,
      phone: req.body.phone,
      email: req.body.email,
      initialPoints: req.body.initialPoints,
      createdBy,
    });
    return res.status(201).json({
      success: true,
      data,
      message: 'สมัครสมาชิกใหม่สำเร็จ',
    });
  } catch (error) {
    return sendSqlError(res, error);
  }
}

async function updateMember(req, res) {
  try {
    const data = await loyaltyService.updateMember(req.params.id, req.body || {});
    return res.status(200).json({
      success: true,
      data,
      message: 'บันทึกข้อมูลสมาชิกสำเร็จ',
    });
  } catch (error) {
    return sendSqlError(res, error);
  }
}

async function deleteMember(req, res) {
  try {
    const data = await loyaltyService.deleteMember(req.params.id);
    return res.status(200).json({
      success: true,
      data,
      message: 'ลบข้อมูลสมาชิกสำเร็จ',
    });
  } catch (error) {
    return sendSqlError(res, error);
  }
}

async function adjustPoints(req, res) {
  try {
    const createdBy = (req.user && req.user.username) || 'admin';
    const data = await loyaltyService.adjustMemberPoints(req.params.id, {
      pointsDelta: req.body.pointsDelta,
      note: req.body.note,
      createdBy,
    });
    return res.status(200).json({
      success: true,
      data,
      message: 'ปรับปรุงแต้มสะสมสำเร็จ',
    });
  } catch (error) {
    return sendSqlError(res, error);
  }
}

async function getTransactions(req, res) {
  try {
    const data = await loyaltyService.listTransactions({
      memberId: req.query.memberId,
      limit: req.query.limit || 50,
    });
    return res.status(200).json({
      success: true,
      data,
      message: 'ดึงประวัติการใช้แต้มและคูปองสำเร็จ',
    });
  } catch (error) {
    return sendSqlError(res, error);
  }
}

async function getPromotions(req, res) {
  try {
    const data = await loyaltyService.listPromotions({
      activeOnly: req.query.activeOnly === 'true',
    });
    return res.status(200).json({
      success: true,
      data,
      message: 'ดึงรายการคูปองและโปรโมชันสำเร็จ',
    });
  } catch (error) {
    return sendSqlError(res, error);
  }
}

async function createPromotion(req, res) {
  try {
    const data = await loyaltyService.createPromotion(req.body || {});
    return res.status(201).json({
      success: true,
      data,
      message: 'สร้างโปรโมชัน/คูปองใหม่สำเร็จ',
    });
  } catch (error) {
    return sendSqlError(res, error);
  }
}

async function updatePromotion(req, res) {
  try {
    const data = await loyaltyService.updatePromotion(req.params.id, req.body || {});
    return res.status(200).json({
      success: true,
      data,
      message: 'อัปเดตโปรโมชัน/คูปองสำเร็จ',
    });
  } catch (error) {
    return sendSqlError(res, error);
  }
}

async function deletePromotion(req, res) {
  try {
    const data = await loyaltyService.deletePromotion(req.params.id);
    return res.status(200).json({
      success: true,
      data,
      message: 'ลบโปรโมชัน/คูปองสำเร็จ',
    });
  } catch (error) {
    return sendSqlError(res, error);
  }
}

module.exports = {
  getStatus,
  getOverview,
  getTiers,
  getMembers,
  lookupMember,
  createMember,
  updateMember,
  deleteMember,
  adjustPoints,
  getTransactions,
  getPromotions,
  createPromotion,
  updatePromotion,
  deletePromotion,
};
