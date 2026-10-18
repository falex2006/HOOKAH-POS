// Read-only: verify tar.gz bytes against a local Git commit, never extract or deploy.
const fs=require('fs'),cp=require('child_process'),zlib=require('zlib'),crypto=require('crypto'),assert=require('assert/strict');
const [checkout,commit,archive]=process.argv.slice(2);
assert(checkout&&commit&&archive,'Usage: node scripts/ui092-verify-archive.cjs <checkout> <commit> <archive.tar.gz>');
const git=(...args)=>cp.execFileSync('git',args,{cwd:checkout,maxBuffer:30000000});
const exact=git('rev-parse','--verify',commit+'^{commit}').toString().trim();
const entries=git('ls-tree','-r','-z',exact).toString().split('\0').filter(Boolean);
const expected=new Map(entries.map(s=>{const [info,name]=s.split('\t');const [mode,type,oid]=info.split(' ');assert(type==='blob'&&/^100(?:644|755)$/.test(mode),'Regular files only: '+name);return [name,{oid,mode}];}));
const compressed=fs.readFileSync(archive),tar=zlib.gunzipSync(compressed,{maxOutputLength:512*1024*1024});
const seen=new Set(),findings=[],hash=(alg,b)=>crypto.createHash(alg).update(b).digest('hex');
let extended={},global={},longName=null;
const str=b=>b.toString('utf8').replace(/\0.*$/s,'');
function pax(bytes){let p=0,out={};while(p<bytes.length){const space=bytes.indexOf(32,p),n=Number(bytes.subarray(p,space).toString());assert(space>p&&Number.isInteger(n)&&n>0&&p+n<=bytes.length,'Valid PAX record');const record=bytes.subarray(space+1,p+n-1).toString(),eq=record.indexOf('=');assert(eq>0,'Valid PAX key');out[record.slice(0,eq)]=record.slice(eq+1);p+=n;}return out;}
for(let pos=0;pos+512<=tar.length;){
 const header=tar.subarray(pos,pos+512);if(header.every(b=>b===0)){assert(tar.subarray(pos).every(b=>b===0),'Zero-only TAR remainder');break;}
 const checksum=parseInt(str(header.subarray(148,156)).trim(),8);
 assert.equal([...header].reduce((n,b,i)=>n+(i>=148&&i<156?32:b),0),checksum,'TAR checksum');
 const size=parseInt(str(header.subarray(124,136)).trim(),8)||0,type=String.fromCharCode(header[156]||48);
 assert(Number.isSafeInteger(size)&&size>=0&&pos+512+size<=tar.length,'TAR bounds');
 const bytes=tar.subarray(pos+512,pos+512+size);pos+=512+Math.ceil(size/512)*512;
 if(type==='g'){const record=pax(bytes);assert(Object.keys(record).every(x=>x==='comment'),'Supported global PAX metadata only');global={...global,...record};continue;}
 if(type==='x'){extended=pax(bytes);assert(Object.keys(extended).every(x=>x==='path'||x==='mtime'),'Supported local PAX metadata only');continue;}
 if(type==='L'){longName=str(bytes);continue;}
 const prefix=str(header.subarray(345,500)),name=extended.path||longName||(prefix?prefix+'/':'')+str(header.subarray(0,100));
 extended={};longName=null;
 assert(!name.startsWith('/')&&!/[\\:]/.test(name)&&!name.split('/').includes('..'),'Safe archive path');
 if(type==='5'){assert([...expected.keys()].some(x=>x.startsWith(name.replace(/\/$/,'')+'/')),'Expected archive directory');continue;}
 assert(type==='0','Regular archive member: '+name);
 assert(!seen.has(name),'Duplicate archive file');seen.add(name);
 const record=expected.get(name);assert(record,'Unexpected archive member: '+name);
 const blob=hash('sha1',Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes]));assert.equal(blob,record.oid,'Git blob match: '+name);
 const archiveMode=parseInt(str(header.subarray(100,108)).trim(),8);assert.equal(Boolean(archiveMode&0o111),record.mode==='100755','Executable bit: '+name);
 if(/(^|\/)(?:tmp|node_modules|backups|archive-recovery|\.git)(\/|$)|\.(?:sqlite3?|db|dump|bak)$/i.test(name)||/(^|\/)\.env(?:$|\.(?!example$|sample$))/i.test(name))findings.push({path:name,kind:'forbidden runtime/temp file'});
 if(bytes.length<=10*1024*1024&&!bytes.includes(0)){
  const text=bytes.toString('utf8');
  for(const [kind,re] of [
   ['private key',/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
   ['provider token',/\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{25,}|AKIA[A-Z0-9]{16}|sk-proj-[A-Za-z0-9_-]{40,})\b/]
  ])if(re.test(text))findings.push({path:name,kind});
 }
}
assert.equal(seen.size,expected.size,'Complete archive inventory');
assert.equal(global.comment,exact,'Archive commit annotation');
console.log(JSON.stringify({commit:exact,archiveSha256:hash('sha256',compressed),archiveBytes:compressed.length,files:seen.size,gitBlobsExact:true,archiveExecutableBitsExact:true,commitAnnotation:global.comment,findings,secretScan:'high-confidence token/private-key signatures and runtime-file names; not a universal secret detector'},null,2));
if(findings.length)process.exitCode=1;
