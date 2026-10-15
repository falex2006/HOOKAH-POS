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
  const messages = { schedule_overlap: 'Есть пересекающаяся смена или отсутствие.', schedule_version_conflict: 'Запись уже изменена. Закройте редактор и обновите график; ваши значения пока сохранены в форме.', schedule_forbidden: 'Доступ отозван или недостаточно прав.', schedule_past_reason_required: 'Для изменения прошлого периода укажите причину.', schedule_employee_unavailable: 'Сотрудник недоступен для назначения.', schedule_duration_invalid: 'Смена должна длиться больше 0 и не больше 24 часов.', schedule_break_invalid: 'Перерыв должен быть короче смены.',schedule_break_intervals_invalid:'Проверьте, что каждый перерыв целиком внутри смены и интервалы не пересекаются.',schedule_break_intervals_mismatch:'Сумма интервалов перерыва должна совпадать с указанным количеством минут.',schedule_open_shift_function_required:'Для свободной смены укажите рабочую функцию.', schedule_grant_conflict: 'Права уже изменены. Обновите список.', schedule_availability_unavailable:'Смена попадает на интервал недоступности.',schedule_availability_outside_window:'Смена выходит за доступное окно.',schedule_availability_time_ambiguous:'Часы доступности попадают на неоднозначное или несуществующее местное время.',schedule_warnings_confirmation_required:'Есть мягкое предупреждение. Подтвердите его и укажите причину перед сохранением.',schedule_demand_overlap:'Этот интервал пересекается с другим правилом потребности.',schedule_demand_version_conflict:'Правило уже изменено. Обновите список.',schedule_demand_timezone_changed:'Часовой пояс заведения изменился. Переподтвердите правила потребности.' };
  window.mountStaffSchedule = async target => {
    messages.schedule_plan_incomplete = 'Сначала уточните время исходной смены.';
    const token = localStorage.getItem('crm_session_token');
    let generation = 0, employees = [], entries = [], actual = [], coverage = [], access, date, mode = 'week', ready = false, initialized = false;
    const roleNames = { owner: 'Владелец', admin: 'Администратор', manager: 'Управляющий', developer: 'Разработчик', senior_bartender: 'Старший бармен', senior_hookah_master: 'Старший кальянщик', bartender: 'Бармен', hookah_master: 'Кальянщик', cleaner: 'Уборщица / уборщик', security: 'Охрана', technician: 'Техник', other_staff: 'Другая должность', staff: 'Сотрудник', waiter: 'Официант', hookah: 'Кальянный мастер' };
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
    target.innerHTML = `<div class="schedule-heading"><div><h1>График сотрудников</h1><p class="muted">План работы команды. Не заменяет учёт фактически отработанного времени.</p></div><button type="button" class="button primary" data-create hidden>Назначить смену</button></div>
      <section class="panel"><div class="schedule-toolbar"><div class="schedule-period"><button type="button" class="button" data-prev aria-label="Предыдущий период">←</button><label>Дата<input type="date" data-date></label><button type="button" class="button" data-next aria-label="Следующий период">→</button><button type="button" class="button" data-today>Сегодня</button></div><label>Вид<select data-mode><option value="week">Неделя</option><option value="month">Месяц</option><option value="day">День</option><option value="list">Список</option></select></label></div><details class="schedule-tools"><summary>Фильтры, действия и экспорт</summary><div class="schedule-toolbar"><label>Сотрудник<select data-person><option value="">Все сотрудники</option></select></label><label>Поиск<input type="search" data-search placeholder="Имя сотрудника"></label><label>Должность<select data-role><option value="">Все должности</option></select></label><label class="schedule-check"><input type="checkbox" data-cancelled>Показывать отменённые</label><button type="button" class="button" data-refresh>Обновить</button><button type="button" class="button" data-csv>Скачать CSV</button><button type="button" class="button" data-print>Печать</button><button type="button" class="button" data-grants hidden>Доступ к графику</button></div></details><div data-summary class="schedule-summary"></div><details data-coverage class="schedule-coverage" hidden></details><details class="schedule-explanation"><summary>Как считаются часы</summary><p data-context class="muted"></p></details><p data-export-meta class="schedule-export-meta" hidden></p><p data-status role="status" aria-live="polite">Загрузка графика…</p><div data-grid></div></section>`;
    const q = s => target.querySelector(s);
    q('[data-create]').textContent = 'Добавить смену или отсутствие';
    q('[data-create]').setAttribute('aria-label','Назначить смену или выходной');q('[data-create]').title='Назначить смену или выходной';
    const headingActions = document.createElement('div'); headingActions.className = 'schedule-heading-actions';
    q('[data-create]').before(headingActions); headingActions.append(q('[data-create]'));
    const monthJump = document.createElement('label');
    monthJump.innerHTML = 'Перейти к дате<select data-month-jump><option value="">Выберите период</option><option value="today">Сегодня</option><option value="current">Этот месяц</option><option value="next">Следующий месяц</option></select>';
    q('[data-mode]').closest('label').after(monthJump);
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
    const hours = minutes => `${(minutes / 60).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ч`;
    function exportEntries() {
      const [from,to]=bounds(),personId=q('[data-person]').value,role=q('[data-role]').value,search=q('[data-search]').value.trim().toLocaleLowerCase('ru-RU');
      const byId=new Map(employees.map(person=>[person.id,person]));
      let periodStart,periodEnd;try{periodStart=Date.parse(instant(`${from}T00:00`,access.timezone));periodEnd=Date.parse(instant(`${addDays(to,1)}T00:00`,access.timezone));}catch{periodStart=NaN;periodEnd=NaN;}
      return entries.filter(entry=>{
        if(entry.status==='cancelled'&&!q('[data-cancelled]').checked)return false;
        if(entry.kind==='open_shift')return !personId&&!role&&(!search||'свободная смена'.includes(search));
        const person=byId.get(entry.userId);if(!person||personId&&person.id!==personId||role&&person.role!==role)return false;
        if(search&&![person.name,roleNames[person.role]||person.role,entry.functionName||''].some(value=>String(value).toLocaleLowerCase('ru-RU').includes(search)))return false;
        if(entry.plannedStart&&entry.plannedEnd&&Number.isFinite(periodStart)&&Number.isFinite(periodEnd))return Date.parse(entry.plannedStart)<periodEnd&&Date.parse(entry.plannedEnd)>periodStart;
        return entry.workDate>=from&&entry.workDate<=to;
      }).sort((a,b)=>a.workDate.localeCompare(b.workDate)||(a.plannedStart||'').localeCompare(b.plannedStart||'')||(a.userName||'').localeCompare(b.userName||'','ru'));
    }
    function exportMeta() { const [from,to]=bounds();return {from,to,timezone:access.timezone,generatedAt:local(new Date(),access.timezone).replace('T',' ')}; }
    function csvCell(value) { let text=String(value??'').replace(/\r\n?/g,'\n');if(/^[\s\u0000-\u001f]*[=+\-@]/.test(text))text="'"+text;return `"${text.replace(/"/g,'""')}"`; }
    function downloadCsv() {
      const meta=exportMeta(),header=['Дата','Сотрудник','Должность','Тип','Рабочая функция','Начало','Окончание','Перерыв, мин','Статус','Период','Часовой пояс','Сформирован'];
      const rows=exportEntries().map(entry=>{const person=employees.find(item=>item.id===entry.userId);return [entry.workDate,entry.kind==='open_shift'?'Свободная смена':person?.name||'',person?(roleNames[person.role]||person.role):'',labels[entry.kind]||entry.kind,entry.functionName||'',entry.plannedStart?local(entry.plannedStart,access.timezone).replace('T',' '):'',entry.plannedEnd?local(entry.plannedEnd,access.timezone).replace('T',' '):'',entry.breakMinutes||0,entry.status==='cancelled'?'Отменена':'В графике',`${meta.from} — ${meta.to}`,meta.timezone,meta.generatedAt];});
      const csv=[['Период',`${meta.from} — ${meta.to}`],['Часовой пояс',meta.timezone],['Сформирован',meta.generatedAt],[],header,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n');
      const blob=new Blob(['\uFEFF',csv],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`staff-schedule_${meta.from}_${meta.to}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }
    function card(entry, day = entry.workDate) {
      if ((entry.kind === 'shift' || entry.kind === 'open_shift') && planMinutes(entry) === null) return `<button type="button" class="schedule-entry" data-entry="${esc(entry.id)}"><b>Время требует уточнения</b><small>${entry.status === 'cancelled' ? 'Отменена' : 'Неполный план · часы не учтены'}</small></button>`;
      const text = entry.kind === 'shift' || entry.kind === 'open_shift' ? `${local(entry.plannedStart, access.timezone).slice(11)}–${local(entry.plannedEnd, access.timezone).slice(11)}${local(entry.plannedEnd, access.timezone).slice(0, 10) !== entry.workDate ? ' +1 день' : ''}` : labels[entry.kind];
      const carry = day !== entry.workDate;
      const detail=carry?'Продолжение ночной смены':entry.kind==='open_shift'?'Свободная смена · не назначена':entry.status==='cancelled'?'Отменена':(['shift','open_shift'].includes(entry.kind)?labels[entry.kind]:'');
      return `<button type="button" class="schedule-entry schedule-kind-${esc(entry.kind)} ${entry.status === 'cancelled' ? 'is-cancelled' : ''}" data-entry="${esc(entry.id)}"><b>${carry ? `До ${esc(local(entry.plannedEnd, access.timezone).slice(11))}` : esc(text)}</b>${detail||entry.functionName||entry.breakMinutes?`<small>${detail?esc(detail):''}${entry.functionName?`${detail?' · ':''}${esc(entry.functionName)}`:''}${!carry && entry.breakMinutes ? ` · перерыв ${entry.breakMinutes} мин` : ''}</small>`:''}</button>`;
    }
    function draw() {
      if (!ready) return;
      const [from, to] = bounds();
      const search = q('[data-search]').value.trim().toLocaleLowerCase('ru-RU');
      const people = employees.filter(p => (!q('[data-person]').value || p.id === q('[data-person]').value)
        && (!q('[data-role]').value || p.role === q('[data-role]').value) && (!search || p.name.toLocaleLowerCase('ru-RU').includes(search)));
      const filtered = entries.filter(e => (e.kind==='open_shift'?!q('[data-person]').value&&!q('[data-role]').value&&(!search||'свободная смена'.includes(search)):people.some(p => p.id === e.userId)) && (e.status !== 'cancelled' || q('[data-cancelled]').checked));
      const openShifts=filtered.filter(e=>e.kind==='open_shift'&&e.status==='planned');
      const planned = filtered.filter(e => e.kind === 'shift' && e.status === 'planned' && e.workDate >= from && e.workDate <= to);
      const minutes = planned.reduce((sum, e) => sum + (planMinutes(e) ?? 0), 0);
      const incompletePlans = planned.filter(e => planMinutes(e) === null).length;
      const facts = actual.filter(row => people.some(p => p.id === row.userId));
      const worked = facts.reduce((sum,row)=>sum+row.minutes,0), incomplete = facts.reduce((sum,row)=>sum+row.openIntervals+row.invalidIntervals,0);
      const dateCoverage=coverage.filter(item=>!item.workDate||(item.workDate>=from&&item.workDate<=to));
      q('[data-summary]').innerHTML = `<strong>${esc(dayName(from))}${from !== to ? ` — ${esc(dayName(to))}` : ''}</strong><span>${planned.length} назначенных смен</span><span>План: ${hours(minutes)}</span>${openShifts.length?`<span class="schedule-warning">Свободных смен: ${openShifts.length}</span>`:''}<span>Факт: ${hours(worked)}</span>${dateCoverage.length?`<span class="schedule-warning">Покрытие: ${dateCoverage.length} замечаний</span>`:''}${incompletePlans || incomplete ? '<span class="schedule-warning">Есть неполные данные</span>' : ''}`;
      const coverageMessages={schedule_coverage_deficit:'Дефицит',schedule_coverage_surplus:'Избыток',schedule_coverage_break_unknown:'Перерыв не размещён · покрытие оценить точно нельзя',schedule_coverage_time_unverifiable:'Время потребности неоднозначно из-за перехода часов',schedule_coverage_double_assigned:'Сотрудник одновременно указан на разных функциях и не засчитан',schedule_demand_timezone_changed:'Часовой пояс изменён · переподтвердите правила потребности'};
      q('[data-coverage]').hidden=!dateCoverage.length;q('[data-coverage]').innerHTML=dateCoverage.length?`<summary>Подробности покрытия · ${dateCoverage.length}</summary><div class="schedule-coverage-details">${dateCoverage.slice(0,12).map(item=>`<div><strong>${esc(coverageMessages[item.code]||item.code)}</strong>${item.workDate?` · ${esc(item.workDate)}`:''}${item.start&&item.end?` · ${esc(local(item.start,access.timezone).slice(11))}–${esc(local(item.end,access.timezone).slice(11))}`:''}${item.functionId?` · ${esc(entries.find(e=>e.functionId===item.functionId)?.functionName||'Функция')}`:''}${item.required!==undefined?` · нужно ${item.required}, есть ${item.covered}`:''}</div>`).join('')}</div>`:'';
      q('[data-context]').textContent = `${dayName(from)} — ${dayName(to)} · ${access.timezone} · ${planned.length} смен · ${(minutes / 60).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ч по плану. Итоги по дате начала.`;
      if (incompletePlans) q('[data-context]').textContent += ` План неполный: ${incompletePlans} смен требуют уточнения времени и не включены в часы.`;
      q('[data-context]').textContent += ` Факт: ${(worked/60).toLocaleString('ru-RU',{maximumFractionDigits:2})} ч по завершённым интервалам.${incomplete ? ` Незакрытых или некорректных интервалов: ${incomplete}; факт неполный.` : ''} Плановый перерыв из факта автоматически не вычитается.`;
      explanationText.textContent=q('[data-context]').textContent;
      const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
      const dailyByDay = new Map(days.map(day => [day, []]));
      for (const entry of filtered) {
        dailyByDay.get(entry.workDate)?.push(entry);
        if (entry.status !== 'planned' || !['shift','open_shift'].includes(entry.kind) || !entry.plannedStart || !entry.plannedEnd) continue;
        const firstDay = addDays(local(entry.plannedStart, access.timezone).slice(0, 10), 1);
        const lastDay = local(new Date(Date.parse(entry.plannedEnd) - 1), access.timezone).slice(0, 10);
        for (let carryDay = firstDay; carryDay <= lastDay; carryDay = addDays(carryDay, 1)) dailyByDay.get(carryDay)?.push(entry);
      }
      if (!people.length&&!openShifts.length) { q('[data-grid]').innerHTML = '<p>Сотрудники не найдены.</p>'; return; }
      const today = local(new Date(), access.timezone).slice(0,10);
      const daily = day => dailyByDay.get(day) || [];
      const staffing = day => new Set(daily(day).filter(e => e.kind === 'shift' && e.status === 'planned'&&e.userId).map(e => e.userId)).size;
      const openCount = day => daily(day).filter(e=>e.kind==='open_shift'&&e.status==='planned').length;
      const desktop = mode === 'week' ? `<div class="schedule-week" tabindex="0" aria-label="График недели, прокручиваемая таблица"><table><thead><tr><th>Сотрудник / часы</th>${days.map(d => `<th class="${d === today ? 'is-today' : ''}"><button type="button" class="schedule-date-link" data-open-day="${d}">${esc(dayName(d))}</button><small>На сменах: ${staffing(d)}${openCount(d)?` · свободно: ${openCount(d)}`:''}</small></th>`).join('')}</tr></thead><tbody>${people.map(p => `<tr><th>${esc(p.name)}<small>${esc(roleNames[p.role] || p.role)} · ${hours(planned.filter(e => e.userId === p.id).reduce((sum,e) => sum + (planMinutes(e) ?? 0),0))}</small>${!p.active ? '<small>Неактивен</small>' : ''}</th>${days.map(d => `<td class="${d === today ? 'is-today' : ''}">${daily(d).filter(e => e.userId === p.id).map(e => card(e,d)).join('') || '<small>Не запланировано</small>'}${access.manage && p.active ? `<button type="button" class="schedule-add" data-add="${esc(p.id)}" data-day="${d}" aria-label="Назначить: ${esc(p.name)}, ${d}">+</button>` : ''}</td>`).join('')}</tr>`).join('')}<tr class="schedule-open-shifts"><th>Свободные смены<small>Не входят в персональные часы</small></th>${days.map(d=>`<td class="${d===today?'is-today':''}">${daily(d).filter(e=>e.kind==='open_shift').map(e=>card(e,d)).join('')||'<small>Нет</small>'}</td>`).join('')}</tr></tbody></table></div>` : '';
      const strip = `<nav class="schedule-day-strip" aria-label="Дни недели">${days.map(d => `<button type="button" class="${d === date ? 'is-selected' : ''}" aria-pressed="${d === date}" data-select-day="${d}">${esc(dayName(d))}<small>${staffing(d)} чел.</small></button>`).join('')}</nav>`;
      const dayCards = day => `<section><h2>${esc(dayName(day))}</h2>${daily(day).map(e => `<div><span>${esc(e.kind==='open_shift'?'Свободная смена':people.find(p => p.id === e.userId)?.name || e.userName)}</span>${card(e,day)}</div>`).join('') || '<p class="muted">Не запланировано</p>'}${access.manage ? `<button type="button" class="button" data-add="${esc(q('[data-person]').value)}" data-day="${day}">Назначить смену</button>` : ''}</section>`;
      let content = desktop;
      if (mode === 'month') {
        const offset = (new Date(from + 'T12:00Z').getUTCDay() + 6) % 7;
        content = `<div class="schedule-month schedule-days" aria-label="Календарь месяца">${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d=>`<b class="schedule-weekday">${d}</b>`).join('')}${Array.from({length:offset},()=>'<div class="schedule-calendar-pad" aria-hidden="true"></div>').join('')}${days.map(d=>{const records=daily(d).filter(e=>e.status==='planned');const absent=records.filter(e=>['day_off','vacation','sick','other_absence'].includes(e.kind)).length;const free=records.filter(e=>e.kind==='open_shift').length;const freeLabel=free===1?'свободная смена':free>=2&&free<=4?'свободные смены':'свободных смен';return `<button type="button" class="schedule-month-day ${d===today?'is-today':''}" data-open-day="${d}" aria-label="${esc(dayName(d))}: ${staffing(d)} сотрудников на сменах, ${absent} отсутствий, ${free} ${freeLabel}"><strong>${Number(d.slice(-2))}</strong><span>${staffing(d)} чел.</span><small>${absent} отсутств.</small>${free?`<small class="schedule-month-open">${free} свободн.</small>`:''}</button>`;}).join('')}</div>`;
      } else if (mode === 'day') {
        let dayStart, dayEnd;
        try { dayStart=Date.parse(instant(date+'T00:00',access.timezone)); dayEnd=Date.parse(instant(addDays(date,1)+'T00:00',access.timezone)); }
        catch { q('[data-grid]').innerHTML=`<p>В этот день перевод часов затрагивает полночь. Используйте точное время в карточках.</p><div class="schedule-days">${dayCards(date)}</div>`; q('[data-grid]').querySelectorAll('[data-entry]').forEach(button=>button.onclick=()=>openEntry(button)); return; }
        const dayDuration=dayEnd-dayStart;
        content = `<div class="schedule-timeline" tabindex="0" aria-label="Почасовой график дня"><div class="schedule-timeline-header"><b>Сотрудник · ${hours(dayDuration/60000)}</b><div>${Array.from({length:9},(_,i)=>`<span>${i===8?'24:00':esc(local(new Date(dayStart+dayDuration*i/8),access.timezone).slice(11))}</span>`).join('')}</div></div>${people.map(p=>`<div class="schedule-timeline-row"><strong>${esc(p.name)}</strong><div class="schedule-timeline-tracks">${daily(date).filter(e=>e.userId===p.id).map(e=>{
          if(e.kind!=='shift' || planMinutes(e)===null) return card(e,date);
          const start=local(e.plannedStart,access.timezone), end=local(e.plannedEnd,access.timezone);
          const a=Math.max(Date.parse(e.plannedStart),dayStart)-dayStart, b=Math.min(Date.parse(e.plannedEnd),dayEnd)-dayStart;
          return `<div class="schedule-timeline-track"><button type="button" class="schedule-time-bar ${e.status==='cancelled'?'is-cancelled':''}" data-entry="${esc(e.id)}" style="left:${100*a/dayDuration}%;width:${100*(b-a)/dayDuration}%" title="${esc(p.name)}: ${esc(start.replace('T',' '))} — ${esc(end.replace('T',' '))}"><span>${esc(start.slice(11))}–${esc(end.slice(11))}${e.workDate!==date?' · продолжение':''}${e.status==='cancelled'?' · отменена':''}</span></button></div>`;
        }).join('') || '<small>Не запланировано</small>'}</div></div>`).join('')}</div><div class="schedule-days schedule-day-detail">${dayCards(date)}</div>`;
      } else {
        content += `<div class="${mode==='week'?'schedule-mobile':''}">${mode==='week'?strip:''}<div class="schedule-days ${mode==='week'?'schedule-mobile':''}">${(mode==='week'?[date]:days).map(dayCards).join('')}</div></div>`;
      }
      q('[data-grid]').innerHTML = mode === 'month' ? `<div class="schedule-month-scroll">${content}</div>` : content;
      if(mode==='month') q('[data-grid]').querySelectorAll('[data-open-day]').forEach(button=>{
        const records=daily(button.dataset.openDay), preview=document.createElement('span');preview.className='schedule-month-preview';
        preview.textContent=records.slice(0,2).map(e=>`${e.kind==='open_shift'?'Свободная смена':people.find(p=>p.id===e.userId)?.name||e.userName}: ${['shift','open_shift'].includes(e.kind)&&e.plannedStart? (e.workDate < button.dataset.openDay?'до '+local(e.plannedEnd,access.timezone).slice(11):local(e.plannedStart,access.timezone).slice(11)+'–'+local(e.plannedEnd,access.timezone).slice(11)):labels[e.kind]}`).join('\n');
        if(records.length>2)preview.textContent+=`\nЕщё ${records.length-2}`;button.append(preview);
      });
      q('[data-grid]').querySelectorAll('[data-entry]').forEach(button => button.onclick = () => openEntry(button));
      q('[data-grid]').querySelectorAll('[data-add]').forEach(button => button.onclick = () => editor(null, button.dataset.add, button.dataset.day));
      q('[data-grid]').querySelectorAll('[data-select-day]').forEach(button => button.onclick = () => { date=button.dataset.selectDay; q('[data-date]').value=date; draw(); });
      q('[data-grid]').querySelectorAll('[data-open-day]').forEach(button => button.onclick = () => { date=button.dataset.openDay; mode='day'; q('[data-date]').value=date; q('[data-mode]').value=mode; q('[data-mode]')._customSelectRefresh?.(); load(); });
    }
    function openEntry(button){const entry=entries.find(e=>e.id===button.dataset.entry);if(entry?.kind==='open_shift'){if(access.manage)window.openSchedulePlanning({api,dialog,employees,access,date:entry.workDate,local,instant,refresh:load});else status('Это свободная смена. Назначить её можно через черновик графика при наличии права управления.');return;}editor(entry);}
    async function load() {
      const current = ++generation; status('Загрузка графика…');
      ready = false; entries = []; actual = [];
      q('[data-grid]').replaceChildren(); q('[data-context]').textContent = ''; q('[data-summary]').textContent = '';
      q('[data-create]').disabled = true;q('[data-csv]').disabled=true;q('[data-print]').disabled=true; if (q('[data-copy-week]')) q('[data-copy-week]').disabled = true;
      q('[data-grid]').inert = true;
      try {
        const [from, to] = bounds();
        const result = await api(`?from=${from}&to=${to}`);
        if (current !== generation) return;
        if (!Array.isArray(result.items) || !Array.isArray(result.actual) || !result.access?.view) throw new Error('Получен неполный ответ графика.');
        entries = [...result.items, ...(result.continuations || [])]; actual = result.actual; coverage=result.coverage?.advisories||[]; access = result.access; ready = true;
        q('[data-create]').hidden = !access.manage; if (q('[data-copy-week]')) q('[data-copy-week]').hidden = !access.manage;
        draw(); status(entries.length ? '' : 'В выбранном периоде пока нет записей.'); return true;
      } catch (error) { if (current === generation) status(error.message + ' Нажмите «Обновить».'); return false; }
      finally { if (alive() && current === generation) {
        q('[data-grid]').inert = !ready; q('[data-create]').disabled = !ready;q('[data-csv]').disabled=!ready;q('[data-print]').disabled=!ready;
        if (q('[data-copy-week]')) q('[data-copy-week]').disabled = !ready;
      } }
    }
    function dialog(title, content) {
      const node = document.createElement('dialog'); node.className = 'schedule-dialog ui-components';
      node.innerHTML = `<form><h2>${esc(title)}</h2>${content}<p data-error role="alert"></p><div class="schedule-actions"><button type="button" class="button" data-close>Закрыть</button><button type="submit" class="button primary" data-submit>Сохранить</button></div></form>`;
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
      const d = dialog(entry ? 'Запись графика' : 'Назначить смену', `<label>Сотрудник<select name="userId" required><option value="">Выберите сотрудника</option>${employees.filter(p => p.active || p.id === entry?.userId).map(p => `<option value="${esc(p.id)}" ${p.id === (entry?.userId || person) ? 'selected' : ''}>${esc(p.name)} · ${esc(roleNames[p.role]||'Сотрудник')}</option>`).join('')}</select></label><label>Тип<select name="kind">${Object.entries(labels).map(([key, value]) => `<option value="${key}" ${key === entry?.kind ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>Дата<input name="workDate" type="date" required value="${esc(entry?.workDate || day)}"></label><fieldset data-times><legend>Время заведения · ${esc(access.timezone)}</legend><label>Начало<input name="start" type="datetime-local" value="${esc(entry?.plannedStart ? local(entry.plannedStart, access.timezone) : day + 'T10:00')}"></label><label>Окончание<input name="end" type="datetime-local" value="${esc(entry?.plannedEnd ? local(entry.plannedEnd, access.timezone) : day + 'T18:00')}"></label><label>Неоплачиваемый перерыв, минут<input name="breakMinutes" type="number" min="0" step="1" value="${entry?.breakMinutes || 0}"></label></fieldset><label>Заметка<textarea name="note" maxlength="500">${esc(entry?.note)}</textarea></label><label>Причина изменения / отмены<textarea name="reason" maxlength="500"></textarea></label><p class="muted">Изменения прошлого периода требуют причины. Утверждённая зарплата автоматически не изменяется.</p>${entry && !readonly ? '<button type="button" class="button" data-cancel>Отменить смену / отсутствие</button>' : ''}`);
      const form = d.node.querySelector('form'); let requestKey = crypto.randomUUID();
      form.querySelector('[data-submit]').textContent = entry ? 'Сохранить изменения' : 'Добавить в график';
      const saveHint=document.createElement('p');saveHint.className='schedule-save-hint muted';saveHint.textContent=entry?'Изменение сразу появится в действующем графике.':'Запись сразу появится в действующем графике.';form.querySelector('.schedule-actions').before(saveHint);
      const breakPanel=document.createElement('fieldset');breakPanel.innerHTML='<legend>Перерывы по времени (необязательно)</legend><div data-break-rows></div><button type="button" class="button" data-add-break>Добавить интервал перерыва</button><small>Укажите точные границы, чтобы учитывать перерыв в покрытии. Если их нет, система не будет угадывать его положение.</small>';form.querySelector('[data-times]').append(breakPanel);
      const addBreakRow=value=>{const row=document.createElement('div');row.dataset.breakRow='';row.innerHTML=`<label>С<input type="datetime-local" data-break-start value="${esc(value?.start?local(value.start,access.timezone):'')}"></label><label>До<input type="datetime-local" data-break-end value="${esc(value?.end?local(value.end,access.timezone):'')}"></label><button type="button" class="button" data-remove-break>Убрать перерыв</button>`;row.querySelector('[data-remove-break]').onclick=()=>row.remove();breakPanel.querySelector('[data-break-rows]').append(row);};
      (entry?.breakIntervals||[]).forEach(addBreakRow);breakPanel.querySelector('[data-add-break]').onclick=()=>addBreakRow(null);
      const functionLabel=document.createElement('label');functionLabel.innerHTML=`Рабочая функция<select name="functionId"><option value="">Не задана</option>${entry?.functionId?`<option value="${esc(entry.functionId)}" selected>Текущая функция</option>`:''}</select>`;
      form.querySelector('[data-times]').before(functionLabel);
      const suggestionPanel=document.createElement('section');suggestionPanel.dataset.suggestion='';suggestionPanel.setAttribute('aria-live','polite');
      form.querySelector('[data-times]').after(suggestionPanel);
      if (!entry) {
        d.node.querySelector('h2').textContent = 'Смена или выходной на любую дату';
        const hint = document.createElement('p'); hint.className = 'muted';
        hint.textContent = 'Можно назначить одну запись заранее, даже если график на месяц ещё не составлен. Выберите тип и дату.';
        form.querySelector('h2').after(hint);
      }
      let previousDay = form.elements.workDate.value;
      let suggestionGeneration=0,manualTimeChanged=false,currentSuggestion=null;
      for(const field of [form.elements.start,form.elements.end,form.elements.breakMinutes])field.addEventListener('input',()=>{manualTimeChanged=true;});
      const applySuggestion=choice=>{
        if(!choice)return false;
        let slot=choice,member=null;
        if(choice.definition){member=choice.definition.mode==='team'?choice.definition.members?.find(item=>item.userId===form.elements.userId.value):null;const slots=member?member.slots:choice.definition.slots;if(!Array.isArray(slots)||slots.length!==1||slots[0].kind!=='shift')return false;slot=slots[0];}
        if(!slot.startTime||!slot.endTime)return false;
        const day=form.elements.workDate.value;form.elements.start.value=`${day}T${slot.startTime}`;
        form.elements.end.value=`${addDays(day,Number(slot.endDayOffset||0))}T${slot.endTime}`;
        form.elements.breakMinutes.value=String(slot.breakMinutes||0);
        const functionId=slot.functionId||member?.functionId||'';
        if(functionId&&[...form.elements.functionId.options].some(option=>option.value===functionId))form.elements.functionId.value=functionId;
        manualTimeChanged=false;requestKey=crypto.randomUUID();return true;
      };
      async function loadSuggestion(){
        const userId=form.elements.userId.value,current=++suggestionGeneration;
        suggestionPanel.textContent='Загрузка функций и подходящего времени…';
        try{
          const qualifications=await api(`/employees/${userId}/functions`);
          if(!d.node.isConnected||current!==suggestionGeneration||form.elements.userId.value!==userId)return;
          const selected=entry?.functionId||form.elements.functionId.value;
          const currentFunctionMissing=entry?.functionId&&!qualifications.items.some(item=>item.functionId===entry.functionId);
          form.elements.functionId.innerHTML='<option value="">Не задана</option>'+(currentFunctionMissing?`<option value="${esc(entry.functionId)}">Сохранённая функция · ${esc(entry.functionName||'вне текущей квалификации')}</option>`:'')+qualifications.items.map(item=>`<option value="${esc(item.functionId)}">${esc(item.name)}</option>`).join('');
          if([...form.elements.functionId.options].some(option=>option.value===selected))form.elements.functionId.value=selected;
          if(entry){suggestionPanel.textContent='Рабочую функцию можно изменить вручную.';return;}
          const result=await api(`/template-suggestions?employeeId=${encodeURIComponent(userId)}${form.elements.functionId.value?`&functionId=${encodeURIComponent(form.elements.functionId.value)}`:''}`);
          if(!d.node.isConnected||current!==suggestionGeneration||form.elements.userId.value!==userId)return;
          currentSuggestion=result;
          if(result.requiresChoice){suggestionPanel.innerHTML=`<label>Несколько подходящих шаблонов<select data-suggestion-choice><option value="">Выберите вариант</option>${result.choices.map(item=>`<option value="${esc(item.templateId)}">${esc(item.templateName)}</option>`).join('')}</select></label><button type="button" class="button" data-suggestion-apply>Применить выбранный шаблон</button>`;}
          else if(result.selection){suggestionPanel.innerHTML=`<p>Подходящее время найдено: ${esc(result.selection.templateName||'личное значение')}.</p><button type="button" class="button" data-suggestion-apply>Применить подсказку</button>`;if(!manualTimeChanged&&applySuggestion(result.selection))suggestionPanel.querySelector('p').textContent+=' Часы подставлены, их можно изменить.';}
          else suggestionPanel.textContent='Подходящего значения по умолчанию нет. Укажите время вручную.';
          suggestionPanel.querySelector('[data-suggestion-apply]')?.addEventListener('click',()=>{const choice=result.requiresChoice?result.choices.find(item=>item.templateId===suggestionPanel.querySelector('[data-suggestion-choice]').value):result.selection;if(!applySuggestion(choice))d.error('Для этой карточки выберите шаблон с одним интервалом смены.');else d.error('Часы подставлены. Проверьте их перед сохранением.');});
        }catch(error){if(current===suggestionGeneration&&d.node.isConnected)suggestionPanel.textContent=error.message+' Время можно указать вручную.';}
      }
      form.elements.userId.addEventListener('change',loadSuggestion);
      form.elements.functionId.addEventListener('change',()=>{if(!entry&&!manualTimeChanged)loadSuggestion();});
      loadSuggestion();
      form.elements.workDate.addEventListener('change', () => {
        const nextDay = form.elements.workDate.value;
        if (!nextDay || !previousDay) return;
        const delta = Math.round((Date.parse(nextDay + 'T12:00Z') - Date.parse(previousDay + 'T12:00Z')) / 86400000);
        for (const field of [form.elements.start, form.elements.end,...form.querySelectorAll('[data-break-start],[data-break-end]')]) {
          if (field.value && Number.isFinite(delta)) field.value = addDays(field.value.slice(0, 10), delta) + field.value.slice(10);
        }
        previousDay = nextDay;
      });
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
            breakMinutes: data.get('kind') === 'shift' ? Number(data.get('breakMinutes')) : 0,
            breakIntervals: data.get('kind') === 'shift' ? [...form.querySelectorAll('[data-break-row]')].map(row=>{const start=row.querySelector('[data-break-start]').value,end=row.querySelector('[data-break-end]').value;if(!start||!end)throw new Error('Заполните начало и окончание каждого перерыва или удалите незавершённый интервал.');return {start:instant(start,access.timezone),end:instant(end,access.timezone)};}) : [],
             functionId: data.get('kind') === 'shift' ? data.get('functionId')||null : null,
            confirmWarnings: !!form.elements.confirmWarnings?.checked
          };
          payload.requestKey = requestKey; if (entry) payload.version = entry.version;
          d.pending(true); d.error('Сохранение…');
          if(payload.confirmWarnings&&!String(payload.reason||'').trim())throw new Error('Для подтверждения предупреждения укажите причину.');
          await api(entry ? `/${entry.id}` : '', entry ? 'PATCH' : 'POST', payload);
          d.node.close(); if (!cancel) { date=payload.workDate; q('[data-date]').value=date; }
          if (await load()) status(cancel ? 'Запись отменена. История сохранена.' : 'Запись сохранена.');
        } catch (error) {
          if (error.code === 'schedule_version_conflict' && entry) { conflictPending=true; d.error('Конфликт версий. Ваш ввод сохранён.'); await compareLatest(); }
          else if(error.code==='schedule_warnings_confirmation_required'){
            if(!form.elements.confirmWarnings){const ack=document.createElement('label');ack.className='schedule-check';ack.innerHTML='<input type="checkbox" name="confirmWarnings" value="true">Подтверждаю показанные предупреждения и хочу сохранить смену';form.elements.reason.parentElement.after(ack);ack.querySelector('input').focus();form.querySelector('[data-submit]').textContent='Подтвердить и сохранить';}
            d.error('Смена не сохранена. Проверьте предупреждения. Для продолжения подтвердите их, укажите причину и нажмите «Сохранить» ещё раз.');
          }else d.error(error.message);
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
      let preview = null, requestKey = crypto.randomUUID(), query = null,confirmWarnings=false;
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
          await api('/copy/apply', 'POST', { ...query, fingerprint: preview.fingerprint, sourceIds, requestKey, reason: reasonInput.value,confirmWarnings });
          date = query.targetFrom; q('[data-date]').value = date; d.node.close();
          if (await load()) status('Выбранные записи скопированы.');
        } catch (error) { if(error.code==='schedule_warnings_confirmation_required'){confirmWarnings=true;d.error('Проверьте предупреждения и причину. Повторное нажатие подтвердит их и продолжит копирование.');}else d.error(error.message + ' При изменении графика обновите предпросмотр.'); }
        finally { d.pending(false); if (preview) preview.items.filter(item => item.conflict).forEach(item => { const el = area.querySelector(`[data-source="${item.sourceId}"]`); if (el) el.disabled = true; }); }
      };
    }
    async function grants() {
      try {
        const result = await api('/grants');
        const d = dialog('Доступ к графику', '<p>Права выдаёт только владелец. Управление настройками графика — отдельное право и доступно только при включённом управлении графиком.</p><div data-grant-list></div>');
        d.node.querySelector('button[type=submit]').remove();
        d.node.querySelector('form').onsubmit = e => e.preventDefault();
        const list = d.node.querySelector('[data-grant-list]');
        list.innerHTML = result.items.map(p => `<fieldset><legend>${esc(p.name)}</legend><label>Действующий график<select data-user="${esc(p.userId)}">${[['none','Нет доступа'],['view','Только просмотр'],['manage','Управление графиком']].map(([key,label]) => `<option value="${key}" ${p.access === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="schedule-check"><input type="checkbox" data-publish-user="${esc(p.userId)}" ${p.canPublish?'checked':''} ${p.access!=='manage'?'disabled':''}>Публикация графиков</label><label class="schedule-check"><input type="checkbox" data-settings-user="${esc(p.userId)}" ${p.canManageSettings?'checked':''} ${p.access!=='manage'?'disabled':''}>Настройка функций, шаблонов и правил</label></fieldset>`).join('') || '<p>Нет администраторов и управляющих для выдачи прав.</p>';
        list.querySelectorAll('select').forEach(select => select.onchange = async () => {
          const person = result.items.find(p => p.userId === select.dataset.user); d.pending(true);
          try { const saved = await api('/grants', 'PUT', { userId: person.userId, access: select.value, version: person.version }); Object.assign(person, saved); d.error('Права сохранены.'); }
          catch (error) { select.value = person.access; d.error(error.message); } finally { d.pending(false);syncPublish();syncSettings(); }
        });
        const syncPublish=()=>list.querySelectorAll('[data-publish-user]').forEach(input=>{const person=result.items.find(p=>p.userId===input.dataset.publishUser);input.disabled=person.access!=='manage';input.checked=!!person.canPublish;});
        list.querySelectorAll('[data-publish-user]').forEach(input=>input.onchange=async()=>{const person=result.items.find(p=>p.userId===input.dataset.publishUser);d.pending(true);try{Object.assign(person,await api('/grants','PUT',{userId:person.userId,access:person.access,version:person.version,canPublish:input.checked}));d.error('Право публикации сохранено.');}catch(error){d.error(error.message);}finally{d.pending(false);syncPublish();}});
        const syncSettings=()=>list.querySelectorAll('[data-settings-user]').forEach(input=>{const person=result.items.find(p=>p.userId===input.dataset.settingsUser);input.disabled=person.access!=='manage';input.checked=!!person.canManageSettings;});
        list.querySelectorAll('[data-settings-user]').forEach(input=>input.onchange=async()=>{const person=result.items.find(p=>p.userId===input.dataset.settingsUser);d.pending(true);try{Object.assign(person,await api('/grants','PUT',{userId:person.userId,access:person.access,version:person.version,canManageSettings:input.checked}));d.error('Право настройки графика сохранено.');}catch(error){d.error(error.message);}finally{d.pending(false);syncSettings();}});
      } catch (error) { status(error.message); }
    }
    async function demandSettings(){
      const d=dialog('Потребность в сотрудниках',`<p class="muted">Задайте минимум людей на функции и интервал времени. Правило действует по местному времени заведения; датированный период заменяет недельные правила для этой функции. Это ориентир покрытия, а не запрет публикации.</p><div data-demand-list></div><fieldset><legend data-demand-title>Новое правило</legend><input type="hidden" name="ruleId"><input type="hidden" name="version" value="0"><label>Рабочая функция<select name="functionId" required></select></label><label>Повторение<select name="scope"><option value="weekly">Каждую неделю</option><option value="date_range">На выбранные даты</option></select></label><label data-demand-weekday>День недели<select name="weekday">${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map((day,i)=>`<option value="${i+1}">${day}</option>`).join('')}</select></label><div data-demand-dates hidden><label>С даты<input type="date" name="effectiveFrom"></label><label>По дату включительно<input type="date" name="effectiveTo"></label></div><label>Начало<input type="time" name="startTime" value="10:00" required></label><label>Окончание<input type="time" name="endTime" value="18:00" required></label><label>Завершение<select name="endDayOffset"><option value="0">В тот же день</option><option value="1">На следующий день</option></select></label><label>Сколько сотрудников нужно<input type="number" name="requiredCount" min="1" max="100" value="1" required></label><label class="schedule-check"><input type="checkbox" name="active" checked>Правило активно</label><button type="button" class="button" data-demand-new>Новое правило</button></fieldset>`);
      const form=d.node.querySelector('form'),list=d.node.querySelector('[data-demand-list]');let functions=[],rules=[];
      const reset=()=>{form.elements.ruleId.value='';form.elements.version.value='0';form.elements.scope.value='weekly';form.elements.weekday.value='1';form.elements.effectiveFrom.value='';form.elements.effectiveTo.value='';form.elements.startTime.value='10:00';form.elements.endTime.value='18:00';form.elements.endDayOffset.value='0';form.elements.requiredCount.value='1';form.elements.active.checked=true;d.node.querySelector('[data-demand-title]').textContent='Новое правило';sync();};
      const sync=()=>{const dated=form.elements.scope.value==='date_range';d.node.querySelector('[data-demand-weekday]').hidden=dated;d.node.querySelector('[data-demand-dates]').hidden=!dated;form.elements.effectiveFrom.required=dated;form.elements.effectiveTo.required=dated;};
      const draw=()=>{list.innerHTML=rules.map(rule=>`<div class="planning-list-item"><strong>${esc(functions.find(item=>item.id===rule.functionId)?.name||'Функция')} · ${rule.scope==='weekly'?['Пн','Вт','Ср','Чт','Пт','Сб','Вс'][rule.weekday-1]:`${rule.effectiveFrom} — ${rule.effectiveTo}`}</strong><span>${esc(rule.startTime)}–${esc(rule.endTime)} · ${rule.requiredCount} чел. ${rule.active?'':'· в архиве'}</span><button type="button" class="button" data-demand-edit="${esc(rule.id)}">Изменить</button></div>`).join('')||'<p>Правила ещё не настроены. Можно задать недельный график или исключения на будущие даты.</p>';list.querySelectorAll('[data-demand-edit]').forEach(button=>button.onclick=()=>{const rule=rules.find(item=>item.id===button.dataset.demandEdit);form.elements.ruleId.value=rule.id;form.elements.version.value=String(rule.version);form.elements.functionId.value=rule.functionId;form.elements.scope.value=rule.scope;form.elements.weekday.value=String(rule.weekday||1);form.elements.effectiveFrom.value=rule.effectiveFrom||'';form.elements.effectiveTo.value=rule.effectiveTo||'';form.elements.startTime.value=rule.startTime;form.elements.endTime.value=rule.endTime;form.elements.endDayOffset.value=String(rule.endDayOffset);form.elements.requiredCount.value=String(rule.requiredCount);form.elements.active.checked=rule.active;d.node.querySelector('[data-demand-title]').textContent='Изменить правило';sync();});};
      try{functions=(await api('/functions')).items.filter(item=>item.active);form.elements.functionId.innerHTML='<option value="">Выберите функцию</option>'+functions.map(item=>`<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');rules=(await api('/demand-rules')).items;draw();}catch(error){d.error(error.message);}
      form.elements.scope.onchange=sync;d.node.querySelector('[data-demand-new]').onclick=reset;
      form.onsubmit=async event=>{event.preventDefault();const data=new FormData(form),ruleId=data.get('ruleId'),scope=data.get('scope'),body={functionId:data.get('functionId'),scope,weekday:scope==='weekly'?Number(data.get('weekday')):null,effectiveFrom:scope==='date_range'?data.get('effectiveFrom'):null,effectiveTo:scope==='date_range'?data.get('effectiveTo'):null,startTime:data.get('startTime'),endTime:data.get('endTime'),endDayOffset:Number(data.get('endDayOffset')),requiredCount:Number(data.get('requiredCount')),active:form.elements.active.checked,requestKey:crypto.randomUUID(),version:Number(data.get('version'))};d.pending(true);try{await api(`/demand-rules${ruleId?`/${ruleId}`:''}`,ruleId?'PATCH':'POST',body);rules=(await api('/demand-rules')).items;draw();reset();d.error('Правило сохранено и перечитано. Предпросмотр черновика обновится.');}catch(error){d.error(error.message);}finally{d.pending(false);}};
    }
    q('[data-refresh]').onclick = () => initialize();
    async function initialize() {
      ready=false;entries=[];actual=[];q('[data-grid]').replaceChildren();q('[data-summary]').textContent='';q('[data-context]').textContent='';status('Загрузка графика…');
      q('[data-create]').disabled=true;if(q('[data-copy-week]'))q('[data-copy-week]').disabled=true;if(q('[data-planning]'))q('[data-planning]').disabled=true;
      q('[data-refresh]').disabled = true;
      target.querySelectorAll('[data-prev],[data-next],[data-date],[data-mode],[data-person],[data-month-jump]').forEach(el=>{el.disabled=true;el._customSelectRefresh?.();});
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
      q('[data-demand]')?.remove();
      if (access.manage) {
        const planningButton=document.createElement('button');planningButton.type='button';planningButton.className='button';planningButton.dataset.planning='';planningButton.textContent='Составить график';planningButton.setAttribute('aria-label','Составить график');planningButton.title='Составить график';
        planningButton.onclick=()=>window.openSchedulePlanning({api,dialog,employees,access,date,local,instant,refresh:load});q('[data-create]').after(planningButton);
      }
      if(access.canManageSettings){const demandButton=document.createElement('button');demandButton.type='button';demandButton.className='button';demandButton.dataset.demand='';demandButton.textContent='Потребность';demandButton.setAttribute('aria-label','Настроить потребность в сотрудниках');demandButton.title='Потребность в сотрудниках';demandButton.onclick=demandSettings;(q('[data-planning]')||q('[data-create]')).after(demandButton);}
      q('[data-create]').onclick = () => editor(null, q('[data-person]').value);
      q('[data-csv]').onclick=downloadCsv;
      q('[data-print]').onclick=()=>{const meta=exportMeta();q('[data-export-meta]').textContent=`Период: ${meta.from} — ${meta.to} · Часовой пояс: ${meta.timezone} · Сформирован: ${meta.generatedAt}`;q('[data-export-meta]').hidden=false;window.addEventListener('afterprint',()=>{q('[data-export-meta]').hidden=true;},{once:true});window.print();};
      if (access.manage) {
        q('[data-copy-week]')?.remove();
        const copyButton = document.createElement('button'); copyButton.className = 'button'; copyButton.dataset.copyWeek = ''; copyButton.textContent = 'Копировать неделю'; copyButton.onclick = copyWeek;
        q('[data-grants]').before(copyButton);
      }
      q('[data-grants]').onclick = grants;
      q('[data-person]').onchange = draw;
      q('[data-search]').oninput=draw; q('[data-role]').onchange=draw; q('[data-cancelled]').onchange=draw;
      q('[data-today]').onclick=()=>{date=local(new Date(),access.timezone).slice(0,10);q('[data-date]').value=date;load();};
      q('[data-month-jump]').onchange = event => {
        if (!event.target.value) return;
        const today = local(new Date(), access.timezone).slice(0, 10);
        const month = new Date(today.slice(0, 7) + '-01T12:00Z');
        if (event.target.value === 'next') month.setUTCMonth(month.getUTCMonth() + 1);
        if (event.target.value === 'today') date = today;
        else { date = month.toISOString().slice(0, 10); mode = 'month'; }
        q('[data-date]').value = date; q('[data-mode]').value = mode; q('[data-mode]')._customSelectRefresh?.();
        event.target.value = ''; event.target._customSelectRefresh?.(); load();
      };
      q('[data-mode]').onchange = event => { mode = event.target.value; load(); };
      q('[data-date]').onchange = event => { if (event.target.value) { date = event.target.value; load(); } };
      const move = n => { if (mode === 'month') { const next = new Date(date.slice(0,7) + '-01T12:00Z'); next.setUTCMonth(next.getUTCMonth() + n); date = next.toISOString().slice(0,10); } else date = addDays(date, n * (mode==='day'?1:7)); q('[data-date]').value = date; load(); };
      q('[data-prev]').onclick = () => move(-1); q('[data-next]').onclick = () => move(1);
      initialized = true;
      target.querySelectorAll('[data-prev],[data-next],[data-date],[data-mode],[data-person],[data-month-jump]').forEach(el=>{el.disabled=false;el._customSelectRefresh?.();});
      await load();
      } catch (error) { status(error.message + ' Нажмите «Обновить».'); }
      finally { q('[data-refresh]').disabled = false; }
    }
    await initialize();
  };
})();
