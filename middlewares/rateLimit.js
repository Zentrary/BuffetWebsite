// Lightweight in-memory rate limiter. Suitable for a single-node deployment.
// Not shared across processes; safe for this project's single-server setup.

const stores = new Map();

function nowMs() { return Date.now(); }

/**
 * Get or create a bucket store. Each limiter name has its own map so different
 * endpoints can enforce independent quotas.
 * @param {string} name - Bucket identifier.
 * @returns {Map<string, { count: number, resetAt: number }>} Store for the limiter.
 */
function getStore(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  return stores.get(name);
}

// Periodic cleanup so memory does not grow without bound.
setInterval(() => {
  const t = nowMs();
  for (const store of stores.values()) {
    for (const [key, bucket] of store) {
      if (bucket.resetAt <= t) store.delete(key);
    }
  }
}, 60_000).unref();

/**
 * Build an Express middleware that limits requests per key.
 * @param {object} [options={}] - Limiter configuration.
 * @param {string} [options.name='default'] - Store name.
 * @param {number} [options.windowMs=60_000] - Window length in milliseconds.
 * @param {number} [options.max=60] - Maximum requests per window.
 * @param {(req: import('express').Request) => string} [options.keyGenerator] - Custom key.
 * @param {string} [options.message] - Response message on limit.
 * @returns {import('express').RequestHandler} Rate limit middleware.
 */
function rateLimit(options = {}) {
  const name = options.name || 'default';
  const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : 60_000;
  const max = Number.isFinite(options.max) ? options.max : 60;
  const message = options.message || 'คุณทำรายการเร็วเกินไป กรุณารอสักครู่แล้วลองใหม่';
  const keyGenerator = options.keyGenerator || ((req) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
    return ip;
  });
  const store = getStore(name);

  return function rateLimitMiddleware(req, res, next) {
    const key = keyGenerator(req);
    const t = nowMs();
    let bucket = store.get(key);

    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + windowMs };
      store.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(remaining));
    res.set('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - t) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        code: 'RATE_LIMITED',
        data: null,
        message,
      });
    }

    return next();
  };
}

// Helper key generators for common cases.
function keyByIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
}

function keyBySession(req) {
  const body = req.body || {};
  const params = req.params || {};
  const query = req.query || {};
  const value = body.sessionId || params.sessionId || query.sessionId;
  return value ? `session:${value}` : keyByIp(req);
}

module.exports = { rateLimit, keyByIp, keyBySession };