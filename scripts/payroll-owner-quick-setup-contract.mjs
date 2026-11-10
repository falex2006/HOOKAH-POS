import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {calculatePayrollScheme} = require('../payroll-schemes');
const source = fs.readFileSync(new URL('../payroll-scheme-ui.js', import.meta.url),'utf8');
function between(start, end) {
  const from=source.indexOf(start),to=source.indexOf(end,from);
  assert(from >= 0 && to > from);
  return source.slice(from,to);
}
const helpers = vm.runInNewContext(between('  const editorDecimal =','  const editorFormat =') +
  between('  const SOURCE_POLICY_SALES =','  const sourcePolicyControlValues =') +
  between('  const quickDate =','  const defaultPreview =') +
  '({quickDefinition,shiftScenario})',{structuredClone});
const employee={id:'a',name:'Анна',role:'bartender',active:true};
const colleague={id:'b',name:'Иван',role:'hookah_master',active:true};
const args={method:'combined',rate:'10,00',percent:'10',from:'2026-10-01',staff:employee,sourceConfirmed:true};
const build = overrides => JSON.parse(JSON.stringify(helpers.quickDefinition({...args,...overrides})));
for(const [method,amount] of [['shift',1000],['percent',1000],['combined',2000]]) {
  const scheme = {...build({method}),id:'scheme',versionId:'version'};
  assert.equal(scheme.sourcePolicies.schemaVersion,2);
  assert.deepEqual(scheme.roleAssignments.map(row=>row.employeeId),['a']);
  const preview=JSON.parse(JSON.stringify(helpers.shiftScenario(scheme,employee,'2026-10-02','100')));
  const result=calculatePayrollScheme({...preview,scheme,roleAssignments:scheme.roleAssignments});
  assert.equal(result.status,'ready',JSON.stringify(result.blockers));
  assert.equal(result.employees[0].amountCents,amount);
}
const team=build({additional:[colleague,employee]});
assert.deepEqual(team.roleAssignments.map(row=>row.employeeId),['a','b']);
assert.deepEqual(Object.keys(team.roleParameters),['bartender','hookah_master']);
assert.throws(()=>build({sourceConfirmed:false}));
assert.throws(()=>build({percent:'100,01'}));
assert.throws(()=>build({from:'2026-02-30'}));
assert.throws(()=>helpers.shiftScenario(team,employee,'2026-09-30','100'));
assert.throws(()=>helpers.shiftScenario(team,{id:'c'},'2026-10-02','100'));
console.log('PASS owner pay setup: dated assignments, explicit source policy, selected colleagues and example shifts in all three pay modes');
