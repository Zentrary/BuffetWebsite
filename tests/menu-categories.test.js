const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const Categories = require('../config/menuCategories');
const Menu = require('../models/Menu');

const root = path.resolve(__dirname, '..');
const locales = {
  th: require('../public/locales/th.json'),
  en: require('../public/locales/en.json'),
};

test('server constants and browser share one immutable category registry', () => {
  const constants = require('../config/constants');
  assert.equal(constants.MENU_CATEGORIES, Categories.MENU_CATEGORIES);
  assert.equal(constants.LEGACY_MENU_CATEGORIES, Categories.LEGACY_MENU_CATEGORIES);
  assert.equal(constants.ALL_MENU_CATEGORIES, Categories.ALL_MENU_CATEGORIES);
  assert.equal(new Set(Categories.ALL_MENU_CATEGORIES).size, Categories.ALL_MENU_CATEGORIES.length);
  assert.ok(Object.isFrozen(Categories.ALL_MENU_CATEGORIES));
  const browser = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/menu-categories.js'), 'utf8'), browser);
  assert.deepEqual(Array.from(browser.MenuCategories.ALL_MENU_CATEGORIES), Categories.ALL_MENU_CATEGORIES);
});

for (const language of ['th', 'en']) {
  test(`every supported category has a ${language} label, including the seed's combined categories`, () => {
    const translate = (key) => locales[language][key] || key;
    for (const category of Categories.ALL_MENU_CATEGORIES) {
      const translationKey = `menu.category.${category}`;
      assert.ok(locales[language][translationKey], translationKey);
      assert.equal(Categories.label(category, translate), locales[language][translationKey]);
      assert.ok(!Categories.label(category, translate).startsWith('menu.category.'));
    }
    // New translations must be registered as well, not just offered by one page.
    for (const key of Object.keys(locales[language]).filter((key) => key.startsWith('menu.category.'))) {
      assert.ok(Categories.ALL_MENU_CATEGORIES.includes(key.slice('menu.category.'.length)), key);
    }
  });
}

test('every seed catalog category is supported without changing its stored ID', () => {
  const seed = fs.readFileSync(path.join(root, 'seed.js'), 'utf8');
  const keys = [...seed.matchAll(/^  ([a-z_]+): \[/gm)].map((match) => match[1]);
  assert.ok(keys.includes('dessert_drink'));
  assert.ok(keys.includes('soup_sauce'));
  for (const key of keys) assert.ok(Categories.ALL_MENU_CATEGORIES.includes(key), key);
});

test('legacy and custom category values are preserved rather than guessed or renamed', () => {
  for (const value of ['set', 'set_menu', 'veg', 'vegetable_tofu', 'dessert_drink', 'เมนูพิเศษ', ' custom category ']) {
    assert.equal(Categories.key(value), value);
    assert.equal(Categories.label(value, (key) => key), value);
  }
  assert.equal(Categories.label('custom', () => undefined), 'custom');
  assert.equal(Categories.label('custom', () => ''), 'custom');
  assert.equal(Categories.label('custom'), 'custom');
});

test('missing categories remain visible in one uncategorized group', () => {
  for (const value of [undefined, null, '', '  ']) assert.equal(Categories.key(value), Categories.DEFAULT_CATEGORY);
  const translate = (key) => locales.th[key] || key;
  assert.equal(Categories.label(null, translate), 'ไม่ระบุหมวดหมู่');
  assert.deepEqual(Categories.orderedKeys([null, '', undefined, 'uncategorized']), ['uncategorized']);
});

test('ordering deduplicates IDs, includes custom values, and is identical for every view', () => {
  const values = ['veg', 'set_menu', 'set', 'veg', 'เมนูพิเศษ', '', 'another-custom'];
  const ordered = Categories.orderedKeys(values);
  assert.deepEqual(ordered, ['set', 'veg', 'uncategorized', 'set_menu', 'เมนูพิเศษ', 'another-custom']);
  assert.deepEqual(Categories.orderedKeys([]), []);
  assert.equal(new Set(ordered).size, ordered.length);
});

test('the Menu schema accepts all existing category IDs and custom categories', () => {
  const defaultMenu = new Menu({ name: 'Default category' });
  assert.equal(defaultMenu.category, Categories.DEFAULT_CATEGORY);
  for (const category of [...Categories.ALL_MENU_CATEGORIES, 'เมนูพิเศษ', '<img src=x onerror=alert(1)>']) {
    const menu = new Menu({ name: 'Test menu', category });
    assert.equal(menu.validateSync(), undefined, category);
    assert.equal(menu.toObject().category, category);
  }
});

test('menu create/update handlers round-trip every category without a live database', async (t) => {
  const { createMenu, updateMenu } = require('../controllers/menuController');
  const stored = new Map();
  t.mock.method(Menu, 'create', async (values) => {
    const menu = new Menu(values);
    await menu.validate();
    stored.set(String(menu._id), menu.toObject());
    return menu;
  });
  t.mock.method(Menu, 'findByIdAndUpdate', async (id, values) => {
    const menu = new Menu({ ...stored.get(id), ...values });
    await menu.validate();
    stored.set(id, menu.toObject());
    return menu;
  });
  const response = () => ({
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  for (const category of [...Categories.ALL_MENU_CATEGORIES, 'เมนูพิเศษ']) {
    const req = { user: { role: 'admin' }, app: { get: () => null }, body: { name: 'Round trip', category } };
    const created = response();
    await createMenu(req, created);
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.data.category, category);
    req.params = { id: String(created.body.data._id) };
    req.body.name = 'Updated name, same category';
    const updated = response();
    await updateMenu(req, updated);
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.data.category, category);
    assert.equal(stored.get(req.params.id).category, category);
  }
});

test('all category consumers load the shared browser registry before using it', () => {
  for (const [file, script] of [
    ['public/menu.html', '/js/customer/menu.js'],
    ['public/admin/manage-menu.html', '/js/admin/manageMenu.js'],
    ['public/admin/reports.html', '/js/admin/reports.js'],
    ['public/kitchen/kitchen.html', '/js/kitchen/kitchen.js'],
  ]) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const registryIndex = html.indexOf('src="/js/menu-categories.js"');
    assert.ok(registryIndex !== -1 && registryIndex < html.indexOf(`src="${script}"`), file);
  }
});
