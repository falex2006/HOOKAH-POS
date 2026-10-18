import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

// These digests were recorded from the immutable UI-04.2 intake, HEAD
// 802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf plus accepted pre-existing WIP.
// Normalize line endings only; protect deliberately excluded domain handlers.
const portal = readFileSync(new URL('../portal.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const digest = value => createHash('sha256').update(value).digest('hex');
const slice = (start, end) => { const from = portal.indexOf(start), to = portal.indexOf(end, from); assert.ok(from >= 0 && to > from, 'boundary markers exist'); return portal.slice(from, to); };
const financialStart = "    const openOrderButton = event.target.closest('[data-reservation-open-order]');";
const checks = {
  financial: [slice(financialStart, "  document.querySelector('#reservation-list')?.addEventListener('click', async (event) => { const editButton"), '420e458642eba4410a80069c50f99397df23b1c47bc30c28b027e2a50ae9f5b8'],
  payload: [portal.match(/const value = \{ guestName: document\.querySelector\('#reservation-guest'\)[^\n]+/)?.[0], 'ecc2c08dda95c26a3b9cb100d24c68b8bddae76161c25281e7d798c66e8ed530'],
  query: [portal.match(/const load = \(keepSavedDate = false\)[^\n]+/)?.[0], '5e3fc8c52b082ef2f4f75bac46ee6e8afc6504e0601a77f2018e89b16704bcd1'],
  legacy: [slice('const portalAction =', '// Ordinary editors own').trim(), '984b67fd9fce6eb7f4f59d19636d770fe4900c9ed9bb3cf68e82341cc9c0d574'],
  shifts: [slice("document.querySelector('#shift-close')?.addEventListener", '  const labels ='), '6a8750e982bb40888b0a7432e22eced6c13ab7db07d897da5d1493d3ab950111']
};
for (const [name, [actual, expected]] of Object.entries(checks)) { assert.equal(typeof actual, 'string', `${name} exists`); assert.equal(digest(actual), expected, `${name} unchanged from UI-04.2 intake`); }
console.log('UI-04.2 financial boundary PASS (5 intake digests: seating/payment/refund, booking payload/query, legacy dialog, shift execution).');
