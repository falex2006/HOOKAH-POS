# Payroll: проверка готовности источников

Состояние: локальный read-only API и секция отчёта владельца в существующей странице зарплаты. Официальный расчёт и запись выплат этот этап не включают.

## Интерфейс владельца

«Проверка источников зарплаты» доступна после открытия сохранённой версии. Владелец выбирает даты и нажимает «Проверить источники». Отчёт показывает версию, период и часовой пояс, статусы компонентов, счётчики и причины неподключённых источников. Несохранённые изменения явно исключены из проверки. Новая схема или новая версия без сохранения не проверяется.

Изменение периода, открытие другой версии, обновление списка и закрытие редактора очищают отчёт. Поздний ответ для старого контекста игнорируется. Повторная проверка доступна после ошибки; ошибка заменяет прежний успешный отчёт и выводится как текст. Неизвестные счётчики показаны словами, без подстановки нуля. Проверка доступна и для активной версии, остающейся защищённой от редактирования.

## Контракт

`GET /api/payroll/versions/:id/source-readiness?from=YYYY-MM-01&to=YYYY-MM-DD`

- Только владелец из авторизованной сессии; сервис повторно проверяет владельца в БД. Версия другого заведения возвращает 404.
- Обязательны ровно два уникальных параметра `from`, `to`. Реальные календарные даты, начало месяца и конец в том же месяце. Неизвестные параметры и дубликаты возвращают 400.
- Все источники читаются через одну транзакцию `REPEATABLE READ READ ONLY`, с часовым поясом заведения. Caller-provided coverage не принимается.
- Ответ: `schemaVersion`, `versionId`, `period`, `requiredSourceFacts`, `components`, `officialReady: false`.
- Компоненты: выбранные source policies, утверждённая посещаемость, наблюдения заголовков/текущих строк заказа, события возврата, канонические цены строк, credit, признанные построчные возвраты, полная net выручка сотрудника, себестоимость, распределение по цеху/смене.

## Значение результата

`available` у наблюдений означает возможность прочитать указанные факты; это не подтверждение полноты финансового источника. `watermarkScope` ограничивает область checksum. Текущие строки заказа не объявляются immutable snapshots. Нулевое число заказов не делает официальный расчёт готовым.

Наблюдения заказов выбираются по `closed_at` в локальном периоде. Заказы без даты закрытия учитываются отдельным счётчиком всего заведения. Проверяются наличие price lock, версии и четырёх сумм заголовка; отсутствие seller/sold_at учитывается отдельным счётчиком. Отсутствие схемы attribution даёт `unsupported` и `null`, а не ноль.

Возвраты088 показывают отдельно события по дате возврата и события любых дат, связанные с заказами выбранного периода. Если в любой из этих областей есть `unattributed` событие, `refundObservations` получает `incomplete` с причиной `recorded_refund_item_attribution_incomplete`; точные счётчики и checksum сохраняются. Даже `available` у наблюдений не подтверждает признание выручки, связь со строкой или сотрудником. До088 компонент имеет `unsupported`, счётчики и checksum — `null`.

Посещаемость использует существующий проверяемый approval manifest. Отсутствующий, неполный, устаревший или повреждённый approval даёт `incomplete`. Неожиданные ошибки БД возвращают 500 и не маскируются под состояние источника.

Канонические цены читаются из POS090 через `payroll-canonical-pricing-source.js` в той же RR read-only транзакции. Проверяются tenant, локальные границы `closed_at`, версия 1, явная RUB/scale2, полный набор текущих ID позиций, integer minor amounts, BigInt aggregate HALF_UP и largest-remainder по ID, распределение скидки по замороженной eligibility, winner terms и сохранение сумм. Заказы без090 дают `canonical_pricing_legacy_unknown`; отсутствующая схема — `unsupported`, повреждённые снимки — `incomplete`. Неожиданные SQL ошибки остаются ошибками.

`canonicalLinePricing.attribution` отдельно показывает полноту продавца. Цена может быть `available` при неизвестном seller/sold_at; это не разрешает начисление. Cross-venue продавец, допустимый POS084 по организации, сохраняет исходный ID и получает `unsupported` с причиной `cross_venue_payroll_employee_unsupported`: employee FK зарплаты077 пока допускает только своё заведение. Нулём или продавцом, открывшим стол, неизвестная атрибуция не заменяется.

Credit/refund/net/cost/department источники остаются `unsupported`, `officialReady:false` — даже при полной pricing coverage и наличии таблиц091. Признание возвратов не подключено этим адаптером. API ничего не пишет в payroll runs, entries, expenses, order/refund ledgers и ревизии схем; этот этап не меняет DDL.

## Проверки

### Post-092 порядок и накопительные переходы — 2026-10-04

Наблюдаемый reader поддерживает принятые поля092: `producer_sequence`, `previous_returned_quantity`, `cumulative_returned_quantity`, `previous_returned_item_value_minor`, `cumulative_returned_item_value_minor`. Все bigint читаются строками; sequence сравнивается BigInt без потери точности. Пять новых полей включены в watermark. На091 без этих столбцов reader читает NULL aliases; частично установленная схема092 даёт unsupported с неизвестными счётчиками.

Для каждого source identity `(venue_id,snapshot_id,order_id,order_item_id)` post092 события проверяются по последовательности1…N: gap/duplicate, незаполненные переходы, неверные previous/cumulative значения и арифметика delta дают incomplete. Сохранённые previous значения должны совпасть с предыдущим cumulative состоянием; cumulative quantity/value должны совпасть с результатом общей HALF_UP проверки. UUID и timestamps не задают порядок. Равные или обратные даты sequenced событий допустимы при точном совпадении даты с refund header и отсутствии возврата раньше закрытия исходного заказа.

Legacy091 строки имеют NULL sequence и переходы; `item_return_legacy_unsequenced` всегда сохраняет incomplete, даже если наблюдаемая timestamp-арифметика проходит. Их сумма quantity/value может установить baseline первого события092 с sequence1. Baseline сверяется с полным legacy aggregate, исходным количеством/line net и HALF_UP; отсутствие необходимых старых фактов или несовпадение не компенсируется нулём. Успешная проверка post092 tail не подтверждает порядок старой истории. Timestamp ties старых строк остаются неоднозначными.

DTO дополняется `sequencedEventCount`, `legacyUnsequencedEventCount`, `post092ValidatedItemCount`, `legacyBaselineItemCount` и `sequenceScope` (`per_source_post_092`, `legacy_unsequenced`, `mixed_post_092_and_legacy`, `none`; при отсутствующей схеме `unknown`). `producerSequence: per_source_post_092` возможен только при sequenced фактах без legacy и ошибок transition/source; иначе not_attested. Эти поля подтверждают проверенную область порядка, не готовность официальной зарплаты.

`recognizedLineRefunds` и employee full net остаются unsupported, `officialReady:false`. Merchandise value вычисляется независимо от external payout; этот пакет не добавляет payout linkage, commission/credit/clawback или writer. Остаются продуктовые блокеры recognition date/period/timezone и employee full net для non-commission items.

Целевые проверки: `scripts/payroll-item-return-sequence-contract.mjs` и `scripts/payroll-item-return-sequence-postgres-contract.mjs`. Ранее принятые090/091 проверки сохраняются как историческое доказательство; их available arithmetic нельзя трактовать как новую аттестацию legacy chronology.

### Наблюдаемый компонент itemReturnEvidence — 2026-10-04

`payroll-item-return-source.js` читает091 через существующий авторизованный RR read-only client. Область событий совпадает с refundObservations: refund зарегистрирован в локальном периоде либо относится к закрытому заказу периода. Затем читаются исходные090 header/all lines и полная история возвратов затронутых заказов, включая предыдущие периоды. Поэтому возврат старого чека не теряет исходную цену, а частичный возврат не проверяется с выдуманного нулевого остатка.

Для `complete` проверяются наличие строк, tenant/order/snapshot/item lineage, policy_version1, точная дата родительского события, исходная цена и cumulative quantity/value. `unattributed` оставляет историю неполной; `not_applicable` означает отсутствие merchandise return, а не подтверждённое признание выручки. Строки `not_applicable`/`unattributed` недопустимы. Unknown/cross-venue seller сохраняет отдельную причину ограничения. Amount из refund header и external tender не используется как стоимость товара.

Общая `verifyPayrollItemReturnArithmetic` в payroll-order-refund-evidence.js проверяет BigInt cumulative HALF_UP и пределы количества/замороженного line net. Её используют прежний строгий verifier и новый reader; department, commission eligibility, source policy, payout и sequence для повторного использования не выдумываются.

PostgreSQL timestamps читаются в UTC с шестью дробными цифрами, сравниваются без округления до миллисекунд. Возврат раньше закрытия исходного чека даёт incomplete. Одинаковые timestamps одного товара дают `item_return_chronology_ambiguous`; timestamp chronology, не воспроизводящая сохранённые delta values, также incomplete.091 не сохраняет порядок сериализации balance guard: `producerSequence: not_attested`, `paymentLinkage: not_attested` сохраняются даже при available arithmetic. Mutable return balances не объявляются авторитетной историей.

Компонент содержит scoped refund/item counts, complete/unattributed/notApplicable headers, full history rows, validated/invalid/ambiguous source items, missing source и unknown/cross-venue attribution counts, reasons и watermark. `validationScope: observed_item_return_arithmetic`; `historyScope: full_observed_history_of_related_orders`. `validatedItemCount` означает успешную проверку арифметики наблюдаемой истории, не число признанных зарплатных возвратов. Отсутствующая091/090 схема даёт unsupported и null; legacy/неполный источник — incomplete. Пустая наблюдаемая область не разрешает официальный расчёт.

Это дополнение API; UI renderer этого этапа не меняется. `recognizedLineRefunds` и fullEmployeeNetRevenue остаются unsupported, `officialReady:false`. Для официального применения ещё требуются payroll period/credit/clawback policy и авторитетный порядок producer. SQL ошибки не маскируются под статус источника; записей в финансовые таблицы reader не создаёт.

- `scripts/payroll-item-return-source-contract.mjs`: full-history fractional/zero delta, microseconds, lineage/policy/currency/amount failures, ambiguous timestamps, unknown/cross seller, header classification и input immutability.
- `scripts/payroll-canonical-pricing-source-postgres-contract.mjs`: actual091 readback и readiness, возврат старого чека с предыдущим возвратом до периода, unknown/cross seller и timestamp ambiguity, без включения official writer.

- `scripts/payroll-canonical-pricing-source-contract.mjs`: 300 независимых oracle случаев скидки manual/group/promotion, fractional cent, точное распределение, chronology, currency/overflow/coverage, unknown и cross-venue seller, отсутствие мутации входа.
- `scripts/payroll-canonical-pricing-source-postgres-contract.mjs`: настоящая090 в собственной временной схеме, raw gross/unsafe bigint отказ, tenant/timezone, RR concurrent commit, legacy/unknown/cross-venue и no-posting. Проверен настоящий091 committed item return quantity0.250/value250 копеек, точная snapshot/item связь и неизменность исходного pricing DTO. Отдельный unattributed refund даёт incomplete с точными event/unattributed/linked/linked-unattributed счётчиками2/1/2/1. Общий readiness в той же RR транзакции сохраняет officialReady:false и неподключённые recognizedLineRefunds/full net. Это downstream reader проверка; POS HTTP producer проверяет его владелец отдельным browser/PG сценарием.

- `scripts/payroll-scheme-routes-contract.mjs`: session owner, query shape, отсутствие вызова сервиса при недопустимых параметрах.
- `scripts/payroll-source-readiness-postgres-contract.mjs`: изолированная БД, настоящий свежий RR, owner/tenant, границы timezone, состояния до/после 088, обе области дат возвратов, свежий/устаревший approval, отсутствие posting.
  Дополнительно проверен реальный concurrent commit: test-only wrapper останавливает чтение после headers; отдельное соединение меняет текущую строку, добавляет append-only refund и меняет табель. Первый ответ целиком равен исходному снимку, следующий показывает новые order/refund watermark и точную причину stale approval. SHOW подтверждает repeatable read и read-only внутри транзакции. Unexpected SQL error остаётся ошибкой; проверены rollback, release и успешное последующее чтение. Проверяется удаление собственной временной схемы. Это доказательство согласованности наблюдений, а не канонической полноты источников.
  Принята отдельная матрица 12 сочетаний (3 credit × 2 discount × 2 refund recognition): реальное сохранение версии, прямой PG JSON, getVersion и readiness с независимым буквальным expected requiredSourceFacts. Каждый ответ сохраняет officialReady:false и шесть unsupported canonical компонентов; GET не меняет счётчики записей. Заказ на точной нижней границе локального midnight включается; новые данные другого tenant и вне обеих refund областей оставляют полный отчёт неизменным. Выбор policy не доказывает её исполнение и не отменяет требование исходного ТЗ к продавцу строки.
- `scripts/payroll-scheme-browser-postgres-qa.mjs`: реальный HTTP/session, owner approval и readiness, staff/finance 403, foreign owner 404, дубликат/forged coverage 400. Общие проверки редактора и отсутствие финансовых записей сохраняются.
- `scripts/payroll-source-readiness-ui-contract.mjs`: фактический renderer, escaping, недопустимые статусы, null, календарные границы и guards контекста. Browser дополнительно проверяет кнопку, очистку по датам, задержанный ответ, loading, HTTP 500, повторный запрос, предупреждение о несохранённом JSON и активную версию/закрытие.
