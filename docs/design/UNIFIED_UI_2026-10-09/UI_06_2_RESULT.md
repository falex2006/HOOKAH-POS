# UI-06.2 — Остатки, пополнение и премиксы

Дата: 2026-10-10. Статус: **ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**. Выполнена только презентационная правка inventory stock, auto-orders и premixes. Production/VPS/GitHub публикация не выполнялась. UI-07.1 не начат.

## Изменения

Три operational inventory views используют согласованные C02/C09/C14 primitives и scoped semantic-token CSS. Добавлен поиск по рекомендациям автопополнения и партиям премикса; несоответствующие строки скрываются без перестройки исходного порядка, состояния выбора и количества сохраняются при перерисовке. Остатки сохраняют критические статусы, порядок и доступные действия; sticky table header и существующие responsive table behavior сохранены.

В светлой теме исправлены контраст динамических полей, панель приготовления, активная вкладка пополнения и действия партий семантическими токенами.

Чтения склада/премиксов защищены поколением запроса и актуальностью целевого узла. Поиск не подменяет состояния загрузки и ошибки пустой выдачей; ошибки показывают retry, а неизвестные KPI остаются `—`. Автозаказ показывает отдельные loading/error/retry и filter-empty состояния. Для премикса сохранены prerequisite блокировка формы и понятное направление следующего шага; история партий доступна на retry и в readonly режиме.

Изменены `portal.js`, `style.css` и их точные `dist/` копии. Backend, API/payload, tenant scoping, права, маршруты/shell/sidebar, количество, себестоимость, единицы, parser, batch lifecycle, write handlers и idempotency не менялись. Финальные SHA-256: portal `40794456c49de0c2cccdb60301a7dc4d0ee211be1959fceb3a839ab151c9b207`; style `c2fd32136e18394d8b32b391ea3dedc392dfdee22feb3778c3ac8eda92e6dd85`. Dist совпадает побайтно.

## Проверки и доказательства

- Source runtime: 8/8 PASS; stock search/loading/error/retry, stale GET guards, auto-order search/preserved selections and quantities, premix retry/read-only/prerequisite/race states.
- Code health: 19 focused checks PASS; 13/13 frozen stock-status, auto-order math/write, premix production/lifecycle, unit conversion, parser and cost spans unchanged. `node --check`, `git diff --check`, exact source/dist parity PASS. Server and DB source remain equal to intake.
- Browser/pixel QA: 52 final evidence bindings PASS, including owner Edge ready captures in light/dark. IAB views checked at 390, 1366, and 1920 widths; loading/error/retry, empty/filter-empty, search, long labels, visible actions, and critical-stock salience covered. JPEG dimensions and image/source hashes match all 52 pairs. Ready matrix: 18 IAB owner frames plus 6 actual Edge frames (1528×780 DPR1.25); manager has 6 readonly frames. Source UI-06.1 regression also passes 35/35. Only visible frame content is accepted; below-fold actions are not asserted from a top screenshot.
- Real isolated API→GET→PostgreSQL: three accepted GUI writes and readbacks in temporary venue `bea9e9cc-10ce-42a1-a05a-add3b69fb232`, database `hookah_ui012`: one zero-stock inventory item, one auto-order and one 100 ml premix production. Premix consumed 50 ml of ingredient at 0.5 ₽/ml; DB shows ingredient 500→450 ml, output 0→100 ml, batch total cost 25 ₽. Auto-order lines were 45 and 20 units, estimate 32.5 ₽. Two production movements were added; setup movement is excluded from accepted writes. Ten finance journals remain unchanged at zero. Three injected 503 rejections happened before upstream writes and are excluded from successful transactions.
- Role API: 15 GET checks across owner, manager, bartender, hookah master and other staff; owner/manager inventory reads return 200 and limited staff reads return 403. Twelve non-owner write attempts return 403. Manager readonly stock, auto-orders and premixes were captured in both themes; three worker roles have actual denied-page captures.

Reproducible final evidence is archived at [acceptance/manifest.json](evidence/UI-06.2/acceptance/manifest.json); working copies remain in `tmp/ui062/` (`frontend-result.md`, `qa-source-results.md`, `health-final.md`, `qa-pixel-review.md`, `api-proof.json`, `role-api-proof.json`, `evidence-contract-report.json`, and `architect-final.md`).

## Ограничения и долг

- Readonly auto-order quantities still use inherited editable display inputs. No selection or submit control exists for manager, and server rejects writes with 403; local edits are not persisted. Static/disabled presentation remains separate polish.
- During the first auto-order GET, its create button is briefly enabled before recommendations load. This inherited initial markup is unchanged from intake; the handler sees no selected recommendation rows and returns before POST. GET errors disable it; once loaded, the normal no-items gate applies. Record as low-priority UI affordance debt, not a data-integrity blocker.
- At 390 px, the inherited page shell leaves an approximately 78 px blank strip. This belongs to the shared narrow shell and is outside UI-06.2; review in UI-10.1.
- No exhaustive cross-product of every role × theme × read state, numeric WCAG contrast audit, full inventory lifecycle, or PIN re-entry matrix was performed. Only the stated isolated production scenario was written; no waste/count/void/receipt/deletion operations were exercised.
- `inventory-form-pending-qa.mjs` has a baseline fixture failure because it extracts the renderer without injecting the already-existing `mountInventoryCatalogPresentation`; it was not introduced or repaired here. An earlier runtime attempt could not connect to localhost:3000; isolated server/DB proof subsequently passed as described above.
- Workspace has inherited unrelated WIP. Acceptance IAB tabs were closed, fixture owner-dark/manager-light preferences restored, and the actual Edge preview was reset before its final matrix. After a CUA kernel reset the Edge session became debugger-detached; final Edge close/reset cannot be independently confirmed. User production tabs were not touched. Own proxy31966 was stopped after PID/command-line identity verification; preview31952/31957, backend31953 and PG31954 listeners were preserved. IAB reset/close succeeded. Edge final close remains unconfirmed after debugger detachment; its last successful size reset was before the actual-window matrix. Cleanup observations are archived.

Next: UI-07.1, recommended GPT-6.1 Sol / High. This stage does not authorize publication or automatically start the next stage.
