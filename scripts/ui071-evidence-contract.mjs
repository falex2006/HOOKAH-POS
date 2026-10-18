import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root=process.cwd(), folder=path.join(root,'docs/design/UNIFIED_UI_2026-10-09/evidence/UI-07.1');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const frozen=JSON.parse(await fs.readFile(path.join(root,'tmp/ui071/final-source-hashes.json')));
const scopes=['payment','refund','movement','purchase-editor','guest-fields','guest-confirm'];
const expected=scopes.flatMap(s=>[1280,1366,1920].flatMap(w=>['dark','light'].map(t=>`v8-owner-${s}-${w}-${t}`)));
expected.push('v8-owner-payment-390-dark','v8-owner-refund-390-dark','v8-owner-payment-actual-light','v8-owner-refund-1366-dark-bottom');
const pairs=[];let controls=0,checkboxExceptions=0;
for(const key of expected){
 const x=JSON.parse(await fs.readFile(path.join(folder,key+'.json'))), jpg=await fs.readFile(path.join(folder,key+'.jpg'));
 assert.equal(x.key,key);assert.deepEqual(x.before,x.after,'stable frame');assert.deepEqual(x.sources,frozen,'exact final sources');assert.equal(hash(jpg),x.imageSHA,'paired raster');
 assert.equal(x.session.status,200);assert.equal(x.session.role,'owner');assert.equal(x.session.venueId,'bea9e9cc-10ce-42a1-a05a-add3b69fb232');
 const {viewport,modal}=x.before;assert(modal?.card&&modal.body&&modal.footer,'real mounted shell');
 assert(modal.card.x>=-1&&modal.card.y>=-1);assert(modal.card.x+modal.card.width<=viewport.width+1);assert(modal.footer.y+modal.footer.height<=viewport.height+1);assert(modal.body.height>0);
 assert(modal.body.y+modal.body.height<=modal.footer.y+1,'bounded scrolling body');assert.equal(x.before.scroll.left,0);assert(x.before.scroll.width<=viewport.width+1,'no page horizontal overflow');
 if(!key.includes('actual')){const match=key.match(/-(\d+)-(dark|light)(?:-bottom)?$/);assert.equal(viewport.width,Number(match[1]));assert.equal(x.before.theme,match[2]);assert.equal(viewport.height,viewport.width===390?844:viewport.width===1280?720:viewport.width===1366?768:1080);}
 for(const c of x.before.controls){if(c.tag==='INPUT'&&c.label==='noItemReturn'&&c.value==='on'){checkboxExceptions++;continue;}assert(c.box.height>=43.9,`${key}: ${c.label} height`);controls++;}
 pairs.push({key,viewport,theme:x.before.theme,imageSHA:x.imageSHA,modal:modal.id||modal.title});
}
const assets=[];
for(const file of Object.keys(frozen)){assert.equal(hash(await fs.readFile(path.join(root,file))),frozen[file]);assert.equal(hash(await fs.readFile(path.join(root,'dist',file))),frozen[file]);const r=await fetch(`http://localhost:31967/${file}`);assert.equal(r.status,200);const bytes=Buffer.from(await r.arrayBuffer());assert.equal(hash(bytes),frozen[file]);assets.push({file,status:r.status,sha256:hash(bytes),cacheControl:r.headers.get('cache-control')});}
const result={at:new Date().toISOString(),status:'PASS',pairs:pairs.length,sourceBindings:pairs.length*4,controls44:controls,checkboxExceptions,scope:'paired final pixels and geometry; lifecycle/API/DB are separate evidence',sources:frozen,assets,frames:pairs};
await fs.writeFile(path.join(root,'tmp/ui071/evidence-contract-report.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({status:result.status,pairs:result.pairs,sourceBindings:result.sourceBindings,controls44:controls,checkboxExceptions,assets:assets.length}));
