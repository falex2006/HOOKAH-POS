'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process'),{createHash}=require('node:crypto');
const {config,folder}=require('./staff-schedule-local-config.cjs');
config(); // Refuse execution against anything except the dedicated local runtime.
const root=path.join(__dirname,'..');
const assets=['portal.js','portal-session.js','staff-schedule-ui.js','staff-schedule-ui.css','staff-schedule-planning-ui.js'];
const sources=['server.js','staff-schedule-domain.js','staff-schedule-access.js','staff-schedule-service.js','staff-schedule-copy.js','staff-schedule-routes.js','staff-schedule-planning.js','staff-schedule-pattern.js','migrations/103_staff_schedule_planning.sql','payroll-attendance-manifest.js',...assets];
const readHashes=()=>Object.fromEntries(sources.map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')]));
const startHashes=readHashes();
const suites=['local-env','local-guards','domain','actual','access-pg','service-pg','revoke-race-pg','batch-pg','copy-pg','payroll-pg','venue-access-pg','access-http','crud-http','venue-http','planning-pg','planning-concurrency','planning-http','browser-crud','browser-roles','legacy-browser','load-errors-browser','browser','visual','calendar','planning-browser','keyboard','migration-recovery'];
const results=[];
for(const name of suites){
  const file=`scripts/staff-schedule-${name}-qa.cjs`,started=Date.now();
  const r=spawnSync(process.execPath,[file,...(name==='calendar'?['--run']:[])],{cwd:root,env:process.env,encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:2*1024*1024});
  const result={name,code:r.status,elapsedMs:Date.now()-started,output:(r.stdout||'').trim(),error:(r.stderr||'').trim()};results.push(result);
  console.log(`${name}: ${r.status===0?'PASS':'FAIL'} (${result.elapsedMs}ms)`);
  if(r.status!==0)break;
}
let distParity=true,sourcesUnchanged=true,hashes=null;const evidenceErrors=[];
for(const name of assets){try{assert.deepEqual(fs.readFileSync(path.join(root,name)),fs.readFileSync(path.join(root,'dist',name)),`dist mismatch ${name}`);}catch(error){distParity=false;evidenceErrors.push(`dist parity failed: ${name}`);}}
try{hashes=readHashes();assert.deepEqual(hashes,startHashes);}catch(error){sourcesUnchanged=false;evidenceErrors.push('Product sources changed or became unreadable during acceptance');}
const report={at:new Date().toISOString(),passed:results.length===suites.length&&results.every(r=>r.code===0)&&distParity&&sourcesUnchanged,results,startHashes,hashes,distParity,sourcesUnchanged,evidenceErrors};
const output=path.join(folder,'acceptance-'+Date.now()+'.json');fs.writeFileSync(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(`Acceptance report: ${path.basename(output)}; ${report.passed?'PASS':'FAIL'}`);
if(!report.passed)process.exitCode=1;
