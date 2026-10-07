import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Client } from 'pg';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const rawUrl = process.env.MIGRATIONS_PG_TEST_DATABASE_URL;
const { url, database } = validateQaDatabaseUrl(rawUrl, 'MIGRATIONS_PG_TEST_DATABASE_URL');
assert.ok(process.env.MIGRATIONS_PG_TEST_DOCKER_CONTAINER, 'Explicit owned disposable container is required');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new Client({ connectionString: url.href });
const ids = { org: randomUUID(), venue: randomUUID(), otherVenue: randomUUID(), owner: randomUUID(), manager: randomUUID(), staff: randomUUID(), cleaner: randomUUID(), reservation: randomUUID(), order: randomUUID(), otherOrder: randomUUID(), foreignOrder: randomUUID(), uiOrder: randomUUID(), uiPayment: randomUUID(), uiItem: randomUUID(), returnProduct: randomUUID(), uiErrorOrder: randomUUID(), uiErrorPayment: randomUUID(), returnOrder: randomUUID(), returnItem: randomUUID(), returnPayment: randomUUID(), raceOrder: randomUUID(), raceItem: randomUUID(), racePayment: randomUUID(), shift: randomUUID(), paymentCash: randomUUID(), paymentCard: randomUUID(), paymentQr: randomUUID(), extraPayment: randomUUID() };
const logins = Object.fromEntries(['owner','manager','staff','cleaner'].map(role => [role, `refund-${role}-${randomUUID()}`]));
const password = 'qa-' + randomUUID();
const salt = randomBytes(16).toString('hex');
const hash = 'scrypt$' + salt + '$' + (await promisify(scryptCb)(password, salt, 64)).toString('hex');
let server, output = '', base = '', token;
const req = async (route, method='GET', body, expected=200) => {
  const response = await fetch(base + route, { method, headers: { 'content-type':'application/json', ...(token ? { authorization:`Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(()=>({}));
  if(Array.isArray(expected))assert.ok(expected.includes(response.status),`${method} ${route}: expected ${expected.join('/')} got ${response.status}: ${JSON.stringify(data)}`);else assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
  return data;
};
const refund = (amount, allocations, key, reason='QA refund') => ({ amount, allocations, idempotencyKey:key, reason });
const route = `/api/finance/orders/${ids.order}/refunds`;
try {
  await db.connect();
  const identity = await db.query('SELECT current_database() database,inet_server_addr()::text address,inet_server_port() port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser');
  assertQaDatabaseIdentity(identity.rows[0], database, Number(url.port || 5432), 'POS refunds QA DB');
  await db.query("INSERT INTO organizations(id,name,slug,plan) VALUES($1,'Refund QA',$2,'network')", [ids.org,'refund-qa-'+ids.org]);
  await db.query("INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit) VALUES($1,'network','active',30,10)",[ids.org]);
  for (const [id,name] of [[ids.venue,'Refund QA'],[ids.otherVenue,'Other QA']]) await db.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES($1,$2,$3,$4)',[id,ids.org,name,'Asia/Yekaterinburg']);
  for (const [role,id] of [['owner',ids.owner],['manager',ids.manager],['bartender',ids.staff],['cleaner',ids.cleaner]]) {
    await db.query('INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,ids.venue,ids.org,role,logins[role==='bartender'?'staff':role],hash,role==='owner'?'owner':role==='manager'?'manager':role]);
    if (role==='owner') await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'owner','active')",[ids.org,id]);
    else await db.query("INSERT INTO organization_memberships(organization_id,user_id,membership_role,status) VALUES($1,$2,'member','active')",[ids.org,id]);
  }
  const shift = (await db.query("INSERT INTO shifts(venue_id,opened_by,opening_cash) VALUES($1,$2,100) RETURNING id",[ids.venue,ids.owner])).rows[0]; ids.shift=shift.id;
  for (const [orderId,venueId] of [[ids.order,ids.venue],[ids.otherOrder,ids.venue],[ids.foreignOrder,ids.otherVenue]]) await db.query("INSERT INTO orders(id,venue_id,opened_by,status,closed_at,closed_in_shift_id) VALUES($1,$2,$3,'closed',now()-interval '2 days',$4)",[orderId,venueId,ids.owner,venueId===ids.venue?ids.shift:null]);
  await db.query("INSERT INTO reservations(id,venue_id,starts_at,guests_count,status) VALUES($1,$2,now()+interval '1 day',2,'confirmed')",[ids.reservation,ids.venue]);
  await db.query('UPDATE orders SET reservation_id=$1 WHERE id=$2 AND venue_id=$3',[ids.reservation,ids.otherOrder,ids.venue]);
  await db.query("INSERT INTO products(id,venue_id,name,category,sale_price,is_active) VALUES($1,$2,'QA returned hookah bowl','Кальян',0.05,true)",[ids.returnProduct,ids.venue]);
  const payments = [[ids.paymentCash,ids.order,'cash',500],[ids.paymentCard,ids.order,'card',300],[ids.paymentQr,ids.order,'qr',200]];
  for (const [id,orderId,method,amount] of payments) await db.query('INSERT INTO payments(id,order_id,method,amount,status,shift_id,created_at) VALUES($1,$2,$3,$4,\'paid\',$5,now()-interval \'2 days\')',[id,orderId,method,amount,ids.shift]);
  for (const orderId of [ids.uiOrder,ids.uiErrorOrder]) await db.query("INSERT INTO orders(id,venue_id,opened_by,status,closed_at,closed_in_shift_id) VALUES($1,$2,$3,'closed',now(),$4)",[orderId,ids.venue,ids.owner,ids.shift]);
  await db.query('INSERT INTO payments(id,order_id,method,amount,status,shift_id) VALUES($1,$2,\'cash\',20,\'paid\',$3),($4,$5,\'card\',7,\'paid\',$6)',[ids.uiPayment,ids.uiOrder,ids.shift,ids.uiErrorPayment,ids.uiErrorOrder,ids.shift]);
  const seedSnapshot=async({orderId,itemId,paymentId,quantity,unitPrice,grossMinor,discountMinor,netMinor,paymentAmount})=>{
    await db.query("INSERT INTO order_items(id,order_id,product_id,quantity,unit_price,station,sales_employee_id,sold_at) VALUES($1,$2,$3,$4,$5,'bar',$6,now())",[itemId,orderId,ids.returnProduct,quantity,unitPrice,ids.owner]);
    const source=(await db.query('SELECT oi.sold_at::text AS "soldAt",oi.product_id AS "productId",oi.station,p.name AS "productName",p.category,p.is_active AS "productActive" FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.id=$1',[itemId])).rows[0];
    await db.query('BEGIN');
    const snapshot=(await db.query(`INSERT INTO pos_order_pricing_snapshots(venue_id,order_id,sold_at,subtotal_minor,discount_minor,minimum_adjustment_minor,final_total_minor,discount_source,eligible_item_ids)
      VALUES($1,$2,now(),$3,$4,0,$5,$6,$7::uuid[]) RETURNING id`,[ids.venue,orderId,grossMinor,discountMinor,netMinor,discountMinor?'manual':'none',discountMinor?[itemId]:[]])).rows[0];
    await db.query(`INSERT INTO pos_order_pricing_snapshot_lines(venue_id,snapshot_id,order_id,order_item_id,seller_id,sold_at,quantity,unit_price,gross_minor,discount_minor,net_minor,eligible,product_facts)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,[ids.venue,snapshot.id,orderId,itemId,ids.owner,source.soldAt,quantity,unitPrice,grossMinor,discountMinor,netMinor,Boolean(discountMinor),JSON.stringify({productId:source.productId,productName:source.productName,category:source.category,station:source.station,productActive:source.productActive})]);
    await db.query('COMMIT');
    if(paymentId)await db.query("INSERT INTO payments(id,order_id,method,amount,status,shift_id) VALUES($1,$2,'cash',$3,'paid',$4)",[paymentId,orderId,paymentAmount,ids.shift]);
    return snapshot.id;
  };
  await seedSnapshot({orderId:ids.uiOrder,itemId:ids.uiItem,paymentId:null,quantity:3,unitPrice:0.05,grossMinor:15,discountMinor:4,netMinor:11,paymentAmount:20});
  // Model a committed 091 row from before sequence support. Its amount is known; chronology is not.
  await db.query('BEGIN');
  try {
    await db.query('ALTER TABLE order_refund_items DISABLE TRIGGER order_refund_items_validate_insert');
    await db.query('ALTER TABLE pos_order_item_return_balances DISABLE TRIGGER pos_order_item_return_balance_internal');
    const legacyRefund=(await db.query("INSERT INTO order_refunds(venue_id,order_id,shift_id,amount,reason,idempotency_key,actor_id,item_attribution_status,created_at) VALUES($1,$2,$3,1,'Pre-092 legacy item return','legacy-sequence-0001',$4,'complete','2026-10-03T12:00:00Z') RETURNING id",[ids.venue,ids.uiOrder,ids.shift,ids.owner])).rows[0];
    await db.query("INSERT INTO order_refund_items(venue_id,refund_id,order_id,snapshot_id,order_item_id,returned_quantity,returned_item_value_minor,created_at) SELECT $1,$2,$3,s.id,$4,0.5,2,'2026-10-03T12:00:00Z' FROM pos_order_pricing_snapshots s WHERE s.venue_id=$1 AND s.order_id=$3",[ids.venue,legacyRefund.id,ids.uiOrder,ids.uiItem]);
    await db.query('UPDATE pos_order_item_return_balances SET returned_quantity=0.5,returned_item_value_minor=2 WHERE venue_id=$1 AND order_id=$2 AND order_item_id=$3',[ids.venue,ids.uiOrder,ids.uiItem]);
    await db.query('ALTER TABLE pos_order_item_return_balances ENABLE TRIGGER pos_order_item_return_balance_internal');
    await db.query('ALTER TABLE order_refund_items ENABLE TRIGGER order_refund_items_validate_insert');
    await db.query('COMMIT');
  } catch(error) { await db.query('ROLLBACK'); throw error; }
  await db.query("INSERT INTO orders(id,venue_id,opened_by,status,closed_at,closed_in_shift_id) VALUES($1,$2,$3,'closed',now()-interval '2 days',$4),($5,$2,$3,'closed',now()-interval '2 days',$4)",[ids.returnOrder,ids.venue,ids.owner,ids.shift,ids.raceOrder]);
  await seedSnapshot({orderId:ids.returnOrder,itemId:ids.returnItem,paymentId:ids.returnPayment,quantity:3,unitPrice:0.05,grossMinor:15,discountMinor:4,netMinor:11,paymentAmount:100});
  await seedSnapshot({orderId:ids.raceOrder,itemId:ids.raceItem,paymentId:ids.racePayment,quantity:1,unitPrice:1,grossMinor:100,discountMinor:0,netMinor:100,paymentAmount:100});
  await db.query('INSERT INTO payments(order_id,method,amount,status,shift_id) VALUES($1,\'cash\',100,\'refunded\',$2)',[ids.otherOrder,ids.shift]);
  await db.query('INSERT INTO payments(id,order_id,method,amount,status,shift_id) VALUES($1,$2,\'card\',100,\'paid\',$3)',[ids.extraPayment,ids.otherOrder,ids.shift]);
  await db.query('INSERT INTO payments(order_id,method,amount,status,shift_id) VALUES($1,\'cash\',100,\'paid\',NULL)',[ids.foreignOrder]);
  server = spawn(process.execPath,['server.js'],{cwd:root,windowsHide:true,env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATABASE_URL:url.href,VENUE_ID:ids.venue,AUTH_REQUIRED:'true',COOKIE_SECURE:'false',NODE_ENV:'test',API_RATE_LIMIT:'5000'},stdio:['ignore','pipe','pipe']});
  server.stdout.setEncoding('utf8').on('data',x=>output+=x); server.stderr.setEncoding('utf8').on('data',x=>output+=x);
  const until=Date.now()+20000;
  while(!base&&Date.now()<until){const m=output.match(/CRM running on http:\/\/localhost:(\d+)/); if(m)base=`http://127.0.0.1:${m[1]}`; else if(server.exitCode!==null)throw Error('server failed: '+output); else await delay(50);}
  assert.ok(base,'isolated API starts'); assert.equal((await req('/api/health')).database,'postgres');
  token=(await req('/api/login','POST',{username:logins.owner,password},200)).token; assert.ok(token);
  const ownerToken=token;
  const ownerSession=await req('/api/session');
  const managerLogin=await req('/api/login','POST',{username:logins.manager,password},200); token=managerLogin.token;
  const managerSession=await req('/api/session');
  assert.ok(Array.isArray((await req(route,'GET')).items),'finance_read can read refund history');
  assert.equal((await req(route,'POST',refund(1,[{sourcePaymentId:ids.paymentCash,amount:1,payoutMethod:'cash'}],'refund-manager-01'),403)).error,'forbidden');
  token=(await req('/api/login','POST',{username:logins.staff,password},200)).token;
  const staffSession=await req('/api/session');
  assert.ok(Array.isArray((await req(route,'GET')).items),'finance_read role can read history');
  assert.equal((await req(`/api/finance/orders/${ids.otherOrder}/refunds`,'GET',undefined,403)).permission,'reservations','finance_read with orders but without reservations cannot read reservation-linked refunds');
  assert.equal((await req(route,'POST',refund(1,[{sourcePaymentId:ids.paymentCash,amount:1,payoutMethod:'cash'}],'refund-staff-01'),403)).error,'forbidden');
  token=(await req('/api/login','POST',{username:logins.cleaner,password},200)).token;
  assert.equal((await req(`/api/finance/orders/${ids.returnOrder}/refunds`,'GET',undefined,403)).permission,'orders','finance_read role without orders cannot fetch item-return details');
  token=ownerToken;
  const otherRoute=`/api/finance/orders/${ids.foreignOrder}/refunds`;
  assert.equal((await req(otherRoute,'GET',undefined,404)).error,'order_not_found');
  const first=await req(route,'POST',refund(150,[{sourcePaymentId:ids.paymentCash,amount:100,payoutMethod:'cash'},{sourcePaymentId:ids.paymentCard,amount:50,payoutMethod:'card'}],'refund-multi-001'),201);
  assert.equal(first.itemAttributionStatus,'unattributed');
  const replay=await req(route,'POST',refund(150,[{sourcePaymentId:ids.paymentCard,amount:50,payoutMethod:'card'},{sourcePaymentId:ids.paymentCash,amount:100,payoutMethod:'cash'}],'refund-multi-001'),200); assert.equal(replay.idempotentReplay,true);
  const upperReplay=await req(`/api/finance/orders/${ids.order.toUpperCase()}/refunds`,'POST',refund(150,[{sourcePaymentId:ids.paymentCash.toUpperCase(),amount:100,payoutMethod:'cash'},{sourcePaymentId:ids.paymentCard.toUpperCase(),amount:50,payoutMethod:'card'}],'refund-multi-001'),200); assert.equal(upperReplay.idempotentReplay,true,'UUID case is normalized for replay');
  assert.equal((await req(route,'POST',refund(150,[{sourcePaymentId:ids.paymentCash,amount:150,payoutMethod:'cash'}],'refund-multi-001'),409)).error,'idempotency_key_reused');
  assert.equal((await req(route,'POST',refund(0,[{sourcePaymentId:ids.paymentCash,amount:0,payoutMethod:'cash'}],'refund-bad-000'),400)).error,'invalid_order_refund');
  const refundsBeforeMalformedUuid=(await db.query('SELECT count(*)::int count FROM order_refunds WHERE venue_id=$1',[ids.venue])).rows[0].count;
  assert.equal((await req(route,'POST',refund(1,[{sourcePaymentId:'not-a-uuid',amount:1,payoutMethod:'cash'}],'refund-bad-uuid-01'),400)).error,'invalid_order_refund');
  assert.equal((await db.query('SELECT count(*)::int count FROM order_refunds WHERE venue_id=$1',[ids.venue])).rows[0].count,refundsBeforeMalformedUuid,'malformed source UUID is rejected before any DB write');
  assert.equal((await req(route,'POST',{...refund(1,[{sourcePaymentId:ids.paymentCash,amount:1,payoutMethod:'cash'}],'refund-no-reason-01'),reason:''},400)).error,'invalid_order_refund');
  const partial=await req(route,'POST',refund(350,[{sourcePaymentId:ids.paymentCash,amount:350,payoutMethod:'cash'}],'refund-partial-01'),201);
  assert.equal(Number(partial.amount),350);
  const full=await req(route,'POST',refund(500,[{sourcePaymentId:ids.paymentCash,amount:50,payoutMethod:'cash'},{sourcePaymentId:ids.paymentCard,amount:250,payoutMethod:'card'},{sourcePaymentId:ids.paymentQr,amount:200,payoutMethod:'qr'}],'refund-full-0001'),201);
  assert.equal(Number(full.amount),500);
  assert.equal((await req(route,'POST',refund(1,[{sourcePaymentId:ids.paymentCash,amount:1,payoutMethod:'cash'}],'refund-over-cap-01'),409)).error,'refund_exceeds_payment_balance');
  const before=(await db.query('SELECT count(*)::int count FROM order_refunds WHERE venue_id=$1',[ids.venue])).rows[0].count;
  const race=await Promise.all([1,2].map(i=>req(route,'POST',refund(1,[{sourcePaymentId:ids.paymentCash,amount:1,payoutMethod:'cash'}],`refund-race-000${i}`),409)));
  assert.ok(race.every(x=>x.error==='refund_exceeds_payment_balance'),'over-cap races are rejected');
  assert.equal(Number((await db.query('SELECT sum(amount) amount FROM order_refund_tenders WHERE venue_id=$1 AND order_id=$2 AND source_payment_id=$3',[ids.venue,ids.order,ids.paymentCash])).rows[0].amount),500);
  const list=await req(route); assert.equal(list.coverage.legacyPaymentStatusRefunded,'unknown_not_reconstructed'); assert.equal(list.items.length,3);
  const report=await req(`/api/finance/report?date=${new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Yekaterinburg'})}`);
  assert.equal(report.payouts.dateBasis,'created_at'); assert.equal(Number(report.payouts.bySource.order_refund),1000);
  const oldDate=new Date(Date.now()-2*86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Yekaterinburg'});
  const oldReport=await req(`/api/finance/report?date=${oldDate}`); assert.equal(Number(oldReport.payouts.bySource.order_refund||0),0,'refund report follows refund event date, not sale date');
  const itemRefund=(quantity,key)=>({amount:1,reason:'QA item return',allocations:[{sourcePaymentId:ids.returnPayment,amount:1,payoutMethod:'qr'}],items:[{orderItemId:ids.returnItem,quantity}],idempotencyKey:key});
  const returned=[];
  for(const [quantity,key] of [['1','item-return-001'],['1','item-return-002'],['1','item-return-003']]) returned.push(await req(`/api/finance/orders/${ids.returnOrder}/refunds`,'POST',itemRefund(quantity,key),201));
  assert.deepEqual(returned.map(row=>Number(row.itemReturns[0].producerSequence)),[1,2,3],'new item events receive monotonic source-local sequence');
  assert.deepEqual(returned.map(row=>[Number(row.itemReturns[0].previousReturnedQuantity),Number(row.itemReturns[0].cumulativeReturnedQuantity)]),[[0,1],[1,2],[2,3]],'quantity transition facts form a continuous chain');
  assert.deepEqual(returned.map(row=>[Number(row.itemReturns[0].previousReturnedItemValueMinor),Number(row.itemReturns[0].cumulativeReturnedItemValueMinor)]),[[0,4],[4,7],[7,11]],'value transition facts form a cumulative half-up chain');
  assert.deepEqual(returned.map(row=>Number(row.itemReturns[0].itemValueMinor)),[4,3,4],'cumulative half-up allocation reconciles to frozen net line value');
  assert.equal(returned.reduce((sum,row)=>sum+Number(row.itemReturns[0].itemValueMinor),0),11,'cumulative full quantity returns exactly frozen net cents');
  assert.equal(Number(returned[0].amount),1,'external payout amount remains separate from returned merchandise value');
  const exactReplay=await req(`/api/finance/orders/${ids.returnOrder}/refunds`,'POST',itemRefund('1','item-return-001'),200);
  assert.equal(exactReplay.idempotentReplay,true,'item return exact-key replay is idempotent');
  assert.deepEqual(exactReplay.itemReturns,returned[0].itemReturns,'exact replay returns same authoritative sequence facts');
  assert.equal(Number((await db.query('SELECT return_sequence FROM pos_order_item_return_balances WHERE venue_id=$1 AND order_id=$2 AND order_item_id=$3',[ids.venue,ids.returnOrder,ids.returnItem])).rows[0].return_sequence),3,'replay does not advance source sequence');
  const persistedSequenceHistory=await req(`/api/finance/orders/${ids.returnOrder}/refunds`);
  assert.deepEqual(persistedSequenceHistory.items.map(row=>Number(row.itemReturns[0].producerSequence)),[1,2,3],'GET history replays persisted per-item sequence');
  assert.equal((await req(`/api/finance/orders/${ids.returnOrder}/refunds`,'POST',itemRefund('2','item-return-001'),409)).error,'idempotency_key_reused','changed item quantity conflicts under the same key');
  assert.equal((await req(`/api/finance/orders/${ids.returnOrder}/refunds`,'POST',{...itemRefund('0','item-return-zero'),items:[{orderItemId:ids.returnItem,quantity:'0'}]},400)).error,'invalid_order_refund');
  assert.equal((await req(`/api/finance/orders/${ids.returnOrder}/refunds`,'POST',{amount:1,reason:'wrong source item',allocations:[{sourcePaymentId:ids.returnPayment,amount:1,payoutMethod:'qr'}],items:[{orderItemId:ids.raceItem,quantity:'0.1'}],idempotencyKey:'item-wrong-source-01'},409)).error,'refund_item_source_unavailable','item from another order cannot borrow this source sequence');
  const noMerch=await req(`/api/finance/orders/${ids.returnOrder}/refunds`,'POST',{amount:1,reason:'QA no merchandise',allocations:[{sourcePaymentId:ids.returnPayment,amount:1,payoutMethod:'qr'}],items:[],noItemReturn:true,idempotencyKey:'item-no-merch-001'},201);
  assert.equal(noMerch.itemAttributionStatus,'not_applicable','no-merchandise status is explicit on snapshot-backed orders');
  assert.equal((await req(`/api/finance/orders/${ids.returnOrder}/refunds`,'POST',itemRefund('0.001','item-return-over-cap'),409)).error,'refund_item_quantity_exceeds_remaining');
  assert.equal(Number((await db.query('SELECT return_sequence FROM pos_order_item_return_balances WHERE venue_id=$1 AND order_id=$2 AND order_item_id=$3',[ids.venue,ids.returnOrder,ids.returnItem])).rows[0].return_sequence),3,'over-cap attempt does not consume sequence');
  const afterItemReport=await req(`/api/finance/report?date=${new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Yekaterinburg'})}`);
  assert.equal(Number(afterItemReport.payouts.bySource.order_refund),1004,'item sale value never enters finance payout totals; four one-unit payouts add exactly 4 report units');
  const concurrentReturns=await Promise.all([1,2].map(i=>req(`/api/finance/orders/${ids.raceOrder}/refunds`,'POST',{amount:1,reason:'QA concurrent item return',allocations:[{sourcePaymentId:ids.racePayment,amount:1,payoutMethod:'qr'}],items:[{orderItemId:ids.raceItem,quantity:'0.6'}],idempotencyKey:`race-item-return-00${i}`},[201,409])));
  assert.equal(concurrentReturns.filter(row=>row.itemAttributionStatus==='complete').length,1,'same-order lock serializes concurrent item returns');
  assert.equal(Number((await db.query('SELECT returned_quantity FROM pos_order_item_return_balances WHERE venue_id=$1 AND order_item_id=$2',[ids.venue,ids.raceItem])).rows[0].returned_quantity),0.6,'concurrent return leaves one valid quantity in the balance guard');
  const raceSource=(await db.query('SELECT snapshot_id FROM pos_order_pricing_snapshot_lines WHERE venue_id=$1 AND order_id=$2 AND order_item_id=$3',[ids.venue,ids.raceOrder,ids.raceItem])).rows[0];
  const directA=new Client({connectionString:url.href}),directB=new Client({connectionString:url.href});
  const commonTimestamp='2026-10-01T12:00:00.000Z';
  let directACommitted=false;
  try {
    await Promise.all([directA.connect(),directB.connect()]);
    await directA.query('BEGIN');
    const headerA=(await directA.query("INSERT INTO order_refunds(venue_id,order_id,shift_id,amount,reason,idempotency_key,actor_id,item_attribution_status,created_at) VALUES($1,$2,$3,1,'Serialized source sequence','sequence-direct-a-001',$4,'complete',$5) RETURNING id",[ids.venue,ids.raceOrder,ids.shift,ids.owner,commonTimestamp])).rows[0];
    const insertedA=(await directA.query('INSERT INTO order_refund_items(venue_id,refund_id,order_id,snapshot_id,order_item_id,returned_quantity,returned_item_value_minor) VALUES($1,$2,$3,$4,$5,0.2,NULL) RETURNING producer_sequence,previous_returned_quantity,cumulative_returned_quantity,previous_returned_item_value_minor,cumulative_returned_item_value_minor,created_at',[ids.venue,headerA.id,ids.raceOrder,raceSource.snapshot_id,ids.raceItem])).rows[0];
    await directB.query('BEGIN');
    const headerB=(await directB.query("INSERT INTO order_refunds(venue_id,order_id,shift_id,amount,reason,idempotency_key,actor_id,item_attribution_status,created_at) VALUES($1,$2,$3,1,'Serialized source sequence','sequence-direct-b-001',$4,'complete',$5) RETURNING id",[ids.venue,ids.raceOrder,ids.shift,ids.owner,commonTimestamp])).rows[0];
    const pendingB=directB.query('INSERT INTO order_refund_items(venue_id,refund_id,order_id,snapshot_id,order_item_id,returned_quantity,returned_item_value_minor) VALUES($1,$2,$3,$4,$5,0.2,NULL) RETURNING producer_sequence,previous_returned_quantity,cumulative_returned_quantity,previous_returned_item_value_minor,cumulative_returned_item_value_minor,created_at',[ids.venue,headerB.id,ids.raceOrder,raceSource.snapshot_id,ids.raceItem]);
    await delay(100); // B is held at the same source balance row until A releases its lock.
    await directA.query('COMMIT'); directACommitted=true;
    const insertedB=(await pendingB).rows[0];
    await directB.query('COMMIT');
    assert.deepEqual([Number(insertedA.producer_sequence),Number(insertedB.producer_sequence)],[2,3],'direct concurrent inserts follow balance-lock acquisition order');
    assert.deepEqual([Number(insertedA.previous_returned_quantity),Number(insertedA.cumulative_returned_quantity),Number(insertedA.previous_returned_item_value_minor),Number(insertedA.cumulative_returned_item_value_minor)],[0.6,0.8,60,80]);
    assert.deepEqual([Number(insertedB.previous_returned_quantity),Number(insertedB.cumulative_returned_quantity),Number(insertedB.previous_returned_item_value_minor),Number(insertedB.cumulative_returned_item_value_minor)],[0.8,1,80,100]);
    assert.equal(new Date(insertedA.created_at).toISOString(),new Date(insertedB.created_at).toISOString(),'identical header timestamps do not obscure authoritative sequence');
  } finally {
    if(!directACommitted)await directA.query('ROLLBACK').catch(()=>{});
    await directB.query('ROLLBACK').catch(()=>{});
    await Promise.all([directA.end().catch(()=>{}),directB.end().catch(()=>{})]);
  }
  await db.query('BEGIN');
  try {
    const failedRefund=(await db.query("INSERT INTO order_refunds(venue_id,order_id,shift_id,amount,reason,idempotency_key,item_attribution_status,actor_id) VALUES($1,$2,$3,1,'QA rollback item event','rollback-item-0001','complete',$4) RETURNING id",[ids.venue,ids.raceOrder,ids.shift,ids.owner])).rows[0];
    await assert.rejects(db.query('INSERT INTO order_refund_items(venue_id,refund_id,order_id,snapshot_id,order_item_id,returned_quantity,returned_item_value_minor) VALUES($1,$2,$3,$4,$5,0.5,0)',[ids.venue,failedRefund.id,ids.raceOrder,raceSource.snapshot_id,ids.raceItem]),/quantity_exceeds_remaining/);
  } finally { await db.query('ROLLBACK'); }
  assert.equal(Number((await db.query("SELECT count(*)::int count FROM order_refunds WHERE venue_id=$1 AND idempotency_key='rollback-item-0001'",[ids.venue])).rows[0].count),0,'failed direct SQL item event rolls back its header');
  assert.equal(Number((await db.query('SELECT return_sequence FROM pos_order_item_return_balances WHERE venue_id=$1 AND order_id=$2 AND order_item_id=$3',[ids.venue,ids.raceOrder,ids.raceItem])).rows[0].return_sequence),3,'failed cap transaction rolls back sequence advancement');
  assert.equal((await req(`/api/finance/orders/${ids.order}/refunds`)).items[0].itemAttributionStatus,'unattributed','legacy order without snapshot remains unattributed');
  const legacyHistory=await req(`/api/finance/orders/${ids.uiOrder}/refunds`);
  const legacyItemFact=legacyHistory.items.flatMap(row=>row.itemReturns||[]).find(row=>row.orderItemId===ids.uiItem&&Number(row.quantity)===0.5);
  assert.equal(legacyItemFact.producerSequence,null,'pre-092 event stays unsequenced');
  assert.equal(legacyItemFact.sequenceScope,'legacy_unsequenced','API labels the legacy chronology boundary');
  const uiPayments=await req(`/api/orders/${ids.uiOrder}/payments`); assert.ok(uiPayments.items?.some(payment=>payment.id===ids.uiPayment&&Number(payment.amount)===20&&['paid','partially_paid'].includes(payment.status)),`browser fixture payment is available in order payments API: ${JSON.stringify(uiPayments.items)}`);

  const playwrightPackagePath=process.env.PLAYWRIGHT_PACKAGE_PATH;
  assert.ok(playwrightPackagePath,'PLAYWRIGHT_PACKAGE_PATH must name the bundled Playwright runtime');
  const {chromium}=createRequire(import.meta.url)(playwrightPackagePath);
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  const makeContext=async (sessionToken,user)=>{const context=await browser.newContext({viewport:{width:1280,height:900},locale:'ru-RU',serviceWorkers:'block'});await context.addInitScript(()=>{window.__qaFetchCalls=[];window.__qaSubmitEvents=[];const nativeFetch=window.fetch.bind(window);window.fetch=(...args)=>{window.__qaFetchCalls.push(String(args[0]));return nativeFetch(...args);};document.addEventListener('submit',event=>window.__qaSubmitEvents.push(event.target?.getAttribute('data-order-refund-form')!==null?'refund-form':event.target?.tagName),true);});await context.addInitScript(({token,user})=>{localStorage.setItem('crm_session_token',token);localStorage.setItem('crm_session_user',JSON.stringify(user));},{token:sessionToken,user});return context;};
  try {
    const managerContext=await makeContext(managerLogin.token,managerSession.user);
    try {
      const page=await managerContext.newPage();let failHistoryOnce=true;
      await page.route(`**/api/finance/orders/${ids.uiOrder}/refunds`,async route=>{if(failHistoryOnce&&route.request().method()==='GET'){failHistoryOnce=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'order_refunds_unavailable'})});}else await route.continue();});
      await page.goto(`${base}/orders`,{waitUntil:'domcontentloaded'});const action=page.locator(`[data-order-refunds="${ids.uiOrder}"]`);await action.waitFor({state:'visible'});await action.click();
      const dialog=page.locator('dialog.order-refund-dialog');await dialog.waitFor({state:'visible'});await dialog.getByText('Не удалось загрузить историю возвратов.').waitFor();
      await page.unroute(`**/api/finance/orders/${ids.uiOrder}/refunds`);await dialog.locator('[data-refund-retry]').click();
      await dialog.locator('.order-refund-history').getByText('Pre-092 legacy item return').waitFor();
      assert.equal(await dialog.locator('[data-order-refund-form]').count(),0,'finance_read can view/retry history without any create controls');
      assert.match(await dialog.textContent(),/Старые отметки возврата в статусах оплат не восстановлены/,'legacy coverage warning is visible');
    } finally {await managerContext.close();}

    const staffContext=await makeContext((await req('/api/login','POST',{username:logins.staff,password},200)).token,staffSession.user);
    try {const page=await staffContext.newPage();await page.goto(`${base}/orders`,{waitUntil:'domcontentloaded'});await page.locator(`[data-order-refunds="${ids.uiOrder}"]`).waitFor({state:'visible'});await page.locator(`[data-order-refunds="${ids.uiOrder}"]`).click();const dialog=page.locator('dialog.order-refund-dialog');await dialog.waitFor({state:'visible'});await dialog.locator('.order-refund-history').getByText('Pre-092 legacy item return').waitFor();assert.equal(await dialog.locator('[data-order-refund-form]').count(),0,'finance_read staff cannot create refunds');} finally {await staffContext.close();}

    const ownerContext=await makeContext(ownerToken,ownerSession.user);
    try {
      const page=await ownerContext.newPage();const pageErrors=[];const consoleErrors=[];const failedRequests=[];let browserPayments=null;const browserRequests=[];page.on('pageerror',error=>pageErrors.push(error.message));page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});page.on('requestfailed',request=>failedRequests.push({url:request.url(),error:request.failure()?.errorText}));page.on('request',request=>browserRequests.push({method:request.method(),url:request.url()}));page.on('response',async response=>{if(new URL(response.url()).pathname===`/api/orders/${ids.uiOrder}/payments`)browserPayments=await response.json().catch(()=>null);});await page.goto(`${base}/orders`,{waitUntil:'domcontentloaded'});const apiProbe=await page.evaluate(async()=>{const fetchCount=window.__qaFetchCalls.length;let result;try{await window.__crmApi('/api/__qa_refund_probe_not_found',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});result={settled:'resolved'};}catch(error){result={settled:'rejected',message:error.message,status:error.status||null,payload:error.payload||null};}return {...result,fetchCalled:window.__qaFetchCalls.length>fetchCount,api:window.__crmApi.toString(),asset:performance.getEntriesByType('resource').find(entry=>entry.name.includes('/portal.js?'))?.name,tokenIsDemo:String(localStorage.getItem('crm_session_token')||'').startsWith('demo-static-')};});assert.equal(apiProbe.settled,'rejected',`nonexistent safe API probe should reject: ${JSON.stringify(apiProbe)}`);assert.equal(apiProbe.fetchCalled,true,'window.__crmApi invokes wrapped fetch for non-demo session');await page.locator(`[data-order-refunds="${ids.uiOrder}"]`).waitFor({state:'visible'});await page.locator(`[data-order-refunds="${ids.uiOrder}"]`).click();
      const dialog=page.locator('dialog.order-refund-dialog');await dialog.waitFor({state:'visible'});await dialog.locator('[data-order-refund-form]').waitFor();
      const requests=[];page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname===`/api/finance/orders/${ids.uiOrder}/refunds`)requests.push(JSON.parse(request.postData()||'{}'));});
      let lostResponse=false;let resolveLostResponse;const lostResponseObserved=new Promise(resolve=>{resolveLostResponse=resolve;});const refundRouteCalls=[];await page.route('**/*',async route=>{const request=route.request();if(request.method()==='POST')refundRouteCalls.push({method:request.method(),url:request.url()});if(!lostResponse&&request.method()==='POST'&&new URL(request.url()).pathname===`/api/finance/orders/${ids.uiOrder}/refunds`){const response=await route.fetch();assert.equal(response.status(),201,'first UI request commits its full refund before response loss');lostResponse=true;await route.abort('failed');resolveLostResponse(true);}else await route.continue();});
      await dialog.locator(`[data-refund-source="${ids.uiPayment}"]`).fill('20.00');await dialog.locator(`[data-refund-item="${ids.uiItem}"]`).fill('1');await dialog.locator('[name="reason"]').fill('Browser QA full refund');
      const submit=dialog.locator('[data-order-refund-form] [type="submit"]');await submit.waitFor({state:'visible'});const initialFormState=await dialog.locator('[data-order-refund-form]').evaluate(form=>({total:form.querySelector('[data-refund-total]')?.textContent,payments:[...form.querySelectorAll('[data-refund-source]')].map(field=>({id:field.dataset.refundSource,amount:field.value,max:field.dataset.refundAvailable})),reason:form.querySelector('[name="reason"]')?.value,disabled:form.querySelector('[type="submit"]')?.disabled}));assert.equal(initialFormState.disabled,false,`valid full-refund form enables submit; browser payments: ${JSON.stringify(browserPayments)}, form: ${JSON.stringify(initialFormState)}`);await submit.click();await page.waitForFunction(key=>Boolean(localStorage.getItem(key)),`crm:pending-order-refund:${ids.uiOrder}`);assert.equal(await Promise.race([lostResponseObserved,delay(5000).then(()=>false)]),true,`browser E2E instrumentation: apiProbe=${JSON.stringify(apiProbe)}; route calls=${JSON.stringify(refundRouteCalls)}; observed posts=${requests.length}; browser requests=${JSON.stringify(browserRequests)}; fetch calls=${JSON.stringify(await page.evaluate(()=>window.__qaFetchCalls))}; submit events=${JSON.stringify(await page.evaluate(()=>window.__qaSubmitEvents))}; tokenIsDemo=${await page.evaluate(()=>String(localStorage.getItem('crm_session_token')||'').startsWith('demo-static-'))}; formMessage=${await dialog.locator('.form-message').textContent()}; notice=${await page.locator('#portal-notice').textContent().catch(()=>null)}; failed=${JSON.stringify(failedRequests)}; pageErrors=${JSON.stringify(pageErrors)}; consoleErrors=${JSON.stringify(consoleErrors)}`);
      assert.equal(await dialog.locator(`[data-refund-source="${ids.uiPayment}"]`).isDisabled(),true,'unresolved write locks its original source field');
      const intentKey=`crm:pending-order-refund:${ids.uiOrder}`;const firstIntent=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),intentKey);assert.ok(firstIntent?.idempotencyKey&&firstIntent?.payload,'full original payload and key persist after lost response');assert.deepEqual(firstIntent.payload.items,[{orderItemId:ids.uiItem,quantity:'1'}],'item return is frozen into retry intent');
      assert.equal(Number((await db.query('SELECT count(*)::int count FROM order_refunds WHERE venue_id=$1 AND order_id=$2',[ids.venue,ids.uiOrder])).rows[0].count),2,'lost response did not create duplicate headers beside the legacy event');
      await page.reload({waitUntil:'domcontentloaded'});await page.locator(`[data-order-refunds="${ids.uiOrder}"]`).waitFor({state:'visible'});await page.locator(`[data-order-refunds="${ids.uiOrder}"]`).click();
      const reloadedDialog=page.locator('dialog.order-refund-dialog');await reloadedDialog.waitFor({state:'visible'});await reloadedDialog.locator('.order-refund-history-row').getByText('Browser QA full refund').waitFor();
      await reloadedDialog.locator(`[data-refund-source="${ids.uiPayment}"]`).waitFor({state:'visible'});assert.equal(await reloadedDialog.locator(`[data-refund-source="${ids.uiPayment}"]`).inputValue(),'20.00','fully refunded payment restores original amount');assert.equal(await reloadedDialog.locator(`[data-refund-source="${ids.uiPayment}"]`).isDisabled(),true);const restoredFormState=await reloadedDialog.locator('[data-order-refund-form]').evaluate(form=>({total:form.querySelector('[data-refund-total]')?.textContent,amount:form.querySelector('[data-refund-source]')?.value,max:form.querySelector('[data-refund-source]')?.dataset.refundAvailable,reason:form.querySelector('[name="reason"]')?.value,disabled:form.querySelector('[type="submit"]')?.disabled}));assert.equal(restoredFormState.disabled,false,`restored pending intent enables same-key retry: ${JSON.stringify(restoredFormState)}`);
      const retryResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/finance/orders/${ids.uiOrder}/refunds`);
      await reloadedDialog.locator('[data-order-refund-form] [type="submit"]').click();const replayResponse=await retryResponse;assert.equal(replayResponse.status(),200);
      await reloadedDialog.locator('.order-refund-history-row').getByText('Browser QA full refund').waitFor();
      assert.equal(requests.length,2,'one first request and one explicit retry; no duplicate submit');assert.equal(requests[0].idempotencyKey,firstIntent.idempotencyKey);assert.equal(requests[1].idempotencyKey,firstIntent.idempotencyKey);assert.deepEqual(requests[1],{...requests[0]});assert.deepEqual(requests[1].items,[{orderItemId:ids.uiItem,quantity:'1'}],'browser exact retry preserves item quantity');
      const browserItemLine=(await db.query('SELECT returned_item_value_minor,producer_sequence,previous_returned_quantity,cumulative_returned_quantity,previous_returned_item_value_minor,cumulative_returned_item_value_minor FROM order_refund_items WHERE venue_id=$1 AND refund_id=(SELECT id FROM order_refunds WHERE venue_id=$1 AND order_id=$2 AND idempotency_key=$3)',[ids.venue,ids.uiOrder,requests[1].idempotencyKey])).rows[0];
      assert.deepEqual([Number(browserItemLine.returned_item_value_minor),Number(browserItemLine.producer_sequence),Number(browserItemLine.previous_returned_quantity),Number(browserItemLine.cumulative_returned_quantity),Number(browserItemLine.previous_returned_item_value_minor),Number(browserItemLine.cumulative_returned_item_value_minor)],[4,1,0.5,1.5,2,6],'browser commit carries new sequence and the legacy aggregate transition baseline');
      assert.equal(Number((await db.query('SELECT count(*)::int count FROM order_refunds WHERE venue_id=$1 AND order_id=$2',[ids.venue,ids.uiOrder])).rows[0].count),2,'exact retry resolves to one new refund header beside one legacy header');
      assert.equal(await page.evaluate(key=>localStorage.getItem(key),intentKey),null,'resolved intent is cleared');

      await page.goto(`${base}/finance/report`,{waitUntil:'domcontentloaded'});const reconciliation=page.locator('#loyalty-reconciliation-results');await reconciliation.getByText('Возврат по POS-заказу').waitFor();
      assert.match(await reconciliation.textContent(),/Возврат по POS-заказу/,'period reconciliation labels order_refund source in the browser');
    } finally {await ownerContext.close();}
  } finally {await browser.close();}

  const shiftClose=await req(`/api/shifts/${ids.shift}/close`,'POST',{closingCash:100,checklist:{version:1,items:{ordersReviewed:true,cashCounted:true,inventoryReviewed:true,externalFiscalReportsHandled:true}}},200);
  assert.equal(Number(shiftClose.expectedCash),300,'cash expected balance includes independently seeded return and race orders; card/QR payouts do not');
  assert.equal((await req(`/api/finance/orders/${ids.otherOrder}/refunds`,'POST',refund(1,[{sourcePaymentId:ids.extraPayment,amount:1,payoutMethod:'cash'}],'refund-no-shift-01'),409)).error,'open_shift_required');
  assert.equal(before,4,'three API-ledger refunds and one simulated unsequenced 091 row existed before Stage 3 events');
  assert.equal((await db.query('SELECT count(*)::int count FROM order_refunds WHERE venue_id=$1 AND order_id=$2',[ids.venue,ids.uiOrder])).rows[0].count,2,'browser UI same-key replay created one new refund header beside legacy event');
  const audits=await db.query("SELECT count(*)::int count FROM audit_events WHERE venue_id=$1 AND action='order.refunded'",[ids.venue]); assert.equal(audits.rows[0].count,9,'one audit record per committed API or browser refund');
  await assert.rejects(db.query('UPDATE order_refunds SET reason=\'mutated\' WHERE venue_id=$1',[ids.venue]),/append-only/);
  assert.equal((await db.query('SELECT count(*)::int count FROM order_refunds WHERE venue_id=$1',[ids.venue])).rows[0].count,before+8,'failed cap transaction rolls back while successful API and serialized SQL events persist');
  console.log('POS ORDER REFUNDS PG + BROWSER QA: PASS (RBAC, tenant miss, split tender, 092 sequence and before/after chain, equal timestamps, serialized direct SQL concurrency, replay/cap/rollback, 091 unsequenced compatibility, payout separation, lost-response UI retry)');
} finally {
  if(server&&server.exitCode===null){server.kill(); await Promise.race([new Promise(resolve=>server.once('exit',resolve)),delay(3000)]);}
  await db.end().catch(()=>{});
}
