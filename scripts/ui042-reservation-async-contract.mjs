import assert from 'node:assert/strict';
import vm from 'node:vm';
import {portal,createReservationFixture,validDraft,settle} from './ui042-reservation-fixture.mjs';

// Execute actual asynchronous domain mount/query callbacks and shared lifecycle.
// Controlled module/API promises are VM mechanics, not actual authentication/API proof.
const queryLine=portal.split(/\r?\n/).find(line=>line.includes("if (reservationParams.get('tableId')"));assert.ok(queryLine);
const queryContext=f=>{f.context.reservationParams=new URLSearchParams('tableId=table-1');};
const applied=f=>vm.runInContext('requestedTableApplied',f.context);

let releaseModule;const moduleGate=new Promise(resolve=>{releaseModule=resolve;});
let calls=0;const delayed=createReservationFixture({loadSharedUI:()=>{calls++;return moduleGate;}});queryContext(delayed);
vm.runInContext(queryLine,delayed.context);
assert.equal(applied(delayed),false,'delayed module does not consume query intent');assert.equal(delayed.context.getWindow(),null);
assert.equal(await delayed.context.openWizard(delayed.document.querySelector('#focus-reservation')),false,'concurrent open is blocked while module resolves');assert.equal(calls,1);
releaseModule(delayed.ui);await settle();assert.equal(applied(delayed),true,'query intent consumed only after successful open');assert.ok(delayed.context.getWindow());
vm.runInContext(queryLine,delayed.context);await settle();assert.equal(calls,1,'applied table query never reopens');delayed.context.getWindow().close();

let attempt=0;const retry=createReservationFixture({loadSharedUI:()=>{attempt++;return attempt===1?Promise.reject(new Error('module_unavailable')):Promise.resolve(retry.ui);}});queryContext(retry);
vm.runInContext(queryLine,retry.context);await settle();assert.equal(applied(retry),false);assert.equal(retry.context.getWindow(),null);assert.equal(retry.notices.at(-1)[1],'error');
vm.runInContext(queryLine,retry.context);await settle();assert.equal(attempt,2);assert.equal(applied(retry),true);assert.ok(retry.context.getWindow());retry.context.getWindow().close();

for(const change of ['user','venue','role','permission','removed-target']){
 let release;const gate=new Promise(resolve=>{release=resolve;});const f=createReservationFixture({loadSharedUI:()=>gate});queryContext(f);
 const opening=f.context.openWizard(f.document.querySelector('#focus-reservation'));
 if(change==='removed-target')f.main.remove();
 else if(change==='permission')f.context.hasPortalPermission=()=>false;
 else f.context.window.__portalSessionVerified.user[change==='user'?'id':change==='venue'?'venueId':'role']='changed';
 release(f.ui);assert.equal(await opening,false,change+' during module load prevents stale form open');assert.equal(f.context.getWindow(),null);assert.equal(f.requests.length,0);assert.equal(applied(f),false);
}

for(const outcome of ['error','success']){
 const f=createReservationFixture();validDraft(f);f.context.showStep(2);await f.context.openWizard(f.document.querySelector('#focus-reservation'));
 const h=f.context.getWindow(),submission=h.form.dispatch('submit');assert.equal(h.pending,true);assert.equal(f.requests.length,1);
 f.main.remove();
 if(outcome==='success')f.pending[0].resolve({});else f.pending[0].reject(new Error('write_failed'));
 await Promise.all(submission.results);await settle();
 assert.equal((await h.promise).reason,'context-changed',outcome+' after removed target ends old context without missing-ID exception');
 assert.equal(f.context.getWindow(),null);assert.equal(h.form.dataset.submitting,'0');assert.equal(f.requests.length,1);
 assert.equal(f.notices.length,0,'stale completion does not emit business success/error on replacement page');
 assert.equal(f.document.body.style.overflow,'scroll');assert.equal(f.get('form'),null,'old form returned only to disconnected parking host');
}
for(const mode of ['readback-focus','new-wizard','new-opening','changed-context','removed-target']){
 let releaseFloor,releaseReadback;
 const floor=new Promise(resolve=>{releaseFloor=resolve;}),readback=new Promise(resolve=>{releaseReadback=resolve;});
 const reads=[];const f=createReservationFixture({loadTables:()=>{reads.push('floor');return floor;},load:keepSavedDate=>{reads.push(keepSavedDate);return readback;}});
 const rowOpener=new f.Node('button');rowOpener.id='row-edit';f.main.append(rowOpener);
 validDraft(f);f.context.showStep(2);f.get('form').dataset.editingId='r1';await f.context.openWizard(rowOpener);
 const submit=f.get('form').dispatch('submit');f.pending[0].resolve({});await Promise.all(submit.results);await settle();
 assert.deepEqual(reads,['floor',true],'success starts floor/list readback retaining saved date');assert.equal(f.context.getWindow(),null);
 // Simulate list rerender deleting focused row; the callback must wait for both reads.
 rowOpener.remove();f.document.activeElement=f.document.body;
 let nextOpening,releaseNext;
 if(mode==='new-wizard')await f.context.openWizard(f.document.querySelector('#focus-reservation'));
 if(mode==='new-opening'){f.context.loadSharedUI=()=>new Promise(resolve=>{releaseNext=resolve;});nextOpening=f.context.openWizard(f.document.querySelector('#focus-reservation'));}
 if(mode==='changed-context')f.context.window.__portalSessionVerified.user.venueId='changed';
 if(mode==='removed-target')f.main.remove();
 const focused=f.document.activeElement;releaseFloor();await settle();assert.equal(f.document.activeElement,focused,'floor completion alone never steals focus');
 releaseReadback();await settle();
 if(mode==='readback-focus')assert.equal(f.document.activeElement,f.document.querySelector('#focus-reservation'),'post-readback success focuses stable CTA after deleted row');
 else assert.equal(f.document.activeElement,focused,mode+' guards delayed readback focus');
 if(nextOpening){releaseNext(f.ui);assert.equal(await nextOpening,true);}
 f.context.getWindow()?.close();
}
console.log('UI-04.2 RESERVATION ASYNC: PASS (delayed module/query retry, concurrent open, verified contexts, detached pending, post-readback focus/no-steal guards)');
