import assert from 'node:assert/strict';
import fs from 'node:fs';

// Source contract only. CSSOM and actual theme rendering have a separate browser gate.
const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const mirror = fs.readFileSync(new URL('../dist/style.css', import.meta.url), 'utf8');
const doc = fs.readFileSync(new URL('../DESIGN_TOKENS.md', import.meta.url), 'utf8');
assert.equal(css, mirror, 'CSS source/dist drift');
const dark = css.match(/:root \{\s*(--ui-page:[\s\S]*?)\n\}/)?.[1];
const light = css.match(/\.portal\.light-theme, \.staff-theme\.light-theme \{([\s\S]*?)\n\}/)?.[1];
assert.ok(dark && light, 'Both semantic theme maps required');
const roles = ['page', 'panel', 'raised', 'input', 'overlay', 'text-primary', 'text-secondary', 'text-muted', 'text-on-action', 'link', 'success', 'warning', 'danger', 'neutral', 'border-subtle', 'border-control', 'focus', 'action-fill', 'brand-start', 'brand-end'];
const expected = [
  ['#0b0d10', '#f5f7fa'], ['#15181d', '#ffffff'], ['#1b1f25', '#eef3f6'], ['#1b1f25', '#ffffff'],
  ['rgba(0,0,0,.65)', 'rgba(15,25,35,.45)'], ['#f3f5f7', '#20313d'], ['#c1c8d0', '#405762'],
  ['#9aa3ae', '#526672'], ['#ffffff', '#ffffff'], ['#ffb08f', '#9f3f32'], ['#63e2ad', '#166b4a'],
  ['#ffc65d', '#805000'], ['#ff8898', '#a72c42'], ['#c1c8d0', '#526672'], ['#2b3038', '#d3dfe5'],
  ['#74808e', '#71818b'], ['#ffb08f', '#9f3f32'], ['#a72c42', '#a72c42'], ['#ff516e', '#ff516e'], ['#ff9a3d', '#ff9a3d'],
];
for (const role of roles) {
  for (const [theme, block] of [dark, light].entries()) {
    const matches = [...block.matchAll(new RegExp(`--ui-${role}:\\s*([^;]+);`, 'g'))];
    assert.equal(matches.length, 1, role);
    assert.equal(matches[0][1].trim(), expected[roles.indexOf(role)][theme], `Theme value ${role}`);
  }
  assert.ok(doc.includes(`--ui-${role}`), `Missing documented role ${role}`);
}
assert.ok(!/var\(--text[,)\s]/.test(css), 'Ambiguous --text consumer remains');
assert.ok(css.includes('--text:var(--text-primary)'), 'Deprecated alias must stay compatible');
assert.ok(/\/\* Isolated reference-level visual system\.[^]*?\*\/\s*\.portal\.velora-theme \.staff-catalog-page/.test(css), 'Staff token prelude must be a comment');
const staff = css.match(/\.portal\.velora-theme \.staff-catalog-page, \.portal\.velora-theme \.staff-catalog \{([\s\S]*?)\n\}/)?.[1];
assert.ok(staff?.includes('--staff-bg: #0c121b'), 'Staff token rule missing');
const definitions = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
for (const ref of css.matchAll(/var\((--(?:ui|legacy|staff)-[\w-]+)/g)) {
  assert.ok(definitions.has(ref[1]), `Undefined scoped token ${ref[1]}`);
}
for (const [alias, role] of Object.entries({ ink: 'page', surface: 'panel', 'surface-2': 'raised', line: 'line', muted: 'muted', accent: 'brand-start', 'accent-2': 'brand-end', cyan: 'link', green: 'success' })) {
  assert.ok(css.includes(`--${alias}:var(--legacy-${role})`), `Compatibility alias ${alias}`);
}
for (const selector of ['.quantity-control', '.recipe-card h3', '.recipe-card p strong', '.finance-result-grid strong', '.finance-segment-grid strong', '.recipe-yield b', '.finance-section-nav a', '.finance-section-nav button']) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blocks = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'g'))];
  assert.ok(blocks.some(m => /color:\s*inherit/.test(m[1])), `Inherited color compatibility ${selector}`);
}
console.log('UI-02.1 source contract PASS: 20 roles x 2 exact maps, aliases, inherited color compatibility, staff prelude, scoped references and CSS mirror. Browser gate is separate.');
