import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
const helper=fs.readFileSync(new URL('../pos-dispatch.js',import.meta.url),'utf8');
const start=source.indexOf('const preparationPending=new Set();');
const end=source.indexOf('\nlet posRefreshPending=',start);
assert.ok(start>0&&end>start);
const plain=value=>JSON.parse(JSON.stringify(value));
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const nodes=new Map(),handlers={},notices=[],reads=[],writes=[];
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{hidden:false,disabled:false,classList:{toggle(){}},dataset:{},innerHTML:'',textContent:'',setAttribute(){},removeAttribute(){},replaceChildren(){this.innerHTML='';},querySelector:()=>({textContent:''}),addEventListener(type,fn){handlers[id+type]=fn;}});
    return nodes.get(id);
  };
  const storage=new Map([['crm_session_token','qa-actor-a']]);
  let dialog=null,chosen={station_0:'bar'},readOutcome='ready';
  const context={
    tables:{dataset:{dataState:'ready'}},navigator:{onLine:true},floorTableFor:()=>null,document:{querySelector:node,addEventListener(){},visibilityState:'visible'},window:{setInterval(){},addEventListener(){}},
    localStorage:{getItem:key=>storage.get(key)||null},staffAccessRevision:0,staffSessionVerified:true,
    staffSessionPermissions:new Set(['orders','bar_tasks','hookah_tasks']),floorVenueId:'v',ordersReadState:'ready',currentShift:{id:'shift'},
    paymentPostsPending:new Set(),posWorkspaceMounted:false,posOrderDispatchPending:new Set(),posPreparationReadState:'loading',posPreparationFilter:'all',
    currentOrder:{id:'o',status:'open',items:[
      {id:'a',name:'Bar',quantity:1,preparationStation:'bar',preparationStatus:'new'},
      {id:'u',name:'Unknown',quantity:1,preparationStation:null,preparationStatus:'queued'},
      {id:'h',name:'Hookah',quantity:1,preparationStation:'hookah',preparationStatus:'new'},
      {id:'old',name:'Sent',quantity:1,preparationStation:'bar',preparationStatus:'queued'},
    ]},
    staticStaffDemo:()=>false,staffCanWork:()=>context.staffSessionVerified,notice:message=>notices.push(message),
    refreshOrderPricingSummary:async()=>{},staffIcon:()=>'',pluralRu:(_value,_one,few)=>few,refreshPosWorkspace(){},
    requestStaffAction:async value=>{dialog=value;return chosen;},
    orderHeaders:()=>({Authorization:'Bearer '+storage.get('crm_session_token')}),
    apiJson:async(url,options)=>{
      const body=JSON.parse(options.body);writes.push({url,body,headers:options.headers});
      return {status:'in_progress',items:context.currentOrder.items.map(item=>body.itemIds.includes(item.id)?{...item,preparationStation:body.station,preparationStatus:'queued'}:{...item})};
    },
    staffFetchJson:()=>new Promise((resolve,reject)=>reads.push({resolve,reject})),
    drawOrder:order=>{context.currentOrder=order;},drawQueue(){},
    loadOrders:async()=>{context.ordersReadState=readOutcome;},escapeFloorText:String,floorTableLabel:String,
  };
  context.openOrders=[context.currentOrder];
  vm.createContext(context);vm.runInContext(helper,context);
  vm.runInContext(source.slice(start,end)+'\nthis.load=loadPreparationQueue;this.clear=clearPreparationQueue;this.dispatch=dispatchOrderPreparation;this.rows=()=>preparationItems;this.updateAction=updateOrderMainAction;',context);
  return {context,nodes,reads,writes,notices,storage,get dialog(){return dialog;},choose:input=>{chosen=input;},setReadOutcome:status=>{readOutcome=status;}};
}

const first=fixture(),c=first.context;
const loading=c.load();assert.equal(loading,c.load(),'queue reads are singleflight');assert.equal(first.reads.length,1);
c.staffAccessRevision++;first.reads[0].resolve({items:[{id:'stale'}]});await loading;
assert.equal(c.rows().length,0,'old access response ignored');
c.clear();assert.equal(c.posPreparationFilter,'all','access invalidation clears a station filter');
const sent=c.dispatch();await settle();
assert.equal(first.writes.length,2,'one user send routes known bar and hookah groups');
assert.deepEqual(plain(first.writes.map(write=>write.body)),[
  {station:'bar',itemIds:['a','u'],expectedVenueId:'v'},
  {station:'hookah',itemIds:['h'],expectedVenueId:'v'},
],'already-dispatched position excluded and unknown position uses its explicit direction');
assert.equal(first.dialog.fields.length,1,'only unknown direction requires a choice');
assert.equal(first.dialog.fields[0].required,true);
assert.equal(first.dialog.fields[0].value,'','unknown direction has no implied default');
first.reads.at(-1).resolve({items:[]});await sent;
assert.equal(c.posOrderDispatchPending.size,0,'per-order lock released after confirmed refresh');
assert.match(first.notices.at(-1),/Передано на бар · 2 поз\..*Передано кальянщику · 1 поз\./);

const changed=fixture();changed.context.requestStaffAction=async()=>{changed.context.staffAccessRevision++;return {station_0:'bar'};};
await changed.context.dispatch();assert.equal(changed.writes.length,0,'rights change during direction dialog prevents dispatch');
const token=fixture();token.context.requestStaffAction=async()=>{token.storage.set('crm_session_token','qa-actor-b');return {station_0:'bar'};};
await token.context.dispatch();assert.equal(token.writes.length,0,'token change during direction dialog prevents dispatch');

const partial=fixture();let calls=0;
partial.context.apiJson=async(url,options)=>{
  partial.writes.push({url,body:JSON.parse(options.body),headers:options.headers});
  if(++calls===2)throw Error('station_unavailable');
  return {status:'in_progress',items:partial.context.currentOrder.items.map(item=>['a','u'].includes(item.id)?{...item,preparationStation:'bar',preparationStatus:'queued'}:{...item})};
};
partial.setReadOutcome('error');const incomplete=partial.context.dispatch();await settle();partial.reads.at(-1).resolve({items:[]});await incomplete;
assert.match(partial.notices.at(-1),/Подтверждено Бар: 2.*Не удалось сверить/,'failed authoritative reread cannot claim order updated');
assert.doesNotMatch(partial.notices.at(-1),/Заказ обновлён/);
assert.equal(partial.nodes.get('#order-main-action').disabled,true,'retry stays unavailable until authoritative orders are read');

const lost=fixture();lost.context.currentOrder.items=lost.context.currentOrder.items.filter(item=>item.preparationStation);
const original=plain(lost.context.currentOrder);
lost.context.apiJson=async(url,options)=>{lost.writes.push({url,headers:options.headers});lost.storage.set('crm_session_token','qa-actor-b');return {status:'in_progress',items:[]};};
await lost.context.dispatch();assert.equal(lost.writes.length,1,'identity loss stops the next station request');
assert.equal(lost.writes[0].headers.Authorization,'Bearer qa-actor-a','first write preserves originating identity');
assert.deepEqual(plain(lost.context.currentOrder),original,'late result does not alter the new identity view');

console.log('ORDER PREPARATION UI QA: PASS (singleflight, stale access, explicit unknown direction, mixed station routing, pending, token guard and failed reread retry gate)');
