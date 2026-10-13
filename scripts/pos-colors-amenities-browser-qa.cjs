'use strict';
// Read-only owned preview. Amenity combinations are GET-only browser fixtures.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE_PATH||'playwright');
const m=JSON.parse(fs.readFileSync('tmp/full-local-qa/pos-payments-private.json','utf8'));
assert.equal(m.root,path.resolve('.'));assert.equal(m.ownerTag,'pos-payments-polish-20261013');assert.equal(m.state,'ready');assert.match(m.base,/^http:\/\/127\.0\.0\.1:\d+$/);
const dir=path.resolve('docs/design/POS_COLORS_AMENITIES_2026-10-13/evidence');fs.mkdirSync(dir,{recursive:true});
let browser;const errors=[],writes=[],results=[];
async function run(){browser=await chromium.launch({channel:'chrome',headless:true});
 for(const width of [1366,320]){
  const p=await browser.newPage({viewport:{width,height:768}});p.setDefaultTimeout(12000);p.on('pageerror',e=>errors.push(e.message));
  await p.route('**/api/**',async r=>{if(!['GET','HEAD'].includes(r.request().method())){writes.push(r.request().method());return r.abort();}if(new URL(r.request().url()).pathname==='/api/floor'){const response=await r.fetch(),data=await response.json();let i=0;for(const z of data.zones||[])for(const t of z.tables||[]){t.layout={...t.layout,amenities:{playstation5:i%4<2,television:i%4<3}};i++;}return r.fulfill({response,json:data});}return r.continue();});
  await p.addInitScript(a=>{localStorage.setItem('crm_session_token',a.token);localStorage.setItem('crm_session_user',JSON.stringify(a.user));},m.actors.bartender);
  await p.goto(m.base);await p.locator('#tables[data-data-state="ready"]').waitFor();await p.locator('[data-pos-counter="open"][data-state="ready"]').waitFor();
  for(const theme of ['dark','light']){
   await p.evaluate(v=>{document.body.classList.toggle('light-theme',v==='light');document.documentElement.dataset.theme=v;},theme);await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(500);
   for(const density of [100,70,130]){ await p.locator('#floor-density-range').evaluate((n,v)=>{n.value=String(v);n.dispatchEvent(new Event('input',{bubbles:true}));},density);await p.waitForTimeout(100);
   const scan=await p.evaluate(()=>{
    const rgb=s=>{const c=document.createElement('canvas').getContext('2d');c.fillStyle=s;c.fillRect(0,0,1,1);const v=[...c.getImageData(0,0,1,1).data];v[3]/=255;return v;};const lum=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
    const contrast=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
    const bg=n=>{while(n){const c=rgb(getComputedStyle(n).backgroundColor);if(c.length===3||c[3]===1)return c;n=n.parentElement;}return[255,255,255];};
    return {overflow:document.documentElement.scrollWidth>innerWidth,tiles:[...document.querySelectorAll('#tables .table[data-table]')].map(n=>{const r=n.getBoundingClientRect(),a=n.querySelector('.table-amenities'),ar=a?.getBoundingClientRect();return {id:n.dataset.table,classes:n.className,accent:getComputedStyle(n).getPropertyValue('--table-accent').trim(),count:n.querySelectorAll('.table-amenity').length,right:ar?r.right-ar.right:null,bottom:ar?r.bottom-ar.bottom:null,overlap:!!ar&&[...n.children].filter(x=>x!==a).some(x=>{const b=x.getBoundingClientRect();return b.width>0&&b.height>0&&b.left<ar.right&&b.right>ar.left&&b.top<ar.bottom&&b.bottom>ar.top;}),inside:!ar||(ar.left>=r.left&&ar.right<=r.right&&ar.bottom<=r.bottom),icons:[...n.querySelectorAll('.table-amenity')].map(x=>{const s=getComputedStyle(x);return{color:s.color,bg:s.backgroundColor,border:s.borderTopWidth,label:x.getAttribute('aria-label'),contrast:contrast(rgb(s.color),bg(x)),size:x.querySelector('svg')?.getBoundingClientRect().width};}),badges:[...n.querySelectorAll('.pos-table-attention')].map(x=>({kind:x.dataset.kind,text:x.textContent,color:getComputedStyle(x).color,contrast:contrast(rgb(getComputedStyle(x).color),bg(x))}))};})};
   });
   assert.equal(scan.overflow,false);assert.ok(scan.tiles.length>=4);assert.deepEqual(scan.tiles.slice(0,4).map(t=>t.count),[2,2,1,0]);
   for(const t of scan.tiles){assert.ok(t.inside,'amenities inside card '+t.id);assert.equal(t.overlap,false,'no amenities overlap '+t.id);if(t.count){assert.ok(t.right>=0&&t.right<=20,'right aligned '+t.id);assert.ok(t.bottom>=0&&t.bottom<=24,'bottom aligned '+t.id);}for(const i of t.icons){assert.ok(i.label,'accessible icon label');assert.equal(i.border,'0px');assert.ok(i.contrast>=3,'icon contrast');assert.ok(i.size>=14);}for(const b of t.badges)assert.ok(b.contrast>=4.5,'badge text contrast '+JSON.stringify(b));}
   await p.screenshot({path:path.join(dir,`floor-${width}-${theme}-${density}.png`),fullPage:true});results.push({width,theme,density,...scan});
   await p.locator('[data-pos-view="preparation"]').click();const prep=await p.locator('.preparation-row').evaluateAll(ns=>ns.map(n=>({state:n.dataset.preparationState,color:getComputedStyle(n.querySelector('.preparation-state')).color})));results.push({width,theme,preparation:prep});await p.locator('[data-pos-view="floor"]').click();
   }
  }await p.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);fs.writeFileSync(path.join(dir,'qa.json'),JSON.stringify({generatedAt:new Date().toISOString(),environment:'Owned preview, isolated Chrome, GET-only amenity overrides, all API writes blocked',results,errors,writes},null,2));console.log('PASS: desktop/mobile both themes; amenity flags, alignment, contrast; no API writes or JS errors');
}
run().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>browser?.close());
