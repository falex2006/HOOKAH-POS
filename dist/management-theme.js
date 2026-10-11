/* Management presentation only: verified session authority stays in portal-session.js. */
(() => {
  'use strict';
  if (window.HOOKAH_MANAGEMENT_THEME) return;
  const marker = 'data-management-theme';
  const schemeMarker = 'data-management-scheme';
  const roles = new Set(['owner', 'admin', 'manager']);
  const adminHashes = new Set(['', '#tasks', '#loyalty', '#settings', '#company', '#settings-dashboard-modules', '#lock-security', '#audit', '#diagnostics', '#notifications', '#help', '#shift-control']);
  const inventoryViews = new Set(['stock', 'products', 'recipes', 'auto-orders', 'movements', 'premixes', 'directories']);
  const pages = new Set(['/admin', '/inventory', '/finance', '/finance/report', '/finance/categories', '/orders', '/clients', '/reservations', '/delivery', '/integrations', '/network']);
  // renderDashboard creates the floor editor even when it is hidden. Exclusion
  // is structural, independent of visibility and the currently focused hash.
  const excluded = ['#staff', '#permissions', '[data-staff-section]', '#floor-editor', '.floor-editor-panel', '#venue-layout-settings', '.venue-layout-settings', '.company-layout-note', '.staff-profile-modal', '.staff-drawer', '.screen-lock-overlay', '.lock-settings-dialog', '[data-management-exclude]', '[data-floor-dialog]', '[data-table-dialog]'].join(',');
  const forbiddenOrigin = `${excluded},#lock-screen-button,.lock-settings-button,.header-user,.sidebar-profile`;
  const unclassifiedOverlay = '.modal,.ui-modal,[data-ui-dialog],dialog,.notification-panel,.ui-feedback,#portal-notice';
  const panelExcluded = `${excluded},${unclassifiedOverlay}`;
  const marked = new Set();
  const owned = new Map();
  const tickets = new WeakSet();
  const sessionTokens = new WeakMap();
  let contextKey = '';
  let generation = 0;
  let queued = false;

  function normalizePath(path) {
    const normalized = path.replace(/\.html$/, '').replace(/\/$/, '') || '/';
    return ({ '/finance-report': '/finance/report', '/finance-categories': '/finance/categories' })[normalized] || normalized;
  }
  function resolve() {
    const session = window.__portalSessionVerified;
    const gate = window.__portalSessionGate;
    if (!session || session.demo || !session.user?.id || !roles.has(session.user.role) || !Array.isArray(session.permissions) || !gate || gate.blocked || document.documentElement.hasAttribute('data-portal-access') || document.body?.classList.contains('screen-locked')) return null;
    let token;
    try { token = localStorage.getItem('crm_session_token'); } catch (_) { return null; }
    if (!token || token.startsWith('demo-static-')) return null;
    if (!sessionTokens.has(session)) sessionTokens.set(session, token);
    if (sessionTokens.get(session) !== token) return null;
    const url = new URL(window.location.href);
    const path = normalizePath(url.pathname);
    if (!pages.has(path)) return null;
    // Presentation parameters never confer management authority.
    if (url.searchParams.has('operator') || url.searchParams.has('mode')) return null;
    if (path === '/admin' && !adminHashes.has(url.hash)) return null;
    if (path === '/inventory' && (url.hash || !inventoryViews.has(url.searchParams.get('view') || 'stock'))) return null;
    if (path === '/finance' && !['', '#payroll'].includes(url.hash)) return null;
    if (!['/admin', '/inventory', '/finance'].includes(path) && url.hash) return null;
    if (path !== '/inventory' && url.searchParams.has('view')) return null;
    if (path === '/admin' && url.hash === '#diagnostics' && !['owner', 'admin'].includes(session.user.role)) return null;
    try {
      if (!gate.canAccessRoute(session, path, url.hash)) return null;
      return { key: JSON.stringify([gate.signature(session), url.pathname, url.search, url.hash]), session };
    } catch (_) { return null; }
  }
  function unmark(node) {
    node.removeAttribute(marker);
    node.removeAttribute(schemeMarker);
    marked.delete(node);
  }
  function clear() {
    generation++;
    contextKey = '';
    for (const node of marked) unmark(node);
    owned.clear();
  }
  function mark(node) {
    if (!node || !node.isConnected || node.matches('html,body') || node.closest(excluded)) return;
    if (node.getAttribute(marker) !== 'mt') node.setAttribute(marker, 'mt');
    const scheme = document.documentElement.dataset.theme === 'light' || document.body.classList.contains('light-theme') ? 'light' : 'dark';
    if (node.getAttribute(schemeMarker) !== scheme) node.setAttribute(schemeMarker, scheme);
    marked.add(node);
  }
  function panelScopes(node, next) {
    if (node.matches(panelExcluded)) return;
    // Mixed company/dashboard markup may contain excluded panels. No inherited
    // tokens or root selector may cross those branches.
    if (node.querySelector(panelExcluded)) {
      for (const child of node.children) panelScopes(child, next);
    } else if (!node.matches('script,style,link,template')) next.add(node);
  }
  function refresh() {
    const context = resolve();
    if (!context) { if (contextKey || marked.size || owned.size) clear(); return false; }
    if (contextKey && contextKey !== context.key) clear();
    contextKey = context.key;
    const next = new Set();
    document.querySelectorAll('.portal-sidebar').forEach(node => next.add(node));
    const content = document.getElementById('page-content');
    if (content) panelScopes(content, next);
    for (const [node, ticket] of owned) {
      if (!node.isConnected || ticket.generation !== generation || ticket.key !== contextKey || node.closest(excluded) || node.querySelector(excluded)) { owned.delete(node); continue; }
      next.add(node);
    }
    for (const node of marked) if (!next.has(node)) unmark(node);
    for (const node of next) mark(node);
    return true;
  }
  function capture(origin) {
    if (!refresh() || !(origin instanceof Element) || !origin.isConnected || origin.closest(forbiddenOrigin)) return null;
    const scope = origin.closest(`[${marker}="mt"]`);
    // Notification provenance does not require styling the existing header.
    const headerBell = origin.matches('#notification-bell') && origin.closest('.portal-header') && !origin.matches(':disabled') && origin.getClientRects().length > 0;
    if ((!scope || !marked.has(scope)) && !headerBell) return null;
    const ticket = Object.freeze({ key: contextKey, generation });
    tickets.add(ticket);
    return ticket;
  }
  function attach(node, ticket) {
    if (!(node instanceof Element) || !ticket || !tickets.has(ticket) || !refresh() || ticket.key !== contextKey || ticket.generation !== generation || node.matches('html,body,main,.portal-main,#page-content,.portal-header') || node.closest('.portal-header') || node.closest(excluded) || node.querySelector(excluded)) {
      if (node instanceof Element && marked.has(node)) { owned.delete(node); unmark(node); }
      return false;
    }
    owned.set(node, ticket);
    if (node.isConnected) mark(node);
    return true;
  }
  function detach(node) { owned.delete(node); if (node instanceof Element && marked.has(node)) unmark(node); }
  function schedule() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; refresh(); });
  }
  function transition() { clear(); schedule(); }
  window.HOOKAH_MANAGEMENT_THEME = Object.freeze({ refresh, clear, capture, attach, detach });
  // Capture precedes the session guard's bubbling listener, which may stop
  // propagation on denied hash transitions. Old overlay provenance is revoked.
  window.addEventListener('hashchange', transition, true);
  window.addEventListener('popstate', transition, true);
  window.addEventListener('pageshow', transition, true);
  window.addEventListener('pagehide', clear, true);
  window.addEventListener('storage', event => { if (['crm_session_token', 'crm_session_user', null].includes(event.key)) transition(); }, true);
  window.addEventListener('focus', schedule, true);
  document.addEventListener('visibilitychange', schedule, true);
  document.addEventListener('management-theme-context-change', transition);
  // Detect programmatic history transitions without changing routing behavior.
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const before = window.location.href;
      const result = original.apply(this, args);
      if (window.location.href !== before) transition();
      return result;
    };
  }
  function start() {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-portal-access', 'data-theme', 'hidden', 'data-management-exclude'] });
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
