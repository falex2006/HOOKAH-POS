// Shared notification UI for administrative pages and authorized staff-shell managers.
(() => {
  window.mountCrmNotifications = ({ user, permissions, api, bellHost }) => {
    const portalUser=user, portalPermissions=permissions;
  const role = portalUser.role;
  const hasNotificationPermission = (['owner', 'admin'].includes(role) && portalPermissions.has('finance_read') && portalPermissions.has('orders'))
    || (['owner', 'admin', 'manager'].includes(role) && portalPermissions.has('inventory_read'))
    || (['owner', 'admin', 'manager'].includes(role) && portalPermissions.has('orders'))
    || (['owner', 'admin'].includes(role) && (portalPermissions.has('staff_view') || portalPermissions.has('staff')))
    || (['owner', 'admin', 'manager'].includes(role) && ['floor','orders','finance_read'].some(p=>portalPermissions.has(p)));

    const attendanceTypes = new Set(['attendance_request','attendance_decision','attendance_expired','attendance_overdue','attendance_closed','attendance_warning']);
    const hasAttendancePermission = ['staff_attendance_self','staff_attendance_policy_manage','staff_attendance_approval','staff_attendance_close'].some(permission=>portalPermissions.has(permission));
    const attendanceOnly = hasAttendancePermission && !hasNotificationPermission;
    if(!bellHost||(!['owner','admin','manager','developer'].includes(role)&&!attendanceOnly)||(!hasNotificationPermission&&!attendanceOnly)){const bell=bellHost?.querySelector('#notification-bell');if(bell)bell.hidden=true;return {refresh:()=>{},dispose:()=>{}};}
    let disposed=false;
    const lifecycle=new AbortController();
    let interval;
    let notificationBell=bellHost.querySelector('#notification-bell');
    if(!notificationBell){notificationBell=document.createElement('button');notificationBell.type='button';notificationBell.id='notification-bell';notificationBell.className='notification-bell';notificationBell.innerHTML='<svg class="icon" aria-hidden="true"><use href="/assets/tabler-icons.svg#bell"></use></svg><span id="notification-count" hidden>0</span>';bellHost.prepend(notificationBell);}
    notificationBell.hidden=false;notificationBell.setAttribute('aria-label','Уведомления');notificationBell.title='Уведомления';
const notificationPanel = document.createElement('section');
notificationPanel.id = 'notification-panel';
notificationPanel.className = 'notification-panel';
notificationPanel.hidden = true;
notificationPanel.setAttribute('role', 'dialog');
notificationPanel.setAttribute('aria-labelledby', 'notification-panel-title');
notificationPanel.setAttribute('aria-modal', 'false');
notificationPanel.innerHTML = '<div class="notification-panel-card"><div class="notification-panel-head"><div><h2 id="notification-panel-title" tabindex="-1">Уведомления</h2><span class="notification-panel-count" id="notification-panel-count" aria-live="polite"></span></div><button class="notification-panel-close" type="button" aria-label="Закрыть уведомления">×</button></div><div class="notification-panel-toolbar"><div class="notification-filter" role="group" aria-label="Фильтр уведомлений"><button type="button" data-notification-filter="all" aria-pressed="true">Все</button><button type="button" data-notification-filter="unread" aria-pressed="false">Непрочитанные</button></div><button class="notification-read-all" type="button">Отметить все прочитанными</button></div><div class="notification-panel-content" id="notification-panel-content" aria-live="polite" aria-busy="false"></div></div>';
document.body.append(notificationPanel);
let notificationFilter = 'all';
let notificationData = { items: [], unreadCount: 0 };
let notificationBusy = false;
let notificationRefreshQueued = false;
const allowedNotificationHrefs = new Set(['/orders', '/inventory?view=auto-orders', '/admin', '/admin#shift-control', '/finance', '/admin#staff-attendance', '/#staff-attendance']);
const notificationContent = notificationPanel.querySelector('#notification-panel-content');
const notificationBadge = bellHost.querySelector('#notification-count');
const notificationCountLabel = notificationPanel.querySelector('#notification-panel-count');
const formatNotificationTime = (value) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date) : ''; };
const updateNotificationCount = (count) => {
  const value = Math.max(0, Number(count) || 0);
  if (notificationBadge) { notificationBadge.textContent = value > 99 ? '99+' : String(value); notificationBadge.hidden = value === 0; }
  if (notificationBell) { notificationBell.title = value ? `Непрочитанные уведомления: ${value}` : 'Уведомления'; notificationBell.setAttribute('aria-label', value ? `Уведомления, непрочитанных: ${value}` : 'Уведомления'); }
  if (notificationCountLabel) notificationCountLabel.textContent = value ? `${value} непрочитанных` : 'Все просмотрено';
  notificationPanel.querySelector('.notification-read-all').hidden = attendanceOnly || value === 0;
};
updateNotificationCount(0);
const renderNotificationState = (kind, message = '') => {
  notificationContent.replaceChildren(); notificationContent.setAttribute('aria-busy', kind === 'loading' ? 'true' : 'false');
  const state = document.createElement('div'); state.className = `notification-state notification-state-${kind}`;
  if (kind === 'error') { const text = document.createElement('p'); text.textContent = message || 'Не удалось загрузить уведомления.'; state.append(text); const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button small'; retry.textContent = 'Повторить'; retry.addEventListener('click', () => loadNotifications(true)); state.append(retry); }
  else state.textContent = kind === 'loading' ? 'Загружаем уведомления…' : (message || 'Пока нет уведомлений');
  notificationContent.append(state);
};
const renderNotifications = () => {
  const items = notificationData.items.filter((item) => (!attendanceOnly || attendanceTypes.has(item.type)) && (notificationFilter !== 'unread' || !item.readAt));
  notificationContent.replaceChildren(); notificationContent.setAttribute('aria-busy', 'false');
  if (!items.length) { renderNotificationState('empty', notificationFilter === 'unread' && notificationData.unreadCount === 0 ? 'Непрочитанных уведомлений нет' : 'Пока нет уведомлений'); return; }
  const list = document.createElement('ul'); list.className = 'notification-list';
  for (const item of items) {
    const row = document.createElement('li'); row.className = `notification-item${item.readAt ? '' : ' is-unread'}`;
    const copy = document.createElement('div'); copy.className = 'notification-item-copy';
    const title = document.createElement('b'); title.textContent = String(item.title || 'Уведомление'); copy.append(title);
    const summary = document.createElement('p'); summary.textContent = String(item.summary || ''); copy.append(summary);
    const meta = document.createElement('small'); meta.textContent = formatNotificationTime(item.createdAt); copy.append(meta); row.append(copy);
    const actions = document.createElement('div'); actions.className = 'notification-item-actions';
    const href = allowedNotificationHrefs.has(item.href) ? item.href : null;
    if (href && (!attendanceOnly || attendanceTypes.has(item.type))) { const open = document.createElement('a'); open.href = href; open.className = 'notification-open-link'; open.textContent = item.requiresAction ? 'Открыть запрос' : 'Открыть'; open.addEventListener('click', async (event) => { event.preventDefault(); try { if (!item.readAt) await setNotificationRead(item.id); const target = new URL(href, location.origin); if (target.pathname === location.pathname && target.hash === location.hash) { closeNotificationPanel(false); window.dispatchEvent(new CustomEvent(target.hash === '#staff-attendance' && target.pathname === '/' ? 'staff-attendance:open-self' : 'staff-attendance:open-management')); } else window.location.assign(href); } catch (_) { renderNotificationState('error', 'Не удалось сохранить прочтение. Повторите попытку.'); } }); actions.append(open); }
    if (!item.readAt) { const read = document.createElement('button'); read.type = 'button'; read.className = 'notification-mark-read'; read.textContent = 'Отметить прочитанным'; read.setAttribute('aria-label', `Отметить прочитанным: ${String(item.title || 'уведомление')}`); read.addEventListener('click', async () => { read.disabled = true; try { await setNotificationRead(item.id); } catch (_) { read.disabled = false; renderNotificationState('error', 'Не удалось сохранить прочтение. Повторите попытку.'); } }); actions.append(read); }
    row.append(actions); list.append(row);
  }
  notificationContent.append(list);
};
const loadNotifications = async (showLoading = false) => {
  if(disposed)return;
  if (notificationBusy) { notificationRefreshQueued = true; return; } notificationBusy = true; if (showLoading) renderNotificationState('loading');
  try { const data = await api(`/api/notifications?limit=20&filter=${notificationFilter}`,{signal:AbortSignal.any([lifecycle.signal,AbortSignal.timeout(15000)])}); if(disposed)return; const items=Array.isArray(data.items)?data.items:[]; notificationData = { items, unreadCount: Number(data.unreadCount || 0) }; updateNotificationCount(notificationData.unreadCount); if (!notificationPanel.hidden) renderNotifications(); }
  catch (error) {
    if(disposed)return;if(error.status===403||error.payload?.error==='forbidden'){dispose();return;}
    if (!notificationPanel.hidden) {
      if (notificationData.items.length) { renderNotifications(); const error = document.createElement('div'); error.className = 'notification-inline-error'; error.setAttribute('role', 'status'); error.textContent = 'Не удалось обновить. Нажмите, чтобы повторить.'; const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Повторить'; retry.addEventListener('click', () => loadNotifications(true)); error.append(retry); notificationContent.prepend(error); }
      else renderNotificationState('error');
    }
    if (notificationBell && notificationData.unreadCount === 0) notificationBell.title = 'Не удалось обновить уведомления';
  }
  finally { notificationBusy = false; if (!disposed && notificationRefreshQueued) { notificationRefreshQueued = false; loadNotifications(false); } }
};
const notificationChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('territory-crm-notifications') : null;
const setNotificationRead = async (id) => {
  const response = await api(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'PUT',signal:AbortSignal.any([lifecycle.signal,AbortSignal.timeout(15000)]) }); if(disposed)return;
  notificationData.items = notificationData.items.map((item) => item.id === id ? { ...item, readAt: response.readAt || new Date().toISOString() } : item);
  notificationData.unreadCount = Number(response.unreadCount ?? Math.max(0, notificationData.unreadCount - 1)); updateNotificationCount(notificationData.unreadCount); renderNotifications();
  notificationChannel?.postMessage({ type: 'read-state-changed' });
};
const closeNotificationPanel = (restoreFocus = true) => { notificationPanel.hidden = true; notificationBell?.setAttribute('aria-expanded', 'false'); notificationPanel.setAttribute('aria-modal', 'false'); document.body.classList.remove('notification-panel-open'); if (restoreFocus) notificationBell?.focus(); };
const openNotificationPanel = async () => {
  if (!notificationBell) return;
  window.HOOKAH_MANAGEMENT_THEME?.detach(notificationPanel);
  window.HOOKAH_MANAGEMENT_THEME?.attach(notificationPanel,window.HOOKAH_MANAGEMENT_THEME?.capture(notificationBell));
  notificationPanel.hidden = false; notificationBell.setAttribute('aria-expanded', 'true');
  const mobile = window.matchMedia('(max-width: 768px)').matches; notificationPanel.setAttribute('aria-modal', mobile ? 'true' : 'false'); document.body.classList.toggle('notification-panel-open', mobile);
  notificationPanel.querySelector('#notification-panel-title').focus(); await loadNotifications(true);
};
notificationPanel.querySelector('.notification-panel-close').addEventListener('click', () => closeNotificationPanel());
notificationPanel.querySelectorAll('[data-notification-filter]').forEach((button) => button.addEventListener('click', () => { notificationFilter = button.dataset.notificationFilter; notificationPanel.querySelectorAll('[data-notification-filter]').forEach((item) => item.setAttribute('aria-pressed', String(item === button))); renderNotifications(); loadNotifications(false); }));
notificationPanel.querySelector('.notification-read-all').addEventListener('click', async (event) => {
  const button = event.currentTarget; button.disabled = true;
  try { const result = await api('/api/notifications', { method: 'POST',signal:AbortSignal.any([lifecycle.signal,AbortSignal.timeout(15000)]) }); if(disposed)return; notificationData.items = notificationData.items.map((item) => ({ ...item, readAt: item.readAt || new Date().toISOString() })); notificationData.unreadCount = Number(result.unreadCount || 0); updateNotificationCount(notificationData.unreadCount); renderNotifications(); notificationChannel?.postMessage({ type: 'read-state-changed' }); }
  catch (_) { renderNotificationState('error', 'Не удалось отметить уведомления прочитанными.'); } finally { button.disabled = false; }
});
notificationBell?.setAttribute('aria-controls', 'notification-panel'); notificationBell?.setAttribute('aria-expanded', 'false'); notificationBell?.addEventListener('click', () => notificationPanel.hidden ? openNotificationPanel() : closeNotificationPanel(false));
document.addEventListener('pointerdown', (event) => { if (!notificationPanel.hidden && !notificationPanel.contains(event.target) && !notificationBell?.contains(event.target)) closeNotificationPanel(false); },{signal:lifecycle.signal});
document.addEventListener('keydown', (event) => {
  if (notificationPanel.hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); closeNotificationPanel(); return; }
  if (event.key === 'Tab' && window.matchMedia('(max-width: 768px)').matches) { const controls = [...notificationPanel.querySelectorAll('button:not(:disabled):not([hidden]), a[href]')].filter((node) => node.getClientRects().length); if (!controls.length) return; const first = controls[0], last = controls[controls.length - 1], heading = notificationPanel.querySelector('#notification-panel-title'); if (event.shiftKey && (document.activeElement === first || document.activeElement === heading || document.activeElement === notificationPanel)) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === heading)) { event.preventDefault(); first.focus(); } }
},{signal:lifecycle.signal});
notificationChannel?.addEventListener('message', () => { if (document.visibilityState === 'visible') loadNotifications(!notificationPanel.hidden); });
window.addEventListener('staff-attendance:changed',()=>{if(document.visibilityState==='visible')loadNotifications(false);},{signal:lifecycle.signal});
const refreshLeaderNotifications = () => {if(!disposed&&document.visibilityState==='visible')loadNotifications(false);};
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadNotifications(false); },{signal:lifecycle.signal});

    const dispose=()=>{if(disposed)return;disposed=true;clearInterval(interval);lifecycle.abort();notificationChannel?.close();closeNotificationPanel(false);notificationPanel.remove();notificationBell.hidden=true;};
    window.addEventListener('pagehide',event=>{if(!event.persisted)dispose();},{signal:lifecycle.signal});
    interval=window.setInterval(refreshLeaderNotifications,20000);
    return {refresh:refreshLeaderNotifications,dispose};
  };
})();
