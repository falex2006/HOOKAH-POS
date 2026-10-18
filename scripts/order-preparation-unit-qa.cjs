'use strict';
const assert=require('node:assert/strict');
const {aggregatePreparation,refreshMemoryPreparation,dispatchSelection,assertPreparationTransition}=require('../order-preparation');
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
for(const [states,result]of [[[],'open'],[['new'],'open'],[['new','ready'],'in_progress'],[['queued','ready'],'in_progress'],[['ready','ready'],'ready'],[['in_progress','ready'],'in_progress']])eq(aggregatePreparation(states.map(preparationStatus=>({preparationStatus}))),result);
for(const status of ['closed','cancelled']){const order={status,items:[{preparationStatus:'ready'}]};eq(refreshMemoryPreparation(order),status);}
const rows=[{id:'a',preparationStation:'bar',preparationStatus:'new'},{id:'b',preparationStation:null,preparationStatus:'queued'},{id:'h',preparationStation:'hookah',preparationStatus:'new'}];
eq(dispatchSelection(rows,{station:'bar',itemIds:['a','b']}).map(x=>x.id),['a','b']);
for(const [input,code]of [[{station:'kitchen',itemIds:['a']},400],[{station:'bar',itemIds:[]},400],[{station:'bar',itemIds:['a','a']},400],[{station:'bar',itemIds:['missing']},404],[{station:'bar',itemIds:['h']},409]]){assert.throws(()=>dispatchSelection(rows,input),e=>e.status===code);checks++;}
eq(assertPreparationTransition({preparationStation:'bar',preparationStatus:'queued'},{status:'in_progress',expectedStatus:'queued'},['bar']),true);
eq(assertPreparationTransition({preparationStation:'bar',preparationStatus:'ready'},{status:'ready',expectedStatus:'in_progress'},['bar']),false);
for(const [item,input,stations,code]of [[{preparationStation:'bar',preparationStatus:'queued'},{status:'in_progress',expectedStatus:'queued'},['hookah'],403],[{preparationStation:'bar',preparationStatus:'queued'},{status:'ready',expectedStatus:'queued'},['bar'],400],[{preparationStation:'bar',preparationStatus:'ready'},{status:'in_progress',expectedStatus:'queued'},['bar'],409]]){assert.throws(()=>assertPreparationTransition(item,input,stations),e=>e.status===code);checks++;}
console.log(`ORDER PREPARATION UNIT QA: PASS (${checks} cases; aggregate, frozen financial status, mixedstation selection, invalid/replay/stale transitions)`);
