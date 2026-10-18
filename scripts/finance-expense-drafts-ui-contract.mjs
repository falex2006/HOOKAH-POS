import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portal = fs.readFileSync(path.join(root, 'portal.js'), 'utf8');
const publishedPortal = fs.readFileSync(path.join(root, 'dist/portal.js'), 'utf8');
const expenseCorrectionUi = (source) => {
  const start = source.indexOf('const readExpenseCorrectionDetail =');
  const end = source.indexOf('const expenseDraftMessage =', start);
  assert.ok(start >= 0 && end > start, 'expense correction UI block is present');
  return source.slice(start, end);
};
assert.equal(expenseCorrectionUi(publishedPortal), expenseCorrectionUi(portal),
  'published portal contains the same manual expense correction flow');
assert.match(portal, /const listFinanceEventAttempts=\(kind\)=>[\s\S]*?sessionStorage\.length[\s\S]*?getFinanceEventAttempt\(kind,id\)/,
  'pending finance actions can be enumerated after reloading the page');
assert.match(portal, /listFinanceEventAttempts\('manual_expense_draft_post'\)[\s\S]*?latest\.status === 'posted'[\s\S]*?removePostedDraft\(id\)[\s\S]*?latest\.status === 'draft'[\s\S]*?\/post/,
  'an uncertain post is reconciled or replayed after reload, including the already-posted branch');
assert.match(portal, /const removePostedDraft = \(id\) => \{[\s\S]*?expenseDraftItems\.delete\(id\)[\s\S]*?list\.querySelectorAll\('\[data-expense-draft-post\]'\)/,
  'a recovered or concurrently posted expense is removed from the visible draft list');
assert.match(portal, /catch \(error\) \{\s*if \(Number\(error\.status\) >= 400 && Number\(error\.status\) < 500\) \{\s*clearFinanceEventAttempt\('manual_expense_draft_post', id\);\s*const latest = await readExpenseDraft\(id\)/,
  'a startup replay conflict re-reads state to recognize a concurrent post');
assert.match(portal, /const expenseDraftMatchesPayload = \(draft, payload\) =>[\s\S]*?counterpartyName[\s\S]*?paymentAccountId[\s\S]*?paymentMethod/,
  'a lost draft edit response is accepted only when the saved payload matches');
assert.match(portal, /if \(latest\.status === 'posted'\)[\s\S]*?loadExpenses\(\), loadExpenseDrafts\(\), load\(\)/,
  'a matching draft posted by another authorized user refreshes the financial views');
assert.match(portal, /readExpenseDraft\(draft\.id\)[\s\S]*?latest\?\.status === 'posted'[\s\S]*?latest\.postIdempotencyKey === attempt\.payload\.idempotencyKey[\s\S]*?latest\.postedVersion/,
  'post recovery by key and version does not mistake a different posted attempt for an exact replay');
assert.match(portal, /data-expense-draft-cancel[\s\S]*?latest\?\.status !== 'cancelled'/,
  'a lost cancel response is reconciled from persisted state');
assert.match(portal, /counterpartyName: expenseSection\.querySelector\('#expense-counterparty'\)\.value\.trim\(\)/,
  'the manual expense form submits a separate counterparty');

console.log('FINANCE EXPENSE DRAFTS UI CONTRACT: PASS (source parity, saved-state recovery, draft lifecycle actions)');
