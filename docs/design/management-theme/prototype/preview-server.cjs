// MT-02 preview only. No application, credentials, APIs, or database connection.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const assets = path.resolve(root, '../../../../assets');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
const routes = new Map([
  ['/', path.join(root, 'index.html')],
  ['/index.html', path.join(root, 'index.html')],
  ['/prototype.css', path.join(root, 'prototype.css')],
  ['/prototype.js', path.join(root, 'prototype.js')],
  ['/assets/brand/hookah-pos-lockup.svg', path.join(assets, 'brand/hookah-pos-lockup.svg')],
  ['/assets/brand/hookah-pos-symbol.svg', path.join(assets, 'brand/hookah-pos-symbol.svg')],
  ...[400, 500, 600, 700, 800].map(weight => [`/assets/fonts/manrope-${weight}.ttf`, path.join(assets, `fonts/manrope-${weight}.ttf`)]),
]);
const server = http.createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end('Read-only preview'); return; }
  let pathname;
  try { pathname = new URL(request.url, 'http://127.0.0.1').pathname; } catch { response.writeHead(400); response.end(); return; }
  if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  const file = routes.get(pathname);
  if (!file) { response.writeHead(404); response.end('Preview route not found'); return; }
  fs.readFile(file, (error, data) => {
    if (error) { response.writeHead(404); response.end('Preview asset not ready'); return; }
    response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    response.writeHead(200); response.end(request.method === 'HEAD' ? undefined : data);
  });
});
server.listen(0, '127.0.0.1', () => console.log(`MT02_PREVIEW http://127.0.0.1:${server.address().port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
