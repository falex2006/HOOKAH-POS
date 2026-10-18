# UI-01.2 R2 — code health дополнительных фикстур

2026-10-09 · Независимая роль `code_health_engineer`. **Verdict: GO для одного контролируемого локального исполнения после сигнала координатора `GO_FIXTURES`, с рисками ниже. UI PASS не выдан.** На момент чтения fixture mutations и entity cache пусты; подготовка не является доказательством успешного создания данных.

## Проверено

Read-only просмотр `tmp/ui012-baseline/new-long-fixtures.cjs`, `UI_01_2_FIXTURE_PLAN_R2.md`, структуры `evidence/UI-01.2/r2/effective-permissions.json` и изменённой ветки `finalize-evidence.cjs`. Для точечной проверки контрактов прочитаны связанные handlers в локальном snapshot `source/server.js` (floor, recipes, products, shift). `node --check tmp/ui012-baseline/new-long-fixtures.cjs` завершился exit 0. API, SQL и fixtures данным ревью не исполнялись; продуктовые файлы и данные не менялись. Независимо проверен подготовленный исходник, diff после реального исполнения ещё отсутствует.

## Основания GO

- Target фиксирован на loopback proxy 31952; проверяются config container/database/dbPort, normal proxy, PostgreSQL health и `current_database()`. Перед mutation выбирается owner именно `long` fixture; session role/organization/venue сверяются с его credentials. `empty` tenant не используется для записи.
- Default mode `plan` завершает процесс до API/SQL; `--apply` требует явный дополнительный аргумент `GO_FIXTURES`. В `--permissions` non-auth POST запрещён helper guard. Запросы имеют timeout, ошибки прерывают выполнение; auth token остаётся в памяти, logout выполняется в finally.
- Подготовлены новый зал/шесть новых столов, четыре ингредиента с нулевым остатком, четыре новых продукта и четыре recipe metadata. В новые открытые заказы добавляются только два `non_stock` продукта; sale recipe связываются с двумя отдельными `tracked` продуктами. Dispatch использует explicit station и item IDs. Существующие восемь столов и учётные записи script не обновляет.
- Открытие смены `openingCash=0` происходит только при отсутствии открытой смены. Не предусмотрены payment/close/deposit receipt, stock production/depletion, payroll или finance endpoints. Premix создаётся как metadata без product binding и выпуска партии. На уровне прочитанного кода это соответствует заявленной области.
- Plan явно сохраняет непроверенные finance/payroll/produced batch/closed history регионы. Mutation log сохраняет синтетические payload/status/ID, исключая login/logout payload. Нельзя назначать long-content PASS только по успешному POST.
- Структура effective permissions на исходном checkpoint: девять role/fixture записей; platform без tenant, остальные восемь имеют venue/organization; `permissions` является массивом permission strings; `fixtureMutations=0`, `fixtureEntities=0`. Secret field names password/token/authorization/sessionSecret/dbPassword/appKey отсутствуют. Пароли/токены/значения приватного runtime не выводились. Политика прав и tenant isolation через API этим структурным чтением не доказаны. Коррекция R3: прежнее число «8 permission keys» было числом PowerShell properties массива, а не прав; фактические long fixture counts — owner 16, manager 9, hookah_master/bartender по 4. Выводы о login/session не меняются.

## Риски и минимальные меры

| Приоритет | Сценарий и первопричина | Владелец / минимальная мера |
|---|---|---|
| P2 | POST прошёл, но ответ/локальный save потерян: entity cache не записан, повторный apply может создать дубликат. Для столов `predicate=()=>false`; order items не имеют server idempotency key. | Координатор/backend instrumentation: при неоднозначном timeout остановить replay, сверить GET и ID; продолжать после восстановления cache. Plan уже требует эту меру. Не считать script полностью идемпотентным. |
| P2 | Reservation date вычисляется как UTC ISO day, хотя tenant timezone Asia/Yekaterinburg. В первые пять часов местных суток первая «будущая» бронь может попасть на текущий местный день. | Backend instrumentation: перед apply подтвердить шесть дат в timezone venue или вычислять local calendar dates в этой timezone. Для текущего дневного запуска риск не блокирует GO. |
| P2 | Созданы категории `UI012 R2 Длинная категория bar/hookah`, а продукты получают другие category strings `UI012 R2 bar/hookah`. Product POST принимает свободный category string; API-create может пройти, но фильтр UI по справочнику способен скрыть позиции. | Backend/QA: при повторном GET и browser review проверить видимость четырёх продуктов и их категорий; предпочтительно использовать имена созданных category metadata. Stock ingredient категории согласованы. Это не основание принимать каталог заранее. |
| P2 | API mutation/evidence file writes последовательны без общей транзакции; частичная ошибка оставляет уже созданные фикстуры. Cache сущностей хранится в evidence и при последующем resume доверяется без fresh GET. | Координатор: сохранять evidence, не делать rollback/delete автоматически; проверить entity IDs и tenant перед продолжением. После GO фиксировать реальное число созданных сущностей и список незавершённых шагов. |

Дополнительное ограничение: создание брони может создать синтетическую guest запись через настоящий handler; это допустимое следствие сценария и не платёж. Открытая смена также является настоящей тестовой записью, её нельзя считать отсутствием любых domain mutations.

## Предыдущее замечание finalize

P2 со старыми evidence refs при переходе capture → blocked исправлен: до mapping helper очищает refs, dimensions, permissions/environment/defect fields и notes. Подтверждено чтением нового исходника; helper не запускался, R1 matrix не перезаписана. По-прежнему требуется валидная CSV schema и отдельная сверка mapping; это не повод использовать старый finalize для текущей R2 без контроля координатора.

## После контролируемого исполнения

Координатор подтверждает GET stock/recipes/products/floor/orders/queue/reservations и реальные tenant IDs; сверяет отсутствие оплат/закрытий/stock movements и effective permissions по действующим сценариям. QA привязывает long-content снимки к отображаемым новым сущностям. Итоговый runtime/evidence review выполняется по реальным результатам. Текущий GO относится к безопасности подготовленной локальной instrumentation и не заменяет эти проверки.

## Повторное чтение перед GO execution

Координатор передал GO_FIXTURES на одно контролируемое выполнение после baseline. В актуальном `new-long-fixtures.cjs` product category исправлена на `UI012 R2 Длинная категория bar/hookah` — совпадает с именами создаваемых category metadata, соответствующий P2 закрыт чтением. Остальные guards и mutation scope сохранены; targeted readiness GO остаётся. Reviewer не исполнял apply/API и не утверждает успешность ещё не проверенных mutations. GET/browser проверка после исполнения остаётся обязательной.
