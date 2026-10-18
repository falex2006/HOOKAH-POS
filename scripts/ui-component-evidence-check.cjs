// Checks saved observations only; this does not drive or emulate a browser.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'docs/design/UNIFIED_UI_2026-10-09/evidence/UI-02.2/final');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const frames = [];
let minText=Infinity, minBoundary=Infinity, minFocus=Infinity, minHeight=Infinity;
for (const file of fs.readdirSync(folder).filter(f=>f.endsWith('.json'))) {
  const meta = JSON.parse(fs.readFileSync(path.join(folder,file),'utf8'));
  if (!meta.before) continue;
  assert.equal(meta.stable,true,file);
  assert.deepEqual(meta.before,meta.after,file);
  for (const [p,h] of Object.entries(meta.sourceHashes)) assert.equal(sha(path.join(root,p)),h,p);
  const b=meta.before;
  assert.equal(b.paintAssumptions.length,0,'Contrast assumes opacity1 and solid/transparent backgrounds');
  assert.ok(b.page.width<=b.viewport.width+1,'Page overflow');
  assert.ok(b.status.startsWith('Запусков:'),'UTF8 status');
  for (const t of b.targets) {
    assert.ok(t.rect.width>=43.99&&t.rect.height>=43.99,`${file}:${t.id} hitarea`);
    minHeight=Math.min(minHeight,t.rect.height);
    if (!t.disabled) { assert.ok(t.textContrast>=4.5,`${file}:${t.id} text`);minText=Math.min(minText,t.textContrast); }
    if (!t.classes.includes('ui-button--quiet')) { assert.ok(t.boundaryContrast>=3,`${file}:${t.id} boundary`);minBoundary=Math.min(minBoundary,t.boundaryContrast); }
    if (t.focusVisible) { assert.ok(Number(t.outline.match(/([\d.]+)px/)?.[1])>0,`${t.id} outline`);assert.ok(t.focusContrast>=3);minFocus=Math.min(minFocus,t.focusContrast); }
    if (t.placeholderContrast!==null) assert.ok(t.placeholderContrast>=4.5);
    if (t.indicatorGlyphContrast!==null) assert.ok(t.indicatorGlyphContrast>=3);
    if (b.manualReducedMotion) assert.ok(t.transition.split(',').every(s=>parseFloat(s)===0));
  }
  for (const t of b.text) assert.ok(t.contrast>=4.5,`${file}:${t.text}`);
  assert.ok(b.targets.find(t=>t.id==='mixed-box').indeterminate,'Actual indeterminate state');
  const one=b.text.find(t=>t.id==='digits-one'),eight=b.text.find(t=>t.id==='digits-eight');
  assert.equal(one.rect.width,eight.rect.width,'Tabular digit widths');
  const number=b.text.find(t=>t.id==='long-number');assert.ok(number.scrollWidth<=number.clientWidth+1,'Long number clipping');
  for (const p of b.pseudos) {assert.equal(p.content,'none');assert.equal(p.animation,'none');}
  if (b.manualReducedMotion) for(const s of b.spinner)assert.equal(s.animation,'none');
  const image=path.join(folder,meta.key+'.jpg');assert.ok(fs.existsSync(image));
  frames.push({key:meta.key,image:path.basename(image),imageSha256:sha(image),metadataSha256:sha(path.join(folder,file)),viewport:b.viewport,scroll:b.scroll});
}
for (const size of ['1366','1920','actual','390']) for (const theme of ['dark','light']) for(const view of ['top','middle','bottom']) {
  const frame=frames.find(f=>f.key===`${size}-${theme}-${view}`);assert.ok(frame,'Matrix coverage');if(view!=='top')assert.ok(frame.scroll.y>0,'Actual lower viewport');
}
for(const theme of ['dark','light'])for(const state of ['button','input','checkbox','select']) {
  const data=JSON.parse(fs.readFileSync(path.join(folder,`1366-${theme}-focus-${state}.json`),'utf8')).before;
  assert.equal(data.focus.visible,true,'Keyboard focus');
}
const seq=JSON.parse(fs.readFileSync(path.join(folder,'busy-sequence.json'),'utf8'));
for(const step of seq){
  const counter=b=>Number(b.status.match(/\d+/)[0]);assert.equal(counter(step.during),counter(step.before)+1,'Double click starts once');
  const a=step.before.targets.find(t=>t.id==='busy-button'),b=step.during.targets.find(t=>t.id==='busy-button');
  assert.equal(a.rect.width,b.rect.width);assert.equal(a.rect.height,b.rect.height);assert.equal(b.disabled,true);assert.equal(b.busy,'true');
}
const terminal=JSON.parse(fs.readFileSync(path.join(folder,'busy-terminal.json'),'utf8')).terminal;
assert.equal(terminal.targets.find(t=>t.id==='busy-button').disabled,false);assert.ok(terminal.status.includes('Проверка завершена'));
const summary={status:'PASS_SAVED_OBSERVATIONS',frames:frames.length,minActiveTextContrast:minText,minMeaningfulBoundaryContrast:minBoundary,minKeyboardFocusContrast:minFocus,minHitHeight:minHeight,limits:['OS preference was false; manual reduction executed, native OS branch source/CSSOM only','Quiet text button has no meaningful boundary','Native select long collapsed option can truncate; value remains intact','No production role migration or full system regression'],manifest:frames};
fs.writeFileSync(path.join(folder,'checks.json'),JSON.stringify(summary,null,2),'utf8');
console.log(JSON.stringify({...summary,manifest:undefined},null,2));
