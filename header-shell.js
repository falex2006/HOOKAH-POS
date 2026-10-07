(() => {
  const sidebar = document.querySelector('.portal-sidebar');
  if (sidebar && sidebar.dataset.menuReady !== 'true') {
    const groups = [
      ['Главное', [['Главная', '/admin', 'layout-dashboard', 'dashboard']]],
      ['Операции', [['Рабочий зал', '/', 'home', 'floor'], ['Заказы', '/orders', 'clipboard-list', 'orders'], ['Гости', '/clients', 'users', 'staff_view'], ['Бронирования', '/reservations', 'calendar-event', 'reservations'], ['Доставка', '/delivery', 'truck-delivery', 'delivery']]],
      ['Меню', [['Каталог товаров', '/inventory?view=products', 'package', 'inventory_read'], ['Технологические карты', '/inventory?view=recipes', 'file-text', 'inventory_read']]],
      ['Склад', [['Остатки', '/inventory?view=stock', 'package', 'inventory_read'], ['Пополнение запасов', '/inventory?view=auto-orders', 'shopping-cart', 'inventory_read'], ['Поставки и списания', '/inventory?view=movements', 'arrows-exchange', 'inventory_manage'], ['Заготовки и премиксы', '/inventory?view=premixes', 'flask', 'inventory_read'], ['Цеха и категории', '/inventory?view=directories', 'category', 'inventory_manage']]],
      ['Финансы', [['Обзор финансов', '/finance', 'cash', 'finance_read'], ['Зарплата', '/finance#payroll', 'receipt-2', 'finance_read'], ['Отчёты', '/finance/report', 'chart-bar', 'finance_read'], ['Категории доходов и расходов', '/finance/categories', 'list-details', 'finance_read']]],
      ['Команда', [['Персонал', '/admin#staff', 'users', 'staff_view'], ['Роли и права доступа', '/admin#permissions', 'shield-lock', 'staff_manage'], ['Задачи', '/admin#tasks', 'checklist', 'orders']]],
      ['Система', [['Система лояльности', '/admin#loyalty', 'heart', 'settings'], ['Настройки заведения', '/admin#company', 'building-store', 'settings'], ['Настройки модулей', '/admin#settings-dashboard-modules', 'adjustments', 'settings'], ['Безопасность', '/admin#lock-security', 'lock', 'settings'], ['Интеграции', '/integrations', 'plug', 'integrations'], ['Моя сеть', '/network', 'building', 'settings'], ['Диагностика', '/admin#diagnostics', 'tool', 'diagnostics']]],
    ];
    const brand = sidebar.querySelector('.brand');
    const footer = sidebar.querySelector('.sidebar-footer');
    const logout = sidebar.querySelector('.logout-button');
    sidebar.querySelectorAll('.side-label, .portal-nav, [data-staff-nav]').forEach((node) => node.remove());
    const current = `${location.pathname}${location.search}${location.hash}`;
    const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="/assets/tabler-icons.svg#${name}"></use></svg>`;
    groups.forEach(([label, items]) => {
      const heading = document.createElement('div'); heading.className = 'side-label'; heading.textContent = label;
      const nav = document.createElement('nav'); nav.className = 'portal-nav';
      items.forEach(([text, href, glyph, permission]) => {
        const link = document.createElement('a'); link.href = href; link.dataset.permission = permission;
        link.innerHTML = `${icon(glyph)}<span>${text}</span>`;
        const target = new URL(href, location.origin);
        const samePath = target.pathname === location.pathname;
        const sameHash = target.hash && target.hash === location.hash;
        const inventoryView = target.searchParams.get('view') && target.search === location.search;
        if ((samePath && (!target.hash || sameHash) && (!target.search || inventoryView)) || href === '/admin' && location.pathname === '/admin' && !location.hash) link.classList.add('active');
        nav.append(link);
      });
      sidebar.insertBefore(heading, footer || logout); sidebar.insertBefore(nav, footer || logout);
    });
    sidebar.dataset.menuReady = 'true';
  }
  const header = document.querySelector('.portal-header');
  if (!header || header.dataset.shellReady === 'true') return;

  const context = [...header.children].find((node) => !node.matches('.header-right, .header-user'));
  if (!context) return;
  context.classList.add('header-context');

  let actions = header.querySelector('.header-right');
  if (!actions) {
    actions = document.createElement('div');
    actions.className = 'header-right';
    header.append(actions);
  }

  const profile = header.querySelector('.header-user');
  if (profile && profile.parentElement !== actions) actions.append(profile);

  let bell = actions.querySelector('#notification-bell');
  if (!bell) {
    bell = document.createElement('button');
    bell.type = 'button';
    bell.className = 'notification-bell';
    bell.id = 'notification-bell';
    bell.innerHTML = '<svg class="icon" aria-hidden="true"><use href="/assets/tabler-icons.svg#bell"></use></svg><span id="notification-count" hidden>0</span>';
    actions.prepend(bell);
  }
  bell.setAttribute('aria-label', 'Уведомления');
  bell.title = 'Уведомления';

  let shift = actions.querySelector('.live-dot');
  if (!shift) {
    shift = document.createElement('span');
    shift.className = 'live-dot';
    actions.append(shift);
  }
  shift.classList.add('header-shift-status');
  shift.dataset.shiftState = 'loading';
  shift.setAttribute('role', 'status');
  shift.setAttribute('aria-live', 'polite');
  shift.textContent = 'Проверяем смену…';

  let date = actions.querySelector('[data-current-date]');
  if (!date) {
    date = document.createElement('span');
    date.dataset.currentDate = '';
    actions.append(date);
  }
  date.classList.add('header-date');

  const ordered = [
    bell,
    shift,
    date,
    ...(profile ? [profile] : []),
  ];
  actions.replaceChildren(...ordered);
  header.dataset.shellReady = 'true';

  try {
    const user = JSON.parse(localStorage.getItem('crm_session_user') || '{}');
    if (!['owner', 'admin', 'manager', 'developer'].includes(user.role)) bell.hidden = true;
  } catch (_) {
    bell.hidden = true;
  }
})();
