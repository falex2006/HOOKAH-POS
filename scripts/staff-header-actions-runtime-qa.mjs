import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync('app.js','utf8');
const html=fs.readFileSync('index.html','utf8');
const css=fs.readFileSync('style.css','utf8');
const start=source.indexOf('const renderStaffShiftControl=');
const end=source.indexOf('if(staffSessionVerified)refreshShift();',start);
const handlerStart=source.indexOf('let staffShiftActionPending=false;');
const handlerEnd=source.indexOf("document.querySelectorAll('.actions button')",handlerStart);
assert.ok(start>0&&end>start&&handlerStart>0&&handlerEnd>handlerStart);
assert.match(html, /staff-header-title"><b>Рабочий зал<\/b><\/div><div class="staff-header-toolbar"><button/);
assert.match(html, /data-shift-state="loading"[^>]*disabled/);
assert.match(css, /staff-header-user>#lock-settings-button[^}]*border:0!important/);
assert.match(css, /@media\(max-width:480px\).*shift-state-label\{display:none\}/);
assert.match(fs.readFileSync('assets/tabler-icons.svg','utf8'), /symbol id="clock"/);
for(const file of ['index.html','style.css','assets/tabler-icons.svg']) assert.equal(fs.readFileSync(file,'utf8').replaceAll('\r\n','\n'),fs.readFileSync(`dist/${file}`,'utf8').replaceAll('\r\n','\n'));
const distApp=fs.readFileSync('dist/app.js','utf8');
assert.match(distApp,/const renderStaffShiftControl=/,'published app contains the shift state renderer');
assert.match(distApp,/const refreshVisibleStaffShift=/,'published app contains the visible shift refresh listener');

let click, choice={openingCash:'0'}, failing=false, mutationFailing=false, current=null, delayedResolve;
const requests=[],notices=[];
const button={dataset:{},disabled:true,innerHTML:'',title:'',attributes:{},setAttribute(k,v){this.attributes[k]=v;},addEventListener(_event,fn){click=fn;}};
const context={
  staffNotificationCenter:null,currentShift:null,currentOrder:null,staffShiftReadable:true,staffShiftManageable:true,document:{querySelector:()=>button,addEventListener(){},visibilityState:'visible'},staffIcon:(name)=>`<svg>${name}</svg>`,
  notice:(text)=>notices.push(text),window:{confirm:()=>true,addEventListener(){},setInterval(){return 1},HOOKAH_SHIFT_CLOSE:{checklistVersion:1,checklistItems:[{id:'ordersReviewed',label:'Проверить заказы'},{id:'cashCounted',label:'Пересчитать кассу'},{id:'inventoryReviewed',label:'Проверить склад'},{id:'externalFiscalReportsHandled',label:'Проверить внешние отчёты'}]}},requestStaffAction:async()=>choice,
  shiftCashCloseDescription:()=> 'Проверьте ожидаемую наличность и подтвердите четыре пункта.',shiftCloseResultMessage:()=> 'Смена закрыта',
  shiftCloseFailureMessage:()=> 'Смена осталась открытой',
  shiftApi:async(options={})=>{
    requests.push(options);
    if(options.method){if(mutationFailing)throw Error('mutation_failed');if(options.url?.endsWith('/close')){current=null;return {}; }current={id:'shift-qa'};return current;}
    if(delayedResolve==='pending')return new Promise(resolve=>{delayedResolve=resolve;});
    if(failing)throw Error('unavailable');return {current};
  }
};
vm.runInNewContext(`${source.slice(start,end)}\n${source.slice(handlerStart,handlerEnd)}\nthis.refreshShift=refreshShift;`,context);
delayedResolve='pending';
const first=context.refreshShift();const duplicate=context.refreshShift();assert.equal(first,duplicate);assert.equal(requests.length,1);
assert.equal(button.disabled,true);assert.equal(button.dataset.shiftState,'loading');
delayedResolve({current:null});delayedResolve=null;await first;
assert.equal(button.dataset.shiftState,'closed');assert.equal(button.attributes['aria-label'],'Открыть смену');assert.match(button.innerHTML,/Смена закрыта/);assert.equal(button.disabled,false);
failing=true;await context.refreshShift();assert.equal(button.dataset.shiftState,'error');assert.equal(button.disabled,false);assert.match(button.attributes['aria-label'],/Повторить/);
failing=false;await click();assert.equal(button.dataset.shiftState,'closed');assert.equal(requests.filter(x=>x.method).length,0,'retry only reads');
const opening=click();await click();await opening;assert.equal(requests.filter(x=>x.method).length,1,'duplicate clicks cannot duplicate POST');assert.equal(button.dataset.shiftState,'open');assert.equal(button.attributes['aria-label'],'Закрыть смену');assert.ok(notices.includes('Смена открыта'),'successful opening displays success');
await context.refreshShift();assert.equal(button.dataset.shiftState,'open','reload reads actual open shift');
choice={closingCash:'0',ordersReviewed:'on',cashCounted:'on',inventoryReviewed:'on',externalFiscalReportsHandled:'on'};mutationFailing=true;await click();assert.equal(button.dataset.shiftState,'open');assert.equal(button.disabled,false);assert.ok(notices.includes('Смена осталась открытой'));
mutationFailing=false;await click();assert.equal(button.dataset.shiftState,'closed');assert.ok(notices.includes('Смена закрыта'),'successful closing displays success');const closeRequest=[...requests].reverse().find((request)=>request.url?.endsWith('/close'));assert.equal(closeRequest?.url,'/api/shifts/shift-qa/close');assert.deepEqual(JSON.parse(closeRequest.body),{closingCash:0,checklist:{version:1,items:{ordersReviewed:true,cashCounted:true,inventoryReviewed:true,externalFiscalReportsHandled:true}}});
console.log('STAFF HEADER ACTIONS QA: PASS (layout/dist, loading/open/closed/error/retry, duplicate guards, open/close/error and confirmed payload)');
