import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {validateQaDatabaseUrl,assertQaDatabaseIdentity} from './postgres-qa-safety.mjs';
const {Client}=createRequire(import.meta.url)('pg');
const {beginPayrollSourceProducerTransaction,beginPayrollSourceConsumerTransaction,acquirePayrollSourceSnapshotLock,
 beginPayrollVerifiedRunSourceTransaction,hasPayrollVerifiedWriteSnapshot}=createRequire(import.meta.url)('../payroll-source-fence.js');
const {readPayrollRecognitionManifestInTransaction}=createRequire(import.meta.url)('../payroll-recognition-manifest.js');
const {loadLatestProductDepartmentMappingInTransaction}=createRequire(import.meta.url)('../payroll-product-department-source.js');
const target=validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
assert.match(target.database,/^inventory_qa_[a-f0-9]{16}$/);
assert.equal(target.database,process.env.LOCAL_FULL_PG_OWNED_DATABASE);
const clients=Array.from({length:4},()=>new Client({connectionString:target.url.href}));
const venue='11111111-1111-4111-8111-111111111111';
const otherVenue='22222222-2222-4222-8222-222222222222';
const key=`payroll-official-source-v1:${venue}`;
const tryShared=(db)=>db.query('SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS acquired',[key]).then(r=>r.rows[0].acquired);
const tryExclusive=(db)=>db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[key]).then(r=>r.rows[0].acquired);
let tableCreated=false;
try{
 await Promise.all(clients.map(c=>c.connect()));
 assertQaDatabaseIdentity((await clients[0].query('SELECT current_database() database,inet_server_addr() address,inet_server_port() port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser')).rows[0],target.database,Number(target.url.port));
 const [a,b,c,d]=clients;
 await Promise.all([beginPayrollSourceProducerTransaction(a,venue),beginPayrollSourceProducerTransaction(b,venue),beginPayrollSourceProducerTransaction(c,otherVenue)]);
 assert.equal(await tryExclusive(d),false,'consumer waits while either producer is active');
 await c.query('ROLLBACK');
 await a.query('COMMIT');
 assert.equal(await tryExclusive(d),false,'second producer still holds fence');
 await b.query('COMMIT');
 await beginPayrollSourceConsumerTransaction(d,venue);
 assert.equal(await tryShared(c),false,'new producer waits while consumer holds exclusive fence');
 await d.query('ROLLBACK');
 assert.equal(await tryShared(c),true,'rollback releases consumer fence');
 await c.query('ROLLBACK');
 // A waiter must read a producer commit after acquiring its first statement
 // lock. READ COMMITTED gives the subsequent query a fresh statement snapshot.
 await clients[0].query('CREATE TABLE payroll_fence_snapshot_qa(value text)');tableCreated=true;
 await beginPayrollSourceProducerTransaction(a,venue);
 await a.query("INSERT INTO payroll_fence_snapshot_qa VALUES('committed-after-wait')");
 let readerSettled=false;
 const readerPid=(await d.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const reader=beginPayrollSourceConsumerTransaction(d,venue).then(()=>{readerSettled=true;});
 let isWaiting=false;
 const deadline=Date.now()+5000;
 while(Date.now()<deadline&&!isWaiting){
  const state=(await clients[0].query(`SELECT wait_event_type,wait_event,query FROM pg_stat_activity WHERE pid=$1`,[readerPid])).rows[0];
  isWaiting=state?.wait_event_type==='Lock'&&state?.wait_event==='advisory'&&state.query.includes('pg_advisory_xact_lock(');
  if(!isWaiting) await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.equal(isWaiting,true,'consumer backend is waiting on the expected advisory lock');
 assert.equal(readerSettled,false,'exclusive consumer remains blocked until producer commits');
 await a.query('COMMIT');
 await reader;
 assert.equal((await d.query('SHOW transaction_isolation')).rows[0].transaction_isolation,'read committed');
 assert.equal((await d.query('SELECT value FROM payroll_fence_snapshot_qa')).rows[0].value,'committed-after-wait','first source read after lock sees producer commit');
 await d.query('COMMIT');
 // A multi-query REPEATABLE READ source consumer must obtain its session lock
 // before BEGIN or the waiting lock SELECT would establish a stale snapshot.
 await beginPayrollSourceProducerTransaction(a,venue);
 await a.query("INSERT INTO payroll_fence_snapshot_qa VALUES('committed-before-rr-begin')");
 const snapshotPid=(await d.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 let snapshotSettled=false;
 const snapshotPromise=acquirePayrollSourceSnapshotLock(d,venue).then(release=>{snapshotSettled=true;return release;});
 let snapshotWaiting=false;
 const snapshotDeadline=Date.now()+5000;
 while(Date.now()<snapshotDeadline&&!snapshotWaiting){
  const state=(await clients[0].query('SELECT wait_event_type,wait_event,query FROM pg_stat_activity WHERE pid=$1',[snapshotPid])).rows[0];
  snapshotWaiting=state?.wait_event_type==='Lock'&&state?.wait_event==='advisory'&&state.query.includes('pg_advisory_lock(');
  if(!snapshotWaiting) await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.equal(snapshotWaiting,true,'repeatable-read snapshot lock waits on the producer session before BEGIN');
 assert.equal(snapshotSettled,false);
 await a.query('COMMIT');
 const releaseSnapshot=await snapshotPromise;
 await d.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.equal((await d.query("SELECT count(*)::int AS count FROM payroll_fence_snapshot_qa WHERE value='committed-before-rr-begin'")).rows[0].count,1,
  'repeatable-read snapshot starts after acquiring the source lock and sees the producer commit');
 await d.query('COMMIT');
 let producerSettled=false;
 const producerPid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const producerPromise=beginPayrollSourceProducerTransaction(b,venue).then(()=>{producerSettled=true;});
 let producerWaiting=false;
 const producerDeadline=Date.now()+5000;
 while(Date.now()<producerDeadline&&!producerWaiting){
  const state=(await clients[0].query('SELECT wait_event_type,wait_event,query FROM pg_stat_activity WHERE pid=$1',[producerPid])).rows[0];
  producerWaiting=state?.wait_event_type==='Lock'&&state?.wait_event==='advisory'&&state.query.includes('pg_advisory_xact_lock_shared(');
  if(!producerWaiting) await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.equal(producerWaiting,true,'producer waits while snapshot session lock is held');
 assert.equal(producerSettled,false);
 await releaseSnapshot();
 await producerPromise;
 await b.query('ROLLBACK');
 // Only the helper owning pre-snapshot lock acquisition grants RW readers.
 await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE');
 const manifestOptions={venueId:venue,from:'2026-09-01',to:'2026-09-30'};
 await assert.rejects(()=>readPayrollRecognitionManifestInTransaction(a,manifestOptions),/repeatable_read_read_only_required/);
 await assert.rejects(()=>loadLatestProductDepartmentMappingInTransaction(a,venue),/repeatable_read_required/);
 await a.query('ROLLBACK');
 const releaseVerified=await beginPayrollVerifiedRunSourceTransaction(a,venue);
 try{
  assert.equal(hasPayrollVerifiedWriteSnapshot(a,venue),true);
  assert.equal(hasPayrollVerifiedWriteSnapshot(a,otherVenue),false);
  assert.equal(hasPayrollVerifiedWriteSnapshot(b,venue),false);
  const manifest=await readPayrollRecognitionManifestInTransaction(a,manifestOptions);
  assert.ok(['unsupported','incomplete'].includes(manifest.status),'empty synthetic venue remains unavailable');
  const mappings=await loadLatestProductDepartmentMappingInTransaction(a,venue);
  assert.ok(['unsupported','incomplete'].includes(mappings.component.status));
  assert.equal(await tryShared(b),false,'verified write snapshot excludes source producers');
  await a.query('COMMIT');
 }finally{await releaseVerified();}
 assert.equal(hasPayrollVerifiedWriteSnapshot(a,venue),false);
 assert.equal(await tryShared(b),true);
 await b.query('ROLLBACK');
 await assert.rejects(()=>beginPayrollSourceProducerTransaction(a,'not-a-uuid'),/venue_id_invalid/);
 await beginPayrollSourceProducerTransaction(a,'00000000-0000-0000-0000-000000000001');
 await a.query('ROLLBACK');
 console.log('PASS payroll-source-fence-postgres-qa: producer coexistence; READ COMMITTED consumer; pre-BEGIN REPEATABLE READ snapshot lock; producer exclusion; transaction release; venue isolation');
}finally{
 for(const db of clients){await db.query('ROLLBACK').catch(()=>{});if(tableCreated)await db.query('DROP TABLE IF EXISTS payroll_fence_snapshot_qa').catch(()=>{});await db.end().catch(()=>{});}
}
