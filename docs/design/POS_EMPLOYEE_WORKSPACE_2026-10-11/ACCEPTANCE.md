# Локальная приёмка рабочего места HOOKAH POS

**Результат: локальная реализация принята в согласованной области.** Зал остаётся основным экраном; приготовление открывается одним действием. Выбранный заказ показывает следующее действие, итог и оплату независимо от длины списка. Светлая и тёмная темы используют существующие семантические токены.

Дата: 11.10.2026. Worktree: `C:\Users\ADMIN\.codex\worktrees\pos-employee-workspace\HOOKAH CRM 2`, база `f7e7af1381cb081662b85c53447fd73cb935c6e6`. Изменения сохранены локально для просмотра. Исходный dirty checkout не редактировался. Push, merge, deployment и production операции не выполнялись.

После локального просмотра владелец запросил дальнейшую эстетическую доработку. Его уточнение про цветные верхние карточки и крупные значки выполнено отдельной итерацией: [COUNTER_POLISH.md](COUNTER_POLISH.md), CSS `rev=2`. Техническая приёмка выше не подменяет окончательную оценку внешнего вида владельцем; старые screenshots показывают предыдущую версию карточек.

Финальная визуальная доводка карточек столов, заказа и отступов выполнена следующей итерацией: [FINAL_POLISH.md](FINAL_POLISH.md), CSS rev3 / app rev2026101108. Свежие dark/light screenshots, фактический Edge preview и matrix находятся в evidence/final-polish/.

После замечания владельца внешний двойной контур выбранного стола убран: [SELECTION_POLISH.md](SELECTION_POLISH.md), CSS rev4. Остаются тонкая рамка 1px и мягкий фон, отдельно сохранён keyboard focus.

## Как выглядит результат

Снимки настоящего локального приложения с отдельными тестовыми данными, а не генерация макета:

| Экран | Тёмная тема | Светлая тема |
|---|---|---|
| Зал и выбранный заказ | [Открыть](evidence/final-floor-dark-1366.png) | [Открыть](evidence/final-floor-light-1366.png) |
| Приготовление | [Открыть](evidence/final-preparation-dark-1366.png) | [Открыть](evidence/final-preparation-light-1366.png) |
| Существующий сценарий оплаты | [Открыть](evidence/final-payment-dark-1366.png) | [Открыть](evidence/final-payment-light-1366.png) |

Главная кнопка меняется по подтверждённому состоянию: добавить первую позицию → отправить новые позиции → открыть оплату. Для известного направления сотрудник не выбирает бар/кальян повторно. Неизвестное направление требует явного выбора. Подтверждения обозначают станцию; персональное назначение исполнителю сервером не поддерживается.

## Матрица требований и доказательств

| Требование промпта | Проверенный результат | Доказательство |
|---|---|---|
| Operational/owner, bar-only, hookah-only, обе станции, отказ доступа, tenant isolation | PASS. Шесть role contexts и пять соседних shell contexts. Manager/owner видят обе разрешённые станции, работники свою. Cleaner получает отказ; чужие данные не появляются. | [ROLE_QA.md](ROLE_QA.md), live role API/browser audit |
| Зал: несколько комнат, одна комната, пустота, пять состояний | PASS. Настоящая fixture содержит два зала, десять столов, пять статусов; empty/one-room дополнительно проверены явными GET response overrides. | [FUNCTIONAL_QA.md](FUNCTIONAL_QA.md), [state-qa.json](evidence/state-qa.json) |
| Стабильный порядок, badges, selection/focus, размер/«Вместить» | PASS. Очередь не меняет порядок столов; badges переживают смену зала и размера. `aria-pressed`, roving tabindex и arrows/Home/End проверены. | [floor-qa.json](evidence/floor-qa.json), [VISUAL_QA.md](VISUAL_QA.md) |
| Длинное имя, оборудование и длинный заказ | PASS компоновки в обеих темах. Полное accessible name, PS5/ТВ и один badge не пересекаются; длинный заказ прокручивается внутри панели. Сохранение искусственного long-name override в БД не заявляется. | [visual-preview-qa.json](evidence/visual-preview-qa.json), [VISUAL_QA.md](VISUAL_QA.md) |
| Первая/следующая позиция, авторство, отсутствие автоматической отправки | PASS настоящих API/PG мутаций, reload и draft. | [functional-qa.json](evidence/functional-qa.json), [FUNCTIONAL_QA.md](FUNCTIONAL_QA.md) |
| Mixed dispatch, unknown selection/cancel, pending/double click, partial failure/retry | PASS. Сохранённая часть остаётся; повтор включает только неотправленную. Отказ 409 и failed reread не дают ложного успеха/опасного повтора. | Browser 12 + state 7, runtime 26 checks, [CODE_HEALTH.md](CODE_HEALTH.md) |
| Очередь: права, take/ready, комментарий, время | PASS. Два сотрудника выполняют разрешённые станции. Сохранённый комментарий прочитан до ready и после reload. Неизвестное время не подменяется нулём; historical paid unfinished не перепривязан к новому заказу. | [FUNCTIONAL_QA.md](FUNCTIONAL_QA.md), [notes-qa.json](evidence/notes-qa.json), preparation backend QA |
| Ошибка чтения, повтор, смена сессии/venue | PASS. Заказы/очередь становятся неизвестными, stale dispatch запрещён. Зал при background 503 сохраняет последние столы с предупреждением, убирает недостоверные badges; initial failure не обещает прошлых данных. Повтор восстанавливает чтение и не перехватывает focus после перехода пользователя к приготовлению. | [state-qa.json](evidence/state-qa.json), floor browser 5 PASS / errors=[] |
| Частичная и полная оплата, точный остаток, стол, идемпотентность | PASS. Реальные 1000 + 2950 = 3950; после первого платежа стол занят, после остатка заказ закрыт и стол свободен, ровно две payment rows. Backend отдельно подтверждает однократное складское списание и сохранение финансово закрытого заказа при завершении приготовления. | [final-ledger-qa.json](evidence/final-ledger-qa.json), `order-preparation-postgres-qa.cjs` — 123 assertions |
| Две темы, desktop и узкие viewport | PASS Chrome: 1366×768, 1920×1080, 768×1024, 390×844, 320×740, обе темы. Page overflow=0, CTA 48px в viewport, прочие проверенные цели ≥44px. | [VISUAL_QA.md](VISUAL_QA.md), viewport screenshots/measurements |
| Контраст, клавиатура, reduced-motion | PASS измеренных новых состояний. Обычный текст ≥4.5:1, значимые границы/иконки ≥3:1; focus виден, Enter/Escape работают, transitions 0s при reduced-motion. | [visual-final-effective-contrast.json](evidence/visual-final-effective-contrast.json), [VISUAL_QA.md](VISUAL_QA.md) |
| Гигиена, source/dist, packaging, финальный review | PASS syntax/diff/parity, static allowlist, Docker COPY и canonical sync. БД, API mutations и RBAC не менялись. Независимый code health не нашёл новых blockers. | [CODE_HEALTH.md](CODE_HEALTH.md) |

## Реально выполненные проверки

- Независимый clean PostgreSQL/browser replay: **12 functional + 7 state PASS**, без JavaScript exceptions; нормальные действия выполнялись настоящими API/PG, отказы 409/503 — явными Playwright overrides.
- Финальный read-only floor browser runner: **5 PASS**, errors=[]; включает delayed retry/focus и initial error. Данные БД не изменялись.
- Независимый backend `node scripts/order-preparation-postgres-qa.cjs`: **123 assertions PASS**, собственная случайная QA БД удалена runner после проверки.
- Code health: **22 выбранных контракта PASS**. Четыре сбоя воспроизведены также на неизменённой базе: `staff-catalog-refresh-runtime-qa`, `staff-catalog-load-state-contract`, `fold-responsive-contract`, `sidebar-navigation-contract`. Это документированный прежний долг harness/regex; весь общий suite не объявляется зелёным. Детали и владелец — [CODE_HEALTH.md](CODE_HEALTH.md).
- После последнего небольшого delta отдельно подтверждены syntax/parity, floor 5 PASS, dispatch runtime 26 checks, preparation UI и header shell contracts. Повтор полного mutating replay после изменений только warning/focus не требовался.
- Координатор лично просмотрел финальные dark/light снимки зала, приготовления и оплаты; независимый visual audit измерил компоновку, effective contrast, badges и доступность главного действия.
- Финальная гигиена: syntax 16 JS/MJS/CJS, семь source/dist пар, 51 локальная ссылка документации и 42 текстовых файла проверены; diff PASS, private paths ignored. [final-hygiene-qa.json](evidence/final-hygiene-qa.json).

## Что изменено

`app.js` / `index.html` интегрируют новый рабочий вид с имеющимися контролами. `pos-workspace.js` / `.css` отвечают за композицию, counters/badges, роли и геометрию панели. `pos-dispatch.js` выделяет последовательную отправку и подтверждённый partial result. Серверный diff добавляет только три публичных runtime assets; Docker и sync включают их в поставку. Опубликованные `dist` пары совпадают побайтно; `appRevision=2026101107`, новые JS assets `rev=1`, `pos-workspace.css rev=2` после визуальной итерации. Общий CSS, маршруты, разрешения, финансовые API и схема БД не переписаны.

QA runners и необходимые обновления DOM harness находятся в `scripts/`; прежние сценарии не удалялись ради PASS. Runtime release не должен включать private runtime, manifest, tokens, logs и test helpers. Они находятся в ignored `tmp/full-local-qa/`. Старые checkpoints/промежуточные снимки сохранены в ignored task archive; обязательные финальные evidence лежат рядом с этим отчётом.

## Воспроизведение

Из worktree, с подготовленным **guarded disposable PostgreSQL runtime**; адрес production использовать запрещено:

```powershell
$env:NODE_PATH='C:\Users\ADMIN\Documents\ChatGPT\HOOKAH CRM 2\node_modules'
$env:PLAYWRIGHT_PACKAGE_PATH='C:/Users/ADMIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
node scripts/pos-workspace-postgres-fixture.cjs
node scripts/pos-workspace-browser-qa.cjs
node scripts/pos-workspace-state-browser-qa.cjs
node scripts/pos-workspace-floor-browser-qa.cjs
node scripts/pos-workspace-postgres-fixture.cjs --stop
```

Functional/state runner требуют свежую собственную fixture и выполняются последовательно. Готовый manifest переиспользуется без reset, остановленный/failed не сбрасывается автоматически. Для нового replay после остановки координатор сохраняет старый private manifest в ignored archive, затем создаёт новую fixture. Не сбрасывать чужие БД, не делать общий seed. Floor runner read-only и рассчитан на состояние после functional/state. Подготовка и cleanup проверяют ownership, loopback, Docker label/image/volume и commandline собственного server PID.

После окончания всех приёмок `--stop` завершился PASS: собственный QA server остановлен, удалена только runner-owned случайная БД, manifest переведён в `stopped`, actor credentials из него удалены. Shared PostgreSQL container и чужие fixtures не удалялись. Локальный URL из функционального отчёта теперь не является работающим preview; сохранённые screenshots/evidence доступны независимо от сервера.

## Границы результата

Обновление между сотрудниками — polling раз в 30 секунд плюс focus/visibility и чтение после действий. Это не гарантированный мгновенный push. Последовательная отправка двух станций не атомарна; интерфейс показывает сохранённую часть и безопасный повтор.

Текущий сервер не предоставляет персонального исполнителя/проверку его наличия на смене, «Выдано гостю», возврат готовности, SLA, банковское/фискальное подтверждение и смену личности по PIN. Отдельной чистой base-role «бармен-кальянщик» нет; показываются существующие effective permissions без автоматической выдачи кадровых/управленческих прав. Эти функции зафиксированы как отдельные расширения в [CONTRACT.md](CONTRACT.md).

Приёмка локальная: desktop Chrome и эмуляция размеров. Физический сенсорный POS, Fold/шарнир, экранная клавиатура, Edge, печать и полный WCAG-аудит этим этапом не подтверждены. Новое приложение на VPS не публиковалось. Перед будущей публикацией необходим отдельный релизный workflow и актуальная серверная проверка.

Подробное исходное задание: [PROMPT.md](PROMPT.md). Этапы и роли: [PLAN.md](PLAN.md).
