'use strict';
// UI-04.1 offline evidence verification. No browser, auth, storage or DB writes.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const evidence=path.join(root,'docs/design/UNIFIED_UI_2026-10-09/evidence/UI-04.1');
const dir=path.join(evidence,'final');
const partial=process.argv.includes('--partial');
const failures=[],entries=new Map(),hashes=new Map();let refs=0,openCount=0,pendingCount=0,referenceCount=0;
const check=(label,run)=>{try{run();}catch(error){failures.push(label+': '+error.message);}};
function hash(file){const full=path.resolve(root,file);assert.ok(full.startsWith(root+path.sep),'reference must stay within workspace');if(!hashes.has(full))hashes.set(full,crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));return hashes.get(full);}
function jpegSize(bytes){assert.equal(bytes.readUInt16BE(0),0xffd8,'JPEG signature');let p=2;while(p+4<=bytes.length){if(bytes[p++]!==0xff)continue;let marker=bytes[p++];while(marker===0xff)marker=bytes[p++];if(marker===0xd9||marker===0xda)break;if(marker===0||marker===1||(marker>=0xd0&&marker<=0xd7))continue;const n=bytes.readUInt16BE(p);assert.ok(n>=2&&p+n<=bytes.length,'complete JPEG segment');if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return{width:bytes.readUInt16BE(p+5),height:bytes.readUInt16BE(p+3)};p+=n;}throw Error('JPEG dimensions unavailable');}
const close=(a,b,t=1)=>Math.abs(a-b)<=t;
const inside=(r,v)=>r&&r.x>=-1&&r.y>=-1&&r.x+r.width<=v.width+1&&r.y+r.height<=v.height+1;
const textValues=d=>Object.fromEntries((d?.fields||[]).filter(f=>f.name).map(f=>[f.name,f.value]));
function rgb(value){const m=String(value).match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);return m&&(!m[4]||Number(m[4])===1)?m.slice(1,4).map(Number):null;}
function contrast(a,b){const light=c=>c.map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0);const aa=light(a),bb=light(b);return(Math.max(aa,bb)+.05)/(Math.min(aa,bb)+.05);}
const mandatorySources=['ui-dialog.js','portal.js','app.js','style.css','server.js','lock.js','portal-session.js','scripts/ui-dialog-browser-measure.mjs','scripts/ui-shell-browser-measure.mjs'];
for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.json')).sort()){
  check(file,()=>{
    const e=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8')),meta=e.meta||{},m=e.before,d=m?.dialog,state=meta.state||e.key;
    assert.equal(file,e.key+'.json','named record');assert.ok(!entries.has(e.key),'unique record key');entries.set(e.key,e);
    assert.equal(e.stable,true,'stable flag');assert.deepEqual(e.before,e.after,'before/after DOM and geometry identical');
    assert.ok(Object.keys(e.sourceHashes||{}).length>=10,'at least ten frozen source bindings');
    for(const source of mandatorySources)assert.ok(e.sourceHashes[source],'mandatory source binding '+source);
    for(const[source,sha]of Object.entries(e.sourceHashes)){assert.equal(hash(source),sha,'current source '+source);refs++;}
    const raster=jpegSize(fs.readFileSync(path.join(dir,file.replace(/\.json$/,'.jpg'))));
    assert.deepEqual(raster,{width:e.clip.width,height:e.clip.height},'JPEG raster equals recorded CSS clip');
    assert.equal(e.clip.x,0,'clip origin x');assert.equal(e.clip.y,0,'clip origin y');
    assert.ok(m.viewport&&m.viewport.width>0&&m.viewport.height>0,'actual CSS viewport');
    assert.ok(d&&typeof d.open==='boolean','measured dialog state');
    const localReference=new URL(m.url).pathname==='/__ui041/reference';
    if(localReference){referenceCount++;assert.ok(meta.reference===true||meta.localReference===true||meta.fixture==='local-no-api-no-storage-no-auth','explicit reference context, no auth inference');for(const source of ['docs/design/UNIFIED_UI_2026-10-09/components/UI_04_1_REFERENCE.html','docs/design/UNIFIED_UI_2026-10-09/components/ui-dialog-reference.js'])assert.ok(e.sourceHashes[source],'actual reference runtime binding '+source);
      const observed=JSON.parse(e.reference);assert.equal(observed.fixture,'local-no-api-no-storage-no-auth','actual readonly reference report context');assert.equal(observed.module,1,'reference runs shared module');assert.equal(observed.theme,m.theme,'actual report theme');
      if(e.key==='reference-portal-callback-success'){assert.equal(observed.lastValues.optional,true,'actual portal checkbox boolean');assert.equal(observed.lastValues.amount,'','optional numeric string remains empty');assert.equal(observed.lastResult.fixture,'success');assert.equal(observed.open,false);}
      if(e.key==='reference-staff-callback-success'){assert.equal(observed.lastValues.optional,'on','actual staff checkbox string');assert.equal(observed.lastValues.amount,'','staff optional number remains empty string');assert.equal(observed.lastValues.defaultOptional,'');assert.equal(observed.lastResult.fixture,'success');assert.equal(observed.open,false);}
      if(/reference-pin-(?:yield|settings-closed|native-settings)$/.test(e.key)){assert.equal(observed.pinVisible,true,'static PIN visible');assert.equal(d.suspended,true,'shared window yields to static PIN');assert.equal(d.focus.id,observed.nativeSettingsOpen?'reference-settings-input':'screen-lock-pin','priority surface focus');}
      if(e.key==='reference-native-yield'){assert.equal(observed.nativeSettingsOpen,true);assert.equal(d.suspended,true);assert.equal(d.focus.id,'reference-settings-input');}
      if(/reference-(?:pin|native)-resume$/.test(e.key)){assert.equal(observed.nativeSettingsOpen,false);assert.equal(observed.pinVisible,false);assert.equal(d.suspended,false);assert.equal(d.focus.inside,true);}
      if(/^reference-number-(?:min|max)-invalid$/.test(e.key)){
        const amount=d.fields.find(f=>f.name==='amount');assert.equal(amount?.invalid,'true','numeric bound has linked invalid state');assert.equal(amount?.value,e.key.includes('-min-')?'-1':'101','raw numeric string retained');assert.equal(observed.pending,false,'invalid number never starts pending');
        const lastOpen=observed.events.map(x=>x.type).lastIndexOf('open');assert.ok(lastOpen>=0,'numeric fixture has observed open event');assert.ok(!observed.events.slice(lastOpen+1).some(x=>x.type==='callback-start'),'invalid numeric submit never invokes callback since open');
      }
      if(meta.feedbackObserved){const f=meta.feedbackObserved;assert.ok(f.text?.trim(),'observed feedback text');assert.equal(f.role,f.kind==='error'?'alert':'status');assert.equal(f.live,f.kind==='error'?'assertive':'polite');if(state==='feedback-error-retained')assert.ok(meta.afterErrorMs>=4200,'error remains beyond previous toast');}
    }
    else{
      const session=meta.verifiedSession;assert.ok(session,'actual disposable API session provenance');assert.equal(session.status,200,'verified session response');assert.ok(session.userId&&session.venueId&&session.role,'actual identity');
      if(meta.role)assert.equal(session.role,meta.role,'role matches frame metadata');if(meta.venueId||meta.venue)assert.equal(session.venueId,meta.venueId||meta.venue,'venue matches metadata');
    }
    if(meta.theme)assert.equal(m.theme,meta.theme,'actual computed theme');
    if(meta.expectedOpen!==undefined)assert.equal(d.open,meta.expectedOpen,'expected open state');
    if(meta.expectedFocusId!==undefined)assert.equal(d.focus.id,meta.expectedFocusId,'expected focus id');
    if(meta.expectedValues)for(const[k,v]of Object.entries(meta.expectedValues))assert.equal(textValues(d)[k],v,'preserved field '+k);
    if(meta.expectedDenied!==undefined)assert.equal(m.denied,meta.expectedDenied,'denial state');
    if(d.open&&d.shared){
      openCount++;assert.equal(d.role,'dialog','accessible role');assert.ok(d.title?.trim(),'accessible title text');assert.ok(d.labelledby,'title association');
      assert.ok(Array.isArray(d.ids),'measured dialog ids');assert.equal(new Set(d.ids).size,d.ids.length,'unique IDs inside dialog');assert.ok(d.ids.includes(d.labelledby),'label target exists');
      assert.equal(d.bodyOverflow,'hidden','background scroll locked');assert.ok(d.background.length,'background measured');assert.ok(d.background.every(n=>n.inert===true),'background inert');
      const suspended=d.suspended===true;
      if(!suspended){
        assert.ok(d.focus.inside,'active focus within shared dialog');
        const maxWidth=meta.expectedSize==='small'?440:meta.expectedSize==='large'?880:localReference&&/long|large/.test(state)?880:localReference&&/small/.test(state)?440:640;
        assert.ok(close(d.card.width,Math.min(maxWidth,m.viewport.width-32),1),'candidate card width bounded by viewport');
        assert.ok(d.card.height<=m.viewport.height-48+1,'card bounded height');assert.ok(inside(d.card,m.viewport),'card inside CSS viewport');
        assert.ok(inside(d.head,m.viewport)&&inside(d.footer,m.viewport),'header and footer remain visible');
        assert.ok(d.body.height>0,'content has usable scroll region');
      }
      for(let i=0;i<d.fields.length;i++){
        const f=d.fields[i];
        if(f.name){assert.ok(f.id,'named field has id');assert.ok(d.ids.includes(f.id),'field id is present');assert.ok(f.describedby?.split(/\s+/).every(id=>d.ids.includes(id)),'field error/help association targets exist');}
        if(f.invalid==='true'){assert.ok(f.describedby?.includes(f.id+'-error'),'invalid field linked to persistent local error');if(f.tag==='SELECT'){const trigger=d.fields[i+1];assert.equal(trigger?.tag,'BUTTON','select custom trigger measured');assert.equal(trigger.invalid,'true','custom trigger invalid state');assert.ok(trigger.describedby?.includes(f.id+'-error'),'custom trigger error association');}}
        // The local reference checkbox glyph is20px; the linked label is its measured hit area.
        const referenceCheckbox=localReference&&f.tag==='INPUT'&&f.name==='optional'&&close(f.rect.width,20)&&close(f.rect.height,20);
        if(referenceCheckbox&&f.visible&&!suspended)assert.ok(f.labelRect?.width>=43&&f.labelRect?.height>=43,'checkbox label hit area44px');
        if(f.visible&&!suspended&&!referenceCheckbox){
          assert.ok(f.rect.height>=43,'visible control hit height '+(f.name||f.label));
          if(f.rect.width<43){assert.equal(f.tag,'SELECT','only native select behind visible custom trigger can have small width');const trigger=d.fields[i+1];assert.ok(trigger?.visible&&trigger.tag==='BUTTON'&&trigger.rect.width>=43,'small select has visible full-width custom trigger');}
          const fg=rgb(f.rect.color),bg=rgb(f.rect.background);if(fg&&bg)assert.ok(contrast(fg,bg)>=4.5-.01,'text contrast '+(f.name||f.label));
          if(f.tag==='BUTTON'&&d.fields[i-1]?.tag==='SELECT'){
            const arrow=rgb(f.icon?.arrow);assert.ok(arrow&&bg,'custom select arrow colors measured');assert.ok(contrast(arrow,bg)>=3-.01,'custom select arrow contrast3:1');
          }
          if(f.name==='dueDate'){
            assert.equal(f.icon?.colorScheme,m.theme,'native date uses actual theme color scheme');assert.equal(f.icon?.calendarFilter,'none','native date picker has no legacy inverse filter');
          }
        }
      }
      if(d.busy==='true'){
        pendingCount++;assert.ok(d.fields.length&&d.fields.every(f=>f.disabled),'all controls disabled while pending');assert.ok(d.messages.some(x=>x.role==='status'&&x.live==='polite'),'pending live announcement');
      }
      if(!localReference&&/^(?:open|invalid|reopen-draft|select-escape|tab-wrap|shift-tab-wrap|write-error|error-retained|pending|pending-escape|pending-long)$/.test(state)){
        const values=textValues(d);for(const name of ['title','description','assigneeId','priority','dueDate'])assert.equal(typeof values[name],'string','pilot retains string field '+name);
        for(const name of ['title','assigneeId','priority','dueDate'])assert.equal(d.fields.find(f=>f.name===name)?.required,true,'pilot required '+name);
        assert.equal(d.fields.find(f=>f.name==='description')?.required,false,'description optional');
      }
      if(state==='open'&&!localReference)assert.equal(d.focus.name,'title','initial title focus');
      if(state==='invalid'){assert.ok(d.fields.some(f=>f.invalid==='true'),'invalid field state visible');assert.ok(d.messages.length,'persistent field error text');}
      if(/write-error|error-retained/.test(state)){assert.ok(d.messages.some(x=>x.role==='alert'&&x.live==='assertive'),'operation error is persistent inline alert');assert.equal(d.busy,'false','pending restored after error');}
      if(state==='error-retained')assert.ok(meta.afterErrorMs>=4200,'error observed beyond old toast lifetime');
      if(state==='tab-wrap')assert.equal(d.focus.label,'Закрыть окно','forward Tab wraps to first close control');
      if(state==='shift-tab-wrap'){assert.equal(d.focus.tag,'BUTTON','reverse Tab wraps to last submit');assert.equal(d.focus.inside,true);}
      if(state==='select-escape'){assert.equal(d.focus.tag,'BUTTON','custom select Escape restores trigger');assert.equal(d.focus.inside,true);}
    }
    if(state==='cancel-focus'||state==='success'){
      assert.equal(d.open,false,'window closed');assert.equal(d.focus.id,localReference?(meta.expectedFocusId||d.focus.id):'task-new','focus restored to opener');assert.ok(d.background.every(n=>n.inert===false),'background inert released');assert.notEqual(d.bodyOverflow,'hidden','scroll lock released');
    }
    if(meta.expectedFallback){assert.equal(d.open,false,'fallback after close');assert.equal(d.focus.id,meta.expectedFallback,'disconnected opener fallback');}
  });
}
for(const e of entries.values())check(e.key+' associations',()=>{
  if(e.meta.state==='reopen-draft'){
    const prefix=e.key.replace(/reopen-draft$/,''),cancel=entries.get(prefix+'cancel-focus');assert.ok(cancel,'paired cancel frame');assert.ok(textValues(e.before.dialog).title,'reopened nonempty draft');
  }
  if(e.meta.state==='error-retained'){
    const source=entries.get(e.key.replace(/error-retained$/,'write-error'));assert.ok(source,'paired initial save error');assert.deepEqual(textValues(source.before.dialog),textValues(e.before.dialog),'all values retained after error timeout');
  }
  if(e.meta.state==='pending-after-six'){
    const initial=entries.get(e.key.replace(/pending-after-six$/,'pending'));assert.ok(initial,'paired initial pending frame');assert.ok(Date.parse(e.time)-Date.parse(initial.time)>=6000,'real elapsed pending exceeds six seconds');assert.equal(initial.before.dialog.busy,'true');assert.equal(e.before.dialog.busy,'true');assert.deepEqual(textValues(e.before.dialog),textValues(initial.before.dialog),'pending retains every field');
  }
  if(/^reference-(?:pin|native)-resume$/.test(e.key)){
    const yielded=entries.get(e.key.replace(/resume$/,'yield'));assert.ok(yielded,'paired priority yield frame');assert.deepEqual(textValues(e.before.dialog),textValues(yielded.before.dialog),'every draft value retained through priority yield');assert.equal(JSON.parse(e.reference).draftVersion,JSON.parse(yielded.reference).draftVersion,'draft identity retained through priority yield');
  }
});
function ndjson(file){return fs.existsSync(file)?fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)):null;}
const mutationPath=path.join(evidence,'mutations.ndjson'),readPath=path.join(evidence,'task-readback.ndjson');
const mutations=ndjson(mutationPath),reads=ndjson(readPath);
check('real API evidence',()=>{
  if(partial&&(!mutations||!reads))return;
  assert.ok(mutations&&reads,'saved safe mutations.ndjson and task-readback.ndjson required');
  const writes=mutations.filter(x=>x.method==='POST'&&x.path==='/api/tasks'&&x.status===201);
  assert.ok(writes.length,'real create201 observed');assert.equal(new Set(writes.map(x=>x.id)).size,writes.length,'unique created task ids');
  const titles=new Set();
  const server=fs.readFileSync(path.join(root,'server.js'),'utf8'),start=server.indexOf("if (pathname === '/api/tasks' && req.method === 'POST') {"),end=server.indexOf('  const taskPath = pathname.match(',start),handler=server.slice(start,end);
  // This whole handler SHA was independently identical in UI-04.1 intake server.js.before.
  assert.equal(crypto.createHash('sha256').update(handler).digest('hex'),'3a641297192f0ee617967d6bc03e74f661e03817f36c4d3be32d96024bf2d787','unchanged baseline task POST contract, including server string trim');
  assert.ok(handler.includes("const title = String(input.title || '').trim(); const description = String(input.description || '').trim();"),'existing server title/description normalization');
  for(const write of writes){assert.ok(write.id,'saved task id');assert.ok(write.title?.startsWith('UI041'),'isolated synthetic task title');assert.ok(!titles.has(write.title),'one201 for each distinct scenario title');titles.add(write.title);for(const name of ['title','description','assigneeId','priority','dueDate'])assert.equal(typeof write[name],'string','unchanged string API field '+name);const read=reads.filter(x=>x.status===200&&x.time>=write.time).flatMap(x=>x.items||[]).find(x=>x.id===write.id);assert.ok(read,'actual subsequent API read for '+write.id);for(const name of ['title','description','assigneeId','priority','dueDate'])assert.equal(read[name],['title','description'].includes(name)?write[name].trim():write[name],'API persistence under existing server normalization '+name);
    const pending=[...entries.values()].find(e=>e.meta.state==='pending'&&textValues(e.before.dialog).title===write.title);if(pending){assert.ok(Date.parse(write.time)<=Date.parse(pending.time),'real write observed before pending response frame');const success=[...entries.values()].find(e=>e.key===pending.key.replace(/pending$/,'success'));assert.ok(success,'paired eventual success');assert.equal(mutations.filter(x=>x.status===201&&x.title===write.title&&Date.parse(x.time)<=Date.parse(success.time)).length,1,'single201 in accepted scenario response interval');}
  }
  assert.ok(mutations.some(x=>x.status===503&&x.fixture==='rejected before write'),'isolated save error never forwarded as write');
});
if(!partial){
  check('desktop matrix',()=>{for(const width of [1366,1920])for(const theme of ['dark','light'])for(const state of ['open','invalid','pending','write-error','success','api-readback']){const cell=`owner/${width}/${theme}/${state}`,e=[...entries.values()].find(frame=>frame.meta.state===state&&frame.meta.role==='owner'&&frame.meta.theme===theme&&frame.before.viewport.width===width&&frame.before.viewport.height===(width===1366?768:1080));assert.ok(e,'required desktop cell '+cell);assert.equal(e.before.theme,theme,'actual theme '+cell);assert.equal(e.meta.verifiedSession.role,'owner','actual owner '+cell);}});
  check('reference and bounded supplemental coverage',()=>{const all=[...entries.values()];assert.ok(all.some(e=>e.before.viewport.width<500),'ordinary narrow regression represented');assert.ok(all.some(e=>e.meta.actualViewport===true||/actual/.test(e.key)),'actual viewport represented');assert.ok(all.some(e=>e.meta.verifiedSession?.role==='manager'),'manager role represented');assert.ok(all.some(e=>e.meta.verifiedSession?.role==='hookah_master'||e.meta.verifiedSession?.role==='bartender'),'employee role represented');assert.ok(referenceCount,'local reference captures');assert.ok(all.some(e=>e.meta.expectedFallback),'removed opener fallback represented');});
}
check('source/dist shared product parity',()=>{for(const file of ['ui-dialog.js','portal.js','app.js','style.css'])assert.equal(hash(file),hash('dist/'+file),'source/dist '+file);});
console.log(JSON.stringify({phase:'UI-04.1',mode:partial?'partial-current-records':'acceptance',frames:entries.size,sourceReferences:refs,openFrames:openCount,pendingFrames:pendingCount,localReferenceFrames:referenceCount,apiWrites201:mutations?.filter(x=>x.status===201).length??null,result:failures.length?'FAIL':'PASS',failures},null,2));
if(failures.length)process.exitCode=1;
