// Import qrcode to generate scannable data URLs for queue entries.
const QRCode = require('qrcode');

/**
 * Generate a Base64 QR Code data URL for an arbitrary customer-facing URL.
 * @param {string} value - URL to encode in the QR code.
 * @returns {Promise<string>} Base64-encoded QR Code data URL.
 */
async function generateQRCode(value) {
  try {
    return await QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 2 });
  } catch (error) {
    console.error('QR Code generation failed:', error);
    throw error;
  }
}

// Export the QR Code generator for queue creation workflows.
module.exports = { generateQRCode };
