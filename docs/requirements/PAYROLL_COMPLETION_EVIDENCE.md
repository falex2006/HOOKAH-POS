# Payroll: доказательства полной готовности

Цель остаётся полной: ТЗ «Гибкий модуль расчёта зарплаты CRM», owner-only правила, официальные snapshots и существующая цепочка payroll_entries → expenses. Состояние на 2026-10-03. PASS отдельного сценария не означает готовность всего модуля.

| Этап / подэтап | Текущее доказательство | Что ещё требуется |
|---|---|---|
| 1. Версии, owner/tenant, история, даты, подтверждение риска | service/API/PG и browser→reload проверки | Финальная сквозная проверка после интеграции официального writer |
| 2. Семь режимов, персональные и позиционные правила | Calculator inheritance: 23 случая семи режимов; 15 поддержанных личных путей UI→HTTP→PG→reload; восемь личных scalar leaves допускают отсутствие у роли, complete effective mode проверяется по всем dated boundaries. Missing-role target UI save/reload/preview30→inherit20→restore30 ₽/activation принят. Дополнительное подтверждение cap выше роли и dated captions приняты; standalone cap без role cap: pure16, actual PG save/read/activation/rollback и browser HTTP→PG→reload50→inherit120→restore50 ₽ приняты, UI rev15. Milestone eligibility math/evidence/DTO отдельно | Личные team/department параметры; оставшиеся границы полной матрицы. Сквозной расчёт milestone eligibility на подтверждённых источниках; durable089 и owner service/digest/UI приняты локально (см. подэтап ниже) |
| 3. Табель и пропорциональная оплата | Immutable approval 082; verified transaction source интегрирован в preview; actual PG проверки stale/lineage/caller-forgery | Будущий общий official adapter; отдельно доказать согласование правила: исходное ТЗ считает факт смены по продажам, принятый архитектурный расчёт использует утверждённые фактические минуты и плановый знаменатель; совпадение этих правил не предполагается |
| 4. Источники продаж, скидок, возвратов, полной личной net выручки | POS attribution084 и producer090; payroll read-only canonical pricing reader и компонент readiness подключены. Проверяются полный набор строк, RUB/scale2, raw decimal/BigInt gross, точное распределение скидок, tenant/date/legacy и отдельная неизвестная/cross-venue атрибуция. Existing-source readiness: actual RR/read-only concurrent snapshot, rollback/recovery, 12 сохранённых policy сочетаний с независимыми required facts, tenant/date/checksum isolation и timezone midnight PASS; officialReady:false сохраняется | Применение credit/refund policy и чтение построчных возвратов091; полная личная net выручка; цех/смена; margin cost; согласованный авторитетный source manifest. Pricing availability не подтверждает payroll credit. Cross-venue employee077 пока unsupported. POS088 unattributed refunds не доказывают line/employee lineage |
| 5. Детерминированные snapshots | Pure evidence/DTO; immutable schema 087; PG replay/guards; milestone evidence replay/independent attendance и detached дневной sidecar в пяти режимах. Durable089: committed calculator/DTO→PG→полный readback, пустой день/отказ без payout,26 atomic negatives, legacy history/replay/fresh catalogs, shadow path и ограниченная двухклиентная concurrency PASS | Подключение durable milestone хранения к будущему atomic official writer, только от авторитетных источников; canonical IDs до расчёта; checksum полного входа; actual source→calculate→persist→reload. Таблицы089 не включают service/UI eligibility и не аттестуют источники |
| 6. Периоды 1–14 и 15–конец, выплаты и пересчёт | Существующий payroll entry/expense lifecycle; blocked-only новый run service | Unique run→entry linkage; идемпотентность/concurrency; owner-approved adjustments без перезаписи оплаченной истории; actual payout/report E2E без двойного P&L/cash-flow; final-month режим только после конца месяца либо отдельно согласованный advance/true-up |
| 7. Сравнение и сверка | Сценарное сравнение на одинаковом вводе | Сравнение на одном подтверждённом manifest; позиции vs признанная выручка/тендеры с расхождением ₽/% и объяснением liability/VIP/refund, без подмены commission base |
| 8. Подменный сотрудник из календаря | Движок допускает временные role assignments | Actual calendar→employee/assignment→расчёт; права/tenant и dated inheritance; общий календарь только с согласованным владельцем файлов |
| 9. Дашборд сотрудника | Полная приёмка ещё не доказана | Периоды/роль/сотрудник/цех; выручка, факт смен, среднее за смену, начислено, payroll/revenue, top items, доля цеха; KPI/рейтинг/динамика/утро-вечер от тех же источников, без второго хранилища фактов |
| 10. QA и последующее серверное развёртывание | Изолированные local PG/browser contracts и рабочий журнал | Общая регрессия после всех интеграций; пакетный workflow; deployment отдельным согласованным этапом |

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
