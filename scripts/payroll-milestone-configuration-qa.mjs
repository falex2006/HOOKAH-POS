import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateQaDatabaseUrl} from './postgres-qa-safety.mjs';

const args=process.argv.slice(2);assert.ok(args.length===0||(args.length===1&&args[0]==='--postgres'),'use no arguments or --postgres');
const scripts=['payroll-milestone-editor-contract.mjs','payroll-milestone-digest-contract.mjs','payroll-milestone-eligibility-contract.mjs',
 'payroll-milestone-evidence-contract.mjs','payroll-milestone-storage-serializer-contract.mjs','payroll-milestone-render-contract.mjs',
 'payroll-milestone-migration-contract.mjs','payroll-scheme-editor-contract.mjs','payroll-inherited-caption-contract.mjs','payroll-scheme-ui-contract.mjs'];
if(args[0]==='--postgres'){
 validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
 scripts.push('payroll-milestone-configuration-postgres-contract.mjs','payroll-milestone-configuration-browser-postgres-qa.mjs',
   'payroll-milestone-postgres-contract.mjs','payroll-personal-cap-postgres-contract.mjs');
}
for(const script of scripts){
 const result=spawnSync(process.execPath,[fileURLToPath(new URL(script,import.meta.url))],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:process.env,stdio:'inherit',windowsHide:true,timeout:180000});
 if(result.error||result.status!==0)throw new Error(`Payroll milestone QA failed: ${script}`);
}
console.log(`PAYROLL MILESTONE CONFIGURATION SUITE: PASS (${args.length?'isolated PG/browser plus pure':'pure only; PG/browser requires --postgres'})`);
