// Read-only package inventory. Never copies, stages, merges or publishes files.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url));
const primary='C:/Users/ADMIN/Documents/ChatGPT/HOOKAH CRM 2';
const output=path.join(root,'docs/ai-team/payroll-source-integration-handoff.json');
const git=(args,cwd=root)=>execFileSync('git',args,{cwd,maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytes=file=>fs.existsSync(file)?fs.readFileSync(file):null;
const canonicalCommit=git(['rev-parse','origin/main']).toString().trim();
const primaryHead=git(['rev-parse','HEAD'],primary).toString().trim();
const previous=fs.existsSync(output)?JSON.parse(fs.readFileSync(output,'utf8')):{};
const files=new Map();
const add=(file,kind)=>{if(fs.existsSync(path.join(root,file)))files.set(file,kind);};
for(const name of fs.readdirSync(root).filter(name=>/^payroll.*\.js$/.test(name)))add(name,'payroll_runtime');
for(const name of fs.readdirSync(path.join(root,'migrations')).filter(name=>/^(187|188|189|190|191|201|202|203|204|205|206|207|208)_/.test(name)))add('migrations/'+name,'migration');
for(const name of ['Dockerfile','server.js','db.js','schema.sql','portal.js','finance.html','scripts/sync-published-assets.mjs',
  'inventory-order-cost-capture.js','inventory-order-cost-allocation.js','pos-sale-cost-evidence.js'])add(name,'shared_manual_hunks');
for(const name of ['dist/portal.js','dist/finance.html','dist/finance/index.html','dist/payroll-scheme-ui.js'])add(name,'generated_regenerate_only');
for(const name of fs.readdirSync(path.join(root,'scripts')).filter(name=>/^payroll.*\.(mjs|cjs|js)$/.test(name)))add('scripts/'+name,'qa_or_fixture');
for(const name of ['local-full-pg-regression.cjs','postgres-qa-safety.mjs','build-payroll-source-handoff.mjs'])add('scripts/'+name,'qa_or_fixture');
for(const name of fs.readdirSync(path.join(root,'docs/requirements')).filter(name=>/^PAYROLL.*\.md$/.test(name)))add('docs/requirements/'+name,'documentation_review');
for(const name of ['MIGRATIONS.md','docs/ai-team/WORK_LOG.md','docs/ai-team/DECISIONS.md',
  'docs/ai-team/payroll-refund-aware-acceptance.json',
  'docs/ai-team/payroll-refund-aware-qa-11166.log',
  'docs/requirements/FINANCE_PAYROLL_RECOGNITION_CONTRACT.md'])add(name,'documentation_review');

// Resolve literal relative imports/readFile dependencies, retaining product
// ownership boundaries. Private runtime configuration and artifacts are absent.
const queue=[...files.keys()].filter(name=>/\.(mjs|cjs|js)$/.test(name)),visited=new Set();
while(queue.length){
  const file=queue.shift();if(visited.has(file))continue;visited.add(file);
  const text=fs.readFileSync(path.join(root,file),'utf8');
  for(const match of text.matchAll(/['"](\.{1,2}\/[^'"\r\n]+)['"]/g)){
    const raw=path.posix.normalize(path.posix.join(path.posix.dirname(file),match[1]));
    if(raw.startsWith('../')||/^(tmp|node_modules|\.git)\//.test(raw))continue;
    const dependency=[raw,raw+'.js',raw+'.mjs',raw+'.cjs'].find(name=>fs.existsSync(path.join(root,name))&&fs.statSync(path.join(root,name)).isFile());
    if(!dependency)continue;
    if(!files.has(dependency))add(dependency,dependency.startsWith('scripts/')?'qa_dependency':'shared_dependency_review');
    if(/\.(mjs|cjs|js)$/.test(dependency)&&!visited.has(dependency))queue.push(dependency);
  }
}
const comparison=(source,base)=>base===null?'missing':source===base?'identical':'different';
const records=[...files].sort(([a],[b])=>a.localeCompare(b)).map(([file,kind])=>{
  const source=bytes(path.join(root,file)),primaryBytes=bytes(path.join(primary,file));
  const sourceSha256=hash(source),primaryCheckoutSha256=primaryBytes===null?null:hash(primaryBytes);
  let canonicalBytes=null;try{canonicalBytes=git(['show',`${canonicalCommit}:${file}`]);}catch(error){if(error.status!==128)throw error;}
  const canonicalSha256=canonicalBytes===null?null:hash(canonicalBytes);
  const isText=/\.(js|mjs|cjs|md|sql|html|css|json|yml|yaml)$/.test(file)||file==='Dockerfile';
  const normalized=value=>value===null?null:hash(value.toString('utf8').replaceAll('\r\n','\n'));
  return {path:file,kind,sourceSha256,primaryCheckoutSha256,primaryCheckoutComparison:comparison(sourceSha256,primaryCheckoutSha256),
    canonicalSha256,canonicalComparison:comparison(sourceSha256,canonicalSha256),
    ...(isText?{sourceLfSha256:normalized(source),primaryCheckoutLfSha256:normalized(primaryBytes),canonicalLfSha256:normalized(canonicalBytes),
      primaryCheckoutTextComparison:comparison(normalized(source),normalized(primaryBytes)),canonicalTextComparison:comparison(normalized(source),normalized(canonicalBytes))}:{})};
});
const data={schemaVersion:2,status:previous.status||'local_acceptance_in_progress',
  sourceWorktree:root,sourceHead:git(['rev-parse','HEAD']).toString().trim(),
  canonical:{ref:'origin/main',commit:canonicalCommit,comparison:'exact Git object bytes; local cached remote ref, no network publication claim'},
  primaryCheckout:{path:primary,head:primaryHead,dirty:git(['status','--porcelain'],primary).length>0,
    comparison:'actual dirty filesystem bytes; distinct from canonical origin/main'},
  instructions:'Inventory only. Integrate shared/dependency/docs hunks with their owners; regenerate dist from integrated sources. Never copy old dist bundles independently. No commit/publication/deployment authorized. Recompute hashes after edits.',
  evidence:previous.evidence||{},files:records};
fs.writeFileSync(output,JSON.stringify(data,null,2)+'\n');
console.log(JSON.stringify({files:records.length,canonicalCommit,primaryHead,
  canonicalDifferent:records.filter(row=>row.canonicalComparison==='different').length,
  canonicalMissing:records.filter(row=>row.canonicalComparison==='missing').length,
  canonicalTextDifferent:records.filter(row=>row.canonicalTextComparison==='different').length,
  qaFiles:records.filter(row=>row.kind.startsWith('qa')).length}));
