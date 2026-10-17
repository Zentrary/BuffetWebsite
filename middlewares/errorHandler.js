// Convert application errors into consistent HTTP responses.

/**
 * Log an error and return the matching client-safe response.
 * @param {Error & {code?: number}} err - Error passed through Express middleware.
 * @param {import('express').Request} req - Incoming HTTP request.
 * @param {import('express').Response} res - HTTP response.
 * @param {import('express').NextFunction} next - Express next middleware.
 * @returns {void} Sends an error response unless headers have already been sent.
 */
function errorHandler(err, req, res, next) {
  console.error('Application error:', err);

  if (res.headersSent) {
    return next(err);
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({ message: err.message });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({ message: 'รูปแบบ ID ไม่ถูกต้อง' });
  }

  if (err.code === 11000) {
    return res.status(400).json({ message: 'ข้อมูลซ้ำ' });
  }

  return res.status(500).json({ message: 'เกิดข้อผิดพลาดในระบบ' });
}

/**
 * Handle requests that did not match any registered route.
 * @param {import('express').Request} req - Incoming HTTP request.
 * @param {import('express').Response} res - HTTP response.
 * @param {import('express').NextFunction} next - Express next middleware.
 * @returns {import('express').Response} 404 response indicating no route matched.
 */
function notFound(req, res, next) {
  return res.status(404).json({ message: 'ไม่พบเส้นทางนี้' });
}

// Export the not-found and centralized error middleware.
module.exports = { errorHandler, notFound };
