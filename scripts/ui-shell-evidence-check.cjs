'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'docs/design/UNIFIED_UI_2026-10-09/evidence/UI-03.1/final');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
function jpegSize(buf){
 assert.equal(buf.readUInt16BE(0),0xffd8);let p=2;
 while(p<buf.length){if(buf[p]!==0xff){p++;continue;}const marker=buf[++p];p++;if(marker===0xd9||marker===0xda)break;if(marker===0x00||marker===0xff||marker>=0xd0&&marker<=0xd7)continue;const n=buf.readUInt16BE(p);if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return{height:buf.readUInt16BE(p+3),width:buf.readUInt16BE(p+5)};p+=n;}
 throw Error('JPEG dimensions unavailable');
}
const entries=new Map();let refs=0;
for(const file of fs.readdirSync(dir).filter(x=>x.endsWith('.json'))){const e=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));assert.equal(e.stable,true,file);assert.deepEqual(e.before,e.after,file);for(const [source,sha] of Object.entries(e.sourceHashes)){assert.equal(hash(source),sha,file+' '+source);refs++;}const raster=jpegSize(fs.readFileSync(path.join(dir,file.replace(/\.json$/,'.jpg'))));assert.deepEqual(raster,{width:e.clip.width,height:e.clip.height},file+' native screenshot uses CSS clip dimensions');entries.set(e.key,e);}
let allowed=0,denied=0;const close=(a,b,label)=>assert.ok(Math.abs(a-b)<=1,label+': '+a+' vs '+b);
for(const role of ['owner','manager','hookah_master','bartender'])for(const width of [1366,1920])for(const theme of ['dark','light']){
 let canonical=null;
 for(const route of ['floor','clients','tasks','reservations','finance']){
  const key=`${role}-${width}-${theme}-${route}`,e=entries.get(key);assert.ok(e,key);const m=e.before;
  assert.equal(m.viewport.width,width);
  if(route==='reservations'&&['hookah_master','bartender'].includes(role)){assert.equal(m.denied,true,key);assert.equal(m.shell.header,null);assert.equal(m.shell.sidebar,null);denied++;continue;}
  assert.equal(m.theme,theme,key+' theme');assert.equal(m.denied,false,key);assert.equal(m.pending,false,key);assert.ok(m.shell.header&&m.shell.sidebar,key);
  const expected=['owner','manager'].includes(role)?Math.min(280,Math.max(210,width*.18)):210;
  close(m.shell.sidebar.width,expected,key+' sidebar');close(m.shell.header.height,68,key+' header');close(m.shell.header.x,m.shell.sidebar.width,key+' origin');assert.ok(m.page.width<=m.viewport.width+1,key+' page overflow');
  const stable=[m.shell.sidebar.width,m.shell.header.x,m.shell.header.height,parseFloat(m.shell.header.paddingInlineStart),parseFloat(m.shell.sidebar.paddingInlineStart),m.shell.brand.x,m.shell.brand.y];
  if(canonical)stable.forEach((v,i)=>close(v,canonical[i],key+' geometry '+i));else canonical=stable;
  for(const c of m.controls){assert.ok(c.rect.width>=43.99&&c.rect.height>=43.99,key+' hit target '+c.label);assert.ok(c.rect.x>=m.shell.header.x-1&&c.rect.x+c.rect.width<=m.shell.header.x+m.shell.header.width+1&&c.rect.y>=m.shell.header.y-1&&c.rect.y+c.rect.height<=m.shell.header.y+m.shell.header.height+1,key+' control bounds');}
  for(const t of m.contextTexts.filter(t=>!t.title&&['Гости','Бронирования','Задачи','Финансы'].includes(t.text.trim())))assert.ok(t.rect.scrollWidth<=t.rect.clientWidth+1,key+' title clipping');
  if(route==='floor'&&theme==='light')assert.ok(e.meta.posThemeFixture,key+' fixture disclosure');allowed++;
 }
}
const result={status:'PASS_SCOPED',frames:entries.size,sourceHashRefs:refs,desktop:{cells:80,allowed,denied},supplemental:entries.size-80,raster:'native JPEG = CSS clip; DPR observed separately',limitations:['<=900px inherited geometry/hit targets outside desktop scope','POS light class fixture, no runtime theme switching','No production/API mutation acceptance']};
console.log(JSON.stringify(result,null,2));
