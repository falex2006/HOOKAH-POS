import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const scheduleCss = fs.readFileSync(new URL('../staff-schedule-ui.css', import.meta.url), 'utf8');
const personalUi = fs.readFileSync(new URL('../staff-schedule-personal-ui.js', import.meta.url), 'utf8');
const managementUi = fs.readFileSync(new URL('../staff-schedule-ui.js', import.meta.url), 'utf8');
const themeSetup = source.match(/function setupThemePreference\(\{ isCurrent: routeGuard \} = \{\}\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(themeSetup, 'theme preference lifecycle must remain independently testable');
assert.match(source, /function renderScheduleRoute\(target\)\s*\{[\s\S]*?setupThemePreference\(\{ isCurrent: \(\) =>[\s\S]*?canAccessRoute\(scheduleSession, location\.pathname, location\.hash\)[\s\S]*?\}\);/,
  'direct schedule entry must load the theme only while the same verified, authorized schedule route is current');
assert.match(source, /if \(!window\.__portalSessionVerified\.demo && !window\.__portalSessionGate\.canAccessRoute\(window\.__portalSessionVerified, window\.location\.pathname, window\.location\.hash\)\)/,
  'the existing route authorization gate must remain ahead of schedule rendering');
assert.doesNotMatch(themeSetup, /portalPermissions\.(add|delete|clear)|permissions\.(add|delete|clear)/,
  'reading a theme preference must not grant or mutate permissions');
assert.match(personalUi, /document\.body\.classList\.add\('schedule-route'\)/);
assert.match(managementUi, /document\.body\.classList\.add\('schedule-route'\)/);
const shellThemeRules = scheduleCss.split(/\r?\n/).filter((line) => /\.portal-(?:sidebar|header)/.test(line) && /light-theme/.test(line));
assert.ok(shellThemeRules.length > 0, 'schedule light-theme shell adjustments must remain present');
assert.ok(shellThemeRules.every((line) => line.startsWith('body.portal.light-theme.schedule-route ')),
  'light sidebar/header adjustments must remain scoped to the schedule route and must not alter routing');

function fixture({ currentRoute = true } = {}) {
  const storage = new Map([['crm_session_token', 'session-a'], ['crm_session_user', '{"id":"user-a"}']]);
  const applied = [];
  const notices = [];
  let resolvePreference;
  const preferenceRequest = new Promise((resolve) => { resolvePreference = resolve; });
  const context = {
    portalTheme: 'dark',
    themeStorageKey: 'crm_theme_user_a',
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    document: { querySelector: () => null },
    window: { __portalSessionVerified: { user: { id: 'user-a' }, permissions: ['staff_schedule_self'] }, __portalSessionGate: { canAccessRoute: () => true } },
    location: { pathname: '/admin', hash: '#staff-schedule' },
    api: (path) => { assert.equal(path, '/api/session/preferences'); return preferenceRequest; },
    preferenceSessionIdentity: () => ({ token: storage.get('crm_session_token'), user: storage.get('crm_session_user') }),
    samePreferenceSession: (identity) => storage.get('crm_session_token') === identity.token && storage.get('crm_session_user') === identity.user,
    applyPortalTheme: (theme) => { const selected = theme === 'light' ? 'light' : 'dark'; applied.push(selected); return selected; },
    reportPreferenceReadFailure: () => notices.push('preference_read_failed'),
  };
  vm.runInNewContext(`${themeSetup}; setupThemePreference`, context);
  return { ...context, setup: vm.runInNewContext(`${themeSetup}; setupThemePreference`, context), applied, notices, storage, resolvePreference, get currentRoute() { return currentRoute; }, set currentRoute(value) { currentRoute = value; } };
}

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

{
  const test = fixture();
  test.setup({ isCurrent: () => test.currentRoute && test.location.pathname === '/admin' && test.location.hash === '#staff-schedule' });
  test.resolvePreference({ preferences: { theme: 'light' } });
  await settle();
  assert.deepEqual(test.applied, ['light'], 'a fresh user entering the schedule directly receives the server-saved light theme');
  assert.equal(test.storage.get('crm_theme_user_a'), 'light', 'the confirmed per-user preference refreshes its local cache');
}

{
  const test = fixture();
  test.setup({ isCurrent: () => test.currentRoute && test.location.hash === '#staff-schedule' });
  test.currentRoute = false;
  test.location.hash = '#staff';
  test.resolvePreference({ preferences: { theme: 'light' } });
  await settle();
  assert.deepEqual(test.applied, [], 'a late theme response cannot repaint after leaving the schedule route');
}

{
  const test = fixture();
  test.setup({ isCurrent: () => test.window.__portalSessionVerified.user.id === 'user-a' });
  test.window.__portalSessionVerified = { user: { id: 'user-b' }, permissions: [] };
  test.storage.set('crm_session_token', 'session-b');
  test.storage.set('crm_session_user', '{"id":"user-b"}');
  test.resolvePreference({ preferences: { theme: 'light' } });
  await settle();
  assert.deepEqual(test.applied, [], 'a response from the previous account cannot overwrite the next account theme');
}

console.log('STAFF SCHEDULE THEME LIFECYCLE: PASS (direct route, server preference, route/session race guards, no permission mutation)');
