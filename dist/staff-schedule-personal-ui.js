/* Published personal schedule. This renderer has no management or write requests. */
(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const kinds = { shift: 'Смена', day_off: 'Выходной', vacation: 'Отпуск', sick: 'Больничный', other_absence: 'Отсутствие' };
  const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0,10) === value;
  const addDays = (day, count) => new Date(Date.parse(day + 'T12:00:00Z') + count * 86400000).toISOString().slice(0,10);
  const dayLabel = day => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'long' }).format(new Date(day + 'T12:00:00Z'));
  function localTime(value, timezone) {
    const instant = new Date(value);
    if (!Number.isFinite(instant.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
    const get = key => parts.find(part => part.type === key).value;
    return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
  }
  function periodBounds(day, mode) {
    if (mode === 'day') return [day, day];
    if (mode === 'week') {
      const weekday = new Date(day + 'T12:00:00Z').getUTCDay();
      const from = addDays(day, -((weekday + 6) % 7));
      return [from, addDays(from,6)];
    }
    const from = day.slice(0,7) + '-01';
    const next = new Date(from + 'T12:00:00Z'); next.setUTCMonth(next.getUTCMonth() + 1);
    return [from, addDays(next.toISOString().slice(0,10),-1)];
  }
  function occursOn(entry, day, timezone) {
    if (entry.kind !== 'shift') return entry.workDate === day;
    if (!entry.plannedStart || !entry.plannedEnd || Date.parse(entry.plannedEnd) <= Date.parse(entry.plannedStart)) return entry.workDate === day;
    const start = localTime(entry.plannedStart, timezone);
    const last = localTime(Date.parse(entry.plannedEnd) - 1, timezone);
    return !!start && !!last && start.date <= day && last.date >= day;
  }
  function describeEntry(entry, day, timezone) {
    if (entry.kind !== 'shift') return { time: kinds[entry.kind] || 'Запись графика', detail: '', full: kinds[entry.kind] || 'Запись графика', carry: false };
    const start = entry.plannedStart && localTime(entry.plannedStart, timezone);
    const end = entry.plannedEnd && localTime(entry.plannedEnd, timezone);
    if (!start || !end || Date.parse(entry.plannedEnd) <= Date.parse(entry.plannedStart)) return { time: 'Время требует уточнения', detail: '', full: 'Время требует уточнения', carry: false };
    const carry = start.date < day;
    return { time: carry ? `↳ до ${end.time}` : `${start.time}–${end.time}`, detail: !carry && start.date !== end.date ? '+1 день' : '', full: `${carry ? 'Продолжение ночной смены · ' : ''}${start.date} ${start.time} — ${end.date} ${end.time} · ${timezone}`, carry };
  }
  window.mountStaffSchedulePersonal = async (target, { access } = {}) => {
    const token = localStorage.getItem('crm_session_token');
    const mountKey = {};
    target._schedulePersonalMount = mountKey;
    const alive = () => target.isConnected && target._schedulePersonalMount === mountKey && location.hash === '#staff-schedule' && localStorage.getItem('crm_session_token') === token;
    target.classList.add('schedule-page', 'schedule-personal-page', 'ui-components');
    document.body.classList.add('schedule-route');
    if (access?.self !== true || access.view) { target.innerHTML = '<p role="alert">Личный график недоступен.</p>'; return; }
    let timezone = access.timezone, date, mode = 'month', generation = 0, ready = false, selfUserId = null;
    let items = [], team = [];
    try { if (typeof timezone !== 'string' || !timezone) throw new Error('timezone_missing'); date = localTime(new Date(), timezone).date; }
    catch { target.innerHTML = '<p role="alert">Не удалось определить часовой пояс заведения.</p>'; return; }
    target.innerHTML = `<div class="schedule-heading"><div><h1>Мой график</h1><p class="muted">Опубликованные смены. Только просмотр.</p></div></div>
      <section class="panel schedule-personal-panel"><div class="schedule-commandbar schedule-toolbar">
        <div class="schedule-period"><button type="button" class="button" data-personal-prev aria-label="Предыдущий период">←</button><span class="schedule-period-title" data-personal-period></span><button type="button" class="button" data-personal-next aria-label="Следующий период">→</button><button type="button" class="button" data-personal-today>Сегодня</button></div>
        <div class="schedule-view-tabs" role="group" aria-label="Вид личного графика">${[['day','День'],['week','Неделя'],['month','Месяц']].map(([value,label]) => `<button type="button" class="button" data-personal-view="${value}" aria-pressed="${value === mode}">${label}</button>`).join('')}</div>
      </div><p data-personal-status role="status" aria-live="polite"></p><button type="button" class="button" data-personal-retry hidden>Повторить загрузку</button>
      <p class="schedule-personal-instruction muted">Выберите дату — ниже ваши смены и коллеги</p><div class="schedule-personal-calendar" data-personal-calendar></div><section class="schedule-personal-day" data-personal-day aria-label="Выбранный день"></section></section>`;
    const q = selector => target.querySelector(selector);
    function syncControls() {
      const [from,to] = periodBounds(date,mode);
      q('[data-personal-period]').textContent = mode === 'month' ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(date + 'T12:00:00Z')) : from === to ? dayLabel(from) : `${dayLabel(from)} — ${dayLabel(to)}`;
      target.querySelectorAll('[data-personal-prev],[data-personal-next],[data-personal-today],[data-personal-view]').forEach(control => { control.disabled = !ready; });
      target.querySelectorAll('[data-personal-view]').forEach(control => control.setAttribute('aria-pressed', String(control.dataset.personalView === mode)));
    }
    const ownOn = day => items.filter(entry => occursOn(entry,day,timezone));
    const teamOn = day => team.filter(entry => occursOn(entry,day,timezone));
    function entryCard(entry, mine) {
      const description = describeEntry(entry,date,timezone);
      return `<article class="schedule-personal-entry ${mine ? 'schedule-personal-mine' : 'schedule-personal-coworker'} schedule-kind-${esc(entry.kind)}" title="${esc(description.full)}"><div class="schedule-person-identity"><strong class="schedule-person-name">${esc(entry.userName || (mine ? 'Моя запись' : 'Сотрудник'))}</strong>${mine ? '<span class="schedule-personal-mine-label">Моя запись</span>' : ''}</div><span class="schedule-entry-time">${esc(description.time)}</span>${description.detail ? `<span class="schedule-entry-next-day">${description.detail}</span>` : ''}${entry.functionName ? `<span class="schedule-entry-detail">${esc(entry.functionName)}</span>` : ''}${mine && entry.kind === 'shift' && entry.breakMinutes > 0 ? `<span class="schedule-entry-detail">Перерыв: ${entry.breakMinutes} мин</span>` : ''}</article>`;
    }
    function render() {
      if (!alive() || !ready) return;
      syncControls();
      const [from,to] = periodBounds(date,mode), today = localTime(new Date(),timezone).date;
      const days = []; for (let day=from; day<=to; day=addDays(day,1)) days.push(day);
      const offset = mode === 'month' ? (new Date(from + 'T12:00:00Z').getUTCDay()+6)%7 : 0;
      q('[data-personal-calendar]').innerHTML = mode === 'day' ? '' : `<div class="${mode === 'month' ? 'schedule-month schedule-days' : 'schedule-personal-week'}">${mode === 'month' ? ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(label => `<span class="schedule-weekday">${label}</span>`).join('') : ''}${Array.from({length:offset},()=>'<span aria-hidden="true"></span>').join('')}${days.map(day => {
        const own = ownOn(day);
        const accessibleEntries = own.map(entry => {
          const kind = kinds[entry.kind] || 'Запись графика';
          return entry.kind === 'shift' ? `${kind}: ${describeEntry(entry,day,timezone).full}` : kind;
        }).join('; ');
        return `<button type="button" class="schedule-month-day schedule-personal-date ${day === date ? 'is-selected is-selected-date' : ''} ${day === today ? 'is-today' : ''} ${own.length ? 'has-own-entries' : ''}" data-personal-date="${day}" aria-pressed="${day === date}"${day === today ? ' aria-current="date"' : ''} aria-label="${esc(dayLabel(day))}, моих записей: ${own.length}${accessibleEntries ? '. ' + esc(accessibleEntries) : '. Нет опубликованных записей'}"><strong>${mode === 'month' ? Number(day.slice(-2)) : esc(dayLabel(day))}</strong>${own.slice(0,3).map(entry => { const description=describeEntry(entry,day,timezone); return `<span class="schedule-personal-calendar-entry schedule-personal-mine schedule-kind-${esc(entry.kind)}"><span class="schedule-personal-mine-label">Моя</span> <span class="schedule-entry-time">${esc(description.time)}</span>${description.detail ? `<span class="schedule-entry-next-day">${description.detail}</span>` : ''}</span>`; }).join('') || '<span class="schedule-cell-empty">Нет моих смен</span>'}${own.length > 3 ? `<span class="schedule-month-more">Ещё ${own.length-3}</span>` : ''}</button>`;
      }).join('')}</div>`;
      q('[data-personal-calendar]').querySelectorAll('[data-personal-date]').forEach(button => button.onclick = () => { date=button.dataset.personalDate; render(); q(`[data-personal-date="${date}"]`)?.focus({preventScroll:true}); });
      const own = ownOn(date), coworkers = teamOn(date);
      q('[data-personal-day]').innerHTML = `<h2>${esc(dayLabel(date))}</h2><section class="schedule-personal-own"><h3>Мои смены и записи</h3>${own.map(entry => entryCard(entry,true)).join('') || '<p>На этот день у вас нет опубликованных смен или отсутствий.</p>'}</section><section class="schedule-personal-team"><h3>Коллеги на смене</h3><p class="muted">Опубликованные смены коллег на выбранный день.</p>${coworkers.map(entry => entryCard(entry,false)).join('') || '<p>На этот день нет опубликованных смен коллег.</p>'}</section>`;
    }
    async function load() {
      const current = ++generation;
      ready = false; items = []; team = [];
      q('[data-personal-calendar]').replaceChildren(); q('[data-personal-day]').replaceChildren();
      q('[data-personal-status]').textContent = 'Загрузка опубликованного графика…';
      q('[data-personal-retry]').hidden = true; syncControls();
      const [from,to] = periodBounds(date,mode);
      try {
        const response = await fetch(`/api/staff/schedule/personal?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { method:'GET', cache:'no-store', headers:{Authorization:`Bearer ${token}`} });
        if (!alive() || current !== generation) return;
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Доступ к личному графику недоступен или отозван.' : 'Не удалось загрузить личный график.');
        const result = await response.json();
        if (!alive() || current !== generation) return;
        if (!result || typeof result.selfUserId !== 'string' || !result.selfUserId || result.from !== from || result.to !== to || !Array.isArray(result.items) || !Array.isArray(result.team) || typeof result.timezone !== 'string' || !result.timezone) throw new Error('Получен неполный ответ личного графика.');
        const expectedUser = access.selfUserId || access.userId || selfUserId;
        if (expectedUser && expectedUser !== result.selfUserId) throw new Error('Пользователь личного графика изменился. Обновите страницу.');
        localTime(new Date(),result.timezone);
        timezone = result.timezone; selfUserId = result.selfUserId;
        const own = result.items.filter(entry => entry && entry.userId === selfUserId && Object.hasOwn(kinds,entry.kind) && validDay(entry.workDate) && (!entry.status || entry.status === 'planned'));
        const others = result.team.filter(entry => entry && typeof entry.userId === 'string' && entry.userId !== selfUserId && (!entry.kind || entry.kind === 'shift') && (!entry.status || entry.status === 'planned') && validDay(entry.workDate) && entry.plannedStart && entry.plannedEnd && Number.isFinite(Date.parse(entry.plannedStart)) && Date.parse(entry.plannedEnd) > Date.parse(entry.plannedStart));
        const project = (entry,mine) => ({ id:entry.id,userId:entry.userId,userName:entry.userName,workDate:entry.workDate,plannedStart:entry.plannedStart,plannedEnd:entry.plannedEnd,kind:mine?entry.kind:'shift',functionName:entry.functionName,breakMinutes:mine&&Number.isFinite(Number(entry.breakMinutes))?Math.max(0,Number(entry.breakMinutes)):0 });
        const order = (a,b) => a.workDate.localeCompare(b.workDate) || String(a.plannedStart||'').localeCompare(String(b.plannedStart||'')) || String(a.userName||'').localeCompare(String(b.userName||''),'ru');
        items = own.map(entry => project(entry,true)).sort(order); team = others.map(entry => project(entry,false)).sort(order);
        ready = true; render();
        q('[data-personal-status]').textContent = `Часовой пояс: ${timezone}. ${items.length ? 'Опубликованный график загружен.' : 'В выбранном периоде у вас нет опубликованных записей.'}`;
      } catch (error) {
        if (!alive() || current !== generation) return;
        ready = false; items = []; team = [];
        q('[data-personal-calendar]').replaceChildren(); q('[data-personal-day]').replaceChildren();
        q('[data-personal-status]').textContent = error.message;
        q('[data-personal-retry]').hidden = false;
      } finally { if (alive() && current === generation) syncControls(); }
    }
    const move = step => {
      if (!ready) return;
      if (mode === 'month') { const next=new Date(date.slice(0,7)+'-01T12:00:00Z'); next.setUTCMonth(next.getUTCMonth()+step); date=next.toISOString().slice(0,10); }
      else date=addDays(date,step*(mode==='week'?7:1));
      load();
    };
    q('[data-personal-prev]').onclick = () => move(-1);
    q('[data-personal-next]').onclick = () => move(1);
    q('[data-personal-today]').onclick = () => { if (!ready) return; date=localTime(new Date(),timezone).date; load(); };
    q('[data-personal-retry]').onclick = load;
    target.querySelectorAll('[data-personal-view]').forEach(button => button.onclick = () => { if (!ready) return; mode=button.dataset.personalView; load(); });
    await load();
  };
})();
