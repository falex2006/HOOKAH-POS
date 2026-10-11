# MT-04 — качество кода страничного пакета

Дата: 11 октября 2026. Роль: code_health_engineer. Baseline `7b8ef7ed`, исходно чистое дерево кроме ранее существовавшего tmp/. Прочитаны профиль роли и AI_TEAM_WORKFLOW, существующие MT-03 границы resolver, shared UI, notice и native editors. Проверяющий не менял исходники.

## Начальные риски

Главные риски этого этапа: страничная CSS specificity и light preference; hidden floor/staff ветви mixed admin; native body-mounted overlays без собственного происхождения; async completion с новым activeElement/tenant/route вместо исходного контекста; disabled/readonly/focus и custom-select lifecycle. Координатору передана рекомендация capture до await, точечный attach после mount, сохранение существующего adapter и source/dist parity.

## Проверенный финальный пакет

Прочитаны diff portal.js и ui-dialog.js, весь добавленный блок management-theme.css, изменения подключений/cache revisions и MT04_ROUTES_REVIEW. CSS добавляет реальные domain consumers главной, склада/меню/техкарт, финансов, операций и настроек. Каждый новый selector привязан к точному marker и отсутствию checking guard; глобальных body/root tokens и новых разрешений нет. Данные, периоды, финансовые formatters и SVG geometry не редактируются. Native directory/finance-category editor получают отдельный root/backdrop.

51 реальный click/submit/change handler получает локальный notice binder. Проведено read-only механическое сравнение всех 45 diff hunks с этими вставками: после удаления binder и восстановления только имени callback parameter исходный и новый текст совпадают без различий whitespace. Во всех таких hunks API вызовы, payload, проверка прав, ветви success/error и бизнес-вычисления сохранены. Остальные hunks просмотрены отдельно: изменения ограничены ticket capture/forwarding, explicit native attach, per-open critical options, reservation finish notice и cache revision.

Точные origins: native directory editor.opener, native finance editorOpener, inventory movement opener до editor.ready, orders refund кнопка строки до refundShellReady, ordinary scope opener до shared UI load, reservation opener до await и ticket результата finishReservationSave. Notice binder захватывает один ticket в начале handler и переносит его через async branches. Глобального fallback по pathname/body/current activeElement не добавлено.

Shared UI honors explicit null через Object.hasOwn для ordinary и critical options. Critical open({managementTicket}) имеет per-open slot; аргумент без ticket сохраняет прежнее fallback поведение. Focus/return, pending block, leases, draft/cancel и form adapters не заменены. Не включённые native browser confirm/prompt/date picker/reportValidity остаются браузерными, как указано route review.

## Замечания

Новая неблокирующая неоднозначность static critical options.managementTicket=null первоначально использовала || fallback и могла recapture. Передана координатору; заменена Object.hasOwn и повторно прочитана. Известных блокирующих дефектов после исправления не найдено. Старые native confirm/prompt, отсутствие полного runtime всех ролей и прочие ограничения каталога не приписываются этому diff.

## Проверки и границы доказательства

- node --check portal.js и ui-dialog.js — PASS.
- git diff --check — PASS; только сообщения Git о будущей нормализации LF/CRLF, ошибок diff нет.
- Read-only механическая сверка: 51 binder insertion в 45 hunks, все 45 эквивалентны baseline после удаления этих presentation-only вставок.
- Broad tests, новые tests, DB и production действия этим reviewer не выполнялись.
- Координатор передал финальный PASS шести source/dist hash сравнений, node syntax portal/ui-dialog/sync и git diff --check. Cache revision: management CSS 2, ui-dialog 3, portal/bootstrap 2026101108.

## Последняя дельта и локальное браузерное доказательство

Повторно прочитаны последние узкие правки: purchase receipt opener берётся из подключённой кнопки текущего remount; task open захватывает ticket до shared UI await и передаёт ui.open; payroll spacing задаёт section gap 16, results gap 12 и reversal margin 24 в прежней scoped области. API/payload и domain gates этими правками не меняются.

Координатор подтвердил owner desktop 1440×900 на localhost:31934 с in-memory backend: native inventory category и finance-category dialog marker mt; purchase marker mt после opener fix, Cancel возвращает фокус receipt; shared task marker mt; recipe empty-ingredient notice marker mt без API/save. Company проверен в light/dark, floor/staff branches исключены; `/admin#staff`, `/admin#permissions` и `/` имеют 0 markers. Последняя DOM проверка gap 16 и Console warning/error [] передана координатором. Это его runtime evidence, а не самостоятельный браузерный прогон reviewer.

Локальный payroll ответил существующим payroll_scheme_owner_only, поэтому полноценная проверка payroll и PostgreSQL не заявляется. Runtime других ролей, полный business E2E, native browser UI, mobile/Fold и production не подтверждены. DB/customer writes, новые и broad tests не выполнялись.

**Финальный статус: source/diff PASS; известных блокирующих замечаний нет.** Публикация production и приёмка MT-05 этим документом не заявляются.
