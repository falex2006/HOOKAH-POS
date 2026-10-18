# UI-01.2 R3 — подготовленные synthetic read samples

2026-10-09 · Роль backend fixture/support. Статус **PREPARED CANDIDATE; NOT APPLIED**. Координатор дал `GO_PREPARE_SAMPLES`; активация требует отдельного `GO_APPLY_SAMPLES` после независимого code-health review. Активные proxy/controller, mode.json и сервисы не изменены/не перезапущены. Browser не использовался; продукт/БД не менялись.

## Подготовленные артефакты

Все helpers/data/instrumentation находятся в ignored `tmp/ui012-baseline`:

| Файл | Назначение |
|---|---|
| `samples-r3/expenses.json` | Три длинных UI012 R3 synthetic expense rows, amount=0, source=manual, documentUrl=null |
| `samples-r3/payroll.json` | Три cancelled payroll rows, amount/hours=0, paymentDate/expenseId=null |
| `samples-r3/orders.json` | Три cancelled nonbinding history rows, tableId=null, items/payments/attentionReasons=[], amounts=0 |
| `samples-r3/manifest.json` | Версия ui012-r3-v1, expected long tenant, immutable source hashes |
| `sample-validator.cjs` | Проверки UUID/date/finite zero numbers/status/length/envelope, strict exact GET/query |
| `sample-helper.cjs` | Hash verification, true upstream200 requirement, direct real session role/tenant/permission recheck; filtered response/provenance |
| `sample-validation-check.cjs` | Статические positive/negative проверки без API/DB/server activity |
| `proxy.r3-candidate.cjs`, `state-controller.r3-candidate.cjs` | Кандидаты обновления внешней instrumentation; оригиналы остаются активными |
| `proxy-r3-candidate.diff`, `state-controller-r3-candidate.diff` | Точные diff для независимого review |

## Неизменяемые hashes

| Источник | SHA256 |
|---|---|
| manifest | `feda390c1bdf26c8d89a98b4e3756b9a686fc4f1ef6dbeab0e3da128aac8f41a` |
| expenses | `eac7c6da6dc8b3384240f75037ddcd57038bacbefb52cecba87f40c571179aeb` |
| payroll | `1fc4199bdbe6ea707648b036ad0c3fba85061acf264d2f1e46ef0467c648b2ea` |
| orders | `90ea309f091f4c3cb6a328252d2424c34c8fd67b40b046afeb5c7b300a862d73` |

Hashes зафиксированы также в helper source: правка sample/manifest приводит к guard refusal. Response SHA отдельный, поскольку фильтры/pagination могут менять возвращаемое подмножество. Никакие реальные credentials/cookies/tokens не включены в samples/manifest/provenance.

## Exact targets и права

| Регион | Единственный допускаемый target | Session guard |
|---|---|---|
| Expenses | GET `/api/expenses`, только unique query keys from/to и optional limit/offset; valid ISO dates from≤to, limit integer1–100, offset≥0 только при limit | owner/manager, actual finance_read, exact expected long organization+venue |
| Payroll | GET `/api/payroll/entries`, ровно unique from/to; valid dates from≤to | Только owner, actual finance, exact expected long organization+venue |
| Cancelled orders | GET `/api/orders?scope=all`, ровно один key scope=all | owner/manager, actual orders, exact expected long organization+venue |

GET без scope, floor queue, details, payroll schemes, summary/analytics, auth/session/preferences, invalid/duplicate/unknown query и все POST/PATCH/DELETE не совпадают с target. Прежде чем выдать synthetic response, исходный endpoint обязан вернуть **ровно HTTP200**, затем helper повторно читает настоящий `/api/session` у backend31953 с теми же входными credentials исключительно внутри процесса. Любой session/context/hash/schema отказ сохраняет исходный upstream response и записывает безопасный sample-refused marker. Upstream401/403/5xx не заменяются. Настоящие права не расширяются.

Fixed sample expenseDate/createdAt: 2026-10-09; payroll period: 2026-10-01…2026-10-09. Expenses применяют date range +pagination и totalCount; payroll применяет overlap range. Orders renderer выполняет собственные date/search/status/sort фильтры после точного scope=all GET; дополнительные query не разрешены. Если выбранный диапазон не включает sample, response честно содержит zero rows — не переназначать даты незаметно.

Body содержит `_ui012Synthetic` marker, response headers `x-ui012-synthetic-region`, `x-ui012-sample-version`, `x-ui012-sample-sha256`, cache-control no-store. При активации provenance пишется в `sample-provenance.ndjson`: endpoint/query, upstream200, real role/user/organization/venue, source/version/hash, response hash, rows, explicit persistenceValidated=false/actionsValidated=false. Private headers не сериализуются.

## Границы визуальной проверки

Samples проверяют видимые long labels/row sizing/contrast/zero formatting/filter regions. Они не являются существующими entities и не подтверждают финансовые расчёты, сохранение, ledger/KPI reconciliation или payroll lifecycle. Payroll cancelled rows не выводят approve/pay/cancel editors. Cancelled history renderer **всё ещё выводит ссылки «Открыть»/«Возвраты»**; их активация запрещена в sample capture. Допускаются чтение и keyboard focus без activation. Sample flags не являются скрытой правкой app renderer и не выключают actions в продукте.

Настоящие empty, synthetic loading/error и synthetic long samples хранятся раздельно в evidence. После будущего capture вернуть normal и подтвердить mode/provenance. Наличие sample не позволяет заявлять closed/payment/refund detail coverage.

## Выполненная подготовительная проверка

`node --check` выполнен для helper и обоих candidate scripts: PASS. `node tmp/ui012-baseline/sample-validation-check.cjs`: **PASS, 31 проверка**, включая immutable hashes, correct samples, duplicate UUID rejection, nonzero/NaN/invalid date/approved/paid/closed/binding table rejection, wrong methods, unknown/duplicate query, details/session/summary exclusions. Эти статические проверки не запускали API/DB/server и не активировали sample mode.

Независимый code-health review и runtime guards/visual region screenshots **ещё не выполнены**. До `GO_APPLY_SAMPLES` кандидат не копируется поверх активных файлов и proxy не перезапускается. Browser blocker не обходится этим toolkit.


## Актуализация координатора R3

После независимого GO_APPLY_SAMPLES и исправления provenance failure применены ignored proxy/controller, перезапущен только принадлежащий UI012 proxy. Expenses/payroll получены через реальные HTTP200 и собственную owner session. Domain actions не выполнялись; history visual ещё pending. Два финансовых кадра отклонены R3-E06. Proxy возвращён normal. Исходный PREPARED раздел выше сохранён как история подготовки. Полный результат: [контрольный срез](UI_01_2_CHECKPOINT_R3.md).
