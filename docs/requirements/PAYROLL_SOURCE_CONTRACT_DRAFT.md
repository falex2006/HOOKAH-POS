# Payroll первичные источники — проект контракта

**Статус:** проект для согласования с MASTER и владельцами POS/loyalty; реализацию upstream-источников не разрешает.  
**Основание:** `PAYROLL_ARCHITECTURE_CONTRACT.md`, `FINANCE_MODEL.md`, локальная схема и действующие POS/табельные маршруты.  
**Цель:** определить доказуемые входные данные official payroll run, не используя кассу, стол или текущего пользователя как догадку об исполнителе.

## Отраслевые примеры, не заменяющие наш финансовый контракт

- Oracle Simphony отдельно предоставляет Employee Journal — журнал продажных операций сотрудника — и Employee Closed Check — список чеков, закрытых сотрудником. Это полезное разделение: автор позиции/операции и закрывший чек являются разными фактами; `orders.opened_by` или закрытие чека не следует принимать как автора каждой позиции. [Oracle Simphony POS Reports](https://docs.oracle.com/en/industries/food-beverage/simphony-essentials/simsl/c_reports_pos.htm)
- В Oracle Simphony для сотрудника можно назначать несколько job codes, а на clock-in выбирать должность. Это подтверждает, что ставка/роль может зависеть от фактически выбранной работы, а не только от одной постоянной роли сотрудника. Для HOOKAH CRM это аргумент сохранять effective role/department в источнике факта продажи и табеля. [Oracle Simphony Employees and Job Codes](https://docs.oracle.com/en/industries/food-beverage/simphony/19.7/simcg/F96890_18.pdf)
- Oracle описывает time card как отдельную запись clock-in/clock-out; менеджер или payroll team может корректировать её, а сотрудника можно уведомлять и просить подтвердить изменения. Это поддерживает версионируемое owner-approved закрытие табеля и аудит изменений, сохраняя исходные интервалы. [Oracle Simphony Time Cards](https://docs.oracle.com/en/industries/food-beverage/simphony/19.7/simcg/c_employee_time_cards.htm)

Это отраслевые примеры организации данных и контроля. Они не утверждают commission policy, российские трудовые нормы, распределение скидок HOOKAH CRM или право менеджера менять начисления; эти решения остаются в `FINANCE_MODEL.md` и локальном owner-only контракте.

## Почему нужен отдельный upstream-этап

Migration `084_order_item_sales_attribution.sql` теперь сохраняет для новых `order_items` автора добавления (`sales_employee_id`) и серверное UTC-время (`sold_at`); legacy-строки могут оставаться без обоих значений. Контракт `POS_SALE_ATTRIBUTION_CONTRACT.md` запрещает выводить автора из `orders.opened_by`. Эти факты фиксируют автора добавления, но сами по себе не определяют payroll-credit policy, последующее исполнение или допустимую коррекцию атрибуции. Pricing migrations 074–075 фиксируют выбранную скидку/акцию и суммы только на `orders`, не allocation на `order_item`. Migration 088 фиксирует фактические денежные POS-возвраты отдельным order-level ledger, но без line/employee lineage; `payments.status='refunded'` остаётся неизвестным legacy сигналом. Payroll attendance approvals 082 и их текущий preview дают immutable approved attendance manifest. Следовательно, остаются неподтверждёнными полный line-level pricing/refund snapshot и иные source coverage (личный net, department/cost), а не attendance manifest.

Смежные принятые политики уже дают устойчивые части контракта. `docs/requirements/LOYALTY_POLICY_CONTRACT.md` (L11.6) выбирает одно лучшее предложение скидки в порядке `promotion > guest_group > manual`, применяет VIP minimum после скидки, а bonus tender — после цены; bonus/deposit/reservation prepayment не добавляются повторно и не меняют discounted price. `docs/requirements/FINANCE_MODEL.md` признаёт закрытую выручку по `final_total_snapshot`, а legacy fallback строит по сохранённым позициям и одобренным скидкам. Payroll использует эти решения как входные финансовые факты и не переопределяет выбор скидки, tender или возврат.

**Оставшийся gap:** принятый выбор скидки на весь заказ не является распределением скидки между товарными строками. Для построчной комиссии всё ещё нужен line allocation от владельца pricing evaluator; пока он отсутствует, нельзя выводить net строки пропорциональной эвристикой внутри payroll и переводить run в `ready`.

Отдельно от комиссии нужен источник полного личного net revenue для проверки абсолютного дневного ограничения выплаты из ТЗ. Он включает все продажи сотрудника после скидок и возвратов по Finance semantics, даже если позиция не участвует в комиссии. `commissionBaseCents` исключает некомиссионные части и `turnoverCents` пока не гарантирован как полный Finance-net итог; payroll не может подменять ими инвариант. До upstream-поля с attribution, refund/discount lineage и полным coverage доступен только сценарный turnover proxy, а official run остаётся blocked.

Запрещённые замены источников: `orders.opened_by` вместо автора добавления строки; `payments.status='refunded'` или итог сменной кассы вместо признанного построчного возврата; стол/станция вместо сотрудника; план расписания вместо подтверждённой явки; имя/категория товара вместо стабильного owner-reviewed mapping. Ledger 088 является источником фактической выплаты возврата по заказу, но не доказательством line/employee attribution или payroll recognition.

## Предлагаемый контракт записи продажи

| Поле/событие | Предлагаемое значение | Инвариант |
|---|---|---|
| `sales_employee_id` | Authenticated POS employee, создавший продажную порцию строки | Сервер берёт identity из сессии, никогда из тела запроса. `opened_by` не наследуется. |
| `recorded_by` | Authenticated actor, выполнивший API действие | Отдельен от `sales_employee_id`, если владелец/уполномоченный менеджер исправляет атрибуцию с обязательной причиной. |
| Quantity addition | Отдельная порция/строка для `sales_employee_id` | Одинаковые product/price строки можно объединять только при совпадении venue, заказа, товара, цены и исполнителя; увеличение чужой строки не переписывает её автора. |
| Quantity reduction / void before close | Явно указанная строка/порция и уменьшенное количество | Не меняет цену закрытого заказа и не создаёт refund. Аудит сохраняет actor и lineage исходной порции. |
| Item move/split | Сохраняет исходные `order_item_id`/author allocation либо явную ссылку `source_order_item_id` | Перенос стола или заказа не меняет исполнителя и цену; чужое происхождение нельзя потерять при split. |
| Price lock | Immutable per-line snapshot в момент первой принятой оплаты/закрытия | На строку сохраняются gross cents, allocated discount cents, commissionable net cents, currency, pricing version и исходный order/item identity. Повторная оплата не пересчитывает snapshot. |

Позиционная комиссия использует чистую цену товара после фактически выбранной order discount, но не использует tender. Bonus, guest deposit и reservation prepayment являются способом расчёта/обязательством, а не скидкой к commission base. VIP minimum adjustment не распределяется как продажа товара и не увеличивает commission base; он остаётся самостоятельной частью полного order turnover.

Чтобы распределить скидку закрытого заказа, pricing source должен передать точное распределение скидки по подходящим строкам от того же evaluator, который выбрал скидку. Для fixed/group/manual скидки допустимое проектное правило — пропорционально исходной eligible базе с детерминированным largest-remainder округлением до копейки и стабильным tie-break по `order_item_id`; для item/category promotion eligible база ограничена выбранными подходящими строками. Сумма allocations обязана совпасть с `discount_total_snapshot`. Скидку нельзя пересчитывать по текущим промо-правилам при payroll чтении. Это финансовое правило требует принятия MASTER и loyalty-владельцем до кода.

## Возвраты и сторно

Migration 088 уже фиксирует фактическую POS cash refund как append-only order-level событие с tender allocation, actor, reason и idempotency; она намеренно не атрибутирует возврат к item/employee. Поэтому `payments.status='refunded'` остаётся неизвестным legacy сигналом, а order-level ledger не определяет line, employee, частичную net сумму или payroll recognition period. Для official basis всё ещё требуется неизменяемое line-level refund/reversal событие, связанное с исходной проданной порцией и employee snapshot; cumulative allocation применяется не более одного раза. Возврат после закрытого payroll run порождает только согласованную lineage-linked adjustment следующего периода; paid history не переписывается. Пока этой части lineage и полной coverage нет, official run остаётся `blocked`.

## Утверждённый табель

Official run требует фиксированный owner-approved attendance source на venue-local период: конкретные фактические интервалы, подтверждённые/закрытые интервалы без `ended_at=NULL`, расписание-знаменатель для ставки за смену, actor/time/reason утверждения, уникальный approval version, исходные log IDs и checksum. Пересечения объединяются детерминированно. Изменение исходного интервала после approval делает прежнее подтверждение неактуальным и требует новой ревизии; ранее сохранённый payroll run сохраняет старую attendance revision. Schedule без подтверждённой явки и raw work log без approval не являются зарплатным фактом.

Табельное утверждение не закрывает POS-смену и не меняет сменную кассу. Оно — отдельное owner-only payroll/HR действие с tenant-scoped аудитом.

## Департамент, период и полнота

- Категория/департамент позиции разрешается по стабильному ID mapping, эффективному на момент price lock; отсутствие/пересечение mapping блокирует режимы, которым нужен цех.
- Все даты сводятся по timezone площадки и immutable timezone конкретного run. Полнота каждого входного источника определяется отдельным manifest от/до периода, а не наличием хотя бы одной строки.
- Полный venue-day turnover остаётся самостоятельной серией закрытого POS/Finance source. Он не восстанавливается из сотруднических строк. `FINANCE_MODEL.md` уже разрешает legacy fallback по сохранённым строкам и одобренным скидкам; payroll preview локально воспроизводит эту проверенную формулу только для venue-only сценария. Production source adapter должен читать канонический Finance-resolved total или общий Finance-owned pricing evaluator, а не поддерживать независимую копию формулы. При недоступном/неполном Finance source manifest official run остаётся blocked.
- Currency берётся из версии схемы и immutable source context; неподдержанная/несовпадающая валюта блокирует run.

## Предлагаемая карта владельцев и файлов

| Слой | Предполагаемые файлы/область | Владелец и согласование |
|---|---|---|
| Сохранение исполнителя, line portions, move/split/quantity semantics | Новая additive payroll provenance migration; `server.js` order-item POST/PATCH/DELETE/move; соответствующие POS-контракты | MASTER владеет POS/`server.js`; до кода требуется явный file-level scope и проверка текущих незакоммиченных diff. Payroll не редактирует эти участки параллельно. |
| Эффективная цена и точная discount allocation | Pricing evaluator/снимок заказа и связанных тестов | Совместное принятие MASTER (финансовый источник) и loyalty-владельцем (pricing rules); никакого изменения guest bonus/deposit ledgers. |
| POS cash refund / payroll line lineage | Existing finance-owned order-level payout source (migration 088), plus a future finance-owned line attribution event/read-only payroll adapter | 088 fixes payout actor/audit/idempotency/cash-flow. MASTER owns any additive link to exact source item/amount; Loyalty confirms pricing lineage where discounts affect net. Payroll never creates a parallel refund/payment ledger. |
| Approved/frozen attendance | Additive migration 082 и методы в существующих payroll service/routes/UI; read-only adapter к текущим schedules/work logs | Читает tenant-scoped HR факты и копирует их в append-only payroll manifest; таблицы и routes HR не меняет. Изменение расписания само по себе не меняет факт; только owner из серверной сессии утверждает отдельную ревизию с причиной и audit snapshot. |
| Нормализация входов и immutable source read | Новый payroll-owned read-only source adapter + tests | Payroll: repeatable-read, tenant predicates на каждом join, source manifests/checksum, причины blocked. Не пишет order/payment/loyalty/shift/expense data. |
| Run и snapshots | Существующие `payroll-calculation-run-service.js`, routes/UI и таблицы 077 | Payroll-owned; ready разрешён только при полном подтверждении всех source manifests. Draft payroll entry и expense остаются отдельным, последующим этапом. |

Решение о последовательности: migration 082 отводится под immutable attendance approval manifest, поскольку это первичный источник, требуемый до official run; run→entry migration получает следующий свободный номер только после появления `ready` run. Номер 082 уже занят payroll attendance approvals (migration 082); миграции 083–088 также существуют и не перенумеровываются. Следующий свободный номер проверяется по текущему дереву и фактической истории целевой БД непосредственно перед согласованным DDL; этот draft сам по себе номер не резервирует.

## Порядок принятия и интеграции

1. Payroll attendance approval manifest ограничен owner-only payroll-owned migration/service/routes/UI; он read-only к HR источникам и не меняет их.
2. MASTER уже принял общую POS refund boundary и cash-flow semantics в migration 088; открытый Finance handoff ограничен будущей item/quantity/net lineage без дублирования payout ledger. Loyalty подтверждает точную discount allocation и связь с immutable line pricing. Tender/discount semantics остаются в FINANCE_MODEL.md и loyalty pricing contract; ledgers не копируются в payroll.
3. Утверждается точное определение «автора/исполнителя продажи» для кальянного зала и процедура correction до price lock. До этого текущий authenticated actor — только кандидат, не автоматически official policy.
4. Сверяются line-level discount/refund allocation и source manifests; department mapping разрешается по стабильным ID, а VIP minimum остаётся venue-only revenue.
5. Реализуются согласованные additive POS/Finance source migrations/write paths с тестами смешанных авторов, quantity split/move/edit, discount cent-allocation и refund idempotency; payroll не редактирует их параллельно.
6. Payroll read adapter выдаёт canonical source coverage, watermark и checksum из одного согласованного DB snapshot; run service пишет snapshots только когда sale, Finance и attendance manifests полны и согласованы.
7. Отдельный run→existing payroll entry этап следует действующему finance P&L/cash-flow контракту; один payout path остаётся существующий `payroll_entries` → linked `source='payroll'` expense.

Пока пункты 1–3 не приняты владельцами, UI/API остаются preview/blocked-only: нельзя создавать `ready`, начисление или расход на основе ручного JSON и нельзя трактовать принудительный owner input как первичный POS-факт.

## Margin source extension required for official calculation

The scenario margin_target costSnapshot is a TOTAL net line cost, not a unit cost. The official source owner must supply immutable cost method/version/currency, sold/remaining quantity allocation, original sale lineage and refund/reversal cost treatment in the same snapshot as net sale revenue. Current menu/recipe costs cannot backfill historic sales. Returned goods/loss/writeoff recognition must come from Finance/Inventory contract; payroll must not invent stock/refund events. A caller-entered id/version is not evidence of source completeness. Missing or stale cost coverage must block official margin runs.

## Политики начисления, выбираемые владельцем заведения

Пользовательское решение от 2026-10-03: нельзя навязывать всем точкам один универсальный ответ на то, кому засчитывать продажи, как относить скидку к сотрудникам/позициям и как учитывать возвраты. Эти правила должны выбираться владельцем каждой площадки отдельно, сохраняться в версии payroll-схемы и применяться только к будущему расчёту. Значения, уже записанные в опубликованной версии, неизменяемы; изменение создаёт новую ревизию с автором, временем, пояснением и подтверждением владельца.

Предлагаемые семейства настроек (точные названия/options предстоит согласовать в UI/API-контракте):

**Обязательное поведение исходного ТЗ:** в исходном файле `ТЗ_Гибкий_модуль_расчёта_зарплаты_CRM.md`, строка 93, сказано: «Привязка „сотрудник ↔ продажа“ всегда на уровне строки чека (кто именно пробил эту конкретную позицию)», далее это названо обязательным поведением. Поэтому приёмка исходного ТЗ требует line-seller attribution. Дополнительные сохранённые варианты будущей source policy пока являются намерением настройки и не применяются; их наличие не разрешает официально заменить это обязательное правило ответственным заказа или распределением смены. Любое расширение официального credit требует отдельного явно согласованного продуктового контракта и подтверждённых источников, с сохранением исходного автора.

1. **Зачёт продажи сотруднику:** сохранённые source policies уже поддерживают `line_seller_snapshot`, `order_responsible_snapshot` и `explicit_line_allocation`. Автор добавления из 084 сам по себе не доказывает исполнителя или payroll-credit. Ответственный за заказ требует отдельного неизменяемого назначения; `orders.opened_by` не подставляется. В будущем payroll snapshot сохраняет исходный источник, выбранную policy, получателя и сумму. Настройки пока не применяются к официальному расчёту и не переписывают POS-атрибуцию.
2. **Распределение скидки:** предпочтительно использовать зафиксированные pricing evaluator line allocations и их eligibility; если владелец разрешит самостоятельное распределение для фиксированной/заказной скидки — выбрать явный алгоритм (например, пропорционально gross только eligible lines, largest remainder до копейки с устойчивым tie-break). Версионировать правило и сохранять сумму скидки/eligibility/result по каждой строке. Запрещено распределять скидку повторно или расходиться с фактической скидкой закрытого заказа.
3. **Возвраты:** выбирать способ отражения в комиссии: отменить ещё не подтверждённую/не выплаченную комиссию исходной строки; либо создавать отдельную корректировку следующего периода для уже выплаченной суммы; предусмотреть отдельное решение о допустимости/лимите clawback. Возврат должен ссылаться на исходные order/item/refund факты и сотрудника; выплаченная история не переписывается, каждая корректировка отдельно подтверждается и аудируется.

Пока нет owner-selected, поддержанного версиями и обеспеченного полным источником фактов набора правил, preview может показывать сценарий, но official payroll run не может получить `ready`. Выбор владельца не заменяет отсутствующую атрибуцию, line discount allocation, возвратную lineage или проверку финансовых инвариантов. Правила должны иметь утверждённые допустимые варианты, понятное предпросмотром объяснение и явно обозначенные последствия до включения в код.


## Verified critical source handoff — 2026-10-03

Read-only system_architect audit after local owner eligibility/refund arithmetic acceptance. Current migrations stop at089; no canonical per-item pricing/return storage was found. Existing readiness explicitly reports canonical pricing/credit/refunds/full-net/costs/department shifts unsupported; calculation-run service exposes only createBlockedRun. This is missing implementation, not evidence of an active producer assignment.

| Stage | Verified code seam | Required proof / owner |
|---|---|---|
| Frozen pricing producer | server.js pgOrderPricing; /api/orders/:id/payments first pricing lock before INSERT payments; separate /close pricing update. loyalty-pricing.js evaluateLoyaltyPricing computes eligibleLines but returns no frozen eligible item IDs. | POS/Loyalty/Finance shared hunks: immutable canonical item ID, quantity/price, original seller/time/department, winner/version/eligible-set and reconciled gross/discount/net captured atomically with first accepted tender. Later payments/close read the same snapshot. Current Number/mutable-catalog reads cannot prove historical facts. |
| Item returns | server.js /api/orders/:id/refunds; order_refunds/order_refund_tenders088 remain unattributed. | Finance/POS additive merchandise quantity/value journal, original frozen line linkage, full cumulative history, replay/concurrency constraints, explicit payout linkage including unknown cases. No parallel payout ledger. |
| Authoritative payroll manifest | payroll-source-readiness.js observations; existing approved attendance adapter | Payroll/Finance RR tenant snapshot with full counts/checksums, timezone/currency, recognized close date versus sold time, full employee net including noncommission lines, immutable costs and actual department shift allocation. Finalized attendance completeness must be established independently. |
| Official calculation and comparison | payroll-calculation-run-service.js only blocked; scheme compare currently scenario input | Payroll adapter→calculate→typed daily/line/incentive/milestone snapshots→atomic committed readback; idempotency/adjustment history. Compare each version against the same authoritative manifest. |
| Existing payout integration | server.js legacy payroll entry creation and locked pay action → one linked payroll expense | Add unique run→existing entry linkage after ready writer, preserving paid history and retries; P&L accrual versus expense cashflow E2E. Existing payout path is reused. |
| Full product completion | Calendar substitutions, employee dashboard, period/advance semantics and full QA | Actual source-driven calendar/role assignment, employee KPI/deltas, all seven modes and periods, owner/tenant isolation, concurrency/refunds-after-paid-run and final server workflow. No pure helper or synthetic ready fixture substitutes this acceptance. |

Coordinator must assign exact shared producer files/hunks and next migration number before payroll edits those dependencies. The audit reserves no DDL number and authorizes no changes to POS/payment/loyalty/shift ledgers. Pricing/refund arithmetic helpers validate supplied facts only; their presence cannot enable officialReady.


### POS baseline confirmation and additional dependencies

POS turn01a102d2-83bf-7dc2-8781-a3d8f6341151 completed its read-only baseline and confirms no pricing/returns producer assignment. Besides first-tender/close/evaluator seams, Finance has an independent orderPricingSqlCtes path in server.js; its header/source truth must agree with the canonical source. Current venue model has no explicit currency field: producer needs an approved explicit currency/scale contract, never currency inferred from a payroll scheme. Proposal sent to coordinator: current ruble POS sourcev1 explicitly RUB/scale2 stored in new snapshots, or explicit venue monetary configuration; this is a proposal, not an accepted decision or a backfill authorization. New schema.sql additions must be dependency-reviewed because current base omits payroll077+parents; the full migration chain remains the authoritative fresh-bootstrap acceptance path. These findings do not permit payroll edits to shared producer files.
