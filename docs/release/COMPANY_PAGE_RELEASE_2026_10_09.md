# Company page audit and release — 09.10.2026

## Findings and fixes
- Late dashboard preference reads exposed unrelated blocks on admin#company. Shared focused-route predicate now preserves route ownership; no MutationObserver workaround.
- Company identity fields grouped; compact section navigation; main/header titles agree.
- Removed two misleading legacy VIP inputs: deposits are configured for real tables/rooms in the layout editor. Company PATCH no longer sends vipRoomMinimums.
- Persist valid saved timezone outside predefined Russian list.
- Persisted/selected logo preview, filename and removal through save; normalized API readback fills form.
- Five-phone limit is explicit; primary selection feedback and native radio dimensions improved.
- Reversal policy explanation shortened, restrictions retained in details; shown only on company route.
- Single 8-second opacity pulse around company page content, no travelling gradient; static reduced-motion and light/dark styles. Company modal sweep disabled only within this route.

## Evidence
System architect, frontend/design and code-health reviews completed. API QA31, form VM, delayed-route-preference regression, headings, visual rules, navigation52, preferences, sidebar/source-dist, employee-shell, design/click/static/deploy/boundary PASS. CSS409 / portal477.
Edge local authenticated admin: name save/reload; UTC preservation; persisted logo/readback/removal/reload; phone5 limit; company/interface/layout navigation; sibling sections hidden; light/dark and1366/1920 viewport inspection. No horizontal overflow. Production inspected read-only as owner before changes.
File picker upload blocked by Edge extension file-URL permission; permission unchanged. Selected-file handling covered by VM, persisted logo API and browser preview/removal checked. Mobile/Fold full acceptance deferred per user scope.
No database/API/migration/deployment changes. Production data not edited for QA. Final commit/archive/backup/post-deploy evidence recorded after deployment.
