;(async () => {
  let token = localStorage.getItem('crm_session_token');
  let user = {};
  try { user = JSON.parse(localStorage.getItem('crm_session_user') || '{}'); } catch (_) {}
  if (!token) return;

  const activeToken = token;
  const sessionEventKey = 'crm_session_event';
  const identityKey = String(user.id || user.login || user.name || 'user').trim().toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, '_').slice(0, 80) || 'user';
  const timeoutKey = `crm_lock_timeout_user_${identityKey}`;
  const lockStateKey = `crm_screen_locked_user_${identityKey}`;
  const timeoutOptions = [0, 1, 5, 10, 15, 30];
  const readTimeout = () => { const accountValue = Number(user.preferences?.lockTimeoutMinutes); if (timeoutOptions.includes(accountValue)) return accountValue; try { const value = Number(localStorage.getItem(timeoutKey)); return timeoutOptions.includes(value) ? value : 5; } catch (_) { return 5; } };
  let timeoutMinutes = readTimeout();
  let autoLockEnabled = Boolean(user.pinConfigured);
  const inactivityMs = () => timeoutMinutes * 60 * 1000;
  let locked = false;
  let timer = null;
  let unlockRequest = null;

  const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('crm_session_token') || ''}`, 'Content-Type': 'application/json' });
  const refreshUserFromSession = async () => {
    try {
      const response = await fetch('/api/session', { headers: headers(), cache: 'no-store' });
      if (!response.ok) return false;
      const payload = await response.json().catch(() => ({}));
      if (!payload?.user || String(payload.user.id || '') !== String(user.id || payload.user.id || '')) return false;
      user = { ...user, ...payload.user };
      localStorage.setItem('crm_session_user', JSON.stringify(user));
      autoLockEnabled = Boolean(user.pinConfigured);
      return Boolean(user.pinConfigured);
    } catch (_) { return false; }
  };
  const redirectToLogin = () => { clearTimeout(timer); location.replace('/login'); };
  window.__broadcastSessionEnd = () => { try { localStorage.setItem(sessionEventKey, JSON.stringify({ action: 'logout', userId: String(user.id || ''), at: Date.now() })); } catch (_) {} };
  const logout = async () => {
    const button=overlay.querySelector('#screen-lock-exit');
    if(button.disabled)return;
    button.disabled=true;
    try { if(!String(localStorage.getItem('crm_session_token')||'').startsWith('demo-static-')){const response=await fetch('/api/logout', { method: 'POST', headers: headers() });if(!response.ok&&response.status!==401)throw new Error('logout_unavailable');} }
    catch (_) {button.disabled=false;setMessage('Не удалось завершить сессию. Повторите выход.','error');return;}
    window.__broadcastSessionEnd();
    try { localStorage.removeItem(lockStateKey); } catch (_) {}
    localStorage.removeItem('crm_session_token');
    localStorage.removeItem('crm_session_user');
    location.replace('/login');
  };
  const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="/assets/tabler-icons.svg#${name}"></use></svg>`;
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const displayName = String(user.name || 'Сотрудник').trim() || 'Сотрудник';
  const initials = displayName.split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || 'С';
  const avatarMarkup = user.avatarUrl ? `<img src="${escapeHtml(user.avatarUrl)}" alt="">` : `<span>${escapeHtml(initials)}</span>`;

  if (!document.querySelector('link[data-auth-smoke]')) {
    const smokeStyle = document.createElement('link');
    smokeStyle.rel = 'stylesheet';
    smokeStyle.href = '/auth-smoke.css?rev=2';
    smokeStyle.dataset.authSmoke = 'true';
    document.head.appendChild(smokeStyle);
  }
  if (!document.querySelector('script[data-auth-smoke]')) {
    const smokeScript = document.createElement('script');
    smokeScript.src = '/auth-smoke.js?rev=3';
    smokeScript.dataset.authSmoke = 'true';
    document.head.appendChild(smokeScript);
  }
  const overlay = document.createElement('div');
  overlay.className = 'screen-lock-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `<div class="auth-smoke-backdrop" aria-hidden="true"><span class="auth-smoke-texture"></span><span class="auth-smoke-light"></span><span class="auth-smoke-vignette"></span></div><section class="screen-lock-card" role="dialog" aria-modal="true" aria-labelledby="screen-lock-title">
    <div class="screen-lock-mark" aria-label="Аватар сотрудника">${avatarMarkup}</div>
    <picture class="auth-product-brand screen-lock-brand"><img src="/assets/brand/hookah-pos-lockup.svg?rev=2" width="200" height="64" alt="Hookah POS by AlphaSat"></picture>
    <p class="screen-lock-eyebrow">РАБОЧЕЕ МЕСТО ЗАБЛОКИРОВАНО</p>
    <h2 id="screen-lock-title">Вернитесь к работе</h2>
    <p class="screen-lock-user">${escapeHtml(displayName)}</p>
    <p class="screen-lock-hint" id="screen-lock-hint">Введите свой 4-значный PIN, чтобы продолжить.</p>
    <input class="screen-lock-pin" id="screen-lock-pin" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="4" pattern="[0-9]{4}" placeholder="••••" aria-label="PIN сотрудника">
    <div class="screen-lock-keypad" aria-label="Цифровая клавиатура">${['1','2','3','4','5','6','7','8','9','⌫','0','Очистить'].map((key) => `<button type="button" data-lock-key="${key}" ${key === 'Очистить' ? 'class="wide"' : ''}>${key}</button>`).join('')}</div>
    <p class="screen-lock-message" id="screen-lock-message" role="alert"></p>
    <button type="button" class="screen-lock-exit" id="screen-lock-exit">${icon('logout')} Выйти из системы</button>
  </section>`;
  document.body.appendChild(overlay);

  const pinInput = overlay.querySelector('#screen-lock-pin');
  const message = overlay.querySelector('#screen-lock-message');
  const hint = overlay.querySelector('#screen-lock-hint');
  const setMessage = (text, kind = '') => { message.textContent = text; message.className = `screen-lock-message ${kind}`; };
  const lock = async (reason = 'manual') => {
    if (locked) return;
    if (!user.pinConfigured && !await refreshUserFromSession()) { window.__openLockSettings?.(); return; }
    locked = true;
    try { localStorage.setItem(lockStateKey, 'locked'); } catch (_) {}
    clearTimeout(timer);
    overlay.dataset.reason = reason;
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('screen-locked');
    pinInput.value = '';
    setMessage('');
    hint.textContent = reason === 'auto' ? `Система заблокирована после ${timeoutMinutes} минут бездействия.` : 'Экран заблокирован вручную.';
    pinInput.focus();
  };
  const schedule = () => { if (autoLockEnabled && timeoutMinutes > 0 && !locked) { clearTimeout(timer); timer = setTimeout(() => lock('auto'), inactivityMs()); } };
  const unlock = async () => {
    if (unlockRequest || pinInput.value.length !== 4) return;
    unlockRequest = fetch('/api/session/unlock', { method: 'POST', headers: headers(), body: JSON.stringify({ pin: pinInput.value }) }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { const error = new Error(payload.error || 'unlock_failed'); error.status = response.status; throw error; }
      locked = false; try { localStorage.setItem(lockStateKey, `unlocked:${Date.now()}`); } catch (_) {} overlay.setAttribute('aria-hidden', 'true'); document.body.classList.remove('screen-locked'); setMessage(''); schedule();
    }).catch((error) => {
      pinInput.value = '';
      if (error.message === 'pin_not_configured') setMessage('PIN не настроен. Выйдите и обратитесь к администратору.', 'error');
      else if (error.message === 'invalid_pin') setMessage('Неверный PIN. Попробуйте ещё раз.', 'error');
      else if (error.message === 'too_many_pin_attempts') setMessage('Слишком много попыток. Подождите минуту и попробуйте снова.', 'error');
      else setMessage('Не удалось проверить PIN. Проверьте соединение.', 'error');
    }).finally(() => { unlockRequest = null; });
    await unlockRequest;
  };
  pinInput.addEventListener('input', () => { pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 4); if (pinInput.value.length === 4) unlock(); });
  overlay.querySelector('.screen-lock-keypad').addEventListener('click', (event) => { const button = event.target.closest('[data-lock-key]'); if (!button) return; const key = button.dataset.lockKey; if (key === '⌫') pinInput.value = pinInput.value.slice(0, -1); else if (key === 'Очистить') pinInput.value = ''; else if (pinInput.value.length < 4) pinInput.value += key; pinInput.dispatchEvent(new Event('input')); });
  overlay.querySelector('#screen-lock-exit').addEventListener('click', logout);

  // A standalone glyph avoids stale external sprite caches on shared terminals.
  const lockButtonStyle = document.createElement('style');
  lockButtonStyle.textContent = `
    #lock-screen-button { display:inline-flex!important;align-items:center!important;justify-content:center!important;width:44px!important;min-width:44px!important;height:44px!important;min-height:44px!important;padding:0!important;margin:0!important;border:0!important;background:transparent!important;box-shadow:none!important;color:#c4cad1!important;cursor:pointer; }
    #lock-screen-button .lock-button-glyph { display:block!important;position:static!important;flex:none;width:18px!important;height:18px!important;transform:none!important; }
    #lock-screen-button:hover { color:#fff!important;background:#24272d!important; }
    #lock-screen-button:focus-visible { outline:2px solid #ff9a8f!important;outline-offset:2px; }
  `;
  document.head.appendChild(lockButtonStyle);
  const addLockButton = (host) => { if (!host || document.querySelector('#lock-screen-button')) return; const button = document.createElement('button'); button.type = 'button'; button.id = 'lock-screen-button'; button.className = 'lock-screen-button'; button.title = 'Заблокировать экран'; button.setAttribute('aria-label', 'Заблокировать экран'); button.innerHTML = '<svg class="lock-button-glyph" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="display:block!important" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"></rect><path d="M8 10V6a4 4 0 0 1 8 0v4"></path><path d="M12 14v3"></path></svg>'; button.addEventListener('click', () => lock('manual')); host.prepend(button); };
  const settingsDialog = document.createElement('dialog');
  settingsDialog.className = 'lock-settings-dialog';
  settingsDialog.innerHTML = `<form method="dialog" class="lock-settings-card lock-settings-simple"><div class="lock-settings-head"><div><h2>Блокировка экрана</h2><p>Личные настройки</p></div><button type="submit" class="lock-settings-close" aria-label="Закрыть">${icon('x')}</button></div><div class="lock-pin-settings"><div class="lock-settings-section-head"><b>PIN-код</b><span id="lock-pin-state">${user.pinConfigured ? 'Установлен' : 'Не задан'}</span></div><div class="lock-pin-fields"><label>Новый PIN<input type="password" id="lock-new-pin" inputmode="numeric" autocomplete="new-password" maxlength="4" pattern="[0-9]{4}" placeholder="4 цифры"></label><label>Повторите PIN<input type="password" id="lock-new-pin-confirm" inputmode="numeric" autocomplete="new-password" maxlength="4" pattern="[0-9]{4}" placeholder="4 цифры"></label></div><p class="lock-settings-note">${user.pinConfigured ? 'Оставьте поля пустыми, чтобы сохранить текущий PIN.' : 'Задайте PIN для разблокировки экрана.'}</p><p class="lock-pin-message" id="lock-pin-message" role="alert"></p></div><label class="lock-timeout-label" for="lock-timeout-select">Блокировать при бездействии</label><select id="lock-timeout-select" name="lock-timeout">${timeoutOptions.map((value) => `<option value="${value}">${value ? `Через ${value} мин` : 'Не блокировать автоматически'}</option>`).join('')}</select><button type="button" class="button primary lock-settings-save">Сохранить</button></form>`;
  document.body.append(settingsDialog);
  const syncSettings = () => { settingsDialog.querySelector('#lock-timeout-select').value = String(timeoutMinutes); };
  const settingsButton = document.createElement('button'); settingsButton.type = 'button'; settingsButton.className = 'lock-settings-button'; settingsButton.title = 'Настройки автоблокировки'; settingsButton.setAttribute('aria-label', 'Настройки автоблокировки'); settingsButton.innerHTML = icon('settings'); const openLockSettings = () => { syncSettings(); settingsDialog.showModal(); }; window.__openLockSettings = openLockSettings; settingsButton.addEventListener('click', openLockSettings);
  document.addEventListener('click', (event) => { if (event.target.closest('#lock-screen-button')) { event.preventDefault(); event.stopPropagation(); lock('manual'); return; } if (event.target.closest('#lock-settings-button')) { event.preventDefault(); event.stopPropagation(); openLockSettings(); } }, true);
  window.addEventListener('storage', (event) => {
    if (event.key === sessionEventKey && event.newValue) {
      try { const notice = JSON.parse(event.newValue); if (notice.action === 'logout' && String(notice.userId || '') === String(user.id || '')) redirectToLogin(); } catch (_) {}
      return;
    }
    if (event.key === 'crm_session_token' && event.newValue !== activeToken) { redirectToLogin(); return; }
    if (event.key === 'crm_session_user') {
      if (!event.newValue) { redirectToLogin(); return; }
      try {
        const nextUser = JSON.parse(event.newValue);
        if (String(nextUser.id || '') !== String(user.id || '')) { redirectToLogin(); return; }
        user = { ...user, ...nextUser };
        autoLockEnabled = Boolean(user.pinConfigured);
        timeoutMinutes = readTimeout();
        syncSettings();
        settingsDialog.querySelector('#lock-pin-state').textContent = user.pinConfigured ? 'Настроен' : 'Не задан';
        clearTimeout(timer);
        schedule();
      } catch (_) {}
      return;
    }
    if (event.key !== lockStateKey) return;
    if (event.newValue === 'locked' && user.pinConfigured) lock('manual');
    else if (event.newValue?.startsWith('unlocked:') && locked) { locked = false; clearTimeout(timer); overlay.setAttribute('aria-hidden', 'true'); document.body.classList.remove('screen-locked'); setMessage(''); schedule(); }
  });
  try { if (localStorage.getItem(lockStateKey) === 'locked' && user.pinConfigured) requestAnimationFrame(() => lock('manual')); } catch (_) {}
  const lockHost = document.querySelector('.header-right') || document.querySelector('.staff-header-user') || document.querySelector('.user');
  addLockButton(lockHost);
  if (lockHost && !document.querySelector('#lock-settings-button')) { settingsButton.id = 'lock-settings-button'; lockHost.prepend(settingsButton); }
  settingsDialog.querySelector('.lock-settings-save').addEventListener('click', async () => { const pinMessage = settingsDialog.querySelector('#lock-pin-message'); const newPin = settingsDialog.querySelector('#lock-new-pin').value.trim(); const confirmPin = settingsDialog.querySelector('#lock-new-pin-confirm').value.trim(); if ((newPin || confirmPin) && (!/^\d{4}$/.test(newPin) || newPin !== confirmPin)) { pinMessage.textContent = 'Введите одинаковый PIN из 4 цифр'; pinMessage.className = 'lock-pin-message error'; return; } const selected = settingsDialog.querySelector('#lock-timeout-select'); timeoutMinutes = Number(selected?.value || 0); const saveButton = settingsDialog.querySelector('.lock-settings-save'); saveButton.disabled = true; try { if (newPin) { const response = await fetch(`/api/staff/${encodeURIComponent(user.id)}/pin`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ pin: newPin }) }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.error || 'pin_save_failed'); user.pinConfigured = true; autoLockEnabled = true; settingsDialog.querySelector('#lock-pin-state').textContent = 'Настроен'; settingsDialog.querySelector('#lock-new-pin').value = ''; settingsDialog.querySelector('#lock-new-pin-confirm').value = ''; pinMessage.textContent = 'PIN сохранён'; pinMessage.className = 'lock-pin-message success'; } user.preferences = { ...(user.preferences || {}), lockTimeoutMinutes: timeoutMinutes }; try { localStorage.setItem(timeoutKey, String(timeoutMinutes)); localStorage.setItem('crm_session_user', JSON.stringify(user)); } catch (_) {} fetch('/api/session/preferences', { method: 'PATCH', headers: headers(), body: JSON.stringify({ lockTimeoutMinutes: timeoutMinutes }) }).catch(() => {}); clearTimeout(timer); schedule(); window.setTimeout(() => settingsDialog.close(), newPin ? 500 : 0); } catch (error) { pinMessage.textContent = error.message === 'staff_pin_key_required' ? 'Не настроено хранилище PIN' : 'Не удалось сохранить PIN'; pinMessage.className = 'lock-pin-message error'; } finally { saveButton.disabled = false; } });
  fetch('/api/session/preferences', { headers: headers() }).then((response) => response.ok ? response.json() : null).then((payload) => { const serverValue = Number(payload?.preferences?.lockTimeoutMinutes); if (!timeoutOptions.includes(serverValue)) return; timeoutMinutes = serverValue; user.preferences = { ...(user.preferences || {}), lockTimeoutMinutes: serverValue }; try { localStorage.setItem(timeoutKey, String(serverValue)); localStorage.setItem('crm_session_user', JSON.stringify(user)); } catch (_) {} clearTimeout(timer); schedule(); }).catch(() => {});
  ['pointerdown', 'keydown', 'touchstart', 'mousemove', 'scroll'].forEach((eventName) => document.addEventListener(eventName, () => { if (!locked) schedule(); }, { passive: true }));
  schedule();
})();
