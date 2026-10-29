// Local browser fixtures only: no MongoDB, credentials, or production requests.
// Set CHROME_PATH if Playwright's Chromium is not installed.
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright-core');

const order = (id, status = 'pending') => ({
  _id: id, status, createdAt: '2026-10-29T05:00:00Z', totalPrice: 100,
  tableId: { tableNumber: 'A1' }, items: [{ name: 'Fixture food', quantity: 1, price: 100 }],
});
const socketMock = () => {
  window.io = () => {
    const handlers = new Map();
    window.__socket = {
      connected: false,
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
        return this;
      },
      emit() {},
      dispatch(event, payload) {
        if (event === 'connect') this.connected = true;
        if (['disconnect', 'connect_error'].includes(event)) this.connected = false;
        for (const handler of handlers.get(event) || []) handler(payload);
      },
    };
    return window.__socket;
  };
};

async function main() {
  const app = express();
  app.get('/socket.io/socket.io.js', (_req, res) => res.type('js').send('// Vercel polling-only fixture'));
  app.use(express.static(path.resolve(__dirname, '../public')));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '0.0.0.0', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const errors = [];
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || undefined,
      headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    async function open(pagePath, transport = 'absent', configure = () => {}) {
      const fixture = {
        kitchenOrders: [order('old-kitchen')], readyOrders: [order('old-ready', 'ready')],
        customerOrders: [order('old-customer')], menus: [],
        tables: [{ _id: 'table-1', tableNumber: 'A1', zone: 'small', capacity: 4, minCapacity: 1, status: 'cleaning' }],
        session: { status: 'active', endTime: '2026-10-29T08:00:00Z', tableId: { tableNumber: 'A1' } },
        board: { nowServing: [], waiting: [], totalWaiting: 0 },
        staffRole: 'admin',
        salesToday: { totalSales: 2571.47, paymentCount: 3, salesByDay: [] },
        salesWeek: { totalSales: 2571.47, salesByDay: [{ date: '2026-10-29', totalSales: 2571.47 }] },
        queueStats: { customerCount: 12, totalQueues: 3, waitingCount: 0 },
        dining: { averageMinutes: 42, sessionCount: 3 },
        topMenus: [{ name: 'Fixture menu', quantitySold: 1, sales: 699 }],
        failures: new Set(), invalid: new Set(), holds: {},
      };
      configure(fixture);
      const counts = {}, active = {}, peaks = {};
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addInitScript(({ role }) => {
        if (!['http:', 'https:'].includes(location.protocol)) return;
        localStorage.setItem('lang', 'th');
        sessionStorage.setItem('token', 'local-fixture-token');
        sessionStorage.setItem('staffUser', JSON.stringify({ username: 'Fixture', role }));
        window.__chimes = 0;
        window.__audioContexts = 0;
        // Count actual sound attempts without relying on a speaker in CI.
        window.AudioContext = class {
          constructor() { this.state = 'suspended'; this.currentTime = 0; window.__audioContexts += 1; }
          async resume() { this.state = 'running'; }
          createOscillator() {
            return { frequency: { setValueAtTime() {} }, connect() {}, start() { window.__chimes += 1; }, stop() {} };
          }
          createGain() {
            return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
          }
        };
      }, { role: fixture.staffRole });
      // The dashboard's chart library is external; keep these status tests
      // offline/local and exercise its chart update calls with a small stub.
      await context.route('https://cdn.jsdelivr.net/npm/chart.js', (route) => route.fulfill({
        contentType: 'application/javascript',
        body: 'window.Chart = class { constructor(_canvas, config) { this.data = config.data; } update() {} };',
      }));
      if (transport === 'socket') await context.addInitScript(socketMock);
      if (transport === 'throws') await context.addInitScript(() => { window.io = () => { throw new Error('Unavailable client'); }; });
      await context.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        const resource = url.pathname === '/api/order' ? (url.searchParams.get('status') === 'ready' ? 'readyOrders' : 'kitchenOrders')
          : url.pathname.startsWith('/api/order/session/') ? 'customerOrders'
          : url.pathname.startsWith('/api/session/') ? 'session'
          : url.pathname === '/api/table' ? 'tables'
          : url.pathname === '/api/menu' ? 'menus'
          : url.pathname === '/api/queue/display' ? 'board'
          : url.pathname === '/api/report/daily-sales' ? (url.searchParams.get('days') === '7' ? 'salesWeek' : 'salesToday')
          : url.pathname === '/api/report/queue-stats' ? 'queueStats'
          : url.pathname === '/api/report/dining-time' ? 'dining'
          : url.pathname === '/api/report/top-menus' ? 'topMenus' : 'settings';
        if (url.pathname.startsWith('/api/report/')) {
          assert.equal(route.request().method(), 'GET');
          assert.equal(route.request().headers().authorization, 'Bearer local-fixture-token');
        }
        counts[resource] = (counts[resource] || 0) + 1;
        active[resource] = (active[resource] || 0) + 1;
        peaks[resource] = Math.max(peaks[resource] || 0, active[resource]);
        fixture.onRequest?.(resource);
        const snapshot = JSON.parse(JSON.stringify(fixture[resource] || { restaurantName: 'Local test' }));
        try {
          if (fixture.holds[resource]) await fixture.holds[resource];
          if (fixture.failures.has(resource)) {
            await route.fulfill({ status: 503, json: { success: false, message: 'Fixture API failure', data: [] } });
          } else {
            await route.fulfill({ json: { success: true, data: fixture.invalid.has(resource) ? {} : snapshot } });
          }
        } finally { active[resource] -= 1; }
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(`${pagePath}: ${error.message}`));
      // Freeze time and advance polling timers explicitly rather than waiting
      // 20–30 real seconds for every assertion. HTTP responses still run normally.
      await page.clock.install({ time: new Date('2026-10-29T05:00:00Z') });
      await page.clock.pauseAt(new Date('2026-10-29T05:00:01Z'));
      await page.goto(`${baseUrl}${pagePath}`);
      return { context, page, fixture, counts, peaks };
    }
    async function state(page, expected, selector = '#connection-status') {
      await page.waitForFunction(([selector, expected]) => document.querySelector(selector)?.dataset.connectionState === expected, [selector, expected]);
    }
    async function ready(page, selector = '#connection-status') {
      await state(page, 'polling', selector);
      await page.waitForFunction(() => window.t?.('connection.polling') === 'อัปเดตทุก {seconds} วินาที');
      await page.waitForLoadState('networkidle');
    }
    async function tick(page, seconds) { await page.clock.fastForward(seconds * 1000); }
    async function chimes(page, count) {
      await page.waitForFunction((count) => window.__chimes === count, count);
      assert.equal(await page.evaluate(() => window.__chimes), count);
    }

    // Vercel: no io() at all, but successful HTTP requests are healthy polling.
    {
      const { context, page, fixture } = await open('/kitchen/kitchen.html');
      await ready(page);
      assert.equal(await page.locator('#connection-label').textContent(), 'อัปเดตทุก 20 วินาที');
      await chimes(page, 0);
      assert.equal(await page.evaluate(() => window.__audioContexts), 0, 'Loading old orders must not try to unlock audio');
      fixture.kitchenOrders.push(order('before-gesture'));
      await tick(page, 20);
      await page.waitForFunction(() => document.querySelectorAll('#kitchen-orders > *').length === 2);
      await chimes(page, 0);
      assert.equal(await page.locator('#audio-toast').isVisible(), true);
      await page.locator('h1').click();
      fixture.kitchenOrders.push(order('after-gesture'));
      await tick(page, 20);
      await chimes(page, 1);
      await page.locator('#refresh-orders').click();
      await page.evaluate(() => window.setLang('en'));
      await tick(page, 20);
      assert.equal(await page.locator('#connection-label').textContent(), 'Auto-refresh every 20s');
      await chimes(page, 1);
      fixture.failures.add('kitchenOrders');
      await tick(page, 20); await state(page, 'error');
      assert.equal(await page.locator('#kitchen-orders > *').count(), 3, 'Keep the last successful snapshot on API failure');
      await page.locator('#refresh-menus').click();
      await state(page, 'error'); // Menu success must not clear an order failure.
      await page.evaluate(() => window.setLang('th'));
      await state(page, 'error');
      assert.equal(await page.locator('#connection-label').textContent(), 'โหลดข้อมูลไม่สำเร็จ กำลังลองใหม่');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Kitchen status must fit a mobile viewport');
      fixture.failures.clear();
      await tick(page, 20); await state(page, 'polling');
      await chimes(page, 1);
      await context.close();
      console.log('PASS kitchen polling, autoplay permission, one-time sound, language changes, HTTP failure and recovery');
    }

    {
      const { context, page, fixture } = await open('/waiter/waiter.html');
      await ready(page);
      assert.equal(await page.locator('#connection-label').textContent(), 'อัปเดตทุก 30 วินาที');
      await chimes(page, 0); // Existing ready orders/cleaning tables are silent.
      await page.locator('h1').click();
      fixture.readyOrders.push(order('new-ready', 'ready'));
      await tick(page, 30); await chimes(page, 1);
      await tick(page, 30); await page.locator('#refresh-waiter').click();
      await chimes(page, 1);
      fixture.tables[0].status = 'occupied';
      await tick(page, 30);
      await page.waitForFunction(() => document.getElementById('cleaning-count').textContent === '0');
      fixture.tables[0].status = 'cleaning';
      await tick(page, 30); await chimes(page, 2);
      await tick(page, 30); await chimes(page, 2);
      await page.evaluate(() => window.setLang('en'));
      await page.waitForLoadState('networkidle');
      await chimes(page, 2);
      fixture.failures.add('tables');
      await tick(page, 30); await state(page, 'error');
      await page.locator('#refresh-waiter').click(); await state(page, 'error');
      fixture.failures.clear();
      await tick(page, 30); await state(page, 'polling');
      await chimes(page, 2);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Waiter status must fit a mobile viewport');
      await context.close();
      console.log('PASS waiter ready/cleaning snapshot notifications, no old-order/repeated alarms, partial API failure');
    }

    // Real Socket.IO mode is preserved, with polling taking over on failure.
    {
      const { context, page, fixture, counts, peaks } = await open('/kitchen/kitchen.html', 'socket');
      await ready(page);
      await page.locator('h1').click();
      await page.evaluate(() => window.__socket.dispatch('connect'));
      await state(page, 'live');
      await page.waitForLoadState('networkidle');
      let release;
      fixture.holds.kitchenOrders = new Promise((resolve) => { release = resolve; });
      const before = counts.kitchenOrders;
      const started = new Promise((resolve) => { fixture.onRequest = (resource) => { if (resource === 'kitchenOrders') resolve(); }; });
      await page.evaluate(() => window.__socket.dispatch('new_order'));
      await started;
      delete fixture.onRequest;
      assert.equal(counts.kitchenOrders, before + 1);
      fixture.kitchenOrders.push(order('socket-new'));
      await page.evaluate(() => {
        window.__socket.dispatch('new_order');
        window.__socket.dispatch('new_order');
        window.__socket.dispatch('order_status_changed');
      });
      delete fixture.holds.kitchenOrders; release();
      await page.waitForFunction(() => document.querySelectorAll('#kitchen-orders > *').length === 2);
      await page.waitForLoadState('networkidle');
      await chimes(page, 1);
      assert.equal(peaks.kitchenOrders, 1, 'Concurrent triggers must not race API responses');
      assert.equal(counts.kitchenOrders, before + 2, 'All overlapping triggers should coalesce into one follow-up');
      fixture.failures.add('kitchenOrders');
      await tick(page, 20); await state(page, 'error');
      assert.equal(await page.evaluate(() => window.__socket.connected), true, 'Socket presence is not proof of API health');
      fixture.failures.clear();
      await tick(page, 20); await state(page, 'live');
      await page.evaluate(() => window.__socket.dispatch('connect_error'));
      await state(page, 'polling');
      await page.evaluate(() => window.setLang('en'));
      assert.equal(await page.locator('#connection-label').textContent(), 'Auto-refresh every 20s');
      await page.evaluate(() => window.__socket.dispatch('connect'));
      await state(page, 'live');
      assert.equal(await page.locator('#connection-label').textContent(), 'Live updates');
      await context.close();
      console.log('PASS realtime reconnect/fallback, duplicate socket events, serialized requests and truthful API health');
    }

    {
      const { context, page, fixture } = await open('/waiter/waiter.html', 'socket');
      await ready(page);
      await page.locator('h1').click();
      await page.evaluate(() => window.__socket.dispatch('connect'));
      await state(page, 'live');
      await page.waitForLoadState('networkidle');
      fixture.readyOrders.push(order('socket-ready', 'ready'));
      await page.evaluate(() => {
        window.__socket.dispatch('order_ready');
        window.__socket.dispatch('order_status_changed', { status: 'ready' });
        window.__socket.dispatch('order_ready');
      });
      await page.waitForLoadState('networkidle');
      await chimes(page, 1);
      fixture.tables[0].status = 'occupied';
      await tick(page, 30);
      await page.waitForFunction(() => document.getElementById('cleaning-count').textContent === '0');
      fixture.tables[0].status = 'cleaning';
      await page.evaluate(() => {
        window.__socket.dispatch('table_waiting_for_cleaning');
        window.__socket.dispatch('table_board_updated');
      });
      await page.waitForLoadState('networkidle');
      await chimes(page, 2);
      await page.evaluate(() => window.__socket.dispatch('disconnect'));
      await state(page, 'polling');
      await context.close();
      console.log('PASS waiter socket notifications do not double-play alongside snapshot polling');
    }

    {
      const { context, page, fixture } = await open('/status.html?sessionId=fixture-session');
      await ready(page, '#live-badge');
      assert.equal(await page.locator('#live-badge').textContent(), 'อัปเดตทุก 30 วินาที');
      fixture.invalid.add('customerOrders');
      await tick(page, 30); await state(page, 'error', '#live-badge');
      assert.equal(await page.locator('#orders-list > *').count(), 1, 'Invalid payload must not masquerade as an empty order list');
      await page.evaluate(() => window.setLang('en'));
      assert.equal(await page.locator('#live-badge').textContent(), 'Data unavailable — retrying');
      fixture.invalid.clear();
      fixture.customerOrders.push(order('new-customer', 'ready'));
      await tick(page, 30); await state(page, 'polling', '#live-badge');
      assert.equal(await page.locator('#orders-list > *').count(), 2);
      await context.close();
      console.log('PASS customer status is not stuck connecting; invalid API responses remain visible and recover');
    }

    {
      let release;
      const { context, page, fixture } = await open('/display.html', 'absent', (fixture) => {
        fixture.holds.board = new Promise((resolve) => { release = resolve; });
      });
      await state(page, 'loading', '#live-indicator');
      delete fixture.holds.board; release();
      await ready(page, '#live-indicator');
      assert.equal(await page.locator('#live-label').textContent(), 'อัปเดตทุก 15 วินาที');
      fixture.failures.add('board');
      await tick(page, 15); await state(page, 'error', '#live-indicator');
      fixture.failures.clear();
      await tick(page, 6); await state(page, 'polling', '#live-indicator');
      await context.close();
      console.log('PASS queue display waits for real data, shows polling accurately, and retries failed API reads');
    }
    async function dashboardRectangle(page) {
      const badge = await page.locator('#dashboard-live').evaluate((element) => ({
        radius: getComputedStyle(element).borderRadius,
        rectangle: element.classList.contains('rounded-md'),
        pill: element.classList.contains('rounded-full') || element.classList.contains('badge'),
      }));
      assert.equal(badge.radius, '6px', 'The status background should only have slightly rounded corners');
      assert.equal(badge.rectangle, true);
      assert.equal(badge.pill, false, 'i18n/DaisyUI must not turn the status back into a pill');
    }

    {
      let release;
      const { context, page, fixture, counts } = await open('/admin/dashboard.html', 'absent', (fixture) => {
        fixture.holds.salesWeek = new Promise((resolve) => { release = resolve; });
      });
      await state(page, 'loading', '#dashboard-live');
      await dashboardRectangle(page);
      assert.equal(await page.locator('#dashboard-content').isVisible(), false);
      delete fixture.holds.salesWeek; release();
      await ready(page, '#dashboard-live');
      assert.equal(await page.locator('#dashboard-live').textContent(), 'อัปเดตทุก 30 วินาที');
      assert.equal(await page.locator('#sales-today').textContent(), '฿2,571.47');
      assert.equal(await page.locator('#customers-today').textContent(), '12');
      await dashboardRectangle(page);
      await page.evaluate(() => {
        window.applyTranslations();
        const extra = document.createElement('div');
        extra.innerHTML = '<span data-i18n="common.loadingData"></span>';
        document.body.append(extra); // Trigger the same i18n observer as table/sidebar updates.
      });
      await page.evaluate(() => window.setLang('en'));
      assert.equal(await page.locator('#dashboard-live').textContent(), 'Auto-refresh every 30s');
      await dashboardRectangle(page);
      const before = counts.salesToday;
      fixture.salesToday.totalSales = 2800;
      await tick(page, 30);
      await page.waitForFunction(() => document.getElementById('sales-today').textContent === '฿2,800.00');
      assert.equal(counts.salesToday, before + 1, 'Keep the existing 30-second polling interval');
      for (const resource of ['salesToday', 'salesWeek', 'queueStats', 'dining', 'topMenus']) {
        fixture.failures.add(resource);
        fixture.salesToday.totalSales = 4000;
        await tick(page, 30);
        await page.waitForLoadState('networkidle');
        await state(page, 'error', '#dashboard-live');
        assert.equal(await page.locator('#sales-today').textContent(), '฿2,800.00', 'Do not replace a good dashboard with partial report data');
        assert.equal(await page.locator('#admin-error').isVisible(), true);
        await dashboardRectangle(page);
        fixture.failures.clear();
      }
      await page.evaluate(() => window.setLang('th'));
      assert.equal(await page.locator('#dashboard-live').textContent(), 'โหลดข้อมูลไม่สำเร็จ กำลังลองใหม่');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Dashboard status must fit a mobile viewport');
      await dashboardRectangle(page);
      await tick(page, 30); await state(page, 'polling', '#dashboard-live');
      assert.equal(await page.locator('#sales-today').textContent(), '฿4,000.00');
      assert.equal(await page.locator('#admin-error').isVisible(), false);
      await context.close();
      console.log('PASS dashboard loading/polling, translation observer, all five report failures, recovery and rectangular mobile badge');
    }

    {
      let release;
      const { context, page, fixture, counts, peaks } = await open('/admin/dashboard.html', 'socket', (fixture) => {
        fixture.holds.salesWeek = new Promise((resolve) => { release = resolve; });
      });
      await state(page, 'loading', '#dashboard-live');
      await page.evaluate(() => {
        window.__socket.dispatch('connect');
        window.__socket.dispatch('payment_completed');
        window.__socket.dispatch('new_queue');
      });
      await state(page, 'loading', '#dashboard-live'); // A socket is not a successful report snapshot.
      delete fixture.holds.salesWeek; release();
      await state(page, 'live', '#dashboard-live');
      await page.waitForLoadState('networkidle');
      assert.equal(counts.salesWeek, 2, 'Coalesce overlapping dashboard events into one follow-up snapshot');
      assert.equal(peaks.salesWeek, 1, 'Do not overlap dashboard report snapshots');
      await dashboardRectangle(page);
      for (const resource of ['salesToday', 'salesWeek', 'queueStats', 'dining', 'topMenus']) {
        fixture.invalid.add(resource);
        await tick(page, 30);
        await page.waitForLoadState('networkidle');
        await state(page, 'error', '#dashboard-live');
        assert.equal(await page.evaluate(() => window.__socket.connected), true);
        fixture.invalid.clear();
      }
      await tick(page, 30); await state(page, 'live', '#dashboard-live');
      await page.evaluate(() => window.__socket.dispatch('disconnect'));
      await state(page, 'polling', '#dashboard-live');
      await page.evaluate(() => window.__socket.dispatch('connect_error'));
      await state(page, 'polling', '#dashboard-live');
      await page.evaluate(() => window.__socket.dispatch('connect'));
      await state(page, 'live', '#dashboard-live');
      await page.waitForLoadState('networkidle');
      fixture.holds.salesWeek = new Promise((resolve) => { release = resolve; });
      await context.setOffline(true);
      await state(page, 'error', '#dashboard-live');
      const onlineReadStarted = new Promise((resolve) => { fixture.onRequest = (resource) => { if (resource === 'salesWeek') resolve(); }; });
      await context.setOffline(false);
      await onlineReadStarted;
      delete fixture.onRequest;
      await state(page, 'error', '#dashboard-live'); // Stay red until fresh reports, not merely an online event.
      delete fixture.holds.salesWeek; release();
      await state(page, 'live', '#dashboard-live');
      await dashboardRectangle(page);
      await context.close();
      console.log('PASS dashboard sockets, coalesced refreshes, malformed reports, disconnect fallback and offline recovery');
    }

    {
      let release;
      const { context, page, fixture } = await open('/admin/dashboard.html', 'absent', (fixture) => {
        fixture.holds.salesWeek = new Promise((resolve) => { release = resolve; });
      });
      await state(page, 'loading', '#dashboard-live');
      await tick(page, 15); await state(page, 'error', '#dashboard-live');
      assert.equal(await page.locator('#dashboard-loading').isVisible(), false, 'Stalled reports must not remain loading forever');
      await dashboardRectangle(page);
      delete fixture.holds.salesWeek; release();
      await tick(page, 15); await ready(page, '#dashboard-live');
      await context.close();
      console.log('PASS a stalled dashboard report times out and the next poll recovers');
    }

    {
      const { context, page } = await open('/admin/dashboard.html', 'throws', (fixture) => { fixture.staffRole = 'manager'; });
      await ready(page, '#dashboard-live');
      assert.equal(await page.locator('#manager-quick-actions').isVisible(), true);
      assert.equal(await page.locator('#admin-quick-actions').isVisible(), false);
      await dashboardRectangle(page);
      await context.close();
      console.log('PASS manager dashboard and a throwing socket client retain healthy polling and rectangular styling');
    }

    {
      const { context, page } = await open('/kitchen/kitchen.html', 'throws');
      await ready(page);
      await context.close();
      console.log('PASS a throwing realtime client still falls back to working HTTP polling');
    }
    assert.deepEqual(errors, [], 'No unhandled browser JavaScript errors');
    console.log('Live update UI regression tests passed. All data and audio are local fixtures.');
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
