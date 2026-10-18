import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

// Actual current source blocks in a DOM-mechanics VM. No browser/API/PG claim.
const root = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('portal.js', root), 'utf8');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const span = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `source markers ${start}`);
  return source.slice(a, b);
};
const lifecycle = fs.readFileSync(new URL('scripts/ui-dialog-lifecycle-contract.mjs', root), 'utf8');
const decode = value => String(value).replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => ({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[key]);
const factory = vm.runInNewContext(lifecycle.slice(lifecycle.indexOf('function fixture() {'), lifecycle.indexOf('\nconst defaults =')) + '\nfixture;', {vm, decode, source:fs.readFileSync(new URL('ui-dialog.js', root),'utf8')});
const checks = [];
const check = async (name, fn) => { try { await fn(); checks.push({name,status:'PASS'}); } catch(error) { checks.push({name,status:'FAIL',error:error.stack}); } };
const tick = () => new Promise(resolve => setImmediate(resolve));
const blocks = {
  mount:span('function mountInventoryCatalogPresentation(target)', '\nfunction renderInventory()'),
  current:source.split(/\r?\n/).find(line=>line.includes('const catalogueReadIsCurrent =')),
  products:span('  const drawProducts = (items) => {', '  loadProducts(); document.querySelector'),
  recipes:span('  const showRecipesReadState = ', '  const premixPanel = '),
  writer:span('    const renderRecipes = () => {', '    const resetRecipeForm = '),
  readonly:span('    const normalizeReadOnlyRecipeSearch = ', '    recipeSearchInput?.addEventListener'),
  directories:span('    const directoryReads = ', "    document.querySelectorAll('[data-inventory-directory-status]')"),
  categories:span('    const loadProductCategories = ', '    const categoryForm = '),
};
function fixture(writer = true) {
  const f = factory(), c = f.context, requests=[];
  const markup = source.split(/\r?\n/).find(line=>line.includes("const visual = document.createElement('section')"));
  Object.assign(c,{target:f.main,canWriteInventory:writer,icon:()=>'',esc:String,displayName:String,money:String,productPlaceholder:()=>'<span>Фото</span>', normalizeInventorySearch:v=>String(v||'').toLowerCase(),normalizeRecipeSearch:v=>String(v||'').toLowerCase(),identity:'qa-owner-venue-a',portalEditorIdentity:()=>c.identity,refreshInventoryContext:()=>{},syncRecipeProductOptions:()=>{},syncRecipeCategoryOptions:()=>{},invalidateRecipeCostCache:()=>{},renderRecipeCostBreakdown:()=>'',setProductEditorMode:()=>{},portalNotice:()=>{},api:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})),renderInventoryDepartments:()=>{},renderInventoryDepartmentList:()=>{},drawSubdepartments:()=>{},drawProductCategories:()=>{},syncInventoryHierarchyOptions:()=>{},loadDirectoryView:()=>{}});
  vm.runInContext(markup,c);
  const recipe = f.document.createElement('section');recipe.className='recipes-panel'; recipe.innerHTML='<input id="recipe-search"><select id="recipe-category-filter"><option value="">Все</option><option value="Бар">Бар</option></select><span id="recipe-count"></span><div id="recipe-grid"></div>';f.main.append(recipe);
  for(const id of ['inventory-department-list','inventory-subdepartment-list','product-category-list']) { const node=f.document.createElement('div');node.id=id;f.main.append(node); }
  vm.runInContext(`let productsReadState='loading',recipesReadState='loading',productsReadGeneration=0,recipesReadGeneration=0,productItems=[],recipeItems=[]; let directoryLoadFailed=false,subdepartmentLoadFailed=false,categoryLoadFailed=false,allInventoryDepartments=[],inventoryDepartments=[],allInventorySubdepartments=[],inventorySubdepartments=[],allProductCategories=[],productCategoryItems=[]; const productsGrid=target.querySelector('#visual-catalog'); const recipeGrid=target.querySelector('#recipe-grid'),recipeCount=target.querySelector('#recipe-count'),recipeSearchInput=target.querySelector('#recipe-search'),recipeCategoryFilter=target.querySelector('#recipe-category-filter');`,c);
  vm.runInContext(blocks.mount+blocks.current+blocks.products+blocks.recipes+(writer?blocks.writer:blocks.readonly)+blocks.directories+blocks.categories,c);
  if(!writer) vm.runInContext('refreshRecipesAfterProducts=renderReadOnlyRecipes;',c);
  return {...f,c,requests,run:text=>vm.runInContext(text,c),get:id=>f.document.querySelector('#'+id)};
}
for(const writer of [true,false]) {
  const role=writer?'writer':'readonly';
  await check(`${role}: true empty distinguishes product and recipe filter empty`,()=>{
    const f=fixture(writer),render=writer?'renderRecipes()':'renderReadOnlyRecipes()';f.run('drawProducts([]);');assert.match(f.get('visual-catalog').textContent,/Каталог пока пуст/);f.run(`recipesReadState='ready';${render};`);assert.match(f.get('recipe-grid').textContent,/Технологических карт пока нет/);f.get('recipe-search').value='absent';f.run(`recipeItems=[{id:'r',name:'Tea',category:'Бар',ingredients:[]}];${render};`);assert.match(f.get('recipe-grid').textContent,/Ничего не найдено/);assert.equal(f.get('recipe-count').textContent,'0 из 1');
  });
  await check(`${role}: loading/error search retention, retry filters, product-triggered recipe refresh`,async()=>{
    const f=fixture(writer),render=writer?'renderRecipes()':'renderReadOnlyRecipes()';
    f.get('product-search').value='absent';f.get('recipe-search').value='needle';f.get('recipe-category-filter').value='Бар';
    f.run(`drawProducts();${render};`);assert.equal(f.get('visual-catalog').dataset.readState,'loading');assert.equal(f.get('recipe-grid').dataset.readState,'loading');
    f.run('loadProducts()');f.requests.at(-1).resolve({items:[{id:'p1',name:'Tea',category:'Бар',price:5,inventoryMode:'tracked'}]});await tick();
    assert.equal(f.get('recipe-grid').dataset.readState,'loading','product response cannot create false empty recipes');
    f.run(`readRecipes(recipeGrid,${writer?'renderRecipes':'renderReadOnlyRecipes'})`);f.requests.at(-1).reject(new Error('read failed'));await tick();
    f.run(render+';refreshRecipesAfterProducts();');assert.equal(f.get('recipe-grid').dataset.readState,'error');assert.ok(f.get('recipe-grid').querySelector('[role="alert"]'));
    f.run('loadProducts()');f.requests.at(-1).reject(new Error('read failed'));await tick();f.run('drawProducts()');assert.equal(f.get('visual-catalog').dataset.readState,'error');assert.ok(f.get('visual-catalog').querySelector('[data-products-retry]'));
    f.get('visual-catalog').querySelector('[data-products-retry]').dispatch('click');assert.equal(f.get('product-search').value,'absent');f.requests.at(-1).resolve({items:[{id:'p1',name:'Tea',category:'Бар',price:5}]});await tick();assert.match(f.get('visual-catalog').textContent,/По запросу ничего/);
    f.get('recipe-grid').querySelector('[data-recipes-retry]').dispatch('click');assert.equal(f.get('recipe-search').value,'needle');assert.equal(f.get('recipe-category-filter').value,'Бар');f.requests.at(-1).resolve({items:[{id:'r1',name:'needle',category:'Бар',productId:'p1',ingredients:[]}]});await tick();assert.equal(f.get('recipe-grid').dataset.readState,'ready');assert.equal(f.get('recipe-category-filter').value,'Бар');assert.ok(f.get('recipe-grid').querySelector('[data-recipe-card]'));
  });
  await check(`${role}: photo DOM gate and no false missing-techcard inference`,()=>{
    const f=fixture(writer); f.run("drawProducts([{id:'p',name:'Tea',price:5,inventoryMode:'tracked'}]);");assert.equal(f.get('visual-catalog').querySelectorAll('.upload-button').length,writer?1:0);assert.equal(f.get('visual-catalog').querySelectorAll('input').length,writer?1:0);assert.equal(Boolean(f.get('new-product')),writer);assert.equal(Boolean(f.get('product-form')),writer);assert.doesNotMatch(f.get('visual-catalog').textContent,/Нет технологической карты/);
    // Final architect decision: unique normalized-name fallback can bind a recipe
    // without productId; a non_stock product does not require a recipe.
    f.run("recipesReadState='ready';recipeItems=[{id:'r',name:'Tea',productId:null}];drawProducts();");assert.doesNotMatch(f.get('visual-catalog').textContent,/Нет технологической карты/);
    f.run("recipeItems=[];drawProducts([{id:'service',name:'Service',price:5,inventoryMode:'non_stock'}]);");assert.doesNotMatch(f.get('visual-catalog').textContent,/Нет технологической карты/);assert.match(f.get('visual-catalog').textContent,/Без складского списания/);
  });
}
for(const kind of ['products','recipes','departments','subdepartments','categories']) {
  await check(`${kind}: newer success ignores older error and older success`,async()=>{
    for(const reject of [true,false]) {
      const f=fixture(),call={products:'loadProducts()',recipes:'readRecipes(recipeGrid,renderRecipes)',departments:'loadInventoryDirectories().catch(()=>{})',subdepartments:'loadSubdepartments()',categories:'loadProductCategories()'}[kind],id={products:'visual-catalog',recipes:'recipe-grid',departments:'inventory-department-list',subdepartments:'inventory-subdepartment-list',categories:'product-category-list'}[kind];
      f.run(call);const old=f.requests.at(-1);f.run(call);const fresh=f.requests.at(-1);fresh.resolve({items:[]});await tick();if(kind==='departments'){f.requests.at(-1).resolve({items:[]});await tick();f.requests.at(-1).resolve({items:[]});await tick();}assert.equal(f.get(id).dataset.readState,'ready');const requestCount=f.requests.length;reject?old.reject(new Error('stale')):old.resolve({items:[{id:'stale'}]});await tick();assert.equal(f.get(id).dataset.readState,'ready');assert.equal(f.requests.length,requestCount,'old parent response cannot launch dependent reads');
    }
  });
  for(const guard of ['disconnected','replaced','context']) await check(`${kind}: ${guard} response ignored`,async()=>{
    const f=fixture(),call={products:'loadProducts()',recipes:'readRecipes(recipeGrid,renderRecipes)',departments:'loadInventoryDirectories().catch(()=>{})',subdepartments:'loadSubdepartments()',categories:'loadProductCategories()'}[kind],id={products:'visual-catalog',recipes:'recipe-grid',departments:'inventory-department-list',subdepartments:'inventory-subdepartment-list',categories:'product-category-list'}[kind];
    f.run(call);const request=f.requests.at(-1),node=f.get(id),before=node.textContent;
    if(guard==='context')f.c.identity='qa-readonly-venue-b';else if(guard==='disconnected')node.remove();else{node.id='old-anchor';const replacement=f.document.createElement('div');replacement.id=id;f.main.append(replacement);}
    request.resolve({items:[{id:'stale',name:'Stale'}]});await tick();assert.equal(node.textContent,before);assert.equal(node.dataset.readState,'loading');assert.equal(f.requests.length,1);
  });
}
await check('directory parent reload invalidates pending child reads',async()=>{
  const f=fixture();f.run('loadSubdepartments();loadProductCategories();');const old=[...f.requests];f.run('loadInventoryDirectories().catch(()=>{})');for(const request of old)request.reject(new Error('stale child'));await tick();assert.equal(f.get('inventory-subdepartment-list').dataset.readState,'loading');assert.equal(f.get('product-category-list').dataset.readState,'loading');
});
await check('directory parent initial failure stops unchanged child pending state',async()=>{
  const f=fixture();f.run('loadSubdepartments();loadProductCategories();');const staleChildren=[...f.requests];f.run('loadInventoryDirectories().catch(()=>{})');f.requests.at(-1).reject(new Error('parent offline'));await tick();
  for(const id of ['inventory-subdepartment-list','product-category-list']) { const node=f.get(id);assert.equal(node.dataset.readState,'error');assert.equal(node.getAttribute('aria-busy'),'false');assert.match(node.textContent,/Сначала повторите загрузку цехов/);assert.ok(node.querySelector('[role="status"]')); }
  for(const request of staleChildren)request.resolve({items:[{id:'stale'}]});await tick();for(const id of ['inventory-subdepartment-list','product-category-list'])assert.equal(f.get(id).dataset.readState,'error');
});
await check('directory parent failure preserves ready child rows',async()=>{
  const f=fixture();f.run('loadSubdepartments();loadProductCategories();');for(const request of f.requests)request.resolve({items:[]});await tick();
  const ids=['inventory-subdepartment-list','product-category-list'];for(const id of ids)f.get(id).innerHTML='<div>Existing ready rows</div>';
  f.run('loadInventoryDirectories().catch(()=>{})');f.requests.at(-1).reject(new Error('parent offline'));await tick();for(const id of ids){assert.equal(f.get(id).dataset.readState,'ready');assert.equal(f.get(id).getAttribute('aria-busy'),'false');assert.equal(f.get(id).textContent,'Existing ready rows');}
});
await check('directory parent failure leaves newer independent child retries current',async()=>{
  const f=fixture();f.run('loadInventoryDirectories().catch(()=>{})');const parent=f.requests.at(-1);f.run('loadSubdepartments();loadProductCategories();');const retries=f.requests.slice(1);const ids=['inventory-subdepartment-list','product-category-list'],before=ids.map(id=>f.get(id).innerHTML);
  parent.reject(new Error('parent offline'));await tick();ids.forEach((id,index)=>{assert.equal(f.get(id).dataset.readState,'loading');assert.equal(f.get(id).getAttribute('aria-busy'),'true');assert.equal(f.get(id).innerHTML,before[index]);});
  for(const request of retries)request.resolve({items:[]});await tick();for(const id of ids){assert.equal(f.get(id).dataset.readState,'ready');assert.equal(f.get(id).getAttribute('aria-busy'),'false');}
});
for(const kind of ['departments','subdepartments','categories']) await check(`${kind}: read failure alert, retry and retained directory context`,async()=>{
  const f=fixture(),call={departments:'loadInventoryDirectories().catch(()=>{})',subdepartments:'loadSubdepartments()',categories:'loadProductCategories()'}[kind],id={departments:'inventory-department-list',subdepartments:'inventory-subdepartment-list',categories:'product-category-list'}[kind],retry={departments:'data-directory-retry',subdepartments:'data-subdepartment-retry',categories:'data-category-retry'}[kind];
  f.c.selectedDepartment='bar';f.c.selectedSubdepartment='s1';f.c.categorySearch='syrup';f.run(call);f.requests.at(-1).reject(new Error('offline'));await tick();assert.equal(f.get(id).dataset.readState,'error');assert.equal(f.get(id).getAttribute('aria-busy'),'false');assert.ok(f.get(id).querySelector('[role="alert"]'));assert.ok(f.get(id).querySelector(`[${retry}]`));if(kind!=='departments'){f.get(id).querySelector(`[${retry}]`).dispatch('click');assert.equal(f.get(id).dataset.readState,'loading');}assert.equal(f.c.selectedDepartment,'bar');assert.equal(f.c.selectedSubdepartment,'s1');assert.equal(f.c.categorySearch,'syrup');
});
await check('photo keyboard Enter/Space, disabled/pending protection, idempotent mount and excluded panel',()=>{
  const f=fixture();f.run("drawProducts([{id:'p',name:'Tea',price:5}]);mountInventoryCatalogPresentation(target);mountInventoryCatalogPresentation(target);");const label=f.get('visual-catalog').querySelector('.upload-button'),input=label.querySelector('input');let clicks=0;input.click=()=>clicks++;assert.equal(label.tabIndex,0);assert.equal(label.getAttribute('role'),'button');assert.equal(label.listeners.get('keydown').size,1);label.dispatch('keydown',{key:'Enter'});label.dispatch('keydown',{key:' '});label.dispatch('keydown',{key:'a'});assert.equal(clicks,2);input.disabled=true;label.dispatch('keydown',{key:'Enter'});assert.equal(clicks,2);
  const editor=f.get('product-form'),upload=editor.querySelector('.upload-button'),picker=upload.querySelector('input');picker.click=()=>clicks++;editor.dataset.submitting='1';upload.dispatch('keydown',{key:'Enter'});editor.dataset.submitting='0';editor.dataset.imageProcessing='1';upload.dispatch('keydown',{key:' '});assert.equal(clicks,2);
  const excluded=f.document.createElement('section');excluded.className='premix-panel';excluded.innerHTML='<button>Excluded</button>';f.main.append(excluded);f.run('mountInventoryCatalogPresentation(target)');assert.equal(excluded.querySelector('button').classList.contains('ui-button'),false);
});
await check('source/dist mirrors and scoped token CSS',()=>{
  for(const file of ['portal.js','style.css'])assert.deepEqual(fs.readFileSync(new URL(file,root)),fs.readFileSync(new URL('dist/'+file,root)));
  const css=fs.readFileSync(new URL('style.css',root),'utf8').split('/* UI-06.1:')[1];assert.ok(css);assert.doesNotMatch(css, /#[a-fA-F0-9]{3,8}\b|!important/);assert.match(css,/min-height:44px/);assert.match(css,/:focus-visible/);
});
const result={generatedAt:new Date().toISOString(),scope:'Actual-source VM/DOM mechanics, no browser/API/PG proof',hashes:{portal:sha(source),style:sha(fs.readFileSync(new URL('style.css',root))),blocks:Object.fromEntries(Object.entries(blocks).map(([key,value])=>[key,sha(value)]))},checks,passed:checks.filter(x=>x.status==='PASS').length,failed:checks.filter(x=>x.status==='FAIL').length};
fs.mkdirSync(new URL('tmp/ui061/',root),{recursive:true});fs.writeFileSync(new URL('tmp/ui061/qa-source-final-results.json',root),JSON.stringify(result,null,2)+'\n');
for(const item of checks)console.log(`${item.status} ${item.name}${item.error?'\n'+item.error:''}`);console.log(`${result.passed} passed, ${result.failed} failed`);if(result.failed)process.exitCode=1;
