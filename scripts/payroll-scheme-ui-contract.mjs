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
assert.match(finance, /payroll-scheme-ui\.js\?rev=37/, 'finance source loads the current owner payroll UI revision');
assert.match(distFinance, /payroll-scheme-ui\.js\?rev=37/, 'published finance page loads the current payroll UI revision');
assert.match(distFinanceAlias, /payroll-scheme-ui\.js\?rev=37/, 'directory alias loads the same payroll UI revision');
assert.match(sync, /payrollSchemeUiRevision = '37'/, 'asset revision is managed by the publish sync');
assert.match(ui, /saved:'Сохранённые расчёты'/, 'saved runs remain in the existing payroll workspace');
assert.match(ui, /sessionStorage\.setItem\(storageKey,\s*input\.idempotencyKey\)/, 'save intent is retained across reload');
assert.match(ui, /detailToken === detailAtSubmit/, 'save completion preserves a later detail selection');
assert.match(sync, /--payroll-scheme-ui-only/, 'payroll UI can be synchronized without rewriting unrelated published assets');
assert.ok(sync.includes(String.raw`payroll-scheme-ui\.js\?rev=\d+`), 'publish sync updates the payroll UI cache revision');
assert.match(sync, /cpSync\(resolve\(root, 'payroll-scheme-ui\.js'\), resolve\(root, 'dist', 'payroll-scheme-ui\.js'\)\)/,
  'publish sync copies the payroll UI source into dist');
assert.match(server, /'\/payroll-scheme-ui\.js'/, 'local server explicitly allows the payroll UI asset');
assert.match(ui, /sessionUser\.role !== 'owner'/, 'non-owner browser sessions receive no payroll scheme UI');
assert.match(ui, /const renderCandidateCalculation = payload =>/, 'the sourced preview renders the separate payroll scenario result');
assert.match(ui, /candidate\.nonPayable !== true \|\| candidate\.nonAccrual !== true/, 'the UI rejects a candidate result without explicit non-payable and non-accrual flags');
assert.match(ui, /не начислено и не к выплате/, 'the payroll scenario is visibly distinguished from an accrual or payment');
assert.match(ui, /renderFullEmployeeNetCandidate\(payload\)\}\$\{renderOrderRevenueReconciliation\(payload\)\}\$\{renderRefundReview\(payload\)\}\$\{renderCandidateCalculation\(payload\)\}\$\{renderCandidateSnapshot\(payload\)\}/,
  'the owner sees merchandise net, order reconciliation, refund lineage, candidate payroll result and its bound snapshot');
assert.match(ui, /const renderOrderRevenueReconciliation = payload =>/, 'order reconciliation is rendered as an independently validated candidate source');
assert.match(ui, /const mountProductDepartmentPanel =/, 'owner UI contains the payroll product classification editor');
assert.match(ui, /request\('\/api\/payroll\/product-department-mappings'\)/, 'classification editor reads current version and recent history');
assert.match(ui, /product-department-mappings\/retroactive-revisions/, 'historical correction uses a separate retroactive API');
assert.match(ui, /ownerAttestation:\{confirmed:true,action:'retroactive_payroll_product_department_mapping'\}/,
  'historical correction sends an explicit owner attestation');
assert.match(ui, /if \(snapshot\?\.productOptionsTruncated\) \{ report\(status/, 'truncated catalog blocks classification editing');
assert.match(ui, /Обычная версия начнёт действовать/, 'editor displays the server-derived next-day boundary');
assert.match(ui, /Открыть снимок/, 'owner can open an immutable revision snapshot from history');
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
assert.match(ui, /mountEmploymentEligibilityPanel\(payrollPanel, settings\)/, 'owner eligibility editor lives inside the existing payroll section');
assert.match(ui, /\/api\/payroll\/employment-eligibility\/employees/, 'eligibility editor uses the narrow owner payroll roster');
assert.match(ui, /expectedRevisionId: editingRevisionId/, 'full-snapshot writes use the revision captured when the editor opens');
assert.match(ui, /editingRevisionId = snapshot\.current\?\.id \|\| null/, 'editor base revision is frozen when editing starts');
assert.match(ui, /payroll_employment_revision_conflict/, 'stale full snapshots receive a clear conflict message');
assert.match(ui, /data-eligibility-empty-confirm/, 'an explicit empty eligibility snapshot requires owner confirmation');
assert.match(ui, /await refresh\(\)[\s\S]*?повторно загружена/, 'successful changes are confirmed from an API readback');
assert.doesNotMatch(ui, /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/, 'defaults do not derive venue-local dates from UTC');
assert.match(ui, /document\.querySelector\('\.finance-payroll-panel'\)/, 'scheme UI stays inside the existing finance payroll page');
assert.match(ui, /data-source-candidate-run/, 'owner can explicitly request the candidate employee/day source series');
assert.match(ui, /data-source-comparison-run/, 'owner has a separate sourced comparison action');
assert.match(ui, /\/api\/payroll\/compare\/sourced/, 'sourced comparison reads server-owned inputs through its own endpoint');
assert.match(ui, /JSON\.stringify\(\{versionIds,baselineVersionId,periodFrom:from,periodTo:to\}\)/, 'sourced comparison sends version IDs and period only, without scenario JSON');
assert.match(ui, /data-source-comparison-baseline/, 'owner explicitly selects the baseline saved version');
assert.match(ui, /data-sourced-comparison-candidate-only/, 'sourced comparison is visibly non-accrual and non-payable');
assert.match(ui, /payload\.nonPayable !== true \|\| payload\.nonAccrual !== true \|\| payload\.payoutEligible !== false/, 'sourced comparison requires explicit finance safety flags');
assert.match(ui, /item\.amountCents !== null \|\| item\.deltaToBaselineCents !== null/, 'blocked comparison rows cannot display zero as a substitute amount');
assert.match(ui, /База недоступна/, 'a ready version remains visible when the selected baseline is blocked');
assert.match(ui, /invalidateSourcedComparison/, 'changing selected versions or baseline invalidates stale sourced comparison output');
assert.match(ui, /Сравнить сценарии \(JSON\)/, 'legacy JSON comparison is distinguished from sourced comparison');
assert.match(ui, /preview\/sourced/, 'candidate UI reads the owner-only sourced preview endpoint');
assert.match(ui, /renderFullEmployeeNetCandidate/, 'candidate source states use a dedicated structured renderer');
assert.match(ui, /renderRefundReview/, 'owner candidate panel exposes a separate refund lineage review');
assert.match(ui, /renderCandidateSnapshot/, 'owner candidate panel validates and displays a source-bound non-persisted snapshot');
assert.match(ui, /snapshot\.period\?\.from !== payload\.period\?\.from/, 'candidate snapshot cannot outlive the selected preview period');
assert.match(ui, /review\.period\.from !== payload\.period\?\.from \|\| review\.period\.to !== payload\.period\?\.to/,
  'refund review period must match the enclosing sourced preview');
assert.match(ui, /review\.impactStatus !== 'not_applied'/, 'refund review fails closed unless source explicitly confirms it was not applied');
assert.match(ui, /MAX_REFUND_REVIEW_EMPLOYEE_DAYS = 500/, 'refund summary rows have a bounded DOM render budget');
assert.match(ui, /visibleEmployeeDays = review\.employeeDays\.slice\(0, MAX_REFUND_REVIEW_EMPLOYEE_DAYS\)/, 'refund summary is bounded only after full evidence reconciliation');
assert.ok(ui.includes('итог учитывает весь период.'), 'bounded summary discloses hidden rows while preserving whole-period total');
assert.match(ui, /data-payroll-refund-review-total/, 'refund review displays a reconciled signed source total');
assert.match(ui, /Суммы не применены к зарплате/, 'refund review cannot be mistaken for a wage deduction');
assert.match(ui, /data-full-net-candidate-amount/, 'complete candidate source displays its value');
assert.match(ui, /data-full-net-candidate-warning/, 'candidate source is explicitly not payroll or commission');
assert.match(ui, /series\.status !== 'available'[\s\S]*?Итоговая сумма и дневная детализация скрыты/, 'incomplete sources never display an amount as zero');
assert.match(ui, /MAX_FULL_NET_CANDIDATE_ROWS = 2000/, 'candidate detail has a bounded render budget');
assert.match(ui, /MAX_FULL_NET_CANDIDATE_EVENTS = 2000/, 'nested event details have a separate global render budget');
assert.match(ui, /eventTotal !== BigInt\(row\.netMinor\)/, 'visible daily values reconcile to their sale/refund event amounts');
assert.match(ui, /total !== BigInt\(series\.amount\)/, 'candidate period amount reconciles to employee/day values');
assert.match(ui, /role="region" aria-label="Чистая стоимость товаров по сотрудникам и датам"/, 'wide candidate table can be keyboard-focused and horizontally scrolled');
assert.match(ui, /Полнота истории за этот период не подтверждена/, 'candidate source failure reasons are shown in Russian');
assert.match(ui, /readinessReasonLabel\(reason\)/, 'readiness reasons pass through safe owner-facing translations');
assert.match(ui, /Источник требует проверки\. Проверьте данные или обратитесь к администратору\./,
  'unrecognized readiness reason codes are not exposed as implementation strings');
assert.match(ui, /Посмотреть предварительные данные по продажам/, 'owner action uses plain language for the candidate sales preview');
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
for (const [key, label] of [['itemReturnEvidence', 'Проверка возвратов по строкам товаров'],
  ['employeeEligibility', 'Допуск сотрудников к расчёту'], ['employeeRoleCoverage', 'Покрытие сотрудников назначениями ролей']]) {
  assert.ok(ui.includes(`${key}: '${label}'`), `source readiness shows ${label}`);
}
assert.match(ui, /Object\.keys\(payload\.components\)/, 'all readiness components from the server are considered');
assert.match(ui, /unknownKeys = actualKeys\.filter/, 'unknown future components are rendered for owner review');
assert.match(ui, /missingKeys = Object\.keys\(readinessLabels\)\.filter/, 'missing expected components are shown instead of silently disappearing');
assert.match(ui, /Новый источник — требуется проверка/, 'unknown components never look payroll-ready');
assert.match(ui, /data-source-readiness-summary/, 'owner sees a concise readiness status summary');
assert.match(ui, /data-payroll-entry-diagnostic/, 'owner can inspect current payroll entries and expense links');
assert.match(ui, /entry-overlap-diagnostic/, 'payroll diagnostic UI uses the owner-only read API');
assert.match(ui, /Только чтение/, 'diagnostic is visibly read-only');
assert.match(ui, /не складывайте эти суммы/, 'accrual and cash evidence are kept distinct');
assert.match(ui, /incompleteCount = actualKeys\.filter\(key => Object\.hasOwn\(readinessLabels, key\)/,
  'unknown component states cannot inflate mapped incomplete totals');
assert.match(ui, /unsupportedCount = actualKeys\.filter\(key => Object\.hasOwn\(readinessLabels, key\)/,
  'unknown component states cannot inflate mapped unsupported totals');
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
