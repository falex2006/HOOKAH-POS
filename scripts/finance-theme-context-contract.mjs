import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const theme = fs.readFileSync(new URL('management-theme.js', root), 'utf8');
const sessionSource = fs.readFileSync(new URL('portal-session.js', root), 'utf8');
const resolverStart = theme.indexOf('  const marker =');
const resolverEnd = theme.indexOf('  function unmark(', resolverStart);
const gateStart = sessionSource.indexOf('  const signature =');
const gateEnd = sessionSource.indexOf('  const canUseNavigation =', gateStart);
assert.ok(resolverStart >= 0 && resolverEnd > resolverStart, 'Actual theme resolver boundaries exist');
assert.ok(gateStart >= 0 && gateEnd > gateStart, 'Actual session route gate boundaries exist');
// Execute production resolver and permission gate, not copies of their policy.
const subject = `${sessionSource.slice(gateStart, gateEnd)}\nwindow.__portalSessionGate={signature,canAccessRoute,blocked:false};\n${theme.slice(resolverStart, resolverEnd)}\nglobalThis.resolveTheme=resolve;`;
let checks = 0;
const check = (actual, expected, message) => { assert.equal(actual, expected, message); checks++; };
function fixture({ route = '/finance', role = 'owner', permissions = ['finance_read'], demo = false, token = 'verified-token', authenticated = true, checking = false, locked = false, storageFailure = false } = {}) {
  const state = { token, checking, locked, storageFailure };
  const session = { user: { id: 'owner-1', venueId: 'venue-1', organizationId: 'org-1', role }, permissions, demo };
  const context = vm.createContext({
    URL,
    window: { location: new URL(route, 'https://example.invalid'), __portalSessionVerified: authenticated ? session : null },
    document: { documentElement: { hasAttribute: name => name === 'data-portal-access' && state.checking }, body: { classList: { contains: name => name === 'screen-locked' && state.locked } } },
    localStorage: { getItem: () => { if (state.storageFailure) throw new Error('Storage unavailable'); return state.token; } },
  });
  vm.runInContext(subject, context, { filename: fileURLToPath(new URL('management-theme.js', root)) });
  return { state, session, context, allowed: () => Boolean(context.resolveTheme()), navigate: route => { context.window.location = new URL(route, 'https://example.invalid'); } };
}

const financeHashes = ['', '#finance-chart-panel', '#expenses', '#other-income', '#business-obligations', '#payables', '#finance-payments-panel', '#cash-register-panel', '#finance-result-panel', '#finance-staff-panel', '#discounts', '#payroll', '#expense-form', '#payment-list', '#finance-account-settings'];
for (const role of ['owner', 'admin', 'manager']) {
  const f = fixture({ role });
  for (const hash of financeHashes) { f.navigate(`/finance${hash}`); check(f.allowed(), true, `${role}: finance theme survives ${hash || 'overview'} with read-only finance permission`); }
  f.navigate('/finance#'); check(f.allowed(), true, `${role}: empty fragment remains overview`);
}
for (const hash of ['#unknown', '#payroll-create-form', '#staff', '#expenses-extra', '#%65xpenses', '#finance-account-settings/']) {
  check(fixture({ route: `/finance${hash}` }).allowed(), false, `Unknown/uncontracted fragment is excluded: ${hash}`);
}
for (const [action, hash] of [['expense', '#expenses'], ['obligation', '#business-obligations'], ['recurring', '#business-obligations'], ['other-income', '#other-income']]) {
  const f = fixture({ route: `/finance?action=${action}&categoryId=category-1${hash}` });
  check(f.allowed(), true, `Category entry ${action} retains presentation`);
  f.navigate(`/finance${hash}`); check(f.allowed(), true, `Consumed category entry ${action} retains presentation`);
  check(fixture({ route: `/finance?action=${action}&categoryId=category-1${hash}`, permissions: [] }).allowed(), false, `Category entry ${action} cannot grant finance permission`);
}
for (const query of ['operator=1', 'operator=', 'mode=admin', 'mode=', 'view=stock']) {
  check(fixture({ route: `/finance?${query}#expenses` }).allowed(), false, `Presentation exclusion remains: ${query}`);
}
for (const [name, options] of [
  ['no verified session', { authenticated: false }], ['no finance permission', { permissions: [] }],
  ['write permission alone is not read authority', { permissions: ['finance'] }],
  ['employee despite read permission', { role: 'bartender' }], ['demo session', { demo: true }],
  ['demo token', { token: 'demo-static-fixture' }], ['missing token', { token: '' }],
  ['checking access', { checking: true }], ['locked screen', { locked: true }], ['storage unavailable', { storageFailure: true }],
]) check(fixture({ route: '/finance#expenses', ...options }).allowed(), false, name);
const blocked = fixture(); blocked.context.window.__portalSessionGate.blocked = true; check(blocked.allowed(), false, 'Blocked verified gate excludes theme');
const missingGate = fixture(); missingGate.context.window.__portalSessionGate = null; check(missingGate.allowed(), false, 'Missing gate excludes theme');
const malformed = fixture(); malformed.session.permissions = null; check(malformed.allowed(), false, 'Malformed permissions excluded');
const denied = fixture(); denied.context.window.__portalSessionGate.canAccessRoute = () => false; check(denied.allowed(), false, 'Resolver respects authoritative route denial');
const throwing = fixture(); throwing.context.window.__portalSessionGate.canAccessRoute = () => { throw new Error('Gate unavailable'); }; check(throwing.allowed(), false, 'Gate exception fails closed');
const rotation = fixture(); check(rotation.allowed(), true, 'Initial verified token accepted'); rotation.state.token = 'replacement-token'; check(rotation.allowed(), false, 'Old verified object cannot authorize rotated token'); rotation.context.window.__portalSessionVerified = { ...rotation.session }; check(rotation.allowed(), true, 'Fresh verified session can bind replacement token');

for (const route of ['/finance.html#expenses', '/finance/#expenses', '/finance/report', '/finance-report.html', '/finance/categories', '/finance-categories.html']) {
  check(fixture({ route }).allowed(), true, `Existing finance normalization retained: ${route}`);
}
for (const [route, permissions] of [['/admin#tasks', ['orders']], ['/inventory?view=products', ['inventory_read']], ['/clients', ['orders']], ['/orders', ['orders']]]) {
  check(fixture({ route, permissions }).allowed(), true, `Unrelated eligible route unchanged: ${route}`);
}
for (const [route, permissions] of [['/admin#staff', ['staff']], ['/inventory#expenses', ['inventory_read']], ['/inventory?view=unknown', ['inventory_read']], ['/finance/report#expenses', ['finance_read']], ['/finance/categories#expenses', ['finance_read']], ['/', ['orders']]]) {
  check(fixture({ route, permissions }).allowed(), false, `Unrelated excluded route unchanged: ${route}`);
}
const navigation = fixture();
for (const [route, expected] of [['/finance#expenses', true], ['/finance#unknown', false], ['/finance#payroll', true], ['/finance#payment-list', true]]) {
  navigation.navigate(route); check(navigation.allowed(), expected, `Repeated navigation resolves current context: ${route}`);
}
check(fs.readFileSync(new URL('dist/management-theme.js', root), 'utf8'), theme, 'Published resolver matches source');
const sync = fs.readFileSync(new URL('scripts/sync-published-assets.mjs', root), 'utf8');
const revision = sync.match(/const managementThemeRevision = '(\d+)'/)?.[1];
assert.ok(revision, 'Publish sync declares the management resolver revision');
for (const path of ['finance.html', 'dist/finance.html', 'dist/finance/index.html']) {
  const html = fs.readFileSync(new URL(path, root), 'utf8');
  check(html.match(/management-theme\.js\?rev=(\d+)/)?.[1], revision, `Finance entry uses the revised resolver: ${path}`);
}
console.log(`FINANCE THEME CONTEXT: PASS (${checks} actual-source resolver and permission checks; browser appearance/lifecycle checked separately)`);
