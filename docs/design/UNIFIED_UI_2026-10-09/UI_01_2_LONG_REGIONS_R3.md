# UI-01.2 R3 — минимальные long-content fixtures финансов, payroll и истории

2026-10-09 · Независимая роль `code_health_engineer`. **PLAN ONLY; реализация proxy/sample data и исполнение не разрешены этим отчётом.** Нужен отдельный GO координатора. Продуктовые файлы, БД и proxy reviewer не изменял; API/SQL не выполнял.

## Предлагаемый минимальный пакет

Предпочтительный путь — явно обозначенные синтетические ответы локального read proxy после успешного настоящего upstream GET. Создавать финансовые операции, payments, закрытые смены/заказы, payroll accruals и прямые SQL historical inserts для проверки переноса текста не требуется. Фикстуры относятся только к отображению выбранного региона; backend persistence, расчёты, суммы и действия ими не проверяются.

| Регион и роль | Минимальный sample | Exact read target / подтверждённый контракт | Что проверяется |
|---|---|---|---|
| Expenses, owner; manager только после настоящего successful access | 3 строки: длинная category до 80 символов, длинная description; amount=0, source=manual, expenseDate в выбранном диапазоне; documentUrl=null, payrollNeedsReview=false. Для строки явно использовать UI012 R3 synthetic label. | `GET /api/expenses?from=…&to=…&limit=…&offset=…`; envelope `{items,totalCount,limit,offset}`. Server 4545–4564, renderer portal 4423–4441. Category/description реально отображаются в payment-row. | Перенос, высота rows, контраст, сумма 0, pagination labels. Не ledger truth/KPI reconciliation. |
| Payroll register, owner | 3 cancelled rows с long userName/ruleName, amount=0, hours=0, paymentDate=null, expenseId=null, корректными ISO periodFrom/To; synthetic UUID IDs/userId/ruleId отдельно от реальных записей. | `GET /api/payroll/entries?from=…&to=…`; `{items:[…]}`. Server 4605–4616, portal 4490–4504/4517–4523. Status cancelled поддержан lifecycle migration040 и renderer. | Long label/date/amount rows и filter options; cancelled не показывает approve/pay/cancel editors. Не payroll расчёт/выплата. |
| Cancelled history rows, owner/manager после successful orders gate | 3 cancelled orders с длинными tableName/guestName, notes, createdAt; items=[], payments=[], finalTotalSnapshot=0, minimumOrderTotal=0, attentionReasons=[]; synthetic UUID IDs и non-binding tableId=null. | Только `GET /api/orders?scope=all` (точное query matching). `{items:[…]}`; server 5885–5903, portal 5267–5274. Не подменять обычный `/api/orders` floor queue. | Журнал, фильтр cancelled, поиск/сортировка и long table/guest columns. Closed/payment history не заявляется. |

Для expenses zero amount разрешён текущим POST validation (`server.js:4573`), но POST не выполняется. Для payroll amount>=0 закреплён migration021. Cancelled orders с нулём сохраняют нулевую closed revenue и не требуют оплаты. Текст notes не отображается в journal row; его наличие не считается покрытием visible notes. Измерить именно видимые labels.

## Контракт proxy и guardrails после отдельного GO

1. Использовать только фиксированный isolated origin/backend `127.0.0.1:31952/31953`; сохранить AUTH_REQUIRED и настоящий session/tenant. Текущий proxy уже сохраняет upstream 401/403, меняя только successful GET. Не заменять auth/session/preferences/health/venue, не создавать synthetic success при denied/error.
2. Новый sample mode требует exact pathname+query parser, allowlisted region, expected role/tenant context и task-specific sample version. Один общий prefix `/api/orders` недопустим: он затронет floor и детали. Payroll samples разрешены только после actual successful owner GET; никакой замены `/api/payroll/schemes` owner-only gate.
3. Перед записью/выдачей samples валидировать finite numeric values, enum status, ISO dates и from<=to, уникальные UUID, max lengths, envelope arrays и pagination. Для expenses применять from/to/offset/limit к sample list и согласовать totalCount. История — только scope=all, date/search отражать renderer contract. Для payroll sample dates должны попасть в текущий filter range.
4. В mode log/evidence сохранить sample source/version/hash, endpoint/query, upstream status, isolated role/tenant context и synthetic-region marker. Не сохранять Authorization/cookies/passwords/tokens. Synthetic evidence не смешивать с реальным baseline, отдельные state/attempt metadata и review classification обязательны.
5. Synthetic IDs не являются существующими entities. Не нажимать «Открыть», «Возвраты», payroll create/approve/pay/cancel, financial submit и другие domain actions. Журнал показывает action links даже для cancelled (`portal.js:5273`), поэтому sample покрывает только read region, не actions/detail state. Keyboard focus допустим без activation. Если нужен action/editor contract — использовать реальные отдельные fixtures и новое GO.
6. Summary/report/analytics не подменять, zero amounts не создают fake оборот. Нулевые KPI не являются N/A для компонента. Состояния true empty, synthetic loading/error и long sample записывать раздельно; после capture вернуть mode normal и подтвердить mode/log.

Проверка schema samples статическим validator и visual region screenshot обязательна после подготовки; текущий отчёт не создаёт sample files или рабочий режим proxy. Альтернатива прямой вставки в isolated DB усложняет FK/lifecycle/tenant provenance и не нужна для этой цели.

## Точные условия статической неприменимости региона

Это **условные source-derived N/A candidates**, а не готовый runtime N/A всех matrix rows. Нужны подтверждённые actual role/session/permissions и соответствующая видимая ветка UI. Неизвестная роль/redirect/error/loading не заменяют доказательство.

| Регион | Условие | Статическое доказательство | Требуемый runtime bridge |
|---|---|---|---|
| Общий expense/ledger, payroll, business charts на `/finance` для bartender/hookah_master | Portal user.role в operational employee list | `portal.js:4247–4253`: employee branch строит только «Оплаты сегодня», получает own summary и делает return до business regions. `server.js:4547` дополнительно запрещает operational expense GET. | Session соответствует рабочей роли; own-current-day surface видим. N/A только общие business регионы, собственный summary всё ещё applicable. |
| Payroll register для manager или любого non-employee без finance | `hasPortalPermission('finance')` false | `portal.js:4248`, `4464`: register создаётся только canDecideFinance&&!employeeFinanceView. `server.js:4606`: entries требует finance. | Saved manager permissions содержит finance_read, не finance; актуальный session bridge и отсутствие register. Не исключать expenses/summary, которым разрешён finance_read. |
| Payroll schemes конфигурация non-owner | Actual role !=owner | `payroll-scheme-routes.js:34–37`: 401 без principal, 403 `payroll_scheme_owner_only` для non-owner до service/lookup. | Actual route/API deny с role bridge; это отдельный scheme region, не разрешение делать N/A всему payroll при одном denied endpoint. |
| History list без orders permission | Actual orders permission отсутствует | `server.js:5886` denyUnless orders; портал route gate нужен отдельно. | Реальный отказ страницы/GET, role/tenant и visible deny. У текущих owner/manager/staff orders есть, их journal rows заранее не исключать. |
| Отсутствующие closed payment/refund details в cancelled sample | Sample содержит только cancelled zero orders | Это граница приготовленного sample, **не source N/A**: portal journal всё равно показывает «Возвраты» и «Открыть» при соответствующих permissions (5273). | Оставить details/history states непроверенными; наличие cancelled rows не доказывает closed/payment/refund UI. |

Настоящая пустая БД/пустой GET, отсутствие transactions/payroll entries и отсутствие fixture сами по себе не дают N/A. Owner business regions applicable и требуют long/empty/loading/error проверки. Текущие saved long permissions: owner16 (finance/read/orders), manager9 (read/orders, finance отсутствует), staff4 (read/orders, finance отсутствует); permissions — массивы, не объект из восьми ключей.

## Критерий завершения этого пакета

После GO coordinator prepares exact synthetic GET fixtures, validator и новый evidence sample provenance; QA проходит visible regions и conditional N/A bridges. Code health проверяет instrumentation diff и final outputs; source mirror/root остаются 215/215 unchanged. До этого пакет PLAN_ONLY, UI-01.2 не завершён.
