import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeStaffEmail, normalizeStaffLogin } from '../staff-identity.js';

const portal = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const card = fs.readFileSync(new URL('../staff-admin-card.js', import.meta.url), 'utf8');
assert.equal(normalizeStaffEmail('Roman.Test@EXAMPLE.COM'), 'Roman.Test@example.com');
assert.equal(normalizeStaffLogin(' Bazinga '), 'Bazinga');
assert.throws(() => normalizeStaffEmail('bad@example'), /invalid_staff_email/);
assert.throws(() => normalizeStaffLogin('ab'), /invalid_staff_login/);
assert.match(portal, /staff-admin-card\.js\?rev=/);
assert.match(card, /PIN блокировки экрана/);
assert.match(card, /pin_new/);
assert.match(card, /pin_confirm/);
assert.match(card, /canAssignRole/);
assert.match(card, /staff_role_assignment_required/);
assert.match(card, /sessionsRevoked/);
console.log('PASS staff identity static demo: current identity normalization, role guard, PIN form and session revocation markers');
