'use strict';
// Read-only verification of current UI-04.2 saved pixels/measurements. Diagnostic
// directories are deliberately excluded. Does not prove API/auth or persistence.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'docs/design/UNIFIED_UI_2026-10-09/evidence/UI-04.2/final');
const partial=process.argv.includes('--partial'),failures=[],records=[],cache=new Map();let references=0,pending=0,open=0;
const check=(label,run)=>{try{run();}catch(error){failures.push(label+': '+error.message);}};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function sourceHash(file){const full=path.resolve(root,file);assert.ok(full.startsWith(root+path.sep),'source path stays in workspace');if(!cache.has(full))cache.set(full,sha(fs.readFileSync(full)));return cache.get(full);}
function jpegSize(bytes){assert.equal(bytes.readUInt16BE(0),0xffd8,'JPEG signature');let p=2;while(p+4<=bytes.length){if(bytes[p++]!==0xff)continue;let marker=bytes[p++];while(marker===0xff)marker=bytes[p++];if(marker===0xd9||marker===0xda)break;if(marker===0||marker===1||(marker>=0xd0&&marker<=0xd7))continue;const n=bytes.readUInt16BE(p);assert.ok(n>=2&&p+n<=bytes.length,'complete JPEG segment');if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return{width:bytes.readUInt16BE(p+5),height:bytes.readUInt16BE(p+3)};p+=n;}throw Error('JPEG dimensions unavailable');}
const near=(a,b,tolerance=1)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=tolerance;
const inside=(r,v)=>r&&r.width>0&&r.height>0&&r.x>=-1&&r.y>=-1&&r.x+r.width<=v.width+1&&r.y+r.height<=v.height+1;
const insideCard=(r,c)=>r&&r.x>=c.x-1&&r.y>=c.y-1&&r.x+r.width<=c.x+c.width+1&&r.y+r.height<=c.y+c.height+1;
const values=d=>Object.fromEntries(d.fields.filter(f=>f.tag!=='BUTTON'&&(f.name||f.id?.startsWith('reservation-'))).map(f=>[f.name||f.id,f.value]));
for(const file of fs.readdirSync(dir).filter(file=>file.endsWith('.json')).sort())check(file,()=>{
 const e=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));assert.equal(file,e.key+'.json','matching named record');assert.ok(!records.some(r=>r.key===e.key),'unique evidence key');
 assert.equal(e.consistent??e.stable,true,'measurement stability flag');assert.deepEqual(e.before,e.after,'identical before/after geometry/state/values');
 for(const file of ['portal.js','style.css','ui-dialog.js'])assert.ok(e.sourceHashes?.[file],'mandatory source binding '+file);
 for(const [file,hash] of Object.entries(e.sourceHashes)){assert.match(hash,/^[a-f0-9]{64}$/,'source hash format');assert.equal(sourceHash(file),hash,'current source hash '+file);references++;}
 const jpgPath=path.join(dir,file.replace(/\.json$/,'.jpg')),jpg=fs.readFileSync(jpgPath),raster=jpegSize(jpg);assert.match(e.screenshotSHA256||'',/^[a-f0-9]{64}$/,'screenshot SHA recorded');assert.equal(sha(jpg),e.screenshotSHA256,'unchanged JPEG bytes');
 const m=e.before,v=m.viewport,d=m.dialog;assert.ok(v&&v.width>0&&v.height>0,'actual viewport recorded');
 if(e.clip){assert.equal(e.clip.x,0);assert.equal(e.clip.y,0);assert.deepEqual(raster,{width:e.clip.width,height:e.clip.height});}else assert.ok(near(raster.width,v.width)&&near(raster.height,v.height),'JPEG raster matches measured CSS viewport');
 assert.ok(['light','dark'].includes(m.theme),'actual supported theme');assert.equal(m.theme,/(?:^|\s)light-theme(?:\s|$)/.test(m.body)?'light':'dark','actual body theme');
 if(e.meta?.theme)assert.equal(m.theme,e.meta.theme);const namedTheme=/-((?:dark|light))-/.exec(e.key)?.[1];if(namedTheme)assert.equal(m.theme,namedTheme,'named theme matches actual theme');
 assert.ok(d&&typeof d.open==='boolean','measured dialog open state');
 if(e.meta?.verifiedSession){const s=e.meta.verifiedSession;assert.equal(s.status,200);assert.ok(s.userId&&s.venueId&&s.role);if(e.meta.role)assert.equal(s.role,e.meta.role);}
 if(d.open&&d.shared){
  open++;assert.equal(d.role,'dialog');assert.ok(d.title?.trim(),'nonempty accessible title');assert.ok(Array.isArray(d.ids));assert.equal(new Set(d.ids).size,d.ids.length,'unique dialog IDs');assert.ok(d.ids.includes(d.labelledby),'label target exists');
  assert.equal(d.bodyOverflow,'hidden','background scroll locked');assert.ok(d.background?.length,'background measured');assert.ok(d.background.every(n=>n.inert===true),'background inert');
  if(!d.suspended){assert.equal(d.focus.inside,true,'focus inside dialog');assert.ok(near(d.card.width,Math.min(640,v.width-32)),'medium width640 bounded by viewport');assert.ok(d.card.height<=v.height-48+1,'card height bounded');assert.ok(inside(d.card,v),'card on screen');assert.ok(inside(d.head,v)&&inside(d.footer,v),'head/footer on screen');assert.ok(insideCard(d.head,d.card)&&insideCard(d.footer,d.card)&&insideCard(d.body,d.card),'head/body/footer within card');assert.ok(d.body.height>0,'usable body');assert.ok(d.head.y+d.head.height<=d.body.y+1,'body below fixed header');assert.ok(d.body.y+d.body.height<=d.footer.y+1,'body above fixed footer');}
  for(const f of d.fields){
   if(f.id)assert.ok(d.ids.includes(f.id),'field ID exists '+f.id);
   if(f.describedby)for(const id of f.describedby.split(/\s+/).filter(Boolean))assert.ok(d.ids.includes(id),'field help/error target exists '+id);
   if(f.invalid==='true'){assert.ok(f.describedby?.includes(f.id+'-error'),'invalid field linked to local error '+f.id);}
   if(f.visible&&!d.suspended){const checkbox=f.tag==='INPUT'&&f.rect.width<=21&&f.rect.height<=21;if(checkbox)assert.ok(f.labelRect?.height>=43&&f.labelRect?.width>=43,'checkbox label target44');else assert.ok(f.rect.height>=43,'control target44 '+(f.id||f.label));}
  }
  if(d.busy==='true'){pending++;assert.ok(d.fields.length&&d.fields.every(f=>f.disabled),'all pending controls disabled');assert.ok(d.messages.some(message=>message.text.trim()&&message.role==='status'&&message.live==='polite'),'pending live status');}
  if(/(?:write-error|task-error|venue-error|error-retained)/.test(e.key)){assert.ok(d.messages.some(message=>message.text.trim()&&message.role==='alert'&&message.live==='assertive'),'persistent operation error alert');assert.notEqual(d.busy,'true','error no longer pending');}
 }else if(!d.open){assert.ok(d.background.every(n=>n.inert===false),'closed dialog releases background');assert.notEqual(d.bodyOverflow,'hidden','closed dialog releases scroll');if(/readback-focus/.test(e.key)){assert.ok(d.focus.visible,'readback focus is visible');assert.ok(d.focus.tag==='H1'||d.focus.id==='focus-reservation','readback focus reaches stable page heading/action');}}
 if(/reservation-denied$/.test(e.key)){assert.equal(m.denied,true,'measured access denial');assert.equal(d.open,false,'denial has no editor');}
 if(/task-restriction$/.test(e.key))assert.equal(d.open,false,'restricted worker has no editor open');
 records.push(e);
});
check('source/dist byte parity',()=>{for(const file of ['portal.js','style.css','ui-dialog.js'])assert.equal(sourceHash(file),sourceHash('dist/'+file),file+' mirror');});
check('paired files',()=>{for(const file of fs.readdirSync(dir).filter(file=>file.endsWith('.jpg')))assert.ok(fs.existsSync(path.join(dir,file.replace(/\.jpg$/,'.json'))),'JPEG has JSON '+file);assert.ok(records.length,'current final records required');});
for(const e of records.filter(e=>e.key.endsWith('-draft-reopen')))check(e.key+' retained draft',()=>{
 const prior=records.find(p=>p.key===e.key.replace(/-draft-reopen$/,'-write-error'));
 if(!prior)return; // Other reopen paths need their own explicit lifecycle scenario.
 assert.ok(Object.keys(values(prior.before.dialog)).length,'ordinary/mounted draft controls measured');
 assert.deepEqual(values(e.before.dialog),values(prior.before.dialog),'every raw named/mounted field retained from rejected write through reopen');
 assert.equal(e.before.dialog.open,true,'reopened draft is visible');
});
for(const b of records.filter(e=>e.key.endsWith('-pending-b')))check(b.key+' prolonged pending',()=>{
 const a=records.find(e=>e.key===b.key.replace(/-pending-b$/,'-pending-a'));assert.ok(a,'initial pending pair exists');
 assert.ok(Date.parse(b.capturedAt)-Date.parse(a.capturedAt)>=6500,'pending survives at least6.5s between captures');
 assert.equal(a.before.dialog.busy,'true');assert.equal(b.before.dialog.busy,'true');assert.deepEqual(values(a.before.dialog),values(b.before.dialog),'pending values unchanged after time/Escape/Return sequence');
});
if(!partial)check('bounded desktop/theme/actual/narrow coverage',()=>{
 const has=(width,height,theme,state)=>records.some(e=>near(e.before.viewport.width,width)&&near(e.before.viewport.height,height)&&e.before.theme===theme&&e.before.dialog.open&&state.test(e.key));
 for(const [w,h] of [[1366,768],[1920,1080]])for(const theme of ['dark','light'])for(const state of [/\-zone$/,/\-table$/,/\-venue$/,/\-task$/,/\-reservation-step1$/,/\-reservation-step2$/,/\-reservation-step3$/])assert.ok(has(w,h,theme,state),[w,h,theme,state].join(' ')+' represented');
 for(const theme of ['dark','light']){assert.ok(records.some(e=>/-actual-/.test(e.key)&&e.before.theme===theme&&e.before.dialog.open),'actual '+theme+' shared frame');assert.ok(records.some(e=>e.before.viewport.width<500&&e.before.theme===theme&&e.before.dialog.open),'ordinary narrow '+theme+' shared frame');}
});
console.log(JSON.stringify({phase:'UI-04.2',mode:partial?'current-saved-pairs':'bounded-visual-matrix',pairs:records.length,sourceReferences:references,sharedOpenFrames:open,pendingFrames:pending,result:failures.length?'FAIL':'PASS',failures},null,2));process.exitCode=failures.length?1:0;
