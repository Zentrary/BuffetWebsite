// Vercel serverless functions cannot keep Socket.IO sessions alive. Serve a
// small no-op client script instead; the app's pages detect the missing io()
// client and continue with their existing HTTP polling fallbacks.
module.exports = function socketClientFallback(_req, res) {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).send('// Realtime transport is disabled on Vercel; HTTP polling remains active.\n');
};
