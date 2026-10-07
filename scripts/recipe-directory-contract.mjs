import { readFileSync, existsSync } from 'node:fs';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const migration = new URL('../migrations/067_recipe_card_categories.sql', import.meta.url);
if (!existsSync(migration)) throw new Error('recipe category migration is missing');
const migrationSql = readFileSync(migration, 'utf8');
for (const field of ['id="recipe-search"', 'id="recipe-category-filter"', 'id="recipe-category"', 'data-recipe-card=']) {
  if (!portal.includes(field)) throw new Error(`recipe directory UI is missing ${field}`);
}
for (const behavior of ['recipeSearchInput?.addEventListener', 'recipeCategoryFilter?.addEventListener', 'normalizeRecipeSearch', 'item.category', 'category: document.querySelector']) {
  if (!portal.includes(behavior)) throw new Error(`recipe search/filter/create/update behavior is missing ${behavior}`);
}
for (const behavior of ['renderReadOnlyRecipes', 'recipeSearchInput?.addEventListener(\'input\', renderReadOnlyRecipes)', 'recipeCategoryFilter?.addEventListener(\'change\', renderReadOnlyRecipes)', 'data-recipe-card=', 'esc(item.category)']) {
  if (!portal.includes(behavior)) throw new Error(`read-only recipe directory behavior is missing ${behavior}`);
}
for (const apiContract of ['name,category,ingredients', 'category=$', 'category.length > 80', 'String(input.category ||']) {
  if (!server.includes(apiContract)) throw new Error(`recipe category API contract is missing ${apiContract}`);
}
if (!/ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT ''/i.test(migrationSql)) throw new Error('recipe category persistence is missing');
console.log('RECIPE DIRECTORY CONTRACT: PASS');
