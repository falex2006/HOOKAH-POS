# Consolidated POS improvements — 2026-10-11

User requested a complete working POS version, integrating useful old WIP rather than deferring candidate work indefinitely. Base: published main `878761b1` (PR #28 owner home removal).

## Resolution of old WIP

| Item | Final decision |
| --- | --- |
| Order amount on occupied table | Integrated using canonical server due (discounts, promotions, minimum and locked payment price), rather than old raw item subtotal. All active orders on table are summed. Missing price shows dash; no guessed zero. |
| Preparation dispatch/accept/ready notices | Integrated after successful API acknowledgement, with station/count or table/item context. |
| Table minimum error/validation/wording | Integrated schedule error for creation, nonnegative/finite amount and equal-time editor validation; label is minimum order check. Existing venue/session guards, paired schedule and input/change booking refresh retained. |
| 18:00–09:00 schedule | Already present and covered by existing boundary QA. Strict HH:MM kept; old blind truncation rejected because API/PG already normalize time. |
| Statuses in order card, logical catalogue return/next step | Already published; preserved. |
| Button/staff layouts, warehouse names, new-venue empty setup | Already published; preserved. |
| Owner dashboard roster | Removed in PR #28; directory/permissions unaffected. |
| Docker/PIN/lock/deploy/migration old differences | Regressions/obsolete implementation excluded; safer current main retained. |
| Old docs/temp/scripts and AlphaSat adapter | Preserved; evidence is not product behavior. Separate unfinished AlphaSat integration is outside this POS release and is not auto-installed. |

No remaining known independent useful POS behavior from the audited old runtime diff is left as an unreviewed release candidate. This does not certify every historic evidence file or complete a separate AlphaSat integration.

## Price contract

Floor requests `/api/orders?withPricing=1`. Legacy callers retain unchanged response. Optional `pricingTotal` is computed through the same `pgOrderPricing`/`memoryOrderPricing` as order summary, with at most four concurrent order calculations. Price failures are per-order nulls, not a guessed subtotal. Only active venue-scoped authorized orders are priced. No order writes, new DB fields or migrations. Display amount includes already paid share (full order total, not outstanding balance). Timer/status/amount have separate rows; numeric amount is never hidden by a textual prefix.

Performance: pricing reads per active order remain O(n); concurrency is bounded. Appropriate for this small venue. A future high-volume optimization may batch server calculations; it is not necessary to ship this verified behavior.

## Verification

PASS: isolated memory and disposable PostgreSQL paid-order suites (discount/promotion/minimum/partial-price lock, legacy response, unchanged state, tenant/role denial); floor total label helper (multiple active/zero/unknown/closed); desktop browser floor with 250-ruble item/1200 minimum (map/density/grid row bounds); owner dashboard/directory browser; schedule boundaries/optional controls/new editor validation; preparation unit/UI including acknowledged success message; design/click/static/deploy source/dist contracts and syntax.

Existing paid-memory VIP fixture was corrected to configure the authoritative table minimum, not send an ignored client minimum. Optional-time contract normalizes CRLF for Windows before extracting actual editor functions. Three unrelated obsolete baseline sidebar/visual contracts remain recorded in the audit; product/runtime navigation is covered by focused tests. Mobile/Fold/other viewport work excluded by user.

Independent code-health review found no blocking product issue. Source/dist synchronized at `2026101106`. Screenshots: local `tmp/consolidated-qa/floor-total-desktop.png` and `tmp/owner-dashboard-qa/`. Production release confirmation is recorded after deploy.

## Data safety

Guarded canonical deploy, final backup/restore verification, `SKIP_MENU_SEED_ONCE=true`. No production fixtures, account changes, DB reset/restore or catalog rewriting. Client/taxonomy/stock counts and hashes must match before/after.
