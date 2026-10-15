# Staff schedule release candidate — 2026-10-15

Base: `origin/main` `87946de45b60c0ed81a32315183fa921fd6f0aed`. Includes the existing premix/recipe release unchanged. Loyalty WIP is excluded. Adds migrations 113–115 for personal attendance, per-shift preparation and manager recovery.

## Changes

- Personal read-only calendar for active employees, self permission, tenant-scoped minimal DTO and colleagues' published shifts without private absence details.
- Management calendar visual hierarchy, avatars, selected-day styling, responsive views and 15-topic searchable guide available only to management viewers.
- Planning form retry/dirty-state fixes; source/dist synchronization and new asset revisions.
- Light-theme contrast, native date indicators, scoped sidebar/header colors and server-saved theme on direct calendar entry with session/route race guards.
- Personal attendance workflow: owner-configured admission rules and independent grants, exception requests/approval, in-app notifications, and audited manager completion with a required reason. Cash shifts and payroll remain separate.

## Candidate checks

- PASS: local design, click, static boundary, deployment, staff navigation, theme lifecycle, help (8), UI lifecycle (9), visual page rules, team, SaaS/POS boundary self-test and platform contract; npm audit has no vulnerabilities.
- PASS: fresh application child with guarded local PostgreSQL: personal HTTP five groups and cleanup; avatar DTO HTTP and cleanup.
- PASS: schema plus all 116 SQL migrations on a newly created disposable database in the guarded local container; database removed and absence verified. Migration QA also verified additive upgrade/replay and preserved existing table rows. This does not substitute for production preflight.
- Historical QA setup correctly refused migration 106's stored checksum mismatch; transaction rolled back. Digests were not rewritten. Preliminary migration 101 mismatch was EOL-only. Product migration contents remain identical to main.
- Browser CUA against this release tree at 127.0.0.1:31945: owner week/month/day, light assignment dialog and searchable guide; light month at 1280, 1366 and 1536 CSS-pixel widths; 320-pixel day view without document overflow; dark owner month and employee month/day with own shift and colleague. Owner console error list empty. Personal UI has no management/help actions.
- Screenshots: `docs/qa/staff-schedule-light-release-month.png`, `staff-schedule-release-dark-month.png`, `staff-schedule-personal-release-dark.png`.
- Independent code-health review found no blocking release-diff defect. Missing notifications/help route documentation in visual rules was fixed without changing routes or permissions.
- PASS: browser owner request review, approval and employee start; manager recovery with required reason; employee sees the saved completion reason. Owner rules/access screen confirms separate controls for policy, approval and recovery.
- PASS: attendance migration24 checks, service14 suites, notification50 HTTP checks, recovery12 PostgreSQL/HTTP suites, attendance HTTP61 checks and schedule preparation override10 PostgreSQL suites. All disposable databases were removed and cleanup verified; cash/payroll protected tables were unchanged.
- PASS: final independent code-health review found no new P1/P2 in the combined diff; all 45 changed/new JavaScript files passed `node --check`, and source/dist parity passed.

## Publication

GitHub PR #47 is open against `main`; both pull-request workflows passed on head `a2474fff9e8012a63b6c95eee6e4844640324167`. Merge and guarded VPS deployment are pending. No claim of production acceptance is made by this candidate note. Preserve production environment, PostgreSQL volume and backups; skip menu seeding. Deploy only the merged clean main commit after CI; verify health and exact public assets.
