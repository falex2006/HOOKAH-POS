import assert from 'node:assert/strict';
import fs from 'node:fs';
const portal = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const dist = fs.readFileSync(new URL('../dist/portal.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const distCss = fs.readFileSync(new URL('../dist/style.css', import.meta.url), 'utf8');
assert.equal(dist, portal, 'source/dist portal parity');
assert.match(portal, /const sidebarGroupKeys = \['operations', 'menu', 'inventory', 'finance', 'team', 'system'\]/);
assert.match(portal, /const sidebarDisclosureKey = \(session\) =>/);
assert.match(portal, /const readSidebarDisclosure = \(raw\) =>/);
assert.match(portal, /const createSidebarNavigation = \(sidebar, syncActive\) =>/);
assert.match(portal, /localStorage\.setItem\(key, JSON\.stringify\(\{ version: 2, route: route\(\), openGroup \}\)\)/);
assert.match(portal, /openGroup = reload && saved\?\.route === lastRoute[\s\S]*?routeGroup\(\)/);
assert.match(portal, /group\.querySelector\('summary'\)\?\.setAttribute\('aria-expanded', String\(group\.open\)\)/);
assert.match(portal, /const toggle = \(event, details, value\) =>/);
assert.equal(distCss, css, 'source/dist stylesheet parity');
assert.match(css, /sidebar-nav-group>summary::after\{[^}]*background-image:url\("data:image\/svg\+xml/,
  'sidebar disclosure arrow must use a centered vector glyph, not a font character');
console.log('SIDEBAR DISCLOSURE ACTUAL SOURCE: PASS (persistent state, centered SVG chevron, source/dist parity)');
