# Employee POS release — 2026-10-13

Candidate integrates the agreed employee floor/preparation/payment package onto origin/main 507e51ff, preserving already published management theme and sidebar changes. No new database schema or migrations; employee payment summary adds a read-only API.

Release QA: isolated PostgreSQL employee-payments 79 assertions PASS; integrated browser buttons/permissions 12 groups PASS; fresh browser login/logout for bartender, hookah master, manager and owner PASS with database-backed token revocation verified. Catalog assertion updated to the scoped handler. A pre-existing logout persistence failure was repaired: await database revocation; preserve client session and show a retryable error when server logout fails.

Local-design, static boundary, clickability, deploy contract, platform/SaaS boundary, syntax and source/dist checks pass. Separate disposable order creation/dispatch/preparation/reload acceptance is recorded below when complete. No live financial writes are used for release QA.

Production procedure: publish reviewed Git commit through PR; build exact merged commit; preserve environment, PostgreSQL volume and rollback image; verified backup/restore; skip menu reseed; verify health/release identity, unchanged business-data fingerprints and public asset hashes. Production receipt will identify the exact deployed commit and verification outcome.

Actual disposable PostgreSQL order flow: PASS. UI-created order and added bar item, dispatch queued, reload, accepted in progress, marked ready, and a fresh page/GET confirmed ready. No production writes. Evidence: docs/design/POS_RELEASE_2026-10-13/evidence/order-flow.json and order-ready.png.
