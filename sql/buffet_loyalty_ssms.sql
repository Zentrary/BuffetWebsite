/* ============================================================================
   ระบบสมาชิก สะสมแต้ม และคูปองส่วนลด (BuffetLoyaltyDB)
   สำหรับรันในโปรแกรม Microsoft SQL Server Management Studio (SSMS)
   วิธีใช้งาน:
     1. เปิดโปรแกรม SQL Server Management Studio (SSMS) และ Connect เข้า Server
     2. กด File -> Open -> File... เลือกไฟล์ sql/buffet_loyalty_ssms.sql นี้
     3. กดปุ่ม Execute (หรือกด F5) เพื่อสร้างฐานข้อมูล ตาราง ความสัมพันธ์ (PK/FK)
        View และข้อมูลตัวอย่างครบชุด
   ============================================================================ */

-- 1. สร้างฐานข้อมูล BuffetLoyaltyDB (ถ้ายังไม่มี)
IF DB_ID(N'BuffetLoyaltyDB') IS NULL
BEGIN
    CREATE DATABASE BuffetLoyaltyDB;
END
GO

USE BuffetLoyaltyDB;
GO

-- 2. ตารางที่ 1: MembershipTiers (ระดับบัตรสมาชิกและสิทธิประโยชน์)
IF OBJECT_ID(N'dbo.MembershipTiers', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.MembershipTiers (
        TierId            INT IDENTITY(1,1) NOT NULL,
        TierCode          NVARCHAR(30)      NOT NULL,
        TierName          NVARCHAR(100)     NOT NULL,
        MinPoints         INT               NOT NULL CONSTRAINT DF_MembershipTiers_MinPoints DEFAULT (0),
        DiscountPercent   DECIMAL(5,2)      NOT NULL CONSTRAINT DF_MembershipTiers_DiscountPercent DEFAULT (0),
        PointsMultiplier  DECIMAL(4,2)      NOT NULL CONSTRAINT DF_MembershipTiers_PointsMultiplier DEFAULT (1.00),
        CreatedAt         DATETIME2         NOT NULL CONSTRAINT DF_MembershipTiers_CreatedAt DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_MembershipTiers PRIMARY KEY (TierId),
        CONSTRAINT UQ_MembershipTiers_TierCode UNIQUE (TierCode),
        CONSTRAINT CK_MembershipTiers_MinPoints CHECK (MinPoints >= 0),
        CONSTRAINT CK_MembershipTiers_Discount CHECK (DiscountPercent >= 0 AND DiscountPercent <= 100),
        CONSTRAINT CK_MembershipTiers_Multiplier CHECK (PointsMultiplier >= 1.00)
    );
END
GO

-- 3. ตารางที่ 2: Members (ข้อมูลสมาชิกลูกค้า เชื่อม FK กับ MembershipTiers)
IF OBJECT_ID(N'dbo.Members', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Members (
        MemberId          INT IDENTITY(1,1) NOT NULL,
        MemberCode        NVARCHAR(20)      NOT NULL,
        FullName          NVARCHAR(150)     NOT NULL,
        Phone             NVARCHAR(20)      NOT NULL,
        Email             NVARCHAR(150)     NULL,
        TierId            INT               NOT NULL,
        CurrentPoints     INT               NOT NULL CONSTRAINT DF_Members_CurrentPoints DEFAULT (0),
        LifetimePoints    INT               NOT NULL CONSTRAINT DF_Members_LifetimePoints DEFAULT (0),
        TotalSpent        DECIMAL(12,2)     NOT NULL CONSTRAINT DF_Members_TotalSpent DEFAULT (0),
        VisitCount        INT               NOT NULL CONSTRAINT DF_Members_VisitCount DEFAULT (0),
        IsActive          BIT               NOT NULL CONSTRAINT DF_Members_IsActive DEFAULT (1),
        CreatedAt         DATETIME2         NOT NULL CONSTRAINT DF_Members_CreatedAt DEFAULT (SYSDATETIME()),
        UpdatedAt         DATETIME2         NOT NULL CONSTRAINT DF_Members_UpdatedAt DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_Members PRIMARY KEY (MemberId),
        CONSTRAINT UQ_Members_MemberCode UNIQUE (MemberCode),
        CONSTRAINT UQ_Members_Phone UNIQUE (Phone),
        CONSTRAINT FK_Members_MembershipTiers FOREIGN KEY (TierId)
            REFERENCES dbo.MembershipTiers (TierId),
        CONSTRAINT CK_Members_CurrentPoints CHECK (CurrentPoints >= 0),
        CONSTRAINT CK_Members_LifetimePoints CHECK (LifetimePoints >= 0),
        CONSTRAINT CK_Members_TotalSpent CHECK (TotalSpent >= 0),
        CONSTRAINT CK_Members_VisitCount CHECK (VisitCount >= 0)
    );

    CREATE INDEX IX_Members_TierId ON dbo.Members (TierId);
    CREATE INDEX IX_Members_FullName ON dbo.Members (FullName);
END
GO

-- 4. ตารางที่ 3: Promotions (คูปองและโปรโมชันแลกแต้มส่วนลด)
IF OBJECT_ID(N'dbo.Promotions', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Promotions (
        PromotionId       INT IDENTITY(1,1) NOT NULL,
        PromoCode         NVARCHAR(30)      NOT NULL,
        Title             NVARCHAR(150)     NOT NULL,
        Description       NVARCHAR(500)     NULL,
        DiscountType      NVARCHAR(20)      NOT NULL,
        DiscountValue     DECIMAL(10,2)     NOT NULL,
        PointsCost        INT               NOT NULL CONSTRAINT DF_Promotions_PointsCost DEFAULT (0),
        MinSpend          DECIMAL(10,2)     NOT NULL CONSTRAINT DF_Promotions_MinSpend DEFAULT (0),
        MaxDiscount       DECIMAL(10,2)     NULL,
        IsActive          BIT               NOT NULL CONSTRAINT DF_Promotions_IsActive DEFAULT (1),
        CreatedAt         DATETIME2         NOT NULL CONSTRAINT DF_Promotions_CreatedAt DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_Promotions PRIMARY KEY (PromotionId),
        CONSTRAINT UQ_Promotions_PromoCode UNIQUE (PromoCode),
        CONSTRAINT CK_Promotions_DiscountType CHECK (DiscountType IN (N'FIXED', N'PERCENT')),
        CONSTRAINT CK_Promotions_DiscountValue CHECK (DiscountValue > 0),
        CONSTRAINT CK_Promotions_PointsCost CHECK (PointsCost >= 0),
        CONSTRAINT CK_Promotions_MinSpend CHECK (MinSpend >= 0)
    );
END
GO

-- 5. ตารางที่ 4: PointTransactions (ประวัติการได้รับแต้ม/แลกคูปอง เชื่อม FK กับ Members และ Promotions)
IF OBJECT_ID(N'dbo.PointTransactions', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.PointTransactions (
        TransactionId     INT IDENTITY(1,1) NOT NULL,
        MemberId          INT               NOT NULL,
        PromotionId       INT               NULL,
        SessionRef        NVARCHAR(64)      NULL, -- อ้างอิงรหัส Session จาก MongoDB
        TransactionType   NVARCHAR(20)      NOT NULL,
        PointsDelta       INT               NOT NULL,
        DiscountAmount    DECIMAL(10,2)     NOT NULL CONSTRAINT DF_PointTransactions_DiscountAmount DEFAULT (0),
        BillAmount        DECIMAL(10,2)     NOT NULL CONSTRAINT DF_PointTransactions_BillAmount DEFAULT (0),
        Note              NVARCHAR(300)     NULL,
        CreatedBy         NVARCHAR(100)     NULL,
        CreatedAt         DATETIME2         NOT NULL CONSTRAINT DF_PointTransactions_CreatedAt DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_PointTransactions PRIMARY KEY (TransactionId),
        CONSTRAINT FK_PointTransactions_Members FOREIGN KEY (MemberId)
            REFERENCES dbo.Members (MemberId) ON DELETE CASCADE,
        CONSTRAINT FK_PointTransactions_Promotions FOREIGN KEY (PromotionId)
            REFERENCES dbo.Promotions (PromotionId) ON DELETE SET NULL,
        CONSTRAINT CK_PointTransactions_Type CHECK (TransactionType IN (N'EARN', N'REDEEM', N'BONUS', N'ADJUST', N'REFUND'))
    );

    CREATE INDEX IX_PointTransactions_MemberId ON dbo.PointTransactions (MemberId, CreatedAt DESC);
    CREATE INDEX IX_PointTransactions_SessionRef ON dbo.PointTransactions (SessionRef);
END
GO

-- 6. สร้าง SQL View สรุปข้อมูลสมาชิกพร้อมระดับบัตรและจำนวนธุรกรรม
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
INNER JOIN dbo.MembershipTiers AS t
    ON m.TierId = t.TierId
LEFT JOIN dbo.PointTransactions AS pt
    ON m.MemberId = pt.MemberId
GROUP BY
    m.MemberId, m.MemberCode, m.FullName, m.Phone, m.Email,
    m.CurrentPoints, m.LifetimePoints, m.TotalSpent, m.VisitCount,
    m.IsActive, m.CreatedAt,
    t.TierId, t.TierCode, t.TierName, t.DiscountPercent, t.PointsMultiplier;
GO

-- 7. เพิ่มข้อมูลเริ่มต้น: ระดับบัตรสมาชิก (MembershipTiers)
IF NOT EXISTS (SELECT 1 FROM dbo.MembershipTiers WHERE TierCode = N'MEMBER')
BEGIN
    INSERT INTO dbo.MembershipTiers (TierCode, TierName, MinPoints, DiscountPercent, PointsMultiplier)
    VALUES
        (N'MEMBER', N'สมาชิกทั่วไป', 0,   0.00,  1.00),
        (N'SILVER', N'Silver',       50,  5.00,  1.20),
        (N'GOLD',   N'Gold',         150, 10.00, 1.50),
        (N'VIP',    N'VIP',          400, 15.00, 2.00);
END
GO

-- 8. เพิ่มข้อมูลเริ่มต้น: คูปองและโปรโมชัน (Promotions)
IF NOT EXISTS (SELECT 1 FROM dbo.Promotions WHERE PromoCode = N'WELCOME30')
BEGIN
    INSERT INTO dbo.Promotions (PromoCode, Title, Description, DiscountType, DiscountValue, PointsCost, MinSpend, MaxDiscount, IsActive)
    VALUES
        (N'WELCOME30', N'ต้อนรับสมาชิกใหม่ ลด 30 บาท',       N'คูปองต้อนรับสมาชิก ใช้ลดทันทีเมื่อทานครบ 299 บาท ไม่ต้องใช้แต้ม', N'FIXED',   30.00,  0,   299.00, NULL,   1),
        (N'SAVE50',    N'แลก 30 แต้ม ลดทันที 50 บาท',         N'ใช้แต้มสะสม 30 แต้ม แลกส่วนลดท้ายบิล 50 บาท เมื่อทานครบ 399 บาท',   N'FIXED',   50.00,  30,  399.00, NULL,   1),
        (N'SAVE10PCT', N'แลก 50 แต้ม ลด 10% (สูงสุด 150 บ.)', N'ใช้แต้มสะสม 50 แต้ม ลดค่าอาหาร 10% สูงสุด 150 บาท เมื่อครบ 500 บาท', N'PERCENT', 10.00,  50,  500.00, 150.00, 1),
        (N'VIP150',    N'แลก 100 แต้ม ลดจัดเต็ม 150 บาท',     N'ใช้แต้มสะสม 100 แต้ม ลดทันที 150 บาท เมื่อทานครบ 899 บาท',          N'FIXED',   150.00, 100, 899.00, NULL,   1);
END
GO

-- 9. เพิ่มข้อมูลสมาชิกตัวอย่าง 3 ราย พร้อมประวัติแต้มตัวอย่าง
IF NOT EXISTS (SELECT 1 FROM dbo.Members WHERE Phone = N'0812345678')
BEGIN
    DECLARE @TierMember INT = (SELECT TierId FROM dbo.MembershipTiers WHERE TierCode = N'MEMBER');
    DECLARE @TierSilver INT = (SELECT TierId FROM dbo.MembershipTiers WHERE TierCode = N'SILVER');
    DECLARE @TierGold   INT = (SELECT TierId FROM dbo.MembershipTiers WHERE TierCode = N'GOLD');
    DECLARE @PromoSave50 INT = (SELECT PromotionId FROM dbo.Promotions WHERE PromoCode = N'SAVE50');

    INSERT INTO dbo.Members (MemberCode, FullName, Phone, Email, TierId, CurrentPoints, LifetimePoints, TotalSpent, VisitCount, IsActive)
    VALUES
        (N'MB0001', N'สมชาย ใจดี',      N'0812345678', N'somchai@example.com',  @TierGold,   135, 165, 12850.00, 8, 1),
        (N'MB0002', N'พิมพ์ชนก รักชาบู', N'0898765432', N'pimchanok@example.com', @TierSilver, 62,  62,  5490.00,  4, 1),
        (N'MB0003', N'กิตติพงศ์ สายเนื้อ', N'0861112233', N'kittipong@example.com', @TierMember, 18,  18,  1790.00,  2, 1);

    DECLARE @Member1 INT = (SELECT MemberId FROM dbo.Members WHERE Phone = N'0812345678');
    DECLARE @Member2 INT = (SELECT MemberId FROM dbo.Members WHERE Phone = N'0898765432');

    INSERT INTO dbo.PointTransactions (MemberId, PromotionId, SessionRef, TransactionType, PointsDelta, DiscountAmount, BillAmount, Note, CreatedBy)
    VALUES
        (@Member1, NULL,         N'seed-session-001', N'EARN',    25,  0.00,  1690.00, N'สะสมแต้มจากการชำระค่าอาหาร', N'admin'),
        (@Member1, @PromoSave50, N'seed-session-002', N'REDEEM', -30, 50.00,  1190.00, N'แลกคูปอง SAVE50 ลด 50 บาท', N'admin'),
        (@Member1, NULL,         N'seed-session-002', N'EARN',    17,  0.00,  1140.00, N'สะสมแต้มจากการชำระค่าอาหาร (Gold x1.5)', N'admin'),
        (@Member2, NULL,         N'seed-session-003', N'EARN',    14,  0.00,  1198.00, N'สะสมแต้มจากการชำระค่าอาหาร (Silver x1.2)', N'admin');
END
GO

/* ============================================================================
   ตัวอย่างคำสั่ง SQL สำหรับกดรันโชว์อาจารย์ใน SSMS
   ============================================================================ */

-- ดูสรุปสมาชิกทั้งหมดพร้อมระดับบัตร (ดึงผ่าน SQL View)
SELECT * FROM dbo.vw_MemberSummary ORDER BY LifetimePoints DESC;

-- ดูการเชื่อมตาราง 3 ตาราง (PointTransactions + Members + Promotions)
SELECT
    pt.TransactionId,
    pt.CreatedAt,
    m.MemberCode,
    m.FullName,
    m.Phone,
    pt.TransactionType,
    pt.PointsDelta,
    p.PromoCode,
    pt.DiscountAmount,
    pt.BillAmount,
    pt.Note
FROM dbo.PointTransactions AS pt
INNER JOIN dbo.Members AS m ON pt.MemberId = m.MemberId
LEFT JOIN dbo.Promotions AS p ON pt.PromotionId = p.PromotionId
ORDER BY pt.TransactionId DESC;

-- สรุปจำนวนสมาชิกและแต้มสะสมแยกตามระดับบัตร (GROUP BY)
SELECT
    t.TierName,
    t.DiscountPercent,
    COUNT(m.MemberId) AS MemberCount,
    COALESCE(SUM(m.CurrentPoints), 0) AS TotalCurrentPoints,
    COALESCE(SUM(m.TotalSpent), 0) AS TotalRevenueFromMembers
FROM dbo.MembershipTiers AS t
LEFT JOIN dbo.Members AS m ON t.TierId = m.TierId
GROUP BY t.TierId, t.TierName, t.DiscountPercent
ORDER BY t.TierId ASC;
GO

/* ============================================================================
   (ทางเลือกเสริม) หากต้องการสร้างผู้ใช้ SQL Login สำหรับใส่ในไฟล์ .env ของเว็บ Node.js:
   หมายเหตุ: ต้องเปิดโหมด SQL Server and Windows Authentication mode ใน Server Properties ก่อน
   ----------------------------------------------------------------------------
   USE [master];
   GO
   IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'buffet_app')
   BEGIN
       CREATE LOGIN [buffet_app] WITH PASSWORD = N'Buffet@Sql1234', CHECK_POLICY = OFF;
   END
   GO
   USE [BuffetLoyaltyDB];
   GO
   IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'buffet_app')
   BEGIN
       CREATE USER [buffet_app] FOR LOGIN [buffet_app];
       ALTER ROLE [db_owner] ADD MEMBER [buffet_app];
   END
   GO
   ============================================================================ */
