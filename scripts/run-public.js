// เริ่มเว็บและ Cloudflare Quick Tunnel พร้อมตรวจปลายทาง HTTPS ก่อนเปิดเบราว์เซอร์
require('dotenv').config();

const { spawn } = require('child_process');
const http = require('http');
const https = require('https');

const port = Number.parseInt(process.env.PORT, 10) || 3000;
const tunnelCommand = process.env.CLOUDFLARED || 'cloudflared';
let tunnel;
let server;
let tunnelBuffer = '';
let serverOutput = '';
let serverLogBuffer = [];
let publicUrl = null;
let serverReady = false;
let checkingPublicUrl = false;
let publicReady = false;
let closing = false;
let lastProbeMessage = '';
let dashboardShown = false;
let verboseMode = false;

// === ANSI ===
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RED = `${ESC}91m`;
const GREEN = `${ESC}92m`;
const YELLOW = `${ESC}93m`;
const BLUE = `${ESC}94m`;
const MAGENTA = `${ESC}95m`;
const CYAN = `${ESC}96m`;
const WHITE = `${ESC}97m`;
const GREY = `${ESC}90m`;

const LINE = '─'.repeat(63);

function tag(kind, text) {
  const map = {
    ok:   `${GREEN}[ OK ]${RESET}`,
    fail: `${RED}[FAIL]${RESET}`,
    warn: `${YELLOW}[WARN]${RESET}`,
    info: `${BLUE}[INFO]${RESET}`,
    web:  `${MAGENTA}[ WEB]${RESET}`,
    tun:  `${CYAN}[TUN ]${RESET}`,
    db:   `${GREEN}[ DB ]${RESET}`,
  };
  return `  ${map[kind] || map.info}  ${text}`;
}

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

function banner() {
  console.log('');
  console.log(`${MAGENTA}  ╔═══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${MAGENTA}  ║${RESET}   ${BOLD}${WHITE}TEEHID BUFFET${RESET}   ${DIM}${GREY}Smart Queue Restaurant${RESET}`);
  console.log(`${MAGENTA}  ║${RESET}   ${GREY}Queue - Dine-in - Kitchen - Checkout${RESET}`);
  console.log(`${MAGENTA}  ╚═══════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');
}

// Skip drawing a closed box — just left bar + label, avoids ANSI width math.
function dashboard() {
  const pub = publicUrl || '(pending)';
  console.log('');
  console.log(`${MAGENTA}  ┌${LINE}┐${RESET}`);
  console.log(`${MAGENTA}  │${RESET}   ${BOLD}${WHITE}TEEHID BUFFET${RESET} ${GREY}- running${RESET}`);
  console.log(`${MAGENTA}  └${LINE}┘${RESET}`);
  console.log('');
  console.log(`    ${CYAN}Local  ${RESET} ${WHITE}http://localhost:${port}${RESET}`);
  console.log(`    ${CYAN}Public ${RESET} ${BOLD}${GREEN}${pub}${RESET}`);
  console.log('');
  console.log(`    ${GREY}QR links use the Public URL. Keep this window open.${RESET}`);
  console.log(`    ${GREY}Press Ctrl+C to stop the server and the tunnel.${RESET}`);
  console.log('');
  if (serverLogBuffer.length > 0) {
    console.log(`    ${DIM}${GREY}(server logs suppressed - ${serverLogBuffer.length} lines buffered)${RESET}`);
  }
  console.log('');
}

function stopChild(child) {
  if (child && child.exitCode === null && !child.killed) child.kill();
}

function shutdown(exitCode) {
  if (closing) return;
  closing = true;
  stopChild(server);
  stopChild(tunnel);
  setTimeout(() => process.exit(exitCode), 500).unref();
}

function fail(message) {
  console.error('');
  console.error(`${RED}  [FAIL]${RESET}  ${message}`);
  shutdown(1);
}

function openBrowser(url) {
  const command = spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], {
    stdio: 'ignore',
    windowsHide: true,
  });
  command.unref();
}

function inspectExistingServer() {
  return new Promise((resolve) => {
    let body = '';
    const request = http.get(`http://127.0.0.1:${port}/`, { timeout: 3000 }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (body.length < 4096) body += chunk;
      });
      response.on('end', () => resolve({
        listening: true,
        isSmartQueue: response.statusCode === 200 && body.includes('Smart Queue Restaurant'),
      }));
    });

    request.on('timeout', () => {
      request.destroy();
      resolve({ listening: true, isSmartQueue: false });
    });
    request.on('error', (error) => {
      resolve({
        listening: error.code !== 'ECONNREFUSED' && error.code !== 'ECONNRESET',
        isSmartQueue: false,
      });
    });
  });
}

function probePublicUrl(url) {
  return new Promise((resolve) => {
    const request = https.get(`${url}/`, { timeout: 7000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (body.length < 500) body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode || 0, body }));
    });
    request.on('timeout', () => request.destroy(new Error('HTTPS health check timed out')));
    request.on('error', (error) => resolve({ status: 0, error: error.message }));
  });
}

async function verifyPublicUrl() {
  if (!serverReady || !publicUrl || checkingPublicUrl || publicReady || closing) return;
  checkingPublicUrl = true;
  console.log(tag('info', `Verifying public HTTPS endpoint ${publicUrl}`));
  const startedAt = Date.now();
  let result;
  while (!closing && Date.now() - startedAt < 90000) {
    result = await probePublicUrl(publicUrl);
    if (result.status >= 200 && result.status < 400) {
      publicReady = true;
      if (!dashboardShown) {
        dashboardShown = true;
        clearScreen();
        dashboard();
      }
      openBrowser(publicUrl);
      checkingPublicUrl = false;
      return;
    }

    const detail = result.status
      ? `HTTP ${result.status}`
      : result.error || 'DNS not ready';
    if (detail !== lastProbeMessage) {
      console.log(tag('info', `Tunnel responded ${detail}; retrying...`));
      lastProbeMessage = detail;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  checkingPublicUrl = false;
  if (!closing) {
    const lastError = result && (result.error || `HTTP ${result.status}`);
    console.error(tag('warn', `Public URL not confirmed (${lastError || 'no response'}). Local access still works; retrying in 15s.`));
    const retryTimer = setTimeout(verifyPublicUrl, 15000);
    retryTimer.unref();
  }
}

function handleServerOutput(chunk) {
  const text = chunk.toString();
  serverOutput += text;
  if (serverOutput.length > 12000) serverOutput = serverOutput.slice(-6000);

  const sawListening = serverOutput.includes(`Server listening on port ${port}`);
  const sawDatabase = /MongoDB database: \S+/.test(serverOutput);
  if (sawListening && !serverReady) {
    serverReady = true;
    verifyPublicUrl();
  }

  if (sawListening && sawDatabase && !dashboardShown) {
    dashboardShown = true;
    clearScreen();
    dashboard();
  } else if (!dashboardShown) {
    // Still in boot phase — echo live so the user sees progress.
    process.stdout.write(text);
  } else {
    // Dashboard shown — suppress noisy output, buffer for later.
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    for (const line of lines) {
      serverLogBuffer.push(line);
      if (serverLogBuffer.length > 500) serverLogBuffer.shift();
      // Only surface real warnings/errors.
      if (/(error|fail|warn|unhandled|crash)/i.test(line)) {
        process.stdout.write(`${YELLOW}  [LOG ]${RESET}  ${line}\n`);
      }
    }
  }
}

function startServer() {
  if (server) return;
  server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PUBLIC_BASE_URL: publicUrl,
      CLIENT_BASE_URL: publicUrl,
      CLIENT_ORIGIN: publicUrl,
    },
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  server.stdout.on('data', handleServerOutput);
  server.stderr.on('data', handleServerOutput);
  server.on('error', (error) => fail(`Failed to start Node.js: ${error.message}`));
  server.on('exit', (code, signal) => {
    if (!closing) {
      const reason = code === null ? signal : `exit code ${code}`;
      fail(`Server stopped (${reason})`);
    }
  });
}

function handleTunnelOutput(chunk) {
  const text = chunk.toString();
  tunnelBuffer += text;
  if (tunnelBuffer.length > 12000) tunnelBuffer = tunnelBuffer.slice(-6000);
  const match = tunnelBuffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (match && !publicUrl) {
    publicUrl = match[0];
    console.log(tag('tun', `Temporary URL assigned: ${publicUrl}`));
    startServer();
  }

  if (!publicUrl && /failed to create|failed to connect|error|ERR_/i.test(text)) {
    console.error(tag('warn', 'Check your internet connection, DNS, and cloudflared installation.'));
  }
}

async function startTunnel() {
  const existingServer = await inspectExistingServer();
  if (existingServer.listening && existingServer.isSmartQueue) {
    console.log(tag('warn', `http://localhost:${port} is already in use by this app.`));
    console.log(tag('info', 'Skipping a new server + tunnel to avoid EADDRINUSE.'));
    console.log(tag('info', 'Use the existing window for public URLs, or close it and run start.bat again.'));
    openBrowser(`http://localhost:${port}`);
    return;
  }
  if (existingServer.listening) {
    fail(`Port ${port} is in use by another program. Close it or change PORT in .env.`);
    return;
  }

  tunnel = spawn(tunnelCommand, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  tunnel.stdout.on('data', handleTunnelOutput);
  tunnel.stderr.on('data', handleTunnelOutput);
  tunnel.on('error', (error) => fail(`Cannot start Cloudflare Tunnel: ${error.message}`));
  tunnel.on('exit', (code, signal) => {
    if (!closing) {
      const reason = code === null ? signal : `exit code ${code}`;
      fail(`Cloudflare Tunnel stopped (${reason})`);
    }
  });

  setTimeout(() => {
    if (!publicUrl && !closing) {
      fail('Waited 90s for a Cloudflare URL with no result. Check your internet and cloudflared.');
    }
  }, 90000);
}

banner();
startTunnel().catch((error) => {
  fail(`Port pre-check before starting Tunnel failed: ${error.message}`);
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));