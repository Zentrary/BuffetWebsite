// Import JWT utilities to authenticate requests and authorize staff roles.
const jwt = require('jsonwebtoken');

/**
 * Verify the Bearer token supplied in the Authorization header.
 * @param {import('express').Request} req - Incoming HTTP request.
 * @param {import('express').Response} res - HTTP response.
 * @param {import('express').NextFunction} next - Express next middleware.
 * @returns {Promise<void>} Sends an error response or continues the middleware chain.
 */
async function protect(req, res, next) {
  const authorization = req.headers.authorization;
  const bearerMatch = authorization && authorization.match(/^Bearer\s+(\S+)$/i);
  const token = bearerMatch ? bearerMatch[1] : null;

  if (!token) {
    return res.status(401).json({ success: false, code: 'UNAUTHORIZED', message: 'Access denied.' });
  }

  if (!process.env.JWT_SECRET) {
    return next(new Error('JWT_SECRET is not configured.'));
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch (error) {
    if (
      error.name === 'JsonWebTokenError'
      || error.name === 'TokenExpiredError'
      || error.name === 'NotBeforeError'
    ) {
      return res.status(401).json({ success: false, code: 'UNAUTHORIZED', message: 'Invalid token.' });
    }

    return next(error);
  }
}

/**
 * Create middleware that allows only the specified user roles.
 * @param {...string} roles - Roles permitted to access the route.
 * @returns {import('express').RequestHandler} Role authorization middleware.
 */
function authorize(...roles) {
  /**
   * Check the authenticated user's role against the roles allowed by the route.
   * @param {import('express').Request} req - Incoming HTTP request.
   * @param {import('express').Response} res - HTTP response.
   * @param {import('express').NextFunction} next - Express next middleware.
   * @returns {import('express').Response|void} Sends a forbidden response or continues.
   */
  return function authorizeRole(req, res, next) {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'You are not allowed to perform this action.' });
    }

    return next();
  };
}

// Export authentication and role authorization middleware.
module.exports = { protect, authorize };
