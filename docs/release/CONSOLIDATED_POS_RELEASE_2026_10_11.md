# Consolidated POS improvements — 2026-10-11

Published application improvements: canonical order totals on occupied table cards, contextual preparation notifications, minimum-check validation, and owner dashboard without a roster. Existing button layouts, scheduled minimum, order statuses and the dedicated staff directory are preserved.

## Price contract

Floor requests `/api/orders?withPricing=1`. Legacy callers retain unchanged response. Optional `pricingTotal` is computed through the same `pgOrderPricing`/`memoryOrderPricing` as order summary, with at most four concurrent order calculations. Price failures are per-order nulls, not a guessed subtotal. Only active venue-scoped authorized orders are priced. No order writes, new DB fields or migrations. Display amount includes already paid share (full order total, not outstanding balance). Timer/status/amount have separate rows; numeric amount is never hidden by a textual prefix.

Performance: pricing reads per active order remain O(n); concurrency is bounded. Appropriate for this small venue. A future high-volume optimization may batch server calculations; it is not necessary to ship this verified behavior.

## Verification

PASS: isolated memory and disposable PostgreSQL paid-order suites (discount/promotion/minimum/partial-price lock, legacy response, unchanged state, tenant/role denial); floor total label helper (multiple active/zero/unknown/closed); desktop browser floor with 250-ruble item/1200 minimum (map/density/grid row bounds); owner dashboard/directory browser; schedule boundaries/optional controls/new editor validation; preparation unit/UI including acknowledged success message; design/click/static/deploy source/dist contracts and syntax.

Existing paid-memory VIP fixture was corrected to configure the authoritative table minimum, not send an ignored client minimum. Optional-time contract normalizes CRLF for Windows before extracting actual editor functions. Three baseline sidebar/visual test scripts have obsolete mocks/assertions; focused runtime navigation checks passed. Mobile/Fold/other viewport work excluded by user.

Independent code-health review found no blocking product issue. Source/dist synchronized at `2026101106`. Screenshots: local `tmp/consolidated-qa/floor-total-desktop.png` and `tmp/owner-dashboard-qa/`. Production confirmation is recorded below.

## Data safety

Guarded canonical deploy, final backup/restore verification, `SKIP_MENU_SEED_ONCE=true`. No production fixtures, account changes, DB reset/restore or catalog rewriting. Client/taxonomy/stock counts and hashes must match before/after.

## Production receipt

- PR #29 merged and deployed runtime `70d70ec5d4c77ff15681fc39404fa92db9c31f31`; both GitHub contract workflows passed. Public app.js, portal.js and style.css match this checkout after line-ending normalization (cache revision 2026101106).
- Guarded deployment completed; final backup restoration rehearsal reported PASS. CRM and PostgreSQL healthy; public `/api/health` returns ok/PostgreSQL. Existing `territory-crm_pgdata` volume retained; server checkout clean.
- Before/after full-row aggregate hashes and counts match exactly for guests (3), departments (8), subdepartments (12), categories including archived (35), products (71), ingredients (85). Customer data and configured taxonomy/stock were not rewritten.
- Read-only owner Edge check after deployment: `/admin` loads with no roster; working floor loads all ten free tables and empty preparation/order queues. No synthetic production order was created. Occupied-table amount, pricing rules and preparation actions were exercised in isolated local memory/PostgreSQL QA, not with customer records.
- Evidence retained locally under `tmp/consolidated-qa/owner-home-server-final.png`, `tmp/consolidated-qa/floor-total-desktop.png`, and `tmp/consolidated-deploy.log`. These temporary artifacts are not shipped as application files.
- This receipt is documentation only; it requires no further application deployment. The agreed POS integration is complete.
