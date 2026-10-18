import assert from 'node:assert/strict';
import vm from 'node:vm';
import {portal as source, createReservationFixture, validDraft, settle} from './ui042-reservation-fixture.mjs';
const minimumStart=source.indexOf('const reservationTableMinimumAtTime ='),minimumEnd=source.indexOf('const renderReservationTableOptions =',minimumStart);
assert.ok(minimumStart>0&&minimumEnd>minimumStart);
const minimumRule=vm.runInNewContext(source.slice(minimumStart,minimumEnd)+' reservationTableMinimumAtTime;');
const scheduledTable={minimumOrderTotal:2500,minimumOrderStartTime:'18:00',minimumOrderEndTime:'09:00'};
for(const [time,expected] of [['17:59',0],['18:00',2500],['08:59',2500],['09:00',0]])assert.equal(minimumRule(scheduledTable,time),expected);
assert.equal(minimumRule({minimumOrderTotal:1500},'12:00'),1500);
assert.equal(minimumRule({...scheduledTable,minimumOrderStartTime:'bad'},'20:00'),0);
const f=createReservationFixture(),ctx=f.context,get=f.get,panels=get('form').querySelectorAll('[data-reservation-step]'),opener=f.document.querySelector('#focus-reservation');
await ctx.openWizard(opener);assert.equal(f.document.activeElement,get('guest'));assert.equal(ctx.getWindow().element.getAttribute('aria-labelledby'),'reservation-form-title');
get('guest').value='   ';get('next').click();assert.equal(panels[0].hidden,false);assert.equal(f.document.activeElement,get('guest'));assert.match(get('message').textContent,/имя/);assert.equal(get('guest').getAttribute('aria-invalid'),'true');
get('guest').value='Guest';get('next').click();assert.equal(panels[1].hidden,false,'next advances to visit');assert.equal(get('back').hidden,false);
get('table').disabled=true;get('next').click();assert.equal(panels[1].hidden,false);assert.equal(f.document.activeElement,get('retry-tables'));
validDraft(f);get('table').disabled=false;get('table').selectedOptions[0].disabled=true;assert.equal(ctx.validateStep(1),false);
get('table').selectedOptions[0].disabled=false;vm.runInContext('reservationTablesLoading=true',ctx);assert.equal(ctx.validateStep(1),false);vm.runInContext('reservationTablesLoading=false',ctx);
for(const [id,value] of [['date',''],['time',''],['guests','0'],['guests','51']]){const old=get(id).value;get(id).value=value;assert.equal(ctx.validateStep(1),false,id+' blocks progression');assert.equal(f.document.activeElement,get(id));get(id).value=old;}
get('next').click();assert.equal(panels[2].hidden,false);assert.equal(get('form').querySelector('[type="submit"]').hidden,false);assert.match(get('review').textContent,/Guest/);assert.match(get('review').textContent,/2026-11-01/);
get('back').click();assert.equal(panels[1].hidden,false);get('next').click();assert.equal(panels[2].hidden,false);assert.equal(get('notes').value,' Notes ');
get('deposit').value='-1';assert.equal(ctx.validateStep(2),false,'negative deposit requirement cannot submit');assert.equal(f.document.activeElement,get('deposit'));get('deposit').value='300';
get('guest').value=' ';assert.equal(ctx.validateStep(0),false);assert.equal(panels[0].hidden,false);get('guest').value='Guest';
ctx.showStep(2);ctx.getWindow().close();assert.equal(f.document.activeElement,opener);await ctx.openWizard(opener);assert.equal(panels[2].hidden,false,'reopen resumes draft step');
const dropdown=new f.Node('div');dropdown.className='custom-select is-open';const trigger=new f.Node('button');trigger.className='custom-select-trigger';trigger.setAttribute('aria-expanded','true');dropdown.append(trigger);get('form').append(dropdown);
f.document.dispatch('keydown',{key:'Escape'});assert.equal(dropdown.classList.contains('is-open'),false);assert.equal(trigger.getAttribute('aria-expanded'),'false');assert.ok(ctx.getWindow());
f.document.dispatch('keydown',{key:'Escape'});assert.equal(ctx.getWindow(),null);dropdown.remove();await ctx.openWizard(opener);
const h=ctx.getWindow();h.element.dispatch('pointerdown',{target:h.form});h.element.dispatch('pointerup');h.element.dispatch('click');assert.ok(ctx.getWindow(),'inside to backdrop drag ignored');
h.element.dispatch('pointerdown');h.element.dispatch('pointerup',{target:h.form});h.element.dispatch('click');assert.ok(ctx.getWindow(),'backdrop to inside drag ignored');
h.element.dispatch('pointerdown');h.element.dispatch('pointerup');h.element.dispatch('pointercancel');h.element.dispatch('click');assert.ok(ctx.getWindow(),'pointercancel ignored');
h.element.dispatch('pointerdown');h.element.dispatch('pointerup');h.element.dispatch('click');assert.equal(ctx.getWindow(),null);
assert.match(source,/id="reservation-form"[^>]*novalidate/);
const requestedOpenLine=source.split(/\r?\n/).find(line=>line.includes("if (reservationParams.get('tableId')"));assert.ok(requestedOpenLine);
for(const [query,expected] of [['tableId=t1',true],['reservationId=r1',false],['tableId=t1&reservationId=r1',false],['tableId=t1&action=seat',false],['action=seat',false],['',false]]){
let count=0;const q=vm.createContext({reservationParams:new URLSearchParams(query),requestedTableApplied:false,async openReservationDialog(){count++;return true;},document:{querySelector:()=>opener}});
vm.runInContext(requestedOpenLine,q);await settle();assert.equal(count,Number(expected),query);vm.runInContext(requestedOpenLine,q);assert.equal(count,Number(expected));}
assert.doesNotMatch(source.slice(source.indexOf('function renderReservations()'),source.indexOf('async function renderAuthorizedFinancePage')),/form\.scrollIntoView/);
const loadLine=source.split(/\r?\n/).find(line=>line.includes("const load = (keepSavedDate = false) => api('/api/reservations')"));assert.ok(loadLine,'actual reservationId/seat load route');
for(const [query,expectedFocus,expectedSeat] of [['reservationId=r1',true,false],['tableId=t1&reservationId=r1',true,false],['reservationId=r1&action=seat',true,true],['reservationId=unknown&action=seat',false,false],['tableId=t1&action=seat',false,false]]){
 let focused=false,seated=false;const date={value:'2026-10-10'},filter={value:'keep query'};
 const row={classList:{add(value){focused=value==='is-focused';}},scrollIntoView(){},querySelector(){return{click(){seated=true;}};}};
 const q=vm.createContext({window:{location:{search:'?'+query}},URLSearchParams,CSS:{escape:String},reservationLoadError:false,reservations:[],draw(){},portalNotice(){},api:async()=>({items:[{id:'r1',date:'2026-11-01T00:00:00'}]}),document:{querySelector(selector){return selector==='#reservation-list-date'?date:selector==='#reservation-filter'?filter:selector.includes('"r1"')?row:null;}}});
 vm.runInContext(loadLine+'\nglobalThis.runLoad=load;',q);await q.runLoad();
 assert.equal(focused,expectedFocus,query+' highlights only requested existing reservation');assert.equal(seated,expectedSeat,query+' seats only existing requested reservation');
 assert.equal(date.value,expectedFocus?'':'2026-10-10');assert.equal(filter.value,'keep query');
}
// Same source context guard rejects opening after permission/user/venue change.
await ctx.openWizard(opener);ctx.getWindow().close();ctx.window.__portalSessionVerified.user.venueId='another-venue';await ctx.openWizard(opener);assert.equal(ctx.getWindow(),null,'stale venue cannot open old draft');
console.log('RESERVATION WIZARD QA: PASS (actual shared mount, steps, validation/focus, draft, Escape, backdrop, query guards)');
