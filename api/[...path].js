// Route all API requests through the existing Express application. Vercel
// functions are invoked per request, so DB readiness is awaited before Express
// runs rather than starting a detached connection attempt at module load.
const app = require('../server');
const connectDB = require('../config/db');

module.exports = async function apiHandler(req, res) {
  try {
    // Vercel normally preserves the incoming pathname. Keep the Express route
    // prefix intact if an adapter passes only the path after the function name.
    const requestUrl = req.url || '/';
    if (!/^\/api(?:\/|$|\?)/.test(requestUrl)) {
      req.url = `/api${requestUrl.startsWith('/') ? '' : '/'}${requestUrl}`;
    }

    await connectDB();
    return app(req, res);
  } catch (error) {
    console.error('Vercel API request could not connect to MongoDB:', error.message);
    if (res.headersSent) return undefined;
    return res.status(503).json({
      success: false,
      code: 'DATABASE_UNAVAILABLE',
      message: 'ไม่สามารถเชื่อมต่อฐานข้อมูลได้ กรุณาลองใหม่ภายหลัง',
    });
  }
};
