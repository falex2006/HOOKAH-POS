import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const start = source.indexOf("const paymentModal=document.querySelector('#payment-modal')");
const end = source.indexOf("\ndocument.querySelectorAll('.chips button')", start);
assert.ok(start >= 0 && end > start);
const formatterStart=source.indexOf('const staffStockErrorMessage=');
const formatterEnd=source.indexOf("\ndocument.querySelector('.close')",formatterStart);
assert.ok(formatterStart>=0&&formatterEnd>formatterStart);
const formatter=source.slice(formatterStart,formatterEnd);
const listeners = new Map();
const node = (id) => ({
  id, value: '0', textContent: '', disabled: false, children: [],
  classList: { add() {} },
  addEventListener(type, callback) { listeners.set(`${id}:${type}`, callback); },
  replaceChildren(...children) { this.children = children; this.textContent = children.map((child) => child.textContent || '').join(''); },
  focus() {},
  append(...children) { this.children.push(...children); },
  querySelectorAll() { return []; },
});
const modalClasses = new Set();
const modal = node('payment-modal');
modal.classList = { add: (name) => modalClasses.add(name), remove: (name) => modalClasses.delete(name), contains: (name) => modalClasses.has(name) };
const submit = node('payment-submit');
const form = node('payment-form');
form.querySelector = selector => selector === '.modal-head' ? null : submit;
submit.classList = { add() {} };
const elements = Object.fromEntries([
  modal, form, submit, node('payment-cash'), node('payment-card'), node('payment-qr'),
  node('payment-due'), node('payment-remaining'), node('payment-message'),
  node('payment-close'), node('split-payment'),
].map((element) => [`#${element.id}`, element]));
const document = { querySelector: (selector) => elements[selector] || null, createElement: (tag) => ({ ...node(tag), tagName: tag.toUpperCase(), style: {}, textContent: '' }) };
const requests = [];
const apiJson = (path, options) => new Promise((resolve, reject) => requests.push({ path, options, resolve, reject }));
const storageValues=new Map();const sessionStorage={getItem:key=>storageValues.get(key)||null,setItem:(key,value)=>storageValues.set(key,String(value)),removeItem:key=>storageValues.delete(key)};
const notices = [];
// This fixture covers payment-domain closures. ui071-source-runtime-qa executes
// the real shared shell; forced close below models external context replacement.
let shell;
const loadSharedUI = async () => ({ critical(options) {
  const forceClose = () => { modalClasses.delete('open'); options.onClose(); };
  shell = { open() { modalClasses.add('open'); }, refresh() {}, close() { if (options.isPending()) return false; forceClose(); return true; }, forceClose };
  return shell;
} });
const setup = new Function('document', 'apiJson', 'notice', 'orderHeaders','refreshOrderPricingSummary','loadSharedUI','localStorage','sessionStorage',
  `let currentOrder={id:'order-1',status:'open',items:[{unitPrice:500,quantity:1}]};let floorVenueId='venue-1';
   let staffAccessRevision=1,staffFloorActorId='staff-1',staffSessionVerified=true,staffSessionPermissions=new Set(['orders']);const sessionHeaders=()=>({});
   let openOrders=[currentOrder];let queueDraws=0,orderLoads=0;
   let onLoadOrders=()=>{};
   const drawQueue=()=>{queueDraws+=1;};const drawOrder=()=>{};
   const loadOrders=async()=>{orderLoads+=1;onLoadOrders();};const refreshFloor=async()=>{};
   ${formatter}
   ${source.slice(start, end)}
   return {state:()=>({currentOrder,openOrders,paymentState,queueDraws,orderLoads}),setOrder:(order)=>{currentOrder=order;},setOnLoadOrders:(callback)=>{onLoadOrders=callback;}};`);
const runtime = setup(document, apiJson, (message) => notices.push(message), () => ({}),()=>{},loadSharedUI,{getItem:()=> 'fixture-token'},sessionStorage);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const open = () => listeners.get('split-payment:click')();
const submitPayment = () => listeners.get('payment-form:submit')({ preventDefault() {} });

const firstOpen = open();
await settle();
assert.equal(submit.disabled, true, 'submit waits for authoritative payment balance');
assert.equal(requests[0].path, '/api/orders/order-1/payments');
requests[0].resolve({ due: 500, paid: 200, remaining: 300, items: [] });
await firstOpen;
assert.equal(elements['#payment-due'].textContent, '300 ₽');
assert.match(elements['#payment-message'].textContent, /Уже оплачено 200 ₽ из 500 ₽/);
elements['#payment-card'].value = '400';
await submitPayment();
assert.equal(requests.length, 1, 'overpayment is rejected before POST');
assert.match(elements['#payment-message'].textContent, /больше остатка/);
elements['#payment-card'].value = '300';
const finalPayment = submitPayment();
assert.equal(requests[1].options.method, 'POST');
requests[1].resolve({ due: 500, paid: 500, remaining: 0, closed: true });
await finalPayment;
assert.equal(runtime.state().orderLoads, 1);
assert.equal(runtime.state().openOrders[0].status, 'closed');
assert.match(notices.at(-1), /оплачен/);

runtime.setOrder({ id: 'order-2', status: 'open', items: [{ unitPrice: 500, quantity: 1 }] });
const secondOpen = open();
await settle();
requests[2].resolve({ due: 500, paid: 0, remaining: 500, items: [] });
await secondOpen;
elements['#payment-cash'].value = '200';
elements['#payment-card'].value = '300';
const partialFailure = submitPayment();
requests[3].resolve({ due: 500, paid: 200, remaining: 300, closed: false });
await settle();
assert.equal(elements['#payment-cash'].value, '0', 'saved method is cleared before next POST');
assert.equal(requests[4].path, '/api/orders/order-2/payments');
requests[4].reject(Object.assign(new Error('product_recipe_required'),{payload:{error:'product_recipe_required',productName:'Тестовая позиция'}}));
await settle();
assert.equal(requests[5].options, undefined, 'failure reloads authoritative payments');
requests[5].resolve({ due: 500, paid: 200, remaining: 300, items: [{ amount: 200, method: 'cash' }] });
await partialFailure;
assert.equal(elements['#payment-card'].value, '300', 'ambiguous failed method restores the frozen amount for exact retry');
assert.equal(JSON.parse(storageValues.get('hookah-pos:pending-order-payment:venue-1:staff-1:order-2')).nextIndex,1,'confirmed tender progress is persisted before retry');
assert.equal(elements['#payment-due'].textContent, '300 ₽');
assert.equal(submit.disabled, false);
assert.ok(modalClasses.has('open'));
assert.match(elements['#payment-message'].textContent,/нет активной техкарты продажи/);
assert.match(elements['#payment-message'].textContent,/Учтено платежей: 200 ₽. Осталось: 300 ₽/);
// The remaining assertions exercise independent stale-response and stock-error behavior.
storageValues.delete('hookah-pos:pending-order-payment:venue-1:staff-1:order-2');
runtime.state().paymentState.pendingPaymentIntent=null;
elements['#payment-card'].value='0';
const staleOpen = open();
const latestOpen = open();
await settle();
requests[7].resolve({ due: 500, paid: 250, remaining: 250, items: [] });
await latestOpen;
requests[6].resolve({ due: 500, paid: 200, remaining: 300, items: [] });
await staleOpen;
assert.equal(elements['#payment-due'].textContent, '250 ₽', 'older balance cannot overwrite a newer opening');
elements['#payment-cash'].value = '100';
const latePayment = submitPayment();
assert.equal(requests[8].options.method, 'POST');
listeners.get('payment-close:click')();
assert.ok(modalClasses.has('open'), 'ordinary close is blocked during POST');
shell.forceClose();
runtime.setOrder({ id: 'order-3', status: 'open', items: [{ unitPrice: 500, quantity: 1 }] });
await open();
assert.equal(requests.length, 9, 'new order opening waits for pending operation to settle');
requests[8].resolve({ due: 500, paid: 350, remaining: 150, closed: false });
await latePayment;
assert.equal(storageValues.has('hookah-pos:pending-order-payment:venue-1:staff-1:order-2'),false,'a successful late response clears its completed intent without touching a closed modal state');
assert.equal(runtime.state().paymentState, null, 'forced context close discards only presentation state');
const thirdOpen = open();
await settle();
requests[9].resolve({ due: 500, paid: 0, remaining: 500, items: [] });
await thirdOpen;
assert.equal(runtime.state().paymentState.orderId, 'order-3', 'late POST cannot replace the next order balance');
assert.equal(elements['#payment-due'].textContent, '500 ₽');
assert.ok(modalClasses.has('open'), 'late POST cannot close the next order modal');
elements['#payment-cash'].value = '100';
const sameOrderLatePayment = submitPayment();
listeners.get('payment-close:click')();
assert.ok(modalClasses.has('open'), 'same-order ordinary close is blocked during POST');
shell.forceClose();
await open();
assert.equal(requests.length, 11, 'same-order reopening sends no GET until old POST settles');
requests[10].resolve({ due: 500, paid: 100, remaining: 400, closed: false });
await sameOrderLatePayment;
const sameOrderOpen = open();
await settle();
assert.equal(requests[11].path, '/api/orders/order-3/payments', 'reopening after settled POST reads authoritative balance');
requests[11].resolve({ due: 500, paid: 100, remaining: 400, items: [] });
await sameOrderOpen;
assert.equal(elements['#payment-due'].textContent, '400 ₽');
assert.equal(submit.disabled, false);
elements['#payment-card'].value = '400';
const lateFinalPayment = submitPayment();
listeners.get('payment-close:click')();
assert.ok(modalClasses.has('open'), 'final ordinary close is blocked during POST');
shell.forceClose();
await open();
assert.equal(requests.length, 13, 'final pending operation prevents reopen');
runtime.setOnLoadOrders(() => runtime.setOrder({ items: [] }));
requests[12].resolve({ due: 500, paid: 500, remaining: 0, closed: true });
await lateFinalPayment;
assert.equal(modalClasses.has('open'), false, 'late final POST closes stale same-order modal before order refresh');
assert.equal(runtime.state().currentOrder.id, undefined);
runtime.setOnLoadOrders(()=>{});
for(const [code,reason] of Object.entries({
  product_recipe_required:'нет активной техкарты',product_recipe_ambiguous:'несколько техкарт',
  product_inventory_mode_required:'не настроен складской учёт',product_inventory_mode_invalid:'неверно настроен складской учёт',
  recipe_invalid:'ошибка в составе',recipe_ingredient_not_found:'не найден на складе',
  recipe_ingredient_unit_mismatch:'не совпадают',invalid_recipe_quantity:'неверно указано количество',
  insufficient_recipe_stock:'Недостаточно ингредиентов',expired_premix_stock:'Истёк срок годности',
  recipe_depletion_failed:'Не удалось выполнить списание'
})){
  runtime.setOrder({id:code,status:'open',items:[{unitPrice:500,quantity:1}]});
  const offset=requests.length,opening=open();
  await settle();
  requests[offset].resolve({due:500,paid:200,remaining:300,items:[{method:'cash',amount:200}]});await opening;
  elements['#payment-card'].value='300';
  const failing=submitPayment();
  const attempt=JSON.parse(requests[offset+1].options.body).idempotencyKey;
  await submitPayment();assert.equal(requests.length,offset+2,'double click does not repeat POST');
  requests[offset+1].reject({payload:{error:code,productName:'Тестовая позиция',detail:'SECRET_COST',missing:[{stock:{cost:'SECRET_COST'}}]}});
  await settle();
  requests[offset+2].resolve({due:500,paid:200,remaining:300,items:[{method:'cash',amount:200}]});await failing;
  const text=elements['#payment-message'].textContent;
  assert.ok(text.includes(reason),`${code} explains the actual cause`);
  assert.match(text,/управляющего/);assert.match(text,/Учтено платежей: 200 ₽. Осталось: 300 ₽/);
  assert.ok(!text.includes('SECRET_COST'),'internal payload never becomes employee text');
  assert.equal(runtime.state().currentOrder.status,'open');assert.equal(submit.disabled,false);
  elements['#payment-card'].value='300';const retry=submitPayment();
  assert.equal(JSON.parse(requests[offset+3].options.body).idempotencyKey,attempt,'retry retains the same payment intent');
  requests[offset+3].resolve({due:500,paid:500,remaining:0,closed:true});await retry;
  assert.equal(modalClasses.has('open'),false,'successful retry completes payment');
}
const format=new Function(`${formatter};return staffStockErrorMessage;`)();
assert.equal(format({payload:{error:'unknown',detail:'SECRET_COST'}}),'');
assert.equal(format({payload:{error:'toString'}}),'');
console.log('STAFF PARTIAL PAYMENT PENDING QA: PASS (balance, mixed failure reconciliation, 11 stock/recipe reasons, safe text, retry idempotency, pending and stale GET/POST guards)');
