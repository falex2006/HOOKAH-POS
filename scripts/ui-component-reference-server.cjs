'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'docs/design/UNIFIED_UI_2026-10-09/components');
const routes = {
  '/': [path.join(folder, 'UI_02_2_REFERENCE.html'), 'text/html'],
  '/style.css': [path.join(root, 'style.css'), 'text/css'],
  '/reference.css': [path.join(folder, 'ui-component-reference.css'), 'text/css'],
  '/reference.js': [path.join(folder, 'ui-component-reference.js'), 'text/javascript'],
};
for (const weight of [400, 500, 600, 700, 800]) routes[`/assets/fonts/manrope-${weight}.ttf`] = [path.join(root, `assets/fonts/manrope-${weight}.ttf`), 'font/ttf'];
http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1:31957').pathname;
  const route = Object.hasOwn(routes, pathname) ? routes[pathname] : null;
  if (!route || req.method !== 'GET') { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': `${route[1]}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; font-src 'self'; img-src 'self'; connect-src 'none'" });
  res.end(fs.readFileSync(route[0]));
}).listen(31957, '127.0.0.1', () => console.log('UI-02.2 local reference: http://127.0.0.1:31957 (Ctrl+C to stop)'));
