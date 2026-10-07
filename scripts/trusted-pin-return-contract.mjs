import fs from 'node:fs';
import assert from 'node:assert/strict';

const server = fs.readFileSync('server.js', 'utf8');
const login = fs.readFileSync('login.js', 'utf8');
const db = fs.readFileSync('db.js', 'utf8');
const css = fs.readFileSync('style.css', 'utf8');

assert.match(db, /u\.pin_updated_at AS "pinUpdatedAt"/, 'persisted cookie sessions expose whether PIN is configured');
assert.match(db, /s\.created_at AS "createdAt",s\.expires_at AS "expiresAt"/, 'persisted sessions expose their original duration so trusted-device state is derived server-side');
assert.match(server, /const STANDARD_SESSION_TTL_MS = 12 \* 60 \* 60 \* 1000/, 'normal sessions stay shorter than trusted owner/admin devices');
assert.match(server, /const TRUSTED_SESSION_TTL_MS = 30 \* 24 \* 60 \* 60 \* 1000/, 'trusted owner/admin devices keep a long session for PIN return');
assert.match(server, /canUseTrustedDevice = \(role\) => \['owner', 'admin', 'developer'\]\.includes/, 'only leader roles can request a trusted device session');
assert.match(server, /const isTrustedSession = \(session\) => \{[\s\S]*?expiresAt - createdAt > STANDARD_SESSION_TTL_MS/, 'trusted-device state is derived from the current session and not only from role or PIN');
assert.match(server, /pathname === '\/api\/session\/pin-return'/, 'trusted PIN return has a dedicated endpoint');
assert.match(server, /pin_return_role_forbidden/, 'trusted PIN return rejects operational staff roles');
assert.match(server, /pin_return_requires_trusted_device/, 'trusted PIN return rejects owner-admin sessions that were not created as trusted devices');
assert.match(server, /req\.user\.pinConfigured = true/, 'PIN return marks the restored user as PIN-configured for the browser lock state');
assert.match(server, /trustedDevice: Boolean\(persistedSession\?\.trustedDevice\)/, 'session restore exposes only the trusted-device flag, never the bearer token');
assert.match(server, /return json\(res, 200, \{ token, user, permissions: effectivePermissions\(user\), expiresIn: sessionTtlSeconds\(TRUSTED_SESSION_TTL_MS\), trustedDevice: true \}\)/, 'PIN return restores the existing trusted session token after verification');
assert.match(login, /const adminPinRoles = new Set\(\['owner', 'admin', 'developer'\]\)/, 'trusted PIN return is limited to owner/admin/developer roles');
assert.match(login, /login-trust-device/, 'password login exposes a trust-this-device choice');
assert.match(login, /fetch\('\/api\/session', \{ cache: 'no-store' \}\)/, 'login page checks the current trusted cookie session');
assert.match(login, /!session\?\.trustedDevice \|\| !user\?\.pinConfigured \|\| !adminPinRoles\.has\(user\.role\)/, 'login PIN card appears only for a live trusted-device session with a configured leader PIN');
assert.match(login, /fetch\('\/api\/session\/pin-return'[\s\S]*?body: JSON\.stringify\(\{ pin \}\)/, 'trusted return validates PIN through the PIN-return endpoint');
assert.match(login, /await finishLogin\(\{ token: data\.token, user: data\.user \}\)/, 'successful PIN return restores local browser session state');
assert.match(login, /Войти по паролю/, 'password login remains available from the PIN return card');
assert.match(css, /\.trusted-pin-card\[hidden\]\{display:none\}/, 'trusted PIN card respects the hidden state');
assert.match(css, /\.login-card \.login-trust-device\{display:flex;align-items:center;gap:10px/, 'trust-device checkbox uses a compact row inside the login card');
assert.match(css, /\.login-card \.login-trust-device span\{min-width:0\}/, 'trust-device label cannot force mobile horizontal overflow');
assert.match(css, /@media\(max-width:760px\)\{body\{overflow-x:hidden\}[\s\S]*?\.login-card\{width:100%;max-width:100%;min-width:0;max-height:calc\(100svh - 42px\);overflow:auto\}/, 'login and trusted PIN cards retain mobile width and scrolling constraints');
assert.match(css, /\.trusted-pin-keypad\{grid-template-columns:repeat\(3,1fr\);gap:10px/, 'trusted PIN keypad stays a fixed three-column touch grid');

console.log('TRUSTED PIN RETURN CONTRACT: PASS');
