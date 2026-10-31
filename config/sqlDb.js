// SQL Database connection manager for the Membership, Loyalty Points & Promotions module.
// Primary engine: Microsoft SQL Server (SSMS) via `mssql` when SQL_SERVER is configured in .env.
// Fallback engine: Embedded SQLite relational SQL engine (`sql.js`) when SQL_SERVER is not set,
// so the web app, live preview, and automated tests work out of the box without crashing.

const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const initSqlJs = require('sql.js/dist/sql-wasm-inline.js');

const DEFAULT_SQL_DB_NAME = 'BuffetLoyaltyDB';
const LOCAL_SQLITE_PATH = path.join(__dirname, '..', '.data', 'buffet-loyalty-local.sqlite');

const cache = global.__buffetSqlCache || {
  mssqlPool: null,
  mssqlPromise: null,
  mssqlInitialized: false,
  lastMssqlError: null,
  sqliteDb: null,
  sqlitePromise: null,
};
global.__buffetSqlCache = cache;

function parseSqlConfig(env = process.env) {
  const rawServer = (env.SQL_SERVER || '').trim();
  const forceMemorySqlite = env.SQL_FORCE_SQLITE_MEMORY === '1';

  if (!rawServer || forceMemorySqlite) {
    return {
      configured: false,
      forceMemorySqlite,
      database: (env.SQL_DATABASE || DEFAULT_SQL_DB_NAME).trim() || DEFAULT_SQL_DB_NAME,
    };
  }

  let serverHost = rawServer;
  let instanceName = (env.SQL_INSTANCE || '').trim();

  if (rawServer.includes('\\')) {
    const [hostPart, instancePart] = rawServer.split('\\');
    serverHost = (!hostPart || hostPart === '.' || hostPart.toLowerCase() === '(local)')
      ? 'localhost'
      : hostPart.trim();
    if (!instanceName && instancePart) {
      instanceName = instancePart.trim();
    }
  } else if (serverHost === '.' || serverHost.toLowerCase() === '(local)') {
    serverHost = 'localhost';
  }

  const database = (env.SQL_DATABASE || DEFAULT_SQL_DB_NAME).trim() || DEFAULT_SQL_DB_NAME;
  const user = (env.SQL_USER || '').trim();
  const password = env.SQL_PASSWORD || '';
  const hasExplicitPort = Boolean(env.SQL_PORT && String(env.SQL_PORT).trim());
  const port = hasExplicitPort
    ? Number.parseInt(env.SQL_PORT, 10)
    : (instanceName ? undefined : 1433);

  const isAzure = /\.database\.windows\.net$/i.test(serverHost);
  const encrypt = env.SQL_ENCRYPT !== undefined
    ? String(env.SQL_ENCRYPT).toLowerCase() === 'true'
    : isAzure;
  const trustServerCertificate = env.SQL_TRUST_SERVER_CERTIFICATE !== undefined
    ? String(env.SQL_TRUST_SERVER_CERTIFICATE).toLowerCase() !== 'false'
    : !isAzure;

  const mssqlConfig = {
    user,
    password,
    server: serverHost,
    database,
    connectionTimeout: 10000,
    requestTimeout: 15000,
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000,
    },
    options: {
      encrypt,
      trustServerCertificate,
      enableArithAbort: true,
    },
  };

  if (Number.isInteger(port) && port > 0) {
    mssqlConfig.port = port;
  } else if (instanceName) {
    mssqlConfig.options.instanceName = instanceName;
  }

  return {
    configured: true,
    rawServer,
    serverHost,
    instanceName: instanceName || null,
    port: mssqlConfig.port || null,
    database,
    user,
    hasPassword: Boolean(password),
    mssqlConfig,
  };
}

async function ensureMssqlSchema(pool) {
  if (cache.mssqlInitialized) return;

  await pool.request().batch(`
    IF OBJECT_ID(N'dbo.MembershipTiers', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.MembershipTiers (
        TierId            INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MembershipTiers PRIMARY KEY,
        TierCode          NVARCHAR(30)      NOT NULL CONSTRAINT UQ_MembershipTiers_TierCode UNIQUE,
        TierName          NVARCHAR(100)     NOT NULL,
        MinPoints         INT               NOT NULL CONSTRAINT DF_MembershipTiers_MinPoints DEFAULT (0),
        DiscountPercent   DECIMAL(5,2)      NOT NULL CONSTRAINT DF_MembershipTiers_DiscountPercent DEFAULT (0),
        PointsMultiplier  DECIMAL(4,2)      NOT NULL CONSTRAINT DF_MembershipTiers_PointsMultiplier DEFAULT (1.00),
        CreatedAt         DATETIME2         NOT NULL CONSTRAINT DF_MembershipTiers_CreatedAt DEFAULT (SYSDATETIME())
      );
    END;

    IF OBJECT_ID(N'dbo.Members', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.Members (
        MemberId          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Members PRIMARY KEY,
        MemberCode        NVARCHAR(20)      NOT NULL CONSTRAINT UQ_Members_MemberCode UNIQUE,
        FullName          NVARCHAR(150)     NOT NULL,
        Phone             NVARCHAR(20)      NOT NULL CONSTRAINT UQ_Members_Phone UNIQUE,
        Email             NVARCHAR(150)     NULL,
        TierId            INT               NOT NULL CONSTRAINT FK_Members_MembershipTiers FOREIGN KEY REFERENCES dbo.MembershipTiers (TierId),
        CurrentPoints     INT               NOT NULL CONSTRAINT DF_Members_CurrentPoints DEFAULT (0),
        LifetimePoints    INT               NOT NULL CONSTRAINT DF_Members_LifetimePoints DEFAULT (0),
        TotalSpent        DECIMAL(12,2)     NOT NULL CONSTRAINT DF_Members_TotalSpent DEFAULT (0),
        VisitCount        INT               NOT NULL CONSTRAINT DF_Members_VisitCount DEFAULT (0),
        IsActive          BIT               NOT NULL CONSTRAINT DF_Members_IsActive DEFAULT (1),
        CreatedAt         DATETIME2         NOT NULL CONSTRAINT DF_Members_CreatedAt DEFAULT (SYSDATETIME()),
        UpdatedAt         DATETIME2         NOT NULL CONSTRAINT DF_Members_UpdatedAt DEFAULT (SYSDATETIME())
      );
    END;

    IF OBJECT_ID(N'dbo.Promotions', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.Promotions (
        PromotionId       INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Promotions PRIMARY KEY,
        PromoCode         NVARCHAR(30)      NOT NULL CONSTRAINT UQ_Promotions_PromoCode UNIQUE,
        Title             NVARCHAR(150)     NOT NULL,
        Description       NVARCHAR(500)     NULL,
        DiscountType      NVARCHAR(20)      NOT NULL,
        DiscountValue     DECIMAL(10,2)     NOT NULL,
        PointsCost        INT               NOT NULL CONSTRAINT DF_Promotions_PointsCost DEFAULT (0),
        MinSpend          DECIMAL(10,2)     NOT NULL CONSTRAINT DF_Promotions_MinSpend DEFAULT (0),
        MaxDiscount       DECIMAL(10,2)     NULL,
        IsActive          BIT               NOT NULL CONSTRAINT DF_Promotions_IsActive DEFAULT (1),
        CreatedAt         DATETIME2         NOT NULL CONSTRAINT DF_Promotions_CreatedAt DEFAULT (SYSDATETIME())
      );
    END;

    IF OBJECT_ID(N'dbo.PointTransactions', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.PointTransactions (
        TransactionId     INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PointTransactions PRIMARY KEY,
        MemberId          INT               NOT NULL CONSTRAINT FK_PointTransactions_Members FOREIGN KEY REFERENCES dbo.Members (MemberId) ON DELETE CASCADE,
        PromotionId       INT               NULL CONSTRAINT FK_PointTransactions_Promotions FOREIGN KEY REFERENCES dbo.Promotions (PromotionId) ON DELETE SET NULL,
        SessionRef        NVARCHAR(64)      NULL,
        TransactionType   NVARCHAR(20)      NOT NULL,
        PointsDelta       INT               NOT NULL,
        DiscountAmount    DECIMAL(10,2)     NOT NULL CONSTRAINT DF_PointTransactions_DiscountAmount DEFAULT (0),
        BillAmount        DECIMAL(10,2)     NOT NULL CONSTRAINT DF_PointTransactions_BillAmount DEFAULT (0),
        Note              NVARCHAR(300)     NULL,
        CreatedBy         NVARCHAR(100)     NULL,
        CreatedAt         DATETIME2         NOT NULL CONSTRAINT DF_PointTransactions_CreatedAt DEFAULT (SYSDATETIME())
      );
    END;
  `);

  await pool.request().batch(`
    CREATE OR ALTER VIEW dbo.vw_MemberSummary
    AS
    SELECT
      m.MemberId,
      m.MemberCode,
      m.FullName,
      m.Phone,
      m.Email,
      m.CurrentPoints,
      m.LifetimePoints,
      m.TotalSpent,
      m.VisitCount,
      m.IsActive,
      m.CreatedAt,
      t.TierId,
      t.TierCode,
      t.TierName,
      t.DiscountPercent,
      t.PointsMultiplier,
      COUNT(pt.TransactionId) AS TotalTransactions,
      COALESCE(SUM(CASE WHEN pt.DiscountAmount > 0 THEN pt.DiscountAmount ELSE 0 END), 0) AS TotalDiscountSaved
    FROM dbo.Members AS m
    INNER JOIN dbo.MembershipTiers AS t ON m.TierId = t.TierId
    LEFT JOIN dbo.PointTransactions AS pt ON m.MemberId = pt.MemberId
    GROUP BY
      m.MemberId, m.MemberCode, m.FullName, m.Phone, m.Email,
      m.CurrentPoints, m.LifetimePoints, m.TotalSpent, m.VisitCount,
      m.IsActive, m.CreatedAt,
      t.TierId, t.TierCode, t.TierName, t.DiscountPercent, t.PointsMultiplier;
  `);

  await pool.request().batch(`
    IF NOT EXISTS (SELECT 1 FROM dbo.MembershipTiers WHERE TierCode = N'MEMBER')
    BEGIN
      INSERT INTO dbo.MembershipTiers (TierCode, TierName, MinPoints, DiscountPercent, PointsMultiplier)
      VALUES
        (N'MEMBER', N'สมาชิกทั่วไป', 0,   0.00,  1.00),
        (N'SILVER', N'Silver',       50,  5.00,  1.20),
        (N'GOLD',   N'Gold',         150, 10.00, 1.50),
        (N'VIP',    N'VIP',          400, 15.00, 2.00);
    END;

    IF NOT EXISTS (SELECT 1 FROM dbo.Promotions WHERE PromoCode = N'WELCOME30')
    BEGIN
      INSERT INTO dbo.Promotions (PromoCode, Title, Description, DiscountType, DiscountValue, PointsCost, MinSpend, MaxDiscount, IsActive)
      VALUES
        (N'WELCOME30', N'ต้อนรับสมาชิกใหม่ ลด 30 บาท',       N'คูปองต้อนรับสมาชิก ใช้ลดทันทีเมื่อทานครบ 299 บาท ไม่ต้องใช้แต้ม', N'FIXED',   30.00,  0,   299.00, NULL,   1),
        (N'SAVE50',    N'แลก 30 แต้ม ลดทันที 50 บาท',         N'ใช้แต้มสะสม 30 แต้ม แลกส่วนลดท้ายบิล 50 บาท เมื่อทานครบ 399 บาท',   N'FIXED',   50.00,  30,  399.00, NULL,   1),
        (N'SAVE10PCT', N'แลก 50 แต้ม ลด 10% (สูงสุด 150 บ.)', N'ใช้แต้มสะสม 50 แต้ม ลดค่าอาหาร 10% สูงสุด 150 บาท เมื่อครบ 500 บาท', N'PERCENT', 10.00,  50,  500.00, 150.00, 1),
        (N'VIP150',    N'แลก 100 แต้ม ลดจัดเต็ม 150 บาท',     N'ใช้แต้มสะสม 100 แต้ม ลดทันที 150 บาท เมื่อทานครบ 899 บาท',          N'FIXED',   150.00, 100, 899.00, NULL,   1);
    END;
  `);

  cache.mssqlInitialized = true;
}

async function getMssqlPool(cfg) {
  if (cache.mssqlPool && cache.mssqlPool.connected) {
    return cache.mssqlPool;
  }
  if (cache.mssqlPromise) {
    return cache.mssqlPromise;
  }

  const connectAttempt = (async () => {
    if (!cfg.user) {
      const err = new Error('กรุณาตั้งค่า SQL_USER และ SQL_PASSWORD ในไฟล์ .env สำหรับเชื่อมต่อ SQL Server (SSMS)');
      err.code = 'SQL_CREDENTIALS_MISSING';
      throw err;
    }

    let pool;
    try {
      pool = await new sql.ConnectionPool(cfg.mssqlConfig).connect();
    } catch (firstError) {
      // Auto-create database if user hasn't run sql/buffet_loyalty_ssms.sql yet
      // and login has permission on master.
      const safeDbIdentifier = /^[A-Za-z0-9_]+$/.test(cfg.database) ? cfg.database : null;
      const isDbMissing = /cannot open database|login failed for user/i.test(firstError.message)
        && /cannot open database/i.test(firstError.message);
      if (isDbMissing && safeDbIdentifier) {
        const masterPool = await new sql.ConnectionPool({
          ...cfg.mssqlConfig,
          database: 'master',
        }).connect();
        try {
          await masterPool.request().query(`
            IF DB_ID(N'${safeDbIdentifier}') IS NULL
            BEGIN
              CREATE DATABASE [${safeDbIdentifier}];
            END
          `);
        } finally {
          await masterPool.close().catch(() => {});
        }
        pool = await new sql.ConnectionPool(cfg.mssqlConfig).connect();
      } else {
        throw firstError;
      }
    }

    pool.on('error', (err) => {
      console.error('SQL Server pool error:', err.message);
      cache.mssqlPool = null;
      cache.mssqlInitialized = false;
    });

    await ensureMssqlSchema(pool);
    cache.mssqlPool = pool;
    cache.lastMssqlError = null;
    console.log(`SQL Server (SSMS) connected: ${cfg.serverHost}${cfg.instanceName ? `\\${cfg.instanceName}` : ''} (${cfg.database})`);
    return pool;
  })();

  cache.mssqlPromise = connectAttempt;
  try {
    return await connectAttempt;
  } catch (error) {
    cache.mssqlPool = null;
    cache.mssqlInitialized = false;
    cache.lastMssqlError = error.message;
    throw error;
  } finally {
    if (cache.mssqlPromise === connectAttempt) {
      cache.mssqlPromise = null;
    }
  }
}

function shouldPersistSqlite(cfg) {
  if (cfg.forceMemorySqlite) return false;
  if (process.env.VERCEL) return false;
  return true;
}

function persistSqliteToDisk(db, cfg) {
  if (!shouldPersistSqlite(cfg)) return;
  try {
    const dir = path.dirname(LOCAL_SQLITE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const data = db.export();
    fs.writeFileSync(LOCAL_SQLITE_PATH, Buffer.from(data));
  } catch (error) {
    console.warn('Could not persist local SQL demo database:', error.message);
  }
}

function initializeSqliteSchemaAndSeed(db, cfg) {
  db.run('PRAGMA foreign_keys = ON;');

  db.run(`
    CREATE TABLE IF NOT EXISTS MembershipTiers (
      TierId            INTEGER PRIMARY KEY AUTOINCREMENT,
      TierCode          TEXT NOT NULL UNIQUE,
      TierName          TEXT NOT NULL,
      MinPoints         INTEGER NOT NULL DEFAULT 0,
      DiscountPercent   REAL NOT NULL DEFAULT 0,
      PointsMultiplier  REAL NOT NULL DEFAULT 1.00,
      CreatedAt         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS Members (
      MemberId          INTEGER PRIMARY KEY AUTOINCREMENT,
      MemberCode        TEXT NOT NULL UNIQUE,
      FullName          TEXT NOT NULL,
      Phone             TEXT NOT NULL UNIQUE,
      Email             TEXT NULL,
      TierId            INTEGER NOT NULL REFERENCES MembershipTiers(TierId),
      CurrentPoints     INTEGER NOT NULL DEFAULT 0 CHECK (CurrentPoints >= 0),
      LifetimePoints    INTEGER NOT NULL DEFAULT 0 CHECK (LifetimePoints >= 0),
      TotalSpent        REAL NOT NULL DEFAULT 0 CHECK (TotalSpent >= 0),
      VisitCount        INTEGER NOT NULL DEFAULT 0 CHECK (VisitCount >= 0),
      IsActive          INTEGER NOT NULL DEFAULT 1,
      CreatedAt         TEXT NOT NULL DEFAULT (datetime('now')),
      UpdatedAt         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS Promotions (
      PromotionId       INTEGER PRIMARY KEY AUTOINCREMENT,
      PromoCode         TEXT NOT NULL UNIQUE,
      Title             TEXT NOT NULL,
      Description       TEXT NULL,
      DiscountType      TEXT NOT NULL CHECK (DiscountType IN ('FIXED', 'PERCENT')),
      DiscountValue     REAL NOT NULL CHECK (DiscountValue > 0),
      PointsCost        INTEGER NOT NULL DEFAULT 0 CHECK (PointsCost >= 0),
      MinSpend          REAL NOT NULL DEFAULT 0 CHECK (MinSpend >= 0),
      MaxDiscount       REAL NULL,
      IsActive          INTEGER NOT NULL DEFAULT 1,
      CreatedAt         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS PointTransactions (
      TransactionId     INTEGER PRIMARY KEY AUTOINCREMENT,
      MemberId          INTEGER NOT NULL REFERENCES Members(MemberId) ON DELETE CASCADE,
      PromotionId       INTEGER NULL REFERENCES Promotions(PromotionId) ON DELETE SET NULL,
      SessionRef        TEXT NULL,
      TransactionType   TEXT NOT NULL CHECK (TransactionType IN ('EARN', 'REDEEM', 'BONUS', 'ADJUST', 'REFUND')),
      PointsDelta       INTEGER NOT NULL,
      DiscountAmount    REAL NOT NULL DEFAULT 0,
      BillAmount        REAL NOT NULL DEFAULT 0,
      Note              TEXT NULL,
      CreatedBy         TEXT NULL,
      CreatedAt         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE VIEW IF NOT EXISTS vw_MemberSummary AS
    SELECT
      m.MemberId,
      m.MemberCode,
      m.FullName,
      m.Phone,
      m.Email,
      m.CurrentPoints,
      m.LifetimePoints,
      m.TotalSpent,
      m.VisitCount,
      m.IsActive,
      m.CreatedAt,
      t.TierId,
      t.TierCode,
      t.TierName,
      t.DiscountPercent,
      t.PointsMultiplier,
      COUNT(pt.TransactionId) AS TotalTransactions,
      COALESCE(SUM(CASE WHEN pt.DiscountAmount > 0 THEN pt.DiscountAmount ELSE 0 END), 0) AS TotalDiscountSaved
    FROM Members AS m
    INNER JOIN MembershipTiers AS t ON m.TierId = t.TierId
    LEFT JOIN PointTransactions AS pt ON m.MemberId = pt.MemberId
    GROUP BY
      m.MemberId, m.MemberCode, m.FullName, m.Phone, m.Email,
      m.CurrentPoints, m.LifetimePoints, m.TotalSpent, m.VisitCount,
      m.IsActive, m.CreatedAt,
      t.TierId, t.TierCode, t.TierName, t.DiscountPercent, t.PointsMultiplier;
  `);

  const tierCountRes = db.exec('SELECT COUNT(*) FROM MembershipTiers;');
  const tierCount = tierCountRes[0]?.values?.[0]?.[0] || 0;
  let seeded = false;

  if (tierCount === 0) {
    db.run(`
      INSERT INTO MembershipTiers (TierCode, TierName, MinPoints, DiscountPercent, PointsMultiplier)
      VALUES
        ('MEMBER', 'สมาชิกทั่วไป', 0,   0.00,  1.00),
        ('SILVER', 'Silver',       50,  5.00,  1.20),
        ('GOLD',   'Gold',         150, 10.00, 1.50),
        ('VIP',    'VIP',          400, 15.00, 2.00);
    `);
    seeded = true;
  }

  const promoCountRes = db.exec('SELECT COUNT(*) FROM Promotions;');
  const promoCount = promoCountRes[0]?.values?.[0]?.[0] || 0;
  if (promoCount === 0) {
    db.run(`
      INSERT INTO Promotions (PromoCode, Title, Description, DiscountType, DiscountValue, PointsCost, MinSpend, MaxDiscount, IsActive)
      VALUES
        ('WELCOME30', 'ต้อนรับสมาชิกใหม่ ลด 30 บาท',       'คูปองต้อนรับสมาชิก ใช้ลดทันทีเมื่อทานครบ 299 บาท ไม่ต้องใช้แต้ม', 'FIXED',   30.00,  0,   299.00, NULL,   1),
        ('SAVE50',    'แลก 30 แต้ม ลดทันที 50 บาท',         'ใช้แต้มสะสม 30 แต้ม แลกส่วนลดท้ายบิล 50 บาท เมื่อทานครบ 399 บาท',   'FIXED',   50.00,  30,  399.00, NULL,   1),
        ('SAVE10PCT', 'แลก 50 แต้ม ลด 10% (สูงสุด 150 บ.)', 'ใช้แต้มสะสม 50 แต้ม ลดค่าอาหาร 10% สูงสุด 150 บาท เมื่อครบ 500 บาท', 'PERCENT', 10.00,  50,  500.00, 150.00, 1),
        ('VIP150',    'แลก 100 แต้ม ลดจัดเต็ม 150 บาท',     'ใช้แต้มสะสม 100 แต้ม ลดทันที 150 บาท เมื่อทานครบ 899 บาท',          'FIXED',   150.00, 100, 899.00, NULL,   1);
    `);
    seeded = true;
  }

  const memberCountRes = db.exec('SELECT COUNT(*) FROM Members;');
  const memberCount = memberCountRes[0]?.values?.[0]?.[0] || 0;
  if (memberCount === 0) {
    db.run(`
      INSERT INTO Members (MemberCode, FullName, Phone, Email, TierId, CurrentPoints, LifetimePoints, TotalSpent, VisitCount, IsActive)
      VALUES
        ('MB0001', 'สมชาย ใจดี',       '0812345678', 'somchai@example.com',   3, 135, 165, 12850.00, 8, 1),
        ('MB0002', 'พิมพ์ชนก รักชาบู',  '0898765432', 'pimchanok@example.com', 2, 62,  62,  5490.00,  4, 1),
        ('MB0003', 'กิตติพงศ์ สายเนื้อ', '0861112233', 'kittipong@example.com', 1, 18,  18,  1790.00,  2, 1);

      INSERT INTO PointTransactions (MemberId, PromotionId, SessionRef, TransactionType, PointsDelta, DiscountAmount, BillAmount, Note, CreatedBy)
      VALUES
        (1, NULL, 'seed-session-001', 'EARN',    25,  0.00, 1690.00, 'สะสมแต้มจากการชำระค่าอาหาร', 'admin'),
        (1, 2,    'seed-session-002', 'REDEEM', -30, 50.00, 1190.00, 'แลกคูปอง SAVE50 ลด 50 บาท', 'admin'),
        (1, NULL, 'seed-session-002', 'EARN',    17,  0.00, 1140.00, 'สะสมแต้มจากการชำระค่าอาหาร (Gold x1.5)', 'admin'),
        (2, NULL, 'seed-session-003', 'EARN',    14,  0.00, 1198.00, 'สะสมแต้มจากการชำระค่าอาหาร (Silver x1.2)', 'admin');
    `);
    seeded = true;
  }

  if (seeded) {
    persistSqliteToDisk(db, cfg);
  }
}

async function getSqliteDb(cfg) {
  if (cache.sqliteDb) {
    return cache.sqliteDb;
  }
  if (cache.sqlitePromise) {
    return cache.sqlitePromise;
  }

  const initAttempt = (async () => {
    const SQL = await initSqlJs();
    let db;
    if (shouldPersistSqlite(cfg) && fs.existsSync(LOCAL_SQLITE_PATH)) {
      const fileBuffer = fs.readFileSync(LOCAL_SQLITE_PATH);
      db = new SQL.Database(new Uint8Array(fileBuffer));
    } else {
      db = new SQL.Database();
    }
    initializeSqliteSchemaAndSeed(db, cfg);
    cache.sqliteDb = db;
    return db;
  })();

  cache.sqlitePromise = initAttempt;
  try {
    return await initAttempt;
  } finally {
    if (cache.sqlitePromise === initAttempt) {
      cache.sqlitePromise = null;
    }
  }
}

function bindSqliteParams(sqlText, params = {}) {
  const bound = {};
  for (const [key, rawVal] of Object.entries(params)) {
    const token = `@${key}`;
    if (!new RegExp(`@${key}\\b`).test(sqlText)) continue;
    if (rawVal === undefined || rawVal === null) {
      bound[token] = null;
    } else if (typeof rawVal === 'boolean') {
      bound[token] = rawVal ? 1 : 0;
    } else if (rawVal instanceof Date) {
      bound[token] = rawVal.toISOString();
    } else {
      bound[token] = rawVal;
    }
  }
  return bound;
}

/**
 * Execute a parameterized SQL query (@param syntax) against either Microsoft SQL Server (SSMS)
 * or the embedded SQL fallback engine when SQL_SERVER is not set.
 */
async function querySql(sqlText, params = {}, options = {}) {
  const cfg = parseSqlConfig();

  if (cfg.configured) {
    const pool = await getMssqlPool(cfg);
    const request = pool.request();
    for (const [key, value] of Object.entries(params)) {
      request.input(key, value === undefined ? null : value);
    }
    let finalSql = sqlText;
    if (Number.isInteger(options.limit) && options.limit > 0) {
      // Standardize row limit across MSSQL (OFFSET/FETCH or TOP) when requested.
      finalSql = sqlText.replace(/^\s*SELECT\s+/i, `SELECT TOP (${options.limit}) `);
    }
    const result = await request.query(finalSql);
    return {
      rows: result.recordset || [],
      rowsAffected: Array.isArray(result.rowsAffected) ? (result.rowsAffected[0] || 0) : 0,
      mode: 'mssql',
    };
  }

  const db = await getSqliteDb(cfg);
  db.run('PRAGMA foreign_keys = ON;');
  let finalSql = sqlText;
  if (Number.isInteger(options.limit) && options.limit > 0) {
    finalSql = `${sqlText.replace(/;\s*$/, '')} LIMIT ${options.limit};`;
  }
  const bound = bindSqliteParams(finalSql, params);
  const isSelect = /^\s*SELECT\b/i.test(finalSql);

  if (isSelect) {
    const stmt = db.prepare(finalSql);
    try {
      stmt.bind(bound);
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      return { rows, rowsAffected: rows.length, mode: 'sqlite_demo' };
    } finally {
      stmt.free();
    }
  }

  const stmt = db.prepare(finalSql);
  try {
    stmt.run(bound);
    const rowsAffected = db.getRowsModified();
    let insertedId = null;
    if (/^\s*INSERT\b/i.test(finalSql)) {
      const idRes = db.exec('SELECT last_insert_rowid() AS id;');
      insertedId = idRes[0]?.values?.[0]?.[0] ?? null;
    }
    if (rowsAffected > 0) {
      persistSqliteToDisk(db, cfg);
    }
    return {
      rows: insertedId !== null ? [{ InsertedId: insertedId }] : [],
      insertedId,
      rowsAffected,
      mode: 'sqlite_demo',
    };
  } finally {
    stmt.free();
  }
}

/**
 * Execute an INSERT statement and return the newly generated identity primary key.
 */
async function insertSql(insertStatement, params = {}) {
  const cfg = parseSqlConfig();
  if (cfg.configured) {
    const cleanSql = insertStatement.replace(/;\s*$/, '');
    const result = await querySql(`${cleanSql}; SELECT CAST(SCOPE_IDENTITY() AS INT) AS InsertedId;`, params);
    const insertedId = result.rows[0]?.InsertedId ?? null;
    return { insertedId, mode: 'mssql' };
  }
  const result = await querySql(insertStatement, params);
  return { insertedId: result.insertedId ?? null, mode: 'sqlite_demo' };
}

/**
 * Inspect SQL database readiness and return safe connection metadata for UI & diagnostics.
 */
async function getSqlStatus() {
  const cfg = parseSqlConfig();
  if (cfg.configured) {
    try {
      const pool = await getMssqlPool(cfg);
      await pool.request().query('SELECT 1 AS ok;');
      return {
        connected: true,
        mode: 'mssql',
        engine: 'Microsoft SQL Server (SSMS)',
        server: `${cfg.serverHost}${cfg.instanceName ? `\\${cfg.instanceName}` : ''}`,
        port: cfg.port,
        database: cfg.database,
        scriptPath: 'sql/buffet_loyalty_ssms.sql',
        error: null,
      };
    } catch (error) {
      return {
        connected: false,
        mode: 'mssql_error',
        engine: 'Microsoft SQL Server (SSMS)',
        server: `${cfg.serverHost}${cfg.instanceName ? `\\${cfg.instanceName}` : ''}`,
        port: cfg.port,
        database: cfg.database,
        scriptPath: 'sql/buffet_loyalty_ssms.sql',
        error: error.message,
      };
    }
  }

  await getSqliteDb(cfg);
  return {
    connected: true,
    mode: 'sqlite_demo',
    engine: 'Local SQL Engine (ตั้งค่า SQL_SERVER ใน .env เพื่อเชื่อม SSMS)',
    server: 'local-sql-demo',
    port: null,
    database: cfg.database,
    scriptPath: 'sql/buffet_loyalty_ssms.sql',
    error: null,
  };
}

async function connectSqlOptional() {
  const status = await getSqlStatus();
  if (status.mode === 'mssql_error') {
    console.warn(`SQL Server connection warning (${status.server}): ${status.error}`);
  } else if (status.mode === 'sqlite_demo') {
    console.log('SQL Loyalty module running in Local SQL Demo mode (set SQL_SERVER in .env to connect to SSMS).');
  }
  return status;
}

async function closeSqlConnections() {
  if (cache.mssqlPool) {
    try {
      await cache.mssqlPool.close();
    } catch {}
    cache.mssqlPool = null;
    cache.mssqlInitialized = false;
  }
  if (cache.sqliteDb) {
    try {
      cache.sqliteDb.close();
    } catch {}
    cache.sqliteDb = null;
  }
}

module.exports = {
  DEFAULT_SQL_DB_NAME,
  parseSqlConfig,
  querySql,
  insertSql,
  getSqlStatus,
  connectSqlOptional,
  closeSqlConnections,
};
