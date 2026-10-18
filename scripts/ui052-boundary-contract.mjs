import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
// Immutable intake includes accepted WIP. Ignore only added mount calls;
// exclude the guest GET loader separately reviewed as approved scope.
const source=readFileSync(new URL('../portal.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
const hash=x=>createHash('sha256').update(x).digest('hex');
const normalize=x=>x.replace(/mountOperationalListPresentation\(target\);\s*/g,'');
const scopes=[
{"name":"guest_avatar_crud_editor_loyalty","start":"  document.querySelector('#client-avatar-file').addEventListener","end":"  document.querySelector('#client-form').addEventListener('submit'","anchor":"function renderClients()","ignoreRead":false,"expected":"b4647130aa8a4bf770544db9f3254f02d0ee30f1ac61b921a6aec53aac6be235"},
  {
    "name": "task_delete",
    "start": "    if (deleteButton) {",
    "end": "    if (editButton) {",
    "anchor": "function renderTasks()",
    "ignoreRead": false,
    "expected": "8979008caab3fe0a923f835bd76f21e6f76e6c47d6d8584c0958ee74a1de0210"
  },
  {
    "name": "guest_financial",
    "start": "  document.querySelector('#client-history')?.addEventListener('click'",
    "end": "  const phoneInput =",
    "anchor": "function renderClients()",
    "ignoreRead": true,
    "expected": "224ef1d318605edee7614bcf28d0aad401cb1ed63b479d3a71efe7ed5239acea"
  },
  {
    "name": "reservation_financial",
    "start": "    const openOrderButton = event.target.closest('[data-reservation-open-order]');",
    "end": "  document.querySelector('#reservation-list')?.addEventListener('click', async (event) => { const editButton",
    "anchor": "",
    "ignoreRead": false,
    "expected": "420e458642eba4410a80069c50f99397df23b1c47bc30c28b027e2a50ae9f5b8"
  },
  {
    "name": "delivery_status",
    "start": "  document.querySelector('#delivery-list').addEventListener('change'",
    "end": "  let creating = false;",
    "anchor": "",
    "ignoreRead": false,
    "expected": "5cf6e515377663f2aba0083a2d2823c48f63748030d2ea664819d88417fd78ea"
  },
  {
    "name": "delivery_create",
    "start": "  document.querySelector('#delivery-form').addEventListener('submit'",
    "end": "function renderEmployeeFinanceReport(",
    "anchor": "",
    "ignoreRead": false,
    "expected": "d19dffab1aa148c3601136986644759cee43f49d7844dd58c324ec65265d77a8"
  },
  {
    "name": "tasks_interaction",
    "start": "  const focusTaskStatus =",
    "end": "  const draw =",
    "anchor": "function renderTasks()",
    "ignoreRead": false,
    "expected": "82917290c283fc02666ddc6d3199838946ae29301fa61d3ad1423461123a9d42"
  },
  {
    "name": "tasks_lifecycle",
    "start": "  const load = async ({ background = false } = {})",
    "end": "function renderLoyalty()",
    "anchor": "function renderTasks()",
    "ignoreRead": false,
    "expected": "ba3098032c11d6331a3308d24392e88ebfffcb153524a4c33ef5623b0add5b36"
  },
  {
    "name": "guest_submit",
    "start": "  document.querySelector('#client-form').addEventListener('submit'",
    "end": "const reservationTableCapacityLabel =",
    "anchor": "",
    "ignoreRead": false,
    "expected": "a20c3fb24e6024c8567220cb5c5b5f36209fc664a8131bfd51c2987b953af2f0"
  },
  {
    "name": "reservation_mounted",
    "start": "  const reservationDialog =",
    "end": "  let reservations =",
    "anchor": "function renderReservations()",
    "ignoreRead": false,
    "expected": "fb6894e76b43a6e53b68fd6f57957372f13ac604d22660b757d10d0fe5c5466d"
  },
  {
    "name": "reservation_execute",
    "start": "  const load = (keepSavedDate = false)",
    "end": "\nif (page === 'dashboard' && location.hash === '#loyalty')",
    "anchor": "function renderReservations()",
    "ignoreRead": false,
    "expected": "ba1379b2dc907c80ff5742b74f62209d8314727b7fab870bf6bad90cb3e659f6"
  }
];
for(const c of scopes){const from=source.indexOf(c.start,c.anchor?source.indexOf(c.anchor):0),to=source.indexOf(c.end,from);assert.ok(from>=0&&to>from,c.name+' markers');let v=normalize(source.slice(from,to));if(c.ignoreRead)v=v.replace(/const load = [^\n]*\n/g,'');assert.equal(hash(v),c.expected,c.name+' unchanged business/lifecycle');}
const end=source.indexOf('// Consume existing UI primitives only inside operational page content.');assert.ok(end>0);assert.equal(hash(source.slice(0,end)),"753f208160a75ff3e34cd6b26fc595b2fa80961e4d00148686435b77102eff23",'upstream API/security/adapters unchanged');
for(const [file,expected]of [["server.js","490a71f46e4b9b143cb1f349be8c379d682bfa74ce9ac9c8c2fded8f956f3e61"],["app.js","01a1e81090b2fde6324f5b5a657dc7b91d9d5c8e5460bbd3b5259780038a5120"],["ui-dialog.js","c384626fd53db3ac049b788b4dfe127af0530ac98dd2fda776c5a0f288b172c8"],["lock.js","38275889e013d61c1779c17027c8ac13f39294546db1c22f6a2c53bd8e7b2ef9"]])assert.equal(hash(readFileSync(new URL('../'+file,import.meta.url))),expected,file+' intake bytes');
for(const [key,expected]of [["  const canManageTasks =","  const canManageTasks = hasPortalPermission('tasks_manage') || hasPortalPermission('staff_manage');"],["  const employeeClientView =","  const employeeClientView = !['owner', 'admin', 'developer', 'manager'].includes(portalUser.role);"],["  const canAdjustGuestLoyalty =","  const canAdjustGuestLoyalty = hasPortalPermission('finance') || hasPortalPermission('loyalty') || hasPortalPermission('staff_manage'); const canReadGuestAccountEntries = canAdjustGuestLoyalty; const canReverseGuestAccountEntries = hasPortalPermission('finance') || hasPortalPermission('loyalty'); const canMakeExternalGuestPayout = ['owner','admin','developer'].includes(portalUser.role) && hasPortalPermission('finance');"],["  const canTopUpGuestWallet =","  const canTopUpGuestWallet = hasPortalPermission('orders') || hasPortalPermission('finance');"],["  const canRefundReservationPrepayment =","  const canRefundReservationPrepayment = ['owner','admin','developer'].includes(portalUser.role) && hasPortalPermission('finance');"]])assert.equal(source.split('\n').find(l=>l.startsWith(key)),expected,key+' grant unchanged');
console.log('UI-05.2 boundary PASS (11 business/lifecycle scopes + upstream authority + 5 grant lines + 4 frozen files).');
