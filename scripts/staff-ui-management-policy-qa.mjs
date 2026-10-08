import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../portal.js',import.meta.url),'utf8');
const policy=source.match(/const canManageStaff = hasPortalPermission\('staff_manage'\); const canCreateStaff =[^\n]+/);
assert.ok(policy,'Actual staff UI policy is present');
let checks=0;
for(const role of ['owner','admin','manager','developer','bartender','hookah_master']){
  for(const allowed of [true,false]){
    const ctx={portalUser:{role},hasPortalPermission:()=>allowed};
    vm.createContext(ctx);vm.runInContext(policy[0]+';globalThis.result={create:canCreateStaff,edit:canManageStaffPerson};',ctx);
    assert.equal(ctx.result.create,allowed&&['owner','admin'].includes(role));checks++;
    for(const target of ['owner','admin','developer','manager','bartender','hookah_master']){
      const expected=allowed&&(role==='owner'||(['admin','manager'].includes(role)&&!['owner','admin','developer'].includes(target)));
      assert.equal(ctx.result.edit({role:target}),expected,`${role}/${allowed} -> ${target}`);checks++;
    }
  }
}
assert.ok(source.includes('if (canCreateStaff) {'),'Add button uses creation policy');
assert.ok(source.includes('staffForm && !canCreateStaff'),'Form uses creation policy');
console.log(`STAFF UI MANAGEMENT POLICY: PASS (${checks} role/target cases; create button and form guarded)`);
