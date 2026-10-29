// Regression tests with local API fixtures: never connect to or modify MongoDB.
// Set CHROME_PATH to a Chrome/Chromium executable if Playwright's browser isn't installed.
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright-core');
const Categories = require('../config/menuCategories');
const locales = { th: require('../public/locales/th.json'), en: require('../public/locales/en.json') };

async function main() {
  const customCategory = 'พิเศษ <img src=x onerror="window.__categoryXss=true">';
  const menus = [...Categories.ALL_MENU_CATEGORIES, customCategory, null, ''].map((category, index) => ({
    _id: String(index + 1).padStart(24, '0'),
    name: `เมนูทดสอบ ${index + 1}`,
    description: 'Test fixture, not production data',
    category,
    price: 100,
    imageUrl: '/assets/images/default-food.jpg',
    preparationTime: 10,
    isAvailable: true,
    stockQuantity: 50,
    lowStockThreshold: 5,
    maxOrderQuantity: 99,
  }));
  const writes = [];
  const pageErrors = [];
  const dialogs = [];
  const app = express();
  // An absent Socket.IO client exercises the same polling fallback as serverless hosting.
  app.get('/socket.io/socket.io.js', (_req, res) => res.type('js').send(''));
  app.use(express.static(path.resolve(__dirname, '../public')));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '0.0.0.0', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || undefined,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      // Do not mask popup blocking with Playwright's default Chromium flag.
      ignoreDefaultArgs: ['--disable-popup-blocking'],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    context.on('page', (page) => {
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    });
    await context.addInitScript(() => {
      // Playwright also runs init scripts in the popup's opaque about:blank document.
      if (!['http:', 'https:'].includes(location.protocol)) return;
      if (!localStorage.getItem('lang')) localStorage.setItem('lang', 'th');
      localStorage.setItem('menuTab', 'menu');
      localStorage.setItem('kitchenMenuView', 'list');
      if (/^\/(admin|kitchen)\//.test(location.pathname)) {
        sessionStorage.setItem('token', 'local-test-token');
        sessionStorage.setItem('staffUser', JSON.stringify({ role: 'admin', username: 'Fixture admin' }));
      }
    });
    await context.route('**/api/**', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      let data = [];
      if (pathname === '/api/menu') {
        if (request.method() === 'POST') {
          const values = request.postDataJSON();
          const menu = { ...values, _id: String(menus.length + 1).padStart(24, '0'), isAvailable: true };
          menus.push(menu);
          writes.push({ method: 'POST', values });
          data = menu;
        } else data = menus;
      } else if (/^\/api\/menu\/[^/]+$/.test(pathname) && request.method() === 'PUT') {
        const id = pathname.split('/').pop();
        const menu = menus.find((menu) => menu._id === id);
        assert.ok(menu, `Unexpected menu ID: ${id}`);
        const values = request.postDataJSON();
        writes.push({ method: 'PUT', id, values });
        Object.assign(menu, values);
        data = menu;
      } else if (pathname.startsWith('/api/session/')) {
        data = { endTime: new Date(Date.now() + 3_600_000).toISOString(), status: 'active', tableId: { tableNumber: 'A1' } };
      } else if (pathname === '/api/settings/public') {
        data = { restaurantName: 'Regression test restaurant' };
      } else if (pathname === '/api/queue/display') {
        data = { nowServing: [], waiting: [], totalWaiting: 0 };
      }
      await route.fulfill({ json: { success: true, data } });
    });

    const customer = await context.newPage();
    await customer.goto(`${baseUrl}/menu.html?sessionId=local-test-session`);
    await customer.waitForFunction(() => window.t?.('menu.category.set') === 'ชุดเซต'
      && document.querySelector('#category-nav [data-category="set"]')?.textContent.trim() === 'ชุดเซต');
    const customerCategories = await customer.locator('#category-nav [data-category]').evaluateAll((buttons) =>
      buttons.map((button) => ({ value: button.dataset.category, label: button.textContent.trim() })));
    const expectedKeys = Categories.orderedKeys(menus.map((menu) => menu.category));
    assert.deepEqual(customerCategories, expectedKeys.map((value) => ({
      value, label: Categories.label(value, (key) => locales.th[key] || key),
    })));
    assert.equal(await customer.locator('#menu-content article').count(), menus.length, 'Missing/unknown categories must not hide menu items');
    assert.equal(await customer.evaluate(() => Boolean(window.__categoryXss)), false);
    console.log('PASS customer categories: all current, legacy, custom and missing values; Thai labels; safe HTML');

    const admin = await context.newPage();
    await admin.goto(`${baseUrl}/admin/manage-menu.html`);
    await admin.waitForFunction(() => document.querySelector('#menu-search-form option[value="set"]')?.textContent === 'ชุดเซต');
    const filterOptions = await admin.locator('#menu-search-form select[name="category"] option').evaluateAll((options) =>
      options.filter((option) => option.value).map((option) => ({ value: option.value, label: option.textContent })));
    assert.deepEqual(filterOptions, customerCategories, 'Customer sidebar and admin filter must use identical IDs, labels and order');
    assert.equal(await admin.locator('#menu-rows tr').count(), menus.length);
    assert.equal(await admin.evaluate(() => Boolean(window.__categoryXss)), false);

    // Every category from older catalogs (plus custom values) must be selectable
    // before any form changes. This is where the old hard-coded select lost data.
    for (const menu of menus.filter((menu) => menu.category)) {
      await admin.locator(`#menu-rows [data-edit="${menu._id}"]`).click();
      assert.equal(await admin.locator('#menu-form-category').inputValue(), menu.category);
      const label = await admin.locator('#menu-form-category').evaluate((select) => select.selectedOptions[0].textContent);
      assert.equal(label, Categories.label(menu.category, (key) => locales.th[key] || key));
      await admin.locator('#menu-modal [data-close-modal]').first().click();
    }
    console.log('PASS editor opens every existing category without replacing its stored value');

    const saveEditor = async () => {
      await Promise.all([
        admin.waitForResponse((response) => response.url().includes('/api/menu') && ['POST', 'PUT'].includes(response.request().method())),
        admin.locator('#menu-form button[type="submit"]').click(),
      ]);
      await admin.waitForFunction(() => document.getElementById('menu-modal').classList.contains('hidden')
        && document.getElementById('menu-loading').classList.contains('hidden'));
    };
    for (const category of ['set', 'veg', 'dessert_drink', 'vegetable_tofu', customCategory]) {
      const menu = menus.find((menu) => menu.category === category);
      await admin.locator(`#menu-rows [data-edit="${menu._id}"]`).click();
      await admin.locator('#menu-form-description').fill('Changed description only');
      await saveEditor();
      assert.equal(writes.at(-1).values.category, category);
      assert.equal(menu.category, category);
    }
    console.log('PASS unrelated menu edits round-trip problem categories without changing their IDs');

    await admin.locator('#menu-search-form select[name="category"]').selectOption('dessert_drink');
    assert.equal(await admin.locator('#menu-rows tr').count(), 1);
    await admin.locator('#menu-rows [data-edit]').click();
    await admin.locator('#menu-form-name').fill('Unsaved name');
    // Use the same language API as the switcher while the modal is open.
    await admin.evaluate(() => window.setLang('en'));
    await admin.waitForFunction(() => document.querySelector('#menu-form-category option[value="dessert_drink"]')?.textContent === 'Desserts & drinks');
    assert.equal(await admin.locator('#menu-form-category').inputValue(), 'dessert_drink');
    assert.equal(await admin.locator('#menu-form-name').inputValue(), 'Unsaved name');
    assert.equal(await admin.locator('#menu-search-form select[name="category"]').inputValue(), 'dessert_drink');
    assert.equal(await admin.locator('#menu-rows tr').count(), 1);
    await admin.locator('#menu-modal [data-close-modal]').first().click();
    await admin.locator('#menu-search-form select[name="category"]').selectOption('');
    await customer.evaluate(() => window.setLang('en'));
    const englishCategories = await customer.locator('#category-nav [data-category]').evaluateAll((buttons) =>
      buttons.map((button) => ({ value: button.dataset.category, label: button.textContent.trim() })));
    assert.deepEqual(englishCategories, expectedKeys.map((value) => ({ value, label: Categories.label(value, (key) => locales.en[key] || key) })));
    console.log('PASS English translation refresh preserves filter, editor category, and unsaved form values');

    await admin.locator('#add-menu-button').click();
    await admin.locator('#menu-form-category').selectOption('veg');
    await admin.locator('#menu-form-name').fill('ชาไทย');
    assert.equal(await admin.locator('#menu-form-category').inputValue(), 'veg', 'Auto-categorization must not overwrite an explicit choice');
    await saveEditor();
    assert.equal(writes.at(-1).method, 'POST');
    assert.equal(writes.at(-1).values.category, 'veg');
    const changedMenu = menus.find((menu) => menu.category === 'set');
    await admin.locator(`#menu-rows [data-edit="${changedMenu._id}"]`).click();
    await admin.locator('#menu-form-category').selectOption('main');
    await saveEditor();
    assert.equal(changedMenu.category, 'main');
    await customer.reload();
    await customer.waitForFunction((count) => document.querySelectorAll('#menu-content article').length === count, menus.length);
    const changedCategory = await customer.locator(`[data-add="${changedMenu._id}"]`).evaluate((button) => button.closest('section').id);
    assert.equal(changedCategory, 'category-main');
    console.log('PASS explicit category changes and new menus reach the correct customer section');

    const originalAdminUrl = admin.url();
    await admin.evaluate(() => {
      window.__openCalls = 0;
      window.open = () => { window.__openCalls += 1; return null; };
    });
    const openLink = admin.locator('#admin-open-display');
    assert.equal(await openLink.getAttribute('href'), '/display.html');
    assert.equal(await openLink.getAttribute('target'), '_blank');
    assert.match(await openLink.getAttribute('rel'), /noopener/);
    const [display] = await Promise.all([admin.waitForEvent('popup'), openLink.click()]);
    await display.waitForURL(`${baseUrl}/display.html`);
    assert.equal(await display.evaluate(() => window.opener), null);
    assert.equal(await admin.evaluate(() => window.__openCalls), 0);
    assert.equal(admin.url(), originalAdminUrl);
    await display.close();

    // Native links also support keyboard activation and the mobile drawer.
    await admin.setViewportSize({ width: 390, height: 844 });
    await admin.locator('#admin-drawer-toggle').click();
    const [mobileDisplay] = await Promise.all([admin.waitForEvent('popup'), openLink.press('Enter')]);
    await mobileDisplay.waitForURL(`${baseUrl}/display.html`);
    assert.equal(await admin.locator('#admin-drawer-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await admin.evaluate(() => window.__openCalls), 0);
    await mobileDisplay.close();
    assert.deepEqual(dialogs, [], 'Opening the display must not produce a misleading popup-blocked alert');
    assert.deepEqual(pageErrors, [], 'No browser JavaScript errors');
    console.log('PASS queue display: native mouse/keyboard/mobile navigation, isolated opener, no window.open or false alerts');
    console.log(`Menu/display UI regression tests passed (${Categories.ALL_MENU_CATEGORIES.length} registered categories, ${writes.length} fixture writes, no real database).`);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
