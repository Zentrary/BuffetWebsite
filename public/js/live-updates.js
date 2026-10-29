// Shared HTTP health, polling fallback, and snapshot notification helpers.
// A connected socket alone does not prove that the page can load its data.
((root, factory) => {
  const helpers = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = helpers;
  else root.LiveUpdates = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  const STYLES = {
    loading: 'bg-slate-100 text-slate-600',
    live: 'bg-green-100 text-green-800',
    polling: 'bg-blue-100 text-blue-800',
    error: 'bg-red-100 text-red-800',
  };
  const DARK_STYLES = {
    loading: 'border-slate-700 bg-slate-900 text-slate-400',
    live: 'border-green-500/40 bg-green-500/10 text-green-300',
    polling: 'border-blue-500/40 bg-blue-500/10 text-blue-300',
    error: 'border-red-500/40 bg-red-500/10 text-red-300',
  };
  const DOT_STYLES = {
    loading: 'bg-slate-400', live: 'bg-green-400', polling: 'bg-blue-400', error: 'bg-red-400',
  };

  function createStatus({ element, label = element, dot, intervalMs, resources = ['data'], theme,
    baseClass = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold',
    translate = (key, vars) => root.t ? root.t(key, vars) : key } = {}) {
    const results = new Map(resources.map((resource) => [resource, 'loading']));
    let connected = false;
    let offline = root.navigator?.onLine === false;

    function state() {
      if (offline || [...results.values()].includes('error')) return 'error';
      if ([...results.values()].includes('loading')) return 'loading';
      return connected ? 'live' : 'polling';
    }

    function render() {
      const mode = state();
      const key = `connection.${mode}`;
      const seconds = Math.round(intervalMs / 1000);
      const fallback = { loading: 'Loading data', live: 'Live updates', polling: `Auto-refresh every ${seconds}s`, error: 'Data unavailable — retrying' };
      if (element) {
        element.className = `${baseClass} ${(theme === 'dark' ? DARK_STYLES : STYLES)[mode]}`;
        element.dataset.connectionState = mode;
        element.setAttribute('role', 'status');
        element.setAttribute('aria-live', 'polite');
      }
      if (label) {
        // Keep i18n metadata current, or its mutation observer can restore an
        // obsolete "Connecting" label after a successful refresh/language change.
        label.dataset.i18n = key;
        label.dataset.i18nVars = JSON.stringify({ seconds });
        const text = translate(key, { seconds });
        const nextText = text && text !== key ? text : fallback[mode];
        if (label.textContent !== nextText) label.textContent = nextText;
      }
      if (dot) dot.className = `h-2 w-2 shrink-0 rounded-full ${DOT_STYLES[mode]}`;
    }

    const status = {
      state,
      render,
      success(resource) {
        if (!results.has(resource)) throw new Error(`Unknown connection resource: ${resource}`);
        results.set(resource, offline ? 'error' : 'ready');
        render();
      },
      failure(resource) {
        if (!results.has(resource)) throw new Error(`Unknown connection resource: ${resource}`);
        results.set(resource, 'error');
        render();
      },
      setSocketConnected(value) { connected = Boolean(value); render(); },
    };
    root.addEventListener?.('languageChanged', render);
    root.addEventListener?.('offline', () => {
      offline = true;
      for (const resource of results.keys()) results.set(resource, 'error');
      render();
    });
    root.addEventListener?.('online', () => {
      offline = false;
      // Stay in error until the page has actually fetched each resource again.
      render();
    });
    render();
    return status;
  }

  function openSocket(options) {
    try { return typeof root.io === 'function' ? root.io(options) : null; }
    catch (error) { console.warn('Realtime client unavailable; using HTTP polling:', error); return null; }
  }

  async function fetchJSON(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await root.fetch(url, { ...options, cache: 'no-store', signal: controller.signal });
      const payload = await response.json();
      return { response, payload };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  // Polls, manual refreshes, language changes and socket events may overlap.
  // Serialize them and coalesce triggers into a fresh follow-up request so an
  // older response cannot overwrite a newer snapshot or replay its notification.
  function createLoader(task) {
    let inFlight = null;
    let queued = false;
    return function load() {
      if (inFlight) { queued = true; return inFlight; }
      inFlight = (async () => {
        do {
          queued = false;
          await task();
        } while (queued);
      })().finally(() => { inFlight = null; });
      return inFlight;
    };
  }

  function createChangeTracker({ key = (item) => item?._id, value = () => true, maxEntries = 10000 } = {}) {
    const seen = new Map();
    let initialized = false;
    return {
      observe(items) {
        const changes = [];
        for (const item of items) {
          const id = key(item);
          if (id === null || id === undefined || id === '') continue;
          const normalizedId = String(id);
          const next = value(item);
          if (initialized && (!seen.has(normalizedId) || seen.get(normalizedId) !== next)) changes.push(item);
          seen.set(normalizedId, next);
        }
        // First successful snapshot is the baseline, not a screenful of alerts.
        initialized = true;
        while (seen.size > maxEntries) seen.delete(seen.keys().next().value);
        return changes;
      },
    };
  }

  return { createStatus, openSocket, fetchJSON, createLoader, createChangeTracker };
});
