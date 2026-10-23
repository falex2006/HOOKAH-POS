# Payroll: доказательства полной готовности

Цель остаётся полной: ТЗ «Гибкий модуль расчёта зарплаты CRM», owner-only правила, воспроизводимые snapshots и существующая цепочка payroll_entries → expenses. Состояние обновлено 2026-10-23; прежние доказательства отдельных подэтапов сохранены ниже. PASS отдельного сценария не означает готовность всего модуля.

## Актуальная интеграция — 2026-10-23

В отдельной локальной копии объединены canonical8af, зарплатный пакет и все пять принятых UI-коммитов до53fd690b. Проверки: default PG72335 до UI-пакета; actual POS margin PG90948; public v2 UI→HTTP→DB→reload PG91584 после полного объединения. Проверки справки, категорий финансов, настроек интерфейса, справочников склада и сотрудников прошли. Подробные границы: `docs/ai-team/payroll-current-integration-acceptance.json`. Сервер8af и исходные рабочие копии сохранены. Полный исходный объём ТЗ ещё не принят.

## Приёмка исходного зарплатного пакета — 2026-10-23

Guarded PG45799 подтвердил семь режимов на фактических источниках:21 сохранённый расчёт initial/partial/full,14 выплат через обычный owner lifecycle, оценки полного периода после возвратов и изменение премии коллег. Сохранённые результаты, выплаченные записи, расходы и квитанции остаются неизменными; оценка не создаёт удержаний. Margin-проверка использует реальный producer187 с известной нулевой стоимостью non-stock; исторический clock в одноразовой QA-базе отдельно ограничен тестовой подготовкой и восстановлен до COMMIT.

| Последний блок | Подтверждённое доказательство | Остаток приёмки |
|---|---|---|
|204: расчёт с возвратами | Все7 режимов,21 saved run/replay,14 paid entries, canonical typed provenance; исходные количества и отдельные merchandise/cash refunds. Default PG11166 exit0 PASS | Общая интеграция с текущим main |
|207: замена неоплаченной ведомости | Полный500/0 cohort; все старые строки отменены атомарно;8 rollback stages,10 дополнительных storage guards; actual UI→API→DB→reload, потеря ответа и точный повтор,4 ширины. Default PG11166 exit0 PASS | Общая интеграция с текущим main |
|208: корректировка после выплаты | Actual service: stable first claim500, current potential500→1000, apply/cancel/release/new target→zero settlement/waive500;6 rollback stages,12 storage guards,208 replay twice. Полный public UI→API→DB→reload, роли/tenant/CSRF,4 ширины, один исходный расход и однократные Finance accrual/cashflow. Default PG11166 exit0 PASS | Интеграция общего пакета |

Старый public203/205/206 путь прошёл повторно в45799 и79348 после исправления SQL-конфликта имени переменной208. Новый public v2 browser полностью прошёл в1127 после исправления двух QA-переходов. Итоговый общий default-прогон11166 exit0 PASS подтвердил все три блока вместе, полный прежний денежный путь и заключительные201 review/immutability/migration checks. Доказательства и границы сохранены в `docs/ai-team/payroll-refund-aware-acceptance.json`.

Полная цель остаётся активной. Помимо интеграции нужно проверить все требования исходного ТЗ, включая календарь подменных сотрудников, полный аналитический дашборд, сравнение на фактических данных с новой refund-aware policy и выплаты по полумесячным периодам. Эти требования не заменяются приёмкой трёх последних блоков. Развёртывание на сервере — отдельный этап после местной приёмки.

## Историческая матрица на 2026-10-19

| Этап / подэтап | Текущее доказательство | Что ещё требуется |
|---|---|---|
| 1. Версии, owner/tenant, история, даты, подтверждение риска | service/API/PG и browser→reload проверки | Финальная сквозная проверка после интеграции официального writer |
| 2. Семь режимов, персональные и позиционные правила | Calculator inheritance: 23 случая семи режимов; 15 поддержанных личных путей UI→HTTP→PG→reload; восемь личных scalar leaves допускают отсутствие у роли, complete effective mode проверяется по всем dated boundaries. Missing-role target UI save/reload/preview30→inherit20→restore30 ₽/activation принят. Дополнительное подтверждение cap выше роли и dated captions приняты; standalone cap без role cap: pure16, actual PG save/read/activation/rollback и browser HTTP→PG→reload50→inherit120→restore50 ₽ приняты, UI rev15. Milestone eligibility math/evidence/DTO отдельно. 2026-10-19: личный teamWeight без листа роли принят для обеих политик фонда; department/cap.department143 приняты через UI→HTTP→PG→reload→preview→activate (см. PAYROLL_INHERITANCE_ACCEPTANCE.md), UI rev19 | Оставшиеся границы полной матрицы и сквозное применение от официальных источников. Сквозной расчёт milestone eligibility на подтверждённых источниках; durable089 и owner service/digest/UI приняты локально (см. подэтап ниже) |
| 3. Табель и пропорциональная оплата | Immutable approval 082; verified transaction source интегрирован в preview; actual PG проверки stale/lineage/caller-forgery | Будущий общий official adapter; отдельно доказать согласование правила: исходное ТЗ считает факт смены по продажам, принятый архитектурный расчёт использует утверждённые фактические минуты и плановый знаменатель; совпадение этих правил не предполагается |
| 4. Источники продаж, скидок, возвратов, полной личной net выручки | POS attribution084 и producer090/144; payroll читает immutable recognized sale/refund manifest, canonical pricing и owner-versioned product→department revisions. Owner UI→HTTP→PostgreSQL→reload для классификации товара принят отдельным QA: normal/retro revisions, owner/tenant denial, idempotent replay, stale parent, точный исторический readback, отсутствие изменений runs/entries/expenses и узкий viewport. Actual HTTP→isolated PostgreSQL candidate QA: две строки/продавца, same-day owner mapping, approved minutes 120:60, точный team fund 2,680/1,340/0; post-refund team preview fails closed, no payroll writes. Recognition manifest независимо сверяет все raw refund headers и refund items для выбранных order IDs без ограничения по дате; orphan/mismatched rows и неполная detailed history закрывают coverage, watermark scope v3 фиксирует cohort и raw records. Owner refund review теперь сверяет каждую candidate impact line 1:1 с первичным refund event/line и оригинальной продажей, скрывая результат при любом расхождении | Signed refunds пока не являются входом калькулятора; полный watermark подтверждает только уже записанную историю на момент snapshot, не будущие возвраты. Owner mapping фиксирует управленческую payroll-классификацию, но сам по себе не подтверждает соответствие отдела фактической POS-смене. Полнота full employee net для cap и immutable margin cost ещё не подтверждены; candidate manifest не разрешает official calculation |
| 5. Детерминированные snapshots | Pure evidence/DTO; immutable schema087; milestone sidecar/durable089. 2026-10-19 private transaction-only writer: actual isolated PG PASS для всех семи режимов, полный readback/UUID lineage, valid/invalid recalculation reason, SAVEPOINT mutation guard, qualified constraints под shadow schema, atomic rollback после каждой семьи; entries/expenses неизменны. Добавлен source-bound candidate snapshot bundle с typed line evidence, replay и line/employee/day reconciliation; owner-only sourced API отдаёт его только в памяти и UI показывает детализацию; `persistence:none`. См. `docs/ai-team/payroll-snapshot-persistence/evidence.json` | Это не official snapshot. Writer пока не вызывается официальным маршрутом и принимает подготовленные данные без аттестации их источников. Нужны authoritative source→calculate→persist→reload и интеграция milestone/eligibility от подтверждённых источников |
| 6. Периоды 1–14 и 15–конец, выплаты и пересчёт | Существующий payroll entry/expense lifecycle; blocked-only новый run service; локальная owner-only read-only диагностика включительных пересечений legacy/flexible entries и явных expense links (`diagnosticOnly`, без блокировки или записи) | Unique run→entry linkage; идемпотентность/concurrency; owner-approved adjustments без перезаписи оплаченной истории; actual payout/report E2E без двойного P&L/cash-flow; final-month режим только после конца месяца либо отдельно согласованный advance/true-up |
| 7. Сравнение и сверка | Сценарное сравнение остаётся отдельным. Также реализовано owner-only sourced candidate comparison: версии считают server-side на общем `REPEATABLE READ` source bundle, с shared source watermark и per-version source-bound candidate snapshots; при неподтверждённом общем watermark суммы и снимки скрываются. Сравнение неофициальное и не создаёт записей | Official comparison после согласованных refund/cap/period policies и official snapshots; позиции vs признанная выручка/тендеры с расхождением ₽/% и объяснением liability/VIP/refund, без подмены commission base |
| 8. Подменный сотрудник из календаря | Движок допускает временные role assignments | Actual calendar→employee/assignment→расчёт; права/tenant и dated inheritance; общий календарь только с согласованным владельцем файлов |
| 9. Дашборд сотрудника | Полная приёмка ещё не доказана | Периоды/роль/сотрудник/цех; выручка, факт смен, среднее за смену, начислено, payroll/revenue, top items, доля цеха; KPI/рейтинг/динамика/утро-вечер от тех же источников, без второго хранилища фактов |
| 10. QA и последующее серверное развёртывание | Изолированные local PG/browser contracts и рабочий журнал | Общая регрессия после всех интеграций; пакетный workflow; deployment отдельным согласованным этапом |

## Текущий этап и следующий переход — 2026-10-19

Основной незавершённый этап — 4 из 10. Это не 40% готовности: часть инфраструктуры этапов 5–7 локально проверена, но полный source→calculate→persist→entry→pay ещё не принят. Личные teamWeight/department настройки больше не являются остатком этапа 2; полная матрица от подтверждённых источников остаётся впереди.

Finance producer144 уже согласован, локально принят и объединён в d831c77b: неизменяемая eligibility при создании строки, события продажи при закрытии и возврата в исходной транзакции, recognizedAt/timezone/localDate и lineage; исторического backfill нет. Проверенный набор политик: line_seller_snapshot + immutable_line_snapshot + recognized_event_date. Дополнительно локально доказан sourced team_fund candidate только до возвратов, с owner mapping, approved-minute распределением и отсутствием финансовых записей; после возвратов candidate закрывается fail-closed. Owner UI/API для неизменяемых product→department ревизий также прошёл локальный HTTP→PostgreSQL→reload QA. OfficialReady всё ещё false. Immutable recipe cost, полнота личного дохода для cap, подтверждение управленческой классификации по фактической POS-смене и staff attendance/shift основание отдельно не подтверждены.

Private transaction-only snapshots writer прошёл свою локальную pure+PG приёмку: все семь режимов, schema-qualified deferred constraints, rollback и полный readback. Это инфраструктура хранения, а не полный источник-ориентированный расчёт или официальный writer route. Read-only overlap diagnostic теперь помогает увидеть текущие legacy entries/expenses, но не резервирует интервал и не заменяет общий writer guard. Дальше нужны единый источник признанных продаж/refunds → полный calculator/manifest → контролируемое создание run, tenant-safe run→entry, согласованный overlap legacy/flexible начислений и идемпотентный pay через существующий expense writer. Margin/department/shift остаются gated до подтверждённых фактов. Финальная цель и этапы8–10 не сокращаются.

## Непереопределяемые условия

### Личный cap: текущий подэтап — 2026-10-03

MASTER подтвердил bounded ownership; standalone cap без role cap реализован в calculator/service/policy/UI. Pure 16 PASS, даты вне preview/ноль/оба inherit/malformed baseline/milestone policy и существующие ack parity проверены; source/dist rev15. Actual PostgreSQL lifecycle и browser нового cap приняты локально: independent5000/0/12000, атомарный отказ create/PUT/new-version, typed readback, active immutability и missing-leaf activation отказ; browser две карточки/даты, translated partial-cap400 с неизменными rows/revisions, фактический renderer50→120→50 ₽, пять ширин и readonly после активации. Исправлен выявленный PG обход full-window validation через смешанный регистр UUID: validation-only копии; обе стороны регистра, scalar/threshold/cap/policy ошибки и input immutability проверены. Активному второму продавцу комиссия1000 не меняется при изменении лимита первого. Канонические источники и выплаты этим изменением не закрыты.

### Проверенный стык сравнения с источниками — 2026-10-03

Read-only system_architect аудит и прямое чтение текущего кода: `payroll-scheme-service.js:compare` загружает версии в одной RR read-only транзакции, но передаёт каждому `calculateScenario` клиентский `previewInput`. Таким образом, одинаковый ввод доказывает сценарную сопоставимость; DB snapshot версий не подтверждает продажи, табель, refunds или costs. `payroll-snapshot-source-context.js` проверяет согласованность переданных строк, не их происхождение и полноту. `payroll-calculation-run-service.js` предоставляет только `createBlockedRun`; готового подтверждённого source bundle для compare нет.

Полный следующий интеграционный контракт должен получать один tenant-scoped manifest за один период, фиксировать его checksum/источники и применять к каждой выбранной версии без повторного независимого чтения фактов. Затем нужны actual source→compare HTTP→видимые суммы/дельты, отказ при stale/incomplete источниках, отсутствие postings и сохранение существующих overflow guards. Он зависит от handoff канонических sales/pricing/credit/refund/full-net/cost/department источников и payroll adapter; этот документ не разрешает 089 или shared edits.

Существующий verified attendance loader 082 уже используется в отдельном preview, но не в compare. Его возможное подключение к сравнениям закрывало бы только attendance: продажи и costs оставались бы сценарными. Такой промежуточный этап не заменяет полную приёмку сравнения на фактических данных и требует отдельного file-level handoff service/routes/UI. Новых продуктовых методов этим аудитом не добавлено.

- При недостаточных источниках официальный run остаётся blocked. Caller-provided coverage/cost IDs/UUIDs не являются подтверждением источника.
- Дневной предел выплаты проверяется против полной Finance-net выручки сотрудника, включая некомиссионные продажи. Сценарный turnover proxy не доказывает этот предел.
- Cap цеха за смену требует факта соответствующей смены/цеха; employee×department×day не всегда эквивалентен.
- Выплаченная история неизменяема. Исправление связывается с исходным run/line и проходит явное owner действие.
- Payroll не переписывает order/payment/loyalty ledgers или сменную кассу; shared pricing/refund этапы выполняют назначенные владельцы.
- Достоверный процент завершения пока отсутствует: крупнейшие интеграции ещё не имеют сквозного доказательства. Прогресс показывается по принятым подэтапам.


### Owner milestoneEligibility configuration — 2026-10-03

Координатор разрешил отдельный bounded service/UI этап после durable089 и pure pricing alignment. Scheme optional field проходит validation→config JSON→load/reload→scenario и digest; роль и личный параметр поддерживают strict enum, даты и inherit (личный→роль→схема→legacy all_active). Пустой control схемы удаляет optional field без изменения legacy digest/HTML. На базе без089 create/PUT/new-version/activation с любым из трёх уровней возвращают schema-required409 с rollback. Наличие таблиц не означает officialReady.

Фактический прогон96309 exit0: node scripts/payroll-milestone-configuration-qa.mjs --postgres —10 pure contracts, configuration PG, actual Chrome UI→HTTP→PG→GET/reload→preview refusal/inherit/restore→activation readonly→new-version/reload, durable089 PG и old-schema personal-cap PG PASS. Дополнительно personal-scalar PG PASS. Проверены invalid enum атомарные400, digest tamper409, RBAC/tenant, даты/expiry и no catchup, отсутствие entries/expenses/runs. Пять ширин1440/1024/768/375/320 без overflow;375 визуально проверен. Source/dist exact и payroll-only rev17; syntax/scoped diff и final code-health PASS, новых замечаний нет. Свой disposable container удалён, QA schemas удаляются с проверкой отсутствия.

Исправлены только QA ошибки: раскрытие day details перед чтением visible decision и проверка точных русских формулировок. Продуктовый renderer и расчётные guards не ослаблялись. Full goal active: authoritative pricing/refund/full-net/cost/department source adapter, atomic official writer и run→entry→expense/payout остаются отдельными интеграциями.


### Item-return arithmetic preparation — 2026-10-03

Coordinator approved new payroll-owned payroll-order-refund-evidence.js + own contract/docs only after architect/finance and code-health baseline. Full raw original pricing facts revalidated, canonical item/seller/tenant lineage preserved; BigInt cumulative HALF_UP quantity/value history, caps, duplicate/replay/sequence/chronology and zero-value deltas checked. Actual RED missingmodule→PASS; reversed-history QA expected error corrected (history rejection precedes sequence), no guard weakened. Refund contract1000independent integer oracle cases+fractional/half/full/zero/boundary PASS; bothpricing/sourcepolicy/sourcecontext/snapshotevidence/milestone-storage regressions PASS. Final health no findings; no runtimeconsumer or ledgerwrites. DTO explicitly supplied_item_return_arithmetic/not_attested/payment unknown; unknownseller remainsunknown. See PAYROLL_ORDER_REFUND_EVIDENCE_DRAFT.md. Fullgoalactive: canonical storage/producer and authoritative source adapter/officialwriter/payment linkage/payout integration still required.

### Наблюдаемая история возвратов091 — 2026-10-04

Подэтап4 дополнен отдельным read-only itemReturnEvidence в API готовности. Проверяется полный091 history затронутых заказов, исходный090 pricing и cumulative HALF_UP арифметика без использования суммы внешнего payout. Источник старого чека загружается даже при возврате в другом периоде. Unknown/cross-venue seller, unattributed history, legacy/missing pricing и timestamp ties дают явные ограничения; одинаковые timestamps не упорядочиваются по UUID. При available подтверждена только наблюдаемая арифметика; producerSequence/paymentLinkage not_attested. recognizedLineRefunds/fullEmployeeNetRevenue остаются unsupported и officialReady:false. Не реализованы признание периода/credit/clawback/официальная выплата; UI этого API этапа не менялся.

### Post092 read-only адаптация — 2026-10-04

Завершён ограниченный зарплатный adapter: sequence1…N по источнику, точные сохранённые previous/cumulative quantity/value и HALF_UP delta, independent от порядка timestamps/UUID. Legacy091 остаётся unsequenced/incomplete; sequence1 с ненулевым previous допустим только при сверке полного legacy aggregate, без аттестации его порядка. Targeted pure и фактический disposable PG092 upgrade/concurrency/rollback/readiness PASS; итоговый code-health без замечаний. Доказательство и точные команды записаны в WORK_LOG. officialReady:false сохраняется; recognition date/period/timezone и full employee net для non-commission items остаются product contract gaps. Производители, общие API/UI, schema/migrations и денежные записи не изменены.

### Межмодульный ownership handoff — 2026-10-04

Координатор подтвердил read-only сверку reader092, sequence QA и officialReady:false. Повторная проверка принятого пакета не требуется.

- Payroll: readiness и расчётный consumer.
- POS: исходные факты продаж, payments/refunds и смены.
- Finance: reconciliation и payout semantics.
- Loyalty: policy/evaluator; payroll reader и shared server не входят в его область.

Полный payroll остаётся заблокирован до явного согласования recognition date/period/timezone и full employee net для возвратов некомиссионных позиций. Official writer/payout — отдельный пакет после этого контракта. При расхождениях передаётся точный контракт координатору; встречные изменения общих файлов не выполняются. Все работы локальные; SaaS/production вне scope. Этой записью код, shared POS/Finance и officialReady не изменяются.

### Payroll: текущая сверка контрактов и очередь продолжения — 2026-10-04

Сверены фактические reader/readiness/run/sourcePolicies, решения POS/Finance/Loyalty и текущий WORK_LOG. Canonical090 и item-return091/092 компоненты уже реализованы; второго consumer не требуется. 088 внешний payout не является merchandise return value. 092 подтверждает только post-upgrade порядок; legacy baseline не подтверждает старую chronology. sourcePolicies сохраняют выбранное намерение владельца, а не исполнение политики. officialReady:false и blocked-only run остаются корректными.

| Компонент | Статус после сверки | Обязательное условие продолжения |
|---|---|---|
| Canonical090 pricing и seller observation | Реализованы; исправлена точность timestamp до PostgreSQL микросекунды | Проверяемый pricing source не заменяет commission eligibility/credit manifest |
| Item-return091/092 evidence | Реализован наблюдаемый consumer; legacy явно incomplete | Для recognition требуется отдельная политика; старые sequence не восстанавливаются |
| Payroll sale credit | Unsupported | Утверждённый source/credit contract и правила unknown/cross-venue. Обязательный line seller из ТЗ не подменяется opener/cashier |
| Recognized line refunds | Unsupported | Конкретное immutable поле recognition date, timezone и правило периода: дата события либо коррекция исходного периода; связь с исходным run и следующей открытой корректировкой |
| Full employee net | Unsupported | Полный набор строк, включая non-commission; правила attribution и возвратов при выбранной recognition policy. Payout, VIP minimum и liabilities не подставляются как employee net |
| Margin cost | Unsupported | Исторический immutable cost source и обработка возвратов от назначенного владельца источника |
| Department/shift allocation | Unsupported | Manifest связи продаж с цехом/сменой; согласование факта смены по продажам с approved attendance минутами |
| Official writer/run→entry→expense | Не реализован; попытки только blocked | Принятый полный source manifest и отдельный writer/payout handoff с идемпотентностью и неизменяемой оплаченной историей |
| Подтверждённое сравнение схем | Пока сценарное | Один авторитетный manifest/checksum для всех выбранных версий |

Безопасный закрытый дефект этой сверки: Date.parse терял микросекунды и пропускал несовпадение lock/capture либо продажу после lock в пределах миллисекунды. payroll-canonical-pricing-source.js теперь сравнивает exact BigInt microsecond instants, поддерживает ISO/PG timezone offsets и проверяет календарь. Pure, реальный PostgreSQL timestamp-text QA четырёх timezone и узкие regressions PASS; DTO/readiness/officialReady не менялись.

Отдельный возможный UI этап: существующий fixed-list readiness renderer не показывает itemReturnEvidence и новые attribution/sequence counts. Принятый source handoff был API-only; для UI нужен отдельный bounded ownership handoff, этот аудит интерфейс не изменял. Новые миграции не создавались; номера093/094 уже заняты в текущем дереве и не присваиваются payroll автоматически.

### Candidate migration144 recognition manifest — 2026-10-19

Implemented a payroll-owned read-only consumer over immutable sale/refund recognition events144, canonical pricing090, and complete related return history092. It requires a caller-owned `REPEATABLE READ READ ONLY` transaction, checks activation epoch and frozen recognition date/timezone, uses conservative period-boundary candidates only to detect missing post-epoch events, validates full line attribution/source coverage and sequential returned quantity/value, and keeps cash payout/tender separate from returned merchandise value. Historical refund events linked to a period sale are validated and included in the deterministic watermark even when recognized outside that period. Status is candidate-only and `officialReady:false`; no calculation, payroll run, entry, expense, or payout path is connected.

Pure manifest contract, adjacent canonical-pricing/item-return/snapshot/source-policy contracts, JS syntax, runner guard42, and `git diff --check` PASS. Real guarded PostgreSQL QA created an isolated tenant and sale through authenticated HTTP, issued two separate one-unit returns against a two-unit line, and read the resulting manifest under `REPEATABLE READ READ ONLY`: source sequence1→2 and cumulative merchandise return20100 minor units were preserved, while two cash payouts totaled200 minor units; no payroll entry or expense was created. The runner verifies and drops its owned disposable database. Evidence: [payroll recognition manifest QA](../ai-team/payroll-recognition-manifest/evidence.json). Independent final code-health review GO. No production, server, or GitHub release performed.

### 2026-10-19 — Calendar function context in payroll attendance

Migration 175 adds a nullable immutable pair of scheduled function ID/name to attendance approval shifts. Source manifests include the assigned calendar function and its name; changes invalidate the previous approval watermark and require a new owner approval. Older snapshots are preserved without inferred backfill. Missing schema returns a named readiness error. A missing assigned function blocks approval; an unassigned function remains valid descriptive context.

The owner coverage table and approved-attendance preview display this context (UI revision 28). It does not establish payroll role, sales attribution, department, or POS station eligibility and does not change calculation amounts. No additional context is exposed by sourced candidate calculation responses. Official calculation remains blocked; no entry/expense writer is enabled.

Evidence: isolated PostgreSQL approved-attendance source contract PASS; browser PostgreSQL payroll scheme QA PASS; payroll scheme migration contract PASS; migration registry contract PASS; UI and sourced-preview contracts PASS. Local implementation only, no GitHub or server deployment.

### 2026-10-19 — Candidate personal-revenue reconciliation and historical attendance upgrade

The candidate snapshot builder now rebuilds the merchandise-net source from the same recognition manifest and saved source policy, verifies the source component watermark, and reconciles calculator sale turnover with the source and calculator personalRevenueCents for each employee/day. Covered sparse days may contribute zero only after complete source validation. Missing source, tampered values or watermark, unsafe amounts, omitted source days, and mismatched day revenue prevent snapshot creation. The snapshot records a bound no_refund_merchandise_net_only reconciliation summary. This does not change wage mathematics, make merchandise revenue a complete income cap basis, or enable official calculation/persistence.

Checks: candidate-calculation contract PASS, including sparse zero day, sale day mismatch, missing source, source hash tampering and unsafe amount after outer-envelope rehash; sourced-preview and sourced-comparison contracts PASS; JS syntax PASS. Browser integration is tracked separately until its running process completes.

The previously outstanding pre-175 compatibility case is now covered by real isolated PostgreSQL: insert a legacy approval and shift before DDL, apply migration175 twice, compare complete prior column values unchanged, verify added context remains NULL, and require a fresh approval via stale status. Test PASS. Empty periods without scheduled rows need not change watermark. No release performed.

Browser integration for candidate personal-revenue reconciliation: isolated PostgreSQL payroll-scheme-browser-postgres-qa.mjs PASS, including sourced preview and no financial posting.

### 2026-10-19 — Exact cost allocation arithmetic for the missing producer

Implemented `inventory-order-cost-allocation.js`, a pure producer component, plus its focused contract. It consumes captured sale lines, actual depletion components and actual movements; decimal6 quantities and decimal4 costs use BigInt with raw scale10. Per-movement quantities must reconcile exactly; line/movement/ingredient identities are validated and canonicalized. Duplicate identities/components, unproven tracked lines and non-stock consumption are incomplete. Half-up order total must match the supplied persisted total; line cents use deterministic largest remainder and sum to that total. A known zero valuation is allowed, unknown valuation is not.

Pure contract and JS syntax PASS: fractional micro-units, rounding ties, input permutations/case, duplicates, source mismatch, unsafe totals, zero/non-stock evidence and positive raw values rounding to zero. This module is not yet called from close paths and does not create historical cost evidence by itself. No schema or ledger changes in this slice. The reader and transactional append-only writer remain necessary.

Migration coordination: flexible-loyalty currently contains176–186, so187 was requested (not yet allocated) from chat ЛОЯЛЬНОСТЬ. Payroll172–175 are retained. Independent system_architect confirmed the existing lock order and code-health baseline; final review requested.

### 2026-10-19 — Capture actual depletion provenance

Added inventory-order-cost-capture.js and narrow depleteRecipeForOrder changes: read orderItemId with the selected recipe, retain the actual recipe payload and normalized component quantities, capture the exact locked stock cost, and read actual movement IDs/quantities from INSERT RETURNING. Existing stock quantities, premix allocation and COGS formula remain unchanged. Capture is returned internally as costEvidenceInput; it is not persisted and is not a payroll-ready source yet.

Legacy requirements without line identity and non-stock legacy consumption remain incomplete; all actual movements are retained. Already-depleted evidence is unavailable. Code-health identified a zero-requirements historical loophole; fixed with read-only lookup for prior outgoing movements OR order_costs before accepting a new zero capture. The original totalCost0 behavior is unchanged. Deep copies preserve used recipes/costs after mutable objects change.

Pure capture and allocator contracts PASS. The actual server function's zero branch is exercised through VM with controlled query results for new versus historical orders; no writes are permitted by that regression. Initial live PostgreSQL depletion regression PASS (413 assertions, synthetic fixture; fresh owned database removed); a repeat after the zero-path fix is pending. No migration allocated and no writer/reader readiness enabled. Final review requested.

## 2026-10-19 — Current migration mapping and cancelled-order evidence

Current payroll migrations are188–191 (historical172–175 respectively); see MIGRATIONS.md for exact filenames. SQL hashes were unchanged by rename. Loyalty172–186 and producer187 require subsequent combined-tree validation; no user database upgrade is claimed.

Recognition rejects source orders whose status is not closed, retaining immutable events and hashing raw status. Pure and isolated PostgreSQL recognition tests PASS. After fixture correction to install actual schedule101–104 plus191, PostgreSQL source-readiness PASS; approved-attendance, employment-eligibility, department-migration and scheme-migration also PASS. Independent code-health GO is scoped to these changes. These results do not enable official calculation, signed refunds, payout persistence or deployment.

## 2026-10-19 — Source-bound margin candidate, verified local chain

Current runtime integrates authoritative producer187 with readiness, server bundle, calculator input and candidate snapshot. Actual guarded HTTP/PostgreSQL QA proves a quantity2 sale with20100 net revenue and5000 full line historical cost yields15100 margin and1510 commission at10%. Owner department/eligibility/approved attendance required. Result and snapshot remain unchanged after mutable recipe/cost edits; current linked refund blocks both. Preview leaves payroll runs/entries/expenses unchanged. Snapshot cost and producer watermark match persisted evidence. Command: `node scripts/local-full-pg-regression.cjs payroll-margin-source-postgres-qa.mjs`; PASS and disposable DB cleanup confirmed. Log: tmp/full-local-qa/pg-payroll-margin-source-postgres-qa.mjs.log.

Source-level missing/foreign/zero-unattested negatives PASS; absent187 readiness unsupported PASS. Pure tests cover cost/hash/product tampering, complete-empty, quantity normalization, late related refunds, replace/additive and non-margin role override. Cross-period HTTP refund is not claimed. This advances margin candidate support, not official payroll/run persistence/payout readiness.

### Проверено 22.10.2026: сохранённый расчёт в интерфейсе

В attached worktree `C:/Users/ADMIN/.codex/worktrees/payroll-source-integration/HOOKAH CRM 2` теперь подтверждён публичный owner-only путь сохранения и чтения расчёта: HTTP/UI → PostgreSQL → повторное открытие → сотрудник → день → строки продажи. Guarded payroll-verified-run-postgres-qa PASS; доказательства и ограничения записаны в WORK_LOG за 22.10.2026. Более ранние формулировки «public saved-run API/UI следующий этап» устарели: этот подэтап принят локально. Выплаты и начисления этим действием не создаются.

Для сохранённых строк уточнены объяснения личного плана, маржи и командного фонда; неизвестная себестоимость не показывается нулём. Actual-renderer contract PASS, code-health final GO, source/dist parity подтверждена. Browser QA покрывает процентный режим и replay после потери ответа; все режимы в браузере не приняты. Полная цель остаётся открытой: signed refunds и аудируемые корректировки, точное независимое воспроизведение движка, run→entry→pay, календарный сценарий, dashboard и финальная сквозная приёмка.

### Проверено 23.10.2026: точное повторение сохранённого вычисления

Закрыт ранее отмеченный пробел полного входа/результата движка. Новые runs сохраняют полный calculatorReplay внутри immutable provenance; source-fenced сбор и write transaction остаются прежними. Owner-only API и кнопка повторного вычисления используют исключительно сохранённые данные и возвращают результат сравнения контрольных сумм. Legacy без payload и неизвестная версия движка явно отмечены и не скрывают старую расшифровку. Actual guarded PostgreSQL+HTTP/browser PASS, детали и ограничения в WORK_LOG за 23.10.2026. Это завершение подэтапа воспроизводимости этапа5, не завершение всего этапа5 или выплат. Signed refunds/корректировки и run→entry→expense/pay остаются открытыми.

### 2026-10-23 — Актуальность источников сохранённого расчёта

Добавлен owner-only POST /api/payroll/calculation-runs/:id/freshness с пустым JSON и без query. В одной source-fenced RR/RO транзакции сервер проверяет сохранённый provenance, собирает источники по замороженной версии схемы и строит проверенный расчёт. Сравнивается полный inputWatermark и часовой пояс; меняющиеся timestamp/closure/calculation hashes не используются как признак изменения данных. Ответ current/stale/blocked относится только к моменту проверки, не является разрешением выплаты. Суммы и история не переписываются; entries/expenses не создаются.

В карточке расчёта появилась кнопка «Проверить актуальность данных», краткий результат, раскрываемые причины и время проверки. При повторном открытии состояние сбрасывается; запоздавший ответ другого расчёта игнорируется. Scoped UI revision31, source/dist SHA совпадают. Новых миграций нет; shared server/db не изменялись в этом пакете.

Проверки PASS: payroll-run-freshness-service-contract (реальный service/fence/reader error path; для callback success изолированная VM-подмена, не источник), payroll-saved-run-routes-contract, payroll-saved-run-reader-contract, payroll-saved-line-explanation-contract, payroll-scheme-ui-contract; синтаксис и scoped diff-check. Guarded `node scripts/local-full-pg-regression.cjs payroll-verified-run-postgres-qa.mjs` завершён exit0: неизменившийся источник при разных timestamp; новая eligibility revision с той же суммой даёт stale; ожидание активного producer до RR; полноценный поздний возврат с исходной оплатой, счётом и tender, распознанный реальными триггерами за пределами месяца продажи, даёт blocked; сохранённый replay по-прежнему совпадает. Полный evidence_payload и число entries/expenses неизменны. Браузер подтверждает owner/foreign-tenant denial, strict body, current/stale/blocked, reload, delayed response после переключения и ширины1440/768/390/344. Артефакты: tmp/payroll-saved-runs-qa/1792701645788-45848; лог tmp/full-local-qa/pg-payroll-verified-run-postgres-qa.mjs.log. После PASS в QA helper добавлены reject/timeout ожидания route.fetch; эта защита ошибочного пути проверена синтаксически. Architect/code-health GO. Визуально просмотрены desktop и344px.

Границы доказательств: synthetic historical percent_only fixture с настоящими producer triggers и реальным временем сервиса; это не весь POS-to-next-day-payout сценарий. Отдельные end-to-end кейсы изменения подтверждённого табеля и timezone не добавлены в этот пакет. Функция — необходимая проверка внутри будущих materialize/approve/pay, но не завершённый bridge. Полный модуль остаётся незавершённым: reviewed late-refund adjustments, защищённая связь run→entry, общий overlap gate, утверждение/выплата и полная приёмка ещё обязательны. officialReady/payoutEligible=false. Публикации и развёртывания не было.

### 2026-10-23 — Проверка возвратов после сохранённого расчёта

Закрыт локальный подэтап review: migration201, server-owned assessment, immutable cases/assessments/decisions/exact-request replay, owner API и UI32 внутри сохранённого расчёта. Доказательство: final guarded PG/browser session78821 exit0; артефакты tmp/payroll-saved-runs-qa/1792704257734-39220; подробная матрица и ограничения в WORK_LOG за эту дату. Подтверждены реальный late return, различие merchandise/payout/salary, решения hold/close и доказанный zero, stale/tenant denial, concurrency, rollback, archived seller, unknown cap/unallocated refund и migration replay без изменения истории. Pure assessment38 отдельно покрывает cumulative rounding, nonlinear/fixedpay ограничения и unavailable-engine metadata.

Это завершение журнала рассмотрения, не этапа денежных корректировок или всего payroll. Full goal remains active; officialReady=false, payoutEligible=false. Следующий обязательный замкнутый сценарий: authoritative saved run → entry → approve → single expense → late refund → owner decision → единственное применение к следующему открытому неоплаченному начислению. Нужны correction-aware source/provenance без исключения refund из manifest, неизменяемые связи, общий overlap constraint и согласованное с MASTER финансовое признание. Альтернативные непроведённые savedruns не становятся отдельными требованиями к сотруднику. Частные PASS не разрешают выплату.

## 2026-10-23 — Run→entry bridge, draft-only

Owner materialization, linked registry display and cancellation implemented. Migration202 preserves legacy components and enforces mixed/run period overlap exclusions. Actual browser+PostgreSQL QA93943 PASS with register navigation/cancel, replay, rollback, role/tenant and no expense; standalone DB QA69933 PASS59. See WORK_LOG and PAYROLL_CALCULATION_ENTRY_BRIDGE.md. Capability remains officialReady:false/payoutEligible:false. Not complete: reviewed monetary allocation persistence/API, correction-aware source evidence, approve/pay and full financial acceptance.

### 2026-10-23 — correction ledger prerequisite accepted locally

Migration203 and internal correction writer now persist exact apply/waive/release history with source identity, partial balances, fixed-pay protection, actual target net reconciliation, complete cancellation and request retry. Final isolated PostgreSQL test63284 PASS61 exercises actual SQL and store with synthetic upstream evidence; authenticated real paid-source acceptance remains open. Existing real collector/browser regression81290 PASS (including still-blocked payout). Pure policy/command, source-proof and store behavior tests PASS; independent code-health GO is limited to this internal package. See WORK_LOG for commands and exact limits. No public monetary route is enabled. Current outstanding work is205 lifecycle/expense protection, public correction integration,204 refund-aware full input/engine and final complete financial acceptance; module is not yet ready for actual payroll payouts.

### 2026-10-23 — Lifecycle205 подтверждён локально

Предыдущие записи о draft-only и отсутствии205 описывают прежнее состояние. Теперь owner-only approve/pay/cancel установлен: сохранённый расчёт проходит реальную проверку источника, положительная выплата создаёт один защищённый расход, нулевая закрывается без расхода. Квитанции неизменяемы, повтор после потери ответа не дублирует деньги. Dedicated DB60 PASS и actual source/HTTP/browser/finance suite PASS (финальный session14280, artifacts tmp/payroll-lifecycle-ui-qa/1792733226662-26156). Семь точек rollback, роли/tenant, calendar date, P&L/cashflow once, четыре ширины и восстановление запросов проверены. Подробности WORK_LOG.

Полный модуль не завершён: применение/отказ203 через UI, zero-paid источник корректировки,204 полный пересчёт после возвратов и нелинейные схемы остаются в работе. Production не обновлялся.

### 2026-10-23 — Public203/206 подтверждены реальными источниками

Предыдущий остаток по public203 и zero-paid206 закрыт локально: итоговый guarded PG/browser23185 PASS. Проверен полный путь paid original→late return→explicit next-period draft→partial application→cancel/release→new draft application→zero completion→own later return, плюс waiver остатка, пять/три точки rollback, потеря ответа, reload/concurrent exact retry и неизменяемость прошлой выплаты. Пять lifecycle entries создают ровно один расход; incoming correction не учитывается повторно при собственном возврате нулевого начисления. Четыре ширины, API/БД, роли/tenant и прежние сценарии review проходят. Подробные артефакты и исправления граничных дат — в WORK_LOG.

Остаётся204: полный пересчёт всех режимов с возвратами, атомарная замена неоплаченных начислений и оценка нелинейного влияния на уже оплаченные расчёты. Готовность всего модуля и production не объявляется.
