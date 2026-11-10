import {createRequire} from 'node:module';
import {randomBytes,randomUUID,scryptSync} from 'node:crypto';
import {readFile,readdir,writeFile,access} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {seedUnpaidSupersessionFixture} from './payroll-unpaid-supersession-fixture.mjs';

const require=createRequire(import.meta.url);
const {Pool}=require('pg');
const qa=process.argv.includes('--visual-qa');
const run=process.env.PAYROLL_OWNER_VISUAL_RUN;
if(run) assert.match(run,/^[0-9a-f]{16}$/);
const store='tmp/payroll-owner-demo/'+(qa?(run?'visual-'+run+'/':'visual-qa/'):'');
const configPath=store+'demo.local.json';
const db=JSON.parse(await readFile(store+'db.local.json','utf8'));
assert.match(db.name,/^orders_qa_[a-f0-9]{16}$/);
const connectionString='postgresql://postgres:'+encodeURIComponent(db.password)+'@127.0.0.1:54561/'+db.name;
process.env.LOCAL_FULL_PG_OWNED_DATABASE=db.name;
let config;
try { await access(configPath); config=JSON.parse(await readFile(configPath,'utf8')); }
catch (error) { if(error.code!=='ENOENT') throw error; }
if(!config) {
 const pool=new Pool({connectionString});
 try {
  assert.equal((await pool.query("SELECT to_regclass('public.users') AS existing")).rows[0].existing,null,'Fresh dedicated database required');
  await pool.query(await readFile('schema.sql','utf8'));
  for(const file of (await readdir('migrations')).filter(x=>x.endsWith('.sql')).sort()) await pool.query(await readFile('migrations/'+file,'utf8'));
  const period=(await pool.query("SELECT (date_trunc('month',CURRENT_DATE)-interval '1 month')::date::text AS \"from\", (date_trunc('month',CURRENT_DATE)-interval '1 day')::date::text AS \"to\"")).rows[0];
  const schedule=require('../staff-schedule-service');
  const attendance=require('../payroll-attendance-manifest').makePayrollAttendanceManifestService(pool);
  const {ids,owner}=await seedUnpaidSupersessionFixture({pool,period,sourcesOnly:true});
  const password=randomBytes(16).toString('hex'),salt=randomBytes(16).toString('hex');
  const hash='scrypt$'+salt+'$'+scryptSync(password,salt,64).toString('hex');
  await pool.query("UPDATE venues SET name='Учебный зал' WHERE id=$1",[ids.venue]);
  await pool.query("UPDATE users SET full_name='Владелец демозала', login='payroll.demo', password_hash=$2 WHERE id=$1",[ids.owner,hash]);
  await pool.query("UPDATE users SET full_name='Анна Смирнова' WHERE id=$1",[ids.employee]);
  await pool.query("UPDATE users SET full_name='Иван Соколов' WHERE id=$1",[ids.zeroEmployee]);
  await pool.query("INSERT INTO organization_subscriptions(organization_id,status) VALUES($1,'active') ON CONFLICT(organization_id) DO UPDATE SET status='active'",[ids.org]);
  const day=period.from;
  await schedule.save(pool,owner,{userId:ids.employee,kind:'shift',workDate:day,breakMinutes:0,plannedStart:day+'T10:00:00Z',plannedEnd:day+'T18:00:00Z',requestKey:randomUUID(),reason:'Учебная смена'});
  await pool.query("INSERT INTO staff_work_logs(venue_id,user_id,started_at,ended_at,source) VALUES($1,$2,$3,$4,'manual')",[ids.venue,ids.employee,day+'T10:00:00Z',day+'T18:00:00Z']);
  for(const end of [day.slice(0,8)+'14',period.to]){
   const range={periodFrom:day,periodTo:end};
   const coverage=await attendance.readCoverage(owner,range);
   await attendance.approveCoverage(owner,{...range,reason:'Сверка учебной смены',idempotencyKey:randomUUID(),sourceWatermark:coverage.sourceWatermark});
  }
  config={username:'payroll.demo',password,ids,period};
  await writeFile(configPath,JSON.stringify(config,null,2),{flag:'wx',mode:0o600});
 } finally {await pool.end();}
}
Object.assign(process.env,{DATABASE_URL:connectionString,VENUE_ID:config.ids.venue,AUTH_REQUIRED:'true',DEMO_MODE:'false',NODE_ENV:'test',HOST:'127.0.0.1',PORT:qa?(run?'0':'4180'):'4179'});
require('../server.js');
