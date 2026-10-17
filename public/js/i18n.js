// ระบบแปลภาษาไทยและอังกฤษสำหรับข้อความที่กำหนด data-i18n
(() => {
  const DEFAULT_LANGUAGE = 'th';
  const SUPPORTED_LANGUAGES = ['th', 'en'];
  const CACHE_PREFIX = 'locale_cache_';
  const CACHE_VERSION = '2'; // bump เมื่อ schema ของ locale เปลี่ยน

  // Boot: read saved lang immediately so scripts after this file can use window.t()
  let language = (() => {
    try { return localStorage.getItem('lang') || DEFAULT_LANGUAGE; }
    catch { return DEFAULT_LANGUAGE; }
  })();
  if (!SUPPORTED_LANGUAGES.includes(language)) language = DEFAULT_LANGUAGE;

  // Translations per language so we can do cross-locale reverse lookup.
  const translationsByLang = {};
  for (const lang of SUPPORTED_LANGUAGES) {
    try {
      const raw = localStorage.getItem(`${CACHE_PREFIX}${lang}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        // รองรับทั้ง cache แบบเก่า (object ตรงๆ) และแบบใหม่ ({version, data})
        const data = parsed && parsed.version === CACHE_VERSION ? parsed.data : parsed;
        if (data && typeof data === 'object') translationsByLang[lang] = data;
      }
    } catch {}
  }
  let translations = translationsByLang[language] || {};

  try { document.documentElement.lang = language; } catch {}

  function t(key, vars) {
    let value = translations[key];
    if (!value) {
      if (key.startsWith('error.')) value = translations['common.error'] || key;
      else value = key;
    }
    if (vars && typeof vars === 'object') {
      value = String(value).replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
      );
    }
    return value;
  }

  // Text the user is typing (or a value a script just wrote back) must never be
  // rewritten by a re-render; buttons/selects still translate their static labels.
  const USER_VALUE_SELECTOR = 'input, textarea';

  function isTranslatable(element) {
    if (element.hasAttribute('data-shop-name') || element.hasAttribute('data-i18n-skip')) return false;
    return !(element.closest && element.closest(USER_VALUE_SELECTOR));
  }

  // Merge reverse lookups from ALL cached locales.
  function buildReverseLookup() {
    const map = new Map();
    for (const lang of SUPPORTED_LANGUAGES) {
      const data = translationsByLang[lang];
      if (!data) continue;
      for (const [key, value] of Object.entries(data)) {
        if (typeof value !== 'string') continue;
        if (!map.has(value)) map.set(value, key);
      }
    }
    return map;
  }

  // Parse data-i18n-vars='{"n":5}' if present.
  function parseVars(element) {
    if (!element.dataset.i18nVars) return null;
    try { return JSON.parse(element.dataset.i18nVars); }
    catch { return null; }
  }

  function applyTranslations(root = document) {
    const reverseLookup = buildReverseLookup();

    root.querySelectorAll('*').forEach((element) => {
      if (element.hasAttribute('data-i18n')) return;
      if (!isTranslatable(element)) return;
      const directText = Array.from(element.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
      if (!directText) return;
      const key = reverseLookup.get(directText.nodeValue.trim());
      if (key) element.dataset.i18n = key;
    });

    root.querySelectorAll('[data-i18n]').forEach((element) => {
      if (!isTranslatable(element)) return;
      const vars = parseVars(element);
      const value = t(element.dataset.i18n, vars);
      const attributes = (element.dataset.i18nAttr || '').split(',').filter(Boolean);
      attributes.forEach((attribute) => element.setAttribute(attribute, value));

      if (element.dataset.i18nAttr) return;
      const textNode = Array.from(element.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
      if (textNode) textNode.nodeValue = value;
      else if (element.children.length === 0) element.textContent = value;
    });
    document.documentElement.lang = language;
    const switcher = document.getElementById('langSwitcher');
    if (switcher) switcher.value = language;
  }

  function applyDaisyComponents(root = document) {
    // Skip anything inside the admin sidebar: its buttons use pure Tailwind
    // utilities, and inheriting DaisyUI `.btn` would repaint them with the
    // theme's cream background, hiding our custom colors.
    const inSidebar = (el) => Boolean(el && el.closest && el.closest('#admin-sidebar'));

    const selectors = [
      ['button:not(.rating-star):not([data-no-btn])', 'btn'],
      ['input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])', 'input'],
      ['textarea', 'textarea'],
      ['select:not(#langSwitcher)', 'select'],
    ];
    selectors.forEach(([selector, className]) => {
      if (root.matches && root.matches(selector) && !inSidebar(root)) {
        root.classList.add(className);
      }
      root.querySelectorAll(selector).forEach((element) => {
        if (inSidebar(element)) return;
        element.classList.add(className);
      });
    });
    root.querySelectorAll('section.rounded-2xl.bg-white').forEach((card) => card.classList.add('card'));
    // DaisyUI's `.modal-box` caps a panel at 100vh - 5em and adds its own
    // scrollbar. That turned the menu editor into a small scroll area, so the
    // menu form opts out and lets the overlay size itself normally.
    root.querySelectorAll('[role="dialog"] > form, [role="dialog"] > section').forEach((panel) => {
      panel.classList.add('w-full', 'sm:rounded-2xl');
      if (!panel.hasAttribute('data-no-modal-box')) {
        panel.classList.add('modal-box', 'min-h-screen', 'rounded-none', 'sm:min-h-0', 'sm:rounded-2xl');
      }
    });
    root.querySelectorAll('[role="alert"]').forEach((alert) => alert.classList.add('alert'));
    root.querySelectorAll('[role="tab"]').forEach((tab) => tab.classList.add('tab'));
    root.querySelectorAll('span.rounded-full').forEach((badge) => badge.classList.add('badge'));
  }

  // Fetch a single locale and store in cache + memory.
  async function fetchLocale(lang) {
    try {
      const response = await fetch(`/locales/${lang}.json?cache-bust=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return false;
      const data = await response.json();
      translationsByLang[lang] = data;
      try {
        localStorage.setItem(`${CACHE_PREFIX}${lang}`, JSON.stringify({ version: CACHE_VERSION, data }));
      } catch {}
      return true;
    } catch {
      return false;
    }
  }

  // Always refetch both locales so server updates reach the browser.
  async function ensureLocalesLoaded() {
    await Promise.all(SUPPORTED_LANGUAGES.map((lang) => fetchLocale(lang)));
    translations = translationsByLang[language] || {};
  }

  async function setLang(nextLanguage) {
    language = SUPPORTED_LANGUAGES.includes(nextLanguage) ? nextLanguage : DEFAULT_LANGUAGE;
    try { localStorage.setItem('lang', language); } catch {}
    translations = translationsByLang[language] || {};
    applyTranslations();
    window.dispatchEvent(new CustomEvent('languageChanged', { detail: { language } }));
    await ensureLocalesLoaded();
    translations = translationsByLang[language] || {};
    applyTranslations();
    window.dispatchEvent(new CustomEvent('languageChanged', { detail: { language, refreshed: true } }));
  }

  function initI18n() {
    const switcher = document.getElementById('langSwitcher');
    if (switcher) {
      switcher.value = language;
      switcher.addEventListener('change', () => setLang(switcher.value));
      const languageHeader = switcher.closest('header');
      if (languageHeader) languageHeader.classList.replace('z-[100]', 'z-30');
    }
    applyDaisyComponents();

    new MutationObserver((records) => {
      let hasAddedElements = false;
      records.forEach((record) => record.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          hasAddedElements = true;
          applyDaisyComponents(node);
        }
      }));
      if (hasAddedElements) applyTranslations();
    }).observe(document.body, { childList: true, subtree: true });

    applyTranslations();
    setLang(language);
  }

  window.t = t;
  window.setLang = setLang;
  window.applyTranslations = applyTranslations;
  window.initI18n = initI18n;
  Object.defineProperty(window, 'currentLanguage', { get: () => language });

  document.addEventListener('DOMContentLoaded', initI18n, { once: true });
})();