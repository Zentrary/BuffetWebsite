// Single source of truth for menu categories.
//
// MENU_CATEGORIES is the order customers see on the menu page, the admin
// filter dropdown, and the order used by seed.js.
//
// The legacy keys at the bottom are no longer offered when creating a new
// menu item, but they stay valid so older documents (created before the
// 14-category menu catalog) can still be read, edited and saved.
const MENU_CATEGORIES = [
  'set_menu',
  'sukiyaki_hotpan',
  'sushi_roll',
  'japanese_main',
  'chinese_stirfry',
  'fried_appetizer',
  'salad_yum',
  'fresh_meat',
  'fresh_seafood',
  'vegetable_tofu',
  'noodle_rice_side',
  'soup_sauce',
  'dessert',
  'drink',
];

const LEGACY_MENU_CATEGORIES = [
  'appetizer',
  'main',
  'side',
  'meat',
  'seafood',
  'vegetable',
  'noodle',
  'soup',
  'sauce',
];

const ALL_MENU_CATEGORIES = [...MENU_CATEGORIES, ...LEGACY_MENU_CATEGORIES];

module.exports = {
  MENU_CATEGORIES,
  LEGACY_MENU_CATEGORIES,
  ALL_MENU_CATEGORIES,
};