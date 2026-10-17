// คืน URL พื้นฐานสำหรับ QR โดยให้ค่าที่ตั้งใจระบุไว้มีลำดับความสำคัญสูงสุด
const os = require('os');

function getLanIPv4() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    const address = (addresses || []).find((item) => (
      (item.family === 'IPv4' || item.family === 4) && !item.internal
    ));
    if (address) return address.address;
  }
  return null;
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}

function getBaseUrl(req) {
  const configuredUrl = process.env.PUBLIC_BASE_URL;
  if (configuredUrl && configuredUrl.trim()) {
    return normalizeBaseUrl(configuredUrl.trim());
  }

  const host = req && req.headers && req.headers.host;
  if (host) {
    // Reverse proxies such as Cloudflare Tunnel forward the public HTTPS scheme.
    const forwardedProtocol = req.headers['x-forwarded-proto'];
    const protocol = typeof forwardedProtocol === 'string'
      ? forwardedProtocol.split(',')[0].trim().toLowerCase()
      : req.protocol;
    const safeProtocol = protocol === 'https' ? 'https' : 'http';
    return normalizeBaseUrl(`${safeProtocol}://${host}`);
  }

  const lanIPv4 = getLanIPv4();
  const port = Number.parseInt(process.env.PORT, 10) || 3000;
  if (lanIPv4) return `http://${lanIPv4}:${port}`;

  throw new Error('Could not determine the public base URL for queue QR code.');
}

module.exports = getBaseUrl;
