# Local WIP audit and owner home release — 2026-10-11

## Release boundary

Old checkout: `C:/Users/ADMIN/Documents/ChatGPT/HOOKAH CRM 2`, HEAD `802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf`. Preserved without reset, cleanup, edits or wholesale publication.
Reference: published `origin/main` `3b07310252c76c9091d161e106a2786aef3e8ef7`.
Implementation: isolated managed worktree, branch `codex/owner-dashboard-wip-audit`.

All tracked/untracked paths were classified against main (text CRLF normalized, binary bytes compared). This is a file inventory plus focused runtime/release review, not a claim that the contents of every historic report were reviewed. Old checkout contains 899 tracked and 15,927 untracked paths; 7,883 local-only documentation/evidence and 7,899 temporary paths stay in place.

| Group | Same as main | Different | Local only | Missing locally |
| --- | ---: | ---: | ---: | ---: |
| Root runtime/config/docs | 125 | 33 | 0 | 0 |
| Published assets | 55 | 32 | 0 | 0 |
| Documentation/evidence | 188 | 15 | 7883 | 1 |
| Migrations | 100 | 1 | 1 | 0 |
| Scripts | 380 | 28 | 32 | 3 |

Full local inventory remains in worktree `tmp/local-wip-classification.json`; compact code/config discrepancy index is retained alongside this report. No secrets or thousands of evidence artifacts are published.

## Decisions

- Keep main server PIN authorization and venue/target-role guards. Old `server.js` removes guards: excluded.
- Keep main Dockerfile module copies (`table-minimum-schedule.js`, `ui-dialog.js`). Old file omits them: excluded.
- Keep guarded main deploy/migrate/backup flow. Old scripts lack write-stop/final verified backup: excluded.
- Keep table minimum start/end response fields in main server. Old response drops them: excluded.
- Keep main `schema.sql` / migration 091 ordering: suspend balance trigger before replay-safe insertion, restore afterwards. Old ordering can break repeat migration: excluded.
- Keep main lock preference saving: old lock.js ignores failed persistence and stale-read generations: excluded.
- `db.js` difference is import order/whitespace: no port needed.
- Root `effective-permissions.js`, `order-preparation.js`, `reservation-calendar.js`, `staff-display-name.js`, `ui-dialog.js` and migrations 099/100 already match main: no re-release.
- Follow-up integration: order totals on table cards are now implemented with canonical server pricing instead of the unsafe local subtotal. Catalog return-focus behavior and preparation status card are already in main; no duplicate port needed.
- Local `table-minimum-schedule.js` truncates strings to HH:MM; main strict validation retained. Investigate actual API/PG formats separately before changing.
- Local portal/UI code overlaps published work; no whole-file import. Focused staff removal was released in PR #28. Useful minimum-check error messages/validation and preparation success messages are integrated in the follow-up package; existing paired-time and input-change guards are retained.
- Local-only migration 098 and AlphaSat adapter utilities are a separate unfinished integration: no deployment.
- CSS button alignment release and shot category archive are already published; not reimplemented.
- Evidence/QA utilities remain preserved as an archive; publishing them is not necessary to keep the service working.

## Focused change

The roster/form is rendered and loaded only on `/admin#staff` and `/admin#permissions`, with existing permissions. Home `/admin` no longer has the staff panel or GET `/api/staff`. The staff sidebar route and administration remain intact. The retired home module toggle/default is removed; old `dashboardModules.staff=false` cannot hide the dedicated directory. Portal and bootstrap cache revisions are `2026101105`; canonical source/dist sync performed.

## Verification

- `node --check portal.js`, source/dist byte parity, `git diff --check`: PASS.
- `node scripts/owner-dashboard-staff-browser-qa.mjs`: PASS, isolated memory server, desktop 1440×900, owner login, no home roster/GET, legacy hidden-module preference, staff creation drawer open/close, permissions, settings and hash return, no JavaScript errors.
- `node scripts/dashboard-shift-deeplink-contract.mjs`: PASS.
- `node scripts/role-api-matrix-runtime-qa.mjs`: PASS, isolated role/venue API matrix.
- Canonical design/click/static-boundary/deploy/platform contracts: PASS.
- Independent system_architect and code_health reviews: no blocking issue in product diff.
- Existing `visual-page-rules-contract`, `sidebar-navigation-contract`, `sidebar-menu-audit-contract` do not pass baseline main: incomplete document mock and assertions for superseded sidebar implementation. No product changes made to satisfy obsolete strings. Recorded debt; focused runtime navigation test above passed.
- Mobile/Fold/additional viewport checks excluded by user. Screenshots saved under `tmp/owner-dashboard-qa/` and visually inspected.

## Deployment boundary

No server.js/db.js/schema/migration/catalog data changes in this package. Deploy uses canonical main guarded script with `SKIP_MENU_SEED_ONCE=true`; no PostgreSQL restore/reset/reseed. Client records and the manually configured departments, subdepartments/categories must be preserved. Release SHA, CI and live verification are recorded after publication.

## PR #28 live result

Merged/runtime commit `878761b1151984a82d10bb4814147637e30338f2`; both GitHub PR workflows succeeded. Canonical guarded VPS deploy passed, final backup restoration test passed, menu seed explicitly skipped, PostgreSQL volume `territory-crm_pgdata` retained. Before/after counts and full-row aggregate hashes exactly matched for guests (3), departments (8), subdepartments (12), product categories (35 including archived), products (71), ingredients (85). Public health reports PostgreSQL healthy.
