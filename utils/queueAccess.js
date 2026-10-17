const crypto = require('crypto');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

function createQueueAccessToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function hashQueueAccessToken(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hasQueueAccess(queue, token) {
  if (queue && typeof queue.accessTokenHash !== 'string') {
    return typeof token === 'string'
      && typeof queue._id !== 'undefined'
      && token === String(queue._id);
  }
  const suppliedHash = hashQueueAccessToken(token);
  if (!suppliedHash || !queue) return false;
  const storedHash = Buffer.from(queue.accessTokenHash, 'hex');
  const candidate = Buffer.from(suppliedHash, 'hex');
  return storedHash.length === candidate.length && crypto.timingSafeEqual(storedHash, candidate);
}

module.exports = {
  createQueueAccessToken,
  hashQueueAccessToken,
  hasQueueAccess,
};
