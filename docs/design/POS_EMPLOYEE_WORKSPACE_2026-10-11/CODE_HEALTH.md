# Итоговая проверка кода и границ выпуска POS

Дата: 11.10.2026. Роль: `code_health_engineer`. Проверен worktree `pos-employee-workspace`, основанный на `origin/main` / `f7e7af1381cb081662b85c53447fd73cb935c6e6`. Исходный dirty checkout не изменялся этим аудитом. Push, merge, deploy и операции с QA fixture не выполнялись.

## Заключение

В финальном product diff новых блокирующих дефектов не найдено. Из 26 выбранных контрактов 22 завершились с exit 0. Четыре оставшихся ошибки воспроизведены на исходном HEAD и относятся к ранее существовавшему долгу проверок. Это не означает полностью зелёный общий regression suite.

После интеграции `renderZone` и клавиатурного переключения залов повторно прошли все 22 применимых проверки, синтаксис и source/dist parity. Последующие малые deltas проверены отдельно ниже, без новых блокирующих замечаний. Сценарии PostgreSQL и настоящего браузера выполнялись координатором и независимым QA; их отдельные отчёты не подменены статическими проверками этого документа.

## Проверенный diff

- `app.js`: единая отправка, динамическое основное действие, чтение и ошибки очереди/заказов, согласованное обновление floor/orders/preparation, комментарии из актуальных orders, переключение рабочего вида и залов.
- `pos-dispatch.js`: подходящие строки, явное направление неизвестной позиции, последовательные station requests, подтверждённая частичная отправка, остановка при смене access/token/venue.
- `pos-workspace.js` / `.css`: счётчики из подтверждённых данных, строгая готовность всех строк, суммирование split orders на столе, переустановка badges после отрисовки зала, динамический scroll body заказа и viewport height, существующие semantic tokens, reduced motion.
- `index.html`, `server.js`, `Dockerfile`, `scripts/sync-published-assets.mjs`: загрузка новых modules до `app.js`, публичный allowlist, packaging и опубликованные копии.
- Изменённые QA harness и четыре новых `pos-workspace-*.cjs` runner: сценарии, допустимые окружения, отсутствие сохранённых credentials в исходниках.

Проверены исправления интеграции: demo polling не запрашивает серверную авторизацию; сумма основного действия не сохраняется в устаревающем cache; после неудачного reread отправка заблокирована; dispatch и preparation transition используют захваченные headers/token и context guard; отзыв доступа очищает filter и очередь; badges учитывают все активные заказы стола. Неизвестное направление не выбирается автоматически, отмена диалога восстанавливает focus. Готовность определяется по всем items, независимо от финансового состояния заказа.

Order wrapper перемещает существующие DOM nodes один раз; ссылки и обработчики сохраняются. Resize callback объединён через requestAnimationFrame, меняет CSS property только при изменении высоты. Scroll body отделён от суммы и основной кнопки. Roving tabindex и ArrowLeft/ArrowRight/Home/End используют тот же настоящий click путь выбора зала.

## Выполненные проверки

`git diff --check` — PASS. Сообщения Git о возможной LF → CRLF нормализации не являются ошибками diff. `node --check` — PASS для всех изменённых JS/MJS/CJS и новых modules/runners. `package.json` и lock-файл не менялись; отдельный dependency upgrade/audit не входил в этот пакет.

Все приведённые ниже команды выполнены из worktree; префикс каждой — `node scripts/`:

| Область | Scripts с exit 0 |
|---|---|
| Приготовление | `order-preparation-unit-qa.cjs` (19 cases), `order-preparation-ui-qa.mjs`, `pos-dispatch-runtime-qa.mjs` (26 checks) |
| Оплата | `staff-order-payment-summary-runtime-qa.mjs`, `staff-partial-payment-pending-qa.mjs`, `pos-order-pricing-snapshot-contract.mjs` |
| Столы/каталог/modal | `staff-table-elapsed-qa.mjs`, `staff-table-density-qa.mjs`, `staff-catalog-add-pending-qa.mjs`, `pos-modal-a11y-contract.mjs` |
| Общий каркас | `staff-workspace-polish-qa.mjs`, `staff-shell-parity-qa.mjs`, `staff-mode-navigation-contract.mjs`, `header-shell-contract.mjs`, `staff-header-actions-runtime-qa.mjs`, `staff-observer-stability-runtime-qa.mjs`, `ui-navigation-context-contract.mjs` (56 checks) |
| Дизайн | `ui-semantic-token-contract.mjs`, `ui-component-primitives-contract.mjs`, `local-design-contract.mjs` |
| Выпуск | `local-deploy-contract.mjs`, `local-static-boundary.mjs` (29 private paths, 14 routes, 37 resources, Docker manifest) |

Дополнительная проверка новых assets: все 32 используемых `--ui-*` tokens определены в существующем `style.css`; в новом CSS нет raw hex/RGB/HSL цветов. Modules стоят перед `app.js`. Это подтверждает source contract обеих тем, но само по себе не измеряет browser contrast или геометрию.

Worktree не имеет собственного `node_modules`. Для запуска локального static server использована существующая зависимость `pg` через process-local `$env:NODE_PATH='C:\Users\ADMIN\Documents\ChatGPT\HOOKAH CRM 2\node_modules'`. Без этого server завершался до readiness. С указанным runtime `local-static-boundary.mjs` прошёл; install/package changes не требовались.

## Baseline debt — отдельно от регрессий

Исходное поведение подтверждено запуском неизменённых проверок с in-memory чтением соответствующих source и dist из `git show HEAD:<path>`. Checkout и файлы baseline не переписывались.

| Script / место | HEAD и текущий результат | Первопричина / минимальное отдельное исправление |
|---|---|---|
| `staff-catalog-refresh-runtime-qa.mjs` | exit 1 после напечатанного PASS | DOM mock не имеет `search.focus`; поздний timeout бросает TypeError. Дополнить mock настоящими необходимыми DOM methods, сохранить сценарии. |
| `staff-catalog-load-state-contract.mjs:18` | FAIL | Exact regex требует старый короткий click handler, хотя реальный handler также управляет accessibility/focus. Проверять refresh внутри фактической границы handler. |
| `fold-responsive-contract.mjs:41` | FAIL | Regex ожидает прежний compact-map алгоритм, отсутствующий уже в HEAD. Согласовать контракт с актуальным floor density; не выдавать эту проверку за browser Fold acceptance. |
| `sidebar-navigation-contract.mjs:5` | FAIL | Literal ожидает старую сигнатуру `normalizeManagementSidebar`, отсутствующую в HEAD. Согласовать с владельцем общего каркаса. `portal.js` этим пакетом не менялся. |

Владелец долга: координатор и владельцы QA/общего каркаса. Приоритет P3, отдельный пакет. Сбои не скрыты и проверки не ослаблялись.

Новые расхождения harness устранены: `order-preparation-ui-qa` проверяет актуальный подтверждённый station success text; `staff-header-actions-runtime-qa` использует новый end marker вместо удалённых `.actions button`. Все прежние сценарии opening/closing/errors/retry/doubleclick/payload сохранены; добавлена проверка обновления основной кнопки для пяти shift states и guard до mounting. Ранее существовавшие elapsed/payment mock ошибки также исправлены в своих harness без изменения продуктового API ради тестов.

## Source/dist и packaging

SHA-256 bytes source/dist совпадают для `app.js`, `index.html`, `pos-dispatch.js`, `pos-workspace.js`, `pos-workspace.css`, а также неизменённых `style.css` и `portal.js`. `appRevision=2026101107`; новые assets подключены с `rev=1`.

| Source | SHA-256 финальной проверки |
|---|---|
| `app.js` | `3B9E863695B6D163FA7C661A6A9074F9BDC5232F16B3B7B9A623395BEA654FE8` |
| `index.html` | `9A6FA7B1E36FA80AA7E235C5A968393BD15E03E749FF0C425B9D91C07D72CA79` |
| `pos-dispatch.js` | `A7B67C8ABDF3B29F27F3D2A317600C540C35021BC85AB590229A1E0551F02E1A` |
| `pos-workspace.js` | `5C56C6E9B7FCC5BBFBF2B94ECA865DFB5AB61C971AD6D7FF005AD71AE3F91A08` |
| `pos-workspace.css` | `1BBF365C31FB07A7847647B07B7969375F5092573EFF7AD2680F2099BF10189E` |

Новые runtime assets включены в явный Docker COPY, server static allowlist и canonical source/dist sync. `.dockerignore` не исключает их и исключает `.git`, `node_modules`, `tmp`, `.env*`, logs. Другой список runtime assets в Compose/deploy не обнаружен. Серверные API/схема БД/миграции/права в этом пакете не изменяются; server diff ограничен static allowlist.

В runtime release входят только согласованные source/dist assets и явные packaging изменения. `tmp/`, private manifest/runtime/log/helper, ранние `*-checkpoint.json` и промежуточные screenshots не включать в release assets. Итоговые screenshots/JSON являются отдельными QA evidence; выбирать их явно для документации, не stage-all весь каталог. Все проверенные private fixture пути подтверждены как git-ignored. Secrets/private manifest в отчёт не копировались.

## Безопасность и воспроизводимость новых QA runners

`pos-workspace-postgres-fixture.cjs` проверяет exact loopback31931, ownership Docker label, image, AutoRemove, единственный anonymous volume без bind mounts, ожидаемые database identity и config. Создаёт случайную `audit_qa_<16 hex>` БД после проверки отсутствия, новые UUID и случайные credentials. Запись private manifest/server helper находится только в ignored tmp. Вывод startup/errors sanitizes credentials. Production target и существующие business fixtures не используются.

`--stop` требует ownerTag/root/random database, заново проверяет Docker guard и commandline своего server PID, затем останавливает только собственный process и удаляет свою БД. Partial/stopped manifest не сбрасывается автоматически. Эти операции этим аудитом не запускались.

Browser/state/floor runners проверяют root, ownerTag, ready manifest и loopback base; не имеют встроенных credential literals. API mutations основного и state replay направлены только на owned fixture. Floor runner делает GET и явно помеченные rendering overrides; theme toggle в нём локальный. Error exits ненулевые; functional/state сохраняют sanitized checkpoint, который не является success evidence.

Для воспроизведения нужен guarded private runtime, доступные `pg` и Playwright, установленный Chrome (`channel:'chrome'`). Порядок: подготовка свежей owned fixture → `pos-workspace-browser-qa.cjs` → `pos-workspace-state-browser-qa.cjs` → `pos-workspace-floor-browser-qa.cjs`. Functional/state намеренно изменяют fixture; повторный запуск на уже пройденной fixture не обещает исходных draft/payment состояний. Existing ready fixture переиспользуется без автоматического reset; для нового clean replay координатор отдельно управляет завершённой private fixture. Это safety boundary, а не обещание idempotent rerun.

## Проверка последнего малого delta

После основной серии отдельно проверены малые финальные изменения. `renderTableBadges` устанавливает `aria-pressed` из существующего `sel` для каждого стола до ветки наличия badges, поэтому доступное состояние есть также у столов без приготовления. Scoped `opacity:1` для `preparation-head p` и `preparation-row small` убирает прежнее дополнительное ослабление текста; существующий `--ui-text-secondary` и обе theme maps сохранены.

Повторный `node --check app.js` / `pos-workspace.js`, синтаксис актуального floor browser runner, `ui-semantic-token-contract.mjs`, прямой contract новых 32 tokens/двух opacity overrides, `git diff --check` и все семь source/dist пар — PASS. Неизменённые hashes выше сохранены; hashes изменённых assets обновлены. Причин расширять эти небольшие deltas до повторного полного regression не обнаружено.

Ошибка или stale состояние floor теперь отображает предупреждение и настоящий GET-only retry через `refreshFloor({background:true})`, затем актуализацию orders. Формулировка про последние данные зависит от `floorReady`; первая неудачная загрузка не обещает сохранённого floor. Async retry использует существующие read guards и singleflight. При завершении focus восстанавливается только если прежняя кнопка удалена и активным остаётся body: к новому retry при повторной ошибке, иначе к «Зал». Если пользователь уже выбрал другой control, focus сохраняется. Первоначально найденные focus-steal и неточная initial-error формулировка исправлены координатором до приёмки.

Отдельная in-memory VM проверка фактического source callback — PASS: четыре async исхода focus (успех, пользователь перенёс focus, старый node остался, новая retry после ошибки) и две формулировки initial/background warnings. Проверка не копирует реализацию обработчика и не пишет fixture/product/test files.

Координатор выполнил финальный `pos-workspace-floor-browser-qa.cjs`: прочитанный `evidence/floor-qa.json` содержит 5 PASS и пустой errors. Проверены `aria-pressed` выбранного/остальных столов, zone arrows/Home/End и focus, badges после zone/density/fit в обеих темах, background floor503 с сохранением последних столов/скрытием stale badges, delayed retry без перехвата focus, initial floor503 и успешный retry, агрегирование split orders, длинные названия и equipment. Retry не меньше 44px, основная CTA остаётся в viewport. Fault/split/long-name cases используют явно обозначенные rendering overrides и не подтверждают создание таких сущностей в БД. Новые screenshots `floor-regression-*` не перезаписывают canonical final-floor evidence. Визуальное измерение контраста относится к отдельной browser acceptance; этот code-health audit подтверждает CSS cascade/token contract.

Данный аудит самостоятельно не выполнял browser mutations, не менял fixtures, не подтверждает VPS/production, Edge, печать или полную WCAG-сертификацию.
