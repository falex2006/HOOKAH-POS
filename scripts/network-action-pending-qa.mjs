import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../portal.js',import.meta.url),'utf8');
const start=source.indexOf('  let actionPending = false;');
const end=source.indexOf('  let creating = false;',start);
assert.ok(start>0&&end>start);
for(const type of ['network-select','network-archive']) {
 let listener,requests=0,resolve,reject;const notices=[];
 const button={dataset:{venue:'qa'},disabled:false,isConnected:true,textContent:'Original',classList:{contains:name=>name===type}};
 const event={target:{closest:selector=>selector==='[data-venue]'?button:null}};
 new Function('document','api','portalNotice','portalConfirm','portalAction','load','window','refreshPortalContext','bindManagementNotice',`${source.slice(start,end)}`)(
 {querySelector:()=>({addEventListener:(_name,fn)=>listener=fn})},()=>{requests++;return new Promise((a,b)=>{resolve=a;reject=b;});},(...args)=>notices.push(args),async()=>true,async()=>({name:'QA',address:'QA'}),async()=>{}, {__networkItems:[{id:'qa',name:'QA',address:'QA'}]},async()=>({failed:[]}),()=> (...args)=>notices.push(args));
 const first=listener(event);await Promise.resolve();await Promise.resolve();
 assert.equal(button.disabled,true);await listener(event);assert.equal(requests,1);
 reject(Error('offline'));await first;assert.equal(button.disabled,false);assert.equal(button.textContent,'Original');
 assert.equal(notices.at(-1)[1],'error');
 const retry=listener(event);await Promise.resolve();await Promise.resolve();resolve({});await retry;
 assert.equal(requests,2);assert.equal(button.disabled,false);assert.equal(notices.at(-1)[1],'success');
}
for (const type of ['network-archive', 'network-edit']) {
 let listener, finishDialog, requests=0, dialogs=0, focused=0;
 const button={dataset:{venue:'qa'},disabled:false,isConnected:true,textContent:'Original',getClientRects:()=>[{}],focus(){assert.equal(this.disabled,false);focused++;},classList:{contains:name=>name===type}};
 const event={target:{closest:selector=>selector==='[data-venue]'?button:null}};
 const dialog=()=>{dialogs++;return new Promise(resolve=>{finishDialog=resolve;});};
 const ordinaryDialog=async()=>{await dialog();return {reason:'cancel'};};
 new Function('document','api','portalNotice','portalConfirm','portalAction','load','window','editOrdinary','bindManagementNotice',source.slice(start,end))(
  {querySelector:()=>({addEventListener:(_name,fn)=>listener=fn})},async()=>{requests++;},()=>{},dialog,dialog,async()=>{}, {__networkItems:[{id:'qa',name:'QA',address:'QA'}]},ordinaryDialog,()=>()=>{});
 const first=listener(event);
 assert.equal(dialogs,1);assert.equal(button.disabled,true);
 await listener(event);assert.equal(dialogs,1);assert.equal(requests,0);
 const other={dataset:{venue:'other'},disabled:false,classList:{contains:name=>name==='network-select'}};
 await listener({target:{closest:selector=>selector==='[data-venue]'?other:null}});
 assert.equal(requests,0,'other venue action is suppressed while dialog is pending');
 finishDialog(null);await first;
 assert.equal(button.disabled,false);assert.equal(button.textContent,'Original');assert.equal(requests,0);assert.equal(focused,1);
 const second=listener(event);assert.equal(dialogs,2);
 button.isConnected=false;finishDialog(null);await second;assert.equal(focused,1,'detached opener is not focused');
 button.isConnected=true;button.disabled=false;
 const third=listener(event);assert.equal(dialogs,3);finishDialog(null);await third;
 assert.equal(button.disabled,false);assert.equal(requests,0);
}
// Shared edit holds the caller open across API failure/retry; invoke its actual onSubmit callback.
{
 let listener,editor,finishEditor,requests=0,resolveRequest,rejectRequest,loads=0,restored=0;
 const notices=[],errors=[],payloads=[];
 const button={dataset:{venue:'qa'},disabled:false,isConnected:true,textContent:'Original',getClientRects:()=>[{}],focus(){},classList:{contains:name=>name==='network-edit'}};
 const event={target:{closest:selector=>selector==='[data-venue]'?button:null}};
 const editOrdinary=options=>{editor=options;return new Promise(resolve=>finishEditor=resolve);};
 const api=(path,options)=>{requests++;payloads.push({path,method:options.method,body:JSON.parse(options.body)});return new Promise((resolve,reject)=>{resolveRequest=resolve;rejectRequest=reject;});};
 new Function('document','api','portalNotice','portalConfirm','portalAction','load','window','editOrdinary','hasPortalPermission','bindManagementNotice',source.slice(start,end))(
  {querySelector:()=>({addEventListener:(_name,fn)=>listener=fn})},api,(...args)=>notices.push(args),async()=>true,()=>{throw Error('legacy edit must not run');},async()=>{loads++;},{__networkItems:[{id:'qa',name:'QA',address:'QA'}]},editOrdinary,()=>true,()=> (...args)=>notices.push(args));
 const first=listener(event);
 assert.equal(button.disabled,true);assert.equal(editor.key,'venue:qa');assert.equal(editor.opener,button);assert.equal(editor.isCurrent(),true);
 assert.equal(editor.validate({name:' ',address:'a'}).field,'name');assert.equal(editor.validate({name:'n',address:' '}).field,'address');
 await listener(event);assert.equal(requests,0,'opening the editor does not write');
 const submit=async values=>{try{await editor.onSubmit(values);finishEditor({reason:'success',restoreFocus(){assert.equal(loads,1,'post-save focus runs after readback');restored++;}});}catch(error){errors.push(editor.errorMessage(error));}};
 const failed=submit({name:' Changed ',address:' Address '});
 assert.equal(requests,1);assert.deepEqual(payloads[0],{path:'/api/network/venues/qa',method:'PATCH',body:{name:'Changed',address:'Address'}});
 await listener(event);assert.equal(requests,1,'duplicate venue action suppressed during API pending');
 rejectRequest(Error('offline'));await failed;
 assert.equal(button.disabled,true,'error keeps shared edit and outer pending gate open');assert.equal(loads,0);assert.match(errors[0],/Введённые данные сохранены/);
 const retry=submit({name:' Changed ',address:' Address '});assert.equal(requests,2);resolveRequest({});await retry;await first;
 assert.equal(button.disabled,false);assert.equal(button.textContent,'Original');assert.equal(loads,1);assert.equal(restored,1);assert.equal(notices.at(-1)[1],'success');
}
console.log('NETWORK ACTION PENDING QA: PASS (duplicate suppression, cancellation/focus, shared callback PATCH failure retention/retry, exact payload and successful readback)');
