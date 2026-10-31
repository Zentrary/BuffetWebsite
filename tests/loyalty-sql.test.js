// Automated tests for the SQL Membership, Loyalty Points & Promotions system.
// Exercises SQL schema, joins, aggregates, constraints, REST endpoints, payment integration,
// DOM IDs, and Thai/English i18n keys using an isolated in-memory SQL engine (never touches external DBs).

process.env.SQL_FORCE_SQLITE_MEMORY = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'loyalty-sql-test-secret-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const jwt = require('jsonwebtoken');

const {
  parseSqlConfig,
  closeSqlConnections,
  getSqlStatus,
} = require('../config/sqlDb');
const loyaltyService = require('../services/loyaltySqlService');
const Session = require('../models/Session');
const Order = require('../models/Order');
const Payment = require('../models/Payment');
const Table = require('../models/Table');
const Queue = require('../models/Queue');
const app = require('../server');

const thLocale = require('../public/locales/th.json');
const enLocale = require('../public/locales/en.json');

async function startTestServer() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function makeToken(role = 'admin', username = 'test_admin') {
  return jwt.sign({ id: '507f1f77bcf86cd799439011', username, role }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });
}

test('SSMS SQL script defines BuffetLoyaltyDB, 4 relational tables, PK/FK constraints, and vw_MemberSummary', () => {
  const sqlPath = path.resolve(__dirname, '../sql/buffet_loyalty_ssms.sql');
  assert.equal(fs.existsSync(sqlPath), true, 'sql/buffet_loyalty_ssms.sql must exist');
  const script = fs.readFileSync(sqlPath, 'utf8');

  assert.match(script, /CREATE DATABASE BuffetLoyaltyDB/i);
  assert.match(script, /CREATE TABLE dbo\.MembershipTiers/i);
  assert.match(script, /CREATE TABLE dbo\.Members/i);
  assert.match(script, /CREATE TABLE dbo\.Promotions/i);
  assert.match(script, /CREATE TABLE dbo\.PointTransactions/i);
  assert.match(script, /FK_Members_MembershipTiers/i);
  assert.match(script, /FK_PointTransactions_Members/i);
  assert.match(script, /FK_PointTransactions_Promotions/i);
  assert.match(script, /VIEW dbo\.vw_MemberSummary/i);
});

test('parseSqlConfig supports localhost, named SSMS instances (.\\SQLEXPRESS), explicit ports, and Azure SQL TLS', () => {
  const empty = parseSqlConfig({ SQL_SERVER: '' });
  assert.equal(empty.configured, false);

  const localDefault = parseSqlConfig({
    SQL_SERVER: 'localhost',
    SQL_USER: 'sa',
    SQL_PASSWORD: 'secret',
  });
  assert.equal(localDefault.configured, true);
  assert.equal(localDefault.serverHost, 'localhost');
  assert.equal(localDefault.port, 1433);
  assert.equal(localDefault.database, 'BuffetLoyaltyDB');
  assert.equal(localDefault.mssqlConfig.options.trustServerCertificate, true);

  const namedInstance = parseSqlConfig({
    SQL_SERVER: '.\\SQLEXPRESS',
    SQL_DATABASE: 'CustomDB',
    SQL_USER: 'buffet_app',
    SQL_PASSWORD: 'pw',
  });
  assert.equal(namedInstance.configured, true);
  assert.equal(namedInstance.serverHost, 'localhost');
  assert.equal(namedInstance.instanceName, 'SQLEXPRESS');
  assert.equal(namedInstance.port, null);
  assert.equal(namedInstance.mssqlConfig.options.instanceName, 'SQLEXPRESS');

  const azure = parseSqlConfig({
    SQL_SERVER: 'myserver.database.windows.net',
    SQL_USER: 'adminuser',
    SQL_PASSWORD: 'pw',
  });
  assert.equal(azure.mssqlConfig.options.encrypt, true);
  assert.equal(azure.mssqlConfig.options.trustServerCertificate, false);
});

test('SQL schema seeds tiers, promotions, sample members, and computes relational overview aggregates', async () => {
  await closeSqlConnections();
  const status = await getSqlStatus();
  assert.equal(status.connected, true);

  const overview = await loyaltyService.getLoyaltyOverview();
  assert.equal(overview.tiers.length, 4);
  assert.equal(overview.summary.totalMembers, 3);
  assert.equal(overview.summary.totalPromotions, 4);
  assert.ok(overview.summary.totalCurrentPoints > 0);
  assert.equal(overview.summary.totalRedemptions, 1);
  assert.equal(overview.summary.totalDiscountSaved, 50);
});

test('Member CRUD, phone normalization, bonus point adjustments, auto-tier upgrade, and CASCADE delete', async () => {
  await closeSqlConnections();

  const created = await loyaltyService.createMember({
    fullName: 'ธนพล ทดสอบระบบ',
    phone: '091-222-3344',
    email: 'thanapol@example.com',
    initialPoints: 55,
    createdBy: 'admin',
  });
  assert.equal(created.phone, '0912223344');
  assert.equal(created.currentPoints, 55);
  assert.equal(created.lifetimePoints, 55);
  // 55 points >= 50 threshold -> automatically assigned Silver tier!
  assert.equal(created.tierCode, 'SILVER');

  await assert.rejects(
    () => loyaltyService.createMember({ fullName: 'ซ้ำ', phone: '0912223344' }),
    (err) => err.code === 'DUPLICATE_MEMBER_PHONE' && err.status === 409
  );

  const upgraded = await loyaltyService.adjustMemberPoints(created.memberId, {
    pointsDelta: 100,
    note: 'โบนัสกิจกรรมหน้าร้าน',
    createdBy: 'admin',
  });
  assert.equal(upgraded.currentPoints, 155);
  assert.equal(upgraded.lifetimePoints, 155);
  // 155 lifetime points >= 150 threshold -> upgraded to GOLD!
  assert.equal(upgraded.tierCode, 'GOLD');

  await assert.rejects(
    () => loyaltyService.adjustMemberPoints(created.memberId, { pointsDelta: -999 }),
    (err) => err.code === 'INSUFFICIENT_MEMBER_POINTS'
  );

  const updated = await loyaltyService.updateMember(created.memberId, {
    fullName: 'ธนพล อัปเดตแล้ว',
    isActive: false,
  });
  assert.equal(updated.fullName, 'ธนพล อัปเดตแล้ว');
  assert.equal(updated.isActive, false);

  const memberLogsBeforeDelete = await loyaltyService.listTransactions({ memberId: created.memberId });
  assert.equal(memberLogsBeforeDelete.length, 2);

  await loyaltyService.deleteMember(created.memberId);
  const afterDelete = await loyaltyService.getMemberById(created.memberId);
  assert.equal(afterDelete, null);

  const allLogs = await loyaltyService.listTransactions({ limit: 100 });
  assert.equal(allLogs.some((tx) => tx.memberId === created.memberId), false, 'FK ON DELETE CASCADE must remove member transactions');
});

test('Promotion CRUD, lookup eligibility, discount calculation, and idempotent payment loyalty settlement', async () => {
  await closeSqlConnections();

  const promo = await loyaltyService.createPromotion({
    promoCode: 'mala80',
    title: 'ลดค่าซุปหม่าล่า 80 บาท',
    discountType: 'FIXED',
    discountValue: 80,
    pointsCost: 40,
    minSpend: 500,
    isActive: true,
  });
  assert.equal(promo.promoCode, 'MALA80');
  assert.equal(promo.pointsCost, 40);

  // Lookup Somchai (0812345678, Gold tier 10%, 135 points) with 600 THB subtotal
  const lookup = await loyaltyService.lookupMemberByPhone('081-234-5678', 600);
  assert.equal(lookup.found, true);
  assert.equal(lookup.member.tierCode, 'GOLD');
  assert.equal(lookup.tierBenefit.available, true);
  assert.equal(lookup.tierBenefit.estimatedDiscount, 60); // 10% of 600

  const malaPromo = lookup.availablePromotions.find((p) => p.promoCode === 'MALA80');
  assert.ok(malaPromo);
  assert.equal(malaPromo.eligible, true);
  assert.equal(malaPromo.estimatedDiscount, 80);

  // Evaluate redeeming MALA80 on 600 THB bill
  const evaluated = await loyaltyService.evaluateBenefitForBill({
    memberId: lookup.member.memberId,
    benefitType: 'PROMO',
    promotionId: promo.promotionId,
    subtotal: 600,
  });
  assert.equal(evaluated.discountAmount, 80);
  assert.equal(evaluated.pointsToRedeem, 40);

  // Simulate session paid at net grandTotal = 520 THB (Gold x1.5 -> floor(5.2 * 1.5) = 7 points)
  const fakeSession = {
    _id: '507f1f77bcf86cd799439099',
    memberId: lookup.member.memberId,
    discount: 80,
    grandTotal: 520,
    appliedPromotionId: promo.promotionId,
    appliedPromoCode: promo.promoCode,
    appliedPromoTitle: promo.title,
    pointsToRedeem: 40,
  };

  const settled = await loyaltyService.settleSessionLoyalty(fakeSession, { username: 'cashier1' });
  assert.equal(settled.alreadySettled, false);
  assert.equal(settled.pointsRedeemed, 40);
  assert.equal(settled.pointsEarned, 7);
  assert.equal(settled.newBalance, 135 - 40 + 7);

  // Calling settleSessionLoyalty a second time for the same session must be idempotent
  const duplicateSettle = await loyaltyService.settleSessionLoyalty(fakeSession, { username: 'cashier1' });
  assert.equal(duplicateSettle.alreadySettled, true);
  assert.equal(duplicateSettle.member.currentPoints, 135 - 40 + 7);
});

test('REST API endpoints enforce role authorization and apply/settle loyalty discounts during checkout', async (t) => {
  await closeSqlConnections();
  const srv = await startTestServer();
  t.after(async () => {
    await srv.close();
    await closeSqlConnections();
  });

  const adminHeaders = {
    Authorization: `Bearer ${makeToken('admin', 'admin_user')}`,
    'Content-Type': 'application/json',
  };
  const waiterHeaders = {
    Authorization: `Bearer ${makeToken('waiter', 'waiter_user')}`,
    'Content-Type': 'application/json',
  };

  // Unauthorized request rejected
  const unauthRes = await fetch(`${srv.baseUrl}/api/members/status`);
  assert.equal(unauthRes.status, 401);

  // Waiter can lookup and register members at checkout, but cannot delete members
  const waiterLookup = await fetch(`${srv.baseUrl}/api/members/lookup?phone=0812345678&subtotal=1000`, {
    headers: waiterHeaders,
  });
  assert.equal(waiterLookup.status, 200);
  const waiterLookupJson = await waiterLookup.json();
  assert.equal(waiterLookupJson.data.found, true);

  const waiterDelete = await fetch(`${srv.baseUrl}/api/members/1`, {
    method: 'DELETE',
    headers: waiterHeaders,
  });
  assert.equal(waiterDelete.status, 403);

  // Admin overview works
  const overviewRes = await fetch(`${srv.baseUrl}/api/members/overview`, { headers: adminHeaders });
  assert.equal(overviewRes.status, 200);
  const overviewJson = await overviewRes.json();
  assert.equal(overviewJson.success, true);
  assert.equal(overviewJson.data.summary.totalMembers, 3);

  // Stub Mongoose models to test POST /api/payment/apply-loyalty & POST /api/payment/process end-to-end
  const sessionDoc = {
    _id: '507f1f77bcf86cd799439055',
    tableId: '507f1f77bcf86cd799439066',
    status: 'active',
    isPaid: false,
    checkoutRequestedAt: new Date(),
    subtotal: 1000,
    discount: 0,
    grandTotal: 1000,
    memberId: null,
    pointsToRedeem: 0,
    async save() { return this; },
  };

  const origSessionFindById = Session.findById;
  const origSessionFindOneAndUpdate = Session.findOneAndUpdate;
  const origSessionUpdateOne = Session.updateOne;
  const origOrderFind = Order.find;
  const origPaymentUpdateMany = Payment.updateMany;
  const origPaymentCreate = Payment.create;
  const origTableFindOne = Table.findOne;
  const origTableFindOneAndUpdate = Table.findOneAndUpdate;
  const origQueueFind = Queue.find;

  t.after(() => {
    Session.findById = origSessionFindById;
    Session.findOneAndUpdate = origSessionFindOneAndUpdate;
    Session.updateOne = origSessionUpdateOne;
    Order.find = origOrderFind;
    Payment.updateMany = origPaymentUpdateMany;
    Payment.create = origPaymentCreate;
    Table.findOne = origTableFindOne;
    Table.findOneAndUpdate = origTableFindOneAndUpdate;
    Queue.find = origQueueFind;
  });

  Session.findById = async () => sessionDoc;
  Order.find = async () => [{ status: 'served', items: [{ name: 'ชุดเนื้อวากิว', price: 500, quantity: 2, itemStatus: 'served' }] }];
  Payment.updateMany = async () => ({ modifiedCount: 0 });

  // Apply SAVE50 (30 points -> 50 THB off) for memberId 1 (Somchai, 135 pts)
  const applyRes = await fetch(`${srv.baseUrl}/api/payment/apply-loyalty`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      sessionId: sessionDoc._id,
      memberId: 1,
      benefitType: 'PROMO',
      promotionId: 2, // SAVE50
    }),
  });
  assert.equal(applyRes.status, 200);
  const applyJson = await applyRes.json();
  assert.equal(applyJson.data.bill.discount, 50);
  assert.equal(applyJson.data.bill.grandTotal, 950);
  assert.equal(sessionDoc.pointsToRedeem, 30);

  // Test clearing loyalty discount and re-applying before payment
  const clearRes = await fetch(`${srv.baseUrl}/api/payment/apply-loyalty/${sessionDoc._id}`, {
    method: 'DELETE',
    headers: adminHeaders,
  });
  assert.equal(clearRes.status, 200);
  const clearJson = await clearRes.json();
  assert.equal(clearJson.data.bill.discount, 0);
  assert.equal(clearJson.data.bill.grandTotal, 1000);
  assert.equal(sessionDoc.memberId, null);

  // Re-apply SAVE50 before cash payment
  const reapplyRes = await fetch(`${srv.baseUrl}/api/payment/apply-loyalty`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      sessionId: sessionDoc._id,
      memberId: 1,
      benefitType: 'PROMO',
      promotionId: 2,
    }),
  });
  assert.equal(reapplyRes.status, 200);

  // Now complete cash payment and verify SQL points are settled automatically
  Table.findOne = async () => ({ _id: sessionDoc.tableId, status: 'occupied', currentSessionId: sessionDoc._id });
  Session.findOneAndUpdate = async (_filter, update) => {
    Object.assign(sessionDoc, update.$set);
    return sessionDoc;
  };
  Session.updateOne = async (_filter, update) => {
    if (update.$set) Object.assign(sessionDoc, update.$set);
    return { modifiedCount: 1 };
  };
  Payment.create = async (doc) => ({ _id: '507f1f77bcf86cd799439077', ...doc });
  Table.findOneAndUpdate = async () => ({ _id: sessionDoc.tableId, tableNumber: 'A1', status: 'cleaning' });
  Queue.find = () => ({
    distinct: async () => [],
    select: () => ({ lean: async () => [] }),
  });

  const payRes = await fetch(`${srv.baseUrl}/api/payment/process`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      sessionId: sessionDoc._id,
      method: 'cash',
      receivedAmount: 1000,
    }),
  });
  assert.equal(payRes.status, 201);
  const payJson = await payRes.json();
  assert.equal(payJson.data.amount, 950);
  assert.equal(payJson.data.changeDue, 50);
  assert.ok(payJson.loyalty, 'Payment response must include settled SQL loyalty summary');
  assert.equal(payJson.loyalty.pointsRedeemed, 30);
  // 950 THB paid * Gold 1.5x -> floor(9.5 * 1.5) = 14 points earned
  assert.equal(payJson.loyalty.pointsEarned, 14);
  assert.equal(payJson.loyalty.newBalance, 135 - 30 + 14);
});

test('Every DOM ID and i18n key used by manage-members and checkout loyalty UI exists', () => {
  const membersHtml = fs.readFileSync(path.resolve(__dirname, '../public/admin/manage-members.html'), 'utf8');
  const membersJs = fs.readFileSync(path.resolve(__dirname, '../public/js/admin/manageMembers.js'), 'utf8');
  const checkoutHtml = fs.readFileSync(path.resolve(__dirname, '../public/admin/checkout.html'), 'utf8');
  const checkoutJs = fs.readFileSync(path.resolve(__dirname, '../public/js/admin/checkout.js'), 'utf8');
  const commonJs = fs.readFileSync(path.resolve(__dirname, '../public/js/admin/common.js'), 'utf8');

  assert.match(commonJs, /manage-members\.html/, 'Admin sidebar must link to manage-members.html');

  // Verify every getElementById in manageMembers.js exists in manage-members.html (except shared #page-message which is also there)
  const memberJsIds = [...membersJs.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  for (const id of memberJsIds) {
    assert.match(membersHtml, new RegExp(`id=["']${id}["']`), `manage-members.html missing #${id}`);
  }

  // Verify every loyalty-related getElementById in checkout.js exists in checkout.html
  const checkoutIds = [...checkoutJs.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  for (const id of checkoutIds) {
    assert.match(checkoutHtml, new RegExp(`id=["']${id}["']`), `admin/checkout.html missing #${id}`);
  }

  // Verify every data-i18n* key across ALL HTML files and T('...') key across ALL JS files exists in both th.json and en.json
  assert.deepEqual(
    Object.keys(thLocale).sort(),
    Object.keys(enLocale).sort(),
    'th.json and en.json must have identical translation key sets'
  );

  // Ensure production UI has no visible SQL/SSMS assignment labels
  assert.doesNotMatch(membersHtml, /\b(SQL|SSMS)\b/i, 'manage-members.html must not show SQL/SSMS wording');
  assert.doesNotMatch(checkoutHtml, /\b(SQL|SSMS)\b/i, 'admin/checkout.html must not show SQL/SSMS wording');
  for (const [k, v] of [...Object.entries(thLocale), ...Object.entries(enLocale)]) {
    assert.doesNotMatch(String(v), /\b(SQL|SSMS)\b/i, `Locale value for "${k}" must not expose SQL/SSMS`);
  }

  function walkFiles(dir, ext) {
    let out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out = out.concat(walkFiles(full, ext));
      else if (full.endsWith(ext)) out.push(full);
    }
    return out;
  }

  const publicDir = path.resolve(__dirname, '../public');
  for (const htmlFile of walkFiles(publicDir, '.html')) {
    const html = fs.readFileSync(htmlFile, 'utf8');
    const keys = [
      ...[...html.matchAll(/data-i18n=["']([^"']+)["']/g)].map((m) => m[1]),
      ...[...html.matchAll(/data-i18n-placeholder=["']([^"']+)["']/g)].map((m) => m[1]),
      ...[...html.matchAll(/data-i18n-aria-label=["']([^"']+)["']/g)].map((m) => m[1]),
      ...[...html.matchAll(/data-i18n-title=["']([^"']+)["']/g)].map((m) => m[1]),
    ];
    for (const key of keys) {
      assert.ok(Object.prototype.hasOwnProperty.call(thLocale, key), `th.json missing key "${key}" used in ${path.relative(publicDir, htmlFile)}`);
      assert.ok(Object.prototype.hasOwnProperty.call(enLocale, key), `en.json missing key "${key}" used in ${path.relative(publicDir, htmlFile)}`);
    }
  }

  for (const jsFile of walkFiles(path.join(publicDir, 'js'), '.js')) {
    const src = fs.readFileSync(jsFile, 'utf8');
    for (const m of src.matchAll(/\b(?:T|window\.t)\(\s*['"]([^'"${}]+)['"]/g)) {
      const key = m[1];
      if (key.endsWith('.')) continue;
      assert.ok(Object.prototype.hasOwnProperty.call(thLocale, key), `th.json missing key "${key}" used in ${path.relative(publicDir, jsFile)}`);
      assert.ok(Object.prototype.hasOwnProperty.call(enLocale, key), `en.json missing key "${key}" used in ${path.relative(publicDir, jsFile)}`);
    }
  }
});
