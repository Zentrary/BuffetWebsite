// Client-side Thai/English dictionary loader, DOM translator, and DaisyUI helper.
(() => {
  const SUPPORTED = new Set(['th', 'en']);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'SVG']);
  const TEXT_SKIP_TAGS = new Set(['INPUT', 'TEXTAREA']);
  const AUTO_ATTRS = [
    ['placeholder', 'data-i18n-placeholder', 'i18nAutoPlaceholder'],
    ['aria-label', 'data-i18n-aria-label', 'i18nAutoAriaLabel'],
    ['title', 'data-i18n-title', 'i18nAutoTitle'],
  ];
  const dictionaries = { th: {}, en: {} };
  const reverseMap = new Map();
  let currentLanguage = getSavedLanguage();
  let observer = null;
  let applying = false;
  let readyResolved = false;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  function getSavedLanguage() {
    const saved = localStorage.getItem('lang') || localStorage.getItem('buffet_lang') || 'th';
    return SUPPORTED.has(saved) ? saved : 'th';
  }

  function saveLanguage(language) {
    localStorage.setItem('lang', language);
    localStorage.setItem('buffet_lang', language);
  }

  function interpolate(template, vars = {}) {
    return String(template).replace(/\{(\w+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
    ));
  }

  function currentData() {
    return dictionaries[currentLanguage] || {};
  }

  function fallbackData() {
    return dictionaries.th || {};
  }

  function fallbackValue(key) {
    if (key.startsWith('error.')) {
      return currentData()['common.error'] || fallbackData()['common.error'] || 'เกิดข้อผิดพลาด กรุณาลองใหม่';
    }
    return key;
  }

  function t(key, vars = {}) {
    const raw = currentData()[key] ?? fallbackData()[key] ?? fallbackValue(key);
    return interpolate(raw, vars);
  }

  function buildReverseMap() {
    reverseMap.clear();
    ['th', 'en'].forEach((lang) => {
      Object.entries(dictionaries[lang] || {}).forEach(([key, value]) => {
        if (typeof value === 'string' && value.trim() && !reverseMap.has(value)) {
          reverseMap.set(value, key);
        }
      });
    });
  }

  async function loadDictionary(language) {
    const response = await fetch(`/locales/${language}.json`, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Cannot load ${language} locale`);
    dictionaries[language] = await response.json();
  }

  function parseVars(element) {
    const raw = element.getAttribute('data-i18n-vars');
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }

  function isTranslatable(el) {
    return Boolean(
      el
      && el.nodeType === 1
      && !SKIP_TAGS.has(el.tagName)
      && !el.closest('[data-i18n-skip], [data-shop-name]')
    );
  }

  function getNonEmptyTextNodes(el) {
    return Array.from(el.childNodes).filter(
      (node) => node.nodeType === Node.TEXT_NODE && node.nodeValue.trim().length > 0
    );
  }

  function setPreservingWhitespace(textNode, translatedText) {
    const lead = /^\s/.test(textNode.nodeValue) ? ' ' : '';
    const trail = /\s$/.test(textNode.nodeValue) ? ' ' : '';
    const nextVal = `${lead}${translatedText}${trail}`;
    if (textNode.nodeValue !== nextVal) textNode.nodeValue = nextVal;
  }

  function applyAttributeTranslations(el, vars) {
    const coveredAttrs = new Set();

    if (el.hasAttribute('data-i18n') && el.hasAttribute('data-i18n-attr')) {
      const key = el.getAttribute('data-i18n');
      const text = t(key, vars);
      const attrNames = el.getAttribute('data-i18n-attr').split(',').map((s) => s.trim()).filter(Boolean);
      attrNames.forEach((name) => {
        coveredAttrs.add(name);
        if (el.getAttribute(name) !== text) el.setAttribute(name, text);
      });
    }

    for (const [attrName, explicitDataAttr, autoDatasetKey] of AUTO_ATTRS) {
      if (coveredAttrs.has(attrName)) continue;
      if (el.hasAttribute(explicitDataAttr)) {
        const key = el.getAttribute(explicitDataAttr);
        const text = t(key, vars);
        if (el.getAttribute(attrName) !== text) el.setAttribute(attrName, text);
        continue;
      }
      if (!el.hasAttribute(attrName)) continue;
      const existingVal = (el.getAttribute(attrName) || '').trim();
      if (!existingVal) continue;
      const autoKey = el.dataset[autoDatasetKey] || reverseMap.get(existingVal);
      if (!autoKey) continue;
      el.dataset[autoDatasetKey] = autoKey;
      const translated = currentData()[autoKey];
      if (translated && el.getAttribute(attrName) !== translated) {
        el.setAttribute(attrName, translated);
      }
    }
  }

  function applyTranslations(root = document) {
    if (!root) return;
    applying = true;
    try {
      const scope = root.nodeType === 1 ? root : document.documentElement;
      if (!scope) return;

      const elements = [scope, ...scope.querySelectorAll('*')];
      for (const el of elements) {
        if (!isTranslatable(el)) continue;

        const vars = parseVars(el);
        applyAttributeTranslations(el, vars);

        if (TEXT_SKIP_TAGS.has(el.tagName)) continue;

        if (el.hasAttribute('data-i18n')) {
          if (el.hasAttribute('data-i18n-attr')) continue;
          const key = el.getAttribute('data-i18n');
          const text = t(key, vars);
          if (el.childElementCount === 0) {
            if (el.textContent !== text) el.textContent = text;
          } else {
            const textNodes = getNonEmptyTextNodes(el);
            if (textNodes.length >= 1) {
              setPreservingWhitespace(textNodes[0], text);
            }
          }
          continue;
        }

        // Reverse-lookup fallback for static labels without explicit data-i18n
        if (el.childElementCount === 0) {
          const rawText = (el.textContent || '').trim();
          if (!rawText) continue;
          const autoKey = el.dataset.i18nAuto || reverseMap.get(rawText);
          if (!autoKey) continue;
          el.dataset.i18nAuto = autoKey;
          const translated = currentData()[autoKey];
          if (translated && el.textContent !== translated) {
            el.textContent = translated;
          }
        } else {
          const textNodes = getNonEmptyTextNodes(el);
          if (textNodes.length === 1) {
            const rawText = textNodes[0].nodeValue.trim();
            const autoKey = el.dataset.i18nAuto || reverseMap.get(rawText);
            if (autoKey) {
              el.dataset.i18nAuto = autoKey;
              const translated = currentData()[autoKey];
              if (translated) setPreservingWhitespace(textNodes[0], translated);
            }
          }
        }
      }

      document.documentElement.lang = currentLanguage;
      document.documentElement.dataset.theme = 'buffet';
      syncSwitchers();
      enhanceDaisyControls(scope);
    } finally {
      applying = false;
    }
  }

  function enhanceDaisyControls(root) {
    root.querySelectorAll('button, input[type="submit"], input[type="button"]').forEach((button) => {
      if (button.classList.contains('btn') || button.hasAttribute('data-no-btn')) return;
      if (button.getAttribute('role') === 'tab' || button.hasAttribute('data-category-pill')) return;
      if (button.closest('#category-tabs, [data-no-daisy-btn]')) return;
      button.classList.add('btn');
    });
    root.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="hidden"]):not([type="submit"]):not([type="button"])').forEach((input) => {
      if (!input.classList.contains('input')) input.classList.add('input', 'input-bordered');
    });
    root.querySelectorAll('select').forEach((select) => {
      if (!select.classList.contains('select')) select.classList.add('select', 'select-bordered');
    });
    root.querySelectorAll('textarea').forEach((textarea) => {
      if (!textarea.classList.contains('textarea')) textarea.classList.add('textarea', 'textarea-bordered');
    });
  }

  function syncSwitchers() {
    document.querySelectorAll('#langSwitcher, [data-lang-switcher]').forEach((switcher) => {
      if (switcher.tagName === 'SELECT') switcher.value = currentLanguage;
      switcher.querySelectorAll('[data-lang]').forEach((button) => {
        const active = button.dataset.lang === currentLanguage;
        button.classList.toggle('btn-primary', active);
        button.classList.toggle('btn-ghost', !active);
        button.setAttribute('aria-pressed', String(active));
      });
    });
  }

  async function setLang(lang) {
    const language = SUPPORTED.has(lang) ? lang : 'th';
    currentLanguage = language;
    saveLanguage(language);
    if (!Object.keys(dictionaries[language] || {}).length) {
      await loadDictionary(language);
      buildReverseMap();
    }
    applyTranslations(document);
    window.dispatchEvent(new CustomEvent('languageChanged', { detail: { language } }));
    window.setTimeout(() => {
      if (currentLanguage !== language) return;
      applyTranslations(document);
      window.dispatchEvent(new CustomEvent('languageChanged', { detail: { language, refreshed: true } }));
    }, 120);
  }

  function bindSwitchers() {
    document.addEventListener('change', (event) => {
      const switcher = event.target.closest('#langSwitcher, select[data-lang-switcher]');
      if (switcher) setLang(switcher.value);
    });
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-lang]');
      if (button) setLang(button.dataset.lang);
    });
  }

  function observeMutations() {
    if (observer || !document.body) return;
    let scheduled = null;
    observer = new MutationObserver(() => {
      if (applying || scheduled) return;
      scheduled = window.requestAnimationFrame(() => {
        scheduled = null;
        applyTranslations(document.body);
      });
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'data-i18n',
        'data-i18n-vars',
        'data-i18n-placeholder',
        'data-i18n-aria-label',
        'data-i18n-title',
      ],
    });
  }

  async function initI18n() {
    bindSwitchers();
    try {
      await Promise.all([loadDictionary('th'), loadDictionary('en')]);
      buildReverseMap();
    } catch (error) {
      console.error('Failed to load translations:', error);
    }
    await setLang(currentLanguage);
    observeMutations();
    if (!readyResolved) {
      readyResolved = true;
      resolveReady(currentLanguage);
    }
  }

  window.t = t;
  window.setLang = setLang;
  window.applyI18n = applyTranslations;
  window.i18n = {
    t,
    setLang,
    apply: applyTranslations,
    getLang: () => currentLanguage,
    ready,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initI18n, { once: true });
  } else {
    initI18n();
  }
})();
