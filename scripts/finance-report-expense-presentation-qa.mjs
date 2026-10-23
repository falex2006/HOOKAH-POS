import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const esc=value=>String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
for(const file of ['portal.js','dist/portal.js']){
 const src=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
 const detailsStart=src.indexOf('const details=row=>');
 const start=src.indexOf('cashOutflows:',detailsStart),end=src.indexOf(',refundTenders:',start);
 assert.ok(detailsStart>=0&&start>detailsStart&&end>start);
 const expression=src.slice(start+'cashOutflows:'.length,end);
 const actionStart=src.indexOf('const sourceAction=row=>',end),actionEnd=src.indexOf(';return `<details',actionStart);
 assert.ok(actionStart>end&&actionEnd>actionStart);
 const ctx={esc,key:'cashOutflows',report:{venue:{id:'venue-A'}}};
 vm.runInNewContext(src.slice(actionStart,actionEnd)+';globalThis.action=sourceAction',ctx);
 for(const [source,label,field,kind] of [['other','Прочий расход',null,null],['payable','Оплата обязательства',null,null],['manual','Расход вручную',null,null],['purchase','Оплата закупки','purchaseDocumentId','purchase'],['payroll','Выплата зарплаты','payrollEntryId','payroll']]){
  const row={id:'11111111-1111-4111-8111-111111111111',source,categoryName:'Тестовая статья',counterpartyName:'Контрагент',paymentAccountNameSnapshot:'Расчётный счёт',shiftId:'shift-A'};
  if(field)row[field]='22222222-2222-4222-8222-222222222222';
  const text=vm.runInNewContext(expression,{row});
  assert.ok(text.startsWith(label));assert.ok(text.includes('Тестовая статья')&&text.includes('Контрагент')&&text.includes('Расчётный счёт')&&text.includes('POS-смена'));
  assert.doesNotMatch(text,/[0-9a-f]{8}-[0-9a-f]{4}-/);
  const button=ctx.action(row);
  if(field){assert.ok(button.includes('data-report-source="'+kind+'"'));assert.ok(button.includes('data-report-source-id="'+row[field]+'"'));assert.ok(button.includes('data-report-source-venue="venue-A"'));}
  else assert.equal(button,'');
 }
 assert.match(vm.runInNewContext(expression,{row:{source:'manual',accountCoverage:'unknown_legacy'}}),/статья не указана · счёт не указан/);
 ctx.key='purchaseReceipts';assert.ok(ctx.action({documentId:'receipt-A'}).includes('data-report-source-id="receipt-A"'));
 const posStart=src.indexOf('pos:',detailsStart),posEnd=src.indexOf(',legacyPos:',posStart);
 assert.ok(posStart>detailsStart&&posEnd>posStart);
 const posExpression=src.slice(posStart+'pos:'.length,posEnd);
 ctx.key='pos';
 for(const [status,label] of [['complete','Распределено'],['unmapped','Не распределено'],['unknown','Требует проверки']]){
  const row={orderId:'33333333-3333-4333-8333-333333333333',status};
  assert.equal(vm.runInNewContext(posExpression,{row}),'Продажа POS · '+label);
  const button=ctx.action(row);
  assert.ok(button.includes('data-report-source="pos"'));
  assert.ok(button.includes('data-report-source-id="'+row.orderId+'"'));
  assert.ok(button.includes('data-report-source-venue="venue-A"'));
 }
}
console.log('REPORT EXPENSE PRESENTATION: PASS (friendly expense/POS labels, classification states, financial context, exact document and venue IDs in actions)');
