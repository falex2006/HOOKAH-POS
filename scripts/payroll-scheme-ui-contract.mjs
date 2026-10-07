import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = fs.readFileSync(path.join(root, 'payroll-scheme-ui.js'), 'utf8');
const distUi = fs.readFileSync(path.join(root, 'dist', 'payroll-scheme-ui.js'), 'utf8');
const finance = fs.readFileSync(path.join(root, 'finance.html'), 'utf8');
const distFinance = fs.readFileSync(path.join(root, 'dist', 'finance.html'), 'utf8');
const distFinanceAlias = fs.readFileSync(path.join(root, 'dist', 'finance', 'index.html'), 'utf8');
const sync = fs.readFileSync(path.join(root, 'scripts', 'sync-published-assets.mjs'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

assert.equal(ui, distUi, 'published UI asset matches the source');
assert.match(finance, /payroll-scheme-ui\.js\?rev=17/, 'finance source loads the current owner payroll UI revision');
assert.match(distFinance, /payroll-scheme-ui\.js\?rev=17/, 'published finance page loads the current payroll UI revision');
assert.match(distFinanceAlias, /payroll-scheme-ui\.js\?rev=17/, 'directory alias loads the same payroll UI revision');
assert.match(sync, /payrollSchemeUiRevision = '17'/, 'asset revision is managed by the publish sync');
assert.ok(sync.includes(String.raw`payroll-scheme-ui\.js\?rev=\d+`), 'publish sync updates the payroll UI cache revision');
assert.match(sync, /cpSync\(resolve\(root, 'payroll-scheme-ui\.js'\), resolve\(root, 'dist', 'payroll-scheme-ui\.js'\)\)/,
  'publish sync copies the payroll UI source into dist');
assert.match(server, /'\/payroll-scheme-ui\.js'/, 'local server explicitly allows the payroll UI asset');
assert.match(ui, /sessionUser\.role !== 'owner'/, 'non-owner browser sessions receive no payroll scheme UI');
assert.match(ui, /request\('\/api\/venue'\)\.then\(\(venue\) =>[\s\S]*?venueTimezone = venue\.timezone\.trim\(\)/,
  'default scheme and preview dates receive the current venue time zone');
assert.match(ui, /\/api\/payroll\/attendance\/approvals\?\$\{params\}/, 'owner can read current attendance coverage and approval history');
assert.match(ui, /attendanceApprove\.disabled = !canApprove/, 'attendance approval stays disabled until a complete, current source and every detail page were reviewed');
assert.match(ui, /plannedMinutes.*workedMinutes/, 'attendance review shows scheduled and factual minutes per employee/day');
assert.match(ui, /shift\.sourceIntervals/, 'attendance review exposes the source time intervals before approval');
assert.match(ui, /data-attendance-page/, 'large attendance manifests can be reviewed page by page');
assert.match(ui, /attendanceVisitedPages\.clear\(\)/, 'refresh requires re-review of every attendance page');
assert.match(ui, /attendanceFrom\.addEventListener\('change'[\s\S]*?attendanceWatermark\.value = null/, 'changing the reviewed period invalidates the approval watermark');
assert.match(ui, /data-attendance-approve[\s\S]*?sourceWatermark: attendanceWatermark\.value[\s\S]*?idempotencyKey:/, 'approval sends the reviewed source watermark and an idempotency key');
assert.match(ui, /await venueTimezonePromise/, 'owner editor waits for the venue date context before creating defaults');
assert.doesNotMatch(ui, /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/, 'defaults do not derive venue-local dates from UTC');
assert.match(ui, /document\.querySelector\('\.finance-payroll-panel'\)/, 'scheme UI stays inside the existing finance payroll page');
assert.ok(ui.includes('/api/payroll/schemes'),
  'owner UI reads and creates versioned schemes through the payroll API');
for (const pathPart of ['/versions/${encodeURIComponent(versionId)}', '/activate', '/revisions', '/preview', '/preview/approved-attendance', '/preview/venue-turnover', '/api/payroll/compare']) {
  assert.ok(ui.includes(pathPart), `owner UI supports ${pathPart}`);
}
assert.match(ui, /manual-scenario|Сценарный расчёт/, 'scenario preview is visibly separated from production data');
assert.match(ui, /renderDetails/, 'preview renders a structured day/employee breakdown');
assert.match(ui, /Личный дневной план/, 'personal target preview identifies its daily scope');
assert.match(ui, /row\.marginIncentive/, 'margin preview shows signed/payable daily margin');
assert.match(ui, /line\.costSnapshot/, 'margin line explains versioned net total cost');
assert.match(ui, /текущая себестоимость меню не подставляется/, 'cost source limitation is disclosed');
assert.match(ui, /day\.teamFunds/, 'team fund preview presents each pooled computation once');
assert.match(ui, /Доля командного фонда до лимитов/, 'employee pool share stays distinct from sale commission');
assert.match(ui, /независимо от выхода/, 'configured weight attendance independence is explicit');
assert.match(ui, /renderBudget\.poolAllocations/, 'pool allocation detail has a bounded render budget');
assert.match(ui, /line\.targetAllocation/, 'target line allocations are displayed without a fictitious scalar percentage');
assert.match(ui, /Number\.isInteger\(line\.appliedRateBps\)/, 'missing scalar rate never renders as zero percent');
assert.match(ui, /personal_target.*личный дневной план/i, 'configuration help explains target parameters');
assert.match(ui, /Критическая проверка сценария: сумма выше приписанного сотруднику оборота/, 'preview exposes scenario turnover breaches without silently reducing pay');
assert.match(ui, /Сценарная проверка по приписанному обороту сотрудника; это не официальный payroll-run/, 'scenario result is never presented as official payout eligibility');
assert.match(ui, /личной чистой выручки ещё требует подтверждения/, 'UI discloses the missing authoritative personal net revenue basis');
assert.match(ui, /<th>Приписанный оборот<\/th>/, 'employee summary exposes the actual guard proxy');
assert.match(ui, /Детализация по дню и чеку/, 'preview exposes order-line drilldown');
assert.match(ui, /Утверждённые смены/, 'preview exposes attendance inputs behind per-shift pay');
assert.match(ui, /shift\.workedMinutes.*shift\.plannedMinutes/, 'attendance detail displays factual and scheduled minutes');
assert.match(ui, /Δ к базе/, 'comparison shows per-day deltas against the baseline version');
assert.match(ui, /innerHTML = renderPreview/, 'preview uses escaped structured rendering instead of dumping raw JSON');
assert.match(ui, /innerHTML = renderComparison/, 'comparison uses structured rendering');
assert.match(ui, /Number\.isSafeInteger\(row\.amountCents\).*Number\.isSafeInteger\(previous\)/,
  'daily comparison deltas remain unavailable when either side overflows');
assert.match(ui, /MAX_RENDERED_LINES = 2000/, 'line detail rendering has a global DOM row limit');
assert.match(ui, /MAX_PREVIEW_ATTENDANCE = 20000/, 'attendance scenario input has a bounded row limit');
assert.match(ui, /MAX_RENDERED_EMPLOYEE_DAYS = 2000/, 'daily employee detail rendering has a global DOM row limit');
assert.match(ui, /MAX_COMPARE_EMPLOYEE_DAYS = 500/, 'comparison detail uses a tighter per-version employee row limit');
assert.match(ui, /MAX_COMPARE_LINES = 500/, 'comparison detail uses a tighter per-version line row limit');
assert.match(ui, /catch \(_\) \{ return `\$\{new Intl\.NumberFormat/, 'unsupported currency formatting fails safely');
assert.match(ui, /baselineValid = baselineResult\?\.status === 'ready'/, 'blocked baseline does not create a false zero delta');
assert.match(ui, /baselineValid \? money\(previousFound \? previous : 0, currency\) : '—'/, 'blocked baseline amount is unavailable instead of zero');
assert.match(ui, /\.filter\(\(employee\) => employee && typeof employee === 'object'\)/, 'malformed employees do not crash result rendering');
assert.match(ui, /const renderBudget = \{ employeeDays: MAX_COMPARE_EMPLOYEE_DAYS, lines: MAX_COMPARE_LINES \};[\s\S]*?renderDetails\(/,
  'each compared version receives a fair bounded detail budget');
assert.match(ui, /payload\.currency/, 'comparison totals use the validated shared currency');
assert.match(ui, /entry\.scheme\.name/, 'comparison identifies schemes by their owner-facing name');
assert.ok(ui.includes('не является официальным расчётом'), 'preview is described as non-official');
assert.match(ui, /не создаёт расчётный run, начисление или расход/, 'UI explains that scenario preview has no financial side effects');
assert.match(ui, /data-scheme-run-venue-preview/, 'owner has a separate action for sourced venue-turnover preview');
assert.match(ui, /data-scheme-run-approved-attendance/, 'owner has a separate action for approved-attendance preview');
assert.match(ui, /renderApprovedAttendancePreview/, 'approved-attendance preview displays approval revision and its non-official scenario boundary');
assert.match(ui, /source\.revision/, 'approved attendance provenance exposes the source revision');
assert.match(ui, /Данные продаж, авторство строк, скидки\/возвраты и оборот остаются входными данными сценария/, 'UI names remaining scenario sources');
assert.match(ui, /расчётная часть периода.*previewInput\.periodFrom/, 'UI distinguishes the calculation interval from the approved attendance month');
assert.match(ui, /Результат не сохраняется, начисления и расходы не создаются/, 'UI confirms no financial posting');
assert.match(ui, /renderVenueTurnoverPreview/, 'sourced preview renders its source and scenario-only limitations');
assert.match(ui, /final_total_snapshot либо тому же legacy fallback, что использует финансовая модель/, 'sourced preview labels Finance-compatible totals');
assert.match(ui, /база комиссии после скидок и возвратов и посещаемость остаются данными сценария/, 'UI does not imply sourced employee commission or approved attendance');
assert.match(ui, /sourceWatermarkPurpose|обнаружения изменений preview/, 'watermark is never described as authoritative payroll reconciliation');
assert.match(ui, /sourcePreviewErrorLabels/, 'source errors are mapped to owner-readable explanations');
assert.match(ui, /показан с блокерами/, 'blocked sourced scenarios are not shown as successful calculations');
assert.match(ui, /roleAssignments: \[\], employeeOverrides: \[\], itemRules: \[\]/,
  'owner can configure assignments, employee overrides and item rules');
assert.match(ui, /data-scheme-definition/, 'owner can edit the complete versioned configuration');
assert.match(ui, /data-scheme-risk-acknowledged required/, 'owner must explicitly acknowledge non-waivable payout-limit risk before every configuration save');
assert.match(ui, /const payoutRiskAcknowledgement = \{ confirmed: true, policyCode: PAYOUT_RISK_ACK_POLICY \}/, 'save creates a version-bound payout-risk acknowledgement payload');
assert.equal((ui.match(/definition, payoutRiskAcknowledgement \}/g) || []).length, 3, 'create, new-version and draft edit all send the acknowledgement');
assert.match(ui, /Подтверждение риска не сохранено/, 'list identifies versions without an acknowledged risk policy');
assert.match(ui, /Это подтверждение не отменяет дневной лимит и не разрешает выплату сверх личной выручки/, 'acknowledgement cannot opt out of the hard payout invariant');
assert.match(ui, /data-scheme-compare-version/, 'owner can select versions for comparison');
assert.equal(['/api/payroll/entries', '/api/expenses', '/api/orders', '/api/loyalty'].some((pathPart) => ui.includes(pathPart)), false,
  'scheme configuration UI never mutates existing payroll, expense, order or loyalty data');

console.log('PAYROLL SCHEME UI CONTRACT: PASS (owner-only finance mount, published asset, version config, audit and scenario UI)');
