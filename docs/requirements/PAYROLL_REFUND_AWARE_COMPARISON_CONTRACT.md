# Refund-aware sourced comparison: implementation contract

Status: implemented; integrated default PostgreSQL/UI suite78201 passed on 2026-10-23. Additional foreign-owner HTTP acceptance is recorded in payroll-current-integration-acceptance.json. This document is a contract, not deployment evidence.

## Objective and source of truth

The original owner specification is available at C:/Users/ADMIN/Downloads/Telegram Desktop/ТЗ_Гибкий_модуль_расчёта_зарплаты_CRM.md (the former Desktop path is missing). Compare payroll schemes on the same actual data, including merchandise returns. Preserve every original requirement; this comparison slice does not complete the substitute calendar, employee dashboard or half-month payout acceptance.

MASTER accepted the Finance boundary after inspecting current finance-unified-report.js. P&L continues to read approved/paid payroll_entries and prorate the existing amount over intersecting calendar days. Comparison is a forecast of calculated accrual before incoming payroll corrections, not an actual payment amount. It never applies incoming corrections or protected-fixed deductions and never changes entries, expenses, settlements, claims, dispositions, runs, POS/payment/loyalty ledgers or shift cash.

## Current verified gap

payroll-scheme-service.js compareSourced reads versions in one fenced REPEATABLE READ READ ONLY transaction but calls the v1 sourced-preview collector separately per version. Version2 policies are rejected by payroll-calculation-input-contract.js. The comparison adapter and UI accept only schema1 candidate snapshots. Existing refund-aware calculation/source modules are reusable; no engine or migration change is needed.

## Common source collection

One owner-checked, fenced read-only transaction loads the saved versions and collects one authoritative recognition manifest/cohort for the exact venue, currency, period and as-of snapshot. Load common closure, eligibility and the union of required attendance, department mapping and frozen sale-cost evidence once. Pass the same raw immutable facts to each applicable calculation. Scheme-dependent role, department/team allocation and projections may differ; do not use their different hashes as evidence of inconsistent raw data.

A missing optional family blocks only candidates that require it. An incomplete common recognition source cannot be replaced by zero. Return timestamps are not a reason to exclude a later return from the original sale cohort. Retain the epoch, all-related-refund and coverage checks. Frozen depletion cost is explicitly payroll incentive valuation; refundAdjustedReady:false remains and no actual return-adjusted COGS is implied.

## API and compatibility

Keep POST /api/payroll/compare/sourced and strict body {versionIds, baselineVersionId, periodFrom, periodTo}, owner/same-origin/tenant enforcement, 2–8 unique saved versions, matching currency and effective windows. Policy comes only from immutable saved configuration, never from a client override.

All-v1 requests retain their existing result contract. A request containing v2 uses an explicit versioned DTO (schemaVersion2, comparisonKind sourced_candidate_v2) with candidateOnly/nonPayable/nonAccrual true, officialReady/payoutEligible false and persistence none. Each row has its saved policy family, status, reasons, nullable amount, source identity, scheme input identity and employee rows including known zeros. V2 evidence must not masquerade as a v1 no-refund candidateSnapshot.

Mixed policies are not migrated or normalized into one another. Each candidate follows its own policy; v1 with refunds remains blocked. Show a valid candidate's own forecast even when the baseline is blocked, but its baseline delta is null. Cross-policy-family deltas are null. Same-family deltas require a ready baseline, the same proven raw source identity, venue/currency/period/timezone and compatible earning/attribution bases. Missing employee identity is unknown, not a zero substitute. Enforce bounded detail size and safe integer arithmetic.

## File ownership

Coordinator owns payroll-refund-aware-source.js, payroll-scheme-service.js, payroll-sourced-comparison.js or a separate payroll-refund-aware-sourced-comparison.js, payroll-scheme-ui.js, relevant tests and payroll documentation. Dockerfile changes only if the new local module requires COPY; dist is regenerated. Preserve all accepted UI53fd690b changes and existing payroll/source money behavior. System architect owns this cross-layer contract; code_health reviews before and after. MASTER approved this boundary; no financial code changes are required.

## Required acceptance

- Seven modes, zero/partial/full and late merchandise returns, nonlinear colleague effects, zero employees and positive/negative deltas.
- One actual recognition collection per comparison and common raw identity across candidates; tampered identity/period/currency/version rejected.
- Missing attendance/cost/department facts block only dependent candidates; incomplete common facts block all affected results.
- V1 no-return regression, v1 return blockage, v2-v2 comparison, mixed-family null deltas and blocked baseline behavior.
- Actual owner UI -> HTTP -> PostgreSQL sources -> visible forecast -> reload; four widths; stale selection/results and malformed DTO rejected.
- Unauthorized staff, foreign tenant and foreign origin denied. The transaction and before/after database assertions prove no writes to financial, payroll or POS/loyalty ledgers.
- Existing immutable source/calculator/replay validators remain unchanged or separately justified; source/dist and Docker closure checked.

Update PAYROLL_SOURCED_PREVIEW_API.md only after behavior is implemented and accepted. The current API document's blanket statement that refunds block every source-backed comparison is a legacy description, not the desired v2 behavior.
