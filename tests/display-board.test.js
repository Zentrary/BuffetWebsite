// Guards the TV queue board: the page, its styles and display.js must agree.
// The renderer lives in JS, so a rename in one place silently breaks the board.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (file) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
const html = read('public/display.html');
const script = read('public/js/display.js');

test('every element display.js looks up exists in display.html', () => {
  const ids = [...script.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);
  assert.ok(ids.length >= 12, 'expected the board to look up its controls');
  for (const id of new Set(ids)) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
});

test('the styled class names used by the renderer exist in the page styles', () => {
  const classes = [
    'serving-card', 'serving-head', 'serving-kicker', 'serving-time', 'serving-number',
    'serving-table', 'serving-table-pending', 'serving-meta', 'serving-empty',
    'serving-empty-icon', 'serving-empty-title', 'serving-empty-hint', 'serving-more',
    'waiting-chip', 'waiting-more', 'waiting-empty', 'card-flash', 'live-dot', 'top-accent',
  ];
  for (const name of classes) {
    assert.match(html, new RegExp(`\\.${name}\\b`), `missing .${name} style`);
    if (['serving-card', 'serving-head', 'serving-kicker', 'serving-time', 'serving-number',
      'serving-table', 'serving-meta', 'serving-empty', 'waiting-chip', 'card-flash'].includes(name)) {
      assert.match(script, new RegExp(name), `missing ${name} in display.js`);
    }
  }
});

test('the board keeps its adaptive 1-4 column layout', () => {
  for (const count of [1, 2, 3, 4]) {
    assert.match(html, new RegExp(`#now-serving\\[data-count="${count}"\\]`));
  }
  assert.match(script, /dom\.serving\.dataset\.count = String\(columns\)/);
  assert.match(script, /Math\.min\(visible\.length, 4\)/);
});

test('a called queue shows its table, party and zone with a call time', () => {
  assert.match(script, /data-zone="\$\{zoneName\}"/);
  assert.match(script, /serving-time/);
  assert.match(script, /toLocaleTimeString\('en-GB', \{ hour: '2-digit', minute: '2-digit' \}\)/);
  assert.match(script, /translated\('display\.assigningTable'/);
  // Zone accents must be defined for every zone the API can return.
  for (const zone of ['small', 'medium', 'large']) {
    assert.match(html, new RegExp(`\\.serving-card\\[data-zone="${zone}"\\]`));
  }
});

test('new waiting labels are translated and animations respect reduced motion', () => {
  for (const language of ['th', 'en']) {
    const locale = JSON.parse(read(`public/locales/${language}.json`));
    assert.equal(typeof locale['display.waitingHint'], 'string');
    assert.equal(typeof locale['display.nowServing'], 'string');
  }
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
});

test('the board still loads the shared realtime helper before its own script', () => {
  const liveIndex = html.indexOf('src="/js/live-updates.js"');
  assert.ok(liveIndex >= 0 && liveIndex < html.indexOf('src="/js/display.js"'));
  // Polling + audio + fullscreen behaviour must not regress with the redesign.
  assert.match(script, /POLL_INTERVAL_MS/);
  assert.match(script, /playChime/);
  assert.match(script, /requestFullscreen/);
});
