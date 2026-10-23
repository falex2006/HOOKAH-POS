import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const file of ['../portal.js', '../dist/portal.js']) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const start = source.indexOf('const createPortalEditorScope = (anchor) => {');
  const end = source.indexOf('\n};', start) + 3;
  assert.ok(start >= 0 && end > start, `${file}: editor scope found`);
  assert.match(source, /editOrdinary\(\{ key: `task:\$\{task\.id\}`, opener: editButton, discardOnCancel: true/);

  let context = 'venue-a';
  const queue = [];
  const openings = [];
  const ui = { open(options) {
    openings.push(options);
    const { reason, values } = queue.shift();
    options.onClose({ reason, values });
    return { promise: Promise.resolve({ reason }) };
  } };
  const create = new Function('portalEditorIdentity', 'document', 'window', 'loadSharedUI', 'portalNotice',
    `${source.slice(start, end)}; return createPortalEditorScope;`)(
    () => context, { activeElement: {}, querySelector: () => null }, {}, async () => ui,
    () => assert.fail('editor failed to open'));
  const editor = create({ isConnected: true });
  const open = async (reason, value, discardOnCancel = true) => {
    queue.push({ reason, values: { priority: value } });
    await editor({ key: 'task:1', fields: [{ name: 'priority', value: 'low' }],
      discardOnCancel, onSubmit: async () => null });
    return openings.at(-1).fields[0].value;
  };

  assert.equal(await open('cancel', 'high'), 'low');
  assert.equal(await open('cancel', 'low'), 'low', 'explicit task cancel discards unsaved priority');
  assert.equal(await open('escape', 'high'), 'low');
  assert.equal(await open('cancel', 'low'), 'high', 'Escape keeps recoverable draft');
  assert.equal(await open('cancel', 'high', false), 'low');
  assert.equal(await open('cancel', 'low', false), 'high', 'other editors retain existing cancel policy');
  context = 'venue-b';
  assert.equal(await open('cancel', 'low'), 'low', 'venue change clears old drafts');
}
console.log('TASK EDITOR CANCEL CONTRACT: PASS (source and dist)');
