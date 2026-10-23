import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const root = fileURLToPath(new URL('../', import.meta.url));
const pairs = [
  ['../portal.js', '../dist/portal.js'],
  ['../notification-center.js', '../dist/notification-center.js'],
];

for (const [sourcePath, distPath] of pairs) {
  const source = read(sourcePath);
  const dist = read(distPath);
  for (const [name, code] of [['source', source], ['dist', dist]]) {
    assert.match(code, /allowedNotificationHrefs[\s\S]*?\/admin#shift-control/,
      `${name} notification allowlist must include shift control`);
    assert.match(code, /else\s*\{\s*closeNotificationPanel\(false\);\s*window\.location\.assign\(href\);\s*\}/,
      `${name} navigation must close the notification panel before following an internal route`);
  }
}

const syncScript = read('../scripts/sync-published-assets.mjs');
const notificationRevision = Number(syncScript.match(/notificationCenterRevision = '(\d+)'/)?.[1]);
assert.ok(Number.isInteger(notificationRevision), 'notification center cache revision must be declared');
assert.match(syncScript, /notification-center\\\.js\\\?rev=\\d\+/,
  'published HTML sync must normalize notification center cache revisions');
assert.ok(syncScript.split(String.raw`notification-center\.js\?rev=\d+`).length >= 3,
  'notification center injection guard must recognize any existing revision');

const htmlFiles = [];
const collectHtml = (directory, recursive) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith('.html')) htmlFiles.push(file);
    else if (recursive && entry.isDirectory()) collectHtml(file, true);
  }
};
collectHtml(root, false);
collectHtml(path.join(root, 'dist'), true);
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  const references = [...html.matchAll(/notification-center\.js\?rev=(\d+)/g)];
  assert.ok(references.length <= 1, `${path.relative(root, file)} must include one notification center script at most once`);
  for (const reference of references) {
    assert.equal(Number(reference[1]), notificationRevision, `${path.relative(root, file)} must use the current notification center cache revision`);
  }
}

console.log('NOTIFICATION ROUTE ACTIONS CONTRACT: PASS');
