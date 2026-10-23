import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const portal = read('portal.js');
const app = read('app.js');
const css = read('style.css');

const checks = [
  ['Tasks render four status lanes', /class="tasks-board"[\s\S]*data-task-column="open"[\s\S]*data-task-column="in_progress"[\s\S]*data-task-column="done"[\s\S]*data-task-column="cancelled"/, portal],
  ['Task cards use role-aware status control', /<article class="task-card">[^\n]*\$\{taskStatusControl\(task\)\}/, portal],
  ['Task board has dedicated layout', /\.velora-theme \.tasks-board\{display:grid;/, css],
  ['Task board collapses for tablet', /@media\(max-width:1100px\)\{\.velora-theme \.tasks-board\{grid-template-columns:repeat\(2/, css],
  ['Task board collapses to one column on mobile', /@media\(max-width:650px\)\{[\s\S]*?\.velora-theme \.tasks-board\{grid-template-columns:1fr/, css],
  ['Guest cards expose archive action', /data-client-action="archive"/, portal],
  ['Guest cards expose owner-only delete action', /data-client-action="delete"[\s\S]*Удалить гостя/, portal],
  ['Guest card list has responsive grid', /\.client-grid\{display:grid;[\s\S]*@media\(max-width:900px\)\{\.client-grid\{grid-template-columns:1fr\}/, css],
  ['Inventory directory has department and category sections', /inventory-department-list[\s\S]*product-category-list/, portal],
  ['Employee table page renders selectable tables', /querySelectorAll\('\.table'\)|querySelectorAll\("\.table"\)/, app],
  ['Order item removal uses an explicit item endpoint and DELETE method', /apiJson\(`\/api\/orders\/\$\{orderId\}\/items\/\$\{itemId\}`,\{method:deleted\?'DELETE':'PATCH'/, app],
  ['Order deletion requires reason and stock decision', /Причина удаления[\s\S]*Списать ингредиенты по технологической карте/, app],
  ['Employee finance page returns after showing only own received payments today, including partial receipts', /МОЯ СМЕНА[\s\S]*Ваши оплаты сегодня[\s\S]*Все поступившие платежи, включая частичные[\s\S]*employeeView !== true[\s\S]*renderFinanceReport/, portal],
];

let failed = 0;
for (const [label, pattern, source] of checks) {
  if (pattern.test(source)) console.log(`PASS ${label}`);
  else { failed += 1; console.error(`FAIL ${label}`); }
}

// Run the real rendering helper to verify the role boundary, not its source spelling.
try {
  const start = portal.indexOf('const taskStatusControl = (task) => {');
  const end = portal.indexOf('const runTaskMutation =', start);
  assert(start >= 0 && end > start, 'Task status helper must be found');
  const helper = portal.slice(start, end);
  const render = (canManageTasks, status) => vm.runInNewContext(
    `${helper}; taskStatusControl(task);`,
    { canManageTasks, task: { id: 'qa-task', title: 'QA task', status }, esc: String },
    { timeout: 1000 }
  );
  const manager = render(true, 'in_progress');
  assert.match(manager, /data-task-status="qa-task"/);
  assert.match(manager, /value="in_progress" selected/);
  assert.deepEqual([...manager.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]), ['open', 'in_progress', 'done', 'cancelled']);
  assert.match(manager, /value="cancelled"/);
  const employee = render(false, 'open');
  assert.deepEqual([...employee.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]), ['open', 'in_progress', 'done']);
  assert.doesNotMatch(employee, /value="cancelled"/);
  assert.match(employee, /aria-label="Изменить статус задачи: QA task"/);
  const cancelled = render(false, 'cancelled');
  assert.doesNotMatch(cancelled, /<select/);
  assert.match(cancelled, /Отменена руководителем/);
  console.log('PASS Task status control role behavior (manager, employee, cancelled)');
} catch (error) {
  failed += 1;
  console.error(`FAIL Task status control role behavior: ${error.message}`);
}

if (failed) process.exitCode = 1;
else console.log(`UI scenario contract passed (${checks.length + 1} invariants)`);
