import assert from 'node:assert/strict';
import fs from 'node:fs';

const variants = ['', 'dist/'].map(prefix => ({
  prefix,
  portal: fs.readFileSync(new URL(`../${prefix}portal.js`, import.meta.url), 'utf8'),
  styles: fs.readFileSync(new URL(`../${prefix}style.css`, import.meta.url), 'utf8')
}));
const footers = [];
for (const { prefix, portal, styles } of variants) {
const footerStart = portal.indexOf('<div class="recipe-wizard-nav">', portal.indexOf('const recipes = document.createElement'));
const footerEnd = portal.indexOf('<p class="form-message" id="recipe-message">', footerStart);
assert.ok(footerStart >= 0 && footerEnd > footerStart, 'recipe wizard footer exists');
const footer = portal.slice(footerStart, footerEnd);
footers.push(footer);

assert.equal((footer.match(/id="cancel-recipe"/g) || []).length, 1, 'one cancel action');
assert.equal((footer.match(/id="recipe-wizard-back"/g) || []).length, 1, 'one back action');
assert.equal((footer.match(/id="recipe-wizard-next"/g) || []).length, 1, 'one next action');
assert.equal((footer.match(/type="submit"/g) || []).length, 1, 'one form submit action');
assert.match(footer, /class="recipe-wizard-nav"[\s\S]*id="cancel-recipe"[\s\S]*class="recipe-wizard-nav-end"[\s\S]*id="recipe-wizard-back"[\s\S]*id="recipe-wizard-next"[\s\S]*data-recipe-stage="4" type="submit"/,
  'cancel stays first; back and forward/save share the aligned primary-action group');
assert.match(footer, /class="recipe-wizard-danger" data-recipe-stage="4"[\s\S]*id="delete-recipe" type="button" hidden/, 'delete stays isolated and never submits the form');
assert.match(portal, /querySelector\('#recipe-wizard-back'\)/, 'existing back handler is retained');
assert.match(portal, /querySelector\('#recipe-wizard-next'\)/, 'existing progress handler is retained');
assert.match(portal, /classList\.toggle\('is-single-action', recipeStep === 1\)/, 'single first-step action spans the mobile group');
assert.match(portal, /classList\.contains\('recipe-wizard-danger'\) && !hasExistingRecipe/, 'create flow hides the empty destructive-action section');
assert.match(portal, /querySelector\('#delete-recipe'\)[\s\S]*addEventListener\('click'/, 'existing delete confirmation handler is retained');
assert.match(styles, /\.recipe-wizard-nav-end\{display:flex;justify-content:flex-end;gap:8px;margin-left:auto\}/, 'desktop actions align to the right with a consistent gap');
assert.match(styles, /\.recipe-wizard-danger\[hidden\]\{display:none\}/, 'hidden danger action does not occupy space');
assert.match(styles, /@media\(max-width:650px\)\{\.velora-theme \.recipe-wizard-nav-end\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\);gap:8px;width:100%;margin-left:0\}\.velora-theme \.recipe-wizard-nav-end\.is-single-action\{grid-template-columns:1fr\}\}/, 'narrow actions use a full-width group and a single step-1 action spans it');
assert.match(styles, /@media\(max-width:400px\)\{\.velora-theme \.recipe-wizard-nav-end\{grid-template-columns:1fr\}\}/, 'very narrow action labels stack without squeezing');
console.log(`PASS: ${prefix || 'source/'}recipe wizard footer contract`);
}
assert.equal(footers[1], footers[0], 'published recipe footer retains the locally reviewed actions and order');

console.log('PASS: source/dist recipe footer parity, action order, responsive grouping, and non-submit delete');
