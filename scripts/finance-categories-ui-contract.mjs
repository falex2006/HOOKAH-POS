import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portal = fs.readFileSync(path.join(root, 'portal.js'), 'utf8');
const start = portal.indexOf('function renderFinanceCategories()');
const end = portal.indexOf('function renderFinance()', start);
assert.ok(start >= 0 && end > start, 'finance category page implementation is available');
const ui = portal.slice(start, end);
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

assert.match(portal, /document\.addEventListener\('submit', \(event\) => \{[^\n]*\}, 6000\); \}\);/,
  'generic form pending state must run after the form-specific submit handler');

assert.match(ui, /const reset = \(\) => \{[\s\S]*?message\.textContent = '';[\s\S]*?message\.className = 'form-message'/,
  'closing or reopening an editor clears its former validation message');
assert.match(ui, /form\.addEventListener\('submit', \(event\) => \{ event\.preventDefault\(\); if \(categoryMutationPending\) return;[\s\S]*?setCategoryMutationPending\(true\);[\s\S]*?\.finally\(\(\) => \{ setCategoryMutationPending\(false\); \}\)/,
  'a category save blocks parallel editor actions and restores them after completion');
assert.match(ui, /const requestId = \+\+categoryLoadRequestId;[\s\S]*?if \(requestId !== categoryLoadRequestId\) return false;/,
  'late category GET responses cannot overwrite a newer filter');
assert.match(ui, /data-finance-category-retry/,
  'a failed category read offers an in-page retry');
assert.match(ui, /if \(!item\) return; reset\(\); form\.hidden = false;[\s\S]*?finance-category-id/,
  'editing another row begins from a clean editor state');
assert.match(ui, /includeArchived=true/,
  'the status filter requests archived categories when asked');
assert.match(ui, /item\.active === false \? 'В архиве'/,
  'archived categories have an explicit status');
assert.match(ui, /item\.active === false \? 'Восстановить' : 'Архивировать'/,
  'archived categories can be restored');
assert.match(ui, /связанные записи за всё время и включают все статусы/,
  'the category page explains that source counts include historical and non-posted records');
assert.match(ui, /Number\(item\.recurringRuleCount \|\| 0\).*регулярных правил/,
  'category usage exposes recurring rules as a separate source count');
assert.match(portal, /расходных записей/,
  'expense ledger rows are not described as a total count of business operations');
assert.match(portal, /recurringRuleCount:0, payrollAccrualCount:null, purchaseDocumentCount:0, otherIncomeDocumentCount:0/,
  'demo fallback returns the same source-count shape as the finance API');
assert.match(portal, /expenseCorrectionCount:0/,
  'demo fallback declares correction-history category references');
assert.match(server, /finance_expense_corrections fc WHERE fc\.venue_id=c\.venue_id AND \(fc\.before_category_id=c\.id OR fc\.after_category_id=c\.id\)/,
  'category list exposes references retained in correction snapshots');
assert.match(server, /FROM finance_recurring_rules rr WHERE rr\.venue_id=c\.venue_id AND rr\.category_id=c\.id\) AS "recurringRuleCount"/,
  'production category usage counts recurring rules within the owning venue');
assert.match(portal, /title="Операции за текущий месяц" data-category-report="\$\{esc\(item\.id\)\}" data-category-report-archived="\$\{item\.active === false\}">Посмотреть операции<\/button>/,
  'each category report button retains its default-month description in the accessible title');
assert.match(ui, /categoryTabs\.setAttribute\('role', 'tablist'\)/,
  'category, mapping and revenue views expose an accessible tab list');
assert.match(ui, /button\.setAttribute\('role', 'tab'\); button\.setAttribute\('aria-controls', panel\.id\)/,
  'each tab identifies its controlled panel');
assert.match(ui, /button\.setAttribute\('aria-selected', String\(selected\)\);[\s\S]*?button\.tabIndex = selected \? 0 : -1;[\s\S]*?tabPanels\[position\]\.hidden = !selected/,
  'selected tab, keyboard focus and panel visibility stay synchronized');
for (const key of ['ArrowRight','ArrowLeft','Home','End']) assert.ok(ui.includes(`event.key === '${key}'`), `tabs support ${key} keyboard navigation`);
assert.match(ui, /expenseChoiceDialog = document\.createElement\('dialog'\)/,
  'expense choices open in a native modal dialog');
assert.match(ui, /expenseChoiceDialog\.setAttribute\('aria-labelledby', 'finance-category-start-title'\)/,
  'expense choice dialog has an accessible heading');
assert.match(ui, /expenseChoiceDialog\.showModal\(\)/,
  'expense entry action uses modal focus containment');
assert.match(ui, /expenseChoiceDialog\.close\(\)/,
  'expense choice dialog exposes a close action');
assert.match(ui, /finance-category-overflow[\s\S]*?<summary[^>]*aria-label=/,
  'secondary category actions retain a labelled expandable menu');
assert.match(portal, /categoryId: reportButton\.dataset\.categoryReport, from: to\.slice\(0, 7\) \+ '-01', to/,
  'category drilldown opens on the current calendar month and exposes editable period filters');
assert.match(portal, /linkedCategoryId=incomingParams\.get\("categoryId"\)[\s\S]*?includeArchivedCategory=incomingParams\.get\("includeArchived"\)==="true"[\s\S]*?loadUnifiedCategories\(current\.id,Boolean\(linkedCategoryId&&includeArchivedCategory\)\)[\s\S]*?categorySelect\.value=linkedCategoryId/,
  'the report restores the category filter after venue-scoped categories load and only requests archive access for archived links');
assert.match(portal, /const amountMinorFor=row=>[\s\S]*?otherIncomeRecognition'\?row\.netRecognizedAmount/,
  'source totals use the correct source-specific amount basis');
assert.ok(portal.includes('BigInt(sectionMeta.knownTotalMinor)')&&portal.includes('sectionMeta?.unknownAmountCount??visibleUnknown')&&portal.includes("' · показаны '+rows.length+' из '+totalCount"),
  'source totals use frozen exact cents, full unknown counts and loaded/total row disclosure');
assert.ok(portal.includes("sectionLabel+': неизвестна для '+totalCount+' строк'+(truncated?' · показаны '+rows.length+' из '+totalCount:'')"),
  'an all-unknown section still discloses loaded versus full snapshot row counts');
const summaryStart=portal.indexOf('const sectionMeta=report.sections?.[key]');
const summaryEnd=portal.indexOf('const details=row=>',summaryStart);
assert.ok(summaryStart>=0&&summaryEnd>summaryStart);
const summarize=new Function('report','key','rows','amountMinorFor','formatMinor','totalLabels',portal.slice(summaryStart,summaryEnd)+'return sectionTotal;');
const unknownRows=Array.from({length:500},()=>({amount:null}));
const readAmount=row=>row.amount==null?null:BigInt(row.amount);
assert.equal(summarize({sections:{test:{count:501,knownTotalMinor:'0',unknownAmountCount:501}},nextCursorBySection:{test:'cursor'}},'test',unknownRows,readAmount,String,{}),'Сумма раздела: неизвестна для 501 строк · показаны 500 из 501');
assert.equal(summarize({sections:{test:{count:501,knownTotalMinor:'12345',unknownAmountCount:1}},nextCursorBySection:{test:'cursor'}},'test',[{amount:'100'}],readAmount,String,{}),'Сумма раздела: известная часть 12345 · неизвестно для 1 строк · показаны 1 из 501');
assert.match(portal, /известная часть /,
  'a subtotal with missing row amounts is explicitly presented as only the known portion');
assert.match(portal, /дата закрытия[\s\S]*?срок оплаты[\s\S]*?период услуги[\s\S]*?дата проведения/,
  'source group names disclose the date basis used by the report filters');
assert.match(portal, /Оплаты закупок, зарплат и обязательств[\s\S]*?не складывайте эти срезы между собой/,
  'the report warns that cash payments and related accrual, purchase, and obligation slices can overlap');
assert.ok(portal.includes('${esc(unifiedNames[key]||key)} · ${report.sections?.[key]?.count??rows.length} · ${esc(sectionTotal)}'),
  'each source group shows its full snapshot count and separate total');
assert.equal((server.match(/finance_recurring_rules WHERE venue_id=\$1 AND category_id=\$2 AND status IN \('active','paused'\) LIMIT 1/g) || []).length, 2,
  'both category archive routes protect categories used by active or paused recurring rules');
assert.match(server, /if \(before\.active && !active\) \{\s*const draftUsage = await client\.query\('SELECT 1 FROM finance_expense_drafts/,
  'PATCH archive rejects expense categories still needed by open drafts');
assert.match(portal, /finance_category_has_drafts' \? 'Сначала перенесите или отмените черновики этой статьи\.'/,
  'category archive explains how to resolve draft references');
assert.match(ui, /form\.dataset\.originalKind = item\.kind[\s\S]*?finance_category_has_operations[\s\S]*?kindControl\.value = form\.dataset\.originalKind[\s\S]*?Создайте новую категорию нужного типа/,
  'rejected direction changes restore the saved type and explain how to proceed');

console.log('FINANCE CATEGORIES UI CONTRACT: PASS (clean editor state, single-submit protection, archive lifecycle)');
