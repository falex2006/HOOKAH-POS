import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

// Run from any cwd; logs are local artifacts, no server or browser mutations.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(root, process.argv[2] || 'tmp/ui042/final-checks');
fs.mkdirSync(output, {recursive:true});
const tests = ['ui-dialog-lifecycle-contract.mjs', 'ui-dialog-mounted-form-contract.mjs',
  'reservation-wizard-qa.mjs', 'reservation-form-qa.mjs', 'reservations-polish-qa.mjs',
  'ui042-reservation-async-contract.mjs', 'network-action-pending-qa.mjs',
  'ui042-ordinary-editor-contract.mjs', 'ui042-table-schedule-contract.mjs', 'ui042-financial-boundary-contract.mjs'];
const syntax = ['portal.js', 'ui-dialog.js', ...tests.map(name => `scripts/${name}`), 'scripts/ui042-reservation-fixture.mjs', 'scripts/ui042-focused-suite.mjs'];
const commands = [...syntax.map(name => ({name:`syntax ${name}`,command:process.execPath,args:['--check',name]})),
  ...tests.map(name => ({name,command:process.execPath,args:[`scripts/${name}`]})),
  {name:'scoped diff whitespace',command:'git',args:['diff','--check','--','portal.js','style.css','ui-dialog.js',...tests.map(name=>`scripts/${name}`),'scripts/ui042-reservation-fixture.mjs','scripts/ui042-focused-suite.mjs']}];
const results = [];
for (let index=0; index<commands.length; index++) {
  const task = commands[index], result = spawnSync(task.command,task.args,{cwd:root,encoding:'utf8',timeout:60000});
  const log = `${String(index+1).padStart(2,'0')}-${task.name.replace(/[^a-z0-9.-]/gi,'-')}.log`;
  fs.writeFileSync(path.join(output,log),(result.stdout||'')+(result.stderr||'')+(result.error?String(result.error):''));
  results.push({name:task.name,exitCode:result.status,pass:result.status===0,log});
  console.log(`${result.status===0?'PASS':'FAIL'} ${task.name}`);
}
const hash = file => createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
const parity = ['portal.js','style.css','ui-dialog.js'].map(file => ({file,source:hash(file),dist:hash(`dist/${file}`)}));
parity.forEach(pair => { pair.pass = pair.source===pair.dist; console.log(`${pair.pass?'PASS':'FAIL'} source/dist ${pair.file}`); });
const pass = results.every(result=>result.pass)&&parity.every(pair=>pair.pass);
const report = {stage:'UI-04.2',timestamp:new Date().toISOString(),scope:'focused current-source VM/contracts; browser/API evidence separate',pass,results,parity};
fs.writeFileSync(path.join(output,'checks.json'),JSON.stringify(report,null,2)+'\n');
fs.writeFileSync(path.join(output,'checks.txt'),[...results.map(result=>`${result.pass?'PASS':'FAIL'} ${result.name} (${result.exitCode})`),...parity.map(pair=>`${pair.pass?'PASS':'FAIL'} source/dist ${pair.file}: ${pair.source}`)].join('\n')+'\n');
if(!pass)process.exitCode=1;
