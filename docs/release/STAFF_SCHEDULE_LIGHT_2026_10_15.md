# Staff schedule release candidate — 2026-10-15

Base: origin/main ed9d0c70acc0fe74de1f750471da1563fea7aa30. Includes the existing premix/recipe release unchanged. Loyalty WIP is excluded. No new migrations.

## Changes

- Personal read-only calendar for active employees, self permission, tenant-scoped minimal DTO and colleagues' published shifts without private absence details.
- Management calendar visual hierarchy, avatars, selected-day styling, responsive views and 15-topic searchable guide available only to management viewers.
- Planning form retry/dirty-state fixes; source/dist synchronization and new asset revisions.
- Light-theme contrast, native date indicators, scoped sidebar/header colors and server-saved theme on direct calendar entry with session/route race guards.

## Candidate checks

- PASS: local design, click, static boundary, deployment, staff navigation, theme lifecycle, help (8), UI lifecycle (9), visual page rules, team, SaaS/POS boundary self-test and platform contract; npm audit has no vulnerabilities.
- PASS: fresh application child with guarded local PostgreSQL: personal HTTP five groups and cleanup; avatar DTO HTTP and cleanup.
- PASS: schema plus all 113 main SQL migrations on a newly created disposable database in the guarded local container; database removed and absence verified. This proves clean installation, not an upgrade of the historical QA database.
- Historical QA setup correctly refused migration 106's stored checksum mismatch; transaction rolled back. Digests were not rewritten. Preliminary migration 101 mismatch was EOL-only. Product migration contents remain identical to main.
- Browser CUA against this release tree at 127.0.0.1:31945: owner week/month/day, light assignment dialog and searchable guide; light month at 1280, 1366 and 1536 CSS-pixel widths; 320-pixel day view without document overflow; dark owner month and employee month/day with own shift and colleague. Owner console error list empty. Personal UI has no management/help actions.
- Screenshots: `docs/qa/staff-schedule-light-release-month.png`, `staff-schedule-release-dark-month.png`, `staff-schedule-personal-release-dark.png`.
- Independent code-health review found no blocking release-diff defect. Missing notifications/help route documentation in visual rules was fixed without changing routes or permissions.

## Publication

GitHub CI and guarded VPS deployment are pending. No claim of production acceptance is made by this candidate note. Preserve production environment, PostgreSQL volume and backups; skip menu seeding. Deploy only the merged clean main commit after CI; verify health and exact public assets.
