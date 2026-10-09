# Staff tiles and remaining packages — release 2026-10-09

## Scope
- Readable table tiles: status colors, large names, actual TV/PS5 vector badges, elapsed time bottom-right, geometry fallback and light-theme contrast.
- Queue duration in hours/minutes from persisted opening.
- Employee task cancellation blocked in UI and server; cancelled tasks read-only; safe automatic/manual refresh.
- Employee guest preferences before analytics, readable history references and stale-response guard.
- Accurate employee payment-date caption. No schema or financial-calculation changes.

## Acceptance
- Code-health baseline/final: no new blocker.
- Syntax and diff hygiene PASS.
- Existing table elapsed, design, workspace polish, guest/editor/history/race, task recovery/deadline, memory task CRUD, finance, header and shell checks PASS.
- Updated three stale harnesses without removing behavior coverage; task recovery adds visibility/concurrency/interaction/failure cases.
- New staff-tasks-release-qa --postgres: 79 assertions PASS. Executes shipped handlers against memory and real isolated PostgreSQL; includes bartender/hookah_master, management scopes, tenant isolation, forbidden cancellation/revival and injected assignment/cancellation races. Transaction cleanup verified. This is handler/SQL acceptance, not full HTTP PostgreSQL middleware testing.
- Edge local real HTTP: employee login, task open→in_progress→reload, no employee cancel choice, cancelled readonly; owner management choices and logout; finance caption; tasks390px document scrollWidth==clientWidth. Full Fold redesign remains deferred.
- Earlier local tile light/dark screenshots reviewed; no production order/task mutation during acceptance.

## Existing unrelated finding
local-floor-management-contract.mjs:27 also fails at base HEAD: legacy exact label regex ignores required-marker span. Not a new package regression; not in CI. Left unchanged.

## Release gates
GitHub CI must pass before merge/deploy. VPS deploy must create and restore-check backup, retain DB, verify health/session and match archive to merged SHA. User authorized GitHub/VPS on 2026-10-09.
