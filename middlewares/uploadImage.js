const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const uploadDirectory = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(uploadDirectory, { recursive: true });
const extensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const storage = multer.diskStorage({
  destination: uploadDirectory,
  filename(req, file, callback) { callback(null, `${crypto.randomUUID()}${extensions[file.mimetype] || ''}`); },
});
module.exports = multer({ storage, limits: { fileSize: 5 * 1024 * 1024, files: 1 }, fileFilter(req, file, callback) {
  callback(null, Boolean(extensions[file.mimetype]));
} });
