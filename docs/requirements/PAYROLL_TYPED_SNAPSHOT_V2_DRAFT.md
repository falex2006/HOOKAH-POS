# Payroll typed immutable snapshots v2 — architecture draft

Status: coordinator-approved payroll-only migration 087 and pure mapper implemented; final code-health review and isolated PostgreSQL storage acceptance passed. This document does not authorize an official payroll run or attest source completeness.

## Scope and compatibility

Keep legacy snapshot mapping and its typed-incentive refusal intact. Add a separate pure `mapPayrollTypedSnapshotRows` returning daily snapshots, line snapshots, team fund snapshots and member allocations. A future atomic writer resolves transient employee/day/pool keys to database IDs. No ready-run writer, payout endpoint or changes to POS/Finance ledgers belong to this stage.

## Storage

- Daily snapshots: calculation kind, separate team fund pay and immutable incentive explanation. Store target/basis/rates/excess policy/components and signed/positive/payable margin/loss offsets with explicit rounding version.
- Line snapshots: typed target/margin components, immutable total net cost snapshot ID/version/currency, signed margin, and team pool source contribution/exclusion. Scalar applied rate may be null only where typed components replace a scalar rate; replacement item rules retain their own scalar rate.
- Fund snapshots: unique tenant/run/local date/pool key, department scope, target/basis/components/rates, distribution and rounding policies, fund amount and source context.
- Fund allocations: tenant/run/day composite links to the pool and employee snapshot; all eligible members, including zero weights and no-sales members; weight and allocation before caps, deterministic tie-break/version.

New historical tables require immutable UPDATE/DELETE/TRUNCATE protection, existing ready-run insert guards and tenant composite foreign keys. Cross-row conservation should use deferred checks at transaction commit so insertion order does not define correctness. Additive migrations must replay safely; existing history remains readable.

## Mandatory validation

1. Recompute personal/margin target components with the shared exact integer helper; never manufacture a scalar effective rate.
2. Validate total net line cost and signed margin against net commission base; offset daily losses before payable margin. Caller-entered cost metadata does not attest Inventory/Finance coverage.
3. Recompute deterministic largest-remainder allocation and validate complete member/source sets. Fund allocations sum to the fund before caps; cap reductions are not redistributed.
4. Reconcile line commissions to employee/day commission, fund allocations to employee/day fund, base pay to shift evidence, components to amount before cap, cap reduction to final pay, and every daily amount to period employee totals. Preserve capped-milestone semantics from the calculator.
5. Reject missing, duplicate, extra or conflicting employee/source/date/mode data. Require explicit period coverage rather than treating the presence of one day as completeness.
6. Preserve original sale/order/item/employee/product/date lineage. Payroll output rates and commissions are calculated values, not POS source facts.

## Official source gate

Typed storage is insufficient for official readiness. Require verified immutable attribution, line discount eligibility/allocation, refund/reversal lineage, personal net revenue, department/shift turnover, attendance approval, cost coverage for margin, consistent timezone, source manifests/watermarks and reconciliation from one source snapshot. Versioned owner-selected payroll credit/discount/refund policies must preserve original POS facts. Missing coverage keeps the official run blocked.

## Acceptance

Legacy compatibility; all three typed modes and mixed modes; exact cent conservation and stable ties; safe integer/decimal ranges; loss and refund scenarios; zero-weight and no-sales members; cap behavior; malformed/tampered explanations; tenant isolation; migration replay; immutable history and rollback. Only a later separately reviewed writer stage may connect these rows to an official ready run and existing payroll entry/expense lifecycle.

## Implemented boundaries

- `payroll-snapshot-reconciliation.js` repeats declared exact formulas and line allocations; `payroll-snapshot-source-context.js` checks supplied lineage and timezone consistency. Their composed gate proves consistency of supplied evidence only.
- `payroll-typed-snapshot-serializer.js` returns detached schema-v2 DTOs with exact decimal strings, signed margin and versioned cost metadata. `key`, `snapshotKey`, `teamPoolKey` and `poolKey` are transient references, not INSERT columns. A writer must resolve them atomically to database IDs.
- The mapper's tested current turnover/pool basis labels remain explicitly scenario labels. Passing this mapper cannot promote a scenario to an official source or authorize any payment.
- Legacy `mapPayrollSnapshotRows` continues refusing typed incentives; no legacy API silently changes semantics.
- Migration 087 is additive storage. Official run service remains blocked without verified source manifests; payroll entries and expenses remain outside this stage.
