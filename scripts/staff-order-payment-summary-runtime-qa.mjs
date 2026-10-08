import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source=readFileSync(new URL('../app.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
const start=source.indexOf('async function refreshOrderPricingSummary(order,knownPayment=null){');
const end=source.indexOf('\nlet queueFilter=',start);
assert.ok(start>=0&&end>start,'order payment summary renderer exists');
const renderer=source.slice(start,end);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function setup(){
  const requests=[];let currentOrder={id:'order-a'};let floorVenueId='venue-a',orderPricingRevision=0;
  const total={textContent:''};let pricingNote=null;
  const meta={querySelector:(selector)=>selector==='[data-order-pricing]'?pricingNote:null,append:(node)=>{pricingNote=node;}};
  const document={querySelector:(selector)=>selector==='.meta'?meta:selector==='#order-total'?total:null,createElement:()=>({dataset:{},style:{},textContent:''})};
  const apiJson=(url)=>{const request=deferred();requests.push({url,...request});return request.promise;};
  const runtime=new Function('apiJson','document',`let currentOrder={id:'order-a'};let floorVenueId='venue-a';let orderPricingRevision=0;${renderer};return{refreshOrderPricingSummary,get:()=>({currentOrder,floorVenueId}),setOrder:(order,venue=floorVenueId)=>{currentOrder=order;floorVenueId=venue;},getView:()=>({total:document.querySelector('#order-total').textContent,note:document.querySelector('.meta').querySelector('[data-order-pricing]')?.textContent||''})}`)(apiJson,document);
  return{runtime,requests};
}
const pricing={due:475,discount:0,minimumAdjustment:0};
const first=setup();
const initial=first.runtime.refreshOrderPricingSummary(first.runtime.get().currentOrder);
assert.match(first.requests[0].url,/\/summary$/);assert.match(first.requests[1].url,/\/payments$/);
first.requests[0].resolve(pricing);first.requests[1].resolve({due:475,paid:200,remaining:275});await initial;
assert.equal(first.runtime.getView().total,'475 ₽');
assert.match(first.runtime.getView().note,/Итого 475 ₽ · Оплачено 200 ₽ · Осталось 275 ₽/);

const partial=setup();
const afterPartial=partial.runtime.refreshOrderPricingSummary(partial.runtime.get().currentOrder,{due:475,paid:200,remaining:275});
assert.equal(partial.requests.length,1,'known balance from reopened payment modal avoids duplicate payment GET');
partial.requests[0].resolve(pricing);await afterPartial;
assert.match(partial.runtime.getView().note,/475 ₽ · Оплачено 200 ₽ · Осталось 275 ₽/);
const complete=partial.runtime.refreshOrderPricingSummary(partial.runtime.get().currentOrder,{due:475,paid:475,remaining:0});
partial.requests[1].resolve(pricing);await complete;
assert.match(partial.runtime.getView().note,/Итого 475 ₽ · Оплачено 475 ₽ · Осталось 0 ₽/);

const reload=setup();
const reopened=reload.runtime.refreshOrderPricingSummary(reload.runtime.get().currentOrder);
reload.requests[0].resolve(pricing);reload.requests[1].resolve({due:475,paid:200,remaining:275});await reopened;
assert.match(reload.runtime.getView().note,/Оплачено 200 ₽ · Осталось 275 ₽/,'reload/reopen reads saved server payment values');

const derived=setup();
const derivesRemaining=derived.runtime.refreshOrderPricingSummary(derived.runtime.get().currentOrder);
derived.requests[0].resolve(pricing);derived.requests[1].resolve({paid:200});await derivesRemaining;
assert.match(derived.runtime.getView().note,/Итого 475 ₽ · Оплачено 200 ₽ · Осталось 275 ₽/,'remaining may be derived only from authoritative total and paid values');

const failed=setup();
const failedRead=failed.runtime.refreshOrderPricingSummary(failed.runtime.get().currentOrder);
failed.requests[0].resolve(pricing);failed.requests[1].reject(new Error('payments unavailable'));await failedRead;
assert.equal(failed.runtime.getView().total,'475 ₽','known final total remains available from pricing endpoint');
assert.match(failed.runtime.getView().note,/Оплату не удалось обновить/);
assert.doesNotMatch(failed.runtime.getView().note,/Оплачено \d|Осталось \d/,'unavailable paid/remaining are not guessed');

const malformed=setup();
const malformedRead=malformed.runtime.refreshOrderPricingSummary(malformed.runtime.get().currentOrder);
malformed.requests[0].resolve(pricing);malformed.requests[1].resolve({due:475,paid:null,remaining:275});await malformedRead;
assert.match(malformed.runtime.getView().note,/Оплату не удалось обновить/,'null amounts are unavailable, not zero');

const race=setup();
const orderA=race.runtime.refreshOrderPricingSummary(race.runtime.get().currentOrder);
race.runtime.setOrder({id:'order-b'});
const orderB=race.runtime.refreshOrderPricingSummary(race.runtime.get().currentOrder);
race.requests[2].resolve({due:250});race.requests[3].resolve({due:250,paid:0,remaining:250});await orderB;
race.requests[0].resolve(pricing);race.requests[1].resolve({due:475,paid:200,remaining:275});await orderA;
assert.equal(race.runtime.getView().total,'250 ₽');assert.match(race.runtime.getView().note,/Итого 250 ₽ · Оплачено 0 ₽ · Осталось 250 ₽/,'late response for previous order cannot overwrite selected order');

const venueRace=setup();
const oldVenue=venueRace.runtime.refreshOrderPricingSummary(venueRace.runtime.get().currentOrder);
venueRace.runtime.setOrder({id:'order-a'},'venue-b');
venueRace.requests[0].resolve(pricing);venueRace.requests[1].resolve({due:475,paid:200,remaining:275});await oldVenue;
assert.equal(venueRace.runtime.getView().total,'','venue switch discards previous response');
console.log('STAFF ORDER PAYMENT SUMMARY QA: PASS (server total/paid/remaining, partial/reopen/final payment, unavailable state, stale order and venue races)');
