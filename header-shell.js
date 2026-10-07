(() => {
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

