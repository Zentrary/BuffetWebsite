/* eslint-disable no-console */
const { spawn } = require('child_process');
const fs = require('fs');
const { chromium } = require('playwright-core');

const port = 3103;
const baseUrl = `http://127.0.0.1:${port}`;
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function waitForServer(process) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 15_000);
    process.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('Server listening')) { clearTimeout(timeout); resolve(); }
    });
    process.stderr.on('data', (chunk) => { output += chunk; });
    process.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited (${code}): ${output}`)); });
  });
}

async function main() {
  if (!fs.existsSync(chromePath)) throw new Error('Chrome was not found at the configured path.');
  const server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  try {
    await waitForServer(server);
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const publicPages = ['/', '/queue.html', '/menu.html', '/login.html', '/checkout.html', '/feedback.html'];
    for (const path of publicPages) {
      const response = await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' });
      if (!response || response.status() !== 200) throw new Error(`${path} returned ${response && response.status()}`);
      if (!await page.locator('body').isVisible()) throw new Error(`${path} did not render a visible body`);
    }
    await page.goto(`${baseUrl}/admin/admin-setting.html`, { waitUntil: 'networkidle' });
    if (new URL(page.url()).pathname !== '/login.html') throw new Error(`Unauthenticated admin settings did not redirect to login: ${page.url()}`);
    if (pageErrors.length) throw new Error(`Browser page errors: ${pageErrors.join(' | ')}`);
    console.log(`Browser smoke test passed: ${publicPages.length} public pages + admin authorization redirect.`);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
