# Payroll pricing source gap audit

Status: read-only audit, updated 2026-10-03 after coordinator-selected line allocation/partial-return policy and local payroll configuration acceptance. The selected policy is in LOYALTY_POLICY_CONTRACT.md; implementation of canonical source storage remains unproven.

## What the POS currently preserves

- Each order line can preserve `sales_employee_id` and `sold_at` (`migrations/084_order_item_sales_attribution.sql`). The server validates that the employee is active and belongs to the order venue/organization. The seller may remain null for historical or unattributed lines.
- The order price is locked on first accepted tender. The locked order stores aggregate `subtotal_snapshot`, `discount_total_snapshot`, `minimum_adjustment_snapshot`, `final_total_snapshot`, `pricing_version`, and `pricing_locked_at` (`migrations/061_order_group_discount_pricing.sql`, `migrations/075_order_pricing_lock.sql`). Server edit paths reject changing a paid/locked order's guest/price inputs.
- Group discount is stored at order level, including its percentage, base, and amount. Manual discount requests are also order-level records. Promotions preserve campaign ID/version/name/benefit and eligible basis/amount, plus a JSON pricing-offers snapshot (`migrations/074_order_promotion_pricing_snapshot.sql`).
- Stored amounts use two decimal places; line quantities use three. Payroll scheme/run currency is versioned separately. Do not assume the order snapshot itself proves its currency without validating the venue/scheme source contract.

## Gaps that block an official employee calculation

1. No immutable per-line discount amount, eligible base, or final net line amount is persisted by the closed-order pricing contract. The aggregate discount cannot be reliably attributed among employees after the fact, particularly for mixed eligible/ineligible lines, minimum-charge adjustments, fixed discounts, and cent rounding.
2. The order-level `pricing_offers_snapshot` is useful evidence of the evaluator result, but it is not the canonical line allocation required to reproduce the final employee amounts. It does not remove the need for persisted source coverage and deterministic rounding.
3. `sales_employee_id` captures a line seller, while `orders.opened_by` is a separate fact. The coordinator decision in DECISIONS.md requires the original line seller for official payroll under the TZ. Alternative source-policy modes remain scenario/future choices until separately approved; neither opener nor cashier may silently replace missing seller facts.
4. Migration088 defines append-only order-level refund/tender facts, explicitly `item_attribution_status='unattributed'` only. Its local UI/API/PG acceptance has been handed off; this does not provide canonical refund/item/employee lineage. A payroll policy for reversals cannot create missing attribution facts. Existing guest-account and reservation-prepayment reversals are separate financial ledgers.
5. Historical closed orders lack the newly introduced sales attribution for many lines and cannot be backfilled as fact from the current logged-in employee or order opener.

## Required implementation gate

The owner editor may expose venue-specific, versioned choices for seller attribution, discount allocation, and refund treatment. Those choices select how complete POS facts are interpreted; they cannot supply missing facts. Before any official (`ready`) payroll run, each included sale must have immutable line-level gross, discount, eligible basis, net amount, attribution state, currency, and price-rule version; refunds must link to the original line and preserve whether attribution is known. Source coverage, totals versus the order snapshot, and deterministic cent balancing must validate from one tenant-scoped database snapshot. Unknown seller/discount/refund coverage means preview-only/blocked.

Pure payroll pricing verification now replays supplied aggregate HALF_UP gross and canonical order_item_id allocations, including decimal quantity/unit price. It validates supplied arithmetic only; immutable winner/eligible-set authority, persisted source coverage and actual line-refund facts are still absent. Owner milestone eligibility configuration and durable089 acceptance do not close these source gaps. No pricing, payroll, server, schema, or source data was changed for this audit.


## Verified producer arithmetic defect — 2026-10-03

Direct execution of current evaluateLoyaltyPricing with subtotal0.01, two eligible merchandise rows quantity0.5/unitPrice0.01 and a100% promotion returned subtotal0.01, eligibleBasis0.02, discount0.02, net0. Per-line Number rounding duplicates the half-cent; discount exceeds the order subtotal. This is an existing shared producer defect, not a refund-helper regression. Existing loyalty-pricing-qa uses whole-quantity cases and does not establish fractional parity. Payroll does not patch shared evaluator without file ownership. Coordinator received the reproducer and native architect/finance contract: reconcile order gross first with the selected exact numeric/item-ID rule, then calculate promotion basis from those frozen gross cents and persist the same allocation envelope. Merely capping discount would leave mismatched basis/source facts.

Additional producer facts currently lost: canonical oi.id and seller/time in pgOrderPricing item query; approved manual-discount IDs in the discount query; actual chosen eligible item IDs in evaluator output. Group has no proven source version in this path; preserve actual group identity/frozen parameters plus producer snapshot identity rather than inventing a version. Winner precedence stays the current best-only comparator contract unless a separate change is approved. Native read-only baseline and this live reproduction changed no shared code or source data.
