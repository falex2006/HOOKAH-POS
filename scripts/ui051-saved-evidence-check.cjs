'use strict';
// Read-only current saved evidence. Never changes or rebinds prior frames.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'docs/design/UNIFIED_UI_2026-10-09/evidence/UI-05.1'),partial=process.argv.includes('--partial');
const failures=[],records=[],hashes=new Map();let bindings=0,targets=0;
const check=(name,fn)=>{try{fn();}catch(e){failures.push(`${name}: ${e.message}`);}};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function sourceHash(file){const full=path.resolve(root,file);assert.ok(full.startsWith(root+path.sep),'source stays in workspace');if(!hashes.has(full))hashes.set(full,sha(fs.readFileSync(full)));return hashes.get(full);}
function jpegSize(b){assert.equal(b.readUInt16BE(0),0xffd8);let p=2;while(p+4<=b.length){if(b[p++]!==0xff)continue;let marker=b[p++];while(marker===0xff)marker=b[p++];if(marker===0xd9||marker===0xda)break;if(marker===0||marker===1||(marker>=0xd0&&marker<=0xd7))continue;const n=b.readUInt16BE(p);assert.ok(n>=2&&p+n<=b.length);if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return{width:b.readUInt16BE(p+5),height:b.readUInt16BE(p+3)};p+=n;}throw Error('JPEG dimensions unavailable');}
const near=(a,b,t=1)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=t;
const validBox=b=>b&&[b.x,b.y,b.width,b.height].every(Number.isFinite)&&b.width>=0&&b.height>=0;
const horizontal=(b,v)=>validBox(b)&&b.x>=-1&&b.x+b.width<=v.width+1;
const intersect=(a,b)=>Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)>1&&Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y)>1;
let files=[];check('evidence directory',()=>{files=fs.readdirSync(dir);});
for(const file of files.filter(n=>n.endsWith('.json')).sort())check(file,()=>{
 assert.ok(!/^(baseline|candidate|diagnostic)-/.test(file),'move nonfinal records explicitly into diagnostic');
 const e=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));assert.equal(file,e.key+'.json');assert.ok(!records.some(r=>r.key===e.key),'unique evidence key');assert.deepEqual(e.before,e.after,'same measurement before and after pixels');
 for(const file of ['app.js','style.css'])assert.ok(e.sources?.[file],'mandatory source binding '+file);
 for(const [file,hash]of Object.entries(e.sources)){assert.match(hash,/^[a-f0-9]{64}$/);assert.equal(sourceHash(file),hash,'current source '+file);bindings++;}
 const bytes=fs.readFileSync(path.join(dir,e.key+'.jpg'));assert.match(e.imageSHA||'',/^[a-f0-9]{64}$/);assert.equal(sha(bytes),e.imageSHA,'unchanged JPEG');const raster=jpegSize(bytes),m=e.before,v=m.viewport;
 assert.ok(v&&v.width>0&&v.height>0&&v.dpr>0,'actual viewport/DPR');
 assert.ok(!e.captureMethod||['tab-screenshot','native-single-frame'].includes(e.captureMethod),'documented unscaled screenshot method');assert.ok(!e.rasterScale&&!e.rawEvidence,'no pixel capture exceptions');assert.ok(near(raster.width,v.width)&&near(raster.height,v.height),'raster/viewport match');
 assert.ok(['dark','light'].includes(m.theme));const named=/-((?:dark|light))-/.exec(e.key)?.[1];if(named)assert.equal(m.theme,named,'actual/named theme');
 assert.ok(m.scroll&&m.scroll.width<=v.width+1,'no horizontal document overflow');assert.ok(near(m.scroll.left,0),'no horizontal page displacement');
 assert.ok(Array.isArray(m.tables)&&Array.isArray(m.controls),'table/control metrics required');assert.ok(m.floor&&m.order&&m.catalog&&m.preparation&&m.queue&&m.focus,'all affected surfaces measured');
 const ids=new Set();for(const t of m.tables){assert.ok(t.id&&!ids.has(t.id),'unique table ID');ids.add(t.id);assert.ok(t.name?.trim(),'table name');assert.ok(t.status,'table status');assert.ok(t.aria?.includes(t.name),'full table name in accessible name');assert.ok(validBox(t.box)&&t.box.width>0&&t.box.height>0,'visible table box');assert.ok(horizontal(t.box,v),'table horizontal bounds');if(t.time)assert.match(t.time,/^(?:\d{2,}:\d{2}|—:—)$/,'HH:MM without seconds');if(t.total)assert.ok(t.aria.includes(t.total),'amount included in accessible name');}
 for(let i=0;i<m.tables.length;i++)for(let j=i+1;j<m.tables.length;j++)assert.equal(intersect(m.tables[i].box,m.tables[j].box),false,'table cards do not overlap');
 if(m.tables.length===10&&/(?:1366x768|1920x1080).*floor-single-room$|default-dpr-ten$|floor-fit$/.test(e.key))assert.ok(m.tables.every(t=>t.box.y>=-1&&t.box.y+t.box.height<=v.height+1),'agreed desktop/default actual control10 fit within viewport; other short views may use EX06 scroll fallback');
 for(const control of m.controls){assert.ok(control.label?.trim(),'accessible/text label');assert.ok(validBox(control.box),'control box');assert.ok(control.box.height>=43&&control.box.width>=43,'44px UI button target '+control.label);targets++;}
 assert.ok(['unselected','empty','populated'].includes(m.order.state)||['loading','error','denied'].includes(m.floor.state),'order presentation state measured');
 if(m.order.state==='unselected'){assert.equal(m.order.primary.visible,false,'no disabled duplicate CTA before table selection');}
 if(m.order.state==='empty'&&m.floor.state==='ready'){assert.equal(m.order.primary.visible,true,'selected table exposes one existing primary');assert.equal(m.order.primary.disabled,false,'selected empty table can add item');}
 if(m.floor.state==='loading'){assert.equal(m.floor.busy,'true');assert.doesNotMatch(m.floor.text,/нет доступа|недоступно.*прав/i,'loading never says denied');}
 if(m.floor.state==='denied'){assert.match(m.floor.text,/недоступно|нет доступа/i);assert.notEqual(m.order.primary.visible,true,'denied access has no operable primary');}
 if(/single-room/.test(e.key))assert.equal(m.floor.tabsHidden,true,'single room row hidden');
 if(/floor-loading/.test(e.key))assert.equal(m.floor.state,'loading','named floor loading');
 if(/floor-error/.test(e.key))assert.equal(m.floor.state,'error','named floor error');
 if(/queue-error/.test(e.key)){assert.equal(m.queue.state,'error');assert.match(m.queue.text,/Не удалось/);}
 if(m.catalog.open){assert.ok(m.catalog.box?.width>0&&horizontal(m.catalog.box,v),'catalog horizontal bounds');assert.ok(m.catalog.box.y<v.height&&m.catalog.box.y+m.catalog.box.height>0,'open catalog intersects actual viewport');if(/catalog-loading/.test(e.key))assert.match(m.catalog.message,/Загружаем/);if(/catalog-error/.test(e.key))assert.match(m.catalog.message,/Не удалось/);}
 if(/catalog-saving$/.test(e.key)){assert.equal(m.catalog.open,true,'pending add retains catalog');const exits=m.controls.filter(c=>/вернуться к заказу/i.test(c.label));assert.equal(exits.length,2,'both catalog exit controls captured');assert.ok(exits.every(c=>c.disabled),'pending add disables both exits');assert.ok(exits.every(c=>horizontal(c.box,v)&&c.box.y>=-1&&c.box.y+c.box.height<=v.height+1),'both disabled exits visible inside viewport');}
 if(/preparation-saving$/.test(e.key))assert.ok(m.controls.some(c=>['Взять в работу','Готово'].includes(c.label)&&c.disabled),'pending work action disabled');
 if(/preparation-error$/.test(e.key))assert.match(m.preparation.message,/Не удалось/,'preparation error distinct from empty');
 if(/preparation-loading$/.test(e.key)){assert.equal(m.preparation.busy,'true');assert.match(m.preparation.message,/Загружаем/);}
 if(/queue-loading$/.test(e.key)){assert.equal(m.queue.state,'loading');assert.match(m.queue.text,/Загружаем/);}
 // Long orders/preparation intentionally scroll; no all-row vertical fit rule.
 for(const row of [...m.order.items,...m.preparation.rows])assert.ok(validBox(row.box)&&horizontal(row.box,v),'long row has bounded horizontal geometry');
 records.push(e);
});
check('paired files',()=>{assert.ok(records.length,'current final pairs required');for(const file of files.filter(n=>n.endsWith('.jpg')))assert.ok(files.includes(file.replace(/\.jpg$/,'.json')),'orphan JPEG '+file);});
check('source/dist parity',()=>{for(const file of ['app.js','style.css'])assert.equal(sourceHash(file),sourceHash('dist/'+file),'mirror '+file);});
if(!partial)check('bounded affected coverage',()=>{
 const has=(role,theme,width,height)=>records.some(e=>e.key.startsWith(role+'-')&&e.before.theme===theme&&near(e.before.viewport.width,width)&&near(e.before.viewport.height,height)&&e.before.tables.length===10);
 for(const theme of ['dark','light'])for(const [w,h]of [[1366,768],[1920,1080]])assert.ok(has('owner',theme,w,h),`owner ${theme} ${w}x${h} control10 floor`);
 for(const role of ['owner','manager','bartender','hookah_master'])for(const theme of ['dark','light'])assert.ok(records.some(e=>e.key.startsWith(role+'-')&&/-actual-/.test(e.key)&&e.before.theme===theme),`${role} actual ${theme}`);
 for(const theme of ['dark','light'])assert.ok(records.some(e=>e.before.viewport.width<500&&e.before.theme===theme),'narrow '+theme);
 for(const state of ['floor-loading','floor-error','floor-retry','catalog-loading','catalog-error','catalog-saving','catalog-keyboard-wrap','catalog-filter-empty','preparation-loading','preparation-error','preparation-saving','queue-loading','queue-error','queue-filter-empty','order-ready-readback','denied'])assert.ok(records.some(e=>e.key.includes(state)),'explicit '+state+' scenario');
});
console.log(JSON.stringify({phase:'UI-05.1',mode:partial?'current-pairs-only':'bounded-final-matrix',pairs:records.length,pixelOneToOnePairs:records.length,sourceBindings:bindings,buttonTargets:targets,result:failures.length?'FAIL':'PASS',failures},null,2));process.exitCode=failures.length?1:0;
