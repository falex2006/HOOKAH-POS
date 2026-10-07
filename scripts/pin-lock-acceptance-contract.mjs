import fs from 'node:fs';
import assert from 'node:assert/strict';

const login = fs.readFileSync('login.js', 'utf8');
const lock = fs.readFileSync('lock.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
const css = fs.readFileSync('style.css', 'utf8');

assert.match(lock, /const lockStateKey = `crm_screen_locked_user_\$\{identityKey\}`/, 'lock state is scoped to the current account identity');
assert.match(lock, /localStorage\.setItem\(lockStateKey, 'locked'\)/, 'manual and auto lock publish a locked state for other tabs');
assert.match(lock, /localStorage\.setItem\(lockStateKey, `unlocked:\$\{Date\.now\(\)\}`\)/, 'successful PIN unlock publishes an unlocked state for other tabs');
assert.match(lock, /window\.addEventListener\('storage'[\s\S]*?event\.key !== lockStateKey[\s\S]*?event\.newValue === 'locked'[\s\S]*?lock\('manual'\)/, 'other tabs react to a locked state');
assert.match(lock, /event\.newValue\?\.startsWith\('unlocked:'\) && locked[\s\S]*?overlay\.setAttribute\('aria-hidden', 'true'\)/, 'other tabs hide the overlay after unlock');
assert.match(lock, /event\.key === 'crm_session_token' && event\.newValue !== activeToken[\s\S]*?redirectToLogin\(\)/, 'stale tabs leave the workspace when the session token changes');
assert.match(lock, /fetch\('\/api\/session\/unlock'[\s\S]*?body: JSON\.stringify\(\{ pin: pinInput\.value \}\)/, 'staff lock keeps using the existing screen-unlock endpoint');
assert.match(lock, /const refreshUserFromSession = async \(\) => \{[\s\S]*?fetch\('\/api\/session', \{ headers: headers\(\), cache: 'no-store' \}\)/, 'lock screen refreshes the current session before trusting stale local PIN state');
assert.match(lock, /if \(!user\.pinConfigured && !await refreshUserFromSession\(\)\) \{ window\.__openLockSettings\?\.\(\); return; \}/, 'user without a configured PIN is sent to PIN settings instead of being trapped');
assert.match(lock, /const schedule = \(\) => \{ if \(autoLockEnabled && timeoutMinutes > 0 && !locked\) \{ clearTimeout\(timer\); timer = setTimeout\(\(\) => lock\('auto'\), inactivityMs\(\)\); \} \}/, 'configured staff sessions still auto-lock after the inactivity timeout');
assert.match(lock, /\['pointerdown', 'keydown', 'touchstart', 'mousemove', 'scroll'\]\.forEach[\s\S]*?if \(!locked\) schedule\(\)/, 'user activity reschedules auto-lock while the screen is unlocked');

assert.match(server, /if \(pathname === '\/api\/session\/pin-return' && req\.method === 'POST'\)[\s\S]*?trustedPinRoles\.has/, 'trusted PIN return has a dedicated role gate');
assert.match(server, /if \(pathname === '\/api\/session\/unlock' && req\.method === 'POST'\)[\s\S]*?SELECT pin_hash[\s\S]*?venue_id=\$2/, 'staff screen unlock remains bound to the active venue');
assert.match(server, /if \(pathname === '\/api\/session\/pin-return' && req\.method === 'POST'\)[\s\S]*?organization_id IS NOT DISTINCT FROM \$2::uuid/, 'admin trusted PIN return is scoped to the authenticated organization');
assert.match(server, /const STANDARD_SESSION_TTL_MS = 12 \* 60 \* 60 \* 1000[\s\S]*?const TRUSTED_SESSION_TTL_MS = 30 \* 24 \* 60 \* 60 \* 1000/, 'ordinary and trusted sessions keep separate expiry windows');
assert.match(server, /if \(memorySession\) \{ if \(Date\.now\(\) > Number\(memorySession\.expiresAt \|\| memorySession\.createdAt \+ SESSION_TTL_MS\)\) \{ sessions\.delete\(token\); return null; \}/, 'expired memory sessions are rejected instead of restored by PIN');

assert.match(login, /localStorage\.removeItem\('crm_session_token'\)/, 'login page clears stale local bearer state before trusted cookie probing');
assert.match(login, /if \(isPasswordReset \|\| !form \|\| trustedSessionUser\) return/, 'trusted PIN return does not interrupt password reset flow');
assert.match(login, /if \(!session\?\.trustedDevice \|\| !user\?\.pinConfigured \|\| !adminPinRoles\.has\(user\.role\)\) return/, 'trusted PIN card appears only for trusted configured owner/admin/developer sessions');
assert.match(login, /trustedReturnCard\.querySelector\('\[data-trusted-user\]'\)\.textContent = `\$\{name\} · доверенное устройство`/, 'trusted PIN card labels the remembered device state');
assert.match(login, /await finishLogin\(\{ token: data\.token, user: data\.user \}\)/, 'trusted PIN return restores the normal browser session state');

assert.match(css, /\.trusted-pin-card\[hidden\]\{display:none\}/, 'trusted PIN card respects hidden state');
assert.match(css, /\.trusted-pin-keypad\{grid-template-columns:repeat\(3,1fr\);gap:10px/, 'trusted PIN keypad stays in three stable touch columns');
assert.match(css, /@media\(max-width:760px\)\{body\{overflow-x:hidden\}[\s\S]*?\.login-card\{width:100%;max-width:100%;min-width:0;max-height:calc\(100svh - 42px\);overflow:auto\}/, 'login and PIN cards keep mobile width and scrolling constraints');
assert.match(css, /\.screen-lock-overlay\{padding:24px;place-items:center\}/, 'screen lock overlay is centered with mobile padding');
assert.match(css, /@media\(max-width:600px\)\{\.screen-lock-card\{padding:32px 24px\}/, 'screen lock card has a compact mobile layout');

console.log('PIN LOCK ACCEPTANCE CONTRACT: PASS (trusted PIN return, staff lock, two-tab storage, stale session and mobile constraints)');
