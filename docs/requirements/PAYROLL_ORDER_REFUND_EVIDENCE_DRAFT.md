# Payroll item-return arithmetic evidence

Status: local pure validation only, 2026-10-03. Canonical POS storage, DB source adapter, payment linkage and official payroll are not implemented by this helper.

## Contract

`verifyPayrollOrderRefundFacts({pricingFacts, orderItemId, refundValuePolicy, itemReturnEvents})` revalidates the complete raw pricing envelope through `verifyPayrollOrderPricingFacts`, then selects one canonical item. A caller flag such as `verified:true` is unsupported. Policy must be `original_line_net_cumulative_half_up_v1`, matching the selected LOYALTY_POLICY_CONTRACT merchandise-return rule.

Each strict event includes event UUID, replay key, positive safe-integer sequence, venue/order/item/portion/snapshot/version/currency and original seller attribution, recognized timestamp, returned/previous/cumulative decimal quantities and previous/delta/cumulative item-value cents. Quantities use the POS numeric(12,3) positive range; previous quantity may be zero. Cents are nonnegative safe integers. Payment/tender/payout fields are unsupported: merchandise value cannot be derived from money disbursed.

The supplied stream starts at zero. Prior quantity and value must equal the preceding cumulative pair. Quantity increments are positive; cumulative quantity cannot exceed the original. With original net N, original quantity Q and cumulative C, all scaled to integer units:

`cumulativeValue = floor((2 × N × C + Q) / (2 × Q))`

Stored delta must equal cumulativeValue minus the prior stored value. Zero-value increments are valid. Full quantity returns exactly original net. The helper checks stored facts; it does not fill missing values.

Event IDs, replay keys and sequences are unique. Input order must follow increasing sequences and nondecreasing timestamps, no earlier than the original sale close. Equal timestamps and sequence gaps are allowed. An identical duplicate is rejected as duplicated input; DB idempotency is a separate producer responsibility. Unordered/disconnected histories, reversed events, unknown policies and negative reversal/void quantities are rejected.

## Result and limitations

Detached result carries `validationScope:'supplied_item_return_arithmetic'`, `coverage:'not_attested'`, `paymentLinkage:'unknown'`, original line, source policy intent, original seller attribution, cumulative/remaining quantity and value, and the supplied events. Unknown original seller stays unknown. No cashier, opener or current catalog inference is accepted.

Empty events mean only that the caller supplied no events. Existing immutable snapshots, full event coverage, concurrent inserts, payment/source ownership and venue-local recognition dates remain unproven. `recognized_event_date` and `original_sale_period_correction` remain owner intent; this helper executes neither recognition, closed-run adjustment nor automatic clawback. The future authoritative adapter must establish timezone/date and original-period/run lineage, then apply the selected owner-reviewed adjustment policy.

## Local acceptance

Own contract RED (module absent) → PASS. The first implementation run found a QA expectation mismatch: reversed history is rejected by prior-chain validation before later sequence validation; only the expected error code changed. No product gate was weakened.

`node scripts/payroll-order-refund-evidence-contract.mjs`: 1,000 independent small Number/integer oracle cases, cumulative-vs-independent rounding, exact half-cent/fractional quantities, zero-net/zero-delta, full return, maximum supported price value, duplicate IDs/replay/sequence, malformed history/quantity/value, chronology, strict tenant/item/snapshot/currency/seller linkage, accessor rejection, unknown attribution, detached output and policy-intent preservation.

Both existing pricing contracts, source-policy, source-context, snapshot-evidence and milestone-storage contracts pass. This is arithmetic preparation for canonical sources; it is not source→DB→official-run→entry→expense acceptance.
