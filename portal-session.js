/* Verify access before loading the classic portal script: its globals are used by extensions. */
(() => {
  const tokenKey = 'crm_session_token';
  const userKey = 'crm_session_user';
  const portalScript = '/portal.js?rev=2026103113';
  let pending = null;
  let cooldownUntil = 0;
  let cooldownTimer = null;
  let accepted = null;
  let loaded = false;
  let loading = false;
  let scriptFailed = false;
  let blocked = true;
  let reloading = false;
  const signature = (session) => JSON.stringify([
    session.user.id, session.user.venueId, session.user.organizationId, session.user.role,
    [...new Set(session.permissions)].sort(), session.permissionPolicy || session.user.permissionPolicy || null,
  ]);
  const canAccessRoute = (session, pathname, hash = '') => {
    const permissions = new Set(session.permissions);
    const any = (...keys) => keys.some((key) => permissions.has(key));
    const page = pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
    if (page === '/clients') return any('orders', 'staff', 'staff_view');
    if (page === '/network') return ['owner', 'admin', 'developer'].includes(session.user.role) && permissions.has('settings');
    if (page === '/admin') {
      if (hash === '#staff') return any('staff', 'staff_view');
      if (hash === '#staff-schedule') return any('staff_schedule_view', 'staff_schedule_self');
      if (hash === '#staff-attendance') return any('staff_attendance_policy_manage', 'staff_attendance_approval', 'staff_attendance_close');
      if (hash === '#permissions') return session.user.role === 'owner';
      if (hash === '#tasks') return any('orders', 'tasks_manage');
      if (hash === '#loyalty') return any('loyalty');
      if (hash === '#diagnostics') return any('diagnostics');
      if (['#settings', '#company', '#settings-dashboard-modules', '#venue-layout-settings', '#lock-security', '#audit'].includes(hash)) return any('settings');
      if (hash === '#shift-control') return any('orders', 'floor');
      return ['', '#notifications', '#help'].includes(hash);
    }
    const required = { '/': 'orders', '/orders': 'orders', '/inventory': 'inventory_read', '/finance': 'finance_read', '/finance-categories': 'finance_read', '/finance-report': 'finance_read', '/finance/categories': 'finance_read', '/finance/report': 'finance_read', '/reservations': 'reservations', '/integrations': 'integrations', '/delivery': 'delivery', '/network': 'settings' };
    return Boolean(required[page] && permissions.has(required[page]));
  };
  const canUseNavigation = (session, href, permission) => {
    const url = new URL(href, window.location.origin);
    if (url.pathname === '/clients' || url.pathname === '/admin' || url.pathname === '/network') return canAccessRoute(session, url.pathname, url.hash);
    return permission === 'dashboard' || session.permissions.includes(permission);
  };
  function updateRetryButton() {
    const button = document.getElementById('portal-session-guard')?.querySelector('[data-session-retry]');
    if (!button) return;
    const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
    button.disabled = Boolean(pending || seconds);
    button.textContent = seconds ? `Повтор через ${seconds} с` : pending ? 'Повторяем…' : 'Повторить';
  }
  function startCooldown(response) {
    const seconds = Number(response.headers?.get('Retry-After'));
    cooldownUntil = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 30) * 1000;
    clearTimeout(cooldownTimer);
    const tick = () => {
      if (reloading) return;
      const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      if (!remaining) { cooldownUntil = 0; cooldownTimer = null; refresh(); return; }
      block(`Слишком много запросов. Повтор через ${remaining} с.`);
      cooldownTimer = setTimeout(tick, Math.min(1000, cooldownUntil - Date.now()));
    };
    tick();
  }
  function block(message = 'Загрузка…', denied = false) {
    blocked = true;
    document.documentElement.dataset.portalAccess = 'checking';
    let guard = document.getElementById('portal-session-guard');
    if (!guard) {
      guard = document.createElement('section');
      guard.id = 'portal-session-guard';
      guard.setAttribute('role', 'status');
      guard.innerHTML = '<span data-session-message></span><button type="button" data-session-retry>Повторить</button><a data-session-login href="/login">Войти заново</a>';
      document.body.append(guard);
      guard.querySelector('[data-session-retry]').onclick = () => refresh();
    }
    const initialLoading = message === 'Загрузка…';
    guard.setAttribute('data-loading', String(initialLoading));
    guard.setAttribute('aria-label', initialLoading ? 'Загрузка' : message);
    guard.querySelector('[data-session-message]').textContent = initialLoading ? '' : message;
    guard.querySelector('[data-session-retry]').hidden = denied || message === 'Загрузка…' || reloading;
    guard.querySelector('[data-session-login]').hidden = message === 'Загрузка…' || reloading;
    updateRetryButton();
  }
  function reload(message = 'Доступ изменился. Обновляем рабочее место…') {
    if (reloading) return;
    reloading = true;
    clearTimeout(cooldownTimer);
    block(message);
    window.location.reload();
  }
  function unblock() {
    blocked = false;
    delete document.documentElement.dataset.portalAccess;
    document.getElementById('portal-session-guard')?.remove();
  }
  function install(session) {
    accepted = session;
    window.__portalSessionVerified = session;
    const user = { ...session.user, workspacePermissions: [...session.permissions], permissionPolicy: session.permissionPolicy || session.user.permissionPolicy };
    localStorage.setItem(userKey, JSON.stringify(user));
    if (!canAccessRoute(session, window.location.pathname, window.location.hash)) {
      block(window.location.pathname.replace(/\/$/, '') === '/network'
        ? 'Раздел «Моя сеть» доступен владельцу, администратору или разработчику.'
        : 'Доступ к этому разделу ограничен. Владелец может изменить права вашей роли.', true);
      return;
    }
    // A classic script may execute even after its network deadline. Retry in a
    // fresh document so its globals and event handlers can never execute twice.
    if (scriptFailed) { reload('Повторно загружаем интерфейс…'); return; }
    if (loaded) { unblock(); return; }
    if (loading) return;
    loading = true;
    blocked = false;
    const script = document.createElement('script');
    script.src = portalScript;
    const timer = setTimeout(() => {
      scriptFailed = true;
      block('Загрузка интерфейса занимает слишком долго. Повторите проверку.');
    }, 15000);
    script.onload = () => {
      clearTimeout(timer);
      loading = false;
      loaded = true;
      if (scriptFailed || blocked || reloading || !accepted || !canAccessRoute(accepted, window.location.pathname, window.location.hash)) return;
      unblock();
    };
    script.onerror = () => {
      clearTimeout(timer);
      loading = false;
      scriptFailed = true;
      block('Не удалось загрузить интерфейс. Повторите проверку.');
    };
    document.head.append(script);
  }

  async function verify() {
    const token = localStorage.getItem(tokenKey);
    if (!token) { block(); window.location.replace('/login'); return; }
    // Demo is an explicit separate mode. It never supplies permissions to a real session.
    if (token.startsWith('demo-static-')) {
      window.__portalSessionVerified = { demo: true };
      const script = document.createElement('script'); script.src = portalScript;
      script.onload = () => { blocked = false; delete document.documentElement.dataset.portalAccess; document.getElementById('portal-session-guard')?.remove(); };
      if (!loaded) { loaded = true; document.head.append(script); }
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('/api/session', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal });
      const session = response.ok ? await response.json() : null;
      if (localStorage.getItem(tokenKey) !== token || reloading) return;
      if (response.status === 429) { startCooldown(response); return; }
      if (response.status === 401) {
        accepted = null; block('Сессия завершена. Войдите снова.');
        localStorage.removeItem(tokenKey); localStorage.removeItem(userKey); window.location.replace('/login'); return;
      }
      if (!response.ok || !session?.user?.id || !Array.isArray(session.permissions) || !session.permissions.every((value) => typeof value === 'string')) throw new Error('session_unavailable');
      if (accepted && signature(accepted) !== signature(session) && (loaded || loading)) { accepted = session; reload(); return; }
      install(session);
    } catch (_) {
      if (localStorage.getItem(tokenKey) === token && !reloading) block('Не удалось проверить доступ. Проверьте подключение и повторите попытку.');
    } finally { clearTimeout(timer); }
  }
  function refresh() {
    if (reloading) return Promise.resolve();
    if (cooldownUntil > Date.now()) { updateRetryButton(); return Promise.resolve(); }
    if (cooldownUntil) { cooldownUntil = 0; clearTimeout(cooldownTimer); cooldownTimer = null; }
    if (!pending) {
      pending = verify().finally(() => { pending = null; updateRetryButton(); });
      updateRetryButton();
    }
    return pending;
  }
  window.__portalSessionGate = { refresh, block, signature, canAccessRoute, canUseNavigation, get blocked() { return blocked; } };
  window.addEventListener('focus', () => refresh());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('storage', (event) => { if (event.key === tokenKey) reload(); });
  window.addEventListener('hashchange', (event) => {
    if (!accepted || reloading) return;
    if (!canAccessRoute(accepted, window.location.pathname, window.location.hash)) {
      block(window.location.pathname.replace(/\/$/, '') === '/network'
        ? 'Раздел «Моя сеть» доступен владельцу, администратору или разработчику.'
        : 'Доступ к этому разделу ограничен. Владелец может изменить права вашей роли.', true);
      event.stopImmediatePropagation();
    } else if (blocked) { event.stopImmediatePropagation(); reload(); }
  });
  setInterval(() => { if (!document.hidden) refresh(); }, 30000);
  block();
  refresh();
})();
