/* Verify access before loading the classic portal script: its globals are used by extensions. */
(() => {
  const tokenKey = 'crm_session_token';
  const userKey = 'crm_session_user';
  const portalScript = '/portal.js?rev=474';
  let pending = null;
  let accepted = null;
  let loaded = false;
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
    if (page === '/admin') {
      if (hash === '#staff') return any('staff', 'staff_view');
      if (hash === '#permissions') return session.user.role === 'owner';
      if (hash === '#tasks') return any('orders', 'tasks_manage');
      if (hash === '#loyalty') return any('loyalty');
      if (hash === '#diagnostics') return any('diagnostics');
      if (['#settings', '#company', '#settings-dashboard-modules', '#venue-layout-settings', '#lock-security', '#audit'].includes(hash)) return any('settings');
      if (hash === '#shift-control') return any('orders', 'floor');
      return ['', '#notifications', '#help'].includes(hash);
    }
    const required = { '/': 'orders', '/orders': 'orders', '/inventory': 'inventory_read', '/finance': 'finance_read', '/finance-categories': 'finance', '/finance-report': 'finance_read', '/finance/categories': 'finance', '/finance/report': 'finance_read', '/reservations': 'reservations', '/integrations': 'integrations', '/delivery': 'delivery', '/network': 'settings' };
    return Boolean(required[page] && permissions.has(required[page]));
  };
  const canUseNavigation = (session, href, permission) => {
    const url = new URL(href, window.location.origin);
    if (url.pathname === '/clients' || url.pathname === '/admin') return canAccessRoute(session, url.pathname, url.hash);
    return permission === 'dashboard' || session.permissions.includes(permission);
  };
  function block(message = 'Проверяем доступ…', denied = false) {
    blocked = true;
    document.documentElement.dataset.portalAccess = 'checking';
    let guard = document.getElementById('portal-session-guard');
    if (!guard) {
      guard = document.createElement('section');
      guard.id = 'portal-session-guard';
      guard.setAttribute('role', 'status');
      guard.innerHTML = '<h1>Hookah POS</h1><p data-session-message></p><button type="button" data-session-retry>Повторить проверку</button> <a href="/">Рабочий стол</a> · <a href="/login">Войти в другую учётную запись</a>';
      document.body.append(guard);
      guard.querySelector('[data-session-retry]').onclick = () => refresh();
    }
    guard.querySelector('[data-session-message]').textContent = message;
    guard.querySelector('[data-session-retry]').hidden = denied || message === 'Проверяем доступ…';
  }
  function reload() {
    if (reloading) return;
    reloading = true;
    block('Доступ изменился. Обновляем рабочее место…');
    window.location.reload();
  }
  function install(session) {
    accepted = session;
    window.__portalSessionVerified = session;
    const user = { ...session.user, workspacePermissions: [...session.permissions], permissionPolicy: session.permissionPolicy || session.user.permissionPolicy };
    localStorage.setItem(userKey, JSON.stringify(user));
    if (!canAccessRoute(session, window.location.pathname, window.location.hash)) {
      block('Доступ к этому разделу ограничен. Владелец может изменить права вашей роли.', true);
      return;
    }
    if (loaded) { if (blocked) reload(); return; }
    loaded = true;
    blocked = false;
    const script = document.createElement('script');
    script.src = portalScript;
    script.onload = () => {
      if (blocked || reloading || !accepted || !canAccessRoute(accepted, window.location.pathname, window.location.hash)) return;
      blocked = false;
      delete document.documentElement.dataset.portalAccess;
      document.getElementById('portal-session-guard')?.remove();
    };
    script.onerror = () => block('Не удалось загрузить интерфейс. Повторите проверку.');
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
      if (response.status === 401) {
        accepted = null; block('Сессия завершена. Войдите снова.');
        localStorage.removeItem(tokenKey); localStorage.removeItem(userKey); window.location.replace('/login'); return;
      }
      if (!response.ok || !session?.user?.id || !Array.isArray(session.permissions) || !session.permissions.every((value) => typeof value === 'string')) throw new Error('session_unavailable');
      if (accepted && signature(accepted) !== signature(session) && loaded) { accepted = session; reload(); return; }
      install(session);
    } catch (_) {
      if (localStorage.getItem(tokenKey) === token && !reloading) block('Не удалось проверить доступ. Проверьте подключение и повторите попытку.');
    } finally { clearTimeout(timer); }
  }
  function refresh() {
    if (reloading) return Promise.resolve();
    if (!pending) pending = verify().finally(() => { pending = null; });
    return pending;
  }
  window.__portalSessionGate = { refresh, block, signature, canAccessRoute, canUseNavigation, get blocked() { return blocked; } };
  window.addEventListener('focus', () => refresh());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('storage', (event) => { if (event.key === tokenKey) reload(); });
  window.addEventListener('hashchange', (event) => {
    if (!accepted || reloading) return;
    if (!canAccessRoute(accepted, window.location.pathname, window.location.hash)) {
      block('Доступ к этому разделу ограничен. Владелец может изменить права вашей роли.', true);
      event.stopImmediatePropagation();
    } else if (blocked) { event.stopImmediatePropagation(); reload(); }
  });
  setInterval(() => { if (!document.hidden) refresh(); }, 30000);
  block();
  refresh();
})();
