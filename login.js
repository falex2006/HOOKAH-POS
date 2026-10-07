const form = document.querySelector('#login-form');
// A login page always starts a fresh authentication attempt; never reuse a stale staff identity.
localStorage.removeItem('crm_session_token');
localStorage.removeItem('crm_session_user');
const setupForm = document.querySelector('#setup-form');
const setupMessage = document.querySelector('#setup-message');
const passwordResetForm = document.querySelector('#password-reset-form');
const passwordResetMessage = document.querySelector('#password-reset-message');
const passwordResetInput = document.querySelector('#reset-password');
const passwordResetConfirmInput = document.querySelector('#reset-password-confirm');
const passwordResetToken = new URLSearchParams(location.hash.slice(1)).get('reset');
const isPasswordReset = Boolean(passwordResetToken && passwordResetForm);
if (isPasswordReset) {
  if (form) form.hidden = true;
  if (setupForm) setupForm.hidden = true;
  passwordResetForm.hidden = false;
  passwordResetInput?.focus();
}
const passwordInput = document.querySelector('#login-password');
const usernameInput = document.querySelector('#login-username');
const trustDeviceInput = document.querySelector('#login-trust-device');
const clearRememberedCredentials = () => { if (usernameInput) usernameInput.value = ''; if (passwordInput) passwordInput.value = ''; };
window.addEventListener('pageshow', clearRememberedCredentials);
window.setTimeout(clearRememberedCredentials, 0);
const passwordToggle = document.querySelector('#login-password-toggle');
passwordToggle?.addEventListener('click', () => { const visible = passwordInput.type === 'text'; passwordInput.type = visible ? 'password' : 'text'; passwordToggle.textContent = visible ? 'Показать' : 'Скрыть'; passwordToggle.setAttribute('aria-label', visible ? 'Показать пароль' : 'Скрыть пароль'); passwordToggle.setAttribute('aria-pressed', String(!visible)); passwordInput.focus(); });

const demoUsers = {
  'admin:admin': { id: 'demo-admin', name: 'Александр', role: 'admin' },
  'owner:demo': { id: 'demo-owner', name: 'Администратор', role: 'owner' },
  'staff:demo': { id: 'demo-bartender', name: 'Мария', role: 'bartender' },
  'developer:developer': { id: 'demo-developer', name: 'Главный разработчик', role: 'developer' },
};

const setLoginState = (state) => { document.body.dataset.loginState = state; form?.setAttribute('data-login-state', state); };
const showFailureAnimation = () => { setLoginState('idle'); return Promise.resolve(); };
setLoginState('idle');
const adminPinRoles = new Set(['owner', 'admin', 'developer']);

const showLoginTransition = () => new Promise((resolve) => {
  resolve();
});

const setupPassword = document.querySelector('#setup-password');
document.querySelector('#setup-password-toggle')?.addEventListener('click', (event) => {
  const visible = setupPassword.type === 'text';
  setupPassword.type = visible ? 'password' : 'text';
  event.currentTarget.textContent = visible ? 'Показать' : 'Скрыть';
  setupPassword.focus();
});

const showSetupIfNeeded = async () => {
  if (isPasswordReset) return;
  if (form && setupForm) { form.hidden = false; setupForm.hidden = true; }
  try {
    const response = await fetch('/api/setup/status', { cache: 'no-store' });
    const status = response.ok ? await response.json() : null;
    if (status?.required && form && setupForm) {
      form.hidden = true;
      setupForm.hidden = false;
      setupForm.querySelector('#setup-venue')?.focus();
    } else if (status && !status.required && form && setupForm) {
      setupForm.hidden = true;
      form.hidden = false;
    }
    if (!status?.required) checkTrustedPinReturn();
  } catch (_) {}
};
showSetupIfNeeded();

passwordResetForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!passwordResetToken || passwordResetForm.dataset.submitting === 'true') return;
  const submit = passwordResetForm.querySelector('button[type="submit"]');
  const password = passwordResetInput.value;
  if (password !== passwordResetConfirmInput.value) {
    passwordResetMessage.textContent = 'Пароли не совпадают. Проверьте оба поля.';
    passwordResetConfirmInput.focus();
    return;
  }
  passwordResetMessage.textContent = 'Сохраняем новый пароль…';
  passwordResetForm.dataset.submitting = 'true';
  submit.disabled = true;
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetToken: passwordResetToken, newPassword: password }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'password_reset_failed');
    passwordResetInput.value = '';
    passwordResetConfirmInput.value = '';
    passwordResetForm.dataset.complete = 'true';
    passwordResetMessage.textContent = 'Пароль обновлён. Теперь войдите с новым паролем.';
    submit.hidden = true;
    history.replaceState(null, '', '/login');
  } catch (error) {
    passwordResetInput.value = '';
    passwordResetConfirmInput.value = '';
    const messages = {
      reset_token_invalid_or_expired: 'Ссылка недействительна или срок её действия истёк. Запросите новую ссылку у владельца платформы.',
      password_too_short: 'Пароль должен содержать не менее 8 символов.',
      password_reset_requires_database: 'Восстановление пароля недоступно в этом режиме. Обратитесь к владельцу платформы.',
    };
    passwordResetMessage.textContent = messages[error.message] || 'Не удалось обновить пароль. Запросите новую ссылку и повторите попытку.';
    passwordResetInput.focus();
  } finally {
    passwordResetForm.dataset.submitting = 'false';
    if (!passwordResetForm.dataset.complete) submit.disabled = false;
  }
});

const trustedReturnCard = document.createElement('section');
trustedReturnCard.className = 'login-card trusted-pin-card';
trustedReturnCard.hidden = true;
trustedReturnCard.innerHTML = `<div class="brand-mark" data-trusted-avatar>T</div><p class="login-kicker">БЫСТРЫЙ ВОЗВРАТ</p><h1>Введите PIN</h1><p data-trusted-user>Доверенное устройство</p><label>PIN-код<input id="trusted-pin" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="4" pattern="[0-9]{4}" placeholder="4 цифры"></label><div class="screen-lock-keypad trusted-pin-keypad" aria-label="Цифровая клавиатура">${['1','2','3','4','5','6','7','8','9','⌫','0','Очистить'].map((key) => `<button type="button" data-trusted-key="${key}">${key}</button>`).join('')}</div><button class="primary" type="button" id="trusted-pin-submit">Продолжить</button><button class="trusted-password-link" type="button" id="trusted-password-login">Войти по паролю</button><p id="trusted-pin-message" class="login-message"></p>`;
form?.after(trustedReturnCard);
let trustedSessionUser = null;
const trustedPinInput = trustedReturnCard.querySelector('#trusted-pin');
const trustedPinMessage = trustedReturnCard.querySelector('#trusted-pin-message');
const showPasswordLogin = () => { trustedReturnCard.hidden = true; if (form) form.hidden = false; usernameInput?.focus(); };
trustedReturnCard.querySelector('#trusted-password-login')?.addEventListener('click', showPasswordLogin);
const unlockTrustedSession = async () => {
  const pin = trustedPinInput.value.replace(/\D/g, '').slice(0, 4);
  trustedPinInput.value = pin;
  if (pin.length !== 4) return;
  const submit = trustedReturnCard.querySelector('#trusted-pin-submit');
  trustedPinMessage.textContent = 'Проверяем PIN…';
  if (submit) submit.disabled = true;
  try {
    const response = await fetch('/api/session/pin-return', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'unlock_failed');
    if (!data.token || !data.user) throw new Error('session_restore_failed');
    await finishLogin({ token: data.token, user: data.user });
  } catch (error) {
    const messages = {
      invalid_pin: 'Неверный PIN. Попробуйте ещё раз.',
      too_many_pin_attempts: 'Слишком много попыток. Подождите минуту.',
      pin_not_configured: 'PIN не настроен. Войдите по паролю.',
      session_restore_failed: 'Сессия устарела. Войдите по паролю.',
    };
    trustedPinInput.value = '';
    trustedPinMessage.textContent = messages[error.message] || 'Не удалось проверить PIN. Войдите по паролю.';
    if (submit) submit.disabled = false;
    trustedPinInput.focus();
  }
};
trustedPinInput?.addEventListener('input', () => { trustedPinInput.value = trustedPinInput.value.replace(/\D/g, '').slice(0, 4); if (trustedPinInput.value.length === 4) unlockTrustedSession(); });
trustedReturnCard.querySelector('.trusted-pin-keypad')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-trusted-key]');
  if (!button) return;
  const key = button.dataset.trustedKey;
  if (key === '⌫') trustedPinInput.value = trustedPinInput.value.slice(0, -1);
  else if (key === 'Очистить') trustedPinInput.value = '';
  else if (trustedPinInput.value.length < 4) trustedPinInput.value += key;
  trustedPinInput.dispatchEvent(new Event('input'));
});
trustedReturnCard.querySelector('#trusted-pin-submit')?.addEventListener('click', unlockTrustedSession);
async function checkTrustedPinReturn() {
  if (isPasswordReset || !form || trustedSessionUser) return;
  try {
    const response = await fetch('/api/session', { cache: 'no-store' });
    if (!response.ok) return;
    const session = await response.json();
    const user = session?.user;
    if (!user?.pinConfigured || !adminPinRoles.has(user.role)) return;
    trustedSessionUser = user;
    const name = String(user.name || 'Администратор').trim() || 'Администратор';
    const initials = name.split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || 'A';
    trustedReturnCard.querySelector('[data-trusted-avatar]').textContent = initials;
    trustedReturnCard.querySelector('[data-trusted-user]').textContent = `${name} · доверенное устройство`;
    form.hidden = true;
    trustedReturnCard.hidden = false;
    trustedPinInput.focus();
  } catch (_) {}
}

setupForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = setupForm.querySelector('button[type="submit"]');
  const payload = {
    venueName: document.querySelector('#setup-venue').value.trim(),
    ownerName: document.querySelector('#setup-name').value.trim(),
    city: document.querySelector('#setup-city').value.trim(),
    ownerLogin: document.querySelector('#setup-login').value.trim().toLowerCase(),
    ownerPassword: document.querySelector('#setup-password').value,
    timezone: document.querySelector('#setup-timezone').value,
  };
  setupMessage.textContent = 'Создаём рабочее пространство…';
  if (submit) { submit.disabled = true; submit.textContent = 'Создаём…'; }
  try {
    const response = await fetch('/api/setup/owner', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (response.status === 404) {
      const owner = { id: `local-owner-${Date.now()}`, name: payload.ownerName, role: 'owner', avatarUrl: null };
      localStorage.setItem('territory_crm_demo_state', JSON.stringify({ venue: { name: payload.venueName, city: payload.city, timezone: payload.timezone }, staff: [{ ...owner, login: payload.ownerLogin, password: payload.ownerPassword, active: true }] }));
      await finishLogin({ token: `demo-static-owner-${Date.now()}`, user: owner });
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'setup_failed');
    const loginResponse = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: payload.ownerLogin, password: payload.ownerPassword, trustDevice: true }) });
    const loginData = await loginResponse.json().catch(() => ({}));
    if (!loginResponse.ok) throw new Error(loginData.error || 'login_failed');
    await finishLogin(loginData);
  } catch (error) {
    setupMessage.textContent = error.message === 'owner_login_already_exists' ? 'Этот логин уже занят' : 'Не удалось создать рабочее пространство';
    if (submit) { submit.disabled = false; submit.textContent = 'Создать и войти'; }
  }
});

const finishLogin = async (data) => {
  // A real server session is the source of truth. Clear local demo orders and
  // shift data so an old browser session can never leak fake tables/orders into
  // the newly authenticated workspace.
  if (data?.token && !String(data.token).startsWith('demo-static-')) {
    ['territory_crm_staff_orders', 'territory_crm_shift', 'territory_crm_discount_requests', 'territory_crm_demo_audits', 'territory_crm_seen_discount_notifications', 'territory_crm_seen_staff_pin_notifications'].forEach((key) => localStorage.removeItem(key));
  }
  localStorage.setItem('crm_session_token', data.token);
  localStorage.setItem('crm_session_user', JSON.stringify(data.user));
  setLoginState('idle');
  await showLoginTransition();
  window.location.replace(data.user.role === 'platform_owner' ? '/platform' : ['owner', 'admin', 'developer'].includes(data.user.role) ? '/admin' : '/' );
};

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.querySelector('#login-message');
  const submit = form.querySelector('button[type="submit"]');
  const username = usernameInput.value.trim();
  const password = document.querySelector('#login-password').value;
  clearRememberedCredentials();
  message.textContent = 'Проверяем доступ…';
  if (submit) { submit.disabled = true; submit.textContent = 'Проверяем…'; }

  let response;
  try {
    response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, trustDevice: Boolean(trustDeviceInput?.checked) }),
    });
  } catch (error) {
    // Offline/demo credentials are only a fallback when no HTTP response was
    // received. Never turn a server-side rejection (401/409/429/503) into a
    // local identity or an invalid token loop.
    try {
      const state = JSON.parse(localStorage.getItem('territory_crm_demo_state') || '{}');
      const person = (state.staff || []).find((entry) => entry.active !== false && entry.login === username && entry.password === password);
      if (person) { finishLogin({ token: `demo-static-${person.role}-${Date.now()}`, user: { id: person.id, name: person.name, role: person.role, avatarUrl: person.avatarUrl || null } }); return; }
    } catch (_) {}
    const user = demoUsers[`${username}:${password}`];
    if (user) {
      finishLogin({ token: `demo-static-${user.role}-${Date.now()}`, user });
      return;
    }
    message.textContent = 'Сервер входа недоступен. Проверьте подключение и повторите попытку.';
    await showFailureAnimation();
    if (submit) { submit.disabled = false; submit.textContent = 'Войти в систему'; }
    return;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const messages = {
      invalid_credentials: 'Неверный логин или пароль',
      too_many_login_attempts: 'Слишком много попыток. Повторите позже.',
      session_limit_reached: 'Учетная запись уже открыта на двух устройствах. Выйдите на одном из них и повторите вход.',
    };
    message.textContent = messages[data.error] || 'Не удалось войти. Проверьте данные и повторите попытку.';
    await showFailureAnimation();
    if (submit) { submit.disabled = false; submit.textContent = 'Войти в систему'; }
    return;
  }
  if (!data.token || !data.user) {
    message.textContent = 'Сервер вернул неполный ответ. Повторите попытку.';
    await showFailureAnimation();
    if (submit) { submit.disabled = false; submit.textContent = 'Войти в систему'; }
    return;
  }
  await finishLogin(data);
  if (submit) { submit.disabled = false; submit.textContent = 'Войти в систему'; }
});
