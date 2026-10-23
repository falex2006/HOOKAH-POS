import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../portal.js',import.meta.url),'utf8');
const served=readFileSync(new URL('../dist/portal.js',import.meta.url),'utf8');
const extract=text=>{
  const start=text.indexOf('const positionPortalSelect =');
  const end=text.indexOf('const enhancePortalSelect =',start);
  assert.ok(start>=0&&end>start,'select placement helper must exist');
  return text.slice(start,end);
};
const helper=extract(source);
assert.equal(extract(served),helper,'source and served placement helpers must match');

const listeners=new Map();
const on=(name,fn)=>listeners.set(name,fn);
const body={};
const window={innerHeight:844,visualViewport:{offsetTop:0,height:844,addEventListener:(name,fn)=>listeners.set(`visual:${name}`,fn)},addEventListener:on};
let openWrappers=[];
const document={body,addEventListener:on,querySelectorAll:()=>openWrappers};
const getComputedStyle=node=>node.computed;
const position=new Function('window','document','getComputedStyle',`${helper};return positionPortalSelect;`)(window,document,getComputedStyle);
window.visualViewport=null;
const make=(config={})=>{
  const values={};
  const menu={
    scrollHeight:config.scrollHeight??160,
    computed:{position:config.position??'absolute',maxHeight:config.cssMaxHeight??'280px',borderTopWidth:config.borderTop??'0px',borderBottomWidth:config.borderBottom??'0px',paddingTop:config.paddingTop??'0px',paddingBottom:config.paddingBottom??'0px',boxSizing:config.boxSizing??'border-box'},
    style:{removeProperty:key=>delete values[key],get top(){return values.top},set top(v){values.top=v},get bottom(){return values.bottom},set bottom(v){values.bottom=v},get maxHeight(){return values['max-height']},set maxHeight(v){values['max-height']=v}}
  };
  let open=config.open??true;
  const trigger={attributes:{},setAttribute(name,value){this.attributes[name]=value}};
  const wrapper={
    parentElement:config.parent??body,
    classList:{contains:key=>key==='is-open'&&open,remove:key=>{if(key==='is-open')open=false}},
    querySelector:selector=>selector==='.custom-select-menu'?menu:selector==='.custom-select-trigger'?trigger:null,
    getBoundingClientRect:()=>({top:config.top??690,bottom:config.bottom??735})
  };
  return {wrapper,menu,trigger,values};
};
const check=(config,expected)=>{
  const target=make(config);position(target.wrapper);
  assert.deepEqual(target.values,expected);
};

check({}, {top:'auto',bottom:'calc(100% + 6px)','max-height':'160px'});
check({top:200,bottom:245}, {top:'calc(100% + 6px)',bottom:'auto','max-height':'160px'});
check({top:95,bottom:140,scrollHeight:500}, {top:'calc(100% + 6px)',bottom:'auto','max-height':'280px'});
check({top:650,bottom:695,scrollHeight:500}, {top:'auto',bottom:'calc(100% + 6px)','max-height':'280px'});

window.innerHeight=300;
check({top:140,bottom:185,scrollHeight:500}, {top:'auto',bottom:'calc(100% + 6px)','max-height':'126px'});
window.innerHeight=844;

const clip={parentElement:body,computed:{overflowY:'auto'},clientTop:2,clientHeight:180,getBoundingClientRect:()=>({top:500})};
check({top:590,bottom:635,parent:clip,scrollHeight:160}, {top:'auto',bottom:'calc(100% + 6px)','max-height':'82px'});

window.visualViewport={offsetTop:300,height:300,addEventListener:on};
check({top:500,bottom:545,scrollHeight:160}, {top:'auto',bottom:'calc(100% + 6px)','max-height':'160px'});
window.visualViewport=null;

check({top:690,bottom:735,scrollHeight:160,boxSizing:'content-box',borderTop:'1px',borderBottom:'1px',paddingTop:'5px',paddingBottom:'5px'}, {top:'auto',bottom:'calc(100% + 6px)','max-height':'150px'});
check({open:false},{});
check({position:'relative'},{});
const closing=make();position(closing.wrapper);assert.ok(closing.values.top);
closing.wrapper.classList.contains=()=>false;position(closing.wrapper);assert.deepEqual(closing.values,{});
const resized=make();position(resized.wrapper);assert.ok(resized.values.top);
openWrappers=[resized.wrapper];window.innerHeight=420;listeners.get('resize')();
assert.equal(resized.wrapper.classList.contains('is-open'),false,'offscreen trigger must close on resize');
assert.equal(resized.trigger.attributes['aria-expanded'],'false');
assert.deepEqual(resized.values,{},'offscreen closure must clear inline geometry');
window.innerHeight=844;openWrappers=[];
assert.ok(listeners.has('resize')&&listeners.has('scroll')&&listeners.has('visual:resize')&&listeners.has('visual:scroll'),'open menus must reposition on viewport/scroll changes');
console.log('CUSTOM SELECT PLACEMENT QA: PASS (flip, fit, viewport, clipping, content-box, offscreen resize closure, closed/static cleanup, source/dist parity)');
