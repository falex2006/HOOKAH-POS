import fs from 'node:fs';
import crypto from 'node:crypto';
const root=new URL('../',import.meta.url), base=new URL('docs/design/UNIFIED_UI_2026-10-09/evidence/UI-06.1/',root);
// Only these images were independently opened with view_image by QA.
const historicalNames=`owner-products-1920-dark-ready
owner-products-1920-light-ready
owner-recipes-1920-dark-ready
owner-directories-1920-light-ready
owner-products-actual-dark-ready2
owner-products-actual-light-ready
owner-recipes-actual-dark-ready2
owner-recipes-actual-light-ready
owner-directories-actual-dark-ready2
owner-directories-actual-light-ready
owner-products-390-light-ready
owner-recipes-390-light-ready
owner-recipes-390-dark-ready
owner-directories-390-light-ready
owner-directories-390-dark-ready
owner-products-390-dark-read-error-query
owner-products-1366-dark-edit
owner-products-1366-dark-read-error-query
owner-recipes-1366-dark-save-error-retained
owner-recipes-1366-dark-save-pending
owner-recipes-1366-dark-wizard-back
owner-directories-1366-dark-department-editor
owner-products-1366-light-ready
owner-recipes-1366-light-ready
owner-directories-1366-light-ready
owner-recipes-1920-light-ready
owner-directories-1920-dark-ready
owner-recipes-1366-dark-created-reload
owner-directories-1366-dark-created-reload`.split('\n');
const finalPass=process.argv.includes('--final');
const names=finalPass?['products','recipes','directories'].flatMap(view=>['1920','1366','actual','390'].flatMap(viewport=>['dark','light'].map(theme=>view==='directories'&&viewport==='1366'&&theme==='light'?'edge-owner-directories-1366-light-retry':`edge-owner-${view}-${viewport}-${theme}-ready`))).concat(['edge-owner-recipes-390-light-scrolled-cost','edge-owner-recipes-390-dark-scrolled-cost','edge-owner-directories-1366-light-parent-error','edge-owner-recipes-1366-dark-editor-back','edge-owner-recipes-1366-dark-save-error','edge-owner-recipes-1366-dark-save-pending']).concat(['edge-manager-products-1366-dark-readonly','edge-manager-products-1366-light-readonly','edge-manager-products-1366-light-filter-empty','edge-manager-products-1366-light-loading-query','edge-manager-products-1366-light-read-error-query','edge-manager-products-1366-light-retry-query','edge-manager-products-1366-light-empty-fixture','edge-manager-recipes-1366-dark-readonly','edge-manager-recipes-1366-light-readonly','edge-manager-recipes-1366-light-loading-query','edge-manager-recipes-1366-light-read-error-query','edge-manager-recipes-1366-light-retry-query','edge-manager-recipes-1366-light-empty-fixture','edge-manager-directories-1366-dark-readonly','edge-manager-directories-1366-light-readonly','edge-bartender-inventory-1366-light-denied','edge-hookah-inventory-1366-dark-denied','edge-other-staff-inventory-1366-dark-denied','edge-owner-products-1366-dark-save-error','edge-owner-directories-1366-dark-save-error','edge-owner-directories-1366-dark-empty-department','edge-owner-recipes-1366-dark-save-reload']):historicalNames;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const hashes=Object.fromEntries(['portal.js','style.css'].map(file=>[file,sha(fs.readFileSync(new URL(file,root)))]));
const paths=fs.readdirSync(base,{recursive:true});
const records=names.map(name=>{const relative=paths.find(path=>path.replaceAll('\\','/').split('/').at(-1)===name+'.json');if(!relative)return{name,missing:true};const pair=new URL(relative.replaceAll('\\','/'),base),j=JSON.parse(fs.readFileSync(pair,'utf8'));return {name,path:relative,stable:JSON.stringify(j.before)===JSON.stringify(j.after),imageSHA:sha(fs.readFileSync(new URL(relative.replaceAll('\\','/').replace(/\.json$/,'.jpg'),base)))===j.imageSHA,currentSource:Object.entries(hashes).every(([file,hash])=>j.sources[file]===hash),heading:j.after.heading,theme:j.after.theme,viewport:j.after.viewport,view:j.after.view,session200:j.after.session?.status===200,overflow:j.after.scroll?.width>j.after.viewport.width,list:j.after.list,forms:j.after.forms};});
fs.writeFileSync(new URL(`tmp/ui061/qa-pixel-${finalPass?'final-':''}metadata-results.json`,root),JSON.stringify({generatedAt:new Date().toISOString(),hashes,records},null,2)+'\n');
console.log(JSON.stringify({reviewed:records.length,unstable:records.filter(x=>!x.stable).map(x=>x.name),badImageSHA:records.filter(x=>!x.imageSHA).map(x=>x.name),oldSources:records.filter(x=>!x.currentSource).map(x=>x.name),noSession200:records.filter(x=>!x.session200).map(x=>x.name),overflow:records.filter(x=>x.overflow).map(x=>x.name)},null,2));
