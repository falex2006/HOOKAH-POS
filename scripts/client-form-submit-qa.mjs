import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const capture = portal.slice(portal.indexOf("document.addEventListener('submit'"), portal.indexOf('\n', portal.indexOf("document.addEventListener('submit'")));
assert.match(capture, /\['client-form'[\s\S]*'expense-form'[\s\S]*\]\.includes\(form\.id\)/, 'forms with local pending guards must opt out of six-second global submit lock');

const start = portal.indexOf("document.querySelector('#client-form').addEventListener('submit'");
const end = portal.indexOf(' }); load();', start);
assert.ok(start > 0 && end > start, 'guest submit handler exists');
const handler = portal.slice(start, end);
assert.match(handler, /if \(form\.dataset\.submitting === '1'\) return/, 'duplicate guest submits must be ignored');
assert.match(handler, /form\.dataset\.submitting = '1';.*submit\.disabled = true/, 'request must lock submit control');
assert.match(portal, /const openEditor = \(client, trigger = newClientButton\) => \{ editorSession \+= 1; resetClientSubmit\(\)/, 'opening another guest must invalidate the previous response');
assert.match(portal, /const closeEditor = \(\) => \{ editorSession \+= 1; resetClientSubmit\(\)/, 'closing the guest form must invalidate the previous response');
assert.match(handler, /\.then\(\(saved\) => \{ if \(editorSession !== activeEditorSession \|\| editor\.hidden\) \{ load\(\); return; \} if \(!id && saved\?\.id\) \{ document\.querySelector\('#client-id'\)\.value = saved\.id/, 'stale create must not retarget the open editor');
assert.match(handler, /\.catch\(\(error\) => \{ if \(editorSession !== activeEditorSession \|\| editor\.hidden\) return;/, 'stale errors must not appear in another editor');
assert.match(handler, /\.finally\(\(\) => \{ if \(submitGeneration !== activeSubmission\) return; form\.dataset\.submitting = '0'; submit\.disabled = false; submit\.textContent = 'Сохранить карточку'; \}\)/, 'only the current request may release the submit control');
console.log('CLIENT FORM SUBMIT QA: PASS (pending guard, create ID, stale response isolation, immediate retry)');
