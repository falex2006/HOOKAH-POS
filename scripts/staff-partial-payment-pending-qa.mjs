import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const start = source.indexOf("const paymentModal=document.querySelector('#payment-modal')");
const end = source.indexOf("\ndocument.querySelectorAll('.chips button')", start);
assert.ok(start >= 0 && end > start);
const listeners = new Map();
const node = (id) => ({
  id, value: '0', textContent: '', disabled: false,
  addEventListener(type, callback) { listeners.set(`${id}:${type}`, callback); },
  replaceChildren(...children) { this.children = children; this.textContent = children.map((child) => child.textContent || '').join(''); },
  focus() {},
});
const modalClasses = new Set();
const modal = node('payment-modal');
modal.classList = { add: (name) => modalClasses.add(name), remove: (name) => modalClasses.delete(name), contains: (name) => modalClasses.has(name) };
const submit = node('payment-submit');
const form = node('payment-form');
form.querySelector = () => submit;
const elements = Object.fromEntries([
  modal, form, submit, node('payment-cash'), node('payment-card'), node('payment-qr'),
  node('payment-due'), node('payment-remaining'), node('payment-message'),
  node('payment-close'), node('split-payment'),
].map((element) => [`#${element.id}`, element]));
const document = { querySelector: (selector) => elements[selector] || null, createElement: (tag) => ({ tagName: tag.toUpperCase(), style: {}, textContent: '' }) };
const requests = [];
const apiJson = (path, options) => new Promise((resolve, reject) => requests.push({ path, options, resolve, reject }));
const notices = [];
const setup = new Function('document', 'apiJson', 'notice', 'orderHeaders',
  `let currentOrder={id:'order-1',status:'open',items:[{unitPrice:500,quantity:1}]};
   let openOrders=[currentOrder];let queueDraws=0,orderLoads=0;
   let onLoadOrders=()=>{};
   const drawQueue=()=>{queueDraws+=1;};const drawOrder=()=>{};
   const loadOrders=async()=>{orderLoads+=1;onLoadOrders();};const refreshFloor=async()=>{};
   ${source.slice(start, end)}
   return {state:()=>({currentOrder,openOrders,paymentState,queueDraws,orderLoads}),setOrder:(order)=>{currentOrder=order;},setOnLoadOrders:(callback)=>{onLoadOrders=callback;}};`);
const runtime = setup(document, apiJson, (message) => notices.push(message), () => ({}));
const settle = () => new Promise((resolve) => setImmediate(resolve));
const open = () => listeners.get('split-payment:click')();
const submitPayment = () => listeners.get('payment-form:submit')({ preventDefault() {} });

const firstOpen = open();
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
requests[2].resolve({ due: 500, paid: 0, remaining: 500, items: [] });
await secondOpen;
elements['#payment-cash'].value = '200';
elements['#payment-card'].value = '300';
const partialFailure = submitPayment();
requests[3].resolve({ due: 500, paid: 200, remaining: 300, closed: false });
await settle();
assert.equal(elements['#payment-cash'].value, '0', 'saved method is cleared before next POST');
assert.equal(requests[4].path, '/api/orders/order-2/payments');
requests[4].reject(new Error('payment_create_failed'));
await settle();
assert.equal(requests[5].options, undefined, 'failure reloads authoritative payments');
requests[5].resolve({ due: 500, paid: 200, remaining: 300, items: [{ amount: 200, method: 'cash' }] });
await partialFailure;
assert.equal(elements['#payment-card'].value, '0', 'ambiguous failed method requires deliberate reentry');
assert.equal(elements['#payment-due'].textContent, '300 ₽');
assert.equal(submit.disabled, false);
assert.ok(modalClasses.has('open'));
const staleOpen = open();
const latestOpen = open();
requests[7].resolve({ due: 500, paid: 250, remaining: 250, items: [] });
await latestOpen;
requests[6].resolve({ due: 500, paid: 200, remaining: 300, items: [] });
await staleOpen;
assert.equal(elements['#payment-due'].textContent, '250 ₽', 'older balance cannot overwrite a newer opening');
elements['#payment-cash'].value = '100';
const latePayment = submitPayment();
assert.equal(requests[8].options.method, 'POST');
listeners.get('payment-close:click')();
runtime.setOrder({ id: 'order-3', status: 'open', items: [{ unitPrice: 500, quantity: 1 }] });
const thirdOpen = open();
requests[9].resolve({ due: 500, paid: 0, remaining: 500, items: [] });
await thirdOpen;
requests[8].resolve({ due: 500, paid: 350, remaining: 150, closed: false });
await latePayment;
assert.equal(runtime.state().paymentState.orderId, 'order-3', 'late POST cannot replace the next order balance');
assert.equal(elements['#payment-due'].textContent, '500 ₽');
assert.ok(modalClasses.has('open'), 'late POST cannot close the next order modal');
elements['#payment-cash'].value = '100';
const sameOrderLatePayment = submitPayment();
listeners.get('payment-close:click')();
const sameOrderOpen = open();
requests[11].resolve({ due: 500, paid: 0, remaining: 500, items: [] });
await sameOrderOpen;
assert.equal(submit.disabled, true, 'same-order reopening waits for old POST');
requests[10].resolve({ due: 500, paid: 100, remaining: 400, closed: false });
await settle();
assert.equal(requests[12].path, '/api/orders/order-3/payments', 'late POST triggers a fresh balance read');
requests[12].resolve({ due: 500, paid: 100, remaining: 400, items: [] });
await sameOrderLatePayment;
assert.equal(elements['#payment-due'].textContent, '400 ₽');
assert.equal(submit.disabled, false);
elements['#payment-card'].value = '400';
const lateFinalPayment = submitPayment();
listeners.get('payment-close:click')();
const finalReopen = open();
requests[14].resolve({ due: 500, paid: 100, remaining: 400, items: [] });
await finalReopen;
assert.equal(submit.disabled, true);
runtime.setOnLoadOrders(() => runtime.setOrder({ items: [] }));
requests[13].resolve({ due: 500, paid: 500, remaining: 0, closed: true });
await lateFinalPayment;
assert.equal(modalClasses.has('open'), false, 'late final POST closes stale same-order modal before order refresh');
assert.equal(runtime.state().currentOrder.id, undefined);
console.log('STAFF PARTIAL PAYMENT PENDING QA: PASS (balance, overpay, close, partial failure reconciliation, stale GET/POST, same-order reopen/final close)');
