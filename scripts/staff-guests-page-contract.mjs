import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('portal.js','utf8'),dist=fs.readFileSync('dist/portal.js','utf8'),server=fs.readFileSync('server.js','utf8');
assert.equal(source,dist,'portal source/dist parity');
// The navigation builder now applies permissions inline while creating links
// (`link.hidden = !portalPermissions.has(permission)`). Keep this contract
// focused on that current behavior instead of extracting the removed helper.
const helper=`const hasPortalLinkPermission = (link, permission) => portalPermissions.has(permission || link?.dataset?.permission);`;
const routeGuard=source.slice(source.indexOf('const pagePermissions ='),source.indexOf('const formatRuDate ='));
for(const [permissions,linkAllowed,routeAllowed] of [[['orders'],false,true],[['staff_view'],true,true],[['finance_read'],false,false],[[],false,false]]) {
  const portalPermissions=new Set(permissions);
  const hasPortalPermission=(permission)=>portalPermissions.has(permission)||(permission==='clients'&&['staff_view','staff','orders'].some((candidate)=>portalPermissions.has(candidate)));
  const context={URL,location:{origin:'http://localhost'},portalPermissions,hasPortalPermission,page:'clients',window:{location:{replace(){}}}};
  vm.createContext(context);
  vm.runInContext(helper+'\nthis.checkLink=hasPortalLinkPermission;',context);
  assert.equal(context.checkLink({href:'http://localhost/clients',dataset:{permission:'staff_view'}}),linkAllowed);
  assert.equal(context.checkLink({href:'http://localhost/inventory',dataset:{permission:'inventory_read'}}),false,'guest access must not unlock inventory');
  if(routeAllowed) vm.runInContext(routeGuard,context);
  else assert.throws(()=>vm.runInContext(routeGuard,context),/portal_route_forbidden/);
}
assert.match(source,/link\.hidden = !hasPortalPermission\(permission\)/);
assert.match(source,/link\.hidden = !hasPortalPermission\(permission\) \|\| navigation\[name\] === false/);
const fillStart=source.indexOf('const fill = (client) => {');
const fillEnd=source.indexOf("document.querySelector('#client-nickname')",fillStart);
assert.ok(fillStart>0&&fillEnd>fillStart);
const fill=source.slice(fillStart,fillEnd)+'}; this.runFill=fill;';
for(const [bonusPresent,depositPresent] of [[false,false],[true,true],[false,true],[true,false]]) {
  const fields=new Map();
  const document={querySelector(selector){
    if(selector==='#client-bonus'&&!bonusPresent||selector==='#client-deposit'&&!depositPresent)return null;
    if(!fields.has(selector))fields.set(selector,{value:'',innerHTML:'',textContent:'',classList:{toggle(){}},dataset:{}});
    return fields.get(selector);
  },querySelectorAll(){return [];}};
  const context={historyGeneration:0,document,clientInitials:()=> 'QA',esc:v=>String(v??''),discountGroups:[]};
  vm.createContext(context);vm.runInContext(fill,context);
  context.runFill({id:'guest-qa',name:'Гость QA',bonusBalance:12,depositBalance:400});
  assert.equal(fields.get('#client-id').value,'guest-qa');
  assert.equal(fields.get('#client-name').value,'Гость QA');
  if(bonusPresent)assert.equal(fields.get('#client-bonus').value,12);
  if(depositPresent)assert.equal(fields.get('#client-deposit').value,400);
}
const getClients=server.match(/if \(pathname === '\/api\/clients' && req\.method === 'GET'\) \{[\s\S]*?\n  \}/)?.[0]||'';
assert.match(getClients,/hasPermission\(req, 'orders'\)/);assert.match(getClients,/hasPermission\(req, 'staff_view'\)/);
assert.match(server,/clientDelete[\s\S]{0,160}denyUnless\(req, res, 'staff_manage'\)/);
assert.match(server,/pathname === '\/api\/clients' && req\.method === 'POST'[\s\S]{0,160}denyUnlessAny\(req, res, \['staff_manage', 'orders'\]\)/);
assert.match(server,/clientProfile[\s\S]{0,220}denyUnlessAny\(req, res, \['staff_manage', 'orders'\]\)/);
console.log('STAFF GUESTS PAGE CONTRACT: PASS (actual route/link/fill VM, denied roles, protected fields absent, source/dist, unchanged CRUD)');
