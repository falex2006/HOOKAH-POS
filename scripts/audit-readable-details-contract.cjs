const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('portal.js', 'utf8');
const start = source.indexOf('const auditReadableRows =');
const end = source.indexOf('let auditItems =', start);
assert(start >= 0 && end > start);
const run = event => JSON.parse(JSON.stringify(vm.runInNewContext(`${source.slice(start,end)}; auditReadableRows(event);`, { event }, { timeout:1000 })));
assert.deepEqual(run({action:'finance.report_generated',afterData:{date:'2026-10-20',type:'x',revenue:200}}),[{label:'Дата отчёта',text:'20.10.2026'},{label:'Тип отчёта',text:'X-отчёт'}]);
assert.deepEqual(run({beforeData:{price:0,active:false},afterData:{price:200,active:true}}),[{label:'Цена',text:'0 → 200'},{label:'Активен',text:'Нет → Да'}]);
assert.deepEqual(run({afterData:{password:'secret',passportData:{number:'secret'},name:{nested:'data'},permissionScopes:['all']}}),[]);
assert.deepEqual(run({beforeData:{name:'Same'},afterData:{name:'Same'}}),[]);
assert.deepEqual(run({afterData:{title:'<img onerror=alert(1)>'}}),[{label:'Название',text:'<img onerror=alert(1)>'}]);
assert.match(source,/esc\(row\.label\)/);assert.match(source,/esc\(row\.text\)/);
assert.match(source,/querySelector\('\.audit-technical'\)\.open = false/);
console.log('AUDIT READABLE DETAILS: PASS (report, scalar changes, sensitive/nested exclusion, unchanged, escaped render, collapsed reset)');

assert.deepEqual(run({action:'finance.report_generated',afterData:{type:'unknown'}}),[]);
// Exercise the actual bindings: custom selects emit change, typing emits input.
const bindingStart = source.indexOf("['audit-search','audit-action','audit-entity','audit-from','audit-to'].forEach");
const bindingEnd = source.indexOf("document.querySelector('#audit-detail-close')", bindingStart);
assert(bindingStart >= 0 && bindingEnd > bindingStart);
let renders = 0;
const nodes = Object.fromEntries(['audit-search','audit-action','audit-entity','audit-from','audit-to','audit-reset'].map(id => [id,{value:'selected',events:{},refreshes:0,addEventListener(name,fn){this.events[name]=fn;},_customSelectRefresh(){this.refreshes++;}}]));
vm.runInNewContext(source.slice(bindingStart,bindingEnd),{document:{querySelector:selector=>nodes[selector.slice(1)]},renderAudit:()=>renders++},{timeout:1000});
for(const id of ['audit-action','audit-entity']){assert.equal(typeof nodes[id].events.change,'function');nodes[id].events.change();}
for(const id of ['audit-search','audit-from','audit-to'])assert.equal(typeof nodes[id].events.input,'function');
assert.equal(renders,2);nodes['audit-reset'].events.click();assert.equal(renders,3);
for(const id of ['audit-search','audit-action','audit-entity','audit-from','audit-to']){assert.equal(nodes[id].value,'');assert.equal(nodes[id].refreshes,1);}
console.log('AUDIT FILTER BINDINGS: PASS (custom change, text/date input, reset value and displayed selection)');
const labelsStart = source.indexOf('const auditActionLabels =');
const labelsEnd = source.indexOf('const renderAudit =', labelsStart);
const search = event => vm.runInNewContext(`${source.slice(labelsStart,labelsEnd)}; auditText(event);`, {event}, {timeout:1000});
assert(search({action:'finance.expense_draft_cancelled',entityType:'finance_expense_draft'}).includes('отменён черновик расхода'));
assert(search({action:'product.image_updated',entityType:'product'}).includes('изменено фото товара'));
assert(search({action:'future.event',entityType:'future'}).includes('future.event'));
const actionStart=source.indexOf('const auditActionLabels =');const actionEnd=source.indexOf('const auditLabels =',actionStart);const actions=vm.runInNewContext(`${source.slice(actionStart,actionEnd)}; ({auditActionName,auditActionExportName,auditActionFilterValue});`,{}, {timeout:1000});
assert.equal(actions.auditActionName('order.item_preparation_changed'),'Изменён этап приготовления');
assert.equal(actions.auditActionName('future.event'),'Событие системы');
assert.equal(actions.auditActionFilterValue('future.event'),'__other__');
assert.equal(actions.auditActionExportName('future.event'),'future.event');
for(const [action,label] of [['inventory.purchase_document_voided','Отменена накладная'],['order.items_dispatched','Позиции переданы на приготовление'],['delivery.created','Создан заказ доставки'],['finance_category.archived','Архивирована категория финансов'],["finance_category.created","Создана категория финансов"]]) assert.equal(actions.auditActionName(action),label);
assert.match(source,/custom_staff_role: 'Пользовательская роль'/);assert.match(source,/system_role: 'Системная роль'/);assert.match(source,/order_refund: 'Возврат заказа'/);assert.match(source,/auditLabels\[event\.entityType\] \|\| 'Объект системы'/);assert.match(source,/id=\"audit-code\"/);
assert.match(source,/querySelector\('#audit-code'\)\.textContent = event\.action/);
assert.match(source,/<option value=\"delivery\">Доставка<\/option>/);
assert.match(source,/<option value=\"purchase_document\">Накладные<\/option>/);
console.log('AUDIT TRANSLATED SEARCH AND LABELS: PASS');
for (const asset of ['portal.js', 'dist/portal.js']) {
  const implementation = fs.readFileSync(asset, 'utf8');
  const helperStart = implementation.indexOf('const auditDateRangeInvalid =');
  const helperEnd = implementation.indexOf(';', helperStart) + 1;
  assert(helperStart >= 0 && helperEnd > helperStart);
  const invalid = vm.runInNewContext(`${implementation.slice(helperStart, helperEnd)}; auditDateRangeInvalid`, {}, { timeout: 1000 });
  assert.equal(invalid('2026-10-23', '2026-10-22'), true, `${asset}: reversed range`);
  assert.equal(invalid('2026-10-22', '2026-10-23'), false, `${asset}: valid range`);
  assert.equal(invalid('', '2026-10-23'), false, `${asset}: open range`);
  assert.match(implementation, /id=\"audit-date-range-error\" role=\"alert\"/);
  assert.match(implementation, /setAttribute\('aria-invalid', 'true'\)/);
  assert.match(implementation, /auditFilteredItems = filtered/);
  assert.match(implementation, /\.\.\.auditFilteredItems\.map\(\(event\) => \[formatRuDate/);
}
console.log('AUDIT DATE VALIDATION AND FILTERED EXPORT: PASS (source and published asset)');

for (const asset of ['portal.js', 'dist/portal.js']) {
  const implementation = fs.readFileSync(asset, 'utf8');
  const helperStart = implementation.indexOf('const pluralRu=');
  const helperEnd = implementation.indexOf(';', implementation.indexOf('};', helperStart) + 1);
  assert(helperStart >= 0 && helperEnd > helperStart);
  const pluralRu = vm.runInNewContext(`${implementation.slice(helperStart, helperEnd)}; pluralRu`, {}, { timeout: 1000 });
  for (const [value, expected] of [[0,'событий'],[1,'событие'],[2,'события'],[4,'события'],[5,'событий'],[11,'событий'],[14,'событий'],[21,'событие'],[22,'события'],[25,'событий']]) assert.equal(pluralRu(value,'событие','события','событий'),expected,`${asset}: ${value}`);
  assert.match(implementation, /pluralRu\(filtered\.length, 'событие', 'события', 'событий'\)/);
}
console.log('AUDIT COUNT PLURALIZATION: PASS (source and published asset)');

