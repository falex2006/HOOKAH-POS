import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { publishedHtmlFiles, routeAliases } from './published-html-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const brand = path.join(root, 'assets', 'brand');
const distBrand = path.join(root, 'dist', 'assets', 'brand');
const required = [
  'hookah-pos-lockup.svg', 'hookah-pos-lockup-animated.svg',
  'hookah-pos-lockup-light.svg', 'hookah-pos-lockup-light-animated.svg',
  'hookah-pos-symbol.svg', 'manifest.webmanifest',
  'icons/favicon.svg', 'icons/favicon.ico', 'icons/favicon-32.png',
  'icons/opera-speed-dial-264x168.png',
  'icons/safari-pinned-tab.svg', 'icons/apple-touch-icon-180.png',
  'icons/og-image-1200x630.png', 'icons/pwa-192.png', 'icons/pwa-512.png',
  'icons/pwa-maskable-512.png', 'icons/apple-touch-icon-dark-180.png',
  'icons/favicon-16.png', 'icons/favicon-48.png', 'icons/mono-black-512.png',
  'icons/mono-white-512.png', 'icons/mstile-150.png'
];
for (const rel of required) {
  assert.ok(fs.existsSync(path.join(brand, rel)), `missing source brand asset: ${rel}`);
  assert.ok(fs.existsSync(path.join(distBrand, rel)), `missing dist brand asset: ${rel}`);
  assert.equal(fs.readFileSync(path.join(brand, rel)).equals(fs.readFileSync(path.join(distBrand, rel))), true, `source/dist mismatch: ${rel}`);
}
for (const rel of required.filter(rel => rel.endsWith('.png'))) {
  assert.deepEqual(fs.readFileSync(path.join(brand, rel)).subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]), `invalid PNG signature: ${rel}`);
}
const manifest = JSON.parse(read('assets/brand/manifest.webmanifest'));
assert.equal(manifest.name, 'Hookah POS');
assert.ok(manifest.icons?.some((icon) => icon.purpose === 'maskable'));
const speedDialPath = path.join(brand, 'icons', 'opera-speed-dial-264x168.png');
const speedDialMetadata = await sharp(speedDialPath).metadata();
assert.equal(speedDialMetadata.format, 'png', 'Opera Speed Dial asset must be PNG');
assert.equal(speedDialMetadata.width, 264, 'Opera Speed Dial asset width');
assert.equal(speedDialMetadata.height, 168, 'Opera Speed Dial asset height');
const speedDialStats = await sharp(speedDialPath).ensureAlpha().stats();
assert.equal(speedDialStats.channels[3].min, 255, 'Opera Speed Dial asset must be fully opaque');
const pages = publishedHtmlFiles;
for (const file of pages) {
  const html = read(file);
  assert.match(html, /favicon\.svg\?rev=2/);
  assert.match(html, /manifest\.webmanifest\?rev=2/);
  assert.match(html, /<link rel="icon" type="image\/png" sizes="264x168" href="\/assets\/brand\/icons\/opera-speed-dial-264x168\.png\?rev=1">/);
  assert.equal((html.match(/opera-speed-dial-264x168\.png/g) || []).length, 1, 'one Opera Speed Dial candidate');
  assert.equal(html, read(`dist/${file}`), `source/dist page mismatch: ${file}`);
  assert.equal((html.match(/<!-- Hookah POS brand icons -->/g) || []).length, 1, 'one icon metadata block');
}
for (const [alias, source] of Object.entries(routeAliases)) assert.equal(read(source), read(`dist/${alias}`), `alias mismatch: ${alias}`);
for (const rel of required.filter(rel => rel.endsWith('.svg'))) {
  assert.doesNotMatch(read(`assets/brand/${rel}`), /<script|foreignObject|(?:href|src)\s*=\s*["'][^#]|@import/i, `active or external SVG content: ${rel}`);
}
for (const file of ['index.html', 'admin.html', 'platform.html']) {
  const html = read(file);
  assert.match(html, /srcset="\/assets\/brand\/hookah-pos-symbol\.svg\?rev=2"/);
  assert.match(html, /prefers-reduced-motion:reduce[^>]+srcset="\/assets\/brand\/hookah-pos-lockup\.svg\?rev=2"/);
  assert.match(html, /src="\/assets\/brand\/hookah-pos-lockup-animated\.svg\?rev=2"/);
}
const login = read('login.html');
assert.match(login, /auth-product-brand/);
assert.match(login, /hookah-pos-lockup-animated\.svg\?rev=2/);
assert.match(login, /prefers-reduced-motion:reduce[^>]+hookah-pos-lockup\.svg\?rev=2/);
assert.doesNotMatch(login, /data-login-brand|api\/public\/venue-brand/);
assert.doesNotMatch(read('login.js'), /data-login-brand|api\/public\/venue-brand/);
const server = read('server.js');
assert.match(server, /const isBrandAsset = requestPath\.startsWith\('\/assets\/brand\/'\)/,
  'server allows the complete versioned brand asset namespace');
assert.match(server, /application\/manifest\+json/);
for (const script of ['make-animated-hookah-lockups.py', 'make-auth-preview.py', 'export-hookah-pos-icons.py']) {
  assert.doesNotMatch(read('scripts/sync-published-assets.mjs'), new RegExp(script), `generator published: ${script}`);
}
console.log(`BRAND KIT CONTRACT: PASS (${required.length} assets, animated sidebar/auth, reduced-motion fallbacks, source/dist parity, server allowlist)`);
