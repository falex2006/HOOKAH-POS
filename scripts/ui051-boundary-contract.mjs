import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

// Frozen from immutable UI-05.1 intake before implementation, including accepted WIP.
// Self-contained: no mutable baseline files required at execution. Normalize CRLF only.
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
const digest=value=>createHash('sha256').update(value).digest('hex');
const checks=[
  [
    "payment_refund_execution",
    "const paymentModal=",
    "document.querySelector('#queue-list')",
    "460c9fab1a94f6a1d34e490fc66c7f02af010e3f22c674173d7c3699cd42f637"
  ],
  [
    "stock_close_reasons",
    "// Only allowlisted business reasons",
    "// Queue ages",
    "13c55dfb437917e679296e41bf1254f7ac7323f82dc8cd27313280e99a1cfef6"
  ],
  [
    "http_session_authority",
    "const sessionHeaders=",
    "// A changed authoritative session",
    "4bbecac3c458e32f4263bb53162782307b6ce351f0f8862e4cbd16932cb515e3"
  ],
  [
    "order_api_and_demo_authority",
    "const orderHeaders=",
    "function orderCardPreparationState(",
    "42cb1a6b3928fc6dd7dbc891c808741ef172afac90cccd37247ec96211a3196f"
  ],
  [
    "pricing_summary",
    "async function refreshOrderPricingSummary(",
    "let queueFilter=",
    "fb38419ee83f915b72a09146eb3a653ef00a760dd51bbdde8ff1a5d207da7c4f"
  ],
  [
    "table_elapsed",
    "function tableElapsedLabel(",
    "function loadOrders(",
    "932e67a271c8ba09ae724346f21c755de365d8e10c7a14d22fac00e731618985"
  ],
  [
    "density",
    "// Device-local density:",
    "const renderZone=",
    "0470737228faf222ed2ac0468f57a82a3be09ff79976736669525ec3e43d4474"
  ],
  [
    "catalog_read",
    "async function loadProducts()",
    "const closeCatalog=",
    "63eccfcd70ff988077034c239ec3847e3123450f8dfef5c5c0f33e9f583d4652"
  ],
  [
    "catalog_writes_and_quantity",
    "grid.addEventListener('click'",
    "const openGuestBinding=",
    "4cb8c8721496ef60a295fe9b549f6efe9346938122288f744dc13a4c817e5d8e"
  ],
  [
    "preparation_dispatch",
    "const preparationPending=",
    "function drawPreparationQueue(",
    "f3bb485f89768775da6e5a13a5fbcfbd1bc0a4322fc4dd90dfc861d3aa39afcf"
  ],
  [
    "preparation_execution",
    "document.querySelector('#preparation-list')?.addEventListener",
    "const refreshVisiblePreparation=",
    "366677fd972d99485e00f21b4965504fd74c615d118259e3b55cc37267c3f633"
  ],
  [
    "queue_elapsed",
    "// Queue ages",
    "// Orders view uses",
    "02c44d1fb2b7f4edfdacbda1b98024050844882e1069760265c62a0e5513c9f0"
  ]
];
for(const [name,start,end,expected] of checks){
  const from=app.indexOf(start),to=app.indexOf(end,from);
  assert.ok(from>=0&&to>from,name+': source boundaries exist');
  assert.equal(digest(app.slice(from,to)),expected,name+': unchanged from UI-05.1 intake');
}
assert.equal(digest(readFileSync(new URL('../server.js',import.meta.url))), '490a71f46e4b9b143cb1f349be8c379d682bfa74ce9ac9c8c2fded8f956f3e61','server API/security unchanged');
console.log('UI-05.1 boundary PASS ('+checks.length+' frozen app scopes + server bytes; payment/refund, stock, HTTP/session, payloads, guards, density/timers).');
