# Финальная функциональная приёмка рабочего места POS

Дата: 11.10.2026. Независимая роль: `qa_engineer`. **Итог: PASS — полный чистый replay, 12 основных и 7 state сценариев.** Оба runner завершились с exit code 0 последовательно, без исправления или ослабления тестов в процессе. Browser JavaScript exceptions: 0.

## Среда и границы

Worktree: `pos-employee-workspace`. Реальный API: `http://127.0.0.1:46366`, fresh собственная disposable PostgreSQL БД. Перед стартом проверены готовый private manifest, exact base/root/ownerTag/state, живой собственный server PID, health 200 и исходный mixed fixture: пять строк, три новые. Координатор не изменял данные во время replay. Private tokens/логины/пароли и случайное имя БД не опубликованы.

Записи выполняли только назначенные runner в собственных disposable fixtures: dispatch, preparation transitions, payments, создание нового заказа и preferences. Shared/production данные не затронуты; reset/reseed и остановка сервера не выполнялись. Ошибки 409/503 моделировались Playwright route override, нормальные операции использовали настоящий API/PG.

## Последовательный replay

| Runner / этап | Подтверждено |
|---|---|
| `scripts/pos-workspace-browser-qa.cjs` — PASS, 12 сценариев | Счётчик готовых открывает действительно готовые orders; отмена выбора неизвестной station не отправляет запрос и возвращает focus; mixed partial dispatch сохраняет bar+unknown и оставляет hookah new; повтор отправляет только hookah, двойной click не дублирует; persisted dispatch переживает reload, порядок столов стабилен; bartender/hookah видят свои станции; реальные take/ready transitions согласуют все строки; частичная оплата 1000 сохраняет заказ и занятый стол; остаток 2950 закрывает заказ и освобождает стол с двумя payment rows; первые/следующие catalog items сохраняют авторство и draft; queue read error показывает неизвестный показатель, retry восстанавливает данные; JavaScript errors отсутствуют. |
| `scripts/pos-workspace-state-browser-qa.cjs` — PASS, 7 сценариев | Orders 503 делает counters неизвестными и блокирует stale dispatch, refresh восстанавливает; dispatch 409 не меняет статус оптимистически; подтверждённая bar запись плюс failed reread не предлагает опасный повтор; live identity/venue switch очищает прошлые table/queue данные; настоящие saved light/dark preferences переживают reload; пустой зал имеет явное empty state; один зал с десятью столами и длинным accessible name отрисовывается без изменения порядка. |

Команды выполнены именно в таком порядке из worktree:

```powershell
$env:PLAYWRIGHT_PACKAGE_PATH='C:/Users/ADMIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
node scripts/pos-workspace-browser-qa.cjs
node scripts/pos-workspace-state-browser-qa.cjs
```

Эти runner ожидают чистые собственные fixtures. Повтор на уже изменённой БД не заменяет clean replay; для повторения нужен отдельный согласованный fresh fixture, без сброса чужих данных.

## Дополнительное сохранение и повторное чтение

- Сохранённый комментарий mixed заказа проверен read-only в реальной `.preparation-comment` **до ready**, затем после reload. Проверка выполнялась до replay transitions, пока mixed ещё присутствовал в очереди. Комментарий не создавался и не подменялся browser route override. Evidence: [notes-qa.json](evidence/notes-qa.json).
- После обоих runner независимые GET повторно подтвердили mixed `paid=3950`, `remaining=0`, `closed=true`, ровно две payment rows и `table.status=free`. Историческая financially closed unfinished работа остаётся в preparation queue. Evidence: [final-ledger-qa.json](evidence/final-ledger-qa.json).
- После финального assets sync `scripts/header-shell-contract.mjs` — PASS, `scripts/staff-shell-parity-qa.mjs` — PASS. Их прежние parity failures из `ROLE_QA.md` разрешены. Зафиксированный sidebar regex baseline debt остаётся отдельным пунктом координатора; этим replay он не изменялся.

## Финальные screenshots

Chromium/Chrome headless, 1366×768, reduced motion и завершённые CSS animations. Сняты **после успешных runner**. Light/dark screenshots используют только локальное отображение CSS темы; сохранение настоящих session preferences подтверждено state suite выше. Payment modal открыт настоящим UI на существующем ready заказе и закрыт Cancel. Дополнительных payments или preferences при съёмке не создано: read-only перехватчик не зафиксировал изменяющих API-запросов, payment ledger до/после полностью совпал.

| Вид | Тёмная тема | Светлая тема |
|---|---|---|
| Приготовление | [final-preparation-dark-1366.png](evidence/final-preparation-dark-1366.png) | [final-preparation-light-1366.png](evidence/final-preparation-light-1366.png) |
| Оплата | [final-payment-dark-1366.png](evidence/final-payment-dark-1366.png) | [final-payment-light-1366.png](evidence/final-payment-light-1366.png) |

Rendered output осмотрен: основной текст, станция и статусы читаются; строки и кнопки приготовления не перекрываются; modal оплаты, inputs, focus и submit находятся внутри viewport. Старые `preparation-1366-*` и прежние checkpoint artifacts относятся к промежуточным проверкам; финальное доказательство — указанные `final-*` файлы и latest successful JSON.

Итоговый machine evidence: [functional-qa.json](evidence/functional-qa.json), [state-qa.json](evidence/state-qa.json), [final-screenshots-qa.json](evidence/final-screenshots-qa.json).

## Что здесь не подтверждается

Это локальная приёмка Chrome на disposable PG, не production/staging deploy и не Edge или физический POS terminal. Полный viewport/theme visual matrix выполняет design lead отдельно. Фискализация, подтверждение эквайринга, персональное назначение station работ, выдача гостю и realtime/WebSocket не представлены текущим серверным контрактом. Проверка отсутствия двойного складского списания требует отдельного backend regression; данный browser replay доказывает сохранение двух реальных payments при двойном click, закрытие заказа и согласованный статус стола.

Продуктовые и назначенные test files в этом независимом replay не изменялись. Добавлены только этот отчёт, sanitized evidence и ignored read-only helper для notes/screenshots. Сервер оставлен работающим; дальнейший владелец — координатор интеграции.
