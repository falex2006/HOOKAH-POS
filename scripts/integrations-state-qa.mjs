import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../portal.js',import.meta.url),'utf8');
const start=source.indexOf('  const panel = target.querySelector',source.indexOf('function renderIntegrations()'));
const end=source.indexOf('\n}',start);
assert.ok(start>0 && end>start);
function fixture() {
  const nodes=new Map(['status','note','help'].map(key=>[`#telegram-integration-${key}`,{textContent:'',className:''}]));
  const panel={isConnected:true,attrs:{},setAttribute(key,value){this.attrs[key]=value;},append(retry){this.retry=retry;}};
  nodes.set('.integrations-panel',panel);
  const document={createElement:()=>({hidden:false,addEventListener(_event,listener){this.click=listener;}})};
  const pending=[];
  const api=()=>new Promise((resolve,reject)=>pending.push({resolve,reject}));
  // Run the actual load callback; suppress only its automatic initial invocation.
  const code=source.slice(start,end).replace(/; load\(\);\s*$/,'; return {load};');
  const state=new Function('target','document','api',code)({querySelector:id=>nodes.get(id)},document,api);
  return {nodes,panel,pending,...state};
}
for(const scenario of ['enabled','disabled','error']) {
  const f=fixture(),load=f.load();assert.equal(f.panel.attrs['aria-busy'],'true');
  if(scenario==='error') f.pending[0].reject(Error('offline')); else f.pending[0].resolve({telegram:{enabled:scenario==='enabled'}});
  await load;
  assert.equal(f.nodes.get('#telegram-integration-status').textContent,{enabled:'Подключено',disabled:'В разработке',error:'Статус недоступен'}[scenario]);
  assert.ok(f.nodes.get('#telegram-integration-note').textContent.length>0);
  assert.equal(f.panel.attrs['aria-busy'],'false');
  if(scenario==='error') {
    assert.match(f.nodes.get('#telegram-integration-help').textContent,/не подтверждено/);assert.equal(f.panel.retry.hidden,false);
    const retry=f.panel.retry.click();assert.equal(f.panel.retry.hidden,true);f.pending[1].resolve({telegram:{enabled:true}});await retry;assert.equal(f.nodes.get('#telegram-integration-status').textContent,'Подключено');
  }
}
{
  const f=fixture(),old=f.load(),fresh=f.load();f.pending[1].resolve({telegram:{enabled:true}});await fresh;f.pending[0].reject(Error('stale failure'));await old;
  assert.equal(f.nodes.get('#telegram-integration-status').textContent,'Подключено');assert.equal(f.panel.retry.hidden,true);
}
{
  const f=fixture(),load=f.load();f.panel.isConnected=false;f.pending[0].resolve({telegram:{enabled:true}});await load;
  assert.equal(f.nodes.get('#telegram-integration-status').textContent,'Проверяем…');
}
console.log('INTEGRATIONS STATUS RUNTIME QA: PASS (enabled, unavailable feature, error/retry, pending, stale and detached responses)');
