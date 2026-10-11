'use strict';
// Standalone proposed lifecycle. No production imports, API, storage or authentication.
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeText = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let readState = 'ready';
let wizardStep = 0;
let editorDirty = false;
let editorDraft = false;
let readGeneration = 0;
let trayGeneration = 0;
let criticalUnknown = false;
const busy = new Set();
const openers = new Map();
const items = [
  {name:'Black Burn · Ягодный микс',code:'TB-014',dept:'Кальянная',quantity:240,unit:'г',min:500},
  {name:'Darkside · Core',code:'TB-006',dept:'Кальянная',quantity:1250,unit:'г',min:500},
  {name:'Уголь кокосовый · 25 мм',code:'CL-001',dept:'Кальянная',quantity:8,unit:'кг',min:12},
  {name:'Мундштуки индивидуальные',code:'AC-003',dept:'Кальянная',quantity:620,unit:'шт.',min:200},
  {name:'Тоник классический',code:'BR-008',dept:'Бар',quantity:4,unit:'л',min:8},
  {name:'Сироп ванильный',code:'KT-002',dept:'Кухня',quantity:2.5,unit:'л',min:2}
];
function showScreen(name) {
  $$('.screen').forEach(screen => screen.hidden = screen.id !== `screen-${name}`);
  $$('.nav-item').forEach(button => { const active = button.dataset.screen === name; button.classList.toggle('active', active); if(active) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); });
  $('#crumb').textContent = ({home:'Главная',inventory:'Склад',components:'Компоненты'})[name];
}
function renderKpis() {
  const zero = readState === 'zero';
  const entries = [
    ['Выручка за день',zero?'0':readState==='long'?'12 348 650 920':'43 520','₽',zero?'Подтверждённый ноль · 11 октября':'↗ 8,4% · к предыдущему дню','i-trend'],
    ['Заказов за день',zero?'0':'28','',zero?'Нет заказов · 11 октября':'11 октября · кассовый пример','i-check'],
    ['Средний чек за день',zero?'—':'1 554','₽',zero?'Нет заказов для расчёта':'Заказы за 11 октября','i-home'],
    ['Нужно пополнить',zero?'0':'3','позиции',zero?'Все остатки выше минимума':'Ниже минимального остатка','i-box']
  ];
  $('#kpis').innerHTML = entries.map(([label,value,unit,note,icon],i) => {
    const unavailable = ['unknown','loading','error','empty'].includes(readState);
    const text = readState==='error'?'Ошибка источника':readState==='loading'?'Загрузка примерных данных':readState==='empty'?'Нет данных для расчёта':'Источник ещё не готов';
    return `<article class="kpi"><div class="kpi-top"><span>${label}</span><svg aria-hidden="true"><use href="#${icon}"/></svg></div>${readState==='loading'?'<span class="skeleton" aria-label="Загрузка"></span>':`<div class="kpi-value ${readState==='long'&&i===0?'large-value':''} ${readState==='error'?'read-error':''}">${unavailable?'—':value} <span>${unavailable?'':unit}</span></div>`}<div class="kpi-bottom ${!unavailable&&!zero&&i===0?'good':''}">${unavailable?text:note}</div></article>`;
  }).join('');
  const hasShift = !['empty','unknown','error','loading'].includes(readState);
  $('#shift-badge').textContent = hasShift?'Открыта':readState==='empty'?'Нет открытой смены':'Состояние неизвестно';
  $('#shift-badge').className = `badge ${hasShift?'success':'neutral'}`;
  $('#shift-duration').textContent = hasShift?'6 ч 24 мин':'—';
  $('#shift-orders').textContent = hasShift?(zero?'0':'28'):'—';
  $('#shift-average').textContent = hasShift&&!zero?'1 554 ₽':'—';
  $('.bottom-grid .panel-heading p').textContent=hasShift?'11 октября · открыта в 12:00':readState==='empty'?'11 октября · открытой смены нет':'11 октября · состояние смены не подтверждено';
  // The independent weekly chart must not imply readiness of a failed read source.
  $('.revenue-panel').hidden = ['unknown','loading','error','empty','zero'].includes(readState);
  $('.overview-grid').classList.toggle('single-panel', $('.revenue-panel').hidden);
}
function renderTable() {
  const unavailable = ['unknown','error','loading','empty'].includes(readState);
  const summary = $$('.inventory-summary strong');
  summary[0].textContent = readState==='empty' ? '0' : unavailable ? '—' : '6';
  summary[1].textContent = readState==='empty' ? '0' : unavailable ? '—' : readState === 'zero' ? '0' : '3';
  summary[2].textContent = unavailable ? '—' : readState === 'zero' ? '0 ₽' : '84 920 ₽';
  $$('.inventory-summary small')[0].textContent = unavailable&&readState!=='empty' ? 'Количество позиций неизвестно' : 'Позиций в образце';
  $$('.inventory-summary small')[2].textContent = unavailable ? 'Стоимость не рассчитана' : 'Стоимость остатков · пример';
  $('.attention-panel .badge').textContent = unavailable ? 'Источник не готов' : readState === 'zero' ? 'Нет событий склада' : '3 события';
  $('.attention-row strong').textContent = unavailable ? 'Остатки неизвестны' : readState === 'zero' ? 'Пополнение не требуется' : 'Нужно пополнить склад';
  $('.attention-row p').textContent = unavailable ? 'Минимальные остатки не проверены' : readState === 'zero' ? 'В примере нет позиций ниже минимума' : '3 позиции ниже минимального остатка';
  $('.nav-count').textContent=unavailable?'—':readState==='zero'?'0':'3';
  const target = $('#table-area');
  if (['loading','empty','error','unknown'].includes(readState)) {
    const descriptions = {loading:['Загрузка остатков','Ожидание в образце. Источник не подключён.'],empty:['На складе пока нет позиций','Добавьте позицию, чтобы проверить длинную форму.'],error:['Не удалось получить остатки','Ошибка симуляции. Последние значения не подменяются нулём.'],unknown:['Остатки неизвестны','Источник не готов. Количество и стоимость не рассчитаны.']};
    const [title,description] = descriptions[readState];
    target.innerHTML = `<div class="state-box" ${readState==='loading'?'aria-busy="true"':''}>${readState==='loading'?'<span class="spinner" aria-hidden="true"></span>':''}<strong>${title}</strong><p>${description}</p>${readState==='error'?'<button class="button quiet" id="table-retry">Повторить загрузку</button>':readState==='empty'?`<button class="button primary" data-open="editor" ${$('#role').value!=='Владелец'?'disabled title="Демонстрация ограничения права"':''}>Добавить пример позиции</button>`:''}</div>`;
    $('#row-count').textContent = readState==='empty'?'0 позиций в образце':'Список не готов';
    return;
  }
  const query = $('#search').value.trim().toLocaleLowerCase('ru');
  const department = $('#department').value;
  const source = items.map((item,i) => readState==='long'&&i===0?{...item,name:'Табачная смесь ограниченной серии со сложным наименованием, уточнением вкуса и дополнительным описанием поставщика',quantity:123456789.125,unit:'граммов условной единицы хранения',min:200000000}:readState==='zero'?{...item,quantity:0,min:0}:item);
  const rows = source.filter(item => (!query||`${item.name} ${item.code}`.toLocaleLowerCase('ru').includes(query))&&(department==='all'||item.dept===department));
  $('#row-count').textContent = `Показано ${rows.length} из ${source.length} позиций`;
  if (!rows.length) { target.innerHTML = '<div class="state-box"><strong>Ничего не найдено</strong><p>Попробуйте другое название или снимите фильтр подразделения.</p><button class="button quiet" id="no-matches-clear">Сбросить фильтры</button></div>'; return; }
  target.innerHTML = `<table><caption class="visually-hidden">Пример остатков склада</caption><thead><tr><th scope="col">Позиция</th><th scope="col">Подразделение</th><th scope="col">Остаток</th><th scope="col">Минимум</th><th scope="col">Статус</th></tr></thead><tbody>${rows.map(item => `<tr><td><strong>${escapeText(item.name)}</strong><small>${item.code}</small></td><td>${item.dept}</td><td class="quantity">${item.quantity.toLocaleString('ru-RU',{maximumFractionDigits:3})} ${escapeText(item.unit)}</td><td class="quantity">${item.min.toLocaleString('ru-RU')} ${escapeText(item.unit)}</td><td><span class="badge ${item.quantity<item.min?'warning':'success'}">${item.quantity<item.min?'Нужно пополнить':'Достаточно'}</span></td></tr>`).join('')}</tbody></table>`;
}
function setReadState(value) { readGeneration++; readState=value; $('#read-state').value=value; renderKpis(); renderTable(); }
function clearFilters() { $('#search').value=''; $('#department').value='all'; renderTable(); }
function openDialog(id,opener) {
  const dialog = $(`#${id}`);
  if(dialog.open) return;
  openers.set(dialog,opener||document.activeElement);
  if(id==='editor') { $('#editor-message').hidden=true; if(editorDraft) message($('#editor-message'),'info','Черновик восстановлен из памяти образца.'); }
  if(id==='wizard') renderWizard();
  if(id==='critical') {
    $('#critical-message').hidden=!criticalUnknown;
    $('#critical-submit').disabled=criticalUnknown;
    $('#critical-submit').textContent='Подтвердить 3 200 ₽';
    $('#critical-reset').hidden=!criticalUnknown;
    if(criticalUnknown) message($('#critical-message'),'warning','Результат предыдущей симуляции неизвестен. Повторный возврат заблокирован до сверки. Сброс образца начинает отдельную симуляцию, он не подтверждает результат операции.');
  }
  if(id==='tray') renderTray();
  if(id==='tray') dialog.show();
  else { dialog.showModal(); document.documentElement.classList.add('dialog-open'); }
  const first = id==='editor'?$('#item-name'):id==='wizard'?$('.wizard-step:not([hidden]) input',dialog):id==='discard'? $('[data-close]',dialog):$('[data-close]',dialog)||$('button',dialog);
  first?.focus();
}
function closeDialog(dialog) {
  if(busy.has(dialog.id)) return;
  if(dialog.id==='editor') editorDraft=editorDirty;
  dialog.close();
}
$$('dialog').forEach(dialog => {
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(dialog); });
  dialog.addEventListener('close', () => { if(!$$('dialog[open]:not(#tray)').length) document.documentElement.classList.remove('dialog-open'); const opener=openers.get(dialog); if(opener?.isConnected) opener.focus(); });
});
$('#tray').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closeDialog($('#tray'));}});
function message(element,kind,text) { element.hidden=false; element.className=`inline-message ${kind}`; element.textContent=text; }
function setBusy(dialogId,value) {
  const dialog=$(`#${dialogId}`);
  if(value) busy.add(dialogId); else busy.delete(dialogId);
  dialog.setAttribute('aria-busy',String(value));
  $$('button, input, select, textarea',dialog).forEach(control => {
    if(value) { control.dataset.wasDisabled=String(control.disabled); control.disabled=true; }
    else { control.disabled=control.dataset.wasDisabled==='true'; delete control.dataset.wasDisabled; }
  });
}
function toast(kind,text) {
  const notices={success:['Симуляция завершена','Подтверждённый успех в образце. Рабочие данные не изменялись.'],info:['Информация','Это отдельный демонстрационный интерфейс. Все данные примерные.'],warning:['Нужна проверка','Пример предупреждения: источник расходов ещё не сверён. Финансовый результат не готов.'],error:['Ошибка симуляции','Не удалось подтвердить операцию. Введённые значения сохранены. Проверьте состояние источника перед повтором. Важная ошибка остаётся видимой до ручного закрытия.']};
  const [title,defaultText]=notices[kind];
  const node=document.createElement('div'); node.className=`toast ${kind}`; node.setAttribute('role',kind==='error'?'alert':'status');
  node.innerHTML=`<div><strong>${title}</strong><p>${escapeText(text||defaultText)}</p><small>Предложение: ручное закрытие сообщения</small></div><button class="toast-close" aria-label="Закрыть сообщение (предложение)">×</button>`;
  node.querySelector('button').addEventListener('click',()=>node.remove()); $('#toast-region').append(node);
  if(kind!=='error') setTimeout(()=>node.remove(),6500);
}
document.addEventListener('click',event => {
  const opener=event.target.closest('[data-open]'); if(opener) openDialog(opener.dataset.open,opener);
  const closer=event.target.closest('[data-close]'); if(closer) closeDialog(closer.closest('dialog'));
  const screen=event.target.closest('[data-screen], [data-go]'); if(screen) showScreen(screen.dataset.screen||screen.dataset.go);
  const feedback=event.target.closest('[data-toast]'); if(feedback) toast(feedback.dataset.toast);
  if(event.target.closest('#table-retry')) { setReadState('loading'); const generation=readGeneration; setTimeout(()=>{if(generation!==readGeneration)return;setReadState('ready');toast('info','Загрузка примерных остатков завершена. Сервер не вызывался.');},900); }
  if(event.target.closest('#no-matches-clear')) clearFilters();
});
$('#read-state').addEventListener('change',event=>setReadState(event.target.value));
$('#role').addEventListener('change',event=>{
  const limited=event.target.value!=='Владелец';
  $$('#screen-home [data-open], #screen-inventory [data-open]').forEach(button=>{button.disabled=limited;button.title=limited?'Демонстрация ограничения права':'';});
  $('.simulation-label').textContent=limited?'Демонстрация ограничения права':'Не проверяет права';
  toast('info',`Выбрана роль «${event.target.value}» в симуляции. Это не авторизация и не проверка доступа. Образцы окон доступны на экране «Компоненты».`);
});
$('#search').addEventListener('input',renderTable); $('#department').addEventListener('change',renderTable); $('#clear-filters').addEventListener('click',clearFilters);
$('#finance-details').addEventListener('click',()=>{ $('#finance-panel').scrollIntoView({block:'nearest'}); $('#finance-retry').focus(); });
$('#finance-retry').addEventListener('click',()=>{ const button=$('#finance-retry'); button.disabled=true; button.setAttribute('aria-busy','true'); $('#finance-status').textContent='Проверяем готовность · симуляция…'; setTimeout(()=>{button.disabled=false;button.removeAttribute('aria-busy');$('#finance-status').textContent='Источник недоступен. Итог по-прежнему неизвестен, это не 0 ₽.';toast('warning','Финансовый источник не готов в этом образце. Прибыль не рассчитана.');},1000); });
$('#editor-form').addEventListener('input',()=>{editorDirty=true;});
$('#editor-form').addEventListener('change',()=>{editorDirty=true;});
$('#editor-form').addEventListener('submit',event=>{
  event.preventDefault(); if(busy.has('editor')) return;
  const name=$('#item-name'), quantity=$('#item-quantity'); const invalidName=!name.value.trim(), invalidQuantity=quantity.value===''||!quantity.validity.valid;
  $('#name-error').hidden=!invalidName; $('#quantity-error').hidden=!invalidQuantity;
  name.setAttribute('aria-invalid',String(invalidName));quantity.setAttribute('aria-invalid',String(invalidQuantity));
  if(invalidName||invalidQuantity) { message($('#editor-message'),'error','Исправьте отмеченные поля. Введённые данные сохранены.'); (invalidName?name:quantity).focus(); return; }
  if(!$('#item-minimum').validity.valid||!$('#item-date').validity.valid) { message($('#editor-message'),'error','Проверьте минимальный запас и дату. Значения формы сохранены.'); (!$('#item-minimum').validity.valid?$('#item-minimum'):$('#item-date')).focus(); return; }
  const outcome=$('#editor-outcome').value;
  setBusy('editor',true); $('#editor-save').textContent='Сохранение…'; message($('#editor-message'),'info','Ожидание симуляции. Закрытие и повторное сохранение заблокированы.');
  setTimeout(()=>{setBusy('editor',false);$('#editor-save').textContent='Сохранить пример';if(outcome==='error'){message($('#editor-message'),'error','Ошибка сохранения в симуляции. Ввод сохранён; можно изменить исход и повторить.');$('#editor-save').focus();}else{editorDirty=false;editorDraft=false;closeDialog($('#editor'));$('#editor-form').reset();toast('success','Сохранение подтверждено в симуляции. Реальная позиция не создана; пример таблицы остаётся иллюстрацией.');}},2500);
});
$('#discard-editor').addEventListener('click',()=>openDialog('discard',$('#discard-editor')));
$('#confirm-discard').addEventListener('click',()=>{ $('#editor-form').reset(); editorDirty=false;editorDraft=false;$('#editor-message').hidden=true;$('#name-error').hidden=true;$('#quantity-error').hidden=true;$$('[aria-invalid]',$('#editor')).forEach(field=>field.removeAttribute('aria-invalid'));closeDialog($('#discard'));toast('info','Черновик образца удалён.'); });
function renderWizard() {
  $$('.wizard-step').forEach(step=>step.hidden=Number(step.dataset.step)!==wizardStep);
  $$('.steps li').forEach((step,i)=>{step.classList.toggle('current',i===wizardStep);if(i===wizardStep)step.setAttribute('aria-current','step');else step.removeAttribute('aria-current');});
  $('#wizard-back').disabled=wizardStep===0; $('#wizard-next').textContent=wizardStep===2?'Подтвердить пример':'Далее';
  if(wizardStep===2) { const data=new FormData($('#wizard-form')); const entries=[['Гость',data.get('guest')],['Контакт',data.get('phone')||'Не указан'],['Дата / время',`${data.get('date')} · ${data.get('time')}`],['Гостей',data.get('count')],['Пожелания',data.get('note')||'Не указаны']];$('#booking-review').innerHTML=entries.map(([label,value])=>`<dt>${label}</dt><dd>${escapeText(value)}</dd>`).join(''); }
}
$('#wizard-back').addEventListener('click',()=>{if(wizardStep>0&&!busy.has('wizard')){wizardStep--;$('#wizard-message').hidden=true;renderWizard();$('.wizard-step:not([hidden]) input').focus();}});
$('#wizard-form').addEventListener('submit',event=>{
  event.preventDefault();if(busy.has('wizard'))return;
  const step=$(`.wizard-step[data-step="${wizardStep}"]`);const invalid=$$('input',step).find(input=>!input.validity.valid||(input.required&&!input.value.trim()));
  if(invalid){message($('#wizard-message'),'error','Заполните обязательные поля текущего шага. Ввод сохранён.');invalid.setAttribute('aria-invalid','true');invalid.focus();return;}
  $('#wizard-message').hidden=true;$$('[aria-invalid]',step).forEach(input=>input.removeAttribute('aria-invalid'));
  if(wizardStep<2){wizardStep++;renderWizard();const focus=wizardStep===2?$('#wizard-next'):$('.wizard-step:not([hidden]) input');focus.focus();return;}
  setBusy('wizard',true);$('#wizard-next').textContent='Подтверждение…';
  setTimeout(()=>{setBusy('wizard',false);closeDialog($('#wizard'));toast('success','Пример брони подтверждён. На сервере бронь не создавалась.');wizardStep=0;$('#wizard-form').reset();renderWizard();},2500);
});
$('#critical-form').addEventListener('submit',event=>{
  event.preventDefault();if(busy.has('critical')||criticalUnknown)return;
  const outcome=$('#critical-outcome').value;setBusy('critical',true);$('#critical-submit').textContent='Подтверждение…';message($('#critical-message'),'info','Ожидание симуляции. Повторное действие и закрытие заблокированы.');
  setTimeout(()=>{setBusy('critical',false);$('#critical-submit').textContent='Подтвердить 3 200 ₽';if(outcome==='success'){message($('#critical-message'),'success','Успех подтверждён в симуляции. Реальный возврат не выполнен.');$('#critical-submit').disabled=true;toast('success','Возврат 3 200 ₽ подтверждён только в симуляции.');}else if(outcome==='error'){message($('#critical-message'),'error','Подтверждённая ошибка симуляции. Возврат не выполнен. Можно выбрать другой исход и повторить.');}else{criticalUnknown=true;message($('#critical-message'),'warning','Результат неизвестен. Успех не подтверждён. Повторный возврат заблокирован: сначала нужна сверка статуса операции. В этом образце нет API для сверки.');$('#critical-submit').disabled=true;$('#critical-reset').hidden=false;} $('[data-close]',$('#critical')).focus();},2500);
});
$('#critical-reset').addEventListener('click',()=>{criticalUnknown=false;$('#critical-reset').hidden=true;$('#critical-submit').disabled=false;message($('#critical-message'),'info','Состояние дизайн-образца сброшено для новой симуляции. Результат предыдущей операции не подтверждён. Это не сверка и не повтор рабочего возврата.');});
$('#legacy-confirm').addEventListener('click',()=>{closeDialog($('#legacy'));toast('info','Legacy подтверждение получено в образце. Категория на сервере не архивировалась.');});
function renderTray() {
  const state=$('#tray-state').value;
  $('#unread-label').textContent=state==='list'?'2 непрочитанных · пример':state==='zero'?'0 непрочитанных · пример':'Статус центра · симуляция';
  $('.unread-dot').hidden=state!=='list';
  const target=$('#tray-content');
  if(state==='list'||state==='zero'){target.innerHTML=`<article class="notification-row"><h3>Нужно пополнить 3 позиции</h3><p>Black Burn, уголь и тоник: примерные остатки ниже минимума.</p><small>${state==='zero'?'Прочитано':'Не прочитано'} · сегодня, 17:40</small><div><button class="text-button" id="tray-inventory">Открыть пример склада →</button></div></article><article class="notification-row"><h3>Финансовый результат не готов</h3><p>Длинный пример уведомления: расходы и остатки требуют сверки. Источник не подтверждён, поэтому итог периода нельзя показывать как нулевую прибыль.</p><small>${state==='zero'?'Прочитано':'Не прочитано'} · сегодня, 16:20</small></article>${state==='list'?'<button class="button quiet" id="mark-read">Отметить пример прочитанным</button>':''}`;}
  else if(state==='empty')target.innerHTML='<div class="state-box"><strong>Уведомлений пока нет</strong><p>Список пуст. Это состояние истории, а не показателей заведения.</p></div>';
  else if(state==='loading')target.innerHTML='<div class="state-box" aria-busy="true"><span class="spinner" aria-hidden="true"></span><strong>Загрузка уведомлений</strong><p>Симуляция ожидания</p></div>';
  else target.innerHTML='<div class="state-box"><strong>Центр недоступен</strong><p>Не удалось загрузить историю в симуляции.</p><button class="button quiet" id="tray-retry">Повторить</button></div>';
}
$('#notifications').addEventListener('click',()=>openDialog('tray',$('#notifications')));$('#open-tray').addEventListener('click',()=>openDialog('tray',$('#open-tray')));$('#tray-state').addEventListener('change',()=>{trayGeneration++;renderTray();});
$('#tray-content').addEventListener('click',event=>{if(event.target.closest('#mark-read')){trayGeneration++;$('#tray-state').value='zero';renderTray();}if(event.target.closest('#tray-inventory')){closeDialog($('#tray'));showScreen('inventory');}if(event.target.closest('#tray-retry')){const generation=++trayGeneration;$('#tray-state').value='loading';renderTray();setTimeout(()=>{if(generation!==trayGeneration)return;$('#tray-state').value='list';renderTray();},900);}});
renderKpis();renderTable();showScreen('home');
