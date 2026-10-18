# Prospective POS recognition evidence for payroll

Status: local implementation contract for migration `144_pos_payroll_recognition.sql`. This document does not attest deployment, approval of a payroll run, legal entitlement, or permission for automatic deductions. Migration 143 belongs to the payroll workstream.

## Product decisions for version 1

New source events use `recognized_event_date`: the database transaction timestamp at the source transition, the venue's timezone observed at that transition, and the resulting fixed local date. The timestamp is server generated with `transaction_timestamp()`, matching existing POS `now()` operations. It is not a caller's date, original sale time for a refund, source payout `created_at`, or commit-order counter. A transaction started earlier can commit later; refund ordering remains the per-source 092 sequence, never timestamp or UUID ordering.

Sale recognition occurs when the order first becomes `closed`. First tender only freezes canonical090 pricing; it does not recognize a sale. `source_closed_at` is retained separately for reconciliation; a value different from the producer's transaction timestamp is marked `source_close_time_mismatch`, matching both existing HTTP close paths' `closed_at=now()`. Refund recognition occurs in the transaction that creates the refund header. Header time and timezone are captured immediately; the recognition event is materialized by a deferred constraint trigger after tender and item writes. Reader transactions see only committed evidence. A read endpoint never creates evidence.

Changing the venue timezone later never moves an existing event between dates. A missing or invalid timezone creates incomplete evidence with null timezone/date; it does not silently adopt another timezone or block the POS payout. Period readers must include such unassignable evidence in their completeness assessment instead of hiding it with a date filter.

Eligibility means the employee attribution was observed as valid when the order item was created. It does not mean that a commission scheme applies. Migration084 remains the attribution validator: active, not deleted, same venue or organization-qualified employee. Version1 records same-venue eligibility as supported, cross-venue eligibility as observed but unsupported, and missing/legacy attribution as unknown. Current staff membership changes must not rewrite these facts. Canonical090 `eligible` remains discount eligibility and must never be reused as payroll eligibility.

## Producer and storage contract

All evidence is produced by database triggers in the source transaction. Direct inserts into evidence tables and all updates, deletes and truncates are rejected. These controls assume the application's ordinary database privileges; a database owner who disables triggers is outside this integrity boundary.

| Producer | Persistent evidence | Timing and completeness |
| --- | --- | --- |
| `order_items` INSERT | `payroll_attribution_captured_at`, `payroll_attribution_policy_version`, `payroll_eligibility_status`, `payroll_eligibility_venue_id`, `payroll_employee_venue_id` | Server captures once; caller-supplied evidence fields rejected. Attribution employee/time and evidence fields cannot be changed. |
| `orders` transition to `closed` | `pos_payroll_sale_events`, `pos_payroll_sale_line_events` | Copies frozen090 line identity and historical item eligibility. Missing pricing, missing line coverage, unknown seller, cross-venue or missing timezone makes header incomplete. |
| `order_refunds` INSERT | Header `payroll_recognized_at`, `payroll_timezone_snapshot`, `payroll_recognized_local_date`, `payroll_recognition_policy_version` | Server captures once; caller-supplied values rejected. Original refund header immutability already protects these columns. |
| Deferred refund INSERT constraint | `pos_payroll_refund_events`, `pos_payroll_refund_line_events` | Source tender sum, item attribution, original sale and sequence lineage inspected after all source writes. Missing facts yield explicit incomplete coverage. |

Mutable order items have no new restrictive evidence foreign key. Quantity changes, deletion and same-venue order splitting remain possible before090. Split moves the item with its captured attribution; it does not re-observe staff membership. A cross-venue move is rejected. Existing items retain null evidence; closing an old item after migration does not fabricate historical eligibility. Existing sale/refund records are not backfilled. New refunds of old sales therefore remain incomplete for official employee net revenue.

Canonical pricing amounts and product facts remain in090. Recognition lines reference those immutable records rather than inventing a second pricing calculation. Empty orders with a real empty canonical snapshot may have complete zero-merchandise coverage; an absent snapshot is incomplete even when the apparent total is zero. Minimum adjustment stays a venue component and is never assigned to a seller.

### Reader schema

`pos_payroll_sale_events`: `id`, `venue_id`, `order_id`, nullable `snapshot_id`, `policy_version=1`, `recognized_at`, nullable `timezone_snapshot` and `recognized_local_date`, nullable `source_closed_at`, `currency_code='RUB'`, `coverage_status` (`complete`/`incomplete`), `coverage_reasons` text array. Unique `(venue_id,order_id)`.

`pos_payroll_sale_line_events`: `id`, `venue_id`, `sale_event_id`, `snapshot_id`, `order_id`, `order_item_id`, `pricing_line_id`, nullable `seller_id`, `sold_at`, `attribution_captured_at`, `attribution_policy_version`, `eligibility_venue_id`, `employee_venue_id`; `eligibility_status` (`same_venue`/`cross_venue`/`unknown`). Unique `(venue_id,order_item_id)`. Foreign keys preserve same-tenant original line and sale-event lineage. Read amount/quantity/product facts by `pricing_line_id` from090.

`pos_payroll_refund_events`: `id`, `venue_id`, `refund_id`, `order_id`, nullable `original_sale_event_id`, `policy_version=1`, `recognized_at`, nullable `timezone_snapshot` and `recognized_local_date`, `currency_code='RUB'`, `item_attribution_status`, `payout_minor`, `tender_total_minor`, `coverage_status`, `coverage_reasons`. Unique `(venue_id,refund_id)`.

`pos_payroll_refund_line_events`: `id`, `venue_id`, `refund_event_id`, `refund_item_id`, `order_id`, `snapshot_id`, `order_item_id`, nullable `original_sale_line_event_id`; source092 copies `producer_sequence`, `previous_returned_quantity`, `returned_quantity`, `cumulative_returned_quantity`, `previous_returned_item_value_minor`, `returned_item_value_minor`, `cumulative_returned_item_value_minor`. Unique `(venue_id,refund_item_id)`. Values remain merchandise values, not the amount returned to the guest.

Dates are serialized as ISO local dates; UTC timestamps retain their full database precision in the reader's established timestamp codec. IDs and tenant lineage are not reconstructed from presentation labels.

## Refund authority and seals

Every newly recorded refund has a recognition header, including `unattributed` and `not_applicable`. Complete coverage requires a complete original sale event, a usable timezone, external paid/partially-paid source tenders, tender-total equality to the header payout, no cumulative payment over-refund, and a complete attributed item lineage or explicit `not_applicable` with no item lines. `complete` with no items is incomplete. Historical unsequenced lines, missing source lines, or sequence gaps remain incomplete.

Tender conservation is `sum(tender.amount) = header.amount`. There is deliberately no equation between payout and returned merchandise value: mixed bonus/deposit/reservation settlement may make these amounts differ. Liability reversal ledgers keep their existing ownership and are not posted here. An unattributed payout never becomes a zero merchandise refund; its merchandise value stays unknown.

The recognition event seals the refund. Later tender or item insertion, even for an incomplete event, is rejected. The insert guard locks the matching header before checking the seal and rejects a missing/invisible parent. Tender insert also locks the source payment before the deferred cap observation. This prevents a concurrent append from waiting on a foreign key and slipping in after recognition. Only `read committed` source-writing transactions can receive complete refund coverage in version1. Every other producer isolation level records `producer_isolation_unsupported`: a payment row lock alone does not refresh a repeatable-read snapshot, so aggregate coverage would be unsafe. The isolation level cannot be changed after source reads/writes begin. Read-only payroll consumers still use repeatable-read. Explicitly forcing deferred constraints early seals the source early; subsequent source additions fail rather than changing published evidence.

Sale recognition similarly seals canonical090 headers and lines against late insertion. An incomplete sale cannot later become silently complete. The source writer must finish snapshot lines before closing the order; both existing HTTP close paths do so. Immutable evidence remains immutable across migration replay.

## Consumer boundary and closed periods

### Per-venue installation coverage

`pos_payroll_recognition_epochs` contains exactly one immutable row per venue: `venue_id` (primary/foreign key), `policy_version=1`, server `activated_at`, `activation_scope` (`existing_at_install` or `new_venue`), nullable `timezone_snapshot` and `activated_local_date`. Initial installation seeds venues already present with `existing_at_install`; an AFTER INSERT venue trigger captures future venues as `new_venue`. Replay does not recreate or reset epochs. Direct insert/update/delete/truncate is forbidden. The timezone/date columns record the activation observation and are not proof of a venue's earlier timezone history.

An existing venue cannot claim complete history before producer installation. Version1 uses an intentionally conservative timezone-independent cutover: compute midnight UTC for the requested `from` civil date, subtract 24 hours, and require that instant to be at or after `activated_at`. Otherwise full-period coverage is incomplete (`period_precedes_recognition_epoch`). The 24-hour envelope includes the supported IANA timezone offsets and avoids interpreting old events using the venue's current timezone. It can conservatively exclude a period close to the installation boundary. A current month that started before installation is therefore unsupported; source facts within it remain inspectable. Consumers must not silently relax this boundary using the activation timezone or current timezone.

For `new_venue`, the epoch attests that this tenant did not exist before activation, so a requested monthly period may begin before activation without an installation gap. This is an explicit absence-of-tenant claim, not fabricated zero source data. Missing/incomplete events, legacy imported rows, unknown attribution, source timestamps and all canonical/period reconciliation checks still apply. Missing or malformed epoch means incomplete coverage. The epoch never repairs an unknown old item, refund, or imported sale. Its immutable facts must be included in the consumer watermark.

These are source facts, not payroll postings. `coverage_status` attests this producer's linkage, source coverage and eligibility checks; it does not replace canonical090 pricing validation, payroll policy validation, or run readiness. Consumers must preserve those checks, use one coherent repeatable-read snapshot, check complete source coverage including legacy/unassignable rows, and hash the scoped immutable facts and policy version into their watermark. Presence of some complete events does not make an entire period complete. Zero is valid only for an explicitly known zero amount; unknown coverage stays unknown. No global `officialReady` flag is enabled by144.

The payroll owner supplies configured commission rules and determines whether a source line is commissionable. Full merchandise net includes noncommissionable lines; commission eligibility never removes them from business net revenue. Refund lineage must refer to the original credited line and run before any payroll effect is proposed.

Closed/paid payroll runs and paid entries remain unchanged. A late recognized event may generate a reviewable proposal for the next open run, with event/run/credited-line references, rule version, amount cap, owner decision and reason. Applying the same proposal twice must have one effect. No automatic clawback, fixed-salary deduction, negative payout, or legal rule is encoded here. Unsupported adjustment cases and unallocated residuals remain explicit pending decisions in the payroll workflow. This producer can be implemented independently of that consumer without fabricating old history.

## Acceptance required before release

Use an isolated PostgreSQL database and actual HTTP source operations: attributed item insertion, first partial tender, explicit close and auto-close, partial/full item refunds, replay and concurrency. Verify no sale event at first tender, exactly one at close, fixed timezone/date and eligibility after later staff/venue changes, and unchanged pricing/payout accounting. Verify split/delete before snapshot and snapshot locks after tender. Test zero-value/empty, unknown seller, cross-venue and pre144 legacy cases.

Independently attack evidence and epoch INSERT/UPDATE/DELETE/TRUNCATE, injected capture fields, attribution rewrite, cross-tenant joins, late canonical/tender/item append (including two connections), tender mismatch/cap and sequence lineage. Two repeatable-read writers with stale snapshots must both retain `producer_isolation_unsupported` instead of claiming complete tender-cap coverage. Failed source transactions must leave no recognition event. Refund replay must not duplicate source or recognition; concurrent valid returns retain092 order. Verify initial-versus-new-venue epoch scope, same-month new-venue coverage boundaries, and replay migration144 and the ordinary migration chain without changing existing captured rows or activation times. Browser/readiness evidence remains a separate consumer acceptance step.
