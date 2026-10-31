'use strict';
const fs = require('fs');
const assert = require('assert/strict');
const path = require('path');
const source = fs.readFileSync(path.resolve(process.env.TASK_TEST_PORTAL || 'portal.js'), 'utf8');
const start = source.indexOf('function renderTasks()');
function take(a, b) { const x = source.indexOf(a, start), y = source.indexOf(b, x); assert(x >= 0 && y > x, `missing ${a} or ${b}`); return source.slice(x, y); }
const draw = take('  const draw = () =>', '  const load = async (');
const load = take('  const load = async (', '  const refreshVisible =');
const filters = take('  const drawTaskFilter =', '  if (canManageTasks) list.addEventListener(');
function setup() {
  const requests = [];
  const controls = Object.fromEntries(['#task-status-filter', '#task-priority-filter'].map(id => [id, {value: '', addEventListener(type, callback) { assert.equal(type, 'change'); this.change = callback; }}]));
  const document = { hidden: false, querySelector(selector) { return controls[selector]; } };
  const body = { innerHTML: 'Загрузка…' };
  const list = { isConnected: true, classList: { toggle() {} }, querySelectorAll(selector) { if (selector === '.tasks-column-list') return [body]; return []; } };
  const status = { textContent: '', innerHTML: '', querySelector() { return { addEventListener() {} }; } };
  const empty = { hidden: true, textContent: '' };
  const api = () => new Promise((resolve, reject) => requests.push({resolve, reject}));
  const setupHandlers = new Function('document','list','taskLoadStatus','filterEmpty','api', `let items=[],loadedOnce=false,mutationBusy=0,loading=false,loadGeneration=0; const refreshButton={disabled:false},pendingTaskIds=new Set(),canManageTasks=false,target={}; const updateTaskSidebarBadge=()=>{},interactionActive=()=>false,mountOperationalListPresentation=()=>{}; ${draw}\n${load}\n${filters}\nreturn {load};`);
  return { ...setupHandlers(document, list, status, empty, api), controls, requests, body, status, empty };
}
(async () => {
 for (const succeed of [true, false]) {
  const t=setup(), pending=t.load(); assert.equal(t.requests.length,1); assert.match(t.status.textContent,/Обновление задач/);
  t.controls['#task-status-filter'].value='open'; t.controls['#task-status-filter'].change();
  assert.equal(t.empty.hidden,true,'filter must not expose empty state while pending'); assert.equal(t.body.innerHTML,'Загрузка…');
  if(succeed) { t.requests[0].resolve({items:[]}); assert.equal(await pending,true); assert.equal(t.empty.hidden,false); assert.equal(t.empty.textContent,'По выбранным условиям задач нет'); }
  else { t.requests[0].reject(new Error('offline')); assert.equal(await pending,false); assert.match(t.status.innerHTML,/Не удалось загрузить задачи/); assert.match(t.body.innerHTML,/Данные не загружены/); t.controls['#task-priority-filter'].value='high'; t.controls['#task-priority-filter'].change(); assert.equal(t.empty.hidden,true,'filter must preserve load error'); assert.match(t.body.innerHTML,/Данные не загружены/); }
 }
 console.log('PASS real release handlers: filter while initial GET pending, failure, successful empty response');
})().catch(error => { console.error(error); process.exitCode=1; });
