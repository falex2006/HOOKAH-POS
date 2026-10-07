if (!localStorage.getItem('crm_session_token')) { window.location.replace('/login'); throw new Error('authentication_required'); }
const desktopPreviewParam = new URLSearchParams(window.location.search).get('desktop');
const desktopPreview = desktopPreviewParam === '1' || (desktopPreviewParam !== '0' && localStorage.getItem('hookah_pos_desktop_preview') === '1');
if (desktopPreview) document.documentElement.classList.add('desktop-preview');
let portalUser = {};
try { portalUser = JSON.parse(localStorage.getItem('crm_session_user') || '{}'); if (!['owner', 'admin', 'developer', 'manager', 'bartender', 'hookah_master', 'senior_bartender', 'senior_hookah_master', 'cleaner', 'security', 'technician', 'other_staff', 'staff'].includes(portalUser.role)) { window.location.replace('/'); throw new Error('portal_permission_required'); }  } catch (error) { if (error.message === 'portal_permission_required' || error.message === 'developer_dashboard_redirect') throw error; }
const compressUploadedImage = (file, maxSide = 256, maxInputPixels = Infinity) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = reject; reader.onload = () => { const image = new Image(); image.onerror = reject; image.onload = () => { const sourceWidth = image.naturalWidth || image.width; const sourceHeight = image.naturalHeight || image.height; if (sourceWidth * sourceHeight > maxInputPixels) { reject(new Error('image_too_large')); return; } const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight)); const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(sourceWidth * scale)); canvas.height = Math.max(1, Math.round(sourceHeight * scale)); const context = canvas.getContext('2d'); if (!context) { reject(new Error('image_processing_unavailable')); return; } context.drawImage(image, 0, 0, canvas.width, canvas.height); resolve(canvas.toDataURL('image/webp', 0.78)); }; image.src = String(reader.result || ''); }; reader.readAsDataURL(file); });
const themeIdentity = String(portalUser.id || portalUser.login || portalUser.name || portalUser.role || 'user').toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, '_');const russianTimezoneOptions = () => [['Europe/Kaliningrad','Калининградская область (UTC+02:00)'],['Europe/Moscow','Москва, Санкт-Петербург, Центральная Россия (UTC+03:00)'],['Europe/Samara','Самарская область, Удмуртия, Саратовская область (UTC+04:00)'],['Asia/Yekaterinburg','Свердловская, Тюменская, Челябинская области, Пермский край (UTC+05:00)'],['Asia/Omsk','Омская область (UTC+06:00)'],['Asia/Novosibirsk','Новосибирская, Томская, Кемеровская области (UTC+07:00)'],['Asia/Krasnoyarsk','Красноярский край, Хакасия, Тыва (UTC+07:00)'],['Asia/Irkutsk','Иркутская область, Бурятия (UTC+08:00)'],['Asia/Chita','Забайкальский край (UTC+09:00)'],['Asia/Yakutsk','Якутия (UTC+09:00)'],['Asia/Vladivostok','Приморский и Хабаровский края (UTC+10:00)'],['Asia/Magadan','Магаданская область, Сахалин (UTC+11:00)'],['Asia/Anadyr','Чукотский автономный округ (UTC+12:00)'],['Asia/Kamchatka','Камчатский край (UTC+12:00)']].map(([value,label]) => `<option value="${value}">${label}</option>`).join('');
const themeStorageKey = `crm_theme_${themeIdentity}`;
const applyPortalTheme = (theme) => { const selected = theme === 'light' ? 'light' : 'dark'; document.body.classList.toggle('light-theme', selected === 'light'); document.documentElement.dataset.theme = selected; return selected; };
let portalTheme = 'dark';
try { portalTheme = applyPortalTheme(localStorage.getItem(themeStorageKey) || 'dark'); } catch (_) { portalTheme = applyPortalTheme('dark'); }
const portalRoleLabels = { owner: ['Владелец заведения', 'Полный доступ к заведению и сотрудникам'], admin: ['Администратор', 'Владелец заведения'], developer: ['Разработчик', 'Полный доступ к CRM'], manager: ['Управляющий', 'Операционное управление'], bartender: ['Бармен', 'Работа с заказами и гостями'], hookah_master: ['Кальянщик', 'Работа с заказами и гостями'], staff: ['Сотрудник', 'Работа с гостями'] };
Object.assign(portalRoleLabels, { senior_bartender: ['Старший бармен', 'Работа с заказами и гостями'], senior_hookah_master: ['Старший кальянщик', 'Работа с заказами и гостями'], cleaner: ['Уборщица / уборщик', 'Рабочие поручения'], security: ['Охрана', 'Рабочие поручения'], technician: ['Техник', 'Рабочие поручения'], other_staff: ['Другая должность', 'Рабочие поручения'] });
const portalRole = portalRoleLabels[portalUser.role] || ['Пользователь', 'Ограниченный доступ'];
const localDateKey = (value = new Date()) => { const raw = String(value || ''); if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw; const date = value instanceof Date ? value : new Date(value); if (Number.isNaN(date.getTime())) return raw.slice(0, 10); return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'); };
function getDashboardGreetingForHour(hour) { const value = Number(hour); if (!Number.isInteger(value) || value < 0 || value > 23) return 'Здравствуйте'; if (value >= 5 && value < 12) return 'Доброе утро'; if (value >= 12 && value < 18) return 'Добрый день'; if (value >= 18 && value < 22) return 'Добрый вечер'; return 'Доброй ночи'; }
function getVenueLocalHour(date, timezone) { if (!timezone) return null; try { const part = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).formatToParts(date).find((item) => item.type === 'hour'); const hour = Number(part?.value); return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null; } catch (_) { return null; } }
let venueTimezone = String(portalUser.timezone || '');
let dashboardGreetingTimer = null;
function updateDashboardGreeting() { /* Dashboard keeps a stable title; no recurring greeting. */ }
const adminSectionTitles = { '#staff': 'Персонал', '#permissions': 'Роли и права доступа', '#tasks': 'Задачи', '#loyalty': 'Лояльность', '#shift-control': 'Контроль смены', '#settings': 'Настройки', '#company': 'Настройки', '#settings-dashboard-modules': 'Настройки', '#venue-layout-settings': 'Залы и рабочая зона', '#lock-security': 'Безопасность', '#audit': 'Журнал действий', '#diagnostics': 'Диагностика', '#notifications': 'Уведомления', '#help': 'База знаний' };
function updateAdminSectionTitle() { const title = document.querySelector('[data-admin-section-title]'); if (title) title.textContent = adminSectionTitles[window.location.hash] || 'Главная'; if (document.body?.dataset.page === 'dashboard') document.title = `Hookah POS — ${adminSectionTitles[window.location.hash] || 'Главная'}`; }
window.addEventListener('hashchange', updateAdminSectionTitle);
updateAdminSectionTitle();
const recipeOutputUnits = new Set(['г', 'кг', 'мл', 'л', 'шт', 'порция', 'уп', 'упаковка']);
const normalizeDemoRecipeOutput = (input = {}, previous = {}) => { const quantity = Number(String(input.yieldQuantity ?? input.yield ?? previous.yieldQuantity ?? '').replace(',', '.')); const unit = String(input.yieldUnit ?? previous.yieldUnit ?? '').trim().toLocaleLowerCase('ru-RU'); const portions = Number(input.portionCount ?? input.portions ?? previous.portionCount); if (!Number.isFinite(quantity) || quantity <= 0 || !recipeOutputUnits.has(unit)) throw new Error('invalid_recipe_output'); if (!Number.isInteger(portions) || portions < 1) throw new Error('invalid_recipe_output'); return { yieldQuantity: Number(quantity.toFixed(6)), yieldUnit: unit, portionCount: portions }; };
const portalPermissionScopes = ['orders', 'reservations', 'inventory', 'inventory_categories', 'finance', 'finance_read', 'staff', 'delivery', 'integrations', 'settings', 'loyalty'];
const portalScopedPermissionMap = { loyalty: ['loyalty'], orders: ['orders', 'floor'], reservations: ['reservations'], inventory: ['inventory', 'inventory_read'], inventory_categories: ['inventory_categories', 'inventory_read'], finance: ['finance', 'finance_read'], finance_read: ['finance_read'], staff: ['staff', 'staff_manage', 'staff_view', 'staff_sensitive', 'tasks_manage'], delivery: ['delivery'], integrations: ['integrations'], settings: ['settings'] };
const portalBasePermissions = {
  owner: new Set(['dashboard', 'floor', 'loyalty', 'orders', 'reservations', 'inventory', 'inventory_read', 'finance', 'finance_read', 'staff', 'staff_manage', 'staff_view', 'staff_sensitive', 'tasks_manage', 'settings', 'diagnostics', 'integrations', 'delivery']),
  admin: new Set(['dashboard', 'floor', 'loyalty', 'orders', 'reservations', 'inventory', 'inventory_read', 'finance', 'finance_read', 'staff', 'staff_manage', 'staff_view', 'staff_sensitive', 'tasks_manage', 'settings', 'diagnostics', 'integrations', 'delivery']),
  manager: new Set(['dashboard', 'floor', 'orders', 'reservations', 'inventory_read', 'finance_read', 'staff_view', 'tasks_manage', 'settings', 'loyalty']),
  bartender: new Set(['dashboard', 'floor', 'orders', 'bar_tasks', 'finance_read']),
  hookah_master: new Set(['dashboard', 'floor', 'orders', 'hookah_tasks', 'finance_read']),
  senior_bartender: new Set(['dashboard', 'floor', 'orders', 'bar_tasks', 'finance_read']),
  senior_hookah_master: new Set(['dashboard', 'floor', 'orders', 'hookah_tasks', 'finance_read']),
  cleaner: new Set(['dashboard', 'floor', 'orders', 'finance_read']),
  security: new Set(['dashboard', 'floor', 'orders', 'finance_read']),
  technician: new Set(['dashboard', 'floor', 'orders', 'finance_read']),
  other_staff: new Set(['dashboard', 'floor', 'orders', 'finance_read']),
  staff: new Set(['dashboard', 'floor', 'orders', 'finance_read', 'staff_view']),
  developer: new Set(['dashboard', 'floor', 'orders', 'reservations', 'inventory_read', 'finance_read', 'staff', 'staff_manage', 'staff_view', 'tasks_manage', 'settings', 'diagnostics', 'integrations', 'delivery'])
}[portalUser.role] || new Set();
const portalPermissions = new Set(portalBasePermissions); window.portalPermissions = portalPermissions;
const portalScopes = Array.isArray(portalUser.permissionScopes) ? [...new Set(portalUser.permissionScopes.filter((scope) => portalPermissionScopes.includes(scope)))] : [];
if (portalScopes.length) { portalScopes.flatMap((scope) => portalScopedPermissionMap[scope] || []).forEach((permission) => portalPermissions.add(permission)); }
const operationsNav = document.querySelectorAll('.portal-nav')[1];
if (operationsNav) {
  const sharedLinks = [
    ['/orders', 'orders', 'Заказы', 'clipboard-list'],
    ['/clients', 'orders', 'Гости', 'users'],
    ['/delivery', 'delivery', 'Доставка', 'truck-delivery'],
  ];
  sharedLinks.forEach(([href, permission, label, iconName]) => {
    if (operationsNav.querySelector(`a[href="${href}"]`)) return;
    const link = document.createElement('a'); link.href = href; link.dataset.permission = permission;
    link.innerHTML = `<svg class="icon" aria-hidden="true"><use href="/assets/tabler-icons.svg#${iconName}"></use></svg><span>${label}</span>`;
    operationsNav.append(link);
  });
}
const administrationNav = document.querySelector('.portal-nav.staff-nav');
if (administrationNav && !administrationNav.querySelector('a[href="/integrations"]')) {
  const link = document.createElement('a'); link.href = '/integrations'; link.dataset.permission = 'integrations';
  link.innerHTML = '<svg class="icon" aria-hidden="true"><use href="/assets/tabler-icons.svg#plug"></use></svg><span>Интеграции</span>';
  administrationNav.append(link);
}
const adminNavigationAllowed = ['owner', 'admin', 'developer', 'manager'].includes(portalUser.role);
// Keep the sidebar structure identical on every management page.
const normalizeManagementSidebar = ({ routeChange = false } = {}) => {
  document.querySelectorAll('a[href="/finance#discounts"]').forEach((link) => link.remove());
  const sidebar = document.querySelector('.portal-sidebar');
  if (!sidebar) return;
  sidebar.querySelectorAll(':scope > .side-label').forEach((node) => { if (node.textContent.trim().toLocaleLowerCase('ru-RU') === 'главное') node.remove(); });
  const iconMarkup = (name) => `<svg class="icon" aria-hidden="true"><use href="/assets/tabler-icons.svg?rev=5#${name}"></use></svg>`;
  if (!document.querySelector('.sidebar-mobile-toggle')) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'sidebar-mobile-toggle';
    toggle.setAttribute('aria-label', 'Открыть меню');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = `${iconMarkup('menu-2')}<span>Меню</span>`;
    sidebar.parentElement?.insertBefore(toggle, sidebar);
    if (!sidebar.id) sidebar.id = 'primary-navigation';
    toggle.setAttribute('aria-controls', sidebar.id);
    let backdrop = document.querySelector('.sidebar-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'sidebar-backdrop';
      backdrop.setAttribute('aria-hidden', 'true');
      backdrop.hidden = true;
      document.body.append(backdrop);
    }
    const main = sidebar.parentElement?.querySelector(':scope > .portal-main');
    const isDrawerViewport = () => window.matchMedia('(max-width: 900px)').matches;
    const focusableInDrawer = () => [toggle, ...sidebar.querySelectorAll('a[href],button:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')]
      .filter((node) => !node.hidden && node.getAttribute('aria-hidden') !== 'true' && node.getClientRects().length > 0);
    const syncToggle = (expanded, { restoreFocus = false } = {}) => {
      sidebar.classList.toggle('is-expanded', expanded);
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.setAttribute('aria-label', expanded ? 'Закрыть меню' : 'Открыть меню');
      toggle.innerHTML = `${iconMarkup(expanded ? 'x' : 'menu-2')}<span>Меню</span>`;
      const modalOpen = expanded && isDrawerViewport();
      backdrop.hidden = !modalOpen;
      document.body.classList.toggle('sidebar-drawer-open', modalOpen);
      if (main) {
        main.inert = modalOpen;
        if (modalOpen) main.setAttribute('aria-hidden', 'true');
        else main.removeAttribute('aria-hidden');
      }
      const hiddenDrawer = isDrawerViewport() && !expanded;
      sidebar.inert = hiddenDrawer;
      if (hiddenDrawer) sidebar.setAttribute('aria-hidden', 'true');
      else sidebar.removeAttribute('aria-hidden');
      if (!expanded && restoreFocus && toggle.getClientRects().length > 0) toggle.focus({ preventScroll: true });
    };
    toggle.addEventListener('click', () => {
      const opening = !sidebar.classList.contains('is-expanded');
      syncToggle(opening);
      if (opening && isDrawerViewport()) requestAnimationFrame(() => focusableInDrawer()[1]?.focus({ preventScroll: true }));
    });
    backdrop.addEventListener('click', () => syncToggle(false, { restoreFocus: true }));
    document.addEventListener('keydown', (event) => {
      if (!sidebar.classList.contains('is-expanded')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        syncToggle(false, { restoreFocus: true });
        return;
      }
      if (event.key !== 'Tab' || !isDrawerViewport()) return;
      const focusable = focusableInDrawer();
      if (!focusable.length) { event.preventDefault(); toggle.focus({ preventScroll: true }); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || (!sidebar.contains(document.activeElement) && document.activeElement !== toggle))) {
        event.preventDefault(); first.focus();
      }
    });
    sidebar.addEventListener('click', (event) => {
      if (event.target.closest('.portal-nav a') && sidebar.classList.contains('is-expanded')) syncToggle(false);
    });
    window.addEventListener('orientationchange', () => {
      if (sidebar.classList.contains('is-expanded')) syncToggle(false, { restoreFocus: true });
    });
    let drawerBreakpoint = isDrawerViewport();
    window.addEventListener('resize', () => {
      const nextBreakpoint = isDrawerViewport();
      if (nextBreakpoint !== drawerBreakpoint) {
        drawerBreakpoint = nextBreakpoint;
        if (sidebar.classList.contains('is-expanded')) syncToggle(false, { restoreFocus: true });
      }
    });
    syncToggle(false);
  }
  sidebar.querySelectorAll('.portal-nav:not(.staff-nav) a[href="/integrations"]').forEach((link) => link.remove());
  const makeLink = ({ href, permission, label, iconName, navigationModule }) => {
    const link = document.createElement('a');
    const targetUrl = new URL(href, location.origin);
    if (targetUrl.pathname === '/inventory') {
      const currentUrl = new URL(location.href);
      currentUrl.searchParams.forEach((value, key) => { if (!['view', 'mode', 'operator'].includes(key) && !targetUrl.searchParams.has(key)) targetUrl.searchParams.set(key, value); });
    }
    link.href = targetUrl.pathname + targetUrl.search + targetUrl.hash; link.dataset.permission = permission; if (navigationModule) link.dataset.navigationModule = navigationModule; link.hidden = !portalPermissions.has(permission); link.innerHTML = `${iconMarkup(iconName)}<span>${label}</span>`; return link;
  };
  // Include nav blocks inside disclosure groups so hash-based re-renders do
  // not create duplicate operation/control menus after the first grouping pass.
  const navs = [...sidebar.querySelectorAll('.portal-nav')];
  const mainNav = navs.find((nav) => nav.querySelector('a[href="/admin"]')) || navs[0];
  if (!mainNav) return;
  let operations = navs.find((nav) => nav !== mainNav && [...nav.querySelectorAll('a')].some((a) => ['/orders','/clients','/reservations','/delivery','/'].includes(a.getAttribute('href'))));
  if (!operations) { operations = document.createElement('nav'); operations.className = 'portal-nav'; mainNav.after(operations); }
  // Older static pages used `/` for the work panel. Remove that stale entry so
  // the sidebar cannot show two work-panel links with different modes.
  operations.querySelectorAll('a[href="/"]').forEach((link) => link.remove());
  operations.querySelectorAll('a[href^="/?mode="]').forEach((link) => link.remove());
  const operationLinks = [
    { href: '/', permission: 'floor', label: 'Зал', iconName: 'table-layout' },
    { href: '/orders', permission: 'orders', label: 'Журнал заказов', iconName: 'receipt' },
    { href: '/reservations', permission: 'reservations', label: 'Бронирования', iconName: 'calendar-event' },
    { href: '/clients', permission: 'staff_view', label: 'Гости', iconName: 'users' },
    { href: '/delivery', permission: 'delivery', label: 'Доставка', iconName: 'truck-delivery' },
  ];
  operationLinks.forEach((item) => {
    let link = operations.querySelector(`a[href="${item.href}"]`);
    if (!link) { link = makeLink(item); operations.append(link); }
    else { link.dataset.permission = item.permission; link.innerHTML = `${iconMarkup(item.iconName)}<span>${item.label}</span>`; }
  });
  operationLinks.forEach((item) => { const link = operations.querySelector(`a[href="${item.href}"]`); if (link) operations.append(link); });
  let control = navs.find((nav) => nav !== mainNav && nav !== operations && [...nav.querySelectorAll('a')].some((a) => ['/inventory','/finance'].includes(a.getAttribute('href'))));
  if (!control) { control = document.createElement('nav'); control.className = 'portal-nav'; operations.after(control); }
  control.querySelectorAll('a[href="/inventory"],a[href^="/inventory?"],a[href^="/finance/report"],a[href^="/finance/categories"]').forEach((link) => link.remove());
  const groupStorageKey = (key) => `crm_sidebar_group_${String(portalUser.id || portalUser.login || portalUser.role || 'user')}_${key}`;
  const currentUrl = new URL(location.href);
  const currentPath = currentUrl.pathname;
  const currentHash = currentUrl.hash;
  const currentView = currentUrl.searchParams.get('view') || 'stock';
  const initialDocumentReload = (() => { try { return performance.getEntriesByType('navigation')[0]?.type === 'reload'; } catch (_) { return false; } })();
  const defaultGroupOpen = (key) => {
    if (key === 'operations') return ['/', '/orders', '/reservations', '/clients', '/delivery'].includes(currentPath);
    if (key === 'menu') return currentPath === '/inventory' && ['products', 'recipes'].includes(currentView);
    if (key === 'inventory') return currentPath === '/inventory' && !['products', 'recipes'].includes(currentView);
    if (key === 'finance') return ['/finance', '/finance/report', '/finance/categories'].includes(currentPath);
    if (key === 'team') return currentPath === '/admin' && ['#staff', '#tasks', '#permissions'].includes(currentHash);
    if (key === 'system') return currentPath === '/integrations' || currentPath === '/network' || (currentPath === '/admin' && !['', '#staff', '#tasks', '#permissions'].includes(currentHash));
    return false;
  };
  const savedGroupState = (key) => { try { const value = localStorage.getItem(groupStorageKey(key)); return value === null ? null : value === 'open'; } catch (_) { return null; } };
  const revealActiveSidebarLink = (details) => {
    const activeLink = details.querySelector('a.active');
    const scroller = details.closest('.sidebar-nav-groups');
    const target = details.open ? activeLink : details.querySelector(':scope > summary');
    if (!activeLink || !target || !scroller || !target.getClientRects().length) return;
    const linkRect = target.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const inset = 8;
    if (linkRect.top < scrollerRect.top + inset) scroller.scrollTop -= scrollerRect.top + inset - linkRect.top;
    else if (linkRect.bottom > scrollerRect.bottom - inset) scroller.scrollTop += linkRect.bottom - scrollerRect.bottom + inset;
  };
  const rememberGroupState = (details, key) => {
    const summary = details.querySelector(':scope > summary');
    if (summary) {
      summary.setAttribute('aria-expanded', String(details.open));
      summary.addEventListener('click', () => { details.dataset.userToggle = 'true'; if (!details.open) sidebar.querySelectorAll('details.sidebar-nav-group[data-nav-group]').forEach((sibling) => { if (sibling !== details && !sibling.hidden) sibling.open = false; }); });
    }
    details.addEventListener('toggle', () => {
      summary?.setAttribute('aria-expanded', String(details.open));
      requestAnimationFrame(() => revealActiveSidebarLink(details));
      if (details.dataset.userToggle !== 'true') return;
      delete details.dataset.userToggle;
      try { localStorage.setItem(groupStorageKey(key), details.open ? 'open' : 'closed'); } catch (_) {}
    });
  };
  const ensureAreaGroup = (key, label, iconName, items) => {
    let details = sidebar.querySelector(`details.sidebar-nav-group[data-nav-group="${key}"]`);
    if (!details) {
      details = document.createElement('details'); details.className = 'sidebar-nav-group'; details.dataset.navGroup = key;
      const summary = document.createElement('summary'); summary.setAttribute('aria-label', label); summary.title = label;
      summary.innerHTML = `${iconMarkup(iconName)}<span>${label}</span>`;
      const nav = document.createElement('nav'); nav.className = 'portal-nav';
      details.append(summary, nav); rememberGroupState(details, key);
    }
    const nav = details.querySelector('.portal-nav');
    nav.replaceChildren(...items.map((item) => makeLink(item)));
    details.hidden = !items.some((item) => portalPermissions.has(item.permission));
    details.open = savedGroupState(key) ?? defaultGroupOpen(key);
    return details;
  };
  const menuGroup = ensureAreaGroup('menu', 'Меню', 'layout-grid', [
    { href: '/inventory?view=products', permission: 'inventory_read', label: 'Каталог товаров', iconName: 'layout-grid' },
    { href: '/inventory?view=recipes', permission: 'inventory_read', label: 'Технологические карты', iconName: 'clipboard-list' },
  ]);
  const inventoryGroup = ensureAreaGroup('inventory', 'Склад', 'package', [
    { href: '/inventory?view=stock', permission: 'inventory_read', label: 'Остатки', iconName: 'package', navigationModule: 'inventory' },
    { href: '/inventory?view=auto-orders', permission: 'inventory_read', label: 'Пополнение запасов', iconName: 'alert-triangle', navigationModule: 'inventory' },
    { href: '/inventory?view=movements', permission: 'inventory_read', label: 'Поставки и списания', iconName: 'truck-delivery', navigationModule: 'inventory' },
    { href: '/inventory?view=premixes', permission: 'inventory_read', label: 'Заготовки и премиксы', iconName: 'flask', navigationModule: 'inventory' },
    { href: '/inventory?view=directories', permission: 'inventory_read', label: 'Цеха и категории', iconName: 'building', navigationModule: 'inventory' },
  ]);
  const financeGroup = ensureAreaGroup('finance', 'Финансы', 'chart-bar', [
    { href: '/finance', permission: 'finance_read', label: 'Обзор финансов', iconName: 'chart-bar', navigationModule: 'finance' },
    { href: '/finance#payroll', permission: 'finance_read', label: 'Зарплата', iconName: 'receipt-2', navigationModule: 'finance' },
    { href: '/finance/report', permission: 'finance_read', label: 'Отчёты', iconName: 'receipt', navigationModule: 'finance' },
    { href: '/finance/categories', permission: 'finance', label: 'Категории доходов и расходов', iconName: 'cash', navigationModule: 'finance' },
  ]);
  // Finance navigation is always rendered from one canonical list. Older
  // templates may contain a flat finance nav with a different subset.
  if (control !== financeGroup.querySelector('.portal-nav')) {
    const controlLabel = control.previousElementSibling;
    if (controlLabel?.classList.contains('side-label') && controlLabel.textContent.trim() === 'КОНТРОЛЬ') controlLabel.remove();
    control.remove();
  }
  // Daily operational destinations share one disclosure. Keep “Главное” visible.
  [['Операции', 'operations']].forEach(([labelText, key]) => {
    const label = [...sidebar.querySelectorAll(':scope > .side-label')].find((node) => node.textContent.trim().toLocaleLowerCase('ru-RU') === labelText.toLocaleLowerCase('ru-RU'));
    const nav = label?.nextElementSibling;
    if (!label || !nav?.classList.contains('portal-nav')) return;
    // The admin portal must expose the same working hall as the staff shell.
    // Rebuild this list from the canonical permission-aware definition so an
    // older static template cannot hide the primary operational destination.
    nav.replaceChildren(...[
      { href: '/', permission: 'floor', label: 'Рабочий зал', iconName: 'table-layout' },
      { href: '/orders', permission: 'orders', label: 'Заказы', iconName: 'receipt' },
      { href: '/clients', permission: 'staff_view', label: 'Гости', iconName: 'users' },
      { href: '/reservations', permission: 'reservations', label: 'Бронирования', iconName: 'calendar-event' },
      { href: '/delivery', permission: 'delivery', label: 'Доставка', iconName: 'truck-delivery' },
    ].map(makeLink));
    const details = document.createElement('details'); details.className = 'sidebar-nav-group'; details.dataset.navGroup = key;
    const saved = savedGroupState(key); details.open = saved === null ? defaultGroupOpen(key) : saved;
    const summary = document.createElement('summary'); summary.setAttribute('aria-label', labelText); summary.title = labelText; summary.innerHTML = `${iconMarkup(key === 'operations' ? 'clipboard-list' : 'chart-bar')}<span>${labelText}</span>`; details.append(summary, nav);
    rememberGroupState(details, key); label.replaceWith(details);
  });
  if (adminNavigationAllowed) {
    let adminLabel = sidebar.querySelector(':scope > .side-label.staff-nav');
    let adminNav = sidebar.querySelector(':scope > .portal-nav.staff-nav');
    if (!adminLabel) { adminLabel = document.createElement('div'); adminLabel.className = 'side-label staff-nav'; adminLabel.dataset.staffNav = ''; adminLabel.textContent = 'АДМИНИСТРИРОВАНИЕ'; sidebar.querySelector('.sidebar-footer')?.before(adminLabel); }
    if (!adminNav) { adminNav = document.createElement('nav'); adminNav.className = 'portal-nav staff-nav'; adminNav.dataset.staffNav = ''; adminLabel.after(adminNav); }
    const adminLinks = [
      { href: '/admin#staff', permission: 'staff_view', label: 'Персонал', iconName: 'id-badge' },
      { href: '/admin#permissions', permission: 'staff_manage', label: 'Роли и права доступа', iconName: 'shield-lock' },
      { href: '/admin#tasks', permission: 'orders', label: 'Задачи', iconName: 'list-check' },
      { href: '/admin#loyalty', permission: 'loyalty', label: 'Лояльность и скидки', iconName: 'gift' },
      { href: '/admin#company', permission: 'settings', label: 'Настройки заведения', iconName: 'building-store' },
      { href: '/admin#settings-dashboard-modules', permission: 'settings', label: 'Настройки модулей', iconName: 'layout-dashboard' },
      { href: '/admin#lock-security', permission: 'settings', label: 'Безопасность', iconName: 'lock' },
      { href: '/admin#audit', permission: 'settings', label: 'Журнал действий', iconName: 'history' },
      { href: '/integrations', permission: 'integrations', label: 'Интеграции', iconName: 'send' },
      { href: '/network', permission: 'settings', label: 'Моя сеть', iconName: 'building' },
      { href: '/admin#diagnostics', permission: 'diagnostics', label: 'Диагностика', iconName: 'alert-triangle' },
      { href: '/admin#notifications', permission: 'dashboard', label: 'Уведомления', iconName: 'bell' },
      { href: '/admin#help', permission: 'dashboard', label: 'База знаний', iconName: 'help-circle' },
    ];
    // Rebuild this small administrative list from one canonical definition.
    // This prevents duplicate or stale links left by older page templates and
    // allows two useful entries to share the staff screen (#staff).
    adminNav.replaceChildren(...adminLinks.map((item) => makeLink(item)));
    // Keep the sidebar calm: team actions and system configuration are
    // expandable groups while daily operations remain visible.
    const existingGroups = sidebar.querySelector(':scope > .sidebar-nav-groups');
    if (!existingGroups) {
      const groupRoot = document.createElement('div'); groupRoot.className = 'sidebar-nav-groups';
      const makeGroup = (label, hrefs, key) => {
        const details = document.createElement('details'); details.className = 'sidebar-nav-group'; details.dataset.navGroup = key;
        const saved = savedGroupState(key); details.open = saved === null ? defaultGroupOpen(key) : saved;
        const summary = document.createElement('summary'); summary.setAttribute('aria-label', label); summary.title = label; summary.innerHTML = `${iconMarkup(key === 'team' ? 'users' : 'settings')}<span>${label}</span>`; details.append(summary);
        const nav = document.createElement('nav'); nav.className = 'portal-nav staff-nav'; nav.dataset.staffNav = '';
        hrefs.forEach((href) => { adminNav.querySelectorAll(`a[href="${href}"]`).forEach((link) => nav.append(link)); });
        details.append(nav); rememberGroupState(details, key); return details;
      };
      groupRoot.append(makeGroup('Команда', ['/admin#staff', '/admin#permissions', '/admin#tasks'], 'team'));
      groupRoot.append(makeGroup('Система', ['/admin#loyalty', '/admin#company', '/admin#settings-dashboard-modules', '/admin#lock-security', '/admin#audit', '/integrations', '/network', '/admin#diagnostics', '/admin#notifications', '/admin#help'], 'system'));
      adminLabel.replaceWith(groupRoot); adminNav.remove();
    }
    // After the first grouping pass, subsequent hash navigation must not
    // recreate the old flat administration menu beside the grouped menu.
    sidebar.querySelectorAll(':scope > .side-label.staff-nav, :scope > .portal-nav.staff-nav').forEach((node) => {
      if (!node.closest('.sidebar-nav-group')) node.remove();
    });
  }
  const disclosureGroups = new Map([...sidebar.querySelectorAll('details.sidebar-nav-group[data-nav-group]')].map((group) => [group.dataset.navGroup, group]));
  let disclosureRoot = sidebar.querySelector(':scope > .sidebar-nav-groups');
  if (!disclosureRoot) { disclosureRoot = document.createElement('div'); disclosureRoot.className = 'sidebar-nav-groups'; }
  disclosureRoot.className = 'sidebar-nav-groups';
  let menuSearch = sidebar.querySelector(':scope > .sidebar-menu-search');
  if (!menuSearch) {
    menuSearch = document.createElement('label');
    menuSearch.className = 'sidebar-menu-search';
    menuSearch.innerHTML = '<span class="sr-only">Поиск по меню</span><svg class="icon" aria-hidden="true"><use href="/assets/tabler-icons.svg?rev=5#search"></use></svg><input type="search" id="sidebar-menu-search" placeholder="Найти раздел" autocomplete="off">';
    mainNav.after(menuSearch);
  }
  const menuSearchInput = menuSearch.querySelector('input');
  const applyMenuSearch = () => {
    const query = String(menuSearchInput?.value || '').trim().toLocaleLowerCase('ru-RU');
    sidebar.querySelectorAll('details.sidebar-nav-group[data-nav-group]').forEach((group) => {
      const links = [...group.querySelectorAll('.portal-nav a')];
      const visibleLinks = links.filter((link) => !link.hidden || link.dataset.menuSearchHidden !== 'true');
      const matching = visibleLinks.filter((link) => String(link.textContent || '').toLocaleLowerCase('ru-RU').includes(query));
      const groupMatches = String(group.querySelector(':scope > summary')?.textContent || '').toLocaleLowerCase('ru-RU').includes(query);
      links.forEach((link) => {
        if (link.hidden && link.dataset.permission && !portalPermissions.has(link.dataset.permission)) return;
        const hide = Boolean(query) && !String(link.textContent || '').toLocaleLowerCase('ru-RU').includes(query);
        link.dataset.menuSearchHidden = hide ? 'true' : 'false';
        if (!link.hidden || !hide) link.hidden = hide;
      });
      if (query) group.hidden = !groupMatches && matching.length === 0;
      if (query && !group.hidden && matching.length) group.open = true;
    });
  };
  if (menuSearchInput && !menuSearchInput.dataset.bound) { menuSearchInput.dataset.bound = 'true'; menuSearchInput.addEventListener('input', applyMenuSearch); }
  mainNav.after(disclosureRoot);
  disclosureRoot.replaceChildren(...['operations', 'menu', 'inventory', 'finance', 'team', 'system'].map((key) => key === 'menu' ? menuGroup : key === 'inventory' ? inventoryGroup : key === 'finance' ? financeGroup : disclosureGroups.get(key)).filter(Boolean));
  const normalizedGroups = [...disclosureRoot.querySelectorAll('details.sidebar-nav-group[data-nav-group]')];
  const savedOpenGroup = normalizedGroups.find((group) => savedGroupState(group.dataset.navGroup) === true);
  const hasSavedDisclosureState = normalizedGroups.some((group) => savedGroupState(group.dataset.navGroup) !== null);
  const preferCurrentRoute = routeChange || !initialDocumentReload;
  const preferredGroup = preferCurrentRoute ? normalizedGroups.find((group) => defaultGroupOpen(group.dataset.navGroup)) : (hasSavedDisclosureState ? savedOpenGroup : (currentPath === '/admin' && !currentHash ? null : normalizedGroups.find((group) => defaultGroupOpen(group.dataset.navGroup))));
  normalizedGroups.forEach((group) => { group.open = group === preferredGroup; });
  const homeLink = sidebar.querySelector(':scope > a[href="/admin"]');
  if (homeLink && homeLink.dataset.homeDisclosureBound !== 'true') {
    homeLink.dataset.homeDisclosureBound = 'true';
    homeLink.addEventListener('click', () => {
      normalizedGroups.forEach((group) => {
        group.open = false;
        try { localStorage.setItem(groupStorageKey(group.dataset.navGroup), 'closed'); } catch (_) {}
      });
    });
  }
  applyMenuSearch();
  // Keep the single-disclosure invariant after reload. The preferred group
  // already accounts for the active route and the user's saved preference;
  // reopening each saved group here would expand several groups at once.
  normalizedGroups.forEach((group) => {
    group.querySelector(':scope > summary')?.setAttribute('aria-expanded', String(group.open));
  });
  const settingsHashes = new Set(['#settings', '#company', '#settings-dashboard-modules', '#venue-layout-settings', '#lock-security', '#audit']);
  sidebar.querySelectorAll('.portal-nav a').forEach((link) => {
    const href = link.getAttribute('href') || '';
    const linkLabel = link.querySelector('span')?.textContent.trim() || link.textContent.trim();
    if (linkLabel) { link.setAttribute('aria-label', linkLabel); link.title = linkLabel; }
    let linkUrl;
    try { linkUrl = new URL(href, currentUrl); } catch (_) { linkUrl = null; }
    if (!linkUrl) return;
    // Compare normalized paths so the root staff workspace highlights reliably.
    const settingsLinkActive = linkUrl.pathname === '/admin' && linkUrl.hash === '#settings' && settingsHashes.has(currentHash);
    const hashMatches = linkUrl.hash ? linkUrl.hash === currentHash : !currentHash;
    const linkView = linkUrl.searchParams.get('view');
    const currentView = currentUrl.searchParams.get('view') || 'stock';
    const viewMatches = linkUrl.pathname === '/inventory' ? (linkView || 'stock') === currentView : true;
    const active = settingsLinkActive || (linkUrl.pathname === currentPath && hashMatches && viewMatches);
    link.classList.toggle('active', active);
    if (active) {
      link.setAttribute('aria-current', 'page');
    } else link.removeAttribute('aria-current');
  });
  sidebar.querySelectorAll('details.sidebar-nav-group[data-nav-group]').forEach((group) => {
    const activeLink = group.querySelector('a.active');
    const summary = group.querySelector(':scope > summary');
    // Keep the user's saved disclosure state; the active child remains marked
    // on the group summary even when that group is intentionally collapsed.
    summary?.setAttribute('aria-expanded', String(group.open));
    summary?.classList.toggle('has-active-child', Boolean(activeLink));
    if (activeLink) summary?.setAttribute('aria-current', 'location');
    else summary?.removeAttribute('aria-current');
    if (activeLink) requestAnimationFrame(() => revealActiveSidebarLink(group));
  });
  if (sidebar._activeNavigationResizeHandler) window.removeEventListener('resize', sidebar._activeNavigationResizeHandler);
  sidebar._activeNavigationResizeHandler = () => {
    requestAnimationFrame(() => sidebar.querySelectorAll('details.sidebar-nav-group').forEach(revealActiveSidebarLink));
  };
  window.addEventListener('resize', sidebar._activeNavigationResizeHandler, { passive: true });
  window.__applyInterfacePreferences?.();
};
normalizeManagementSidebar();
document.querySelectorAll('.portal-nav a[data-permission]').forEach((link) => {
  if (!portalPermissions.has(link.dataset.permission)) link.hidden = true;
});
if (portalUser.role === 'manager') document.querySelectorAll('.portal-nav a[href="/network"]').forEach((link) => { link.hidden = true; });
// Do not leave empty headings or navigation blocks after role filtering.
const refreshSidebarGroups = () => {
  document.querySelectorAll('.portal-sidebar > .portal-nav,.portal-sidebar > .sidebar-nav-groups > .portal-nav').forEach((nav) => {
    const hasVisibleLink = [...nav.querySelectorAll('a')].some((link) => !link.hidden);
    nav.hidden = !hasVisibleLink;
    const label = nav.previousElementSibling;
    if (label?.classList.contains('side-label')) label.hidden = !hasVisibleLink;
  });
  document.querySelectorAll('.portal-sidebar details.sidebar-nav-group').forEach((group) => {
    group.hidden = ![...group.querySelectorAll('.portal-nav a')].some((link) => !link.hidden);
  });
};
refreshSidebarGroups();
document.querySelectorAll('[data-owner-only]').forEach((node) => { if (!['owner', 'developer'].includes(portalUser.role)) node.hidden = true; });
document.querySelectorAll('[data-staff-nav]').forEach((node) => { if (!portalPermissions.has('staff_view')) node.hidden = true; });
document.querySelectorAll('[data-admin-mode-switch],.current-mode').forEach((node) => node.remove());

const portalFooterRole = document.querySelector('.sidebar-footer b');
const portalFooterAccess = document.querySelector('.sidebar-footer small');
if (portalFooterRole) portalFooterRole.textContent = `● ${portalRole[0]}`;
if (portalFooterAccess) portalFooterAccess.textContent = portalRole[1];
document.querySelector('#logout')?.addEventListener('click', async (event) => {
  if (event.currentTarget.disabled) return; event.currentTarget.disabled = true; try { await fetch('/api/logout', { method: 'POST', headers: authHeaders() }); } catch (_) {}
  window.__broadcastSessionEnd?.();
  localStorage.removeItem('crm_session_token');
  localStorage.removeItem('crm_session_user');
  window.location.replace('/login');
});
const page = document.body.dataset.page || 'dashboard';
const pagePermissions = { dashboard: 'dashboard', orders: 'orders', clients: 'staff_view', reservations: 'reservations', inventory: 'inventory_read', finance: 'finance_read', finance_categories: 'finance', finance_report: 'finance_read', integrations: 'integrations', delivery: 'delivery' };
if (pagePermissions[page] && !portalPermissions.has(pagePermissions[page])) {
  window.location.replace('/admin');
  throw new Error('portal_route_forbidden');
}
const formatRuDate = (value, withTime = false) => { if (!value) return '—'; const raw = String(value); if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) { const [year, month, day] = raw.split('-'); return `${day}.${month}.${year}`; } const date = value instanceof Date ? value : new Date(value); if (Number.isNaN(date.getTime())) return raw; return new Intl.DateTimeFormat('ru-RU', withTime ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date); }; const pluralRu=(value,one,few,many)=>{const n=Math.abs(Number(value)||0),last10=n%10,last100=n%100;return last10===1&&last100!==11?one:last10>=2&&last10<=4&&(last100<12||last100>14)?few:many;}; const formatActiveStaffCount=(value)=>{const count=Number(value)||0;return `${count} ${pluralRu(count,'активный','активных','активных')}`;}; const money=(value)=>`${Number(value||0).toLocaleString('ru-RU',{maximumFractionDigits:2})} ₽`;
const reservationCancelPrompt = (reservation) => {
  const verifiedPrepayment = Number(reservation?.verifiedDepositPaid || 0);
  const legacyDeposit = Math.max(Number(reservation?.legacyDepositPaid || 0), Number(reservation?.depositPaid || 0));
  const warnings = [];
  if (verifiedPrepayment > 0) warnings.push('Сначала верните зачёт из открытого заказа и оформите возврат всей фактически полученной предоплаты.');
  if (legacyDeposit > 0) warnings.push(`В старом поле брони указано ${money(legacyDeposit)}. Это не подтверждение поступления. При отмене сумма останется в истории для ручной сверки; не оформляйте возврат без первичного документа.`);
  if (!warnings.length) warnings.push('Бронирование будет отменено, а история останется в журнале.');
  return warnings.join(' ');
};
const reservationHistoryPaymentLabel = (reservation) => {
  if (!reservation) return 'Без депозита';
  const verified = Number(reservation.verifiedDepositPaid || 0);
  const legacy = Math.max(Number(reservation.legacyDepositPaid || 0), Number(reservation.depositPaid || 0));
  const required = Number(reservation.depositRequired ?? reservation.deposit ?? 0);
  const receipts = Array.isArray(reservation.prepaymentReceipts) ? reservation.prepaymentReceipts : [];
  const refunded = receipts.reduce((sum, receipt) => sum + Number(receipt.refundedAmount || 0), 0);
  const receiptGross = receipts.reduce((sum, receipt) => sum + Number(receipt.amount || 0), 0);
  const parts = [];
  if (required > 0) parts.push(`Требуемый депозит ${money(required)}`);
  if (verified > 0) parts.push(`подтверждено квитанциями ${money(verified)}`);
  if (refunded > 0 && verified > 0) parts.push(`возвращено ${money(refunded)}`);
  if (verified === 0 && receiptGross > 0 && refunded > 0) parts.push(`предоплата возвращена полностью (${money(refunded)})`);
  if (legacy > 0) parts.push(`старая сумма ${money(legacy)} · не подтверждена`);
  if (verified === 0 && receiptGross === 0 && legacy === 0 && required > 0) parts.push('получение не подтверждено');
  return parts.length ? parts.join(' · ') : 'Без депозита';
};
const updateHeaderDate = () => { const currentDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date()).replace(/ г\.$/, ''); document.querySelectorAll('[data-current-date]').forEach((node) => { node.textContent = currentDate; }); };
updateHeaderDate(); window.setInterval(updateHeaderDate, 60_000);
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="/assets/tabler-icons.svg#${name}"></use></svg>`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
const renderLegacyReservationRows = (records) => records.map((item) => {
  const receiptCount = Number(item.receiptCount || 0);
  const receiptTotal = Math.max(0, Number(item.receiptTotal || 0));
  const legacyOnly = item.reviewStatus === 'legacy_unverified' && receiptCount === 0;
  const hasReceipts = item.reviewStatus === 'legacy_and_verified_receipts' || receiptCount > 0;
  const reviewLabel = legacyOnly
    ? 'Квитанций нет · требуется сверка старой суммы'
    : hasReceipts && receiptTotal === 0
      ? 'Квитанции есть, сумма полностью возвращена · старая сумма проверяется отдельно'
      : hasReceipts
        ? `Есть квитанции на ${money(receiptTotal)} после возвратов · старая сумма проверяется отдельно`
        : 'Тип записи не определён · требуется ручная сверка';
  const dispositionLabels = { unreviewed: 'Не проверена', documents_found: 'Документы найдены', documents_not_found: 'Документы не найдены', disputed: 'Передано на разбор' };
  const history = (item.reviewHistory || []).map((entry) => `<small>${Number(entry.sequence)}. ${esc(dispositionLabels[entry.disposition] || entry.disposition)} · ${esc(entry.actorName || 'Система')} · ${formatRuDate(entry.createdAt, true)} · ${esc(entry.note || '')}${entry.evidenceReference ? ` · Основание: ${esc(entry.evidenceReference)}` : ''}</small>`).join('');
  return `<article class="report-row report-row-long legacy-deposit-review" data-reservation-id="${esc(item.id)}"><span>${esc(item.guestName || 'Гость не указан')} · ${esc(String(item.startsAt || '').replace('T', ' ').slice(0, 16))} · ${esc(item.status || '')}</span><strong>Старая сумма в записи брони (не подтверждена): ${money(item.legacyAmount)}</strong><small>${esc(reviewLabel)} · Депозит по условиям брони: ${money(item.depositRequired)} · По квитанциям после возвратов: ${money(receiptTotal)} (${receiptCount}) · Счёт брони ${esc(item.id)}</small><small>Статус документальной проверки: ${esc(dispositionLabels[item.reviewDisposition] || 'Не проверена')}. Это не подтверждает получение денег и не меняет остаток или кассу.</small>${history ? `<div class="legacy-review-history">${history}</div>` : ''}<form class="legacy-review-form"><input type="hidden" name="expectedReviewId" value="${esc(item.reviewId || '')}"><label>Результат поиска документов<select name="disposition" required><option value="documents_found">Документы найдены</option><option value="documents_not_found">Документы не найдены</option><option value="disputed">Нужна дополнительная проверка</option></select></label><label>Комментарий о сверке<textarea name="note" minlength="8" maxlength="500" required placeholder="Что проверили и какой результат получили"></textarea></label><label>Ссылка или номер документа<input name="evidenceReference" maxlength="250" placeholder="Обязательно, если документы найдены"></label><button class="button small" type="submit">Записать результат проверки</button><span class="form-message" role="status" aria-live="polite"></span></form></article>`;
}).join('');
const portalSelectOptionsMarkup = (select) => {
  const optionMarkup = (option, groupDisabled = false) => {
    const disabled = select.disabled || option.disabled || groupDisabled;
    return `<button type="button" class="custom-select-option" role="option" data-value="${esc(option.value)}" aria-selected="${option.selected ? 'true' : 'false'}"${disabled ? ' disabled aria-disabled="true"' : ''}>${esc(option.textContent)}</button>`;
  };
  return [...select.children].map(child => child.tagName === 'OPTGROUP'
    ? `<div role="group" aria-label="${esc(child.label)}"><div class="custom-select-group-label" aria-hidden="true">${esc(child.label)}</div>${[...child.children].map(option => optionMarkup(option, child.disabled)).join('')}</div>`
    : optionMarkup(child)).join('');
};
const enhancePortalSelect = (select) => {
  if (!(select instanceof HTMLSelectElement) || select.dataset.customSelect === '1' || select.multiple) return;
  const wrapper = document.createElement('div'); wrapper.className = 'custom-select';
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'custom-select-trigger'; trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-label', select.getAttribute('aria-label') || [...(select.labels || [])].map(label => { const name = label.cloneNode(true); name.querySelectorAll('select,input,textarea,button,small,.custom-select').forEach(node => node.remove()); return name.textContent.trim(); }).filter(Boolean).join(' · ') || 'Выбор значения');
  const menu = document.createElement('div'); menu.className = 'custom-select-menu'; menu.setAttribute('role', 'listbox');
  const rebuild = () => {
    menu.innerHTML = portalSelectOptionsMarkup(select);
    trigger.textContent = select.selectedOptions[0]?.textContent || 'Выберите значение'; trigger.disabled = select.disabled; menu.querySelectorAll('[data-value]').forEach((option) => { option.tabIndex = select.disabled ? -1 : option.getAttribute('aria-selected') === 'true' && !option.disabled ? 0 : -1; }); if (select.disabled) close();
  };
  const close = () => { wrapper.classList.remove('is-open'); trigger.setAttribute('aria-expanded', 'false'); };
  const open = () => { if (select.disabled) return; wrapper.classList.add('is-open'); trigger.setAttribute('aria-expanded', 'true'); (menu.querySelector('[aria-selected="true"]:not(:disabled)') || menu.querySelector('[data-value]:not(:disabled)'))?.focus(); };
  wrapper.addEventListener('focusout', (event) => { if (!wrapper.contains(event.relatedTarget)) close(); });
  trigger.addEventListener('click', () => wrapper.classList.contains('is-open') ? close() : open());
  trigger.addEventListener('keydown', (event) => { if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } if (event.key === 'Escape') close(); });
  menu.addEventListener('click', (event) => { const option = event.target.closest('[data-value]'); if (select.disabled || !option || option.disabled) return; select.value = option.dataset.value; select.dispatchEvent(new Event('change', { bubbles: true })); rebuild(); close(); trigger.focus(); });
  menu.addEventListener('keydown', (event) => { if (select.disabled) { event.preventDefault(); return; } const options = [...menu.querySelectorAll('[data-value]:not(:disabled)')]; const current = options.indexOf(document.activeElement); if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); options[(current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus(); } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); document.activeElement?.click(); } else if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus(); } });
  select.addEventListener('change', rebuild); select.addEventListener('input', rebuild); select._customSelectRefresh = rebuild; select.dataset.customSelect = '1'; select.setAttribute('aria-hidden', 'true'); select.tabIndex = -1; select.classList.add('native-select-source'); select.parentNode.insertBefore(wrapper, select); wrapper.append(select, trigger, menu); rebuild();
};
const enhancePortalSelects = () => document.querySelectorAll('select:not([data-custom-select="1"])').forEach(enhancePortalSelect);
enhancePortalSelects();
const portalSelectObserver = new MutationObserver((records) => { records.forEach((record) => { if (record.type === 'childList' && record.target instanceof HTMLSelectElement && record.target._customSelectRefresh) record.target._customSelectRefresh(); }); enhancePortalSelects(); });
portalSelectObserver.observe(document.body, { childList: true, subtree: true });
document.addEventListener('click', (event) => { document.querySelectorAll('.custom-select.is-open').forEach((wrapper) => { if (!wrapper.contains(event.target)) { wrapper.classList.remove('is-open'); wrapper.querySelector('.custom-select-trigger')?.setAttribute('aria-expanded', 'false'); } }); });
const displayName = (value) => { const text = String(value ?? '').trim(); return text ? text.replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_, prefix, letter) => prefix + letter.toLocaleUpperCase('ru-RU')) : text; };
const portalHeaderName = displayName(portalUser.name || portalUser.fullName || portalRole[0]);
const portalHeaderInitials = portalHeaderName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toLocaleUpperCase('ru-RU') || 'С';
const refreshPortalHeaderAvatar = (avatarUrl) => { portalUser.avatarUrl = avatarUrl || null; document.querySelectorAll('[data-user-avatar],[data-sidebar-avatar]').forEach((node) => { if (portalUser.avatarUrl) { const image = document.createElement('img'); image.src = portalUser.avatarUrl; image.alt = portalHeaderName; node.replaceChildren(image); } else node.textContent = portalHeaderInitials; }); };
document.querySelectorAll('[data-user-name]').forEach((node) => { node.textContent = portalHeaderName; });
document.querySelectorAll('[data-user-role]').forEach((node) => { node.textContent = portalRole[0]; });
document.querySelectorAll('[data-user-avatar]').forEach((node) => {
  node.title = `${portalHeaderName} · ${portalRole[0]}`;
  if (portalUser.avatarUrl) { const image = document.createElement('img'); image.src = portalUser.avatarUrl; image.alt = portalHeaderName; node.replaceChildren(image); }
  else node.textContent = portalHeaderInitials;
});
document.querySelectorAll('[data-sidebar-name]').forEach((node) => { node.textContent = portalHeaderName; });
document.querySelectorAll('[data-sidebar-role]').forEach((node) => { node.textContent = portalRole[0]; });
document.querySelectorAll('[data-sidebar-avatar]').forEach((node) => { node.title = `${portalHeaderName} · ${portalRole[0]}`; if (portalUser.avatarUrl) { const image = document.createElement('img'); image.src = portalUser.avatarUrl; image.alt = portalHeaderName; node.replaceChildren(image); } else node.textContent = portalHeaderInitials; });
const permissionScopeLabels = { orders: 'Заказы', reservations: 'Бронирования', inventory: 'Склад', inventory_categories: 'Справочник категорий склада', finance: 'Управление финансами', finance_read: 'Просмотр финансов', staff: 'Сотрудники', delivery: 'Доставка', integrations: 'Интеграции', settings: 'Настройки и сеть' };
const permissionScopeMarkup = (selected = []) => `<details class="permission-scope-fields"><summary>Права доступа по направлениям</summary><small class="muted">Выберите разделы, которыми сможет управлять сотрудник. Пустой список оставляет только базовые права роли.</small><div class="scope-grid">${Object.entries(permissionScopeLabels).map(([scope, label]) => `<label class="scope-option"><input type="checkbox" name="permissionScopes" value="${scope}" ${selected.includes(scope) ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div></details>`;
const authHeaders = () => { const token = localStorage.getItem('crm_session_token'); return token ? { Authorization: `Bearer ${token}` } : {}; };
const portalNotice = (text, kind = 'info') => { let node = document.querySelector('#portal-notice'); if (!node) { node = document.createElement('div'); node.id = 'portal-notice'; node.className = 'portal-notice'; document.body.append(node); } node.textContent = text; node.dataset.kind = kind; clearTimeout(portalNotice.timer); portalNotice.timer = setTimeout(() => node.remove(), 4200); }; window.portalNotice = portalNotice;
let portalActionSequence = 0;
const portalActionFieldMarkup = (field) => {
  if (field.type === 'checkbox') return `<label class="action-field action-field-checkbox"><input name="${esc(field.name)}" type="checkbox" value="true" ${field.value ? 'checked' : ''} ${field.required === false ? '' : 'required'}><span>${esc(field.label)}</span></label>`;
  if (field.type === 'select') return `<label class="action-field">${esc(field.label)}<select name="${esc(field.name)}" ${field.required === false ? '' : 'required'}>${(field.options || []).map((option) => `<option value="${esc(option.value)}" ${String(option.value) === String(field.value ?? '') ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select></label>`;
  if (field.type === 'textarea') return `<label class="action-field">${esc(field.label)}<textarea name="${esc(field.name)}" rows="3" ${field.required === false ? '' : 'required'} placeholder="${esc(field.placeholder || '')}">${esc(field.value ?? '')}</textarea></label>`;
  return `<label class="action-field">${esc(field.label)}<input name="${esc(field.name)}" type="${esc(field.type || 'text')}" value="${esc(field.value ?? '')}" ${field.min !== undefined ? `min="${esc(field.min)}"` : ''} ${field.max !== undefined ? `max="${esc(field.max)}"` : ''} ${field.step !== undefined ? `step="${esc(field.step)}"` : ''} ${field.required === false ? '' : 'required'} placeholder="${esc(field.placeholder || '')}"></label>`;
};
const portalAction = ({ title, description = '', submitLabel = 'Сохранить', fields = [], danger = false, validate = null }) => new Promise((resolve) => {
  const opener = document.activeElement;
  const labelId = `portal-action-title-${++portalActionSequence}`;
  const descriptionId = `${labelId}-description`;
  const modal = document.createElement('div'); modal.className = 'modal action-modal open'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', labelId); if (description) modal.setAttribute('aria-describedby', descriptionId); modal.tabIndex = -1;
  modal.innerHTML = `<div class="action-box"><div class="modal-head"><div><h2 id="${labelId}">${esc(title)}</h2>${description ? `<small id="${descriptionId}">${esc(description)}</small>` : ''}</div><button type="button" class="icon-button modal-close" aria-label="Закрыть">${icon('x')}</button></div><form><div class="action-fields">${fields.map(portalActionFieldMarkup).join('')}</div><p class="form-message" aria-live="polite"></p><div class="action-footer"><button type="button" class="button modal-cancel">Отмена</button><button type="submit" class="button ${danger ? 'danger' : 'primary'}">${esc(submitLabel)}</button></div></form></div>`;
  document.body.append(modal); const form = modal.querySelector('form'); const firstField = modal.querySelector('input,select,textarea'); let escape;
  let closed = false;
  const close = (value) => {
    if (closed) return; closed = true;
    if (escape) document.removeEventListener('keydown', escape);
    modal.remove();
    if (opener?.isConnected && !opener.disabled && opener.getClientRects().length > 0 && typeof opener.focus === 'function') {
      opener.focus({ preventScroll: true });
    } else {
      const fallback = document.querySelector('#page-content,main,[role="main"]');
      if (fallback) {
        const previousTabIndex = fallback.getAttribute('tabindex');
        fallback.tabIndex = -1; fallback.focus({ preventScroll: true });
        if (previousTabIndex === null) fallback.removeAttribute('tabindex'); else fallback.setAttribute('tabindex', previousTabIndex);
      }
    }
    resolve(value);
  };
  modal.querySelector('.modal-close').addEventListener('click', () => close(null)); modal.querySelector('.modal-cancel').addEventListener('click', () => close(null)); modal.addEventListener('click', (event) => { if (event.target === modal) close(null); });
  escape = (event) => {
    if (event.defaultPrevented || [...document.querySelectorAll('.action-modal.open')].at(-1) !== modal) return;
    if (event.key === 'Escape') { event.preventDefault(); close(null); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')]
      .filter((node) => !node.disabled && node.tabIndex >= 0 && node.getAttribute('aria-hidden') !== 'true' && node.getClientRects().length > 0);
    const first = focusable[0]; const last = focusable.at(-1);
    if (!first) { event.preventDefault(); modal.focus(); return; }
    const active = document.activeElement;
    if (!modal.contains(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
      event.preventDefault(); (event.shiftKey ? last : first).focus();
    }
  }; document.addEventListener('keydown', escape);
  form.addEventListener('submit', (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(form).entries()); fields.filter((field) => field.type === 'checkbox').forEach((field) => { data[field.name] = Boolean(form.querySelector(`[name="${CSS.escape(field.name)}"]`)?.checked); }); const invalid = fields.find((field) => field.type === 'number' && (!Number.isFinite(Number(data[field.name])) || (field.min !== undefined && Number(data[field.name]) < Number(field.min)) || (field.max !== undefined && Number(data[field.name]) > Number(field.max)))); const validationMessage = invalid ? `Введите корректное значение: ${invalid.label.toLocaleLowerCase('ru-RU')}` : validate?.(data); if (validationMessage) { const message = modal.querySelector('.form-message'); message.textContent = validationMessage; modal.querySelector(`[name="${CSS.escape(invalid?.name || validate.focusField || '')}"]`)?.focus(); return; } close(data); });
  (firstField || modal.querySelector('.modal-cancel') || modal).focus();
});
// На узких экранах подписи навигации скрываются, поэтому сохраняем название
// пункта в нативной подсказке и доступном имени ссылки.
document.querySelectorAll('.portal-nav a').forEach((link) => {
  const label = link.querySelector('span')?.textContent?.trim();
  if (label && !link.title) link.title = label;
  if (label && !link.getAttribute('aria-label')) link.setAttribute('aria-label', label);
});
const portalConfirm = (title, description, submitLabel = 'Подтвердить') => portalAction({ title, description, submitLabel, fields: [], danger: true }).then((result) => result !== null);
const headerNotificationRoles = new Set(['owner', 'admin', 'manager', 'developer']);
const notificationBell = document.querySelector('#notification-bell');
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
const allowedNotificationHrefs = new Set(['/orders', '/inventory?view=auto-orders', '/admin']);
const notificationContent = notificationPanel.querySelector('#notification-panel-content');
const notificationBadge = document.querySelector('#notification-count');
const notificationCountLabel = notificationPanel.querySelector('#notification-panel-count');
const formatNotificationTime = (value) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date) : ''; };
const updateNotificationCount = (count) => {
  const value = Math.max(0, Number(count) || 0);
  if (notificationBadge) { notificationBadge.textContent = value > 99 ? '99+' : String(value); notificationBadge.hidden = value === 0; }
  if (notificationBell) { notificationBell.title = value ? `Непрочитанные уведомления: ${value}` : 'Уведомления'; notificationBell.setAttribute('aria-label', value ? `Уведомления, непрочитанных: ${value}` : 'Уведомления'); }
  if (notificationCountLabel) notificationCountLabel.textContent = value ? `${value} непрочитанных` : 'Все просмотрено';
  notificationPanel.querySelector('.notification-read-all').hidden = value === 0;
};
const renderNotificationState = (kind, message = '') => {
  notificationContent.replaceChildren(); notificationContent.setAttribute('aria-busy', kind === 'loading' ? 'true' : 'false');
  const state = document.createElement('div'); state.className = `notification-state notification-state-${kind}`;
  if (kind === 'error') { const text = document.createElement('p'); text.textContent = message || 'Не удалось загрузить уведомления.'; state.append(text); const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button small'; retry.textContent = 'Повторить'; retry.addEventListener('click', () => loadNotifications(true)); state.append(retry); }
  else state.textContent = kind === 'loading' ? 'Загружаем уведомления…' : (message || 'Пока нет уведомлений');
  notificationContent.append(state);
};
const renderNotifications = () => {
  const items = notificationData.items.filter((item) => notificationFilter !== 'unread' || !item.readAt);
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
    if (href) { const open = document.createElement('a'); open.href = href; open.className = 'notification-open-link'; open.textContent = item.requiresAction ? 'Открыть запрос' : 'Открыть'; open.addEventListener('click', async (event) => { if (item.readAt) return; event.preventDefault(); try { await setNotificationRead(item.id); window.location.assign(href); } catch (_) { renderNotificationState('error', 'Не удалось сохранить прочтение. Повторите попытку.'); } }); actions.append(open); }
    if (!item.readAt) { const read = document.createElement('button'); read.type = 'button'; read.className = 'notification-mark-read'; read.textContent = 'Отметить прочитанным'; read.setAttribute('aria-label', `Отметить прочитанным: ${String(item.title || 'уведомление')}`); read.addEventListener('click', async () => { read.disabled = true; try { await setNotificationRead(item.id); } catch (_) { read.disabled = false; renderNotificationState('error', 'Не удалось сохранить прочтение. Повторите попытку.'); } }); actions.append(read); }
    row.append(actions); list.append(row);
  }
  notificationContent.append(list);
};
const loadNotifications = async (showLoading = false) => { if (notificationObserverDisposed) return;
  if (notificationBusy) { notificationRefreshQueued = true; return; } notificationBusy = true; if (showLoading) renderNotificationState('loading');
  try { const data = await api(`/api/notifications?limit=20&filter=${notificationFilter}`); notificationData = { items: Array.isArray(data.items) ? data.items : [], unreadCount: Number(data.unreadCount || 0) }; updateNotificationCount(notificationData.unreadCount); if (!notificationPanel.hidden) renderNotifications(); }
  catch (_) {
    if (!notificationPanel.hidden) {
      if (notificationData.items.length) { renderNotifications(); const error = document.createElement('div'); error.className = 'notification-inline-error'; error.setAttribute('role', 'status'); error.textContent = 'Не удалось обновить. Нажмите, чтобы повторить.'; const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Повторить'; retry.addEventListener('click', () => loadNotifications(true)); error.append(retry); notificationContent.prepend(error); }
      else renderNotificationState('error');
    }
    if (notificationBell && notificationData.unreadCount === 0) notificationBell.title = 'Не удалось обновить уведомления';
  }
  finally { notificationBusy = false; if (notificationRefreshQueued) { notificationRefreshQueued = false; loadNotifications(false); } }
};
const notificationChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('territory-crm-notifications') : null;
let notificationObserverDisposed = false;
let notificationRefreshTimer = null;
const disposeNotificationObserver = () => { notificationObserverDisposed = true; if (notificationRefreshTimer) { clearInterval(notificationRefreshTimer); notificationRefreshTimer = null; } notificationChannel?.close?.(); };
const setNotificationRead = async (id) => {
  const response = await api(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'PUT' });
  notificationData.items = notificationData.items.map((item) => item.id === id ? { ...item, readAt: response.readAt || new Date().toISOString() } : item);
  notificationData.unreadCount = Number(response.unreadCount ?? Math.max(0, notificationData.unreadCount - 1)); updateNotificationCount(notificationData.unreadCount); renderNotifications();
  notificationChannel?.postMessage({ type: 'read-state-changed' });
};
const closeNotificationPanel = (restoreFocus = true) => { notificationPanel.hidden = true; notificationBell?.setAttribute('aria-expanded', 'false'); notificationPanel.setAttribute('aria-modal', 'false'); document.body.classList.remove('notification-panel-open'); if (restoreFocus) notificationBell?.focus(); };
const openNotificationPanel = async () => {
  if (!notificationBell) return; notificationPanel.hidden = false; notificationBell.setAttribute('aria-expanded', 'true');
  const mobile = window.matchMedia('(max-width: 768px)').matches; notificationPanel.setAttribute('aria-modal', mobile ? 'true' : 'false'); document.body.classList.toggle('notification-panel-open', mobile);
  notificationPanel.querySelector('#notification-panel-title').focus(); await loadNotifications(true);
};
notificationPanel.querySelector('.notification-panel-close').addEventListener('click', () => closeNotificationPanel());
notificationPanel.querySelectorAll('[data-notification-filter]').forEach((button) => button.addEventListener('click', () => { notificationFilter = button.dataset.notificationFilter; notificationPanel.querySelectorAll('[data-notification-filter]').forEach((item) => item.setAttribute('aria-pressed', String(item === button))); renderNotifications(); loadNotifications(false); }));
notificationPanel.querySelector('.notification-read-all').addEventListener('click', async (event) => {
  const button = event.currentTarget; button.disabled = true;
  try { const result = await api('/api/notifications', { method: 'POST' }); notificationData.items = notificationData.items.map((item) => ({ ...item, readAt: item.readAt || new Date().toISOString() })); notificationData.unreadCount = Number(result.unreadCount || 0); updateNotificationCount(notificationData.unreadCount); renderNotifications(); notificationChannel?.postMessage({ type: 'read-state-changed' }); }
  catch (_) { renderNotificationState('error', 'Не удалось отметить уведомления прочитанными.'); } finally { button.disabled = false; }
});
notificationBell?.setAttribute('aria-controls', 'notification-panel'); notificationBell?.setAttribute('aria-expanded', 'false'); notificationBell?.addEventListener('click', () => notificationPanel.hidden ? openNotificationPanel() : closeNotificationPanel(false));
document.addEventListener('pointerdown', (event) => { if (!notificationPanel.hidden && !notificationPanel.contains(event.target) && !notificationBell?.contains(event.target)) closeNotificationPanel(false); });
document.addEventListener('keydown', (event) => {
  if (notificationPanel.hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); closeNotificationPanel(); return; }
  if (event.key === 'Tab' && window.matchMedia('(max-width: 768px)').matches) { const controls = [...notificationPanel.querySelectorAll('button:not(:disabled):not([hidden]), a[href]')].filter((node) => node.getClientRects().length); if (!controls.length) return; const first = controls[0], last = controls[controls.length - 1], heading = notificationPanel.querySelector('#notification-panel-title'); if (event.shiftKey && (document.activeElement === first || document.activeElement === heading || document.activeElement === notificationPanel)) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === heading)) { event.preventDefault(); first.focus(); } }
});
notificationChannel?.addEventListener('message', () => { if (document.visibilityState === 'visible') loadNotifications(!notificationPanel.hidden); });
const refreshLeaderNotifications = () => {
  const role = portalUser.role;
  const hasNotificationPermission = (['owner', 'admin'].includes(role) && portalPermissions.has('finance_read') && portalPermissions.has('orders'))
    || (['owner', 'admin', 'manager'].includes(role) && portalPermissions.has('inventory_read'))
    || (['owner', 'admin', 'manager'].includes(role) && portalPermissions.has('orders'))
    || (['owner', 'admin'].includes(role) && (portalPermissions.has('staff_view') || portalPermissions.has('staff')));
  if (!headerNotificationRoles.has(role) || !hasNotificationPermission) { if (notificationBell) notificationBell.hidden = true; return; }
  if (notificationBell) notificationBell.hidden = false;
  if (document.visibilityState === 'visible') loadNotifications(false);
};
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadNotifications(false); });
const bindKpiNavigation = () => { const activate = (card) => { const route = card.dataset.kpiRoute; const target = card.dataset.kpiTarget; if (target) { document.querySelector(target)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); document.querySelector(target)?.focus?.({ preventScroll: true }); return; } if (route) window.location.href = route; }; document.querySelectorAll('[data-kpi-route], [data-kpi-target]').forEach((card) => { if (card.dataset.kpiBound === '1') return; card.dataset.kpiBound = '1'; card.setAttribute('role', 'button'); card.setAttribute('tabindex', '0'); card.addEventListener('click', () => activate(card)); card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(card); } }); }); };
const staticDemo = () => String(localStorage.getItem('crm_session_token') || '').startsWith('demo-static-');
const demoKey = 'territory_crm_demo_state';
const demoState = (() => { try { return JSON.parse(localStorage.getItem(demoKey)) || {}; } catch (_) { return {}; } })();
// Clear the old showcase workspace once for this browser while preserving recipes.
const demoResetKey = 'territory_crm_demo_reset_v1';
try {
  if (!localStorage.getItem(demoResetKey)) {
    ['staff', 'inventory', 'products', 'productCategories', 'reservations', 'movements', 'clients', 'discountGroups', 'discounts', 'audit', 'floorZones', 'floorLayout', 'floorNames', 'floorCapacities', 'floorStatuses', 'shift'].forEach((key) => { delete demoState[key]; });
    ['territory_crm_staff_orders', 'territory_crm_shift', 'territory_crm_discount_requests', 'territory_crm_demo_audits'].forEach((key) => localStorage.removeItem(key));
    localStorage.setItem(demoResetKey, 'pending');
    localStorage.setItem(demoKey, JSON.stringify(demoState));
  }
} catch (_) {}
const demoSave = () => localStorage.setItem(demoKey, JSON.stringify(demoState));
const demoReadOrders = () => { try { return JSON.parse(localStorage.getItem('territory_crm_staff_orders') || '[]'); } catch (_) { return []; } };
const demoDiscountOrderError = (request) => {
  const order = demoReadOrders().find((entry) => entry.id === request.orderId);
  if (order && !['closed', 'cancelled'].includes(order.status)) return null;
  const error = new Error('discount_not_found_or_decided');
  error.payload = { error: 'discount_not_found_or_decided' };
  return error;
};
const demoPaidOrderBalanceError = (request, allRequests) => {
  const orderError = demoDiscountOrderError(request);
  if (orderError) return orderError;
  const order = demoReadOrders().find((entry) => entry.id === request.orderId);
  const subtotal = (order.items || []).reduce((sum, item) => sum + Number(item.unitPrice || 0) * Number(item.quantity || 0), 0);
  const discount = allRequests.filter((entry) => entry.orderId === order.id && entry.status === 'approved' && entry.type === 'percent').reduce((sum, entry) => sum + subtotal * Math.min(100, Math.max(0, Number(entry.value || 0))) / 100, 0);
  const proposedDue = Math.max(subtotal - discount, Number(order.minimumOrderTotal || 0));
  const paid = (order.payments || []).filter((payment) => ['paid', 'partially_paid'].includes(payment.status)).reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  if (Math.round(paid * 100) <= Math.round(proposedDue * 100)) return null;
  const error = new Error('order_total_below_paid');
  error.payload = { error: 'order_total_below_paid', paid, proposedDue };
  return error;
};
const demoRecipeUnitAliases = { г: 'г', гр: 'г', грамм: 'г', грамма: 'г', граммов: 'г', кг: 'кг', килограмм: 'кг', килограмма: 'кг', мл: 'мл', milliliter: 'мл', миллилитр: 'мл', миллилитра: 'мл', л: 'л', liter: 'л', литр: 'л', литра: 'л', шт: 'шт', штука: 'шт', штуки: 'шт', порция: 'порция', порции: 'порция', уп: 'уп', упаковка: 'упаковка' };
const demoRecipeUnitFactors = { г: { г: 1, кг: 0.001 }, кг: { кг: 1, г: 1000 }, мл: { мл: 1, л: 0.001 }, л: { л: 1, мл: 1000 }, шт: { шт: 1 }, порция: { порция: 1 }, уп: { уп: 1 }, упаковка: { упаковка: 1 } };
const demoNormalizeRecipeUnit = (value) => demoRecipeUnitAliases[String(value || '').trim().toLocaleLowerCase('ru-RU')] || null;
const parseDemoRecipeQuantity = (value, targetUnit, fallbackUnit = null) => {
  const raw = String(value ?? '').trim().replace(',', '.'); const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*([a-zа-яё]+)?$/i);
  const amount = match ? Number(match[1]) : NaN;
  if (!match || !Number.isFinite(amount) || amount <= 0) return { error: 'invalid_recipe_quantity' };
  const sourceUnit = demoNormalizeRecipeUnit(match[2] || fallbackUnit || targetUnit); const normalizedTarget = demoNormalizeRecipeUnit(targetUnit);
  if (!sourceUnit || !normalizedTarget || !demoRecipeUnitFactors[sourceUnit]?.[normalizedTarget]) return { error: 'recipe_ingredient_unit_mismatch', sourceUnit: sourceUnit || match[2] || null, targetUnit: normalizedTarget || targetUnit || null };
  const factor = demoRecipeUnitFactors[sourceUnit][normalizedTarget];
  if (!Number.isFinite(amount * factor)) return { error: 'invalid_recipe_quantity' };
  return { amount, sourceUnit, targetUnit: normalizedTarget, factor };
};
const demoPendingSummary = (items = demoReadOrders()) => { const active = items.filter((order) => ['open', 'in_progress', 'ready'].includes(order.status)); const pendingRevenue = active.reduce((sum, order) => { const subtotal = (order.items || []).reduce((total, item) => total + Number(item.unitPrice || item.price || 0) * Number(item.quantity || 0), 0); const discount = Number(order.discountTotal || order.approvedDiscountTotal || 0); const due = Math.max(Number(order.minimumOrderTotal || 0), subtotal - discount); const paid = (order.payments || []).filter((payment) => ['paid', 'partially_paid'].includes(payment.status)).reduce((total, payment) => total + Number(payment.amount || 0), 0); return sum + Math.max(0, due - paid); }, 0); return { pendingOrders: active.length, pendingRevenue: Math.round(pendingRevenue * 100) / 100 }; };
const normalizeDemoPhones = (value) => { const seen = new Set(); const items = (Array.isArray(value) ? value : []).map((entry) => ({ label: String(entry?.label || 'Дополнительный').trim().slice(0, 32), number: String(entry?.number || '').trim(), primary: Boolean(entry?.primary) })).filter((entry) => { const key = entry.number.replace(/\D/g, ''); if (!key || seen.has(key)) return false; seen.add(key); return true; }); if (items.length) { const primary = items.findIndex((entry) => entry.primary); items.forEach((entry, index) => { entry.primary = primary < 0 ? index === 0 : index === primary; }); } return items; };
demoState.floorLayout ||= {};
demoState.staff ||= [{ id: 'demo-owner', name: 'Администратор', login: 'owner', password: 'demo', role: 'owner', active: true, permissionScopes: [] }, { id: 'demo-bartender', name: 'Мария', login: 'staff', password: 'demo', role: 'bartender', active: true, permissionScopes: [] }];
demoState.inventory ||= [{ id: 'demo-redbull', name: 'Red Bull', category: 'Холодильник', unit: 'шт', onHand: 24, minLevel: 10 }, { id: 'demo-coco', name: 'Уголь Coco Nara', category: 'Кальянная зона', unit: 'уп', onHand: 8, minLevel: 5 }, { id: 'demo-mint', name: 'Мята', category: 'Бар', unit: 'кг', onHand: 1.8, minLevel: 2 }];
demoState.products ||= [{ id: 'redbull', name: 'Red Bull', price: 250, aliases: ['red bull', 'ред булл', 'энергетик'], imageUrl: null }, { id: 'lemonade-maracuya', name: 'Лимонад Маракуйя', price: 300, aliases: ['лимонад', 'маракуйя'], imageUrl: null }, { id: 'hookah-darkside', name: 'Кальян — Darkside Blueberry', price: 1200, aliases: ['кальян', 'darkside'], imageUrl: null }, { id: 'energy-tiger', name: 'Tiger Energy', price: 220, aliases: ['тигр', 'энергетик tiger'], imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAAJ50lEQVR42u3dZ29lRxnA8eczULV9193rXu61b3G377V3XdZtvc273l3vBtFEE1U00URTGqlKI40U0kkjjZQlDQgkkFCSEEIgkFBCSeiCF5YQEpPE55yZOTPn/KXfF5j/PM+bW86R16ypAOApee2aCgCektetqQDgKXn9mkoAnpI3rKkE4Cl549pKAJ6SNWurAHhK1q6tAuApWbe2CoCnZP26agCekg3rqgF4SjatqwbgKdm8rgaAp2TL+hoAnpKK9TUAPCWV62sBeEqq19cC8JTUbKgF4Cmp3VAHwFNSt6EOgKekfkMdAE9Jw8Z6AJ6Sxo31ADwlTRvrAXhKmjduBeApadm0FYCnpHVTAwBPSfumBgCeko5NDQA8JZ2bGn10fFspHE/PCyhJZnOjR45vL+ni18EBJclubnTfCe0lc7woAChJ9+Yml53YXrbD8Q6AkuQ2N7nppPayfc7WAJQkv6XJNSd1lOPlYBNASQpbmt1xckfZHU6VAZSkuKXZEU5t7wp34gBK0rul2QVf6ii7yZE+gJL0VbTE65SOUffFXglQkv6Klhh5sb0r4g0FKMlARUtcTu0Y9UuMrQAlGaxojcVpHaM+iisXoCTDla32nd456q9YigFKMlLZapnX27vCfjRASUqVbZad0TnmO/vRACUpV7bZlIDtXWG5G6Ako1Vt1pzZOZYkNtMBSjJW1W5HwrZ3hbV6gJJsr2q346zOseSxVg9QkvGqdgsSub0r7AQElGSiusOCszPbkspOQEBJJqs7TEvw9q6w0BBQkqnqTtPOyWxLNgsNASWZru406tzMtjQwnRFQkpmaTqNSssCmMwJKMluTMee8zPb0MFoSUJK5mow5qVpgoyUBJZmvyZjz5cz29DBaElCShZqsIednxtPGXExASXbVZg25IDueNuZiAkqyuzZrSAoX2FxMQEn21HaZcGF2PJ0M9QSUZG9tlwmpXWBDPQElWazrMuGi7Hg6GeoJKMn+um4TLs5OpJOhnoCSHKjrNuEr2Yl0MtQTUJKlum4TUrvAhnoCSnKwPmfCJV0T6WSoJ6Akh+pzJqR2gQ31BJRkuT5nwqVdE+lkqCegJEfq8yZc1jWZToZ6AkpydGvehNQusKGegJIctzVvwuVdk+lkqCegJG/aWjAhtQtsqCegJG/eWjDhiq7JdDLUE1CStzQUTbiieyqdDPUElOStDUUTruyeSidDPQEleVtD0YTULrChnoCSvL2hx4SruqfSyVBPQEne0dhjwtW5qXQy1BNQknc29hiSwu01FxNQknc19hpyTW5H2piLCTtT59155d2NvYZcm9uRNuZiwv6keXF2eU9Trzmp2l6jJRHjdLkcQd7b1GfOdbnp9DBaEi4MlYM15H1NfeZ8LTedHkZLwp1xcqqJvL+pz6iUbK/pjCnHjb8c+UBTv1HX56bTwHTG1OLeX5l8sLnftOvz08lmoWEKMQCrIR9q7jfthvx0sllomCqMwerJh5sHLLgxP5NUdgKmB8MQiHykecCCm/IzSWUnYEowD0HJR1sG7Ejk9lqrl3gMRjjysZZBO27OzySPtXrJxmyEJh9vGbQmYTdkM12CJXJ7rU2IfKJl0Kav52eSwXK3pErMPMQ1J/LJ1iHLbinM+s5+tERKwCTEPi3yqdYhyxJwJfajJU9Kttf0wMinW4fsu7Uw669YiiWM1wPg1NjIZ1qHY3FbYdZHceVKEk+v3s3hkc+2Dcfl9sKsX2JslRjeXbrjIySfaxuJ0e2FOV/EGyoZPLpuXwZJPt82Eq87CnPui71SMnhx137NknyhbcQFzuZ2pE8CsLomhkq+2F5yxDeKc65xJ47vHLzcZIyWHN9ecsedxTl3OFXGa05da8IGTE5oL7km9rIONvEau2puzOTE9rKb7irO2+dsDX/Fco++iJ5XTuoou+zu4rwdjnfwl7Ub9FH0vHJyR9l9RiN6UcBTrKjp8ZNTOkY9ck9xXhe/Du4pjfeVVBELy6kdoz46VpwPx9PzpuqO0iZKZDmtcxQw4VjPPFYjSmQ5vXMM0O6bPTuxeqE7yxmdY4B27GQgoTvLmZ1jgF739uxEUOFSy1md2wC97utZQFDhUsvZmW2AXvf3LiCocKnlnMw2QCNWMbQQteXczHZAowd6FxBOiNpyXmY7oBF7GFqI2nJ+djugy4O9C4giaHC5IDsO6PKt3l2IImhwuTA7DujCBkYUNLhclB0HdPl27y5EETS4XNw1AWjxnb5diC5Qc7mkawLQ4qG+XYguUHO5tGsS0OKhvt2ILlBzuaxrEtDiu327EV2g5nJ59ySgBbunRaDm8tXuKUCL7/XtRnSBmsuV3VOAFg/37UZ0gZrLVd1TgBaP9O1GdIGay9W5HYAWj/TvQXSBmss1uR2AFt/v34PoAjWXa3M7AC3YPS0CNZfrctOAFj/o34PoAjWX6/PTgBaP9u9BdIGayw35aUALdk+LQM3lxvwMoMVj/XsRXaDmclN+BtCC3dMiUHO5uTADaPHDgb2ILlBzuaUwC2jxo4F9iC5Qc7m1MAto8eOBfYguUHO5rTALaMHuaRGoudxemAO0+MnAPkQXqLncUZwDdGH9IgoaXO4szgG6PD6wD1EEDS53FecBXZ4YWEQUQYPL3cV5QJcnBxYRRdDgck/PTkCjJwcXEU6I2nKsZyeg0U8HFxFOiNpyb89OQKOnBhcRTojacl/PAqDXU4P7EVS41HJ/7wKg188G9yOocKnlgd4FQC+2MYRwqeXB3l2Adk8P7sfqhe4svBMdJrCTgYTuLLxPGYY8M7QfqxElsvA6VhjyzNABrEaUyMLbHGHOL4YO4JVFLCy8zRHmsJ+vKmJhebh/D2DOL4cP4OVEzyu8igZGPTt8AC8nel7hVTQwjUVV0tJWHu3fCxj1q+El/D8tbeWxgb2Aab8eXsL/0hVWeBA+7GBp/0tjVeExvLDmueEl6E0qPMgT1jw/vAS9SeXxwX2ANc+PLKWZ9p7yxOAiYNNvRg6mk4mYwqMAYV8Kt9dQSeFJYojFb0cOpoe5jMKjTBCX340cSgOjDeXpof1AXH4/cijZTAeUnw8dAGKU4O21UE94HgJi98LIoeSxk074RzVckLDttdZNnh1eAhzxh9Jh31kuJvyrC075Y+mwv+znEv4aAtd4ur2xtJLnhg8CDvpT6bAvYqwkz48cBJz159Jhl8XeR1L1izZ46sXSYdc4UkZS8nM2JMCLpWUXONVEEv9bNiTMS6XluDhYQ14oHQJ89FJ52Q6XI0gCvjpHyv2lvGyCF2cXjz6sB17VX8vLUXh3XnH8Y3oAr0BeLC8D8JRY+yQAgHZi6AMAABbI38pHAHhK/j56BICn5B+jRwB4Sv45ehSAp+Rfo0cBeEr+PXYcAE/9B4cXlZ2qZMJBAAAAAElFTkSuQmCC' }, { id: 'lemonade-berry', name: 'Лимонад Лесные ягоды', price: 320, aliases: ['ягоды', 'лесные ягоды', 'лимонад'], imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAAJ1UlEQVR42u3dd5dV1RnH8ec1CIIgCNLLML3e6RV7wYZdEXsFpEiT3gYYYGhDkzJUqUaNiRpNYovRaNTUVxNXyloxHsycc/azz95nf9f6vIHz3fv3B9w758oV46YA8JSQAPB5wOOnAvCUXDGhCICnZNDEIgCekkGTpgHwlAyaXAzAUzJoSjEAT8ngqSUAPCWDi0oBeEoGTysF4CkZXFwGwFNyZXE5AE/JlSXlADwlV5ZWAPCUDCmrBOApGVJeCcBTMqSiCoCnZEhlNQBPydCqagCekqHVNQA8JUNragF4SobW1gLwlFxVVwfAU98PuADAU3JVoQDAUzKsvh6Ap2RYQwMAT8mwxgYAnpJhTY0+Kl4zJxlPnxeIJMObmzySeLc/5teDA5FkeEuz+4rXztXjRQEgkgxvbXaZ6nR/MGO3OwCRZHhbi5uK1821z9kaQCS5ur3VNSXr5mXLwSZAJLm6o9UdJevnucOpMkCk7wfc5gin1vufDbcBLpMRne0uKNnwspsc6QNEkhFd7dlydro/mHHWlYBIMmJ6R4ZKNs73RbahgEgy4rrOrHi03n9vOLtWQCQZeX1nJko3zfdRVrmASDLyhi77Sjct8FcmxYBIMvLG6ZaVdi/wnf1oQCQZedN0y/IwYOvRgEhyzc3X2VS6eWE+WO4GRJJrbrnemtItC/PEZjogkrBeNgyPBzzq1hvsKNuyKH+s1QMiyajbbrSgbOuivLITEIgko26/0YI8D9hKQCCSjJpxk7aynlfyzUJDIJKMvuNmbeU9i/PNQkMgkoy+82ZV5dsWh0A7IxBJRt91i6pQBqycEYgko+++VU/59iXhUC0JRJJr77lVT1ADVi0JRJJrZ96mp3zHknColgQiybX33q6kvHdpaPRiApFkzL0zlFT0Lg2NXkwgkoy5b4aSEAesFhOIJGPuv0NDxc5lYVLqCUSSMQ/cqSHcAev0BCLJ2Afv1FCxa1mYlHoCkWTsQ3dpqNi1PExKPYFIMvbhuzVU7F4eJqWeQCQZ+8jdGsIdsE5PIJKMe/QeDZV7Xg2TUk8gkoybNVND5d4VYVLqCUSScY/N1BDugHV6ApFk3Ox7NVT2rQiTUk8gkoyffZ+Gyr6VYVLqCUSS8Y/fpyHcAev0BCLJ+Cfu11C5b2WYlHoCkWTCkw9oqNq3KkxKPYFIMuGpBzRU7V8VJqWeQCSZ8PSDGsIdsE5PIJJMeOYhDVUHVodJqScQSSY++5CGYAes1BOIJBOfe1hD1cHVYVLqCUSSic8/oqTq0JrQ6MUEIsnEFx5REuKA1WLCzq3z7nll0guPKqk+tDY0ejFh/6Z58ewy6cVZeqpfWxsO1ZLI8Ha5HEEmvTRLT1gD1iwJFy6VgzVk8pzH9FQfXhcO1ZJw5zo51UQmz52tKpT1KmcMHCd+OTJ53uOqqo+sD4F2xmBx7j9NJr/8uLb8r1e/YYC4AAMhU+Y/oa3m6Pp8s9AwKFyDgZMpC560oObYhryyEzAcXIZYZMrCJy3I84CtBAwE9yEumbLoKTtq+jfkj7V6ucfFSEamvvK0HbX9G/PHWr18424kJpwT62W9/t4Qmbr4GZtqj2/MB8vd8io39yGreyJFS561rPb4Jt/Zj5ZLObgJmd8WKVr6rGW1Jzb5zn60/MnBNXDhwkjRsufsqz3R7a9MiuWM1xfAqWsjRcufz0TtyW4fZZUrTzw9ejcvj0x79fms1J3s9kuGrXLDu0N3/ArJtBUvZKju1GZfZBsqHzw6bl8ukkxb+WK26k5vdl/mlfLBi7P26y7JtFUvusDd3G70yQGmq3GppHj1S46oO7PFNe7E8Z2Dh5uPqyXFa+a4w63ELpXxGnPVu2DCeTNdBuzxgEvWznVT4fWt9jlbw1+ZnKMv0ueVknXzXGYvpdsd/MVKVW+dlKyf577C2a16vCjgKdWDy4eUhaVkw8seKZztMcWvB/eUwfPKq5SFpXTjfB8Vzm1LxtPnDeqMQpMmspRumg9oKJzfhoFIE1lKuxcAxjHLeBtO2llKNy8EjCtc2I6BS9xZyrYsAsyqv7AdcSVLLWVbFwFm1V/cjriSpZaynlcAs+ov7kBcyVJLec9iwCCmmFiC2lK+bTFgUP2lHUgmQW0p374EMKj+Ui+SSVBbyncsBUypf6MXacQNLhW9SwFTGt7oRRpxg0vFzmWAKQ0/24k04gaXil3LAVMa3tyJNOIGl4rdywEjmJ+ZDcdpLpV7XgWMaHxrF9KL1Vwq964AjGh8azfSi9VcKvtWAEY0vr0b6cVqLlV9KwEj2J4RsZpL1b5VgBGNb+9BerGaS9X+VYARjT/fg/RiNZeqA6sBI9iemQHHaS7VB9cARjS9sxfpxWou1YfWAEY0/WIv0ovVXKpfWwsYwfbMDDhOc6k+vA4woumXfUgvVnOpObIOMILtGRGrudQcXQ8Y0fRuH9KL1Vxqjm0AjGh6dx/Si9Vcavo3AEY0vbcP6cVqLrX9GwEjmt/bj/RiNZfa45sAI9iemQHHaS61J7oBI5rfP4D0YjWXupPdgBFsz4hYzaXu1GbAiOZfHUB6sZpL3ektgCnNHxxEGnGDS92ZLYApLDDtgGMGl8LrWwFTWj48iDTiBpfC2R7AlJYPDyGNuMGlcK4HMKjl14eQTILaUji/DTCIHSYfcPzaUn9hO2BQy29eQzIJajNgsGFf1/vPAV/cAZjFGpMMOFFqabjUC5jV+tvDiCtZauE30aGh9aPDGLjEnYXfRIeG1o+OYOASd5aGN3cBGlo/PoKBSBNZ+D1lKGGZA5QmsvBrjtDT+slR/LSUhYXfkoIe9vn/B5yusDS+swfQ0/rpUVxO+rzCT9FAVdunx3A56fN+P+A+QBVDvcx6DbQVfooG2to+O4YfM9JWmt/dB2hr/6wf/81UWOE92rCj/Xf9+BeDVaX5/f2AHe2f98NsUuE1vLCm/fPjMJtUWj44CFjT/vsTITPeU3gPICwLd70KMYU3icG+9i9OhEappPAqE2Si/YuT4dDLKLzKBFnp+PJkCFQbCm8zQYbyv17lgMLbTJCtji9P5ZWFetL28VEgWx1/OJU/dtJJ2ydHgcx1fHUqT6x1E/6qC+7o+Oq07ywXk7bP+gF3dHx92l/2cwl/GgLXdH592keZtBK+XA43df7xjC8yrCSBf7kcjnN9uln3kQC/lQrvdH5zxjWOlJFAvs6GHOj85nUXONVEcvkZOnKs89uzWXGwhuTsA3SEw95uHY4gnV+dBrzW9e1ZDV48u3R+fQbIja7vzqXh3fOKR5+2Afgf4sj/7AFIQJT+/QDAAun67iwAT0nXn84B8JR0/fk8AE/J9L+cB+Apmf7XCwA8JdP/dhGAp+S6v18C4Kl/ACLiNvPRXbgrAAAAAElFTkSuQmCC' }, { id: 'hookah-mint', name: 'Кальян — Mint Mix', price: 1100, aliases: ['кальян', 'мята', 'mint'], imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAAKAklEQVR42u3d95cW1R3H8e8fgTUGkV4s9M4WtrF9Fxa2V3rvHUGwgFQ15aQpCqLYjaCxYsOCBU2MJibRYKKpmhhjQupJ5hx/yYkjZ2fm3jv3zn2f8/oHnvd8P7/APs9Izx5DAThKevYYBsBRcmGP4QAcJReeNQKAo6TXWSMBOEp6nT0KgKPkorNHA3CU9D57DABHSe9zxgJwlPQ5ZxwAR0mfc8cDcJT0PXcCAEcFA54IwFHS77xJABwl/c/LAeAo6X9+LgBHyYDz8wA4KhhwPgBHycAvTQbgqGDABQAcJYMuKATgKBl8QREARwUDLgbgKBny5RIAjgoGPAWAo+TinmUAHCWX9CwH4KhgwBUAHCWXXlgJwFHBgKtc1JRzYzyOfl4glFzWq9ohzTk3qeLWBwdCBQOusZ/C3YYtuQZwlAztVWuz5pz9ZljeAQglwy6aaqeW3P3mWVsDCBUMeJptWnJvTpeFTYBQMrx3nT1Sn+7/sqoMECoY8HRLtOTeYht74gChZETvGTZozT1gJ0v6AKFkRJ/6dLXmHbBf6pWAUDKyT0OKWvMOuiLdUEAoGdW3MS1teQfdkmIrIFQw4KZUtOXd6qK0cgGhZHTfZvMcXe9nUikGhJLR/VoMa8s/5Drz0YBQMqZfq2Ht+YdcZz4aEErG9m8zqSP/tmww3A0IFQy43ZiO/NuzxGQ6IJSM699hRsbW+xlj9YBQMm5Apxkdkw9nj7F6QCgZP6DLgM7Jh7PKTEAglIwfOMuAzoI7sspMQCCUTBg4W7fOgjuzzUBDIJRMHDhHt66CO7PNQEMglEwcNFerroK7fKA7IxBKJg2ap5UnA9adEQglkwbP16er8G5/aC0JhJKcwQv0mVl4jz+0lgRCBQNeqI9nA14IGCa5QxZpMrPwXt/oiwmEkrwhizWZVXivb/TFBEJJ3sVLNJlVdJ9v9MUEQkn+xUt1mF10n5809QRCBQNepsPsovv9pKknEEomX7JcB28HrKknECoY8AodZhd910+aegKhpODSlTrMKX7AT5p6AqGk8NJVOng7YE09gVDBgFfrMKf4iJ809QRCSdFla3SYW3zET5p6AqGCAa/VYW7xUT9p6gmEkuKh63SYW3LUT5p6AqGkZOh6HeaVPOgnTT2BUMGAN+jg8YA3AMbIlGEbdZhX8pCfNPUEQgUD3qSDxwPeBBgjpcM36zB/ysN+0tQTCBUMeIsOHg94C2CMlA2/Qof5Ux7xk6aeQCgpH7FVhwWlj/hJU08gVDDgbTosKH3UT5p6AqGkYuSVmiwsfdQ3+mICoYIBX6XJwtLHfKMvJsxcnXOfVypHXq2JhwPWFxPmL82Jzy6Vo67RZ2HZ4/7QWhIpXpfNEaRq1HZ9FpU94Q+tJWHDUVlYQ6pH79DHqwFrLQl7zsmqJsGAr9VqUdkxH+jO6Dme+BeRmtE7tVpcdswHujN6i+d+ZlIzZpdui8ufzDYDDT3EAXSH1I7ZrVvmB2ygoVc4g+6TqWP3GLCk/KmsMhPQHxxDJMGA9xqQ6QHvBXeS1j3ItLH7zFhS/nT2GKuXeRxGPDJt3HVmLKl4OnuM1cs2biM2qRt3vTFLK57JEpPpMixjV2H4QqRu/A0mLa14NhsMd8uqzNxDWnci08d/xbBlFc+6zny0TMrAJaR+LTJj/FcNW1Zx3HXmo2VPBs7AhoORGRO+Zt6yyuPuSqVYxjh9AFadjdRP+Hoqllc+56K0cmWJo4/ezuOR+onfSMvyqufdkmKrzHDuoVt+QtIw8Zspcih9uqGywfP16jgkaZj0rXQtr3rBfqlXygYnnrVbtySNk75tgxVVL9rJkj4ZYO0jdvqopGnSdyxhYWh74riO0Wo6LWnKudEeK6pP2MOqMk6z6rFm7MCkOecm26ysPpEuC5s4LfUHaiclbaU5d7+dVla/ZJ61NdyVynN0RfK80pJ7s82MpbS8g7tYqdarCwZ8i/1WVr+sjxMFHKX1wWVDwsLSmnfAIatqXlbFrQ/uKIXPK6sSFpa2vIMuWlXzSjyOfl6vnpFvkkSWtvxbAR1YZncHnCCytOcfApRbXfMqui9252DAtwHKra45ie6L3Vk6Jt8OqLWm9iSiipdaOicfBtRaU/saooqXWjoL7gDUYo1xBhwrtXQV3AkotLb2dcQTo3Yw4LsAhdhhggFHri0zC+8GFFo79fuIJ0btYMD3AKowwsQbjhZcZhXdC6iybuoPkETU4DK76D5AlXVT30ASUYMHA74fUIUFJh5wtOAyp/gBQIn1036I5CI1DwZ8BFBi/bQ3kVyk5jK35CigxPq6N5FcpObBgB8ElFhf9xaSi9Rc5pU8BCixoe4tJBepucyf8j1AiY11P0JykZoHA34YUILtKRpwhOayoPQRQImN03+M5CI1Dwb8KKDExulvI7lIzWVh6WOAEpumv43kIjWXRWWPA0psmv4TJBepeTDgJwAl2J6iAUdoLovLjwFKXD7jp0guUvNgwE8CSrA9RQOO0FyWlD8FKHH5jJ8huUjNZUnF04ASbE/NgKM0l6UVzwBKbJ7xDpKL1FyWVT4LKLG5/l0kF6l5MODjgBJsT9GAIzSX5ZXPAUpsqf85kovUXJZXPQ8owfbUDDhKc1lR9QKgypb6U0gianBZUf0ioMqWhlNIImpwWVl9AlDliob3kETU4LKq+iVAla0N7yGJqMFlVc0rgEJbG3+BeGLUltU1rwIKbW38JeKJUVtW154EFNra+D7iiVFb1tS+Bqi1rfF9RBUvdTDg1wG1tjV+gKjipRbeiQ7ltjV9gKjipRbeiQ4drmz6FbovdmdZN+0NQDk2GW3AcTsL71OGJlc2/RrdkSSy8D5laMIyuz3g+JGFtzlCn6uaf4MzS1hYeBkc9Lmq+bc4s4SFhZfBQSsmeqb1Js4rvEsKWl3d/Dt8keR5hVfRQDeG+gXrVdBWeJMFdLum5ff4PCVthR/ChwHM9XPrVRNWNte/AxhwTcuH+IzCqrKl/l3AjO0tH0JtUuFneGHM9paPoDapXNFwCjBme+tHPlPeU/ghTxi2vfUPftIRU/gpQJi3o/WPvtFUUvgpQKTCs/Xqyij8mBjSsqP1Yx9obSj8GAJSdG3bn7JNd0Dh69RIV6bXq72e8I1qpO7a9k+yx0w64TuZsEHm1muom/CtLthjZ/ufXWe4mPC9EFhlZ/un7jKfS/hqCGzj7HpTaCWe/20qrLWr4y+uSLGSePuHqXCC9dNNuY94+FepcM7ujr/axpIysqPtY8AJtkzXpiaS+b9lQ8bs7jidFgtryM72TwAX7ek8bYbNESQD/3UOz+3p/JsOTnx22dX+KZAZCUfr3OcVh/63DcD/EQv/gR5AN8nuztMAHCWa/gEAgAGyt/PvABwle7v+AcBRsq/rnwAcJftm/guAo+S6mf8G4Ci5ftZ/ADjqv0IBuCyB6L7yAAAAAElFTkSuQmCC' }];
const importedCatalogProducts = Array.isArray(window.CRM_CATALOG_SEED?.products) ? window.CRM_CATALOG_SEED.products : [];
if (importedCatalogProducts.length && localStorage.getItem(demoResetKey) !== '1') { const existingIds = new Set((demoState.products || []).map((item) => item.id)); importedCatalogProducts.forEach((item) => { if (!existingIds.has(item.id)) demoState.products.push({ ...item }); }); }
demoState.inventoryDepartments ||= [{ id: 'kitchen', code: 'kitchen', name: 'Кухня', description: 'Продукты, заготовки и блюда', color: 'coral', sortOrder: 10, active: true }, { id: 'bar', code: 'bar', name: 'Бар', description: 'Напитки, сиропы и чай', color: 'amber', sortOrder: 20, active: true }, { id: 'hookah', code: 'hookah', name: 'Кальяны', description: 'Табак, уголь и расходники', color: 'violet', sortOrder: 30, active: true }, { id: 'inventory', code: 'inventory', name: 'Хозяйственный склад', description: 'Расходники и инвентарь', color: 'green', sortOrder: 40, active: true }];
demoState.productCategories ||= [{ id: 'demo-product-category-soft', name: 'Безалкогольные напитки', department: 'bar', active: true }, { id: 'demo-product-category-alcohol', name: 'Алкогольные напитки', department: 'bar', active: true }, { id: 'demo-product-category-tea', name: 'Чай и кофе', department: 'bar', active: true }, { id: 'demo-product-category-kitchen', name: 'Продукты и заготовки', department: 'kitchen', active: true }, { id: 'demo-product-category-hookah', name: 'Табак и смеси', department: 'hookah', active: true }, { id: 'demo-product-category-inventory', name: 'Расходники и инвентарь', department: 'inventory', active: true }];
const importedProductCategoryNames = [...new Set((window.CRM_CATALOG_SEED?.products || []).map((item) => String(item.category || '').trim()).filter(Boolean))];
if (localStorage.getItem(demoResetKey) !== '1') for (const name of importedProductCategoryNames) if (!demoState.productCategories.some((item) => item.name === name)) demoState.productCategories.push({ id: 'seed-category-' + name.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').slice(0, 32), name, active: true });
demoState.recipes ||= (window.CRM_CATALOG_SEED?.recipes || []).map((recipe, index) => ({ ...recipe, id: recipe.id || `demo-recipe-${index + 1}` })); demoState.products.forEach((product) => { if (!product.inventoryMode) { const linked = demoState.recipes.some((recipe) => recipe.active !== false && recipe.recipeType !== 'premix' && (String(recipe.productId || '') === String(product.id) || (!recipe.productId && String(recipe.name || '').trim().toLocaleLowerCase('ru-RU') === String(product.name || '').trim().toLocaleLowerCase('ru-RU') && demoState.products.filter((candidate) => String(candidate.name || '').trim().toLocaleLowerCase('ru-RU') === String(product.name || '').trim().toLocaleLowerCase('ru-RU')).length === 1))); product.inventoryMode = linked ? 'tracked' : 'needs_review'; } }); demoState.reservations ||= []; demoState.movements ||= []; demoState.clients ||= [{ id: 'demo-client-anna', guestStatus: 'regular', name: 'Анна Смирнова', phoneNumbers: [{ label: 'Основной', number: '+79991112233', primary: true }], telegram: '@anna_sm', tobaccoPreferences: ['Darkside', 'Мята'], bowlPreferences: ['Кальянная чаша'], barPreferences: ['Лимонад маракуйя', 'Red Bull'], allergies: '', notes: 'Предпочитает среднюю крепость', loyaltyPoints: 420, visits: 6, totalSpent: 18400, lastVisitAt: '2026-09-18T21:30:00.000Z' }, { id: 'demo-client-igor', guestStatus: 'vip', name: 'Игорь Волков', phoneNumbers: [{ label: 'Основной', number: '+79994445566', primary: true }, { label: 'Рабочий', number: '+79997778899', primary: false }], telegram: '', tobaccoPreferences: ['Tangiers', 'Ягодные миксы'], bowlPreferences: ['Калауд'], barPreferences: ['Кола', 'Виски'], allergies: 'Орехи', notes: '', loyaltyPoints: 180, visits: 3, totalSpent: 9200, lastVisitAt: '2026-09-12T20:10:00.000Z' }]; demoState.discountGroups ||= [{ id: 'none', name: 'Без скидки', discountPercent: 0, bonusPercent: 0, depositMin: 0, active: true }, { id: 'regular', name: 'Постоянный гость', discountPercent: 5, bonusPercent: 1, depositMin: 0, active: true }, { id: 'vip', name: 'VIP', discountPercent: 10, bonusPercent: 2, depositMin: 3000, active: true }]; demoState.audit ||= []; demoState.discounts ||= [{ id: 'demo-discount-1', orderId: 'demo-order-1522', type: 'percent', value: 10, reason: 'Компенсация ожидания', status: 'requested', requestedBy: 'Мария', createdAt: new Date().toISOString() }];
if (localStorage.getItem(demoResetKey) === 'pending') {
  demoState.staff = (demoState.staff || []).filter((person) => person.role === 'owner');
  demoState.inventory = []; demoState.products = []; demoState.productCategories = []; demoState.reservations = []; demoState.movements = []; demoState.clients = []; demoState.discountGroups = []; demoState.discounts = []; demoState.audit = []; demoState.floorZones = []; demoState.floorLayout = {}; demoState.floorNames = {}; demoState.floorCapacities = {}; demoState.floorStatuses = {}; demoState.shift = null; demoState.networkVenues = []; demoState.networkCurrentId = null;
  demoSave(); localStorage.setItem(demoResetKey, '1');
}
demoState.shift ||= null;
const nonCrmStaffRoles = ['cleaner', 'security', 'technician', 'other_staff']; const demoStaffManager = () => portalPermissions.has('staff_manage'); const demoCanManageVenue = () => ['owner', 'admin', 'developer'].includes(portalUser.role); const demoCanAssignStaffRole = (role) => portalUser.role === 'owner'; const demoCanCreateStaffRole = (role) => portalUser.role === 'owner' || (portalUser.role === 'admin' && ['senior_bartender','senior_hookah_master','bartender','hookah_master','cleaner','security','technician','other_staff'].includes(role));
const demoDiscountError = (code) => Object.assign(new Error(code), { payload: { error: code } });
const demoDiscountVenueId = () => String(demoState.networkCurrentId || demoDefaultVenue.id);
const demoDiscountGroupsForVenue = () => (demoState.discountGroups || []).filter((group) => (group.venueId || demoDefaultVenue.id) === demoDiscountVenueId());
const demoDiscountCanManage = () => ['staff_manage', 'finance', 'loyalty'].some((permission) => portalPermissions.has(permission));
const demoDiscountCanRead = () => ['staff', 'staff_view', 'staff_manage', 'finance', 'orders', 'loyalty'].some((permission) => portalPermissions.has(permission));
const demoSensitiveStaffManager = () => portalPermissions.has('staff_sensitive');
const demoStaffPublic = (person) => { const result = { ...person, permissionScopes: Array.isArray(person.permissionScopes) ? person.permissionScopes : [] }; delete result.password; if (!demoSensitiveStaffManager()) delete result.passportData; return result; };
const demoDefaultVenue = { id: 'demo-venue-territory', name: 'Hookah POS', format: 'кальян-бар', city: 'Тюмень', address: 'ул. Пермякова, 77, этаж -1', phone: '+7 (996) 641-95-10', phoneNumbers: [{ label: 'Основной', number: '+7 (996) 641-95-10', primary: true }], timezone: 'Asia/Yekaterinburg', status: 'active', isCurrent: true, logoUrl: null };
const demoDefaultVenueRecord = () => { const record = { ...demoDefaultVenue, ...(demoState.venue || {}), id: demoDefaultVenue.id, status: 'active', isCurrent: !demoState.networkCurrentId || demoState.networkCurrentId === demoDefaultVenue.id }; record.phoneNumbers = normalizeDemoPhones(record.phoneNumbers || (record.phone ? [{ label: 'Основной', number: record.phone, primary: true }] : [])); record.phone = record.phoneNumbers.find((entry) => entry.primary)?.number || ''; return record; };
const demoSelectedVenue = () => { const currentId = demoState.networkCurrentId || demoDefaultVenue.id; if (currentId === demoDefaultVenue.id) return demoDefaultVenueRecord(); const selected = (demoState.networkVenues || []).find((item) => item.id === currentId && item.status !== 'archived'); return selected ? { ...selected, isCurrent: true } : demoDefaultVenueRecord(); };
const demoFloorContext = () => { const venueId = demoSelectedVenue().id; if (venueId === demoDefaultVenue.id) return { venueId, state: demoState }; demoState.floorByVenue ||= {}; demoState.floorByVenue[venueId] ||= { floorZones: [], floorLayout: {}, floorNames: {}, floorCapacities: {}, floorStatuses: {} }; return { venueId, state: demoState.floorByVenue[venueId] }; };
const demoFloorPrecondition = (input, venueId) => { if (!input.expectedVenueId) throw demoDiscountError('venue_precondition_required'); if (String(input.expectedVenueId) !== venueId) throw demoDiscountError('venue_context_changed'); };
const demoScenarioBackupKey = 'territory_crm_demo_scenario_backup_v1';
const demoScenarioActiveKey = 'territory_crm_demo_scenario_active';
const createRichDemoScenario = () => {
  const day = (offset, hour = 21, minute = 0) => { const value = new Date(); value.setDate(value.getDate() + offset); value.setHours(hour, minute, 0, 0); return value; };
  const dateKey = (value) => [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
  const iso = (offset, hour = 21, minute = 0) => day(offset, hour, minute).toISOString();
  const staff = [
    { id: 'demo-owner', name: 'Юрий Назаров', login: 'owner', password: 'demo', role: 'owner', active: true, permissionScopes: [] },
    { id: 'demo-manager-anna', name: 'Анна Белова', login: 'manager-demo', password: 'demo', role: 'manager', active: true, permissionScopes: [] },
    { id: 'demo-admin-alex', name: 'Алексей Морозов', login: 'admin-demo', password: 'demo', role: 'admin', active: true, permissionScopes: [] },
    { id: 'demo-bartender-maria', name: 'Мария Соколова', login: 'staff', password: 'demo', role: 'bartender', active: true, permissionScopes: [] },
    { id: 'demo-hookah-ivan', name: 'Иван Петров', login: 'hookah-demo', password: 'demo', role: 'hookah_master', active: true, permissionScopes: [] },
    { id: 'demo-bartender-oleg', name: 'Олег Смирнов', login: 'bartender-demo', password: 'demo', role: 'bartender', active: true, permissionScopes: [] },
    { id: 'demo-inactive', name: 'Дмитрий Козлов', login: 'inactive-demo', password: 'demo', role: 'hookah_master', active: false, permissionScopes: [] }
  ];
  const table = (id, name, capacity, x, y, status = 'free', minimumOrderTotal = 0) => ({ id, name, capacity, minCapacity: Math.max(1, capacity - 1), maxCapacity: capacity, status, minimumOrderTotal, layout: { x, y, width: 150, height: 82, shape: 'rectangle', rotation: 0 } });
  const floorZones = [
    { id: 'demo-hall', name: 'Основной зал', sortOrder: 0, tables: [table('demo-table-1', 'Стол 1', 2, 30, 30, 'occupied'), table('demo-table-2', 'Стол 2', 4, 220, 30), table('demo-table-3', 'Стол 3', 4, 410, 30, 'reserved'), table('demo-table-4', 'Стол 4', 6, 30, 150), table('demo-table-5', 'Стол 5', 2, 220, 150, 'occupied'), table('demo-table-6', 'Стол 6', 4, 410, 150), table('demo-table-7', 'Стол 7', 4, 30, 270), table('demo-table-8', 'Стол 8', 6, 220, 270, 'blocked')] },
    { id: 'demo-vip', name: 'VIP-комнаты', sortOrder: 1, tables: [table('demo-vip-1', 'VIP-комната 1', 8, 30, 30, 'occupied', 3000), table('demo-vip-2', 'VIP-комната 2', 12, 220, 30, 'free', 5000)] },
    { id: 'demo-terrace', name: 'Терраса', sortOrder: 2, tables: [table('demo-terrace-1', 'Терраса 1', 4, 30, 30), table('demo-terrace-2', 'Терраса 2', 4, 220, 30, 'reserved'), table('demo-terrace-3', 'Терраса 3', 6, 410, 30)] }
  ];
  const inventory = [
    { id: 'demo-ing-mint', name: 'Мята свежая', shortName: 'Мята', category: 'Зелень и фрукты', department: 'bar', itemType: 'ingredient', unit: 'кг', purchaseUnit: 'кг', packMultiplier: 1, cost: 680, onHand: 0.4, minLevel: 1, supplier: 'Фермерский рынок' },
    { id: 'demo-ing-cola', name: 'Кола', category: 'Безалкогольные напитки', department: 'bar', itemType: 'ingredient', unit: 'л', purchaseUnit: 'бутылка', packMultiplier: 1.5, cost: 95, onHand: 3, minLevel: 3, supplier: 'Торг-Сервис' },
    { id: 'demo-ing-whisky', name: 'Виски купажированный', category: 'Крепкий алкоголь', department: 'bar', itemType: 'ingredient', unit: 'мл', purchaseUnit: 'бутылка', packMultiplier: 700, cost: 1.8, onHand: 4200, minLevel: 1400, supplier: 'Бар-Поставка' },
    { id: 'demo-ing-ice', name: 'Лёд пищевой', category: 'Заморозка', department: 'bar', itemType: 'ingredient', unit: 'кг', purchaseUnit: 'пакет', packMultiplier: 2, cost: 120, onHand: 5, minLevel: 2, supplier: 'Торг-Сервис' },
    { id: 'demo-ing-coal', name: 'Уголь кокосовый', category: 'Кальянный цех', department: 'hookah', itemType: 'ingredient', unit: 'шт', purchaseUnit: 'коробка', packMultiplier: 72, cost: 5, onHand: 18, minLevel: 36, supplier: 'Кальян-Трейд' },
    { id: 'demo-ing-tobacco', name: 'Табак ягодный', category: 'Табак', department: 'hookah', itemType: 'ingredient', unit: 'г', purchaseUnit: 'банка', packMultiplier: 100, cost: 4.2, onHand: 640, minLevel: 200, supplier: 'Кальян-Трейд' },
    { id: 'demo-ing-cup', name: 'Чаша глиняная', category: 'Расходные материалы', department: 'hookah', itemType: 'product', unit: 'шт', purchaseUnit: 'коробка', packMultiplier: 12, cost: 180, onHand: 9, minLevel: 4, supplier: 'Кальян-Трейд' },
    { id: 'demo-premix-berry', name: 'Премикс ягодный', category: 'Заготовки', department: 'bar', itemType: 'premix', unit: 'мл', cost: 0, onHand: 1200, minLevel: 500, supplier: '' },
    { id: 'demo-ing-lime', name: 'Лайм', category: 'Зелень и фрукты', department: 'bar', itemType: 'ingredient', unit: 'кг', cost: 420, onHand: 2.3, minLevel: 1, supplier: 'Фермерский рынок' }
  ];
  const products = [
    { id: 'demo-product-cola-whisky', name: 'Виски-кола', category: 'Коктейли', station: 'bar', price: 520, aliases: ['виски', 'кола'], imageUrl: null },
    { id: 'demo-product-berry-lemonade', name: 'Лимонад ягодный', category: 'Лимонады', station: 'bar', price: 390, aliases: ['ягода', 'лимонад'], imageUrl: null },
    { id: 'demo-product-hookah', name: 'Кальян на чаше', category: 'Кальяны', station: 'hookah', price: 1450, aliases: ['кальян'], imageUrl: null },
    { id: 'demo-product-tea', name: 'Чайник чая', category: 'Чай', station: 'bar', price: 480, aliases: ['чай'], imageUrl: null },
    { id: 'demo-product-water', name: 'Вода минеральная', category: 'Вода', station: 'bar', price: 250, aliases: ['вода'], imageUrl: null },
    { id: 'demo-product-snack', name: 'Фруктовая тарелка', category: 'Закуски', station: 'kitchen', price: 650, aliases: ['фрукты'], imageUrl: null }
  ];
  const productById = Object.fromEntries(products.map((item) => [item.id, item]));
  const productUnitCost = { 'demo-product-cola-whisky': 115, 'demo-product-berry-lemonade': 85, 'demo-product-hookah': 420, 'demo-product-tea': 92, 'demo-product-water': 75, 'demo-product-snack': 245 };
  const guestRefs = [{ id: 'demo-client-vip', name: 'Екатерина Орлова', phone: '+79991234567' }, { id: 'demo-client-regular', name: 'Сергей Волков', phone: '+79997654321' }, { id: 'demo-client-new', name: 'Алина Крылова', phone: '+79990001122' }, { id: 'demo-client-inactive', name: 'Максим Романов', phone: '+79998887766' }];
  const makeOrder = (id, status, offset, tableId, staffName, selections, paymentMethod = 'card', paidRatio = 1) => {
    const items = selections.map(([productId, quantity]) => ({ productId, name: productById[productId].name, station: productById[productId].station, quantity, unitPrice: productById[productId].price, unitCost: productUnitCost[productId], price: productById[productId].price }));
    const total = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    const paid = Math.round(total * paidRatio);
    const minutesAgo = 35 + (Number(String(id).match(/\d+$/)?.[0] || 0) % 5) * 35;
    const createdAt = offset === 0 ? new Date(Date.now() - minutesAgo * 60_000).toISOString() : iso(offset, 20 + (Number(id.slice(-1)) % 3), 10);
    const closedAt = status === 'closed' ? (offset === 0 ? new Date(new Date(createdAt).getTime() + 12 * 60_000).toISOString() : iso(offset, 22, 45)) : null;
    const payments = paid > 0 ? [{ id: `${id}-payment-1`, method: paymentMethod, amount: paid, status: paidRatio === 1 ? 'paid' : 'partially_paid', shiftId: offset === 0 ? 'demo-shift-open' : null, createdAt: closedAt || createdAt }] : [];
    const guest = guestRefs[Number(String(id).match(/\d+$/)?.[0] || 0) % guestRefs.length];
    return { id, orderNumber: id.replace('demo-order-', ''), orderType: 'regular', tableId, tableName: floorZones.flatMap((zone) => zone.tables).find((entry) => entry.id === tableId)?.name || tableId, zoneName: floorZones.find((zone) => zone.tables.some((entry) => entry.id === tableId))?.name || '', status, items, subtotal: total, finalTotal: total, total, discountTotal: 0, payments, clientId: guest.id, createdBy: staff.find((person) => person.name === staffName)?.id || null, createdByName: staffName, waiterName: staffName, guestName: guest.name, guestPhone: guest.phone, notes: status === 'ready' ? 'Гости скоро вернутся к столу' : '', createdAt, updatedAt: closedAt || createdAt, closedAt, closedInShiftId: status === 'closed' && offset === 0 ? 'demo-shift-open' : null, minimumOrderTotal: 0 };
  };
  const orders = [];
  const staffNames = ['Мария Соколова', 'Иван Петров', 'Олег Смирнов'];
  const productIds = Object.keys(productById);
  for (let offset = -6; offset <= 0; offset += 1) {
    const count = offset === 0 ? 6 : 2 + ((offset + 6) % 3);
    for (let index = 0; index < count; index += 1) {
      const n = orders.length + 1;
      const selections = [[productIds[(n + index) % productIds.length], 1 + (n % 2)]];
      if (n % 3 === 0) selections.push([productIds[(n + 2) % productIds.length], 1]);
      const methods = ['cash', 'card', 'qr'];
      orders.push(makeOrder(`demo-order-${String(n).padStart(3, '0')}`, 'closed', offset, floorZones[0].tables[(n + 1) % 7].id, staffNames[n % staffNames.length], selections, methods[n % methods.length]));
    }
  }
  orders.push(makeOrder('demo-order-open-101', 'open', 0, 'demo-table-1', 'Мария Соколова', [['demo-product-hookah', 1], ['demo-product-berry-lemonade', 2]], 'card', 0));
  orders.push(makeOrder('demo-order-service-102', 'in_progress', 0, 'demo-table-5', 'Иван Петров', [['demo-product-hookah', 1], ['demo-product-tea', 1]], 'cash', 0.25));
  orders.push(makeOrder('demo-order-ready-103', 'ready', 0, 'demo-vip-1', 'Олег Смирнов', [['demo-product-hookah', 2], ['demo-product-snack', 1]], 'qr', 0.6));
  const tomorrow = day(1, 19, 0);
  const reservations = [
    { id: 'demo-res-today-0', guestName: 'Алина Крылова', phone: '+79990001122', date: dateKey(day(0)), time: `${String(Math.min(23, new Date().getHours() + 1)).padStart(2, '0')}:30`, guests: 2, tableId: 'demo-table-2', tableName: 'Стол 2', status: 'confirmed', deposit: 0, notes: 'Бронирование на сегодня', createdAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() },
    { id: 'demo-res-today-1', guestName: 'Екатерина Орлова', phone: '+79991234567', date: dateKey(tomorrow), time: '19:00', guests: 4, tableId: 'demo-table-3', tableName: 'Стол 3', status: 'confirmed', deposit: 1000, notes: 'Предпочитают стол у стены', createdAt: new Date(Date.now() - 90 * 60_000).toISOString() },
    { id: 'demo-res-today-2', guestName: 'Сергей Волков', phone: '+79997654321', date: dateKey(tomorrow), time: '21:30', guests: 7, tableId: 'demo-vip-1', tableName: 'VIP-комната 1', status: 'confirmed', deposit: 3000, notes: '', createdAt: new Date(Date.now() - 60 * 60_000).toISOString() },
    { id: 'demo-res-cancelled', guestName: 'Алина К.', phone: '', date: dateKey(day(-1)), time: '20:00', guests: 2, tableId: 'demo-table-2', tableName: 'Стол 2', status: 'cancelled', deposit: 0, notes: 'Демо отменённой брони', createdAt: iso(-2, 18) }
  ];
  const clients = [
    { id: 'demo-client-vip', guestStatus: 'vip', name: 'Екатерина Орлова', phoneNumbers: [{ label: 'Основной', number: '+79991234567', primary: true }], telegram: '@katya_demo', tobaccoPreferences: ['Darkside', 'ягоды'], bowlPreferences: ['Калауд'], barPreferences: ['Лимонад ягодный'], allergies: '', notes: 'Любит стол у стены', loyaltyPoints: 860, visits: 14, totalSpent: 42300, lastVisitAt: iso(-1, 22) },
    { id: 'demo-client-regular', guestStatus: 'regular', name: 'Сергей Волков', phoneNumbers: [{ label: 'Основной', number: '+79997654321', primary: true }], telegram: '', tobaccoPreferences: ['мята'], bowlPreferences: ['Глиняная чаша'], barPreferences: ['Чай'], allergies: 'Цитрусовые', notes: '', loyaltyPoints: 240, visits: 5, totalSpent: 12600, lastVisitAt: iso(-3, 20) },
    { id: 'demo-client-new', guestStatus: 'new', name: 'Алина Крылова', phoneNumbers: [{ label: 'Основной', number: '+79990001122', primary: true }], telegram: '', tobaccoPreferences: [], bowlPreferences: [], barPreferences: [], allergies: '', notes: 'Новый гость', loyaltyPoints: 0, visits: 1, totalSpent: 1450, lastVisitAt: new Date(Date.now() - 60 * 60_000).toISOString() },
    { id: 'demo-client-inactive', guestStatus: 'regular', name: 'Максим Романов', phoneNumbers: [{ label: 'Основной', number: '+79998887766', primary: true }], telegram: '', tobaccoPreferences: ['ягоды'], bowlPreferences: [], barPreferences: ['Вода'], allergies: '', notes: '', loyaltyPoints: 120, visits: 2, totalSpent: 4100, lastVisitAt: iso(-45, 20) }
  ];
  const recipes = [
    { id: 'demo-recipe-cola-whisky', name: 'Виски-кола', recipeType: 'sale', productId: 'demo-product-cola-whisky', yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1, ingredients: [{ itemId: 'demo-ing-whisky', ingredientId: 'demo-ing-whisky', name: 'Виски купажированный', quantity: 50, unit: 'мл' }, { itemId: 'demo-ing-cola', ingredientId: 'demo-ing-cola', name: 'Кола', quantity: 0.2, unit: 'л' }, { itemId: 'demo-ing-ice', ingredientId: 'demo-ing-ice', name: 'Лёд пищевой', quantity: 0.05, unit: 'кг' }], technology: 'Наполнить стакан льдом, добавить виски и колу, аккуратно перемешать.' },
    { id: 'demo-recipe-berry-premix', name: 'Премикс ягодный', recipeType: 'premix', yieldQuantity: 1, yieldUnit: 'л', portionCount: 1, ingredients: [{ itemId: 'demo-ing-mint', ingredientId: 'demo-ing-mint', name: 'Мята свежая', quantity: 0.1, unit: 'кг' }, { itemId: 'demo-ing-lime', ingredientId: 'demo-ing-lime', name: 'Лайм', quantity: 0.15, unit: 'кг' }], technology: 'Измельчить ингредиенты, смешать и промаркировать дату приготовления.' }
  ];
  const movements = [
    { id: 'demo-move-in-1', itemId: 'demo-ing-mint', itemName: 'Мята свежая', direction: 'in', quantity: 3, reason: 'Поставка', unitCost: 680, createdAt: iso(-2, 10), createdBy: 'Анна Белова' },
    { id: 'demo-move-out-1', itemId: 'demo-ing-mint', itemName: 'Мята свежая', direction: 'out', quantity: 2.6, reason: 'Приготовление напитков', unitCost: 680, createdAt: new Date(Date.now() - 60 * 60_000).toISOString(), createdBy: 'Мария Соколова' },
    { id: 'demo-move-in-2', itemId: 'demo-ing-coal', itemName: 'Уголь кокосовый', direction: 'in', quantity: 72, reason: 'Поставка', unitCost: 5, createdAt: iso(-4, 12), createdBy: 'Анна Белова' }
  ];
  const expenses = [-6, -5, -4, -3, -2, -1, 0].map((offset, index) => ({ id: `demo-expense-${index + 1}`, date: dateKey(day(offset)), category: ['Аренда', 'Коммунальные услуги', 'Зарплата', 'Расходные материалы'][index % 4], amount: [3800, 1250, 5400, 2600, 3300, 1850, 4200][index], status: 'paid', description: 'Демо-расход для проверки аналитики', createdAt: offset === 0 ? new Date(Date.now() - 2 * 60 * 60_000).toISOString() : iso(offset, 11), createdBy: 'Анна Белова' }));
  return { state: { venue: { ...demoDefaultVenue }, staff, inventory, products, productCategories: [...new Set(products.map((item) => item.category))].map((name, index) => ({ id: `demo-category-${index + 1}`, name, department: products.find((item) => item.category === name)?.station || 'bar', active: true })), recipes, reservations, movements, clients, expenses, discountGroups: [{ id: 'none', name: 'Без скидки', discountPercent: 0, bonusPercent: 0, depositMin: 0, active: true }, { id: 'regular', name: 'Постоянный гость', discountPercent: 5, bonusPercent: 1, depositMin: 0, active: true }, { id: 'vip', name: 'VIP', discountPercent: 10, bonusPercent: 2, depositMin: 3000, active: true }], discounts: [{ id: 'demo-discount-request', orderId: 'demo-order-014', type: 'percent', value: 10, reason: 'Компенсация ожидания', status: 'requested', requestedBy: 'Мария Соколова', createdAt: new Date(Date.now() - 30 * 60_000).toISOString() }], audit: [], floorZones, floorLayout: Object.fromEntries(floorZones.flatMap((zone) => zone.tables).map((entry) => [entry.id, entry.layout])), floorNames: {}, floorCapacities: {}, floorStatuses: {}, shift: { id: 'demo-shift-open', openedAt: new Date(Date.now() - 6 * 60 * 60_000).toISOString(), closedAt: null, openingCash: 12000, closingCash: null, openedBy: 'Анна Белова' }, premixBatches: [{ id: 'demo-premix-batch-1', recipeId: 'demo-recipe-berry-premix', recipeName: 'Премикс ягодный', quantity: 1.2, unit: 'л', producedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), producedBy: 'Мария Соколова', status: 'available' }], tasks: [] }, orders };
};
const handleDemoScenario = () => {
  const params = new URLSearchParams(window.location.search); const mode = params.get('demo'); if (!mode) return;
  if (!['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)) { portalNotice('Демо-сценарий доступен только на локальном сайте', 'info'); return; }
  const touchedKeys = [demoKey, 'territory_crm_staff_orders', 'territory_crm_shift', 'crm_session_token', 'crm_session_user'];
  if (mode === 'full') {
    try {
      if (!localStorage.getItem(demoScenarioBackupKey)) { const backup = Object.fromEntries(touchedKeys.map((key) => [key, localStorage.getItem(key)])); localStorage.setItem(demoScenarioBackupKey, JSON.stringify(backup)); }
      const scenario = createRichDemoScenario(); Object.keys(demoState).forEach((key) => delete demoState[key]); Object.assign(demoState, scenario.state); demoSave(); localStorage.setItem('territory_crm_staff_orders', JSON.stringify(scenario.orders)); localStorage.setItem('territory_crm_shift', JSON.stringify({ id: scenario.state.shift.id, openedAt: scenario.state.shift.openedAt, closedAt: null, openingCash: scenario.state.shift.openingCash })); localStorage.setItem('crm_session_token', 'demo-static-scenario'); localStorage.setItem('crm_session_user', JSON.stringify({ id: 'demo-owner', name: 'Юрий Назаров', fullName: 'Юрий Назаров', login: 'owner', role: 'owner' })); localStorage.setItem(demoScenarioActiveKey, 'full');
    } catch (error) { console.error('Не удалось загрузить демо-сценарий', error); portalNotice('Не удалось загрузить демо-данные: проверьте свободное место в хранилище браузера', 'error'); return; }
  } else if (mode === 'restore') {
    const raw = localStorage.getItem(demoScenarioBackupKey); if (!raw) { portalNotice('Сохранённый набор до демо-сценария не найден', 'info'); return; }
    try { const backup = JSON.parse(raw); const restoredState = backup[demoKey] ? JSON.parse(backup[demoKey]) : {}; Object.keys(demoState).forEach((key) => delete demoState[key]); Object.assign(demoState, restoredState); for (const key of touchedKeys) { if (backup[key] === null) localStorage.removeItem(key); else if (backup[key] !== undefined) localStorage.setItem(key, backup[key]); } localStorage.removeItem(demoScenarioBackupKey); localStorage.removeItem(demoScenarioActiveKey); } catch (error) { console.error('Не удалось восстановить данные демо', error); portalNotice('Не удалось восстановить прежние демо-данные', 'error'); return; }
  } else return;
  params.delete('demo'); const nextUrl = `${window.location.pathname}${params.size ? `?${params.toString()}` : ''}${window.location.hash}`; window.history.replaceState(null, '', nextUrl); window.location.reload();
};
handleDemoScenario();
const demoPremixRemaining = (batch) => (batch.status || 'produced') === 'voided' ? 0 : Number(Math.max(0, Number(batch.outputQuantity ?? batch.quantity ?? 0) + (batch.lotMovements || []).reduce((sum, event) => sum + Number(event.quantityDelta || 0), 0)).toFixed(6));
const demoAllocatePremixConsumption = (item, quantity, movementId, reason, { apply = true } = {}) => {
  const lots = (demoState.premixBatches || []).filter((batch) => String(batch.outputItemId || '') === String(item.id) && (batch.status || 'produced') !== 'voided' && demoPremixRemaining(batch) > 0)
    .sort((a, b) => (a.expiresAt || '9999').localeCompare(b.expiresAt || '9999') || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const tracked = lots.reduce((sum, batch) => sum + demoPremixRemaining(batch), 0);
  let remaining = Number(quantity); remaining -= Math.min(remaining, Math.max(0, Number(item.onHand || 0) - tracked));
  const allocations = []; let available = 0;
  for (const batch of lots) { const expired = batch.expiresAt && new Date(batch.expiresAt).getTime() <= Date.now(); if (!expired) available += demoPremixRemaining(batch); }
  if (remaining > available + 0.000001) throw Object.assign(new Error(lots.some((batch) => batch.expiresAt && new Date(batch.expiresAt).getTime() <= Date.now()) ? 'expired_premix_stock' : 'premix_batch_balance_mismatch'), { payload: { error: lots.some((batch) => batch.expiresAt && new Date(batch.expiresAt).getTime() <= Date.now()) ? 'expired_premix_stock' : 'premix_batch_balance_mismatch' } });
  for (const batch of lots) { if (remaining <= 0.000001) break; if (batch.expiresAt && new Date(batch.expiresAt).getTime() <= Date.now()) continue; const used = Math.min(demoPremixRemaining(batch), remaining); allocations.push({ batch, used }); remaining -= used; }
  if (apply) for (const { batch, used } of allocations) { batch.lotMovements ||= []; batch.lotMovements.push({ movementId, type: 'consumption', quantityDelta: -used, reason, createdAt: new Date().toISOString(), createdBy: portalUser.name || 'Сотрудник' }); } return allocations;
};
const demoJson = async (url, options = {}) => {
  const path = new URL(url, window.location.origin).pathname; const method = options.method || 'GET'; const input = options.body ? JSON.parse(options.body) : {}; const demoAlcoholDuplicateKey=(item)=>JSON.stringify([item.scope,item.scope==='organization'?item.organizationId:item.venueId,String(item.brand||'').trim().toLocaleLowerCase('ru-RU'),String(item.productLine||'').trim().toLocaleLowerCase('ru-RU'),String(item.name||'').trim().toLocaleLowerCase('ru-RU'),String(item.spiritType||'').trim().toLocaleLowerCase('ru-RU'),String(item.spiritSubtype||'').trim().toLocaleLowerCase('ru-RU'),item.bottleMl==null||item.bottleMl===''?null:Number(item.bottleMl)]);
  if (path === '/api/tobacco-catalog' && method === 'GET') { const queryUrl = new URL(url,window.location.origin); const q=String(queryUrl.searchParams.get('q')||'').trim().toLocaleLowerCase('ru-RU'); const status=queryUrl.searchParams.get('status')||'active'; const scope=queryUrl.searchParams.get('scope')||''; const venueId=String(demoState.networkCurrentId||demoDefaultVenue.id); const items=(demoState.tobaccoCatalogItems||[]).filter((item)=>(item.scope==='organization'||item.venueId===venueId)&&(status==='all'||(status==='archived'?!item.active:item.active))&&(!scope||item.scope===scope)&&(!q||[item.brand,item.productLine,item.flavor,item.barcode,...(item.aliases||[])].join(' ').toLocaleLowerCase('ru-RU').includes(q))).sort((a,b)=>`${a.brand} ${a.productLine||''} ${a.flavor}`.localeCompare(`${b.brand} ${b.productLine||''} ${b.flavor}`,'ru')); return {items}; }
  if (path === '/api/alcohol-catalog' && method === 'GET') { if(!portalPermissions.has('inventory')&&!portalPermissions.has('inventory_read'))throw new Error('forbidden'); const queryUrl=new URL(url,window.location.origin); const q=String(queryUrl.searchParams.get('q')||'').trim().toLocaleLowerCase('ru-RU'), status=queryUrl.searchParams.get('status')||'active', scope=queryUrl.searchParams.get('scope')||'', venueId=String(demoState.networkCurrentId||demoDefaultVenue.id); const items=(demoState.alcoholCatalogItems||[]).filter((item)=>(item.scope==='organization'||item.venueId===venueId)&&(status==='all'||(status==='archived'?!item.active:item.active))&&(!scope||item.scope===scope)&&(!q||[item.brand,item.productLine,item.name,item.spiritType,item.spiritSubtype,item.country,item.barcode,...(item.aliases||[])].join(' ').toLocaleLowerCase('ru-RU').includes(q))).sort((a,b)=>`${a.brand} ${a.productLine||''} ${a.name}`.localeCompare(`${b.brand} ${b.productLine||''} ${b.name}`,'ru')); return {items}; }
  if (path === '/api/alcohol-catalog' && method === 'POST') { if(!portalPermissions.has('inventory'))throw new Error('forbidden'); const scope=input.scope==='organization'?'organization':input.scope==='venue'?'venue':''; if(!scope)throw new Error('invalid_alcohol_catalog_scope'); if(scope==='organization'&&!['owner','admin','developer'].includes(portalUser.role))throw new Error('alcohol_catalog_network_admin_required'); const number=(value)=>value===''||value==null?null:Number(value); const item={brand:String(input.brand||'').trim(),productLine:String(input.productLine||'').trim()||null,name:String(input.name||'').trim(),spiritType:String(input.spiritType||''),spiritSubtype:String(input.spiritSubtype||'').trim()||null,country:String(input.country||'').trim()||null,abv:number(input.abv),bottleMl:number(input.bottleMl),ageYears:number(input.ageYears),barcode:String(input.barcode||'').trim()||null,aliases:[...new Set((Array.isArray(input.aliases)?input.aliases:String(input.aliases||'').split(',')).map((value)=>String(value).trim()).filter(Boolean))],description:String(input.description||'').trim(),active:true}; if(!item.brand||item.brand.length>120||!item.name||item.name.length>160||item.productLine?.length>120||!['whisky','vodka','rum','tequila','gin','cognac','brandy','liqueur','other'].includes(item.spiritType)||[item.abv,item.bottleMl,item.ageYears].some((value)=>value!==null&&(!Number.isFinite(value)||value<0))||(item.abv!==null&&item.abv>100)||(item.bottleMl!==null&&item.bottleMl<=0)||item.country?.length>80||item.spiritSubtype?.length>100||item.barcode?.length>64||item.description.length>1200||item.aliases.length>20||item.aliases.some((alias)=>alias.length>80))throw new Error('invalid_alcohol_catalog_item'); demoState.alcoholCatalogItems||=[]; const venueId=String(demoState.networkCurrentId||demoDefaultVenue.id), organizationId='demo-organization'; const duplicate=demoState.alcoholCatalogItems.some((entry)=>entry.active&&entry.scope===scope&&entry.organizationId===organizationId&&(scope==='organization'||entry.venueId===venueId)&&demoAlcoholDuplicateKey(entry)===demoAlcoholDuplicateKey({...item,scope,organizationId,venueId:scope==='venue'?venueId:null})); if(duplicate)throw new Error('alcohol_catalog_duplicate'); const created={id:`alcohol-${Date.now()}-${Math.random().toString(16).slice(2,8)}`,organizationId,scope,venueId:scope==='venue'?venueId:null,...item,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}; demoState.alcoholCatalogItems.push(created); demoSave(); return created; }
  const demoAlcoholPath=path.match(/^\/api\/alcohol-catalog\/([^/]+)$/); if(demoAlcoholPath&&method==='PATCH'){if(!portalPermissions.has('inventory'))throw new Error('forbidden'); const item=(demoState.alcoholCatalogItems||[]).find((entry)=>entry.id===decodeURIComponent(demoAlcoholPath[1])&&(entry.scope==='organization'||entry.venueId===String(demoState.networkCurrentId||demoDefaultVenue.id))); if(!item)throw new Error('alcohol_catalog_item_not_found'); if(item.scope==='organization'&&!['owner','admin','developer'].includes(portalUser.role))throw new Error('alcohol_catalog_network_admin_required'); const merged={...item,...input}, number=(value)=>value===''||value==null?null:Number(value); for(const key of ['abv','bottleMl','ageYears']) merged[key]=input[key]===undefined?item[key]:number(input[key]); merged.brand=String(merged.brand||'').trim(); merged.name=String(merged.name||'').trim(); merged.productLine=String(merged.productLine||'').trim()||null; merged.spiritSubtype=String(merged.spiritSubtype||'').trim()||null; merged.country=String(merged.country||'').trim()||null; merged.barcode=String(merged.barcode||'').trim()||null; merged.description=String(merged.description||'').trim(); merged.scope=item.scope;merged.organizationId=item.organizationId;merged.venueId=item.venueId; if(!merged.brand||!merged.name||merged.brand.length>120||merged.name.length>160||merged.productLine?.length>120||merged.spiritSubtype?.length>100||merged.country?.length>80||merged.barcode?.length>64||merged.description.length>1200||!['whisky','vodka','rum','tequila','gin','cognac','brandy','liqueur','other'].includes(merged.spiritType)||[merged.abv,merged.bottleMl,merged.ageYears].some((value)=>value!==null&&(!Number.isFinite(value)||value<0))||(merged.abv!==null&&merged.abv>100)||(merged.bottleMl!==null&&merged.bottleMl<=0)||typeof merged.active!=='boolean')throw new Error('invalid_alcohol_catalog_item'); if(input.aliases!==undefined)merged.aliases=(Array.isArray(input.aliases)?input.aliases:String(input.aliases).split(',')).map((value)=>String(value).trim()).filter(Boolean); if(merged.aliases.length>20||merged.aliases.some((alias)=>alias.length>80))throw new Error('invalid_alcohol_catalog_item'); if(merged.active&&demoState.alcoholCatalogItems.some((entry)=>entry.active&&String(entry.id)!==String(item.id)&&demoAlcoholDuplicateKey(entry)===demoAlcoholDuplicateKey(merged)))throw new Error('alcohol_catalog_duplicate'); Object.assign(item,merged,{updatedAt:new Date().toISOString()}); demoSave(); return item; }
  if (path === '/api/tobacco-catalog' && method === 'POST') { if (!portalPermissions.has('inventory')) throw new Error('forbidden'); const scope=input.scope==='organization'?'organization':input.scope==='venue'?'venue':''; if (!scope) throw new Error('invalid_tobacco_catalog_scope'); if (scope==='organization'&&!['owner','admin','developer'].includes(portalUser.role)) throw new Error('tobacco_catalog_network_admin_required'); const item={brand:String(input.brand||'').trim(),productLine:String(input.productLine||'').trim()||null,flavor:String(input.flavor||'').trim(),productType:input.productType||'tobacco',packageGrams:input.packageGrams===''||input.packageGrams==null?null:Number(input.packageGrams),strength:String(input.strength||'').trim()||null,country:String(input.country||'').trim()||null,leafType:String(input.leafType||'').trim()||null,barcode:String(input.barcode||'').trim()||null,aliases:[...new Set((Array.isArray(input.aliases)?input.aliases:String(input.aliases||'').split(',')).map((value)=>String(value).trim()).filter(Boolean))],description:String(input.description||'').trim(),active:true}; if (!item.brand||item.brand.length>120||!item.flavor||item.flavor.length>160||item.productLine?.length>120||!['tobacco','tobacco_free'].includes(item.productType)||(item.packageGrams!==null&&(!Number.isFinite(item.packageGrams)||item.packageGrams<=0))||item.description.length>1200||item.aliases.length>20||item.aliases.some((alias)=>alias.length>80)) throw new Error('invalid_tobacco_catalog_item'); demoState.tobaccoCatalogItems||=[]; const venueId=String(demoState.networkCurrentId||demoDefaultVenue.id); const organizationId='demo-organization'; const duplicate=demoState.tobaccoCatalogItems.some((entry)=>entry.active&&entry.scope===scope&&entry.organizationId===organizationId&&(scope==='organization'||entry.venueId===venueId)&&entry.brand.toLocaleLowerCase('ru-RU')===item.brand.toLocaleLowerCase('ru-RU')&&(entry.productLine||'').toLocaleLowerCase('ru-RU')===(item.productLine||'').toLocaleLowerCase('ru-RU')&&entry.flavor.toLocaleLowerCase('ru-RU')===item.flavor.toLocaleLowerCase('ru-RU')&&entry.productType===item.productType&&Number(entry.packageGrams||0)===Number(item.packageGrams||0)); if(duplicate)throw new Error('tobacco_catalog_duplicate'); const created={id:`tobacco-${Date.now()}-${Math.random().toString(16).slice(2,8)}`,organizationId,scope,venueId:scope==='venue'?venueId:null,...item,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}; demoState.tobaccoCatalogItems.push(created); demoSave(); return created; }
  const tobaccoCatalogPath=path.match(/^\/api\/tobacco-catalog\/([^/]+)$/); if(tobaccoCatalogPath&&method==='PATCH'){if(!portalPermissions.has('inventory'))throw new Error('forbidden'); const item=(demoState.tobaccoCatalogItems||[]).find((entry)=>entry.id===decodeURIComponent(tobaccoCatalogPath[1])&&(entry.scope==='organization'||entry.venueId===String(demoState.networkCurrentId||demoDefaultVenue.id))); if(!item)throw new Error('tobacco_catalog_item_not_found'); if(item.scope==='organization'&&!['owner','admin','developer'].includes(portalUser.role))throw new Error('tobacco_catalog_network_admin_required'); const brand=String(input.brand??item.brand).trim(),flavor=String(input.flavor??item.flavor).trim(),line=input.productLine===undefined?item.productLine:String(input.productLine||'').trim()||null,packageGrams=input.packageGrams===undefined?item.packageGrams:(input.packageGrams===''||input.packageGrams===null?null:Number(input.packageGrams)),active=input.active===undefined?item.active:input.active; if(!brand||brand.length>120||!flavor||flavor.length>160||line?.length>120||!['tobacco','tobacco_free'].includes(input.productType||item.productType)||(packageGrams!==null&&(!Number.isFinite(packageGrams)||packageGrams<=0))||typeof active!=='boolean')throw new Error('invalid_tobacco_catalog_item'); Object.assign(item,{brand,flavor,productLine:line,productType:input.productType||item.productType,packageGrams,strength:input.strength===undefined?item.strength:String(input.strength||'').trim()||null,country:input.country===undefined?item.country:String(input.country||'').trim()||null,leafType:input.leafType===undefined?item.leafType:String(input.leafType||'').trim()||null,barcode:input.barcode===undefined?item.barcode:String(input.barcode||'').trim()||null,aliases:input.aliases===undefined?item.aliases:(Array.isArray(input.aliases)?input.aliases:String(input.aliases).split(',')).map((value)=>String(value).trim()).filter(Boolean),description:input.description===undefined?item.description:String(input.description||'').trim(),active,updatedAt:new Date().toISOString()}); demoSave(); return item; }
  if (path === '/api/session/preferences' && method === 'GET') { const accountKey = String(portalUser.id || portalUser.login || portalUser.name || portalUser.role || 'user').trim().toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, '_').slice(0, 80) || 'user'; demoState.preferencesByAccount ||= {}; if (!demoState.preferencesByAccount[accountKey] && demoState.preferences) { demoState.preferencesByAccount[accountKey] = demoState.preferences; delete demoState.preferences; demoSave(); } return { preferences: demoState.preferencesByAccount[accountKey] || {} }; }
  if (path === '/api/session/preferences' && method === 'PATCH') { const incoming = input.preferences && typeof input.preferences === 'object' ? input.preferences : input; const accountKey = String(portalUser.id || portalUser.login || portalUser.name || portalUser.role || 'user').trim().toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, '_').slice(0, 80) || 'user'; demoState.preferencesByAccount ||= {}; const previous = demoState.preferencesByAccount[accountKey] || {}; const merged = { ...previous, ...incoming }; for (const name of ['dashboardModules', 'insights', 'financeMetrics', 'navigationVisibility', 'staffDirectory']) if (incoming[name] && typeof incoming[name] === 'object' && !Array.isArray(incoming[name])) merged[name] = { ...(previous[name] || {}), ...incoming[name] }; demoState.preferencesByAccount[accountKey] = merged; demoSave(); return { preferences: merged }; }
  if (path === '/api/venue' && method === 'GET') return demoSelectedVenue();
  if (path === '/api/venue' && (method === 'PATCH' || method === 'PUT')) { if (!demoCanManageVenue()) throw new Error('venue_admin_required'); if (input.name !== undefined && (!String(input.name).trim() || String(input.name).length > 120)) throw new Error('venue_name_required'); if (input.city !== undefined && (!String(input.city).trim() || String(input.city).length > 80)) throw new Error('venue_city_required'); if (input.address !== undefined && (!String(input.address).trim() || String(input.address).length > 240)) throw new Error('venue_address_required'); if (input.phoneNumbers !== undefined && (!Array.isArray(input.phoneNumbers) || input.phoneNumbers.length > 5 || input.phoneNumbers.some((entry) => !/^\+7[0-9 ()-]{7,24}$/.test(String(entry?.number || '').trim())))) throw new Error('invalid_phone_numbers'); if (input.phone !== undefined && input.phone && !/^\+7[0-9 ()-]{7,24}$/.test(String(input.phone).trim())) throw new Error('invalid_phone'); if (input.vipRoomMinimums) { for (const key of ['vip_room_1','vip_room_2']) if (input.vipRoomMinimums[key] !== undefined && (!Number.isFinite(Number(input.vipRoomMinimums[key])) || Number(input.vipRoomMinimums[key]) < 0)) throw new Error('invalid_vip_minimum'); } const currentId = demoState.networkCurrentId || demoDefaultVenue.id; if (!input.expectedVenueId) throw new Error('venue_precondition_required'); if (String(input.expectedVenueId) !== String(currentId)) throw new Error('venue_context_changed'); const selected = currentId === demoDefaultVenue.id ? demoState.venue || {} : (demoState.networkVenues || []).find((item) => item.id === currentId && item.status !== 'archived'); if (!selected && currentId !== demoDefaultVenue.id) throw new Error('venue_not_found'); const before = { ...selected }; Object.assign(selected, input); delete selected.expectedVenueId; if (currentId === demoDefaultVenue.id) demoState.venue = selected; demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'venue.updated', entityType: 'venue', entityId: currentId, actor: portalUser.name || 'владелец', beforeData: before, afterData: { ...selected }, createdAt: new Date().toISOString() }); demoSave(); return demoSelectedVenue(); }
  if (path === '/api/discount-groups' && method === 'GET') { const includeArchived = new URL(url, window.location.origin).searchParams.get('includeArchived') === 'true'; if (!demoDiscountCanRead() || includeArchived && !demoDiscountCanManage()) throw demoDiscountError('forbidden'); return { items: demoDiscountGroupsForVenue().filter((group) => includeArchived || group.active !== false) }; }
  if (path === '/api/discount-groups' && method === 'POST') {
    if (!demoDiscountCanManage()) throw demoDiscountError('forbidden');
    const name = String(input.name || '').trim(); const discountPercent = Number(input.discountPercent ?? 0); const bonusPercent = Number(input.bonusPercent ?? 0); const depositMin = Number(input.depositMin ?? 0);
    if (!name || name.length > 80 || ![discountPercent, bonusPercent, depositMin].every(Number.isFinite) || discountPercent < 0 || discountPercent > 100 || bonusPercent < 0 || bonusPercent > 100 || depositMin < 0 || depositMin > 9999999999.99 || Math.abs(depositMin * 100 - Math.round(depositMin * 100)) > 1e-6) throw demoDiscountError('invalid_discount_group');
    if (demoDiscountGroupsForVenue().some((group) => group.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'))) throw demoDiscountError('discount_group_name_exists');
    const group = { id: `discount-group-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, venueId: demoDiscountVenueId(), name, discountPercent, bonusPercent, depositMin, active: true };
    demoState.discountGroups.push(group); demoSave(); return group;
  }
  const discountGroupProfile = path.match(/^\/api\/discount-groups\/([^/]+)$/);
  if (discountGroupProfile && method === 'PATCH') {
    if (!demoDiscountCanManage()) throw demoDiscountError('forbidden');
    const group = demoDiscountGroupsForVenue().find((entry) => entry.id === discountGroupProfile[1]); if (!group) throw demoDiscountError('discount_group_not_found');
    const name = input.name === undefined ? group.name : String(input.name || '').trim(); const discountPercent = input.discountPercent === undefined ? group.discountPercent : Number(input.discountPercent); const bonusPercent = input.bonusPercent === undefined ? group.bonusPercent : Number(input.bonusPercent); const depositMin = input.depositMin === undefined ? group.depositMin : Number(input.depositMin);
    if (!name || name.length > 80 || ![discountPercent, bonusPercent, depositMin].every(Number.isFinite) || discountPercent < 0 || discountPercent > 100 || bonusPercent < 0 || bonusPercent > 100 || depositMin < 0 || depositMin > 9999999999.99 || Math.abs(depositMin * 100 - Math.round(depositMin * 100)) > 1e-6 || input.active !== undefined && typeof input.active !== 'boolean') throw demoDiscountError('invalid_discount_group');
    if (demoDiscountGroupsForVenue().some((entry) => entry.id !== group.id && entry.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'))) throw demoDiscountError('discount_group_name_exists');
    Object.assign(group, { name, discountPercent, bonusPercent, depositMin, ...(input.active === undefined ? {} : { active: input.active }) }); demoSave(); return group;
  }
  const demoAccountEntries = path.match(/^\/api\/clients\/([^/]+)\/account-entries$/);
  if (demoAccountEntries && method === 'GET') { if (!portalPermissions.has('finance') && !portalPermissions.has('loyalty') && !portalPermissions.has('staff_manage')) throw new Error('forbidden'); const guest = demoState.clients.find((entry) => entry.id === decodeURIComponent(demoAccountEntries[1])); if (!guest) throw new Error('client_not_found'); guest.accountEntries ||= []; return { items: guest.accountEntries, balances: { bonus: Number(guest.bonusBalance ?? guest.loyaltyPoints ?? 0), deposit: Number(guest.depositBalance || 0) } }; }
  const demoDepositTopUp = path.match(/^\/api\/clients\/([^/]+)\/deposit-top-ups$/);
  if (demoDepositTopUp && method === 'POST') { if (!portalPermissions.has('orders') && !portalPermissions.has('finance')) throw new Error('forbidden'); const guest = demoState.clients.find((entry) => entry.id === decodeURIComponent(demoDepositTopUp[1])); if (!guest) throw new Error('client_not_found'); const amount = Number(input.amount), paymentMethod = String(input.method || 'cash'), reason = String(input.reason || '').trim(), idempotencyKey = String(input.idempotencyKey || '').trim(); if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000 || !['cash','card','qr'].includes(paymentMethod) || !reason || reason.length > 500 || !/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey)) throw new Error('invalid_deposit_top_up'); if (!demoState.shift || demoState.shift.closedAt) throw new Error('open_shift_required'); guest.depositTopUps ||= []; guest.accountEntries ||= []; const prior = guest.depositTopUps.find((entry) => entry.idempotencyKey === idempotencyKey); if (prior) { if (prior.guestId !== guest.id || Number(prior.amount) !== amount || prior.method !== paymentMethod || prior.reason !== reason) throw new Error('idempotency_key_reused'); return { ...prior, depositBalance: Number(guest.depositBalance || 0), idempotentReplay: true }; } const receipt = { id: `demo-deposit-${crypto.randomUUID()}`, guestId: guest.id, shiftId: demoState.shift.id, amount, method: paymentMethod, reason, idempotencyKey, createdAt: new Date().toISOString() }; guest.depositBalance = Number(guest.depositBalance || 0) + amount; guest.depositTopUps.unshift(receipt); guest.accountEntries.unshift({ ...receipt, accountType: 'deposit', sourceType: 'deposit_top_up', sourceId: receipt.id, sourceKey: `deposit-top-up:${idempotencyKey}`, actorName: portalUser.name || 'Сотрудник' }); demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'guest.deposit_topped_up', entityType: 'guest_deposit_receipt', entityId: receipt.id, actor: portalUser.name || 'Сотрудник', createdAt: receipt.createdAt }); demoSave(); return { ...receipt, depositBalance: guest.depositBalance }; }
  if (path === '/api/clients' && method === 'GET') { const query = String(new URL(url, window.location.origin).searchParams.get('q') || '').trim().toLowerCase(); const canReadGuestBalances = portalPermissions.has('finance') || portalPermissions.has('loyalty') || portalPermissions.has('staff_manage'); const items = demoState.clients.filter((client) => !client.archivedAt && (!query || `${client.name} ${client.nickname || ''} ${client.telegram} ${(client.phoneNumbers || []).map((phone) => phone.number).join(' ')} ${client.tobaccoPreferences.join(' ')} ${client.barPreferences.join(' ')}`.toLowerCase().includes(query))); return { items: canReadGuestBalances ? items : items.map(({ loyaltyPoints, bonusBalance, depositBalance, ...profile }) => profile) }; }
  if (path === '/api/clients' && method === 'POST') { if (!demoStaffManager() && !portalPermissions.has('orders')) throw new Error('clients_management_required'); const protectedFields = ['discountGroupId','loyaltyPoints','bonusBalance','depositBalance']; if (protectedFields.some((field) => Object.hasOwn(input, field)) && !portalPermissions.has('finance') && !portalPermissions.has('loyalty') && !portalPermissions.has('staff_manage')) throw new Error('forbidden'); if (Number(input.loyaltyPoints ?? input.bonusBalance ?? 0) !== 0 || Number(input.depositBalance ?? 0) !== 0) throw new Error('guest_balances_require_ledger'); const name = String(input.name || '').trim(); if (!name) throw new Error('client_name_required'); const client = { id: `demo-client-${Date.now()}`, name, avatarUrl: String(input.avatarUrl || '').trim() || null, guestStatus: ['new', 'regular', 'vip', 'blocked'].includes(String(input.guestStatus || 'new')) ? String(input.guestStatus || 'new') : 'new', phoneNumbers: normalizeDemoPhones(input.phoneNumbers), telegram: String(input.telegram || '').trim(), tobaccoPreferences: Array.isArray(input.tobaccoPreferences) ? input.tobaccoPreferences : [], bowlPreferences: Array.isArray(input.bowlPreferences) ? input.bowlPreferences : [], barPreferences: Array.isArray(input.barPreferences) ? input.barPreferences : [], allergies: String(input.allergies || '').trim(), notes: String(input.notes || '').trim(), loyaltyPoints: 0, bonusBalance: 0, depositBalance: 0, discountGroupId: String(input.discountGroupId || 'none'), visits: 0, totalSpent: 0, lastVisitAt: null }; demoState.clients.push(client); demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'client.created', entityType: 'client', entityId: client.id, actor: portalUser.name || 'сотрудник', createdAt: new Date().toISOString() }); demoSave(); if (!portalPermissions.has('finance') && !portalPermissions.has('loyalty') && !portalPermissions.has('staff_manage')) { const { loyaltyPoints, bonusBalance, depositBalance, ...profile } = client; return profile; } return client; }
  const clientArchive = path.match(/^\/api\/clients\/([^/]+)\/archive$/); if (clientArchive && method === 'POST') { if (!demoStaffManager()) throw new Error('clients_management_required'); const client = demoState.clients.find((entry) => entry.id === clientArchive[1]); if (!client) throw new Error('client_not_found'); client.archivedAt = new Date().toISOString(); demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'client.archived', entityType: 'client', entityId: client.id, actor: portalUser.name || 'сотрудник', createdAt: client.archivedAt }); demoSave(); return client; }
  const clientDelete = path.match(/^\/api\/clients\/([^/]+)$/); if (clientDelete && method === 'DELETE') { if (portalUser.role !== 'owner') throw new Error('client_delete_owner_required'); const index = demoState.clients.findIndex((entry) => entry.id === clientDelete[1]); if (index < 0) throw new Error('client_not_found'); const [removed] = demoState.clients.splice(index, 1); demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'client.deleted', entityType: 'client', entityId: removed.id, actor: portalUser.name || 'владелец', createdAt: new Date().toISOString() }); demoSave(); return { id: removed.id, deleted: true }; }
  const clientProfile = path.match(/^\/api\/clients\/([^/]+)$/); if (clientProfile && method === 'PATCH') { if (!demoStaffManager() && !portalPermissions.has('orders')) throw new Error('clients_management_required'); const client = demoState.clients.find((entry) => entry.id === clientProfile[1]); if (!client) throw new Error('client_not_found'); const protectedFields = ['discountGroupId','loyaltyPoints','bonusBalance','depositBalance']; if (protectedFields.some((field) => Object.hasOwn(input, field)) && !portalPermissions.has('finance') && !portalPermissions.has('loyalty') && !portalPermissions.has('staff_manage')) throw new Error('forbidden'); if ((Object.hasOwn(input, 'loyaltyPoints') && Number(input.loyaltyPoints) !== Number(client.loyaltyPoints ?? client.bonusBalance ?? 0)) || (Object.hasOwn(input, 'bonusBalance') && Number(input.bonusBalance) !== Number(client.bonusBalance ?? client.loyaltyPoints ?? 0)) || (Object.hasOwn(input, 'depositBalance') && Number(input.depositBalance) !== Number(client.depositBalance || 0))) throw new Error('guest_balances_require_ledger'); Object.assign(client, input); demoSave(); if (!portalPermissions.has('finance') && !portalPermissions.has('loyalty') && !portalPermissions.has('staff_manage')) { const { loyaltyPoints, bonusBalance, depositBalance, ...profile } = client; return profile; } return client; }
  const clientHistory = path.match(/^\/api\/clients\/([^/]+)\/history$/); if (clientHistory && method === 'GET') { const client = demoState.clients.find((entry) => entry.id === clientHistory[1]); if (!client) throw new Error('client_not_found'); const orders = demoReadOrders().filter((order) => order.clientId === client.id || order.guestName === client.name); const canReadReservationPayments = portalPermissions.has('reservations') || portalPermissions.has('finance') || portalPermissions.has('loyalty'); const reservations = demoState.reservations.filter((item) => item.clientId === client.id || item.guestName === client.name).map((item) => { const prepaymentReceipts = (item.prepaymentReceipts || []).map((receipt) => { const refundedAmount = (item.prepaymentRefunds || []).filter((refund) => refund.receiptId === receipt.id).reduce((sum, refund) => sum + Number(refund.amount || 0), 0); return { ...receipt, refundedAmount, netAmount: Math.max(0, Number(receipt.amount || 0) - refundedAmount) }; }); const withRefunds = { ...item, prepaymentReceipts }; return canReadReservationPayments ? withRefunds : Object.fromEntries(Object.entries(withRefunds).filter(([key]) => !['deposit','depositPaid','legacyDepositPaid','depositRequired','verifiedDepositPaid','prepaymentReceipts','prepaymentRefunds','notes'].includes(key))); }); return { orders, reservations, reservationPaymentsVisible: canReadReservationPayments }; }
  const clientLoyalty = path.match(/^\/api\/clients\/([^/]+)\/loyalty$/); if (clientLoyalty && method === 'POST') { if (!demoStaffManager() && !portalPermissions.has('finance')) throw new Error('loyalty_management_required'); const client = demoState.clients.find((entry) => entry.id === clientLoyalty[1]); const delta = Number(input.delta); const reason = String(input.reason || '').trim(); if (!client || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100000 || !reason || reason.length > 500) throw new Error('invalid_loyalty_adjustment'); const before = Number(client.loyaltyPoints || 0); client.loyaltyPoints = Math.max(0, before + delta); demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'client.loyalty_adjusted', entityType: 'client', entityId: client.id, actor: portalUser.name || 'администратор', beforeData: { loyaltyPoints: before }, afterData: { loyaltyPoints: client.loyaltyPoints, delta, reason }, createdAt: new Date().toISOString() }); demoSave(); return { id: client.id, loyaltyPoints: client.loyaltyPoints, delta, reason }; }
  if (path === '/api/finance/categories' && method === 'GET') { const params = new URL(url, window.location.origin).searchParams; const query = String(params.get('q') || '').trim().toLowerCase(); const includeArchived = params.get('includeArchived') === 'true'; if (includeArchived && !portalPermissions.has('finance')) throw new Error('HTTP 403'); demoState.financeCategories ||= [{ id: 'demo-finance-kitchen', name: 'Кухня', kind: 'income', active: true }, { id: 'demo-finance-bar', name: 'Бар', kind: 'income', active: true }, { id: 'demo-finance-hookah', name: 'Кальяны', kind: 'income', active: true }, { id: 'demo-finance-stock', name: 'Склад', kind: 'expense', active: true }]; return { items: demoState.financeCategories.filter((item) => (includeArchived || item.active !== false) && (!query || item.name.toLowerCase().includes(query))).map((item) => ({ ...item, operationCount: (demoState.expenses || []).filter((expense) => expense.categoryId === item.id).length })) }; }
  if (path === '/api/finance/categories' && method === 'POST') { if (!portalPermissions.has('finance')) throw new Error('HTTP 403'); const name = String(input.name || '').trim(); const kind = String(input.kind || 'income'); demoState.financeCategories ||= []; if (!name || name.length > 80 || !['income','expense'].includes(kind)) throw new Error('invalid_finance_category'); if (demoState.financeCategories.some((item) => item.active !== false && item.kind === kind && item.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'))) throw new Error('finance_category_exists'); const category = { id: `demo-finance-category-${Date.now()}`, name, kind, active: true }; demoState.financeCategories.push(category); demoSave(); return category; }
  const demoFinanceCategoryPath = path.match(/^\/api\/finance\/categories\/([^/]+)$/); if (demoFinanceCategoryPath && method === 'PATCH') { if (!portalPermissions.has('finance')) throw new Error('HTTP 403'); const category = (demoState.financeCategories || []).find((item) => item.id === demoFinanceCategoryPath[1]); if (!category) throw new Error('finance_category_not_found'); const name = input.name === undefined ? category.name : String(input.name || '').trim(); const kind = input.kind === undefined ? category.kind : String(input.kind); const active = input.active === undefined ? category.active !== false : input.active; if (!name || name.length > 80 || !['income','expense'].includes(kind) || typeof active !== 'boolean') throw new Error('invalid_finance_category'); if (kind !== 'expense' && (demoState.expenses || []).some((expense) => expense.categoryId === category.id)) throw new Error('finance_category_has_expenses'); for (const expense of demoState.expenses || []) if (expense.categoryId === category.id && name !== category.name) expense.category = name; Object.assign(category, { name, kind, active }); demoSave(); return category; }
  if (path === '/api/expenses' && method === 'GET') { if (!portalPermissions.has('finance_read') && !portalPermissions.has('finance')) throw new Error('HTTP 403'); const params = new URL(url, window.location.origin).searchParams; const from = params.get('from') || '1900-01-01'; const to = params.get('to') || '2999-12-31'; return { items: (demoState.expenses || []).filter((item) => item.date >= from && item.date <= to && item.status !== 'cancelled').slice().sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map((item) => ({ ...item, expenseDate: item.date })) }; }
  if (path === '/api/expenses' && method === 'POST') { if (!portalPermissions.has('finance')) throw new Error('HTTP 403'); const categoryId = String(input.categoryId || ''); const selected = categoryId ? (demoState.financeCategories || []).find((item) => item.id === categoryId && item.active !== false && item.kind === 'expense') : null; const category = selected?.name || String(input.category || '').trim(); const amount = Number(input.amount); const expenseDate = String(input.expenseDate || localDateKey()); if (categoryId && !selected || !category || category.length > 80 || !Number.isFinite(amount) || amount < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) throw new Error('invalid_expense'); const expense = { id: `demo-expense-${Date.now()}`, category, categoryId: selected?.id || null, amount, date: expenseDate, expenseDate, description: String(input.description || '').trim().slice(0, 1000), documentUrl: String(input.documentUrl || '').slice(0, 500), source: ['manual', 'payroll', 'purchase', 'other'].includes(input.source) ? input.source : 'manual', status: 'paid', createdAt: new Date().toISOString(), createdBy: portalUser.name || 'администратор' }; demoState.expenses ||= []; demoState.expenses.push(expense); demoSave(); return expense; }
  if (path === '/api/integrations') return { telegram: { enabled: false, status: 'planned' } };
  if (path === '/api/network/venues' && method === 'GET') return { items: [demoDefaultVenueRecord(), ...(demoState.networkVenues || []).filter((item) => item.status !== 'archived').map((item) => ({ ...item, isCurrent: item.id === (demoState.networkCurrentId || '') }))] };
  if (path === '/api/network/venues' && method === 'POST') { if (!demoCanManageVenue()) throw new Error('venue_admin_required'); if (!portalPermissions.has('settings')) throw new Error('HTTP 403'); const name = String(input.name || '').trim(); const city = String(input.city || '').trim(); const address = String(input.address || '').trim(); if (!name || !city || !address) throw new Error('venue_name_city_address_required'); const item = { id: `demo-venue-${Date.now()}`, name, format: String(input.format || 'кальян-бар').trim(), city, address, phone: String(input.phone || '').trim(), timezone: String(input.timezone || 'Europe/Moscow').trim(), status: 'active', isCurrent: false }; demoState.networkVenues ||= []; demoState.networkVenues.push(item); demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'venue.created', entityType: 'venue', entityId: item.id, actor: portalUser.name || 'владелец', createdAt: new Date().toISOString() }); demoSave(); return item; }
  const demoVenuePath = path.match(/^\/api\/network\/venues\/([^/]+)$/); const demoVenueSelect = path.match(/^\/api\/network\/venues\/([^/]+)\/select$/);
  if (demoVenueSelect && method === 'POST') { if (!demoCanManageVenue()) throw new Error('venue_admin_required'); if (!portalPermissions.has('settings')) throw new Error('HTTP 403'); const items = [demoDefaultVenueRecord(), ...(demoState.networkVenues || [])]; const item = items.find((entry) => entry.id === demoVenueSelect[1] && entry.status !== 'archived'); if (!item) throw new Error('HTTP 404'); demoState.networkCurrentId = item.id; demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'venue.selected', entityType: 'venue', entityId: item.id, actor: portalUser.name || 'владелец', createdAt: new Date().toISOString() }); demoSave(); return { ...item, isCurrent: true }; }
  if (demoVenuePath && method === 'PATCH') { if (!demoCanManageVenue()) throw new Error('venue_admin_required'); if (!portalPermissions.has('settings')) throw new Error('HTTP 403'); const item = (demoState.networkVenues || []).find((entry) => entry.id === demoVenuePath[1]); if (!item) throw new Error('HTTP 404'); Object.assign(item, { name: String(input.name || item.name).trim(), address: String(input.address || item.address).trim() }); demoSave(); return item; }
  if (demoVenuePath && method === 'DELETE') { if (!demoCanManageVenue()) throw new Error('venue_admin_required'); if (!portalPermissions.has('settings')) throw new Error('HTTP 403'); const item = (demoState.networkVenues || []).find((entry) => entry.id === demoVenuePath[1]); if (!item) throw new Error('HTTP 404'); if (demoState.networkCurrentId === item.id) throw new Error('current_venue_cannot_be_archived'); item.status = 'archived'; demoSave(); return item; }
  if (path === '/api/shifts' && method === 'GET') { if (!['floor', 'orders', 'finance_read'].some((permission) => portalPermissions.has(permission))) throw new Error('HTTP 403'); const employeeView = ['bartender','hookah_master','senior_bartender','senior_hookah_master','cleaner','security','technician','other_staff'].includes(portalUser.role); const fullHistory = portalPermissions.has('finance_read') && !employeeView; const visible = fullHistory ? demoState.shift : demoState.shift && !demoState.shift.closedAt ? { id: demoState.shift.id, openedAt: demoState.shift.openedAt, closedAt: null, openingCash: demoState.shift.openingCash } : null; return { items: visible ? [visible] : [], current: visible && !visible.closedAt ? visible : null }; }
  if (path.startsWith('/api/dashboard/shift-kpis') && ['bartender','hookah_master','senior_bartender','senior_hookah_master','cleaner','security','technician','other_staff'].includes(String(portalUser.role || '').toLowerCase())) {
    const timezone = demoSelectedVenue().timezone || 'Asia/Yekaterinburg';
    const dayKey = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
    const reportDate = dayKey(new Date());
    const venueId = String(demoSelectedVenue().id);
    const actorId = String(portalUser.id || portalUser.name || '');
    const totals = { revenue: 0, paymentCount: 0, cash: 0, cashless: 0, other: 0, closedOrders: 0 };
    for (const order of demoReadOrders().filter((item) => String(item.venueId || venueId) === venueId && String(item.openedById || item.openedBy || '') === actorId)) {
      if (order.status === 'closed' && order.closedAt && dayKey(order.closedAt) === reportDate) totals.closedOrders += 1;
      for (const payment of order.payments || []) {
        if (!['paid', 'partially_paid'].includes(payment.status) || !payment.createdAt || dayKey(payment.createdAt) !== reportDate) continue;
        const amount = Number(payment.amount || 0);
        const method = payment.method === 'cash' ? 'cash' : ['card', 'qr'].includes(payment.method) ? 'cashless' : 'other';
        totals.revenue += amount; totals.paymentCount += 1; totals[method] += amount;
      }
    }
    return { date: reportDate, timezone, employeeView: true, selectedShiftId: null, shifts: [{ id: 'employee-today' }], totals, unassignedPaymentCount: 0, ambiguousPaymentCount: 0 };
  }
  if (path.startsWith('/api/dashboard/shift-kpis')) { const params = new URL(url, window.location.origin).searchParams; const employeeView = ['bartender','hookah_master','senior_bartender','senior_hookah_master','cleaner','security','technician','other_staff'].includes(String(portalUser.role || '').toLowerCase()); const reportDate = employeeView ? localDateKey() : (params.get('date') || localDateKey()); const shift = demoState.shift && localDateKey(demoState.shift.openedAt) === reportDate ? demoState.shift : null; if (params.get('shiftId') && params.get('shiftId') !== shift?.id) throw new Error('shift_not_found_for_date'); const sameEmployee = (order) => !employeeView || String(order.openedById || order.openedBy || '') === String(portalUser.id || portalUser.name || ''); const allOrders = demoReadOrders().filter(sameEmployee); const ordersForShift = shift ? allOrders.filter((order) => order.status === 'closed' && order.closedInShiftId === shift.id) : []; const totals = { revenue: 0, paymentCount: 0, cash: 0, cashless: 0, other: 0, closedOrders: ordersForShift.length }; for (const order of allOrders) for (const payment of order.payments || []) if (payment.shiftId === shift?.id && ['paid','partially_paid'].includes(payment.status)) { const key = payment.method === 'cash' ? 'cash' : ['card','qr'].includes(payment.method) ? 'cashless' : 'other'; totals[key] += Number(payment.amount || 0); totals.revenue += Number(payment.amount || 0); totals.paymentCount += 1; } const safeShift = shift ? [{ id: shift.id, openedAt: shift.openedAt, closedAt: shift.closedAt || null }] : []; return { date: reportDate, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', employeeView, selectedShiftId: params.get('shiftId') || null, shifts: safeShift, totals, unassignedPaymentCount: 0, ambiguousPaymentCount: 0 }; }
  if (path === '/api/shifts' && method === 'POST') { if (!portalPermissions.has('floor')) throw new Error('shift_management_required'); if (demoState.shift && !demoState.shift.closedAt) throw new Error('shift_already_open'); demoState.shift = { id: `demo-shift-${Date.now()}`, openedAt: new Date().toISOString(), closedAt: null, openingCash: Number(input.openingCash || 0), closingCash: null, openedBy: portalUser.name || 'сотрудник' }; demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'shift.opened', entityType: 'shift', entityId: demoState.shift.id, actor: portalUser.name || 'сотрудник', createdAt: new Date().toISOString() }); demoSave(); return demoState.shift; }
  const demoShiftSnapshot=path.match(/^\/api\/shifts\/([^/]+)\/close-snapshot$/); if (demoShiftSnapshot && method === 'GET') { if (!portalPermissions.has('finance_read') && !portalPermissions.has('floor')) throw new Error('forbidden'); if (!demoState.shift || demoState.shift.id !== demoShiftSnapshot[1] || !demoState.shift.closeSnapshot) throw new Error('shift_close_snapshot_not_found'); return demoState.shift.closeSnapshot; }
  const demoShiftClose = path.match(/^\/api\/shifts\/([^/]+)\/close$/); if (demoShiftClose && method === 'POST') { if (!portalPermissions.has('floor')) throw new Error('shift_management_required'); if (!window.HOOKAH_SHIFT_CLOSE?.validateChecklist(input.checklist)) throw new Error('shift_checklist_required'); if (!demoState.shift || demoState.shift.id !== demoShiftClose[1] || demoState.shift.closedAt) throw new Error('shift_not_found_or_closed'); demoState.shift.closedAt = new Date().toISOString(); demoState.shift.closingCash = Number(input.closingCash || 0); demoState.shift.expectedCash = Number(demoState.shift.openingCash || 0); demoState.shift.cashVariance = demoState.shift.closingCash-demoState.shift.expectedCash; demoState.shift.closedById = portalUser.id || null; demoState.shift.closeSnapshot = { id: `demo-close-${Date.now()}`, venueId: portalUser.venueId, shiftId: demoState.shift.id, schemaVersion: 1, checklistVersion: input.checklist.version, capturedAt: demoState.shift.closedAt, closedBy: demoState.shift.closedById, sha256: null, payload: { kind: 'internal_pos_shift_close', reportLabel: 'Внутренний снимок закрытия смены HOOKAH POS', fiscalDocument: false, fiscalNote: 'Демонстрационный снимок; не является фискальным Z-отчётом.', schemaVersion: 1, currency: 'RUB', venueId: portalUser.venueId, shift: { id: demoState.shift.id, openedAt: demoState.shift.openedAt, closedAt: demoState.shift.closedAt, closedBy: demoState.shift.closedById }, checklist: window.HOOKAH_SHIFT_CLOSE.freezeChecklist(input.checklist, demoState.shift.closedById, demoState.shift.closedAt), cashReconciliation: { openingCash: Number(demoState.shift.openingCash || 0), expectedCash: demoState.shift.expectedCash, actualCash: demoState.shift.closingCash, variance: demoState.shift.cashVariance }, ledger: { coverage: 'memory_demo_unverified' } } }; demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'shift.closed', entityType: 'shift', entityId: demoState.shift.id, actor: portalUser.name || 'сотрудник', createdAt: new Date().toISOString() }); demoSave(); return demoState.shift; }
  if (path === '/api/orders' && method === 'GET') { const params = new URL(url, window.location.origin).searchParams; let items = demoReadOrders().slice(); const status = params.get('status'); const tableId = params.get('tableId'); if (status) items = items.filter((order) => order.status === status); if (tableId) items = items.filter((order) => String(order.tableId) === tableId); items.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)); return { items }; }
  const demoOrderProfile = path.match(/^\/api\/orders\/([^/]+)$/); if (demoOrderProfile && method === 'GET') { const order = demoReadOrders().find((item) => item.id === demoOrderProfile[1]); if (!order) throw new Error('HTTP 404'); return order; }
   if (path === '/api/metrics') { const pending = demoPendingSummary(); if (['bartender','hookah_master','senior_bartender','senior_hookah_master','cleaner','security','technician','other_staff'].includes(portalUser.role)) return portalPermissions.has('orders') ? { employeeView: true, openOrders: pending.pendingOrders, pendingOrders: pending.pendingOrders } : { employeeView: true }; const orders = demoReadOrders(); const today = localDateKey(); return { ...(portalPermissions.has('orders') ? { openOrders: pending.pendingOrders, pendingOrders: pending.pendingOrders, closedOrders: orders.filter((order) => order.status === 'closed' && localDateKey(order.closedAt || order.createdAt) === today).length } : {}), ...(portalPermissions.has('finance_read') ? { pendingRevenue: pending.pendingRevenue, discountRequests: demoState.discounts.filter((item) => item.status === 'requested').length } : {}), ...((portalPermissions.has('staff_view') || portalPermissions.has('staff')) ? { staffActive: demoState.staff.filter((x) => x.active).length } : {}), ...(portalPermissions.has('reservations') ? { reservationsToday: demoState.reservations.filter((item) => item.status === 'confirmed' && item.date === today).length } : {}), ...(portalPermissions.has('inventory_read') ? { lowStock: demoState.inventory.filter((x) => Number(x.minLevel || 0) > 0 && Number(x.onHand || 0) <= Number(x.minLevel || 0)).length } : {}) }; }
  if (/^\/api\/payroll(?:\/|$)/.test(path)) {
    if (!portalPermissions.has('finance')) throw new Error('HTTP 403');
    const error = new Error('payroll_requires_database'); error.status = 503; error.payload = { error: 'payroll_requires_database' }; throw error;
  }
  if (path === '/api/analytics') {
    if (!portalPermissions.has('finance_read')) throw new Error('HTTP 403');
    let localOrders = []; try { localOrders = JSON.parse(localStorage.getItem('territory_crm_staff_orders') || '[]'); } catch (_) {}
    const dates = Array.from({ length: 7 }, (_, index) => { const date = new Date(); date.setDate(date.getDate() - (6 - index)); return localDateKey(date); });
    const closed = localOrders.filter((order) => order.status === 'closed' && dates.includes(localDateKey(order.closedAt || order.createdAt)));
    const days = dates.map((date) => { const items = closed.filter((order) => localDateKey(order.closedAt || order.createdAt) === date); const checks = items.map((order) => Number(order.finalTotal || 0)).sort((a, b) => a - b); const revenue = checks.reduce((sum, value) => sum + value, 0); const medianCheck = checks.length ? (checks.length % 2 ? checks[(checks.length - 1) / 2] : (checks[checks.length / 2 - 1] + checks[checks.length / 2]) / 2) : 0; const tables = new Set(items.map((order) => order.tableId).filter(Boolean)); const expenses = (demoState.expenses || []).filter((expense) => expense.date === date && expense.status !== 'cancelled' && !['cancelled', 'purchase', 'payroll'].includes(expense.source)).reduce((sum, expense) => sum + Number(expense.amount || 0), 0); const costOfGoods = items.reduce((sum, order) => sum + (order.items || []).reduce((orderSum, item) => orderSum + Number(item.unitCost || 0) * Number(item.quantity || 0), 0), 0); return { date, revenue, operatingExpenses: expenses, expenses: null, payroll: null, cashOutflow: null, costOfGoods, netProfit: null, orders: items.length, averageCheck: items.length ? revenue / items.length : 0, medianCheck, tables: tables.size }; });
    const stationMap = new Map(); closed.forEach((order) => { const stations = new Set((order.items || []).map((item) => item.station || 'other')); stations.forEach((station) => { const row = stationMap.get(station) || { revenue: 0, orders: 0 }; row.revenue += Number(order.finalTotal || 0) / Math.max(stations.size, 1); row.orders += 1; stationMap.set(station, row); }); }); const byStation = Object.fromEntries([...stationMap.entries()].map(([station, row]) => [station, { ...row, averageCheck: row.orders ? row.revenue / row.orders : 0 }]));
    const counts = new Map(); closed.flatMap((order) => order.items || []).forEach((item) => { const name = item.name || item.productName || item.productId || 'Позиция'; counts.set(name, (counts.get(name) || 0) + Number(item.quantity || 0)); });
    const staffMap = new Map(); closed.forEach((order) => { const name = order.createdByName || order.waiterName || 'Не указан'; const row = staffMap.get(name) || { name, revenue: 0, orders: 0 }; row.revenue += Number(order.finalTotal || 0); row.orders += 1; staffMap.set(name, row); });
    const totalRevenue = days.reduce((sum, row) => sum + row.revenue, 0); const totalExpenses = null; const totalOperatingExpenses = days.reduce((sum, row) => sum + row.operatingExpenses, 0); const totalCostOfGoods = days.reduce((sum, row) => sum + row.costOfGoods, 0); const totalPayroll = null; const totalOrders = days.reduce((sum, row) => sum + row.orders, 0); const floorTableIds = new Set((demoState.floorZones || []).flatMap((zone) => zone.tables || []).map((table) => String(table.id))); const busy = new Set(localOrders.filter((order) => ['open', 'in_progress', 'ready'].includes(order.status) && floorTableIds.has(String(order.tableId))).map((order) => order.tableId)).size;
    const floorTables = (demoState.floorZones || []).flatMap((zone) => zone.tables || []); const totalTables = floorTables.length; const avgTablesPerDay = days.length ? totalTables / days.length : 0; const allChecks = closed.map((order) => Number(order.finalTotal || 0)).sort((a, b) => a - b); const medianCheck = allChecks.length ? (allChecks.length % 2 ? allChecks[(allChecks.length - 1) / 2] : (allChecks[allChecks.length / 2 - 1] + allChecks[allChecks.length / 2]) / 2) : 0; return { days, totalRevenue, totalExpenses, totalOperatingExpenses, totalPayroll, totalCashOutflow: null, payrollCoverage: { status: 'unsupported', reason: 'payroll_requires_database' }, officialReady: false, totalCostOfGoods, netProfit: null, averageCheck: totalOrders ? totalRevenue / totalOrders : 0, medianCheck, avgTablesPerDay, byStation, topProducts: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, quantity]) => ({ name, quantity })), staffDynamics: [...staffMap.values()].sort((a, b) => b.revenue - a.revenue), hallLoad: { busy: floorTables.length ? busy : 0, total: totalTables } };
  }
  if (path === '/api/staff' && method === 'GET') { if (!['staff', 'staff_view', 'settings'].some((permission) => portalPermissions.has(permission))) throw new Error('HTTP 403'); return { items: demoState.staff.filter((person) => !person.deletedAt).map(demoStaffPublic) }; }
  if (path === '/api/staff' && method === 'POST') { if (!demoStaffManager()) throw new Error('staff_management_required'); const requestedScopes = Array.isArray(input.permissionScopes) ? [...new Set(input.permissionScopes)] : []; if (input.permissionScopes !== undefined && (portalUser.role !== 'owner' || input.role === 'owner' || requestedScopes.some((scope) => !portalPermissionScopes.includes(scope)))) throw new Error('permission_scopes_owner_required'); const nonCrm = nonCrmStaffRoles.includes(input.role); if (!nonCrm && !input.password) throw new Error('password_required'); if (!nonCrm && input.password !== undefined && (String(input.password).length < 4 || String(input.password).length > 11)) throw new Error('password_length_invalid'); if (!nonCrm && input.login !== undefined && !/^[A-Za-zА-Яа-яЁё0-9_-]{3,32}$/.test(String(input.login).trim())) throw new Error('invalid_staff_login'); if (!input.birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(input.birthDate))) throw new Error('birth_date_required'); if (!demoCanCreateStaffRole(input.role)) throw new Error('staff_role_assignment_required'); if (!input.name || !['admin','manager','senior_bartender','senior_hookah_master','bartender','hookah_master','developer', ...nonCrmStaffRoles].includes(input.role)) throw new Error('name_and_valid_role_required'); if (Array.isArray(input.phoneNumbers) && (input.phoneNumbers.length > 5 || input.phoneNumbers.some((entry) => !/^\+7[0-9 ()-]{7,24}$/.test(String(entry?.number || '').trim())))) throw new Error('invalid_phone_numbers'); const contactNumbers = normalizeDemoPhones(input.phoneNumbers); if (contactNumbers.length && contactNumbers.filter((entry) => entry.primary).length !== 1) throw new Error('one_primary_phone_required'); if (demoState.staff.some((entry) => entry.login === (input.login || ''))) throw new Error('login_already_exists'); if (input.telegram && !/^(@[A-Za-z0-9_]{5,32}|https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\/?$)/.test(String(input.telegram).trim())) throw new Error('invalid_telegram'); const person = { id: `demo-${Date.now()}`, name: String(input.name).trim().slice(0, 120), login: nonCrm ? null : (input.login || `user_${Date.now()}`), password: nonCrm ? null : input.password, role: input.role, active: true, avatarUrl: null, photoUrl: input.photoUrl || null, birthDate: input.birthDate, telegram: String(input.telegram || '').trim(), phoneNumbers: contactNumbers, employmentStartedAt: input.employmentStartedAt || null, workNotes: String(input.workNotes || '').slice(0, 4000), permissionScopes: requestedScopes, passportData: demoSensitiveStaffManager() ? (input.passportData || null) : null }; demoState.staff.push(person); demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'staff.created', entityType: 'staff', entityId: person.id, actor: portalUser.name || 'администратор', createdAt: new Date().toISOString() }); demoSave(); return demoStaffPublic(person); }
  const staffPath = path.match(/^\/api\/staff\/([^/]+)\/avatar$/); if (staffPath && method === 'POST') { if (!demoStaffManager() && staffPath[1] !== portalUser.id) throw new Error('staff_management_required'); const person = demoState.staff.find((x) => x.id === staffPath[1]); if (!person) throw new Error('HTTP 404'); if (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(input.imageData || ''))) throw new Error('invalid_avatar'); person.avatarUrl = input.imageData; demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'staff.avatar_updated', entityType: 'staff', entityId: person.id, actor: portalUser.name || 'администратор', createdAt: new Date().toISOString() }); demoSave(); return demoStaffPublic(person); }
  const staffPin = path.match(/^\/api\/staff\/([^/]+)\/pin$/); if (staffPin && method === 'PATCH') { if (!demoStaffManager()) throw new Error('staff_management_required'); const person = demoState.staff.find((entry) => entry.id === staffPin[1]); if (!person) throw new Error('staff_not_found'); const pin = String(input.pin || '').trim(); if (!/^\d{4}$/.test(pin)) throw new Error('invalid_staff_pin_format'); person.pinConfigured = true; person.pinCode = pin; person.pinUpdatedAt = new Date().toISOString(); demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'staff.pin_updated', entityType: 'staff', entityId: person.id, actor: portalUser.name || 'администратор', createdAt: person.pinUpdatedAt }); demoSave(); return { id: person.id, pinConfigured: true, pinUpdatedAt: person.pinUpdatedAt }; }
  const staffProfile = path.match(/^\/api\/staff\/([^/]+)\/profile$/); if (staffProfile && method === 'GET') { const person = demoState.staff.find((x) => x.id === staffProfile[1]); if (!person) throw new Error('HTTP 404'); if (!demoStaffManager() && person.id !== portalUser.id) throw new Error('HTTP 403'); return demoStaffPublic(person); }
  if (staffProfile && method === 'PATCH') { const person = demoState.staff.find((x) => x.id === staffProfile[1]); if (!person) throw new Error('HTTP 404'); if (person.role === 'owner' && portalUser.role !== 'owner') throw new Error('owner_staff_protected'); const isSelf = person.id === portalUser.id; if (!demoStaffManager() && !isSelf) throw new Error('HTTP 403'); const auditBefore = demoStaffPublic(person); const changedFields = []; if (input.name !== undefined) { if (!demoStaffManager() || !String(input.name).trim() || String(input.name).trim().length > 120) throw new Error('invalid_staff_name'); person.name = String(input.name).trim(); changedFields.push('name'); } if (input.role !== undefined) { if (!demoStaffManager() || !demoCanAssignStaffRole(input.role) || !['admin','manager','senior_bartender','senior_hookah_master','bartender','hookah_master','developer'].includes(input.role)) throw new Error('invalid_staff_role'); person.role = input.role; changedFields.push('role'); } if (input.permissionScopes !== undefined) { if (portalUser.role !== 'owner' || person.role === 'owner' || !Array.isArray(input.permissionScopes) || input.permissionScopes.some((scope) => !portalPermissionScopes.includes(scope))) throw new Error('permission_scopes_owner_required'); person.permissionScopes = [...new Set(input.permissionScopes)]; changedFields.push('permissionScopes'); } if (input.avatarUrl !== undefined) { if (input.avatarUrl && !/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(input.avatarUrl))) throw new Error('invalid_avatar'); person.avatarUrl = input.avatarUrl || null; changedFields.push('avatar'); } if (input.telegram !== undefined) { const telegram = String(input.telegram || '').trim(); if (telegram && !/^(@[A-Za-z0-9_]{5,32}|https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\/?$)/.test(telegram)) throw new Error('invalid_telegram'); person.telegram = telegram; changedFields.push('telegram'); } if (input.phoneNumbers !== undefined) { if (!Array.isArray(input.phoneNumbers) || input.phoneNumbers.length > 5 || input.phoneNumbers.some((entry) => !/^\+7[0-9 ()-]{7,24}$/.test(String(entry?.number || '').trim()))) throw new Error('invalid_phone_numbers'); person.phoneNumbers = normalizeDemoPhones(input.phoneNumbers); if (person.phoneNumbers.length && person.phoneNumbers.filter((entry) => entry.primary).length !== 1) throw new Error('one_primary_phone_required'); changedFields.push('phoneNumbers'); } if (input.employmentStartedAt !== undefined) { if (!demoStaffManager()) throw new Error('staff_management_required'); person.employmentStartedAt = input.employmentStartedAt || null; changedFields.push('employmentStartedAt'); } if (input.workNotes !== undefined) { if (!demoStaffManager()) throw new Error('staff_management_required'); person.workNotes = String(input.workNotes || '').slice(0, 4000); changedFields.push('workNotes'); } if (input.passportData !== undefined) { if (!demoSensitiveStaffManager()) throw new Error('sensitive_staff_permission_required'); person.passportData = input.passportData || null; changedFields.push('passportData'); } const before = { ...person }; demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'staff.profile_updated', entityType: 'staff', entityId: person.id, actor: portalUser.name || 'сотрудник', changedFields, beforeData: auditBefore, afterData: demoStaffPublic(person), createdAt: new Date().toISOString() }); demoSave(); return demoStaffPublic(person); }
  const staffDelete = path.match(/^\/api\/staff\/([^/]+)$/); if (staffDelete && method === 'DELETE') { if (!demoStaffManager()) throw new Error('staff_management_required'); if (staffDelete[1] === portalUser.id) throw new Error('self_deactivation_forbidden'); const person = demoState.staff.find((x) => x.id === staffDelete[1]); if (!person || person.role === 'owner') throw new Error('owner_cannot_be_deleted'); if (portalUser.role === 'manager' && ['admin','developer'].includes(person.role)) throw new Error('staff_management_required'); person.active = false; demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'staff.deactivated', entityType: 'staff', entityId: person.id, actor: portalUser.name || 'администратор', createdAt: new Date().toISOString() }); demoSave(); return demoStaffPublic(person); }
  const staffArchive = path.match(/^\/api\/staff\/([^/]+)\/archive$/); if (staffArchive && method === 'POST') { if (!demoStaffManager()) throw new Error('staff_management_required'); if (portalUser.role !== 'owner') throw new Error('staff_archive_owner_required'); if (staffArchive[1] === portalUser.id) throw new Error('self_archive_forbidden'); const person = demoState.staff.find((x) => x.id === staffArchive[1]); if (!person || person.role === 'owner') throw new Error('owner_cannot_be_deleted'); if (person.active || person.deletedAt) throw new Error('staff_must_be_blocked_before_archive'); person.deletedAt = new Date().toISOString(); demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'staff.archived', entityType: 'staff', entityId: person.id, actor: portalUser.name || 'владелец', createdAt: person.deletedAt }); demoSave(); return { ...demoStaffPublic(person), archivedAt: person.deletedAt }; }
  const staffStatus = path.match(/^\/api\/staff\/([^/]+)\/status$/); if (staffStatus && method === 'PATCH') { if (!demoStaffManager()) throw new Error('staff_management_required'); if (staffStatus[1] === portalUser.id) throw new Error('self_deactivation_forbidden'); const person = demoState.staff.find((x) => x.id === staffStatus[1]); if (!person || person.role === 'owner' || typeof input.active !== 'boolean') throw new Error('HTTP 400'); if (portalUser.role === 'manager' && ['admin','developer'].includes(person.role)) throw new Error('staff_management_required'); person.active = input.active; demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: input.active ? 'staff.activated' : 'staff.deactivated', entityType: 'staff', entityId: person.id, actor: portalUser.name || 'администратор', createdAt: new Date().toISOString() }); demoSave(); return demoStaffPublic(person); }
  if (path === '/api/audit') { let localAudit = []; try { localAudit = JSON.parse(localStorage.getItem('territory_crm_demo_audits') || '[]'); } catch (_) {} return { items: [...demoState.audit, ...localAudit].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 300) }; }
  if (path === '/api/finance/summary' && ['bartender','hookah_master','senior_bartender','senior_hookah_master','cleaner','security','technician','other_staff'].includes(String(portalUser.role || '').toLowerCase())) {
    const timezone = demoSelectedVenue().timezone || 'Asia/Yekaterinburg';
    const dayKey = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
    const date = dayKey(new Date());
    const venueId = String(demoSelectedVenue().id);
    const actorId = String(portalUser.id || portalUser.name || '');
    const revenue = demoReadOrders().filter((order) => String(order.venueId || venueId) === venueId && String(order.openedById || order.openedBy || '') === actorId)
      .flatMap((order) => order.payments || [])
      .filter((payment) => ['paid', 'partially_paid'].includes(payment.status) && payment.createdAt && dayKey(payment.createdAt) === date)
      .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    return { date, revenue, employeeView: true };
  }  if (path === '/api/finance/summary') { const reportDate = new URL(url, window.location.origin).searchParams.get('date') || localDateKey(); const localOrders = demoReadOrders(); let localDiscounts = []; try { localDiscounts = JSON.parse(localStorage.getItem('territory_crm_discount_requests') || '[]'); } catch (_) {} const pending = demoPendingSummary(localOrders); const currentShift = demoState.shift && !demoState.shift.closedAt ? demoState.shift : null; const shiftClosed = currentShift ? localOrders.filter((order) => order.status === 'closed' && String(order.closedInShiftId || '') === String(currentShift.id)) : []; const shiftRevenue = shiftClosed.reduce((sum, order) => sum + (order.payments || []).filter((payment) => ['paid', 'partially_paid'].includes(payment.status)).reduce((total, payment) => total + Number(payment.amount || 0), 0), 0); const closed = localOrders.filter((order) => order.status === 'closed' && localDateKey(order.closedAt || order.createdAt) === reportDate); const byPaymentMethod = {}; let revenue = 0; closed.forEach((order) => (order.payments || []).filter((payment) => payment.status === 'paid').forEach((payment) => { const amount = Number(payment.amount || 0); revenue += amount; byPaymentMethod[payment.method || 'не указан'] = (byPaymentMethod[payment.method || 'не указан'] || 0) + amount; })); return { date: reportDate, revenue, closedOrders: closed.length, paymentCount: closed.reduce((sum, order) => sum + (order.payments || []).filter((payment) => payment.status === 'paid').length, 0), byPaymentMethod, currentShiftOrders: shiftClosed.length, currentShiftAverageCheck: shiftClosed.length ? shiftRevenue / shiftClosed.length : 0, pendingOrders: pending.pendingOrders, pendingRevenue: pending.pendingRevenue, pendingDiscounts: [...localDiscounts, ...demoState.discounts].filter((item) => item.status === 'requested').length }; }
  if (path === '/api/finance/report' && ['bartender','hookah_master','senior_bartender','senior_hookah_master','cleaner','security','technician','other_staff'].includes(portalUser.role)) {
    const timezone = demoSelectedVenue().timezone || 'Asia/Yekaterinburg';
    const dayKey = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
    const date = dayKey(new Date());
    const venueId = String(demoSelectedVenue().id);
    const ownOrders = demoReadOrders().filter((order) => String(order.venueId || venueId) === venueId && String(order.openedById || order.openedBy || '') === String(portalUser.id || portalUser.name || ''));
    const revenue = ownOrders.flatMap((order) => order.payments || []).filter((payment) => ['paid','partially_paid'].includes(payment.status) && payment.createdAt && dayKey(payment.createdAt) === date).reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    const checksCount = ownOrders.filter((order) => order.status === 'closed' && order.closedAt && dayKey(order.closedAt) === date).length;
    return { type: 'x', date, generatedAt: new Date().toISOString(), reportNumber: 'DEMO-X-' + date, revenue: Math.round(revenue * 100) / 100, checksCount, employeeView: true };
  }
  if (path === '/api/finance/report') { const params = new URL(url, window.location.origin).searchParams; const reportDate = params.get('date') || localDateKey(); const type = params.get('type') === 'waiter' ? 'waiter' : 'x'; let localOrders = []; try { localOrders = JSON.parse(localStorage.getItem('territory_crm_staff_orders') || '[]'); } catch (_) {} const closed = localOrders.filter((order) => order.status === 'closed' && localDateKey(order.closedAt || order.createdAt) === reportDate); const byPaymentMethod = {}, byStation = {}, byStaff = {}; let revenue = 0, paymentCount = 0; closed.forEach((order) => { const payments = (order.payments || []).filter((payment) => payment.status === 'paid'); payments.forEach((payment) => { const amount = Number(payment.amount || 0); revenue += amount; paymentCount += 1; byPaymentMethod[payment.method || 'не указан'] = (byPaymentMethod[payment.method || 'не указан'] || 0) + amount; }); (order.items || []).forEach((item) => { const station = item.station || 'other'; byStation[station] = (byStation[station] || 0) + Number(item.unitPrice || 0) * Number(item.quantity || 0); }); const staff = order.createdByName || order.waiterName || 'Не указан'; byStaff[staff] = (byStaff[staff] || 0) + Number(order.finalTotal || 0); }); return { type, date: reportDate, generatedAt: new Date().toISOString(), reportNumber: `DEMO-${reportDate.replace(/-/g, '')}-${type.toUpperCase()}`, cashier: portalUser.name || 'Кассир', checksCount: closed.length, closedOrders: closed.length, paymentCount, revenue, cash: byPaymentMethod.cash || 0, card: byPaymentMethod.card || 0, qr: byPaymentMethod.qr || 0, byPaymentMethod, byStation, byStaff: type === 'waiter' ? byStaff : undefined }; }
  if (path === '/api/inventory/departments' && method === 'GET') return { items: demoState.inventoryDepartments || (demoState.inventoryDepartments = [{ id: 'kitchen', code: 'kitchen', name: 'Кухня', description: 'Продукты, заготовки и блюда', color: 'coral', sortOrder: 10, active: true }, { id: 'bar', code: 'bar', name: 'Бар', description: 'Напитки, сиропы и чай', color: 'amber', sortOrder: 20, active: true }, { id: 'hookah', code: 'hookah', name: 'Кальяны', description: 'Табак, уголь и расходники', color: 'violet', sortOrder: 30, active: true }, { id: 'inventory', code: 'inventory', name: 'Хозяйственный склад', description: 'Расходники и инвентарь', color: 'green', sortOrder: 40, active: true }]) };
  if (path === '/api/inventory/departments' && method === 'POST') { if (!portalPermissions.has('inventory')) throw new Error('HTTP 403'); const name = String(input.name || '').trim(); const code = String(input.code || '').trim(); if (!name || !code) throw new Error('invalid_inventory_department'); demoState.inventoryDepartments ||= []; if (demoState.inventoryDepartments.some((item) => item.active !== false && item.code === code)) throw new Error('inventory_department_exists'); const item = { id: code, code, name, description: String(input.description || '').trim(), color: 'coral', sortOrder: demoState.inventoryDepartments.length * 10 + 10, active: true }; demoState.inventoryDepartments.push(item); demoSave(); return item; }
  if (path === '/api/product-categories' && method === 'GET') return { items: demoState.productCategories.filter((item) => item.active) };
  if (path === '/api/product-categories' && method === 'POST') { if (!portalPermissions.has('inventory')) throw new Error('HTTP 403'); const name = String(input.name || '').trim(); const department = String(input.department || 'inventory').trim(); if (!name || name.length > 80) throw new Error('invalid_product_category'); if (!demoState.inventoryDepartments?.some((item) => item.active !== false && String(item.id || item.code) === department)) throw new Error('inventory_department_not_found'); if (demoState.productCategories.some((item) => item.active && item.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'))) throw new Error('product_category_exists'); const category = { id: `demo-product-category-${Date.now()}`, name, department, active: true }; demoState.productCategories.push(category); demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'product_category.created', entityType: 'product_category', entityId: category.id, actor: portalUser.name || 'администратор', createdAt: new Date().toISOString() }); demoSave(); return category; }
  const demoProductCategory = path.match(/^\/api\/product-categories\/([^/]+)$/); if (demoProductCategory && method === 'PATCH') { if (!portalPermissions.has('inventory')) throw new Error('HTTP 403'); const category = demoState.productCategories.find((item) => item.id === demoProductCategory[1]); if (!category) throw new Error('HTTP 404'); const name = String(input.name || '').trim(); const department = String(input.department ?? category.department ?? 'inventory').trim(); if (!name || name.length > 80) throw new Error('invalid_product_category'); if (!demoState.inventoryDepartments?.some((item) => item.active !== false && String(item.id || item.code) === department)) throw new Error('inventory_department_not_found'); if (demoState.productCategories.some((item) => item.active && item.id !== category.id && item.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'))) throw new Error('product_category_exists'); category.name = name; category.department = department; demoSave(); return category; }
  if (demoProductCategory && method === 'DELETE') { if (!portalPermissions.has('inventory')) throw new Error('HTTP 403'); const category = demoState.productCategories.find((item) => item.id === demoProductCategory[1]); if (!category) throw new Error('HTTP 404'); category.active = false; demoSave(); return category; }
  if (path === '/api/products' && method === 'GET') return { items: demoState.products };
   if (path === '/api/recipes' && method === 'GET') return { items: (demoState.recipes || []).map((recipe) => ({ ...recipe, yieldQuantity: recipe.yieldQuantity || 1, yieldUnit: recipe.yieldUnit || 'порция', portionCount: recipe.portionCount || 1 })) }; if (path === '/api/recipes' && method === 'POST') { if (!portalPermissions.has('inventory')) throw new Error('HTTP 403'); const name=String(input.name||'').trim(); const category=String(input.category||'').trim(); if(category.length>80) throw new Error('invalid_recipe'); const ingredients=Array.isArray(input.ingredients)?input.ingredients.slice(0,50):[]; const recipeType=['sale','premix'].includes(String(input.recipeType||'sale'))?String(input.recipeType||'sale'):'sale'; const productId=input.productId?String(input.productId):null; if(!name||name.length>120||!ingredients.length) throw new Error('invalid_recipe'); if(recipeType==='premix'&&productId) throw new Error('premix_product_binding_not_allowed'); if(productId&&!(demoState.products||[]).some((item)=>String(item.id)===productId)) throw new Error('recipe_product_not_found'); const output=normalizeDemoRecipeOutput(input); const recipe={id:`demo-recipe-${Date.now()}`,name,category,ingredients,productId:recipeType==='sale'?productId:null,recipeType,technology:String(input.technology||'').trim().slice(0,4000),serve:String(input.serve||'').trim().slice(0,1000),...output}; demoState.recipes.push(recipe); demoSave(); return recipe; } const demoRecipePath=path.match(/^\/api\/recipes\/([^/]+)$/); if(demoRecipePath&&method==='PATCH'){ if(!portalPermissions.has('inventory')) throw new Error('HTTP 403'); const recipe=demoState.recipes.find((item)=>item.id===demoRecipePath[1]); if(!recipe) throw new Error('HTTP 404'); const recipeType=['sale','premix'].includes(String(input.recipeType||recipe.recipeType||'sale'))?String(input.recipeType||recipe.recipeType||'sale'):'sale'; const productId=input.productId!==undefined?(input.productId?String(input.productId):null):(recipe.productId||null); if(recipeType==='premix'&&productId) throw new Error('premix_product_binding_not_allowed'); if(productId&&!(demoState.products||[]).some((item)=>String(item.id)===productId)) throw new Error('recipe_product_not_found'); const next={name:String(input.name||recipe.name).trim(),category:String(input.category??recipe.category??'').trim(),ingredients:Array.isArray(input.ingredients)?input.ingredients.slice(0,50):recipe.ingredients,productId:recipeType==='premix'?null:productId,recipeType,technology:String(input.technology ?? recipe.technology ?? '').trim().slice(0,4000),serve:String(input.serve ?? recipe.serve ?? '').trim().slice(0,1000)}; if (input.yieldQuantity !== undefined || input.yieldUnit !== undefined || input.portionCount !== undefined || input.yield !== undefined || input.portions !== undefined) Object.assign(next, normalizeDemoRecipeOutput(input, recipe)); if(next.category.length>80) throw new Error('invalid_recipe'); Object.assign(recipe,next); demoSave(); return recipe; } if(demoRecipePath&&method==='DELETE'){ if(!portalPermissions.has('inventory')) throw new Error('HTTP 403'); const index=demoState.recipes.findIndex((item)=>item.id===demoRecipePath[1]); if(index<0) throw new Error('HTTP 404'); const [recipe]=demoState.recipes.splice(index,1); demoSave(); return recipe; }
  const demoPremixAction = path.match(/^\/api\/inventory\/premixes\/([^/]+)\/(waste|count|void)$/);
  if (demoPremixAction && method === 'POST') {
    if (!portalPermissions.has('inventory')) throw new Error('HTTP 403');
    const batch = (demoState.premixBatches || []).find((entry) => String(entry.id) === decodeURIComponent(demoPremixAction[1])); if (!batch) throw new Error('premix_batch_not_found');
    const action = demoPremixAction[2]; const item = demoState.inventory.find((entry) => String(entry.id) === String(batch.outputItemId)); if (!item) throw new Error('premix_output_item_not_found');
    const remaining = demoPremixRemaining(batch); const reason = String(input.reason || '').trim(); if (action !== 'void' && (!reason || reason.length > 200)) throw new Error('premix_batch_reason_required');
    if ((batch.status || 'produced') === 'voided') throw new Error('premix_batch_not_active');
    if (action === 'void') {
      const sourceItems = (batch.ingredients || []).map((component) => demoState.inventory.find((entry) => String(entry.id) === String(component.ingredientId)));
      if (sourceItems.some((source) => !source)) throw new Error('premix_ingredient_not_found');
      const outputIndex = (demoState.movements || []).findIndex((movement) => movement.id === batch.outputMovementId);
      const later = outputIndex >= 0 && demoState.movements.slice(outputIndex + 1).some((movement) => String(movement.itemId) === String(item.id));
      if ((batch.lotMovements || []).length || later || Math.abs(remaining - Number(batch.outputQuantity)) > 0.000001) throw new Error('premix_batch_cannot_be_voided_after_stock_activity');
      if (Number(item.onHand) + 0.000001 < remaining) throw new Error('insufficient_stock');
      item.onHand = Number((Number(item.onHand) - remaining).toFixed(6));
      for (const component of batch.ingredients || []) { const source = demoState.inventory.find((entry) => String(entry.id) === String(component.ingredientId)); source.onHand = Number((Number(source.onHand || 0) + Number(component.quantity)).toFixed(6)); demoState.movements.push({ id: `demo-premix-reversal-${Date.now()}-${Math.random()}`, itemId: source.id, itemName: source.name, delta: Number(component.quantity), direction: 'in', reason: `Возврат сырья при отмене партии ${batch.id}`, createdAt: new Date().toISOString() }); }
      item.cost = Number(batch.previousOutputCost || 0); batch.status = 'voided'; batch.voidReason = reason || 'Ошибка выпуска'; batch.voidedAt = new Date().toISOString(); batch.voidedBy = portalUser.name || null;
    } else {
      let delta;
      if (action === 'waste') { const quantity = Number(input.quantity); if (!Number.isFinite(quantity) || quantity <= 0 || quantity > remaining) throw new Error('invalid_premix_batch_quantity'); delta = -quantity; }
      else { const count = Number(input.actualQuantity); if (!Number.isFinite(count) || count < 0) throw new Error('invalid_premix_batch_count'); delta = count - remaining; if (Math.abs(delta) < 0.000001) return { id: batch.id, remainingQuantity: remaining }; }
      if (Number(item.onHand) + delta < -0.000001) throw new Error('insufficient_stock'); item.onHand = Number((Number(item.onHand) + delta).toFixed(6));
      const movementId = `demo-premix-${action}-${Date.now()}-${Math.random()}`; batch.lotMovements ||= []; batch.lotMovements.push({ movementId, type: action === 'waste' ? 'waste' : 'adjustment', quantityDelta: delta, reason, createdAt: new Date().toISOString(), createdBy: portalUser.name || 'Сотрудник' });
      demoState.movements.push({ id: movementId, itemId: item.id, itemName: item.name, delta, direction: delta < 0 ? 'waste' : 'adjustment', reason, createdAt: new Date().toISOString() });
    }
    const now = new Date().toISOString(); if (action === 'void') demoState.movements.push({ id: `demo-premix-action-${Date.now()}`, itemId: item.id, itemName: item.name, delta: -remaining, direction: 'out', reason: reason || 'Отмена выпуска', createdAt: now });
    demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: `inventory.premix_batch_${action}`, entityType: 'premix', entityId: batch.id, actor: portalUser.name || 'администратор', afterData: batch, createdAt: now }); demoSave(); return { id: batch.id, status: batch.status || 'produced', remainingQuantity: action === 'void' ? 0 : demoPremixRemaining(batch) };
  }
  if (path === '/api/inventory/premixes' && method === 'GET') return { items: (demoState.premixBatches || []).slice().reverse().map((batch) => ({ ...batch, outputQuantity: Number(batch.outputQuantity ?? batch.quantity ?? 0), outputUnit: batch.outputUnit || batch.unit || '', plannedOutputQuantity: Number(batch.plannedOutputQuantity ?? batch.outputQuantity ?? batch.quantity ?? 0), remainingQuantity: demoPremixRemaining(batch), producedBy: batch.producedBy || null, status: batch.status === 'available' ? 'produced' : (batch.status || 'produced'), expired: Boolean(batch.expiresAt && new Date(batch.expiresAt).getTime() <= Date.now()) })) };
  if (path === '/api/inventory/premixes/produce' && method === 'POST') {
    if (!portalPermissions.has('inventory')) throw new Error('HTTP 403');
    const recipe = (demoState.recipes || []).find((item) => item.id === input.recipeId && (item.recipeType || 'sale') === 'premix');
    const output = demoState.inventory.find((item) => item.id === input.outputItemId);
    const multiplier = Number(input.multiplier || 1);
    if (!recipe || !output || !Number.isFinite(multiplier) || multiplier <= 0) throw new Error('invalid_premix_production');
    const requirementsById = new Map(); let totalCost = 0;
    for (const entry of recipe.ingredients || []) {
      const item = demoState.inventory.find((candidate) => candidate.id === entry.ingredientId || String(candidate.name).toLocaleLowerCase('ru-RU') === String(entry.name || '').toLocaleLowerCase('ru-RU'));
      if (!item) throw new Error('premix_ingredient_not_found');
      if (String(item.id) === String(output.id)) throw new Error('premix_output_cannot_be_an_ingredient');
      const parsed = parseDemoRecipeQuantity(entry.quantity, item.unit, entry.unit || null);
      if (parsed.error) throw Object.assign(new Error(parsed.error), { payload: { error: parsed.error, ingredient: item.name, sourceUnit: parsed.sourceUnit, targetUnit: parsed.targetUnit } });
      const quantity = Number((parsed.amount * parsed.factor * multiplier).toFixed(6));
      const previous = requirementsById.get(String(item.id));
      if (previous) previous.quantity = Number((previous.quantity + quantity).toFixed(6));
      else requirementsById.set(String(item.id), { item, quantity, unit: item.unit });
    }
    const requirements = [...requirementsById.values()];
    for (const requirement of requirements) {
      const onHand = Number(requirement.item.onHand || 0);
      if (onHand < requirement.quantity) throw new Error('insufficient_premix_stock');
      totalCost += requirement.quantity * Number(requirement.item.cost || 0);
    }
    const parsedYield = parseDemoRecipeQuantity(recipe.yieldQuantity, output.unit, recipe.yieldUnit || null);
    if (parsedYield.error) throw Object.assign(new Error('premix_output_unit_mismatch'), { payload: { error: 'premix_output_unit_mismatch', sourceUnit: parsedYield.sourceUnit || recipe.yieldUnit, targetUnit: output.unit } });
    const plannedOutputQuantity = Number((parsedYield.amount * parsedYield.factor * multiplier).toFixed(6)); const actualOutput = input.actualOutput === undefined || input.actualOutput === '' ? null : Number(input.actualOutput); if (actualOutput !== null && (!Number.isFinite(actualOutput) || actualOutput <= 0)) throw new Error('invalid_premix_production'); const outputQuantity = Number(((actualOutput ?? Number(recipe.yieldQuantity) * multiplier) * parsedYield.factor).toFixed(6)); const expiresAt = input.expiresAt ? new Date(input.expiresAt).toISOString() : null;
    const previousOutputCost = Number(output.cost || 0);
    const sourceMovements = requirements.map((requirement) => ({ requirement, movementId: `demo-premix-source-${Date.now()}-${Math.random()}` })); for (const { requirement, movementId } of sourceMovements) demoAllocatePremixConsumption(requirement.item, requirement.quantity, movementId, `Приготовление премикса «${recipe.name}»`, { apply: false }); for (const { requirement, movementId } of sourceMovements) { const before = Number(requirement.item.onHand || 0); demoAllocatePremixConsumption(requirement.item, requirement.quantity, movementId, `Приготовление премикса «${recipe.name}»`); requirement.item.onHand = Number((before - requirement.quantity).toFixed(6)); demoState.movements.push({ id: movementId, itemId: requirement.item.id, itemName: requirement.item.name, delta: -requirement.quantity, direction: 'out', reason: `Приготовление премикса «${recipe.name}»`, createdAt: new Date().toISOString() }); }
    output.onHand = Number((Number(output.onHand || 0) + outputQuantity).toFixed(6));
    const batch = { id: `demo-premix-${Date.now()}`, recipeId: recipe.id, recipeName: recipe.name, outputItemId: output.id, outputItemName: output.name, outputQuantity, plannedOutputQuantity, outputUnit: output.unit, totalCost: Math.round(totalCost * 100) / 100, ingredients: requirements.map(({ item, quantity, unit }) => ({ ingredientId: item.id, name: item.name, quantity, unit })), expiresAt, previousOutputCost, producedBy: portalUser.name || 'администратор', createdAt: new Date().toISOString(), status: 'produced', lotMovements: [] };
    const outputMovementId = `demo-premix-output-${Date.now()}`; batch.outputMovementId = outputMovementId; demoState.movements.push({ id: outputMovementId, itemId: output.id, itemName: output.name, delta: outputQuantity, direction: 'in', reason: `Выход премикса «${recipe.name}»`, createdAt: batch.createdAt });
    demoState.premixBatches ||= []; demoState.premixBatches.push(batch); demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'inventory.premix_produced', entityType: 'premix', entityId: batch.id, actor: portalUser.name || 'администратор', afterData: batch, createdAt: batch.createdAt }); demoSave(); return batch;
  }
  if (path === '/api/products' && method === 'POST') { if (!portalPermissions.has('inventory')) throw new Error('HTTP 403'); const name = String(input.name || '').trim(); const category = String(input.category || input.station || '').trim(); const price = Number(input.price); const inventoryMode = String(input.inventoryMode || 'tracked'); const aliases = Array.isArray(input.aliases) ? input.aliases.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 30) : []; if (!name || name.length > 120 || !category || category.length > 80 || !Number.isFinite(price) || price < 0 || price > 10000000 || !['tracked','non_stock'].includes(inventoryMode)) throw new Error('invalid_product'); const product = { id: `demo-product-${Date.now()}`, name, category, station: category, price, aliases, inventoryMode, imageUrl: input.imageUrl || null }; demoState.products.push(product); demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'product.created', entityType: 'product', entityId: product.id, actor: portalUser.name || 'администратор', createdAt: new Date().toISOString() }); demoSave(); return product; }
  const productProfile = path.match(/^\/api\/products\/([^/]+)$/); if (productProfile && method === 'PATCH') { if (!portalPermissions.has('inventory')) throw new Error('HTTP 403'); const product = demoState.products.find((item) => item.id === productProfile[1]); if (!product) throw new Error('HTTP 404'); const before = { ...product }; if (input.name !== undefined) product.name = String(input.name || '').trim(); if (input.category !== undefined || input.station !== undefined) { product.category = String(input.category ?? input.station ?? '').trim(); product.station = product.category; } if (input.price !== undefined) product.price = Number(input.price); if (input.inventoryMode !== undefined) { if (!['tracked','non_stock','needs_review'].includes(String(input.inventoryMode))) throw new Error('invalid_product'); if (input.inventoryMode === 'non_stock' && (demoState.recipes || []).some((recipe) => recipe.active !== false && recipe.recipeType !== 'premix' && recipe.productId === product.id)) throw new Error('non_stock_product_has_recipe'); if (input.inventoryMode === 'non_stock' && demoReadOrders().some((order) => ['open','in_progress','ready'].includes(order.status) && (order.items || []).some((item) => item.productId === product.id))) throw new Error('product_has_open_orders'); product.inventoryMode = String(input.inventoryMode); } if (input.aliases !== undefined) product.aliases = Array.isArray(input.aliases) ? input.aliases.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 30) : []; if (input.imageUrl !== undefined) product.imageUrl = input.imageUrl || null; demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'product.updated', entityType: 'product', entityId: product.id, actor: portalUser.name || 'администратор', beforeData: before, afterData: product, createdAt: new Date().toISOString() }); demoSave(); return product; }
  if (productProfile && method === 'DELETE') { if (!portalPermissions.has('inventory')) throw new Error('HTTP 403'); const index = demoState.products.findIndex((item) => item.id === productProfile[1]); if (index < 0) throw new Error('HTTP 404'); const [product] = demoState.products.splice(index, 1); demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'product.deactivated', entityType: 'product', entityId: product.id, actor: portalUser.name || 'администратор', createdAt: new Date().toISOString() }); demoSave(); return { ...product, active: false }; }
  const productPath = path.match(/^\/api\/products\/([^/]+)\/image$/); if (productPath && method === 'POST') { if (!portalPermissions.has('inventory')) throw new Error('HTTP 403'); if (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(input.imageData || '')) || String(input.imageData || '').length > 2_000_000) throw new Error('invalid_image'); const product = demoState.products.find((x) => x.id === productPath[1]); if (product) { const hadImage = Boolean(product.imageUrl); product.imageUrl = input.imageData; demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'product.image_updated', entityType: 'product', entityId: product.id, actor: portalUser.name || 'администратор', beforeData: { imageUrl: hadImage ? '[image]' : null }, afterData: { imageUrl: '[image]' }, createdAt: new Date().toISOString() }); } demoSave(); return product; }
  const demoPurchasePath = path.match(/^\/api\/inventory\/purchase-documents\/([^/]+)$/);
  const demoPurchasePostPath = path.match(/^\/api\/inventory\/purchase-documents\/([^/]+)\/post$/);
  const demoPurchaseVoidPath = path.match(/^\/api\/inventory\/purchase-documents\/([^/]+)\/void$/);
  const demoPurchaseUnitFactors = demoRecipeUnitFactors;
  const demoPurchaseLine = (line) => {
    const item = demoState.inventory.find((entry) => entry.id === line.ingredientId);
    if (!item) throw new Error('purchase_ingredient_not_found');
    const sourceUnit = String(line.unit || '').trim();
    const packageFactor = item.purchaseUnit && sourceUnit.toLocaleLowerCase('ru-RU') === String(item.purchaseUnit).trim().toLocaleLowerCase('ru-RU') ? Number(item.packMultiplier || 1) : null;
    const factor = packageFactor || demoPurchaseUnitFactors[sourceUnit]?.[item.unit];
    if (!factor || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0 || !Number.isFinite(Number(line.unitCost)) || Number(line.unitCost) < 0) throw new Error('invalid_purchase_unit');
    return { ingredientId: item.id, ingredientName: item.name, stockUnit: item.unit, quantity: Number(line.quantity), unit: sourceUnit, packMultiplier: factor, stockQuantity: Number((Number(line.quantity) * factor).toFixed(6)), unitCost: Number(line.unitCost), receiptUnitCost: Number((Number(line.unitCost) / factor).toFixed(6)), lineTotal: Number((Number(line.quantity) * Number(line.unitCost)).toFixed(2)) };
  };
  const demoAssertAutoOrderAllocation = (sourceAutoOrderId, documentId, lines) => {
    if (!sourceAutoOrderId) return null;
    const request = (demoState.inventoryAutoOrders || []).find((entry) => entry.id === sourceAutoOrderId);
    if (!request) throw new Error('invalid_source_auto_order');
    if (!['sent', 'partially_received'].includes(request.status)) throw new Error('source_auto_order_not_open');
    const ordered = new Map((request.lines || []).map((line) => [String(line.itemId), line]));
    const requested = new Map();
    for (const line of lines) {
      const orderLine = ordered.get(String(line.ingredientId));
      if (!orderLine) throw new Error('purchase_item_not_in_auto_order');
      if (String(line.stockUnit) !== String(orderLine.unit)) throw new Error('auto_order_unit_mismatch');
      requested.set(String(line.ingredientId), (requested.get(String(line.ingredientId)) || 0) + Number(line.stockQuantity || 0));
    }
    const reserved = new Map();
    for (const doc of demoState.inventoryPurchaseDocuments || []) {
      if (doc.id === documentId || doc.sourceAutoOrderId !== sourceAutoOrderId || doc.status !== 'draft') continue;
      for (const line of doc.lines || []) reserved.set(String(line.ingredientId), (reserved.get(String(line.ingredientId)) || 0) + Number(line.stockQuantity || 0));
    }
    for (const [itemId, quantity] of requested) {
      const orderLine = ordered.get(itemId);
      const remaining = Number(orderLine.quantity || 0) - Number(orderLine.receivedQuantity || 0) - Number(reserved.get(itemId) || 0);
      if (quantity > remaining + 0.000001) throw new Error('purchase_quantity_exceeds_auto_order');
    }
    return request;
  };
  if (new URL(path, window.location.href).pathname === '/api/inventory/purchase-documents' && method === 'GET') {
    const filterUrl = new URL(path, window.location.href); const params = filterUrl.searchParams;
    const from = params.get('documentDateFrom') || ''; const to = params.get('documentDateTo') || '';
    const status = params.get('status') || ''; const includeUndated = params.get('includeUndated') === 'true';
    const items = (demoState.inventoryPurchaseDocuments || []).filter((item) => {
      if (status && item.status !== status) return false;
      if (!from && !to) return true;
      if (!item.documentDate) return includeUndated;
      const date = String(item.documentDate).slice(0, 10);
      return (!from || date >= from) && (!to || date <= to);
    }).slice().sort((a, b) => {
      const aDate = a.documentDate ? String(a.documentDate).slice(0, 10) : '';
      const bDate = b.documentDate ? String(b.documentDate).slice(0, 10) : '';
      return bDate.localeCompare(aDate) || String(b.recordedAt || '').localeCompare(String(a.recordedAt || '')) || String(b.id).localeCompare(String(a.id));
    });
    return { items };
  }
  if (path === '/api/inventory/purchase-documents' && method === 'POST') {
    if (!portalPermissions.has('inventory')) throw new Error('HTTP 403');
    const lines = (Array.isArray(input.lines) ? input.lines : []).map(demoPurchaseLine);
    if (!lines.length) throw new Error('purchase_document_empty');
    demoAssertAutoOrderAllocation(input.sourceAutoOrderId || null, null, lines);
    const now = new Date().toISOString();
    const document = { id: `demo-purchase-${Date.now()}`, supplierName: String(input.supplierName || 'Не указан').trim(), documentNumber: String(input.documentNumber || '').trim() || null, documentDate: String(input.documentDate || '').trim() || null, recordedAt: now, status: 'draft', note: String(input.note || '').trim() || null, sourceAutoOrderId: input.sourceAutoOrderId || null, lineCount: lines.length, totalCost: Number(lines.reduce((sum, line) => sum + line.lineTotal, 0).toFixed(2)), lines };
    demoState.inventoryPurchaseDocuments ||= []; demoState.inventoryPurchaseDocuments.push(document); demoSave(); return document;
  }
  if (demoPurchasePath && method === 'GET') { const doc = (demoState.inventoryPurchaseDocuments || []).find((entry) => entry.id === demoPurchasePath[1]); if (!doc) throw new Error('purchase_document_not_found'); return doc; }
  if (demoPurchasePath && method === 'PATCH') {
    if (!portalPermissions.has('inventory')) throw new Error('HTTP 403');
    const doc = (demoState.inventoryPurchaseDocuments || []).find((entry) => entry.id === demoPurchasePath[1]); if (!doc) throw new Error('purchase_document_not_found'); if (doc.status !== 'draft') throw new Error('purchase_document_not_draft');
    const lines = (Array.isArray(input.lines) ? input.lines : []).map(demoPurchaseLine); if (!lines.length) throw new Error('purchase_document_empty');
    const sourceAutoOrderId = input.sourceAutoOrderId === undefined ? doc.sourceAutoOrderId : (input.sourceAutoOrderId || null);
    demoAssertAutoOrderAllocation(sourceAutoOrderId, doc.id, lines);
    Object.assign(doc, { supplierName: String(input.supplierName || 'Не указан').trim(), documentNumber: String(input.documentNumber || '').trim() || null, documentDate: input.documentDate === undefined ? doc.documentDate || null : String(input.documentDate || '').trim() || null, note: String(input.note || '').trim() || null, sourceAutoOrderId, lineCount: lines.length, totalCost: Number(lines.reduce((sum, line) => sum + line.lineTotal, 0).toFixed(2)), lines }); demoSave(); return doc;
  }
  if (demoPurchasePostPath && method === 'POST') {
    if (!portalPermissions.has('inventory')) throw new Error('HTTP 403');
    const doc = (demoState.inventoryPurchaseDocuments || []).find((entry) => entry.id === demoPurchasePostPath[1]); if (!doc) throw new Error('purchase_document_not_found'); if (doc.status !== 'draft') throw new Error('purchase_document_not_postable');
    const sourceOrder = demoAssertAutoOrderAllocation(doc.sourceAutoOrderId, doc.id, doc.lines);
    const prepared = doc.lines.map((line) => { const item = demoState.inventory.find((entry) => entry.id === line.ingredientId); if (!item) throw new Error('purchase_ingredient_archived'); if (item.active === false) throw new Error('purchase_ingredient_archived'); if (item.unit !== line.stockUnit) throw new Error('purchase_item_unit_changed'); const normalized = demoPurchaseLine(line); if (normalized.packMultiplier !== line.packMultiplier) throw new Error('purchase_item_unit_changed'); return { item, line }; });
    const movementIds = []; const now = new Date().toISOString();
    for (const { item, line } of prepared) { const before = Number(item.onHand || 0); const after = before + line.stockQuantity; item.cost = Number((after > 0 ? (before * Number(item.cost || 0) + line.stockQuantity * line.receiptUnitCost) / after : line.receiptUnitCost).toFixed(4)); item.onHand = Number(after.toFixed(6)); const movement = { id: `demo-movement-${Date.now()}-${movementIds.length}`, itemId: item.id, itemName: item.name, delta: line.stockQuantity, direction: 'in', unit: item.unit, reason: `Поставка по документу ${doc.documentNumber || doc.id}`, createdAt: now, sourceDocumentId: doc.id }; demoState.movements.push(movement); movementIds.push(movement.id); line.sourceMovementId = movement.id; }
    if (sourceOrder) {
      const received = new Map();
      for (const line of doc.lines) received.set(String(line.ingredientId), (received.get(String(line.ingredientId)) || 0) + Number(line.stockQuantity || 0));
      sourceOrder.lines = (sourceOrder.lines || []).map((line) => ({ ...line, receivedQuantity: Number((Number(line.receivedQuantity || 0) + (received.get(String(line.itemId)) || 0)).toFixed(6)) }));
      sourceOrder.status = sourceOrder.lines.length && sourceOrder.lines.every((line) => Number(line.receivedQuantity || 0) >= Number(line.quantity || 0) - 0.000001) ? 'received' : 'partially_received'; sourceOrder.updatedAt = now;
    }
    doc.status = 'posted'; doc.postedAt = now; doc.lineCount = doc.lines.length; demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'inventory.purchase_document_posted', entityType: 'purchase_document', entityId: doc.id, actor: portalUser.name || 'администратор', afterData: doc, createdAt: now }); demoSave(); return { document: doc, movementIds, totalCost: doc.totalCost };
  }
  if (demoPurchaseVoidPath && method === 'POST') {
    if (!portalPermissions.has('inventory')) throw new Error('HTTP 403');
    const doc = (demoState.inventoryPurchaseDocuments || []).find((entry) => entry.id === demoPurchaseVoidPath[1]);
    if (!doc) throw new Error('purchase_document_not_found');
    if (doc.status !== 'draft') throw new Error('purchase_document_not_voidable');
    doc.status = 'voided'; doc.voidedAt = new Date().toISOString(); demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'inventory.purchase_document_voided', entityType: 'purchase_document', entityId: doc.id, actor: portalUser.name || 'администратор', afterData: doc, createdAt: doc.voidedAt }); demoSave(); return doc;
  }
  if (path === '/api/inventory/auto-orders' && method === 'GET') {
    const items = demoState.inventory.filter((item) => Number(item.minLevel || 0) > 0 && Number(item.onHand || 0) <= Number(item.minLevel || 0)).map((item) => {
      const onHand = Number(item.onHand || 0); const minLevel = Number(item.minLevel || 0); const packMultiplier = Math.max(0.000001, Number(item.packMultiplier || 1));
      const targetLevel = Math.max(minLevel * 2, minLevel + packMultiplier); const shortage = Math.max(0, targetLevel - onHand); const orderQuantity = Math.ceil(shortage / packMultiplier) * packMultiplier;
      return { id: item.id, name: item.name, department: item.department, subdepartment: item.subdepartment, category: item.category, unit: item.unit, purchaseUnit: item.purchaseUnit || item.unit, packMultiplier, supplier: item.supplier || null, cost: Number(item.cost || 0), onHand, minLevel, targetLevel: Number(targetLevel.toFixed(6)), shortage: Number(shortage.toFixed(6)), orderQuantity: Number(orderQuantity.toFixed(6)), estimate: Number((orderQuantity * Number(item.cost || 0)).toFixed(2)) };
    });
    return { items, requests: (demoState.inventoryAutoOrders || []).slice().reverse().slice(0, 20) };
  }
  if (path === '/api/inventory/auto-orders' && method === 'POST') {
    if (!portalPermissions.has('inventory')) throw new Error('HTTP 403');
    const rawItems = Array.isArray(input.items) ? input.items.slice(0, 100) : [];
    if (!rawItems.length) throw new Error('auto_order_items_required');
    const requestedLines = rawItems.map((line) => ({ itemId: String(line.itemId || '').trim(), quantity: Number(line.quantity) }));
    if (requestedLines.some((line) => !line.itemId || !Number.isFinite(line.quantity) || line.quantity <= 0)) throw new Error('invalid_auto_order_lines');
    const lines = requestedLines.map((line) => {
      const item = demoState.inventory.find((entry) => entry.id === line.itemId);
      if (!item) throw new Error('auto_order_item_not_found');
      const pack = Math.max(0.000001, Number(item.packMultiplier || 1)); const quantity = Number((Math.ceil(line.quantity / pack) * pack).toFixed(6));
      return { itemId: item.id, name: item.name, quantity, receivedQuantity: 0, unit: item.unit, purchaseUnit: item.purchaseUnit || item.unit, packMultiplier: Number(item.packMultiplier || 1), supplier: item.supplier || null, unitCost: Number(item.cost || 0), estimate: Number((quantity * Number(item.cost || 0)).toFixed(2)) };
    });
    const totalEstimate = Number(lines.reduce((sum, line) => sum + line.estimate, 0).toFixed(2)); const now = new Date().toISOString();
    const request = { id: `demo-auto-order-${Date.now()}-${(demoState.inventoryAutoOrders || []).length + 1}`, venueId: String(demoSelectedVenue().id), status: 'sent', lines, note: String(input.note || '').trim().slice(0, 500) || null, totalEstimate, createdAt: now, sentAt: now };
    demoState.inventoryAutoOrders ||= []; demoState.inventoryAutoOrders.push(request);
    demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'inventory.auto_order_sent', entityType: 'inventory_auto_order', entityId: request.id, actor: portalUser.name || 'администратор', afterData: request, createdAt: now });
    demoSave(); return request;
  }
  const demoAutoOrderPath = path.match(/^\/api\/inventory\/auto-orders\/([^/]+)$/);
  if (demoAutoOrderPath && method === 'PATCH') {
    if (!portalPermissions.has('inventory')) throw new Error('HTTP 403');
    if (input.status === 'received' || input.status === 'partially_received' || Array.isArray(input.receipts)) throw new Error('purchase_document_required');
    if (input.status !== 'cancelled') throw new Error('invalid_auto_order_status');
    const request = (demoState.inventoryAutoOrders || []).find((entry) => entry.id === demoAutoOrderPath[1]);
    if (!request) throw new Error('auto_order_not_found');
    if (!['sent', 'partially_received'].includes(request.status)) throw new Error('auto_order_not_cancellable');
    if ((demoState.inventoryPurchaseDocuments || []).some((doc) => doc.sourceAutoOrderId === request.id && doc.status === 'draft')) throw new Error('auto_order_has_draft_receipts');
    request.status = 'cancelled'; request.updatedAt = new Date().toISOString();
    demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'inventory.auto_order_cancelled', entityType: 'inventory_auto_order', entityId: request.id, actor: portalUser.name || 'администратор', afterData: request, createdAt: request.updatedAt });
    demoSave(); return request;
  }
  const demoVisibleAlcoholLink = (id, currentId = null) => { if (id === null || id === undefined || id === '') return null; const venueId = String(demoState.networkCurrentId || demoDefaultVenue.id); const entry = (demoState.alcoholCatalogItems || []).find((candidate) => String(candidate.id) === String(id) && (candidate.scope === 'organization' || candidate.venueId === venueId)); if (!entry || (entry.active === false && String(currentId || '') !== String(id))) throw new Error('alcohol_catalog_item_not_found'); return String(entry.id); };
  if (path === '/api/inventory' && method === 'GET') { const visibleAlcohol=new Map((demoState.alcoholCatalogItems||[]).filter((entry)=>entry.scope==='organization'||entry.venueId===String(demoState.networkCurrentId||demoDefaultVenue.id)).map((entry)=>[String(entry.id),entry])); const items=demoState.inventory.map((item)=>({...item,alcoholCatalogItemId:item.alcoholCatalogItemId||null,alcoholCatalogItem:visibleAlcohol.get(String(item.alcoholCatalogItemId||''))||null})); return { items, lowStock: items.filter((x) => x.onHand <= x.minLevel), movements: demoState.movements.slice().reverse() }; }
  if (path === '/api/inventory/items' && method === 'POST') { if (!portalPermissions.has('inventory')) throw new Error('HTTP 403'); const alcoholCatalogItemId = demoVisibleAlcoholLink(input.alcoholCatalogItemId); const name = String(input.name || '').trim(); const item = { id: `demo-ing-${Date.now()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`, name, shortName: String(input.shortName || '').trim(), category: String(input.category || 'Без категории').trim(), department: String(input.department || 'inventory'), itemType: String(input.itemType || 'ingredient'), unit: String(input.unit || 'шт'), purchaseUnit: String(input.purchaseUnit || '').trim(), packMultiplier: Number(input.packMultiplier || 1), cost: Number(input.cost || 0), minLevel: Number(input.minLevel || 0), supplier: String(input.supplier || '').trim(), barcode: String(input.barcode || '').trim(), note: String(input.note || '').trim(), alcoholCatalogItemId, onHand: 0 }; if (!name || name.length > 120 || !Number.isFinite(item.cost) || item.cost < 0 || !Number.isFinite(item.minLevel) || item.minLevel < 0) throw new Error('invalid_inventory_item'); demoState.inventory.push(item); demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'inventory.item_created', entityType: 'inventory', entityId: item.id, actor: portalUser.name || 'администратор', createdAt: new Date().toISOString() }); demoSave(); return item; }
  const demoInventoryItem = path.match(/^\/api\/inventory\/items\/([^/]+)$/); if (demoInventoryItem && method === 'PATCH') { if (!portalPermissions.has('inventory')) throw new Error('HTTP 403'); const item = demoState.inventory.find((entry) => entry.id === demoInventoryItem[1]); if (!item) throw new Error('HTTP 404'); if (input.alcoholCatalogItemId !== undefined) input.alcoholCatalogItemId = demoVisibleAlcoholLink(input.alcoholCatalogItemId, item.alcoholCatalogItemId); Object.assign(item, input); demoSave(); return item; } if (demoInventoryItem && method === 'DELETE') { if (!portalPermissions.has('inventory')) throw new Error('HTTP 403'); const index = demoState.inventory.findIndex((entry) => entry.id === demoInventoryItem[1]); if (index < 0) throw new Error('HTTP 404'); const [item] = demoState.inventory.splice(index, 1); demoSave(); return item; }
  if (path === '/api/inventory/movements' && method === 'POST') { if (!portalPermissions.has('inventory')) throw new Error('HTTP 403'); const item = demoState.inventory.find((x) => x.id === input.itemId); const delta = Number(input.delta); const reason = String(input.reason || 'Корректировка').trim(); if (!item || !Number.isFinite(delta) || delta === 0 || item.onHand + delta < 0) throw new Error('HTTP 409'); if (reason.length > 200) throw new Error('movement_reason_too_long'); const before = Number(item.onHand); const movement = { id: `demo-mov-${Date.now()}`, itemId: item.id, itemName: item.name, delta, reason: reason || 'Корректировка', direction: delta < 0 ? 'out' : 'adjustment', createdAt: new Date().toISOString() }; if (delta < 0) demoAllocatePremixConsumption(item, -delta, movement.id, reason); item.onHand = Number((before + delta).toFixed(6)); demoState.movements.push(movement); demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'inventory.movement', entityType: 'inventory', entityId: item.id, actor: 'администратор', beforeData: { onHand: before }, afterData: { onHand: item.onHand, delta }, createdAt: movement.createdAt }); demoSave(); return movement; }
  const demoFloorTable = path.match(/^\/api\/floor\/tables\/([^/]+)$/);
  const demoFloorZone = path.match(/^\/api\/floor\/zones\/([^/]+)$/);
  if (path === '/api/floor' || path === '/api/floor/zones' || path === '/api/floor/tables' || demoFloorZone || demoFloorTable) {
    const { venueId, state } = demoFloorContext();
    if (method !== 'GET') {
      if (!portalPermissions.has('settings')) throw demoDiscountError('forbidden');
      demoFloorPrecondition(input, venueId);
    }
    if (path === '/api/floor' && method === 'GET') {
      const vip = demoSelectedVenue().vipRoomMinimums || { vip_room_1: 1500, vip_room_2: 2500 };
      if (!Array.isArray(state.floorZones)) state.floorZones = venueId === demoDefaultVenue.id
        ? [{ id: 'hall', name: 'Зал', sortOrder: 0, tables: Array.from({ length: 12 }, (_, i) => ({ id: `table-${i + 1}`, name: `Стол ${i + 1}`, status: 'free', capacity: 2, layout: {}, minimumOrderTotal: 0 })) }, { id: 'vip', name: 'VIP-комнаты', sortOrder: 1, tables: [{ id: 'vip-room-1', name: 'VIP-комната 1', status: 'free', capacity: 4, layout: {}, minimumOrderTotal: vip.vip_room_1 }, { id: 'vip-room-2', name: 'VIP-комната 2', status: 'free', capacity: 6, layout: {}, minimumOrderTotal: vip.vip_room_2 }] }]
        : [];
      return { venueId, zones: state.floorZones.map((zone) => ({ ...zone, tables: (zone.tables || []).map((table) => ({ ...table, minimumOrderTotal: venueId === demoDefaultVenue.id && table.id === 'vip-room-1' ? vip.vip_room_1 : venueId === demoDefaultVenue.id && table.id === 'vip-room-2' ? vip.vip_room_2 : Number(table.minimumOrderTotal || 0) })) })) };
    }
    state.floorZones ||= [];
    if (path === '/api/floor/zones' && method === 'POST') {
      const name = String(input.name || '').trim();
      if (!name || name.length > 80) throw demoDiscountError('invalid_zone_name');
      const zone = { id: `demo-zone-${globalThis.crypto?.randomUUID?.() || Date.now()}`, name, sortOrder: Number(input.sortOrder ?? state.floorZones.length), tables: [] };
      state.floorZones.push(zone); demoSave(); return zone;
    }
    if (demoFloorZone && method === 'PATCH') {
      const zone = state.floorZones.find((entry) => entry.id === demoFloorZone[1]);
      if (!zone) throw demoDiscountError('zone_not_found');
      const name = String(input.name || '').trim();
      if (!name || name.length > 80) throw demoDiscountError('invalid_zone_name');
      zone.name = name; demoSave(); return zone;
    }
    if (demoFloorZone && method === 'DELETE') {
      const index = state.floorZones.findIndex((entry) => entry.id === demoFloorZone[1]);
      if (index < 0) throw demoDiscountError('zone_not_found');
      const zone = state.floorZones[index];
      if (zone.tables?.length) throw demoDiscountError('zone_not_empty');
      state.floorZones.splice(index, 1); demoSave(); return zone;
    }
    if (path === '/api/floor/tables' && method === 'POST') {
      const zone = state.floorZones.find((entry) => entry.id === String(input.zoneId || ''));
      if (!zone) throw demoDiscountError('zone_not_found');
      const name = String(input.name || '').trim();
      const capacity = Number(input.capacity || 2);
      const minCapacity = Number(input.minCapacity ?? capacity);
      const maxCapacity = Number(input.maxCapacity ?? capacity);
      const minimumOrderTotal = Number(input.minimumOrderTotal || 0);
      const requestedLayout = input.layout && typeof input.layout === 'object' && !Array.isArray(input.layout) ? input.layout : {};
      const amenities = requestedLayout.amenities && typeof requestedLayout.amenities === 'object' && !Array.isArray(requestedLayout.amenities) ? { playstation5: Boolean(requestedLayout.amenities.playstation5), television: Boolean(requestedLayout.amenities.television) } : { playstation5: false, television: false };
      if (!name || name.length > 80) throw demoDiscountError('invalid_table_name');
      if (![capacity, minCapacity, maxCapacity].every(Number.isInteger) || capacity < 1 || capacity > 100 || minCapacity < 1 || maxCapacity < minCapacity || maxCapacity > 100) throw demoDiscountError('invalid_table_capacity');
      if (!Number.isFinite(minimumOrderTotal) || minimumOrderTotal < 0) throw demoDiscountError('invalid_vip_minimum');
      const table = { id: `demo-table-${globalThis.crypto?.randomUUID?.() || Date.now()}`, name, status: 'free', capacity, minCapacity, maxCapacity, minimumOrderTotal, layout: { amenities } };
      zone.tables.push(table); demoSave(); return table;
    }
    if (demoFloorTable && method === 'PATCH') {
      const id = demoFloorTable[1];
      const table = state.floorZones.flatMap((zone) => zone.tables || []).find((entry) => entry.id === id);
      if (!table) throw demoDiscountError('table_not_found');
      const layout = input.layout && typeof input.layout === 'object' ? input.layout : {};
      const changes = {};
      if (input.name !== undefined) { const name = String(input.name).trim(); if (!name || name.length > 80) throw demoDiscountError('invalid_table_name'); changes.name = name; }
      if (input.capacity !== undefined || input.minCapacity !== undefined || input.maxCapacity !== undefined) {
        const capacity = Number(input.capacity ?? input.maxCapacity ?? input.minCapacity);
        const minCapacity = Number(input.minCapacity ?? capacity);
        const maxCapacity = Number(input.maxCapacity ?? capacity);
        if (![capacity, minCapacity, maxCapacity].every(Number.isInteger) || capacity < 1 || capacity > 100 || minCapacity < 1 || maxCapacity < minCapacity || maxCapacity > 100) throw demoDiscountError('invalid_table_capacity');
        Object.assign(changes, { capacity, minCapacity, maxCapacity });
      }
      if (input.minimumOrderTotal !== undefined) { const minimum = Number(input.minimumOrderTotal); if (!Number.isFinite(minimum) || minimum < 0) throw demoDiscountError('invalid_vip_minimum'); changes.minimumOrderTotal = minimum; }
      if (input.status !== undefined) { if (!['free', 'blocked'].includes(String(input.status))) throw demoDiscountError('invalid_table_status'); changes.status = String(input.status); }
      Object.assign(table, changes);
      table.layout = { ...(table.layout || {}), ...layout };
      state.floorLayout ||= {}; state.floorLayout[id] = table.layout;
      demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'floor_table.updated', entityType: 'floor_table', entityId: id, actor: portalUser.name || 'администратор', afterData: table, createdAt: new Date().toISOString() });
      demoSave(); return table;
    }
    if (demoFloorTable && method === 'DELETE') {
      const zone = state.floorZones.find((entry) => entry.tables?.some((table) => table.id === demoFloorTable[1]));
      const index = zone?.tables?.findIndex((table) => table.id === demoFloorTable[1]) ?? -1;
      if (!zone || index < 0) throw demoDiscountError('table_not_found');
      if (demoReadOrders().some((order) => order.tableId === demoFloorTable[1] && ['open', 'in_progress', 'ready'].includes(order.status))) throw demoDiscountError('table_in_use');
      const [table] = zone.tables.splice(index, 1); demoSave(); return table;
    }
  }  if (path === '/api/reservations' && method === 'GET') return { items: demoState.reservations };
  if (path === '/api/reservations' && method === 'POST') { if (!portalPermissions.has('reservations')) throw new Error('HTTP 403'); if (!String(input.guestName || '').trim() || String(input.guestName).trim().length > 120) throw new Error('guest_name_too_long'); if (input.notes !== undefined && String(input.notes).length > 2000) throw new Error('reservation_notes_too_long'); const vip = demoState.venue?.vipRoomMinimums || { vip_room_1: 1500, vip_room_2: 2500 }; const minimums = { 'vip-room-1': vip.vip_room_1, 'vip-room-2': vip.vip_room_2 }; const deposit = Number(input.deposit || 0); const guests = Number(input.guests || 1); const when = `${input.date || ''}T${input.time || ''}:00`; if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.date || '')) || !/^\d{2}:\d{2}$/.test(String(input.time || '')) || Number.isNaN(Date.parse(when)) || Date.parse(when) <= Date.now()) throw new Error('invalid_reservation_datetime'); if (input.phone && !/^\+7[0-9 ()-]{7,24}$/.test(String(input.phone).trim())) throw new Error('invalid_guest_phone'); if (!Number.isInteger(guests) || guests < 1 || guests > 50) throw new Error('invalid_guest_count'); const minimum = Number(minimums[input.tableId] || 0); if (String(input.tableId).includes('blocked')) throw new Error('table_unavailable'); if (demoState.reservations.some((entry) => entry.status === 'confirmed' && entry.tableId === input.tableId && entry.date === input.date && entry.time === input.time)) throw new Error('table_already_reserved'); if (!Number.isFinite(deposit) || deposit < minimum) throw new Error(`vip_deposit_below_minimum:${minimum}`); const reservation = { id: `demo-res-${Date.now()}`, ...input, guests, status: 'confirmed', tableName: input.tableId, deposit: 0, depositRequired: deposit, depositPaid: 0, createdBy: portalUser.id || null, createdByName: portalUser.name || 'Сотрудник', createdByRole: portalRole[0] || 'Сотрудник', createdAt: new Date().toISOString() }; demoState.reservations.push(reservation); demoSave(); return reservation; }
  const reservationPrePayment = path.match(/^\/api\/reservations\/([^/]+)\/deposit-receipts$/);
  if (reservationPrePayment && method === 'POST') {
    if (!portalPermissions.has('reservations')) throw new Error('HTTP 403');
    const reservation = demoState.reservations.find((entry) => entry.id === reservationPrePayment[1] && String(entry.venueId || demoSelectedVenue().id) === String(demoSelectedVenue().id));
    if (!reservation) throw new Error('HTTP 404');
    const amount = Number(input.amount), methodName = String(input.method || ''), reason = String(input.reason || 'Предоплата по бронированию').trim(), key = String(input.idempotencyKey || '');
    if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100 || amount > 10000000) throw new Error('invalid_deposit_amount');
    if (!['cash','card','qr'].includes(methodName)) throw new Error('invalid_payment_method');
    if (!reason || reason.length > 500 || key.length < 8 || key.length > 120) throw new Error('invalid_idempotency_key');
    reservation.prepaymentReceipts ||= [];
    const prior = reservation.prepaymentReceipts.find((entry) => entry.idempotencyKey === key);
    if (prior) { if (Number(prior.amount) !== amount || prior.method !== methodName || prior.reason !== reason) throw new Error('idempotency_key_reused'); return { receipt: prior, replayed: true, depositRequired: Number(reservation.depositRequired || 0), verifiedDepositPaid: Number(reservation.verifiedDepositPaid || 0), remaining: Math.max(0, Number(reservation.depositRequired || 0) - Number(reservation.verifiedDepositPaid || 0)) }; }
    if (reservation.status !== 'confirmed') throw new Error('reservation_not_confirmed');
    if (Number(reservation.legacyDepositPaid ?? reservation.depositPaid ?? 0) > 0) throw new Error('legacy_deposit_requires_reconciliation');
    if (!demoState.activeShift) throw new Error('open_shift_required');
    const required = Number(reservation.depositRequired ?? reservation.deposit ?? 0), verified = Number(reservation.verifiedDepositPaid || 0);
    if (amount > required - verified) throw new Error('deposit_exceeds_required');
    const receipt = { id: 'demo-reservation-receipt-' + (globalThis.crypto?.randomUUID?.() || Date.now()), reservationId: reservation.id, shiftId: demoState.activeShift.id, amount, method: methodName, reason, idempotencyKey: key, actorId: portalUser.id || null, actorName: portalUser.name || 'Сотрудник', createdAt: new Date().toISOString() };
    reservation.prepaymentReceipts.push(receipt); reservation.verifiedDepositPaid = verified + amount;
    demoState.audit.push({ id: 'demo-audit-' + Date.now(), action: 'reservation.prepayment_received', entityType: 'reservation', entityId: reservation.id, actor: portalUser.name || 'Сотрудник', afterData: receipt, createdAt: receipt.createdAt });
    demoSave(); return { receipt, replayed: false, depositRequired: required, verifiedDepositPaid: reservation.verifiedDepositPaid, remaining: Math.max(0, required - reservation.verifiedDepositPaid) };
  }
  const reservationCancel = path.match(/^\/api\/reservations\/([^/]+)\/cancel$/); if (reservationCancel && method === 'POST') { if (!portalPermissions.has('reservations')) throw new Error('HTTP 403'); const reservation = demoState.reservations.find((x) => x.id === reservationCancel[1]); if (!reservation) throw new Error('HTTP 404'); if (reservation.status !== 'confirmed') throw new Error('reservation_not_found_or_cancelled'); reservation.status = 'cancelled'; demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: 'reservation.cancelled', entityType: 'reservation', entityId: reservation.id, actor: 'администратор', createdAt: new Date().toISOString() }); demoSave(); return reservation; }
  if (path === '/api/discount-requests' && method === 'GET') { let localItems = []; try { localItems = JSON.parse(localStorage.getItem('territory_crm_discount_requests') || '[]'); } catch (_) {} return { items: [...localItems, ...demoState.discounts] }; }
  const demoNotificationReadPath = path.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (path === '/api/notifications' || demoNotificationReadPath) {
    const managerRoles = ['owner', 'admin', 'manager', 'developer'];
    if (!managerRoles.includes(portalUser.role) || ['bartender','hookah_master','senior_bartender','senior_hookah_master','cleaner','security','technician','other_staff'].includes(portalUser.role)) throw new Error('HTTP 403');
    const venueId = String(demoSelectedVenue().id); const role = portalUser.role;
    const canDiscount = ['owner', 'admin'].includes(role) && portalPermissions.has('finance_read') && portalPermissions.has('orders');
    const canAutoOrder = ['owner', 'admin', 'manager'].includes(role) && portalPermissions.has('inventory_read');
    const canOrderDelete = ['owner', 'admin', 'manager'].includes(role) && portalPermissions.has('orders');
    const canStaffPin = ['owner', 'admin'].includes(role) && (portalPermissions.has('staff_view') || portalPermissions.has('staff'));
    if (![canDiscount, canAutoOrder, canOrderDelete, canStaffPin].some(Boolean)) throw new Error('HTTP 403');
    const readKey = `territory_crm_notification_reads:${String(portalUser.id || portalUser.login || role)}:${venueId}`;
    let readState = {}; try { readState = JSON.parse(localStorage.getItem(readKey) || '{}'); } catch (_) {}
    let staffItems = [], localDiscounts = []; try { staffItems = JSON.parse(localStorage.getItem('territory_crm_staff_notifications') || '[]'); } catch (_) {} try { localDiscounts = JSON.parse(localStorage.getItem('territory_crm_discount_requests') || '[]'); } catch (_) {}
    const events = [];
    if (canDiscount) for (const item of [...localDiscounts, ...(demoState.discounts || [])]) if (item.status === 'requested' && String(item.venueId || '') === venueId && (!item.notificationRecipients?.length || item.notificationRecipients.includes(role))) events.push({ id: `discount:${item.id}`, type: 'discount', title: 'Запрошена скидка', summary: 'Запрос ожидает решения', createdAt: item.createdAt, orderId: item.orderId, href: '/orders', requiresAction: true });
    if (canAutoOrder) for (const item of demoState.inventoryAutoOrders || []) if (item.status === 'sent' && String(item.venueId || '') === venueId) events.push({ id: `inventory_auto_order:${item.id}`, type: 'inventory_auto_order', title: 'Заявка на пополнение', summary: 'Заявка отправлена и ожидает обработки', createdAt: item.createdAt, autoOrderId: item.id, href: '/inventory?view=auto-orders', requiresAction: false });
    for (const item of staffItems) {
      if (String(item.venueId || '') !== venueId || item.notificationRecipients?.length && !item.notificationRecipients.includes(role)) continue;
      if (item.type === 'order_deleted' && canOrderDelete) events.push({ id: `order_deleted:${item.id}`, type: item.type, title: 'Заказ удалён', summary: 'Проверьте событие в журнале заказов', createdAt: item.createdAt, orderId: item.orderId, href: '/orders', requiresAction: false });
          }
    events.sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));
    for (const item of events) item.readAt = readState[item.id] || null;
    const unreadCount = events.filter((item) => !item.readAt).length;
    if (demoNotificationReadPath && method === 'PUT') {
      let id; try { id = decodeURIComponent(demoNotificationReadPath[1]); } catch (_) { throw new Error('notification_not_found'); }
      const item = events.find((entry) => entry.id === id); if (!item) throw new Error('notification_not_found');
      const readAt = new Date().toISOString(); readState[id] = readAt; localStorage.setItem(readKey, JSON.stringify(readState));
      return { id, readAt, unreadCount: Math.max(0, unreadCount - (item.readAt ? 0 : 1)) };
    }
    if (path === '/api/notifications' && method === 'POST') {
      const readAt = new Date().toISOString(); events.forEach((item) => { readState[item.id] = readState[item.id] || readAt; }); localStorage.setItem(readKey, JSON.stringify(readState)); return { unreadCount: 0 };
    }
    if (path === '/api/notifications' && method === 'GET') {
      const query = new URL(url, window.location.origin).searchParams; const limit = Math.min(50, Math.max(1, Number(query.get('limit') || 20))); const filtered = query.get('filter') === 'unread' ? events.filter((item) => !item.readAt) : events;
      return { items: filtered.slice(0, limit), unreadCount, hasMore: filtered.length > limit };
    }
  }
  const discountDecision = path.match(/^\/api\/discount-requests\/([^/]+)\/(approve|reject)$/); if (discountDecision && method === 'POST') { if (!portalPermissions.has('finance')) throw new Error('HTTP 403'); let localItems = []; try { localItems = JSON.parse(localStorage.getItem('territory_crm_discount_requests') || '[]'); } catch (_) {} const decision = discountDecision[2] === 'approve' ? 'approved' : 'rejected'; const localRequest = localItems.find((x) => x.id === discountDecision[1]); if (localRequest) { const orderError = demoDiscountOrderError(localRequest); if (orderError) throw orderError; if (localRequest.status !== 'requested') throw new Error('discount_already_decided'); if (decision === 'approved') { const proposed = localItems.map((entry) => entry === localRequest ? { ...entry, status: decision } : entry); const balanceError = demoPaidOrderBalanceError(localRequest, [...proposed, ...demoState.discounts]); if (balanceError) throw balanceError; } localRequest.status = decision; localRequest.decidedAt = new Date().toISOString(); localStorage.setItem('territory_crm_discount_requests', JSON.stringify(localItems)); demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: `discount.${decision}`, entityType: 'discount', entityId: localRequest.id, actor: 'администратор', createdAt: new Date().toISOString() }); demoSave(); return localRequest; } const request = demoState.discounts.find((x) => x.id === discountDecision[1]); if (!request) throw new Error('HTTP 404'); const orderError = demoDiscountOrderError(request); if (orderError) throw orderError; if (request.status !== 'requested') throw new Error('discount_already_decided'); if (decision === 'approved') { const proposed = demoState.discounts.map((entry) => entry === request ? { ...entry, status: decision } : entry); const balanceError = demoPaidOrderBalanceError(request, [...localItems, ...proposed]); if (balanceError) throw balanceError; } request.status = decision; request.decidedAt = new Date().toISOString(); demoState.audit.push({ id: `demo-audit-${Date.now()}`, action: `discount.${decision}`, entityType: 'discount', entityId: request.id, actor: 'администратор', createdAt: new Date().toISOString() }); demoSave(); return request; }
  return {};
};
const api = (url, options = {}) => { if (staticDemo()) return demoJson(url, options); return window.fetch(url, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } }).then(async (response) => { if (response.status === 401) { disposeNotificationObserver(); try { localStorage.removeItem('crm_session_token'); localStorage.removeItem('crm_session_user'); } catch {} window.location.href = '/login'; const error = new Error('authentication_required'); error.status = 401; error.payload = { error: 'authentication_required' }; throw error; } const payload = await response.json().catch(() => ({})); if (!response.ok) { const error = new Error(payload.error || `HTTP ${response.status}`); error.payload = payload; throw error; } return payload; }); };
window.__crmApi = api;
const refreshSidebarCounters = () => {
  const setBadge = (href, value, label, { markProblem = false } = {}) => document.querySelectorAll(`.portal-sidebar a[href="${href}"]`).forEach((link) => {
    const count = Number(value || 0); let badge = link.querySelector('.sidebar-count');
    if (!count) { badge?.remove(); link.removeAttribute('data-sidebar-attention'); return; }
    if (!badge) { badge = document.createElement('span'); badge.className = 'sidebar-count'; link.append(badge); }
    badge.textContent = markProblem ? '!' : count > 99 ? '99+' : String(count); badge.title = label; badge.setAttribute('aria-label', `${label}: ${count}`); link.dataset.sidebarAttention = 'true';
  });
  Promise.allSettled([api('/api/metrics'), api('/api/notifications?limit=1&filter=unread'), api('/api/shifts'), api('/api/integrations')]).then(([metrics, notifications, shifts, integrations]) => {
    const data = metrics.status === 'fulfilled' ? metrics.value : {};
    setBadge('/orders', data.openOrders, 'Открытые заказы');
    setBadge('/reservations', data.reservationsToday, 'Брони на сегодня');
    setBadge('/inventory?view=stock', data.lowStock, 'Позиции ниже минимума');
    setBadge('/admin#tasks', data.discountRequests, 'Заявки, требующие внимания');
    setBadge('/admin#notifications', notifications.status === 'fulfilled' ? notifications.value.unreadCount : 0, 'Непрочитанные уведомления');
    setBadge('/', shifts.status === 'fulfilled' && shifts.value?.current ? 1 : 0, 'Незакрытая смена');
    const integrationData = integrations.status === 'fulfilled' ? integrations.value : null;
    const integrationProblem = integrationData && integrationData.telegram && integrationData.telegram.status !== 'connected';
    setBadge('/integrations', integrationProblem ? 1 : 0, 'Проблема интеграции', { markProblem: true });
  });
};
refreshSidebarCounters();
refreshLeaderNotifications(); notificationRefreshTimer = setInterval(refreshLeaderNotifications, 20000);

document.addEventListener('submit', (event) => { const form = event.target; if (['client-form', 'reservation-form', 'movement-form', 'inventory-item-form', 'recipe-form', 'product-form', 'purchase-document-form', 'loyalty-form-visible', 'expense-form', 'deposit-topup-form'].includes(form.id) || form.classList?.contains('payable-payment-form')) return; const button = form?.querySelector('button[type=submit],button:not([type])'); if (!button || button.disabled) return; button.disabled = true; button.dataset.submitLabel = button.textContent; button.textContent = 'Сохранение…'; window.setTimeout(() => { if (button.isConnected) { button.disabled = false; button.textContent = button.dataset.submitLabel || 'Сохранить'; } }, 6000); });

document.querySelectorAll('[data-route]').forEach((link) => {
  if (link.dataset.route === page && !location.hash) link.classList.add('active');
});

const portalShiftListeners = new Set();
let portalShiftRequest = null;
let portalShiftActionPending = false;
let portalShiftFingerprint = '';
const publishPortalShift = (data, error = null) => { portalShiftListeners.forEach((listener) => listener(data, error)); };
portalShiftListeners.add((data,error)=>{if(error)return;const key=JSON.stringify(data?.current||null);if(key===portalShiftFingerprint)return;portalShiftFingerprint=key;});
const refreshPortalShiftState = () => {
  const shift = document.querySelector('.portal-header .header-shift-status');
  const canRead = !portalPermissions || portalPermissions.has('floor') || portalPermissions.has('orders') || portalPermissions.has('finance_read');
  if (!canRead || document.visibilityState === 'hidden' || portalShiftActionPending) return Promise.resolve(null);
  if (portalShiftRequest) return portalShiftRequest;
  portalShiftRequest = api('/api/shifts').then((data) => {
    if (!data || !Object.prototype.hasOwnProperty.call(data, 'current')) throw new Error('invalid_shift_response');
    const currentShift = data?.current; const open = Boolean(currentShift);
    if (shift) { shift.hidden = false; shift.textContent = open ? `● Смена открыта${currentShift.openedByName ? ` · ${String(currentShift.openedByName)}` : ''}` : '● Смена закрыта'; shift.title = open && currentShift.openedByName ? `Смену открыл(а): ${String(currentShift.openedByName)}` : ''; shift.dataset.shiftState = open ? 'open' : 'closed'; shift.classList.toggle('offline', !open); }
    publishPortalShift(data, null); return data;
  }).catch((error) => { if (shift) { shift.hidden = false; shift.textContent = '● Статус смены недоступен'; shift.dataset.shiftState = 'error'; shift.classList.toggle('offline', true); } publishPortalShift(null, error); return null; }).finally(() => { portalShiftRequest = null; });
  return portalShiftRequest;
};
const refreshVisiblePortalShift = () => {
  return refreshPortalShiftState();
};
if (typeof window !== 'undefined' && window.setInterval) {
  const pollPortalShift = () => { if (document.visibilityState !== 'hidden' && !portalShiftActionPending && (!portalPermissions || portalPermissions.has('floor') || portalPermissions.has('orders') || portalPermissions.has('finance_read'))) refreshPortalShiftState(); };
  window.setInterval(pollPortalShift, 20000);
  document.addEventListener('visibilitychange', pollPortalShift);
  window.addEventListener('focus', pollPortalShift);
}
let portalContextGeneration = 0;
const refreshPortalContext = async () => {
  const generation = ++portalContextGeneration;
  const shift = document.querySelector('.portal-header .header-shift-status');
  const vipSummary = document.querySelector('#vip-minimum-summary');
  if (vipSummary) vipSummary.textContent = 'Проверяем минимумы…';
  document.querySelectorAll('[data-venue-name],[data-venue-address],[data-metric]').forEach((node) => { node.textContent = '—'; });
  document.querySelectorAll('[data-admin-avatar]').forEach((node) => { node.textContent = 'T'; });
  venueTimezone = '';
  const canReadShift = portalPermissions.has('floor') || portalPermissions.has('orders') || portalPermissions.has('finance_read');
  if (shift && canReadShift) { shift.textContent = '● Проверяем смену…'; shift.dataset.shiftState = 'loading'; shift.classList.add('offline'); }
  if (shift && !canReadShift) shift.hidden = true;
  const results = await Promise.allSettled([api('/api/venue'), api('/api/metrics'), shift && canReadShift ? refreshVisiblePortalShift() : Promise.resolve(null)]);
  if (generation !== portalContextGeneration) return { stale: true, failed: [] };
  const [venueResult, metricsResult, shiftResult] = results;
  const failed = [];
  if (venueResult.status === 'fulfilled' && venueResult.value) {
    const venue = venueResult.value;
    venueTimezone = String(venue.timezone || ''); updateDashboardGreeting();
    document.querySelectorAll('[data-venue-name]').forEach((node) => { node.textContent = venue.name || 'Hookah POS'; });
    document.querySelectorAll('[data-venue-address]').forEach((node) => { node.textContent = [venue.city, venue.address].filter(Boolean).join(', ') || 'Адрес не указан'; });
    document.querySelectorAll('[data-admin-avatar]').forEach((node) => { node.innerHTML = venue.logoUrl ? `<img src="${esc(venue.logoUrl)}" alt="Логотип">` : 'T'; });
    const vip = venue.vipRoomMinimums || {}; const summary = document.querySelector('#vip-minimum-summary');
    if (summary) summary.textContent = `Комната 1 — ${money(vip.vip_room_1 ?? 1500)} · Комната 2 — ${money(vip.vip_room_2 ?? 2500)}`;
  } else { failed.push('заведение'); document.querySelectorAll('[data-venue-name]').forEach((node) => { node.textContent = 'Заведение недоступно'; }); if (vipSummary) vipSummary.textContent = 'Минимумы недоступны'; }
  if (metricsResult.status === 'fulfilled' && metricsResult.value) {
    const metrics = metricsResult.value;
    document.querySelectorAll('[data-metric]').forEach((node) => { const key = node.dataset.metric; node.textContent = metrics[key] === undefined ? '—' : key === 'staffActive' ? formatActiveStaffCount(metrics[key]) : metrics[key]; });
  } else failed.push('показатели');
  if (shift) {
    if (shiftResult.status === 'fulfilled' && shiftResult.value && Object.prototype.hasOwnProperty.call(shiftResult.value, 'current')) {
      const currentShift = shiftResult.value.current; const open = Boolean(currentShift); shift.textContent = open ? `● Смена открыта${currentShift.openedByName ? ` · ${esc(currentShift.openedByName)}` : ''}` : '● Смена закрыта'; shift.title = open && currentShift.openedByName ? `Смену открыл(а): ${currentShift.openedByName}` : ''; shift.dataset.shiftState = open ? 'open' : 'closed'; shift.classList.toggle('offline', !open);
    } else { failed.push('смена'); shift.textContent = '● Статус смены недоступен'; shift.dataset.shiftState = 'error'; shift.classList.add('offline'); }
  }
  return { failed };
};
refreshPortalContext();
let sessionPreferenceSaveQueue = Promise.resolve();
const saveSessionPreference = (patch) => {
  const queuedToken = localStorage.getItem('crm_session_token');
  const queuedUser = localStorage.getItem('crm_session_user');
  const task = sessionPreferenceSaveQueue.then(() => {
    if (localStorage.getItem('crm_session_token') !== queuedToken || localStorage.getItem('crm_session_user') !== queuedUser) throw new Error('session_changed');
    return api('/api/session/preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  });
  sessionPreferenceSaveQueue = task.catch(() => {});
  return task;
};
const preferenceSessionIdentity = () => ({ token: localStorage.getItem('crm_session_token'), user: localStorage.getItem('crm_session_user') });
const samePreferenceSession = (identity) => localStorage.getItem('crm_session_token') === identity.token && localStorage.getItem('crm_session_user') === identity.user;
let preferenceReadWarningShown = false;
const reportPreferenceReadFailure = () => { if (preferenceReadWarningShown) return; preferenceReadWarningShown = true; console.warn('Optional session preferences unavailable; local defaults remain active.'); };
const restoreFailedPreference = async ({ current, latest, identity, read, fallback, apply, message }) => {
  if (!current() || !latest() || !samePreferenceSession(identity)) return;
  let value;
  let verified = false;
  try {
    const data = await api('/api/session/preferences');
    value = read(data?.preferences || {});
    verified = true;
  } catch (_) { value = fallback(); }
  if (!current() || !latest() || !samePreferenceSession(identity)) return;
  apply(value);
  portalNotice(verified ? message : `${message} Не удалось проверить состояние на сервере.`, 'error');
};
function setupFinancePreferences() {
  const settings = document.querySelector('#settings-dashboard-modules');
  if (!settings) return;
  const identity = String(portalUser.id || portalUser.login || portalUser.name || portalUser.role || 'user').toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, '_');
  const key = `crm_finance_metrics_${identity}`;
  const defaults = { revenue: true, profit: true, expenses: true, average: true, median: true, tables: true };
  let selected = { ...defaults };
  let localChanges = 0;
  try { selected = { ...defaults, ...(JSON.parse(localStorage.getItem(key) || '{}')) }; } catch (_) {}
  let confirmed = { ...selected };
  const versions = new Map();
  const controls = [...settings.querySelectorAll('[data-finance-metric-toggle]')];
  const apply = () => controls.forEach((input) => { input.checked = selected[input.dataset.financeMetricToggle] !== false; });
  const current = () => document.querySelector('#settings-dashboard-modules') === settings;
  const readIdentity = preferenceSessionIdentity();
  apply();
  controls.forEach((input) => input.addEventListener('change', () => {
    const name = input.dataset.financeMetricToggle;
    selected[name] = input.checked;
    ++localChanges;
    const version = (versions.get(name) || 0) + 1;
    versions.set(name, version);
    const identity = preferenceSessionIdentity();
    try { localStorage.setItem(key, JSON.stringify(selected)); } catch (_) {}
    saveSessionPreference({ financeMetrics: { [name]: input.checked } }).then((data) => { if (samePreferenceSession(identity) && data?.preferences?.financeMetrics) confirmed = { ...defaults, ...data.preferences.financeMetrics }; }).catch(() => restoreFailedPreference({ current, latest: () => versions.get(name) === version, identity, read: (preferences) => preferences.financeMetrics?.[name] !== false, fallback: () => confirmed[name] !== false, apply: (value) => { selected[name] = value; confirmed[name] = value; try { localStorage.setItem(key, JSON.stringify(selected)); } catch (_) {} apply(); }, message: 'Не удалось сохранить выбор финансовых показателей. Повторите изменение.' }));
  }));
  api('/api/session/preferences').then((data) => {
    if (!current() || !samePreferenceSession(readIdentity) || localChanges || !data?.preferences?.financeMetrics) return;
    selected = { ...defaults, ...data.preferences.financeMetrics };
    confirmed = { ...selected };
    try { localStorage.setItem(key, JSON.stringify(selected)); } catch (_) {}
    apply();
  }).catch(() => { if (current() && samePreferenceSession(readIdentity)) reportPreferenceReadFailure(); });
}
function getFinanceMetricPreferences() {
  const identity = String(portalUser.id || portalUser.login || portalUser.name || portalUser.role || 'user').toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, '_'); const defaults = { revenue: true, profit: true, expenses: true, average: true, median: true, tables: true };
  try { return { ...defaults, ...(JSON.parse(localStorage.getItem(`crm_finance_metrics_${identity}`) || '{}')) }; } catch (_) { return defaults; }
}

function setupDashboardModules() {
  const settings = document.querySelector('#settings-dashboard-modules');
  if (!settings) return;
  const canViewStaff = portalPermissions.has('staff_view');
  if (!canViewStaff) settings.querySelector('[data-dashboard-module-toggle="staff"]')?.closest('label')?.remove();
  for (const name of ['kpi', 'insights', 'quick']) if (!document.querySelector(`[data-dashboard-module="${name}"]`)) settings.querySelector(`[data-dashboard-module-toggle="${name}"]`)?.closest('label')?.remove();
  const roleKey = portalUser.role || 'admin';
  const identityKey = String(portalUser.id || portalUser.login || portalUser.name || roleKey).trim().toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, '_').slice(0, 80) || roleKey;
  const storageKey = `crm_dashboard_modules_user_${identityKey}`;
  const defaults = { kpi: true, insights: true, shift: true, quick: true, staff: true };
  let visible = { ...defaults };
  let localChanges = 0;
  try { visible = { ...defaults, ...(JSON.parse(localStorage.getItem(storageKey) || '{}')) }; } catch (_) {}
  let confirmed = { ...visible };
  const versions = new Map();
  const controls = [...settings.querySelectorAll('[data-dashboard-module-toggle]')];
  const current = () => document.querySelector('#settings-dashboard-modules') === settings;
  const readIdentity = preferenceSessionIdentity();
  const apply = () => {
    if (!current()) return;
    controls.forEach((input) => { input.checked = visible[input.dataset.dashboardModuleToggle] !== false; });
    const focusedAdminPage = window.location.pathname === '/admin' && ['#staff', '#permissions', '#tasks'].includes(window.location.hash);
    document.querySelectorAll('[data-dashboard-module]').forEach((node) => {
      const pageOwnsModule = focusedAdminPage ? node.id === 'staff' : true;
      const shiftFocus = window.location.hash === '#shift-control' && node.id === 'shift-control';
      node.hidden = !pageOwnsModule || (!shiftFocus && visible[node.dataset.dashboardModule] === false);
    });
  };
  controls.forEach((input) => input.addEventListener('change', () => {
    const name = input.dataset.dashboardModuleToggle;
    visible[name] = input.checked;
    ++localChanges;
    const version = (versions.get(name) || 0) + 1;
    versions.set(name, version);
    const identity = preferenceSessionIdentity();
    try { localStorage.setItem(storageKey, JSON.stringify(visible)); } catch (_) {}
    apply();
    saveSessionPreference({ dashboardModules: { [name]: input.checked } }).then((data) => { if (samePreferenceSession(identity) && data?.preferences?.dashboardModules) confirmed = { ...defaults, ...data.preferences.dashboardModules }; }).catch(() => restoreFailedPreference({ current, latest: () => versions.get(name) === version, identity, read: (preferences) => preferences.dashboardModules?.[name] !== false, fallback: () => confirmed[name] !== false, apply: (value) => { visible[name] = value; confirmed[name] = value; try { localStorage.setItem(storageKey, JSON.stringify(visible)); } catch (_) {} apply(); }, message: 'Не удалось сохранить блоки главной. Повторите изменение.' }));
  }));
  apply();
  api('/api/session/preferences').then((data) => {
    if (!current() || !samePreferenceSession(readIdentity) || localChanges || !data?.preferences?.dashboardModules || typeof data.preferences.dashboardModules !== 'object') return;
    visible = { ...defaults, ...data.preferences.dashboardModules };
    confirmed = { ...visible };
    try { localStorage.setItem(storageKey, JSON.stringify(visible)); } catch (_) {}
    apply();
  }).catch(() => { if (current() && samePreferenceSession(readIdentity)) reportPreferenceReadFailure(); });
}

const interfaceModulePermissions = { orders: 'orders', clients: 'staff_view', reservations: 'reservations', floor: 'floor', delivery: 'delivery', inventory: 'inventory_read', finance: 'finance_read', loyalty: 'loyalty', staff: 'staff_view', integrations: 'integrations' };
function setupInterfacePreferences() {
  const settings = document.querySelector('#settings-dashboard-modules');
  const key = `crm_interface_preferences_${String(portalUser.id || portalUser.login || portalUser.role || 'user').toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, '_')}`;
  const defaults = { orders: true, clients: true, reservations: true, floor: true, delivery: true, inventory: true, finance: true, loyalty: true, staff: true, integrations: true };
  let navigation = { ...defaults };
  let localChanges = 0;
  try { const saved = JSON.parse(localStorage.getItem(key) || '{}'); for (const name of Object.keys(defaults)) if (typeof saved.navigationVisibility?.[name] === 'boolean') navigation[name] = saved.navigationVisibility[name]; if (saved.deliveryEnabled === false) navigation.delivery = false; if (saved.integrationsEnabled === false) navigation.integrations = false; } catch (_) {}
  let confirmed = { ...navigation };
  const versions = new Map();
  const hrefs = { orders: '/orders', clients: '/clients', reservations: '/reservations', floor: '/', delivery: '/delivery', inventory: '/inventory', finance: '/finance', loyalty: '/admin#loyalty', staff: '/admin#staff', integrations: '/integrations' };
  const selectors = { inventory: 'a[data-navigation-module="inventory"]', finance: 'a[data-navigation-module="finance"]' };
  const current = () => !settings || document.querySelector('#settings-dashboard-modules') === settings;
  const readIdentity = preferenceSessionIdentity();
  const apply = () => {
    if (!current()) return;
    Object.entries(hrefs).forEach(([name, href]) => document.querySelectorAll(selectors[name] || `a[href="${href}"]`).forEach((link) => {
      const permission = link.dataset.permission || interfaceModulePermissions[name];
      link.hidden = !portalPermissions.has(permission) || navigation[name] === false;
    }));
    refreshSidebarGroups();
  };
  window.__applyInterfacePreferences = apply;
  const controls = [...(settings?.querySelectorAll('[data-interface-toggle]') || [])];
  controls.forEach((toggle) => {
    const name = toggle.dataset.interfaceToggle;
    toggle.checked = navigation[name] !== false;
    toggle.addEventListener('change', () => {
      navigation[name] = toggle.checked;
      ++localChanges;
      const version = (versions.get(name) || 0) + 1;
      versions.set(name, version);
      const identity = preferenceSessionIdentity();
      try { localStorage.setItem(key, JSON.stringify({ navigationVisibility: navigation, deliveryEnabled: navigation.delivery, integrationsEnabled: navigation.integrations })); } catch (_) {}
      apply();
      saveSessionPreference({ navigationVisibility: { [name]: toggle.checked }, ...(name === 'delivery' ? { deliveryEnabled: toggle.checked } : {}), ...(name === 'integrations' ? { integrationsEnabled: toggle.checked } : {}) }).then((data) => { if (!samePreferenceSession(identity)) return; const saved = data?.preferences || {}; if (saved.navigationVisibility) confirmed = { ...confirmed, ...saved.navigationVisibility }; if (typeof saved.deliveryEnabled === 'boolean') confirmed.delivery = saved.deliveryEnabled; if (typeof saved.integrationsEnabled === 'boolean') confirmed.integrations = saved.integrationsEnabled; }).catch(() => restoreFailedPreference({ current, latest: () => versions.get(name) === version, identity, read: (preferences) => { const special = name === 'delivery' ? preferences.deliveryEnabled : name === 'integrations' ? preferences.integrationsEnabled : undefined; return typeof special === 'boolean' ? special : preferences.navigationVisibility?.[name] !== false; }, fallback: () => confirmed[name] !== false, apply: (value) => { navigation[name] = value; confirmed[name] = value; toggle.checked = value; try { localStorage.setItem(key, JSON.stringify({ navigationVisibility: navigation, deliveryEnabled: navigation.delivery, integrationsEnabled: navigation.integrations })); } catch (_) {} apply(); }, message: 'Не удалось сохранить видимость меню. Повторите изменение.' }));
    });
  });
  apply();
  api('/api/session/preferences').then((data) => {
    if (!current() || !samePreferenceSession(readIdentity) || localChanges) return;
    const preferences = data?.preferences || {};
    if (preferences.navigationVisibility && typeof preferences.navigationVisibility === 'object') for (const name of Object.keys(defaults)) if (typeof preferences.navigationVisibility[name] === 'boolean') navigation[name] = preferences.navigationVisibility[name];
    if (typeof preferences.deliveryEnabled === 'boolean') navigation.delivery = preferences.deliveryEnabled;
    if (typeof preferences.integrationsEnabled === 'boolean') navigation.integrations = preferences.integrationsEnabled;
    confirmed = { ...navigation };
    controls.forEach((toggle) => { toggle.checked = navigation[toggle.dataset.interfaceToggle] !== false; });
    apply();
  }).catch(() => { if (current() && samePreferenceSession(readIdentity)) reportPreferenceReadFailure(); });
}
function setupThemePreference() {
  const settings = document.querySelector('#settings-dashboard-modules');
  const controls = [...(settings?.querySelectorAll('[data-theme-toggle]') || [])];
  let localChanges = 0;
  let confirmed = portalTheme;
  const current = () => !settings || document.querySelector('#settings-dashboard-modules') === settings;
  const readIdentity = preferenceSessionIdentity();
  controls.forEach((control) => {
    control.checked = portalTheme === 'light';
    control.addEventListener('change', () => {
      portalTheme = applyPortalTheme(control.checked ? 'light' : 'dark');
      const version = ++localChanges;
      const identity = preferenceSessionIdentity();
      controls.forEach((item) => { item.checked = portalTheme === 'light'; });
      try { localStorage.setItem(themeStorageKey, portalTheme); } catch (_) {}
      saveSessionPreference({ theme: portalTheme }).then((data) => { if (samePreferenceSession(identity) && ['light', 'dark'].includes(data?.preferences?.theme)) confirmed = data.preferences.theme; }).catch(() => restoreFailedPreference({ current, latest: () => version === localChanges, identity, read: (preferences) => ['light', 'dark'].includes(preferences.theme) ? preferences.theme : 'dark', fallback: () => confirmed, apply: (value) => { portalTheme = applyPortalTheme(value); confirmed = portalTheme; try { localStorage.setItem(themeStorageKey, portalTheme); } catch (_) {} controls.forEach((item) => { item.checked = portalTheme === 'light'; }); }, message: 'Не удалось сохранить тему. Повторите изменение.' }));
    });
  });
  api('/api/session/preferences').then((data) => {
    if (!current() || !samePreferenceSession(readIdentity) || localChanges) return;
    const saved = data?.preferences?.theme;
    if (!['light', 'dark'].includes(saved)) return;
    portalTheme = applyPortalTheme(saved);
    confirmed = portalTheme;
    try { localStorage.setItem(themeStorageKey, portalTheme); } catch (_) {}
    controls.forEach((control) => { control.checked = portalTheme === 'light'; });
  }).catch(() => { if (current() && samePreferenceSession(readIdentity)) reportPreferenceReadFailure(); });
}

function setupDashboardInsights() {
  const paymentPanel = document.querySelector('#dashboard-insight-payments');
  const extra = document.querySelector('#dashboard-insight-extra');
  if (!paymentPanel && !extra) return;
  const render = (summary, analytics) => {
    if (paymentPanel) {
      if (!summary) paymentPanel.innerHTML = '<div class="empty">Оплаты временно недоступны</div>';
      else {
        const byPayment = summary.byPaymentMethod || {};
        const paymentRows = [{ key: 'cash', label: 'Наличные', icon: 'cash', tone: 'cash' }, { key: 'card', label: 'Карта', icon: 'credit-card', tone: 'card' }, { key: 'qr', label: 'QR-код', icon: 'qrcode', tone: 'qr' }].filter((item) => Number(byPayment[item.key] || 0) > 0);
        const paymentTotal = paymentRows.reduce((sum, item) => sum + Number(byPayment[item.key] || 0), 0);
        paymentPanel.innerHTML = paymentTotal ? `<div class="insight-payments-head"><div><b>Оплачено сегодня</b></div><strong>${money(paymentTotal)}</strong></div><div class="insight-payment-list">${paymentRows.map((item) => `<div class="insight-payment-row"><span class="insight-payment-icon ${item.tone}">${icon(item.icon)}</span><span>${item.label}</span><strong>${money(byPayment[item.key] || 0)}</strong></div>`).join('')}</div>` : '<div class="insight-payment-empty"><b>Оплат пока нет</b><span>Способы оплаты появятся здесь после первых продаж за сегодня.</span></div>';
      }
    }
    if (extra) {
      if (!analytics) extra.innerHTML = '<div class="empty">Аналитика временно недоступна</div>';
      else {
        const products = (analytics.topProducts || []).slice(0, 3);
        const load = analytics.hallLoad || {};
        const loadText = load.total ? `${load.busy} из ${load.total} столов` : 'Нет данных по залу';
        extra.innerHTML = `<div class="insight-mini insight-profit"><b>Чистая прибыль</b><strong>${analytics.payrollCoverage?.status === 'unsupported' ? 'Недоступно' : money(analytics.netProfit || 0)}</strong><span class="muted">${analytics.payrollCoverage?.status === 'unsupported' ? 'Требуется зарплатный реестр в БД' : 'За последние 7 дней'}</span></div><div class="insight-mini"><b>Средний чек</b><strong>${money(analytics.averageCheck || 0)}</strong><span class="muted">За последние 7 дней</span></div><div class="insight-mini"><b>Загрузка зала</b><strong>${esc(loadText)}</strong><span class="muted">Занятые и забронированные столы</span></div><div class="insight-mini insight-products"><b>Популярные позиции</b>${products.length ? products.map((item) => `<span>${esc(displayName(item.name))} <em>${esc(String(item.quantity))}</em></span>`).join('') : '<span class="muted">Пока нет закрытых заказов</span>'}</div>`;
      }
    }
  };
  Promise.allSettled([api('/api/finance/summary'), api('/api/analytics')]).then(([summaryResult, analyticsResult]) => render(summaryResult.status === 'fulfilled' ? summaryResult.value : null, analyticsResult.status === 'fulfilled' ? analyticsResult.value : null)).catch(() => render(null, null));
}

function setupDashboardShiftKpis() {
  const dateInput = document.querySelector('#dashboard-shift-date');
  const shiftSelect = document.querySelector('#dashboard-shift-select');
  const context = document.querySelector('#dashboard-shift-context');
  const cards = document.querySelector('#dashboard-shift-kpis');
  const warning = document.querySelector('#dashboard-shift-warning');
  if (!dateInput || !shiftSelect || !context || !cards) return;
  let requestRevision = 0;
  let firstLoad = true;
  const render = (data) => {
    if (firstLoad && data.date) dateInput.value = data.date;
    firstLoad = false;
    dateInput.disabled = Boolean(data.employeeView);
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = data.employeeView ? 'Сегодня' : data.shifts.length ? `Все смены · ${data.shifts.length}` : 'Смен нет';
    allOption.selected = true;
    shiftSelect.replaceChildren(allOption);
    if (!data.employeeView) data.shifts.forEach((shift) => {
      const option = document.createElement('option');
      option.value = shift.id;
      const start = new Date(shift.openedAt);
      const end = shift.closedAt ? new Date(shift.closedAt) : null;
      const time = (value) => Number.isNaN(value.getTime()) ? '' : value.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: data.timezone });
      option.textContent = `${time(start)}–${end ? time(end) : 'идёт сейчас'}`;
      shiftSelect.append(option);
    });
    const selectedShiftId = data.selectedShiftId ? String(data.selectedShiftId) : '';
    const validSelectedId = selectedShiftId ? shiftSelect.querySelector(`option[value="${CSS.escape(selectedShiftId)}"]`) : null;
    if (validSelectedId) shiftSelect.value = selectedShiftId;
    else shiftSelect.value = '';
    shiftSelect.disabled = data.employeeView || data.shifts.length < 2;
    shiftSelect._customSelectRefresh?.();
    const totals = data.totals || {};
    const selected = data.employeeView ? null : data.shifts.find((shift) => shift.id === shiftSelect.value);
    if (!data.shifts.length) {
      context.textContent = `За ${new Date(`${data.date}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} смен не было.`;
      cards.innerHTML = `<div class="dashboard-shift-empty" role="status"><span class="dashboard-shift-empty__icon">${icon('calendar-event')}</span><div><strong>За выбранную дату смен не найдено</strong><small>Выберите другой день, чтобы посмотреть показатели.</small></div><button type="button" class="button dashboard-shift-empty__action">Выбрать дату</button></div>`;
      cards.querySelector('.dashboard-shift-empty__action')?.addEventListener('click', () => { dateInput?.focus(); try { dateInput?.showPicker?.(); } catch (_) {} });
    } else {
      const venueDateTime = (value) => new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: data.timezone });
      const range = data.employeeView ? 'Ваши показатели за сегодня' : selected ? `${venueDateTime(selected.openedAt)} — ${selected.closedAt ? venueDateTime(selected.closedAt) : 'смена открыта'}` : 'Итог по всем сменам выбранного дня';
      context.textContent = range;
      const methodRows = [['Наличные', Number(totals.cash || 0)], ['Карта и QR', Number(totals.cashless || 0)], ['Другие способы', Number(totals.other || 0)]].filter(([, amount]) => amount > 0);
      const guestTopUps = totals.depositTopUps || {};
      const reservationPrepayments = totals.reservationPrepayments || {};
      const periodLabel = data.employeeView ? 'за сегодня' : selected ? 'за выбранную смену' : 'за все смены дня';
      cards.innerHTML = `<article class="dashboard-shift-stat dashboard-shift-stat--hero"><span>Оплачено</span><strong>${money(totals.revenue || 0)}</strong><small>Поступившие платежи ${periodLabel}</small></article><article class="dashboard-shift-stat"><span>Закрыто заказов</span><strong>${Number(totals.closedOrders || 0)}</strong><small>По времени закрытия</small></article><article class="dashboard-shift-stat"><span>Платежей</span><strong>${Number(totals.paymentCount || 0)}</strong><small>Проведено ${periodLabel}</small></article><div class="dashboard-shift-methods"><b>Способы оплаты</b>${methodRows.length ? methodRows.map(([method, amount]) => `<div><span>${esc(method)}</span><strong>${money(amount)}</strong></div>`).join('') : `<span class="muted">Оплат ${data.employeeView ? 'сегодня' : selected ? 'за смену' : 'за этот день'} пока нет</span>`}${Number(guestTopUps.count || 0) ? `<div class="dashboard-shift-deposit-topups"><span>Пополнения счёта гостей · не выручка</span><strong>${money(guestTopUps.total)}</strong><small>Наличные ${money(guestTopUps.cash)} · карта и QR ${money(guestTopUps.cashless)} · ${Number(guestTopUps.count)} операций</small></div>` : ''}${Number(reservationPrepayments.count || 0) ? `<div class="dashboard-shift-reservation-prepayments"><span>Предоплаты броней · не выручка заказа</span><strong>${money(reservationPrepayments.total)}</strong><small>Наличные ${money(reservationPrepayments.cash)} · карта и QR ${money(reservationPrepayments.cashless)} · ${Number(reservationPrepayments.count)} операций</small></div>` : ''}</div>`;
    }
    if (warning) {
      const messages = [];
      if (data.unassignedPaymentCount) messages.push(`${data.unassignedPaymentCount} исторических оплат за выбранную дату или интервал смены не привязаны к смене и не включены в итоги`);
      warning.hidden = !messages.length;
      warning.textContent = messages.join('. ');
    }
  };
  const load = async ({ initial = false } = {}) => {
    const revision = ++requestRevision;
    shiftSelect.disabled = true;
    shiftSelect._customSelectRefresh?.();
    context.textContent = 'Загружаем показатели…';
    cards.innerHTML = '<div class="empty">Загрузка показателей…</div>';
    if (warning) warning.hidden = true;
    const params = new URLSearchParams();
    if (!initial && dateInput.value) params.set('date', dateInput.value);
    if (!initial && shiftSelect.value) params.set('shiftId', shiftSelect.value);
    try {
      const data = await api(`/api/dashboard/shift-kpis${params.size ? `?${params}` : ''}`);
      if (revision !== requestRevision) return;
      render(data);
    } catch (_) {
      if (revision !== requestRevision) return;
      shiftSelect.disabled = true;
      shiftSelect._customSelectRefresh?.();
      context.textContent = 'Не удалось загрузить смены за этот день.';
      cards.innerHTML = '<div class="empty dashboard-shift-error">Не удалось получить данные смены.<br><button type="button" class="button small dashboard-shift-retry">Повторить</button></div>';
      if (warning) { warning.hidden = false; warning.textContent = 'Данные смены временно недоступны.'; }
    }
  };
  cards.addEventListener('click', (event) => { if (event.target.closest('.dashboard-shift-retry')) load(); });
  dateInput.addEventListener('change', () => { shiftSelect.value = ''; load(); });
  shiftSelect.addEventListener('change', () => load());
  load({ initial: true });
}

function setupVenueLayout() {
  const root = document.querySelector('#venue-layout-settings'); if (!root || !portalPermissions.has('settings')) return;
  const list = root.querySelector('#venue-zone-list'); const zoneForm = root.querySelector('#venue-zone-form'); const roomForm = root.querySelector('#venue-room-form'); let zones = []; let loadedVenueId = ''; let showArchived = false;
  const readAmenities = (table) => ({ playstation5: Boolean(table?.layout?.amenities?.playstation5), television: Boolean(table?.layout?.amenities?.television) });
  const amenityMarkup = (table) => { const amenities = readAmenities(table); const items = []; if (amenities.playstation5) items.push('<span class="venue-amenity-chip venue-amenity-chip--playstation"><b>PS5</b><span>PlayStation</span></span>'); if (amenities.television) items.push('<span class="venue-amenity-chip venue-amenity-chip--tv"><b>TV</b><span>Телевизор</span></span>'); return items.length ? `<span class="venue-amenities" aria-label="Оснащение: ${items.map((item) => item.includes('PS5') ? 'PlayStation 5' : 'телевизор').join(', ')}">${items.join('')}</span>` : ''; };
  const load = () => api('/api/floor?includeArchived=true').then((data) => { if (!data?.venueId) throw new Error('venue_identity_unavailable'); loadedVenueId = String(data.venueId); zones = data.zones || []; root.querySelector('#new-floor-zone').disabled = false; draw(); return true; }).catch(() => { loadedVenueId = ''; zones = []; for (const button of [root.querySelector('#new-floor-zone'), root.querySelector('#new-floor-table'), root.querySelector('#new-vip-room')]) button.disabled = true; list.innerHTML = '<div class="venue-layout-empty venue-layout-empty--large" role="alert"><strong>Не удалось загрузить залы</strong><span>Проверьте соединение и попробуйте ещё раз.</span><button type="button" class="button primary" data-venue-layout-retry>Повторить загрузку</button></div>'; return false; });
  const isArchivedTable = (table) => Boolean(table.archivedAt || table.archived_at);
  const archiveVersion = (table) => Number(table.archiveVersion ?? table.archive_version ?? 0);
  const draw = () => { const roomZone = root.querySelector('#venue-room-zone'); const selectedZoneId = roomForm && !roomForm.hidden ? roomZone.value : ''; roomZone.innerHTML = zones.map((zone) => `<option value="${esc(zone.id)}">${esc(zone.name)}</option>`).join(''); if (zones.some((zone) => zone.id === selectedZoneId)) roomZone.value = selectedZoneId; const canAddObjects = zones.length > 0; for (const button of [root.querySelector('#new-floor-table'), root.querySelector('#new-vip-room')]) { button.disabled = !canAddObjects; button.title = canAddObjects ? '' : 'Сначала создайте зал или этаж'; } const visibleZones = zones.map((zone) => ({ ...zone, tables: (zone.tables || []).filter((table) => isArchivedTable(table) === showArchived) })).filter((zone) => zone.tables.length); const zoneCards = visibleZones.map((zone) => `<article class="venue-zone-card" data-zone="${esc(zone.id)}"><div class="venue-zone-card__head"><div><h3>${esc(zone.name)}</h3><small>${zone.tables.length} ${pluralRu(zone.tables.length, 'стол', 'стола', 'столов')} · ${zone.tables.filter((table) => /vip|комнат/i.test(table.name || '')).length ? 'есть VIP-комната' : 'обычная зона'}</small></div>${showArchived ? '' : `<div class="toolbar-row"><button type="button" class="button small primary venue-zone-add-table" data-zone-add-table="${esc(zone.id)}">+ Стол</button><button type="button" class="button small venue-zone-edit" data-zone-edit="${esc(zone.id)}">Изменить</button><button type="button" class="button small danger-outline venue-zone-delete" data-zone-delete="${esc(zone.id)}">Удалить</button></div>`}</div><div class="venue-room-list">${zone.tables.map((table) => `<div class="venue-room-row"><div><b>${esc(table.name)}</b><small>${Number(table.minCapacity || table.capacity || 0)}–${Number(table.maxCapacity || table.capacity || 0)} гостей · ${Number(table.minimumOrderTotal || 0) ? `депозит ${money(table.minimumOrderTotal)}` : 'без депозита'}${showArchived ? ` · Архивирован ${esc(formatRuDate(String(table.archivedAt || table.archived_at).slice(0, 10)))}` : ''}</small>${amenityMarkup(table)}</div><div class="toolbar-row">${showArchived ? `<span class="badge">В архиве</span><button type="button" class="button small venue-room-restore" data-room-restore="${esc(table.id)}" data-zone-id="${esc(zone.id)}" data-archived-at="${esc(table.archivedAt || table.archived_at)}" data-archive-version="${archiveVersion(table)}">Восстановить</button>` : `<span class="badge ${table.status === 'blocked' ? 'danger' : 'success'}">${table.status === 'blocked' ? 'Закрыто' : 'Активно'}</span><button type="button" class="button small venue-room-edit" data-room-edit="${esc(table.id)}" data-zone-id="${esc(zone.id)}">Изменить</button><button type="button" class="button small danger-outline venue-room-archive" data-room-archive="${esc(table.id)}" data-zone-id="${esc(zone.id)}" data-archive-version="${archiveVersion(table)}">В архив</button>`}</div></div>`).join('')}</div></article>`).join(''); list.innerHTML = `<div class="toolbar-row venue-table-archive-filter"><button type="button" class="button small ${showArchived ? '' : 'primary'}" data-floor-view="active" aria-pressed="${!showArchived}">Активные столы</button><button type="button" class="button small ${showArchived ? 'primary' : ''}" data-floor-view="archived" aria-pressed="${showArchived}">Архив</button></div>${zoneCards || `<div class="venue-layout-empty venue-layout-empty--large"><strong>${showArchived ? 'Архивных столов нет' : zones.length ? 'В залах пока нет активных столов' : 'Залов пока нет'}</strong><span>${showArchived ? 'Архивированные столы появятся здесь. Их можно восстановить в исходный зал.' : 'Создайте зал или этаж, затем добавьте в него столы.'}</span>${!showArchived && !zones.length ? '<button type="button" class="button primary" id="empty-new-floor-zone">+ Создать зал / этаж</button>' : ''}</div>`}`; };
  const show = (form) => { if (!loadedVenueId) return; form.dataset.venueId = loadedVenueId; form.dataset.stale = '0'; form.querySelector('button[type="submit"]').disabled = false; form.hidden = false; form.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
  const openTableForm = (zoneId, mode = 'table') => { if (!zones.length) { zoneForm.reset(); show(zoneForm); root.querySelector('#venue-zone-name').focus(); return; } roomForm.reset(); root.querySelector('#venue-room-zone').value = zoneId || zones[0].id; const title = root.querySelector('#venue-room-form-title'); const hint = root.querySelector('#venue-room-form-hint'); const submit = root.querySelector('#venue-room-submit'); const vipMode = mode === 'vip'; if (title) title.textContent = vipMode ? 'Добавить VIP-комнату' : 'Добавить стол'; if (hint) hint.textContent = vipMode ? 'VIP-комната появится в выбранной зоне и будет доступна для бронирований.' : 'Стол появится в выбранном зале и станет доступен сотрудникам.'; if (submit) submit.textContent = vipMode ? 'Добавить VIP-комнату' : 'Добавить стол'; root.querySelector('#venue-room-name').value = vipMode ? 'VIP-комната' : ''; root.querySelector('#venue-room-name').placeholder = vipMode ? 'Например, VIP-комната 1' : 'Например, Стол 1'; root.querySelector('#venue-room-min-capacity').value = vipMode ? '2' : '2'; root.querySelector('#venue-room-max-capacity').value = vipMode ? '4' : '4'; root.querySelector('#venue-room-capacity').value = vipMode ? '4' : '4'; root.querySelector('#venue-room-minimum').value = vipMode ? '1500' : '0'; roomForm.dataset.mode = mode; show(roomForm); root.querySelector('#venue-room-name').focus(); };
  root.querySelector('#new-floor-zone').disabled = true;
  root.querySelector('#new-floor-table').disabled = true;
  root.querySelector('#new-vip-room').disabled = true;
  root.querySelector('#new-floor-zone').addEventListener('click', () => { zoneForm.reset(); show(zoneForm); root.querySelector('#venue-zone-name').focus(); });
  root.querySelector('#new-floor-table').addEventListener('click', () => openTableForm(zones.find((zone) => !/vip|комнат/i.test(zone.name))?.id, 'table'));
  root.querySelector('#new-vip-room').addEventListener('click', () => openTableForm(zones.find((zone) => /vip/i.test(zone.name))?.id, 'vip'));
  root.querySelector('#cancel-venue-zone').addEventListener('click', () => { zoneForm.hidden = true; }); root.querySelector('#cancel-venue-room').addEventListener('click', () => { roomForm.hidden = true; });
  zoneForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (zoneForm.dataset.submitting === '1' || zoneForm.dataset.stale === '1') return;
    zoneForm.dataset.submitting = '1';
    const submit = zoneForm.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    const message = root.querySelector('#venue-zone-message');
    const name = root.querySelector('#venue-zone-name').value.trim();
    let created = null;
    try {
      created = await api('/api/floor/zones', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVenueId: zoneForm.dataset.venueId, name, sortOrder: zones.length }) });
      zoneForm.hidden = true;
      zones = [...zones.filter((zone) => zone.id !== created.id), { ...created, tables: [] }];
      draw();
      openTableForm(created.id, 'table');
      try {
        const data = await api('/api/floor');
        zones = data.zones || [];
        draw();
        portalNotice('Зал создан. Добавьте в него первый стол.', 'success');
      } catch {
        portalNotice('Зал создан, но список не обновился. Перезагрузите страницу, чтобы проверить изменения.', 'warning');
      }
    } catch (error) {
      if (error.payload?.error === 'venue_context_changed') { zoneForm.dataset.stale = '1'; load(); }
      message.textContent = error.payload?.error === 'venue_context_changed' ? 'Точка изменилась. Закройте форму и откройте новую карточку зала.' : error.payload?.error === 'invalid_zone_name' ? 'Укажите название зала до 80 символов' : created ? 'Зал создан, но не удалось обновить список' : 'Не удалось добавить зал';
      message.className = 'form-message error-message';
      if (created) { zones = [...zones.filter((zone) => zone.id !== created.id), { ...created, tables: [] }]; draw(); openTableForm(created.id, 'table'); }
    } finally {
      zoneForm.dataset.submitting = '0';
      if (submit) submit.disabled = zoneForm.dataset.stale === '1';
    }
  });
  roomForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (roomForm.dataset.submitting === '1' || roomForm.dataset.stale === '1') return;
    roomForm.dataset.submitting = '1';
    const submit = root.querySelector('#venue-room-submit');
    if (submit) submit.disabled = true;
    const message = root.querySelector('#venue-room-message');
    try {
      await api('/api/floor/tables', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVenueId: roomForm.dataset.venueId, zoneId: root.querySelector('#venue-room-zone').value, name: root.querySelector('#venue-room-name').value.trim(), capacity: Number(root.querySelector('#venue-room-max-capacity').value), minCapacity: Number(root.querySelector('#venue-room-min-capacity').value), maxCapacity: Number(root.querySelector('#venue-room-max-capacity').value), minimumOrderTotal: Number(root.querySelector('#venue-room-minimum').value || 0), layout: { amenities: { playstation5: Boolean(root.querySelector('#venue-room-playstation')?.checked), television: Boolean(root.querySelector('#venue-room-television')?.checked) } } }) });
      roomForm.hidden = true;
      const refreshed = await load();
      portalNotice(refreshed ? (roomForm.dataset.mode === 'vip' ? 'VIP-комната добавлена' : 'Стол добавлен') : (roomForm.dataset.mode === 'vip' ? 'VIP-комната создана, но список не обновился' : 'Стол создан, но список не обновился'), refreshed ? 'success' : 'warning');
    } catch (error) {
      if (error.payload?.error === 'venue_context_changed') { roomForm.dataset.stale = '1'; load(); }
      message.textContent = error.payload?.error === 'venue_context_changed' ? 'Точка изменилась. Закройте форму и откройте новый стол.' : error.payload?.error === 'invalid_table_capacity' ? 'Проверьте вместимость: мест от 1 до 100' : error.payload?.error === 'invalid_vip_minimum' ? 'Минимальный депозит не может быть отрицательным' : 'Не удалось добавить стол';
      message.className = 'form-message error-message';
    } finally {
      roomForm.dataset.submitting = '0';
      if (submit) submit.disabled = roomForm.dataset.stale === '1';
    }
  });
  list.addEventListener('click', async (event) => {
    if (event.target.closest('[data-venue-layout-retry]')) { list.innerHTML = '<div class="empty">Загрузка залов…</div>'; await load(); return; }
    const actionVenueId = loadedVenueId;
    const viewButton = event.target.closest('[data-floor-view]'); if (viewButton) { showArchived = viewButton.dataset.floorView === 'archived'; draw(); return; }
    const addTable = event.target.closest('[data-zone-add-table]'); if (addTable) { openTableForm(addTable.dataset.zoneAddTable, 'table'); return; }
    if (event.target.closest('#empty-new-floor-zone')) { zoneForm.reset(); show(zoneForm); root.querySelector('#venue-zone-name').focus(); return; }
    const editZone = event.target.closest('[data-zone-edit]'); const deleteZone = event.target.closest('[data-zone-delete]'); const editRoom = event.target.closest('[data-room-edit]'); const archiveRoom = event.target.closest('[data-room-archive]'); const restoreRoom = event.target.closest('[data-room-restore]');
    if (archiveRoom || restoreRoom) {
      const button = archiveRoom || restoreRoom; const zone = zones.find((entry) => entry.id === button.dataset.zoneId); const table = zone?.tables?.find((entry) => entry.id === (button.dataset.roomArchive || button.dataset.roomRestore)); if (!table || !actionVenueId) return;
      const restoring = Boolean(restoreRoom); const action = restoring ? 'restore' : 'archive'; const archivedAt = restoring ? (button.dataset.archivedAt || table.archivedAt || table.archived_at) : null; const expectedArchiveVersion = Number(button.dataset.archiveVersion ?? archiveVersion(table));
      if (!await portalConfirm(restoring ? `Восстановить стол «${table.name}»?` : `Переместить стол «${table.name}» в архив?`, restoring ? 'Стол вернётся в тот же зал. Его история заказов и бронирований сохранится.' : 'Стол исчезнет из активного списка. История заказов и бронирований сохранится; при открытом заказе архивация будет отклонена.', restoring ? 'Восстановить стол' : 'В архив')) return;
      button.disabled = true;
      try {
        await api(`/api/floor/tables/${encodeURIComponent(table.id)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVenueId: actionVenueId, expectedArchivedAt: archivedAt, expectedArchiveVersion }) });
        const refreshed = await load();
        const readbackZone = zones.find((entry) => entry.id === zone.id); const readback = readbackZone?.tables?.find((entry) => entry.id === table.id); const nowArchived = readback ? isArchivedTable(readback) : false;
        if (!refreshed || (restoring ? nowArchived || !readback : !nowArchived || !readback)) { portalNotice('Изменение отправлено, но список не подтвердил результат. Обновите экран и проверьте стол.', 'warning'); return; }
        portalNotice(restoring ? 'Стол восстановлен в исходном зале' : 'Стол перемещён в архив. История сохранена', 'success');
      } catch (error) {
        if (error.payload?.error === 'venue_context_changed' || error.payload?.error === 'floor_table_stale' || error.payload?.error === 'table_archive_stale' || error.payload?.error === 'table_archive_state_changed' || error.payload?.error === 'table_archive_version_changed') await load();
        const code = error.payload?.error;
        portalNotice(code === 'venue_context_changed' ? 'Точка изменилась. Загрузите актуальный зал.' : code === 'table_in_use' || code === 'table_has_live_activity' ? 'Нельзя архивировать стол: есть открытый заказ или бронь на сегодня' : code === 'table_archive_stale' || code === 'floor_table_stale' || code === 'table_archive_state_changed' || code === 'table_archive_version_changed' ? 'Стол уже изменён. Список обновлён; проверьте его состояние.' : code === 'table_not_found' || code === 'floor_table_not_found' ? 'Стол не найден в текущем зале. Список обновлён.' : code === 'forbidden' ? 'Недостаточно прав для изменения стола' : restoring ? 'Не удалось восстановить стол' : 'Не удалось архивировать стол', 'error');
      } finally { if (button.isConnected) button.disabled = false; }
      return;
    }
    if (editZone) {
      const zone = zones.find((entry) => entry.id === editZone.dataset.zoneEdit); if (!zone) return;
      const values = await portalAction({ title: 'Изменить зону', description: 'Название будет показано сотрудникам в бронированиях и рабочей панели.', submitLabel: 'Сохранить', fields: [{ name: 'name', label: 'Название зоны / этажа', value: zone.name }] }); if (!values) return;
      api(`/api/floor/zones/${encodeURIComponent(zone.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVenueId: actionVenueId, name: values.name.trim() }) }).then(load).catch((error) => { if (error.payload?.error === 'venue_context_changed') load(); portalNotice(error.payload?.error === 'venue_context_changed' ? 'Точка изменилась. Откройте актуальный зал.' : 'Не удалось изменить зону', 'error'); });
    } else if (deleteZone) {
      const zone = zones.find((entry) => entry.id === deleteZone.dataset.zoneDelete); if (!zone || !await portalConfirm(`Удалить зону «${zone.name}»?`, 'Удалить можно только пустую зону. Зона со столами останется без изменений.', 'Удалить зону')) return;
      api(`/api/floor/zones/${encodeURIComponent(zone.id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVenueId: actionVenueId }) }).then(() => { load(); portalNotice('Зона удалена', 'success'); }).catch((error) => { if (error.payload?.error === 'venue_context_changed') load(); portalNotice(error.payload?.error === 'venue_context_changed' ? 'Точка изменилась. Откройте актуальный зал.' : error.payload?.error === 'zone_not_empty' ? 'Нельзя удалить зону, пока в ней есть столы' : 'Не удалось удалить зону', 'error'); });
    } else if (editRoom) {
      const zone = zones.find((entry) => entry.id === editRoom.dataset.zoneId); const table = zone?.tables?.find((entry) => entry.id === editRoom.dataset.roomEdit); if (!table) return;
      const values = await portalAction({ title: 'Изменить объект', description: 'Диапазон гостей и депозит используются при бронировании и в контроле зала.', submitLabel: 'Сохранить', validate: (data) => Number(data.maxCapacity) < Number(data.minCapacity) ? 'Максимум гостей не может быть меньше минимума' : '', fields: [{ name: 'name', label: 'Название объекта', value: table.name }, { name: 'minCapacity', label: 'Минимум гостей', type: 'number', min: 1, max: 100, step: 1, value: String(table.minCapacity || table.capacity || 2) }, { name: 'maxCapacity', label: 'Максимум гостей', type: 'number', min: 1, max: 100, step: 1, value: String(table.maxCapacity || table.capacity || 2) }, { name: 'minimumOrderTotal', label: 'Минимальный депозит, ₽', type: 'number', min: 0, step: 1, value: String(table.minimumOrderTotal || 0) }, { name: 'playstation5', label: 'PlayStation 5 · Sony', type: 'checkbox', required: false, value: readAmenities(table).playstation5 }, { name: 'television', label: 'Телевизор', type: 'checkbox', required: false, value: readAmenities(table).television }] }); if (!values) return;
      const minCapacity = Number(values.minCapacity); const maxCapacity = Number(values.maxCapacity);
      api(`/api/floor/tables/${encodeURIComponent(table.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVenueId: actionVenueId, name: values.name.trim(), capacity: maxCapacity, minCapacity, maxCapacity, minimumOrderTotal: Number(values.minimumOrderTotal), layout: { amenities: { playstation5: Boolean(values.playstation5), television: Boolean(values.television) } } }) }).then(load).catch((error) => { if (error.payload?.error === 'venue_context_changed') load(); portalNotice(error.payload?.error === 'venue_context_changed' ? 'Точка изменилась. Откройте актуальный объект.' : 'Не удалось изменить объект', 'error'); });
    }
  });  load();
}

function disposeStaffDrawer() {
  window.__closeStaffDrawer?.();
  document.querySelectorAll('.staff-drawer').forEach((drawer) => drawer.remove());
  window.__closeStaffDrawer = undefined;
}

function renderDashboard() {
  disposeStaffDrawer();
  const target = document.querySelector('#page-content');
  if (!target) return;
  const canViewStaff = portalPermissions.has('staff_view');
  const canViewAudit = portalPermissions.has('settings') || portalPermissions.has('diagnostics');
  if ((!canViewStaff && window.location.hash === '#staff') || (!canViewAudit && window.location.hash === '#audit')) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  const quickActions = [
    { permission: 'reservations', href: '/reservations', iconName: 'calendar-event', label: portalUser.role === 'owner' ? 'Забронировать для себя' : 'Оформить бронь' },
    { permission: 'inventory_read', href: '/inventory', iconName: 'package', label: 'Проверить склад' },
    { permission: 'finance_read', href: '/finance', iconName: 'cash', label: 'Открыть финансы' },
    { permission: 'finance_read', href: '/finance/report', iconName: 'clipboard-list', label: 'Отчёты' },
  ].filter((action) => portalPermissions.has(action.permission));
  if (!quickActions.length && portalPermissions.has('orders')) quickActions.push({ href: '/', iconName: 'layout-grid', label: 'Рабочий зал' });
  const quickActionsMarkup = quickActions.map((action) => `<a href="${action.href}">${icon(action.iconName)} ${action.label}</a>`).join('');
  const dashboardKpiCount = Number(portalPermissions.has('finance_read')) + Number(portalPermissions.has('orders')) + Number(portalPermissions.has('reservations')) + Number(portalPermissions.has('inventory_read'));
  target.innerHTML = `
    <div class="page-title"><div><p class="eyebrow">ОБЗОР ЗАВЕДЕНИЯ</p><h1 id="dashboard-greeting">Обзор заведения</h1><p class="muted">Финансы, смена и рабочие задачи в одном окне.</p></div>${portalPermissions.has('settings') ? '<div class="dashboard-page-actions"><a class="button small" href="/admin#settings">Настроить главную</a></div>' : ''}</div>
    <section class="panel dashboard-insights dashboard-shift-panel" id="dashboard-insights" data-dashboard-module="insights"><div class="panel-head"><div><h2>Показатели смены</h2><span class="muted">Итоги выбранного дня или выбранной смены</span></div><div class="dashboard-shift-controls"><label>Дата<input id="dashboard-shift-date" type="date" value="${localDateKey()}" aria-label="Дата смены"></label><label>Смена<select id="dashboard-shift-select" aria-label="Смена за выбранный день" disabled><option value="">Загрузка смен…</option></select></label></div></div><div id="dashboard-shift-context" class="dashboard-shift-context" aria-live="polite">Загружаем показатели…</div><small class="dashboard-shift-explainer">Оплаты относятся к смене их проведения, закрытые заказы — к смене закрытия.</small><div id="dashboard-shift-kpis" class="dashboard-shift-kpis" aria-live="polite"><div class="empty">Загрузка показателей…</div></div><div id="dashboard-shift-warning" class="dashboard-shift-warning" hidden></div></section>
    <div class="panel-head dashboard-live-heading" data-dashboard-module="kpi"><div><h2>Текущая работа</h2><span class="muted">Оперативные показатели за сегодня и сейчас</span></div></div>
    <div class="kpi-grid dashboard-kpi-grid dashboard-kpi-grid--${dashboardKpiCount}" data-dashboard-module="kpi">
      <article class="kpi dashboard-revenue-card" data-dashboard-revenue data-kpi-route="/finance" aria-label="Открыть финансы"><div class="dashboard-revenue-main"><span>Выручка сегодня</span><strong id="dash-revenue">—</strong><small class="positive">Оплаты по закрытым сегодня заказам</small></div><div class="dashboard-revenue-pending" data-pending-summary><span>К оплате</span><strong id="dash-pending-revenue">—</strong><small id="dash-pending-detail">Загружаем финансы…</small></div></article>
      <article class="kpi" data-kpi-route="/" aria-label="Открыть зал и заказы"><span>Открытые заказы</span><strong data-metric="openOrders">0</strong><small>В работе сейчас</small></article>
      ${portalPermissions.has('reservations') ? '<article class="kpi" data-kpi-route="/reservations" aria-label="Открыть бронирования"><span>Бронирования сегодня</span><strong data-metric="reservationsToday">0</strong><small>Подтверждённые брони</small></article>' : ''}
      ${portalPermissions.has('inventory_read') ? '<article class="kpi" data-kpi-route="/inventory" aria-label="Открыть список позиций к пополнению"><span>Нужно пополнить</span><strong data-metric="lowStock">0</strong><small>Позиции ниже минимума</small></article>' : ''}
    </div>
    <div class="content-grid"><section class="panel" id="shift-control" data-dashboard-module="shift"><div class="panel-head"><h2>Контроль смены</h2><span class="muted" id="shift-date">—</span></div><div class="check-list"><div><span class="check ok" id="shift-icon">${icon('circle-check')}</span><div><b id="shift-title">Проверка смены…</b><small id="shift-detail">Загрузка состояния кассы</small></div><div class="shift-actions" id="shift-actions"></div></div></div></section><section class="panel" data-dashboard-module="quick"><div class="panel-head"><h2>Быстрые действия</h2><span class="muted">${portalUser.role === 'owner' ? 'Действия от вашего имени' : 'Доступные разделы'}</span></div><div class="quick-actions">${quickActionsMarkup}</div></section></div><section class="panel staff-panel" id="staff" data-staff-section data-dashboard-module="staff"><div class="panel-head"><div><h2>Сотрудники</h2><span class="muted">Роли, контакты и кадровые данные ведут владелец и администратор</span></div><span class="badge success" data-metric="staffActive">Загрузка…</span></div><div class="staff-layout"><div id="staff-list" class="staff-list"><div class="empty">Загрузка сотрудников…</div></div><form id="staff-form" class="staff-form"><b>Добавить сотрудника</b><label class="staff-form-field">ФИО<input id="staff-name" required placeholder="Фамилия Имя Отчество" autocomplete="name"></label><label class="staff-form-field">Дата рождения<input id="staff-birth-date" name="birth_date" type="date" required></label><label class="staff-form-field staff-photo-field">Фото сотрудника<input id="staff-photo" name="photo" type="file" accept="image/png,image/jpeg,image/webp"><small class="muted">Видно владельцу, администратору и управляющему. До 700 КБ.</small></label><label class="staff-form-field">Логин<input id="staff-login" placeholder="Логин" autocomplete="username"></label><label class="staff-form-field">Временный пароль<input id="staff-password" type="password" minlength="4" maxlength="11" placeholder="4–11 символов" autocomplete="new-password"></label><div class="staff-form-contact-row"><label class="staff-form-field">Основной телефон<input id="staff-phone-primary" name="phone_primary" type="tel" placeholder="+7 (___) ___-__-__" autocomplete="tel"></label><label class="staff-form-field">Дополнительный телефон<input id="staff-phone-secondary" name="phone_secondary" type="tel" placeholder="Необязательно" autocomplete="tel"></label></div><label class="staff-form-field">Telegram<input id="staff-telegram" name="telegram" type="text" placeholder="@username или ссылка"></label><label class="staff-form-field">Дата начала работы<input id="staff-employment-started" name="employment_started_at" type="date"></label><label class="staff-form-field">Рабочие заметки<textarea id="staff-work-notes" name="work_notes" rows="2" maxlength="4000" placeholder="График, допуски, важные заметки"></textarea></label>${portalUser.role === 'owner' ? '<details class="staff-sensitive-fields"><summary>Паспортные данные</summary><label class="staff-form-field">Серия и номер<input name="passport_number" maxlength="32"></label><label class="staff-form-field">Дата выдачи<input name="passport_issued_at" type="date"></label><label class="staff-form-field">Кем выдан<input name="passport_issuer" maxlength="180"></label></details>' : ''}${portalUser.role === 'owner' ? permissionScopeMarkup() : ''}<label class="staff-form-field">Роль<select id="staff-role" required>${portalUser.role === 'owner' ? '<option value="admin">Администратор</option><option value="manager">Управляющий</option>' : ''}<option value="senior_bartender">Старший бармен</option><option value="senior_hookah_master">Старший кальянщик</option><option value="bartender">Бармен</option><option value="hookah_master">Кальянщик</option>${portalUser.role === 'owner' ? '<option value="developer">Главный разработчик</option>' : ''}<optgroup label="Без доступа к CRM"><option value="cleaner">Уборщица / уборщик</option><option value="security">Охрана</option><option value="technician">Техник</option><option value="other_staff">Другая должность</option></optgroup></select></label><small id="staff-role-hint" class="muted">Для должностей без доступа создаётся только кадровая карточка.</small><button type="submit" class="button primary">Создать сотрудника</button><small id="staff-message" class="form-message"></small></form></div></section>`;
  const helpPanel = document.createElement('section');
  helpPanel.className = 'panel help-panel'; helpPanel.id = 'help'; helpPanel.hidden = true;
  const knowledgeTopics = [
    { title: 'Первый рабочий день', audience: 'Для нового сотрудника', steps: ['Войдите под своим PIN или логином и проверьте, что видите только нужные разделы.', 'Откройте «Рабочий зал», проверьте статус смены и найдите нужный стол.', 'Если доступ или данные неверны, сообщите управляющему через форму обращения ниже.'], link: '/', linkLabel: 'Открыть рабочий зал' },
    { title: 'Смена и заказы', audience: 'Для сотрудников зала и кассы', steps: ['Перед началом работы проверьте, открыта ли смена.', 'Выберите стол, добавьте позиции и сверяйте количество перед отправкой.', 'После оплаты убедитесь, что заказ закрыт и появился в журнале.'], link: '/orders', linkLabel: 'Открыть журнал заказов' },
    { title: 'Гости и лояльность', audience: 'Для сотрудников, работающих с гостями', steps: ['Найдите гостя по имени или телефону, чтобы не создавать дубликат.', 'Сверьте статус, заметки и предпочтения перед обслуживанием.', 'Скидки и бонусы применяйте только по доступным правилам; спорные случаи передавайте управляющему.'], link: '/clients', linkLabel: 'Открыть гостей' },
    { title: 'Склад и меню', audience: 'Для кухни, бара и управляющего', steps: ['Ищите позицию в каталоге и проверяйте единицу учёта.', 'Остатки меняются через приёмку, списание или производственную операцию.', 'Если позиция или категория отсутствует, попросите управляющего добавить её в справочники.'], link: '/inventory', linkLabel: 'Открыть склад' },
    { title: 'Финансы и зарплата', audience: 'Для управляющего и финансовых ролей', steps: ['Финансовый обзор показывает выручку, расходы и оплаты за выбранный период.', 'Зарплатный реестр формируется по сотрудникам и расчётному периоду.', 'Перед утверждением проверьте даты, суммы и статус каждой строки.'], link: '/finance', linkLabel: 'Открыть финансы' },
    { title: 'Команда и доступы', audience: 'Для владельца и администратора', steps: ['Карточка сотрудника хранит контакты, должность и рабочий статус.', 'Роль определяет базовый доступ, а индивидуальные права можно уточнить в карточке.', 'После изменения прав попросите сотрудника войти заново, чтобы увидеть новый набор разделов.'], link: '/admin#permissions', linkLabel: 'Открыть роли и права' },
  ];
  const knowledgeMarkup = knowledgeTopics.map((topic, index) => `<details class="help-topic"${index === 0 ? ' open' : ''}><summary><span><b>${topic.title}</b><small>${topic.audience}</small></span><span class="help-topic-chevron">⌄</span></summary><ol>${topic.steps.map((step) => `<li>${step}</li>`).join('')}</ol><a class="button small" href="${topic.link}">${topic.linkLabel}</a></details>`).join('');
  helpPanel.innerHTML = `<div class="panel-head help-panel-head"><div><p class="eyebrow">ЦЕНТР ПОМОЩИ</p><h2>База знаний</h2><span class="muted">Короткие понятные инструкции по ежедневной работе. Здесь нет внутренней реализации системы — только рабочие действия.</span></div></div><div class="help-topics" aria-label="Категории базы знаний">${knowledgeMarkup}</div><section class="help-feedback-card"><div><h3>Не нашли ответ?</h3><p class="muted">Опишите ситуацию, и управляющий сможет передать её в поддержку.</p></div><form id="help-feedback-form" class="stack-form"><label>Что произошло<textarea id="help-feedback" rows="3" maxlength="1000" required placeholder="Опишите вопрос или проблему"></textarea></label><div class="help-feedback-actions"><button class="button primary small" type="submit">Сохранить обращение</button><small id="help-feedback-message" class="form-message" role="status"></small></div></form></section>`;
  target.append(helpPanel);
  helpPanel.querySelector('#help-feedback-form')?.addEventListener('submit', (event) => { event.preventDefault(); const value = helpPanel.querySelector('#help-feedback').value.trim(); if (!value) return; try { const key = 'crm_help_feedback'; const items = JSON.parse(localStorage.getItem(key) || '[]'); items.push({ text: value, createdAt: new Date().toISOString(), user: portalUser.name || portalUser.login || portalUser.role }); localStorage.setItem(key, JSON.stringify(items.slice(-20))); } catch (_) {} helpPanel.querySelector('#help-feedback-message').textContent = 'Обращение сохранено на этом устройстве. Передайте его администратору поддержки.'; event.target.reset(); });
  if (!portalPermissions.has('finance_read')) {
    target.querySelector('[data-dashboard-revenue]')?.remove();
    target.querySelector('#dashboard-insights')?.remove();
    target.querySelector('[data-dashboard-module-toggle="insights"]')?.closest('label')?.remove();
  }
  if (!portalPermissions.has('orders')) target.querySelector('[data-kpi-route="/"]')?.remove();
  if (!quickActionsMarkup) target.querySelector('[data-dashboard-module="quick"]')?.remove();
  if (!portalPermissions.has('floor') && !portalPermissions.has('finance_read')) target.querySelector('#shift-control')?.remove();
  if (!dashboardKpiCount) { target.querySelector('.dashboard-live-heading')?.remove(); target.querySelector('.dashboard-kpi-grid')?.remove(); }
  updateDashboardGreeting();
  if (!canViewStaff) target.querySelector('#staff')?.remove();
  if (!dashboardGreetingTimer) dashboardGreetingTimer = window.setInterval(updateDashboardGreeting, 60_000);
  bindKpiNavigation();
  const renderShift = (shift) => {
  const title = document.querySelector('#shift-title'); const detail = document.querySelector('#shift-detail'); const date = document.querySelector('#shift-date'); const iconNode = document.querySelector('#shift-icon'); const actions = document.querySelector('#shift-actions');
  if (!title || !detail || !actions) return;
  if (shift && !shift.closedAt) {
    const name = shift.openedByName || shift.openedBy || ''; title.textContent = 'Касса активна'; detail.textContent = `Смена открыта${name?` · ${name}`:''} в ${new Date(shift.openedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · старт ${money(shift.openingCash || 0)}`; date.textContent = formatRuDate(shift.openedAt); iconNode.className = 'check ok'; iconNode.innerHTML = icon('circle-check'); actions.innerHTML = portalPermissions.has('floor') ? '<button class="button small danger-outline" id="shift-close" type="button">Закрыть смену</button>' : '';
    document.querySelector('#shift-close')?.addEventListener('click', async () => {
      const checklistFields=(window.HOOKAH_SHIFT_CLOSE?.checklistItems||[]).map((item)=>({name:item.id,label:item.label,type:'checkbox',required:true})); const values = await portalAction({ title: 'Закрыть смену', description: `Ожидаемая наличность: ${money(shift.expectedCash ?? shift.openingCash ?? 0)}. Утвердите каждый пункт. Будет сохранён внутренний снимок POS; он не является фискальным Z-отчётом.`, submitLabel: 'Закрыть смену', fields: [{ name: 'closingCash', label: 'Фактическая сумма в кассе, ₽', type: 'number', min: 0, step: 0.01, value: String(shift.expectedCash ?? shift.openingCash ?? 0) }, ...checklistFields], danger: true });
      if (!values) return;
      api(`/api/shifts/${encodeURIComponent(shift.id)}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ closingCash: Number(values.closingCash), checklist: { version: window.HOOKAH_SHIFT_CLOSE?.checklistVersion, items: Object.fromEntries((window.HOOKAH_SHIFT_CLOSE?.checklistItems||[]).map((item)=>[item.id,Object.hasOwn(values,item.id)])) } }) }).then((closed) => { const variance = Number(closed.cashVariance || 0); portalNotice(`Смена закрыта · ${variance === 0 ? 'касса сошлась' : `расхождение ${money(variance)}`}`, variance === 0 ? 'success' : 'error'); loadShift(); }).catch((error) => { if(error.payload?.error==='shift_cash_attribution_unresolved'){const count=Number(error.payload.count||0),amount=Number(error.payload.amount||0);portalNotice(`Смена осталась открытой: ${count} платежей на ${money(amount)} без привязки. Попросите управляющего сверить их и повторите закрытие.`, 'error');}else portalNotice(error.payload?.error==='shift_checklist_required'?'Подтвердите каждый обязательный пункт чек-листа':'Не удалось закрыть смену', 'error'); });
    });
  } else {
    title.textContent = 'Касса не открыта'; detail.textContent = 'Откройте новую смену перед началом работы'; date.textContent = 'Нет активной смены'; iconNode.className = 'check warn'; iconNode.innerHTML = icon('alert-triangle'); actions.innerHTML = portalPermissions.has('floor') ? '<button class="button small primary" id="shift-open" type="button">Открыть смену</button>' : '';
    document.querySelector('#shift-open')?.addEventListener('click', async () => {
      const values = await portalAction({ title: 'Открыть смену', description: 'Укажите стартовый остаток наличных в кассе.', submitLabel: 'Открыть смену', fields: [{ name: 'openingCash', label: 'Стартовый остаток, ₽', type: 'number', min: 0, step: 0.01, value: '0' }] });
      if (!values) return;
      api('/api/shifts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ openingCash: Number(values.openingCash) }) }).then(() => { portalNotice('Смена открыта', 'success'); loadShift(); }).catch(() => portalNotice('Не удалось открыть смену', 'error'));
    });
  }
};  const loadShift = () => api('/api/shifts').then((data) => renderShift(data.current)).catch(() => { const title = document.querySelector('#shift-title'); if (title) title.textContent = 'Состояние смены недоступно'; }); if (target.querySelector('#shift-control')) loadShift();
  const canManageStaff = portalPermissions.has('staff_manage'); const canManageStaffPerson = (person) => portalUser.role === 'owner' || (portalUser.role === 'admin' && person.role !== 'owner') || (portalUser.role === 'manager' && !['owner','admin','developer'].includes(person.role));
  const staffActionMarkup = (person) => { if (person.role === 'owner' || !canManageStaffPerson(person)) return ''; if (!person.active) return canManageStaff ? `<button type="button" class="button small staff-restore" data-staff="${person.id}">Разблокировать</button>${portalUser.role === 'owner' ? `<button type="button" class="button small danger staff-archive" data-staff="${person.id}">Удалить из списка</button>` : ''}` : ''; if (!canManageStaff) return ''; return `<button type="button" class="icon-button staff-delete" data-staff="${person.id}" title="Заблокировать" aria-label="Заблокировать">${icon('x')}</button>`; };
  const renderStaffLegacy = (items) => { const labels = { owner: 'Владелец заведения', admin: 'Администратор', manager: 'Управляющий', senior_bartender: 'Старший бармен', senior_hookah_master: 'Старший кальянщик', bartender: 'Бармен', hookah_master: 'Кальянщик', developer: 'Разработчик', cleaner: 'Уборщица / уборщик', security: 'Охрана', technician: 'Техник', other_staff: 'Другая должность' }; const list = document.querySelector('#staff-list'); if (!list) return; list.innerHTML = items.length ? items.map((person) => { const primary = (person.phoneNumbers || []).find((phone) => phone.primary) || (person.phoneNumbers || [])[0]; const phone = primary?.number || ''; const telegram = person.telegram || ''; const email = person.email || ''; const note = person.workNotes || ''; const started = person.employmentStartedAt ? `с ${formatRuDate(person.employmentStartedAt)}` : ''; return `<article class="staff-row ${person.active ? '' : 'inactive'}" data-role="${esc(person.role || '')}" data-name="${esc(person.name)}"><label class="staff-avatar">${person.role === 'owner' ? '<span class="staff-owner-mark" aria-label="Владелец">♛</span>' : ''}${(person.avatarUrl || person.photoUrl) ? `<img src="${esc(person.avatarUrl || person.photoUrl)}" alt="Фото ${esc(person.name)}">` : esc(person.name).slice(0, 1)}${(canManageStaffPerson(person) || String(person.id) === String(portalUser.id)) ? `<input type="file" accept="image/png,image/jpeg,image/webp" data-avatar="${person.id}" hidden>` : ''}</label><div class="staff-identity"><b>${esc(person.name)}</b><small>${esc(labels[person.role] || person.role || 'Сотрудник')}</small></div><span class="badge ${person.active ? 'success' : 'danger'}">${person.active ? 'Активен' : 'Заблокирован'}</span><div class="staff-contacts">${phone ? `<span>${icon('phone')}${esc(phone)}</span>` : ''}${telegram ? `<span>${icon('send')}@${esc(String(telegram).replace(/^@/, ''))}</span>` : ''}${email ? `<span>${icon('mail')}${esc(email)}</span>` : ''}${started ? `<span>${esc(started)}</span>` : ''}${note ? `<blockquote>${esc(note)}</blockquote>` : ''}</div><div class="staff-actions">${canManageStaffPerson(person) ? `<button type="button" class="button primary staff-edit" data-staff="${person.id}" aria-label="Открыть профиль сотрудника ${esc(person.name)}" title="Открыть профиль сотрудника">${icon('edit')}<span>Профиль</span></button>` : ''}${staffActionMarkup(person)}</div></article>`; }).join('') : '<div class="empty">Сотрудники ещё не добавлены</div>'; };
  // Catalog has its own visual contract; dashboard summaries keep the legacy row.
  const staffCardIcon = (name) => {
    const paths = {
      phone: '<path d="M6 3h4l2 5-3 2a15 15 0 0 0 5 5l2-3 5 2v4a3 3 0 0 1-3 3C8 20 4 16 3 6a3 3 0 0 1 3-3Z"/>',
      mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
      telegram: '<path d="m3 10 18-7-4 18-6-7-8-4Z"/><path d="m11 14 5-6"/>',
      file: '<path d="M14 3H6v18h12V7l-4-4Z"/><path d="M14 3v5h4M9 12h6M9 16h6"/>',
      ban: '<circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/>',
      crown: '<path d="m3 6 5 4 4-6 4 6 5-4-2 13H5L3 6Z"/>',
      user: '<circle cx="12" cy="8" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.user}</svg>`;
  };
  const staffDirectoryIdentity = String(portalUser.id || portalUser.login || portalUser.name || portalUser.role || 'user').trim().toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, '_').slice(0, 80) || 'user';
  const staffDirectoryStorageKey = `hookah_pos_staff_directory_${staffDirectoryIdentity}`;
  const staffDirectoryDefaults = { view: 'cards', cardScale: 2 };
  const normalizeStaffDirectory = (value = {}) => ({ view: ['cards', 'list', 'table'].includes(value?.view) ? value.view : 'cards', cardScale: Number.isInteger(Number(value?.cardScale)) ? Math.max(1, Math.min(4, Number(value.cardScale))) : 2 });
  let staffDirectoryPreference = staffDirectoryDefaults;
  try { staffDirectoryPreference = normalizeStaffDirectory(JSON.parse(localStorage.getItem(staffDirectoryStorageKey) || '{}')); } catch (_) {}
  let currentStaffItems = [];
  let renderStaff = (items) => {
    if (window.location.hash !== '#staff') { renderStaffLegacy(items); return; }
    const list = document.querySelector('#staff-list');
    if (!list) return;
    const labels = { owner: 'Владелец', admin: 'Администратор', manager: 'Управляющий', senior_bartender: 'Старший бармен', senior_hookah_master: 'Старший кальянщик', bartender: 'Бармен', hookah_master: 'Кальянный мастер', developer: 'Разработчик', cleaner: 'Уборщик', security: 'Охрана', technician: 'Техник', other_staff: 'Сотрудник' };
    const view = staffDirectoryPreference.view;
    list.dataset.view = view;
    list.dataset.cardScale = String(staffDirectoryPreference.cardScale);
    const records = items.map(person => {
      const id = esc(person.id);
      const name = esc(person.name || 'Сотрудник');
      const phone = ((person.phoneNumbers || []).find(entry => entry.primary) || person.phoneNumbers?.[0])?.number;
      const email = person.email || '';
      const telegram = String(person.telegram || '').replace(/^https:\/\/t\.me\//, '').replace(/^@/, '').replace(/\/$/, '');
       const photo = String(person.avatarUrl || person.photoUrl || '');
      const photoSafe = /^(?:data:image\/(?:png|jpe?g|webp);base64,|https?:\/\/|\/(?!\/))/.test(photo);
      const canEdit = canManageStaffPerson(person);
      const canChangeAvatar = canEdit || String(person.id) === String(portalUser.id);
      const canBlock = canManageStaff && canEdit && person.role !== 'owner' && String(person.id) !== String(portalUser.id);
      const contacts = [
        phone ? `<span>${staffCardIcon('phone')}<span>${esc(phone)}</span></span>` : '',
        email ? `<span>${staffCardIcon('mail')}<span>${esc(email)}</span></span>` : '',
        telegram ? `<span>${staffCardIcon('telegram')}<span>@${esc(telegram)}</span></span>` : '',
      ].filter(Boolean).join('');
      const status = `<span class="staff-card-status ${person.active ? 'active' : 'inactive'}">${person.active ? 'Активен' : 'Заблокирован'}</span>`;
      const avatar = `<label class="staff-card-avatar${photoSafe ? '' : ' is-placeholder'}" title="${canChangeAvatar ? 'Изменить фото сотрудника' : name}">${photoSafe ? `<img src="${esc(photo)}" alt="Фото ${name}">` : staffCardIcon('user')}${canChangeAvatar ? `<input type="file" accept="image/png,image/jpeg,image/webp" data-avatar="${id}" aria-label="Изменить фото ${name}">` : ''}</label>`;
      const actions = `<div class="staff-card-actions">${canEdit ? `<button type="button" class="staff-edit staff-card-primary" data-staff="${id}" aria-label="Открыть профиль сотрудника ${name}" title="Открыть профиль сотрудника">${staffCardIcon('file')}<span>Профиль</span></button>` : ''}${canBlock ? person.active ? `<button type="button" class="staff-delete staff-card-secondary" data-staff="${id}">${staffCardIcon('ban')}<span>Заблокировать</span></button>` : `<button type="button" class="staff-restore staff-card-secondary" data-staff="${id}">Разблокировать</button>${portalUser.role === 'owner' ? `<button type="button" class="staff-archive staff-card-secondary" data-staff="${id}">Удалить из списка</button>` : ''}` : ''}</div>`;
      const roleLabel = labels[person.role] || person.role || "Сотрудник"; const accessLabel = person.customRoleName ? `${roleLabel} · роль: ${person.customRoleName}` : roleLabel;
      const identity = `<div class="staff-card-identity"><h3>${name}</h3><p>${esc(accessLabel)}</p></div>`;
      if (view === 'list') return `<article class="staff-directory-row staff-row${person.active ? '' : ' inactive'}" data-role="${esc(person.role || '')}" data-name="${name}"><div class="staff-directory-avatar">${avatar}</div>${identity}<div class="staff-card-contacts">${contacts || '<span class="staff-card-contact-empty">Контакты не указаны</span>'}</div>${status}${actions}</article>`;
      if (view === 'table') return `<tr class="staff-table-row staff-row${person.active ? '' : ' inactive'}" data-role="${esc(person.role || '')}" data-name="${name}"><td data-label="Сотрудник"><div class="staff-table-person">${avatar}<strong>${name}</strong>${person.role === 'owner' ? `<span class="staff-card-owner" title="Владелец заведения" aria-label="Владелец заведения">${staffCardIcon('crown')}</span>` : ''}</div></td><td data-label="Должность">${esc(accessLabel)}</td><td data-label="Контакты" class="staff-table-contacts">${contacts || '<span class="staff-card-contact-empty">Контакты не указаны</span>'}</td><td data-label="Статус">${status}</td><td data-label="Действия">${actions}</td></tr>`;
      return `<article class="staff-card${person.active ? '' : ' inactive'}" data-role="${esc(person.role || '')}" data-name="${name}">
        <div class="staff-card-portrait">
          ${avatar}
          ${person.role === 'owner' ? `<span class="staff-card-owner" title="Владелец заведения" aria-label="Владелец заведения">${staffCardIcon('crown')}</span>` : ''}
        </div>
        ${status}
        ${identity}
        <div class="staff-card-contacts">${contacts || '<span class="staff-card-contact-empty">Контакты не указаны</span>'}</div>
        ${person.workNotes ? `<p class="staff-card-note">${esc(person.workNotes)}</p>` : '<p class="staff-card-note" aria-hidden="true"></p>'}
        ${actions}
      </article>`;
    });
    if (!items.length) { list.innerHTML = '<div class="empty">Сотрудники ещё не добавлены</div>'; return; }
    list.innerHTML = view === 'table' ? `<div class="staff-table-scroll"><table class="staff-directory-table"><thead><tr><th scope="col">Сотрудник</th><th scope="col">Должность</th><th scope="col">Контакты</th><th scope="col">Статус</th><th scope="col">Действия</th></tr></thead><tbody>${records.join('')}</tbody></table></div>` : records.join('');
  };

  const originalRenderStaff = renderStaff; renderStaff = (items) => { currentStaffItems = items; originalRenderStaff(items); const badge = document.querySelector('[data-metric="staffActive"]'); if (badge) badge.textContent = formatActiveStaffCount(items.filter((person) => person.active).length); };
  const staffForm = document.querySelector('#staff-form');
  const roleSelect = document.querySelector('#staff-role');
  const photoInput = document.querySelector('#staff-photo');
  const staffSubmitButton = staffForm?.querySelector('button[type="submit"]');
  let staffPhotoReadSeq = 0;
  let staffPhotoReading = false;
  const setStaffPhotoReading = (reading) => {
    staffPhotoReading = reading;
    if (staffSubmitButton && staffForm?.dataset.submitting !== '1') staffSubmitButton.disabled = reading;
  };
  photoInput?.addEventListener('change', () => {
    const readId = ++staffPhotoReadSeq;
    const file = photoInput.files?.[0];
    staffForm?.removeAttribute('data-photo');
    if (!file) { setStaffPhotoReading(false); return; }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      photoInput.value = '';
      setStaffPhotoReading(false);
      portalNotice('Выберите PNG, JPG или WebP до 5 МБ', 'error');
      return;
    }
    setStaffPhotoReading(true);
    compressUploadedImage(file, 256, 20_000_000).then((result) => {
      if (readId !== staffPhotoReadSeq) return;
      if (!result.startsWith('data:image/')) {
        photoInput.value = '';
        portalNotice('Не удалось уменьшить фото. Выберите другой файл.', 'error');
      } else staffForm?.setAttribute('data-photo', result);
      setStaffPhotoReading(false);
    }).catch((error) => {
      if (readId !== staffPhotoReadSeq) return;
      photoInput.value = '';
      setStaffPhotoReading(false);
      portalNotice(error.message === 'image_too_large' ? 'Фото слишком большое по разрешению. Выберите изображение до 20 мегапикселей.' : 'Не удалось обработать фото. Выберите файл ещё раз.', 'error');
    });
  }); const syncStaffRole = () => { const nonCrm = nonCrmStaffRoles.includes(roleSelect?.value); ['#staff-login','#staff-password'].forEach((selector) => { const node = document.querySelector(selector); const label = node?.closest('label'); if (label) label.hidden = Boolean(nonCrm); if (node) { node.required = !nonCrm && selector === '#staff-password'; if (nonCrm) node.value = ''; } }); const hint = document.querySelector('#staff-role-hint'); if (hint) hint.textContent = nonCrm ? 'CRM-доступ, логин и пароль не создаются. Сохраняется только кадровая карточка.' : 'Сотрудник сможет входить в CRM согласно назначенной роли.'; }; roleSelect?.addEventListener('change', syncStaffRole); syncStaffRole(); if (!['#staff', '#permissions'].includes(window.location.hash)) { staffForm?.remove(); document.querySelector('#staff')?.classList.add('staff-summary'); } else if (staffForm && !canManageStaff) { staffForm.hidden = true; staffForm.setAttribute('aria-hidden', 'true'); const note = document.createElement('div'); note.className = 'staff-readonly-note'; note.innerHTML = '<b>Режим просмотра команды</b><small>Кадровые изменения доступны владельцу и администратору.</small>'; staffForm.parentElement?.append(note); }
  target.classList.toggle('staff-catalog-page', window.location.hash === '#staff');
  const staffPanel = document.querySelector('#staff');
  staffPanel?.classList.toggle('staff-catalog', window.location.hash === '#staff');
  const staffHead = staffPanel?.querySelector('.panel-head');
  const staffList = document.querySelector('#staff-list');
  if (staffPanel && staffHead && staffList) {
    const staffTools = document.createElement('div'); staffTools.className = 'staff-list-tools';
    staffTools.innerHTML = '<input id="staff-search" class="table-search" type="search" placeholder="Поиск сотрудника" aria-label="Поиск сотрудника"><select id="staff-role-filter" aria-label="Фильтр по роли"><option value="">Все роли</option><option value="admin">Администратор</option><option value="manager">Управляющий</option><option value="senior_bartender">Старший бармен</option><option value="bartender">Бармен</option><option value="senior_hookah_master">Старший кальянщик</option><option value="hookah_master">Кальянщик</option><option value="cleaner">Уборщица / уборщик</option><option value="security">Охрана</option><option value="technician">Техник</option><option value="other_staff">Другая должность</option></select><select id="staff-status-filter" aria-label="Фильтр по статусу"><option value="">Все статусы</option><option value="active">Активные</option><option value="inactive">Заблокированные</option></select><div class="staff-directory-view-controls" role="group" aria-label="Вид списка сотрудников"><span class="staff-view-label">Вид отображения</span><div class="staff-view-switch"><button type="button" data-staff-view="cards" aria-pressed="true">Плитки</button><button type="button" data-staff-view="list" aria-pressed="false">Список</button><button type="button" data-staff-view="table" aria-pressed="false">Таблица</button></div><label class="staff-card-scale" hidden><span>Размер плиток</span><span class="staff-card-scale-control"><span>Компактнее</span><input type="range" min="1" max="4" step="1" aria-label="Размер плиток сотрудников"><span>Крупнее</span></span></label></div>';
    staffPanel.insertBefore(staffTools, staffPanel.querySelector('.staff-layout'));
    if (canManageStaff) {
      const addButton = document.createElement('button'); addButton.type = 'button'; addButton.className = 'button primary staff-add-button'; addButton.textContent = '＋ Добавить сотрудника'; staffHead.append(addButton);
      const form = document.querySelector('#staff-form');
      if (form) {
        staffPanel.classList.add('staff-directory-only');
        const drawer = document.createElement('div'); drawer.className = 'staff-drawer'; drawer.setAttribute('aria-hidden', 'true'); drawer.innerHTML = '<div class="staff-drawer-scrim" data-staff-drawer-close></div><aside class="staff-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="staff-drawer-title"><div class="staff-drawer-head"><div><h2 id="staff-drawer-title">Новый сотрудник</h2><p>Создайте доступ и назначьте рабочую роль</p></div><button type="button" class="icon-button staff-drawer-close" data-staff-drawer-close aria-label="Закрыть">×</button></div><div class="staff-drawer-body"></div></aside>';
        drawer.querySelector('.staff-drawer-body').append(form); document.body.append(drawer); form.classList.add('staff-drawer-form'); form.querySelector(':scope > b')?.setAttribute('hidden','');
        drawer.inert = true;
        let drawerOpener = null;
        const closeDrawer = () => {
          if (!drawer.classList.contains('open')) return;
          drawerOpener?.focus();
          drawer.classList.remove('open');
          drawer.setAttribute('aria-hidden', 'true');
          drawer.inert = true;
        };
        window.__closeStaffDrawer = closeDrawer;
        addButton.addEventListener('click', () => {
          drawerOpener = document.activeElement instanceof HTMLElement ? document.activeElement : addButton;
          drawer.inert = false;
          drawer.classList.add('open');
          drawer.setAttribute('aria-hidden', 'false');
          form.querySelector('input:not([hidden])')?.focus();
        });
        drawer.addEventListener('keydown', (event) => {
          if (!drawer.classList.contains('open')) return;
          if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); return; }
          if (event.key !== 'Tab') return;
          const focusable = [...drawer.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')]
            .filter((node) => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length > 0);
          const first = focusable[0]; const last = focusable.at(-1);
          if (!first) { event.preventDefault(); drawer.querySelector('.staff-drawer-panel')?.focus(); return; }
          if (!drawer.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
            event.preventDefault(); (event.shiftKey ? last : first).focus();
          }
        });
        drawer.querySelectorAll('[data-staff-drawer-close]').forEach((node) => node.addEventListener('click', closeDrawer));
      }
    }
    const filterRenderedStaff = () => { const query = String(document.querySelector('#staff-search')?.value || '').trim().toLocaleLowerCase('ru-RU'); const role = document.querySelector('#staff-role-filter')?.value || ''; const status = document.querySelector('#staff-status-filter')?.value || ''; const rows = [...staffList.querySelectorAll('.staff-card, .staff-directory-row, .staff-table-row, .staff-row')]; rows.forEach((row) => { const text = row.textContent.toLocaleLowerCase('ru-RU'); const roleMatch = !role || row.dataset.role === role; const statusMatch = !status || (status === 'active' ? row.classList.contains('inactive') === false : row.classList.contains('inactive')); row.hidden = Boolean((query && !text.includes(query)) || !roleMatch || !statusMatch); }); let empty = staffList.querySelector('.staff-filter-empty'); if (rows.length && !rows.some((row) => !row.hidden)) { if (!empty) { empty = document.createElement('div'); empty.className = 'empty staff-filter-empty'; empty.setAttribute('role', 'status'); empty.textContent = 'По текущему поиску и фильтрам сотрудников нет'; staffList.append(empty); } } else empty?.remove(); };
    renderStaff = ((base) => (items) => { base(items); filterRenderedStaff(); })(renderStaff);
    ['staff-search','staff-role-filter','staff-status-filter'].forEach((id) => document.querySelector(`#${id}`)?.addEventListener('input', filterRenderedStaff));
    ['staff-role-filter','staff-status-filter'].forEach((id) => document.querySelector(`#${id}`)?.addEventListener('change', filterRenderedStaff));
    const viewButtons = [...staffTools.querySelectorAll('[data-staff-view]')];
    const scaleInput = staffTools.querySelector('.staff-card-scale input');
    const scaleLabel = staffTools.querySelector('.staff-card-scale');
    const applyStaffDirectoryPreference = () => {
      viewButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.staffView === staffDirectoryPreference.view)));
      scaleLabel.hidden = staffDirectoryPreference.view !== 'cards';
      scaleInput.value = String(staffDirectoryPreference.cardScale);
      if (staffList) { staffList.dataset.view = staffDirectoryPreference.view; staffList.dataset.cardScale = String(staffDirectoryPreference.cardScale); }
      if (currentStaffItems.length) { renderStaff(currentStaffItems); filterRenderedStaff(); }
    };
    let preferenceChanges = 0;
    const updateStaffDirectoryPreference = (partial, persist = true) => {
      staffDirectoryPreference = normalizeStaffDirectory({ ...staffDirectoryPreference, ...partial });
      ++preferenceChanges;
      try { localStorage.setItem(staffDirectoryStorageKey, JSON.stringify(staffDirectoryPreference)); } catch (_) {}
      applyStaffDirectoryPreference();
      if (persist) {
        const identity = preferenceSessionIdentity();
        saveSessionPreference({ staffDirectory: partial }).catch(() => {
          if (samePreferenceSession(identity)) portalNotice('Настройка вида сохранена на этом устройстве, но не синхронизировалась с учётной записью.', 'error');
        });
      }
    };
    viewButtons.forEach((button) => button.addEventListener('click', () => updateStaffDirectoryPreference({ view: button.dataset.staffView })));
    scaleInput.addEventListener('input', () => updateStaffDirectoryPreference({ cardScale: Number(scaleInput.value) }, false));
    scaleInput.addEventListener('change', () => updateStaffDirectoryPreference({ cardScale: Number(scaleInput.value) }));
    applyStaffDirectoryPreference();
    const preferenceIdentity = preferenceSessionIdentity();
    api('/api/session/preferences').then((data) => {
      const saved = data?.preferences?.staffDirectory;
      if (staffPanel.isConnected && samePreferenceSession(preferenceIdentity) && !preferenceChanges && saved && typeof saved === 'object') {
        staffDirectoryPreference = normalizeStaffDirectory(saved);
        try { localStorage.setItem(staffDirectoryStorageKey, JSON.stringify(staffDirectoryPreference)); } catch (_) {}
        applyStaffDirectoryPreference();
      }
    }).catch(() => reportPreferenceReadFailure());
  }
  const showStaffLoadError = () => { if (staffList) staffList.innerHTML = '<div class="empty" role="alert">Не удалось загрузить сотрудников. <button type="button" class="button small staff-list-retry">Повторить</button></div>'; const badge = document.querySelector('[data-metric="staffActive"]'); if (badge) badge.textContent = '—'; };
  let staffLoadSeq = 0;
  const invalidateStaffReads = () => { ++staffLoadSeq; };
  const readStaffList = () => {
    const requestId = ++staffLoadSeq;
    const isCurrent = () => requestId === staffLoadSeq && document.querySelector('#staff-list') === staffList;
    return api('/api/staff').then((data) => {
      if (!isCurrent()) return false;
      if (!Array.isArray(data?.items)) throw new Error('staff_invalid_response');
      renderStaff(data.items);
      return true;
    }).catch((error) => {
      if (!isCurrent()) return false;
      showStaffLoadError();
      throw error;
    });
  };
  const loadStaffList = ({ silentError = false } = {}) => readStaffList().then((loaded) => ({ status: loaded ? 'loaded' : 'stale' })).catch(() => { if (!silentError) portalNotice('Не удалось обновить список сотрудников', 'error'); return { status: 'error' }; });
  const refreshStaffAfterMutation = (successMessage) => readStaffList().then((loaded) => { if (loaded) portalNotice(successMessage, 'success'); }).catch(() => portalNotice('Изменение сохранено, но список не обновился. Повторите загрузку списка.', 'error'));
  window.__refreshStaffList = canViewStaff ? loadStaffList : undefined;
  staffList?.addEventListener('click', (event) => { if (event.target.closest('.staff-list-retry')) loadStaffList(); });
  if (canViewStaff) loadStaffList();
  document.querySelector('#staff-form')?.addEventListener('submit', (event) => { event.preventDefault(); const form = event.target; if (form.dataset.submitting === '1') return; if (staffPhotoReading) { const message = document.querySelector('#staff-message'); message.className = 'form-message error-message'; message.textContent = 'Дождитесь загрузки фото'; return; } form.dataset.submitting = '1'; const submit = form.querySelector('button[type="submit"]'); if (submit) submit.disabled = true; const message = document.querySelector('#staff-message'); let phoneNumbers = []; try { phoneNumbers = JSON.parse(form.querySelector('[name="phones_json"]')?.value || '[]'); } catch (_) {} const legacyPhones = [{ label: 'Рабочий', number: form.querySelector('[name="phone_primary"]')?.value?.trim() || '', primary: true }, { label: 'Дополнительный', number: form.querySelector('[name="phone_secondary"]')?.value?.trim() || '', primary: false }].filter((entry) => entry.number); if (legacyPhones.length) { const known = new Set(phoneNumbers.map((entry) => String(entry.number || '').trim())); legacyPhones.forEach((entry) => { if (!known.has(entry.number)) { phoneNumbers.push(entry); known.add(entry.number); } }); } if (phoneNumbers.length > 5 || phoneNumbers.some((entry) => !/^\+7[0-9 ()-]{7,24}$/.test(String(entry.number || '').trim()))) { message.className = 'form-message error-message'; message.textContent = 'Проверьте телефоны: до пяти номеров, один основной'; form.dataset.submitting = '0'; if (submit) submit.disabled = false; return; } const passportData = { number: form.querySelector('[name="passport_number"]')?.value?.trim() || '', issuedAt: form.querySelector('[name="passport_issued_at"]')?.value || '', issuer: form.querySelector('[name="passport_issuer"]')?.value?.trim() || '' }; const selectedPermissionScopes = [...form.querySelectorAll('[name="permissionScopes"]:checked')].map((node) => node.value); const payload = { name: document.querySelector('#staff-name').value.trim(), login: document.querySelector('#staff-login').value.trim() || undefined, password: nonCrmStaffRoles.includes(document.querySelector('#staff-role').value) ? undefined : (document.querySelector('#staff-password').value || undefined), role: document.querySelector('#staff-role').value, birthDate: form.querySelector('[name="birth_date"]')?.value || undefined, photoUrl: form.dataset.photo || undefined, telegram: form.querySelector('[name="telegram"]')?.value?.trim() || undefined, phoneNumbers, employmentStartedAt: form.querySelector('[name="employment_started_at"]')?.value || undefined, workNotes: form.querySelector('[name="work_notes"]')?.value?.trim() || undefined, ...(passportData.number || passportData.issuedAt || passportData.issuer ? { passportData } : {}), ...(portalUser.role === 'owner' ? { permissionScopes: selectedPermissionScopes } : {}) }; invalidateStaffReads(); api('/api/staff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(() => { message.className = 'form-message'; message.textContent = 'Сотрудник создан'; form.reset(); form.removeAttribute('data-photo'); window.__closeStaffDrawer?.(); return readStaffList().then((loaded) => { if (loaded) portalNotice('Сотрудник создан', 'success'); }).catch(() => { portalNotice('Сотрудник создан, но список не обновился. Повторите загрузку списка.', 'error'); }); }).catch((error) => { const reason = String(error.payload?.error || error.message || ''); message.className = 'form-message error-message'; message.textContent = reason === 'birth_date_required' ? 'Укажите дату рождения' : reason === 'invalid_birth_date' ? 'Проверьте дату рождения' : reason === 'invalid_staff_photo' ? 'Выберите корректное PNG, JPG или WebP изображение до 5 МБ' : reason === 'staff_photo_permission_required' ? 'Фото доступно только владельцу, администратору и управляющему' : reason === 'invalid_staff_login' ? 'Логин: 3–32 символа, буквы, цифры, дефис или подчёркивание' : reason === 'login_already_exists' ? 'Такой логин уже используется' : reason === 'password_required' ? 'Укажите пароль для логина' : reason === 'password_length_invalid' ? 'Пароль должен содержать от 4 до 11 символов' : reason === 'one_primary_phone_required' ? 'Выберите один основной номер' : reason === 'invalid_telegram' ? 'Проверьте ссылку Telegram' : reason === 'invalid_phone_numbers' ? 'Проверьте телефоны: до пяти номеров, один основной'  : reason === 'staff_passport_key_required' ? 'Не настроен ключ шифрования паспортных данных' : reason === 'staff_management_required' ? 'Недостаточно прав для управления сотрудниками' : reason === 'staff_role_assignment_required' ? 'Назначать администраторов и разработчиков может только владелец' : 'Не удалось создать доступ'; }).finally(() => { form.dataset.submitting = '0'; if (submit) submit.disabled = false; }); });
  document.querySelector('#staff-list')?.addEventListener('click', async (event) => { const button = event.target.closest('.staff-delete'); if (!button) return; if (!await portalConfirm('Заблокировать доступ?', 'История и кадровая карточка сохранятся.', 'Заблокировать')) return; invalidateStaffReads(); api(`/api/staff/${button.dataset.staff}`, { method: 'DELETE' }).then(() => refreshStaffAfterMutation('Сотрудник заблокирован')).catch(() => portalNotice('Не удалось заблокировать сотрудника', 'error')); });
  document.querySelector('#staff-list')?.addEventListener('click', (event) => { const button = event.target.closest('.staff-restore'); if (!button) return; invalidateStaffReads(); api(`/api/staff/${button.dataset.staff}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: true }) }).then(() => refreshStaffAfterMutation('Сотрудник разблокирован')).catch(() => portalNotice('Не удалось разблокировать сотрудника', 'error')); });
  document.querySelector('#staff-list')?.addEventListener('click', async (event) => { const button = event.target.closest('.staff-archive'); if (!button) return; if (!await portalConfirm('Удалить сотрудника из рабочего списка?', 'Доступ и кадровая карточка станут недоступны, история операций останется в аудите.', 'Удалить из списка')) return; button.disabled = true; invalidateStaffReads(); api(`/api/staff/${button.dataset.staff}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(() => refreshStaffAfterMutation('Сотрудник удалён из рабочего списка')).catch((error) => { button.disabled = false; const reason=error.payload?.error; portalNotice(reason === 'staff_archive_owner_required' ? 'Удалять из списка может только владелец' : reason === 'staff_must_be_blocked_before_archive' ? 'Сначала заблокируйте доступ сотрудника' : 'Не удалось удалить сотрудника', 'error'); }); });
  document.querySelector('#staff-list')?.addEventListener('change', (event) => { const input = event.target.closest('input[data-avatar]'); const file = input?.files?.[0]; if (!file) return; if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) { portalNotice('Выберите PNG, JPG или WebP до 5 МБ', 'error'); if (input) input.value = ''; return; } invalidateStaffReads(); compressUploadedImage(file, 256, 20_000_000).then((imageData) => api(`/api/staff/${input.dataset.avatar}/avatar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageData }) })).then((saved) => { if (String(input.dataset.avatar) === String(portalUser.id) && saved?.avatarUrl) refreshPortalHeaderAvatar(saved.avatarUrl); return refreshStaffAfterMutation('Аватар сотрудника обновлён'); }).catch((error) => portalNotice(error.message === 'image_too_large' ? 'Фото слишком большое по разрешению. Выберите изображение до 20 мегапикселей.' : 'Не удалось обработать или загрузить аватар', 'error')).finally(() => { input.value = ''; }); });
  if (['owner', 'admin', 'developer'].includes(portalUser.role) && window.location.hash === '#diagnostics') { const diagnosticsPanel = document.createElement('section'); diagnosticsPanel.className = 'panel audit-panel'; diagnosticsPanel.id = 'diagnostics'; diagnosticsPanel.innerHTML = '<div class="panel-head"><div><h2>Диагностика Telegram</h2><span class="muted">Техническое состояние CRM и Telegram</span></div></div><div id="diagnostics-list" class="audit-list"><div class="empty">Проверка состояния…</div></div>'; target.append(diagnosticsPanel); api('/api/integrations').then((data) => { const labels = { telegram: 'Telegram' }; document.querySelector('#diagnostics-list').innerHTML = Object.entries(labels).map(([key, label]) => `<div class="audit-row"><span class="audit-icon">${icon(data[key]?.enabled ? 'circle-check' : 'alert-triangle')}</span><div><b>${label}</b><small>${data[key]?.enabled ? 'Подключено' : 'В подготовке'}</small></div></div>`).join(''); }).catch(() => portalNotice('Не удалось загрузить состояние интеграций', 'error')); }
  const floorEditor = document.createElement('section'); floorEditor.className = 'panel floor-editor-panel'; floorEditor.id = 'floor-editor'; floorEditor.dataset.settingsOnly = ''; floorEditor.innerHTML = '<div class="panel-head"><div><h2>Схема зала</h2><span class="muted">Название, размеры и геометрия столов сохраняются для рабочей панели персонала</span></div><span class="badge" id="floor-editor-count">Загрузка…</span></div><div class="floor-editor-status" id="floor-editor-status" hidden><span></span><button class="button small" type="button" data-floor-refresh>Повторить загрузку</button></div><div class="floor-editor-canvas" id="floor-editor-canvas" aria-label="Схема зала"></div><div class="floor-editor-grid" id="floor-editor-grid"><div class="empty">Загрузка объектов…</div></div>'; target.append(floorEditor);
  const floorZoneTabs = document.createElement('div'); floorZoneTabs.className = 'floor-editor-zone-tabs'; floorZoneTabs.setAttribute('role', 'tablist'); floorZoneTabs.setAttribute('aria-label', 'Зал схемы'); floorEditor.querySelector('.panel-head').after(floorZoneTabs);
  const floorPanHint = document.createElement('p'); floorPanHint.className = 'floor-editor-pan-hint'; floorPanHint.textContent = 'На узком экране проведите по схеме, чтобы увидеть остальные столы. Координаты можно изменить и в карточке стола.'; floorEditor.querySelector('#floor-editor-canvas').after(floorPanHint);
  const floorEditorPlacement = (table, index) => {
    const source = table.layout || {};
    const fallback = { x: (index % 5) * 190 + 12, y: Math.floor(index / 5) * 125 + 12, width: 160, height: 90 };
    const value = (input, base, min, max) => Number.isFinite(Number(input)) ? Math.min(max, Math.max(min, Number(input))) : base;
    const pixel = source.unit === 'px' || source.width !== undefined || source.height !== undefined || ((source.x !== undefined || source.y !== undefined) && source.w === undefined && source.h === undefined);
    const grid = source.unit === 'grid' || (!pixel && (source.w !== undefined || source.h !== undefined));
    return { x: grid ? (value(source.x, 1, 1, 60) - 1) * 80 + 12 : value(source.x, fallback.x, 0, 5000),
      y: grid ? (value(source.y, 1, 1, 100) - 1) * 45 + 12 : value(source.y, fallback.y, 0, 5000),
      width: grid ? Math.max(40, value(source.w, 3, 1, 60) * 80 - 12) : value(source.width, fallback.width, 40, 5000),
      height: grid ? Math.max(40, value(source.h, 2, 1, 100) * 45 - 12) : value(source.height, fallback.height, 40, 5000),
      shape: source.shape || 'rectangle', rotation: value(source.rotation, 0, 0, 5000) };
  };
  const drawFloorEditor = (payload, { preserveDrafts = false, excludeId = '' } = {}) => { const priorVenueId = floorEditor.dataset.venueId; floorEditor.dataset.venueId = String(payload.venueId || ''); if (priorVenueId !== floorEditor.dataset.venueId) floorEditor.dataset.zoneId = ''; floorEditor._payload = payload; const canvas = document.querySelector('#floor-editor-canvas'); const grid = document.querySelector('#floor-editor-grid'); const drafts = preserveDrafts && priorVenueId === floorEditor.dataset.venueId ? [...grid.querySelectorAll('form[data-floor-table]')].filter((form) => form.dataset.floorTable !== excludeId).map((form) => ({ id: form.dataset.floorTable, values: [...new FormData(form).entries()], open: form.closest('details')?.open })) : []; const zones = payload.zones || []; const selectedZone = zones.find((zone) => String(zone.id) === floorEditor.dataset.zoneId) || zones[0]; floorEditor.dataset.zoneId = String(selectedZone?.id || ''); floorZoneTabs.innerHTML = zones.map((zone) => `<button type="button" role="tab" data-floor-zone-tab="${esc(zone.id)}" aria-selected="${String(zone.id) === floorEditor.dataset.zoneId}" class="${String(zone.id) === floorEditor.dataset.zoneId ? 'selected' : ''}">${esc(zone.name)}</button>`).join(''); const tables = zones.flatMap((zone) => (zone.tables || []).map((table, fallbackIndex) => ({ ...table, zoneId: zone.id, zoneName: zone.name, renderLayout: floorEditorPlacement(table, fallbackIndex) }))); const visibleTables = tables.filter((table) => String(table.zoneId) === floorEditor.dataset.zoneId); document.querySelector('#floor-editor-count').textContent = `${visibleTables.length} из ${tables.length} объектов`; if (canvas) { const sceneWidth = Math.max(1000, ...visibleTables.map((table) => table.renderLayout.x + table.renderLayout.width + 24)); const sceneHeight = Math.max(560, ...visibleTables.map((table) => table.renderLayout.y + table.renderLayout.height + 24)); canvas.innerHTML = `<div class="floor-map-stage" style="width:${sceneWidth}px;height:${sceneHeight}px">` + visibleTables.map((table) => { const layout = table.renderLayout; const width = layout.width; const height = layout.height; const x = layout.x; const y = layout.y; return `<button type="button" class="floor-editor-object shape-${esc(layout.shape || 'rectangle')} ${table.status === 'blocked' ? 'is-blocked' : ''}" data-floor-drag="${esc(table.id)}" style="left:${x}px;top:${y}px;width:${width}px;height:${height}px;transform:rotate(${Number(layout.rotation || 0)}deg)">${esc(table.name)}</button>`; }).join('') + '</div>'; } grid.innerHTML = tables.map((table, index) => { const layout = table.renderLayout; const stateLabel = table.status === 'blocked' ? 'Заблокирован' : 'Активен'; return `<details class="floor-editor-card-disclosure" ${index === 0 ? 'open' : ''}><summary><span><b>${esc(table.name)}</b><small>${esc(table.zoneName || '')} · ${Number(table.capacity || 2)} мест</small></span><span class="floor-editor-summary-meta"><span class="badge ${table.status === 'blocked' ? 'danger' : 'success'}">${stateLabel}</span><span class="floor-editor-summary-chevron" aria-hidden="true">›</span></span></summary><form class="floor-editor-card" data-floor-table="${esc(table.id)}" data-capacity="${Number(table.capacity || 2)}"><label>Название<input name="name" value="${esc(table.name || '')}" maxlength="80" required></label><div class="floor-editor-fields"><label>Вместимость<input name="capacity" type="number" min="1" max="100" value="${Number(table.capacity || 2)}"></label><label>Форма<select name="shape"><option value="rectangle" ${layout.shape === 'rectangle' || !layout.shape ? 'selected' : ''}>Прямоугольник</option><option value="square" ${layout.shape === 'square' ? 'selected' : ''}>Квадрат</option><option value="circle" ${layout.shape === 'circle' ? 'selected' : ''}>Круг</option><option value="oval" ${layout.shape === 'oval' ? 'selected' : ''}>Овал</option><option value="freeform" ${layout.shape === 'freeform' ? 'selected' : ''}>Свободная форма</option></select></label><label>X<input name="x" type="number" min="0" max="5000" value="${Number(layout.x || 0)}"></label><label>Y<input name="y" type="number" min="0" max="5000" value="${Number(layout.y || 0)}"></label><label>Ширина<input name="width" type="number" min="40" max="5000" value="${Number(layout.width || 160)}"></label><label>Высота<input name="height" type="number" min="40" max="5000" value="${Number(layout.height || 90)}"></label></div><div class="floor-editor-card__actions"><button class="button small" type="button" data-floor-block="${esc(table.id)}">${table.status === 'blocked' ? 'Разблокировать' : 'Заблокировать'}</button><button class="button small primary" type="submit">Сохранить</button></div><p class="form-message" data-floor-message></p></form></details>`; }).join(''); for (const draft of drafts) { const form = [...grid.querySelectorAll('form[data-floor-table]')].find((node) => node.dataset.floorTable === draft.id); if (!form) continue; for (const [name, value] of draft.values) { const field = form.elements.namedItem(name); if (field && 'value' in field) field.value = value; } form.closest('details').open = draft.open; } };
  if (portalPermissions.has('settings')) {
    const canvas = floorEditor.querySelector('#floor-editor-canvas');
    const grid = floorEditor.querySelector('#floor-editor-grid');
    floorZoneTabs.addEventListener('click', (event) => { const button = event.target.closest('[data-floor-zone-tab]'); if (!button || !floorEditor._payload) return; floorEditor.dataset.zoneId = button.dataset.floorZoneTab; drawFloorEditor(floorEditor._payload, { preserveDrafts: true }); });
    const status = floorEditor.querySelector('#floor-editor-status');
    let dragState = null;
    let floorReadRevision = 0;
    let editorStale = false;
    let retryExcludeId = '';
    const pendingTables = new Set();
    const setFloorPending = (id, pending) => {
      if (pending) pendingTables.add(id); else pendingTables.delete(id);
      [...grid.querySelectorAll('[data-floor-table]')].filter((form) => form.dataset.floorTable === id)
        .forEach((form) => form.querySelectorAll('button').forEach((button) => { button.disabled = pending || editorStale; }));
      [...canvas.querySelectorAll('[data-floor-drag]')].filter((object) => object.dataset.floorDrag === id)
        .forEach((object) => { object.disabled = pending || editorStale; });
    };
    const setEditorStale = (message) => {
      editorStale = true;
      status.hidden = false;
      status.querySelector('span').textContent = message;
      if (!floorEditor.dataset.venueId) {
        floorEditor.querySelector('#floor-editor-count').textContent = 'Ошибка загрузки';
        grid.innerHTML = '<div class="empty">Схема пока недоступна</div>';
      }
      grid.querySelectorAll('[data-floor-table] button').forEach((button) => { button.disabled = true; });
      canvas.querySelectorAll('[data-floor-drag]').forEach((object) => { object.disabled = true; });
    };
    const reloadFloorEditor = (options = {}) => {
      const revision = ++floorReadRevision;
      return api('/api/floor').then((payload) => {
        if (revision !== floorReadRevision) return false;
        editorStale = false;
        drawFloorEditor(payload, options);
        retryExcludeId = '';
        status.hidden = true;
        pendingTables.forEach((id) => setFloorPending(id, true));
        return true;
      }).catch((error) => { if (revision !== floorReadRevision) return false; throw error; });
    };
    const contextChanged = (error) => error.payload?.error === 'venue_context_changed';
    const showFloorError = (error, fallback) => {
      if (contextChanged(error)) {
        setEditorStale('Точка изменилась. Загрузите актуальную схему.');
        reloadFloorEditor().catch(() => setEditorStale('Не удалось загрузить актуальную схему.'));
        portalNotice('Точка изменилась. Загрузите актуальную схему.', 'error');
      } else portalNotice(fallback, 'error');
    };
    const refreshFloor = (options = {}) => reloadFloorEditor(options);
    refreshFloor().catch(() => setEditorStale('Не удалось загрузить схему. Повторите загрузку.'));
    status.querySelector('[data-floor-refresh]').addEventListener('click', () => refreshFloor({ preserveDrafts: true, excludeId: retryExcludeId }).catch(() => setEditorStale('Не удалось загрузить схему. Повторите загрузку.')));
    canvas.addEventListener('pointerdown', (event) => {
      const object = event.target.closest('[data-floor-drag]');
      if (!object || dragState || editorStale || pendingTables.has(object.dataset.floorDrag) || event.button !== 0) return;
      object.setPointerCapture?.(event.pointerId);
      dragState = { pointerId: event.pointerId, id: object.dataset.floorDrag, venueId: floorEditor.dataset.venueId,
        startX: event.clientX, startY: event.clientY, x: Number.parseFloat(object.style.left) || 0,
        y: Number.parseFloat(object.style.top) || 0, moved: false, object };
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const state = dragState;
      if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < 5 && !state.moved) return;
      state.moved = true;
      state.object.style.left = `${Math.max(0, Math.round(state.x + event.clientX - state.startX))}px`;
      state.object.style.top = `${Math.max(0, Math.round(state.y + event.clientY - state.startY))}px`;
    });
    const cancelDrag = (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const state = dragState; dragState = null;
      if (state.object.isConnected) { state.object.style.left = `${state.x}px`; state.object.style.top = `${state.y}px`; }
    };
    canvas.addEventListener('pointercancel', cancelDrag);
    canvas.addEventListener('lostpointercapture', cancelDrag);
    canvas.addEventListener('pointerup', (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const state = dragState; dragState = null;
      if (!state.moved) return;
      const x = Math.round(Number.parseFloat(state.object.style.left) || 0);
      const y = Math.round(Number.parseFloat(state.object.style.top) || 0);
      if (x === state.x && y === state.y) return;
      setFloorPending(state.id, true);
      api(`/api/floor/tables/${encodeURIComponent(state.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVenueId: state.venueId, layout: { unit: 'px', x, y } }) })
        .then(() => {
          const form = [...grid.querySelectorAll('[data-floor-table]')].find((node) => node.dataset.floorTable === state.id);
          if (form) { form.elements.namedItem('x').value = x; form.elements.namedItem('y').value = y; }
          portalNotice('Позиция стола сохранена', 'success');
        }).catch((error) => {
          if (state.object.isConnected) { state.object.style.left = `${state.x}px`; state.object.style.top = `${state.y}px`; }
          showFloorError(error, 'Не удалось сохранить позицию');
        }).finally(() => setFloorPending(state.id, false));
    });
    grid.addEventListener('submit', (event) => {
      const form = event.target.closest('[data-floor-table]');
      if (!form) return;
      event.preventDefault();
      const id = form.dataset.floorTable;
      if (editorStale || pendingTables.has(id)) return;
      const message = form.querySelector('[data-floor-message]');
      const data = new FormData(form);
      const payload = { expectedVenueId: floorEditor.dataset.venueId, name: data.get('name'),
        layout: { unit: 'px', x: Number(data.get('x')), y: Number(data.get('y')), width: Number(data.get('width')),
          height: Number(data.get('height')), shape: data.get('shape') } };
      if (Number(data.get('capacity')) !== Number(form.dataset.capacity)) payload.capacity = Number(data.get('capacity'));
      setFloorPending(id, true); message.textContent = '';
      api(`/api/floor/tables/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(() => refreshFloor({ preserveDrafts: true, excludeId: id })
          .then((loaded) => { if (loaded) portalNotice('Параметры стола сохранены', 'success'); })
          .catch(() => { retryExcludeId = id; setEditorStale('Параметры сохранены, но схема не обновилась. Повторите загрузку.'); portalNotice('Параметры сохранены, но схема не обновилась', 'error'); }))
        .catch((error) => {
          if (!form.isConnected) return;
          message.textContent = contextChanged(error) ? 'Точка изменилась. Откройте актуальную схему.' : 'Не удалось сохранить параметры';
          message.className = 'form-message error-message';
          if (contextChanged(error)) showFloorError(error, 'Не удалось сохранить параметры');
        }).finally(() => setFloorPending(id, false));
    });
    grid.addEventListener('click', (event) => {
      const button = event.target.closest('[data-floor-block]');
      if (!button || editorStale) return;
      const id = button.dataset.floorBlock;
      if (pendingTables.has(id)) return;
      const isBlocked = button.textContent.includes('Разблокировать');
      setFloorPending(id, true);
      api(`/api/floor/tables/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVenueId: floorEditor.dataset.venueId, status: isBlocked ? 'free' : 'blocked' }) })
        .then(() => refreshFloor({ preserveDrafts: true })
          .then((loaded) => { if (loaded) portalNotice(isBlocked ? 'Стол разблокирован' : 'Стол заблокирован', 'success'); })
          .catch(() => { setEditorStale('Статус изменён, но схема не обновилась. Повторите загрузку.'); portalNotice('Статус изменён, но схема не обновилась', 'error'); }))
        .catch((error) => showFloorError(error, 'Не удалось изменить статус стола'))
        .finally(() => setFloorPending(id, false));
    });
  } else floorEditor.remove();
  const auditPanel = document.createElement('section'); auditPanel.className = 'panel audit-panel'; auditPanel.id = 'audit'; auditPanel.innerHTML = '<div class="panel-head audit-head"><div><h2>Журнал действий</h2><span class="muted">Кто, что и когда изменил в системе</span></div><span class="badge" id="audit-count">— событий</span></div><div class="audit-toolbar"><input id="audit-search" class="table-search" placeholder="Поиск по действию, объекту или исполнителю" aria-label="Поиск в журнале"><select id="audit-action" aria-label="Фильтр по действию"><option value="">Все действия</option></select><select id="audit-entity" aria-label="Фильтр по объекту"><option value="">Все объекты</option><option value="order">Заказы</option><option value="staff">Сотрудники</option><option value="inventory">Склад</option><option value="reservation">Бронирования</option><option value="discount">Скидки</option><option value="venue">Компания</option><option value="shift">Смена</option><option value="finance_report">Финансовый отчёт</option><option value="finance_category">Категория финансов</option><option value="product">Товар</option><option value="payment">Оплата</option><option value="order_item">Позиция заказа</option></select><label class="audit-date-field">С даты<input id="audit-from" type="date" aria-label="С даты"></label><label class="audit-date-field">По дату<input id="audit-to" type="date" aria-label="По дату"></label><button class="button small" id="audit-reset" type="button">Сбросить</button><button class="button small" id="audit-export" type="button">Экспорт CSV</button></div><div id="audit-list" class="audit-list" aria-live="polite"><div class="empty">Загрузка журнала…</div></div><dialog id="audit-detail" class="audit-detail"><div class="panel-head"><div><h2>Детали события</h2><span class="muted" id="audit-detail-meta"></span></div><button class="icon-button" id="audit-detail-close" type="button" aria-label="Закрыть"><svg class="icon" aria-hidden="true"><use href="/assets/tabler-icons.svg#x"></use></svg></button></div><div class="audit-detail-grid"><section class="audit-detail-summary"><h3>Изменённые поля</h3><p id="audit-fields">—</p></section><section><h3>До изменения</h3><pre id="audit-before">—</pre></section><section><h3>После изменения</h3><pre id="audit-after">—</pre></section></div></dialog>'; if (canViewAudit) target.append(auditPanel);
   const companyPanel = document.createElement('section'); companyPanel.className = 'panel company-panel'; companyPanel.id = 'company'; companyPanel.dataset.ownerOnly = ''; companyPanel.innerHTML = '<div class="panel-head"><div><h2 id="company-panel-title">Карточка компании</h2><span id="company-panel-description" class="muted">Единая карточка текущего заведения: название, адрес, контакты, формат, часовой пояс и правила VIP-зон. Список точек сети — в «Моя сеть».</span></div></div><form id="company-form" class="company-form"><label>Название заведения<input id="company-name" type="text" maxlength="120" placeholder="Название заведения" required></label><label>Город<input id="company-city" type="text" maxlength="80" placeholder="Город" required></label><label>Адрес<input id="company-address" type="text" maxlength="240" placeholder="Улица, дом" required></label><label>Формат<input id="company-format" type="text" maxlength="80" placeholder="кальян-бар"></label><label>Часовой пояс<select id="company-timezone" required>${russianTimezoneOptions()}</select></label><div class="staff-phone-list company-phone-list"><div class="staff-phone-list__header"><b>Телефоны</b><button type="button" class="staff-phone-list__add" id="company-add-phone">Добавить номер</button></div><div id="company-phone-list" class="staff-phone-list__rows"></div><small class="muted">До пяти номеров. Один номер можно назначить основным.</small></div><div class="vip-settings"><b>Депозит VIP-комнат</b><label>Комната 1<input id="vip-minimum-1" type="number" min="0" step="1"></label><label>Комната 2<input id="vip-minimum-2" type="number" min="0" step="1"></label></div><label class="logo-upload">Логотип<input id="company-logo" type="file" accept="image/png,image/jpeg,image/webp"><span>PNG, JPG или WebP до 1.5 МБ</span></label><button class="button primary" type="submit">Сохранить данные</button><small id="company-message" class="form-message"></small></form><section class="settings-dashboard-panel panel" id="settings-dashboard-modules"><div class="panel-head"><div><h2>Интерфейс и главная</h2><span class="muted">Персональные настройки рабочего профиля: блоки главной и вид выручки.</span></div></div><div class="settings-dashboard-grid"><div><b>Показывать на главной</b><label class="theme-preference"><input type="checkbox" data-theme-toggle> Светлая схема</label><label><input type="checkbox" data-dashboard-module-toggle="kpi" checked> Финансовые показатели</label><label><input type="checkbox" data-dashboard-module-toggle="insights" checked> Аналитика смены</label><label><input type="checkbox" data-dashboard-module-toggle="shift" checked> Контроль смены</label><label><input type="checkbox" data-dashboard-module-toggle="quick" checked> Быстрые действия</label><label><input type="checkbox" data-dashboard-module-toggle="staff" checked> Команда</label><div class="navigation-preferences"><b>Пункты бокового меню</b><label><input type="checkbox" data-interface-toggle="orders" checked> Заказы</label><label><input type="checkbox" data-interface-toggle="clients" checked> Гости</label><label><input type="checkbox" data-interface-toggle="reservations" checked> Бронирования</label><label><input type="checkbox" data-interface-toggle="floor" checked> Рабочий зал</label><label><input type="checkbox" data-interface-toggle="delivery" checked> Доставка</label><label><input type="checkbox" data-interface-toggle="inventory" checked> Склад</label><label><input type="checkbox" data-interface-toggle="finance" checked> Финансы</label><label><input type="checkbox" data-interface-toggle="loyalty" checked> Система лояльности</label><label><input type="checkbox" data-interface-toggle="staff" checked> Персонал</label><label><input type="checkbox" data-interface-toggle="integrations" checked> Интеграции</label></div></div><div class="settings-dashboard-select"><b>Показатель выручки</b><small>Единый вид главных показателей, чтобы карточки оставались понятными на любом экране.</small></div></div><div class="settings-dashboard-insights finance-preferences"><b>Динамика финансов</b><label><input type="checkbox" data-finance-metric-toggle="revenue" checked> Оборот заведения</label><label><input type="checkbox" data-finance-metric-toggle="profit" checked> Чистая прибыль</label><label><input type="checkbox" data-finance-metric-toggle="expenses" checked> Расходы</label><label><input type="checkbox" data-finance-metric-toggle="average" checked> Средний чек</label><label><input type="checkbox" data-finance-metric-toggle="median" checked> Медианный чек</label><label><input type="checkbox" data-finance-metric-toggle="tables" checked> Средние столы в день</label><small>Выбранные показатели будут доступны в разделе «Финансы».</small></div></section><section class="venue-layout-settings" id="venue-layout-settings"><div class="panel-head"><div><h2>Залы, этажи и столы</h2><span class="muted">Сначала создайте зал или этаж, затем добавьте в него столы и VIP-комнаты. Всё сразу появится в схеме зала, бронированиях и заказах.</span></div><div class="toolbar-row"><button type="button" class="button small" id="new-floor-zone">+ Зал / этаж</button><button type="button" class="button small" id="new-floor-table">+ Стол</button><button type="button" class="button small primary" id="new-vip-room">+ VIP-комната</button></div></div><div class="venue-layout-guide"><span class="venue-layout-guide__step"><b>1</b><span><strong>Зал или этаж</strong><small>Например, «Основной зал» или «Терраса»</small></span></span><span class="venue-layout-guide__arrow">→</span><span class="venue-layout-guide__step"><b>2</b><span><strong>Столы и комнаты</strong><small>Добавьте посадочные места внутрь зала</small></span></span><span class="venue-layout-guide__arrow">→</span><span class="venue-layout-guide__step"><b>3</b><span><strong>Схема зала</strong><small>Перетащите столы и сохраните размеры</small></span></span></div><div id="venue-zone-list"><div class="empty">Загрузка залов…</div></div><form id="venue-zone-form" class="stack-form" hidden><label>Название зала / этажа<span class="required-mark">*</span><input id="venue-zone-name" maxlength="80" required placeholder="Например, Основной зал или 2 этаж"></label><small class="muted">После сохранения мы предложим сразу добавить первый стол.</small><div class="toolbar-row"><button class="button primary" type="submit">Сохранить зал</button><button class="button" id="cancel-venue-zone" type="button">Отмена</button></div><p class="form-message" id="venue-zone-message"></p></form><form id="venue-room-form" class="stack-form" hidden><div class="panel-head"><div><h3 id="venue-room-form-title">Добавить стол</h3><span class="muted" id="venue-room-form-hint">Стол появится в выбранном зале и станет доступен сотрудникам.</span></div></div><label>Зал / этаж<span class="required-mark">*</span><select id="venue-room-zone" required></select></label><label>Название посадочного места<span class="required-mark">*</span><input id="venue-room-name" maxlength="80" required placeholder="Например, Стол 1"></label><div class="form-row"><label>Минимум гостей<input id="venue-room-min-capacity" type="number" min="1" max="100" value="2" required></label><label>Максимум гостей<input id="venue-room-max-capacity" type="number" min="1" max="100" value="4" required></label><input id="venue-room-capacity" type="hidden" value="4"><label>Минимальный депозит, ₽<input id="venue-room-minimum" type="number" min="0" step="1" value="0"></label></div><fieldset class="venue-amenities-fieldset"><legend>Оснащение стола</legend><div class="venue-amenities-toolbar"><label class="venue-amenity-option"><input id="venue-room-playstation" type="checkbox"><span class="venue-amenity-mark venue-amenity-mark--playstation">PS5</span><span><b>PlayStation 5</b><small>Игровая приставка</small></span></label><label class="venue-amenity-option"><input id="venue-room-television" type="checkbox"><span class="venue-amenity-mark venue-amenity-mark--tv">TV</span><span><b>Телевизор</b><small>Экран в зоне стола</small></span></label></div></fieldset><small class="muted">Для обычного стола депозит оставьте 0. Для VIP-комнаты укажите обязательный минимум.</small><div class="toolbar-row"><button class="button primary" id="venue-room-submit" type="submit">Добавить стол</button><button class="button" id="cancel-venue-room" type="button">Отмена</button></div><p class="form-message" id="venue-room-message"></p></form></section>'; target.append(companyPanel);
   companyPanel.querySelector('#company-timezone').innerHTML = `<option value="">Выберите часовой пояс</option>${russianTimezoneOptions()}`;
   if (['#settings', '#company', '#settings-dashboard-modules', '#venue-layout-settings', '#lock-security', '#audit'].includes(window.location.hash) && portalPermissions.has('settings')) {
     const settingsHub = document.createElement('section');
     settingsHub.className = 'settings-hub';
     settingsHub.innerHTML = `<div class="settings-hub-head"><div><p class="eyebrow">РАЗДЕЛЫ НАСТРОЕК</p><p class="muted">Разделы сгруппированы по задачам. Администратор управляет заведением и доступами, управляющий — рабочим процессом и интерфейсом смены.</p></div><span class="badge success">${portalUser.role === 'manager' ? 'Управляющий' : 'Расширенный доступ'}</span></div><nav class="settings-category-grid" aria-label="Категории настроек"><a class="settings-category-card" href="#company" data-settings-role="owner-admin"><span class="settings-category-icon">${icon('building')}</span><span><b>Заведение</b><small>Название, адрес, формат, контакты и VIP-депозиты</small></span></a><a class="settings-category-card" href="#settings-dashboard-modules"><span class="settings-category-icon">${icon('layout-dashboard')}</span><span><b>Интерфейс</b><small>Светлая схема, главная, боковое меню и показатели</small></span></a><a class="settings-category-card" href="#venue-layout-settings"><span class="settings-category-icon">${icon('package')}</span><span><b>Залы и рабочая зона</b><small>Залы, столы, VIP-комнаты и доступность объектов</small></span></a><a class="settings-category-card" href="#lock-security"><span class="settings-category-icon">${icon('settings')}</span><span><b>Безопасность</b><small>PIN блокировки экрана и автоматическая пауза</small></span></a><a class="settings-category-card" href="#audit" data-settings-role="owner-admin"><span class="settings-category-icon">${icon('clipboard-list')}</span><span><b>Журнал изменений</b><small>Кто и когда менял данные, роли и настройки</small></span></a><a class="settings-category-card" href="/network" data-settings-role="owner-admin"><span class="settings-category-icon">${icon('building')}</span><span><b>Сеть заведений</b><small>Точки сети и переключение текущего заведения</small></span></a></nav>`;
     target.querySelector('.page-title')?.after(settingsHub);
     const securityPanel = document.createElement('section');
     securityPanel.className = 'panel settings-security-panel';
     securityPanel.id = 'lock-security';
     securityPanel.innerHTML = `<div class="panel-head"><div><h2>Безопасность рабочего места</h2><span class="muted">PIN используется только после блокировки экрана. Пароль остаётся способом входа в CRM.</span></div><button class="button small" type="button" id="open-security-settings">Настроить защиту</button></div><div class="settings-security-summary"><span class="settings-security-dot">${icon('circle-check')}</span><div><b>Настройки сотрудника</b><small>Каждый пользователь задаёт личный PIN и интервал автоблокировки через это окно.</small></div></div>`;
     target.append(securityPanel);
     securityPanel.querySelector('#open-security-settings')?.addEventListener('click', () => { if (typeof window.__openLockSettings === 'function') window.__openLockSettings(); else document.querySelector('#lock-settings-button')?.click(); });
      settingsHub.querySelectorAll('[data-settings-role="owner-admin"]').forEach((node) => { if (!['owner', 'admin'].includes(portalUser.role)) node.remove(); });
   }
   companyPanel.querySelectorAll('[data-interface-toggle]').forEach((toggle) => { const permission = interfaceModulePermissions[toggle.dataset.interfaceToggle]; if (permission && !portalPermissions.has(permission)) toggle.closest('label')?.remove(); });
   setupDashboardModules();
   setupFinancePreferences();
   setupInterfacePreferences();
   setupThemePreference();
   setupVenueLayout();
  const reversalPolicySettings = document.createElement('section');
  reversalPolicySettings.className = 'panel purchase-reversal-settings';
  reversalPolicySettings.innerHTML = '<div class="panel-head"><div><h2>Сторно приходов</h2><span class="muted">Правило заведения для новых приходов. В v1 доступно только полное сторно неоплаченного документа с доказуемым неиспользованным остатком.</span></div></div><label><input id="purchase-reversal-enabled" type="checkbox"> Разрешать безопасное сторно новых приходов</label><p class="muted">Нужны права склада и финансов. Оплату поставщику вносите через связанную накладную: ручной расход не подтверждает оплату конкретного прихода. Документы без включённого правила при проведении останутся недоступны; проведённые документы сохраняют свою версию правила. Сторно также блокируется, пока в заведении есть старые закупочные платежи без привязки к накладной.</p><div class="toolbar-row"><button class="button small primary" id="purchase-reversal-policy-save" type="button" disabled>Сохранить правило</button><span class="form-message" id="purchase-reversal-policy-message" role="status" aria-live="polite"></span></div>';
  companyPanel.insertBefore(reversalPolicySettings, companyPanel.querySelector('#settings-dashboard-modules'));
  const companyForm = document.querySelector('#company-form');
  const companyMessage = document.querySelector('#company-message');
  const companyPhoneList = document.querySelector('#company-phone-list');
  const companyPhoneRows = () => [...companyPhoneList.querySelectorAll('.company-phone-row')];
  const readCompanyPhones = (includeBlank = false) => companyPhoneRows().map((row) => ({
    label: row.querySelector('select')?.value || 'Рабочий',
    number: row.querySelector('input[type=tel]')?.value.trim() || '',
    primary: Boolean(row.querySelector('input[type=radio]')?.checked),
  })).filter((entry) => includeBlank || entry.number);
  const renderCompanyPhones = (items) => {
    const phones = Array.isArray(items) && items.length ? items : [{ label: 'Основной', number: '', primary: true }];
    companyPhoneList.innerHTML = phones.map((phone, index) => `<div class="staff-phone-row company-phone-row"><select aria-label="Тип телефона"><option ${phone.label === 'Основной' ? 'selected' : ''}>Основной</option><option ${phone.label === 'Рабочий' ? 'selected' : ''}>Рабочий</option><option ${phone.label === 'Резервный' ? 'selected' : ''}>Резервный</option></select><input type="tel" inputmode="tel" value="${esc(phone.number || '')}" placeholder="+7 (___) ___-__-__" aria-label="Номер телефона"><label><input type="radio" name="company-primary-phone" ${phone.primary || (!phones.some((entry) => entry.primary) && index === 0) ? 'checked' : ''}> основной</label><button type="button" class="staff-phone-row__remove" aria-label="Удалить номер">×</button></div>`).join('');
    companyPhoneList.querySelectorAll('.staff-phone-row__remove').forEach((button) => button.addEventListener('click', () => {
      if (companyPhoneRows().length > 1) {
        const wasPrimary = button.closest('.company-phone-row').querySelector('input[type=radio]').checked;
        button.closest('.company-phone-row').remove();
        if (wasPrimary) companyPhoneList.querySelector('input[type=radio]').checked = true;
      } else {
        button.closest('.company-phone-row').querySelector('input[type=tel]').value = '';
      }
    }));
  };
  companyForm.querySelector('#company-add-phone')?.addEventListener('click', () => {
    const current = readCompanyPhones(true);
    if (current.length >= 5) return;
    current.push({ label: 'Рабочий', number: '', primary: false });
    renderCompanyPhones(current);
    document.querySelector('#company-phone-list .company-phone-row:last-child input[type=tel]')?.focus();
  });
  companyMessage.setAttribute('role', 'status');
  companyMessage.setAttribute('aria-live', 'polite');
  const companyStatus = (text, error = false) => {
    companyMessage.textContent = text;
    companyMessage.classList.toggle('error-message', error);
  };
  const setCompanyDisabled = (disabled) => {
    companyForm.querySelectorAll('input, select, textarea, button').forEach((control) => {
      control.disabled = disabled;
      control._customSelectRefresh?.();
    });
  };
  const reversalPolicyToggle = reversalPolicySettings.querySelector('#purchase-reversal-enabled');
  const reversalPolicySave = reversalPolicySettings.querySelector('#purchase-reversal-policy-save');
  const reversalPolicyMessage = reversalPolicySettings.querySelector('#purchase-reversal-policy-message');
  let reversalPolicy = null;
  let reversalPolicyLoaded = false;
  let reversalPolicySaving = false;
  const setReversalPolicyMessage = (text, error = false) => { reversalPolicyMessage.textContent = text; reversalPolicyMessage.classList.toggle('error-message', error); };
  const loadReversalPolicy = async () => {
    reversalPolicyLoaded = false;
    reversalPolicyToggle.disabled = true;
    reversalPolicySave.disabled = true;
    setReversalPolicyMessage('Загружаем правило заведения…');
    try {
      const result = await api('/api/venue/purchase-reversal-policy');
      reversalPolicy = result;
      reversalPolicyToggle.checked = Boolean(result.enabled);
      reversalPolicyLoaded = true;
      reversalPolicyToggle.disabled = false;
      reversalPolicySave.disabled = true;
      setReversalPolicyMessage(`Версия ${result.version}. Изменение применяется только к новым приходам.`);
    } catch (_) {
      reversalPolicy = null;
      setReversalPolicyMessage('Правило недоступно без подключённой PostgreSQL базы.', true);
    }
  };
  reversalPolicyToggle.addEventListener('change', () => { reversalPolicySave.disabled = !reversalPolicyLoaded || reversalPolicySaving || !reversalPolicy || reversalPolicyToggle.checked === Boolean(reversalPolicy.enabled); });
  reversalPolicySave.addEventListener('click', async () => {
    if (!reversalPolicyLoaded || !reversalPolicy || reversalPolicySaving || reversalPolicyToggle.checked === Boolean(reversalPolicy.enabled)) return;
    reversalPolicySaving = true;
    reversalPolicySave.disabled = true;
    reversalPolicyToggle.disabled = true;
    setReversalPolicyMessage('Сохраняем новую версию правила…');
    try {
      reversalPolicy = await api('/api/venue/purchase-reversal-policy', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: reversalPolicy.version, enabled: reversalPolicyToggle.checked }) });
      reversalPolicyToggle.checked = Boolean(reversalPolicy.enabled);
      setReversalPolicyMessage(`Сохранена версия ${reversalPolicy.version}. Ранее проведённые документы сохраняют своё правило.`);
    } catch (error) {
      const message = error.payload?.error === 'purchase_reversal_policy_version_conflict' ? 'Настройка уже изменена в другой вкладке. Перезагрузите правило.' : 'Не удалось сохранить правило заведения.';
      setReversalPolicyMessage(message, true);
    } finally {
      reversalPolicySaving = false;
      reversalPolicyToggle.disabled = false;
      reversalPolicySave.disabled = !reversalPolicyLoaded || !reversalPolicy || reversalPolicyToggle.checked === Boolean(reversalPolicy.enabled);
    }
  });
  let companyLoaded = false;
  let companySaving = false;
  let companyLoadedVenueId = null;
  let companyReadSequence = 0;
  const loadCompany = () => {
    const sequence = ++companyReadSequence;
    const identity = preferenceSessionIdentity();
    companyLoaded = false;
    companyLoadedVenueId = null;
    setCompanyDisabled(true);
    companyStatus('Загружаем данные заведения…');
    api('/api/venue').then((data) => {
      if (sequence !== companyReadSequence || document.querySelector('#company-form') !== companyForm || !samePreferenceSession(identity)) return;
      if (!data?.id) throw new Error('venue_identity_unavailable');
      companyLoadedVenueId = String(data.id);
      document.querySelector('#company-name').value = data.name || '';
      document.querySelector('#company-city').value = data.city || '';
      document.querySelector('#company-address').value = data.address || '';
      document.querySelector('#company-format').value = data.format || '';
      const timezoneSelect = document.querySelector('#company-timezone');
      timezoneSelect.value = data.timezone || '';
      timezoneSelect._customSelectRefresh?.();
      renderCompanyPhones(Array.isArray(data.phoneNumbers) && data.phoneNumbers.length ? data.phoneNumbers : (data.phone ? [{ label: 'Основной', number: data.phone, primary: true }] : []));
      const vip = data.vipRoomMinimums || {};
      document.querySelector('#vip-minimum-1').value = vip.vip_room_1 ?? 1500;
      document.querySelector('#vip-minimum-2').value = vip.vip_room_2 ?? 2500;
      companyLoaded = true;
      setCompanyDisabled(false);
      companyStatus('');
    }).catch(() => {
      if (sequence !== companyReadSequence || document.querySelector('#company-form') !== companyForm || !samePreferenceSession(identity)) return;
      setCompanyDisabled(true);
      companyStatus('Не удалось загрузить данные заведения. ', true);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'button small';
      retry.textContent = 'Повторить загрузку';
      retry.addEventListener('click', loadCompany, { once: true });
      companyMessage.append(retry);
    });
  };
  loadReversalPolicy();
  loadCompany();
  companyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!companyLoaded || companySaving || !companyLoadedVenueId) return;
    const identity = preferenceSessionIdentity();
    const expectedVenueId = companyLoadedVenueId;
    const file = document.querySelector('#company-logo').files[0];
    const name = document.querySelector('#company-name').value.trim();
    const city = document.querySelector('#company-city').value.trim();
    const address = document.querySelector('#company-address').value.trim();
    const format = document.querySelector('#company-format').value.trim();
    const timezone = document.querySelector('#company-timezone').value.trim();
    const vip1 = Number(document.querySelector('#vip-minimum-1').value);
    const vip2 = Number(document.querySelector('#vip-minimum-2').value);
    const phoneNumbers = readCompanyPhones();
    if (!name || !city || !address || !timezone) { companyStatus('Укажите название, город, адрес и часовой пояс заведения', true); return; }
    if (!Number.isFinite(vip1) || !Number.isFinite(vip2) || vip1 < 0 || vip2 < 0) { companyStatus('Депозиты VIP должны быть неотрицательными числами', true); return; }
    if (companyPhoneRows().length > 5 || phoneNumbers.some((entry) => !/^\+7[0-9 ()-]{7,24}$/.test(entry.number)) || (phoneNumbers.length && phoneNumbers.filter((entry) => entry.primary).length !== 1)) { companyStatus('Проверьте телефоны: до пяти номеров, один основной', true); return; }
    if (file && (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 1_500_000)) { companyStatus('Логотип: PNG, JPG или WebP до 1.5 МБ', true); return; }
    const primaryPhone = phoneNumbers.find((entry) => entry.primary)?.number || '';
    companySaving = true;
    companyForm.dataset.submitting = '1';
    setCompanyDisabled(true);
    companyStatus('Сохраняем данные заведения…');
    const image = file ? compressUploadedImage(file, 320) : Promise.resolve(undefined);
    image.then((logoUrl) => { if (!samePreferenceSession(identity)) throw new Error('session_changed'); return api('/api/venue', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVenueId, name, city, address, format, timezone, phone: primaryPhone, phoneNumbers, logoUrl, vipRoomMinimums: { vip_room_1: vip1, vip_room_2: vip2 } }) }); })
      .then(async (data) => {
        if (document.querySelector('#company-form') !== companyForm || !samePreferenceSession(identity)) return;
        if (String(data?.id || '') !== expectedVenueId) throw new Error('venue_context_changed');
        const active = await api('/api/venue').catch(() => { throw new Error('venue_refresh_failed'); });
        if (document.querySelector('#company-form') !== companyForm || !samePreferenceSession(identity)) return;
        if (String(active?.id || '') !== expectedVenueId) throw new Error('venue_context_changed');
        document.querySelectorAll('[data-venue-name]').forEach((node) => { node.textContent = active.name || name; });
        document.querySelectorAll('[data-venue-address]').forEach((node) => { node.textContent = active.address || address; });
        document.querySelector('#company-logo').value = '';
        companyStatus('Данные компании сохранены');
      }).catch((error) => {
        if (document.querySelector('#company-form') !== companyForm || !samePreferenceSession(identity)) return;
        const reason = String(error.payload?.error || error.message || '');
        if (reason === 'venue_context_changed' || reason === 'venue_refresh_failed') {
          companyLoaded = false;
          companyLoadedVenueId = null;
          setCompanyDisabled(true);
          companyStatus(reason === 'venue_context_changed' ? 'Точка изменилась. Данные не сохранены для новой точки. ' : 'Данные сохранены, но карточку не удалось обновить. ', true);
          const retry = document.createElement('button');
          retry.type = 'button'; retry.className = 'button small'; retry.textContent = 'Загрузить актуальную карточку';
          retry.addEventListener('click', loadCompany, { once: true });
          companyMessage.append(retry);
          return;
        }
        companyStatus(reason === 'invalid_phone' || reason === 'invalid_phone_numbers' || reason === 'one_primary_phone_required' ? 'Проверьте телефоны: до пяти номеров, один основной' : reason === 'invalid_vip_minimum' ? 'Депозит VIP должен быть неотрицательным числом' : reason.startsWith('venue_') ? 'Проверьте название, город и адрес' : 'Не удалось сохранить', true);
      }).finally(() => {
        if (document.querySelector('#company-form') !== companyForm) return;
        companySaving = false;
        companyForm.dataset.submitting = '0';
        if (!samePreferenceSession(identity)) { companyLoaded = false; companyLoadedVenueId = null; setCompanyDisabled(true); companyStatus('Сессия изменилась. Обновите страницу.', true); }
        else if (companyLoaded) setCompanyDisabled(false);
      });
  });
  let auditItems = []; const auditActionLabels = { 'finance.report_generated': 'Сформирован финансовый отчёт', 'staff.created': 'Создан сотрудник', 'staff.profile_updated': 'Изменены данные или права сотрудника', 'staff.login_updated': 'Изменён логин сотрудника', 'staff.pin_updated': 'Изменён PIN сотрудника', 'shift.opened': 'Открыта смена', 'shift.closed': 'Закрыта смена', 'order.created': 'Создан заказ', 'order.item_added': 'Добавлена позиция в заказ', 'order.payment_added': 'Добавлена оплата', 'order.closed': 'Закрыт заказ', 'inventory.item_created': 'Создана складская позиция', 'inventory.supply_received': 'Принята поставка', 'inventory.movement': 'Изменён остаток', 'inventory.auto_order_sent': 'Сформирована заявка на пополнение', 'inventory.auto_order_received': 'Поставка по заявке принята', 'inventory.auto_order_partially_received': 'Частичная поставка по заявке принята', 'inventory.auto_order_cancelled': 'Заявка на пополнение отменена', 'recipe.created': 'Создана технологическая карта', 'recipe.updated': 'Изменена технологическая карта', 'venue.updated': 'Изменены данные заведения', 'product.created': 'Создан товар', 'product.updated': 'Изменён товар', 'product.deactivated': 'Архивирован товар', 'recipe.archived': 'Архивирована технологическая карта', 'floor_zone.created': 'Создан зал или этаж', 'floor_table.created': 'Создан стол', 'floor_table.updated': 'Изменён стол', 'inventory.item_archived': 'Архивирована складская позиция' }; const auditActionName = (value) => auditActionLabels[value] || value || 'Событие'; const auditLabels = { order: 'Заказ', order_item: 'Позиция заказа', payment: 'Оплата', staff: 'Сотрудник', inventory: 'Склад', reservation: 'Бронирование', discount: 'Скидка', venue: 'Компания', shift: 'Смена', finance_report: 'Финансовый отчёт', finance_category: 'Категория финансов', product: 'Товар', recipe: 'Технологическая карта', table: 'Стол', zone: 'Зал или этаж' }; const auditText = (event) => [event.action, event.entityType, event.entityId, event.actor, JSON.stringify(event.beforeData || {}), JSON.stringify(event.afterData || {})].filter(Boolean).join(' ').toLocaleLowerCase('ru-RU'); const renderAudit = () => { const list = document.querySelector('#audit-list'); if (!list) return; const query = String(document.querySelector('#audit-search')?.value || '').trim().toLocaleLowerCase('ru-RU'); const action = document.querySelector('#audit-action')?.value || ''; const entity = document.querySelector('#audit-entity')?.value || ''; const from = document.querySelector('#audit-from')?.value || ''; const to = document.querySelector('#audit-to')?.value || ''; const filtered = auditItems.filter((event) => (!query || auditText(event).includes(query)) && (!action || event.action === action) && (!entity || event.entityType === entity) && (!from || localDateKey(event.createdAt) >= from) && (!to || localDateKey(event.createdAt) <= to)); const actionSelect = document.querySelector('#audit-action'); if (actionSelect && actionSelect.options.length === 1) [...new Set(auditItems.map((event) => event.action).filter(Boolean))].sort().forEach((value) => { const option = document.createElement('option'); option.value = value; option.textContent = auditActionName(value); actionSelect.append(option); }); const count = document.querySelector('#audit-count'); if (count) count.textContent = `${filtered.length} событий`; list.innerHTML = filtered.length ? filtered.slice(0, 30).map((event, index) => `<button class="audit-row audit-row-button" type="button" data-audit-index="${index}"><span class="audit-icon">${icon('circle-check')}</span><div><b>${esc(auditActionName(event.action))}</b><small>${esc(auditLabels[event.entityType] || event.entityType || 'Система')} · ${esc(event.actor || event.actorId || 'система')} · ${formatRuDate(event.createdAt, true)}</small></div><span class="audit-chevron">${icon('chevron-right')}</span></button>`).join('') : '<div class="empty">По выбранным условиям событий нет</div>'; list.querySelectorAll('[data-audit-index]').forEach((node) => node.addEventListener('click', () => { const event = filtered[Number(node.dataset.auditIndex)]; const detail = document.querySelector('#audit-detail'); if (!event || !detail) return; document.querySelector('#audit-detail-meta').textContent = `${auditActionName(event.action)} · ${event.entityType || 'система'} · ${formatRuDate(event.createdAt, true)}`; const fields = event.changedFields || (event.beforeData && event.afterData ? Object.keys({ ...event.beforeData, ...event.afterData }).filter((key) => JSON.stringify(event.beforeData?.[key]) !== JSON.stringify(event.afterData?.[key])) : []); document.querySelector('#audit-fields').textContent = fields?.length ? fields.join(', ') : 'Не указаны'; document.querySelector('#audit-before').textContent = event.beforeData ? JSON.stringify(event.beforeData, null, 2) : 'Нет данных'; document.querySelector('#audit-after').textContent = event.afterData ? JSON.stringify(event.afterData, null, 2) : 'Нет данных'; detail.showModal(); })); }; const loadAudit = () => api('/api/audit?limit=300').then((data) => { auditItems = data.items || []; renderAudit(); }).catch(() => { auditItems = []; renderAudit(); portalNotice('Не удалось загрузить журнал аудита', 'error'); }); if (canViewAudit) loadAudit(); ['audit-search','audit-action','audit-entity','audit-from','audit-to'].forEach((id) => document.querySelector(`#${id}`)?.addEventListener('input', renderAudit)); document.querySelector('#audit-reset')?.addEventListener('click', () => { ['audit-search','audit-action','audit-entity','audit-from','audit-to'].forEach((id) => { const el = document.querySelector(`#${id}`); if (el) el.value = ''; }); renderAudit(); }); document.querySelector('#audit-detail-close')?.addEventListener('click', () => document.querySelector('#audit-detail')?.close()); document.querySelector('#audit-detail')?.addEventListener('click', (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }); document.querySelector('#audit-export')?.addEventListener('click', () => { const rows = [['Дата','Действие','Объект','ID объекта','Исполнитель'], ...auditItems.map((event) => [formatRuDate(event.createdAt, true), auditActionName(event.action), event.entityType || '', event.entityId || '', event.actor || event.actorId || 'система'])]; const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('\"','\"\"')}"`).join(';')).join('\n'); const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `audit-${localDateKey()}.csv`; link.click(); URL.revokeObjectURL(link.href); });
  const financeCard = document.querySelector('[data-dashboard-revenue]');
  if (financeCard) {
  const financeIdentity = preferenceSessionIdentity();
  let financeRequest = 0;
  let financeError = false;
  const currentFinanceCard = () => document.querySelector('[data-dashboard-revenue]') === financeCard && samePreferenceSession(financeIdentity);
  const loadFinanceHeadline = () => {
    const request = ++financeRequest;
    financeError = false;
    financeCard.querySelector('#dash-revenue').textContent = '—';
    financeCard.querySelector('#dash-pending-revenue').textContent = '—';
    financeCard.querySelector('#dash-pending-detail').textContent = 'Загружаем финансы…';
    financeCard.querySelector('[data-pending-summary]').classList.remove('has-pending');
    api('/api/finance/summary').then((summary) => {
      if (!currentFinanceCard() || request !== financeRequest) return;
      const revenue = Number(summary?.revenue);
      if (summary?.revenue == null || !Number.isFinite(revenue)) throw new Error('invalid_finance_summary');
      financeCard.querySelector('#dash-revenue').textContent = money(revenue);
      financeCard.querySelector('.dashboard-revenue-main > span').textContent = summary.employeeView ? 'Ваши оплаты сегодня' : 'Выручка сегодня';
      financeCard.querySelector('.dashboard-revenue-main > small').textContent = summary.employeeView ? 'Платежи по вашим заказам сегодня' : 'Оплаты по закрытым сегодня заказам';
      const hasPending = Number.isFinite(Number(summary?.pendingRevenue)) && Number.isFinite(Number(summary?.pendingOrders)) && summary?.pendingRevenue != null && summary?.pendingOrders != null;
      const pendingAmount = hasPending ? Number(summary.pendingRevenue) : 0;
      const pendingCount = hasPending ? Number(summary.pendingOrders) : 0;
      financeCard.querySelector('#dash-pending-revenue').textContent = hasPending ? money(pendingAmount) : '—';
      financeCard.querySelector('[data-pending-summary]').classList.toggle('has-pending', hasPending && pendingAmount > 0);
      financeCard.querySelector('#dash-pending-detail').textContent = hasPending ? (pendingCount ? `${pendingCount} ${pluralRu(pendingCount, 'открытый заказ', 'открытых заказа', 'открытых заказов')}` : 'Нет открытых заказов') : 'Доступно руководителю';
      financeCard.dataset.kpiRoute = '/finance';
      financeCard.setAttribute('aria-label', 'Открыть финансы');
    }).catch(() => {
      if (!currentFinanceCard() || request !== financeRequest) return;
      financeError = true;
      financeCard.querySelector('#dash-revenue').textContent = '—';
      financeCard.querySelector('#dash-pending-revenue').textContent = '—';
      financeCard.querySelector('#dash-pending-detail').textContent = 'Данные недоступны · нажмите для повтора';
      financeCard.dataset.kpiRoute = '';
      financeCard.setAttribute('aria-label', 'Повторить загрузку финансов');
    });
  };
  financeCard.addEventListener('click', () => { if (financeError) loadFinanceHeadline(); });
  financeCard.addEventListener('keydown', (event) => { if (financeError && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); loadFinanceHeadline(); } });
  loadFinanceHeadline();
  }
  setupDashboardInsights();
  setupDashboardShiftKpis();
  if (!['owner', 'admin'].includes(portalUser.role)) { document.querySelector('#company-form')?.setAttribute('hidden', ''); document.querySelector('#company-panel-title')?.replaceChildren(document.createTextNode('Рабочие настройки')); document.querySelector('#company-panel-description')?.replaceChildren(document.createTextNode('Управляющий настраивает рабочий интерфейс, показатели и схему зала. Данные заведения и сеть доступны администратору.')); }
  if (!['owner', 'admin', 'developer'].includes(portalUser.role)) { document.querySelector('#staff-form')?.remove(); document.querySelectorAll('.staff-delete').forEach((node) => node.remove()); }
  const getSettingsHashTarget = (hash = window.location.hash) => {
    const targets = {
      '#shift-control': '#shift-control',
      '#company': '#company-form',
      '#settings-dashboard-modules': '#settings-dashboard-modules',
      '#venue-layout-settings': '#venue-layout-settings',
      '#lock-security': '#lock-security',
      '#audit': '#audit',
    };
    return targets[hash] ? target.querySelector(targets[hash]) : target.querySelector('.page-title');
  };
  const settingsHash = ['#settings', '#company', '#settings-dashboard-modules', '#venue-layout-settings', '#lock-security', '#audit'].includes(window.location.hash);
  const requestedDashboardFocus = settingsHash ? 'settings' : window.location.hash.slice(1);
  const dashboardFocus = requestedDashboardFocus === 'permissions' && !portalPermissions.has('staff_manage') ? 'staff' : requestedDashboardFocus;
  if (requestedDashboardFocus === 'permissions' && dashboardFocus !== requestedDashboardFocus) window.history.replaceState({}, '', '/admin#staff');
  const setDashboardPanelVisibility = (selector, visible) => target.querySelectorAll(selector).forEach((node) => { node.hidden = !visible; });
  setDashboardPanelVisibility('#help', dashboardFocus === 'help');
  setDashboardPanelVisibility('.dashboard-page-actions', !dashboardFocus);
  if (!dashboardFocus) {
    setDashboardPanelVisibility('#staff, .floor-editor-panel, #audit, #company, #help', false);
  } else if (dashboardFocus === 'staff' || dashboardFocus === 'permissions') {
    const staffTitle = target.querySelector('.page-title h1'); const staffEyebrow = target.querySelector('.page-title .eyebrow'); const staffSubtitle = target.querySelector('.page-title .muted');
    if (staffTitle) staffTitle.textContent = dashboardFocus === 'permissions' ? 'Роли и права доступа' : 'Персонал'; if (staffEyebrow) staffEyebrow.textContent = 'КОМАНДА'; if (staffSubtitle) staffSubtitle.textContent = dashboardFocus === 'permissions' ? 'Создавайте профили, проверяйте доступы и назначайте их команде.' : 'Кадровый каталог сотрудников: контакты, статусы и рабочие карточки.';
    setDashboardPanelVisibility('#staff', true);
    const staffPanel = target.querySelector('#staff'); staffPanel?.classList.toggle('staff-directory-only', dashboardFocus === 'staff'); staffPanel?.classList.toggle('staff-permissions-mode', dashboardFocus === 'permissions');
    const staffPanelTitle = staffPanel?.querySelector('.panel-head h2');
    const staffPanelDescription = staffPanel?.querySelector('.panel-head .muted');
    const staffForm = staffPanel?.querySelector('#staff-form');
    const staffAddButton = staffPanel?.querySelector('.panel-head button');
    if (dashboardFocus === 'permissions') {
      if (staffPanelTitle) staffPanelTitle.textContent = 'Профили доступа';
      if (staffPanelDescription) staffPanelDescription.textContent = 'Управляйте ролями и правами без повторения кадрового каталога.';
      staffForm?.setAttribute('hidden', ''); staffAddButton?.setAttribute('hidden', ''); staffPanel.querySelector('.staff-layout')?.setAttribute('hidden', ''); staffPanel.querySelector('.staff-list-tools')?.setAttribute('hidden', ''); staffPanel.querySelector('[data-metric="staffActive"]')?.setAttribute('hidden', '');
      if (portalUser.role !== 'owner') staffAddButton?.setAttribute('hidden', '');
      if (portalUser.role === 'owner') staffForm?.querySelector('b')?.replaceChildren(document.createTextNode('Создать сотрудника и назначить доступ'));
      setDashboardPanelVisibility('#diagnostics', false);
      if (staffPanel && !staffPanel.querySelector('[data-permissions-intro]')) {
        const intro = document.createElement('div');
        intro.dataset.permissionsIntro = 'true';
        intro.className = 'panel permissions-intro';
        intro.innerHTML = '<b>Как настроить доступ</b><span class="muted">Откройте карточку сотрудника и измените роль или доступы по направлениям. Владелец может назначать любые роли, администратор — управлять рабочими доступами без смены своей роли.</span>';
        staffPanel.querySelector('.staff-layout')?.before(intro);
      }
      if (portalUser.role === 'owner' && staffPanel && !staffPanel.querySelector('[data-custom-roles]')) {
        const roles = document.createElement('section');
        roles.dataset.customRoles = 'true'; roles.className = 'panel custom-roles-panel';
        roles.innerHTML = '<div class="custom-roles-columns"><section class="custom-roles-main"><div class="panel-head"><div><h3>Пользовательские роли</h3><span class="muted">Профили доступа под задачи команды.</span></div><button type="button" class="button small" data-custom-role-create>Создать роль</button></div><div data-custom-role-list class="custom-role-list"><span class="muted">Загрузка ролей…</span></div></section><section class="system-roles-section"><div class="panel-head"><div><h3>Профиль доступа</h3><span class="muted">Выберите роль, чтобы проверить её разделы.</span></div></div><div data-role-profile class="role-profile-empty">Выберите роль слева, чтобы увидеть её описание и доступы.</div><div class="panel-head system-roles-head"><div><h3>Системные роли</h3><span class="muted">Владелец может настроить направления доступа для каждой роли.</span></div></div><div data-system-role-list class="system-role-list"><span class="muted">Загрузка системных ролей…</span></div></section></div>';
        staffPanel.querySelector('.staff-layout')?.after(roles);
        const scopeLabels = {orders:'Заказы и зал',reservations:'Бронирования',inventory:'Склад и меню',inventory_categories:'Цеха и категории',finance:'Финансы',finance_read:'Финансы · просмотр',staff:'Персонал и задачи',settings:'Настройки заведения',integrations:'Интеграции',delivery:'Доставка',loyalty:'Лояльность'};
        const render = (items=[]) => { const list=roles.querySelector('[data-custom-role-list]'); list.innerHTML=items.length?items.map(r=>{const count=Number(r.assignedCount||0);const scopes=(r.permissionScopes||[]).map(x=>scopeLabels[x]||x);return `<article class="custom-role-row"><div class="custom-role-info"><div class="custom-role-title"><b>${esc(r.name)}</b><span class="role-member-count">${count} ${count===1?'сотрудник':count>1&&count<5?'сотрудника':'сотрудников'}</span></div><p class="custom-role-description">${esc(r.description||'Описание роли не добавлено')}</p><div class="custom-role-assignees" aria-label="Доступные разделы">${scopes.length?scopes.map(label=>'<span>'+esc(label)+'</span>').join(''):'<small>Разделы не выбраны</small>'}</div></div><div class="custom-role-actions"><button type="button" class="button small secondary" data-custom-role-select="${r.id}">Доступы</button><button type="button" class="button small secondary" data-custom-role-assign="${r.id}">Назначить</button><button type="button" class="button small secondary" data-custom-role-edit="${r.id}">Изменить</button><button type="button" class="button small danger" data-custom-role-archive="${r.id}" ${count?'disabled title="Сначала переназначьте сотрудников"':''}>Архивировать</button></div></article>`;}).join(''):'<div class="roles-empty-state"><b>Пользовательских ролей пока нет</b><span>Создайте профиль с нужными разделами и назначьте его сотрудникам.</span></div>'; };
        const systemRoleLabels = { admin:'Администратор', manager:'Управляющий', developer:'Разработчик', senior_bartender:'Старший бармен', senior_hookah_master:'Старший кальянщик', bartender:'Бармен', hookah_master:'Кальянщик', cleaner:'Уборщик', security:'Охрана', technician:'Техник', other_staff:'Сотрудник' };
        const renderSystemRoles = (items=[]) => { const list=roles.querySelector('[data-system-role-list]'); if (!list) return; list.innerHTML = '<div class="system-role-item system-role-owner"><b>Владелец</b><small>Полный доступ ко всем разделам</small><span aria-label="Полный доступ">🔒</span></div>' + items.map(item => `<div class="system-role-item"><div><b>${esc(systemRoleLabels[item.role]||item.role)}</b><small>${item.overridden?'Настройки роли изменены владельцем':'Используются системные настройки по умолчанию'}</small></div><button type="button" class="button small secondary" data-system-role-edit="${esc(item.role)}">Изменить доступы</button></div>`).join(''); window.__systemStaffRoles=items; };
        const load = async () => { try { const [result,staffResult,systemResult]=await Promise.all([api('/api/staff/roles'),api('/api/staff'),api('/api/staff/system-roles')]); window.__staffForRoles=staffResult.items||[]; render(result.items||[]); window.__customStaffRoles=result.items||[]; renderSystemRoles(systemResult.items||[]); } catch (error) { const list=roles.querySelector('[data-custom-role-list]'); list.innerHTML='<span class="muted">Роли доступны после подключения рабочей базы данных.</span>'; const systemList=roles.querySelector('[data-system-role-list]'); if (systemList) systemList.innerHTML='<span class="muted">Системные роли доступны после подключения рабочей базы данных.</span>'; } };
        const edit = async (role) => {
          const scopeLabels = {orders:'Заказы и зал',reservations:'Бронирования',inventory:'Склад и меню',inventory_categories:'Цеха и категории',finance:'Финансы',finance_read:'Финансы · просмотр',staff:'Персонал и задачи',settings:'Настройки',integrations:'Интеграции',delivery:'Доставка',loyalty:'Лояльность'};
          const modal=document.createElement('div'); modal.className='modal open custom-role-editor'; modal.innerHTML='<form class="custom-role-editor-box"><div class="modal-head"><div><h2>'+(role?'Изменить роль':'Создать роль')+'</h2><small>Профиль доступа для сотрудников</small></div><button type="button" class="staff-admin-close" aria-label="Закрыть">×</button></div><label>Название роли<input name="name" maxlength="80" required value="'+esc(role?.name||'')+'"></label><label>Описание<textarea name="description" maxlength="300" rows="2">'+esc(role?.description||'')+'</textarea></label><fieldset><legend>Разделы и права</legend><div class="staff-permission-grid">'+Object.entries(scopeLabels).map(([key,label])=>'<label class="staff-permission-option"><input type="checkbox" name="scope" value="'+key+'" '+((role?.permissionScopes||[]).includes(key)?'checked':'')+'><span>'+label+'</span></label>').join('')+'</div></fieldset><div class="custom-role-preview"><b>Сотрудник с этой ролью сможет</b><p>Выберите направления, чтобы настроить доступ к функциям заведения.</p></div><p class="form-message custom-role-editor-message" role="alert"></p><div class="staff-admin-actions"><button type="button" class="secondary" data-role-cancel>Отмена</button><button type="submit" class="button primary">Сохранить роль</button></div></form>';
          document.body.append(modal); const form=modal.querySelector('form'); const close=()=>modal.remove(); modal.querySelector('.staff-admin-close').onclick=close; modal.querySelector('[data-role-cancel]').onclick=close; form.onsubmit=async event=>{event.preventDefault();const permissionScopes=[...form.querySelectorAll('[name=scope]:checked')].map(n=>n.value);try{await api(role?`/api/staff/roles/${encodeURIComponent(role.id)}`:'/api/staff/roles',{method:role?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:form.elements.name.value.trim(),description:form.elements.description.value.trim(),permissionScopes})});close();await load();window.portalNotice?.('Роль сохранена','success');}catch(error){form.querySelector('.custom-role-editor-message').textContent='Не удалось сохранить роль. Проверьте данные и повторите.';}};
          form.elements.name.focus();
        };
        const editSystemRole = async (role) => { const scopeLabels = {orders:'Заказы и зал',reservations:'Бронирования',inventory:'Склад и меню',inventory_categories:'Цеха и категории',finance:'Финансы',finance_read:'Финансы · просмотр',staff:'Персонал и задачи',settings:'Настройки',integrations:'Интеграции',delivery:'Доставка',loyalty:'Лояльность'}; const modal=document.createElement('div'); modal.className='modal open custom-role-editor'; modal.innerHTML='<form class="custom-role-editor-box"><div class="modal-head"><div><h2>Настройка системной роли</h2><small>Владелец изменяет доступы для всех сотрудников с этой ролью</small></div><button type="button" class="staff-admin-close" aria-label="Закрыть">×</button></div><div class="system-role-edit-name">'+esc(systemRoleLabels[role.role]||role.role)+'</div><fieldset><legend>Разделы и права</legend><div class="staff-permission-grid">'+Object.entries(scopeLabels).map(([key,label])=>'<label class="staff-permission-option"><input type="checkbox" name="scope" value="'+key+'" '+((role.permissionScopes||[]).includes(key)?'checked':'')+'><span>'+label+'</span></label>').join('')+'</div></fieldset><p class="form-message custom-role-editor-message" role="alert"></p><div class="staff-admin-actions"><button type="button" class="secondary" data-role-cancel>Отмена</button><button type="submit" class="button primary">Сохранить доступы</button></div></form>'; document.body.append(modal); const form=modal.querySelector('form'); const close=()=>modal.remove(); modal.querySelector('.staff-admin-close').onclick=close; modal.querySelector('[data-role-cancel]').onclick=close; form.onsubmit=async event=>{event.preventDefault();const permissionScopes=[...form.querySelectorAll('[name=scope]:checked')].map(n=>n.value);try{await api(`/api/staff/system-roles/${encodeURIComponent(role.role)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({permissionScopes})});close();await load();window.portalNotice?.('Доступы системной роли сохранены','success');}catch(error){form.querySelector('.custom-role-editor-message').textContent='Не удалось сохранить доступы роли. Проверьте подключение базы данных.';}}; form.querySelector('input')?.focus(); };
        roles.querySelector('[data-custom-role-create]').onclick=()=>edit(null);
        roles.addEventListener('click', async event => { const systemRoleId=event.target.closest('[data-system-role-edit]')?.dataset.systemRoleEdit; if(systemRoleId){ const systemRole=(window.__systemStaffRoles||[]).find(item=>item.role===systemRoleId); if(systemRole) editSystemRole(systemRole); return; } const selectId=event.target.closest('[data-custom-role-select]')?.dataset.customRoleSelect; if(selectId){const role=(window.__customStaffRoles||[]).find(r=>String(r.id)===String(selectId)); const profile=roles.querySelector('[data-role-profile]'); if(profile&&role){const scopes=(role.permissionScopes||[]).map(x=>scopeLabels[x]||x);const count=Number(role.assignedCount||0);profile.classList.remove('role-profile-empty');profile.innerHTML='<div class="role-profile-heading"><b>'+esc(role.name)+'</b><span>'+count+' назначено</span></div><p>'+esc(role.description||'Описание роли не добавлено')+'</p><h4>Доступные разделы</h4><div class="role-profile-scopes">'+(scopes.map(x=>'<span>'+esc(x)+'</span>').join('')||'<small>Разделы не выбраны</small>')+'</div>';}} const assignId=event.target.closest('[data-custom-role-assign]')?.dataset.customRoleAssign; if(assignId){ const candidates=(window.__staffForRoles||[]).filter(p=>p.role!=='owner'&&p.active); const options=candidates.map(p=>`<option value="${p.id}">${esc(p.name)} · ${esc(p.role||'')}</option>`).join(''); const modal=document.createElement('div'); modal.className='modal open custom-role-editor'; modal.innerHTML='<form class="custom-role-editor-box"><div class="modal-head"><div><h2>Назначить сотрудника</h2><small>Выберите сотрудника для этого профиля доступа</small></div><button type="button" class="staff-admin-close">×</button></div><label>Сотрудник<select name="staffId">'+options+'</select></label><p class="form-message custom-role-editor-message"></p><div class="staff-admin-actions"><button type="button" class="secondary" data-role-cancel>Отмена</button><button type="submit" class="button primary">Назначить</button></div></form>'; document.body.append(modal); const form=modal.querySelector('form'); const close=()=>modal.remove(); modal.querySelector('.staff-admin-close').onclick=close; modal.querySelector('[data-role-cancel]').onclick=close; form.onsubmit=async e=>{e.preventDefault();try{await api(`/api/staff/${encodeURIComponent(form.elements.staffId.value)}/profile`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({customRoleId:assignId})});close();await load();window.portalNotice?.('Роль доступа назначена','success');}catch(_){form.querySelector('.custom-role-editor-message').textContent='Не удалось назначить профиль доступа';}}; return;} const editId=event.target.closest('[data-custom-role-edit]')?.dataset.customRoleEdit; const archiveId=event.target.closest('[data-custom-role-archive]')?.dataset.customRoleArchive; if(editId) edit((window.__customStaffRoles||[]).find(r=>r.id===editId)); if(archiveId && window.confirm('Архивировать роль?')) { try { await api(`/api/staff/roles/${encodeURIComponent(archiveId)}/archive`,{method:'POST'}); await load(); } catch(error) { window.portalNotice?.('Роль используется сотрудниками или недоступна','error'); } } });
        load();
      }
    } else {
      staffForm?.removeAttribute('hidden');
      staffPanel?.querySelector('.staff-layout')?.removeAttribute('hidden');
      staffPanel?.querySelector('.staff-list-tools')?.removeAttribute('hidden'); staffPanel?.querySelector('[data-metric="staffActive"]')?.removeAttribute('hidden');
      staffAddButton?.removeAttribute('hidden');
      const heading = target.querySelector('.page-title');
      heading?.classList.add('staff-catalog-heading');
      if (staffAddButton && heading) heading.append(staffAddButton);
      const search = staffPanel?.querySelector('#staff-search');
      if (search) search.placeholder = 'Поиск по имени, должности или телефону…';
      staffForm?.querySelector('b')?.replaceChildren(document.createTextNode('Добавить сотрудника'));
      staffPanel?.querySelector('[data-permissions-intro]')?.remove();
      setDashboardPanelVisibility('#diagnostics', false);
    }
    setDashboardPanelVisibility('[data-dashboard-module="kpi"], #dashboard-insights, #shift-control, [data-dashboard-module="quick"], .floor-editor-panel, #audit, #company', false);
  } else if (dashboardFocus === 'shift-control') {
    const shiftTitle = target.querySelector('.page-title h1'); const shiftEyebrow = target.querySelector('.page-title .eyebrow'); const shiftSubtitle = target.querySelector('.page-title .muted');
    if (shiftTitle) shiftTitle.textContent = 'Контроль смены'; if (shiftEyebrow) shiftEyebrow.textContent = 'ОПЕРАЦИИ СМЕНЫ'; if (shiftSubtitle) shiftSubtitle.textContent = 'Откройте смену, проверьте кассу или завершите работу.';
    setDashboardPanelVisibility('#shift-control', true);
    setDashboardPanelVisibility('[data-dashboard-module="kpi"], #dashboard-insights, [data-dashboard-module="quick"], #staff, .floor-editor-panel, #audit, #company, #help', false);
  } else if (dashboardFocus === 'company') {
    setDashboardPanelVisibility('.floor-editor-panel, #company', true);
    setDashboardPanelVisibility('[data-dashboard-module="kpi"], #dashboard-insights, #shift-control, [data-dashboard-module="quick"], #staff, #audit, #help', false);
  } else if (dashboardFocus === 'help') {
    setDashboardPanelVisibility('#help', true);
    setDashboardPanelVisibility('[data-dashboard-module="kpi"], #dashboard-insights, #shift-control, [data-dashboard-module="quick"], #staff, .floor-editor-panel, #audit, #company', false);
  } else if (dashboardFocus === 'notifications') {
    setDashboardPanelVisibility('[data-dashboard-module="kpi"], #dashboard-insights, #shift-control, [data-dashboard-module="quick"], #staff, .floor-editor-panel, #audit, #company, #help', false);
    window.setTimeout(() => document.querySelector('#notification-bell')?.click(), 0);
  } else if (dashboardFocus === 'settings') {
    const settingsPageTitle = target.querySelector('.page-title');
    if (settingsPageTitle) {
      settingsPageTitle.querySelector('.eyebrow')?.replaceChildren(document.createTextNode('ЦЕНТР НАСТРОЕК'));
      settingsPageTitle.querySelector('h1')?.replaceChildren(document.createTextNode('Настройки CRM'));
      settingsPageTitle.querySelector('.muted')?.replaceChildren(document.createTextNode('Управление заведением, интерфейсом, безопасностью и журналом изменений.'));
    }
    const applySettingsView = (hash = window.location.hash, shouldScroll = true) => {
      const settingsView = hash || '#settings';
      const focusedView = ['#company', '#settings-dashboard-modules', '#venue-layout-settings', '#lock-security', '#audit'].includes(settingsView) ? settingsView : '#settings';
      const focusedCompanyChild = focusedView === '#company' ? '#company-form' : focusedView === '#settings-dashboard-modules' ? '#settings-dashboard-modules' : focusedView === '#venue-layout-settings' ? '#venue-layout-settings' : '';
      const auditFocus = focusedView === '#audit';
      setDashboardPanelVisibility('#company, .floor-editor-panel, #lock-security', false);
      setDashboardPanelVisibility('[data-dashboard-module="kpi"], #dashboard-insights, #shift-control, [data-dashboard-module="quick"], #staff', false);
      setDashboardPanelVisibility('#audit', auditFocus && ['owner', 'admin'].includes(portalUser.role));
      setDashboardPanelVisibility('#company-form, #settings-dashboard-modules, #venue-layout-settings', false);
      if (focusedView === '#company') {
        setDashboardPanelVisibility('#company', true);
        setDashboardPanelVisibility('#company-form', true);
      } else if (focusedView === '#settings-dashboard-modules') {
        setDashboardPanelVisibility('#company', true);
        setDashboardPanelVisibility('#settings-dashboard-modules', true);
      } else if (focusedView === '#venue-layout-settings') {
        setDashboardPanelVisibility('#company, .floor-editor-panel', true);
        setDashboardPanelVisibility('#venue-layout-settings', true);
      } else if (focusedView === '#lock-security') {
        setDashboardPanelVisibility('#lock-security', true);
      }
      if (shouldScroll) {
        const scrollTarget = getSettingsHashTarget(settingsView);
        scrollTarget?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    applySettingsView();
    target._applySettingsView = applySettingsView;
  } else if (dashboardFocus === 'audit' || dashboardFocus === 'diagnostics') {
    setDashboardPanelVisibility(dashboardFocus === 'audit' ? '#audit' : '#diagnostics', true);
    setDashboardPanelVisibility('[data-dashboard-module="kpi"], #dashboard-insights, #shift-control, [data-dashboard-module="quick"], #staff, .floor-editor-panel, #company', false);
  }
  const dashboardHashChangeHandler = () => {
    disposeStaffDrawer();
    target.classList.toggle('staff-catalog-page', window.location.hash === '#staff');
    normalizeManagementSidebar({ routeChange: true });
    if (page === 'dashboard') {
      if (window.location.hash === '#tasks') renderTasks();
      else if (window.location.hash === '#loyalty') renderLoyalty();
      else renderDashboard();
      if (window.location.hash) {
        const focused = ['#shift-control', '#company', '#settings-dashboard-modules', '#venue-layout-settings', '#lock-security', '#audit'].includes(window.location.hash);
        const scrollTarget = focused ? getSettingsHashTarget(window.location.hash) : target.querySelector('.page-title');
        scrollTarget?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    const nextTarget = window.location.hash ? document.querySelector(window.location.hash) : null;
    nextTarget?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  if (target._dashboardHashChangeHandler) window.removeEventListener('hashchange', target._dashboardHashChangeHandler);
  target._dashboardHashChangeHandler = dashboardHashChangeHandler;
  window.addEventListener('hashchange', dashboardHashChangeHandler);
  const focusedSettingsHash = ['#shift-control', '#company', '#settings-dashboard-modules', '#venue-layout-settings', '#lock-security', '#audit'].includes(window.location.hash);
  const hashTarget = window.location.hash ? (page === 'dashboard' ? (focusedSettingsHash ? target.querySelector(window.location.hash === '#company' ? '#company-form' : window.location.hash) : target.querySelector('.page-title')) : document.querySelector(window.location.hash)) : null; hashTarget?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderInventory() {
  const target = document.querySelector('#page-content'); if (!target) return;
  const canWriteInventory = portalPermissions.has('inventory');
  let tobaccoCatalogItems = [];
  let alcoholCatalogItems = [];
  const alcoholItemLabel = (item) => `${item.brand}${item.productLine ? ` · ${item.productLine}` : ''} — ${item.name}`;
  const alcoholProfileById = (id) => alcoholCatalogItems.find((item) => String(item.id) === String(id));
  const syncTobaccoLinkSelector = (selectedId = '') => { const field = document.querySelector('#inventory-item-tobacco-catalog'); if (!field) return; const current = selectedId || field.value; const options = tobaccoCatalogItems.filter((item) => item.active !== false || String(item.id) === String(current)); field.innerHTML = '<option value="">Без связи с каталогом табака</option>' + options.map((item) => `<option value="${esc(item.id)}">${esc(item.brand)}${item.productLine ? ` · ${esc(item.productLine)}` : ''} — ${esc(item.flavor)} · ${item.productType === 'tobacco_free' ? 'бестабачная' : 'табачная'}${item.packageGrams ? ` · ${esc(item.packageGrams)} г` : ''}${item.strength ? ` · крепость ${esc(item.strength)}` : ''}</option>`).join(''); field.value = options.some((item) => String(item.id) === String(current)) ? String(current) : ''; const selected = options.find((item) => String(item.id) === String(field.value)); const profileHint = document.querySelector('#inventory-tobacco-profile-hint'); if (profileHint) profileHint.textContent = selected ? `${selected.productType === 'tobacco_free' ? 'Бестабачная смесь' : 'Табачная смесь'} · ${selected.flavor}${selected.strength ? ` · крепость: ${selected.strength}` : ' · крепость не указана'}${selected.packageGrams ? ` · упаковка по каталогу: ${selected.packageGrams} г` : ' · масса упаковки в карточке не указана'}` : 'Свяжите ingredient с карточкой, чтобы видеть бренд, линейку, вкус, тип, крепость и фасовку.'; const packHint = document.querySelector('#inventory-item-pack-hint'); if (packHint) packHint.textContent = selected && selected.packageGrams ? `В карточке указано ${selected.packageGrams} г в пачке. При единице учёта «г» задайте здесь такое же число: множитель переведёт пачки в граммы.` : 'Для учёта пачки задайте закупочную единицу и количество базовых единиц в упаковке.'; };
  const syncAlcoholLinkSelector = (selectedId = '') => { const field = document.querySelector('#inventory-item-alcohol-catalog'); if (!field) return; const current = selectedId || field.value; const department = document.querySelector('#inventory-item-department')?.value || '', category = document.querySelector('#inventory-item-category')?.value || '', linked = Boolean(current), looksAlcohol = /алког|спирт|крепк|водк|виск|ром|джин|коньяк|лик[её]р|текил/i.test(category), show = (department === 'bar' && looksAlcohol) || linked, wrapper = document.querySelector('#inventory-alcohol-link-field'); if (wrapper) wrapper.hidden = !show; const options = alcoholCatalogItems.filter((item) => item.active !== false || String(item.id) === String(current)); field.innerHTML = '<option value="">Без связи с каталогом алкоголя</option>' + options.map((item) => `<option value="${esc(item.id)}">${esc(alcoholItemLabel(item))}${item.active === false ? ' · архив' : ''}</option>`).join(''); field.value = options.some((item) => String(item.id) === String(current)) ? String(current) : ''; };
  let recipeItems = [];
  let productItems = [];
  let inventoryDepartments = [];
  let inventorySubdepartments = [];
  let productCategoryItems = [];
  let payload = null;
  let inventoryLoadState = 'loading';
  let allItems = [];
  let autoOrderState = { items: [], requests: [], error: null, hasLoaded: false };
  let purchaseDocuments = [];
  const movementButton = canWriteInventory ? `<button type="button" class="button" id="open-movement" title="Записать поставку, списание или корректировку остатка">${icon('plus')} Учесть поставку или списание</button>` : '<span class="badge">Только просмотр</span>';
  const itemButton = canWriteInventory ? `<button type="button" class="button primary" id="new-inventory-item" title="Создать новую складскую позицию для учёта">${icon('plus')} Добавить складскую позицию</button>` : '';
  const movementPanel = canWriteInventory ? '<section class="panel inventory-movement-editor"><div class="panel-head"><div><h2>Поступление или списание</h2><span class="muted">Выберите позицию, операцию и количество. Для прихода можно указать закупочную стоимость.</span></div></div><form id="movement-form" class="stack-form"><label>Позиция<select id="movement-item" required></select></label><label>Операция<select id="movement-direction"><option value="in">Поступление — добавить на склад</option><option value="out">Списание — убрать со склада</option></select></label><div class="form-row"><label>Количество<input id="movement-delta" type="number" min="0.000001" step="0.000001" placeholder="Например, 10" required><small class="muted" id="movement-unit-hint">Единица: —</small></label><label>Единица<select id="movement-unit"><option value="шт">шт</option><option value="г">г</option><option value="кг">кг</option><option value="мл">мл</option><option value="л">л</option><option value="порция">порция</option><option value="уп">уп</option><option value="упаковка">упаковка</option></select></label></div><label id="movement-unit-cost-label">Закупочная стоимость за единицу<input id="movement-unit-cost" type="number" min="0" step="0.01" placeholder="Например, 350"><small class="muted">Укажите стоимость только для прихода, чтобы пересчитать себестоимость.</small></label><label>Причина<input id="movement-reason" placeholder="Поставка, списание или корректировка"></label><button type="submit" class="button primary">Сохранить операцию</button><p class="form-message" id="movement-message"></p></form></section>' : '<section class="panel inventory-movement-editor"><div class="panel-head"><h2>Доступ</h2></div><p class="muted">У этой роли доступен просмотр остатков. Изменения выполняет сотрудник с правом управления складом.</p></section>';
  target.innerHTML = `<div class="page-title inventory-page-title"><div><p class="eyebrow">ОПЕРАЦИОННЫЙ КОНТРОЛЬ</p><h1 id="inventory-page-heading">Склад</h1><p class="muted" id="inventory-page-description">Управление запасами, закупками и себестоимостью заведения.</p></div><div class="toolbar-row inventory-header-actions" id="inventory-header-actions" aria-label="Действия раздела"></div><div class="inventory-legacy-actions" hidden>${itemButton}${movementButton}</div></div><div class="kpi-grid compact inventory-context-kpis" aria-label="Показатели раздела"><article class="kpi"><span id="inventory-kpi-label-1">Всего позиций</span><strong id="inventory-kpi-value-1">—</strong><small id="inventory-kpi-help-1">Ингредиенты и товары</small></article><article class="kpi"><span id="inventory-kpi-label-2">Нужно пополнить</span><strong id="inventory-kpi-value-2">—</strong><small id="inventory-kpi-help-2">До минимального остатка</small></article><article class="kpi"><span id="inventory-kpi-label-3">Последняя операция</span><strong id="inventory-kpi-value-3">—</strong><small id="inventory-kpi-help-3">По журналу склада</small></article></div><div class="inventory-legacy-metrics" hidden aria-hidden="true"><span id="inventory-count">—</span><span id="inventory-low">—</span><span id="inventory-last">—</span></div><div class="content-grid inventory-content-grid"><section class="panel wide inventory-stock-panel inventory-view-section"><div class="panel-head"><div><h2>Остатки</h2><span class="muted">Текущие остатки. Порог пополнения задаётся в карточке позиции.</span></div><div class="toolbar-row inventory-stock-filters"><input class="table-search" id="inventory-search" aria-label="Поиск позиции" placeholder="Поиск позиции"><select id="inventory-department-filter" aria-label="Фильтр по цеху"><option value="">Все цеха</option></select></div></div><div class="table-wrap"><table><thead><tr><th>Позиция</th><th>Цех / категория</th><th>Остаток</th><th>Порог пополнения</th><th>Состояние</th><th>Действия</th></tr></thead><tbody id="inventory-rows"></tbody></table></div></section>${movementPanel}</div>`;
  const purchasePanel = document.createElement('section');
  purchasePanel.className = 'panel wide inventory-purchase-panel inventory-view-hidden';
  purchasePanel.innerHTML = `<div class="panel-head"><div><h2>Приёмка по документу</h2><span class="muted">Запишите поставщика, накладную и фактическое количество. Проведение обновит остаток и закупочную стоимость.</span></div><span class="badge info">Черновик → проверка → провести</span></div>${canWriteInventory ? `<form id="purchase-document-form" class="purchase-document-form"><div id="purchase-order-context" class="purchase-order-context" hidden><strong>Поступление по автозаказу</strong><span>Проведение обновит полученное количество, остаток и закупочную стоимость.</span></div><div class="form-grid"><label>Поставщик<input id="purchase-supplier" maxlength="160" placeholder="Название поставщика"></label><label>Номер документа<input id="purchase-number" maxlength="80" placeholder="Например, УПД-1042"></label><label>Дата накладной · необязательно<input id="purchase-date" type="date"><small class="muted">Если дата неизвестна, оставьте поле пустым.</small></label></div><div class="purchase-lines-head"><div><h3>Полученные позиции</h3><small class="muted">Укажите закупочную упаковку и цену за неё. Склад пересчитает количество и стоимость в единицу учёта.</small></div><button class="button small" type="button" id="purchase-add-line">${icon('plus')} Добавить позицию</button></div><div id="purchase-lines" class="purchase-lines"></div><label>Комментарий<textarea id="purchase-note" rows="2" maxlength="2000" placeholder="Расхождение, партия или примечание к накладной"></textarea></label><div class="purchase-form-footer"><strong id="purchase-total">Итого: 0 ₽</strong><div class="toolbar-row"><button class="button primary" type="submit" id="purchase-save">Сохранить черновик</button><button class="button" type="button" id="purchase-cancel" hidden>Отмена редактирования</button></div></div><p class="form-message" id="purchase-message" aria-live="polite"></p></form>` : '<p class="muted">Для приёмки необходимы права управления складом.</p>'}<div class="purchase-history"><div class="section-title-row"><div><h3>Документы поступления</h3><span class="muted">Проведённые документы хранят историю закупочной цены и движения</span></div></div><div class="purchase-document-filters" role="group" aria-label="Фильтры документов поступления"><label>Дата накладной с<input id="purchase-filter-from" type="date"></label><label>Дата накладной по<input id="purchase-filter-to" type="date"></label><label>Статус<select id="purchase-filter-status"><option value="">Все статусы</option><option value="draft">Черновик</option><option value="posted">Проведён</option><option value="voided">Отменён</option></select></label><label class="purchase-filter-undated"><input id="purchase-filter-undated" type="checkbox"> Включить документы без даты</label><div class="toolbar-row"><button class="button small primary" type="button" id="purchase-filter-apply">Показать</button><button class="button small" type="button" id="purchase-filter-reset">Сбросить</button></div></div><p id="purchase-filter-message" class="form-message" role="status" aria-live="polite"></p><div id="purchase-document-list"><div class="empty">Загрузка документов…</div></div></div>`;
  target.append(purchasePanel);
  const inventoryContentGrid = target.querySelector('.content-grid');
  if (inventoryContentGrid) target.insertBefore(purchasePanel, inventoryContentGrid);
  for (const label of purchasePanel.querySelectorAll('label:has(:required)')) {
    const caption = [...label.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (!caption) continue;
    const mark = document.createElement('span');
    mark.className = 'required-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = ' *';
    caption.after(mark);
  }
  document.querySelector('#purchase-document-list')?.classList.add('purchase-document-list');
  const quickMovement = document.querySelector('#open-movement'); if (quickMovement) { quickMovement.innerHTML = `${icon('adjustments')} Списание / корректировка`; quickMovement.title = 'Записать потерю, списание или корректировку остатка'; }
  document.querySelector('#movement-unit-cost-label')?.remove();
  const movementHeading = document.querySelector('.inventory-movement-editor h2'); if (movementHeading) movementHeading.textContent = 'Списание или корректировка';
  const movementHelp = document.querySelector('.inventory-movement-editor .muted'); if (movementHelp) movementHelp.textContent = 'Поставки оформляйте по накладной выше. Здесь фиксируйте списание, потери или корректировку остатка.';
  const movementDirection = document.querySelector('#movement-direction'); if (movementDirection) movementDirection.innerHTML = '<option value="out">Списание — убрать со склада</option><option value="in">Корректировка — увеличить остаток</option>';
  let inventoryItemEditor = null;
  let recipeInventoryItems = [];
  const recipeCostCache = new Map();
  const recipeCostRequests = new Map();
  let recipeCostGeneration = 0;
  const refreshRecipeCostCards = () => document.querySelectorAll('[data-recipe-cost-for]').forEach((node) => { node.innerHTML = renderRecipeCostBreakdown(node.dataset.recipeCostFor); });
  const invalidateRecipeCostCache = () => { recipeCostGeneration += 1; recipeCostCache.clear(); recipeCostRequests.clear(); refreshRecipeCostCards(); };
  const loadRecipeCardCost = (recipeId) => {
    const key = String(recipeId);
    if (recipeCostCache.has(key) || recipeCostRequests.has(key)) return;
    const generation = recipeCostGeneration;
    recipeCostRequests.set(key, generation);
    api(`/api/recipes/${encodeURIComponent(key)}/cost`).then((data) => { if (generation === recipeCostGeneration) recipeCostCache.set(key, data); }).catch(() => { if (generation === recipeCostGeneration) recipeCostCache.set(key, { error: true }); }).finally(() => {
      if (recipeCostRequests.get(key) === generation) recipeCostRequests.delete(key);
      refreshRecipeCostCards();
    });
  };
  const renderRecipeCostBreakdown = (recipeId) => {
    const key = String(recipeId);
    if (!recipeCostCache.has(key)) { loadRecipeCardCost(key); return '<p class="muted">Загружаем текущую себестоимость…</p>'; }
    const data = recipeCostCache.get(key);
    if (data.error) return `<div class="muted">Не удалось загрузить текущую себестоимость. <button class="button small" type="button" data-recipe-cost-retry="${esc(key)}">Повторить</button></div>`;
    const lines = Array.isArray(data.lines) ? data.lines : [];
    const rows = lines.map((line) => {
      const recipeQuantity = line.recipeQuantity ?? line.quantity ?? '—';
      const recipeUnit = line.recipeUnit || line.sourceUnit || line.unit || '';
      const normalizedQuantity = line.quantity == null ? '' : `${Number(line.quantity).toLocaleString('ru-RU')} ${line.unit || ''}`;
      return `<div><span><strong>${esc(displayName(line.stockName || line.name || 'Ингредиент'))} · ${esc(String(recipeQuantity))} ${esc(recipeUnit)}</strong>${line.linked ? `<small class="muted">Для расчёта: ${esc(normalizedQuantity)}</small><small class="muted">Закупочная фасовка: ${esc(line.purchaseUnit || line.unit || 'шт')} = ${esc(String(line.packMultiplier || 1))} ${esc(line.unit || '')}</small><small class="muted">Расчётная стоимость фасовки по текущей средней себестоимости: ${money(line.packageEquivalentCost || 0)} · складская единица: ${money(line.unitCost || 0)}/${esc(line.unit || '')}</small>` : '<small class="recipe-cost-missing">Нет связи со складской позицией</small>'}</span><b class="${line.linked ? '' : 'recipe-cost-missing'}">${line.linked ? money(line.cost || 0) : 'Не рассчитано'}</b></div>`;
    }).join('');
    const missingCount = Array.isArray(data.missing) ? data.missing.length : lines.filter((line) => !line.linked).length;
    return `<p><strong>Текущая себестоимость:</strong> ${missingCount ? 'есть строки без связи со складом' : money(data.totalCost || 0)}${missingCount ? '' : ` · ${money(data.costPerPortion || 0)} за единицу продажи`}</p><div class="recipe-cost-lines">${rows || '<span class="muted">Состав не указан</span>'}</div>`;
  };
  document.addEventListener('click', (event) => { const retry = event.target.closest('[data-recipe-cost-retry]'); if (retry) { event.preventDefault(); invalidateRecipeCostCache(); } });
  window.addEventListener('focus', () => { if (!document.hidden && new URL(location.href).searchParams.get('view') === 'recipes') invalidateRecipeCostCache(); });
  if (canWriteInventory) {
    const editor = document.createElement('section'); inventoryItemEditor = editor; editor.className = 'panel inventory-item-editor-panel'; editor.hidden = true; editor.innerHTML = `<div class="panel-head"><div><h2>Новая складская позиция</h2><span class="muted">Ингредиент, товар или расходник для учёта остатков и технологических карт</span></div></div><form id="inventory-item-form" class="product-editor" hidden><div class="form-grid"><label><span>Название <span class="required-mark">*</span></span><input id="inventory-item-name" maxlength="120" required placeholder="Например, Сироп маракуйя"></label><label><span>Цех <span class="required-mark">*</span></span><select id="inventory-item-department"><option value="kitchen">Кухня</option><option value="bar">Бар</option><option value="hookah">Кальяны</option><option value="inventory">Хозяйственный склад</option></select></label><label>Подцех — участок внутри цеха<select id="inventory-item-subdepartment"><option value="">Без подцеха</option></select><small class="field-hint">Выберите созданный подцех. Добавить его можно в «Склад → Справочники».</small></label><label>Категория<select id="inventory-item-category"><option value="">Выберите категорию</option></select><small class="field-hint">Категории — группы похожих позиций. Категория выбирается из справочника выбранного цеха.</small></label><label>Тип<select id="inventory-item-type"><option value="ingredient">Ингредиент</option><option value="product">Товар</option><option value="consumable">Расходник</option><option value="equipment">Инвентарь</option></select></label><label><span>Единица учёта <span class="required-mark">*</span></span><select id="inventory-item-unit"><option>шт</option><option>г</option><option>кг</option><option>мл</option><option>л</option><option>порция</option><option>уп</option><option>упаковка</option></select></label><label>Закупочная единица<input id="inventory-item-purchase-unit" maxlength="30" placeholder="коробка, бутылка"><small class="field-hint">Например: бутылка, если позиция закупается бутылками.</small></label><label>В упаковке<input id="inventory-item-pack" type="number" min="0.000001" step="0.000001" value="1"><small class="field-hint">Количество единиц учёта в одной закупочной единице.</small></label><label><span>Цена закупочной единицы</span><input id="inventory-item-purchase-cost" type="number" min="0" step="0.01" placeholder="Например, 1400"><small class="field-hint">Цена всей бутылки или упаковки. Себестоимость ниже рассчитывается автоматически.</small></label><label><span>Себестоимость единицы учёта</span><input id="inventory-item-cost" type="number" min="0" step="0.0001" value="0" readonly aria-readonly="true"><small class="field-hint" id="inventory-item-cost-hint">Укажите цену закупочной единицы и фасовку, чтобы получить стоимость 1 мл, г или шт.</small></label><label>Минимальный остаток<input id="inventory-item-min" type="number" min="0" step="0.000001" value="0"></label><label>Поставщик<input id="inventory-item-supplier" maxlength="160" placeholder="Название поставщика"></label><label>Штрихкод<input id="inventory-item-barcode" maxlength="64"></label></div><label>Комментарий<textarea id="inventory-item-note" maxlength="500" rows="2" placeholder="Срок хранения, условия списания"></textarea></label><div class="toolbar-row"><button class="button primary" type="submit">Сохранить позицию</button><button class="button" id="cancel-inventory-item" type="button">Отмена</button></div><p class="form-message" id="inventory-item-message"></p></form></section>`; target.insertBefore(editor, target.querySelector('.movement-history') || null);
  }
  const inventorySections = { stock: ['.inventory-stock-panel', '.inventory-item-editor-panel'], 'auto-orders': ['.inventory-auto-order-panel'], movements: ['.inventory-purchase-panel', '.inventory-movement-editor', '.movement-history'], recipes: ['.recipes-panel'], premixes: ['.premix-panel'], directories: ['.inventory-departments-panel', '.inventory-tobacco-catalog-panel', '.inventory-alcohol-catalog-panel'], products: ['.visual-catalog-panel'] };
  const inventoryViewContent = {
    stock: { title: 'Остатки', description: 'Текущие количества товаров и ингредиентов по цехам.', actions: [['item', 'Добавить позицию', 'primary'], ['receipt', 'Оформить поступление', '']], kpis: [['Позиций на складе', () => allItems.length, 'Активные товары и ингредиенты'], ['Нужно пополнить', () => payload?.lowStock?.length || 0, 'Позиции, для которых пора пополнить запас'], ['Последняя операция', () => document.querySelector('#inventory-last')?.textContent || '—', 'По журналу склада']] },
    'auto-orders': { title: 'Пополнение запасов', description: 'Проверьте рекомендации по закупке и подготовьте заявку управляющему.', actions: [], kpis: [['К заказу', () => autoOrderState.error && !autoOrderState.hasLoaded ? '—' : autoOrderState.items.length, autoOrderState.error ? (autoOrderState.hasLoaded ? 'Показаны данные последней успешной загрузки' : 'Не удалось получить данные склада') : 'Позиции ниже заданного минимума'], ['Ожидают получения', () => autoOrderState.requests.filter((item) => ['sent', 'partially_received'].includes(item.status)).length, autoOrderState.error ? 'Статус может быть неактуальным' : 'Внутренние заявки управляющему'], ['Оценка закупки', () => autoOrderState.error && !autoOrderState.hasLoaded ? '—' : money(autoOrderState.items.reduce((sum, item) => sum + Number(item.estimate || 0), 0)), autoOrderState.error ? 'Проверьте данные после повторной загрузки' : 'По последней закупочной цене']] },
    movements: { title: 'Поступления и списания', description: 'Оформляйте поставки по документам и отдельно фиксируйте списания или корректировки.', actions: [['receipt', 'Оформить поступление', 'primary'], ['adjustment', 'Списание / корректировка', '']], kpis: [['Документы поступления', () => purchaseDocuments.length, 'Черновики и проведённые документы'], ['Операции склада', () => payload?.movements?.length || 0, 'Записи в журнале'], ['Последняя операция', () => document.querySelector('#inventory-last')?.textContent || '—', 'По журналу склада']] },
    recipes: { title: 'Технологические карты', description: 'Состав, нормы расхода, приготовление и подача продаваемых позиций.', actions: [], kpis: [['Технологических карт', () => recipeItems.length, 'Продажные позиции и заготовки'], ['Связаны с товаром каталога', () => recipeItems.filter((recipe) => recipe.recipeType !== 'premix' && recipe.productId && productItems.some((product) => String(product.id) === String(recipe.productId))).length, 'Существующая позиция продажи указана в каталоге'], ['Премиксы', () => recipeItems.filter((item) => item.recipeType === 'premix').length, 'Рецептуры заготовок']] },
    premixes: { title: 'Заготовки и премиксы', description: canWriteInventory ? 'Приготовьте партию по техкарте: сырьё спишется, готовая заготовка поступит на склад.' : 'Просматривайте техкарты и историю выпуска заготовок.', actions: [], kpis: [['Доступно рецептур', () => recipeItems.filter((item) => item.recipeType === 'premix').length, 'Техкарты заготовок'], ['Готовых партий', () => document.querySelectorAll('#premix-batches .premix-batch-row').length, 'История производства'], ['Складских позиций', () => allItems.length, 'Для выпуска и списания']] },
    directories: { title: 'Справочники', description: 'Настройте путь складской позиции: цех → подцех → категория. Эти категории затем выбираются в карточке позиции.', actions: [['department', 'Новый цех', 'primary'], ['subdepartment', 'Новый подцех', ''], ['category', 'Новая категория', '']], kpis: [['Цеха', () => inventoryDepartments.length, 'Основные подразделения'], ['Подцеха', () => inventorySubdepartments.length, 'В справочнике'], ['Категории', () => productCategoryItems.length, 'Группы складских позиций']] },
    products: { title: 'Каталог товаров', description: 'Позиции меню, цены и категории, которые сотрудники добавляют в заказы.', actions: [], kpis: [['Товары меню', () => productItems.length, 'Доступны для заказа'], ['Связаны с техкартой', () => productItems.filter((product) => recipeItems.some((recipe) => String(recipe.productId) === String(product.id))).length, 'Есть состав для списания'], ['Категории', () => new Set(productItems.map((item) => item.category).filter(Boolean)).size, 'В каталоге продаж']] }
  };
  const renderInventoryContext = (view) => {
    const context = inventoryViewContent[view] || inventoryViewContent.stock;
    const heading = document.querySelector('#inventory-page-heading'); if (heading) heading.textContent = context.title;
    const description = document.querySelector('#inventory-page-description'); if (description) description.textContent = context.description;
    const actions = document.querySelector('#inventory-header-actions');
    if (actions) { actions.innerHTML = `${canWriteInventory ? context.actions.map(([key, label, style]) => `<button type="button" class="button ${style}" data-inventory-header-action="${key}">${icon('plus')} ${label}</button>`).join('') : '<span class="badge">Только просмотр</span>'}`; actions.hidden = canWriteInventory && context.actions.length === 0; }
    context.kpis.forEach(([label, value, help], index) => {
      const number = index + 1;
      const labelNode = document.querySelector(`#inventory-kpi-label-${number}`);
      const valueNode = document.querySelector(`#inventory-kpi-value-${number}`);
      const helpNode = document.querySelector(`#inventory-kpi-help-${number}`);
      if (labelNode) labelNode.textContent = label;
      if (valueNode) { try { valueNode.textContent = inventoryLoadState === 'loading' && ['stock', 'movements'].includes(view) ? '—' : String(value()); } catch (_) { valueNode.textContent = '—'; } }
      if (helpNode) helpNode.textContent = inventoryLoadState === 'loading' && ['stock', 'movements'].includes(view) ? 'Загружаем данные склада…' : inventoryLoadState === 'error' && ['stock', 'movements'].includes(view) ? 'Не удалось загрузить данные склада' : help;
    });
  };
  const refreshInventoryContext = () => renderInventoryContext(new URL(location.href).searchParams.get('view') || 'stock');
  const setInventoryView = (requestedView, { historyMode = 'push', scroll = true } = {}) => {
    const view = Object.hasOwn(inventorySections, requestedView) ? requestedView : 'stock';
    const visible = inventorySections[view];
    document.querySelectorAll('.inventory-stock-panel,.inventory-item-editor-panel,.inventory-auto-order-panel,.inventory-purchase-panel,.inventory-movement-editor,.movement-history,.visual-catalog-panel,.inventory-departments-panel,.inventory-tobacco-catalog-panel,.inventory-alcohol-catalog-panel,.recipes-panel,.premix-panel').forEach((section) => section.classList.toggle('inventory-view-hidden', !visible.some((selector) => section.matches(selector))));
    renderInventoryContext(view);
    const nextUrl = new URL(location.href);
    if (view === 'stock') nextUrl.searchParams.delete('view'); else nextUrl.searchParams.set('view', view);
    if (nextUrl.search !== location.search && historyMode) history[historyMode + 'State']({}, '', nextUrl.pathname + nextUrl.search + nextUrl.hash);
    normalizeManagementSidebar({ routeChange: true });
    if (scroll) document.querySelector('.portal-main')?.scrollTo({ top: 0, behavior: 'smooth' });
    return view;
  };
  document.querySelector('#inventory-header-actions')?.addEventListener('click', (event) => {
    const action = event.target.closest('[data-inventory-header-action]')?.dataset.inventoryHeaderAction;
    if (!action) return;
    if (action === 'item') { setInventoryView('stock'); document.querySelector('#new-inventory-item')?.click(); }
    if (action === 'receipt') { setInventoryView('movements'); document.querySelector('#purchase-document-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); document.querySelector('#purchase-date')?.focus({ preventScroll: true }); }
    if (action === 'adjustment') document.querySelector('#open-movement')?.click();
    if (action === 'department') { setInventoryView('directories'); document.querySelector('#new-inventory-department')?.click(); }
    if (action === 'subdepartment') { setInventoryView('directories'); document.querySelector('#new-inventory-subdepartment')?.click(); }
    if (action === 'category') { setInventoryView('directories'); document.querySelector('#new-product-category')?.click(); }
  });
  const movementHistory = document.createElement('section'); movementHistory.className = 'panel movement-history'; movementHistory.innerHTML = '<div class="panel-head"><div><h2>История операций</h2><span class="muted">Последние операции по складу</span></div></div><div id="movement-history-list" class="movement-history-list"><div class="empty">Загрузка истории…</div></div>'; target.append(movementHistory);
  const autoOrderPanel = document.createElement('section'); autoOrderPanel.className = 'panel wide inventory-auto-order-panel inventory-view-section'; autoOrderPanel.innerHTML = `<div class="panel-head"><div><h2>Пополнение запасов</h2><span class="muted">Позиции, которые нужно заказать, и заявка для управляющего</span></div><div class="toolbar-row"><span class="badge warning" id="auto-order-low-count">Загрузка…</span>${canWriteInventory ? '<button class="button primary" type="button" id="create-auto-order">Сформировать заявку управляющему</button>' : ''}</div></div><div class="auto-order-explainer"><span class="auto-order-explainer-icon">${icon('clipboard-list')}</span><div><b>Как рассчитывается количество</b><p>Система сравнивает остаток с минимумом и добавляет запас до следующего целого количества упаковок. Перед отправкой заявку можно проверить и изменить.</p></div></div><div id="auto-order-list"><div class="empty">Загрузка позиций…</div></div><div class="auto-order-history"><div class="section-title-row"><div><h3>Заявки управляющему</h3><span class="muted">Последние сформированные заявки и их статус</span></div></div><div id="auto-order-history-list"><div class="empty">Заявок пока нет</div></div></div>`; target.append(autoOrderPanel);
  bindKpiNavigation();
  const visual = document.createElement('section'); visual.className = 'panel visual-catalog-panel'; visual.innerHTML = `<div class="panel-head"><div><h2>Каталог товаров</h2><span class="muted">Позиции меню, фотографии, цены и категории</span></div><div class="toolbar-row"><input class="table-search" id="product-search" placeholder="Поиск товара" aria-label="Поиск товара">${canWriteInventory ? `<button class="button small" id="new-product" type="button">${icon('plus')} Добавить товар</button>` : ''}</div></div>${canWriteInventory ? '<form id="product-form" class="product-editor product-catalog-editor" hidden aria-labelledby="product-form-title"> <input type="hidden" id="product-id"> <div class="product-editor-heading"> <div> <span class="eyebrow">КАТАЛОГ ПРОДАЖ</span> <h3 id="product-form-title">Новый товар</h3> <p class="muted" id="product-form-hint">Заполните основные данные — товар сразу появится в заказах.</p> </div> <span class="badge info" id="product-form-status">Черновик</span> </div> <div class="product-form-layout"> <div class="product-form-main"> <div class="product-form-section"> <div class="section-title-row"><div><h4>Основные данные</h4><span class="muted">Эти поля нужны, чтобы официант быстро нашёл позицию и добавил её в заказ.</span></div></div> <div class="form-grid product-form-grid"> <label class="product-field-wide"><span>Название товара <span class="required-mark" aria-label="Обязательное поле">*</span></span><input id="product-name" required maxlength="120" autocomplete="off" placeholder="Например, Лимонад маракуйя"></label> <label><span>Категория <span class="required-mark" aria-label="Обязательное поле">*</span></span><input id="product-category" list="product-category-options" required maxlength="80" autocomplete="off" placeholder="Бар, кухня, кальянная"><datalist id="product-category-options"></datalist><small class="field-hint">Можно выбрать готовую категорию из справочника.</small></label> <label><span>Цена продажи <span class="required-mark" aria-label="Обязательное поле">*</span></span><span class="input-with-suffix"><input id="product-price" required type="number" min="0" max="10000000" step="1" inputmode="decimal" placeholder="0"><span>₽</span></span><small class="field-hint">Себестоимость считается отдельно по технологической карте.</small></label> <label class="product-inventory-mode-field"><span>Складской учёт <span class="required-mark" aria-label="Обязательное поле">*</span></span><select id="product-inventory-mode" required><option value="tracked">Списывать по техкарте</option><option value="non_stock">Без складского списания</option></select><small class="field-hint">Для позиции с ингредиентами выберите списание по техкарте. Услуги и товары без складского расхода отметьте отдельно.</small></label> </div> </div> <div class="product-form-section"> <div class="section-title-row"><div><h4>Поиск и связь с меню</h4><span class="muted">Синонимы помогают найти товар по разговорному названию или другому написанию.</span></div></div> <label><span>Синонимы для поиска</span><input id="product-aliases" maxlength="500" autocomplete="off" placeholder="маракуйя, лимонад, maracuya"><small class="field-hint">Введите варианты через запятую.</small></label> </div> </div> <aside class="product-editor-preview" aria-label="Предпросмотр товара"> <div class="product-preview-label">Предпросмотр карточки</div> <div id="product-image-preview" class="product-image-preview"><div class="product-image-empty"><span aria-hidden="true">＋</span><b>Фото товара</b><small>Необязательно</small></div></div> <label class="upload-button product-image-upload">Загрузить фото<input id="product-image-file" type="file" accept="image/png,image/jpeg,image/webp" hidden></label> <small class="field-hint">PNG, JPG или WebP до 1,5 МБ.</small> </aside> </div> <div class="product-editor-footer"> <p class="form-message" id="product-message" aria-live="polite"></p> <div class="toolbar-row"><button class="button primary" type="submit" id="save-product">Сохранить товар</button><button class="button" id="cancel-product" type="button">Отмена</button><button class="button danger-outline" id="delete-product" type="button" hidden>Удалить товар</button></div> </div> </form>' : ''}<div id="visual-catalog" class="visual-catalog"><div class="empty">Загрузка товаров…</div></div>`; target.append(visual);
  if (canWriteInventory) {
    const tobaccoPanel = document.createElement('section'); tobaccoPanel.className = 'panel inventory-tobacco-catalog-panel';
    const canManageNetworkCatalog = ['owner','admin','developer'].includes(portalUser.role);
    tobaccoPanel.innerHTML = `<div class="panel-head"><div><h2>Каталог табаков</h2><span class="muted">Информационные карточки брендов и вкусов. Остатки и закупочные цены здесь не ведутся.</span></div><div class="toolbar-row">${canWriteInventory ? '<button type="button" class="button primary" id="tobacco-catalog-add">Добавить карточку</button>' : ''}</div></div><div class="toolbar-row tobacco-catalog-filters"><input class="table-search" type="search" id="tobacco-catalog-search" placeholder="Поиск по бренду, линейке или вкусу" aria-label="Поиск табака"><select id="tobacco-catalog-scope-filter" aria-label="Область каталога"><option value="">Сеть и это заведение</option><option value="organization">Сеть</option><option value="venue">Это заведение</option></select><select id="tobacco-catalog-status-filter" aria-label="Состояние карточек"><option value="active">Активные</option><option value="archived">Архивные</option><option value="all">Все</option></select></div><div id="tobacco-catalog-list" class="tobacco-catalog-list" aria-live="polite"><div class="empty">Загружаем каталог…</div></div><form id="tobacco-catalog-form" class="product-editor tobacco-catalog-editor" hidden><div class="panel-head"><div><h3 id="tobacco-catalog-form-heading">Новая карточка табака</h3><span class="muted">Карточка описывает продукт и не создаёт складской остаток.</span></div></div><div class="form-grid"><label>Область карточки<select id="tobacco-catalog-scope"><option value="venue">Только это заведение</option>${canManageNetworkCatalog ? '<option value="organization">Вся сеть</option>' : ''}</select></label><label><span>Бренд <span class="required-mark" aria-label="Обязательное поле">*</span></span><input id="tobacco-catalog-brand" required maxlength="120" placeholder="Введите бренд"></label><label>Линейка<input id="tobacco-catalog-line" maxlength="120" placeholder="Необязательно"></label><label><span>Вкус / название <span class="required-mark" aria-label="Обязательное поле">*</span></span><input id="tobacco-catalog-flavor" required maxlength="160" placeholder="Например, вкус или название смеси"></label><label>Тип продукта<select id="tobacco-catalog-type"><option value="tobacco">Табачная смесь</option><option value="tobacco_free">Бестабачная смесь</option></select></label><label>Фасовка, г<input id="tobacco-catalog-package" type="number" min="0.001" max="100000" step="0.001" placeholder="Необязательно"></label><label>Крепость<input id="tobacco-catalog-strength" maxlength="80" placeholder="Как указано производителем"></label><label>Страна<input id="tobacco-catalog-country" maxlength="80"></label><label>Тип листа<input id="tobacco-catalog-leaf" maxlength="100"></label><label>Штрихкод<input id="tobacco-catalog-barcode" maxlength="64"></label></div><label>Варианты написания<input id="tobacco-catalog-aliases" maxlength="1000" placeholder="Через запятую"><small class="field-hint">Помогают находить товар по альтернативному названию.</small></label><label>Описание<textarea id="tobacco-catalog-description" maxlength="1200" rows="3" placeholder="Необязательное описание"></textarea></label><div class="toolbar-row"><button class="button primary" type="submit" id="tobacco-catalog-save">Сохранить карточку</button><button class="button" type="button" id="tobacco-catalog-cancel">Отмена</button></div><p class="form-message" id="tobacco-catalog-message" role="status"></p></form>`;
    target.append(tobaccoPanel);
    const tobaccoPanelBody = [...tobaccoPanel.children].slice(1);
    const tobaccoToggle = document.createElement('button');
    tobaccoToggle.type = 'button';
    tobaccoToggle.className = 'button small tobacco-catalog-toggle';
    tobaccoToggle.textContent = 'Показать каталог';
    tobaccoToggle.setAttribute('aria-expanded', 'false');
    tobaccoPanel.querySelector('.panel-head .toolbar-row')?.prepend(tobaccoToggle);
    tobaccoPanelBody.forEach((node) => { node.hidden = true; });
    tobaccoToggle.addEventListener('click', () => {
      const expanded = tobaccoToggle.getAttribute('aria-expanded') === 'true';
      tobaccoToggle.setAttribute('aria-expanded', String(!expanded));
      tobaccoToggle.textContent = expanded ? 'Показать каталог' : 'Свернуть каталог';
      tobaccoPanelBody.forEach((node) => { node.hidden = expanded; });
    });
    const tobaccoCatalogList = document.querySelector('#tobacco-catalog-list');
    const tobaccoCatalogForm = document.querySelector('#tobacco-catalog-form');
    const tobaccoValue = (id) => document.querySelector(`#${id}`)?.value ?? '';
    const showTobaccoForm = (item = null) => { tobaccoCatalogForm.hidden = false; tobaccoCatalogForm.dataset.editId = item?.id || ''; document.querySelector('#tobacco-catalog-form-heading').textContent = item ? 'Изменить карточку' : 'Новая карточка табака'; document.querySelector('#tobacco-catalog-save').textContent = item ? 'Сохранить изменения' : 'Сохранить карточку'; for (const [id,value] of [['scope',item?.scope || 'venue'],['brand',item?.brand || ''],['line',item?.productLine || ''],['flavor',item?.flavor || ''],['type',item?.productType || 'tobacco'],['package',item?.packageGrams ?? ''],['strength',item?.strength || ''],['country',item?.country || ''],['leaf',item?.leafType || ''],['barcode',item?.barcode || ''],['aliases',(item?.aliases || []).join(', ')],['description',item?.description || '']]) { const input=document.querySelector(`#tobacco-catalog-${id}`); if(input) { input.value=value; if(id==='scope') input.disabled=Boolean(item); } } document.querySelector('#tobacco-catalog-message').textContent=''; tobaccoCatalogForm.scrollIntoView({behavior:'smooth',block:'nearest'}); document.querySelector('#tobacco-catalog-brand').focus(); };
    const renderTobaccoCatalogItem = (item) => {
      const line = item.productLine ? ` · ${esc(item.productLine)}` : '';
      const packageText = item.packageGrams ? `<span>${esc(item.packageGrams)} г</span>` : '';
      const strengthText = item.strength ? `<span>Крепость: ${esc(item.strength)}</span>` : '';
      const countryText = item.country ? `<span>${esc(item.country)}</span>` : '';
      const leafText = item.leafType ? `<span>${esc(item.leafType)}</span>` : '';
      const barcodeText = item.barcode ? `<span>Штрихкод: ${esc(item.barcode)}</span>` : '';
      const description = item.description ? `<p>${esc(item.description)}</p>` : '';
      const aliases = item.aliases?.length ? `<small>Также ищут: ${esc(item.aliases.join(', '))}</small>` : '';
      const actions = canWriteInventory ? `<div class="toolbar-row"><button type="button" class="button small" data-tobacco-edit="${esc(item.id)}">Изменить</button>${item.active ? `<button type="button" class="button small danger-outline" data-tobacco-archive="${esc(item.id)}">Архивировать</button>` : `<button type="button" class="button small" data-tobacco-restore="${esc(item.id)}">Восстановить</button>`}</div>` : '';      return `<article class="tobacco-catalog-row${item.active ? '' : ' is-archived'}"><div class="tobacco-catalog-copy"><div class="tobacco-catalog-title"><b>${esc(item.brand)}${line} — ${esc(item.flavor)}</b><span class="badge">${item.scope === 'organization' ? 'Сеть' : 'Это заведение'}</span><span class="badge ${item.active ? 'success' : 'muted'}">${item.active ? 'Активна' : 'Архив'}</span></div><div class="tobacco-catalog-meta"><span>${item.productType === 'tobacco_free' ? 'Бестабачная смесь' : 'Табачная смесь'}</span>${packageText}${strengthText}${countryText}${leafText}${barcodeText}</div>${description}${aliases}</div>${actions}</article>`;
    };
    const loadTobaccoCatalog = () => {
      const query = new URLSearchParams({ status: tobaccoValue('tobacco-catalog-status-filter') || 'active', scope: tobaccoValue('tobacco-catalog-scope-filter') || '', q: tobaccoValue('tobacco-catalog-search').trim() });
      return api(`/api/tobacco-catalog?${query}`).then((data) => {
        tobaccoCatalogItems = data.items || [];
        syncTobaccoLinkSelector();
        if (!tobaccoCatalogItems.length) { tobaccoCatalogList.innerHTML = '<div class="empty">Карточек пока нет. Добавьте используемые в сети или заведении табаки.</div>'; return; }
        tobaccoCatalogList.innerHTML = tobaccoCatalogItems.map(renderTobaccoCatalogItem).join('');
        tobaccoCatalogList.querySelectorAll('[data-tobacco-edit]').forEach((button) => button.addEventListener('click', () => { const item = tobaccoCatalogItems.find((entry) => entry.id === button.dataset.tobaccoEdit); if (item) showTobaccoForm(item); }));
        tobaccoCatalogList.querySelectorAll('[data-tobacco-archive],[data-tobacco-restore]').forEach((button) => button.addEventListener('click', () => {
          const item = tobaccoCatalogItems.find((entry) => entry.id === (button.dataset.tobaccoArchive || button.dataset.tobaccoRestore)); if (!item) return;
          const active = Boolean(button.dataset.tobaccoRestore);
          api(`/api/tobacco-catalog/${encodeURIComponent(item.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }) }).then(() => { portalNotice(active ? 'Карточка восстановлена' : 'Карточка архивирована', 'success'); loadTobaccoCatalog(); }).catch((error) => portalNotice(error.payload?.error === 'tobacco_catalog_network_admin_required' ? 'Изменять каталог сети может владелец или администратор' : 'Не удалось изменить статус карточки', 'error'));
        }));
      }).catch(() => { tobaccoCatalogList.innerHTML = '<div class="empty error-message">Не удалось загрузить каталог. <button type="button" class="button small" id="tobacco-catalog-retry">Повторить</button></div>'; document.querySelector('#tobacco-catalog-retry')?.addEventListener('click', loadTobaccoCatalog); });
    };
    document.querySelector('#tobacco-catalog-add')?.addEventListener('click',()=>showTobaccoForm());
    document.querySelector('#tobacco-catalog-cancel').addEventListener('click',()=>{tobaccoCatalogForm.reset(); tobaccoCatalogForm.hidden=true; delete tobaccoCatalogForm.dataset.editId; document.querySelector('#tobacco-catalog-scope').disabled=false;});
    for(const id of ['tobacco-catalog-search','tobacco-catalog-scope-filter','tobacco-catalog-status-filter']) document.querySelector(`#${id}`).addEventListener(id.endsWith('search')?'input':'change',loadTobaccoCatalog);
    tobaccoCatalogForm.addEventListener('submit',(event)=>{event.preventDefault(); const editId=tobaccoCatalogForm.dataset.editId; const raw={scope:tobaccoValue('tobacco-catalog-scope'),brand:tobaccoValue('tobacco-catalog-brand'),productLine:tobaccoValue('tobacco-catalog-line'),flavor:tobaccoValue('tobacco-catalog-flavor'),productType:tobaccoValue('tobacco-catalog-type'),packageGrams:tobaccoValue('tobacco-catalog-package'),strength:tobaccoValue('tobacco-catalog-strength'),country:tobaccoValue('tobacco-catalog-country'),leafType:tobaccoValue('tobacco-catalog-leaf'),barcode:tobaccoValue('tobacco-catalog-barcode'),aliases:tobaccoValue('tobacco-catalog-aliases').split(',').map((value)=>value.trim()).filter(Boolean),description:tobaccoValue('tobacco-catalog-description')}; const message=document.querySelector('#tobacco-catalog-message'); const button=document.querySelector('#tobacco-catalog-save'); button.disabled=true; api(editId?`/api/tobacco-catalog/${encodeURIComponent(editId)}`:'/api/tobacco-catalog',{method:editId?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(raw)}).then(()=>{portalNotice(editId?'Карточка изменена':'Карточка добавлена','success'); tobaccoCatalogForm.reset(); tobaccoCatalogForm.hidden=true; delete tobaccoCatalogForm.dataset.editId; document.querySelector('#tobacco-catalog-scope').disabled=false; loadTobaccoCatalog();}).catch((error)=>{message.textContent=error.payload?.error==='tobacco_catalog_duplicate'?'Такая карточка уже есть в этом каталоге':error.payload?.error==='tobacco_catalog_network_admin_required'?'Внести карточку сети может владелец или администратор':error.payload?.error==='invalid_tobacco_catalog_item'?'Проверьте обязательные поля и фасовку':'Не удалось сохранить карточку'; message.className='form-message error-message';}).finally(()=>{button.disabled=false;}); });
    loadTobaccoCatalog();
    const alcoholCatalogPanel=document.createElement('section'); alcoholCatalogPanel.className='panel inventory-alcohol-catalog-panel';
    alcoholCatalogPanel.innerHTML=`<div class="panel-head"><div><h2>Каталог крепкого алкоголя</h2><span class="muted">Информационные карточки напитков. Остатки и движения ведутся только в складских позициях.</span></div><div class="toolbar-row"><button type="button" class="button small alcohol-catalog-toggle" aria-expanded="false">Показать каталог</button><button type="button" class="button primary" id="alcohol-catalog-add">Добавить карточку</button></div></div><div class="toolbar-row alcohol-catalog-filters"><input class="table-search" type="search" id="alcohol-catalog-search" placeholder="Поиск по бренду, названию или типу" aria-label="Поиск крепкого алкоголя"><select id="alcohol-catalog-scope-filter" aria-label="Область каталога"><option value="">Сеть и это заведение</option><option value="organization">Сеть</option><option value="venue">Это заведение</option></select><select id="alcohol-catalog-status-filter" aria-label="Состояние карточек"><option value="active">Активные</option><option value="archived">Архивные</option><option value="all">Все</option></select></div><div id="alcohol-catalog-list" class="alcohol-catalog-list" aria-live="polite"><div class="empty">Загружаем каталог…</div></div><form id="alcohol-catalog-form" class="product-editor alcohol-catalog-editor" hidden><div class="panel-head"><div><h3 id="alcohol-catalog-form-heading">Новая карточка алкоголя</h3><span class="muted">Справочная карточка не создаёт остаток. Свяжите её со складской позицией, чтобы использовать в техкартах.</span></div></div><div class="form-grid"><label>Область карточки<select id="alcohol-catalog-scope"><option value="venue">Только это заведение</option>${canManageNetworkCatalog?'<option value="organization">Вся сеть</option>':''}</select></label><label><span>Бренд <span class="required-mark">*</span></span><input id="alcohol-catalog-brand" required maxlength="120" placeholder="Например, Glenfiddich"></label><label>Линейка<input id="alcohol-catalog-line" maxlength="120" placeholder="Необязательно"></label><label><span>Название <span class="required-mark">*</span></span><input id="alcohol-catalog-name" required maxlength="160" placeholder="Например, 12 Year Old"></label><label><span>Тип <span class="required-mark">*</span></span><select id="alcohol-catalog-type" required><option value="whisky">Виски</option><option value="vodka">Водка</option><option value="rum">Ром</option><option value="tequila">Текила</option><option value="gin">Джин</option><option value="cognac">Коньяк</option><option value="brandy">Бренди</option><option value="liqueur">Ликёр</option><option value="other">Другое</option></select></label><label>Подтип<input id="alcohol-catalog-subtype" maxlength="100" list="alcohol-subtype-suggestions" placeholder="Зависит от типа напитка"><datalist id="alcohol-subtype-suggestions"></datalist><small class="field-hint">Можно выбрать подсказку или указать свой подтип.</small></label><label>Страна<input id="alcohol-catalog-country" maxlength="80"></label><label>Крепость, %<input id="alcohol-catalog-abv" type="number" min="0" max="100" step="0.01" placeholder="Например, 40"></label><label>Объём бутылки, мл<input id="alcohol-catalog-bottle" type="number" min="0.001" step="0.001" placeholder="Например, 700"></label><label>Выдержка, лет<input id="alcohol-catalog-age" type="number" min="0" step="0.1" placeholder="Если указана производителем"></label><label>Штрихкод<input id="alcohol-catalog-barcode" maxlength="64"></label></div><label>Варианты написания<input id="alcohol-catalog-aliases" maxlength="1000" placeholder="Через запятую"></label><label>Описание<textarea id="alcohol-catalog-description" maxlength="1200" rows="3" placeholder="Необязательное описание"></textarea></label><div class="toolbar-row"><button class="button primary" type="submit" id="alcohol-catalog-save">Сохранить карточку</button><button class="button" type="button" id="alcohol-catalog-cancel">Отмена</button></div><p class="form-message" id="alcohol-catalog-message" role="status" aria-live="polite"></p></form>`;
    target.append(alcoholCatalogPanel);
    const alcoholForm=alcoholCatalogPanel.querySelector('#alcohol-catalog-form'), alcoholPanelBody=[...alcoholCatalogPanel.children].slice(1).filter((node)=>node!==alcoholForm), alcoholToggle=alcoholCatalogPanel.querySelector('.alcohol-catalog-toggle'); alcoholPanelBody.forEach((node)=>{node.hidden=true;}); alcoholForm.hidden=true; alcoholToggle.addEventListener('click',()=>{const expanded=alcoholToggle.getAttribute('aria-expanded')==='true';alcoholToggle.setAttribute('aria-expanded',String(!expanded));alcoholToggle.textContent=expanded?'Показать каталог':'Свернуть каталог';alcoholPanelBody.forEach((node)=>{node.hidden=expanded;});if(expanded)alcoholForm.hidden=true;});
    const alcoholList=alcoholCatalogPanel.querySelector('#alcohol-catalog-list'), alcoholVal=(field)=>alcoholCatalogPanel.querySelector(`#alcohol-catalog-${field}`)?.value??'';
    const alcoholTypes={whisky:'Виски',vodka:'Водка',rum:'Ром',tequila:'Текила',gin:'Джин',cognac:'Коньяк',brandy:'Бренди',liqueur:'Ликёр',other:'Другое'};
    const subtypeSuggestions={whisky:['односолодовый','купажированный','бурбон','ржаной','ирландский','шотландский'],vodka:['классическая','ароматизированная'],rum:['светлый','золотой','тёмный','выдержанный','пряный'],tequila:['blanco','reposado','añejo','extra añejo'],gin:['London dry','old tom','британский','современный'],cognac:['VS','VSOP','XO'],brandy:['арманьяк','кальвадос','граппа','плодовый'],liqueur:['сливочный','травяной','фруктовый','горький'],other:[]};
    const syncAlcoholSubtypes=()=>{const select=alcoholCatalogPanel.querySelector('#alcohol-catalog-type'), list=alcoholCatalogPanel.querySelector('#alcohol-subtype-suggestions');if(list)list.innerHTML=(subtypeSuggestions[select.value]||[]).map((value)=>`<option value="${esc(value)}"></option>`).join('');};
    alcoholCatalogPanel.querySelector('#alcohol-catalog-type').addEventListener('change',syncAlcoholSubtypes);
    const loadAlcoholCatalog=()=>{const query=new URLSearchParams({status:alcoholVal('status-filter')||'active',scope:alcoholVal('scope-filter'),q:alcoholVal('search').trim()});return api(`/api/alcohol-catalog?${query}`).then((data)=>{alcoholCatalogItems=data.items||[];const linkQuery=new URLSearchParams({status:'all',scope:'',q:''});return api(`/api/alcohol-catalog?${linkQuery}`).then((all)=>{const filtered=alcoholCatalogItems;alcoholCatalogItems=all.items||[];if(!filtered.length){alcoholList.innerHTML='<div class="empty">Карточек пока нет. Добавьте напитки, используемые в меню и техкартах.</div>';syncAlcoholLinkSelector();document.dispatchEvent(new Event('alcohol-catalog-updated'));return;}alcoholList.innerHTML=filtered.map((item)=>{const metadata=[alcoholTypes[item.spiritType]||item.spiritType,item.spiritSubtype,item.country,item.abv!=null?`${item.abv}%`:null,item.bottleMl!=null?`${item.bottleMl} мл`:null,item.ageYears!=null?`${item.ageYears} лет`:null,item.barcode?`Штрихкод: ${item.barcode}`:null].filter(Boolean).map((part)=>`<span>${esc(part)}</span>`).join(''), aliases=item.aliases?.length?`<small>Также ищут: ${esc(item.aliases.join(', '))}</small>`:'', actions=canWriteInventory?`<div class="toolbar-row"><button type="button" class="button small" data-alcohol-edit="${esc(item.id)}">Изменить</button>${item.active?`<button type="button" class="button small danger-outline" data-alcohol-archive="${esc(item.id)}">Архивировать</button>`:`<button type="button" class="button small" data-alcohol-restore="${esc(item.id)}">Восстановить</button>`}</div>`:'';return `<article class="alcohol-catalog-row${item.active?'':' is-archived'}"><div class="alcohol-catalog-copy"><div class="tobacco-catalog-title"><b>${esc(alcoholItemLabel(item))}</b><span class="badge">${item.scope==='organization'?'Сеть':'Это заведение'}</span><span class="badge ${item.active?'success':'muted'}">${item.active?'Активна':'Архив'}</span></div><div class="tobacco-catalog-meta">${metadata}</div>${item.description?`<p>${esc(item.description)}</p>`:''}${aliases}</div>${actions}</article>`;}).join('');alcoholList.querySelectorAll('[data-alcohol-edit]').forEach((button)=>button.addEventListener('click',()=>{const item=alcoholCatalogItems.find((entry)=>String(entry.id)===button.dataset.alcoholEdit);if(!item)return;alcoholForm.hidden=false;alcoholForm.dataset.editId=item.id;alcoholCatalogPanel.querySelector('#alcohol-catalog-form-heading').textContent='Изменить карточку алкоголя';alcoholCatalogPanel.querySelector('#alcohol-catalog-save').textContent='Сохранить изменения';for(const [key,value] of Object.entries({scope:item.scope,brand:item.brand, line:item.productLine||'',name:item.name, type:item.spiritType,subtype:item.spiritSubtype||'',country:item.country||'',abv:item.abv??'',bottle:item.bottleMl??'',age:item.ageYears??'',barcode:item.barcode||'',aliases:(item.aliases||[]).join(', '),description:item.description||''})){const field=alcoholCatalogPanel.querySelector(`#alcohol-catalog-${key}`);if(field){field.value=value;if(key==='scope')field.disabled=true;}}syncAlcoholSubtypes();alcoholCatalogPanel.querySelector('#alcohol-catalog-message').textContent='';alcoholForm.scrollIntoView({behavior:'smooth',block:'nearest'});alcoholCatalogPanel.querySelector('#alcohol-catalog-brand').focus();}));alcoholList.querySelectorAll('[data-alcohol-archive],[data-alcohol-restore]').forEach((button)=>button.addEventListener('click',()=>{const id=button.dataset.alcoholArchive||button.dataset.alcoholRestore,active=Boolean(button.dataset.alcoholRestore);api(`/api/alcohol-catalog/${encodeURIComponent(id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({active})}).then(()=>{portalNotice(active?'Карточка восстановлена':'Карточка архивирована','success');loadAlcoholCatalog();}).catch((error)=>portalNotice(error.payload?.error==='alcohol_catalog_network_admin_required'?'Изменять каталог сети может владелец или администратор':'Не удалось изменить статус карточки','error'));}));syncAlcoholLinkSelector();document.dispatchEvent(new Event('alcohol-catalog-updated'));});}).catch(()=>{alcoholList.innerHTML='<div class="empty error-message">Не удалось загрузить каталог. <button type="button" class="button small" id="alcohol-catalog-retry">Повторить</button></div>';alcoholList.querySelector('#alcohol-catalog-retry')?.addEventListener('click',loadAlcoholCatalog);});};
    alcoholCatalogPanel.querySelector('#alcohol-catalog-add').addEventListener('click',()=>{alcoholForm.reset();alcoholForm.hidden=false;delete alcoholForm.dataset.editId;alcoholForm.querySelector('#alcohol-catalog-scope').disabled=false;alcoholCatalogPanel.querySelector('#alcohol-catalog-form-heading').textContent='Новая карточка алкоголя';alcoholCatalogPanel.querySelector('#alcohol-catalog-save').textContent='Сохранить карточку';syncAlcoholSubtypes();alcoholForm.scrollIntoView({behavior:'smooth',block:'nearest'});alcoholCatalogPanel.querySelector('#alcohol-catalog-brand').focus();});
    alcoholCatalogPanel.querySelector('#alcohol-catalog-cancel').addEventListener('click',()=>{alcoholForm.reset();alcoholForm.hidden=true;delete alcoholForm.dataset.editId;alcoholForm.querySelector('#alcohol-catalog-scope').disabled=false;});
    for(const id of ['search','scope-filter','status-filter'])alcoholCatalogPanel.querySelector(`#alcohol-catalog-${id}`).addEventListener(id==='search'?'input':'change',loadAlcoholCatalog);
    alcoholForm.addEventListener('submit',(event)=>{event.preventDefault();const editId=alcoholForm.dataset.editId,raw={scope:alcoholVal('scope'),brand:alcoholVal('brand'),productLine:alcoholVal('line'),name:alcoholVal('name'),spiritType:alcoholVal('type'),spiritSubtype:alcoholVal('subtype'),country:alcoholVal('country'),abv:alcoholVal('abv'),bottleMl:alcoholVal('bottle'),ageYears:alcoholVal('age'),barcode:alcoholVal('barcode'),aliases:alcoholVal('aliases').split(',').map((value)=>value.trim()).filter(Boolean),description:alcoholVal('description')},button=alcoholCatalogPanel.querySelector('#alcohol-catalog-save'),message=alcoholCatalogPanel.querySelector('#alcohol-catalog-message');button.disabled=true;api(editId?`/api/alcohol-catalog/${encodeURIComponent(editId)}`:'/api/alcohol-catalog',{method:editId?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(raw)}).then(()=>{portalNotice(editId?'Карточка изменена':'Карточка добавлена','success');alcoholForm.reset();alcoholForm.hidden=true;delete alcoholForm.dataset.editId;alcoholForm.querySelector('#alcohol-catalog-scope').disabled=false;loadAlcoholCatalog();}).catch((error)=>{const reason=error.payload?.error;message.textContent=reason==='alcohol_catalog_duplicate'?'Такая карточка уже есть в этом каталоге':reason==='alcohol_catalog_network_admin_required'?'Внести карточку сети может владелец или администратор':reason==='invalid_alcohol_catalog_item'?'Проверьте обязательные поля и числовые значения':'Не удалось сохранить карточку';message.className='form-message error-message';}).finally(()=>{button.disabled=false;});});
    loadAlcoholCatalog();
  }
  if (canWriteInventory || portalPermissions.has('inventory_read') || portalPermissions.has('inventory_categories')) {
    const categoryPanel = document.createElement('section'); categoryPanel.className = 'panel inventory-departments-panel'; categoryPanel.innerHTML = '<div class="panel-head"><div><h2>Структура склада</h2><span class="muted">Разложите складские позиции по понятному пути: <strong>цех → подцех → категория</strong>. Например: <strong>Бар → Сиропы → Фруктовые сиропы</strong> — так сироп маракуйи будет легко найти. Создайте справочники здесь, а сами товары и их остатки добавляйте в разделе «Остатки».</span></div><div class="toolbar-row"><button class="button small" id="open-products" type="button">' + icon('layout-dashboard') + ' Каталог товаров</button></div></div><p class="muted inventory-department-filter-label">Показать категории цеха</p><div class="inventory-departments"><button type="button" class="is-active" data-inventory-department="">Все цеха</button><button type="button" data-inventory-department="kitchen">Кухня</button><button type="button" data-inventory-department="bar">Бар</button><button type="button" data-inventory-department="hookah">Кальяны</button><button type="button" data-inventory-department="inventory">Инвентарь</button></div><div class="catalog-tree-section"><div class="section-title-row"><div><h3>1. Цех — что это за направление?</h3><span class="muted">Выберите общий раздел склада: например, «Кухня», «Бар», «Кальяны» или «Инвентарь». В него входят подцехи и категории. Пример: для сиропа выберите цех «Бар».</span></div></div><div id="inventory-department-list" class="category-list"><div class="empty">Загрузка цехов…</div></div></div><div class="catalog-tree-section" id="inventory-subdepartment-section"><div class="section-title-row"><div><h3>2. Подцех — где именно хранится?</h3><span class="muted">Это необязательный участок внутри цеха. Добавляйте только если полезно разделить хранение: «Бар → Сиропы», «Кухня → Холодильник». Для простого склада подцех можно пропустить.</span></div></div><div id="inventory-subdepartment-list" class="category-list"><div class="empty">Загрузка подцехов…</div></div></div><div class="catalog-tree-section"><div class="section-title-row"><div><h3>3. Категория — что за похожие позиции?</h3><span class="muted">Назовите группу товаров, чтобы их было удобно находить: например, «Фруктовые сиропы» или «Молочные продукты». Категория может быть общей для всего цеха или только для одного подцеха. Пример карточки: «Сироп маракуйя» → Бар → Сиропы → Фруктовые сиропы. Сам товар создаётся отдельно в разделе «Остатки».</span></div></div><div id="product-category-list" class="category-list"><div class="empty">Загрузка категорий…</div></div></div><form id="product-category-form" class="product-editor" hidden><input type="hidden" id="product-category-id"><label>Цех<select id="product-category-department"><option value="kitchen">Кухня</option><option value="bar">Бар</option><option value="hookah">Кальяны</option><option value="inventory">Инвентарь</option></select></label><label>Подцех<select id="product-category-subdepartment"><option value="">Весь цех</option></select><small class="field-hint">Оставьте «Весь цех», если категория подходит для всего направления. Выберите подцех, если она нужна только его позициям.</small></label><label>Категория<input id="product-category-name" maxlength="80" required placeholder="Например, Фруктовые сиропы"></label><div class="toolbar-row"><button class="button primary" type="submit">Сохранить</button><button class="button" id="cancel-product-category" type="button">Отмена</button><button class="button danger-outline" id="delete-product-category" type="button" hidden>Скрыть</button></div><p class="form-message" id="product-category-message"></p></form>'; const tobaccoCatalogPanel = target.querySelector('.inventory-tobacco-catalog-panel'); if (tobaccoCatalogPanel) target.insertBefore(categoryPanel, tobaccoCatalogPanel); else target.append(categoryPanel); document.querySelector('.inventory-legacy-actions')?.insertAdjacentHTML('beforeend', '<button type="button" id="new-inventory-department"></button><button type="button" id="new-inventory-subdepartment"></button><button type="button" id="new-product-category"></button>'); document.querySelector('#open-products')?.addEventListener('click', () => { setInventoryView('products'); document.querySelector('#visual-catalog')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    const directoryControls = document.createElement('div'); directoryControls.className = 'inventory-directory-controls'; directoryControls.innerHTML = '<span class="inventory-directory-controls-label">Показывать:</span><div class="segmented-control" role="group" aria-label="Состояние справочников"><button type="button" class="is-active" data-inventory-directory-status="active" aria-pressed="true">Активные</button><button type="button" data-inventory-directory-status="archived" aria-pressed="false">Архив</button></div><span class="muted">Архивные записи можно восстановить; окончательное удаление требует подтверждения владельца.</span>'; categoryPanel.querySelector('.panel-head .toolbar-row')?.append(directoryControls);
    const deletionRequestsPanel = document.createElement('section'); deletionRequestsPanel.id = 'inventory-deletion-requests'; deletionRequestsPanel.className = 'catalog-tree-section inventory-deletion-requests'; deletionRequestsPanel.hidden = true; categoryPanel.insertBefore(deletionRequestsPanel, categoryPanel.querySelector('.catalog-tree-section'));
    const categoryDirectorySection = [...categoryPanel.querySelectorAll('.catalog-tree-section')].find((section) => section.querySelector('#product-category-list'));
    const categoryFilterLabel = categoryPanel.querySelector('.inventory-department-filter-label');
    const categoryFilterTabs = categoryPanel.querySelector('.inventory-departments');
    if (categoryDirectorySection && categoryFilterLabel && categoryFilterTabs) {
      categoryDirectorySection.querySelector('.section-title-row')?.append(categoryFilterLabel, categoryFilterTabs);
    }
    const departmentTools = document.createElement('form'); departmentTools.className = 'department-editor'; departmentTools.hidden = true; departmentTools.innerHTML = '<label class="department-field"><span>Название цеха</span><input id="inventory-department-name" required maxlength="80" placeholder="Например, Бар"></label><label class="department-field"><span>Назначение</span><input id="inventory-department-description" maxlength="300" placeholder="Что хранится или готовится"></label><button class="button primary" type="submit">Сохранить цех</button><button class="button" type="button" id="cancel-inventory-department">Отмена</button><p class="form-message" id="inventory-department-message"></p>'; document.querySelector('#inventory-department-list').after(departmentTools);
    const subdepartmentTools = document.createElement('form'); subdepartmentTools.className = 'department-editor'; subdepartmentTools.hidden = true; subdepartmentTools.innerHTML = '<label class="department-field"><span>Родительский цех</span><select id="inventory-subdepartment-department"></select></label><label class="department-field"><span>Название подцеха</span><input id="inventory-subdepartment-name" required maxlength="80" placeholder="Например, Прохладительные напитки"></label><button class="button primary" type="submit">Сохранить подцех</button><button class="button" type="button" id="cancel-inventory-subdepartment">Отмена</button><p class="form-message" id="inventory-subdepartment-message"></p>'; const subdepartmentList = document.querySelector('#inventory-subdepartment-list'); subdepartmentList.after(subdepartmentTools);
    inventoryDepartments = [{ id: 'kitchen', name: 'Кухня' }, { id: 'bar', name: 'Бар' }, { id: 'hookah', name: 'Кальяны' }, { id: 'inventory', name: 'Хозяйственный склад' }]; let selectedDepartment = ''; let allInventoryDepartments = []; let allInventorySubdepartments = []; let allProductCategories = []; let inventoryDirectoryStatus = 'active'; let inventoryDeletionRequests = [];
    const syncInventoryHierarchyOptions = () => { const department = document.querySelector('#inventory-item-department')?.value || ''; const subdepartmentOptions = document.querySelector('#inventory-item-subdepartment'); const itemSubdepartment = document.querySelector('#inventory-item-subdepartment')?.value.trim() || ''; const categoryOptions = document.querySelector('#inventory-item-category'); const subdepartments = inventorySubdepartments.filter((item) => !department || String(item.departmentCode) === department); const categories= productCategoryItems.filter((item) => (!department || String(item.department || 'inventory') === department) && (!item.subdepartmentName || item.subdepartmentName === itemSubdepartment)); if (subdepartmentOptions) { const current = subdepartmentOptions.value; subdepartmentOptions.innerHTML = '<option value="">Без подцеха</option>' + subdepartments.map((item) => `<option value="${esc(item.name)}">${esc(displayName(item.name))}</option>`).join(''); if ([...subdepartmentOptions.options].some((option) => option.value === current)) subdepartmentOptions.value = current; } if (categoryOptions) categoryOptions.innerHTML = '<option value="">Выберите категорию</option>' + categories.map((item) => `<option value="${esc(item.id)}">${esc(displayName(item.name))}</option>`).join(''); const categoryDepartment = document.querySelector('#product-category-department')?.value || ''; const categorySubdepartment = document.querySelector('#product-category-subdepartment'); if (categorySubdepartment) { const current = categorySubdepartment.value; const available = inventorySubdepartments.filter((item) => item.departmentCode === categoryDepartment); categorySubdepartment.innerHTML = '<option value="">Весь цех</option>' + available.map((item) => `<option value="${esc(item.id)}">${esc(displayName(item.name))}</option>`).join(''); if ([...categorySubdepartment.options].some((option) => option.value === current)) categorySubdepartment.value = current; } syncAlcoholLinkSelector(); };
    const renderInventoryDepartments = () => { const tabs = document.querySelector('.inventory-departments'); const select = document.querySelector('#product-category-department'); const itemSelect = document.querySelector('#inventory-item-department'); const subdepartmentSelect = document.querySelector('#inventory-subdepartment-department'); if (tabs) tabs.innerHTML = ['<button type="button" class="is-active" data-inventory-department="">Все цеха</button>', ...inventoryDepartments.map((department) => `<button type="button" data-inventory-department="${esc(department.id || department.code)}">${esc(department.name)}</button>`)].join(''); const options = inventoryDepartments.map((department) => `<option value="${esc(department.id || department.code)}">${esc(department.name)}</option>`).join(''); if (select) select.innerHTML = options; if (subdepartmentSelect) { const current = subdepartmentSelect.value; subdepartmentSelect.innerHTML = options; if ([...subdepartmentSelect.options].some((option) => option.value === current)) subdepartmentSelect.value = current; } if (itemSelect) { const current = itemSelect.value; itemSelect.innerHTML = options; if ([...itemSelect.options].some((option) => option.value === current)) itemSelect.value = current; itemSelect.onchange = syncInventoryHierarchyOptions; } syncInventoryHierarchyOptions(); tabs?.querySelectorAll('[data-inventory-department]').forEach((button) => button.addEventListener('click', () => { selectedDepartment = button.dataset.inventoryDepartment || ''; tabs.querySelectorAll('[data-inventory-department]').forEach((item) => item.classList.toggle('is-active', item === button)); drawProductCategories(); })); };
    const archivedView = () => inventoryDirectoryStatus === 'archived';
    const canManageCategoryLifecycle = portalPermissions.has('inventory_categories');
    const inventoryEntityActions = (entityType, id, name, active) => {
      if (!canWriteInventory && !(entityType === 'category' && canManageCategoryLifecycle)) return '';
      if (!active) return `<button type="button" class="button small inventory-restore" data-restore-type="${entityType}" data-restore-id="${esc(id)}">Восстановить</button>${portalUser.role === 'owner' ? `<button type="button" class="button small danger-outline inventory-permanent-delete" data-delete-type="${entityType}" data-delete-id="${esc(id)}" data-delete-name="${esc(name)}">Удалить навсегда</button>` : portalUser.role === 'manager' ? `<button type="button" class="button small danger-outline inventory-request-delete" data-request-type="${entityType}" data-request-id="${esc(id)}" data-request-name="${esc(name)}">Запросить удаление</button>` : ''}`;
      return `<button type="button" class="button small danger-outline inventory-archive" data-archive-type="${entityType}" data-archive-id="${esc(id)}" data-archive-name="${esc(name)}">В архив</button>`;
    };
    const renderInventoryDepartmentList = () => { const list = document.querySelector('#inventory-department-list'); if (!list) return; const items = allInventoryDepartments.filter((item) => archivedView() ? item.active === false : item.active !== false); list.innerHTML = items.length ? items.map((department) => { const id = department.id || department.code; const active = department.active !== false; return `<div class="category-row ${active ? '' : 'is-archived'}"><div><b>${esc(department.name)}</b><small>${esc(department.description || 'Цех склада')} · ${active ? 'Активен' : 'В архиве'}</small></div><div class="toolbar-row"><span class="badge ${active ? 'success' : 'muted'}">Цех</span>${active && canWriteInventory ? `<button type="button" class="button small department-edit" data-department-edit="${esc(id)}" data-department-name="${esc(department.name)}" data-department-description="${esc(department.description || '')}">Изменить</button>` : ''}${inventoryEntityActions('department', id, department.name, active)}</div></div>`; }).join('') : `<div class="empty">${archivedView() ? 'Архивных цехов нет' : 'Цеха ещё не созданы'}</div>`; list.querySelectorAll('[data-department-edit]').forEach((button) => button.addEventListener('click', () => { departmentTools.dataset.editId = button.dataset.departmentEdit; document.querySelector('#inventory-department-name').value = button.dataset.departmentName; document.querySelector('#inventory-department-description').value = button.dataset.departmentDescription; departmentTools.hidden = false; document.querySelector('#inventory-department-name').focus(); })); };
    const drawDeletionRequests = () => { const section = document.querySelector('#inventory-deletion-requests'); if (!section) return; const owner = portalUser.role === 'owner'; const pending = inventoryDeletionRequests.filter((request) => request.status === 'pending'); section.hidden = !pending.length && !owner; section.innerHTML = `<div class="section-title-row"><div><h3>${owner ? 'Запросы на удаление' : 'Ваши запросы на удаление'}</h3><span class="muted">Окончательное удаление требует решения владельца и повторной проверки связей.</span></div></div>${pending.length ? pending.map((request) => `<div class="category-row"><div><b>${esc(request.entityName)}</b><small>${esc({ department: 'Цех', subdepartment: 'Подцех', category: 'Категория' }[request.entityType] || request.entityType)} · ${esc(request.parentName || 'без родителя')} · запросил ${esc(request.requestedByName || 'управляющий')}</small></div><div class="toolbar-row"><span class="badge warning">Ожидает владельца</span>${owner ? `<button type="button" class="button small primary" data-request-decision="approve" data-request-key="${esc(request.id)}" data-request-name="${esc(request.entityName)}">Подтвердить удаление</button><button type="button" class="button small" data-request-decision="reject" data-request-key="${esc(request.id)}">Отклонить</button>` : ''}</div></div>`).join('') : '<div class="empty">Запросов пока нет</div>'}`; section.querySelectorAll('[data-request-decision]').forEach((button) => button.addEventListener('click', async () => { const decision = button.dataset.requestDecision; if (decision === 'approve' && !window.confirm(`Владелец подтверждает окончательное удаление «${button.dataset.requestName}»? Действие необратимо; сервер ещё раз проверит связи.`)) return; button.disabled = true; try { await api(`/api/inventory/deletion-requests/${encodeURIComponent(button.dataset.requestKey)}/${decision}`, { method: 'POST' }); portalNotice(decision === 'approve' ? 'Удаление подтверждено владельцем' : 'Запрос отклонён', 'success'); await Promise.all([loadDeletionRequests(), loadInventoryDirectories()]); } catch (error) { portalNotice(error.payload?.error?.endsWith('_in_use') ? 'Удаление невозможно: запись связана с позициями или историей. Оставьте её в архиве.' : 'Не удалось обработать запрос', 'error'); button.disabled = false; } })); };
    const loadDeletionRequests = () => api('/api/inventory/deletion-requests').then((data) => { inventoryDeletionRequests = data.items || []; drawDeletionRequests(); }).catch(() => { const section = document.querySelector('#inventory-deletion-requests'); if (section) { section.hidden = false; section.innerHTML = '<div class="empty error-message" role="alert">Не удалось загрузить запросы владельцу</div>'; } });
    const drawSubdepartments = () => { const list = document.querySelector('#inventory-subdepartment-list'); if (!list) return; const items = allInventorySubdepartments.filter((item) => archivedView() ? item.active === false : item.active !== false); list.innerHTML = items.length ? items.map((item) => { const active = item.active !== false; return `<div class="category-row ${active ? '' : 'is-archived'}"><div><b>${esc(displayName(item.name))}</b><small>Цех: ${esc(displayName(allInventoryDepartments.find((department) => (department.id || department.code) === item.departmentCode)?.name || item.departmentCode))} · ${active ? 'Активен' : 'В архиве'}</small></div><div class="toolbar-row"><span class="badge ${active ? 'success' : 'muted'}">Подцех</span>${active && canWriteInventory ? `<button type="button" class="button small subdepartment-edit" data-subdepartment-edit="${esc(item.id)}" data-subdepartment-name="${esc(item.name)}" data-subdepartment-department="${esc(item.departmentCode)}">Изменить</button>` : ''}${inventoryEntityActions('subdepartment', item.id, item.name, active)}</div></div>`; }).join('') : `<div class="empty">${archivedView() ? 'Архивных подцехов нет' : 'Подцехи ещё не созданы'}</div>`; list.querySelectorAll('[data-subdepartment-edit]').forEach((button) => button.addEventListener('click', () => { subdepartmentTools.dataset.editId = button.dataset.subdepartmentEdit; document.querySelector('#inventory-subdepartment-name').value = button.dataset.subdepartmentName; document.querySelector('#inventory-subdepartment-department').value = button.dataset.subdepartmentDepartment; subdepartmentTools.hidden = false; document.querySelector('#inventory-subdepartment-name').focus(); })); };
    const loadSubdepartments = () => api('/api/inventory/subdepartments?status=all').then((data) => { allInventorySubdepartments = data.items || []; inventorySubdepartments = allInventorySubdepartments.filter((item) => item.active !== false); refreshInventoryContext(); syncInventoryHierarchyOptions(); drawSubdepartments(); }).catch(() => { const list = document.querySelector('#inventory-subdepartment-list'); if (!list) return; list.innerHTML = '<div class="empty error-message" role="alert">Не удалось загрузить подцехи. <button type="button" class="button small" data-subdepartment-retry>Повторить</button></div>'; list.querySelector('[data-subdepartment-retry]')?.addEventListener('click', loadSubdepartments); });
    const loadInventoryDirectories = async () => { const data = await api('/api/inventory/departments?status=all'); allInventoryDepartments = data.items || []; inventoryDepartments = allInventoryDepartments.filter((item) => item.active !== false); renderInventoryDepartments(); renderInventoryDepartmentList(); const subdepartmentSelect = document.querySelector('#inventory-subdepartment-department'); if (subdepartmentSelect) subdepartmentSelect.innerHTML = inventoryDepartments.map((department) => `<option value="${esc(department.id || department.code)}">${esc(department.name)}</option>`).join(''); await loadSubdepartments(); await loadProductCategories(); };
    document.querySelectorAll('[data-inventory-directory-status]').forEach((button) => button.addEventListener('click', () => { inventoryDirectoryStatus = button.dataset.inventoryDirectoryStatus; document.querySelectorAll('[data-inventory-directory-status]').forEach((item) => { item.classList.toggle('is-active', item === button); item.setAttribute('aria-pressed', String(item === button)); }); renderInventoryDepartmentList(); drawSubdepartments(); drawProductCategories(); }));
    document.querySelector('#inventory-department-list')?.addEventListener('click', async (event) => { const action = event.target.closest('[data-archive-type],[data-restore-type],[data-delete-type],[data-request-type]'); if (!action) return; const entityType = action.dataset.archiveType || action.dataset.restoreType || action.dataset.deleteType || action.dataset.requestType; const entityId = action.dataset.archiveId || action.dataset.restoreId || action.dataset.deleteId || action.dataset.requestId; const name = action.dataset.archiveName || action.dataset.deleteName || action.dataset.requestName || allInventoryDepartments.find((item) => (item.id || item.code) === entityId)?.name || entityId; await runDirectoryAction(action, entityType, entityId, name); });
    document.querySelector('#inventory-subdepartment-list')?.addEventListener('click', async (event) => { const action = event.target.closest('[data-archive-type],[data-restore-type],[data-delete-type],[data-request-type]'); if (!action) return; const entityType = action.dataset.archiveType || action.dataset.restoreType || action.dataset.deleteType || action.dataset.requestType; const entityId = action.dataset.archiveId || action.dataset.restoreId || action.dataset.deleteId || action.dataset.requestId; const name = action.dataset.archiveName || action.dataset.deleteName || action.dataset.requestName || allInventorySubdepartments.find((item) => item.id === entityId)?.name || entityId; await runDirectoryAction(action, entityType, entityId, name); });
    const runDirectoryAction = async (button, entityType, entityId, name) => { const archive = button.hasAttribute('data-archive-type'); const restore = button.hasAttribute('data-restore-type'); const requestDelete = button.hasAttribute('data-request-type'); const permanent = button.hasAttribute('data-delete-type'); if (archive && !(entityType === 'category' && canManageCategoryLifecycle) && !window.confirm(`Переместить «${name}» в архив? Данные и история сохранятся, запись можно будет восстановить.`)) return; if (permanent && !window.confirm(`Удалить «${name}» навсегда? Это можно сделать только если запись больше нигде не используется.`)) return; if (requestDelete && !window.confirm(`Отправить владельцу запрос на окончательное удаление «${name}»? До его решения запись останется в архиве.`)) return; button.disabled = true; try { if (archive) await api(entityType === 'department' ? `/api/inventory/departments/${encodeURIComponent(entityId)}` : entityType === 'subdepartment' ? `/api/inventory/subdepartments/${encodeURIComponent(entityId)}` : `/api/product-categories/${encodeURIComponent(entityId)}`, { method: 'DELETE' }); else if (restore) await api(entityType === 'department' ? `/api/inventory/departments/${encodeURIComponent(entityId)}/restore` : entityType === 'subdepartment' ? `/api/inventory/subdepartments/${encodeURIComponent(entityId)}/restore` : `/api/product-categories/${encodeURIComponent(entityId)}/restore`, { method: 'POST' }); else if (permanent) await api('/api/inventory/permanent-deletions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entityType, entityId }) }); else await api('/api/inventory/deletion-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entityType, entityId }) }); portalNotice(archive ? 'Перемещено в архив' : restore ? 'Запись восстановлена' : permanent ? 'Запись удалена' : 'Запрос отправлен владельцу', 'success'); await Promise.all([loadInventoryDirectories(), loadDeletionRequests()]); } catch (error) { const reason = error.payload?.error; portalNotice(reason === 'inventory_department_in_use' || reason === 'inventory_subdepartment_in_use' || reason === 'inventory_category_in_use' ? 'Нельзя архивировать или удалить: запись ещё связана с позициями либо историей.' : reason === 'inventory_category_parent_inactive' || reason === 'inventory_subdepartment_parent_inactive_or_not_found' ? 'Сначала восстановите родительский цех.' : reason === 'inventory_deletion_request_pending' ? 'Запрос на удаление уже ожидает решения владельца.' : reason === 'inventory_deletion_owner_required' ? 'Это действие может подтвердить только владелец.' : reason === 'inventory_entry_must_be_archived' ? 'Сначала переместите запись в архив.' : 'Не удалось выполнить действие. Проверьте сообщение API и повторите.','error'); button.disabled = false; } };
    document.querySelector('#inventory-deletion-requests')?.addEventListener('click', () => {});
    loadInventoryDirectories().catch(() => { renderInventoryDepartments(); renderInventoryDepartmentList(); }); loadDeletionRequests();
    document.querySelector('#new-inventory-subdepartment')?.addEventListener('click', () => { subdepartmentTools.hidden = false; document.querySelector('#inventory-subdepartment-name')?.focus(); });
    document.querySelector('#cancel-inventory-subdepartment')?.addEventListener('click', () => { subdepartmentTools.reset(); delete subdepartmentTools.dataset.editId; subdepartmentTools.hidden = true; });
    subdepartmentTools.addEventListener('submit', (event) => { event.preventDefault(); const name = document.querySelector('#inventory-subdepartment-name').value.trim(); const departmentCode = document.querySelector('#inventory-subdepartment-department').value; const message = document.querySelector('#inventory-subdepartment-message'); const editId = subdepartmentTools.dataset.editId; api(editId ? `/api/inventory/subdepartments/${encodeURIComponent(editId)}` : '/api/inventory/subdepartments', { method: editId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, departmentCode }) }).then(async () => { subdepartmentTools.reset(); delete subdepartmentTools.dataset.editId; subdepartmentTools.hidden = true; portalNotice(editId ? 'Подцех изменён' : 'Подцех создан', 'success'); await loadSubdepartments(); await loadProductCategories(); }).catch((error) => { message.textContent = error.payload?.error === 'inventory_subdepartment_exists' ? 'Такой подцех уже существует' : 'Не удалось сохранить подцех'; message.className = 'form-message error-message'; }); });
    document.querySelector('#new-inventory-department')?.addEventListener('click', () => { departmentTools.reset(); delete departmentTools.dataset.editId; departmentTools.hidden = false; document.querySelector('#inventory-department-name')?.focus(); });
    document.querySelector('#cancel-inventory-department')?.addEventListener('click', () => { departmentTools.reset(); delete departmentTools.dataset.editId; departmentTools.hidden = true; });
    departmentTools.addEventListener('submit', (event) => { event.preventDefault(); const name = document.querySelector('#inventory-department-name').value.trim(); const description = document.querySelector('#inventory-department-description').value.trim(); const message = document.querySelector('#inventory-department-message'); const code = name.toLocaleLowerCase('ru-RU').replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || `department-${Date.now()}`; const editId = departmentTools.dataset.editId; api(editId ? `/api/inventory/departments/${encodeURIComponent(editId)}` : '/api/inventory/departments', { method: editId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description, code }) }).then(async () => { departmentTools.reset(); delete departmentTools.dataset.editId; departmentTools.hidden = true; portalNotice(editId ? 'Цех изменён' : 'Цех создан', 'success'); await loadInventoryDirectories(); }).catch((error) => { message.textContent = error.payload?.error === 'inventory_department_exists' ? 'Такой цех уже существует' : 'Не удалось сохранить цех'; message.className = 'form-message error-message'; }); });
    const drawProductCategories = () => { const list = document.querySelector('#product-category-list'); const datalist = document.querySelector('#product-category-options'); const source = archivedView() ? allProductCategories.filter((item) => item.active === false) : productCategoryItems; const visibleCategories = selectedDepartment ? source.filter((item) => (item.department || 'inventory') === selectedDepartment) : source; if (datalist) datalist.innerHTML = productCategoryItems.map((item) => `<option value="${esc(displayName(item.name))}"></option>`).join(''); syncInventoryHierarchyOptions(); list.innerHTML = visibleCategories.length ? visibleCategories.map((item) => { const active = item.active !== false; const parentDepartment = allInventoryDepartments.find((department) => (department.id || department.code) === (item.department || 'inventory')); return `<div class="category-row ${active ? '' : 'is-archived'}"><div><b>${esc(displayName(item.name))}</b><small>${esc(parentDepartment?.name || 'Хозяйственный склад')}${item.subdepartmentName ? ` → ${esc(displayName(item.subdepartmentName))}` : ' → весь цех'} · группа позиций · ${active ? 'Активная категория' : 'В архиве'}</small></div><div class="toolbar-row">${active && canWriteInventory ? `<button class="button small product-category-edit" type="button" data-category="${esc(item.id)}">Изменить</button>` : ''}${inventoryEntityActions('category', item.id, item.name, active)}</div></div>`; }).join('') : `<div class="empty">${archivedView() ? 'Архивных категорий нет' : 'Категории не найдены'}</div>`; };
    const loadProductCategories = () => api('/api/product-categories?status=all').then((data) => { allProductCategories = data.items || []; productCategoryItems = allProductCategories.filter((item) => item.active !== false); drawProductCategories(); refreshInventoryContext(); }).catch(() => { const list = document.querySelector('#product-category-list'); if (list) list.innerHTML = '<div class="empty error-message" role="alert">Не удалось загрузить категории. <button type="button" class="button small" data-category-retry>Повторить</button></div>'; list?.querySelector('[data-category-retry]')?.addEventListener('click', loadProductCategories); });
    const categoryForm = document.querySelector('#product-category-form'); const categoryArchiveButton = document.querySelector('#delete-product-category'); if (categoryArchiveButton) categoryArchiveButton.textContent = 'В архив'; const resetCategory = () => { categoryForm.reset(); document.querySelector('#product-category-id').value = ''; document.querySelector('#delete-product-category').hidden = true; categoryForm.hidden = true; };
    document.querySelectorAll('[data-inventory-department]').forEach((button) => button.addEventListener('click', () => { selectedDepartment = button.dataset.inventoryDepartment || ''; document.querySelectorAll('[data-inventory-department]').forEach((item) => item.classList.toggle('is-active', item === button)); drawProductCategories(); })); document.querySelector('#new-product-category').addEventListener('click', () => { resetCategory(); const departmentSelect = document.querySelector('#product-category-department'); if (departmentSelect && selectedDepartment && [...departmentSelect.options].some((option) => option.value === selectedDepartment)) departmentSelect.value = selectedDepartment; syncInventoryHierarchyOptions(); categoryForm.hidden = false; document.querySelector('#product-category-name').focus(); }); document.querySelector('#cancel-product-category').addEventListener('click', resetCategory);
    document.querySelector('#product-category-list').addEventListener('click', async (event) => { const action = event.target.closest('[data-archive-type],[data-restore-type],[data-delete-type],[data-request-type]'); if (action) { const entityType = action.dataset.archiveType || action.dataset.restoreType || action.dataset.deleteType || action.dataset.requestType; const entityId = action.dataset.archiveId || action.dataset.restoreId || action.dataset.deleteId || action.dataset.requestId; const item = allProductCategories.find((entry) => entry.id === entityId); return runDirectoryAction(action, entityType, entityId, action.dataset.archiveName || action.dataset.deleteName || action.dataset.requestName || item?.name || entityId); } const button = event.target.closest('.product-category-edit'); if (!button) return; const item = productCategoryItems.find((entry) => entry.id === button.dataset.category); if (!item) return; categoryForm.hidden = false; document.querySelector('#product-category-id').value = item.id; document.querySelector('#product-category-name').value = item.name; document.querySelector('#product-category-department').value = item.department || 'inventory'; syncInventoryHierarchyOptions(); document.querySelector('#product-category-subdepartment').value = item.subdepartmentId || ''; document.querySelector('#delete-product-category').hidden = false; });
    document.querySelector('#inventory-item-department')?.addEventListener('change', syncInventoryHierarchyOptions);
    document.querySelector('#inventory-item-subdepartment')?.addEventListener('change', syncInventoryHierarchyOptions);
    document.querySelector('#product-category-department')?.addEventListener('change', () => { document.querySelector('#product-category-subdepartment').value = ''; syncInventoryHierarchyOptions(); });
    categoryForm.addEventListener('submit', (event) => { event.preventDefault(); const id = document.querySelector('#product-category-id').value; const message = document.querySelector('#product-category-message'); api(id ? `/api/product-categories/${encodeURIComponent(id)}` : '/api/product-categories', { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: document.querySelector('#product-category-name').value.trim(), department: document.querySelector('#product-category-department').value, subdepartmentId: document.querySelector('#product-category-subdepartment').value || null }) }).then(() => { resetCategory(); loadProductCategories(); portalNotice('Категория сохранена', 'success'); }).catch((error) => { const reason = error.payload?.error; message.textContent = reason === 'product_category_exists' ? 'Такая категория уже есть' : reason === 'inventory_department_not_found' ? 'Выбранный цех больше не доступен. Обновите список цехов и попробуйте снова.' : reason === 'inventory_subdepartment_not_found' ? 'Выбранный подцех больше не доступен. Обновите список и повторите.' : reason === 'inventory_hierarchy_unavailable' ? 'Не удалось проверить справочник цехов. Повторите попытку.' : 'Не удалось сохранить категорию'; message.className = 'form-message error-message'; }); });
    document.querySelector('#delete-product-category').addEventListener('click', () => { const id = document.querySelector('#product-category-id').value; const item = productCategoryItems.find((entry) => entry.id === id); if (!id || !window.confirm(`Переместить категорию «${item?.name || ''}» в архив?`)) return; api(`/api/product-categories/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => { resetCategory(); portalNotice('Категория перемещена в архив', 'success'); return loadInventoryDirectories(); }).catch((error) => portalNotice(error.payload?.error === 'inventory_category_in_use' ? 'Сначала переместите складские позиции из этой категории.' : 'Не удалось архивировать категорию', 'error')); });
  }
    const productPlaceholder = (item) => { const name = displayName(item.name || 'Позиция'); const category = displayName(item.category || item.station || 'Каталог'); const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toLocaleUpperCase('ru-RU'); const palette = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5 + 1; return `<div class="visual-product-placeholder palette-${palette}" aria-label="Превью ${esc(name)}"><strong>${esc(initials || '•')}</strong><span>${esc(category)}</span></div>`; };
  let pendingProductImage = null;
  let productImageChanged = false;
  const normalizeInventorySearch = (value) => String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const syncProductPreview = () => {
    const preview = document.querySelector('#product-image-preview');
    if (!preview) return;
    const name = document.querySelector('#product-name')?.value.trim() || 'Новый товар';
    const category = document.querySelector('#product-category')?.value.trim() || 'Каталог';
    preview.innerHTML = pendingProductImage ? `<img src="${esc(pendingProductImage)}" alt="Превью ${esc(name)}">` : productPlaceholder({ name, category });
  };
  const setProductEditorMode = (item = null) => {
    const form = document.querySelector('#product-form');
    if (!form || form.dataset.submitting === '1') return;
    form.dataset.imageGeneration = String(Number(form.dataset.imageGeneration || 0) + 1);
    form.dataset.imageProcessing = '0';
    const addButton = document.querySelector('#new-product');
    if (addButton) { addButton.disabled = true; addButton.textContent = 'Форма открыта'; }
    const editing = Boolean(item);
    form.hidden = false;
    document.querySelector('#product-form-title').textContent = editing ? 'Редактирование товара' : 'Новый товар';
    document.querySelector('#product-form-hint').textContent = editing ? 'Измените данные и сохраните — карточка обновится во всех заказах.' : 'Заполните основные данные — товар сразу появится в заказах.';
    document.querySelector('#product-form-status').textContent = editing ? 'Изменение' : 'Черновик';
    document.querySelector('#product-id').value = item?.id || '';
    document.querySelector('#product-name').value = item?.name || '';
    document.querySelector('#product-category').value = item?.category || item?.station || '';
    document.querySelector('#product-price').value = item?.price ?? '';
    const inventoryModeSelect = document.querySelector('#product-inventory-mode');
    if (inventoryModeSelect) {
      inventoryModeSelect.innerHTML = '<option value="tracked">Списывать по техкарте</option><option value="non_stock">Без складского списания</option>' + (item?.inventoryMode === 'needs_review' ? '<option value="needs_review">Нужно проверить</option>' : '');
      inventoryModeSelect.value = item?.inventoryMode || 'tracked';
    }
    document.querySelector('#product-aliases').value = (item?.aliases || []).join(', ');
    document.querySelector('#delete-product').hidden = !editing;
    document.querySelector('#save-product').textContent = editing ? 'Сохранить изменения' : 'Сохранить товар';
    pendingProductImage = item?.imageUrl || null;
    productImageChanged = false;
    const imageInput = document.querySelector('#product-image-file');
    if (imageInput) imageInput.value = '';
    syncProductPreview();
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.querySelector('#product-name').focus();
  };
  const syncRecipeProductOptions = () => {
    const select = document.querySelector('#recipe-product');
    if (!select) return;
    const selected = select.value;
    select.innerHTML = '<option value="">Без привязки к каталогу</option>' + productItems.map((item) => `<option value="${esc(item.id)}">${esc(displayName(item.name))} · ${money(item.price)}</option>`).join('');
    if (selected && (productItems.some((item) => item.id === selected) || recipeItems.some((item) => item.productId === selected))) select.value = selected;
  };
  const drawProducts = (items = productItems) => {
    productItems = Array.isArray(items) ? items : [];
    const grid = document.querySelector('#visual-catalog');
    if (!grid) return;
    const query = normalizeInventorySearch(document.querySelector('#product-search')?.value);
    const visible = productItems.filter((item) => normalizeInventorySearch([item.name, item.category, ...(item.aliases || [])].join(' ')).includes(query));
    const emptyMessage = productItems.length
      ? '<strong>По запросу ничего не найдено</strong><small>Измените поисковый запрос и попробуйте ещё раз.</small>'
      : '<strong>Каталог пока пуст</strong><small>Добавьте первый товар — он появится в заказах.</small>';
    grid.innerHTML = visible.length ? visible.map((item) => `<article class="visual-product" data-product-id="${esc(item.id)}"><div class="visual-product-image">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="${esc(displayName(item.name))}">` : productPlaceholder(item)}</div><div class="visual-product-copy"><b>${esc(displayName(item.name))}</b><small>${money(item.price)} · ${esc(displayName(item.category || item.station || 'Без категории'))}</small>${item.inventoryMode === 'needs_review' ? '<em class="badge warning product-inventory-warning">Нужно проверить складской учёт</em>' : item.inventoryMode === 'non_stock' ? '<em class="badge info product-inventory-warning">Без складского списания</em>' : ''}</div><div class="product-card-actions">${canWriteInventory ? `<button class="button small product-edit" type="button" data-product="${esc(item.id)}" aria-label="Изменить ${esc(displayName(item.name))}">Изменить</button>` : ''}<label class="upload-button">${item.imageUrl ? 'Заменить фото' : 'Загрузить фото'}<input type="file" accept="image/png,image/jpeg,image/webp" data-product="${esc(item.id)}" hidden></label></div></article>`).join('') : `<div class="empty visual-catalog-empty product-catalog-empty">${emptyMessage}</div>`;
    grid.querySelectorAll('input[type=file]').forEach((input) => input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 1_500_000) { portalNotice('Фото товара: PNG, JPG или WebP до 1,5 МБ', 'error'); input.value = ''; return; }
      const card = input.closest('.visual-product');
      input.disabled = true;
      compressUploadedImage(file, 640).then((imageData) => {
        const preview = card?.querySelector('.visual-product-image');
        if (preview) preview.innerHTML = `<img src="${esc(imageData)}" alt="Предпросмотр">`;
        return api(`/api/products/${encodeURIComponent(input.dataset.product)}/image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageData }) });
      }).then(() => api('/api/products')).then((data) => { drawProducts(data.items); portalNotice('Фото товара сохранено', 'success'); }).catch(() => { input.disabled = false; portalNotice('Не удалось обработать или сохранить фото товара', 'error'); });
    }));
    grid.querySelectorAll('.product-edit').forEach((button) => button.addEventListener('click', () => {
      const item = productItems.find((entry) => entry.id === button.dataset.product);
      if (item && document.querySelector('#product-form')?.dataset.submitting !== '1') setProductEditorMode(item);
    }));
    syncRecipeProductOptions();
  };
  api('/api/products').then((data) => { drawProducts(data.items); renderRecipes(); }).catch(() => { document.querySelector('#visual-catalog').innerHTML = '<div class="empty">Не удалось загрузить каталог</div>'; portalNotice('Не удалось загрузить каталог', 'error'); }); document.querySelector('#product-search')?.addEventListener('input', () => drawProducts());
  const recipes = document.createElement('section'); recipes.className = 'panel recipes-panel inventory-view-section'; recipes.innerHTML = `<div class="panel-head"><div><h2>Технологические карты</h2><span class="muted">Состав, нормы расхода, приготовление и подача</span></div><div class="toolbar-row"><span class="badge" id="recipe-count">Загрузка…</span>${canWriteInventory ? '<button class="button small primary" type="button" id="new-recipe">+ Новая карта</button>' : ''}</div></div><div class="recipe-directory-toolbar"><label class="recipe-search-field">Поиск по названию, категории, товару или ингредиенту<input id="recipe-search" type="search" placeholder="Например, лимонад, кальяны или мята" autocomplete="off"></label><label>Категория<select id="recipe-category-filter"><option value="">Все категории</option></select></label></div>${canWriteInventory ? '<form id="recipe-form" class="product-editor recipe-wizard" hidden><input type="hidden" id="recipe-id"><div class="recipe-wizard-steps" role="tablist" aria-label="Этапы технологической карты"><button type="button" role="tab" aria-selected="true" class="is-active" data-recipe-step="1">1. Карточка</button><button type="button" role="tab" aria-selected="false" data-recipe-step="2">2. Состав</button><button type="button" role="tab" aria-selected="false" data-recipe-step="3">3. Приготовление</button><button type="button" role="tab" aria-selected="false" data-recipe-step="4">4. Проверка</button></div><p class="muted recipe-wizard-hint" id="recipe-wizard-hint">Укажите, что продаём: блюдо, напиток, кальян или заготовку.</p><label class="recipe-field" data-recipe-stage="1"><span>Название позиции <span class="required-mark">*</span></span><input id="recipe-name" required maxlength="120" placeholder="Например, Виски-кола или Кальян «Киви»"></label><label class="recipe-field" data-recipe-stage="1"><span>Категория техкарты</span><input id="recipe-category" maxlength="80" list="recipe-category-suggestions" placeholder="Например, Коктейли или Кальяны"><datalist id="recipe-category-suggestions"></datalist><small class="field-hint">Категории помогают группировать карты; можно выбрать существующую или ввести новую.</small></label><label class="recipe-field" data-recipe-stage="1"><span>Товар в меню</span><select id="recipe-product"><option value="">Без привязки к каталогу</option></select><small class="field-hint">Свяжите технологическую карту с карточкой продажи, чтобы списание и себестоимость совпадали.</small></label><label class="recipe-field" data-recipe-stage="1"><span>Назначение карты</span><select id="recipe-type"><option value="sale">Продажная позиция</option><option value="premix">Премикс / заготовка</option></select><small class="field-hint">Премикс готовится отдельной партией и автоматически списывает ингредиенты.</small></label><div class="form-row recipe-output-fields" data-recipe-stage="1"><label><span>Выход <span class="required-mark">*</span></span><input id="recipe-yield-quantity" type="number" min="0.001" max="100000" step="0.001" value="1" required placeholder="Например, 1"></label><label><span>Единица выхода <span class="required-mark">*</span></span><select id="recipe-yield-unit" required><option value="порция">Порция</option><option value="л">Литр</option><option value="мл">Миллилитр</option><option value="кг">Килограмм</option><option value="г">Грамм</option><option value="шт">Штука</option></select></label><label><span>Порций / единиц продажи <span class="required-mark">*</span></span><input id="recipe-portion-count" type="number" min="1" max="100000" step="1" value="1" required placeholder="Например, 1"></label></div><small class="field-hint recipe-output-hint" data-recipe-stage="1">Пример: выход 1 порция и 1 единица продажи. Для заготовки укажите общий выход, например 2 л.</small><label class="recipe-field" data-recipe-stage="2"><span>Ингредиенты <span class="required-mark">*</span></span><textarea id="recipe-ingredients" rows="4" placeholder="Ингредиенты добавляются из складского справочника" required></textarea><small class="field-hint">Добавьте все позиции, которые списываются на одну порцию или единицу продажи.</small></label><label class="recipe-field" data-recipe-stage="3"><span>Технология приготовления</span><textarea id="recipe-technology" rows="4" placeholder="Опишите порядок приготовления, чтобы сотрудник мог повторить рецепт без подсказок"></textarea></label><label class="recipe-field" data-recipe-stage="3"><span>Подача</span><textarea id="recipe-serve" rows="2" placeholder="Посуда, украшение, температура подачи"></textarea></label><div id="recipe-cost-summary" class="recipe-cost-summary" data-recipe-stage="4"><div><b>Проверка карты</b><span class="muted">Себестоимость рассчитывается по текущим ценам склада.</span></div><strong id="recipe-total-cost">—</strong><div id="recipe-cost-per-portion" class="muted"></div><div id="recipe-cost-lines" class="recipe-cost-lines"></div></div><div class="recipe-wizard-nav"><button class="button" id="recipe-wizard-back" type="button">Назад</button><button class="button primary" id="recipe-wizard-next" type="button">Далее</button></div><div class="toolbar-row" data-recipe-stage="4"><button class="button primary" type="submit">Сохранить карту</button><button class="button" id="cancel-recipe" type="button">Отмена</button><button class="button danger-outline" id="delete-recipe" type="button" hidden>Удалить</button></div><p class="form-message" id="recipe-message"></p></form>' : ''}<div id="recipe-grid" class="recipe-grid"><div class="empty">Загрузка рецептур…</div></div>`; target.append(recipes);
  const premixPanel = document.createElement('section'); premixPanel.className = 'panel premix-panel inventory-view-section'; premixPanel.innerHTML = `<div class="panel-head"><div><h2>Заготовки и премиксы</h2><span class="muted">${canWriteInventory ? 'Выберите карту и приготовьте партию. Сырьё спишется по сроку годности, готовый фактический выход поступит на склад.' : 'Просматривайте остатки партий, срок годности и себестоимость.'}</span></div><span class="badge info">Складская заготовка</span></div>${canWriteInventory ? '<div class="empty premix-setup-guidance" id="premix-empty-guidance" role="status"><strong>Проверяем доступные техкарты и складские позиции…</strong></div><form id="premix-form" class="stack-form"><div class="form-row"><label>Технологическая карта премикса<select id="premix-recipe" required disabled><option value="">Выберите технологическую карту премикса</option></select></label><label>Куда оприходовать<select id="premix-output" required disabled><option value="">Выберите складскую позицию</option></select></label></div><label>Количество партий<input id="premix-multiplier" type="number" min="0.000001" step="0.000001" value="1" required disabled><small class="field-hint">1 партия = выход техкарты. Фактический выход можно уточнить после приготовления.</small></label><div class="form-row"><label>Фактический выход<input id="premix-actual-output" type="number" min="0.000001" step="0.000001" placeholder="По норме техкарты" disabled></label><label>Годен до<input id="premix-expires-at" type="datetime-local" disabled></label></div><button class="button primary" id="premix-submit" type="submit" disabled>Приготовить премикс</button><p class="form-message" id="premix-message"></p></form>' : '<p class="muted">Приготовление, списание и инвентаризация доступны сотруднику с правом управления складом.</p>'}<div class="section-title-row"><div><h3>Последние партии</h3><span class="muted">Остатки распределяются по партиям; для списания применяется FEFO, затем FIFO.</span></div></div><div id="premix-batches" class="premix-batches"><div class="empty">Загрузка партий…</div></div>`; target.append(premixPanel);
  document.querySelector('#premix-empty-guidance')?.addEventListener('click', (event) => {
    const retry = event.target.closest('[data-premix-retry]');
    if (retry) { retry.disabled = true; retry.textContent = 'Загружаем…'; loadPremixData(); return; }
    if (event.target.closest('[data-premix-create-recipe]')) {
      const newRecipe = document.querySelector('#new-recipe');
      const form = document.querySelector('#recipe-form');
      if (!newRecipe || newRecipe.disabled || form?.dataset.submitting === '1') return;
      setInventoryView('recipes');
      newRecipe.click();
      if (form?.hidden) return;
      const type = document.querySelector('#recipe-type');
      type.value = 'premix';
      type.dispatchEvent(new Event('change', { bubbles: true }));
      type._customSelectRefresh?.();
      document.querySelector('#recipe-product')?._customSelectRefresh?.();
      return;
    }
    if (event.target.closest('[data-premix-create-stock]')) { setInventoryView('stock'); document.querySelector('#new-inventory-item')?.click(); }
  });
  const loadPremixData = () => {
    const recipeSelect = document.querySelector('#premix-recipe'); const outputSelect = document.querySelector('#premix-output'); const canManagePremixes = Boolean(recipeSelect && outputSelect);
    const dataPromise = canManagePremixes ? Promise.all([api('/api/recipes'), api('/api/inventory'), api('/api/inventory/premixes')]) : Promise.all([Promise.resolve({ items: [] }), Promise.resolve({ items: [] }), api('/api/inventory/premixes')]);
    return dataPromise.then(([recipeData, inventoryData, batchData]) => {
      const premixRecipes = (recipeData.items || []).filter((item) => (item.recipeType || 'sale') === 'premix');
      if (recipeSelect) recipeSelect.innerHTML = '<option value="">Выберите технологическую карту премикса</option>' + premixRecipes.map((item) => `<option value="${esc(item.id)}">${esc(displayName(item.name))} · выход ${esc(String(item.yieldQuantity || 1))} ${esc(item.yieldUnit || '')}</option>`).join('');
      if (outputSelect) outputSelect.innerHTML = '<option value="">Выберите складскую позицию</option>' + (inventoryData.items || []).map((item) => `<option value="${esc(item.id)}">${esc(displayName(item.name))} · ${esc(item.unit || '')}</option>`).join('');
      const list = document.querySelector('#premix-batches'); const batches = batchData.items || []; const canProduce = canManagePremixes && premixRecipes.length > 0 && (inventoryData.items || []).length > 0;
      const premixForm = document.querySelector('#premix-form');
      if (premixForm) premixForm.dataset.canProduce = String(canProduce);
      premixForm?.querySelectorAll('select,input,button[type=submit]').forEach((control) => { control.disabled = !canProduce || (control.matches('button[type=submit]') && premixForm.dataset.submitting === '1'); });
      const guidance = document.querySelector('#premix-empty-guidance');
      if (guidance) {
        guidance.classList.remove('auto-order-load-error'); guidance.removeAttribute('role'); guidance.hidden = canProduce;
        guidance.innerHTML = premixRecipes.length ? '<strong>Нет складской позиции для готового премикса</strong><small>Создайте складскую позицию, куда будет оприходован результат.</small><button class="button small" type="button" data-premix-create-stock>Добавить позицию</button>' : '<strong>Сначала создайте техкарту премикса</strong><small>Откройте «Технологические карты», создайте карту и выберите назначение «Премикс / заготовка».</small>' + (canWriteInventory ? '<button class="button small" type="button" data-premix-create-recipe>Создать техкарту премикса</button>' : '');
      }
      if (list) list.innerHTML = batches.length ? batches.map((batch) => { const recipeName = batch.recipeName || premixRecipes.find((recipe) => String(recipe.id) === String(batch.recipeId))?.name || batch.recipeId; const remaining = Number(batch.remainingQuantity ?? batch.outputQuantity ?? 0); return `<div class="premix-batch-row" data-premix-batch="${esc(batch.id || '')}"><div><b>${esc(displayName(recipeName))}</b><small>Факт: ${esc(String(batch.outputQuantity || 0))} ${esc(batch.outputUnit || '')} · план: ${esc(String(batch.plannedOutputQuantity ?? batch.outputQuantity ?? 0))} ${esc(batch.outputUnit || '')}</small><small>Остаток: <b>${esc(String(remaining))} ${esc(batch.outputUnit || '')}</b> · ${batch.expiresAt ? `${batch.expired ? 'Просрочено' : 'Годен до'} ${new Date(batch.expiresAt).toLocaleString('ru-RU')}` : 'Срок годности не указан'}</small><small>Приготовил: ${esc(batch.producedBy || 'Сотрудник не указан')} · ${new Date(batch.createdAt).toLocaleString('ru-RU')}</small></div><div class="premix-batch-actions"><strong>${money(batch.totalCost || 0)}</strong>${canWriteInventory && batch.status !== 'voided' ? `<div class="form-row"><label>Пересчёт<input type="number" min="0" step="0.000001" value="${esc(String(remaining))}" data-premix-count></label><button class="button small" type="button" data-premix-action="count">Сверить</button></div><div class="form-row"><label>Порча, ${esc(batch.outputUnit || '')}<input type="number" min="0.000001" max="${esc(String(remaining))}" step="0.000001" data-premix-waste></label><button class="button small danger-outline" type="button" data-premix-action="waste">Списать</button></div><button class="button small danger-outline" type="button" data-premix-action="void" ${!batch.outputMovementId || Math.abs(remaining-Number(batch.outputQuantity||0)) > 0.000001 ? 'disabled title="Старую партию или партию после складских операций нельзя отменить"' : ''}>Отменить выпуск</button>` : batch.status === 'voided' ? '<span class="badge">Выпуск отменён</span>' : ''}</div></div>`; }).join('') : '<div class="empty">Партии ещё не приготовлены</div>';
      refreshInventoryContext();
    }).catch(() => {
      const premixForm = document.querySelector('#premix-form');
      if (premixForm) premixForm.dataset.canProduce = 'false';
      premixForm?.querySelectorAll('select,input,button[type=submit]').forEach((control) => { control.disabled = true; });
      const guidance = document.querySelector('#premix-empty-guidance');
      if (guidance) { guidance.hidden = false; guidance.classList.add('auto-order-load-error'); guidance.setAttribute('role', 'alert'); guidance.innerHTML = '<strong>Не удалось загрузить данные премиксов</strong><small>Список техкарт, складских позиций или партий недоступен. Проверьте соединение и повторите загрузку.</small><button class="button small" type="button" data-premix-retry>Повторить загрузку</button>'; }
      const list = document.querySelector('#premix-batches'); if (list) list.innerHTML = '<div class="empty" role="status">История партий временно недоступна</div>';
      refreshInventoryContext();
    });
  }; loadPremixData(); document.querySelector('#premix-form')?.addEventListener('submit', (event) => { event.preventDefault(); const form = event.currentTarget; if (form.dataset.submitting === '1' || form.dataset.canProduce !== 'true') return; form.dataset.submitting = '1'; const submit = form.querySelector('button[type=submit]'); const idleLabel = submit.textContent; const actual = document.querySelector('#premix-actual-output').value; const expiry = document.querySelector('#premix-expires-at').value; const payload = { recipeId: document.querySelector('#premix-recipe').value, outputItemId: document.querySelector('#premix-output').value, multiplier: Number(document.querySelector('#premix-multiplier').value), ...(actual ? { actualOutput: Number(actual) } : {}), ...(expiry ? { expiresAt: new Date(expiry).toISOString() } : {}) }; submit.disabled = true; submit.textContent = 'Приготовление…'; const message = document.querySelector('#premix-message'); api('/api/inventory/premixes/produce', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then((batch) => { message.textContent = `Партия приготовлена: ${batch.outputQuantity || ''} ${batch.outputUnit || ''}`; message.className = 'form-message success-message'; return loadPremixData().then(() => load()); }).catch((error) => { const code = error.payload?.error || error.message; message.textContent = code === 'insufficient_premix_stock' ? 'Недостаточно ингредиентов на складе' : code === 'expired_premix_stock' ? 'Недостаточно годных партий сырья' : code === 'premix_output_unit_mismatch' ? `Единица выхода ${error.payload?.sourceUnit || ''} не совместима с единицей складской позиции ${error.payload?.targetUnit || ''}` : code === 'recipe_ingredient_unit_mismatch' ? `Единица ингредиента «${error.payload?.ingredient || 'из техкарты'}» (${error.payload?.sourceUnit || ''}) не совместима с единицей склада (${error.payload?.targetUnit || ''})` : code === 'invalid_recipe_quantity' ? 'Проверьте количество и единицу измерения в техкарте премикса' : code === 'premix_ingredient_not_found' ? 'Ингредиент техкарты не найден на складе. Обновите техкарту.' : code === 'premix_output_cannot_be_an_ingredient' ? 'Нельзя выбрать одну позицию одновременно как ингредиент и результат' : 'Не удалось приготовить премикс'; message.className = 'form-message error-message'; }).finally(() => { form.dataset.submitting = '0'; submit.disabled = form.dataset.canProduce !== 'true'; submit.textContent = idleLabel; }); });
  document.querySelector('#premix-batches')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-premix-action]'); if (!button || button.disabled || !canWriteInventory) return;
    const row = button.closest('[data-premix-batch]'); const action = button.dataset.premixAction;
    if (action === 'void' && !window.confirm('Отменить выпуск? Система вернёт сырьё на склад. Отмена возможна только до дальнейших операций с этой позицией.')) return;
    const reason = action === 'void' ? (window.prompt('Причина отмены выпуска', 'Ошибка выпуска') || '').trim() : (window.prompt(action === 'waste' ? 'Причина списания порчи' : 'Причина сверки остатка', action === 'waste' ? 'Порча' : 'Инвентаризация') || '').trim();
    if (action !== 'void' && !reason) return;
    const payload = { reason };
    if (action === 'count') payload.actualQuantity = Number(row.querySelector('[data-premix-count]')?.value);
    if (action === 'waste') payload.quantity = Number(row.querySelector('[data-premix-waste]')?.value);
    button.disabled = true;
    api(`/api/inventory/premixes/${encodeURIComponent(row.dataset.premixBatch)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(() => Promise.all([loadPremixData(), load()])).catch((error) => { portalNotice(error.payload?.error === 'premix_batch_cannot_be_voided_after_stock_activity' ? 'Партию нельзя отменить после складских операций' : 'Операцию с партией выполнить не удалось', 'error'); button.disabled = false; });
  });

  if (canWriteInventory) {
    syncRecipeProductOptions();
    const ingredientField = recipes.querySelector('#recipe-ingredients');
    if (ingredientField) {
      const picker = document.createElement('div');
      picker.className = 'recipe-ingredient-picker'; picker.dataset.recipeStage = '2';
      picker.innerHTML = '<div class="form-row"><label><span>Складская позиция</span><select id="recipe-ingredient-select"><option value="">Выберите ингредиент</option></select></label><label><span>Количество на порцию</span><input id="recipe-ingredient-quantity" inputmode="decimal" placeholder="Например, 50 мл"><small class="field-hint">Укажите число и единицу: 50 мл, 10 г или 2 шт.</small></label></div><button type="button" class="button small" id="recipe-add-ingredient">Добавить ингредиент</button><div id="recipe-linked-ingredients" class="recipe-linked-ingredients"></div><small class="muted">Позиции выбираются из склада и сохраняются с привязкой к реальному остатку.</small>';
      ingredientField.parentElement.insertBefore(picker, ingredientField);
      ingredientField.hidden = true;
      const renderLinkedIngredients = () => {
        const list = document.querySelector('#recipe-linked-ingredients'); if (!list) return;
        const values = String(ingredientField.value || '').split('\n').map((line) => line.trim()).filter(Boolean);
        list.innerHTML = values.length ? values.map((line, index) => { const separator = line.indexOf(' — '); const name = separator < 0 ? line : line.slice(0, separator); const rest = separator < 0 ? '' : line.slice(separator); return '<div class="recipe-linked-row"><span>' + esc(displayName(name)) + esc(rest) + '</span><button type="button" class="button small danger-outline" data-recipe-remove="' + index + '">Удалить</button></div>'; }).join('') : '<span class="recipe-linked-empty muted">Ингредиенты пока не добавлены.</span>';
        list.querySelectorAll('[data-recipe-remove]').forEach((button) => button.addEventListener('click', () => {
          const next = values.filter((_, row) => row !== Number(button.dataset.recipeRemove)); ingredientField.value = next.join('\n'); renderLinkedIngredients();
        }));
      };
      ingredientField.addEventListener('input', renderLinkedIngredients);
      api('/api/inventory').then((data) => {
        recipeInventoryItems = data.items || [];
        const select = document.querySelector('#recipe-ingredient-select');
        if (select) select.innerHTML = '<option value="">Выберите ингредиент</option>' + recipeInventoryItems.map((item) => '<option value="' + esc(item.id) + '">' + esc(displayName(item.name)) + ' · ' + esc(item.unit || 'шт') + '</option>').join('');
      }).catch(() => {});
      document.querySelector('#recipe-add-ingredient')?.addEventListener('click', () => {
        const select = document.querySelector('#recipe-ingredient-select'); const quantity = document.querySelector('#recipe-ingredient-quantity');
        const item = recipeInventoryItems.find((entry) => entry.id === select?.value);
        if (!item || !quantity?.value.trim()) { portalNotice('Выберите складскую позицию и укажите количество', 'error'); return; }
        const line = item.name + ' — ' + quantity.value.trim() + ' [' + item.id + ']';
        ingredientField.value = ingredientField.value.trim() + (ingredientField.value.trim() ? '\n' : '') + line;
        quantity.value = ''; select.value = ''; renderLinkedIngredients();
      });
      renderLinkedIngredients();
    }
  }
  let setRecipeStep = () => {};
  if (canWriteInventory) {
    const form = document.querySelector('#recipe-form');
    const steps = ['Назовите блюдо или напиток.', 'Добавьте все ингредиенты из складского справочника и укажите количество.', 'Опишите приготовление и подачу.', 'Проверьте состав и предварительную себестоимость перед сохранением.'];
    let recipeStep = 1;
    const unitFactors = { г: { г: 1, кг: 0.001 }, кг: { кг: 1, г: 1000 }, мл: { мл: 1, л: 0.001 }, л: { л: 1, мл: 1000 }, шт: { шт: 1 }, порция: { порция: 1 }, уп: { уп: 1 }, упаковка: { упаковка: 1 } };
    const calculateRecipeCost = () => {
      const lines = String(document.querySelector('#recipe-ingredients')?.value || '').split('\n').map((line) => line.trim()).filter(Boolean);
      let total = 0;
      let valid = lines.length > 0;
      const details = lines.map((line) => {
        const separator = line.lastIndexOf(' — ');
        const name = separator < 0 ? line : line.slice(0, separator).trim();
        const raw = separator < 0 ? '' : line.slice(separator + 3).trim();
        const id = raw.match(/\[([^\]]+)\]\s*$/)?.[1];
        const quantityText = raw.replace(/\s*\[[^\]]+\]\s*$/, '').trim();
        const match = quantityText.match(/^([0-9]+(?:[.,][0-9]+)?)\s*(г|кг|мл|л|шт|порция|уп|упаковка)$/i);
        const quantity = Number((match?.[1] || '').replace(',', '.'));
        const sourceUnit = match?.[2]?.toLocaleLowerCase('ru-RU') || '';
        const item = recipeInventoryItems.find((entry) => entry.id === id || entry.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'));
        const stockUnit = String(item?.unit || '').toLocaleLowerCase('ru-RU');
        const factor = item && unitFactors[sourceUnit]?.[stockUnit];
        const lineValid = Boolean(item && match && quantity > 0 && factor);
        const normalizedQuantity = lineValid ? Number((quantity * factor).toFixed(6)) : 0;
        const unitCost = Number(item?.cost || 0);
        const cost = lineValid ? Math.round(normalizedQuantity * unitCost * 100) / 100 : 0;
        const packMultiplier = Math.max(0.000001, Number(item?.packMultiplier || 1));
        const purchaseUnit = String(item?.purchaseUnit || item?.unit || 'шт').trim();
        const packageEquivalentCost = Math.round(unitCost * packMultiplier * 100) / 100;
        total += cost;
        valid &&= lineValid;
        return {
          name: item?.name || name,
          quantityText,
          normalizedQuantity: lineValid ? `${Number(normalizedQuantity).toLocaleString('ru-RU')} ${item.unit}` : '',
          cost,
          linked: lineValid,
          stockUnit: item?.unit || '',
          unitCost,
          purchaseUnit,
          packMultiplier,
          packageEquivalentCost,
          issue: !item ? 'Нет связи со складом' : !match || quantity <= 0 ? 'Проверьте количество и единицу' : !factor ? `Несовместимая единица: ${item.unit || 'не задана'}` : '',
        };
      });
      const totalNode = document.querySelector('#recipe-total-cost');
      if (totalNode) totalNode.textContent = valid ? money(total) : 'Проверьте состав';
      const portionNode = document.querySelector('#recipe-cost-per-portion');
      const portionCount = Math.max(1, Number(document.querySelector('#recipe-portion-count')?.value || 1));
      if (portionNode) portionNode.textContent = valid ? `Себестоимость единицы: ${money(total / portionCount)} · по текущим ценам склада` : 'Расчёт появится после исправления всех строк';
      const list = document.querySelector('#recipe-cost-lines');
      if (list) list.innerHTML = details.length ? details.map((item) => `<div class="recipe-cost-line"><span><strong>${esc(displayName(item.name))} · ${esc(item.quantityText)}</strong>${item.linked ? `<small class="muted">Для расчёта: ${esc(item.normalizedQuantity)}</small><small class="muted">Закупочная фасовка: ${esc(item.purchaseUnit)} = ${esc(String(item.packMultiplier))} ${esc(item.stockUnit)}</small><small class="muted">Расчётная стоимость фасовки по текущей средней себестоимости: ${money(item.packageEquivalentCost)} · складская единица: ${money(item.unitCost)}/${esc(item.stockUnit)}</small>` : ''}</span><b class="${item.linked ? '' : 'recipe-cost-missing'}">${item.linked ? money(item.cost) : esc(item.issue)}</b></div>`).join('') : '<span class="muted">Добавьте хотя бы один ингредиент.</span>';
      return { total, details, valid };
    };
    setRecipeStep = (next) => { recipeStep = Math.max(1, Math.min(4, next)); form.querySelectorAll('[data-recipe-stage]').forEach((node) => { node.hidden = Number(node.dataset.recipeStage) !== recipeStep; }); form.querySelectorAll('[data-recipe-step]').forEach((node) => { const active = Number(node.dataset.recipeStep) === recipeStep; node.classList.toggle('is-active', active); node.setAttribute('aria-selected', String(active)); }); const hint = document.querySelector('#recipe-wizard-hint'); if (hint) hint.textContent = steps[recipeStep - 1]; const back = document.querySelector('#recipe-wizard-back'); const forward = document.querySelector('#recipe-wizard-next'); if (back) back.disabled = recipeStep === 1; if (forward) { forward.hidden = recipeStep === 4; forward.textContent = recipeStep === 3 ? 'Проверить себестоимость' : 'Далее'; } if (recipeStep === 4) calculateRecipeCost(); };
    const validateRecipeProgress = (target) => { if (target >= 2 && !document.querySelector('#recipe-name').reportValidity()) return false; if (target >= 2 && (!document.querySelector('#recipe-yield-quantity').reportValidity() || !document.querySelector('#recipe-yield-unit').reportValidity() || !document.querySelector('#recipe-portion-count').reportValidity())) return false; if (target >= 3 && !document.querySelector('#recipe-ingredients').value.trim()) { portalNotice('Добавьте хотя бы один ингредиент', 'error'); setRecipeStep(2); return false; } return true; }; form.querySelectorAll('[data-recipe-step]').forEach((button) => button.addEventListener('click', () => { const target = Number(button.dataset.recipeStep); if (target > recipeStep && !validateRecipeProgress(target)) return; setRecipeStep(target); }));
    document.querySelector('#recipe-wizard-back')?.addEventListener('click', () => setRecipeStep(recipeStep - 1));
    document.querySelector('#recipe-wizard-next')?.addEventListener('click', () => { if (!validateRecipeProgress(recipeStep + 1)) return; setRecipeStep(recipeStep + 1); });
    document.querySelector('#recipe-ingredients')?.addEventListener('input', calculateRecipeCost);
    const recipeGrid = document.querySelector('#recipe-grid');
    const recipeCount = document.querySelector('#recipe-count');
    const recipeMessage = document.querySelector('#recipe-message');
    const recipeSearchInput = document.querySelector('#recipe-search');
    const recipeCategoryFilter = document.querySelector('#recipe-category-filter');
    const normalizeRecipeSearch = (value) => String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const syncRecipeCategoryOptions = () => {
      const categories = [...new Set(recipeItems.map((item) => String(item.category || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
      const selected = recipeCategoryFilter?.value || '';
      if (recipeCategoryFilter) recipeCategoryFilter.innerHTML = '<option value="">Все категории</option>' + categories.map((category) => `<option value="${esc(category)}">${esc(category)}</option>`).join('');
      if (recipeCategoryFilter && categories.includes(selected)) recipeCategoryFilter.value = selected;
      const suggestions = document.querySelector('#recipe-category-suggestions');
      if (suggestions) suggestions.innerHTML = categories.map((category) => `<option value="${esc(category)}"></option>`).join('');
    };
    const parseIngredientLines = () => String(document.querySelector('#recipe-ingredients')?.value || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => { const separator = line.lastIndexOf(' — '); const name = separator < 0 ? line : line.slice(0, separator).trim(); const raw = separator < 0 ? '' : line.slice(separator + 3).trim(); const ingredientId = raw.match(/\[([^\]]+)\]\s*$/)?.[1] || null; const quantity = raw.replace(/\s*\[[^\]]+\]\s*$/, '').trim(); const item = recipeInventoryItems.find((entry) => entry.id === ingredientId); return { name: item?.name || name, ingredientId, quantity, unit: quantity.match(/[а-я]+$/i)?.[0] || null }; });
    const renderRecipes = () => {
      syncRecipeCategoryOptions();
      if (!recipeGrid) return;
      const query = normalizeRecipeSearch(recipeSearchInput?.value);
      const selectedCategory = normalizeRecipeSearch(recipeCategoryFilter?.value);
      const visibleRecipes = recipeItems.filter((item) => {
        if (selectedCategory && normalizeRecipeSearch(item.category) !== selectedCategory) return false;
        if (!query) return true;
        const product = productItems.find((entry) => String(entry.id) === String(item.productId));
        const ingredients = Array.isArray(item.ingredients) ? item.ingredients.map((entry) => entry.name || entry.stockName || '').join(' ') : '';
        return normalizeRecipeSearch([item.name, item.category, product?.name, ingredients, item.technology, item.serve].join(' ')).includes(query);
      });
      if (recipeCount) recipeCount.textContent = query || selectedCategory ? `${visibleRecipes.length} из ${recipeItems.length}` : `${recipeItems.length} ${recipeItems.length === 1 ? 'карта' : 'карт'}`;
      recipeGrid.innerHTML = visibleRecipes.length ? visibleRecipes.map((item) => {
        const ingredients = Array.isArray(item.ingredients) ? item.ingredients : [];
        const product = productItems.find((entry) => String(entry.id) === String(item.productId));
        const ingredientRows = ingredients.slice(0, 8).map((entry) => `<li><span>${esc(displayName(entry.name || entry.stockName || 'Ингредиент'))} · ${esc(entry.quantity || 'Количество не задано')}</span>${entry.cost != null ? `<b>${money(entry.cost)}</b>` : ''}</li>`).join('');
        return `<article class="recipe-card" data-recipe-card="${esc(item.id)}"><div class="recipe-card-head"><div><h3>${esc(displayName(item.name))}</h3><span>${item.recipeType === 'premix' ? 'Заготовка / премикс' : 'Продажная позиция'}${product ? ` · ${esc(displayName(product.name))}` : ''}</span></div>${item.category ? `<span class="badge">${esc(item.category)}</span>` : ''}${item.recipeType === 'premix' ? '<span class="badge info">Премикс</span>' : ''}</div><div class="muted recipe-yield">Выход: <b>${esc(String(item.yieldQuantity || 1))} ${esc(item.yieldUnit || 'порция')}</b>${Number(item.portionCount || 1) !== 1 ? ` · ${esc(String(item.portionCount))} порций` : ''}</div><ul>${ingredientRows || '<li class="muted">Состав не указан</li>'}${ingredients.length > 8 ? `<li class="muted">Ещё ${ingredients.length - 8} ингредиентов</li>` : ''}</ul><div class="recipe-card-cost" data-recipe-cost-for="${esc(item.id)}">${renderRecipeCostBreakdown(item.id)}</div>${item.technology ? `<p><strong>Технология:</strong> ${esc(item.technology)}</p>` : ''}${item.serve ? `<p><strong>Подача:</strong> ${esc(item.serve)}</p>` : ''}${canWriteInventory ? `<div class="recipe-card-actions"><button class="button small" type="button" data-recipe-edit="${esc(item.id)}">Изменить</button><button class="button small danger-outline" type="button" data-recipe-delete="${esc(item.id)}">Удалить</button></div>` : ''}</article>`;
      }).join('') : recipeItems.length ? '<div class="empty"><strong>Ничего не найдено</strong><small>Измените поиск или выберите другую категорию.</small></div>' : '<div class="empty"><strong>Технологических карт пока нет</strong><small>Создайте карту продажи или заготовки: укажите состав, нормы расхода и порядок приготовления.</small></div>';
    };
    const loadRecipes = () => api('/api/recipes').then((data) => { invalidateRecipeCostCache(); recipeItems = Array.isArray(data.items) ? data.items : []; syncRecipeProductOptions(); renderRecipes(); refreshInventoryContext(); }).catch((error) => { console.error('Не удалось загрузить технологические карты', error); if (recipeCount) recipeCount.textContent = 'Не удалось загрузить'; if (recipeGrid) recipeGrid.innerHTML = '<div class="empty">Не удалось загрузить технологические карты. Обновите страницу или попробуйте позже.</div>'; });
    const resetRecipeForm = (editing = null) => {
      form.reset();
      document.querySelector('#recipe-id').value = editing?.id || '';
      document.querySelector('#recipe-name').value = editing?.name || '';
      document.querySelector('#recipe-category').value = editing?.category || '';
      document.querySelector('#recipe-product').value = editing?.productId || '';
      document.querySelector('#recipe-type').value = editing?.recipeType || 'sale';
      document.querySelector('#recipe-yield-quantity').value = editing?.yieldQuantity || 1;
      document.querySelector('#recipe-yield-unit').value = editing?.yieldUnit || 'порция';
      document.querySelector('#recipe-portion-count').value = editing?.portionCount || 1;
      document.querySelector('#recipe-technology').value = editing?.technology || '';
      document.querySelector('#recipe-serve').value = editing?.serve || '';
      const lines = (editing?.ingredients || []).map((entry) => `${entry.name || entry.stockName || ''} — ${entry.quantity || ''}${entry.ingredientId ? ` [${entry.ingredientId}]` : ''}`);
      document.querySelector('#recipe-ingredients').value = lines.join('\n');
      document.querySelector('#delete-recipe').hidden = !editing;
      form.querySelector('[type="submit"]').textContent = editing ? 'Сохранить изменения' : 'Сохранить карту';
      if (recipeMessage) { recipeMessage.textContent = ''; recipeMessage.className = 'form-message'; }
      const ingredientRows = document.querySelector('#recipe-linked-ingredients');
      if (ingredientRows) { ingredientFieldForRender(); }
      const typeSelect = document.querySelector('#recipe-type');
      document.querySelector('#recipe-product').disabled = typeSelect.value === 'premix';
      setRecipeStep(1);
      form.hidden = false;
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.querySelector('#recipe-name').focus({ preventScroll: true });
    };
    function ingredientFieldForRender() { document.querySelector('#recipe-ingredients')?.dispatchEvent(new Event('input', { bubbles: true })); }
    document.querySelector('#new-recipe')?.addEventListener('click', () => { if (form.dataset.submitting !== '1') resetRecipeForm(); });
    recipeSearchInput?.addEventListener('input', renderRecipes);
    recipeCategoryFilter?.addEventListener('change', renderRecipes);
    document.querySelector('#cancel-recipe')?.addEventListener('click', () => { if (form.dataset.submitting === '1') return; form.hidden = true; form.reset(); });
    document.querySelector('#recipe-type')?.addEventListener('change', (event) => { const product = document.querySelector('#recipe-product'); if (event.target.value === 'premix') product.value = ''; product.disabled = event.target.value === 'premix'; });
    const lockRecipeControls = () => {
      const controls = [...form.querySelectorAll('input, select, textarea, button')].map((control) => ({ control, disabled: control.disabled }));
      const newButton = document.querySelector('#new-recipe');
      const newButtonWasDisabled = newButton?.disabled;
      form.dataset.submitting = '1';
      controls.forEach(({ control }) => { control.disabled = true; control._customSelectRefresh?.(); });
      if (newButton) newButton.disabled = true;
      return () => { controls.forEach(({ control, disabled }) => { control.disabled = disabled; control._customSelectRefresh?.(); }); if (newButton) newButton.disabled = newButtonWasDisabled; form.dataset.submitting = '0'; };
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (form.dataset.submitting === '1') return;
      if (!validateRecipeProgress(4)) return;
      const cost = calculateRecipeCost();
      if (!cost.valid) { setRecipeStep(4); portalNotice('Исправьте состав: каждая строка должна ссылаться на складскую позицию и иметь совместимую единицу измерения', 'error'); return; }
      const id = document.querySelector('#recipe-id').value;
      const recipeType = document.querySelector('#recipe-type').value;
      const payload = { name: document.querySelector('#recipe-name').value.trim(), category: document.querySelector('#recipe-category').value.trim(), productId: recipeType === 'premix' ? null : document.querySelector('#recipe-product').value || null, recipeType, yieldQuantity: Number(document.querySelector('#recipe-yield-quantity').value), yieldUnit: document.querySelector('#recipe-yield-unit').value, portionCount: Number(document.querySelector('#recipe-portion-count').value), ingredients: parseIngredientLines(), technology: document.querySelector('#recipe-technology').value.trim(), serve: document.querySelector('#recipe-serve').value.trim() };
      const submit = form.querySelector('[type="submit"]');
      const submitLabel = submit.textContent;
      const releaseRecipeControls = lockRecipeControls();
      submit.textContent = 'Сохраняем карту…';
      if (recipeMessage) { recipeMessage.textContent = 'Сохраняем карту…'; recipeMessage.className = 'form-message'; }
      api(id ? `/api/recipes/${encodeURIComponent(id)}` : '/api/recipes', { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(() => { form.hidden = true; return loadRecipes(); }).then(() => portalNotice(id ? 'Изменения технологической карты сохранены' : 'Технологическая карта создана', 'success')).catch((error) => { const code = error.payload?.error; const labels = { invalid_recipe_quantity: 'Проверьте количество ингредиента в техкарте', recipe_ingredient_unit_mismatch: 'Единица ингредиента не совместима с единицей склада', recipe_ingredient_not_found: 'Ингредиент не найден в текущем складе', premix_product_binding_not_allowed: 'Заготовку нельзя привязать к товару продажи', recipe_product_not_found: 'Товар меню не найден в этом заведении', insufficient_stock: 'Недостаточно данных для проверки состава' }; if (recipeMessage) { recipeMessage.textContent = labels[code] || 'Не удалось сохранить карту. Проверьте данные и попробуйте снова.'; recipeMessage.className = 'form-message error-message'; } }).finally(() => { releaseRecipeControls(); submit.textContent = submitLabel; });
    });
    document.querySelector('#delete-recipe')?.addEventListener('click', () => { if (form.dataset.submitting === '1') return; const id = document.querySelector('#recipe-id').value; if (!id || !window.confirm('Удалить технологическую карту? Действие нельзя отменить.')) return; const button = document.querySelector('#delete-recipe'); const releaseRecipeControls = lockRecipeControls(); button.disabled = true; api(`/api/recipes/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => { form.hidden = true; return loadRecipes(); }).then(() => portalNotice('Технологическая карта удалена', 'success')).catch(() => { if (recipeMessage) { recipeMessage.textContent = 'Не удалось удалить карту'; recipeMessage.className = 'form-message error-message'; } }).finally(() => { releaseRecipeControls(); button.disabled = false; }); });
    recipeGrid?.addEventListener('click', (event) => { if (form.dataset.submitting === '1') return; const edit = event.target.closest('[data-recipe-edit]'); const remove = event.target.closest('[data-recipe-delete]'); if (edit) { const item = recipeItems.find((entry) => String(entry.id) === edit.dataset.recipeEdit); if (item) resetRecipeForm(item); } if (remove) { const item = recipeItems.find((entry) => String(entry.id) === remove.dataset.recipeDelete); if (!item || !window.confirm(`Удалить карту «${item.name}»?`)) return; const releaseRecipeControls = lockRecipeControls(); remove.disabled = true; api(`/api/recipes/${encodeURIComponent(item.id)}`, { method: 'DELETE' }).then(() => { if (document.querySelector('#recipe-id').value === String(item.id)) { form.hidden = true; form.reset(); } return loadRecipes(); }).then(() => portalNotice('Технологическая карта удалена', 'success')).catch(() => portalNotice('Не удалось удалить карту', 'error')).finally(() => { releaseRecipeControls(); remove.disabled = false; }); } });
    loadRecipes();
    setRecipeStep(1);
  }
  if (!canWriteInventory) {
    const recipeGrid = document.querySelector('#recipe-grid');
    const recipeCount = document.querySelector('#recipe-count');
    const recipeSearchInput = document.querySelector('#recipe-search');
    const recipeCategoryFilter = document.querySelector('#recipe-category-filter');
    const normalizeReadOnlyRecipeSearch = (value) => String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const renderReadOnlyRecipes = () => {
      const categories = [...new Set(recipeItems.map((item) => String(item.category || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
      const selectedCategory = recipeCategoryFilter?.value || '';
      if (recipeCategoryFilter) recipeCategoryFilter.innerHTML = '<option value="">Все категории</option>' + categories.map((category) => `<option value="${esc(category)}">${esc(category)}</option>`).join('');
      if (recipeCategoryFilter && categories.includes(selectedCategory)) recipeCategoryFilter.value = selectedCategory;
      const query = normalizeReadOnlyRecipeSearch(recipeSearchInput?.value);
      const normalizedCategory = normalizeReadOnlyRecipeSearch(recipeCategoryFilter?.value);
      const visibleItems = recipeItems.filter((item) => {
        if (normalizedCategory && normalizeReadOnlyRecipeSearch(item.category) !== normalizedCategory) return false;
        if (!query) return true;
        const product = productItems.find((entry) => String(entry.id) === String(item.productId));
        const ingredients = Array.isArray(item.ingredients) ? item.ingredients.map((entry) => entry.name || entry.stockName || '').join(' ') : '';
        return normalizeReadOnlyRecipeSearch([item.name, item.category, product?.name, ingredients, item.technology, item.serve].join(' ')).includes(query);
      });
      if (recipeCount) recipeCount.textContent = query || normalizedCategory ? `${visibleItems.length} из ${recipeItems.length}` : `${recipeItems.length} ${recipeItems.length === 1 ? 'карта' : 'карт'}`;
      if (!recipeGrid) return;
      recipeGrid.innerHTML = visibleItems.length ? visibleItems.map((item) => {
        const ingredients = Array.isArray(item.ingredients) ? item.ingredients : [];
        const product = productItems.find((entry) => String(entry.id) === String(item.productId));
        const rows = ingredients.slice(0, 8).map((entry) => `<li><span>${esc(displayName(entry.name || entry.stockName || 'Ингредиент'))} · ${esc(entry.quantity || 'Количество не задано')}</span>${entry.cost != null ? `<b>${money(entry.cost)}</b>` : ''}</li>`).join('');
        return `<article class="recipe-card" data-recipe-card="${esc(item.id)}"><div class="recipe-card-head"><div><h3>${esc(displayName(item.name))}</h3><span>${item.recipeType === 'premix' ? 'Заготовка / премикс' : 'Продажная позиция'}${product ? ` · ${esc(displayName(product.name))}` : ''}</span></div>${item.category ? `<span class="badge">${esc(item.category)}</span>` : ''}${item.recipeType === 'premix' ? '<span class="badge info">Премикс</span>' : ''}</div><div class="muted recipe-yield">Выход: <b>${esc(String(item.yieldQuantity || 1))} ${esc(item.yieldUnit || 'порция')}</b>${Number(item.portionCount || 1) !== 1 ? ` · ${esc(String(item.portionCount))} порций` : ''}</div><ul>${rows || '<li class="muted">Состав не указан</li>'}${ingredients.length > 8 ? `<li class="muted">Ещё ${ingredients.length - 8} ингредиентов</li>` : ''}</ul><div class="recipe-card-cost" data-recipe-cost-for="${esc(item.id)}">${renderRecipeCostBreakdown(item.id)}</div>${item.technology ? `<p><strong>Технология:</strong> ${esc(item.technology)}</p>` : ''}${item.serve ? `<p><strong>Подача:</strong> ${esc(item.serve)}</p>` : ''}</article>`;
      }).join('') : recipeItems.length ? '<div class="empty"><strong>Ничего не найдено</strong><small>Измените поиск или выберите другую категорию.</small></div>' : '<div class="empty"><strong>Технологических карт пока нет</strong><small>Создайте карту продажи или заготовки: укажите состав, нормы расхода и порядок приготовления.</small></div>';
    };
    recipeSearchInput?.addEventListener('input', renderReadOnlyRecipes);
    recipeCategoryFilter?.addEventListener('change', renderReadOnlyRecipes);
    api('/api/recipes').then((data) => {
      recipeItems = Array.isArray(data.items) ? data.items : [];
      refreshInventoryContext();
      renderReadOnlyRecipes();
    }).catch((error) => {
      console.error('Не удалось загрузить технологические карты', error);
      if (recipeCount) recipeCount.textContent = 'Не удалось загрузить';
      if (recipeGrid) recipeGrid.innerHTML = '<div class="empty">Не удалось загрузить технологические карты. Обновите страницу или попробуйте позже.</div>';
    });
  }
  setInventoryView(new URL(location.href).searchParams.get('view') || 'stock', { historyMode: 'replace', scroll: false });
  window.addEventListener('popstate', () => setInventoryView(new URL(location.href).searchParams.get('view') || 'stock', { historyMode: false, scroll: false }));
  const warehouseKpis = [['#inventory-count','stock'],['#inventory-low','stock'],['#inventory-last','movements']];
  warehouseKpis.forEach(([selector, view]) => { const card = document.querySelector(selector)?.closest('.kpi'); if (!card) return; card.addEventListener('click', () => setInventoryView(view)); card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') setInventoryView(view); }); });
  document.querySelector('#inventory-count')?.closest('.kpi')?.setAttribute('aria-label', 'Показать складские позиции');
  if (canWriteInventory) {
    const form = document.querySelector('#product-form');
    const message = document.querySelector('#product-message');
    let disabledProductControls = [];
    const setProductPending = (pending) => {
      form.dataset.submitting = pending ? '1' : '0';
      if (pending) {
        const productControls = [...form.querySelectorAll('input, select, button')];
        disabledProductControls = productControls.filter((control) => control.disabled);
        productControls.forEach((control) => { control.disabled = true; control._customSelectRefresh?.(); });
      } else {
        form.querySelectorAll('input, select, button').forEach((control) => { control.disabled = disabledProductControls.includes(control); control._customSelectRefresh?.(); });
        disabledProductControls = [];
      }
      const addButton = document.querySelector('#new-product');
      if (addButton) addButton.disabled = pending || !form.hidden;
    };
    const resetProductForm = () => {
      form.dataset.imageGeneration = String(Number(form.dataset.imageGeneration || 0) + 1);
      form.dataset.imageProcessing = '0';
      form.reset();
      document.querySelector('#product-id').value = '';
      document.querySelector('#delete-product').hidden = true;
      document.querySelector('#save-product').textContent = 'Сохранить товар';
      document.querySelector('#product-form-title').textContent = 'Новый товар';
      document.querySelector('#product-form-hint').textContent = 'Заполните основные данные — товар сразу появится в заказах.';
      document.querySelector('#product-form-status').textContent = 'Черновик';
      if (message) { message.textContent = ''; message.className = 'form-message'; }
      const addButton = document.querySelector('#new-product');
      if (addButton) { addButton.disabled = form.dataset.submitting === '1'; addButton.innerHTML = `${icon('plus')} Добавить товар`; }
      pendingProductImage = null;
      productImageChanged = false;
      const imageInput = document.querySelector('#product-image-file');
      if (imageInput) imageInput.value = '';
      syncProductPreview();
      form.hidden = true;
    };
    document.querySelector('#new-product').addEventListener('click', () => { if (form.dataset.submitting === '1') return; resetProductForm(); setProductEditorMode(); });
    document.querySelector('#cancel-product').addEventListener('click', () => { if (form.dataset.submitting !== '1') resetProductForm(); });
    document.querySelector('#product-name')?.addEventListener('input', syncProductPreview);
    document.querySelector('#product-category')?.addEventListener('input', syncProductPreview);
    document.querySelector('#product-image-file')?.addEventListener('change', () => {
      const input = document.querySelector('#product-image-file');
      const file = input.files?.[0];
      if (!file) return;
      const generation = Number(form.dataset.imageGeneration || 0) + 1;
      form.dataset.imageGeneration = String(generation);
      form.dataset.imageProcessing = '0';
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 1_500_000) { portalNotice('Фото товара: PNG, JPG или WebP до 1,5 МБ', 'error'); input.value = ''; return; }
      form.dataset.imageProcessing = '1';
      compressUploadedImage(file, 640).then((imageData) => {
        if (Number(form.dataset.imageGeneration) !== generation) return;
        pendingProductImage = imageData; productImageChanged = true; syncProductPreview();
      }).catch(() => { if (Number(form.dataset.imageGeneration) === generation) portalNotice('Не удалось обработать фото товара', 'error'); })
        .finally(() => { if (Number(form.dataset.imageGeneration) === generation) form.dataset.imageProcessing = '0'; });
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (form.dataset.submitting === '1') return;
      if (form.dataset.imageProcessing === '1') { if (message) { message.textContent = 'Подождите, пока обработается фото товара.'; message.className = 'form-message error-message'; } return; }
      if (!form.reportValidity()) return;
      const id = document.querySelector('#product-id').value;
      const payload = { name: document.querySelector('#product-name').value.trim(), category: document.querySelector('#product-category').value.trim(), price: Number(document.querySelector('#product-price').value), inventoryMode: document.querySelector('#product-inventory-mode').value, aliases: document.querySelector('#product-aliases').value.split(',').map((item) => item.trim()).filter(Boolean) };
      if (productImageChanged) payload.imageUrl = pendingProductImage;
      setProductPending(true);
      if (message) { message.textContent = 'Сохраняем товар…'; message.className = 'form-message'; }
      try {
        await api(id ? `/api/products/${encodeURIComponent(id)}` : '/api/products', { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        resetProductForm();
        portalNotice(id ? 'Товар обновлён' : 'Товар создан и добавлен в каталог', 'success');
        try { const data = await api('/api/products'); drawProducts(data.items); }
        catch { portalNotice('Товар сохранён, но каталог не обновился. Перезагрузите страницу.', 'error'); }
      } catch (error) {
        if (message) { message.textContent = error.payload?.error === 'invalid_product' ? 'Проверьте название, категорию и цену.' : 'Не удалось сохранить товар. Попробуйте ещё раз.'; message.className = 'form-message error-message'; }
      } finally { setProductPending(false); }
    });
    document.querySelector('#delete-product').addEventListener('click', async () => {
      if (form.dataset.submitting === '1') return;
      const id = document.querySelector('#product-id').value;
      if (!id) return;
      if (!window.confirm('Удалить товар из каталога? История заказов сохранится.')) return;
      setProductPending(true);
      try {
        await api(`/api/products/${encodeURIComponent(id)}`, { method: 'DELETE' });
        resetProductForm();
        portalNotice('Товар удалён из каталога', 'success');
        try { const data = await api('/api/products'); drawProducts(data.items); }
        catch { portalNotice('Товар удалён, но каталог не обновился. Перезагрузите страницу.', 'error'); }
      } catch { portalNotice('Не удалось удалить товар', 'error'); }
      finally { setProductPending(false); }
    });
  }
  const purchaseForm = document.querySelector('#purchase-document-form'); const purchaseLines = document.querySelector('#purchase-lines');
  const purchaseUnitChoices = ['шт','г','кг','мл','л','порция','уп','упаковка'];
  const purchaseFactors = { г: { г: 1, кг: .001 }, кг: { кг: 1, г: 1000 }, мл: { мл: 1, л: .001 }, л: { л: 1, мл: 1000 }, шт: { шт: 1 }, порция: { порция: 1 }, уп: { уп: 1 }, упаковка: { упаковка: 1 } };
  const purchaseFactor = (item, unit) => item?.purchaseUnit && String(unit).toLocaleLowerCase('ru-RU') === String(item.purchaseUnit).toLocaleLowerCase('ru-RU') ? Number(item.packMultiplier || 1) : purchaseFactors[unit]?.[item?.unit];
  const renderPurchaseLines = (lines = [{ ingredientId: '', quantity: '', unit: '', unitCost: '' }]) => {
    if (!purchaseLines) return;
    purchaseLines.innerHTML = lines.map((line, index) => { const item = allItems.find((entry) => entry.id === line.ingredientId); const archivedOption = !item && line.ingredientId ? `<option value="${esc(line.ingredientId)}" selected>Архивная позиция: ${esc(displayName(line.ingredientName || 'Позиция'))}</option>` : ''; const options = allItems.map((entry) => `<option value="${esc(entry.id)}" ${entry.id === line.ingredientId ? 'selected' : ''}>${esc(displayName(entry.name))} · ${esc(entry.unit || 'шт')}</option>`).join(''); const units = [...new Set([...purchaseUnitChoices, ...(item?.purchaseUnit ? [item.purchaseUnit] : []), ...(line.unit && !purchaseUnitChoices.includes(line.unit) ? [line.unit] : [])])]; return `<div class="purchase-line" data-purchase-line="${index}"><label>Складская позиция<select data-purchase-field="ingredientId" required><option value="">Выберите позицию</option>${archivedOption}${options}</select></label><label>Количество<input data-purchase-field="quantity" type="number" min="0.000001" step="0.000001" value="${esc(line.quantity ?? '')}" required placeholder="0"></label><label>Единица закупки<input data-purchase-field="unit" list="purchase-unit-options-${index}" value="${esc(line.unit || item?.purchaseUnit || item?.unit || '')}" required maxlength="30" placeholder="Например, бутылка"><datalist id="purchase-unit-options-${index}">${units.map((unit) => `<option value="${esc(unit)}"></option>`).join('')}</datalist></label><label>Цена за единицу закупки<input data-purchase-field="unitCost" type="number" min="0" step="0.01" value="${esc(line.unitCost ?? '')}" required placeholder="0,00"></label><button class="button small danger-outline" type="button" data-purchase-remove="${index}" aria-label="Убрать позицию">Убрать</button><small class="purchase-line-preview muted" data-purchase-preview>${item ? 'В учёт поступит ' + (Number(line.quantity || 0) * (purchaseFactor(item, line.unit || item.purchaseUnit || item.unit) || 0)).toLocaleString('ru-RU') + ' ' + item.unit + ' · итого ' + money(Number(line.quantity || 0) * Number(line.unitCost || 0)) : line.ingredientId ? 'Позиция архивирована. Выберите активную замену; в приходе по автозаказу — позицию из заявки. Если подходящей позиции нет, отмените черновик.' : 'Выберите позицию, чтобы увидеть пересчёт упаковки.'}</small></div>`; }).join('');
  };
  const getPurchaseLines = () => [...(purchaseLines?.querySelectorAll('.purchase-line') || [])].map((row) => Object.fromEntries([...row.querySelectorAll('[data-purchase-field]')].map((field) => [field.dataset.purchaseField, field.type === 'number' ? Number(field.value) : field.value.trim()])));
  const updatePurchasePreviews = () => { for (const row of purchaseLines?.querySelectorAll('.purchase-line') || []) { const fields = Object.fromEntries([...row.querySelectorAll('[data-purchase-field]')].map((field) => [field.dataset.purchaseField, field.value])); const item = allItems.find((entry) => entry.id === fields.ingredientId); const factor = purchaseFactor(item, fields.unit); const preview = row.querySelector('[data-purchase-preview]'); if (preview) preview.textContent = item && factor ? `В учёт поступит ${(Number(fields.quantity || 0) * factor).toLocaleString('ru-RU')} ${item.unit} · сумма ${money(Number(fields.quantity || 0) * Number(fields.unitCost || 0))}` : item ? `Единица «${fields.unit}» не настроена для позиции. Проверьте единицу закупки и коэффициент в карточке.` : 'Выберите позицию, чтобы увидеть пересчёт упаковки.'; } const total = document.querySelector('#purchase-total'); if (total) total.textContent = `Итого: ${money(getPurchaseLines().reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitCost || 0), 0))}`; };
  let purchaseActionPending = false;
  let purchasePreviouslyDisabled = new Set();
  const setPurchasePending = (pending) => {
    purchaseActionPending = pending;
    if (pending) purchasePreviouslyDisabled = new Set([...purchaseForm.querySelectorAll('input, select, textarea, button')].filter((control) => control.disabled));
    purchaseForm?.querySelectorAll('input, select, textarea, button').forEach((control) => { control.disabled = pending || purchasePreviouslyDisabled.has(control); control._customSelectRefresh?.(); });
    document.querySelector('#purchase-document-list')?.querySelectorAll('button').forEach((button) => { button.disabled = pending; });
    if (!pending) purchasePreviouslyDisabled.clear();
  };
  const resetPurchaseForm = () => { purchaseForm?.reset(); if (purchaseForm) { delete purchaseForm.dataset.editId; delete purchaseForm.dataset.sourceAutoOrderId; } const orderContext = document.querySelector('#purchase-order-context'); if (orderContext) orderContext.hidden = true; const date = document.querySelector('#purchase-date'); if (date) date.value = ''; const button = document.querySelector('#purchase-save'); if (button) button.textContent = 'Сохранить черновик'; const cancel = document.querySelector('#purchase-cancel'); if (cancel) cancel.hidden = true; renderPurchaseLines(); updatePurchasePreviews(); };
  const canReversePurchaseDocuments = portalPermissions.has('inventory') && portalPermissions.has('finance');
  const purchaseFilterFields = {
    from: document.querySelector('#purchase-filter-from'), to: document.querySelector('#purchase-filter-to'),
    status: document.querySelector('#purchase-filter-status'), undated: document.querySelector('#purchase-filter-undated'),
  };
  const purchaseFilterStorageKey = 'hookah.purchase-document-filters.v1';
  const readPurchaseFilterState = () => ({ from: purchaseFilterFields.from?.value || '', to: purchaseFilterFields.to?.value || '', status: purchaseFilterFields.status?.value || '', includeUndated: Boolean(purchaseFilterFields.undated?.checked) });
  const savePurchaseFilterState = () => { try { sessionStorage.setItem(purchaseFilterStorageKey, JSON.stringify(readPurchaseFilterState())); } catch (_) {} };
  try {
    const saved = JSON.parse(sessionStorage.getItem(purchaseFilterStorageKey) || 'null');
    if (saved && typeof saved === 'object') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(saved.from || '')) purchaseFilterFields.from.value = saved.from;
      if (/^\d{4}-\d{2}-\d{2}$/.test(saved.to || '')) purchaseFilterFields.to.value = saved.to;
      if (['', 'draft', 'posted', 'voided'].includes(saved.status)) purchaseFilterFields.status.value = saved.status;
      purchaseFilterFields.undated.checked = saved.includeUndated === true;
    }
  } catch (_) {}
  const purchaseFilterQuery = () => {
    const state = readPurchaseFilterState(); const params = new URLSearchParams();
    if (state.from) params.set('documentDateFrom', state.from);
    if (state.to) params.set('documentDateTo', state.to);
    if (state.status) params.set('status', state.status);
    if (state.includeUndated) params.set('includeUndated', 'true');
    return params.toString();
  };
  const drawPurchaseDocuments = () => {
    const list = document.querySelector('#purchase-document-list');
    if (!list) return;
    const statuses = { draft: 'Черновик', posted: 'Проведён', voided: 'Отменён' };
    const state = readPurchaseFilterState();
    list.innerHTML = purchaseDocuments.length ? purchaseDocuments.map((doc) => {
      const reversed = Boolean(doc.reversal?.id);
      const canReverse = canWriteInventory && canReversePurchaseDocuments && doc.status === 'posted' && doc.reversalPolicyMode === 'safe_full_unpaid_unused' && doc.reversalPolicyEnabled === true && Number(doc.reversalPolicyVersion) > 0 && !reversed;
      const status = reversed ? 'Сторнирован' : statuses[doc.status] || esc(doc.status);
      return `<article class="purchase-document-row"><div class="purchase-document-main"><b>${esc(doc.supplierName || 'Поставщик не указан')}${doc.documentNumber ? ' · ' + esc(doc.documentNumber) : ''}</b><small>${doc.documentDate ? formatRuDate(doc.documentDate, false) : 'Дата накладной не указана'} · ${Number(doc.lineCount || doc.lines?.length || 0)} поз. · ${money(doc.totalCost || 0)}${doc.sourceAutoOrderId ? ' · По автозаказу' : ''}${doc.reversalPolicyVersion ? ` · Правило v${Number(doc.reversalPolicyVersion)}` : ''}</small></div><span class="badge ${reversed ? 'warning' : doc.status === 'posted' ? 'success' : 'warning'}">${status}</span>${reversed ? `<small class="muted">Сторно ${formatRuDate(doc.reversal.occurredAt, true)} · ${esc(doc.reversal.reason || '')}</small>` : ''}${canWriteInventory && doc.status === 'draft' ? `<div class="toolbar-row"><button class="button small" type="button" data-purchase-edit="${esc(doc.id)}">Изменить</button><button class="button small primary" type="button" data-purchase-post="${esc(doc.id)}">Провести поступление</button><button class="button small danger-outline" type="button" data-purchase-void="${esc(doc.id)}">Отменить черновик</button></div>` : ''}${canReverse ? '<div class="toolbar-row"><button class="button small danger-outline" type="button" data-purchase-reverse="' + esc(doc.id) + '">Сторнировать приход</button></div>' : ''}</article>`;
    }).join('') : `<div class="empty">${state.from || state.to || state.status || state.includeUndated ? 'По выбранным условиям документов нет.' : 'Документов пока нет. Создайте черновик по накладной — до проведения остаток не изменится.'}</div>`;
  };
  let purchaseDocumentLoadRequestId = 0;
  const loadPurchaseDocuments = () => {
    const requestId = ++purchaseDocumentLoadRequestId;
    const query = purchaseFilterQuery(); const message = document.querySelector('#purchase-filter-message');
    if (purchaseFilterFields.from.value && purchaseFilterFields.to.value && purchaseFilterFields.from.value > purchaseFilterFields.to.value) { if (message) { message.textContent = 'Начало периода должно быть раньше или равно окончанию.'; message.className = 'form-message error-message'; } return Promise.resolve(false); }
    if (message) { message.textContent = ''; message.className = 'form-message'; message.setAttribute('role', 'status'); }
    savePurchaseFilterState();
    return api(`/api/inventory/purchase-documents${query ? `?${query}` : ''}`).then((data) => { if (requestId !== purchaseDocumentLoadRequestId) return false; purchaseDocuments = data.items || []; drawPurchaseDocuments(); refreshInventoryContext(); return true; }).catch((error) => { if (requestId !== purchaseDocumentLoadRequestId) return false; purchaseDocuments = []; document.querySelector('#purchase-document-list')?.replaceChildren(); if (message) { message.textContent = error.payload?.error === 'invalid_purchase_filter' ? 'Проверьте период и фильтры документов.' : 'Не удалось загрузить документы по выбранным фильтрам.'; message.className = 'form-message error-message'; message.setAttribute('role', 'alert'); } return false; });
  };
  document.querySelector('#purchase-filter-apply')?.addEventListener('click', () => loadPurchaseDocuments());
  document.querySelector('#purchase-filter-reset')?.addEventListener('click', () => { purchaseFilterFields.from.value = ''; purchaseFilterFields.to.value = ''; purchaseFilterFields.status.value = ''; purchaseFilterFields.undated.checked = false; loadPurchaseDocuments(); });
  purchaseLines?.addEventListener('input', updatePurchasePreviews); purchaseLines?.addEventListener('change', (event) => { if (event.target.dataset.purchaseField === 'ingredientId') { const values = getPurchaseLines(); const rowIndex = Number(event.target.closest('.purchase-line')?.dataset.purchaseLine); if (values[rowIndex]) { const item = allItems.find((entry) => entry.id === values[rowIndex].ingredientId); values[rowIndex].unit = item?.purchaseUnit || item?.unit || ''; renderPurchaseLines(values); } } updatePurchasePreviews(); });
  document.querySelector('#purchase-add-line')?.addEventListener('click', () => { if (purchaseActionPending) return; const lines = getPurchaseLines(); lines.push({ ingredientId: '', quantity: '', unit: '', unitCost: '' }); renderPurchaseLines(lines); });
  purchaseLines?.addEventListener('click', (event) => { if (purchaseActionPending) return; const button = event.target.closest('[data-purchase-remove]'); if (!button) return; const lines = getPurchaseLines(); lines.splice(Number(button.dataset.purchaseRemove), 1); renderPurchaseLines(lines.length ? lines : []); updatePurchasePreviews(); });
  purchaseForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (purchaseActionPending) return;
    const lines = getPurchaseLines();
    const message = document.querySelector('#purchase-message');
    const supplierName = document.querySelector('#purchase-supplier').value.trim();
    if (!supplierName) { message.textContent = 'Укажите поставщика для накладной.'; message.className = 'form-message error-message'; document.querySelector('#purchase-supplier').focus(); return; }
    if (!lines.length || lines.some((line) => !line.ingredientId || !line.quantity || !line.unit || !Number.isFinite(line.unitCost) || line.unitCost < 0)) {
      message.textContent = 'Заполните позицию, количество, единицу закупки и цену в каждой строке.';
      message.className = 'form-message error-message';
      return;
    }
    const payload = { supplierName, documentNumber: document.querySelector('#purchase-number').value.trim(), documentDate: document.querySelector('#purchase-date').value, note: document.querySelector('#purchase-note').value.trim(), sourceAutoOrderId: purchaseForm.dataset.sourceAutoOrderId || null, lines };
    const editing = purchaseForm.dataset.editId;
    setPurchasePending(true);
    message.textContent = 'Сохраняем черновик…'; message.className = 'form-message';
    try {
      await api(editing ? `/api/inventory/purchase-documents/${encodeURIComponent(editing)}` : '/api/inventory/purchase-documents', { method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const catalogLoaded = await loadPurchaseDocuments();
      resetPurchaseForm();
      message.textContent = editing ? 'Черновик обновлён. Остаток пока не изменён.' : 'Черновик сохранён. Остаток изменится после проведения.';
      message.className = 'form-message success-message';
      if (!catalogLoaded) portalNotice('Черновик сохранён, но список не обновился. Перезагрузите страницу.', 'error');
    } catch (error) {
      const reason = ['purchase_document_update_failed', 'purchase_document_create_failed'].includes(error.payload?.error) ? error.payload?.detail : error.payload?.error;
      message.textContent = reason === 'invalid_purchase_unit' ? 'Проверьте единицу закупки и коэффициент упаковки в карточке позиции.' : reason === 'purchase_ingredient_not_found' ? 'Одна из складских позиций больше недоступна. Обновите список.' : reason === 'purchase_quantity_exceeds_auto_order' ? 'Количество превышает остаток по заявке. Проверьте фактически полученное количество.' : reason === 'purchase_item_not_in_auto_order' ? 'В накладной есть позиция, которой нет в заявке. Создайте отдельный документ поступления.' : reason === 'source_auto_order_not_open' ? 'Заявка закрыта или отменена. Создайте обычный документ поступления.' : reason === 'document_number_exists' ? 'Накладная с таким номером уже есть. Проверьте номер документа.' : reason === 'purchase_document_not_draft' ? 'Черновик уже проведён или отменён. Обновите список.' : 'Не удалось сохранить черновик поступления.';
      message.className = 'form-message error-message';
    } finally { setPurchasePending(false); }
  });
  document.querySelector('#purchase-cancel')?.addEventListener('click', () => { if (!purchaseActionPending) resetPurchaseForm(); });
  document.querySelector('#purchase-document-list')?.addEventListener('click', (event) => { if (purchaseActionPending) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  document.querySelector('#purchase-document-list')?.addEventListener('click', async (event) => {
    if (purchaseActionPending) return;
    const editButton = event.target.closest('[data-purchase-edit]');
    const postButton = event.target.closest('[data-purchase-post]');
    if (editButton) {
      const doc = purchaseDocuments.find((entry) => entry.id === editButton.dataset.purchaseEdit);
      if (!doc || doc.status !== 'draft') return;
      purchaseForm.dataset.editId = doc.id;
      if (doc.sourceAutoOrderId) purchaseForm.dataset.sourceAutoOrderId = doc.sourceAutoOrderId; else delete purchaseForm.dataset.sourceAutoOrderId;
      const orderContext = document.querySelector('#purchase-order-context');
      if (orderContext) orderContext.hidden = !doc.sourceAutoOrderId;
      document.querySelector('#purchase-supplier').value = doc.supplierName || '';
      document.querySelector('#purchase-number').value = doc.documentNumber || '';
      document.querySelector('#purchase-date').value = String(doc.documentDate || '').slice(0, 10);
      document.querySelector('#purchase-note').value = doc.note || '';
      renderPurchaseLines(doc.lines.map((line) => ({ ingredientId: line.ingredientId, ingredientName: line.ingredientName, quantity: line.quantity, unit: line.unit, unitCost: line.unitCost })));
      updatePurchasePreviews();
      document.querySelector('#purchase-save').textContent = 'Сохранить изменения';
      document.querySelector('#purchase-cancel').hidden = false;
      purchaseForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (postButton) {
      const doc = purchaseDocuments.find((entry) => entry.id === postButton.dataset.purchasePost);
      if (!doc || doc.status !== 'draft' || !window.confirm(`Провести поступление от ${doc.supplierName || 'поставщика'} на ${money(doc.totalCost || 0)}? Остатки и закупочная стоимость обновятся.`)) return;
      setPurchasePending(true);
      try {
        await api(`/api/inventory/purchase-documents/${encodeURIComponent(doc.id)}/post`, { method: 'POST' });
        portalNotice('Поступление проведено: остаток и стоимость обновлены', 'success');
        const results = await Promise.allSettled([loadPurchaseDocuments(), loadAutoOrders(), load()]);
        if (results.some((result) => result.status === 'rejected' || result.value === false)) portalNotice('Поступление проведено, но данные не полностью обновились. Перезагрузите страницу.', 'error');
      } catch (error) {
        const reason = error.payload?.error === 'purchase_document_post_failed' ? error.payload?.detail : error.payload?.error;
        portalNotice(reason === 'purchase_ingredient_archived' ? 'Позиция в черновике архивирована. Выберите действующую позицию; для автозаказа — из этой заявки. Если подходящей позиции нет, отмените черновик и оформите новый приход. Остаток не изменён.' : reason === 'purchase_item_unit_changed' ? 'Карточка позиции изменилась после создания черновика. Обновите черновик и повторите.' : reason === 'purchase_quantity_exceeds_auto_order' ? 'В заявке осталось меньшее количество. Обновите черновик и проверьте накладную.' : reason === 'purchase_document_not_postable' ? 'Этот черновик уже проведён или отменён. Обновите список.' : 'Не удалось провести поступление', 'error');
      } finally { setPurchasePending(false); }
    }
  });
  document.querySelector('#purchase-document-list')?.addEventListener('click', async (event) => {
    if (purchaseActionPending) return;
    const button = event.target.closest('[data-purchase-reverse]');
    if (!button) return;
    const doc = purchaseDocuments.find((entry) => entry.id === button.dataset.purchaseReverse);
    if (!doc || doc.status !== 'posted' || doc.reversal || !doc.reversalPolicyEnabled || !canReversePurchaseDocuments) return;
    if (!window.confirm('Полностью сторнировать этот приход? Это доступно только пока ни одна затронутая позиция не использовалась и поставщику ничего не платили. Исторический документ останется в журнале.')) return;
    const storageKey = `purchase-reversal:${portalUser.venueId || ''}:${doc.id}`;
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch (_) { saved = null; }
    const reason = String(window.prompt('Укажите причину полного сторно прихода (3–500 символов):', saved?.reason || '') || '').trim();
    if (reason.length < 3 || reason.length > 500) { if (reason) portalNotice('Причина должна содержать от 3 до 500 символов.', 'error'); return; }
    const randomUuid = () => window.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
    const key = saved?.reason === reason && /^[0-9a-f-]{36}$/i.test(saved?.idempotencyKey || '') ? saved.idempotencyKey : randomUuid();
    try { sessionStorage.setItem(storageKey, JSON.stringify({ reason, idempotencyKey: key })); } catch (_) { /* the server still enforces source-document uniqueness */ }
    setPurchasePending(true);
    try {
      const result = await api(`/api/inventory/purchase-documents/${encodeURIComponent(doc.id)}/reverse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason, idempotencyKey: key }) });
      try { sessionStorage.removeItem(storageKey); } catch (_) { /* optional retry cache */ }
      portalNotice(result.idempotent ? 'Сторно уже было проведено; повтор не изменил склад.' : 'Приход сторнирован. Исходный документ и история себестоимости сохранены.', 'success');
      const refreshed = await Promise.allSettled([loadPurchaseDocuments(), loadAutoOrders(), load()]);
      if (refreshed.some((item) => item.status === 'rejected' || item.value === false)) portalNotice('Сторно сохранено, но часть данных не обновилась. Перезагрузите страницу.', 'error');
    } catch (error) {
      const reasons = {
        purchase_document_reversal_paid: 'По этому приходу уже есть оплата поставщику. Сторно заблокировано.',
        purchase_document_reversal_payment_coverage_unavailable: 'В заведении есть старые закупочные расходы без привязки к накладной. Сверьте их перед сторно прихода.',
        purchase_document_reversal_stock_changed: 'После прихода остаток или себестоимость изменились. Сторно заблокировано.',
        purchase_document_reversal_valuation_changed: 'Оценка остатка не совпадает с точным снимком прихода. Сторно заблокировано.',
        purchase_document_reversal_auto_order_changed: 'Связанный автозаказ изменился после прихода. Сторно заблокировано.',
        purchase_document_reversal_auto_order_unavailable: 'Связанный автозаказ нельзя безопасно восстановить. Сторно заблокировано.',
        purchase_document_reversal_open_shift_required: 'Для сторно нужна ровно одна открытая смена.',
        purchase_document_reversal_policy_unavailable: 'У документа нет сохранённой активной версии безопасного правила.',
        purchase_document_already_reversed: 'Этот приход уже сторнирован.',
        purchase_document_reversal_idempotency_conflict: 'Ключ повтора уже использован для другой операции.',
      };
      portalNotice(reasons[error.payload?.error] || (error.payload?.error === 'purchase_document_reversal_failed' ? 'Не удалось провести сторно. Изменения не сохранены.' : 'Сторно отклонено: документ старый, остаток использован либо условия безопасности не выполнены.'), 'error');
    } finally { setPurchasePending(false); }
  });
  document.querySelector('#purchase-document-list')?.addEventListener('click', async (event) => {
    if (purchaseActionPending) return;
    const button = event.target.closest('[data-purchase-void]');
    if (!button) return;
    const doc = purchaseDocuments.find((entry) => entry.id === button.dataset.purchaseVoid);
    if (!doc || doc.status !== 'draft' || !window.confirm('Отменить этот черновик? Он останется в журнале как отменённый; складские остатки не изменятся.')) return;
    setPurchasePending(true);
    try {
      await api(`/api/inventory/purchase-documents/${encodeURIComponent(doc.id)}/void`, { method: 'POST' });
      portalNotice('Черновик отменён. Остатки не изменились.', 'success');
      if (!await loadPurchaseDocuments()) portalNotice('Черновик отменён, но список не обновился. Перезагрузите страницу.', 'error');
    } catch (error) {
      portalNotice(error.payload?.error === 'purchase_document_not_voidable' ? 'Этот черновик уже проведён или отменён. Обновите список.' : 'Не удалось отменить черновик', 'error');
    } finally { setPurchasePending(false); }
  });
  if (purchaseForm) document.querySelector('#purchase-date').value = '';
  renderPurchaseLines(); loadPurchaseDocuments();
  const autoOrderStatus = { sent: 'Отправлена управляющему', partially_received: 'Частично получена', received: 'Получена полностью', cancelled: 'Отменена' };
  let autoOrderCreatePending = false;
  let autoOrderLoadGeneration = 0;
  const autoOrderCancelPending = new Set();
  const openAutoOrderReceipt = (request) => {
    if (!purchaseForm || !request || purchaseActionPending) return;
    const hasPurchaseDraft = Boolean(purchaseForm.dataset.editId || purchaseForm.dataset.sourceAutoOrderId || ['#purchase-supplier', '#purchase-number', '#purchase-date', '#purchase-note'].some((selector) => document.querySelector(selector)?.value.trim()) || getPurchaseLines().some((line) => line.ingredientId || line.quantity || line.unit || line.unitCost));
    if (hasPurchaseDraft && !window.confirm('Заменить текущий черновик приёмкой по заявке? Несохранённые изменения будут потеряны.')) return;
    const lines = (request.lines || []).map((line) => {
      const item = allItems.find((entry) => entry.id === line.itemId);
      const remaining = Math.max(0, Number(line.quantity || 0) - Number(line.receivedQuantity || 0));
      const factor = Math.max(0.000001, Number(line.packMultiplier || item?.packMultiplier || 1));
      return remaining > 0 && item ? { ingredientId: item.id, quantity: Number((remaining / factor).toFixed(6)), unit: line.purchaseUnit || item.purchaseUnit || item.unit, unitCost: Number((Number(line.unitCost || item.cost || 0) * factor).toFixed(2)) } : null;
    }).filter(Boolean);
    if (!lines.length) return portalNotice('В заявке не осталось позиций к приёмке', 'error');
    resetPurchaseForm();
    purchaseForm.dataset.sourceAutoOrderId = request.id;
    document.querySelector('#purchase-supplier').value = request.lines.find((line) => line.supplier)?.supplier || ''; const context = document.querySelector('#purchase-order-context'); if (context) context.hidden = false;
    document.querySelector('#purchase-note').value = `Приёмка по заявке от ${formatRuDate(request.createdAt, false)}`;
    renderPurchaseLines(lines);
    updatePurchasePreviews();
    const message = document.querySelector('#purchase-message');
    if (message) { message.textContent = 'Проверьте фактические количества и цены по накладной. Проведение обновит заявку и остатки.'; message.className = 'form-message'; }
    setInventoryView('movements');
    purchaseForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const drawAutoOrders = () => {
    const list = document.querySelector('#auto-order-list'); const count = document.querySelector('#auto-order-low-count'); const history = document.querySelector('#auto-order-history-list');
    const items = Array.isArray(autoOrderState.items) ? autoOrderState.items : []; const requests = Array.isArray(autoOrderState.requests) ? autoOrderState.requests : [];
    const priorSelections = new Map([...(list?.querySelectorAll('[data-auto-order-item]') || [])].map((input) => [input.dataset.autoOrderItem, { checked: input.checked, quantity: list.querySelector(`[data-auto-order-quantity="${CSS.escape(input.dataset.autoOrderItem)}"]`)?.value }]));
    if (count) { count.textContent = autoOrderState.error && !autoOrderState.hasLoaded ? 'Ошибка загрузки' : items.length ? `${items.length} ${pluralRu(items.length, 'позиция', 'позиции', 'позиций')}` : 'Всё в норме'; count.className = `badge ${autoOrderState.error ? 'danger' : items.length ? 'danger' : 'success'}`; }
    const createButton = document.querySelector('#create-auto-order'); if (createButton) { createButton.disabled = autoOrderCreatePending || Boolean(autoOrderState.error) || !items.length; createButton.title = autoOrderState.error ? 'Сначала повторите загрузку рекомендаций склада.' : ''; }
    if (list) list.innerHTML = `${autoOrderState.error ? `<div class="empty auto-order-load-error" role="alert"><strong>${autoOrderState.hasLoaded ? 'Не удалось обновить рекомендации' : 'Не удалось загрузить рекомендации'}</strong><small>${autoOrderState.hasLoaded ? 'Ниже показаны данные последней успешной загрузки. Проверьте их перед созданием заявки.' : 'Состояние остатков неизвестно — это не означает, что пополнение не требуется.'}</small><button class="button small" type="button" data-auto-order-retry>Повторить загрузку</button></div>` : ''}${items.length ? `<div class="table-wrap auto-order-table-wrap"><table><thead><tr><th class="auto-order-check-col">${canWriteInventory ? '<span class="sr-only">Выбрать</span>' : ''}</th><th>Позиция</th><th>Остаток</th><th>Порог пополнения</th><th>Рекомендуемо заказать</th><th>Поставщик</th><th>Оценка</th></tr></thead><tbody>${items.map((item) => `<tr><td class="auto-order-check-col" data-label="Выбрать">${canWriteInventory ? `<input type="checkbox" data-auto-order-item="${esc(item.id)}" checked aria-label="Добавить ${esc(item.name)} в заявку">` : ''}</td><td data-label="Позиция" class="auto-order-item-cell"><b>${esc(displayName(item.name))}</b><small>${esc(item.department || 'Склад')} · ${esc(item.category || 'Без категории')}</small></td><td data-label="Остаток"><strong class="${Number(item.onHand) <= Number(item.minLevel) ? 'text-danger' : ''}">${item.onHand}</strong> ${esc(item.unit || '')}</td><td data-label="Порог пополнения">${item.minLevel} ${esc(item.unit || '')}</td><td data-label="К заказу"><input class="auto-order-quantity" type="number" min="0.000001" step="0.000001" value="${item.orderQuantity}" data-auto-order-quantity="${esc(item.id)}" aria-label="Количество ${esc(item.name)}"><small>Цель: ${item.targetLevel} ${esc(item.unit || '')} · упаковка ${item.packMultiplier}</small></td><td data-label="Поставщик">${esc(item.supplier || 'Не указан')}</td><td data-label="Оценка">${money(item.estimate || 0)}</td></tr>`).join('')}</tbody></table></div><p class="auto-order-note muted">Сумма рассчитана по последней закупочной стоимости. Фактическая цена уточняется при приёмке.</p>` : autoOrderState.error ? '' : '<div class="empty auto-order-empty"><strong>Пополнение пока не требуется</strong><small>Все позиции с заданным минимумом находятся в норме. Если позиция не должна контролироваться, оставьте её минимум равным 0.</small></div>'}`;
    if (history) history.innerHTML = requests.length ? requests.map((request) => { const waiting = (request.lines || []).filter((line) => Number(line.quantity || 0) - Number(line.receivedQuantity || 0) > 0).map((line) => `${displayName(line.name)} — ${(Number(line.quantity || 0) - Number(line.receivedQuantity || 0)).toLocaleString('ru-RU')} ${line.unit || ''}`).join(', '); return `<div class="auto-order-request-row"><div><b>Заявка от ${formatRuDate(request.createdAt, true)}</b><small>${(request.lines || []).length} поз. · ${money(request.totalEstimate || 0)}${waiting ? ` · Осталось: ${esc(waiting)}` : ''}</small></div><span class="badge ${request.status === 'sent' ? 'warning' : request.status === 'received' ? 'success' : request.status === 'cancelled' ? 'danger' : 'info'}">${esc(autoOrderStatus[request.status] || request.status)}</span>${canWriteInventory && ['sent','partially_received'].includes(request.status) ? `<button class="button small primary" type="button" data-auto-order-receive="${esc(request.id)}">Оформить поступление</button><button class="button small" type="button" data-auto-order-cancel="${esc(request.id)}">Отменить</button>` : ''}</div>`; }).join('') : '<div class="empty">Заявок пока нет. Выберите позиции выше и сформируйте первую заявку.</div>';
    list?.querySelectorAll('[data-auto-order-item]').forEach((input) => { const prior = priorSelections.get(input.dataset.autoOrderItem); if (!prior) return; input.checked = prior.checked; const quantity = list.querySelector(`[data-auto-order-quantity="${CSS.escape(input.dataset.autoOrderItem)}"]`); if (quantity && prior.quantity !== undefined) quantity.value = prior.quantity; });
    history?.querySelectorAll('[data-auto-order-receive], [data-auto-order-cancel]').forEach((button) => { button.disabled = autoOrderCancelPending.has(button.dataset.autoOrderReceive || button.dataset.autoOrderCancel); });
    history?.querySelectorAll('[data-auto-order-receive]').forEach((button) => button.addEventListener('click', () => { if (autoOrderCancelPending.has(button.dataset.autoOrderReceive)) return; const request = requests.find((entry) => entry.id === button.dataset.autoOrderReceive); openAutoOrderReceipt(request); }));
    history?.querySelectorAll('[data-auto-order-cancel]').forEach((button) => button.addEventListener('click', async () => {
      const request = requests.find((entry) => entry.id === button.dataset.autoOrderCancel);
      if (!request || autoOrderCancelPending.has(request.id) || !window.confirm('Отменить заявку на пополнение? Уже проведённые поступления сохранятся.')) return;
      autoOrderCancelPending.add(request.id);
      drawAutoOrders();
      try {
        await api(`/api/inventory/auto-orders/${encodeURIComponent(request.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }) });
        request.status = 'cancelled';
        portalNotice('Заявка отменена', 'success');
        if (await loadAutoOrders() === false) portalNotice('Заявка отменена, но список не обновился. Повторите загрузку.', 'error');
      } catch (error) {
        portalNotice(error.payload?.error === 'auto_order_has_draft_receipts' ? 'Сначала проведите черновик поступления. Заявку с черновиком отменить нельзя.' : error.payload?.error === 'auto_order_not_cancellable' ? 'Заявка уже закрыта. Обновите список.' : 'Не удалось отменить заявку', 'error');
      } finally { autoOrderCancelPending.delete(request.id); drawAutoOrders(); }
    }));
  };
  const loadAutoOrders = async () => {
    const generation = ++autoOrderLoadGeneration;
    try {
      const data = await api('/api/inventory/auto-orders');
      if (generation !== autoOrderLoadGeneration) return null;
      autoOrderState = { items: data.items || [], requests: data.requests || [], error: null, hasLoaded: true };
      drawAutoOrders(); refreshInventoryContext();
      return true;
    } catch {
      if (generation !== autoOrderLoadGeneration) return null;
      autoOrderState = { ...autoOrderState, error: true };
      drawAutoOrders(); refreshInventoryContext();
      portalNotice('Не удалось загрузить рекомендации по пополнению', 'error');
      return false;
    }
  };
  document.querySelector('#auto-order-list')?.addEventListener('click', (event) => { const button = event.target.closest('[data-auto-order-retry]'); if (!button) return; button.disabled = true; button.textContent = 'Загружаем…'; loadAutoOrders(); });
  document.querySelector('#inventory-low')?.closest('.kpi')?.addEventListener('click', () => { setInventoryView('auto-orders'); document.querySelector('#auto-order-list')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  document.querySelector('#create-auto-order')?.addEventListener('click', async () => {
    if (autoOrderCreatePending || autoOrderState.error) return;
    const checked = [...document.querySelectorAll('[data-auto-order-item]')].filter((input) => input.checked);
    if (!checked.length) return portalNotice('Выберите хотя бы одну позицию', 'error');
    const lines = checked.map((input) => ({ itemId: input.dataset.autoOrderItem, quantity: Number(document.querySelector(`[data-auto-order-quantity="${CSS.escape(input.dataset.autoOrderItem)}"]`)?.value) }));
    if (lines.some((line) => !Number.isFinite(line.quantity) || line.quantity <= 0)) return portalNotice('Укажите количество больше нуля для каждой выбранной позиции', 'error');
    autoOrderCreatePending = true;
    drawAutoOrders();
    try {
      const created = await api('/api/inventory/auto-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: lines }) });
      autoOrderState = { ...autoOrderState, requests: [created, ...(autoOrderState.requests || []).filter((item) => item.id !== created.id)] };
      document.querySelectorAll('[data-auto-order-item]').forEach((input) => { input.checked = false; });
      portalNotice('Заявка создана и доступна в разделе пополнения запасов', 'success');
      if (await loadAutoOrders() === false) portalNotice('Заявка создана, но список не обновился. Повторите загрузку.', 'error');
    } catch (error) {
      portalNotice(error.payload?.error === 'auto_order_items_required' ? 'Выберите позиции для заявки' : error.payload?.error === 'auto_order_item_not_found' ? 'Одна из позиций недоступна. Обновите рекомендации.' : 'Не удалось сформировать заявку', 'error');
    } finally { autoOrderCreatePending = false; drawAutoOrders(); }
  });
  loadAutoOrders();
  const draw = (query = '') => { const rows = document.querySelector('#inventory-rows'); if (!rows) return; const department = document.querySelector('#inventory-department-filter')?.value || ''; const normalizedQuery = normalizeInventorySearch(query); rows.innerHTML = allItems.filter((item) => (!department || String(item.department || '') === department) && normalizeInventorySearch(`${item.name} ${item.category} ${item.department}`).includes(normalizedQuery)).map((item) => `<tr><td data-label="Позиция" class="inventory-item-cell"><b>${esc(displayName(item.name))}</b><small>${esc(item.unit)} · ${money(item.cost || 0)}</small>${(item.alcoholCatalogItem || alcoholProfileById(item.alcoholCatalogItemId)) ? `<small class=\"inventory-alcohol-profile\">${esc(alcoholItemLabel(item.alcoholCatalogItem || alcoholProfileById(item.alcoholCatalogItemId)))}</small>` : ''}</td><td data-label="Цех / категория">${esc(displayName(item.department || ''))} / ${esc(displayName(item.category))}</td><td data-label="Остаток"><strong>${item.onHand}</strong> ${esc(item.unit)}</td><td data-label="Порог пополнения">${item.minLevel} ${esc(item.unit)}</td><td data-label="Состояние"><span class="badge ${Number(item.minLevel || 0) <= 0 ? '' : Number(item.onHand) <= Number(item.minLevel) ? 'danger' : 'success'}">${Number(item.minLevel || 0) <= 0 ? 'Порог не задан' : Number(item.onHand) <= Number(item.minLevel) ? 'Нужно пополнить' : 'В норме'}</span></td><td data-label="Действия">${canWriteInventory ? `<button class="button small inventory-item-edit" type="button" data-item="${esc(item.id)}">Изменить</button>` : '—'}</td></tr>`).join('') || `<tr><td colspan="6" class="empty"><strong>${department || normalizedQuery ? 'По выбранным условиям позиций нет' : 'Позиций пока нет'}</strong><small>${department || normalizedQuery ? 'Измените поиск или фильтр цеха.' : 'Добавьте первую складскую позицию, чтобы начать учёт остатков.'}</small>${canWriteInventory && !department && !normalizedQuery ? '<button type="button" class="button small primary inventory-empty-add">Добавить позицию</button>' : ''}</td></tr>`; };
    document.addEventListener('alcohol-catalog-updated', () => { draw(document.querySelector('#inventory-search')?.value || ''); });
    const inventoryLoadErrorMarkup = () => '<tr><td colspan="6" class="empty inventory-load-error" role="alert"><strong>Не удалось загрузить склад</strong><small>Проверьте соединение и повторите попытку.</small><button class="button small" type="button" data-inventory-retry>Повторить загрузку</button></td></tr>';
    const load = () => { inventoryLoadState = 'loading'; refreshInventoryContext(); return api('/api/inventory').then((data) => { invalidateRecipeCostCache(); payload = data; inventoryLoadState = 'loaded'; allItems = data.items || []; renderPurchaseLines(getPurchaseLines().length ? getPurchaseLines() : undefined); updatePurchasePreviews(); document.querySelector('#inventory-count').textContent = allItems.length; document.querySelector('#inventory-low').textContent = data.lowStock?.length || 0; const departmentFilter = document.querySelector('#inventory-department-filter'); if (departmentFilter) { const departments = [...new Set(allItems.map((item) => item.department).filter(Boolean))]; const current = departmentFilter.value; departmentFilter.innerHTML = '<option value="">Все цеха</option>' + departments.map((department) => `<option value="${esc(department)}">${esc(displayName(department))}</option>`).join(''); departmentFilter.value = departments.includes(current) ? current : ''; } const latest = data.movements?.[0]; const history = document.querySelector('#movement-history-list'); if (history) history.innerHTML = data.movements?.length ? data.movements.slice(0, 12).map((movement) => { const delta = movement.delta !== undefined ? Number(movement.delta) : (['in','transfer','adjustment'].includes(movement.direction) ? Number(movement.quantity) : -Number(movement.quantity)); const operation = delta > 0 ? 'Приход' : 'Расход'; return `<div class="movement-row"><div><b>${esc(displayName(movement.itemName || movement.itemId))}</b><small>${operation} · ${esc(movement.reason || 'Без причины')} · ${formatRuDate(movement.createdAt, true)}</small></div><strong class="${delta > 0 ? 'movement-in' : 'movement-out'}">${delta > 0 ? '+' : ''}${delta} ${esc(movement.unit || '')}</strong></div>`; }).join('') : '<div class="empty">Движений пока нет. После первой поставки или списания запись появится здесь.</div>'; document.querySelector('#inventory-last').textContent = latest ? `${(latest.delta !== undefined ? Number(latest.delta) > 0 : ['in','transfer','adjustment'].includes(latest.direction)) ? 'Приход' : 'Расход'} · ${Math.abs(Number(latest.delta ?? latest.quantity ?? 0))} ${latest.unit || ''}` : 'Нет'; const select = document.querySelector('#movement-item'); if (select) select.innerHTML = allItems.length ? allItems.map((item) => `<option value="${item.id}">${esc(displayName(item.name))} · ${esc(item.unit || 'шт')}</option>`).join('') : '<option value="">Сначала добавьте позицию</option>'; updateMovementUnit(); draw(document.querySelector('#inventory-search').value); refreshInventoryContext(); }).catch(() => { inventoryLoadState = 'error'; refreshInventoryContext(); document.querySelector('#inventory-rows').innerHTML = inventoryLoadErrorMarkup(); portalNotice('Не удалось загрузить склад', 'error'); }); };
  const updateMovementUnit = () => { const item = allItems.find((entry) => entry.id === document.querySelector('#movement-item')?.value); const unit = document.querySelector('#movement-unit'); const hint = document.querySelector('#movement-unit-hint'); if (unit && item) { unit.value = item.unit || 'шт'; hint.textContent = `Единица хранения: ${item.unit || 'шт'}`; } else if (hint) hint.textContent = 'Единица: —'; };
  document.querySelector('#open-movement')?.addEventListener('click', () => { setInventoryView('movements'); document.querySelector('#movement-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); updateMovementUnit(); document.querySelector('#movement-item')?.focus(); });
  document.querySelector('#inventory-search').addEventListener('input', (event) => draw(event.target.value));
  document.querySelector('#inventory-department-filter')?.addEventListener('change', () => draw(document.querySelector('#inventory-search').value));
  document.querySelector('#movement-item')?.addEventListener('change', updateMovementUnit);
  document.querySelector('#movement-direction')?.addEventListener('change', (event) => { const costLabel = document.querySelector('#movement-unit-cost-label'); if (costLabel) costLabel.hidden = true; });
  document.querySelector('#inventory-rows')?.addEventListener('click', (event) => { const retry = event.target.closest('[data-inventory-retry]'); if (retry) { retry.disabled = true; retry.textContent = 'Загружаем…'; load(); return; } if (event.target.closest('.inventory-empty-add')) { document.querySelector('#new-inventory-item')?.click(); } });
  document.querySelector('#movement-form')?.addEventListener('submit', (event) => { event.preventDefault(); const form = event.target; if (form.dataset.submitting === '1') return; form.dataset.submitting = '1'; const submit = form.querySelector('button[type="submit"]'); if (submit) { submit.disabled = true; submit.textContent = 'Сохраняем…'; } const controls = [...form.querySelectorAll('input, select, textarea')].map((control) => ({ control, disabled: control.disabled })); controls.forEach(({ control }) => { control.disabled = true; control._customSelectRefresh?.(); }); const message = document.querySelector('#movement-message'); const direction = document.querySelector('#movement-direction').value; const itemId = document.querySelector('#movement-item').value; const quantity = Number(document.querySelector('#movement-delta').value); const unit = document.querySelector('#movement-unit').value; const reason = document.querySelector('#movement-reason').value; const endpoint = '/api/inventory/movements'; const body = { itemId, delta: (direction === 'out' ? -1 : 1) * quantity, unit, reason }; api(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(() => { message.className = 'form-message success-message'; message.textContent = 'Движение сохранено, остаток обновлён'; form.reset();  load(); loadAutoOrders(); }).catch((error) => { const reasonCode = String(error.payload?.error || error.message || ''); message.className = 'form-message error-message'; message.textContent = reasonCode.includes('409') || reasonCode === 'insufficient_stock' ? 'Недостаточно остатка для расхода' : reasonCode === 'invalid_supply_unit' ? 'Проверьте единицу и количество поставки' : reasonCode === 'movement_reason_too_long' ? 'Причина не должна быть длиннее 200 символов' : 'Не удалось сохранить операцию'; }).finally(() => { controls.forEach(({ control, disabled }) => { control.disabled = disabled; control._customSelectRefresh?.(); }); form.dataset.submitting = '0'; if (submit) { submit.disabled = false; submit.textContent = 'Сохранить операцию'; } }); });
  if (canWriteInventory) { const form = document.querySelector('#inventory-item-form'); const reset = () => { form.reset(); syncAlcoholLinkSelector(''); form.hidden = true; inventoryItemEditor.hidden = true; inventoryItemEditor.classList?.remove('inventory-item-modal'); form.dataset.itemId = ''; inventoryItemEditor.querySelector('h2').textContent = 'Новая складская позиция'; document.querySelector('#inventory-item-message').textContent = ''; const purchaseCost = document.querySelector('#inventory-item-purchase-cost'); if (purchaseCost) { purchaseCost.value = ''; purchaseCost.dataset.userEdited = '0'; } const cost = document.querySelector('#inventory-item-cost'); if (cost) cost.value = '0'; }; document.querySelector('#new-inventory-item')?.addEventListener('click', () => { if (form.dataset.submitting === '1') return; reset(); inventoryItemEditor.hidden = false; form.hidden = false; inventoryItemEditor.classList?.add('inventory-item-modal'); document.querySelector('#inventory-item-name').focus({ preventScroll: true }); }); document.querySelector('#cancel-inventory-item')?.addEventListener('click', () => { if (form.dataset.submitting !== '1') reset(); }); document.querySelector('#inventory-rows')?.addEventListener('click', (event) => { const button = event.target.closest('.inventory-item-edit'); if (form.dataset.submitting === '1') return; const item = allItems.find((entry) => entry.id === button?.dataset.item); if (!item) return; inventoryItemEditor.hidden = false; form.hidden = false; inventoryItemEditor.classList?.add('inventory-item-modal'); form.dataset.itemId = item.id; inventoryItemEditor.querySelector('h2').textContent = 'Редактирование позиции'; for (const [key, value] of Object.entries({ name: item.name, department: item.department || 'inventory', subdepartment: item.subdepartment || '', category: item.categoryId || productCategoryItems.find((entry) => entry.name === item.category)?.id || '', type: item.itemType || 'ingredient', unit: item.unit || 'шт', 'purchase-unit': item.purchaseUnit || '', pack: item.packMultiplier || 1, 'purchase-cost': item.cost && item.packMultiplier ? Number(item.cost) * Number(item.packMultiplier) : '', cost: item.cost || 0, min: item.minLevel || 0, supplier: item.supplier || '', barcode: item.barcode || '', 'alcohol-catalog': item.alcoholCatalogItemId || item.alcoholCatalogItem?.id || '', 'tobacco-catalog': item.tobaccoCatalogItemId || item.tobaccoCatalogItem?.id || '', note: item.note || '' })) { const field = document.querySelector(`#inventory-item-${key}`); if (field) { field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })); } } syncAlcoholLinkSelector(item.alcoholCatalogItemId || item.alcoholCatalogItem?.id || ''); syncTobaccoLinkSelector(item.tobaccoCatalogItemId || item.tobaccoCatalogItem?.id || ''); const purchaseCostField = document.querySelector('#inventory-item-purchase-cost'); if (purchaseCostField) purchaseCostField.dataset.userEdited = '0'; syncInventoryCostPreview(); }); document.querySelector('#inventory-item-category')?.addEventListener('change', () => syncAlcoholLinkSelector()); document.querySelector('#inventory-item-tobacco-catalog')?.addEventListener('change', () => syncTobaccoLinkSelector()); document.querySelector('#inventory-item-unit')?.addEventListener('change', () => syncTobaccoLinkSelector()); document.querySelector('#inventory-item-alcohol-catalog')?.addEventListener('change', () => syncAlcoholLinkSelector(document.querySelector('#inventory-item-alcohol-catalog').value)); document.querySelector('#inventory-item-tobacco-catalog')?.addEventListener('change', () => syncTobaccoLinkSelector()); document.querySelector('#inventory-item-unit')?.addEventListener('change', () => syncTobaccoLinkSelector()); const syncInventoryCostPreview = () => { const purchaseCostField = document.querySelector('#inventory-item-purchase-cost'); const packField = document.querySelector('#inventory-item-pack'); const costField = document.querySelector('#inventory-item-cost'); const hint = document.querySelector('#inventory-item-cost-hint'); if (!purchaseCostField || !packField || !costField) return; const purchaseCost = Number(String(purchaseCostField.value || '').replace(',', '.')); const pack = Number(String(packField.value || '').replace(',', '.')); const hasPurchaseCost = String(purchaseCostField.value || '').trim() !== ''; const valid = hasPurchaseCost && Number.isFinite(purchaseCost) && purchaseCost >= 0 && Number.isFinite(pack) && pack > 0; costField.value = valid ? String(Number((purchaseCost / pack).toFixed(4))) : '0'; if (hint) hint.textContent = valid ? `Расчёт: ${purchaseCost.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽ ÷ ${pack.toLocaleString('ru-RU', { maximumFractionDigits: 6 })} = ${Number(costField.value).toLocaleString('ru-RU', { maximumFractionDigits: 4 })} ₽ за ${document.querySelector('#inventory-item-unit')?.value || 'единицу'}.` : 'Укажите цену закупочной единицы и фасовку, чтобы получить стоимость 1 мл, г или шт.'; }; const purchaseCostField = document.querySelector('#inventory-item-purchase-cost'); purchaseCostField?.addEventListener('input', () => { purchaseCostField.dataset.userEdited = '1'; syncInventoryCostPreview(); }); document.querySelector('#inventory-item-pack')?.addEventListener('input', syncInventoryCostPreview); document.querySelector('#inventory-item-unit')?.addEventListener('input', syncInventoryCostPreview); form?.addEventListener('submit', (event) => { event.preventDefault(); if (form.dataset.submitting === '1') return; const message = document.querySelector('#inventory-item-message'); const payload = { name: document.querySelector('#inventory-item-name').value.trim(), department: document.querySelector('#inventory-item-department').value, subdepartment: document.querySelector('#inventory-item-subdepartment').value.trim(), category: productCategoryItems.find((entry) => String(entry.id) === document.querySelector('#inventory-item-category').value)?.name || '', categoryId: document.querySelector('#inventory-item-category').value || null, tobaccoCatalogItemId: document.querySelector('#inventory-item-tobacco-catalog').value || null, itemType: document.querySelector('#inventory-item-type').value, unit: document.querySelector('#inventory-item-unit').value, purchaseUnit: document.querySelector('#inventory-item-purchase-unit').value.trim(), packMultiplier: Number(document.querySelector('#inventory-item-pack').value), minLevel: Number(document.querySelector('#inventory-item-min').value), supplier: document.querySelector('#inventory-item-supplier').value.trim(), barcode: document.querySelector('#inventory-item-barcode').value.trim(), alcoholCatalogItemId: document.querySelector('#inventory-item-alcohol-catalog').value || null, note: document.querySelector('#inventory-item-note').value.trim() }; const purchaseCostInput = document.querySelector('#inventory-item-purchase-cost'); if (purchaseCostInput?.dataset.userEdited === '1') { if (String(purchaseCostInput.value || '').trim() === '') { message.textContent = 'Укажите цену закупочной единицы или отмените изменение этого поля'; message.className = 'form-message error-message'; return; } payload.purchaseCost = Number(purchaseCostInput.value); payload.cost = Number(document.querySelector('#inventory-item-cost').value); } const knownSubdepartment = inventorySubdepartments.some((item) => String(item.departmentCode) === payload.department && String(item.name).toLocaleLowerCase('ru-RU') === payload.subdepartment.toLocaleLowerCase('ru-RU')); if (payload.subdepartment && !knownSubdepartment) { message.textContent = 'Выберите подцех из справочника выбранного цеха'; message.className = 'form-message error-message'; return; } const id = form.dataset.itemId; const controls = [...form.querySelectorAll('input, select, textarea, button')].map((control) => ({ control, disabled: control.disabled })); const newButton = document.querySelector('#new-inventory-item'); const newButtonWasDisabled = newButton?.disabled; form.dataset.submitting = '1'; controls.forEach(({ control }) => { control.disabled = true; control._customSelectRefresh?.(); }); if (newButton) newButton.disabled = true; const submit = form.querySelector('[type=submit]'); if (submit) submit.textContent = 'Сохраняем…'; api(id ? `/api/inventory/items/${encodeURIComponent(id)}` : '/api/inventory/items', { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(() => { reset(); portalNotice('Позиция сохранена', 'success'); load(); loadAutoOrders(); }).catch((error) => { const reason = error.payload?.error; message.textContent = reason === 'invalid_inventory_item_measurement' ? 'Проверьте единицу и тип позиции' : reason === 'inventory_department_not_found' ? 'Выберите действующий цех из справочника' : reason === 'inventory_subdepartment_not_found' ? 'Выберите подцех из справочника выбранного цеха' : reason === 'inventory_category_subdepartment_mismatch' ? 'Категория относится к другому подцеху. Проверьте выбранный подцех или категорию.' : reason === 'inventory_category_department_mismatch' ? 'Категория больше не относится к выбранному цеху. Обновите список категорий.' : reason === 'inventory_category_not_found' ? 'Выберите категорию из актуального справочника или укажите «Без категории».' : reason === 'inventory_item_changed_retry' ? 'Позиция изменилась в другом окне. Обновите форму и повторите.' : 'Не удалось сохранить позицию'; message.className = 'form-message error-message'; }).finally(() => { controls.forEach(({ control, disabled }) => { control.disabled = disabled; control._customSelectRefresh?.(); }); if (newButton) newButton.disabled = newButtonWasDisabled; form.dataset.submitting = '0'; if (submit) submit.textContent = 'Сохранить позицию'; }); }); }
  load();
}

function renderFinanceCategories() {
  const target = document.querySelector('#page-content'); if (!target) return;
  const canWrite = portalPermissions.has('finance');
  target.innerHTML = `<div class="page-title"><div><p class="eyebrow">ФИНАНСОВЫЙ СПРАВОЧНИК</p><h1>Категории доходов и расходов</h1><p class="muted">Категории расходов используются в журнале затрат. Продажи пока группируются по составу меню, поэтому категории доходов не назначаются отдельным продажам. Архивные категории сохраняют историю и могут быть восстановлены.</p></div><div class="toolbar-row"><a class="button" href="/finance">${icon('arrow-left')} Финансы</a>${canWrite ? `<button class="button primary" id="new-finance-category" type="button">${icon('plus')} Новая категория</button>` : '<span class="badge">Только просмотр</span>'}</div></div><section class="panel wide finance-categories-panel"><div class="panel-head"><div><h2>Справочник категорий</h2><span class="muted" id="finance-category-count">Загрузка…</span></div><div class="toolbar-row finance-category-filters"><input class="table-search" id="finance-category-search" aria-label="Поиск категорий" placeholder="Поиск по названию"><label class="inline-filter">Статус<select id="finance-category-status" aria-label="Фильтр по статусу"><option value="active">Активные</option>${canWrite ? '<option value="all">Включая архивные</option>' : ''}</select></label></div></div>${canWrite ? '<form id="finance-category-form" class="product-editor" hidden><input type="hidden" id="finance-category-id"><label>Название<input id="finance-category-name" maxlength="80" required placeholder="Например, Аренда"></label><label>Тип<select id="finance-category-kind"><option value="income">Доход</option><option value="expense">Расход</option></select></label><div class="toolbar-row"><button class="button primary" type="submit">Сохранить</button><button class="button" id="cancel-finance-category" type="button">Отмена</button><button class="button danger-outline" id="archive-finance-category" type="button" hidden>Архивировать</button></div><p class="form-message" id="finance-category-message" role="status" aria-live="polite"></p></form>' : ''}<div class="category-list" id="finance-category-list"><div class="empty">Загрузка категорий…</div></div></section>`;
  let items = [];
  let categoryLoadRequestId = 0;
  let categoryLoadError = false;
  let categoryMutationPending = false;
  const setCategoryMutationPending = (pending) => {
    categoryMutationPending = pending;
    target.querySelectorAll('#new-finance-category,#finance-category-status,.finance-category-edit,[data-category-status],#finance-category-form input,#finance-category-form select,#finance-category-form button').forEach((control) => { control.disabled = pending; control._customSelectRefresh?.(); });
  };
  const draw = () => {
    if (categoryLoadError) return;
    const query = document.querySelector('#finance-category-search').value.trim().toLocaleLowerCase('ru-RU');
    const visible = items.filter((item) => !query || item.name.toLocaleLowerCase('ru-RU').includes(query));
    document.querySelector('#finance-category-count').textContent = `${visible.length} из ${items.length} категорий`;
    document.querySelector('#finance-category-list').innerHTML = visible.length ? visible.map((item) => `<div class="category-row"><div><b>${esc(displayName(item.name))}</b><small>${item.kind === 'income' ? 'Доход' : 'Расход'} · ${Number(item.operationCount || 0)} ${pluralRu(Number(item.operationCount || 0), 'операция', 'операции', 'операций')}</small></div><span class="badge ${item.active === false ? 'warning' : item.kind === 'income' ? 'success' : 'info'}">${item.active === false ? 'В архиве' : item.kind === 'income' ? 'Доход' : 'Расход'}</span>${canWrite ? `<button class="button small finance-category-edit" type="button" data-category="${esc(item.id)}">Изменить</button><button class="button small ${item.active === false ? 'primary' : 'danger-outline'}" type="button" data-category-status="${esc(item.id)}" data-active="${item.active === false ? 'false' : 'true'}">${item.active === false ? 'Восстановить' : 'Архивировать'}</button>` : ''}</div>`).join('') : `<div class="empty">${items.length ? 'По этому запросу категорий нет' : 'Категорий пока нет. Создайте категорию, чтобы выбирать её в финансовых операциях.'}</div>`;
    if (categoryMutationPending) setCategoryMutationPending(true);
  };
  const load = () => { const requestId = ++categoryLoadRequestId; const query = document.querySelector('#finance-category-status').value === 'all' ? '?includeArchived=true' : ''; return api(`/api/finance/categories${query}`).then((data) => { if (requestId !== categoryLoadRequestId) return false; categoryLoadError = false; items = data.items || []; draw(); return true; }).catch(() => { if (requestId !== categoryLoadRequestId) return false; categoryLoadError = true; items = []; document.querySelector('#finance-category-count').textContent = '—'; document.querySelector('#finance-category-list').innerHTML = '<div class="empty" role="alert">Не удалось загрузить категории. <button type="button" class="button small" data-finance-category-retry>Повторить</button></div>'; portalNotice('Не удалось загрузить категории финансов', 'error'); return false; }); };
  document.querySelector('#finance-category-search').addEventListener('input', draw);
  document.querySelector('#finance-category-status').addEventListener('change', load);
  document.querySelector('#finance-category-list').addEventListener('click', (event) => { if (event.target.closest('[data-finance-category-retry]')) load(); });
  if (canWrite) {
    const form = document.querySelector('#finance-category-form'); const archiveButton = document.querySelector('#archive-finance-category');
    const reset = () => { form.reset(); document.querySelector('#finance-category-id').value = ''; const message = document.querySelector('#finance-category-message'); message.textContent = ''; message.className = 'form-message'; archiveButton.hidden = true; archiveButton.textContent = 'Архивировать'; form.hidden = true; };
    document.querySelector('#new-finance-category').addEventListener('click', () => { if (categoryMutationPending) return; reset(); form.hidden = false; form.scrollIntoView({ behavior: 'smooth', block: 'center' }); document.querySelector('#finance-category-name').focus(); });
    document.querySelector('#cancel-finance-category').addEventListener('click', () => { if (!categoryMutationPending) reset(); });
    document.querySelector('#finance-category-list').addEventListener('click', async (event) => {
      const statusButton = event.target.closest('[data-category-status]');
      if (statusButton) { if (categoryMutationPending) return; const item = items.find((entry) => entry.id === statusButton.dataset.categoryStatus); if (!item) return; const active = statusButton.dataset.active === 'true'; setCategoryMutationPending(true); try { if (active && !await portalConfirm('Архивировать категорию?', `${Number(item.operationCount || 0)} исторических операций сохранятся. Категорию можно восстановить позже.`, 'Архивировать')) return; await api(`/api/finance/categories/${encodeURIComponent(item.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !active }) }); const refreshed = await load(); portalNotice(refreshed ? active ? 'Категория помещена в архив' : 'Категория восстановлена' : 'Категория изменена, но список не обновился. Повторите загрузку.', refreshed ? 'success' : 'error'); } catch { portalNotice('Не удалось изменить категорию', 'error'); } finally { setCategoryMutationPending(false); } return; }
      const button = event.target.closest('[data-category]'); if (!button || categoryMutationPending) return; const item = items.find((entry) => entry.id === button.dataset.category); if (!item) return; reset(); form.hidden = false; document.querySelector('#finance-category-id').value = item.id; document.querySelector('#finance-category-name').value = item.name; document.querySelector('#finance-category-kind').value = item.kind; archiveButton.hidden = false; archiveButton.textContent = item.active === false ? 'Восстановить' : 'Архивировать'; form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    form.addEventListener('submit', (event) => { event.preventDefault(); if (categoryMutationPending) return; const id = document.querySelector('#finance-category-id').value; const message = document.querySelector('#finance-category-message'); const payload = { name: document.querySelector('#finance-category-name').value.trim(), kind: document.querySelector('#finance-category-kind').value }; setCategoryMutationPending(true); api(id ? `/api/finance/categories/${encodeURIComponent(id)}` : '/api/finance/categories', { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(async () => { reset(); const refreshed = await load(); portalNotice(refreshed ? 'Категория сохранена' : 'Категория сохранена, но список не обновился. Повторите загрузку.', refreshed ? 'success' : 'error'); }).catch((error) => { message.textContent = error.payload?.error === 'finance_category_exists' ? 'Активная категория с таким названием уже есть' : 'Не удалось сохранить категорию'; message.className = 'form-message error-message'; }).finally(() => { setCategoryMutationPending(false); }); });
    archiveButton.addEventListener('click', async () => { if (categoryMutationPending) return; const id = document.querySelector('#finance-category-id').value; const item = items.find((entry) => entry.id === id); if (!item) return; const active = item.active !== false; setCategoryMutationPending(true); try { if (active && !await portalConfirm('Архивировать категорию?', `${Number(item.operationCount || 0)} исторических операций сохранятся. Категорию можно восстановить позже.`, 'Архивировать')) return; await api(`/api/finance/categories/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !active }) }); reset(); const refreshed = await load(); portalNotice(refreshed ? active ? 'Категория помещена в архив' : 'Категория восстановлена' : 'Категория изменена, но список не обновился. Повторите загрузку.', refreshed ? 'success' : 'error'); } catch { portalNotice('Не удалось изменить категорию', 'error'); } finally { setCategoryMutationPending(false); } });
  }
  load();
}
function renderFinance() {
  const target = document.querySelector('#page-content'); if (!target) return;
  const employeeFinanceView = ['bartender','hookah_master','senior_bartender','senior_hookah_master','cleaner','security','technician','other_staff'].includes(String(portalUser.role || '').toLowerCase());
  const canDecideFinance = portalPermissions.has('finance');
  const payrollStatusLabel = (status) => ({ draft: 'Черновик', approved: 'Утверждено', paid: 'Выплачено', cancelled: 'Отменено' }[String(status || '').toLowerCase()] || 'Требует проверки');
  if (employeeFinanceView) {
    target.innerHTML = `<div class="page-title"><div><p class="eyebrow">МОЯ СМЕНА</p><h1>Оборот сегодня</h1><p class="muted">Оборот заказов, открытых вами сегодня.</p></div></div><section class="panel employee-turnover-panel"><div><span class="muted">Оборот заказов, открытых вами сегодня</span><strong id="finance-revenue">Загрузка…</strong></div><small class="muted">Сумма оплаченных заказов, которые вы открыли за сегодня</small></section>`;
    api(`/api/finance/summary?date=${encodeURIComponent(localDateKey())}`).then((summary) => { const value = document.querySelector('#finance-revenue'); if (value) value.textContent = money(summary.revenue || 0); }).catch(() => { const value = document.querySelector('#finance-revenue'); if (value) value.textContent = 'Не удалось загрузить'; });
    return;
  }
  target.innerHTML = `<div class="page-title"><div><p class="eyebrow">КОНТРОЛЬ ДЕНЕГ</p><h1>Финансы</h1><p class="muted">Оплаты и выручка за выбранную дату; график и итоговые показатели имеют свои периоды.</p></div><input class="date-input" type="date" value="${localDateKey()}" id="finance-date" aria-label="Дата сводки оплат"></div><nav class="finance-section-nav" aria-label="Разделы финансов"><a href="#finance-chart-panel">График</a><a href="#finance-result-panel">Результат</a><a href="#finance-staff-panel">Команда</a><a href="#cash-register-panel">Смена и касса</a><a href="#payables">Поставщики</a><a href="#finance-payments-panel">Оплаты</a><a href="#discounts">Скидки</a><a href="#payroll">Зарплата</a></nav><div class="kpi-grid compact finance-kpi-grid"><article class="kpi dashboard-revenue-card finance-revenue-card" data-kpi-target="#payment-list" data-revenue-style="hero" aria-label="Показать оплаты"><div class="dashboard-revenue-main"><span id="finance-revenue-label">Выручка сегодня</span><strong id="finance-revenue">—</strong><small class="positive">Данные обновляются из оплат ↗</small></div><div class="dashboard-revenue-pending"><span>Ожидается</span><strong id="finance-pending-revenue">—</strong><small id="finance-pending-detail">за открытые заказы</small></div></article><article class="kpi" ${portalPermissions.has('orders') ? 'data-kpi-route="/" aria-label="Открыть зал и заказы"' : ''}><span>Заказы</span><strong id="finance-orders">—</strong><small id="finance-orders-detail">Закрытые и открытые</small></article><article class="kpi" data-kpi-target="#payment-list" aria-label="Показать платежи"><span>Платежи</span><strong id="finance-payments">—</strong><small id="finance-average-check">Проведено операций · Средний чек смены: —</small></article></div><section class="panel finance-chart-panel" id="finance-chart-panel"><div class="panel-head"><div><h2>Динамика показателей</h2><span class="muted">Настраиваемая инфографика за выбранный период</span></div><div class="toolbar-row finance-chart-controls"><label>Показатель<select id="finance-chart-metric"><option value="revenue">Оборот заведения</option><option value="profit">Чистая прибыль</option><option value="expenses">Расходы</option><option value="orders">Заказы</option><option value="average_median">Средний и медианный чек</option><option value="average">Средний чек</option></select></label><label>Период<select id="finance-chart-period"><option value="7">7 дней</option><option value="14">14 дней</option><option value="30">30 дней</option><option value="90">90 дней</option><option value="365">Год</option><option value="all">За всё время</option></select></label><div class="finance-chart-view" role="group" aria-label="Вид диаграммы"><button type="button" class="is-active" aria-pressed="true" data-finance-chart-view="line">Линия</button><button type="button" aria-pressed="false" data-finance-chart-view="bars">Столбцы</button><button type="button" aria-pressed="false" data-finance-chart-view="table">Таблица</button></div></div></div><div id="finance-chart" class="finance-chart"><div class="empty">Загрузка графика…</div></div></section><section class="panel finance-business-panel" id="finance-result-panel"><div class="panel-head"><div><h2>Финансовый результат заведения</h2><span class="muted">Оборот, расходы и чистая прибыль за всё время</span></div></div><div class="finance-result-grid"><article><span>Общий оборот</span><strong id="finance-total-turnover">—</strong><small>Все оплаченные продажи</small></article><article><span>Расходная часть</span><strong id="finance-total-expenses">—</strong><small>Зарегистрированные расходы</small></article><article><span>Себестоимость продаж</span><strong id="finance-total-cogs">—</strong><small>Списано по технологическим картам</small></article><article><span>Чистая прибыль</span><strong id="finance-net-profit">—</strong><small>Оборот минус расходы</small></article></div><p class="muted finance-expense-note">Расходы учитываются после внесения операций в финансовый справочник.</p><div class="finance-segment-grid"><article><span>Среднее количество столов в день</span><strong id="finance-avg-tables">—</strong><small>Занятые столы по закрытым заказам</small></article><article><span>Средний чек · Бар</span><strong id="finance-avg-bar">—</strong><small>Заказы с позициями бара</small></article><article><span>Средний чек · Кальяны</span><strong id="finance-avg-hookah">—</strong><small>Заказы с позициями кальянов</small></article></div></section><section class="panel finance-staff-panel" id="finance-staff-panel"><div class="panel-head"><div><h2>Динамика команды</h2><span class="muted">Вклад сотрудников и управляющих в оборот за последние 7 дней</span></div></div><div id="finance-staff-dynamics" class="finance-staff-dynamics"><div class="empty">Загрузка динамики команды…</div></div></section><section class="panel cash-register-panel is-closed" id="cash-register-panel"><div class="panel-head"><div><h2>Смена и касса</h2><span class="muted" id="cash-register-status">Проверяем состояние смены…</span><small class="cash-register-hint" id="cash-register-hint">Смена связывает оплаты с текущим рабочим периодом.</small></div><a class="button small" id="cash-register-action" href="/admin#shift-control">Открыть смену</a></div><div class="cash-register-grid"><div><span>Стартовый остаток</span><strong id="cash-register-opening">—</strong></div><div><span>Открыта</span><strong id="cash-register-opened">—</strong></div><div><span>Номер смены</span><strong id="cash-register-id">—</strong></div></div></section><div class="content-grid finance-payments-grid" id="finance-payments-panel"><section class="panel wide"><div class="panel-head payment-panel-head"><div><h2>Оплаты по способу</h2><span class="muted">Сравнение способов оплаты за выбранную дату</span></div><div class="finance-chart-view" role="group" aria-label="Вид оплат"><button type="button" class="is-active" aria-pressed="true" data-payment-view="donut">Круговая</button><button type="button" aria-pressed="false" data-payment-view="bars">Колонки</button><button type="button" aria-pressed="false" data-payment-view="line">График</button><button type="button" aria-pressed="false" data-payment-view="table">Таблица</button></div></div><div class="payment-list" id="payment-list"></div></section></div>`;
  const payablesSection = document.createElement('section');
  payablesSection.className = 'panel finance-payables-panel';
  payablesSection.innerHTML = `<div class="panel-head"><div><h2>Расчёты с поставщиками</h2><span class="muted">Проведённые поставки и остаток оплаты по каждой накладной</span></div><div class="finance-payables-totals"><span><b id="payables-count">—</b><small>накладных</small></span><span><b id="payables-balance">—</b><small>к оплате</small></span></div></div><div class="finance-payables-toolbar"><label class="finance-payables-search">Поиск поставщика или накладной<input id="payables-search" type="search" placeholder="Название или номер"></label><label>Статус оплаты<select id="payables-status"><option value="">Все</option><option value="unpaid">Не оплачена</option><option value="partially_paid">Частично оплачена</option><option value="paid">Оплачена</option></select></label></div><div class="finance-payables-date-filters" role="group" aria-label="Фильтры расчётов с поставщиками"><label>Дата накладной с<input id="payables-date-from" type="date"></label><label>Дата накладной по<input id="payables-date-to" type="date"></label><label class="payables-filter-undated"><input id="payables-include-undated" type="checkbox"> Включить накладные без даты</label><div class="toolbar-row"><button type="button" class="button small primary" id="payables-filter-apply">Показать</button><button type="button" class="button small" id="payables-filter-reset">За всё время</button></div></div><p id="payables-filter-message" class="form-message" role="status" aria-live="polite"></p><div id="payables-list" class="finance-payables-list" aria-live="polite"><div class="empty">Загрузка поставок…</div></div><p class="muted finance-payables-note">Оплата уменьшает денежный остаток. Себестоимость товара учитывается в прибыли при продаже.</p>`;
  if (!employeeFinanceView) target.insertBefore(payablesSection, target.querySelector('.finance-payments-grid'));
  const discountSection = document.createElement('section');
  discountSection.className = 'panel finance-discounts-panel';
  discountSection.id = 'discounts';
  discountSection.innerHTML = `<div class="panel-head"><div><h2>Заявки на скидку <span class="badge warning" id="finance-discounts">—</span></h2><span class="muted">Решение по скидке для открытого заказа</span></div><button class="button small" id="discount-reload" type="button">Обновить</button></div><p class="form-message" id="discount-message" role="status" aria-live="polite"></p><div id="discount-list" class="discount-list" aria-live="polite"><div class="empty">Загрузка заявок…</div></div>`;
  target.insertBefore(discountSection, target.querySelector('.finance-chart-panel'));
  const scrollToDiscounts = () => { if (window.location.hash === '#discounts') discountSection.scrollIntoView({ block: 'start' }); };
  window.addEventListener('hashchange', scrollToDiscounts);
  requestAnimationFrame(scrollToDiscounts);
  const payablesList = payablesSection.querySelector('#payables-list');
  let payableItems = [];
  let payableLoadError = false;
  let payablePaymentPending = false;
  const paymentLabels = { cash: 'Наличные', card: 'Карта', bank_transfer: 'Перевод', other: 'Другое' };
  const payableStatusLabels = { unpaid: ['Не оплачена', 'warning'], partially_paid: ['Частично оплачена', 'info'], paid: ['Оплачена', 'success'] };
  const payablesFilterFields = { from: payablesSection.querySelector('#payables-date-from'), to: payablesSection.querySelector('#payables-date-to'), undated: payablesSection.querySelector('#payables-include-undated'), status: payablesSection.querySelector('#payables-status'), search: payablesSection.querySelector('#payables-search') };
  const payablesFilterStorageKey = 'hookah.purchase-payables-filters.v1';
  const readPayablesFilterState = () => ({ from: payablesFilterFields.from.value, to: payablesFilterFields.to.value, includeUndated: payablesFilterFields.undated.checked, status: payablesFilterFields.status.value, search: payablesFilterFields.search.value });
  const savePayablesFilterState = () => { try { sessionStorage.setItem(payablesFilterStorageKey, JSON.stringify(readPayablesFilterState())); } catch (_) {} };
  try { const saved = JSON.parse(sessionStorage.getItem(payablesFilterStorageKey) || 'null'); if (saved && typeof saved === 'object') { if (/^\d{4}-\d{2}-\d{2}$/.test(saved.from || '')) payablesFilterFields.from.value = saved.from; if (/^\d{4}-\d{2}-\d{2}$/.test(saved.to || '')) payablesFilterFields.to.value = saved.to; if (['', 'unpaid', 'partially_paid', 'paid'].includes(saved.status)) payablesFilterFields.status.value = saved.status; payablesFilterFields.undated.checked = saved.includeUndated === true; if (typeof saved.search === 'string') payablesFilterFields.search.value = saved.search.slice(0, 160); } } catch (_) {}
  const drawPayables = (force = false) => {
    if (payablePaymentPending && force !== true) return;
    if (payableLoadError) { payablesList.innerHTML = '<div class="empty">Не удалось загрузить расчёты с поставщиками</div>'; return; }
    const state = readPayablesFilterState(); const search = String(state.search || '').trim().toLocaleLowerCase('ru-RU'); const status = state.status;
    const rows = payableItems.filter((item) => (!status || item.paymentStatus === status) && (!search || `${item.supplierName} ${item.documentNumber || ''}`.toLocaleLowerCase('ru-RU').includes(search)));
    const outstanding = rows.reduce((sum, item) => sum + Number(item.balanceDue || 0), 0);
    payablesSection.querySelector('#payables-count').textContent = rows.length.toLocaleString('ru-RU');
    payablesSection.querySelector('#payables-balance').textContent = money(outstanding);
    if (!rows.length) { const filtered = state.from || state.to || state.includeUndated || state.status || search; payablesList.innerHTML = `<div class="empty">${filtered ? 'По выбранным условиям поставок нет.' : 'Проведённых поставок пока нет. Сначала оформите и проведите накладную в разделе «Склад».'}</div>`; return; }
    payablesList.innerHTML = rows.map((item) => {
      const [label, style] = payableStatusLabels[item.paymentStatus] || payableStatusLabels.unpaid;
      const history = `<details class="payable-payment-history" data-payable-history="${esc(item.id)}" data-loaded="false"><summary>История оплат</summary><div class="payable-payment-history-list" aria-live="polite"><span class="muted">Откройте, чтобы посмотреть оплаты по накладной</span></div></details>`;
      const editor = canDecideFinance && item.balanceDue > 0.005 ? `<details class="payable-payment-editor"><summary class="button small primary">Зафиксировать оплату</summary><form class="payable-payment-form stack-form" data-payable-id="${esc(item.id)}" data-idempotency-key="${esc(globalThis.crypto?.randomUUID?.() || `pay-${Date.now()}-${Math.random().toString(36).slice(2)}`)}"><div class="form-row"><label>Сумма оплаты<input name="amount" type="number" inputmode="decimal" min="0.01" max="${Number(item.balanceDue).toFixed(2)}" step="0.01" value="${Number(item.balanceDue).toFixed(2)}" required></label><label>Дата оплаты<input name="paymentDate" type="date" value="${localDateKey()}" required></label></div><div class="form-row"><label>Способ оплаты<select name="paymentMethod" required><option value="bank_transfer">Безналичный перевод</option><option value="cash">Наличные</option><option value="card">Карта</option><option value="other">Другое</option></select></label><label>Подтверждающий документ<input name="document" type="file" accept="image/png,image/jpeg,image/webp,application/pdf"><small class="muted">Необязательно, до 1,4 МБ.</small></label></div><p class="form-message payable-payment-message" role="status" aria-live="polite"></p><div class="toolbar-row"><button type="submit" class="button small primary">Сохранить оплату</button></div></form></details>` : canDecideFinance ? '<small class="muted">Оплачена полностью</small>' : '<small class="muted">Только просмотр</small>';
      return `<article class="payable-row"><div class="payable-row-main"><div class="payable-supplier"><b>${esc(item.supplierName || 'Поставщик не указан')}</b><small>${item.documentNumber ? `Накладная № ${esc(item.documentNumber)} · ` : ''}${item.documentDate ? esc(formatRuDate(item.documentDate)) : 'Дата накладной не указана'}</small></div><div class="payable-amount"><span>Сумма</span><b>${money(item.totalCost)}</b></div><div class="payable-amount"><span>Оплачено</span><b>${money(item.totalPaid)}</b></div><div class="payable-amount payable-amount-due"><span>Остаток</span><b>${money(item.balanceDue)}</b></div><span class="badge ${style}">${label}</span>${history}${editor}</div></article>`;
    }).join('');
    payablesList.querySelectorAll('[data-payable-history]').forEach((details) => details.addEventListener('toggle', () => {
      if (!details.open || details.dataset.loaded === 'true') return;
      const list = details.querySelector('.payable-payment-history-list');
      details.dataset.loaded = 'loading'; list.innerHTML = '<span class="muted">Загружаем историю оплат…</span>';
      api(`/api/finance/purchase-payables/${encodeURIComponent(details.dataset.payableHistory)}/payments`).then((data) => {
        const payments = Array.isArray(data.items) ? data.items : [];
        const labels = { cash: 'Наличные', card: 'Карта', bank_transfer: 'Безналичный перевод', other: 'Другое' };
        list.innerHTML = payments.length ? payments.map((payment) => {
          const evidence = typeof payment.documentUrl === 'string' && /^data:(?:image\/(?:png|jpeg|webp)|application\/pdf);base64,[A-Za-z0-9+/=\r\n]+$/i.test(payment.documentUrl)
            ? `<a href="${esc(payment.documentUrl)}" target="_blank" rel="noopener noreferrer">Открыть документ</a>` : '';
          return `<div class="payable-payment-history-item"><time>${esc(formatRuDate(payment.paymentDate))}</time><span>${esc(labels[payment.paymentMethod] || 'Способ не указан')}</span><b>${money(payment.amount)}</b>${evidence}</div>`;
        }).join('') : '<span class="muted">По этой накладной ещё не было оплат</span>';
        details.dataset.loaded = 'true';
      }).catch(() => { details.dataset.loaded = 'false'; list.innerHTML = '<span class="muted">Не удалось загрузить историю. Закройте и откройте её, чтобы повторить.</span>'; });
    }));
  };
  let payableLoadRequestId = 0;
  const loadPayables = () => {
    const state = readPayablesFilterState(); const message = payablesSection.querySelector('#payables-filter-message');
    if (state.from && state.to && state.from > state.to) { if (message) { message.textContent = 'Начало периода должно быть раньше или равно окончанию.'; message.className = 'form-message error-message'; } return Promise.resolve(); }
    if (message) { message.textContent = ''; message.className = 'form-message'; }
    savePayablesFilterState();
    const requestId = ++payableLoadRequestId;
    if (staticDemo()) { payablesList.innerHTML = '<div class="empty">Реестр оплат поставщикам доступен при подключённой серверной базе</div>'; return Promise.resolve(); }
    const params = new URLSearchParams(); if (state.from) params.set('documentDateFrom', state.from); if (state.to) params.set('documentDateTo', state.to); if (state.includeUndated) params.set('includeUndated', 'true'); if (state.status) params.set('paymentStatus', state.status);
    const query = params.toString();
    return api(`/api/finance/purchase-payables${query ? `?${query}` : ''}`).then((data) => {
      if (requestId !== payableLoadRequestId) return;
      payableLoadError = false;
      payableItems = data.items || [];
      drawPayables(true);
    }).catch(() => {
      if (requestId !== payableLoadRequestId) return;
      payableLoadError = true;
      payableItems = [];
      payablesSection.querySelector('#payables-count').textContent = '—';
      payablesSection.querySelector('#payables-balance').textContent = '—';
      payablesList.innerHTML = '<div class="empty">Не удалось загрузить расчёты с поставщиками</div>';
    });
  };
  payablesSection.querySelector('#payables-filter-apply').addEventListener('click', () => loadPayables());
  payablesSection.querySelector('#payables-filter-reset').addEventListener('click', () => { payablesFilterFields.from.value = ''; payablesFilterFields.to.value = ''; payablesFilterFields.undated.checked = false; payablesFilterFields.status.value = ''; payablesFilterFields.search.value = ''; loadPayables(); });
  payablesSection.querySelector('#payables-search').addEventListener('input', () => { savePayablesFilterState(); drawPayables(); });
  payablesSection.querySelector('#payables-status').addEventListener('change', () => loadPayables());
  payablesSection.addEventListener('change', (event) => {
    const input = event.target.closest('input[name="document"]'); if (!input) return;
    const message = input.closest('.payable-payment-form')?.querySelector('.payable-payment-message');
    const file = input.files?.[0];
    if (!file) { if (message) message.textContent = ''; return; }
    const validation = window.PurchaseDocumentValidation?.validateFile(file);
    if (!validation?.valid) {
      input.value = '';
      if (message) message.textContent = validation?.error === 'unsupported_purchase_payment_document_type'
        ? 'Поддерживаются только PNG, JPEG, WebP и PDF.'
        : validation?.error === 'purchase_payment_document_too_large'
          ? 'Файл больше 1,4 МБ. Выберите файл меньшего размера.'
          : 'Не удалось проверить файл. Выберите PNG, JPEG, WebP или PDF.';
      return;
    }
    if (message) message.textContent = '';
  });
  payablesSection.addEventListener('submit', (event) => {
    const form = event.target.closest('.payable-payment-form'); if (!form) return;
    event.preventDefault();
    if (payablePaymentPending) { form.querySelector('.payable-payment-message').textContent = 'Дождитесь завершения предыдущей оплаты.'; return; }
    const file = form.querySelector('input[name="document"]').files?.[0]; const message = form.querySelector('.payable-payment-message'); const submit = form.querySelector('button[type="submit"]');
    if (file) {
      const validation = window.PurchaseDocumentValidation?.validateFile(file);
      if (!validation?.valid) {
        message.textContent = validation?.error === 'unsupported_purchase_payment_document_type'
          ? 'Поддерживаются только PNG, JPEG, WebP и PDF.'
          : validation?.error === 'purchase_payment_document_too_large'
            ? 'Файл больше 1,4 МБ. Выберите файл меньшего размера.'
            : 'Не удалось проверить файл. Выберите PNG, JPEG, WebP или PDF.';
        return;
      }
    }
    const payload = { amount: Number(form.elements.amount.value), paymentDate: form.elements.paymentDate.value, paymentMethod: form.elements.paymentMethod.value, idempotencyKey: form.dataset.idempotencyKey };
    const controls = [...form.querySelectorAll('input,select,textarea,button')].map((control) => ({ control, disabled: control.disabled }));
    payablePaymentPending = true;
    controls.forEach(({ control }) => { control.disabled = true; control._customSelectRefresh?.(); });
    message.textContent = 'Сохраняем оплату…';
    const filters = [...payablesSection.querySelectorAll('#payables-search,#payables-status,#payables-date-from,#payables-date-to,#payables-include-undated,#payables-filter-apply,#payables-filter-reset')];
    filters.forEach((control) => { control.disabled = true; control._customSelectRefresh?.(); });
    let finished = false;
    const finish = () => { if (finished) return; finished = true; payablePaymentPending = false; filters.forEach((control) => { control.disabled = false; control._customSelectRefresh?.(); }); controls.forEach(({ control, disabled }) => { if (control.isConnected) { control.disabled = disabled; control._customSelectRefresh?.(); } }); };
    const send = (documentUrl = '') => {
      api(`/api/finance/purchase-payables/${encodeURIComponent(form.dataset.payableId)}/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, documentUrl }) })
        .then(() => { portalNotice('Оплата поставки сохранена', 'success'); return loadPayables(); })
        .then(() => { loadExpenses(); document.querySelector('#finance-date')?.dispatchEvent(new Event('change')); })
        .catch((error) => { const messages = { purchase_payment_exceeds_balance: 'Сумма больше остатка по накладной. Обновите данные и повторите.', purchase_document_not_posted: 'Оплачивать можно только проведённую накладную.', purchase_document_not_found: 'Накладная не найдена в этом заведении.', purchase_payment_idempotency_conflict: 'Этот запрос уже использован для другой оплаты. Обновите страницу.', invalid_purchase_payment_document: 'Файл повреждён или не соответствует типу. Прикрепите PNG, JPEG, WebP или PDF.', unsupported_purchase_payment_document_type: 'Поддерживаются только PNG, JPEG, WebP и PDF.', purchase_payment_document_too_large: 'Файл больше 1,4 МБ. Выберите файл меньшего размера.' }; message.textContent = messages[error.payload?.error || error.message] || 'Не удалось сохранить оплату. Проверьте данные и повторите.'; })
        .finally(finish);
    };
    if (!file) { send(); return; }
    const reader = new FileReader(); reader.onload = () => {
      const documentUrl = String(reader.result || '');
      const validation = window.PurchaseDocumentValidation?.validateDataUrl(documentUrl);
      if (!validation?.valid) {
        message.textContent = validation?.error === 'purchase_payment_document_too_large'
          ? 'Файл больше 1,4 МБ. Выберите файл меньшего размера.'
          : 'Файл не похож на PNG, JPEG, WebP или PDF. Выберите корректный документ.';
        finish();
        return;
      }
      send(documentUrl);
    }; reader.onerror = () => { message.textContent = 'Не удалось прочитать документ'; finish(); }; reader.onabort = () => { message.textContent = 'Чтение документа прервано. Повторите оплату.'; finish(); }; try { reader.readAsDataURL(file); } catch (_) { message.textContent = 'Не удалось прочитать документ'; finish(); }
  });
  if (!employeeFinanceView) loadPayables();
  if (employeeFinanceView) {
    document.querySelector('.finance-chart-panel')?.setAttribute('hidden','');
    document.querySelector('.finance-business-panel')?.setAttribute('hidden','');
    document.querySelector('.finance-staff-panel')?.setAttribute('hidden','');
    document.querySelector('.cash-register-panel')?.setAttribute('hidden','');
    document.querySelector('.finance-payments-grid')?.setAttribute('hidden','');
    document.querySelector('.finance-kpi-grid article:nth-child(2)')?.setAttribute('hidden','');
    document.querySelector('.finance-kpi-grid article:nth-child(3)')?.setAttribute('hidden','');
    const date = document.querySelector('#finance-date'); if (date) { date.value = localDateKey(); date.disabled = true; date.setAttribute('aria-label','Текущий день'); }
    const title = target.querySelector('.page-title h1'); if (title) title.textContent = 'Оборот сегодня';
    const subtitle = target.querySelector('.page-title .muted'); if (subtitle) subtitle.textContent = 'Текущий рабочий день и общий оборот.';
  }
  const financePrefs = getFinanceMetricPreferences();
  const expenseSection = document.createElement('section');
  expenseSection.className = 'panel finance-expenses-panel';
  expenseSection.innerHTML = `<div class="panel-head"><div><h2>Расходы и затраты</h2><span class="muted">Операционные расходы влияют на прибыль. Поставки и оплаты поставщикам ведутся отдельно, чтобы не учитывать закупку дважды.</span></div></div>${canDecideFinance ? '<form id="expense-form" class="stack-form"><div class="form-row"><label>Категория <span class="required-mark">*</span><select id="expense-category" required><option value="">Загрузка категорий…</option></select><small id="expense-category-help" class="muted">Категорию можно создать в <a href="/finance/categories">справочнике расходов</a>.</small></label><label>Сумма <span class="required-mark">*</span><input id="expense-amount" type="number" min="0" step="0.01" required></label></div><div class="form-row"><label>Дата <span class="required-mark">*</span><input id="expense-date" type="date" value="${localDateKey()}" required></label><label>Контрагент<input id="expense-counterparty" maxlength="160" placeholder="Необязательно"></label></div><label>Как учитывать<select id="expense-source"><option value="manual">Операционный расход — уменьшает прибыль и денежный остаток</option><option value="other">Разовый расход без привязки к накладной</option></select></label><label>Описание<input id="expense-description" maxlength="1000" placeholder="Комментарий, номер накладной или чека"></label><label>Документ<input id="expense-document" type="file" accept="image/png,image/jpeg,image/webp,application/pdf"><small class="muted">Чек, счёт, акт или квитанция до 1,4 МБ.</small></label><button class="button primary" type="submit">Добавить расход</button><p class="form-message" id="expense-message"></p></form>' : '<p class="muted">Для добавления расходов требуется право финансового управления.</p>'}<div class="finance-payables-toolbar finance-expenses-filters"><label>Период с<input id="expenses-filter-from" type="date" aria-label="Начало периода расходов"></label><label>Период по<input id="expenses-filter-to" type="date" aria-label="Конец периода расходов"></label><div class="toolbar-row"><button type="button" class="button small primary" id="expenses-filter-apply">Показать</button><button type="button" class="button small" id="expenses-filter-reset">За всё время</button></div></div><div id="expense-list" class="expense-list"><div class="empty">Загрузка расходов…</div></div><div id="expenses-pagination" class="finance-expenses-pagination" aria-live="polite"></div>`;
  target.append(expenseSection);
  const expenseList = expenseSection.querySelector('#expense-list');
  const expenseCategory = expenseSection.querySelector('#expense-category');
  const loadExpenseCategories = () => api('/api/finance/categories').then((data) => { const options = (data.items || []).filter((item) => item.active !== false && item.kind === 'expense'); expenseCategory.innerHTML = '<option value="">Выберите категорию расхода</option>' + options.map((item) => `<option value="${esc(item.id)}">${esc(displayName(item.name))}</option>`).join(''); expenseCategory.disabled = !options.length; const help = expenseSection.querySelector('#expense-category-help'); if (help) help.innerHTML = options.length ? 'Категории редактируются в <a href="/finance/categories">справочнике финансов</a>.' : 'Сначала <a href="/finance/categories">создайте категорию расхода в справочнике</a>.'; }).catch(() => { expenseCategory.innerHTML = '<option value="">Не удалось загрузить категории</option>'; expenseCategory.disabled = true; });
  const expensePageSize = 20;
  let expenseOffset = 0;
  let expenseLoadRequestId = 0;
  const loadExpenses = () => {
    const requestId = ++expenseLoadRequestId;
    const offset = expenseOffset;
    const from = expenseSection.querySelector('#expenses-filter-from').value;
    const to = expenseSection.querySelector('#expenses-filter-to').value;
    if (from && to && from > to) { expenseList.innerHTML = '<div class="empty">Начало периода должно быть раньше его окончания</div>'; expenseSection.querySelector('#expenses-pagination').textContent = ''; return Promise.resolve(); }
    const params = new URLSearchParams({ from: from || '1900-01-01', to: to || '2999-12-31', limit: String(expensePageSize), offset: String(offset) });
    return api(`/api/expenses?${params}`).then((data) => {
      if (requestId !== expenseLoadRequestId) return;
      const items = data.items || [];
      const totalCount = Number(data.totalCount ?? items.length);
      expenseList.innerHTML = items.length ? items.map((item) => {
        const documentLink = typeof item.documentUrl === 'string' && /^data:(?:image\/(?:png|jpeg|webp)|application\/pdf);base64,[A-Za-z0-9+/=\r\n]+$/i.test(item.documentUrl) ? ` · <a href="${esc(item.documentUrl)}" target="_blank" rel="noopener noreferrer">Открыть документ</a>` : '';
        return `<div class="payment-row"><span><b>${esc(displayName(item.category))}${item.source === 'purchase' ? ' · закупка' : ''}${item.payrollNeedsReview ? ' · требует сверки выплаты' : ''}</b><small>${esc(item.expenseDate ? formatRuDate(item.expenseDate) : '')}${item.paymentMethod ? ` · ${esc(paymentLabels[item.paymentMethod] || item.paymentMethod)}` : ''}${item.description ? ` · ${esc(item.description)}` : ''}${documentLink}${item.source === 'payroll' ? ` · статус: ${esc(payrollStatusLabel(item.payrollStatus))}` : ''}</small></span><strong>${money(item.amount)}</strong></div>`;
      }).join('') : '<div class="empty">За выбранный период расходов нет</div>';
      const start = totalCount ? offset + 1 : 0;
      const end = Math.min(offset + items.length, totalCount);
      expenseSection.querySelector('#expenses-pagination').innerHTML = `<span class="muted">Показаны ${start}–${end} из ${totalCount}</span><div class="toolbar-row"><button type="button" class="button small" data-expenses-page="prev" ${offset === 0 ? 'disabled' : ''}>Назад</button><button type="button" class="button small" data-expenses-page="next" ${end >= totalCount ? 'disabled' : ''}>Далее</button></div>`;
    }).catch(() => { if (requestId !== expenseLoadRequestId) return; expenseList.innerHTML = '<div class="empty">Не удалось загрузить расходы</div>'; expenseSection.querySelector('#expenses-pagination').textContent = ''; });
  };
  expenseSection.querySelector('#expenses-filter-apply').addEventListener('click', () => { expenseOffset = 0; loadExpenses(); });
  expenseSection.querySelector('#expenses-filter-reset').addEventListener('click', () => { expenseSection.querySelector('#expenses-filter-from').value = ''; expenseSection.querySelector('#expenses-filter-to').value = ''; expenseOffset = 0; loadExpenses(); });
  expenseSection.querySelector('#expenses-pagination').addEventListener('click', (event) => { const action = event.target.closest('[data-expenses-page]')?.dataset.expensesPage; if (!action) return; expenseOffset = Math.max(0, expenseOffset + (action === 'next' ? expensePageSize : -expensePageSize)); loadExpenses(); });
  const expenseForm = expenseSection.querySelector('#expense-form');
  expenseForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (expenseForm.dataset.submitting === '1') return;
    const file = expenseSection.querySelector('#expense-document')?.files?.[0];
    if (file && file.size > 1400000) { portalNotice('Документ слишком большой. Максимум 1,4 МБ', 'error'); return; }
    const payload = { categoryId: expenseSection.querySelector('#expense-category').value, amount: Number(expenseSection.querySelector('#expense-amount').value), expenseDate: expenseSection.querySelector('#expense-date').value, description: `${expenseSection.querySelector('#expense-counterparty').value.trim()}${expenseSection.querySelector('#expense-description').value.trim() ? ` · ${expenseSection.querySelector('#expense-description').value.trim()}` : ''}`.replace(/^ · | · $/g, ''), source: expenseSection.querySelector('#expense-source').value };
    const controls = [...expenseForm.querySelectorAll('input,select,textarea,button')].map((control) => ({ control, disabled: control.disabled }));
    const submit = expenseForm.querySelector('button[type="submit"]'); const submitLabel = submit.textContent;
    expenseForm.dataset.submitting = '1'; controls.forEach(({ control }) => { control.disabled = true; control._customSelectRefresh?.(); }); submit.textContent = 'Сохраняем…';
    let finished = false;
    const finish = () => { if (finished) return; finished = true; expenseForm.dataset.submitting = '0'; controls.forEach(({ control, disabled }) => { control.disabled = disabled; control._customSelectRefresh?.(); }); submit.textContent = submitLabel; };
    const send = (documentUrl = '') => api('/api/expenses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, documentUrl }) }).then(() => { portalNotice('Расход сохранён', 'success'); expenseForm.reset(); expenseSection.querySelector('#expense-date').value = localDateKey(); expenseOffset = 0; return Promise.allSettled([loadExpenses(), load()]); }).catch((error) => portalNotice(error.payload?.error === 'purchase_payment_requires_receipt_link' ? 'Поставку сначала оформите и проведите в разделе «Склад», затем зафиксируйте оплату здесь.' : error.payload?.error === 'invalid_finance_category' ? 'Выберите активную категорию типа «Расход».' : 'Не удалось сохранить расход', 'error')).finally(finish);
    if (!file) { send(); return; }
    const reader = new FileReader(); reader.onload = () => send(String(reader.result || '')); reader.onerror = () => { portalNotice('Не удалось прочитать документ', 'error'); finish(); }; reader.onabort = finish; try { reader.readAsDataURL(file); } catch (_) { portalNotice('Не удалось прочитать документ', 'error'); finish(); }
  });
  if (canDecideFinance) { loadExpenses(); loadExpenseCategories(); } else expenseList.innerHTML = '<div class="empty">Подробный журнал расходов доступен финансовым ролям</div>';
  let loadPayroll = () => Promise.resolve();
  if (canDecideFinance && !employeeFinanceView) {
    const todayDate = localDateKey();
    const monthStart = `${todayDate.slice(0, 7)}-01`;
    const payrollSection = document.createElement('section');
    payrollSection.className = 'panel finance-payroll-panel';
    payrollSection.id = 'payroll';
    payrollSection.innerHTML = `<div class="panel-head"><div><h2>Зарплатный реестр</h2><span class="muted">Черновики, утверждения и фактические выплаты сотрудникам</span></div><button type="button" class="button small" id="payroll-create-toggle">Начислить зарплату</button></div><form id="payroll-create-form" class="stack-form product-editor" hidden><div class="form-row"><label>Сотрудник <span class="required-mark">*</span><select id="payroll-create-user" required><option value="">Загрузка сотрудников…</option></select></label><label>Модель оплаты <span class="required-mark">*</span><select id="payroll-create-rule" required><option value="">Загрузка правил…</option></select></label></div><div class="form-row"><label>Период с <span class="required-mark">*</span><input id="payroll-create-from" type="date" value="${monthStart}" required></label><label>Период по <span class="required-mark">*</span><input id="payroll-create-to" type="date" value="${todayDate}" required></label></div><p class="muted payroll-calculation-note">Сумма начисления рассчитывается автоматически по выбранной модели оплаты и данным за период: отработанному времени, продажам или другим условиям модели.</p><div class="toolbar-row"><button type="submit" class="button primary">Рассчитать и сохранить черновик</button><button type="button" class="button" id="payroll-create-cancel">Отмена</button></div><p class="form-message" id="payroll-create-message" role="status" aria-live="polite"></p></form><div class="toolbar-row finance-payroll-filters"><label>Период с<input type="date" id="payroll-filter-from" value="${monthStart}" aria-label="Начало периода зарплатного реестра"></label><label>Период по<input type="date" id="payroll-filter-to" value="${todayDate}" aria-label="Конец периода зарплатного реестра"></label><label>Сотрудник<select id="payroll-filter-user" aria-label="Фильтр по сотруднику"><option value="">Все сотрудники</option></select></label><label>Модель оплаты<select id="payroll-filter-rule" aria-label="Фильтр по модели оплаты"><option value="">Все модели</option></select></label><button type="button" class="button small" id="payroll-reload">Обновить</button></div><p class="form-message" id="payroll-message" role="status" aria-live="polite"></p><div id="payroll-register" class="expense-list" aria-live="polite"><div class="empty">Загрузка зарплатного реестра…</div></div>`;
    target.insertBefore(payrollSection, expenseSection);
    if (location.hash === '#payroll') requestAnimationFrame(() => payrollSection.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    const register = payrollSection.querySelector('#payroll-register');
    const registerMessage = payrollSection.querySelector('#payroll-message');
    if (staticDemo()) {
      register.innerHTML = '<div class="empty">В демо-режиме зарплатные начисления не подменяются тестовыми данными. Откройте подключённый серверный реестр.</div>';
      payrollSection.querySelector('#payroll-create-toggle').disabled = true;
    }
    const entryStatuses = { draft: ['Черновик', 'warning'], approved: ['Утверждено', 'success'], paid: ['Выплачено', 'success'], cancelled: ['Отменено', 'danger'] };
    let payrollItems = [];
    let payrollReady = false;
    let payrollRequestId = 0;
    const payrollPendingEntries = new Set();
    const filterOptions = (selector, values, allLabel) => {
      const field = payrollSection.querySelector(selector); const previous = field.value;
      const options = [...new Map(values.filter((item) => item.id && item.name).map((item) => [String(item.id), { id: item.id, name: item.name }])).values()];
      field.innerHTML = `<option value="">${allLabel}</option>${options.map((item) => `<option value="${esc(item.id)}">${esc(displayName(item.name))}</option>`).join('')}`;
      if (options.some((item) => String(item.id) === previous)) field.value = previous;
    };
    const drawPayroll = () => {
      if (!payrollReady) return;
      const userId = payrollSection.querySelector('#payroll-filter-user').value;
      const ruleId = payrollSection.querySelector('#payroll-filter-rule').value;
      const rows = payrollItems.filter((item) => (!userId || String(item.userId) === userId) && (!ruleId || String(item.ruleId) === ruleId));
      if (!rows.length) { register.innerHTML = '<div class="empty">За выбранный период начислений нет</div>'; return; }
      register.innerHTML = rows.map((item) => {
        const [statusLabel, statusStyle] = entryStatuses[item.status] || [String(item.status || 'Неизвестно'), 'warning'];
        const period = `${formatRuDate(item.periodFrom)} — ${formatRuDate(item.periodTo)}`;
        const payout = item.paymentDate ? `Дата выплаты: ${formatRuDate(item.paymentDate)}` : 'Дата выплаты не указана';
        const canCancel = item.status === 'draft' || item.status === 'approved';
        const actions = item.status === 'draft' ? `<button type="button" class="button small primary" data-payroll-action="approve" data-entry="${esc(item.id)}">Утвердить</button><button type="button" class="button small danger-outline" data-payroll-cancel-open="${esc(item.id)}">Отменить</button>` : item.status === 'approved' ? `<label class="payroll-payment-date">Дата выплаты<input type="date" data-payroll-payment-date="${esc(item.id)}" value="${todayDate}" aria-label="Дата выплаты сотруднику"></label><button type="button" class="button small primary" data-payroll-action="pay" data-entry="${esc(item.id)}">Отметить выплаченным</button><button type="button" class="button small danger-outline" data-payroll-cancel-open="${esc(item.id)}">Отменить</button>` : '<small class="muted">Операция завершена</small>';
        const cancelEditor = canCancel ? `<form class="payroll-cancel-editor stack-form" data-payroll-cancel-editor="${esc(item.id)}" hidden><label>Причина отмены <span class="required-mark">*</span><textarea rows="2" minlength="3" maxlength="500" required data-payroll-cancel-reason aria-label="Причина отмены начисления" placeholder="Укажите причину (от 3 до 500 символов)"></textarea></label><p class="form-message" data-payroll-cancel-message role="status" aria-live="polite"></p><div class="toolbar-row"><button type="submit" class="button small danger-outline" data-payroll-action="cancel" data-entry="${esc(item.id)}">Подтвердить отмену</button><button type="button" class="button small" data-payroll-cancel-close="${esc(item.id)}">Назад</button></div></form>` : '';
        return `<article class="payment-row payroll-entry-row"><span><b>${esc(displayName(item.userName || 'Сотрудник не указан'))}</b><small>${esc(displayName(item.ruleName || 'Модель не указана'))} · ${esc(period)}</small><small>Отработано: ${Number(item.hours || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ч · ${esc(payout)}</small></span><span class="badge ${statusStyle}">${esc(statusLabel)}</span><strong>${money(item.amount)}</strong><div class="toolbar-row payroll-entry-actions">${actions}</div>${cancelEditor}</article>`;
      }).join('');
    };
    loadPayroll = async () => {
      const requestId = ++payrollRequestId;
      payrollReady = false;
      payrollItems = [];
      if (staticDemo()) { register.innerHTML = '<div class="empty">В демо-режиме зарплатные начисления не подменяются тестовыми данными. Откройте подключённый серверный реестр.</div>'; return; }
      register.innerHTML = '<div class="empty">Загрузка зарплатного реестра…</div>';
      registerMessage.textContent = '';
      const from = payrollSection.querySelector('#payroll-filter-from').value;
      const to = payrollSection.querySelector('#payroll-filter-to').value;
      if (!from || !to || to < from) { register.innerHTML = '<div class="empty">Укажите корректный диапазон дат</div>'; return; }
      try {
        const data = await api(`/api/payroll/entries?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
        if (requestId !== payrollRequestId) return;
        if (!Array.isArray(data.items)) throw new Error('invalid_payroll_register_response');
        payrollItems = data.items;
        filterOptions('#payroll-filter-user', payrollItems.map((item) => ({ id: item.userId, name: item.userName })), 'Все сотрудники');
        filterOptions('#payroll-filter-rule', payrollItems.map((item) => ({ id: item.ruleId, name: item.ruleName })), 'Все модели');
        payrollReady = true;
        drawPayroll();
      } catch (error) {
        if (requestId !== payrollRequestId) return;
        payrollReady = false;
        payrollItems = [];
        const code = String(error.payload?.error || error.message || '');
        const unavailable = code.includes('404') || code.includes('payroll_entries_unavailable');
        register.innerHTML = `<div class="empty payroll-load-error">${unavailable ? 'Зарплатный реестр пока недоступен: серверный API списка начислений не подключён.' : 'Не удалось загрузить начисления зарплаты.'}<br><button type="button" class="button small" id="payroll-retry">Повторить загрузку</button></div>`;
        register.querySelector('#payroll-retry')?.addEventListener('click', loadPayroll);
      }
    };
    const refreshPayrollViews = () => Promise.allSettled([loadPayroll(), loadExpenses(), load()]);
    for (const selector of ['#payroll-filter-user', '#payroll-filter-rule']) payrollSection.querySelector(selector).addEventListener('change', drawPayroll);
    for (const selector of ['#payroll-filter-from', '#payroll-filter-to']) payrollSection.querySelector(selector).addEventListener('change', loadPayroll);
    payrollSection.querySelector('#payroll-reload').addEventListener('click', loadPayroll);
    payrollSection.querySelector('#payroll-register').addEventListener('click', async (event) => {
      const cancelOpen = event.target.closest('[data-payroll-cancel-open]');
      if (cancelOpen) { const row = cancelOpen.closest('.payroll-entry-row'); if (payrollPendingEntries.has(cancelOpen.dataset.payrollCancelOpen)) return; const editor = row?.querySelector('[data-payroll-cancel-editor]'); if (editor) { editor.hidden = false; cancelOpen.hidden = true; editor.querySelector('textarea')?.focus(); } return; }
      const cancelClose = event.target.closest('[data-payroll-cancel-close]');
      if (cancelClose) { if (payrollPendingEntries.has(cancelClose.dataset.payrollCancelClose)) return; const row = cancelClose.closest('.payroll-entry-row'); const editor = row?.querySelector('[data-payroll-cancel-editor]'); if (editor) { editor.hidden = true; editor.reset(); const opener = row.querySelector('[data-payroll-cancel-open]'); if (opener) opener.hidden = false; } return; }
      const button = event.target.closest('[data-payroll-action]'); if (!button || button.disabled) return;
      if (button.type === 'submit') event.preventDefault();
      const action = button.dataset.payrollAction; const entryId = button.dataset.entry;
      if (payrollPendingEntries.has(entryId)) return;
      const entry = payrollItems.find((item) => String(item.id) === String(entryId)); if (!entry) return;
      const payload = { action };
      if (action === 'pay') {
        payload.paymentDate = [...payrollSection.querySelectorAll('[data-payroll-payment-date]')].find((field) => field.dataset.payrollPaymentDate === entryId)?.value || '';
        if (!payload.paymentDate) { registerMessage.className = 'form-message error-message'; registerMessage.textContent = 'Укажите фактическую дату выплаты.'; return; }
      }
      if (action === 'cancel') {
        const editor = button.closest('[data-payroll-cancel-editor]'); const reasonField = editor?.querySelector('[data-payroll-cancel-reason]'); const reason = reasonField?.value.trim() || '';
        const reasonMessage = editor?.querySelector('[data-payroll-cancel-message]');
        if (reason.length < 3 || reason.length > 500) { if (reasonMessage) { reasonMessage.className = 'form-message error-message'; reasonMessage.textContent = 'Укажите причину длиной от 3 до 500 символов.'; } reasonField?.focus(); return; }
        payload.reason = reason.trim();
      }
      payrollPendingEntries.add(entryId);
      const actionButtons = [...button.closest('.payroll-entry-row').querySelectorAll('[data-payroll-action], [data-payroll-cancel-open], [data-payroll-cancel-close]')];
      actionButtons.forEach((item) => { item.disabled = true; });
      registerMessage.className = 'form-message'; registerMessage.textContent = 'Сохраняем изменение…';
      try {
        await api(`/api/payroll/entries/${encodeURIComponent(entryId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        registerMessage.className = 'form-message success-message'; registerMessage.textContent = action === 'approve' ? 'Начисление утверждено.' : action === 'pay' ? 'Выплата отмечена.' : 'Начисление отменено.';
        await refreshPayrollViews();
        registerMessage.className = payrollReady ? 'form-message success-message' : 'form-message error-message';
        registerMessage.textContent = payrollReady ? action === 'approve' ? 'Начисление утверждено.' : action === 'pay' ? 'Выплата отмечена.' : 'Начисление отменено.' : 'Изменение сохранено, но список не обновился. Повторите загрузку.';
      } catch (error) {
        const code = String(error.payload?.error || error.message || '');
        registerMessage.className = 'form-message error-message';
        registerMessage.textContent = code.includes('404') ? 'Серверный API изменения статуса ещё не подключён. Изменение не сохранено.' : code.includes('payroll_transition') ? 'Это изменение недоступно для текущего статуса начисления.' : code.includes('payment_date') ? 'Проверьте дату выплаты.' : code.includes('reason') ? 'Укажите причину отмены.' : `Не удалось изменить начисление${code ? ` (${code})` : ''}. Изменение не сохранено.`;
      } finally { payrollPendingEntries.delete(entryId); actionButtons.forEach((item) => { if (item.isConnected) item.disabled = false; }); }
    });
    payrollSection.querySelector('#payroll-register').addEventListener('submit', (event) => { if (event.target.matches('[data-payroll-cancel-editor]')) event.preventDefault(); });
    const createToggle = payrollSection.querySelector('#payroll-create-toggle');
    const createForm = payrollSection.querySelector('#payroll-create-form');
    const createMessage = payrollSection.querySelector('#payroll-create-message');
    const fillCreationOptions = async () => {
      if (staticDemo()) { createMessage.className = 'form-message error-message'; createMessage.textContent = 'Черновик нельзя создать в демо-режиме: серверное API зарплаты недоступно.'; return; }
      const userSelect = payrollSection.querySelector('#payroll-create-user'); const ruleSelect = payrollSection.querySelector('#payroll-create-rule');
      userSelect.innerHTML = '<option value="">Загрузка…</option>'; ruleSelect.innerHTML = '<option value="">Загрузка…</option>';
      try {
        const [staffData, rulesData] = await Promise.all([api('/api/staff'), api('/api/payroll/rules')]);
        const staffItems = (staffData.items || []).filter((item) => item.active !== false);
        const rules = (rulesData.items || []).filter((item) => item.active !== false);
        userSelect.innerHTML = `<option value="">Выберите сотрудника</option>${staffItems.map((item) => `<option value="${esc(item.id)}">${esc(displayName(item.fullName || item.name || item.login || 'Сотрудник'))}</option>`).join('')}`;
        ruleSelect.innerHTML = `<option value="">Выберите модель оплаты</option>${rules.map((item) => `<option value="${esc(item.id)}" data-rule-type="${esc(item.ruleType || item.rule_type || '')}">${esc(displayName(item.name))}</option>`).join('')}`;
        if (!staffItems.length || !rules.length) { createMessage.className = 'form-message error-message'; createMessage.textContent = !staffItems.length ? 'Нет доступных сотрудников для начисления.' : 'Сначала добавьте модель оплаты.'; }
      } catch (error) {
        userSelect.innerHTML = '<option value="">Список сотрудников недоступен</option>'; ruleSelect.innerHTML = '<option value="">Правила недоступны</option>';
        createMessage.className = 'form-message error-message'; createMessage.textContent = `Не удалось загрузить сотрудников или модели оплаты (${error.payload?.error || error.message}). Черновик не создан.`;
      }
    };
    createToggle.addEventListener('click', () => { createForm.hidden = !createForm.hidden; if (!createForm.hidden) { createMessage.textContent = ''; fillCreationOptions(); } createToggle.textContent = createForm.hidden ? 'Начислить зарплату' : 'Скрыть форму'; });
    payrollSection.querySelector('#payroll-create-cancel').addEventListener('click', () => { createForm.reset(); createForm.hidden = true; createToggle.textContent = 'Начислить зарплату'; createMessage.textContent = ''; });
    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const ruleSelect = payrollSection.querySelector('#payroll-create-rule');
      const payload = { userId: payrollSection.querySelector('#payroll-create-user').value, ruleId: ruleSelect.value, periodFrom: payrollSection.querySelector('#payroll-create-from').value, periodTo: payrollSection.querySelector('#payroll-create-to').value };
      if (!payload.userId || !payload.ruleId || !payload.periodFrom || !payload.periodTo || payload.periodTo < payload.periodFrom) { createMessage.className = 'form-message error-message'; createMessage.textContent = 'Проверьте сотрудника, модель и границы периода.'; return; }
      const submit = createForm.querySelector('[type="submit"]'); submit.disabled = true; createMessage.className = 'form-message'; createMessage.textContent = 'Создаём черновик…';
      try {
        await api('/api/payroll/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        createMessage.className = 'form-message success-message'; createMessage.textContent = 'Черновик начисления сохранён.';
        createForm.reset(); payrollSection.querySelector('#payroll-create-from').value = monthStart; payrollSection.querySelector('#payroll-create-to').value = todayDate;
        payrollSection.querySelector('#payroll-filter-from').value = payload.periodFrom; payrollSection.querySelector('#payroll-filter-to').value = payload.periodTo;
        await refreshPayrollViews();
        if (payrollReady) {
          createForm.hidden = true; createToggle.textContent = 'Начислить зарплату'; createMessage.textContent = '';
          registerMessage.className = 'form-message success-message'; registerMessage.textContent = 'Черновик начисления сохранён.';
        } else {
          createMessage.className = 'form-message error-message'; createMessage.textContent = 'Черновик сохранён, но список не обновился. Повторите загрузку.';
        }
      } catch (error) { createMessage.className = 'form-message error-message'; createMessage.textContent = `Не удалось сохранить черновик (${error.payload?.error || error.message}). Ничего не сохранено.`; }
      finally { submit.disabled = false; }
    });
    loadPayroll();
  }
  const optionMap = { revenue: ['revenue'], profit: ['profit'], expenses: ['expenses'], average: ['average'], median: ['average_median'], tables: [] };
  document.querySelectorAll('#finance-chart-metric option').forEach((option) => { const key = option.value === 'average_median' ? 'median' : option.value; option.hidden = key !== 'average_median' && financePrefs[key] === false || option.value === 'average_median' && !(financePrefs.average || financePrefs.median); });
  const firstMetric = [...document.querySelectorAll('#finance-chart-metric option')].find((option) => !option.hidden); if (firstMetric) document.querySelector('#finance-chart-metric').value = firstMetric.value;
  ['finance-total-turnover','finance-total-expenses','finance-net-profit'].forEach((id) => { const node = document.querySelector('#' + id); const key = id.includes('turnover') ? 'revenue' : id.includes('expenses') ? 'expenses' : 'profit'; if (node) node.closest('article').hidden = financePrefs[key] === false; });
  const tablesNode = document.querySelector('#finance-avg-tables'); if (tablesNode) tablesNode.closest('article').hidden = financePrefs.tables === false;
  const byStationNodes = [['finance-avg-bar','average'],['finance-avg-hookah','average']]; byStationNodes.forEach(([id,key]) => { const node = document.querySelector('#' + id); if (node) node.closest('article').hidden = financePrefs[key] === false; });
  bindKpiNavigation();
  const drawDiscounts = (items) => { const list = document.querySelector('#discount-list'); const pending = items.filter((item) => item.status === 'requested'); list.innerHTML = items.length ? items.map((item) => `<div class="discount-row"><div><b>${item.type === 'percent' ? `${esc(item.value)}%` : money(item.value)} скидка</b><small>Заказ ${esc(item.orderId)}${item.guestName ? ` · гость: ${esc(item.guestName)}${item.guestPhone ? ` (${esc(item.guestPhone)})` : ''}` : ''} · ${esc(item.reason)} · запросил ${esc(discountRequester(item.requestedBy))}</small></div><span class="badge ${item.status === 'requested' ? 'warning' : item.status === 'approved' ? 'success' : 'danger'}">${item.status === 'requested' ? 'На согласовании' : item.status === 'approved' ? 'Применена' : 'Отклонена'}</span>${item.status === 'requested' ? (canDecideFinance ? `<div class="discount-actions"><button type="button" class="button small discount-approve" data-discount="${esc(item.id)}">Одобрить</button><button type="button" class="button small danger-outline discount-reject" data-discount="${esc(item.id)}">Отклонить</button></div>` : '<small class="muted">Требуется право финансового решения</small>') : ''}</div>`).join('') : '<div class="empty">Заявок на скидку нет</div>'; document.querySelector('#finance-discounts').textContent = pending.length; };
  const discountRequester = (value) => !value || value === 'unknown' || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(value)) ? 'сотрудник' : value;
  let discountLoadRequestId = 0;
  let discountDecisionPending = false;
  const loadDiscounts = async () => {
    const requestId = ++discountLoadRequestId;
    const list = discountSection.querySelector('#discount-list');
    try {
      const data = await api('/api/discount-requests');
      if (requestId !== discountLoadRequestId) return;
      drawDiscounts(data.items || []);
    } catch {
      if (requestId !== discountLoadRequestId) return;
      list.innerHTML = '<div class="empty">Не удалось загрузить заявки. Нажмите «Обновить».</div>';
      discountSection.querySelector('#finance-discounts').textContent = '—';
    }
  };
  discountSection.querySelector('#discount-reload').addEventListener('click', loadDiscounts);
  discountSection.querySelector('#discount-list').addEventListener('click', async (event) => {
    const button = event.target.closest('.discount-approve, .discount-reject');
    if (!button || discountDecisionPending || !canDecideFinance) return;
    const action = button.classList.contains('discount-approve') ? 'approve' : 'reject';
    const row = button.closest('.discount-row');
    const message = discountSection.querySelector('#discount-message');
    discountDecisionPending = true;
    discountLoadRequestId++;
    discountSection.querySelector('#discount-reload').disabled = true;
    row.querySelectorAll('button').forEach((control) => { control.disabled = true; });
    message.textContent = 'Сохраняем решение…';
    message.className = 'form-message';
    try {
      await api(`/api/discount-requests/${encodeURIComponent(button.dataset.discount)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      message.textContent = action === 'approve' ? 'Скидка одобрена' : 'Скидка отклонена';
      message.className = 'form-message success-message';
      await Promise.allSettled([loadDiscounts(), load()]);
    } catch (error) {
      const code = error.payload?.error || error.message;
      message.textContent = ['paid_order_total_conflict', 'order_total_below_paid'].includes(code) ? 'Скидка уменьшит сумму заказа ниже уже полученной оплаты. Решение не сохранено.' : code === 'order_pricing_locked' ? 'Цена заказа уже зафиксирована после первого платежа. Скидку изменить нельзя; решение не сохранено.' : ['discount_not_found_or_decided', 'already_decided', 'discount_already_decided'].includes(code) ? 'Заявка уже рассмотрена или заказ закрыт. Обновите список.' : 'Не удалось сохранить решение. Повторите попытку.';
      message.className = 'form-message error-message';
      await loadDiscounts();
    } finally { discountDecisionPending = false; discountSection.querySelector('#discount-reload').disabled = false; if (row.isConnected) row.querySelectorAll('button').forEach((control) => { control.disabled = false; }); }
  });
  loadDiscounts();
  const drawFinanceChart = (analytics) => {
    const chart = document.querySelector('#finance-chart'); if (!chart) return;
    const metric = document.querySelector('#finance-chart-metric')?.value || 'revenue';
    const periodValue = document.querySelector('#finance-chart-period')?.value || '7';
    const period = Number(periodValue);
    if (['expenses', 'profit'].includes(metric) && analytics?.payrollCoverage?.status === 'unsupported') {
      chart.innerHTML = '<div class="finance-chart-empty" role="status" aria-live="polite"><strong>Полные расходы и прибыль недоступны</strong><span>Для учёта начисленной зарплаты требуется подключённая база данных.</span></div>';
      return;
    }
    const days = periodValue === 'all' ? (analytics?.days || []) : (analytics?.days || []).slice(-period);
    // Do not graph a row of zeroes when no matching business activity exists.
    const hasMetricData = days.some((day) => {
      const orders = Number(day.orders || 0);
      const revenue = Number(day.revenue || 0);
      const expenses = Number(day.expenses || 0);
      const costOfGoods = Number(day.costOfGoods || 0);
      if (metric === 'orders' || metric === 'average' || metric === 'average_median') return orders > 0;
      if (metric === 'expenses') return expenses > 0;
      if (metric === 'profit') return orders > 0 || revenue > 0 || expenses > 0 || costOfGoods > 0;
      return orders > 0 || revenue > 0;
    });
    const values = days.map((day) => metric === 'orders' ? Number(day.orders || 0) : (metric === 'average' || metric === 'average_median') ? Number(day.averageCheck ?? (Number(day.orders || 0) ? Number(day.revenue || 0) / Number(day.orders || 0) : 0)) : metric === 'expenses' ? Number(day.expenses || 0) : metric === 'profit' ? Number(day.netProfit ?? (Number(day.revenue || 0) - Number(day.expenses || 0))) : Number(day.revenue || 0));
    const medianValues = metric === 'average_median' ? days.map((day) => Number(day.medianCheck || 0)) : [];
    const max = Math.max(...values, ...medianValues, 1);
    const total = values.reduce((sum, value) => sum + value, 0);
    const peakIndex = values.reduce((best, value, index) => value > (values[best] || 0) ? index : best, 0);
    const format = metric === 'orders' ? (value) => String(Math.round(value)) : (value) => money(Math.round(value));
    const summaryLabels = metric === 'orders' ? ['Заказов за период', 'Пик за день', 'Среднее в день'] : metric === 'average_median' ? ['Средний чек', 'Медианный чек', 'Разница'] : metric === 'average' ? ['Средний чек', 'Лучший чек', 'Средний показатель'] : metric === 'profit' ? ['Прибыль за период', 'Лучший день', 'Среднее в день'] : metric === 'expenses' ? ['Расходы за период', 'Пиковый день', 'Среднее в день'] : ['Оборот за период', 'Лучший день', 'Среднее в день'];
    const summaryValues = metric === 'average_median' ? [format(values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0), format(medianValues.length ? medianValues.reduce((sum, value) => sum + value, 0) / medianValues.length : 0), format(Math.abs((values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)) - (medianValues.reduce((sum, value) => sum + value, 0) / Math.max(medianValues.length, 1))))] : metric === 'average' ? [format(values.length ? total / values.length : 0), format(values[peakIndex] || 0), format(values.length ? total / values.length : 0)] : [format(total), format(values[peakIndex] || 0), format(values.length ? total / values.length : 0)];
    const chartWidth = 900;
    const chartHeight = 250;
    const left = 28;
    const right = 20;
    const top = 22;
    const bottom = 52;
    const usableWidth = chartWidth - left - right;
    const usableHeight = chartHeight - top - bottom;
    const points = values.map((value, index) => {
      const x = days.length === 1 ? left + usableWidth / 2 : left + (index / (days.length - 1)) * usableWidth;
      const y = top + usableHeight - (value / max) * usableHeight;
      return { x, y, value };
    });
    const linePoints = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
    const smoothPath = (items) => {
      if (!items.length) return '';
      if (items.length === 1) return `M ${items[0].x.toFixed(1)} ${items[0].y.toFixed(1)}`;
      return items.map((point, index) => {
        if (index === 0) return `M ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
        const previous = items[index - 1];
        const midpoint = (previous.x + point.x) / 2;
        return `C ${midpoint.toFixed(1)} ${previous.y.toFixed(1)}, ${midpoint.toFixed(1)} ${point.y.toFixed(1)}, ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
      }).join(' ');
    };
    const linePath = smoothPath(points); const medianPoints = medianValues.map((value, index) => ({ x: points[index]?.x || left, y: top + usableHeight - (value / max) * usableHeight, value })); const medianPath = smoothPath(medianPoints);
    const areaPath = `${linePath} L ${(left + usableWidth).toFixed(1)} ${(top + usableHeight).toFixed(1)} L ${left.toFixed(1)} ${(top + usableHeight).toFixed(1)} Z`;
    const tickLines = [0, 1, 2, 3].map((step) => { const y = top + (usableHeight / 3) * step; return `<line x1="${left}" x2="${left + usableWidth}" y1="${y}" y2="${y}" />`; }).join('');
    const pointsMarkup = points.map((point, index) => `<g class="finance-chart-point${index === points.length - 1 ? ' is-current' : ''}"><title>${esc(formatRuDate(days[index].date))}: ${esc(format(point.value))}</title><circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${index === points.length - 1 ? 6 : 4}"></circle><text x="${point.x.toFixed(1)}" y="${chartHeight - 16}" text-anchor="middle">${esc(formatRuDate(days[index].date).slice(0, 5))}</text></g>`).join('');
    const chartView = document.querySelector('[data-finance-chart-view].is-active')?.dataset.financeChartView || 'line';
    const barsMarkup = days.map((day, index) => { const value = values[index] || 0; const height = max ? Math.max(4, (value / max) * 100) : 4; return `<div class="finance-bars-item"><div class="finance-bars-value">${esc(format(value))}</div><div class="finance-bars-track"><i style="height:${height.toFixed(1)}%"></i></div><small>${esc(formatRuDate(day.date).slice(0, 5))}</small></div>`; }).join('');
    const tableMarkup = days.map((day, index) => `<tr><td>${esc(formatRuDate(day.date))}</td><td>${esc(format(values[index] || 0))}</td>${metric === 'average_median' ? `<td>${esc(format(medianValues[index] || 0))}</td>` : ''}</tr>`).join('');
    const visualMarkup = chartView === 'bars' ? `<div class="finance-bars-view" tabindex="0" role="region" aria-label="Столбцы динамики показателя по дням">${barsMarkup}</div>` : chartView === 'table' ? `<div class="finance-data-table-wrap" tabindex="0" role="region" aria-label="Динамика показателей по дням"><table class="finance-data-table"><thead><tr><th>Дата</th><th>${metric === 'average_median' ? 'Средний чек' : 'Показатель'}</th>${metric === 'average_median' ? '<th>Медиана</th>' : ''}</tr></thead><tbody>${tableMarkup}</tbody></table></div>` : `<svg class="finance-line-chart" viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-label="Динамика показателя за выбранный период"><defs><linearGradient id="finance-area-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9a57" stop-opacity=".34"></stop><stop offset=".42" stop-color="#ff6377" stop-opacity=".2"></stop><stop offset="1" stop-color="#ff6377" stop-opacity="0"></stop></linearGradient><linearGradient id="finance-line-gradient" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffb36b"></stop><stop offset=".48" stop-color="#ff766d"></stop><stop offset="1" stop-color="#ff4f78"></stop></linearGradient><filter id="finance-line-glow" x="-20%" y="-30%" width="140%" height="160%"><feGaussianBlur stdDeviation="5" result="blur"></feGaussianBlur><feMerge><feMergeNode in="blur"></feMergeNode><feMergeNode in="SourceGraphic"></feMerge></filter></defs><g class="finance-chart-grid-lines">${tickLines}</g><path d="${areaPath}" class="finance-chart-area"></path><path d="${linePath}" class="finance-chart-line" filter="url(#finance-line-glow)"></path>${metric === 'average_median' ? `<path d="${medianPath}" class="finance-chart-line finance-chart-median"></path>` : ''}${pointsMarkup}</svg>`;
    chart.innerHTML = days.length && hasMetricData ? `<div class="finance-chart-summary">${summaryLabels.map((label, index) => `<div class="${index === 0 ? 'is-primary' : ''}"><span>${label}</span><strong>${summaryValues[index]}</strong><i aria-hidden="true"></i></div>`).join('')}</div><div class="finance-chart-visual"><div class="finance-chart-visual-head"><span>По дням</span><small>${days.length} ${pluralRu(days.length, 'день', 'дня', 'дней')}</small></div>${visualMarkup}</div>` : `<div class="finance-chart-empty" role="status" aria-live="polite"><strong>${days.length ? 'Нет операций для этого показателя за период' : 'Нет данных за выбранный период'}</strong><span>${days.length ? 'Сводные значения и диаграмма появятся, когда появятся первые продажи или расходы.' : 'Измените период и повторите просмотр.'}</span></div>`;
  };
  const showFinanceLoadError = () => {
    window.__financeAnalytics = null;
    ['#finance-revenue', '#finance-pending-revenue', '#finance-orders', '#finance-payments', '#finance-total-turnover', '#finance-total-expenses', '#finance-total-cogs', '#finance-net-profit', '#finance-avg-tables', '#finance-avg-bar', '#finance-avg-hookah', '#cash-register-opening', '#cash-register-opened', '#cash-register-id'].forEach((selector) => { const node = document.querySelector(selector); if (node) node.textContent = '—'; });
    ['#finance-orders-detail', '#finance-pending-detail', '#finance-average-check', '#cash-register-status', '#cash-register-hint'].forEach((selector) => { const node = document.querySelector(selector); if (node) node.textContent = 'Данные не загрузились'; });
    document.querySelector('#payment-list').innerHTML = '<div class="empty">Не удалось загрузить финансовую сводку</div>';
    document.querySelectorAll('[data-payment-view]').forEach((button) => { button.disabled = true; button.onclick = null; });
    document.querySelector('#finance-chart').innerHTML = '<div class="empty">Не удалось загрузить диаграмму. Измените дату или обновите страницу.</div>';
    document.querySelector('#finance-staff-dynamics').innerHTML = '<div class="empty">Не удалось загрузить динамику команды</div>';
  };
  let financeLoadRequestId = 0;
  const load = () => { const requestId = ++financeLoadRequestId; return Promise.all([api(`/api/finance/summary?date=${document.querySelector('#finance-date').value}`), refreshPortalShiftState(), api('/api/analytics?days=all')]).then(([summary, shifts, analytics]) => { if (requestId !== financeLoadRequestId) return; document.querySelector('#finance-revenue').textContent = money(summary.revenue); const pendingInline = document.querySelector('#finance-pending-inline'); if (pendingInline) pendingInline.textContent = `В заказах не оплачено: ${money(summary.pendingRevenue || 0)}`; const totalOrders = Number(summary.closedOrders || 0) + Number(summary.pendingOrders || 0); document.querySelector('#finance-orders').textContent = totalOrders; const ordersDetail = document.querySelector('#finance-orders-detail'); if (ordersDetail) ordersDetail.textContent = `Закрытые: ${summary.closedOrders || 0} · открытые: ${summary.pendingOrders || 0}`; const pendingAmount = document.querySelector('#finance-pending-revenue'); if (pendingAmount) pendingAmount.textContent = money(summary.pendingRevenue); const pendingDetail = document.querySelector('#finance-pending-detail'); if (pendingDetail) pendingDetail.textContent = `${summary.pendingOrders || 0} ${pluralRu(summary.pendingOrders || 0, 'заказ', 'заказа', 'заказов')} без полной оплаты`; const paymentCount = document.querySelector('#finance-payments'); if (paymentCount) paymentCount.textContent = summary.paymentCount ?? '—'; const averageCheck = document.querySelector('#finance-average-check'); if (averageCheck) averageCheck.textContent = `Средний чек смены: ${summary.currentShiftOrders ? money(summary.currentShiftAverageCheck) : '—'}${summary.currentShiftOrders ? ` · ${summary.currentShiftOrders} ${pluralRu(summary.currentShiftOrders, 'чек', 'чека', 'чеков')}` : ' · пока нет закрытых чеков'}`; const paymentLabels = { cash: 'Наличные', card: 'Карта', qr: 'QR-код', bonus: 'Оплата бонусами', 'не указан': 'Не указан' }; const paymentRows = Object.entries(summary.byPaymentMethod || {}).map(([method, value]) => ({ method, label: paymentLabels[method] || method, value: Number(value || 0) })).filter((item) => item.value > 0); const paymentList = document.querySelector('#payment-list'); const renderPayments = (view = document.querySelector('[data-payment-view].is-active')?.dataset.paymentView || 'donut') => { const total = paymentRows.reduce((sum, item) => sum + item.value, 0); if (!paymentRows.length) { paymentList.innerHTML = '<div class="empty">Оплат за выбранную дату пока нет</div>'; return; } const colors = ['#ff7180','#b887ff','#5ce0ad']; const rows = paymentRows.map((item, index) => ({ ...item, color: colors[index % colors.length], percent: total ? item.value / total * 100 : 0 })); if (view === 'table') paymentList.innerHTML = `<div class="payment-table"><div class="payment-table-head"><span>Способ</span><span>Доля</span><span>Сумма</span></div>${rows.map((item) => `<div class="payment-table-row"><span><i style="background:${item.color}"></i>${esc(item.label)}</span><b>${item.percent.toFixed(0)}%</b><strong>${money(item.value)}</strong></div>`).join('')}</div>`; else if (view === 'bars') paymentList.innerHTML = `<div class="payment-bars">${rows.map((item) => `<div class="payment-bar-row"><div><span>${esc(item.label)}</span><strong>${money(item.value)}</strong></div><div class="payment-bar-track"><i style="width:${item.percent.toFixed(1)}%;background:${item.color}"></i></div></div>`).join('')}</div>`; else if (view === 'line') { const points = rows.map((item, index) => `${index * 50 + 10},${90 - item.percent * .7}`).join(' '); paymentList.innerHTML = `<div class="payment-line"><svg viewBox="0 0 ${Math.max(120, (rows.length - 1) * 50 + 20)} 100" role="img" aria-label="График оплат"><polyline points="${points}" fill="none" stroke="#ff7180" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>${rows.map((item, index) => `<circle cx="${index * 50 + 10}" cy="${90 - item.percent * .7}" r="4" fill="${item.color}"><title>${esc(item.label)}: ${money(item.value)}</title></circle>`).join('')}</svg><div class="payment-line-legend">${rows.map((item) => `<span><i style="background:${item.color}"></i>${esc(item.label)} · ${money(item.value)}</span>`).join('')}</div></div>`; } else { const gradient = rows.reduce((value, item, index) => `${value}${index ? ', ' : ''}${item.color} ${rows.slice(0,index).reduce((sum, entry) => sum + entry.percent, 0).toFixed(1)}% ${(rows.slice(0,index+1).reduce((sum, entry) => sum + entry.percent, 0)).toFixed(1)}%`, ''); paymentList.innerHTML = `<div class="payment-donut-layout"><div class="payment-donut" style="background:conic-gradient(${gradient})"><span>${money(total)}</span></div><div class="payment-donut-legend">${rows.map((item) => `<div><i style="background:${item.color}"></i><span>${esc(item.label)}</span><b>${item.percent.toFixed(0)}%</b></div>`).join('')}</div></div>`; } }; renderPayments(); document.querySelectorAll('[data-payment-view]').forEach((button) => { button.disabled = false; button.onclick = () => { document.querySelectorAll('[data-payment-view]').forEach((item) => { item.classList.toggle('is-active', item === button); item.setAttribute('aria-pressed', String(item === button)); }); renderPayments(button.dataset.paymentView); }; }); const shiftStateKnown = Boolean(shifts && Object.prototype.hasOwnProperty.call(shifts, 'current')); const shift = shiftStateKnown ? shifts.current : null; const cashPanel = document.querySelector('.cash-register-panel'); const cashStatus = document.querySelector('#cash-register-status'); const cashHint = document.querySelector('#cash-register-hint'); const cashAction = document.querySelector('#cash-register-action'); if (cashPanel) { cashPanel.classList.toggle('is-open', Boolean(shift)); cashPanel.classList.toggle('is-closed', shiftStateKnown && !shift); } if (cashStatus) cashStatus.textContent = shift ? 'Смена открыта · оплаты привязаны к текущему периоду' : shiftStateKnown ? 'Смена не открыта · перед началом работы её нужно открыть' : 'Состояние смены недоступно'; if (cashHint) cashHint.textContent = shift ? 'Проверьте выручку и закройте смену через X‑отчёт.' : shiftStateKnown ? 'Открытие фиксирует стартовый остаток и связывает все оплаты со сменой.' : 'Не удалось проверить состояние смены. Финансовые показатели доступны.'; if (cashAction) { cashAction.textContent = shift ? 'Открыть X‑отчёт' : shiftStateKnown ? 'Открыть смену' : 'Обновить финансы'; cashAction.href = shift ? '/finance/report' : shiftStateKnown ? '/admin#shift-control' : '/finance'; } document.querySelector('#cash-register-opening').textContent = shift ? money(shift.openingCash || 0) : shiftStateKnown ? 'Не задан' : 'Недоступно'; document.querySelector('#cash-register-opened').textContent = shift ? formatRuDate(shift.openedAt, true) : shiftStateKnown ? 'Не открыта' : 'Недоступно'; document.querySelector('#cash-register-id').textContent = shift?.id || (shiftStateKnown ? 'После открытия' : 'Недоступно'); window.__financeAnalytics = analytics; for (const selector of ['#finance-total-expenses', '#finance-net-profit']) { const node = document.querySelector(selector); if (node) node.title = analytics.payrollCoverage?.status === 'unsupported' ? 'Для учёта начисленной зарплаты требуется подключённая база данных.' : ''; } document.querySelector('#finance-total-turnover').textContent = money(analytics.totalRevenue ?? (analytics.days || []).reduce((sum, day) => sum + Number(day.revenue || 0), 0)); document.querySelector('#finance-total-expenses').textContent = analytics.payrollCoverage?.status === 'unsupported' ? 'Недоступно' : money(analytics.totalExpenses ?? (analytics.days || []).reduce((sum, day) => sum + Number(day.expenses || 0), 0)); const cogsNode = document.querySelector('#finance-total-cogs'); if (cogsNode) cogsNode.textContent = money(analytics.totalCostOfGoods ?? (analytics.days || []).reduce((sum, day) => sum + Number(day.costOfGoods || 0), 0)); document.querySelector('#finance-net-profit').textContent = analytics.payrollCoverage?.status === 'unsupported' ? 'Недоступно' : money(analytics.netProfit ?? (analytics.totalRevenue || 0) - (analytics.totalExpenses || 0)); document.querySelector('#finance-avg-tables').textContent = Number.isFinite(Number(analytics.avgTablesPerDay)) ? analytics.avgTablesPerDay.toFixed(1).replace('.', ',') : '0'; const byStation = analytics.byStation || {}; document.querySelector('#finance-avg-bar').textContent = money(byStation.bar?.averageCheck || 0); document.querySelector('#finance-avg-hookah').textContent = money(byStation.hookah?.averageCheck || 0); const staffList = document.querySelector('#finance-staff-dynamics'); const staffItems = analytics.staffDynamics || []; if (staffList) { const detailedItems = analytics.staffSales || staffItems.map((item) => ({ ...item, items: [] })); staffList.innerHTML = detailedItems.length ? detailedItems.map((item) => `<div class="finance-staff-row"><div><b>${esc(item.name)}</b><small>${item.orders} ${pluralRu(item.orders, 'заказ', 'заказа', 'заказов')}</small>${item.items?.length ? `<small class="finance-staff-items">${item.items.map((sale) => `${esc(displayName(sale.name))} × ${Number(sale.quantity || 0).toLocaleString('ru-RU')} · ${money(sale.revenue)}`).join('<br>')}</small>` : ''}</div><strong>${money(item.revenue)}</strong></div>`).join('') : '<div class="empty">За выбранный период закрытых заказов нет</div>'; } drawFinanceChart(analytics); }).catch(() => { if (requestId !== financeLoadRequestId) return; showFinanceLoadError(); portalNotice('Не удалось загрузить финансы', 'error'); }); };

  const syncFinanceDateLabel = () => { const date = document.querySelector('#finance-date').value; document.querySelector('#finance-revenue-label').textContent = date === localDateKey() ? 'Выручка сегодня' : 'Выручка за ' + formatRuDate(date); }; syncFinanceDateLabel(); document.querySelector('#finance-date').addEventListener('change', () => { syncFinanceDateLabel(); load(); }); document.querySelector('#finance-chart-metric')?.addEventListener('change', () => drawFinanceChart(window.__financeAnalytics || {})); document.querySelector('#finance-chart-period')?.addEventListener('change', () => drawFinanceChart(window.__financeAnalytics || {})); document.querySelectorAll('[data-finance-chart-view]').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('[data-finance-chart-view]').forEach((item) => { item.classList.toggle('is-active', item === button); item.setAttribute('aria-pressed', String(item === button)); }); drawFinanceChart(window.__financeAnalytics || {}); })); load();
}

function renderDelivery() {
  const target = document.querySelector('#page-content'); if (!target) return;
  target.innerHTML = `<div class="page-title"><div><p class="eyebrow">ДОСТАВКА</p><h1>Заказы доставки</h1><p class="muted">Адреса, контакты, оплата и текущий статус курьера.</p></div><span class="live-dot">● Локальный контур</span></div><div class="content-grid"><section class="panel"><div class="panel-head"><h2>Новая доставка</h2></div><form class="stack-form" id="delivery-form"><label>Имя гостя<input id="delivery-name" required maxlength="120" placeholder="Имя и фамилия"></label><label>Телефон<input id="delivery-phone" placeholder="+7 ..."></label><label>Адрес<textarea id="delivery-address" required maxlength="500" rows="2" placeholder="Улица, дом, квартира"></textarea></label><label>Сумма<input id="delivery-total" type="number" min="0" max="999999999999.99" step="0.01" value="0"></label><label>Оплата<select id="delivery-payment"><option value="cash">Наличные</option><option value="card">Карта</option><option value="qr">QR</option></select></label><label>Комментарий<textarea id="delivery-comment" maxlength="500" rows="2" placeholder="Домофон, пожелания…"></textarea></label><button class="button primary" type="submit">Создать доставку</button><p class="form-message" id="delivery-message" role="status" aria-live="polite"></p></form></section><section class="panel wide"><div class="panel-head"><div><h2>Очередь доставки</h2><span class="muted" id="delivery-count">Загрузка…</span></div><select id="delivery-filter" aria-label="Статус доставки"><option value="">Все статусы</option><option value="new">Новая</option><option value="confirmed">Подтверждена</option><option value="in_delivery">У курьера</option><option value="delivered">Доставлена</option><option value="cancelled">Отменена</option></select></div><div class="delivery-list" id="delivery-list"><div class="empty">Загрузка доставок…</div></div></section></div>`;
  let items = []; const labels = { new: 'Новая', confirmed: 'Подтверждена', in_delivery: 'У курьера', delivered: 'Доставлена', cancelled: 'Отменена' };
  const paymentLabels = { cash: 'Наличные', card: 'Карта', qr: 'QR' };
  const pendingStatusIds = new Set();
  const draw = () => { const filter = document.querySelector('#delivery-filter').value; const list = document.querySelector('#delivery-list'); const filtered = items.filter((item) => !filter || item.status === filter); document.querySelector('#delivery-count').textContent = `${filtered.length} ${pluralRu(filtered.length,'заказ','заказа','заказов')}`; list.innerHTML = filtered.length ? filtered.map((item) => `<article class="delivery-row"><div><b>${esc(item.customerName)}</b><small>${esc(item.phone || 'Телефон не указан')} · ${esc(item.address)}</small><small>${item.comment ? esc(item.comment) : 'Без комментария'} · ${money(item.total)} · ${esc(paymentLabels[item.paymentMethod] || 'Способ оплаты не указан')}</small></div><div class="delivery-actions"><span class="badge ${item.status === 'delivered' ? 'success' : item.status === 'cancelled' ? 'danger' : 'warning'}">${labels[item.status] || item.status}</span><select data-delivery-status="${esc(item.id)}" aria-label="Статус доставки для ${esc(item.customerName)}" ${pendingStatusIds.has(String(item.id)) ? 'disabled' : ''}><option value="new" ${item.status === 'new' ? 'selected' : ''}>Новая</option><option value="confirmed" ${item.status === 'confirmed' ? 'selected' : ''}>Подтверждена</option><option value="in_delivery" ${item.status === 'in_delivery' ? 'selected' : ''}>У курьера</option><option value="delivered" ${item.status === 'delivered' ? 'selected' : ''}>Доставлена</option><option value="cancelled" ${item.status === 'cancelled' ? 'selected' : ''}>Отменена</option></select></div></article>`).join('') : '<div class="empty">Доставок по выбранному фильтру нет</div>'; };
  let loadGeneration = 0;
  let loadFailed = false;
  const showLoadError = () => {
    document.querySelector('#delivery-count').textContent = 'Ошибка загрузки';
    document.querySelector('#delivery-list').innerHTML = '<div class="empty" role="alert">Не удалось загрузить доставки. <button class="button" type="button" data-delivery-retry>Повторить</button></div>';
  };
  const load = async () => {
    const generation = ++loadGeneration;
    try {
      const data = await api('/api/deliveries');
      if (generation !== loadGeneration) return;
      items = data.items || []; loadFailed = false; draw(); return true;
    } catch (_) {
      if (generation !== loadGeneration) return;
      loadFailed = true; showLoadError(); return false;
    }
  };
  document.querySelector('#delivery-filter').addEventListener('change', () => { if (loadFailed) showLoadError(); else draw(); });
  document.querySelector('#delivery-list').addEventListener('click', (event) => {
    const retry = event.target.closest('[data-delivery-retry]');
    if (retry) { retry.disabled = true; retry.textContent = 'Загрузка…'; load(); }
  });
  document.querySelector('#delivery-list').addEventListener('change', async (event) => {
    const select = event.target.closest('[data-delivery-status]');
    if (!select || select.disabled || pendingStatusIds.has(String(select.dataset.deliveryStatus))) return;
    const item = items.find((entry) => String(entry.id) === select.dataset.deliveryStatus);
    if (!item) return;
    const previousStatus = item.status;
    pendingStatusIds.add(String(item.id)); select.disabled = true;
    try {
      await api(`/api/deliveries/${encodeURIComponent(select.dataset.deliveryStatus)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: select.value }) });
      await load();
    } catch (_) {
      select.value = previousStatus;
      portalNotice('Не удалось изменить статус доставки', 'error');
    } finally { pendingStatusIds.delete(String(item.id)); if (select.isConnected) select.disabled = false; if (!loadFailed) draw(); }
  });
  let creating = false;
  document.querySelector('#delivery-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (creating) return;
    const form = event.target;
    const message = document.querySelector('#delivery-message');
    const button = form.querySelector('[type="submit"]');
    const payload = { customerName: document.querySelector('#delivery-name').value.trim(), phone: document.querySelector('#delivery-phone').value.trim(), address: document.querySelector('#delivery-address').value.trim(), total: Number(document.querySelector('#delivery-total').value), paymentMethod: document.querySelector('#delivery-payment').value, comment: document.querySelector('#delivery-comment').value.trim() };
    const controls = [...form.querySelectorAll('input,select,textarea,button')].map((control) => ({ control, disabled: control.disabled }));
    creating = true; controls.forEach(({ control }) => { control.disabled = true; control._customSelectRefresh?.(); }); button.textContent = 'Сохранение…';
    message.textContent = ''; message.className = 'form-message';
    try {
      await api('/api/deliveries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      form.reset(); const refreshed = await load();
      message.textContent = refreshed ? 'Доставка создана' : 'Доставка создана, но список не обновился. Повторите загрузку.'; message.className = refreshed ? 'form-message success-message' : 'form-message error-message';
    } catch (error) {
      const errors = { invalid_guest_phone: 'Проверьте телефон', invalid_delivery_total: 'Проверьте сумму доставки', delivery_contact_required: 'Укажите имя гостя и адрес' };
      message.textContent = errors[error.payload?.error] || 'Не удалось создать доставку. Попробуйте ещё раз';
      message.className = 'form-message error-message';
    } finally { creating = false; controls.forEach(({ control, disabled }) => { control.disabled = disabled; control._customSelectRefresh?.(); }); button.textContent = 'Создать доставку'; }
  });
  load();
}

function renderEmployeeFinanceReport(target) {
  target.innerHTML = `<div class="page-title"><div><p class="eyebrow">МОЯ СМЕНА</p><h1>Мой отчёт</h1><p class="muted">Ваши оплаты и закрытые чеки за сегодня по времени заведения.</p></div><a class="button" href="/finance">${icon('arrow-left')} Финансы</a></div><section class="panel"><div class="panel-head"><span id="employee-report-date">Сегодня</span><button id="employee-report-refresh" class="button" type="button">Обновить</button></div><p id="employee-report-message" class="form-message" role="status" aria-live="polite"></p><div class="finance-result-grid"><article><span>Ваши оплаты сегодня</span><strong id="employee-report-revenue">—</strong><small>Все поступившие платежи, включая частичные</small></article><article><span>Чеков закрыто сегодня</span><strong id="employee-report-checks">—</strong><small>По времени закрытия заказа</small></article></div><small id="employee-report-number" class="muted"></small></section>`;
  let pending = false;
  const load = async () => {
    if (pending) return;
    pending = true;
    const button = target.querySelector('#employee-report-refresh'); const message = target.querySelector('#employee-report-message');
    button.disabled = true; message.textContent = 'Обновляем отчёт…';
    try {
      const report = await api('/api/finance/report');
      if (target.querySelector('#employee-report-refresh') !== button) return;
      if (report.employeeView !== true) throw new Error('employee_report_invalid_response');
      target.querySelector('#employee-report-date').textContent = formatRuDate(report.date);
      target.querySelector('#employee-report-revenue').textContent = money(report.revenue);
      target.querySelector('#employee-report-checks').textContent = report.checksCount ?? 0;
      target.querySelector('#employee-report-number').textContent = report.reportNumber || '';
      message.textContent = '';
    } catch (_) {
      if (target.querySelector('#employee-report-refresh') !== button) return;
      target.querySelector('#employee-report-revenue').textContent = '—'; target.querySelector('#employee-report-checks').textContent = '—'; target.querySelector('#employee-report-number').textContent = '';
      message.textContent = 'Не удалось загрузить отчёт. Повторите попытку.';
    } finally { pending = false; button.disabled = false; }
  };
  target.querySelector('#employee-report-refresh').addEventListener('click', load);
  load();
}

function renderFinanceReport() {
  const target = document.querySelector('#page-content'); if (!target) return;
  if (['bartender','hookah_master','senior_bartender','senior_hookah_master','cleaner','security','technician','other_staff'].includes(String(portalUser.role || '').toLowerCase())) { renderEmployeeFinanceReport(target); return; }
  target.innerHTML = `<div class="page-title"><div><p class="eyebrow">КОНТРОЛЬ СМЕНЫ</p><h1>Отчёты</h1><p class="muted">Продажи относятся к дате закрытия чека. Приём и возврат денег — к фактической дате операции.</p></div><a class="button" href="/finance">${icon('arrow-left')} Финансы</a></div><section class="panel wide report-controls"><div class="toolbar-row"><label>Дата<input id="report-date" type="date" required aria-describedby="report-message" value="${localDateKey()}"></label><label>Тип отчёта<select id="report-type"><option value="x">X‑отчёт смены</option><option value="waiter">Отчёт официанта</option></select></label><button class="button primary" id="report-refresh" type="button">Сформировать</button></div><p id="report-message" class="form-message" role="status" aria-live="polite"></p></section><section class="kpi-grid compact" id="report-kpis"><article class="kpi"><span>Продажи</span><strong id="report-revenue">—</strong><small>По закрытым чекам</small></article><article class="kpi"><span>Чеков закрыто</span><strong id="report-checks">—</strong><small id="report-meta">—</small></article><article class="kpi"><span>Наличные получены</span><strong id="report-cash">—</strong><small>По дате операции</small></article><article class="kpi"><span>Карта + QR получены</span><strong id="report-digital">—</strong><small>По дате операции</small></article><article class="kpi"><span>Возвраты</span><strong id="report-payouts">—</strong><small>Из журналов счёта гостя и предоплат</small></article></section><div class="content-grid report-grid"><section class="panel"><div class="panel-head"><div><h2>Деньги по дате операции</h2><span class="muted" id="report-number">Отчёт ещё не сформирован</span></div></div><div class="report-breakdown" id="report-payments"><div class="empty">Выберите дату и сформируйте отчёт</div></div></section><section class="panel"><div class="panel-head"><div><h2 id="report-secondary-title">Продажи по зонам</h2><span class="muted">Сумма распределяется по сохранённым позициям</span></div></div><div class="report-breakdown" id="report-secondary"><div class="empty">—</div></div></section></div>`;
  const reconciliationFromDefault = `${localDateKey().slice(0,8)}01`;
  target.insertAdjacentHTML('beforeend', `<section class="panel wide loyalty-reconciliation-panel"><div class="panel-head"><div><h2>Сверка бонусов, денег гостей и предоплат</h2><span class="muted">Движения за период по времени заведения; остатки и обязательства — на сейчас</span></div><button class="button" id="loyalty-reconciliation-refresh" type="button">Обновить сверку</button></div><div class="toolbar-row"><label>С даты<input id="loyalty-reconciliation-from" type="date" value="${reconciliationFromDefault}"></label><label>По дату включительно<input id="loyalty-reconciliation-to" type="date" value="${localDateKey()}"></label></div><p class="form-message" id="loyalty-reconciliation-message" role="status" aria-live="polite">Загружаем сверку…</p><div id="loyalty-reconciliation-results" class="report-breakdown"><div class="empty">Загружаем данные…</div></div></section>`);
  const loadLoyaltyReconciliation = async () => {
    const button=target.querySelector('#loyalty-reconciliation-refresh');const message=target.querySelector('#loyalty-reconciliation-message');const results=target.querySelector('#loyalty-reconciliation-results');const from=target.querySelector('#loyalty-reconciliation-from').value;const to=target.querySelector('#loyalty-reconciliation-to').value;
    if(!from||!to||from>to){message.textContent='Укажите корректный диапазон дат';results.innerHTML='<div class="empty">Проверьте начало и конец периода</div>';return;}
    button.disabled=true;message.textContent='Формируем сверку…';
    try{const report=await api(`/api/loyalty/reconciliation?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);const flows=report.periodMovements||{};const bonus=flows.bonus||{};const deposit=flows.deposit||{};const booking=flows.reservationPrepayment||{};const balances=report.balances||{};const bonusAvailable=balances.bonus?.outstandingClawback==null?null:Math.max(0,Number(balances.bonus?.wallet||0)-Number(balances.bonus.outstandingClawback));const metricMoney=(value)=>value==null?'Недоступно в этом режиме':money(value);const metricCount=(value)=>value==null?'Не сверено в этом режиме':Number(value).toLocaleString('ru-RU');const discrepancy=(item)=>Number(item?.mismatchCount||0)?`${item.mismatchCount} гостей · расхождение ${money(item.mismatchAmount)}`:'Расхождений нет';
      const pointRows=Object.entries({issued:bonus.issued,redeemed:bonus.redeemed,reversed:bonus.reversed,clawbackAdded:bonus.clawbackAdded,clawbackReleased:bonus.clawbackReleased}).map(([key,value])=>`<div class="report-row"><span>${esc(({issued:'Начислено бонусов',redeemed:'Списано при оплате',reversed:'Сторнировано',clawbackAdded:'Добавлено удержаний',clawbackReleased:'Снято удержаний'})[key])}</span><strong>${value==null?'Недоступно':Math.floor(Number(value)).toLocaleString('ru-RU')} б.</strong></div>`).join('');
      const legacyRecords=report.legacyReservations||[];const legacyReview=report.legacyReviewAccessRequired?'<section class="panel wide"><div class="panel-head"><h3>Исторические суммы броней</h3></div><p class="form-message">Сводные суммы есть в отчёте; персональные данные и ручная проверка доступны владельцу/администратору с правом управления финансами.</p></section>':legacyRecords.length?`<section class="panel wide"><div class="panel-head"><div><h3>Старые суммы депозитов по броням</h3><span class="muted">Записей в списке: ${Number(balances.reservationPrepayment?.legacyReviewReturnedCount||legacyRecords.length)}${balances.reservationPrepayment?.legacyReviewTruncated?' · показаны первые 250':''}</span></div></div><p class="form-message">Старая сумма сохранена из прежней системы и сама по себе не подтверждает оплату. Сверьте её с первичными документами; не создавайте квитанцию и не оформляйте возврат только по этой записи. Такие брони блокируют новый приём предоплаты до ручной сверки.</p><div class="report-breakdown">${renderLegacyReservationRows(legacyRecords)}}</div></section>`:'<div class="empty">Броней со старыми суммами депозитов для ручной сверки нет.</div>';const business=report.periodBusiness||null;const sale=business?.sales||{};const coverageLabels={'external refund and payout ledgers':'Журналы выплат и внешних возвратов','bonus clawback balance and period movements':'Остаток удержанных бонусов и движения за период','external account refunds':'Внешние возвраты со счетов гостей','reservation prepayment reopening and refund period movements':'Возврат предоплаты гостю и возобновление доступного остатка','sales fields for closed orders without saved price data':'Для некоторых закрытых заказов нет снимка цены','discount breakdown for closed orders without price snapshots':'Для некоторых заказов не сохранён снимок скидок'};const coverageReasonLabel=(item)=>{const missingClosure=String(item).match(/^([0-9]+) closed order/);return missingClosure?`Количество закрытых заказов без корректной даты закрытия: ${missingClosure[1]}. Они исключены из продаж периода.`:coverageLabels[item]||item};const coverageItems=Array.isArray(report.coverage?.unavailable)?report.coverage.unavailable:[];const coverageNotice=report.coverage?.complete===false?`<div class="form-message reconciliation-coverage-warning" role="status">Локальный preview использует memory-хранилище. Показатели без соответствующего журнала помечены «Недоступно» и не считаются нулём.${coverageItems.length?`<ul>${coverageItems.map((item)=>`<li>${esc(coverageReasonLabel(item))}</li>`).join('')}</ul>`:''}</div>`:'';const sourceLabels={guest_group:'Скидка группы',promotion:'Акция',manual:'Ручная скидка',none:'Без скидки'};const receiptLabels={cash:'Наличные',card:'Карта',qr:'QR',guest_account_top_up:'Пополнение счёта гостя',reservation_prepayment:'Предоплата брони',order_payment:'Оплата заказа'};const payoutLabels={cash:'Наличные',card:'Карта',qr:'QR'};const payoutSourceLabels={guest_account_refund:'Возврат со счёта гостя',reservation_prepayment_refund:'Возврат предоплаты брони',order_refund:'Возврат по POS-заказу'};const discountSourceRows=sale.discountsBySource==null?null:Object.fromEntries(Object.entries(sale.discountsBySource).map(([key,value])=>[sourceLabels[key]||key,value]));const groupRows=sale.discountsByGroup==null?null:Object.fromEntries(Object.entries(sale.discountsByGroup).map(([key,value])=>[`Группа: ${key}`,value]));const promotionRows=sale.discountsByPromotion==null?null:Object.fromEntries(Object.entries(sale.discountsByPromotion).map(([key,value])=>[`Акция: ${key}`,value]));const receiptMethodRows=business?.receipts?.byMethod==null?null:Object.fromEntries(Object.entries(business.receipts.byMethod).map(([key,value])=>[receiptLabels[key]||key,value]));const receiptSourceRows=business?.receipts?.bySource==null?null:Object.fromEntries(Object.entries(business.receipts.bySource).map(([key,value])=>[receiptLabels[key]||key,value]));const payoutMethodRows=business?.payouts?.byMethod==null?null:Object.fromEntries(Object.entries(business.payouts.byMethod).map(([key,value])=>[payoutLabels[key]||key,value]));const payoutSourceRows=business?.payouts?.bySource==null?null:Object.fromEntries(Object.entries(business.payouts.bySource).map(([key,value])=>[payoutSourceLabels[key]||key,value]));
      results.innerHTML=`${coverageNotice}<div class="finance-result-grid"><article><span>Доступно бонусов сейчас</span><strong>${bonusAvailable==null?'Недоступно':Math.floor(bonusAvailable).toLocaleString('ru-RU')+' б.'}</strong><small>Баланс ${Math.floor(Number(balances.bonus?.wallet||0)).toLocaleString('ru-RU')} б. · удержание ${balances.bonus?.outstandingClawback==null?'не сверено':Math.floor(Number(balances.bonus.outstandingClawback)).toLocaleString('ru-RU')+' б.'}</small></article><article><span>Деньги на счетах гостей</span><strong>${money(balances.deposit?.wallet||0)}</strong><small>Сверка с журналом: ${esc(discrepancy(balances.deposit))}</small></article><article><span>Неиспользованные предоплаты</span><strong>${metricMoney(balances.reservationPrepayment?.unapplied)}</strong><small>Сверка квитанций и бронирований: ${metricCount(balances.reservationPrepayment?.verifiedCounterMismatchCount)} расхождений · ${metricMoney(balances.reservationPrepayment?.verifiedCounterMismatchAmount)}</small></article><article><span>Старый депозит бронирований</span><strong>${money(balances.reservationPrepayment?.legacyUnverified||0)}</strong><small>${balances.reservationPrepayment?.legacyReservationCount||0} броней со старой суммой для сверки</small></article></div>${legacyReview}<div class="content-grid report-grid"><section><h3>Движения бонусов · ${esc(report.period?.from||from)} — ${esc(report.period?.to||to)}</h3>${pointRows||'<div class="empty">Данных за выбранный период нет</div>'}</section><section><h3>Деньги гостя</h3>${drawRows({toppedUp:deposit.toppedUp,redeemed:deposit.redeemed,reversed:deposit.reversed,externalRefund:deposit.externalRefund},{toppedUp:'Пополнено',redeemed:'Использовано в оплатах',reversed:'Сторно внутри счёта',externalRefund:'Выплачено гостю наличными, картой или QR'})}</section><section><h3>Предоплата бронирований</h3>${drawRows({collected:booking.collected,applied:booking.applied,reopened:booking.reopened,refunded:booking.refunded},{collected:'Принято по квитанциям',applied:'Зачтено в заказах',reopened:'Возвращено в доступный остаток',refunded:'Возвращено гостям'})}</section><section><h3>Продажи и скидки по дате закрытия</h3><small class="muted">Закрыто чеков: ${metricCount(sale.orders)} · без полного снимка цены: ${metricCount(sale.unsnapshottedOrders)} · скидка у них может быть не подтверждена</small>${drawRows({gross:sale.gross,discounts:sale.discounts,minimumAdjustment:sale.minimumAdjustment,net:sale.net},{gross:'До скидок',discounts:'Скидки',minimumAdjustment:'Доплата до минимума',net:'Итого продажи'})}${drawRows(discountSourceRows,{})}${drawRows(groupRows,{})}${drawRows(promotionRows,{})}</section><section><h3>Принятые деньги по дате события</h3>${drawRows(receiptMethodRows,{})}<small class="muted">По типу поступления: ${receiptSourceRows==null?'Недоступно в этом режиме':Object.entries(receiptSourceRows).map(([key,value])=>`${esc(key)} — ${metricMoney(value)}`).join(' · ')||'нет'}</small></section><section><h3>Фактические выплаты по дате возврата</h3>${drawRows(payoutMethodRows,{})}${drawRows(payoutSourceRows,{})}<small class="muted">Поступления — кассовое движение, не дополнительная выручка; зачёт предоплаты не считается новым поступлением, а возврат зачёта — выплатой.</small></section></div><small class="muted">Срез сформирован ${esc(formatRuDate(report.generatedAt,true))}; остатки показаны на сейчас, незачтённая предоплата считается отдельно, старые неподтверждённые суммы не включены в подтверждённый остаток.</small>`;
      results.querySelectorAll('.legacy-review-form').forEach((form)=>form.addEventListener('submit',async(event)=>{event.preventDefault();const button=form.querySelector('button[type="submit"]');const status=form.querySelector('[role="status"]');const values=new FormData(form);const disposition=String(values.get('disposition')||'');const evidenceReference=String(values.get('evidenceReference')||'').trim();if(disposition==='documents_found'&&!evidenceReference){status.textContent='Укажите номер или ссылку на найденный документ';status.className='form-message error-message';return;}button.disabled=true;status.textContent='Записываем результат…';try{await api(`/api/reservations/${encodeURIComponent(form.closest('[data-reservation-id]').dataset.reservationId)}/legacy-deposit-reviews`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedReviewId:String(values.get('expectedReviewId')||'')||null,disposition,note:String(values.get('note')||''),evidenceReference,idempotencyKey:crypto.randomUUID()})});status.textContent='Результат записан. Сумма, квитанции и касса не изменены.';status.className='form-message success-message';await loadLoyaltyReconciliation();}catch(error){status.textContent=error.payload?.error==='legacy_deposit_review_stale'?'Запись уже обновили в другом окне. Сверка перезагружена.':'Не удалось записать результат проверки';status.className='form-message error-message';if(error.payload?.error==='legacy_deposit_review_stale')await loadLoyaltyReconciliation();}finally{button.disabled=false;}}));
      message.textContent=`Период по часовому поясу ${report.period?.timeZone||venueTimezone||'заведения'} · текущий остаток сверяется с журналом: ${esc(discrepancy(balances.bonus))}`;
    }catch(error){results.innerHTML='<div class="empty">Не удалось загрузить сверку</div>';message.textContent=error.payload?.error==='invalid_reconciliation_period'?'Дата начала должна быть не позже даты окончания':'Сверка недоступна. Обновите страницу или повторите позже.';portalNotice('Не удалось сформировать сверку обязательств','error');}finally{button.disabled=false;}
  };
  target.querySelector('#loyalty-reconciliation-refresh').addEventListener('click',loadLoyaltyReconciliation);loadLoyaltyReconciliation();
  const drawRows = (data, labels = {}) => { if (data == null) return '<div class="empty">Показатель недоступен в локальном preview: здесь нет соответствующего журнала</div>'; const rows = Object.entries(data); return rows.length ? rows.map(([key, value]) => { const label = String(labels[key] || key); return `<div class="report-row${label.length > 26 ? ' report-row-long' : ''}"><span>${esc(label)}</span><strong>${value==null?'Недоступно в этом режиме':money(value)}</strong></div>`; }).join('') : '<div class="empty">Данных за выбранную дату нет</div>'; };
  let reportLoadRequestId = 0;
  const clearReport = (placeholder = 'Выберите дату и сформируйте отчёт') => {
    for (const selector of ['#report-revenue', '#report-checks', '#report-meta', '#report-cash', '#report-digital', '#report-payouts']) document.querySelector(selector).textContent = '—';
    document.querySelector('#report-number').textContent = 'Отчёт ещё не сформирован';
    document.querySelector('#report-payments').innerHTML = `<div class="empty">${placeholder}</div>`;
    document.querySelector('#report-secondary-title').textContent = document.querySelector('#report-type').value === 'waiter' ? 'Продажи по ответственному за заказ' : 'Продажи по зонам';
    document.querySelector('#report-secondary').innerHTML = '<div class="empty">—</div>';
  };
  const load = () => {
    const requestId = ++reportLoadRequestId;
    const dateInput = document.querySelector('#report-date'); const message = document.querySelector('#report-message'); const date = dateInput.value;
    clearReport('Формируем отчёт…');
    if (!date || !dateInput.validity.valid) { dateInput.setAttribute('aria-invalid', 'true'); clearReport(); message.textContent = 'Выберите корректную дату отчёта'; return; }
    dateInput.removeAttribute('aria-invalid'); message.textContent = 'Формируем отчёт…';
    const type = document.querySelector('#report-type').value;
    return api(`/api/finance/report?date=${encodeURIComponent(date)}&type=${type}`).then((report) => {
      if (requestId !== reportLoadRequestId) return;
      const ledgerNotices = [];
      if (report.receipts?.coverage === 'memory_order_payments_only') ledgerNotices.push('Локальный preview показывает только оплаты заказов; квитанции пополнений гостевого счёта и предоплат здесь недоступны.');
      if (report.payouts?.coverage === 'guest_account_reservation_prepayment_and_order_refund_ledgers_only') ledgerNotices.push('Выплаты POS-возвратов включены по новому журналу. Старые отметки возврата в статусах оплат не восстановлены; распределение по позициям заказа для этих выплат не подтверждено.');
      else if (report.payouts?.coverage === 'guest_account_and_reservation_prepayment_refund_ledgers_only') ledgerNotices.push('Возвраты обычных POS-заказов пока не входят в этот отчёт; показаны возвраты по счёту гостя и предоплатам.');
      else if (report.payouts?.coverage !== 'complete') ledgerNotices.push('Состав журнала выплат в этом режиме неполный или неизвестен; сверяйте итог с первичными документами.');
      message.textContent = ledgerNotices.join(' ');
      document.querySelector('#report-revenue').textContent = money(report.sales?.net ?? report.revenue);
      document.querySelector('#report-checks').textContent = report.checksCount ?? report.closedOrders ?? 0;
      const receiptMethods = report.receipts?.byMethod || report.byPaymentMethod || {};
      document.querySelector('#report-meta').textContent = `${report.receipts?.count ?? report.paymentCount ?? 0} операций приёма денег`;
      document.querySelector('#report-cash').textContent = money(receiptMethods.cash || 0);
      document.querySelector('#report-digital').textContent = money(Number(receiptMethods.card || 0) + Number(receiptMethods.qr || 0));
      const payoutCoverage = report.payouts?.coverage;
      const payoutsKnown = ['complete', 'guest_account_and_reservation_prepayment_refund_ledgers_only', 'guest_account_reservation_prepayment_and_order_refund_ledgers_only'].includes(payoutCoverage);
      document.querySelector('#report-payouts').textContent = payoutsKnown ? money(report.payouts.total || 0) : 'Недоступно';
      document.querySelector('#report-number').textContent = `${report.reportNumber} · ${new Date(report.generatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
      const receiptSourceLabels = { order_payment: 'Оплата заказа', guest_account_top_up: 'Пополнение счёта гостя', reservation_prepayment: 'Предоплата брони' };
      const payoutSourceLabels = { guest_account_refund: 'Возврат со счёта гостя', reservation_prepayment_refund: 'Возврат предоплаты брони', order_refund: 'Возврат по POS-заказу' };
      const receiptSourceRows = report.receipts?.bySource == null ? null : Object.fromEntries(Object.entries(report.receipts.bySource).map(([key, value]) => [receiptSourceLabels[key] || key, value]));
      const payoutSourceRows = report.payouts?.bySource == null ? null : Object.fromEntries(Object.entries(report.payouts.bySource).map(([key, value]) => [payoutSourceLabels[key] || key, value]));
      document.querySelector('#report-payments').innerHTML = `${drawRows(receiptMethods, { cash: 'Наличные', card: 'Карта', qr: 'QR' })}${receiptSourceRows ? drawRows(receiptSourceRows) : ''}${payoutSourceRows ? `<h3>Фактически выплачено</h3>${drawRows(payoutSourceRows)}` : ''}`;
      document.querySelector('#report-secondary-title').textContent = type === 'waiter' ? 'Продажи по ответственному за заказ' : 'Продажи по зонам';
      document.querySelector('#report-secondary').innerHTML = drawRows(type === 'waiter' ? report.byStaff : report.byStation, { kitchen: 'Кухня', bar: 'Бар', hookah: 'Кальяны', ingredients: 'Ингредиенты', stock: 'Склад', delivery: 'Доставка', other: 'Другое' });
    }).catch(() => { if (requestId !== reportLoadRequestId) return; clearReport('Не удалось загрузить данные отчёта'); message.textContent = 'Не удалось сформировать отчёт. Повторите попытку.'; portalNotice('Не удалось сформировать отчёт', 'error'); });
  };
  document.querySelector('#report-date').addEventListener('input', () => { ++reportLoadRequestId; clearReport(); document.querySelector('#report-message').textContent = 'Нажмите «Сформировать», чтобы обновить отчёт.'; });
  document.querySelector('#report-refresh').addEventListener('click', load); document.querySelector('#report-type').addEventListener('change', load); load();
}

function renderIntegrations() {
  const target = document.querySelector('#page-content'); if (!target) return;
  target.innerHTML = `<div class="page-title"><div><p class="eyebrow">УВЕДОМЛЕНИЯ</p><h1>Интеграции</h1><p class="muted">Здесь будет настройка уведомлений CRM через Telegram.</p></div></div><section class="panel wide integrations-panel"><div class="panel-head"><div><h2>Telegram</h2><span class="muted">Уведомления для управляющего и сотрудников</span></div><span class="badge warning" id="telegram-integration-status" role="status" aria-live="polite">Проверяем…</span></div><div class="integration-card"><span class="integration-icon" aria-hidden="true">${icon('send')}</span><div><h3>Уведомления в Telegram</h3><p>Получайте выбранные рабочие уведомления CRM в Telegram.</p><small class="muted" id="telegram-integration-note">Проверяем состояние подключения.</small></div></div><div class="integration-detail-grid"><div><b>Что будет доступно</b><p class="muted" id="telegram-integration-help">Настройка бота и выбор типов уведомлений.</p></div></div></section>`;
  api('/api/integrations').then((data) => {
    const item = data.telegram || {};
    const status = document.querySelector('#telegram-integration-status');
    const note = document.querySelector('#telegram-integration-note');
    const help = document.querySelector('#telegram-integration-help');
    if (item.enabled) {
      status.className = 'badge success'; status.textContent = 'Подключено';
      if (note) note.textContent = 'Telegram-бот подключён и готов отправлять настроенные уведомления.';
      if (help) help.textContent = 'Связь с ботом активна.';
    } else {
      status.className = 'badge warning'; status.textContent = 'В разработке';
      if (note) note.textContent = 'Настройка Telegram-бота пока недоступна.';
      if (help) help.textContent = 'Когда подключение будет готово, здесь появятся настройка бота и выбор типов уведомлений.';
    }
  }).catch(() => {
    const status = document.querySelector('#telegram-integration-status');
    const note = document.querySelector('#telegram-integration-note');
    const help = document.querySelector('#telegram-integration-help');
    if (status) { status.className = 'badge danger'; status.textContent = 'Статус недоступен'; }
    if (note) note.textContent = 'Не удалось проверить состояние Telegram.';
    if (help) help.textContent = 'Обновите страницу позже. Состояние подключения не подтверждено.';
  });
}
function renderNetwork() {
  const target = document.querySelector('#page-content'); if (!target) return;
  target.innerHTML = `<div class="page-title"><div><p class="eyebrow">СЕТЕВОЕ УПРАВЛЕНИЕ</p><h1>Заведения сети</h1><p class="muted">Здесь управляются точки сети. Данные текущего заведения меняются в разделе «Настройки».</p></div><a class="button small" href="/admin#settings">Настройки заведения</a></div><div class="content-grid"><section class="panel wide"><div class="panel-head"><div><h2>Точки сети</h2><span class="muted" id="network-count">Загрузка…</span></div></div><div class="network-list" id="network-list"><div class="empty">Загрузка заведений…</div></div></section><section class="panel"><div class="panel-head"><h2>Добавить заведение сети</h2></div><form class="stack-form" id="network-form"><label>Название<input id="network-name" required maxlength="120" placeholder="Территория — центр"></label><label>Город<input id="network-city" required maxlength="80" placeholder="Тюмень"></label><label>Адрес<input id="network-address" required maxlength="240" placeholder="Улица, дом"></label><label>Формат<input id="network-format" maxlength="80" value="кальян-бар"></label><label>Телефон<input id="network-phone" maxlength="32" placeholder="+7 ..."></label><label>Часовой пояс<select id="network-timezone" required>${russianTimezoneOptions()}</select></label><button class="button primary" type="submit">Добавить заведение</button><p class="form-message" id="network-message" role="status" aria-live="polite"></p></form></section></div>`;
  const timezoneSelect = document.querySelector('#network-timezone');
  let timezoneTouched = false;
  let defaultTimezone = venueTimezone || 'Asia/Yekaterinburg';
  const setDefaultTimezone = () => {
    const supported = [...timezoneSelect.options].some((option) => option.value === defaultTimezone);
    timezoneSelect.value = supported ? defaultTimezone : 'Asia/Yekaterinburg';
    timezoneSelect._customSelectRefresh?.();
  };
  setDefaultTimezone();
  timezoneSelect.addEventListener('change', () => { timezoneTouched = true; });
  const draw = (items) => { window.__networkItems = items; document.querySelector('#network-count').textContent = `${items.length} ${pluralRu(items.length,'точка','точки','точек')}`; document.querySelector('#network-list').innerHTML = items.length ? items.map((item) => `<article class="network-row"><div><b>${esc(displayName(item.name))}</b><small>${esc(item.format || 'кальян-бар')} · ${esc(item.city)} · ${esc(item.address)}</small><small>${esc(item.phone || 'Телефон не указан')} · ${esc(item.timezone || 'Часовой пояс не указан')}</small></div><div class="toolbar-row"><span class="badge ${item.isCurrent ? 'success' : 'warning'}">${item.isCurrent ? 'Текущая точка' : 'Подготовлена'}</span>${item.isCurrent ? '<a class="button small" href="/admin#settings">Настройки заведения</a>' : `<button class="button small network-select" type="button" data-venue="${esc(item.id)}">Сделать текущей</button><button class="button small network-edit" type="button" data-venue="${esc(item.id)}">Изменить</button>`}${item.isCurrent ? '' : `<button class="button small danger-outline network-archive" type="button" data-venue="${esc(item.id)}">Архивировать</button>`}</div></article>`).join('') : '<div class="empty">Точки ещё не добавлены</div>'; };
  let loadGeneration = 0;
  const load = async () => {
    const generation = ++loadGeneration;
    try {
      const data = await api('/api/network/venues');
      if (generation !== loadGeneration) return;
      const items = data.items || [];
      defaultTimezone = items.find((item) => item.isCurrent)?.timezone || defaultTimezone;
      if (!timezoneTouched) setDefaultTimezone();
      draw(items);
    } catch (_) {
      if (generation !== loadGeneration) return;
      document.querySelector('#network-count').textContent = 'Ошибка загрузки';
      document.querySelector('#network-list').innerHTML = '<div class="empty" role="alert">Не удалось загрузить точки сети. <button class="button" type="button" data-network-retry>Повторить</button></div>';
    }
  };
  load();
  let actionPending = false;
  document.querySelector('#network-list').addEventListener('click', async (event) => {
    const retry = event.target.closest('[data-network-retry]');
    if (retry) { retry.disabled = true; retry.textContent = 'Загрузка…'; await load(); return; }
    const button = event.target.closest('[data-venue]'); if (!button) return; const id = button.dataset.venue;
    if (actionPending || button.disabled) return;
    let restoreFocus = false; actionPending = true; const originalLabel = button.textContent; button.disabled = true; button.textContent = 'Подождите…';
    try {
    if (button.classList.contains('network-select')) { await api(`/api/network/venues/${encodeURIComponent(id)}/select`, { method: 'POST' }).then(async () => { const context = await refreshPortalContext(); portalNotice(context.failed.length ? 'Точка выбрана; часть данных заведения не удалось обновить' : 'Точка выбрана как текущая', context.failed.length ? 'error' : 'success'); await load(); }).catch(() => portalNotice('Не удалось выбрать точку', 'error')); }
    else if (button.classList.contains('network-archive')) { if (!await portalConfirm('Архивировать точку?', 'Точка исчезнет из рабочего списка, но история операций сохранится.', 'Архивировать')) { restoreFocus = true; return; } await api(`/api/network/venues/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(async () => { portalNotice('Точка архивирована', 'success'); await load(); }).catch((error) => portalNotice(error.payload?.error === 'current_venue_cannot_be_archived' ? 'Текущую точку нельзя архивировать' : 'Не удалось архивировать точку', 'error')); }
    else if (button.classList.contains('network-edit')) { const item = (window.__networkItems || []).find((entry) => entry.id === id); if (!item) return; const values = await portalAction({ title: 'Изменить точку', description: 'Название и адрес будут видны в переключателе заведений.', submitLabel: 'Сохранить', fields: [{ name: 'name', label: 'Название точки', value: item.name }, { name: 'address', label: 'Адрес', value: item.address }] }); if (!values) { restoreFocus = true; return; } await api(`/api/network/venues/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: values.name.trim(), address: values.address.trim() }) }).then(async () => { portalNotice('Точка обновлена', 'success'); await load(); }).catch(() => portalNotice('Не удалось обновить точку', 'error')); }
    } finally { actionPending = false; if (button.isConnected) { button.disabled = false; button.textContent = originalLabel; if (restoreFocus && button.getClientRects().length) button.focus({ preventScroll: true }); } }
  });
  let creating = false;
  document.querySelector('#network-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (creating) return;
    const form = event.target; const button = form.querySelector('[type="submit"]');
    const message = document.querySelector('#network-message');
    creating = true; button.disabled = true; button.textContent = 'Сохранение…';
    message.textContent = ''; message.className = 'form-message';
    try {
      await api('/api/network/venues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: document.querySelector('#network-name').value.trim(), city: document.querySelector('#network-city').value.trim(), address: document.querySelector('#network-address').value.trim(), format: document.querySelector('#network-format').value.trim(), phone: document.querySelector('#network-phone').value.trim(), timezone: timezoneSelect.value }) });
      message.textContent = 'Точка добавлена'; message.className = 'form-message success-message';
      form.reset(); document.querySelector('#network-format').value = 'кальян-бар';
      timezoneTouched = false; setDefaultTimezone(); await load();
    } catch (error) {
      const errors = { venue_name_city_address_required: 'Заполните название, город и адрес', invalid_venue_timezone: 'Выберите корректный часовой пояс', venue_admin_required: 'Добавление заведений доступно администратору сети' };
      message.textContent = errors[error.payload?.error] || 'Не удалось добавить точку. Попробуйте ещё раз';
      message.className = 'form-message error-message';
    } finally { creating = false; button.disabled = false; button.textContent = 'Добавить заведение'; }
  });
}

function renderOrders() {
  const target = document.querySelector('#page-content'); if (!target) return; target.classList.add('orders-view');
  target.innerHTML = `<div class="page-title"><div><p class="eyebrow">ОПЕРАЦИИ СМЕНЫ</p><h1>Журнал заказов</h1><p class="muted">Контроль открытых и закрытых заказов, оплат и депозитов VIP-комнат.</p></div><a class="button primary" href="/">Открыть зал и заказы</a></div><div class="kpi-grid compact"><article class="kpi"><span>Всего заказов</span><strong id="orders-count">—</strong><small>За текущий период</small></article><article class="kpi"><span>Открытые</span><strong id="orders-open">—</strong><small>Требуют обслуживания</small></article><article class="kpi"><span>Выручка</span><strong id="orders-revenue">—</strong><small>По закрытым заказам</small></article></div><section class="panel wide"><div class="panel-head"><div><h2>Журнал заказов</h2><span class="muted">Можно найти стол, гостя или номер заказа</span></div><div class="toolbar-row"><input class="table-search" id="orders-search" aria-label="Поиск заказов" placeholder="Поиск"><input class="table-search" id="orders-date" type="date" aria-label="Дата заказов"><select id="orders-sort" aria-label="Сортировка"><option value="newest">Сначала новые</option><option value="attention">Сначала требуют внимания</option><option value="amount">По сумме</option></select><select id="orders-status" aria-label="Статус"><option value="">Все статусы</option><option value="open">Открыт</option><option value="in_progress">Готовится</option><option value="ready">Готов</option><option value="closed">Закрыт</option><option value="cancelled">Отменён</option></select></div></div><div class="table-wrap"><table class="orders-table"><thead><tr><th>Заказ</th><th>Стол</th><th>Гость</th><th>Статус</th><th>Сумма</th><th>Создан</th><th></th></tr></thead><tbody id="orders-rows"><tr><td colspan="7" class="empty">Загрузка заказов…</td></tr></tbody></table></div></section>`;
  let items = [];
  const canReadOrderRefunds = portalPermissions.has('finance_read') || portalPermissions.has('finance');
  const canCreateOrderRefunds = portalPermissions.has('finance');
  const paymentMethodLabel = (method) => ({ cash: 'Наличные', card: 'Карта', qr: 'QR' })[method] || method || '—';
  const payoutMethodLabel = (method) => ({ cash: 'Наличные', card: 'На карту', qr: 'Через QR' })[method] || method || '—';
  const refundDialog = document.createElement('dialog');
  refundDialog.className = 'order-refund-dialog';
  refundDialog.setAttribute('aria-labelledby', 'order-refund-title');
  refundDialog.innerHTML = '<div class="panel-head"><div><h2 id="order-refund-title">Возврат по заказу</h2><span class="muted" data-refund-order-label></span></div><button class="icon-button" type="button" data-refund-close aria-label="Закрыть">×</button></div><div data-refund-content><div class="empty">Загрузка данных…</div></div>';
  document.body.append(refundDialog);
  let activeRefundOrder = null;
  let activeRefundGeneration = 0;
  const closeRefundDialog = () => { activeRefundGeneration += 1; refundDialog.close(); activeRefundOrder = null; };
  refundDialog.querySelector('[data-refund-close]').addEventListener('click', closeRefundDialog);
  refundDialog.addEventListener('click', (event) => { if (event.target === refundDialog) closeRefundDialog(); });
  const refundErrorMessage = (error) => {
    const code = error?.payload?.error;
    return ({
      forbidden: 'Нет права оформлять возврат. Для просмотра истории достаточно финансового доступа.',
      order_must_be_closed: 'Возврат доступен после закрытия заказа.',
      open_shift_required: 'Откройте смену, чтобы провести выплату и записать её в кассовый журнал.',
      refund_source_payment_unavailable: 'Исходная оплата больше недоступна. Обновите данные заказа.',
      refund_exceeds_payment_balance: 'Сумма превышает остаток по выбранной оплате. История обновлена.',
      refund_item_snapshot_unavailable: 'Для этого заказа нет подтверждённого снимка строк продажи. Возврат товара нельзя распределить по позициям.',
      refund_item_source_unavailable: 'Возвращаемая позиция не входит в сохранённый снимок заказа.',
      refund_item_quantity_exceeds_remaining: 'Количество превышает остаток позиции, доступный для возврата.',
      idempotency_key_reused: 'Ключ возврата уже использован, но исходный запрос не подтверждён. Не создавайте новый возврат; обратитесь к финансовому администратору для сверки истории.',
      order_not_found: 'Заказ не найден или недоступен в этом заведении.',
      order_refunds_requires_database: 'Реестр возвратов временно недоступен.',
      order_refunds_unavailable: 'Не удалось загрузить историю возвратов.',
      order_refund_failed: 'Не удалось записать возврат. Повторите с теми же данными.'
    })[code] || (error?.payload ? 'Не удалось выполнить возврат. Проверьте введённые данные и попробуйте снова.' : 'Ответ сервера не получен. Можно безопасно повторить отправку с теми же данными.');
  };
  const readPendingRefundIntent = (orderId) => {
    const storageKey = `crm:pending-order-refund:${orderId}`;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return { intent: null, invalid: false };
      const stored = JSON.parse(raw);
      if (stored?.completed === true) { localStorage.removeItem(storageKey); return { intent: null, invalid: false }; }
      const payload = stored?.payload;
      const cents = (value) => {
        const rawAmount = String(value ?? '');
        if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(rawAmount)) return null;
        const [whole, fraction = ''] = rawAmount.split('.');
        const result = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
        return Number.isSafeInteger(result) ? result : null;
      };
      const totalCents = cents(payload?.amount);
      const allocations = payload?.allocations;
      const valid = /^[A-Za-z0-9._:-]{8,120}$/.test(String(stored?.idempotencyKey || ''))
        && String(payload?.reason || '').trim().length > 0 && String(payload.reason).length <= 500
        && totalCents !== null && totalCents > 0 && Array.isArray(allocations) && allocations.length > 0
        && allocations.every((allocation) => /^[0-9a-f-]{36}$/i.test(String(allocation?.sourcePaymentId || ''))
          && cents(allocation?.amount) > 0 && ['cash', 'card', 'qr'].includes(allocation?.payoutMethod))
        && new Set(allocations.map((allocation) => allocation.sourcePaymentId)).size === allocations.length
        && allocations.reduce((sum, allocation) => sum + cents(allocation.amount), 0) === totalCents
        && stored.fingerprint === JSON.stringify({ orderId, ...payload });
      return valid ? { intent: stored, invalid: false } : { intent: null, invalid: true };
    } catch { return { intent: null, invalid: true }; }
  };
  const renderRefundOrder = async (order) => {
    if (!canReadOrderRefunds || !portalPermissions.has('orders') || (order.reservationId && !portalPermissions.has('reservations'))) return;
    activeRefundOrder = order;
    const generation = ++activeRefundGeneration;
    const pendingState = readPendingRefundIntent(order.id);
    let pendingIntent = pendingState.intent;
    const pendingIntentInvalid = pendingState.invalid;
    refundDialog.querySelector('[data-refund-order-label]').textContent = `Заказ № ${displayOrderId(order.id)} · ${order.tableName || 'без стола'}`;
    const content = refundDialog.querySelector('[data-refund-content]');
    content.innerHTML = '<div class="empty">Загрузка оплат и истории возвратов…</div>';
    if (!refundDialog.open) refundDialog.showModal();
    try {
      const [paymentData, refundData] = await Promise.all([
        api(`/api/orders/${encodeURIComponent(order.id)}/payments`),
        api(`/api/finance/orders/${encodeURIComponent(order.id)}/refunds`)
      ]);
      if (generation !== activeRefundGeneration || !refundDialog.open) return;
      const payments = (paymentData.items || []).filter((payment) => ['cash', 'card', 'qr'].includes(payment.method) && ['paid', 'partially_paid'].includes(payment.status));
      const refunds = refundData.items || [];
      const returnableItems = refundData.returnableItems || [];
      const refundedByPayment = new Map();
      for (const refund of refunds) for (const allocation of refund.allocations || []) {
        refundedByPayment.set(allocation.sourcePaymentId, (refundedByPayment.get(allocation.sourcePaymentId) || 0) + Number(allocation.amount || 0));
      }
      const rows = payments.map((payment) => {
        const paid = Number(payment.amount || 0);
        const refunded = refundedByPayment.get(payment.id) || 0;
        const available = Math.max(0, Math.round((paid - refunded) * 100) / 100);
        const savedAllocation = pendingIntent?.payload?.allocations?.find((allocation) => allocation.sourcePaymentId === payment.id);
        const showControl = canCreateOrderRefunds && (pendingIntent ? Boolean(savedAllocation) : order.status === 'closed' && available > 0);
        const inputMaximum = Math.max(available, savedAllocation ? Number(savedAllocation.amount) : 0);
        return `<div class="order-refund-payment"><div><b>${esc(paymentMethodLabel(payment.method))}</b><small>Получено: ${money(paid)} · Возвращено: ${money(refunded)} · Доступно: ${money(available)}</small><small>${payment.createdAt ? formatRuDate(payment.createdAt, true) : ''}</small></div>${showControl ? `<label>К возврату, ₽<input type="number" min="0" max="${inputMaximum.toFixed(2)}" step="0.01" value="${esc(savedAllocation?.amount || '0.00')}" data-refund-source="${esc(payment.id)}" data-refund-available="${inputMaximum.toFixed(2)}"></label><label>Фактическая выплата<select data-refund-payout="${esc(payment.id)}"><option value="cash" ${savedAllocation?.payoutMethod === 'cash' ? 'selected' : ''}>Наличные</option><option value="card" ${savedAllocation?.payoutMethod === 'card' ? 'selected' : ''}>На карту</option><option value="qr" ${savedAllocation?.payoutMethod === 'qr' ? 'selected' : ''}>Через QR</option></select></label>` : ''}</div>`;
      }).join('');
      const history = refunds.length ? refunds.map((refund) => `<article class="order-refund-history-row"><div><b>${money(refund.amount)} · ${esc(refund.reason || 'Без причины')}</b><small>${refund.createdAt ? formatRuDate(refund.createdAt, true) : 'Дата не указана'} · Выплата по возврату, не изменение исходной оплаты</small><small>Товарные строки: ${refund.itemAttributionStatus === 'complete' ? 'зафиксированы' : refund.itemAttributionStatus === 'not_applicable' ? 'возврата товара нет' : 'не распределены по строкам'}</small></div><ul>${(refund.allocations || []).map((allocation) => `<li>${money(allocation.amount)} · источник: ${esc(paymentMethodLabel(payments.find((payment) => payment.id === allocation.sourcePaymentId)?.method || 'Оплата'))} · выплачено: ${esc(payoutMethodLabel(allocation.payoutMethod))}</li>`).join('')}${(refund.itemReturns || []).map((item) => `<li>${esc(item.productName || 'Позиция заказа')} · возвращено ${Number(item.quantity).toLocaleString('ru-RU',{maximumFractionDigits:3})} · стоимость продажи ${money(Number(item.itemValueMinor||0)/100)}</li>`).join('')}</ul></article>`).join('') : '<div class="empty">Возвратов по этому заказу пока нет.</div>';
      const coverageWarning = refundData.coverage?.legacyPaymentStatusRefunded === 'unknown_not_reconstructed' ? '<p class="notice warning">История содержит возвраты, проведённые через новый реестр. Старые отметки возврата в статусах оплат не восстановлены.</p>' : '';
      const refundFormAvailable = canCreateOrderRefunds && (order.status === 'closed' || pendingIntent || pendingIntentInvalid);
      const paymentRowsSection = `<section><h3>Исходные оплаты</h3><p class="muted">Оплата продажи остаётся в своей истории. Здесь фиксируется отдельная выплата возврата.</p>${rows || '<div class="empty">Нет доступных оплат наличными, картой или QR.</div>'}</section>`;
      const quantityMilli=(value)=>{const raw=String(value??'').trim();if(!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(raw))return null;const [whole,fraction='']=raw.split('.');return BigInt(whole)*1000n+BigInt((fraction+'000').slice(0,3));};
      const quantityText=(milli)=>`${milli/1000n}${milli%1000n?`.${String(milli%1000n).padStart(3,'0').replace(/0+$/,'')}`:''}`;
      const itemRows=returnableItems.map((item)=>{
        const saved=pendingIntent?.payload?.items?.find((entry)=>entry.orderItemId===item.orderItemId);
        const soldMilli=quantityMilli(item.soldQuantity)||0n;const returnedMilli=quantityMilli(item.returnedQuantity)||0n;const availableMilli=soldMilli-returnedMilli;
        const showControl=canCreateOrderRefunds&&refundFormAvailable&&refundData.lineSnapshotStatus==='complete'&&(availableMilli>0n||Boolean(saved));
        const savedMilli=saved?quantityMilli(saved.quantity)||0n:0n;const maxMilli=availableMilli>savedMilli?availableMilli:savedMilli;
        return `<div class="order-refund-payment order-refund-item"><div><b>${esc(item.productFacts?.productName||'Позиция заказа')}</b><small>Продано: ${quantityText(soldMilli)} · стоимость после скидки: ${money(Number(item.netMinor||0)/100)}</small><small>Уже возвращено: ${quantityText(returnedMilli)} · осталось: ${quantityText(availableMilli)} · стоимость ранее возвращённого: ${money(Number(item.returnedItemValueMinor||0)/100)}</small></div>${showControl?`<label>Количество к возврату<input type="number" min="0" max="${quantityText(maxMilli)}" step="0.001" value="${esc(saved?.quantity||'0')}" data-refund-item="${esc(item.orderItemId)}" data-refund-quantity-available="${quantityText(maxMilli)}" data-refund-sold-milli="${soldMilli}" data-refund-returned-milli="${returnedMilli}" data-refund-net-minor="${Number(item.netMinor||0)}" data-refund-returned-value-minor="${Number(item.returnedItemValueMinor||0)}"></label>`:''}</div>`;
      }).join('');
      const itemRowsSection=refundData.lineSnapshotStatus==='complete'?`<section><h3>Возвращаемые позиции</h3><p class="muted">Стоимость рассчитывается по сохранённой цене после скидки и отдельно от денежной выплаты.</p>${itemRows||'<div class="empty">Нет строк заказа, доступных для товарного возврата.</div>'}${refundFormAvailable?'<label class="order-refund-no-items"><input type="checkbox" name="noItemReturn"> Возврата товара по этой выплате нет</label>':''}<p class="muted" data-refund-item-total>Стоимость возвращаемых позиций: 0,00 ₽</p></section>`:`<section><h3>Возвращаемые позиции</h3><p class="notice warning">Снимок строк продажи отсутствует. Выплата сохранится без распределения по товарам.</p></section>`;
      content.innerHTML = `${refundFormAvailable ? '' : paymentRowsSection}${canCreateOrderRefunds && order.status !== 'closed' && !pendingIntent ? '<p class="notice warning">Возврат доступен только для закрытого заказа.</p>' : ''}${refundFormAvailable ? `<form data-order-refund-form>${paymentRowsSection}${itemRowsSection}<label>Причина возврата<textarea name="reason" maxlength="500" required></textarea></label><p class="muted" data-refund-total>Сумма выплаты: 0,00 ₽</p><button class="button danger" type="submit" disabled>Оформить возврат</button><span class="form-message" role="status" aria-live="polite"></span></form>` : `${paymentRowsSection}${itemRowsSection}`}<section><h3>История выплат по возвратам</h3>${coverageWarning}<div class="order-refund-history">${history}</div></section>`;
      const form = content.querySelector('[data-order-refund-form]');
      if (form) {
        const storageKey = `crm:pending-order-refund:${order.id}`;
        if (pendingIntentInvalid || pendingIntent && (!pendingIntent.payload || pendingIntent.fingerprint !== JSON.stringify({ orderId: order.id, ...pendingIntent.payload }))) {
          const warning = document.createElement('p'); warning.className = 'notice warning'; warning.textContent = 'Есть незавершённый запрос возврата без сохранённых исходных данных. Новый возврат заблокирован; обратитесь к администратору и сверьте журнал возвратов.'; form.before(warning); form.remove();
        } else if (pendingIntent) {
          const intentNotice = document.createElement('p'); intentNotice.className = 'notice warning'; intentNotice.textContent = 'Предыдущий запрос мог быть проведён, но ответ не был получен. Повторите его с исходными данными; новый возврат до подтверждения заблокирован.'; form.before(intentNotice);
          const reasonField = form.querySelector('[name="reason"]'); reasonField.value = pendingIntent.payload.reason;
          for (const allocation of pendingIntent.payload.allocations || []) {
            const amountField = [...form.querySelectorAll('[data-refund-source]')].find((field) => field.dataset.refundSource === allocation.sourcePaymentId);
            const payoutField = form.querySelector(`[data-refund-payout="${CSS.escape(allocation.sourcePaymentId)}"]`);
            if (amountField) amountField.value = allocation.amount;
            if (payoutField) payoutField.value = allocation.payoutMethod;
          }
          for(const item of pendingIntent.payload.items||[]){const field=[...form.querySelectorAll('[data-refund-item]')].find((input)=>input.dataset.refundItem===item.orderItemId);if(field)field.value=item.quantity;}
          const noItemField=form.querySelector('[name="noItemReturn"]');if(noItemField)noItemField.checked=pendingIntent.payload.noItemReturn===true;
          form.querySelectorAll('input,select,textarea').forEach((field) => { field.readOnly = true; field.disabled = true; });
          form.dataset.pendingRefundLocked = 'true';
        }
        const updateTotal = () => {
          let cents = 0;
          for (const input of form.querySelectorAll('[data-refund-source]')) {
            const raw = input.value.trim();
            if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw)) continue;
            const [whole, fraction = ''] = raw.split('.');
            const value = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
            const max = Math.round(Number(input.dataset.refundAvailable) * 100);
            if (Number.isSafeInteger(value) && value >= 0 && value <= max) cents += value;
          }
          const totalNode = form.querySelector('[data-refund-total]');
          totalNode.textContent = `Сумма выплаты: ${money(pendingIntent?.payload?.amount ?? cents / 100)}`;
          let itemValueMinor=0n;
          for(const input of form.querySelectorAll('[data-refund-item]')){const eventMilli=quantityMilli(input.value);if(eventMilli===null||eventMilli<=0n)continue;const soldMilli=BigInt(input.dataset.refundSoldMilli||'0');const previousMilli=BigInt(input.dataset.refundReturnedMilli||'0');if(eventMilli+previousMilli>soldMilli)continue;const net=BigInt(input.dataset.refundNetMinor||'0');const previousValue=BigInt(input.dataset.refundReturnedValueMinor||'0');itemValueMinor+=(2n*net*(previousMilli+eventMilli)+soldMilli)/(2n*soldMilli)-previousValue;}
          const itemTotalNode=form.querySelector('[data-refund-item-total]');if(itemTotalNode)itemTotalNode.textContent=`Стоимость возвращаемых позиций: ${money(Number(itemValueMinor)/100)}`;
          form.querySelector('[type="submit"]').disabled = pendingIntent?.payload ? false : cents <= 0 || !form.querySelector('textarea[name="reason"]').value.trim();
        };
        const noItemField=form.querySelector('[name="noItemReturn"]');
        noItemField?.addEventListener('change',()=>{for(const field of form.querySelectorAll('[data-refund-item]')){field.disabled=noItemField.checked;if(noItemField.checked)field.value='0';}updateTotal();});
        form.addEventListener('input', updateTotal);
        form.addEventListener('change', updateTotal);
        updateTotal();
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          if (!canCreateOrderRefunds || activeRefundOrder?.id !== order.id) return;
          let invalidAllocation = false;
          const allocations = [...form.querySelectorAll('[data-refund-source]')].flatMap((input) => {
            const raw = input.value.trim();
            if (!raw || Number(raw) === 0) return [];
            if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw) || Number(raw) < 0 || Number(raw) > Number(input.dataset.refundAvailable)) { invalidAllocation = true; return []; }
            const [whole, fraction = ''] = raw.split('.');
            const amountCents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
            if (!Number.isSafeInteger(amountCents) || amountCents <= 0) { invalidAllocation = true; return []; }
            return [{ sourcePaymentId: input.dataset.refundSource, amount: (amountCents / 100).toFixed(2), payoutMethod: form.querySelector(`[data-refund-payout="${CSS.escape(input.dataset.refundSource)}"]`)?.value || 'cash' }];
          });
          if (!pendingIntent && invalidAllocation) { form.querySelector('.form-message').textContent = 'Введите сумму с точностью до копеек, не больше доступного остатка оплаты.'; updateTotal(); return; }
          let invalidItemReturn=false;
          const itemReturns=[...form.querySelectorAll('[data-refund-item]')].flatMap((input)=>{
            const raw=input.value.trim();if(!raw||Number(raw)===0)return[];
            const milli=quantityMilli(raw);const max=quantityMilli(input.dataset.refundQuantityAvailable);
            if(milli===null||max===null||milli>max){invalidItemReturn=true;return[];}
            return[{orderItemId:input.dataset.refundItem,quantity:quantityText(milli)}];
          });
          const noItemReturn=noItemField?.checked===true;
          if(!pendingIntent&&(invalidItemReturn||noItemReturn&&itemReturns.length)){form.querySelector('.form-message').textContent='Укажите количество до трёх знаков после запятой, не превышающее доступный остаток позиции.';updateTotal();return;}
          const cents = allocations.reduce((sum, allocation) => sum + Math.round(Number(allocation.amount) * 100), 0);
          const reason = form.querySelector('[name="reason"]').value.trim();
          if (!pendingIntent && (!allocations.length || !cents || !reason)) { updateTotal(); return; }
          const payload = pendingIntent?.payload || { amount: (cents / 100).toFixed(2), reason, allocations, items:itemReturns, noItemReturn };
          const canonical = JSON.stringify({ orderId: order.id, ...payload });
          let intent = pendingIntent;
          if (!intent) intent = { fingerprint: canonical, idempotencyKey: crypto.randomUUID(), payload };
          else if (intent.fingerprint !== canonical) { form.querySelector('.form-message').textContent = 'Есть незавершённый возврат. Повторите исходный запрос с прежним ключом.'; return; }
          try {
            if (!pendingIntent) {
              localStorage.setItem(storageKey, JSON.stringify(intent));
              if (JSON.parse(localStorage.getItem(storageKey) || 'null')?.idempotencyKey !== intent.idempotencyKey) throw new Error('persistence_failed');
              pendingIntent = intent;
              const intentNotice = document.createElement('p'); intentNotice.className = 'notice warning'; intentNotice.textContent = 'Запрос сохранён для безопасного повтора. До получения ответа поля возврата заблокированы.'; form.before(intentNotice);
              form.querySelectorAll('input,select,textarea').forEach((field) => { field.readOnly = true; field.disabled = true; });
              form.dataset.pendingRefundLocked = 'true';
            } else if (JSON.parse(localStorage.getItem(storageKey) || 'null')?.idempotencyKey !== intent.idempotencyKey) throw new Error('pending_intent_changed');
          } catch {
            portalNotice('Не удалось сохранить ключ возврата. Запрос не отправлен.', 'error');
            return;
          }
          const submit = form.querySelector('[type="submit"]');
          submit.disabled = true; submit.textContent = 'Сохраняем…';
          try {
            const result = await api(`/api/finance/orders/${encodeURIComponent(order.id)}/refunds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, idempotencyKey: intent.idempotencyKey }) });
            try { localStorage.removeItem(storageKey); } catch { try { localStorage.setItem(storageKey, JSON.stringify({ completed: true })); } catch {} }
            portalNotice(result.idempotentReplay ? 'Этот возврат уже был проведён. История обновлена.' : 'Возврат записан отдельной выплатой.', 'success');
            await renderRefundOrder(order);
          } catch (error) {
            submit.disabled = false; submit.textContent = 'Оформить возврат';
            const message = form.querySelector('.form-message');
            message.textContent = refundErrorMessage(error);
            const errorCode = error?.payload?.error;
            const definitivePreInsert = ['refund_exceeds_payment_balance', 'refund_source_payment_unavailable', 'refund_item_snapshot_unavailable', 'refund_item_source_unavailable', 'refund_item_quantity_exceeds_remaining', 'order_must_be_closed', 'order_not_found', 'open_shift_required', 'invalid_order_refund', 'invalid_order_id', 'authentication_required', 'forbidden'].includes(errorCode);
            if (definitivePreInsert) {
              try {
                localStorage.removeItem(storageKey);
                if (localStorage.getItem(storageKey) !== null) throw new Error('pending_intent_clear_failed');
                pendingIntent = null;
                await renderRefundOrder(order);
                if (errorCode === 'open_shift_required') portalNotice(refundErrorMessage(error), 'error');
              } catch {
                message.textContent = 'Сервер отклонил возврат до записи, но не удалось очистить сохранённое намерение. Не меняйте данные и обратитесь к администратору.';
              }
            }
          }
        });
      }
    } catch (error) {
      if (generation !== activeRefundGeneration || !refundDialog.open) return;
      content.innerHTML = `<div class="empty">${esc(refundErrorMessage(error))} <button type="button" class="button small" data-refund-retry>Повторить</button></div>`;
      content.querySelector('[data-refund-retry]')?.addEventListener('click', () => renderRefundOrder(order));
    }
  };
  const total = (order) => {
    const subtotal = (order.items || []).reduce((sum, item) => sum + Number(item.unitPrice ?? item.price ?? 0) * Number(item.quantity ?? 1), 0);
    // Active orders have payment totals, not a finalized bill. Match the POS item sum.
    return ['open', 'in_progress', 'ready'].includes(order.status) ? subtotal : Number(order.finalTotal ?? order.total ?? subtotal);
  };
  const displayOrderId = (id) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(id || '')) ? String(id).slice(-8).toUpperCase() : String(id || '—');
  const draw = () => { const query = document.querySelector('#orders-search').value.trim().toLowerCase(); const selectedDate = document.querySelector('#orders-date')?.value || ''; const status = document.querySelector('#orders-status').value; const sort = document.querySelector('#orders-sort')?.value || 'newest'; const filtered = items.filter((order) => { const orderDate = order.createdAt ? new Date(order.createdAt).toISOString().slice(0, 10) : ''; return (!status || order.status === status) && (!selectedDate || orderDate === selectedDate) && (!query || `${order.id} ${displayOrderId(order.id)} ${order.tableId || ''} ${order.tableName || ''} ${order.guestName || ''}`.toLowerCase().includes(query)); }); const priority = { open: 0, in_progress: 1, ready: 2, closed: 3, cancelled: 4 }; const attentionLabels = { order_open: 'Заказ открыт', order_in_progress: 'Заказ готовится', order_ready: 'Готов к выдаче', payment_due: 'Остаток оплаты' }; const attentionCount = (order) => Array.isArray(order.attentionReasons) ? order.attentionReasons.length : 0; const sorted = [...filtered].sort((a, b) => sort === 'amount' ? total(b) - total(a) : sort === 'newest' ? new Date(b.createdAt || 0) - new Date(a.createdAt || 0) : Number(attentionCount(b) > 0) - Number(attentionCount(a) > 0) || (priority[a.status] ?? 9) - (priority[b.status] ?? 9) || new Date(b.createdAt || 0) - new Date(a.createdAt || 0)); const rows = document.querySelector('#orders-rows'); rows.innerHTML = sorted.length ? sorted.map((order) => { const statusLabels = { open: 'Открыт', in_progress: 'Готовится', ready: 'Готов', closed: 'Закрыт', cancelled: 'Отменён' }; const attentionText = (Array.isArray(order.attentionReasons) ? order.attentionReasons : []).map((code) => attentionLabels[code]).filter(Boolean); const attentionNote = attentionText.length ? `<small class="muted order-attention-note">Требует внимания: ${esc(attentionText.join(' · '))}</small>` : ''; const canLoadPaymentSources = portalPermissions.has('orders') && (!order.reservationId || portalPermissions.has('reservations')); return `<tr data-order-id="${esc(order.id)}"><td><b>№ ${esc(displayOrderId(order.id))}</b>${attentionNote}</td><td>${esc(order.tableName || (order.tableId ? 'Стол не найден' : 'Без стола'))}</td><td>${esc(order.guestName || 'Без профиля')}</td><td><span class="badge ${order.status === 'closed' ? 'success' : order.status === 'cancelled' ? 'danger' : 'warning'}">${statusLabels[order.status] || order.status}</span></td><td><strong>${money(total(order))}</strong>${Number(order.minimumOrderTotal || 0) ? `<small class="muted">депозит ${money(order.minimumOrderTotal)}</small>` : ''}</td><td>${order.createdAt ? formatRuDate(order.createdAt, true) : '—'}</td><td>${canReadOrderRefunds && canLoadPaymentSources ? `<button type="button" class="button small" data-order-refunds="${esc(order.id)}">Возвраты</button> ` : ''}<a class="button small" href="/?order=${encodeURIComponent(order.id)}">Открыть</a></td></tr>`; }).join('') : '<tr><td colspan="7" class="empty">По выбранным условиям заказов нет</td></tr>'; rows.querySelectorAll(':scope > tr').forEach((row) => { if (row.querySelector('.empty')) return; ['Заказ', 'Стол', 'Гость', 'Статус', 'Сумма', 'Создано', 'Действие'].forEach((label, index) => { if (row.cells[index]) row.cells[index].dataset.label = label; }); }); document.querySelector('#orders-count').textContent = items.length; document.querySelector('#orders-open').textContent = items.filter((order) => !['closed', 'cancelled'].includes(order.status)).length; document.querySelector('#orders-revenue').textContent = money(items.filter((order) => order.status === 'closed').reduce((sum, order) => sum + total(order), 0)); };
  const load = () => api('/api/orders?scope=all').then((data) => { items = data.items || []; draw(); }).catch(() => { document.querySelector('#orders-rows').innerHTML = '<tr><td colspan="7" class="empty">Не удалось загрузить заказы</td></tr>'; portalNotice('Не удалось загрузить заказы', 'error'); });
  document.querySelector('#orders-rows').addEventListener('click', (event) => { const button = event.target.closest('[data-order-refunds]'); if (!button || !canReadOrderRefunds) return; const order = items.find((entry) => entry.id === button.dataset.orderRefunds); if (order) renderRefundOrder(order); });
  document.querySelector('#orders-search').addEventListener('input', draw); document.querySelector('#orders-date')?.addEventListener('change', draw); document.querySelector('#orders-status').addEventListener('change', draw); document.querySelector('#orders-sort').addEventListener('change', draw); load();
}

function renderTasks() {
  const target = document.querySelector('#page-content'); if (!target) return;
  const canManageTasks = portalPermissions.has('tasks_manage') || portalPermissions.has('staff_manage');
  target.innerHTML = `<div class="page-title"><div><p class="eyebrow">ОПЕРАЦИИ</p><h1>Задачи</h1><p class="muted">${canManageTasks ? 'Поручения команды с ответственным, сроком и отметкой выполнения.' : 'Ваши поручения с приоритетом и сроком выполнения.'}</p></div>${canManageTasks ? '<button class="button primary" id="task-new" type="button">+ Новая задача</button>' : ''}</div><section class="panel wide"><div class="toolbar-row tasks-filter-bar"><select id="task-status-filter" aria-label="Статус"><option value="">Все задачи</option><option value="open">Открытые</option><option value="in_progress">В работе</option><option value="done">Выполненные</option><option value="cancelled">Отменённые</option></select><select id="task-priority-filter" aria-label="Приоритет"><option value="">Все приоритеты</option><option value="urgent">Срочные</option><option value="high">Высокие</option><option value="normal">Обычные</option><option value="low">Низкие</option></select></div><div id="tasks-list" class="tasks-board"><section class="tasks-column" data-task-column="open"><h3>Открытые</h3><div class="tasks-column-list"><div class="empty">Загрузка…</div></div></section><section class="tasks-column" data-task-column="in_progress"><h3>В работе</h3><div class="tasks-column-list"><div class="empty">Загрузка…</div></div></section><section class="tasks-column" data-task-column="done"><h3>Выполнено</h3><div class="tasks-column-list"><div class="empty">Загрузка…</div></div></section><section class="tasks-column" data-task-column="cancelled"><h3>Отменено</h3><div class="tasks-column-list"><div class="empty">Загрузка…</div></div></section></div></section>`;
  const list = document.querySelector('#tasks-list'); let items = [];
  let loadGeneration = 0;
  const pendingTaskIds = new Set();
  const taskLoadStatus = document.createElement('div');
  taskLoadStatus.setAttribute('role', 'status');
  list.before(taskLoadStatus);
  const focusTaskStatus = (taskId) => {
    if (!list.isConnected) return;
    const select = [...list.querySelectorAll('[data-task-status]')].find(node => node.dataset.taskStatus === taskId);
    if (select) { enhancePortalSelect(select); select.closest('.custom-select')?.querySelector('.custom-select-trigger')?.focus(); }
    else document.querySelector('#task-status-filter')?.closest('.custom-select')?.querySelector('.custom-select-trigger')?.focus();
  };
  const draw = () => { const status = document.querySelector('#task-status-filter').value; const priority = document.querySelector('#task-priority-filter').value; const visible = items.filter((task) => (!status || task.status === status) && (!priority || task.priority === priority)); const labels = { urgent: 'Срочно', high: 'Высокий', low: 'Низкий', normal: 'Обычный' }; list.querySelectorAll('[data-task-column]').forEach((column) => { const columnItems = visible.filter((task) => task.status === column.dataset.taskColumn); const body = column.querySelector('.tasks-column-list'); body.innerHTML = columnItems.length ? columnItems.map((task) => `<article class="task-card"><b>${esc(task.title)}</b><small>${esc(task.description || 'Без описания')}</small>${task.assigneeName ? `<small>Ответственный: ${esc(displayName(task.assigneeName))}</small>` : ''}<small>${task.dueDate ? `до ${formatRuDate(task.dueDate)}` : task.dueAt ? `до ${formatRuDate(task.dueAt, true)}` : 'Без срока'}</small><div class="toolbar-row"><span class="badge ${task.priority === 'urgent' ? 'danger' : task.priority === 'high' ? 'warning' : 'info'}">${labels[task.priority] || labels.normal}</span><select data-task-status="${esc(task.id)}" data-current-status="${esc(task.status)}" aria-label="Изменить статус задачи: ${esc(task.title)}"><option value="open" ${task.status === 'open' ? 'selected' : ''}>Открыта</option><option value="in_progress" ${task.status === 'in_progress' ? 'selected' : ''}>В работе</option><option value="done" ${task.status === 'done' ? 'selected' : ''}>Выполнена</option><option value="cancelled" ${task.status === 'cancelled' ? 'selected' : ''}>Отменена</option></select></div>${canManageTasks ? `<div class="toolbar-row task-card-actions"><button type="button" class="button small" data-task-edit="${esc(task.id)}">Изменить</button><button type="button" class="button small danger-outline" data-task-delete="${esc(task.id)}">Удалить</button></div>` : ''}</article>`).join('') : '<div class="empty">Нет задач</div>'; }); list.querySelectorAll('[data-task-status]').forEach((select) => {
      select.disabled = pendingTaskIds.has(select.dataset.taskStatus);
      select.addEventListener('change', async () => {
        const taskId = select.dataset.taskStatus;
        if (pendingTaskIds.has(taskId)) return;
        const previousStatus = select.dataset.currentStatus || 'open';
        const nextStatus = select.value;
        pendingTaskIds.add(taskId); select.disabled = true; select._customSelectRefresh?.();
        try {
          await api('/api/tasks/' + encodeURIComponent(taskId), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: nextStatus }) });
          // Keep the confirmed status if the subsequent read fails.
          items = items.map(task => task.id === taskId ? { ...task, status: nextStatus } : task);
          await load();
        } catch (_) {
          if (select.isConnected) select.value = previousStatus;
          portalNotice('Не удалось изменить задачу', 'error');
        } finally {
          pendingTaskIds.delete(taskId);
          if (list.isConnected) { draw(); focusTaskStatus(taskId); }
        }
      });
    }); };

  const load = async () => {
    const generation = ++loadGeneration;
    taskLoadStatus.textContent = 'Загрузка задач…';
    try {
      const data = await api('/api/tasks');
      if (generation !== loadGeneration || !list.isConnected) return;
      items = data.items || []; taskLoadStatus.textContent = ''; draw();
    } catch (_) {
      if (generation !== loadGeneration || !list.isConnected) return;
      taskLoadStatus.innerHTML = '<span>Не удалось обновить задачи. </span><button class="button small" type="button">Повторить</button>';
      taskLoadStatus.querySelector('button').addEventListener('click', load);
      draw();
    }
  };
  document.querySelector('#task-status-filter').addEventListener('change', draw); document.querySelector('#task-priority-filter').addEventListener('change', draw);
  if (canManageTasks) list.addEventListener('click', async (event) => {
    const editButton = event.target.closest('[data-task-edit]');
    const deleteButton = event.target.closest('[data-task-delete]');
    const task = items.find((entry) => String(entry.id) === String(editButton?.dataset.taskEdit || deleteButton?.dataset.taskDelete));
    if (!task) return;
    if (deleteButton) {
      if (!await portalConfirm('Удалить задачу?', 'Задача будет удалена из списка и журнала задач.', 'Удалить')) return;
      deleteButton.disabled = true;
      try { await api('/api/tasks/' + encodeURIComponent(task.id), { method: 'DELETE' }); portalNotice('Задача удалена', 'success'); await load(); }
      catch (_) { deleteButton.disabled = false; portalNotice('Не удалось удалить задачу', 'error'); }
      return;
    }
    if (editButton) {
      let staffItems = [];
      try { staffItems = (await api('/api/staff')).items || []; } catch (_) { portalNotice('Не удалось загрузить список сотрудников', 'error'); return; }
      const assignees = staffItems.filter((person) => person.active !== false);
      const values = await portalAction({ title: 'Изменить задачу', description: 'Обновите поручение, ответственного, приоритет или срок.', submitLabel: 'Сохранить изменения', fields: [{ name: 'title', label: 'Название', value: task.title }, { name: 'description', label: 'Описание', type: 'textarea', required: false, value: task.description || '' }, { name: 'assigneeId', label: 'Ответственный сотрудник', type: 'select', value: task.assigneeId || '', options: [{ value: '', label: 'Без ответственного' }, ...assignees.map((person) => ({ value: person.id, label: `${displayName(person.name)} · ${portalRoleLabels[person.role]?.[0] || person.role}` }))] }, { name: 'priority', label: 'Приоритет', type: 'select', value: task.priority || 'normal', options: [{ value: 'normal', label: 'Обычный' }, { value: 'high', label: 'Высокий' }, { value: 'urgent', label: 'Срочный' }, { value: 'low', label: 'Низкий' }] }, { name: 'status', label: 'Статус', type: 'select', value: task.status || 'open', options: [{ value: 'open', label: 'Открыта' }, { value: 'in_progress', label: 'В работе' }, { value: 'done', label: 'Выполнена' }, { value: 'cancelled', label: 'Отменена' }] }, { name: 'dueDate', label: 'Выполнить до', type: 'date', required: false, value: task.dueDate || '' }] });
      if (!values?.title?.trim()) return;
      editButton.disabled = true;
      try { await api('/api/tasks/' + encodeURIComponent(task.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) }); portalNotice('Задача изменена', 'success'); await load(); }
      catch (error) { editButton.disabled = false; portalNotice(error.payload?.error === 'task_assignee_not_found' ? 'Выберите действующего сотрудника' : 'Не удалось изменить задачу', 'error'); }
    }
  });
  if (canManageTasks) document.querySelector('#task-new').addEventListener('click', async () => {
    let staffItems;
    try { staffItems = (await api('/api/staff')).items || []; } catch (_) { portalNotice('Не удалось загрузить список сотрудников', 'error'); return; }
    const assignees = staffItems.filter((person) => person.active !== false);
    if (!assignees.length) { portalNotice('Сначала добавьте сотрудника, которому назначить задачу', 'error'); return; }
    const values = await portalAction({ title: 'Новая задача', description: 'Назначьте поручение сотруднику и укажите срок.', submitLabel: 'Создать задачу', fields: [{ name: 'title', label: 'Название' }, { name: 'description', label: 'Описание', type: 'textarea', required: false }, { name: 'assigneeId', label: 'Ответственный сотрудник', type: 'select', options: [{ value: '', label: 'Выберите сотрудника' }, ...assignees.map((person) => ({ value: person.id, label: `${displayName(person.name)} · ${portalRoleLabels[person.role]?.[0] || person.role}` }))] }, { name: 'priority', label: 'Приоритет', type: 'select', value: 'normal', options: [{ value: 'normal', label: 'Обычный' }, { value: 'high', label: 'Высокий' }, { value: 'urgent', label: 'Срочный' }, { value: 'low', label: 'Низкий' }] }, { name: 'dueDate', label: 'Выполнить до', type: 'date', value: localDateKey() }] });
    if (!values?.title?.trim()) return;
    api('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) }).then(() => { portalNotice('Задача назначена сотруднику', 'success'); load(); }).catch((error) => portalNotice(error.payload?.error === 'task_assignee_required' ? 'Выберите ответственного сотрудника' : 'Не удалось создать задачу', 'error'));
  });
  load();
}

function renderLoyalty() {
  const target = document.querySelector('#page-content'); if (!target) return;
  target.innerHTML = `<div class="page-title"><div><p class="eyebrow">УПРАВЛЕНИЕ ГОСТЯМИ</p><h1>Система лояльности</h1><p class="muted">Программы скидок, бонусов и депозитов. Персонал применяет готовые правила, а изменения доступны руководителям.</p></div><a class="button" href="/clients">Открыть гостей</a></div><div class="client-insights loyalty-summary"><article><span>Активные программы</span><strong id="loyalty-groups-count">—</strong><small>Доступны персоналу</small></article><article><span>Максимальная скидка</span><strong id="loyalty-max-discount">—</strong><small>В активной программе</small></article><article><span>Начисление бонусов</span><strong id="loyalty-bonus-rate">—</strong><small>Процент от оплаченного заказа</small></article></div><div class="content-grid"><section class="panel wide"><div class="panel-head"><div><h2>Программы лояльности</h2><span class="muted">Назначаются в карточке гостя</span></div><div class="toolbar-row"><label class="inline-filter">Показывать<select id="loyalty-program-filter"><option value="active">Активные</option><option value="all">Включая архивные</option></select></label><button class="button primary" type="button" id="loyalty-new">Новая программа</button></div></div><div class="loyalty-program-list" id="loyalty-program-list"><div class="empty">Загрузка…</div></div></section><section class="panel"><div class="panel-head"><h2 id="loyalty-editor-title">Новая программа</h2><button class="button small" id="loyalty-clear" type="button">Очистить</button></div><form class="stack-form" id="loyalty-form-visible"><input type="hidden" id="loyalty-id"><label>Название программы<input id="loyalty-name" required maxlength="80" placeholder="Например, VIP-вечер"></label><div class="form-row"><label>Скидка, %<input id="loyalty-discount" type="number" min="0" max="100" step="1" value="0"></label><label>Бонусы, %<input id="loyalty-bonus" type="number" min="0" max="100" step="1" value="0"></label></div><label>Минимальный депозит, ₽<input id="loyalty-deposit" type="number" min="0" step="100" value="0"></label><p class="muted">Бонусы начисляются после оплаты заказа. Депозит показывает минимальную сумму для бронирования по программе.</p><button class="button primary" type="submit">Сохранить программу</button><p class="form-message" id="loyalty-message"></p></form></section></div>`;
  const canManageLoyaltySettings = ['owner', 'admin'].includes(portalUser?.role);
  target.insertAdjacentHTML('beforeend', `<section class="panel loyalty-policy-settings" aria-labelledby="loyalty-settings-title"><div class="panel-head"><div><h2 id="loyalty-settings-title">Общие правила списания бонусов</h2><span class="muted" id="loyalty-settings-version">Загрузка настроек…</span></div></div><form class="stack-form" id="loyalty-settings-form"><div class="form-row"><label>Стоимость 1 бонуса, ₽<input id="loyalty-settings-rate" type="number" min="0.0001" max="100" step="0.0001" required></label><label>Максимум оплаты бонусами, % чека<input id="loyalty-settings-cap" type="number" min="0" max="100" step="1" required></label></div><label>Минимум одной операции списания, бонусов<input id="loyalty-settings-minimum" type="number" min="1" max="1000000" step="1" required></label><p class="muted">Совместимые начальные значения: 1 бонус = 1 ₽, лимит 100% остатка и минимум 1 балл за операцию. Курс пока фиксирован: кассовый тендер хранит сумму в рублях и не поддерживает безопасный пересчёт изменяемого курса. Рыночный ориентир для обсуждения — около 20%, но он сам не включается. Истечение бонусов пока выключено: журнал ещё не хранит отдельные начисления по срокам.</p><button class="button primary" type="submit" ${canManageLoyaltySettings ? '' : 'hidden'}>Сохранить новую версию правил</button><p class="form-message" id="loyalty-settings-message" role="status"></p></form></section>`);
  const loyaltySettingsForm = document.querySelector('#loyalty-settings-form');
  let loyaltySettings = null;
  const loadLoyaltySettings = async () => {
    const versionLabel = document.querySelector('#loyalty-settings-version');
    try {
      const policy = await api('/api/loyalty/settings'); loyaltySettings = policy;
      document.querySelector('#loyalty-settings-rate').value = policy.bonusRublesPerPoint;
      document.querySelector('#loyalty-settings-cap').value = policy.maxRedemptionPercent;
      document.querySelector('#loyalty-settings-minimum').value = policy.minimumRedemptionPoints;
      for (const control of loyaltySettingsForm.querySelectorAll('input')) control.disabled = !canManageLoyaltySettings || control.id === 'loyalty-settings-rate';
      document.querySelector('#loyalty-settings-rate').title = 'Фиксированный курс до отдельной поддержки балльного тендера';
      versionLabel.textContent = `Версия ${policy.version} · ${policy.source === 'legacy_default' ? 'совместимые настройки' : 'сохранено'}${policy.effectiveAt ? ` · ${formatRuDate(policy.effectiveAt, true)}` : ''}`;
    } catch { versionLabel.textContent = 'Не удалось загрузить правила'; portalNotice('Не удалось загрузить правила списания бонусов', 'error'); }
  };
  loyaltySettingsForm.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!canManageLoyaltySettings || !loyaltySettings) return;
    const message = document.querySelector('#loyalty-settings-message'); const submit = loyaltySettingsForm.querySelector('button[type="submit"]'); submit.disabled = true; message.textContent = '';
    const expectedVersion = Number(loyaltySettings.version); const body = { expectedVenueId: loyaltySettings.venueId, expectedVersion, bonusRublesPerPoint: 1, maxRedemptionPercent: Number(document.querySelector('#loyalty-settings-cap').value), minimumRedemptionPoints: Number(document.querySelector('#loyalty-settings-minimum').value) };
    try { const saved = await api('/api/loyalty/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); loyaltySettings = saved; message.textContent = `Сохранена версия ${saved.version}; она действует для новых заказов`; message.className = 'form-message success-message'; await loadLoyaltySettings(); }
    catch (error) { message.textContent = error.payload?.error === 'loyalty_settings_version_conflict' ? 'Настройки уже изменили в другом окне. Обновите правила и повторите.' : error.payload?.error === 'venue_context_changed' ? 'Активное заведение изменилось. Перезагрузите экран.' : 'Не удалось сохранить правила'; message.className = 'form-message error-message'; }
    finally { submit.disabled = false; }
  });
  loadLoyaltySettings();
  target.insertAdjacentHTML('beforeend', `<section class="panel loyalty-promotions" aria-labelledby="loyalty-promotions-title"><div class="panel-head"><div><h2 id="loyalty-promotions-title">Акции</h2><span class="muted">Активные версии рассчитываются при оплате; уже оплаченные чеки сохраняют свою цену</span></div><button class="button primary" id="promotion-new" type="button" ${canManageLoyaltySettings ? '' : 'hidden'}>Новая акция</button></div><div id="promotion-list"><div class="empty">Загрузка акций…</div></div><form id="promotion-form" class="stack-form" hidden><h3 id="promotion-editor-title">Новая акция — черновик</h3><input id="promotion-id" type="hidden"><input id="promotion-version" type="hidden"><label>Название<input id="promotion-name" required maxlength="100"></label><label>Описание для сотрудников<textarea id="promotion-description" maxlength="500" rows="2"></textarea></label><div class="form-row"><label>Начало<input id="promotion-start" type="datetime-local" required></label><label>Окончание<input id="promotion-end" type="datetime-local" required></label></div><label>Часовой пояс заведения (IANA)<input id="promotion-timezone" required maxlength="80"></label><div class="form-row"><label>Выгода<select id="promotion-kind"><option value="percent">Скидка, %</option><option value="fixed">Скидка, ₽</option></select></label><label>Размер<input id="promotion-value" type="number" min="0.01" step="0.01" required></label><label>Приоритет<input id="promotion-priority" type="number" min="-100000" max="100000" step="1" value="0" required></label></div><label>Включённые товары<select id="promotion-products" multiple size="5"></select></label><label>Исключённые товары<select id="promotion-excluded-products" multiple size="5"></select></label><label>Включённые категории товаров (через запятую)<input id="promotion-categories" maxlength="500" placeholder="Например: Бар, Кухня"></label><label>Исключённые категории, если нужны<input id="promotion-excluded-categories" maxlength="500"></label><p class="muted">Укажите хотя бы один товар или категорию включения. Черновик можно активировать из списка акций; изменение условий создаёт новую неизменяемую версию.</p><div class="toolbar-row"><button class="button primary" type="submit">Сохранить черновик</button><button class="button" id="promotion-cancel" type="button">Отмена</button><span id="promotion-message" class="form-message" role="status"></span></div></form></section>`);
  const promotionList = document.querySelector('#promotion-list'); const promotionForm = document.querySelector('#promotion-form'); const canManagePromotions = canManageLoyaltySettings; let promotions = []; let promotionProducts = [];
  const promotionDateInput = (value, timezone) => { const date = value ? new Date(value) : new Date(); const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((part) => [part.type, part.value])); return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`; };
  const promotionLocalIso = (value, timezone) => {
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    if (!match) throw new Error('invalid_local_date');
    const [, year, month, day, hour, minute] = match;
    const targetDate = new Date(0);
    targetDate.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
    targetDate.setUTCHours(Number(hour), Number(minute), 0, 0);
    if (targetDate.getUTCFullYear() !== Number(year) || targetDate.getUTCMonth() !== Number(month) - 1 || targetDate.getUTCDate() !== Number(day) || targetDate.getUTCHours() !== Number(hour) || targetDate.getUTCMinutes() !== Number(minute)) throw new Error('invalid_local_date');
    const target = targetDate.getTime();
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const wallTimeAsUtc = (instant) => {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
      const represented = new Date(0);
      represented.setUTCFullYear(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
      represented.setUTCHours(Number(parts.hour), Number(parts.minute), Number(parts.second), 0);
      return represented.getTime();
    };
    const offsets = new Set();
    for (let hours = -48; hours <= 48; hours += 6) {
      const probe = target + hours * 60 * 60 * 1000;
      offsets.add(wallTimeAsUtc(probe) - probe);
    }
    const candidates = [...offsets].map((offset) => target - offset).filter((instant) => wallTimeAsUtc(instant) === target).sort((a, b) => a - b);
    if (candidates.length !== 1) throw new Error('invalid_local_date');
    const instant = new Date(candidates[0]);
    if (promotionDateInput(instant, timezone) !== value) throw new Error('invalid_local_date');
    return instant.toISOString();
  };
  const loadPromotions = async () => { try { const result = await api('/api/loyalty/promotions?includeArchived=true'); promotions = result.items || []; promotionList.innerHTML = promotions.map((promotion) => `<article class="loyalty-program${promotion.status === 'archived' ? ' is-archived' : ''}"><div><h3>${esc(promotion.name)} <small>v${Number(promotion.version)}</small></h3><small>${esc(promotion.description || 'Без описания')} · ${promotion.benefitKind === 'percent' ? `${Number(promotion.benefitValue)}%` : `${money(promotion.benefitValue)} ₽`} · категории: ${esc((promotion.includeCategories || []).join(', '))}</small><small>${formatRuDate(promotion.startsAt, true)} — ${formatRuDate(promotion.endsAt, true)} · ${esc(promotion.timezone)}</small></div><div class="toolbar-row"><span class="badge ${promotion.status === 'draft' ? 'warning' : promotion.status === 'active' ? 'success' : ''}">${promotion.status === 'draft' ? 'Черновик' : promotion.status === 'active' ? 'Активна' : 'Архив'}</span>${canManagePromotions && promotion.status === 'draft' ? `<button class="button small primary" type="button" data-promotion-activate="${esc(promotion.promotionId)}">Активировать</button>` : ''}${canManagePromotions && promotion.status !== 'archived' ? `<button class="button small" type="button" data-promotion-edit="${esc(promotion.promotionId)}">Новая версия</button><button class="button small danger-outline" type="button" data-promotion-archive="${esc(promotion.promotionId)}">Архивировать</button>` : ''}</div></article>`).join('') || '<div class="empty">Акций пока нет. Новая акция сначала сохраняется как черновик.</div>'; }
    catch { promotionList.innerHTML = '<div class="empty">Не удалось загрузить акции</div>'; } };
  let promotionVenueTimezone = '';
  let promotionProductsReady = false;
  const promotionNewButton = document.querySelector('#promotion-new');
  const updatePromotionNewAvailability = () => { promotionNewButton.disabled = !canManagePromotions || !promotionProductsReady || !promotionVenueTimezone; };
  const clearPromotionForm = () => { promotionForm.reset(); promotionForm.hidden = true; document.querySelector('#promotion-id').value = ''; document.querySelector('#promotion-version').value = ''; document.querySelector('#promotion-timezone').value = promotionVenueTimezone; const timezone = promotionVenueTimezone; document.querySelector('#promotion-start').value = timezone ? promotionDateInput(null, timezone) : ''; document.querySelector('#promotion-end').value = timezone ? promotionDateInput(Date.now() + 86400000, timezone) : ''; document.querySelector('#promotion-priority').value = '0'; document.querySelector('#promotion-editor-title').textContent = 'Новая акция — черновик'; };
  promotionNewButton.disabled = true;
  api('/api/venue').then((venue) => {
    const timezone = String(venue.timezone || '').trim();
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    promotionVenueTimezone = timezone;
    venueTimezone = timezone;
    if (promotionForm.hidden) clearPromotionForm();
  }).catch(() => {
    const message = document.querySelector('#promotion-message');
    message.textContent = 'Не удалось определить часовой пояс заведения. Обновите страницу и повторите.';
    message.className = 'form-message error-message';
  }).finally(updatePromotionNewAvailability);
  document.querySelector('#promotion-new').addEventListener('click', () => { clearPromotionForm(); promotionForm.hidden = false; promotionForm.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  document.querySelector('#promotion-cancel').addEventListener('click', clearPromotionForm);
  promotionList.addEventListener('click', async (event) => { const edit = event.target.closest('[data-promotion-edit]'); const archive = event.target.closest('[data-promotion-archive]'); const activate = event.target.closest('[data-promotion-activate]'); const promotion = promotions.find((item) => item.promotionId === (edit?.dataset.promotionEdit || archive?.dataset.promotionArchive || activate?.dataset.promotionActivate)); if (!promotion) return;
    if (edit) { clearPromotionForm(); promotionForm.hidden = false; document.querySelector('#promotion-id').value = promotion.promotionId; document.querySelector('#promotion-version').value = promotion.version; document.querySelector('#promotion-editor-title').textContent = `Новая версия акции · текущая v${promotion.version}`; document.querySelector('#promotion-name').value = promotion.name; document.querySelector('#promotion-description').value = promotion.description || ''; document.querySelector('#promotion-start').value = promotionDateInput(promotion.startsAt, promotion.timezone); document.querySelector('#promotion-end').value = promotionDateInput(promotion.endsAt, promotion.timezone); document.querySelector('#promotion-timezone').value = promotion.timezone; document.querySelector('#promotion-kind').value = promotion.benefitKind; document.querySelector('#promotion-value').value = promotion.benefitValue; document.querySelector('#promotion-priority').value = promotion.priority; document.querySelector('#promotion-categories').value = (promotion.includeCategories || []).join(', '); document.querySelector('#promotion-excluded-categories').value = (promotion.excludeCategories || []).join(', '); for (const select of [document.querySelector('#promotion-products'), document.querySelector('#promotion-excluded-products')]) { const ids = select.id.includes('excluded') ? promotion.excludeProductIds || [] : promotion.includeProductIds || []; const available = new Set([...select.options].map((option) => option.value)); for (const id of ids) if (!available.has(id)) { const option = document.createElement('option'); option.value = id; option.textContent = 'Недоступный товар · ' + id; select.append(option); } for (const option of select.options) option.selected = ids.includes(option.value); } promotionForm.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    if (activate && await portalConfirm('Активировать акцию?', 'Она начнёт участвовать в цене подходящих неоплаченных заказов. Уже принятые платежи сохранят зафиксированную цену.', 'Активировать')) { try { await api(`/api/loyalty/promotions/${encodeURIComponent(promotion.promotionId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVenueId: promotion.venueId || loyaltySettings?.venueId, expectedVersion: promotion.version, status: 'active' }) }); portalNotice('Акция активирована', 'success'); await loadPromotions(); } catch (error) { portalNotice(error.payload?.error === 'loyalty_promotion_version_conflict' ? 'Акцию уже изменили. Обновите список.' : 'Не удалось активировать акцию', 'error'); await loadPromotions(); } }
    if (archive && await portalConfirm('Архивировать акцию?', 'Будет сохранена новая версия; прежние версии останутся в истории.', 'Архивировать')) { try { await api(`/api/loyalty/promotions/${encodeURIComponent(promotion.promotionId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVenueId: promotion.venueId || loyaltySettings?.venueId, expectedVersion: promotion.version, status: 'archived' }) }); portalNotice('Акция архивирована', 'success'); await loadPromotions(); } catch { portalNotice('Не удалось архивировать акцию', 'error'); } }
  });
  promotionForm.addEventListener('submit', async (event) => { event.preventDefault(); if (!canManagePromotions) return; const id = document.querySelector('#promotion-id').value; const promotion = promotions.find((item) => item.promotionId === id); const categories = (value) => value.split(',').map((item) => item.trim()).filter(Boolean); const selected = (selector) => [...document.querySelector(selector).selectedOptions].map((option) => option.value); const message = document.querySelector('#promotion-message'); const submit = promotionForm.querySelector('[type="submit"]'); const timezone = document.querySelector('#promotion-timezone').value.trim(); let body; try { body = { expectedVenueId: loyaltySettings?.venueId || promotion?.venueId, name: document.querySelector('#promotion-name').value.trim(), description: document.querySelector('#promotion-description').value.trim(), startsAt: promotionLocalIso(document.querySelector('#promotion-start').value, timezone), endsAt: promotionLocalIso(document.querySelector('#promotion-end').value, timezone), timezone, benefitKind: document.querySelector('#promotion-kind').value, benefitValue: Number(document.querySelector('#promotion-value').value), priority: Number(document.querySelector('#promotion-priority').value), includeProductIds: selected('#promotion-products'), excludeProductIds: selected('#promotion-excluded-products'), includeCategories: categories(document.querySelector('#promotion-categories').value), excludeCategories: categories(document.querySelector('#promotion-excluded-categories').value), status: 'draft' }; } catch { message.textContent = 'Проверьте часовой пояс и корректность локального времени (например, переход на летнее время).'; message.className = 'form-message error-message'; return; } submit.disabled = true; message.textContent = '';
    try { const nextStatus = promotion?.status === 'active' ? 'active' : 'draft'; const saved = await api(id ? `/api/loyalty/promotions/${encodeURIComponent(id)}` : '/api/loyalty/promotions', { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(id ? { ...body, status: nextStatus, expectedVersion: Number(document.querySelector('#promotion-version').value) } : body) }); message.textContent = `Сохранена ${saved.status === 'active' ? 'активная' : 'черновая'} версия v${saved.version}`; message.className = 'form-message success-message'; await loadPromotions(); clearPromotionForm(); }
    catch (error) { message.textContent = error.payload?.error === 'loyalty_promotion_version_conflict' ? 'Акцию изменили в другом окне. Обновите список и повторите.' : error.payload?.error === 'loyalty_promotion_scope_invalid' ? 'Проверьте, что все категории есть в каталоге этого заведения.' : 'Не удалось сохранить акцию; проверьте период, часовой пояс и поля.'; message.className = 'form-message error-message'; } finally { submit.disabled = false; }
  });
  clearPromotionForm(); loadPromotions(); api('/api/products').then((data) => { promotionProducts = data.items || []; for (const select of [document.querySelector('#promotion-products'), document.querySelector('#promotion-excluded-products')]) select.innerHTML = promotionProducts.map((product) => `<option value="${esc(product.id)}">${esc(product.name)} · ${esc(product.category || product.station || '')}</option>`).join(''); }).catch(() => { document.querySelector('#promotion-products').disabled = true; document.querySelector('#promotion-excluded-products').disabled = true; if (canManagePromotions) portalNotice('Не удалось загрузить товары для акции; можно выбрать категорию', 'error'); }).finally(() => { promotionProductsReady = true; updatePromotionNewAvailability(); });
  let groups = [];
  const loyaltyForm = document.querySelector('#loyalty-form-visible');
  const loyaltySubmit = loyaltyForm.querySelector('button[type="submit"]');
  const setLoyaltyPending = (pending) => {
    loyaltyForm.dataset.submitting = pending ? '1' : '0';
    loyaltyForm.querySelectorAll('input, button').forEach((control) => { control.disabled = pending; });
    document.querySelector('#loyalty-new').disabled = pending;
    document.querySelector('#loyalty-clear').disabled = pending;
    document.querySelector('#loyalty-program-filter').disabled = pending;
    document.querySelectorAll('[data-loyalty-edit], [data-loyalty-toggle]').forEach((button) => { button.disabled = pending; });
    loyaltySubmit.textContent = pending ? 'Сохранение…' : 'Сохранить программу';
  };
  const clear = () => { document.querySelector('#loyalty-id').value = ''; document.querySelector('#loyalty-editor-title').textContent = 'Новая программа'; document.querySelector('#loyalty-form-visible').reset(); };
  const fill = (group) => { document.querySelector('#loyalty-id').value = group.id; document.querySelector('#loyalty-editor-title').textContent = `Изменить: ${group.name}`; document.querySelector('#loyalty-name').value = group.name; document.querySelector('#loyalty-discount').value = group.discountPercent; document.querySelector('#loyalty-bonus').value = group.bonusPercent; document.querySelector('#loyalty-deposit').value = group.depositMin; };
  const draw = () => {
    const list = document.querySelector('#loyalty-program-list'); const activeGroups = groups.filter((group) => group.active !== false);
    document.querySelector('#loyalty-groups-count').textContent = activeGroups.length;
    document.querySelector('#loyalty-max-discount').textContent = `${Math.max(0, ...activeGroups.map((group) => Number(group.discountPercent || 0)))}%`;
    document.querySelector('#loyalty-bonus-rate').textContent = `${Math.max(0, ...activeGroups.map((group) => Number(group.bonusPercent || 0)))}%`;
    list.innerHTML = groups.map((group) => `<article class="loyalty-program${group.active === false ? ' is-archived' : ''}"><div><h3>${esc(group.name)}</h3><small>${group.discountPercent}% скидка · ${group.bonusPercent}% бонусов${Number(group.depositMin || 0) ? ` · депозит от ${money(group.depositMin)}` : ''}</small></div><div class="toolbar-row"><span class="badge ${group.active === false ? 'warning' : 'success'}">${group.active === false ? 'В архиве' : 'Активна'}</span><button class="button small" type="button" data-loyalty-edit="${esc(group.id)}">Изменить</button><button class="button small ${group.active === false ? 'primary' : 'danger-outline'}" type="button" data-loyalty-toggle="${esc(group.id)}" data-active="${group.active === false ? 'false' : 'true'}">${group.active === false ? 'Восстановить' : 'Архивировать'}</button></div></article>`).join('') || '<div class="empty">Программ пока нет</div>';
    if (loyaltyForm.dataset.submitting === '1') list.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  };
  const load = () => { const query = document.querySelector('#loyalty-program-filter').value === 'all' ? '?includeArchived=true' : ''; return api(`/api/discount-groups${query}`).then((data) => { groups = data.items || []; draw(); }).catch(() => portalNotice('Не удалось загрузить программы лояльности', 'error')); };
  document.querySelector('#loyalty-program-filter').addEventListener('change', load);
  document.querySelector('#loyalty-clear').addEventListener('click', clear);
  document.querySelector('#loyalty-new').addEventListener('click', clear);
  document.querySelector('#loyalty-program-list').addEventListener('click', async (event) => {
    if (loyaltyForm.dataset.submitting === '1') return;
    const toggle = event.target.closest('[data-loyalty-toggle]');
    if (toggle) {
      const active = toggle.dataset.active === 'true'; const group = groups.find((item) => item.id === toggle.dataset.loyaltyToggle);
      if (!group || active && !await portalConfirm('Архивировать программу?', 'Она перестанет предлагаться при назначении гостю. Её можно будет восстановить из архива.', 'Архивировать')) return;
      if (loyaltyForm.dataset.submitting === '1') return;
      toggle.disabled = true;
      try { await api(`/api/discount-groups/${encodeURIComponent(group.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !active }) }); portalNotice(active ? 'Программа помещена в архив' : 'Программа восстановлена', 'success'); await load(); }
      catch { toggle.disabled = false; portalNotice('Не удалось изменить состояние программы', 'error'); }
      return;
    }
    const button = event.target.closest('[data-loyalty-edit]'); if (button) { const group = groups.find((item) => item.id === button.dataset.loyaltyEdit); if (group) fill(group); }
  });
  loyaltyForm.addEventListener('submit', async (event) => {
    event.preventDefault(); if (loyaltyForm.dataset.submitting === '1') return;
    const id = document.querySelector('#loyalty-id').value;
    const body = { name: document.querySelector('#loyalty-name').value.trim(), discountPercent: Number(document.querySelector('#loyalty-discount').value || 0), bonusPercent: Number(document.querySelector('#loyalty-bonus').value || 0), depositMin: Number(document.querySelector('#loyalty-deposit').value || 0) };
    const message = document.querySelector('#loyalty-message');
    message.textContent = '';
    setLoyaltyPending(true);
    try {
      await api(id ? `/api/discount-groups/${encodeURIComponent(id)}` : '/api/discount-groups', { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      clear();
      message.textContent = 'Программа сохранена';
      message.className = 'form-message success-message';
      portalNotice('Программа сохранена', 'success');
      await load();
    } catch (error) {
      message.textContent = error.payload?.error === 'discount_group_name_exists' ? 'Программа с таким названием уже существует' : 'Не удалось сохранить программу';
      message.className = 'form-message error-message';
    } finally { setLoyaltyPending(false); }
  });
  load();
}

const clientReservationHistoryDate = (item) => item.date
  ? [formatRuDate(item.date), item.time || ''].filter(Boolean).join(' ')
  : item.startsAt ? formatRuDate(item.startsAt, true) : '—';

function renderClients() {
  const target = document.querySelector('#page-content'); if (!target) return;
  const canAdjustGuestLoyalty = portalPermissions.has('finance') || portalPermissions.has('loyalty') || portalPermissions.has('staff_manage'); const canReadGuestAccountEntries = canAdjustGuestLoyalty; const canReverseGuestAccountEntries = portalPermissions.has('finance') || portalPermissions.has('loyalty'); const canMakeExternalGuestPayout = ['owner','admin','developer'].includes(portalUser.role) && portalPermissions.has('finance');
  const hiddenLoyaltyFields = `<form id="loyalty-form" class="stack-form loyalty-adjustment-form" ${canAdjustGuestLoyalty ? '' : 'hidden'}><div class="panel-head"><h3>Корректировка бонусов</h3><span id="loyalty-balance" class="muted"></span></div><label>Изменение, баллы<input id="loyalty-delta" type="number" step="1" required placeholder="Например, 50 или -20"></label><label>Причина<textarea id="loyalty-reason" maxlength="500" required rows="2" placeholder="Укажите основание операции"></textarea></label><button type="submit" class="button small">Записать операцию</button><span id="loyalty-message" class="form-message"></span></form>`;
  target.innerHTML = `<div class="page-title"><div><p class="eyebrow">ГОСТИ</p><h1>Гости</h1><p class="muted">Единая карточка гостя, контакты и предпочтения. Сотрудники могут применять скидки из заказа; владелец и администратор получают уведомления.</p></div><button type="button" class="button primary" id="new-client" aria-controls="client-editor" aria-expanded="false">${icon('plus')} Новый гость</button></div><div class="client-insights"><article><span>Всего гостей</span><strong id="clients-total">—</strong><small>В основной базе</small></article><article><span>Постоянные и VIP</span><strong id="clients-loyal">—</strong><small>Гости с повторными визитами</small></article><article><span>Оборот гостей</span><strong id="clients-turnover">—</strong><small>По сохранённым карточкам</small></article></div><div class="content-grid"><section class="panel wide"><div class="panel-head"><div><h2>База гостей</h2><span class="muted" id="clients-count">Загрузка…</span></div><div class="clients-toolbar"><input class="table-search" id="clients-search" aria-label="Поиск гостей" placeholder="Имя, телефон, Telegram или вкус"><select id="clients-status-filter" aria-label="Фильтр по статусу"><option value="">Все статусы</option><option value="new">Новые</option><option value="regular">Постоянные</option><option value="vip">VIP</option><option value="blocked">Не обслуживать</option></select><select id="clients-sort" aria-label="Сортировка гостей"><option value="recent">Сначала новые</option><option value="visits">По визитам</option><option value="turnover">По обороту</option><option value="name">По имени</option></select></div></div><div class="client-groups" id="clients-groups" role="tablist" aria-label="Группы гостей"><button type="button" class="is-active" data-client-group="" role="tab" aria-selected="true">Все <span data-group-count="all">0</span></button><button type="button" data-client-group="new" role="tab" aria-selected="false">Новые <span data-group-count="new">0</span></button><button type="button" data-client-group="regular" role="tab" aria-selected="false">Постоянные <span data-group-count="regular">0</span></button><button type="button" data-client-group="vip" role="tab" aria-selected="false">VIP <span data-group-count="vip">0</span></button><button type="button" data-client-group="blocked" role="tab" aria-selected="false">Не обслуживать <span data-group-count="blocked">0</span></button></div><div class="client-grid" id="clients-list"></div></section><section class="panel" id="client-editor" aria-labelledby="client-editor-title" hidden><div class="panel-head"><h2 id="client-editor-title" tabindex="-1">Новый гость</h2><button class="button small" id="client-cancel" type="button" aria-label="Закрыть карточку">Закрыть</button></div><form class="stack-form" id="client-form"><input type="hidden" id="client-id"><div class="client-avatar-editor"><div class="client-avatar large" id="client-avatar-preview" aria-hidden="true">Г</div><div><label class="avatar-upload button small" for="client-avatar-file">${icon('plus')} Фото гостя<input id="client-avatar-file" type="file" accept="image/png,image/jpeg,image/webp" hidden></label><small class="muted">PNG, JPG или WEBP до 1,5 МБ</small></div></div><label>Статус гостя<select id="client-status"><option value="new">Новый</option><option value="regular">Постоянный</option><option value="vip">VIP</option><option value="blocked">Не обслуживать</option></select></label><div class="form-section-label">Скидки и бонусы</div><label>Группа скидки<select id="client-discount-group"></select></label><div class="form-row"><label>Бонусный баланс<input id="client-bonus" type="number" min="0" step="1" value="0" readonly><small id="loyalty-balance-help" class="muted">Остаток и операции доступны в истории гостя.</small></label><label>Денежный баланс, ₽<input id="client-deposit" type="number" min="0" step="0.01" value="0" readonly></label></div><label>ФИО<input id="client-name" required maxlength="120" placeholder="Имя и фамилия"></label><label>Никнейм или второе имя<input id="client-nickname" maxlength="80" placeholder="Например, Лёха или Александр"></label><label>Телефоны<input id="client-phone" type="tel" inputmode="tel" placeholder="+7 (___) ___-__-__; +7 ..."><small class="muted">Можно указать несколько через точку с запятой</small></label><label>Telegram<input id="client-telegram" placeholder="@username или https://t.me/username"></label><label>Вкусы табака<input id="client-tobacco" placeholder="Darkside, мята, ягоды"></label><label>Чаши и крепость<input id="client-bowls" placeholder="Калауд, средняя крепость"></label><label>Барные предпочтения<input id="client-bar" placeholder="Лимонад, Red Bull"></label><label>Аллергии<textarea id="client-allergies" rows="2" placeholder="Орехи, цитрусы…"></textarea></label><label>Заметки<textarea id="client-notes" rows="3" placeholder="Пожелания гостя"></textarea></label><button class="button primary" type="submit">Сохранить карточку</button><p class="form-message" id="client-message"></p></form><div class="discount-policy"><div class="panel-head"><h3>Скидки</h3><span class="muted">С уведомлением руководства</span></div><p class="muted">Сотрудник может применить процентную скидку из заказа с обязательной причиной. Владелец и администратор получают уведомление, а действие записывается в аудит.</p></div><div class="client-history" id="client-history"><div class="panel-head"><h3>История</h3></div><div class="empty">Выберите гостя</div></div></section></div>`;
  target.insertAdjacentHTML('beforeend', hiddenLoyaltyFields);
  const canTopUpGuestWallet = portalPermissions.has('orders') || portalPermissions.has('finance');
  const depositTopUpForm = document.createElement('form'); depositTopUpForm.id = 'deposit-topup-form'; depositTopUpForm.className = 'stack-form deposit-topup-form'; depositTopUpForm.hidden = !canTopUpGuestWallet; depositTopUpForm.innerHTML = '<div class="panel-head"><h3>Пополнить денежный счёт</h3><span class="muted">Поступление не является выручкой от заказа</span></div><div class="form-row"><label>Сумма, ₽<input name="amount" type="number" min="0.01" max="10000000" step="0.01" required></label><label>Получено<select name="method" required><option value="cash">Наличные</option><option value="card">Карта</option><option value="qr">QR</option></select></label></div><label>Основание<textarea name="reason" maxlength="500" rows="2" required placeholder="Например: пополнение счёта гостя"></textarea></label><button class="button small" type="submit">Принять оплату и пополнить счёт</button><span class="form-message" id="deposit-topup-message" role="status"></span>';
  document.querySelector('#client-history')?.before(depositTopUpForm);
  if (document.querySelector('#loyalty-form')) document.querySelector('#client-history')?.before(document.querySelector('#loyalty-form'));
  const clientsToolbar = document.querySelector('.clients-toolbar');
  if (clientsToolbar && !document.querySelector('#clients-period')) {
    clientsToolbar.insertAdjacentHTML('afterbegin', '<label class="client-filter-field">Период<select id="clients-period" aria-label="Период аналитики гостей"><option value="7">7 дней</option><option value="30" selected>30 дней</option><option value="90">90 дней</option><option value="365">Год</option></select></label>');
  }
  for (const [selector, caption] of [['#clients-search', 'Поиск'], ['#clients-status-filter', 'Статус'], ['#clients-sort', 'Сортировка']]) {
    const control = document.querySelector(selector);
    if (!control || control.closest('.client-filter-field')) continue;
    const field = document.createElement('label');
    field.className = 'client-filter-field';
    const label = document.createElement('span');
    label.textContent = caption;
    control.before(field);
    field.append(label, control);
  }
  document.querySelector('#clients-period')?.addEventListener('change', (event) => {
    api(`/api/clients?days=${encodeURIComponent(event.target.value)}`).then((data) => { clients = data.items || []; draw(document.querySelector('#clients-search')?.value || ''); }).catch(() => portalNotice('Не удалось обновить период аналитики гостей', 'error'));
  });
  if (!['owner', 'admin', 'developer', 'manager'].includes(portalUser.role)) { document.querySelector('#client-editor .form-section-label')?.remove(); document.querySelector('#client-discount-group')?.closest('label')?.remove(); document.querySelector('#client-bonus')?.closest('label')?.remove(); document.querySelector('#client-deposit')?.closest('label')?.remove(); document.querySelector('#client-editor .discount-policy')?.remove(); }
  for (const selector of ['#client-bonus', '#client-deposit']) { const balanceField = document.querySelector(selector); if (balanceField) { balanceField.readOnly = true; balanceField.setAttribute('aria-describedby', 'loyalty-balance-help'); } }
  let clients = []; let discountGroups = [];
  const parseTags = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean).slice(0, 30);
  const formatPhones = (items) => (items || []).map((item) => item.number).join(', ');
  const normalizePhoneDraft = (value) => String(value || '').split(/[;,]/).map((part) => { const raw = part.trim(); if (!raw) return ''; const digits = raw.replace(/\D/g, ''); if (!digits) return ''; if (digits === '7') return '+7 '; if (digits.startsWith('7') && digits.length > 1) return `+7 ${digits.slice(1)}`; if (digits.startsWith('8') && digits.length > 1) return `+7 ${digits.slice(1)}`; return `+7 ${digits}`; }).join('; ');
  const guestStatusLabels = { new: 'Новый', regular: 'Постоянный', vip: 'VIP', blocked: 'Не обслуживать' };
  const guestStatusLabelsClass = { new: 'info', regular: 'success', vip: 'warning', blocked: 'danger' };
  const clientInitials = (name) => String(name || 'Гость').trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toLocaleUpperCase('ru-RU');
  let pendingAvatarUrl = null;
  const draw = (query = '') => { const list = document.querySelector('#clients-list'); const q = query.toLowerCase(); const status = document.querySelector('#clients-status-filter')?.value || ''; const sort = document.querySelector('#clients-sort')?.value || 'recent'; const counts = { all: clients.length, new: 0, regular: 0, vip: 0, blocked: 0 }; clients.forEach((item) => { const key = item.guestStatus || 'new'; if (counts[key] !== undefined) counts[key] += 1; }); document.querySelectorAll('[data-group-count]').forEach((node) => { node.textContent = counts[node.dataset.groupCount] ?? 0; }); document.querySelectorAll('[data-client-group]').forEach((node) => { const active = node.dataset.clientGroup === status; node.classList.toggle('is-active', active); node.setAttribute('aria-selected', String(active)); }); const filtered = clients.filter((client) => (!status || (client.guestStatus || 'new') === status) && (!q || `${client.name} ${client.nickname || ''} ${formatPhones(client.phoneNumbers)} ${client.telegram} ${(client.tobaccoPreferences || []).join(' ')} ${(client.barPreferences || []).join(' ')}`.toLowerCase().includes(q))); const sorted = [...filtered].sort((a,b) => sort === 'visits' ? Number(b.visits || 0) - Number(a.visits || 0) : sort === 'turnover' ? Number(b.totalSpent || 0) - Number(a.totalSpent || 0) : sort === 'name' ? String(a.name || '').localeCompare(String(b.name || ''), 'ru') : new Date(b.createdAt || 0) - new Date(a.createdAt || 0)); document.querySelector('#clients-count').textContent = `${filtered.length} ${pluralRu(filtered.length,'гость','гостя','гостей')} из ${clients.length}`; document.querySelector('#clients-total').textContent = clients.length; document.querySelector('#clients-loyal').textContent = clients.filter((client) => ['regular','vip'].includes(client.guestStatus)).length; document.querySelector('#clients-turnover').textContent = money(clients.reduce((sum, client) => sum + Number(client.totalSpent || 0), 0)); list.innerHTML = sorted.length ? sorted.map((client) => `<article class="client-card${document.querySelector('#client-editor') && !document.querySelector('#client-editor').hidden && document.querySelector('#client-id')?.value === client.id ? ' is-selected' : ''}" data-client-id="${esc(client.id)}" role="button" tabindex="0" aria-controls="client-editor" aria-expanded="${String(Boolean(document.querySelector('#client-editor') && !document.querySelector('#client-editor').hidden && document.querySelector('#client-id')?.value === client.id))}" aria-label="Открыть карточку гостя ${esc(client.name)}"><div class="client-card-head"><div class="client-card-person"><span class="client-avatar" aria-hidden="true">${client.avatarUrl ? `<img src="${esc(client.avatarUrl)}" alt="">` : esc(clientInitials(client.name))}</span><div><h3>${esc(client.name)}${client.nickname ? ` <small class="client-nickname">«${esc(client.nickname)}»</small>` : ""}</h3><small>${esc(formatPhones(client.phoneNumbers) || 'Телефон не указан')}${client.telegram ? ` · ${esc(client.telegram)}` : ''}</small></div></div><div class="client-actions"><span class="badge ${guestStatusLabelsClass[client.guestStatus || 'new'] || 'info'}${client.guestStatus === 'vip' ? ' vip-badge' : ''}">${esc(guestStatusLabels[client.guestStatus || 'new'] || guestStatusLabels.new)}</span>${['owner','admin','developer','manager'].includes(portalUser.role) ? `<button type="button" class="button small client-archive" data-client-action="archive" data-client-id="${esc(client.id)}">Архивировать</button>` : ''}${portalUser.role === 'owner' ? `<button type="button" class="button small danger-outline client-delete" data-client-action="delete" data-client-id="${esc(client.id)}" aria-label="Удалить гостя">Удалить</button>` : ''}</div></div><div class="client-tags"><span>${Number(client.visits || 0)} ${pluralRu(client.visits || 0,'визит','визита','визитов')}</span><span>Оборот: ${money(client.totalSpent || 0)}</span>${(() => { const group = discountGroups.find((entry) => entry.id === client.discountGroupId); return group ? `<span class=\"discount-chip\">${esc(group.name)} · ${group.discountPercent}%</span>` : ''; })()}${canAdjustGuestLoyalty ? `<span>Бонусы: ${Number(client.bonusBalance ?? client.loyaltyPoints ?? 0)}</span>${Number(client.depositBalance || 0) ? `<span>Депозит: ${money(client.depositBalance)}</span>` : ''}` : ''}${client.allergies ? `<span class="badge warning">Аллергии: ${esc(client.allergies)}</span>` : ''}</div><div class="preference-line"><b>Табак:</b> ${esc((client.tobaccoPreferences || []).join(', ') || 'не указано')}</div><div class="preference-line"><b>Бар:</b> ${esc((client.barPreferences || []).join(', ') || 'не указано')}</div><div class="preference-line"><b>Чаши:</b> ${esc((client.bowlPreferences || []).join(', ') || 'не указано')}</div>${client.notes ? `<p class="muted">${esc(client.notes)}</p>` : ''}</article>`).join('') : '<div class="empty">Гости не найдены</div>'; };
  const fill = (client) => { pendingAvatarUrl = client?.avatarUrl || null; const preview = document.querySelector('#client-avatar-preview'); if (preview) preview.innerHTML = pendingAvatarUrl ? `<img src="${esc(pendingAvatarUrl)}" alt="">` : esc(clientInitials(client?.name || 'Гость')); const avatarInput = document.querySelector('#client-avatar-file'); if (avatarInput) avatarInput.value = ''; document.querySelector('#client-id').value = client?.id || ''; document.querySelectorAll('.client-card').forEach((card) => card.classList.toggle('is-selected', Boolean(client && card.dataset.clientId === client.id))); document.querySelector('#client-editor-title').textContent = client ? `Карточка: ${client.name}` : 'Новый гость'; document.querySelector('#client-status').value = client?.guestStatus || 'new'; const groupSelect = document.querySelector('#client-discount-group'); if (groupSelect) { groupSelect.innerHTML = `<option value=\"\">Без программы</option>${discountGroups.map((group) => `<option value=\"${esc(group.id)}\">${esc(group.name)} · ${group.discountPercent}%</option>`).join('')}`; groupSelect.value = client?.discountGroupId || ''; } const bonusField = document.querySelector('#client-bonus'); if (bonusField) bonusField.value = Number(client?.bonusBalance ?? client?.loyaltyPoints ?? 0); const depositField = document.querySelector('#client-deposit'); if (depositField) depositField.value = Number(client?.depositBalance || 0); document.querySelector('#client-name').value = client?.name || ''; document.querySelector('#client-nickname').value = client?.nickname || ''; document.querySelector('#client-phone').value = formatPhones(client?.phoneNumbers).replaceAll(', ', '; '); document.querySelector('#client-telegram').value = client?.telegram || ''; document.querySelector('#client-tobacco').value = (client?.tobaccoPreferences || []).join(', '); document.querySelector('#client-bowls').value = (client?.bowlPreferences || []).join(', '); document.querySelector('#client-bar').value = (client?.barPreferences || []).join(', '); document.querySelector('#client-allergies').value = client?.allergies || ''; document.querySelector('#client-notes').value = client?.notes || ''; document.querySelector('#loyalty-balance').textContent = client ? `${Number(client.loyaltyPoints || 0)} ${pluralRu(client.loyaltyPoints || 0,'бонус','бонуса','бонусов')}` : 'Выберите гостя'; const history = document.querySelector('#client-history'); if (!client) { history.innerHTML = '<div class="panel-head"><h3>История</h3></div><div class="empty">Выберите гостя</div>'; } else { history.innerHTML = '<div class="panel-head"><h3>История</h3></div><div class="empty">Загрузка истории…</div>'; Promise.all([api(`/api/clients/${encodeURIComponent(client.id)}/history`), canReadGuestAccountEntries ? api(`/api/clients/${encodeURIComponent(client.id)}/account-entries`) : Promise.resolve({ items: [], balances: null })]).then(([data, ledger]) => { const orders = (data.orders || []).map((order) => `<div class="history-row"><div><b>Заказ ${esc(order.id)}</b><small>${esc(order.tableId || '—')} · ${order.status === 'closed' ? 'Закрыт' : 'Открыт'} · ${order.createdAt ? formatRuDate(order.createdAt) : '—'}</small></div><strong>${money(order.total || 0)}</strong></div>`).join(''); const reservations = (data.reservations || []).map((item) => `<div class="history-row"><div><b>Бронь ${esc(item.tableId || '—')}</b><small>${esc(clientReservationHistoryDate(item))} · ${item.status === 'confirmed' ? 'Подтверждена' : 'Отменена'}</small></div>${data.reservationPaymentsVisible === false ? '<span>Платёжные данные недоступны</span>' : `<strong>${reservationHistoryPaymentLabel(item)}</strong>`}</div>`).join(''); const accountEntries = (ledger.items || []).map((entry) => `<div class="history-row"><div><b>${entry.entryKind === 'reversal' ? `Сторно начисления бонусов · ${entry.reversedAmount}` : `${entry.accountType === 'bonus' ? 'Бонусы' : 'Деньги гостя'} · ${entry.amount > 0 ? '+' : ''}${entry.amount}`}</b><small>${esc(entry.reason)} · ${esc(entry.sourceType)}${(entry.method || entry.reversalMethod) ? ` · ${esc(({cash:'Наличные',card:'Карта',qr:'QR',wallet:'Баланс гостя',clawback:'Удержание бонусов'})[entry.reversalMethod || entry.method] || entry.reversalMethod || entry.method)}` : ''}${entry.reversalShiftId ? ` · смена ${esc(entry.reversalShiftId.slice(0,8))}` : ''} · ${entry.createdAt ? formatRuDate(entry.createdAt, true) : '—'}${entry.canReverse ? ` · к возврату ${entry.reversibleRemaining}` : ''}</small></div><span>${entry.actorName ? esc(entry.actorName) : 'Система'}${canReverseGuestAccountEntries && entry.canReverse ? ` <button type="button" class="button small" data-account-reverse="${esc(entry.id)}" data-account-max="${entry.reversibleRemaining}" data-account-type="${entry.accountType}" data-account-sign="${Math.sign(Number(entry.amount))}">Сторно</button>` : ''}</span></div>`).join(''); history.innerHTML = `<div class="panel-head"><h3>История</h3><span class="muted">${(data.orders || []).length} ${pluralRu((data.orders || []).length,'заказ','заказа','заказов')} · ${(data.reservations || []).length} ${pluralRu((data.reservations || []).length,'бронь','брони','броней')}</span></div>${orders || reservations ? `<div class="history-list">${orders}${reservations}</div>` : '<div class="empty">История пока пуста</div>'}<div class="panel-head"><h3>Операции по балансу</h3><span class="muted">${ledger.balances ? `Бонусы: ${Number(ledger.balances.bonus || 0)} · Деньги: ${money(ledger.balances.deposit || 0)}${Number(ledger.balances.bonusClawback || 0) ? ` · удержано бонусов: ${Number(ledger.balances.bonusClawback)}` : ''}` : 'Операции доступны финансовым ролям'}</span></div>${!ledger.balances ? '<div class="empty">Нет доступа к журналу баланса</div>' : accountEntries.length ? `<div class="history-list">${accountEntries}</div>` : '<div class="empty">Движений пока нет</div>'}`; }).catch(() => { history.innerHTML = '<div class="panel-head"><h3>История</h3></div><div class="empty">Не удалось загрузить историю</div>'; }); } };
  document.querySelector('#client-history')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-account-reverse]'); if (!button || !canReverseGuestAccountEntries) return;
    const guestId = document.querySelector('#client-id').value; const entryId = button.dataset.accountReverse; const max = Number(button.dataset.accountMax || 0); const accountType = button.dataset.accountType; const sourceSign = button.dataset.accountSign; const isBonusAward = accountType === 'bonus' && sourceSign === '1'; const positiveTopUp = accountType === 'deposit' && sourceSign === '1';
    const dialog = document.createElement('dialog'); dialog.className = 'account-reversal-dialog';
    const step = accountType === 'bonus' ? '1' : '0.01';
    const methods = isBonusAward ? '<option value="clawback">Отозвать бонусы; потраченное удержать из будущих начислений</option>' : sourceSign === '-1' ? '<option value="wallet">Вернуть на исходный счёт гостя</option>' : canMakeExternalGuestPayout ? '<option value="cash">Выплатить наличными</option><option value="card">Вернуть на карту</option><option value="qr">Вернуть по QR</option><option value="wallet">Списать только остаток баланса, без внешней выплаты</option>' : '<option value="wallet">Списать только остаток баланса, без внешней выплаты</option>';
    dialog.innerHTML = `<form class="stack-form"><h3>Сторно движения</h3><p class="muted">${positiveTopUp ? 'Сторно уменьшит остаток денежного счёта гостя. Выплата наличными уменьшит ожидаемую кассу текущей смены.' : isBonusAward ? 'Сначала отзовём доступные бонусы; если часть уже потрачена, удержим её из будущих начислений.' : 'Исходная запись останется в истории; обратное движение будет добавлено отдельной операцией.'}</p><label>Сумма<input name="amount" type="number" min="${step}" max="${max}" step="${step}" value="${max}" required></label><label>Способ<select name="method" required>${methods}</select></label><label>Причина<textarea name="reason" maxlength="500" rows="3" required></textarea></label><div class="form-row"><button type="button" class="button small" data-cancel>Отмена</button><button type="submit" class="button primary">Продолжить</button></div></form>`;
    document.body.append(dialog); dialog.showModal();
    const values = await new Promise((resolve) => { const form = dialog.querySelector('form'); form.addEventListener('submit', (submitEvent) => { submitEvent.preventDefault(); const fields = new FormData(form); resolve({ amount: Number(fields.get('amount')), method: String(fields.get('method') || ''), reason: String(fields.get('reason') || '').trim() }); dialog.close(); }); dialog.querySelector('[data-cancel]').addEventListener('click', () => { resolve(null); dialog.close(); }); dialog.addEventListener('cancel', () => resolve(null), { once: true }); });
    dialog.remove(); if (!values) return;
    if (!Number.isFinite(values.amount) || values.amount <= 0 || values.amount > max || !values.reason) { portalNotice('Проверьте сумму и причину сторно', 'error'); return; }
    const methodLabels = { wallet: 'остаток баланса гостя', cash: 'наличные', card: 'карта', qr: 'QR', clawback: 'отзыв бонусов и удержание будущих начислений' };
    if (!await portalConfirm(`Провести сторно ${values.amount} ${accountType === 'bonus' ? 'бонусов' : '₽'}?`, `${methodLabels[values.method]}. Причина: ${values.reason}${values.method === 'cash' ? '. Выплата уменьшит ожидаемую кассу открытой смены.' : ''}`, 'Подтвердить сторно')) return;
    const fingerprint = JSON.stringify({ guestId, entryId, ...values }); if (button.dataset.fingerprint !== fingerprint) { button.dataset.fingerprint = fingerprint; button.dataset.idempotencyKey = crypto.randomUUID(); }
    button.disabled = true;
    try { const result = await api(`/api/clients/${encodeURIComponent(guestId)}/account-entries/${encodeURIComponent(entryId)}/reversals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, idempotencyKey: button.dataset.idempotencyKey }) }); portalNotice(`Сторно проведено${result.clawbackAmount ? ` · удержано будущих бонусов: ${result.clawbackAmount}` : ''}`, 'success'); const selected = clients.find((item) => item.id === guestId); if (selected) { selected.loyaltyPoints = selected.bonusBalance = Number(result.balances?.bonus ?? selected.loyaltyPoints ?? 0); selected.depositBalance = Number(result.balances?.deposit ?? selected.depositBalance ?? 0); fill(selected); draw(document.querySelector('#clients-search').value); } }
    catch (error) { button.disabled = false; const code = error.payload?.error; portalNotice(code === 'open_shift_required' ? 'Для финансовой операции откройте смену' : code === 'insufficient_deposit_balance' ? 'На денежном счёте недостаточно средств для возврата' : code === 'reversal_exceeds_remainder' ? 'Остаток к возврату изменился. Обновите карточку гостя.' : code === 'external_payout_requires_owner_admin_finance' ? 'Выплату может провести только владелец или администратор с правом finance' : code === 'idempotency_key_reused' ? 'Ключ операции уже использован для другого сторно' : 'Не удалось провести сторно; проверьте журнал и повторите с теми же данными', 'error'); }
  });
  depositTopUpForm.addEventListener('submit', async (event) => { event.preventDefault(); if (!canTopUpGuestWallet || depositTopUpForm.dataset.submitting === '1') return; const guestId = document.querySelector('#client-id').value; if (!guestId) { portalNotice('Сначала выберите сохранённого гостя', 'error'); return; } const fields = new FormData(depositTopUpForm); const payload = { amount: Number(fields.get('amount')), method: String(fields.get('method') || 'cash'), reason: String(fields.get('reason') || '').trim() }; if (!Number.isFinite(payload.amount) || payload.amount <= 0 || !payload.reason) { portalNotice('Укажите сумму и основание пополнения', 'error'); return; } const fingerprint = JSON.stringify({ guestId, ...payload }); if (depositTopUpForm.dataset.fingerprint !== fingerprint) { depositTopUpForm.dataset.fingerprint = fingerprint; depositTopUpForm.dataset.idempotencyKey = crypto.randomUUID(); } const message = document.querySelector('#deposit-topup-message'); const submit = depositTopUpForm.querySelector('[type=submit]'); depositTopUpForm.dataset.submitting = '1'; if (submit) submit.disabled = true; try { const result = await api(`/api/clients/${encodeURIComponent(guestId)}/deposit-top-ups`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, idempotencyKey: depositTopUpForm.dataset.idempotencyKey }) }); if (message) { message.textContent = `Получено ${money(result.amount)} · остаток на счёте ${money(result.depositBalance)}`; message.className = 'form-message success-message'; } depositTopUpForm.dataset.fingerprint = ''; depositTopUpForm.dataset.idempotencyKey = ''; const selected = clients.find((client) => client.id === guestId); if (selected) { selected.depositBalance = Number(result.depositBalance); fill(selected); } depositTopUpForm.reset(); } catch (error) { if (message) { message.textContent = error.payload?.error === 'open_shift_required' ? 'Откройте смену, чтобы принять деньги на счёт' : error.payload?.error === 'idempotency_key_reused' ? 'Данные операции изменились. Отправьте её ещё раз.' : 'Не удалось пополнить счёт; повторите запрос с теми же данными или сверьте журнал'; message.className = 'form-message error-message'; } } finally { depositTopUpForm.dataset.submitting = '0'; if (submit) submit.disabled = false; } });  const load = () => Promise.all([api('/api/clients'), api('/api/discount-groups')]).then(([data, groups]) => { clients = data.items || []; discountGroups = groups.items || []; const groupSelect = document.querySelector('#client-discount-group'); if (groupSelect) groupSelect.innerHTML = `<option value=\"\">Без программы</option>${discountGroups.map((group) => `<option value=\"${esc(group.id)}\">${esc(group.name)} · ${group.discountPercent}%</option>`).join('')}`; draw(document.querySelector('#clients-search').value); }).catch(() => portalNotice('Не удалось загрузить базу гостей', 'error'));
  const phoneInput = document.querySelector('#client-phone'); phoneInput.addEventListener('focus', () => { if (!phoneInput.value.trim()) phoneInput.value = '+7 '; }); phoneInput.addEventListener('input', () => { const caret = phoneInput.selectionStart; const before = phoneInput.value; const normalized = normalizePhoneDraft(before); if (normalized !== before) { phoneInput.value = normalized; phoneInput.setSelectionRange(Math.min(normalized.length, caret + (normalized.length - before.length)), Math.min(normalized.length, caret + (normalized.length - before.length))); } });
  document.querySelector('#client-avatar-file').addEventListener('change', (event) => { const file = event.target.files?.[0]; if (!file) return; if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 1500000) { event.target.value = ''; portalNotice('Выберите PNG, JPG или WEBP до 1,5 МБ', 'error'); return; } compressUploadedImage(file).then((imageData) => { pendingAvatarUrl = imageData; const preview = document.querySelector('#client-avatar-preview'); if (preview) preview.innerHTML = `<img src="${esc(pendingAvatarUrl)}" alt="">`; }).catch(() => portalNotice('Не удалось обработать аватар гостя', 'error')); }); document.querySelector('#clients-search').addEventListener('input', (event) => draw(event.target.value)); document.querySelector('#clients-status-filter').addEventListener('change', () => draw(document.querySelector('#clients-search').value)); document.querySelector('#clients-sort').addEventListener('change', () => draw(document.querySelector('#clients-search').value)); document.querySelector('#clients-groups')?.addEventListener('click', (event) => { const button = event.target.closest('[data-client-group]'); if (!button) return; document.querySelector('#clients-status-filter').value = button.dataset.clientGroup || ''; draw(document.querySelector('#clients-search').value); }); const editor = document.querySelector('#client-editor'); const newClientButton = document.querySelector('#new-client'); const clientsGrid = editor.closest('.content-grid'); let editorReturnFocus = newClientButton; let editorSession = 0; let submitGeneration = 0; const resetClientSubmit = () => { submitGeneration += 1; const form = document.querySelector('#client-form'); form.dataset.submitting = '0'; const submit = form.querySelector('button[type="submit"]'); submit.disabled = false; submit.textContent = 'Сохранить карточку'; }; const syncClientSelection = () => document.querySelectorAll('.client-card').forEach((card) => { const selected = !editor.hidden && card.dataset.clientId === document.querySelector('#client-id').value; card.classList.toggle('is-selected', selected); card.setAttribute('aria-expanded', String(selected)); }); const openEditor = (client, trigger = newClientButton) => { editorSession += 1; resetClientSubmit(); editorReturnFocus = trigger; editor.hidden = false; clientsGrid.classList.add('has-client-editor'); newClientButton.setAttribute('aria-expanded', 'true'); fill(client); syncClientSelection(); editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); document.querySelector('#client-name').focus({ preventScroll: true }); }; const closeEditor = () => { editorSession += 1; resetClientSubmit(); fill(null); editor.hidden = true; clientsGrid.classList.remove('has-client-editor'); newClientButton.setAttribute('aria-expanded', 'false'); syncClientSelection(); const focusTarget = editorReturnFocus?.isConnected ? editorReturnFocus : newClientButton; focusTarget.focus({ preventScroll: true }); }; newClientButton.addEventListener('click', () => openEditor(null, newClientButton)); document.querySelector('#client-cancel').addEventListener('click', closeEditor); const activateClientCard = (card) => { if (card) openEditor(clients.find((client) => client.id === card.dataset.clientId), card); }; document.querySelector('#clients-list').addEventListener('click', async (event) => { const action = event.target.closest('[data-client-action]'); if (action) { event.stopPropagation(); const id = action.dataset.clientId; const isDelete = action.dataset.clientAction === 'delete'; if (!await portalConfirm(isDelete ? 'Удалить гостя без возможности восстановления?' : 'Архивировать гостя?', isDelete ? 'После удаления гостя восстановление будет невозможно.' : 'Гость исчезнет из основной базы, но история сохранится.', isDelete ? 'Удалить гостя' : 'Архивировать')) return; action.disabled = true; api(`/api/clients/${encodeURIComponent(id)}${isDelete ? '' : '/archive'}`, { method: isDelete ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' }, body: isDelete ? undefined : '{}' }).then(() => { portalNotice(isDelete ? 'Гость удалён' : 'Гость архивирован', 'success'); load(); editorReturnFocus = newClientButton; closeEditor(); }).catch((error) => { action.disabled = false; portalNotice(error.payload?.error === 'client_delete_owner_required' ? 'Удалять гостей может только владелец' : 'Не удалось изменить гостя', 'error'); }); return; } activateClientCard(event.target.closest('[data-client-id]')); }); document.querySelector('#clients-list').addEventListener('keydown', (event) => { const card = event.target.closest('[data-client-id]'); if (card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); activateClientCard(card); } }); document.querySelector('#loyalty-form').addEventListener('submit', (event) => { event.preventDefault(); const id = document.querySelector('#client-id').value; const delta = Number(document.querySelector('#loyalty-delta').value); const reason = document.querySelector('#loyalty-reason').value.trim(); const message = document.querySelector('#loyalty-message'); if (!id) { message.textContent = 'Сначала выберите гостя'; message.className = 'form-message error-message'; return; } api(`/api/clients/${encodeURIComponent(id)}/loyalty`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delta, reason, idempotencyKey: crypto.randomUUID() }) }).then((result) => { message.textContent = `Баланс: ${Number(result.loyaltyPoints || 0)} ${pluralRu(result.loyaltyPoints || 0,'бонус','бонуса','бонусов')}`; message.className = 'form-message success-message'; const client = clients.find((item) => item.id === id); if (client) { client.loyaltyPoints = client.bonusBalance = result.loyaltyPoints; fill(client); draw(document.querySelector('#clients-search').value); } event.target.reset(); }).catch((error) => { message.textContent = error.payload?.error === 'invalid_loyalty_adjustment' ? 'Укажите ненулевую сумму и причину' : 'Не удалось провести операцию'; message.className = 'form-message error-message'; }); });
  document.querySelector('#client-form').addEventListener('submit', (event) => { event.preventDefault(); const form = event.target; if (form.dataset.submitting === '1') return; const activeEditorSession = editorSession; const activeSubmission = ++submitGeneration; form.dataset.submitting = '1'; const submit = form.querySelector('button[type="submit"]'); submit.disabled = true; submit.textContent = 'Сохранение…'; const id = document.querySelector('#client-id').value; const rawPhones = document.querySelector('#client-phone').value.split(/[;,]/).map((number, index) => ({ label: index ? 'Дополнительный' : 'Основной', number: number.trim(), primary: index === 0 })).filter((item) => item.number); const payload = { name: document.querySelector('#client-name').value.trim(), nickname: document.querySelector('#client-nickname').value.trim(), phoneNumbers: rawPhones, telegram: document.querySelector('#client-telegram').value.trim(), tobaccoPreferences: parseTags(document.querySelector('#client-tobacco').value), bowlPreferences: parseTags(document.querySelector('#client-bowls').value), barPreferences: parseTags(document.querySelector('#client-bar').value), allergies: document.querySelector('#client-allergies').value.trim(), notes: document.querySelector('#client-notes').value.trim(), avatarUrl: pendingAvatarUrl, guestStatus: document.querySelector('#client-status').value, ...(document.querySelector('#client-discount-group') ? { discountGroupId: document.querySelector('#client-discount-group').value } : {}) }; const message = document.querySelector('#client-message'); api(id ? `/api/clients/${id}` : '/api/clients', { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then((saved) => { if (editorSession !== activeEditorSession || editor.hidden) { load(); return; } if (!id && saved?.id) { document.querySelector('#client-id').value = saved.id; document.querySelector('#client-editor-title').textContent = `Карточка: ${saved.name || payload.name}`; } message.textContent = 'Карточка сохранена'; message.className = 'form-message success-message'; load(); }).catch((error) => { if (editorSession !== activeEditorSession || editor.hidden) return; message.textContent = error.payload?.error === 'invalid_telegram' ? 'Проверьте Telegram-ссылку' : error.payload?.error === 'invalid_phone_numbers' ? 'Введите телефон в формате +7 (___) ___-__-__' : 'Не удалось сохранить карточку'; message.className = 'form-message error-message'; }).finally(() => { if (submitGeneration !== activeSubmission) return; form.dataset.submitting = '0'; submit.disabled = false; submit.textContent = 'Сохранить карточку'; }); }); load();
}

const reservationTableCapacityLabel = (table) => {
  const fallback = Number(table.capacity || 0);
  const min = Number(table.minCapacity || fallback);
  const max = Number(table.maxCapacity || fallback);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) return '';
  return min === max ? `${max} ${pluralRu(max, 'гость', 'гостя', 'гостей')}` : `${min}–${max} ${pluralRu(max, 'гость', 'гостя', 'гостей')}`;
};
const renderReservationTableOptions = (zones) => {
  const normalizedZones = Array.isArray(zones) ? zones : [];
  const tables = normalizedZones.flatMap((zone) => Array.isArray(zone.tables) ? zone.tables : []);
  if (!tables.length) return '<option value="">В залах ещё нет столов</option>';
  if (!tables.some((table) => table.status !== 'blocked')) return '<option value="">Нет доступных столов</option>';
  const groups = normalizedZones.map((zone) => {
    const options = (Array.isArray(zone.tables) ? zone.tables : []).map((table) => {
      const minimum = Number(table.minimumOrderTotal || 0);
      const capacity = reservationTableCapacityLabel(table);
      const blocked = table.status === 'blocked';
      const description = [capacity && `вместимость ${capacity}`, minimum > 0 && `депозит ${money(minimum)}`, blocked && 'закрыт'].filter(Boolean).join(' · ');
      const maxGuests = Number(table.maxCapacity || table.capacity || 50);
      return `<option value="${esc(table.id)}" data-minimum="${minimum}" data-max-guests="${maxGuests}" ${blocked ? 'disabled' : ''}>${esc(table.name || 'Без названия')}${description ? ` — ${esc(description)}` : ''}</option>`;
    }).join('');
    return options ? `<optgroup label="${esc(zone.name || 'Зал без названия')}">${options}</optgroup>` : '';
  }).join('');
  return `<option value="">Выберите зал и место</option>${groups}`;
};

function renderReservations() {
  const target = document.querySelector('#page-content'); if (!target) return;
  const canRefundReservationPrepayment = ['owner','admin','developer'].includes(portalUser.role) && portalPermissions.has('finance');
  target.innerHTML = `<div class="page-title"><div><p class="eyebrow">ГОСТИ И СТОЛЫ</p><h1>Бронирования</h1><p class="muted">Единый календарь броней и депозитов.</p></div><button type="button" class="button primary" id="focus-reservation">${icon('plus')} Новая бронь</button></div><div class="content-grid"><section class="panel"><div class="panel-head"><h2>Новая бронь</h2></div><form id="reservation-form" class="stack-form"><label>Гость из базы или новый<input id="reservation-guest" list="reservation-guests-list" required placeholder="Начните вводить имя или никнейм"><datalist id="reservation-guests-list"></datalist><input id="reservation-client-id" type="hidden"><small class="muted" id="reservation-guest-match-hint">Выберите гостя из списка или введите разового гостя</small></label><label>Телефон<input id="reservation-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 (___) ___-__-__"></label><div class="form-row"><label>Дата<input id="reservation-date" type="date" required value="${localDateKey()}"></label><label>Время<input id="reservation-time" type="time" required value="21:00"></label></div><div class="form-row"><label>Зал и место<select id="reservation-table" required><option value="">Загрузка залов и столов…</option></select><small class="muted">Места сгруппированы по залам; вместимость и депозит указаны рядом.</small></label><label>Гости<input id="reservation-guests" type="number" min="1" max="50" value="2" required><small id="reservation-guests-hint" class="muted">Выберите место, чтобы увидеть вместимость.</small></label></div><label>Требуемый депозит<input id="reservation-deposit" type="number" min="0" step="100" value="0"><small id="reservation-deposit-hint" class="muted">Сумма к оплате по брони; полученные деньги учитываются отдельно.</small></label><label>Комментарий<textarea id="reservation-notes" maxlength="2000" rows="3" placeholder="Пожелания гостя или особые условия"></textarea></label><button type="submit" class="button primary">Подтвердить бронь</button><p class="form-message" id="reservation-message"></p></form></section><section class="panel wide reservation-panel"><div class="panel-head"><h2>Ближайшие бронирования</h2><input class="table-search" id="reservation-filter" aria-label="Поиск бронирования" placeholder="Поиск по гостю, залу или столу"><input class="date-input" id="reservation-list-date" type="date" aria-label="Дата списка" value="${localDateKey()}"></div><div class="reservation-list" id="reservation-list"></div></section></div>`;
  const loadTables = () => api('/api/floor').then((data) => {
    const zones = Array.isArray(data.zones) ? data.zones : [];
    const tables = zones.flatMap((zone) => Array.isArray(zone.tables) ? zone.tables : []);
    const select = document.querySelector('#reservation-table');
    const deposit = document.querySelector('#reservation-deposit');
    const depositHint = document.querySelector('#reservation-deposit-hint');
    const guests = document.querySelector('#reservation-guests');
    const guestsHint = document.querySelector('#reservation-guests-hint');
    const selectedId = select.value;
    select.innerHTML = renderReservationTableOptions(zones);
    select.disabled = !tables.some((table) => table.status !== 'blocked');
    if (tables.some((table) => table.id === selectedId && table.status !== 'blocked')) select.value = selectedId;
    const updatePlaceRules = () => {
      const selected = select.selectedOptions[0];
      const minimum = Number(selected?.dataset.minimum || 0);
      const maximum = Number(selected?.dataset.maxGuests || 50);
      deposit.min = String(minimum);
      if (minimum && Number(deposit.value || 0) < minimum) deposit.value = minimum;
      depositHint.textContent = minimum ? `Требуемый депозит: ${money(minimum)}. Зачёт предоплаты в заказ будет доступен после связывания брони с заказом.` : 'Для этого места депозит не требуется.';
      guests.max = String(maximum);
      guestsHint.textContent = selected?.value ? `Вместимость выбранного места — до ${maximum} ${pluralRu(maximum, 'гостя', 'гостей', 'гостей')}.` : 'Выберите место, чтобы увидеть вместимость.';
    };
    if (select.dataset.ruleBound !== '1') { select.addEventListener('change', updatePlaceRules); select.dataset.ruleBound = '1'; }
    updatePlaceRules();
  }).catch(() => {
    const select = document.querySelector('#reservation-table');
    if (select) { select.innerHTML = '<option value="">Не удалось загрузить залы и столы</option>'; select.disabled = true; }
    portalNotice('Не удалось загрузить столы', 'error');
  });
  let reservations = [];
  let reservationLoadError = false;
  const draw = (query = '') => {
    const selectedDate = document.querySelector('#reservation-list-date')?.value || '';
    const list = document.querySelector('#reservation-list');
    const normalizedQuery = String(query).trim().toLocaleLowerCase('ru-RU');
    const filtered = reservations.filter((item) => (!selectedDate || item.date === selectedDate) && String([item.guestName, item.zoneName || '', item.tableName, item.phone].join(' ')).toLocaleLowerCase('ru-RU').includes(normalizedQuery)).sort((a, b) => String(a.date + ' ' + a.time).localeCompare(String(b.date + ' ' + b.time)));
    const emptyState = reservationLoadError ? '<div class="empty"><strong>Не удалось загрузить бронирования</strong><small>Проверьте соединение и повторите попытку.</small><button type="button" class="button small" data-reservation-retry>Повторить загрузку</button></div>' : reservations.length ? '<div class="empty"><strong>По выбранным условиям бронирований нет</strong><small>Измените дату или поиск либо покажите все бронирования.</small><button type="button" class="button small" data-reservation-reset>Показать все бронирования</button></div>' : selectedDate ? '<div class="empty"><strong>На выбранную дату бронирований пока нет</strong><small>Создайте бронь в форме слева или просмотрите все бронирования.</small><button type="button" class="button small" data-reservation-reset>Показать все даты</button></div>' : '<div class="empty"><strong>Бронирований пока нет</strong><small>Создайте первую бронь в форме слева.</small></div>';
    list.innerHTML = filtered.length ? filtered.map((item) => '<div class="reservation-row"><div><b>' + esc(item.guestName) + '</b><small>' + esc(formatRuDate(item.date)) + ' · ' + esc(item.time) + ' · ' + esc(item.zoneName ? item.zoneName + ' · ' + (item.tableName || item.tableId) : (item.tableName || item.tableId)) + ' · ' + item.guests + ' ' + pluralRu(item.guests,'гость','гостя','гостей') + (item.createdByName ? ' · оформил: ' + esc(item.createdByName) + ' (' + esc(item.createdByRole || 'сотрудник') + ')' : '') + '</small></div><div><strong></strong><span class="badge ' + (item.status === 'confirmed' ? 'success' : 'danger') + '">' + (item.status === 'confirmed' ? 'Подтверждена' : 'Отменена') + '</span>' + (item.status === 'confirmed' ? '<button type="button" class="button small danger-outline reservation-cancel" data-reservation="' + esc(item.id) + '">Отменить</button>' : '') + '</div></div>').join('') : emptyState;
    filtered.forEach((item, index) => {
      const details = list.querySelectorAll('.reservation-row')[index]?.children[1];
      if (!details) return;
      const required = Number(item.depositRequired ?? item.deposit ?? 0);
      const legacy = Number(item.legacyDepositPaid ?? item.depositPaid ?? 0);
      const verified = Number(item.verifiedDepositPaid ?? 0);
      const remaining = Math.max(0, required - verified);
      const summary = details.querySelector('strong');
      if (summary) summary.textContent = required ? 'Требуется ' + money(required) + ' · подтверждено ' + money(verified) + ' · остаток ' + money(remaining) : 'Без требуемого депозита';
      if (item.status === 'confirmed' && portalPermissions.has('orders')) { const orderButton = document.createElement('button'); orderButton.type = 'button'; orderButton.className = 'button small reservation-open-order'; orderButton.dataset.reservationOpenOrder = item.id; orderButton.textContent = item.linkedOrderId ? 'Открыть заказ' : 'Начать визит'; orderButton.dataset.orderId = item.linkedOrderId || ''; details.append(orderButton); }
      if (legacy > 0) { const warning = document.createElement('small'); warning.className = 'reservation-legacy-warning'; warning.textContent = 'Старая сумма ' + money(legacy) + ' не подтверждена квитанцией; нужна сверка'; details.append(warning); }
      const receipts = item.prepaymentReceipts || [];
      if (receipts.length) { const history = document.createElement('small'); history.className = 'reservation-prepayment-history'; history.textContent = 'Квитанций: ' + receipts.length + ' · ' + receipts.map((receipt) => money(receipt.amount) + ' (' + (receipt.method === 'cash' ? 'наличные' : receipt.method === 'card' ? 'карта' : 'QR') + ', доступно ' + money(receipt.available || 0) + (receipt.reversals?.length ? ', возвратов ' + receipt.reversals.length : '') + ')').join(', '); details.append(history); }
      for (const allocation of item.prepaymentAllocations || []) if (!allocation.reversalId && ['open','in_progress','ready'].includes(allocation.orderStatus)) { const button = document.createElement('button'); button.type = 'button'; button.className = 'button small reservation-allocation-reversal'; button.dataset.reservationAllocationReversal = item.id; button.dataset.allocationId = allocation.id; button.dataset.allocationAmount = allocation.amount; button.textContent = 'Вернуть зачёт ' + money(allocation.amount) + ' из открытого заказа'; details.append(button); }
      for (const receipt of receipts) if (canRefundReservationPrepayment && Number(receipt.available || 0) > 0) { const button = document.createElement('button'); button.type = 'button'; button.className = 'button small danger-outline reservation-prepayment-refund'; button.dataset.reservationReceiptRefund = item.id; button.dataset.receiptId = receipt.id; button.dataset.receiptAvailable = receipt.available; button.textContent = 'Вернуть предоплату ' + money(receipt.available); details.append(button); }
      if (item.status === 'confirmed' && remaining > 0 && legacy === 0) { const button = document.createElement('button'); button.type = 'button'; button.className = 'button small primary reservation-prepayment'; button.dataset.reservationPrepayment = item.id; button.textContent = 'Принять предоплату'; details.append(button); }
      if (item.status === 'cancelled' && verified > 0) { const warning = document.createElement('small'); warning.className = 'reservation-prepayment-warning'; warning.textContent = 'По отменённой брони есть предоплата: требуется решение по возврату'; details.append(warning); }
    });
  };
  const load = () => api('/api/reservations').then((data) => { reservationLoadError = false; reservations = (data.items || []).map((item) => ({ ...item, date: /^\d{4}-\d{2}-\d{2}T/.test(String(item.date || '')) ? String(item.date).slice(0, 10) : item.date })); draw(document.querySelector('#reservation-filter').value); return true; }).catch(() => { reservations = []; reservationLoadError = true; draw(document.querySelector('#reservation-filter').value); portalNotice('Не удалось загрузить бронирования', 'error'); return false; });
  document.querySelector('#reservation-filter').addEventListener('input', (event) => draw(event.target.value)); document.querySelector('#reservation-list-date')?.addEventListener('input', () => draw(document.querySelector('#reservation-filter').value));
  document.querySelector('#reservation-list')?.addEventListener('click', async (event) => {
    const openOrderButton = event.target.closest('[data-reservation-open-order]');
    if (openOrderButton) {
      const reservation = reservations.find((item) => item.id === openOrderButton.dataset.reservationOpenOrder);
      if (!reservation) return;
      if (reservation.linkedOrderId) { window.location.assign('/?order=' + encodeURIComponent(reservation.linkedOrderId)); return; }
      openOrderButton.disabled = true;
      try {
        const order = await api('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId: reservation.tableId, reservationId: reservation.id, guestId: reservation.guestId || null }) });
        window.location.assign('/?order=' + encodeURIComponent(order.id));
      } catch (error) {
        const reason = error.payload?.error || '';
        portalNotice(reason === 'reservation_already_linked' ? 'Для этой брони уже открыт заказ. Обновите список.' : reason === 'open_shift_required' ? 'Для начала визита откройте кассовую смену' : 'Не удалось открыть заказ по брони', 'error');
        openOrderButton.disabled = false;
        load();
      }
      return;
    }
    const button = event.target.closest('[data-reservation-prepayment]');
    if (!button || button.disabled) return;
    const reservation = reservations.find((item) => item.id === button.dataset.reservationPrepayment);
    if (!reservation) return;
    const required = Number(reservation.depositRequired ?? reservation.deposit ?? 0);
    const remaining = Math.max(0, required - Number(reservation.verifiedDepositPaid || 0));
    const data = await portalAction({ title: 'Предоплата по брони', description: `Гость: ${reservation.guestName}. Остаток требования: ${money(remaining)}. Предоплата не считается выручкой заказа.`, submitLabel: 'Принять оплату', fields: [{ name: 'amount', label: 'Сумма', type: 'number', min: 0.01, max: remaining, step: 0.01, value: remaining }, { name: 'method', label: 'Способ оплаты', type: 'select', value: 'cash', options: [{ value: 'cash', label: 'Наличные' }, { value: 'card', label: 'Карта' }, { value: 'qr', label: 'QR' }] }, { name: 'reason', label: 'Комментарий', type: 'textarea', value: 'Предоплата по бронированию', required: false }] });
    if (!data) return;
    const payload = { amount: Number(data.amount), method: data.method, reason: data.reason || 'Предоплата по бронированию' };
    const fingerprint = JSON.stringify(payload);
    if (button.dataset.pendingFingerprint !== fingerprint) { button.dataset.pendingFingerprint = fingerprint; button.dataset.idempotencyKey = crypto.randomUUID(); }
    button.disabled = true;
    try {
      const result = await api(`/api/reservations/${encodeURIComponent(reservation.id)}/deposit-receipts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, idempotencyKey: button.dataset.idempotencyKey }) });
      portalNotice(`Предоплата ${money(result.receipt?.amount ?? payload.amount)} принята`, 'success');
      load();
    } catch (error) {
      const reason = String(error.payload?.error || error.message || '');
      portalNotice(reason === 'open_shift_required' ? 'Для приёма оплаты откройте кассовую смену' : reason === 'reservation_legacy_pre_payment_unreconciled' ? 'Сначала сверьте старую сумму депозита по брони' : reason === 'reservation_pre_payment_exceeds_required' ? 'Сумма больше остатка требования по брони' : reason === 'reservation_not_confirmed' ? 'Оплата доступна только для подтверждённой брони' : 'Не удалось принять предоплату', 'error');
      button.disabled = false;
    }
  });
  document.querySelector('#reservation-list')?.addEventListener('click', async (event) => {
    const allocationButton = event.target.closest('[data-reservation-allocation-reversal]');
    if (allocationButton && !allocationButton.disabled) {
      const amount = Number(allocationButton.dataset.allocationAmount);
      const data = await portalAction({ title: 'Вернуть зачёт предоплаты', description: `Сумма ${money(amount)} вернётся в доступный остаток брони. Это внутреннее сторно: кассу и выручку оно не меняет. Доступно только пока заказ открыт.`, submitLabel: 'Сторнировать зачёт', fields: [{ name: 'reason', label: 'Причина', type: 'textarea', value: 'Отмена зачёта предоплаты', required: true }] });
      if (!data) return;
      allocationButton.disabled = true;
      try { await api(`/api/reservations/${encodeURIComponent(allocationButton.dataset.reservationAllocationReversal)}/prepayment-allocations/${encodeURIComponent(allocationButton.dataset.allocationId)}/reversals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount, reason: data.reason, idempotencyKey: crypto.randomUUID() }) }); portalNotice('Зачёт возвращён в доступный остаток брони', 'success'); load(); }
      catch (error) { allocationButton.disabled = false; const code = error.payload?.error; portalNotice(code === 'order_already_final' ? 'Заказ уже закрыт; для него нужен отдельный возврат продажи' : code === 'open_shift_required' ? 'Откройте смену для аудита сторно' : 'Не удалось вернуть зачёт предоплаты', 'error'); }
      return;
    }
    const refundButton = event.target.closest('[data-reservation-receipt-refund]');
    if (refundButton && !refundButton.disabled && canRefundReservationPrepayment) {
      const maximum = Number(refundButton.dataset.receiptAvailable);
      const data = await portalAction({ title: 'Возврат предоплаты', description: `Доступно к возврату ${money(maximum)}. Сначала нужно сторнировать весь зачёт этой квитанции. Возврат наличными уменьшит кассу текущей смены.`, submitLabel: 'Подтвердить возврат', fields: [{ name: 'amount', label: 'Сумма', type: 'number', min: 0.01, max: maximum, step: 0.01, value: maximum }, { name: 'method', label: 'Фактический способ выплаты', type: 'select', value: 'cash', options: [{ value: 'cash', label: 'Наличные' }, { value: 'card', label: 'На карту' }, { value: 'qr', label: 'Через QR' }] }, { name: 'reason', label: 'Причина', type: 'textarea', value: 'Возврат предоплаты по брони', required: true }] });
      if (!data) return;
      const reservationId = refundButton.dataset.reservationReceiptRefund;
      const receiptId = refundButton.dataset.receiptId;
      const refundStorageKey = `crm:pending-reservation-refund:${reservationId}:${receiptId}`;
      const fingerprint = JSON.stringify({ amount: Number(data.amount), method: String(data.method), reason: String(data.reason).trim() });
      let pendingIntent = null;
      try { pendingIntent = JSON.parse(localStorage.getItem(refundStorageKey) || 'null'); } catch {}
      if (pendingIntent?.completed === true) pendingIntent = null;
      if (!pendingIntent && refundButton.dataset.refundFingerprint && refundButton.dataset.refundIdempotencyKey) pendingIntent = { fingerprint: refundButton.dataset.refundFingerprint, idempotencyKey: refundButton.dataset.refundIdempotencyKey, availableBefore: Number(refundButton.dataset.refundAvailableBefore) };
      if (pendingIntent && pendingIntent.fingerprint !== fingerprint) {
        refundButton.disabled = false;
        if (await load()) {
          try { localStorage.removeItem(refundStorageKey); } catch {}
          delete refundButton.dataset.refundFingerprint;
          delete refundButton.dataset.refundIdempotencyKey;
          delete refundButton.dataset.refundAvailableBefore;
          portalNotice('Бронь обновлена. Проверьте доступный остаток и повторите возврат.', 'info');
        }
        return;
      }
      const refundIntent = pendingIntent || { fingerprint, idempotencyKey: crypto.randomUUID(), availableBefore: maximum };
      refundButton.dataset.refundFingerprint = refundIntent.fingerprint;
      refundButton.dataset.refundIdempotencyKey = refundIntent.idempotencyKey;
      refundButton.dataset.refundAvailableBefore = String(refundIntent.availableBefore);
      const serializedIntent = JSON.stringify(refundIntent);
      try {
        localStorage.setItem(refundStorageKey, serializedIntent);
        if (localStorage.getItem(refundStorageKey) !== serializedIntent) throw new Error('refund intent persistence failed');
      } catch {
        refundButton.disabled = false;
        portalNotice('Не удалось сохранить ключ возврата в браузере. Операция не отправлена; проверьте настройки хранения и повторите.', 'error');
        return;
      }
      refundButton.disabled = true;
      try {
        await api(`/api/reservations/${encodeURIComponent(reservationId)}/deposit-receipts/${encodeURIComponent(receiptId)}/reversals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: Number(data.amount), method: data.method, reason: data.reason, idempotencyKey: refundIntent.idempotencyKey }) });
        try {
          localStorage.removeItem(refundStorageKey);
          if (localStorage.getItem(refundStorageKey) !== null) localStorage.setItem(refundStorageKey, '{"completed":true}');
        } catch { try { localStorage.setItem(refundStorageKey, '{"completed":true}'); } catch {} }
        delete refundButton.dataset.refundFingerprint;
        delete refundButton.dataset.refundIdempotencyKey;
        delete refundButton.dataset.refundAvailableBefore;
        portalNotice('Возврат предоплаты записан', 'success'); load();
      }
      catch (error) {
        refundButton.disabled = false;
        if (!error.payload) portalNotice('Ответ о возврате не получен. Повторите возврат с теми же данными — повторный запрос не создаст вторую выплату.', 'error');
        else { const code = error.payload?.error; portalNotice(code === 'reservation_pre_payment_allocation_reversal_required' ? 'Сначала верните зачёт из открытого заказа' : code === 'reservation_pre_payment_refund_exceeds_available' ? `Доступно только ${money(error.payload?.available || 0)}` : code === 'open_shift_required' ? 'Откройте смену для фактической выплаты' : 'Не удалось вернуть предоплату', 'error'); }
      }
      return;
    }
  });
  document.querySelector('#reservation-list')?.addEventListener('click', async (event) => { const retry = event.target.closest('[data-reservation-retry]'); if (retry) { load(); return; } const reset = event.target.closest('[data-reservation-reset]'); if (reset) { const search = document.querySelector('#reservation-filter'); const date = document.querySelector('#reservation-list-date'); if (search) search.value = ''; if (date) date.value = ''; draw(''); return; } const button = event.target.closest('[data-reservation]'); if (!button || button.disabled) return; const reservation = reservations.find((item) => item.id === button.dataset.reservation); if (!await portalConfirm('Отменить бронирование?', reservationCancelPrompt(reservation), 'Отменить бронирование')) return; button.disabled = true; api(`/api/reservations/${button.dataset.reservation}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(() => { portalNotice('Бронирование отменено', 'success'); load(); }).catch((error) => { button.disabled = false; const code=error.payload?.error; portalNotice(code==='reservation_pre_payment_refund_required'?'Сначала верните нераспределённый остаток предоплаты':code==='reservation_pre_payment_already_applied'?'Сначала верните зачёт из открытого заказа':'Не удалось отменить бронирование', 'error'); }); });
  document.querySelector('#focus-reservation')?.addEventListener('click', () => { document.querySelector('#reservation-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); document.querySelector('#reservation-guest')?.focus(); });
  document.querySelector('#reservation-form').addEventListener('submit', (event) => { event.preventDefault(); const form = event.target; if (form.dataset.submitting === '1') return; form.dataset.submitting = '1'; const submit = form.querySelector('button[type="submit"]'); if (submit) { submit.disabled = true; submit.textContent = 'Подтверждение…'; } const controls = [...form.querySelectorAll('input, select, textarea')].map((control) => ({ control, disabled: control.disabled })); controls.forEach(({ control }) => { control.disabled = true; control._customSelectRefresh?.(); }); let reservationSaved = false; const message = document.querySelector('#reservation-message'); const value = { guestName: document.querySelector('#reservation-guest').value.trim(), clientId: document.querySelector('#reservation-client-id').value || null, phone: document.querySelector('#reservation-phone').value.trim(), date: document.querySelector('#reservation-date').value, time: document.querySelector('#reservation-time').value, tableId: document.querySelector('#reservation-table').value, guests: Number(document.querySelector('#reservation-guests').value), deposit: Number(document.querySelector('#reservation-deposit').value), notes: document.querySelector('#reservation-notes').value.trim(), createdByName: portalUser.name || undefined, createdByRole: portalRole[0] || undefined }; api('/api/reservations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }).then(() => { reservationSaved = true; message.textContent = 'Бронь подтверждена'; message.className = 'form-message success-message'; event.target.reset(); document.querySelector('#reservation-date').value = localDateKey(); document.querySelector('#reservation-time').value = '21:00'; load(); }).catch((error) => { const reason = String(error.payload?.error || error.message || ''); message.className = 'form-message error-message'; message.textContent = reason === 'table_already_reserved' ? 'Этот стол уже занят на выбранное время' : reason.startsWith('vip_deposit_below_minimum') || reason === 'vip_deposit_below_minimum' ? `Для этой VIP-комнаты нужен депозит от ${money(error.payload?.requiredDeposit || Number(reason.split(':')[1] || 0))}` : reason === 'invalid_guest_phone' ? 'Проверьте телефон гостя' : reason === 'invalid_guest_count' ? 'Количество гостей должно быть от 1 до 50' : reason === 'invalid_reservation_datetime' ? 'Проверьте дату и время бронирования' : reason === 'guest_name_too_long' ? 'Имя гостя должно быть до 120 символов' : reason === 'reservation_notes_too_long' ? 'Комментарий должен быть до 2000 символов' : reason === 'table_unavailable' ? 'Это место закрыто для бронирований' : reason === 'table_capacity_exceeded' ? `Для этого места максимум ${error.payload?.maximumGuests || 0} гостей. Выберите другое место или уменьшите число гостей.` : 'Не удалось создать бронь'; }).finally(() => { controls.forEach(({ control, disabled }) => { control.disabled = disabled; control._customSelectRefresh?.(); }); form.dataset.submitting = '0'; if (submit) { submit.disabled = false; submit.textContent = 'Подтвердить бронь'; } if (reservationSaved) loadTables(); }); });
  api('/api/clients').then((data) => {
    const list = document.querySelector('#reservation-guests-list');
    const clients = data.items || [];
    const baseName = (client) => `${client.name}${client.nickname ? ` — ${client.nickname}` : ''}`;
    const firstPhone = (client) => (client.phoneNumbers || []).map((item) => item.number).join(',').split(',')[0] || '';
    const nameCounts = new Map();
    clients.forEach((client) => nameCounts.set(baseName(client), (nameCounts.get(baseName(client)) || 0) + 1));
    const reservedNames = new Set(clients.map(baseName));
    const usedChoices = new Set();
    const choices = clients.map((client, index) => {
      let value = nameCounts.get(baseName(client)) > 1 ? `${baseName(client)} · ${firstPhone(client) || 'без телефона'} · №${index + 1}` : baseName(client);
      while (usedChoices.has(value) || (value !== baseName(client) && reservedNames.has(value))) value += ` · №${index + 1}`;
      usedChoices.add(value);
      return { client, value };
    });
    if (list) list.innerHTML = choices.map(({ client, value }) => `<option value="${esc(value)}" label="${esc(firstPhone(client) || 'Телефон не указан')}" data-client-id="${esc(client.id)}"></option>`).join('');
    const guest = document.querySelector('#reservation-guest');
    const phone = document.querySelector('#reservation-phone');
    let autoFilledPhone = '';
    guest?.addEventListener('input', () => {
      const value = guest.value;
      const selected = choices.find((choice) => choice.value === value);
      const matches = selected ? [selected.client] : clients.filter((entry) => value === entry.name || value === baseName(entry) || value === entry.nickname);
      const client = matches.length === 1 ? matches[0] : null;
      const hint = document.querySelector('#reservation-guest-match-hint');
      if (hint) hint.textContent = matches.length > 1 ? 'Несколько гостей с таким именем. Выберите нужную карточку из списка.' : 'Выберите гостя из списка или введите разового гостя';
      if (client) {
        document.querySelector('#reservation-client-id').value = client.id;
        const nextPhone = firstPhone(client);
        if (!phone.value || phone.value === autoFilledPhone) { phone.value = nextPhone; autoFilledPhone = nextPhone; }
        if (selected) guest.value = client.name;
      } else {
        document.querySelector('#reservation-client-id').value = '';
        if (autoFilledPhone && phone.value === autoFilledPhone) phone.value = '';
        autoFilledPhone = '';
      }
    });
  }).catch(() => {}); loadTables(); load();
}

if (page === 'dashboard' && location.hash === '#loyalty') renderLoyalty();
if (page === 'dashboard' && location.hash !== '#loyalty') { try { renderDashboard(); } catch (error) { const target = document.querySelector('#page-content'); if (target) target.innerHTML = '<div class="panel"><h2>Не удалось загрузить главную страницу</h2><p class="muted">Попробуйте обновить страницу.</p></div>'; } }
if (page === 'orders') renderOrders();
if (page === 'integrations') renderIntegrations();
if (page === 'network') renderNetwork();
if (page === 'delivery') renderDelivery();
if (page === 'clients') renderClients();
if (page === 'inventory') renderInventory();
if (page === 'finance') renderFinance();
if (page === 'finance_categories') renderFinanceCategories();
if (page === 'finance_report') renderFinanceReport();
if (page === 'reservations') renderReservations();
if (page === 'dashboard' && location.hash === '#tasks') renderTasks();

// Cross-page navigation is handled by the browser's View Transition API where
// available. Keep the content entrance animation for in-page/hash changes only.
if (page !== 'dashboard') {
  setupInterfacePreferences();
  setupThemePreference();
}


if(!window.__staffPhoneFieldsLoaded){window.__staffPhoneFieldsLoaded=true;const script=document.createElement('script');script.src='/staff-phone-fields.js?rev=4';document.head.append(script);}
if(!window.__staffAuditLoaded){window.__staffAuditLoaded=true;const script=document.createElement('script');script.src='/staff-audit.js?rev=1';document.head.append(script);}
if(!window.__staffSensitiveLoaded){window.__staffSensitiveLoaded=true;const script=document.createElement('script');script.src='/staff-sensitive-fields.js?rev=5';document.head.append(script);}
if(!window.__staffAdminCardLoaded){const script=document.createElement('script');script.src='/staff-admin-card.js?rev=10';document.head.append(script);}




/* Global Russian phone formatting */
(function mountRussianPhoneFormat(){
  const isPhone=(input)=>input instanceof HTMLInputElement && !input.disabled && (input.type==='tel'||/phone|телефон|mobile|мобиль/i.test(`${input.id} ${input.name}`)||/^\s*\+?7(?:\s|\(|$)/.test(input.placeholder||''));
  const format=(value)=>{
    const raw=String(value||'');
    let digits=raw.replace(/\D/g,'');
    if (!digits) return raw.trim()==='+7' ? '+7 ' : '';
    if (digits[0]==='8') digits=digits.slice(1);
    else if (digits[0]==='7') digits=digits.slice(1);
    digits=digits.slice(0,10);
    const groups=[digits.slice(0,3),digits.slice(3,6),digits.slice(6,8),digits.slice(8,10)].filter(Boolean);
    let result='+7';
    if(groups[0]) result+=` (${groups[0]}`+(groups[0].length===3?') ':'');
    if(groups[1]) result+=groups[1];
    if(groups[2]) result+=`-${groups[2]}`;
    if(groups[3]) result+=`-${groups[3]}`;
    return result;
  };
  const mount=()=>document.querySelectorAll('input').forEach((input)=>{
    if(!isPhone(input)||input.dataset.ruPhoneReady==='1') return;
    input.dataset.ruPhoneReady='1'; input.inputMode='tel'; input.autocomplete=input.autocomplete||'tel';
    const apply=()=>{const before=input.value;const next=format(before);if(next!==before){const end=input.selectionStart===before.length;input.value=next;if(end)input.setSelectionRange(next.length,next.length);}};
    input.addEventListener('focus',()=>{if(!input.value.trim()) input.value='+7 ';});
    input.addEventListener('input',apply); input.addEventListener('paste',()=>setTimeout(apply,0));
    input.addEventListener('blur',()=>{apply();if(input.value.trim()==='+7')input.value='';}); apply();
  });
  mount(); new MutationObserver(mount).observe(document.body,{childList:true,subtree:true});
})();
