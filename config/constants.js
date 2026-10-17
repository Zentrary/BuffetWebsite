const MENU_CATEGORIES = [
  'set_menu',
  'sukiyaki',
  'hotpan',
  'sushi',
  'maki',
  'sashimi',
  'japanese_main',
  'chinese',
  'fried',
  'dim_sum',
  'yum',
  'salad',
  'fresh_meat',
  'offal',
  'seafood',
  'vegetable',
  'mushroom',
  'tofu',
  'noodle',
  'rice',
  'side',
  'soup',
  'sauce',
  'dessert',
  'drink',
];

const LEGACY_MENU_CATEGORIES = [
  'appetizer',
  'main',
  'meat',
  'sukiyaki_hotpan',
  'sushi_roll',
  'chinese_stirfry',
  'fried_appetizer',
  'salad_yum',
  'fresh_seafood',
  'vegetable_tofu',
  'noodle_rice_side',
  'soup_sauce',
];

const ALL_MENU_CATEGORIES = [...MENU_CATEGORIES, ...LEGACY_MENU_CATEGORIES];

module.exports = {
  MENU_CATEGORIES,
  LEGACY_MENU_CATEGORIES,
  ALL_MENU_CATEGORIES,
};