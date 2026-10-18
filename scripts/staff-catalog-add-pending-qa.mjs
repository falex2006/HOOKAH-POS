import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const start = app.indexOf("grid.addEventListener('click',async(e)=>{");
const end = app.indexOf('\norderRows.addEventListener', start);
assert.ok(start >= 0 && end > start, 'staff catalog click handler is available');
assert.match(app, /catalogAddPending\?'disabled '/, 'redrawn products remain disabled while adding');

let handler;
const items = [
  { disabled: false, dataset: { id: 'product-1', name: 'Первый', price: '100' } },
  { disabled: false, dataset: { id: 'product-2', name: 'Второй', price: '200' } },
];
const grid = { addEventListener: (_, listener) => { handler = listener; }, querySelectorAll: () => items };
const catalog = { busy: '', classList: { remove: () => {} }, setAttribute: (_, value) => { catalog.busy = value; } };
let selected = null;
const document = { querySelector: (selector) => selector === '.table.sel' ? selected : null };
const requests = [];
const apiJson = (path, options) => new Promise((resolve, reject) => requests.push({ path, options, resolve, reject }));
const notices = [];
let catalogRefreshes = 0, refreshedCatalogState='ready';
const refreshProducts = async () => { catalogRefreshes += 1; return refreshedCatalogState; };
const setup = new Function('grid', 'catalog', 'document', 'apiJson', 'orderHeaders', 'tableMinimums', 'normalizeTableId', 'notice', 'refreshProducts',
  `let catalogAddPending=false;let catalogState='ready';let currentOrder=null;let openOrders=[];let queueDraws=0;let orderDraws=0;let orderLoads=0;
   const loadProducts=async()=>{catalogState=await refreshProducts();};
   const drawQueue=()=>{queueDraws+=1;};const drawOrder=(order)=>{currentOrder=order;orderDraws+=1;};
   const loadOrders=async()=>{orderLoads+=1;};const refreshFloor=()=>Promise.resolve();
   ${app.slice(start, end)}
   return {state:()=>({catalogAddPending,currentOrder,openOrders}),counters:()=>({queueDraws,orderDraws,orderLoads}),setCurrentOrder:(order)=>{currentOrder=order;}};`
);
const runtime = setup(grid, catalog, document, apiJson, () => ({}), { 'table-8': 0 },
  (value) => /^\d+$/.test(String(value || '')) ? `table-${value}` : String(value || ''),
  (message) => notices.push(message), refreshProducts);
const click = (item) => handler({ target: { closest: (selector) => selector === '.product' ? item : null } });
const settle = () => new Promise((resolve) => setImmediate(resolve));

await click(items[0]);
assert.equal(requests.length, 0, 'no table selection sends no request');
assert.match(notices.at(-1), /выберите стол/);
selected = { dataset: { table: '8' } };
const firstClick = click(items[0]);
await click(items[1]);
assert.equal(requests.length, 1, 'two product taps on an empty table start one order');
assert.equal(requests[0].path, '/api/orders');
assert.ok(items.every((item) => item.disabled));
requests[0].resolve({ id: 'order-1', tableId: 'table-8', status: 'open', items: [] });
await settle();
assert.equal(requests.length, 2);
assert.equal(requests[1].path, '/api/orders/order-1/items');
assert.ok(items.every((item) => item.disabled), 'buttons remain disabled through item POST');
requests[1].resolve({ id: 'line-1', productId: 'product-1', name: 'Первый', quantity: 1, unitPrice: 0 });
await firstClick;
assert.equal(runtime.state().currentOrder.items[0].unitPrice, 0, 'server zero price is displayed as zero');
assert.equal(runtime.state().openOrders.length, 1);
assert.ok(items.every((item) => !item.disabled));
assert.equal(catalog.busy, 'false');

const secondClick = click(items[1]);
assert.equal(requests.length, 3, 'existing order goes straight to item POST');
assert.equal(requests[2].path, '/api/orders/order-1/items');
refreshedCatalogState='error';
requests[2].reject(Object.assign(new Error('product_not_found'), { payload: { error: 'product_not_found' } }));
await secondClick;
assert.equal(runtime.state().openOrders.length, 1, 'item failure does not invent or remove the order');
assert.equal(catalogRefreshes, 1, 'server rejection for an archived product refreshes the catalog');
assert.match(notices.at(-1), /недоступна/);
assert.match(notices.at(-1), /Не удалось обновить каталог/, 'failure to reload cannot claim the catalog was updated');
assert.ok(items.every((item) => !item.disabled), 'failure permits retry');

selected = { dataset: { table: '9' } };
runtime.setCurrentOrder({ tableId: 'table-9', items: [] });
const failedNewOrder = click(items[0]);
refreshedCatalogState='ready';
assert.equal(requests[3].path, '/api/orders');
requests[3].resolve({ id: 'order-2', tableId: 'table-9', status: 'open', items: [] });
await settle();
assert.equal(requests[4].path, '/api/orders/order-2/items');
requests[4].reject(Object.assign(new Error('product_not_found'), { payload: { error: 'product_not_found' } }));
await failedNewOrder;
assert.equal(runtime.state().currentOrder.id, 'order-2', 'created empty order stays available after item failure');
assert.equal(catalogRefreshes, 2, 'rejected add on a newly created order also refreshes the catalog');
assert.equal(runtime.state().openOrders.some((order) => order.id === 'order-2'), true);
const retryNewOrder = click(items[0]);
assert.equal(requests[5].path, '/api/orders/order-2/items', 'retry reuses created order');
requests[5].resolve({ id: 'line-2', productId: 'product-1', quantity: 1, unitPrice: 100 });
await retryNewOrder;

selected = { dataset: { table: '10' } };
runtime.setCurrentOrder({ tableId: 'table-10', items: [] });
const switchedTable = click(items[0]);
assert.equal(requests[6].path, '/api/orders');
selected = { dataset: { table: '11' } };
runtime.setCurrentOrder({ tableId: 'table-11', items: [] });
requests[6].resolve({ id: 'order-3', tableId: 'table-10', status: 'open', items: [] });
await settle();
assert.equal(requests[7].path, '/api/orders/order-3/items');
requests[7].resolve({ id: 'line-3', productId: 'product-1', quantity: 1, unitPrice: 100 });
await switchedTable;
assert.equal(runtime.state().currentOrder.tableId, 'table-11', 'late request does not replace selected table');
assert.equal(runtime.state().openOrders.some((order) => order.id === 'order-3'), true);
console.log('STAFF CATALOG ADD PENDING QA: PASS (selection, single create, awaited add, zero price, stale product refresh, retry, table switch)');
