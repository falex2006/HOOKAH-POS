import fs from 'node:fs';
const html = fs.readFileSync('login.html', 'utf8');
const distHtml = fs.readFileSync('dist/login.html', 'utf8');
const distDirectoryHtml = fs.readFileSync('dist/login/index.html', 'utf8');
const js = fs.readFileSync('login.js', 'utf8');
const distJs = fs.readFileSync('dist/login.js', 'utf8');
const css = fs.readFileSync('style.css', 'utf8');
const smokeCss = fs.readFileSync('auth-smoke.css', 'utf8');
const smokeJs = fs.readFileSync('auth-smoke.js', 'utf8');
const loginRevision = /const loginRevision = '(\d+)'/.exec(fs.readFileSync('scripts/sync-published-assets.mjs', 'utf8'))?.[1];
const profile = fs.readFileSync('staff-profile.js', 'utf8');
const lock = fs.readFileSync('lock.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
const loginFormSubmitStart = js.indexOf("form?.addEventListener('submit'");
const loginRequestStart = js.indexOf("response = await fetch('/api/login'", loginFormSubmitStart);
const localDemoFallback = js.indexOf('const user = demoUsers', loginRequestStart);
const responseHandlingStart = js.indexOf('const data = await response.json()', loginRequestStart);
const required = [
  ['password toggle', html.includes('login-password-toggle') && js.includes('passwordToggle')],
  ['shared smoke scene', html.includes('auth-smoke-backdrop') && lock.includes('auth-smoke-backdrop')],
  ['approved smoke assets', fs.existsSync('assets/login-smoke-ambient.mp4') && fs.existsSync('assets/login-smoke-ambient.png') && smokeCss.includes('login-smoke-ambient.png')],
  ['login state hook', js.includes('setLoginState')],
  ['transition layer', js.includes('showLoginTransition')],
  ['skip control', css.includes('login-transition__skip')],
  ['transition completion', js.includes('showLoginTransition') && js.includes('resolve()')],
  ['reduced motion', smokeCss.includes('@media(prefers-reduced-motion:reduce)') && smokeJs.includes('!motion.matches')],
  ['looping muted video', smokeJs.includes('video.loop = true') && smokeJs.includes('video.muted = true')],
  ['inline mobile video', smokeJs.includes('video.playsInline = true')],
  ['hidden PIN does not start video', smokeJs.includes("overlay.getAttribute('aria-hidden') !== 'false'")],
  ['decor cannot intercept inputs', smokeCss.includes('pointer-events:none')],
  ['static fallback', smokeCss.includes('animation:none!important') && smokeJs.includes('video-fallback')],
  ['fallback on media error', smokeJs.includes("video.addEventListener('error'")],
  ['screen lock PIN mode', lock.includes('PIN') && lock.includes('pin')],
  ['PIN validation', profile.includes('staff-profile-pin') && profile.includes('\\\\d{4}')],
  ['self-service PIN settings', profile.includes('staff-profile-pin') && profile.includes('__syncStaffPin')],
  ['trusted admin PIN return uses a live session', html.includes('login-trust-device') && js.includes('/api/session/pin-return') && js.includes('adminPinRoles')],
  ['trusted device is explicit and role-limited on the server', js.includes('trustDevice') && server.includes('canUseTrustedDevice') && server.includes('TRUSTED_SESSION_TTL_MS')],
  ['login is the safe default when setup status is unavailable', /if \(form && setupForm\) \{ form\.hidden = false; setupForm\.hidden = true; \}/.test(js) && !/response\.status === 404[\s\S]*setupForm\.hidden = false/.test(js)],
  ['normal login does not auto-scroll the page by focusing its username field', /else if \(status && !status\.required && form && setupForm\) \{\s*setupForm\.hidden = true;\s*form\.hidden = false;\s*\}/.test(js)],
  ['login is visible before JavaScript runs', /id="login-form"(?![^>]*\shidden)/.test(html)],
  ['first-run form is hidden before JavaScript runs', /id="setup-form"\s+hidden/.test(html)],
  ['login password input is identified as an existing password', /id="login-password"[^>]*autocomplete="current-password"/.test(html)],
  ['published flat login route keeps the safe initial state', /id="login-form"(?![^>]*\shidden)/.test(distHtml) && /id="setup-form"\s+hidden/.test(distHtml)],
  ['published /login/ directory alias matches the safe initial state', /id="login-form"(?![^>]*\shidden)/.test(distDirectoryHtml) && /id="setup-form"\s+hidden/.test(distDirectoryHtml)],
  ['owner recovery form is available on the branded login page', html.includes('id="password-reset-form"') && html.includes('id="reset-password-confirm"')],
  ['published login aliases carry the recovery form', [distHtml, distDirectoryHtml].every(markup => markup.includes('id="password-reset-form"'))],
  ['recovery token stays in the URL fragment and is submitted once', /location\.hash\.slice\(1\)/.test(js) && /resetToken: passwordResetToken, newPassword: password/.test(js) && /history\.replaceState\(null, '', '\/login'\)/.test(js)],
  ['recovery flow verifies confirmation and does not fall through to first-run setup', /password !== passwordResetConfirmInput\.value/.test(js) && /if \(isPasswordReset\) return;/.test(js)],
  ['server consumes valid recovery tokens only with a configured database', /password_reset_requires_database/.test(server) && /password_reset_token_hash=NULL,password_reset_expires_at=NULL/.test(server)],
  ['published login behavior and cache revisions stay synchronized', js === distJs && [html,distHtml,distDirectoryHtml].every(markup => markup.includes(`login.js?rev=${loginRevision}`))],
  ['first-run setup is opt-in for the current environment', /FIRST_RUN_SETUP_ENABLED === 'true'/.test(server) && /if \(!firstRunSetupEnabled\) return json\(res, 200, \{ required: false \}\)/.test(server)],
  ['login HTML cannot stay cached with stale first-run markup', /if \(requestPath === '\/login\.html'\) headers\['Cache-Control'\] = 'no-store'/.test(server)],
  ['setup creation is disabled unless explicitly enabled', /if \(!firstRunSetupEnabled\) return json\(res, 404, \{ error: 'setup_disabled' \}\)/.test(server)],
  ['setup creation rechecks bootstrap state under a database lock', /pg_advisory_xact_lock\(hashtext\('territory_crm_first_run_setup'\)\)[\s\S]*SELECT COUNT\(\*\)::int AS count FROM users WHERE is_active=true AND deleted_at IS NULL[\s\S]*setup_already_completed/.test(server)],
  ['HTTP authentication failures never fall back to a local demo identity', loginRequestStart >= 0 && localDemoFallback > loginRequestStart && responseHandlingStart > localDemoFallback && js.includes('only a fallback when no HTTP response was')],
  ['server-side session-limit failure is explained and the form remains usable', /session_limit_reached:[^\n]*Выйдите на одном из них и повторите вход/.test(js) && /submit\.disabled = false; submit\.textContent = 'Войти в систему';/.test(js)],
];
const missing = required.filter(([, ok]) => !ok).map(([name]) => name);
if (missing.length) { console.error(`LOCAL LOGIN CONTRACT: FAIL (${missing.join(', ')})`); process.exit(1); }
console.log(`LOCAL LOGIN CONTRACT: PASS (${required.length} checks)`);
