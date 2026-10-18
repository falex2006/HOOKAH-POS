// Build only in a clean isolated checkout at the declared base. Never deploy.
const fs=require('fs'),path=require('path'),cp=require('child_process'),assert=require('assert/strict'),crypto=require('crypto');
const root=path.resolve(__dirname,'..'),inputs=path.join(root,'docs/release/UI_09_2/inputs');
const args=process.argv.slice(2),candidate=path.resolve(args[0]||''),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
assert(args[0],'Usage: node scripts/ui092-release-package.cjs <isolated-checkout>');
assert.notEqual(candidate,root,'Never build in the shared dirty checkout');
assert(fs.existsSync(path.join(candidate,'.git')),'Existing isolated Git checkout required');
assert.notEqual(fs.realpathSync(candidate),fs.realpathSync(root),'Distinct physical checkout required');
const git=(...a)=>cp.execFileSync('git',a,{cwd:candidate,encoding:'utf8',maxBuffer:30000000});
const manifest=JSON.parse(fs.readFileSync(path.join(inputs,'manifest.json')));
assert.equal(git('rev-parse','HEAD').trim(),manifest.base,'Pinned base required');
assert.equal(git('status','--porcelain=v1','--untracked-files=all').trim(),'','Clean candidate required');
const seen=new Set();
const prepared=[];
for(const entry of manifest.files){
 assert(!seen.has(entry.path),'Duplicate input');seen.add(entry.path);
 assert(!path.isAbsolute(entry.path)&&!entry.path.split(/[\\/]/).some(x=>x==='..'||x==='.'),'Safe relative input');
 assert(!/[\\:]/.test(entry.path),'Canonical POSIX input path required');
 assert(!/(^|\/)(?:\.env(?:\.|$)|tmp|node_modules|backups|archive-recovery|\.git)(\/|$)/i.test(entry.path),'Forbidden input');
 const bytes=fs.readFileSync(path.join(inputs,'files',entry.path));assert.equal(sha(bytes),entry.sha256,'Frozen input hash: '+entry.path);
 const target=path.resolve(candidate,entry.path);assert(target.startsWith(candidate+path.sep),'Target containment');
 for(let probe=target;probe!==candidate;probe=path.dirname(probe)){
  if(fs.existsSync(probe))assert(!fs.lstatSync(probe).isSymbolicLink(),'No linked input target: '+entry.path);
 }
 prepared.push({target,bytes});
}
for(const {target,bytes} of prepared){fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);}
const dockerPath=path.join(candidate,'Dockerfile');let docker=fs.readFileSync(dockerPath,'utf8');
assert(docker.includes('COPY table-minimum-schedule.js ./'),'Retain upstream schedule module');
assert(!docker.includes('COPY ui-dialog.js ./'),'Unexpected existing dialog COPY');
docker=docker.replace('COPY table-minimum-schedule.js ./','COPY table-minimum-schedule.js ./\nCOPY ui-dialog.js ./');fs.writeFileSync(dockerPath,docker);
const syncPath=path.join(candidate,'scripts/sync-published-assets.mjs');let sync=fs.readFileSync(syncPath,'utf8');
for(const name of ['cssRevision','portalRevision','portalSessionRevision','appRevision','lockRevision','platformRevision','platformCssRevision']){
 const re=new RegExp("const "+name+" = '\\d+';");assert(re.test(sync),'Revision contract '+name);sync=sync.replace(re,"const "+name+" = '2026101101';");
}
assert(!sync.includes("cpSync(resolve(root, 'ui-dialog.js')"),'Unexpected dialog sync');
sync+="\ncpSync(resolve(root, 'ui-dialog.js'), resolve(root, 'dist', 'ui-dialog.js'));\n";fs.writeFileSync(syncPath,sync);
cp.execFileSync(process.execPath,['scripts/sync-published-assets.mjs'],{cwd:candidate,stdio:'inherit'});
cp.execFileSync('git',['diff','--check'],{cwd:candidate,stdio:'inherit'});
console.log('UI092 bounded candidate built from '+manifest.base+'; no commit/publication performed.');
