const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const isServerless = Boolean(process.env.VERCEL);
const uploadDirectory = path.join(__dirname, '..', 'public', 'uploads');
const extensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

if (!isServerless) {
  fs.mkdirSync(uploadDirectory, { recursive: true });
}

const storage = isServerless
  ? multer.memoryStorage()
  : multer.diskStorage({
    destination: uploadDirectory,
    filename(req, file, callback) {
      callback(null, `${crypto.randomUUID()}${extensions[file.mimetype] || ''}`);
    },
  });

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(req, file, callback) {
    callback(null, Boolean(extensions[file.mimetype]));
  },
});

// Vercel's function filesystem is ephemeral. Fail clearly instead of accepting
// an upload URL that would disappear as soon as the function instance changes.
upload.requirePersistentStorage = function requirePersistentStorage(_req, res, next) {
  if (isServerless) {
    return res.status(501).json({
      success: false,
      code: 'UPLOAD_STORAGE_UNAVAILABLE',
      message: 'บน Vercel กรุณาใช้ URL ของรูปภาพที่โฮสต์ไว้ภายนอกแทนการอัปโหลดไฟล์',
    });
  }
  return next();
};

module.exports = upload;
