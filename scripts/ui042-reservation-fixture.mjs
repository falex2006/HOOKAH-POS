import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

export const portal = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
export const shared = fs.readFileSync(new URL('../ui-dialog.js', import.meta.url), 'utf8');
export const reservationSource = portal.slice(portal.indexOf('function renderReservations() {'), portal.indexOf('async function renderAuthorizedFinancePage'));
export function createReservationFixture(options = {}) {
  // Reuse the established DOM mechanics fixture, execute the current shared module.
  // This is source/VM proof; browser focus/pixels and persisted API records are separate.
  const lifecycle = fs.readFileSync(new URL('./ui-dialog-lifecycle-contract.mjs', import.meta.url), 'utf8');
  const fixtureStart = lifecycle.indexOf('function fixture() {');
  const fixtureEnd = lifecycle.indexOf('\nconst defaults =', fixtureStart);
  assert.ok(fixtureStart >= 0 && fixtureEnd > fixtureStart);
  const decode = value => String(value).replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => ({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[key]);
  const make = vm.runInNewContext(lifecycle.slice(fixtureStart, fixtureEnd) + '\nfixture;', { vm, source: shared, decode });
  const f = make(), ctx = f.context;
  const markup = reservationSource.split(/\r?\n/).find(line => line.includes('target.innerHTML ='));
  assert.ok(markup, 'actual reservation markup');
  Object.assign(ctx, { target: f.main, icon: () => '', esc: String, localDateKey: () => '2026-10-10' });
  vm.runInContext(markup, ctx);
  const get = id => f.document.getElementById('reservation-' + id);
  for (const panel of get('form').querySelectorAll('[data-reservation-step]')) panel.dataset.reservationStep = panel.getAttribute('data-reservation-step');
  for (const control of get('form').querySelectorAll('input,select,textarea')) {
    let custom = '';
    Object.defineProperty(control, 'validationMessage', { get: () => custom || (control.valid ? '' : 'Проверьте значение поля') });
    control.setCustomValidity = text => { custom = text; };
    control.checkValidity = () => control.disabled || (!custom && control.valid);
    control.reportValidity = () => control.checkValidity();
    control.click = () => control.dispatch('click');
    if (control.tagName === 'SELECT') Object.defineProperty(control, 'selectedOptions', { get: () => control.querySelectorAll('option').filter(o => o.value === control.value) });
  }
  for (const button of get('form').querySelectorAll('button')) button.click = () => button.dispatch('click');
  get('form').reset = () => { for (const control of get('form').querySelectorAll('input,select,textarea')) control.value = control.getAttribute('value') || ''; };
  f.document.querySelector('#focus-reservation').click = () => f.document.querySelector('#focus-reservation').dispatch('click');
  const requests = [], pending = [], notices = [];
  Object.assign(ctx, { portalUser: {id:'qa',venueId:'venue',role:'owner',name:'QA'}, portalRole:['owner'], hasPortalPermission: () => true, formatRuDate: String,
    portalNotice: (...args) => notices.push(args), loadTables: () => {}, load: () => {},
    api: (url, options) => { requests.push({url,options}); return new Promise((resolve,reject) => pending.push({resolve,reject})); } });
  ctx.window.__portalSessionVerified={user:{id:'qa',venueId:'venue',role:'owner'}};
  const identityLine=portal.split(/\r?\n/).find(line=>line.startsWith('const portalEditorIdentity ='));
  assert.ok(identityLine,'actual authoritative editor identity');vm.runInContext(identityLine,ctx);
  ctx.loadSharedUI=options.loadSharedUI||(()=>Promise.resolve(f.ui));
  if(options.loadTables)ctx.loadTables=options.loadTables;
  if(options.load)ctx.load=options.load;
  const begin = reservationSource.indexOf('  const reservationDialog =');
  const end = reservationSource.indexOf('  const loadTables =', begin);
  const modeStart = reservationSource.indexOf('  const syncReservationFormMode =');
  const modeEnd = reservationSource.indexOf("  api('/api/clients')", modeStart);
  assert.ok(begin >= 0 && end > begin && modeStart >= 0 && modeEnd > modeStart);
  vm.runInContext(reservationSource.slice(begin, end) + '\n' + reservationSource.slice(modeStart, modeEnd) + '\nObject.assign(globalThis,{openWizard:openReservationDialog,validateStep:validateReservationStep,showStep:showReservationStep,startNew:startNewReservation,syncMode:syncReservationFormMode,saveReservation,reservationSaveError,finishReservationSave,getWindow:()=>reservationWindow});', ctx);
  return {...f, get, requests, pending, notices};
}
export const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
export function validDraft(f) {
  const values = {guest:'  Guest  ',phone:' +79990000001 ',date:'2026-11-01',time:'21:00',table:'table-1',guests:'2',deposit:'300',notes:' Notes '};
  const select = f.get('table'); select.innerHTML = '<option value="table-1">Table 1</option>';
  for (const [id,value] of Object.entries(values)) f.get(id).value = value;
  return values;
}
