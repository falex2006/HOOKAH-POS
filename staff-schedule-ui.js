/* Standalone route renderer; no dashboard requests or global layout changes. */
(() => {
  const labels = { shift: 'Смена', day_off: 'Выходной', vacation: 'Отпуск', sick: 'Больничный', other_absence: 'Отсутствие' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const planMinutes = entry => {
    const duration = (Date.parse(entry.plannedEnd) - Date.parse(entry.plannedStart)) / 60000;
    const pause = Number(entry.breakMinutes || 0);
    return Number.isInteger(duration) && duration > 0 && duration <= 1440 && Number.isInteger(pause) && pause >= 0 && pause < duration ? duration - pause : null;
  };
  function local(instant, timezone) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
    const get = key => p.find(x => x.type === key).value;
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
  }
  function instant(value, timezone) {
    const guess = Date.parse(value + 'Z');
    if (!Number.isFinite(guess)) throw new Error('Укажите дату и время.');
    const offsets = new Set();
    for (const hours of [-36, -12, 0, 12, 36]) {
      const sample = guess + hours * 3600000;
      offsets.add(Date.parse(local(sample, timezone) + 'Z') - sample);
    }
    const matches = [...offsets].map(offset => guess - offset).filter(ms => local(ms, timezone) === value);
    if (matches.length !== 1) throw new Error(matches.length ? 'Время неоднозначно из-за перевода часов. Выберите другое время.' : 'Такого местного времени не существует. Проверьте перевод часов.');
    return new Date(matches[0]).toISOString().replace('.000Z', 'Z');
  }
  const messages = { schedule_overlap: 'Есть пересекающаяся смена или отсутствие.', schedule_version_conflict: 'Запись уже изменена. Закройте редактор и обновите график; ваши значения пока сохранены в форме.', schedule_forbidden: 'Доступ отозван или недостаточно прав.', schedule_past_reason_required: 'Для изменения прошлого периода укажите причину.', schedule_employee_unavailable: 'Сотрудник недоступен для назначения.', schedule_duration_invalid: 'Смена должна длиться больше 0 и не больше 24 часов.', schedule_break_invalid: 'Перерыв должен быть короче смены.', schedule_grant_conflict: 'Права уже изменены. Обновите список.' };
  window.mountStaffSchedule = async target => {
    messages.schedule_plan_incomplete = 'Сначала уточните время исходной смены.';
    const token = localStorage.getItem('crm_session_token');
    let generation = 0, employees = [], entries = [], actual = [], access, date, mode = 'week', ready = false, initialized = false;
    const roleNames = { owner: 'Владелец', admin: 'Администратор', manager: 'Управляющий', bartender: 'Бармен', waiter: 'Официант', hookah: 'Кальянный мастер' };
    const alive = () => target.isConnected && location.hash === '#staff-schedule' && localStorage.getItem('crm_session_token') === token;
    async function api(suffix = '', method = 'GET', input) {
      const response = await fetch('/api/staff/schedule' + suffix, { method, cache: 'no-store', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input) });
      const result = await response.json();
      if (!response.ok) { const error = new Error(messages[result.error] || `Не удалось выполнить действие (${result.error || response.status}).`); error.code = result.error; throw error; }
      if (!alive()) throw new Error('Контекст страницы изменился.');
      return result;
    }
    target.classList.add('schedule-page', 'ui-components');
    document.body.classList.add('schedule-route');
    target.innerHTML = `<div class="schedule-heading"><div><h1>График сотрудников</h1><p class="muted">План работы команды. Не заменяет учёт фактически отработанного времени.</p></div><button class="button primary" data-create hidden>Назначить смену</button></div>
      <section class="panel"><div class="schedule-toolbar"><div class="schedule-period"><button class="button" data-prev aria-label="Предыдущий период">←</button><label>Дата<input type="date" data-date></label><button class="button" data-next aria-label="Следующий период">→</button><button class="button" data-today>Сегодня</button></div><label>Вид<select data-mode><option value="week">Неделя</option><option value="month">Месяц</option><option value="day">День</option><option value="list">Список</option></select></label></div><details class="schedule-tools"><summary>Фильтры и действия</summary><div class="schedule-toolbar"><label>Сотрудник<select data-person><option value="">Все сотрудники</option></select></label><label>Поиск<input type="search" data-search placeholder="Имя сотрудника"></label><label>Должность<select data-role><option value="">Все должности</option></select></label><label class="schedule-check"><input type="checkbox" data-cancelled>Показывать отменённые</label><button class="button" data-refresh>Обновить</button><button class="button" data-grants hidden>Доступ к графику</button></div></details><div data-summary class="schedule-summary"></div><details class="schedule-explanation"><summary>Как считаются часы</summary><p data-context class="muted"></p></details><p data-status role="status" aria-live="polite">Загрузка графика…</p><div data-grid></div></section>`;
    const q = s => target.querySelector(s);
    q('[data-today]').parentElement.after(q('[data-today]'));
    const explanation = q('[data-context]').parentElement;
    explanation.before(q('[data-context]'));
    q('[data-context]').classList.add('schedule-context-short');
    const explanationText = document.createElement('p'); explanation.append(explanationText);
    q('.schedule-tools').open = window.innerWidth > 1100;
    const compactQuery=window.matchMedia('(max-width:1100px)');
    compactQuery.addEventListener('change',event=>{if(alive())q('.schedule-tools').open=!event.matches;});
    const status = text => { if (alive()) q('[data-status]').textContent = text; };
    const dayName = day => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(day + 'T12:00Z'));
    function bounds() {
      if (mode === 'day') return [date, date];
      if (mode === 'month') { const from = date.slice(0, 7) + '-01'; const next = new Date(from + 'T12:00Z'); next.setUTCMonth(next.getUTCMonth() + 1); return [from, addDays(next.toISOString().slice(0, 10), -1)]; }
      const weekday = new Date(date + 'T12:00Z').getUTCDay();
      const from = addDays(date, -((weekday + 6) % 7)); return [from, addDays(from, 6)];
    }
    function onDay(entry, day) {
      if (entry.workDate === day) return true;
      return entry.status === 'planned' && entry.kind === 'shift' && entry.plannedStart && entry.plannedEnd
        && local(entry.plannedStart, access.timezone).slice(0,10) < day
        && local(new Date(Date.parse(entry.plannedEnd) - 1), access.timezone).slice(0,10) >= day;
    }
    const hours = minutes => `${(minutes / 60).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ч`;
    function card(entry, day = entry.workDate) {
      if (entry.kind === 'shift' && planMinutes(entry) === null) return `<button class="schedule-entry" data-entry="${esc(entry.id)}"><b>Время требует уточнения</b><small>${entry.status === 'cancelled' ? 'Отменена' : 'Неполный план · часы не учтены'}</small></button>`;
      const text = entry.kind === 'shift' ? `${local(entry.plannedStart, access.timezone).slice(11)}–${local(entry.plannedEnd, access.timezone).slice(11)}${local(entry.plannedEnd, access.timezone).slice(0, 10) !== entry.workDate ? ' +1 день' : ''}` : labels[entry.kind];
      const carry = day !== entry.workDate;
      return `<button class="schedule-entry schedule-kind-${esc(entry.kind)} ${entry.status === 'cancelled' ? 'is-cancelled' : ''}" data-entry="${esc(entry.id)}"><b>${carry ? `До ${esc(local(entry.plannedEnd, access.timezone).slice(11))}` : esc(text)}</b><small>${carry ? 'Продолжение ночной смены' : entry.status === 'cancelled' ? 'Отменена' : esc(labels[entry.kind])}${!carry && entry.breakMinutes ? ` · перерыв ${entry.breakMinutes} мин` : ''}</small></button>`;
    }
    function draw() {
      if (!ready) return;
      const [from, to] = bounds();
      const search = q('[data-search]').value.trim().toLocaleLowerCase('ru-RU');
      const people = employees.filter(p => (!q('[data-person]').value || p.id === q('[data-person]').value)
        && (!q('[data-role]').value || p.role === q('[data-role]').value) && (!search || p.name.toLocaleLowerCase('ru-RU').includes(search)));
      const filtered = entries.filter(e => people.some(p => p.id === e.userId) && (e.status !== 'cancelled' || q('[data-cancelled]').checked));
      const planned = filtered.filter(e => e.kind === 'shift' && e.status === 'planned' && e.workDate >= from && e.workDate <= to);
      const minutes = planned.reduce((sum, e) => sum + (planMinutes(e) ?? 0), 0);
      const incompletePlans = planned.filter(e => planMinutes(e) === null).length;
      const facts = actual.filter(row => people.some(p => p.id === row.userId));
      const worked = facts.reduce((sum,row)=>sum+row.minutes,0), incomplete = facts.reduce((sum,row)=>sum+row.openIntervals+row.invalidIntervals,0);
      q('[data-summary]').innerHTML = `<strong>${esc(dayName(from))}${from !== to ? ` — ${esc(dayName(to))}` : ''}</strong><span>${planned.length} смен</span><span>План: ${hours(minutes)}</span><span>Факт: ${hours(worked)}</span>${incompletePlans || incomplete ? '<span class="schedule-warning">Есть неполные данные</span>' : ''}`;
      q('[data-context]').textContent = `${dayName(from)} — ${dayName(to)} · ${access.timezone} · ${planned.length} смен · ${(minutes / 60).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ч по плану. Итоги по дате начала.`;
      if (incompletePlans) q('[data-context]').textContent += ` План неполный: ${incompletePlans} смен требуют уточнения времени и не включены в часы.`;
      q('[data-context]').textContent += ` Факт: ${(worked/60).toLocaleString('ru-RU',{maximumFractionDigits:2})} ч по завершённым интервалам.${incomplete ? ` Незакрытых или некорректных интервалов: ${incomplete}; факт неполный.` : ''} Плановый перерыв из факта автоматически не вычитается.`;
      explanationText.textContent=q('[data-context]').textContent;
      const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
      if (!people.length) { q('[data-grid]').innerHTML = '<p>Сотрудники не найдены.</p>'; return; }
      const today = local(new Date(), access.timezone).slice(0,10);
      const daily = day => filtered.filter(e => onDay(e, day));
      const staffing = day => new Set(daily(day).filter(e => e.kind === 'shift' && e.status === 'planned').map(e => e.userId)).size;
      const desktop = mode === 'week' ? `<div class="schedule-week" tabindex="0" aria-label="График недели, прокручиваемая таблица"><table><thead><tr><th>Сотрудник / часы</th>${days.map(d => `<th class="${d === today ? 'is-today' : ''}"><button class="schedule-date-link" data-open-day="${d}">${esc(dayName(d))}</button><small>На сменах: ${staffing(d)}</small></th>`).join('')}</tr></thead><tbody>${people.map(p => `<tr><th>${esc(p.name)}<small>${esc(roleNames[p.role] || p.role)} · ${hours(planned.filter(e => e.userId === p.id).reduce((sum,e) => sum + (planMinutes(e) ?? 0),0))}</small>${!p.active ? '<small>Неактивен</small>' : ''}</th>${days.map(d => `<td class="${d === today ? 'is-today' : ''}">${daily(d).filter(e => e.userId === p.id).map(e => card(e,d)).join('') || '<small>Не запланировано</small>'}${access.manage && p.active ? `<button class="schedule-add" data-add="${esc(p.id)}" data-day="${d}" aria-label="Назначить: ${esc(p.name)}, ${d}">+</button>` : ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '';
      const strip = `<nav class="schedule-day-strip" aria-label="Дни недели">${days.map(d => `<button class="${d === date ? 'is-selected' : ''}" aria-pressed="${d === date}" data-select-day="${d}">${esc(dayName(d))}<small>${staffing(d)} чел.</small></button>`).join('')}</nav>`;
      const dayCards = day => `<section><h2>${esc(dayName(day))}</h2>${daily(day).map(e => `<div><span>${esc(people.find(p => p.id === e.userId)?.name || e.userName)}</span>${card(e,day)}</div>`).join('') || '<p class="muted">Не запланировано</p>'}${access.manage ? `<button class="button" data-add="${esc(q('[data-person]').value)}" data-day="${day}">Назначить смену</button>` : ''}</section>`;
      let content = desktop;
      if (mode === 'month') {
        const offset = (new Date(from + 'T12:00Z').getUTCDay() + 6) % 7;
        content = `<div class="schedule-month schedule-days" aria-label="Календарь месяца">${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d=>`<b class="schedule-weekday">${d}</b>`).join('')}${Array.from({length:offset},()=>'<div class="schedule-calendar-pad" aria-hidden="true"></div>').join('')}${days.map(d=>`<button class="schedule-month-day ${d===today?'is-today':''}" data-open-day="${d}" aria-label="${esc(dayName(d))}: на сменах ${staffing(d)}"><strong>${Number(d.slice(-2))}</strong><span>${staffing(d)} чел.</span><small>${daily(d).filter(e=>e.status==='planned' && e.kind!=='shift').length} отсутств.</small></button>`).join('')}</div>`;
      } else if (mode === 'day') {
        let dayStart, dayEnd;
        try { dayStart=Date.parse(instant(date+'T00:00',access.timezone)); dayEnd=Date.parse(instant(addDays(date,1)+'T00:00',access.timezone)); }
        catch { q('[data-grid]').innerHTML=`<p>В этот день перевод часов затрагивает полночь. Используйте точное время в карточках.</p><div class="schedule-days">${dayCards(date)}</div>`; q('[data-grid]').querySelectorAll('[data-entry]').forEach(button=>button.onclick=()=>editor(entries.find(e=>e.id===button.dataset.entry))); return; }
        const dayDuration=dayEnd-dayStart;
        content = `<div class="schedule-timeline" tabindex="0" aria-label="Почасовой график дня"><div class="schedule-timeline-header"><b>Сотрудник · ${hours(dayDuration/60000)}</b><div>${Array.from({length:9},(_,i)=>`<span>${i===8?'24:00':esc(local(new Date(dayStart+dayDuration*i/8),access.timezone).slice(11))}</span>`).join('')}</div></div>${people.map(p=>`<div class="schedule-timeline-row"><strong>${esc(p.name)}</strong><div class="schedule-timeline-tracks">${daily(date).filter(e=>e.userId===p.id).map(e=>{
          if(e.kind!=='shift' || planMinutes(e)===null) return card(e,date);
          const start=local(e.plannedStart,access.timezone), end=local(e.plannedEnd,access.timezone);
          const a=Math.max(Date.parse(e.plannedStart),dayStart)-dayStart, b=Math.min(Date.parse(e.plannedEnd),dayEnd)-dayStart;
          return `<div class="schedule-timeline-track"><button class="schedule-time-bar ${e.status==='cancelled'?'is-cancelled':''}" data-entry="${esc(e.id)}" style="left:${100*a/dayDuration}%;width:${100*(b-a)/dayDuration}%" title="${esc(p.name)}: ${esc(start.replace('T',' '))} — ${esc(end.replace('T',' '))}"><span>${esc(start.slice(11))}–${esc(end.slice(11))}${e.workDate!==date?' · продолжение':''}${e.status==='cancelled'?' · отменена':''}</span></button></div>`;
        }).join('') || '<small>Не запланировано</small>'}</div></div>`).join('')}</div><div class="schedule-days schedule-day-detail">${dayCards(date)}</div>`;
      } else {
        content += `<div class="${mode==='week'?'schedule-mobile':''}">${mode==='week'?strip:''}<div class="schedule-days ${mode==='week'?'schedule-mobile':''}">${(mode==='week'?[date]:days).map(dayCards).join('')}</div></div>`;
      }
      q('[data-grid]').innerHTML = mode === 'month' ? `<div class="schedule-month-scroll">${content}</div>` : content;
      if(mode==='month') q('[data-grid]').querySelectorAll('[data-open-day]').forEach(button=>{
        const records=daily(button.dataset.openDay), preview=document.createElement('span');preview.className='schedule-month-preview';
        preview.textContent=records.slice(0,2).map(e=>`${people.find(p=>p.id===e.userId)?.name||e.userName}: ${e.kind==='shift'&&e.plannedStart? (e.workDate<button.dataset.openDay?'до '+local(e.plannedEnd,access.timezone).slice(11):local(e.plannedStart,access.timezone).slice(11)+'–'+local(e.plannedEnd,access.timezone).slice(11)):labels[e.kind]}`).join('\n');
        if(records.length>2)preview.textContent+=`\nЕщё ${records.length-2}`;button.append(preview);
      });
      q('[data-grid]').querySelectorAll('[data-entry]').forEach(button => button.onclick = () => editor(entries.find(e => e.id === button.dataset.entry)));
      q('[data-grid]').querySelectorAll('[data-add]').forEach(button => button.onclick = () => editor(null, button.dataset.add, button.dataset.day));
      q('[data-grid]').querySelectorAll('[data-select-day]').forEach(button => button.onclick = () => { date=button.dataset.selectDay; q('[data-date]').value=date; draw(); });
      q('[data-grid]').querySelectorAll('[data-open-day]').forEach(button => button.onclick = () => { date=button.dataset.openDay; mode='day'; q('[data-date]').value=date; q('[data-mode]').value=mode; q('[data-mode]')._customSelectRefresh?.(); load(); });
    }
    async function load() {
      const current = ++generation; status('Загрузка графика…');
      ready = false; entries = []; actual = [];
      q('[data-grid]').replaceChildren(); q('[data-context]').textContent = ''; q('[data-summary]').textContent = '';
      q('[data-create]').disabled = true; if (q('[data-copy-week]')) q('[data-copy-week]').disabled = true;
      q('[data-grid]').inert = true;
      try {
        const [from, to] = bounds();
        const result = await api(`?from=${from}&to=${to}`);
        if (current !== generation) return;
        if (!Array.isArray(result.items) || !Array.isArray(result.actual) || !result.access?.view) throw new Error('Получен неполный ответ графика.');
        entries = [...result.items, ...(result.continuations || [])]; actual = result.actual; access = result.access; ready = true;
        q('[data-create]').hidden = !access.manage; if (q('[data-copy-week]')) q('[data-copy-week]').hidden = !access.manage;
        draw(); status(entries.length ? '' : 'В выбранном периоде пока нет записей.'); return true;
      } catch (error) { if (current === generation) status(error.message + ' Нажмите «Обновить».'); return false; }
      finally { if (alive() && current === generation) {
        q('[data-grid]').inert = !ready; q('[data-create]').disabled = !ready;
        if (q('[data-copy-week]')) q('[data-copy-week]').disabled = !ready;
      } }
    }
    function dialog(title, content) {
      const node = document.createElement('dialog'); node.className = 'schedule-dialog ui-components';
      node.innerHTML = `<form><h2>${esc(title)}</h2>${content}<p data-error role="alert"></p><div class="schedule-actions"><button type="button" class="button" data-close>Закрыть</button><button type="submit" class="button primary">Сохранить</button></div></form>`;
      target.append(node); const previous = document.activeElement; let busy = false, dirty = false, guarded = false;
      node.setAttribute('aria-labelledby', `schedule-dialog-${crypto.randomUUID()}`); node.querySelector('h2').id=node.getAttribute('aria-labelledby');
      const discard = () => !guarded || !dirty || window.confirm('Есть несохранённые изменения. Закрыть без сохранения?');
      const beforeUnload = event => { if (guarded && dirty) { event.preventDefault(); event.returnValue=''; } };
      window.addEventListener('beforeunload', beforeUnload);
      node.querySelector('[data-close]').onclick = () => { if (!busy && discard()) node.close(); };
      node.addEventListener('cancel', event => { if (busy || !discard()) event.preventDefault(); });
      node.addEventListener('input', () => { dirty=true; }); node.addEventListener('change', () => { dirty=true; });
      node.addEventListener('close', () => { window.removeEventListener('beforeunload',beforeUnload); node.remove(); previous?.focus(); });
      node.showModal();
      return { node, guard() { guarded=true; dirty=false; }, pending(value) { busy = value; node.querySelectorAll('button,input,select,textarea').forEach(el => el.disabled = value); }, error(text) { node.querySelector('[data-error]').textContent = text; } };
    }
    function editor(entry, person = '', day = date) {
      if (!ready) return;
      const readonly = !access.manage || entry?.status === 'cancelled';
      const d = dialog(entry ? 'Запись графика' : 'Назначить смену', `<label>Сотрудник<select name="userId">${employees.filter(p => p.active || p.id === entry?.userId).map(p => `<option value="${esc(p.id)}" ${p.id === (entry?.userId || person) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label><label>Тип<select name="kind">${Object.entries(labels).map(([key, value]) => `<option value="${key}" ${key === entry?.kind ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>Дата<input name="workDate" type="date" required value="${esc(entry?.workDate || day)}"></label><fieldset data-times><legend>Время заведения · ${esc(access.timezone)}</legend><label>Начало<input name="start" type="datetime-local" value="${esc(entry?.plannedStart ? local(entry.plannedStart, access.timezone) : day + 'T10:00')}"></label><label>Окончание<input name="end" type="datetime-local" value="${esc(entry?.plannedEnd ? local(entry.plannedEnd, access.timezone) : day + 'T18:00')}"></label><label>Неоплачиваемый перерыв, минут<input name="breakMinutes" type="number" min="0" step="1" value="${entry?.breakMinutes || 0}"></label></fieldset><label>Заметка<textarea name="note" maxlength="500">${esc(entry?.note)}</textarea></label><label>Причина изменения / отмены<textarea name="reason" maxlength="500"></textarea></label><p class="muted">Изменения прошлого периода требуют причины. Утверждённая зарплата автоматически не изменяется.</p>${entry && !readonly ? '<button type="button" class="button" data-cancel>Отменить смену / отсутствие</button>' : ''}`);
      const form = d.node.querySelector('form'); let requestKey = crypto.randomUUID();
      if (!readonly) d.guard();
      let conflictPending = false;
      const conflictPanel = document.createElement('section'); conflictPanel.setAttribute('aria-live','polite');
      form.querySelector('.schedule-actions').before(conflictPanel);
      async function compareLatest() {
        d.pending(true);
        try {
          const latest = await api(`/${entry.id}`);
          if (!d.node.isConnected) return;
          const summary = value => `${value.userName || employees.find(p=>p.id===value.userId)?.name || value.userId}; ${value.workDate}; ${labels[value.kind]}; ${value.status === 'cancelled' ? 'Отменена' : 'Запланирована'}; ${value.plannedStart ? local(value.plannedStart,access.timezone) : 'начало не задано'} — ${value.plannedEnd ? local(value.plannedEnd,access.timezone) : 'конец не задан'}; перерыв ${value.breakMinutes} мин; заметка: ${value.note || 'нет'}; причина отмены: ${value.cancelReason || 'нет'}`;
          conflictPanel.innerHTML = `<h3>Запись изменена другим пользователем</h3><p>Было (версия ${esc(entry.version)}): ${esc(summary(entry))}</p><p>Сейчас (версия ${esc(latest.version)}): ${esc(summary(latest))}</p><p>Ваш черновик сохранён в полях выше. Сравните изменения перед повторным сохранением.</p>`;
          if (latest.status !== 'cancelled') {
            const accept = document.createElement('button'); accept.type='button'; accept.className='button'; accept.textContent='Применить мой черновик к новой версии';
            accept.onclick=()=>{ entry=latest; conflictPending=false; requestKey=crypto.randomUUID(); conflictPanel.textContent='Актуальная версия принята. Черновик не изменён. Нажмите «Сохранить», чтобы применить его.'; d.error('Проверьте поля перед сохранением.'); };
            conflictPanel.append(accept);
          } else conflictPanel.append(document.createTextNode('Запись отменена. Повторное сохранение запрещено; черновик доступен для копирования.'));
        } catch (error) {
          conflictPanel.textContent=error.message;
          const retry=document.createElement('button'); retry.type='button'; retry.className='button'; retry.textContent='Загрузить актуальную запись'; retry.onclick=compareLatest; conflictPanel.append(retry);
        } finally { d.pending(false); }
      }
      if (entry?.kind === 'shift' && planMinutes(entry) === null) {
        if (!entry.plannedStart) form.elements.start.value = '';
        if (!entry.plannedEnd) form.elements.end.value = '';
        d.error('Старая запись содержит неполное время. Уточните начало и окончание; исходная запись сохранится в истории.');
      }
      if (entry) {
        const historyButton = document.createElement('button'); historyButton.type = 'button'; historyButton.className = 'button'; historyButton.textContent = 'История изменений';
        const historyPanel = document.createElement('div'); historyPanel.setAttribute('aria-live', 'polite');
        form.querySelector('.schedule-actions').before(historyButton, historyPanel);
        historyButton.onclick = async () => {
          historyButton.disabled = true; historyPanel.textContent = 'Загрузка истории…';
          try {
            const result = await api(`/${entry.id}/history`);
            if (!d.node.isConnected) return;
            historyPanel.innerHTML = result.items.map(event => `<article><b>Версия ${esc(event.version)} · ${event.status === 'cancelled' ? 'Отменена' : esc(labels[event.kind] || event.kind)}</b><p>${esc(event.actor)} · ${esc(local(event.createdAt, access.timezone).replace('T',' '))}</p><p>${esc(event.reason || 'Без дополнительной причины')}</p>${(event.plannedStart || event.plannedEnd) ? `<small>${esc(event.plannedStart ? local(event.plannedStart, access.timezone).replace('T',' ') : 'Начало не задано')} — ${esc(event.plannedEnd ? local(event.plannedEnd, access.timezone).replace('T',' ') : 'Окончание не задано')} · перерыв ${esc(event.breakMinutes)} мин</small>` : ''}</article>`).join('') || 'Запись создана до включения истории.';
          } catch (error) { historyPanel.textContent = error.message; } finally { historyButton.disabled = false; }
        };
      }
      form.addEventListener('input', () => { requestKey = crypto.randomUUID(); });
      const kind = form.elements.kind;
      const sync = () => { d.node.querySelector('[data-times]').hidden = kind.value !== 'shift'; };
      kind.onchange = sync; sync();
      if (readonly) { form.querySelectorAll('input,select,textarea,button[type=submit]').forEach(el => el.disabled = true); }
      async function submit(cancel = false) {
        if (readonly) return;
        if (conflictPending) { d.error('Сначала сравните актуальную запись с вашим черновиком.'); return; }
        const data = new FormData(form);
        let payload;
        try {
          if (cancel && !String(data.get('reason')).trim()) throw new Error('Укажите причину отмены.');
          payload = cancel ? { status: 'cancelled', reason: data.get('reason') } : {
            userId: data.get('userId'), workDate: data.get('workDate'), kind: data.get('kind'), note: data.get('note'), reason: data.get('reason'),
            plannedStart: data.get('kind') === 'shift' ? instant(data.get('start'), access.timezone) : null,
            plannedEnd: data.get('kind') === 'shift' ? instant(data.get('end'), access.timezone) : null,
            breakMinutes: data.get('kind') === 'shift' ? Number(data.get('breakMinutes')) : 0
          };
          payload.requestKey = requestKey; if (entry) payload.version = entry.version;
          d.pending(true); d.error('Сохранение…');
          await api(entry ? `/${entry.id}` : '', entry ? 'PATCH' : 'POST', payload);
          d.node.close(); if (!cancel) { date=payload.workDate; q('[data-date]').value=date; }
          if (await load()) status(cancel ? 'Запись отменена. История сохранена.' : 'Запись сохранена.');
        } catch (error) {
          if (error.code === 'schedule_version_conflict' && entry) { conflictPending=true; d.error('Конфликт версий. Ваш ввод сохранён.'); await compareLatest(); }
          else d.error(error.message);
        }
        finally { d.pending(false); }
      }
      form.onsubmit = event => { event.preventDefault(); submit(); };
      d.node.querySelector('[data-cancel]')?.addEventListener('click', () => submit(true));
    }
    function copyWeek() {
      if (!ready) return;
      const sourceFrom = mode === 'month' ? date : bounds()[0];
      const d = dialog('Копировать неделю', `<p>Переносится семь дней, начиная с выбранной даты. Время сохраняется по часовому поясу заведения. Конфликтующие записи можно исключить.</p><label>Начало исходной недели<input type="date" name="sourceFrom" value="${sourceFrom}" required></label><label>Начало новой недели<input type="date" name="targetFrom" value="${addDays(sourceFrom,7)}" required></label><fieldset><legend>Сотрудники</legend>${employees.filter(p => p.active).map(p => `<label class="schedule-check"><input type="checkbox" name="person" value="${esc(p.id)}" ${!q('[data-person]').value || p.id === q('[data-person]').value ? 'checked' : ''}>${esc(p.name)}</label>`).join('')}</fieldset><button type="button" class="button" data-preview>Предварительный просмотр</button><div data-copy-preview aria-live="polite"></div>`);
      const form = d.node.querySelector('form'), apply = form.querySelector('[type=submit]'), area = form.querySelector('[data-copy-preview]');
      apply.textContent = 'Копировать выбранные'; apply.disabled = true;
      const reasonLabel = document.createElement('label');
      reasonLabel.textContent = 'Причина копирования (обязательна для прошлых дат)';
      const reasonInput = document.createElement('textarea'); reasonInput.name = 'reason'; reasonInput.maxLength = 500;
      reasonLabel.append(reasonInput); area.after(reasonLabel);
      let preview = null, requestKey = crypto.randomUUID(), query = null;
      reasonInput.addEventListener('input', () => { requestKey = crypto.randomUUID(); });
      const invalidate = () => { preview = null; apply.disabled = true; area.textContent = 'Параметры изменены. Обновите предварительный просмотр.'; requestKey = crypto.randomUUID(); };
      form.querySelectorAll('[name=sourceFrom],[name=targetFrom],[name=person]').forEach(el => el.addEventListener('change', invalidate));
      form.querySelector('[data-preview]').onclick = async () => {
        query = { sourceFrom: form.elements.sourceFrom.value, targetFrom: form.elements.targetFrom.value,
          userIds: [...form.querySelectorAll('[name=person]:checked')].map(el => el.value) };
        d.pending(true); d.error('Проверка…'); preview = null;
        try {
          preview = await api('/copy/preview', 'POST', query); requestKey = crypto.randomUUID();
          area.innerHTML = preview.items.map(item => `<label class="schedule-check"><input type="checkbox" data-source="${esc(item.sourceId)}" ${item.conflict ? 'disabled' : 'checked'}><span><b>${esc(item.employeeName)} · ${esc(dayName(item.workDate))}</b><small>${item.kind === 'shift' && item.plannedStart ? `${esc(local(item.plannedStart,access.timezone).replace('T',' '))} — ${esc(local(item.plannedEnd,access.timezone).replace('T',' '))}` : esc(labels[item.kind])}</small>${item.conflict ? `<small>Не будет скопировано: ${esc(messages[item.conflict] || item.conflict)}</small>` : ''}</span></label>`).join('') || '<p>В исходной неделе нет записей для выбранных сотрудников.</p>';
          area.querySelectorAll('input').forEach(el => el.onchange = () => { requestKey = crypto.randomUUID(); apply.disabled = !area.querySelector('input:checked'); });
          d.error(preview.items.some(item => item.workDate < preview.today)
            ? 'Внимание: в новой неделе есть прошлые даты. Для их сохранения укажите причину. Предпросмотр не меняет график.'
            : 'Предпросмотр не меняет график. Проверьте даты и выбранные записи.');
        } catch (error) { area.textContent = ''; d.error(error.message); }
        finally {
          d.pending(false);
          if (preview) preview.items.filter(item => item.conflict).forEach(item => { const el = area.querySelector(`[data-source="${item.sourceId}"]`); if (el) el.disabled = true; });
          apply.disabled = !preview || !area.querySelector('input:checked');
        }
      };
      form.onsubmit = async event => {
        event.preventDefault(); if (!preview) return;
        const sourceIds = [...area.querySelectorAll('input:checked:not(:disabled)')].map(el => el.dataset.source);
        if (!sourceIds.length) return;
        if (preview.items.some(item => sourceIds.includes(item.sourceId) && item.workDate < preview.today) && !reasonInput.value.trim()) {
          d.error(messages.schedule_past_reason_required); reasonInput.focus(); return;
        }
        d.pending(true); d.error('Копирование…');
        try {
          await api('/copy/apply', 'POST', { ...query, fingerprint: preview.fingerprint, sourceIds, requestKey, reason: reasonInput.value });
          date = query.targetFrom; q('[data-date]').value = date; d.node.close();
          if (await load()) status('Выбранные записи скопированы.');
        } catch (error) { d.error(error.message + ' При изменении графика обновите предпросмотр.'); }
        finally { d.pending(false); if (preview) preview.items.filter(item => item.conflict).forEach(item => { const el = area.querySelector(`[data-source="${item.sourceId}"]`); if (el) el.disabled = true; }); }
      };
    }
    async function grants() {
      try {
        const result = await api('/grants');
        const d = dialog('Доступ к графику', '<p>Права выдаёт только владелец. Остальные полномочия сотрудника не меняются.</p><div data-grant-list></div>');
        d.node.querySelector('button[type=submit]').remove();
        d.node.querySelector('form').onsubmit = e => e.preventDefault();
        const list = d.node.querySelector('[data-grant-list]');
        list.innerHTML = result.items.map(p => `<fieldset><legend>${esc(p.name)}</legend><label>Действующий график<select data-user="${esc(p.userId)}">${[['none','Нет доступа'],['view','Только просмотр'],['manage','Прямое изменение и черновики']].map(([key,label]) => `<option value="${key}" ${p.access === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="schedule-check"><input type="checkbox" data-publish-user="${esc(p.userId)}" ${p.canPublish?'checked':''} ${p.access!=='manage'?'disabled':''}>Публикация черновиков</label></fieldset>`).join('') || '<p>Нет администраторов и управляющих для выдачи прав.</p>';
        list.querySelectorAll('select').forEach(select => select.onchange = async () => {
          const person = result.items.find(p => p.userId === select.dataset.user); d.pending(true);
          try { const saved = await api('/grants', 'PUT', { userId: person.userId, access: select.value, version: person.version }); Object.assign(person, saved); d.error('Права сохранены.'); }
          catch (error) { select.value = person.access; d.error(error.message); } finally { d.pending(false);syncPublish(); }
        });
        const syncPublish=()=>list.querySelectorAll('[data-publish-user]').forEach(input=>{const person=result.items.find(p=>p.userId===input.dataset.publishUser);input.disabled=person.access!=='manage';input.checked=!!person.canPublish;});
        list.querySelectorAll('[data-publish-user]').forEach(input=>input.onchange=async()=>{const person=result.items.find(p=>p.userId===input.dataset.publishUser);d.pending(true);try{Object.assign(person,await api('/grants','PUT',{userId:person.userId,access:person.access,version:person.version,canPublish:input.checked}));d.error('Право публикации сохранено.');}catch(error){d.error(error.message);}finally{d.pending(false);syncPublish();}});
      } catch (error) { status(error.message); }
    }
    q('[data-refresh]').onclick = () => initialize();
    async function initialize() {
      ready=false;entries=[];actual=[];q('[data-grid]').replaceChildren();q('[data-summary]').textContent='';q('[data-context]').textContent='';status('Загрузка графика…');
      q('[data-create]').disabled=true;if(q('[data-copy-week]'))q('[data-copy-week]').disabled=true;if(q('[data-planning]'))q('[data-planning]').disabled=true;
      q('[data-refresh]').disabled = true;
      target.querySelectorAll('[data-prev],[data-next],[data-date],[data-mode],[data-person]').forEach(el=>{el.disabled=true;el._customSelectRefresh?.();});
      try {
      access = await api('/access'); if (!access.view) throw new Error('Владелец ещё не выдал доступ к графику.');
      employees = (await api('/employees')).items;
      date ||= local(new Date(), access.timezone).slice(0, 10); q('[data-date]').value = date;
      const selectedPerson=q('[data-person]').value;
      q('[data-person]').innerHTML = '<option value="">Все сотрудники</option>' + employees.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
      if (employees.some(p=>p.id===selectedPerson)) q('[data-person]').value=selectedPerson;
      const selectedRole=q('[data-role]').value;
      q('[data-role]').innerHTML='<option value="">Все должности</option>'+[...new Set(employees.map(p=>p.role))].map(role=>`<option value="${esc(role)}">${esc(roleNames[role]||role)}</option>`).join('');
      q('[data-role]').value=selectedRole;
      q('[data-create]').hidden = !access.manage; q('[data-grants]').hidden = !access.grant;
      q('[data-planning]')?.remove();
      if (access.manage) {
        const planningButton=document.createElement('button');planningButton.type='button';planningButton.className='button';planningButton.dataset.planning='';planningButton.textContent='Черновики и шаблоны';
        planningButton.onclick=()=>window.openSchedulePlanning({api,dialog,employees,access,date,local,instant,refresh:load});q('[data-grants]').before(planningButton);
      }
      q('[data-create]').onclick = () => editor(null);
      if (access.manage) {
        q('[data-copy-week]')?.remove();
        const copyButton = document.createElement('button'); copyButton.className = 'button'; copyButton.dataset.copyWeek = ''; copyButton.textContent = 'Копировать неделю'; copyButton.onclick = copyWeek;
        q('[data-grants]').before(copyButton);
      }
      q('[data-grants]').onclick = grants;
      q('[data-person]').onchange = draw;
      q('[data-search]').oninput=draw; q('[data-role]').onchange=draw; q('[data-cancelled]').onchange=draw;
      q('[data-today]').onclick=()=>{date=local(new Date(),access.timezone).slice(0,10);q('[data-date]').value=date;load();};
      q('[data-mode]').onchange = event => { mode = event.target.value; load(); };
      q('[data-date]').onchange = event => { if (event.target.value) { date = event.target.value; load(); } };
      const move = n => { if (mode === 'month') { const next = new Date(date.slice(0,7) + '-01T12:00Z'); next.setUTCMonth(next.getUTCMonth() + n); date = next.toISOString().slice(0,10); } else date = addDays(date, n * (mode==='day'?1:7)); q('[data-date]').value = date; load(); };
      q('[data-prev]').onclick = () => move(-1); q('[data-next]').onclick = () => move(1);
      initialized = true;
      target.querySelectorAll('[data-prev],[data-next],[data-date],[data-mode],[data-person]').forEach(el=>{el.disabled=false;el._customSelectRefresh?.();});
      await load();
      } catch (error) { status(error.message + ' Нажмите «Обновить».'); }
      finally { q('[data-refresh]').disabled = false; }
    }
    await initialize();
  };
})();
