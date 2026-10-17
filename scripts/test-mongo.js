// ตรวจ DNS และการเชื่อมต่อ MongoDB โดยไม่พิมพ์ URI หรือรหัสผ่านลง log
require('dotenv').config();

const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');

// แยกข้อมูลปลายทางที่ไม่เป็นความลับออกจาก MongoDB URI
function describeMongoUri(uri) {
  const match = uri.match(/^mongodb(\+srv)?:\/\/([^/?]+)(?:\/([^?]*))?/i);
  if (!match) {
    throw new Error('รูปแบบ MONGO_URI ไม่ถูกต้อง หรือไม่ใช่ MongoDB URI');
  }

  const isSrv = Boolean(match[1]);
  const authority = match[2].slice(match[2].lastIndexOf('@') + 1);
  const hosts = authority.split(',').map((host) => {
    const separator = host.lastIndexOf(':');
    if (separator > -1 && host.indexOf(']') < separator) {
      return { host: host.slice(0, separator), port: host.slice(separator + 1) };
    }
    return { host, port: isSrv ? '27017 (default)' : '27017 (default)' };
  });

  return {
    isSrv,
    hosts,
    database: decodeURIComponent(match[3] || '(ไม่ได้ระบุ; MongoDB ใช้ค่า default)'),
  };
}

// แสดงข้อแนะนำตามสาเหตุที่มักทำให้เชื่อมต่อ Atlas ไม่ได้
function printRecommendations(error, srvError, isSrv) {
  console.error('\nคำแนะนำตรวจสอบ:');
  if (isSrv && srvError) {
    console.error(`- DNS SRV lookup ล้มเหลว: ${srvError.message}`);
    console.error('- ตรวจสอบ DNS/เครือข่าย หรือเลือก Standard connection string แบบ mongodb:// จาก Atlas > Connect > Drivers');
  } else if (isSrv) {
    console.error('- DNS SRV lookup สำเร็จ แต่เชื่อมต่อไม่ได้: ตรวจ Atlas Network Access, credentials และสถานะ cluster');
  } else {
    console.error('- URI นี้เป็นแบบ non-SRV; ตรวจ host, TLS options และ Atlas Network Access');
  }
  console.error('- เพิ่ม IP เครื่องปัจจุบันใน Atlas > Network Access และตรวจว่า cluster ยังทำงานอยู่');
  console.error(`- รายละเอียดข้อผิดพลาดจาก Mongoose: ${error.message}`);
}

async function testMongo() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('ไม่พบ MONGO_URI ใน .env');
  }

  const target = describeMongoUri(uri);
  console.log('MongoDB connection diagnostic');
  console.log(`DNS servers: ${dns.getServers().join(', ')}`);
  console.log(`Connection type: ${target.isSrv ? 'SRV (mongodb+srv)' : 'Standard (mongodb)'}`);
  console.log(`Host(s): ${target.hosts.map(({ host }) => host).join(', ')}`);
  console.log(`Port(s): ${target.hosts.map(({ port }) => port).join(', ')}`);
  console.log(`Database: ${target.database}`);
  console.log('Password: ***');

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      family: 4,
    });
    console.log('MongoDB connection: OK');
    await mongoose.disconnect();
    process.exitCode = 0;
  } catch (error) {
    console.error(`MongoDB connection: FAIL (${error.message})`);
    let srvError = null;

    if (target.isSrv) {
      try {
        const srvHost = target.hosts[0].host;
        const records = await dns.promises.resolveSrv(`_mongodb._tcp.${srvHost}`);
        if (records.length === 0) {
          throw new Error('DNS lookup สำเร็จแต่ไม่พบ SRV records');
        }
        console.log('Direct SRV lookup: OK');
        records.forEach((record) => {
          console.log(`  target=${record.name} port=${record.port} priority=${record.priority} weight=${record.weight}`);
        });
      } catch (lookupError) {
        srvError = lookupError;
        console.error(`Direct SRV lookup: FAIL (${lookupError.message})`);
      }
    } else {
      console.log('Direct SRV lookup: ข้าม เนื่องจาก URI ไม่ได้ใช้ mongodb+srv');
    }

    printRecommendations(error, srvError, target.isSrv);
    await mongoose.disconnect().catch((disconnectError) => {
      console.error('MongoDB cleanup failed:', disconnectError.message);
    });
    process.exitCode = 1;
  }
}

testMongo().catch(async (error) => {
  console.error('MongoDB diagnostic could not run:', error.message);
  await mongoose.disconnect().catch((disconnectError) => {
    console.error('MongoDB cleanup failed:', disconnectError.message);
  });
  process.exitCode = 1;
});
