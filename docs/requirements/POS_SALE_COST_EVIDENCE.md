# Historical sale cost evidence v1

## Scope and ownership

Local additive inventory/POS producer, owned by MASTER under the financial contract. No payroll calculation, payment, expense, bonus, stock return, or financial ledger is written by this module. Existing quantity depletion, FEFO allocation and order-level COGS remain unchanged. This is observed inventory valuation, not proof of purchase-lot provenance or complete accounting COGS.

The existing sale close actions (`POST /api/orders/:id/close` and the final `POST /api/orders/:id/payments`) capture and persist evidence in their existing transaction, after saving `order_costs`. Cancellation with writeoff still consumes stock but does not persist sale cost evidence. No new UI or HTTP endpoint exposes cost data. The internal reader must be called only after the consumer's existing authorization and venue resolution.

## Producer

- `inventory-order-cost-capture.js` collects the recipe actually used, line identity, source quantity/unit, normalized quantity, locked `ingredients.cost`, and the actual returned movement ID/quantity. It preserves the existing grouping and arithmetic. It does not reread a recipe after depletion.
- `inventory-order-cost-allocation.js` uses decimal6 quantity × decimal4 observed unit cost with BigInt. Total cents must equal the PostgreSQL-rounded saved `order_costs.cost`. Line cents use largest remainder with order-item ID tie break. Any discrepancy yields incomplete evidence instead of changing COGS.
- `pos-sale-cost-evidence.js` writes one immutable JSON snapshot and SHA-256 fingerprint. Whole-payload storage seals all children atomically; later appends are impossible. Retry returns the verified original snapshot before any mutable cost reads.

Valuation method: `ingredient_cost_at_depletion_v1`. This is the cost already used by the current depletion engine, not FEFO batch purchase cost. Tracked zero unit cost is conservatively `valuation_zero_unattested`; an explicitly non-stock line with no consumption may have zero cost. Empty/unknown inputs never imply a complete historical period.

## Schema and migration

`187_pos_sale_cost_evidence.sql` adds `pos_sale_cost_epochs` and `pos_sale_cost_evidence`. Apply with the normal migration chain before starting the new server. `schema.sql` stays at its existing 142 baseline, as required by the migration contract. No dependence on unmerged loyalty/payroll tables; no historical backfill.

Migration numbering was coordinated with LOYALTY: its physical stock source migrations 173/176 remain separate and must not be duplicated or overwritten; payroll's former local 172–175 require distinct numbers before combined integration. This package creates only valuation evidence and no second physical stock allocation ledger. When integrating loyalty's enhanced depletion, retain its allocation hook and feed the same actual allocations into this cost capture; do not overwrite the function wholesale.

Epochs are prospective per venue, immutable and preserved by replay. An epoch alone does not attest full-period coverage. The snapshot records UTC epoch time, policyVersion 1, venue/order, currency RUB, observed total, capture, deterministic allocation, coverage reasons and `refundAdjustedReady:false`.

SQL rejects mutation/truncate, foreign tenant/line/movement identities, non-conserving movement quantities, invalid complete totals, and new complete evidence outside the actual close transaction. The trusted server constructs recipe attribution: SQL guards are consistency checks, not an independent recipe engine or protection against a privileged database owner. Never accept this capture DTO from a browser/caller. No GUC grants authority.

## Reader handoff

```js
const { readSaleCostEvidence } = require('./pos-sale-cost-evidence');
const evidence = await readSaleCostEvidence(client, { venueId, orderId });
```

Use the consumer's owner-checked read transaction. The reader requires a closed order in that venue; verifies fingerprint, epoch and deterministic reconstruction without current recipe/cost lookups.

- `status:'complete'`: `totalCostMinor` and `allocation.lines[].totalCostMinor` are full line/order sale costs in integer kopecks, not unit prices. `capture` preserves recipe and movement lineage.
- `status:'incomplete'`: `totalCostMinor:null`; observed values may remain for diagnostics, never a margin input.
- `status:'unavailable'`: no matching closed sale in the supplied venue.
- `watermark`: frozen complete-payload SHA-256; bind with the consumer's immutable sale/pricing identity, never treat the hash as proof of period completeness.

Legacy grouped recipe rows lack proven per-item allocation and stay incomplete. Already-depleted orders without prior evidence stay incomplete, including when the old depletion fallback reads current cost. No reconstructed historical valuation is persisted as complete.

Refund-adjusted cost is deliberately unsupported. Cash refund, merchandise value, physical stock return and cost reversal are distinct facts. This source alone must not enable `marginCosts`, official payroll or a refund-cost capability. A later contract must link original cost to physical return/writeoff evidence and independently reconcile remaining NET TOTAL line cost.

## Acceptance

Pure contracts cover exact rounding, conservation, invalid quantities, zero/unknown, fingerprint tamper, epoch mismatch, retry without mutable reads. Guarded disposable PostgreSQL HTTP QA covers both close paths, actual movements, split line rounding, recipe/cost changes, duplicate close, tenant isolation, rollback, cancellation, zero/non-stock, immutable guards and unchanged baseline stock/payment/COGS behavior. No production fixtures or deployment.
