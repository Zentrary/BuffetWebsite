const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const Live = require('../public/js/live-updates');

function browserHelpers() {
  const listeners = new Map();
  const browser = vm.createContext({
    navigator: { onLine: true },
    addEventListener(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/js/live-updates.js'), 'utf8'), browser);
  return { Live: browser.LiveUpdates, dispatch: (event) => listeners.get(event)?.forEach((handler) => handler()) };
}

function element() {
  return { dataset: {}, className: '', textContent: '', attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } };
}

test('a page starts loading and cannot report healthy before all required HTTP reads succeed', () => {
  const status = Live.createStatus({ intervalMs: 30000, resources: ['orders', 'tables'] });
  assert.equal(status.state(), 'loading');
  status.setSocketConnected(true);
  assert.equal(status.state(), 'loading');
  status.success('orders');
  assert.equal(status.state(), 'loading');
  status.success('tables');
  assert.equal(status.state(), 'live');
});

test('missing/disconnected sockets are a working polling mode, not an API failure', () => {
  const status = Live.createStatus({ intervalMs: 20000 });
  status.success('data');
  assert.equal(status.state(), 'polling');
  status.setSocketConnected(true);
  assert.equal(status.state(), 'live');
  status.setSocketConnected(false);
  assert.equal(status.state(), 'polling');
});

test('one failed API remains visible despite socket connection and other successful API reads', () => {
  const status = Live.createStatus({ intervalMs: 30000, resources: ['orders', 'tables'] });
  status.failure('orders');
  status.success('tables');
  status.setSocketConnected(true);
  assert.equal(status.state(), 'error');
  status.success('tables');
  assert.equal(status.state(), 'error');
  status.success('orders');
  assert.equal(status.state(), 'live');
  assert.throws(() => status.success('typo'), /Unknown connection resource/);
});

test('offline state recovers only after fresh successful responses, not an online event alone', () => {
  const { Live, dispatch } = browserHelpers();
  const status = Live.createStatus({ intervalMs: 30000, resources: ['orders', 'tables'] });
  status.success('orders'); status.success('tables');
  dispatch('offline');
  assert.equal(status.state(), 'error');
  status.success('orders'); // A response racing with the offline event is not recovery.
  dispatch('online');
  assert.equal(status.state(), 'error');
  status.success('orders');
  assert.equal(status.state(), 'error');
  status.success('tables');
  assert.equal(status.state(), 'polling');
});

test('status rendering updates i18n keys/variables and preserves the true mode across language changes', () => {
  const { Live, dispatch } = browserHelpers();
  const badge = element(); const label = element(); const dot = element();
  label.dataset.i18n = 'kitchen.socketConnecting';
  let language = 'th';
  const status = Live.createStatus({
    element: badge, label, dot, intervalMs: 20000,
    translate: (key, vars) => `${language}:${key}:${vars.seconds}`,
  });
  status.success('data');
  assert.equal(badge.dataset.connectionState, 'polling');
  assert.equal(label.dataset.i18n, 'connection.polling');
  assert.equal(label.dataset.i18nVars, '{"seconds":20}');
  assert.equal(label.textContent, 'th:connection.polling:20');
  language = 'en'; dispatch('languageChanged');
  assert.equal(label.textContent, 'en:connection.polling:20');
  assert.equal(badge.attributes['aria-live'], 'polite');
  status.failure('data'); dispatch('languageChanged');
  assert.equal(label.dataset.i18n, 'connection.error');
  assert.equal(badge.dataset.connectionState, 'error');
});

test('initial snapshots are silent; repeated refreshes, missing items, and socket duplicates do not replay alerts', () => {
  const tracker = Live.createChangeTracker();
  assert.deepEqual(tracker.observe([{ _id: 'old' }]), []);
  assert.deepEqual(tracker.observe([{ _id: 'old' }, { _id: 'new' }]), [{ _id: 'new' }]);
  assert.deepEqual(tracker.observe([{ _id: 'old' }, { _id: 'new' }]), []);
  assert.deepEqual(tracker.observe([]), []);
  assert.deepEqual(tracker.observe([{ _id: 'new' }]), []);
  assert.deepEqual(tracker.observe([null, {}, { _id: '' }]), []);
  const emptyBaseline = Live.createChangeTracker();
  assert.deepEqual(emptyBaseline.observe([]), []);
  assert.equal(emptyBaseline.observe([{ _id: 'first-new-order' }]).length, 1);
});

test('a table can notify again for a later cleaning cycle, without repeating for an unchanged snapshot', () => {
  const tracker = Live.createChangeTracker({ value: (table) => table.status });
  const table = (status) => ({ _id: 'A1', status });
  assert.deepEqual(tracker.observe([table('cleaning')]), []);
  assert.equal(tracker.observe([table('occupied')]).length, 1);
  assert.deepEqual(tracker.observe([table('cleaning')]), [table('cleaning')]);
  assert.deepEqual(tracker.observe([table('cleaning')]), []);
  tracker.observe([table('available')]); tracker.observe([table('occupied')]);
  assert.deepEqual(tracker.observe([table('cleaning')]), [table('cleaning')]);
});

test('overlapping polling/socket/manual refreshes are serialized into one queued follow-up', async () => {
  const releases = [];
  let calls = 0, active = 0, peak = 0;
  const load = Live.createLoader(async () => {
    calls += 1; active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
  });
  const first = load();
  assert.equal(load(), first);
  assert.equal(load(), first);
  assert.equal(calls, 1);
  releases.shift()();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 2);
  releases.shift()();
  await first;
  assert.equal(peak, 1);
});

test('a failed loader releases its in-flight guard so a later poll can recover', async () => {
  let calls = 0;
  const load = Live.createLoader(async () => { if (++calls === 1) throw new Error('offline'); });
  await assert.rejects(load(), /offline/);
  await load();
  assert.equal(calls, 2);
});

test('HTTP reads bypass cached snapshots and pass through response/payload for page validation', async (t) => {
  const response = { ok: true, json: async () => ({ success: true, data: [] }) };
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, 'Bearer local-fixture');
    return response;
  });
  const result = await Live.fetchJSON('/api/order', { headers: { Authorization: 'Bearer local-fixture' } });
  assert.equal(result.response, response);
  assert.deepEqual(result.payload, { success: true, data: [] });
  assert.equal(fetch.mock.callCount(), 1);
});

test('stalled HTTP requests time out instead of leaving a permanent healthy/loading badge', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
  }));
  await assert.rejects(Live.fetchJSON('/api/order', {}, 10), /request aborted/);
});

test('status translations exist in both languages and every affected page loads the shared helper first', () => {
  for (const language of ['th', 'en']) {
    const locale = require(`../public/locales/${language}.json`);
    for (const state of ['loading', 'live', 'polling', 'error']) assert.ok(locale[`connection.${state}`]);
    assert.match(locale['connection.polling'], /\{seconds\}/);
  }
  for (const [page, script] of [
    ['public/kitchen/kitchen.html', '/js/kitchen/kitchen.js'],
    ['public/waiter/waiter.html', '/js/waiter/waiter.js'],
    ['public/status.html', '/js/customer/status.js'],
    ['public/display.html', '/js/display.js'],
  ]) {
    const html = fs.readFileSync(path.resolve(__dirname, '..', page), 'utf8');
    const index = html.indexOf('src="/js/live-updates.js"');
    assert.ok(index >= 0 && index < html.indexOf(`src="${script}"`), page);
  }
});
