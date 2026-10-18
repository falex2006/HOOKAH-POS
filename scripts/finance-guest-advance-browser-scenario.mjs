import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Synthetic fixtures in the guarded runner-owned tenant; this tests reporting, not deposit creation UI.
export async function verifyGuestAdvanceReport({page,base,api,db,venueId,userId,venueDate,selectPortalOption}){
 const insert=async(table,row)=>{const names=Object.keys(row);return(await db.query(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING id`,Object.values(row))).rows[0].id;};
 let shift=(await db.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL',[venueId])).rows[0]?.id;
 if(!shift)shift=await insert('shifts',{venue_id:venueId,opened_by:userId,opening_cash:'0'});
 const guest=await insert('guests',{venue_id:venueId,full_name:`QA advance ${process.pid}`});
 const booking=await insert('reservations',{venue_id:venueId,guest_id:guest,starts_at:new Date().toISOString(),deposit_paid:'200',verified_deposit_paid:'200'});
 await insert('reservations',{venue_id:venueId,guest_id:guest,starts_at:new Date().toISOString(),deposit_paid:'77'});
 const common={venue_id:venueId,shift_id:shift,actor_id:userId,reason:'QA advance reporting'};
 const receipt=await insert('guest_deposit_receipts',{...common,guest_id:guest,amount:'100',payment_method:'cash',idempotency_key:randomUUID()});
 const entry=await insert('guest_account_entries',{venue_id:venueId,guest_id:guest,account_type:'deposit',amount:'100',reason:'QA advance reporting',source_type:'deposit_top_up',source_id:receipt,source_key:randomUUID(),actor_id:userId});
 await insert('guest_account_reversals',{...common,guest_id:guest,source_entry_id:entry,account_type:'deposit',amount:'25',payout_method:'cash',idempotency_key:randomUUID()});
 await insert('guest_account_reversals',{...common,guest_id:guest,source_entry_id:entry,account_type:'deposit',amount:'10',payout_method:'wallet',idempotency_key:randomUUID()});
 const prepayment=await insert('reservation_pre_payment_receipts',{...common,reservation_id:booking,amount:'200',payment_method:'card',idempotency_key:randomUUID()});
 await insert('reservation_pre_payment_receipt_reversals',{...common,reservation_id:booking,receipt_id:prepayment,amount:'50',payout_method:'card',idempotency_key:randomUUID()});
 await page.goto(`${base}/finance/report`,{waitUntil:'networkidle'});
 const panel=page.locator('.finance-unified-report');
 await panel.locator('[data-unified-from]').fill(venueDate);await panel.locator('[data-unified-to]').fill(venueDate);
 await selectPortalOption(panel.locator('[data-unified-source]'),'guest_advance');await panel.locator('[data-unified-q]').fill(guest);
 const saved=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/finance/unified-report/snapshots'&&r.request().postDataJSON()?.source==='guest_advance');
 await panel.locator('[data-unified-load]').click();const response=await saved;assert.equal(response.status(),201);
 const report=await response.json();assert.equal(report.items.guestAdvanceCashEvents.length,4);assert.equal(report.sections.guestAdvanceCashEvents.knownTotalMinor,'22500');
 assert.equal(report.coverage.cashAccounts.status,'incomplete');assert.equal(report.coverage.guestAdvances.eventCount,4);
 const group=panel.locator('.report-source-group').filter({hasText:'Депозиты гостей и предоплаты · фактические поступления и возвраты'});
 await group.locator('summary').click();await group.locator('.report-row').nth(3).waitFor();assert.equal(await group.locator('.report-row').count(),4);
 assert.match(await group.innerText(),/[−-]25,00/);assert.match(await group.innerText(),/[−-]50,00/);assert.ok((await group.innerText()).includes(prepayment));
 await panel.getByText(/Депозиты и предоплаты: 4 денежных событий без записанного ID счёта/).waitFor();
 for(const width of [320,768]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`guest cash report fits ${width}`);}
 await page.setViewportSize({width:1440,height:900});
 const detail=await api(`/api/finance/unified-report?from=${venueDate}&to=${venueDate}&source=guest_advance&q=${guest}`);assert.equal(detail.body.items.guestAdvanceCashEvents.length,4);
}
