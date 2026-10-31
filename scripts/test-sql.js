// ตรวจสอบการเชื่อมต่อฐานข้อมูล SQL Server (SSMS) และตารางระบบสมาชิก/โปรโมชัน โดยไม่แสดงรหัสผ่านลง log
require('dotenv').config();

const {
  parseSqlConfig,
  getSqlStatus,
  querySql,
  closeSqlConnections,
} = require('../config/sqlDb');

async function testSql() {
  const cfg = parseSqlConfig();
  console.log('=== SQL Database Connection Diagnostic ===');
  if (cfg.configured) {
    console.log('Target Engine : Microsoft SQL Server (SSMS)');
    console.log(`Server        : ${cfg.serverHost}${cfg.instanceName ? `\\${cfg.instanceName}` : ''}`);
    console.log(`Port          : ${cfg.port || '(dynamic via SQL Browser)'}`);
    console.log(`Database      : ${cfg.database}`);
    console.log(`User          : ${cfg.user || '(ไม่ได้ระบุ)'}`);
    console.log(`Password      : ${cfg.hasPassword ? '***' : '(ไม่ได้ระบุ)'}`);
  } else {
    console.log('Target Engine : Local SQL Engine (ยังไม่ตั้งค่า SQL_SERVER ใน .env)');
    console.log(`Database      : ${cfg.database}`);
  }

  const status = await getSqlStatus();
  if (!status.connected) {
    console.error(`\nผลการเชื่อมต่อ: FAIL (${status.error})`);
    console.error('\nคำแนะนำการแก้ไขสำหรับ SQL Server Management Studio (SSMS):');
    console.error('1. เปิดโปรแกรม SSMS แล้วรันไฟล์ sql/buffet_loyalty_ssms.sql (กด F5)');
    console.error('2. เปิด SQL Server Configuration Manager -> SQL Server Network Configuration -> เปิด TCP/IP (พอร์ต 1433) แล้ว Restart SQL Server');
    console.error('3. ใน SSMS คลิกขวาชื่อ Server -> Properties -> Security -> เลือก "SQL Server and Windows Authentication mode" แล้ว Restart SQL Server');
    console.error('4. ตรวจสอบค่า SQL_SERVER, SQL_USER และ SQL_PASSWORD ในไฟล์ .env ให้ตรงกับ Login ใน SSMS');
    process.exitCode = 1;
    await closeSqlConnections();
    return;
  }

  const [tiers, members, promos, tx] = await Promise.all([
    querySql('SELECT COUNT(*) AS cnt FROM MembershipTiers'),
    querySql('SELECT COUNT(*) AS cnt FROM Members'),
    querySql('SELECT COUNT(*) AS cnt FROM Promotions'),
    querySql('SELECT COUNT(*) AS cnt FROM PointTransactions'),
  ]);

  console.log(`\nผลการเชื่อมต่อ: OK (${status.mode === 'mssql' ? 'เชื่อมต่อ SSMS สำเร็จ' : 'โหมดทดลอง SQL ในเครื่อง'})`);
  console.log(`- MembershipTiers   : ${tiers.rows[0]?.cnt ?? 0} แถว`);
  console.log(`- Members           : ${members.rows[0]?.cnt ?? 0} แถว`);
  console.log(`- Promotions        : ${promos.rows[0]?.cnt ?? 0} แถว`);
  console.log(`- PointTransactions : ${tx.rows[0]?.cnt ?? 0} แถว`);

  await closeSqlConnections();
}

testSql().catch(async (error) => {
  console.error('SQL diagnostic error:', error.message);
  await closeSqlConnections();
  process.exitCode = 1;
});
