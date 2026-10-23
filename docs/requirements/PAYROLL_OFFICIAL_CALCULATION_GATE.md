# Gate перед официальным расчётом зарплаты

**Статус:** рабочий проект для согласования с MASTER и финансовой моделью. Не является утверждённой финансовой политикой и не разрешает `ready` run, official snapshots, начисления или выплаты.

## Текущее доказанное состояние

- Owner-only версии схем, история допуска работников и источники-претенденты доступны в локальном контуре. Период, площадка и версия разрешаются сервером; tenant/RBAC-проверки и повторное чтение уже покрыты локальным PostgreSQL/HTTP QA.
- Owner-only GET `/api/payroll/entry-overlap-diagnostic` показывает текущие `draft/approved/paid` начисления с включительным пересечением периода, legacy `rule_id IS NULL`, явную ссылку `expense_id` только в той же площадке и отдельный список `source='payroll'` расходов. Это `diagnosticOnly`, provenance расчётов неизвестен; запрос не создаёт и не меняет run, entry, expense или payout и не является проверкой готовности official calculation.
- Кандидатная серия чистой стоимости товарных строк после скидок и возвратов связана с исходной строкой и продавцом, использует даты признания событий и имеет fail-closed coverage. MASTER подтвердил её отдельное отображение, но не признал комиссионной базой, полным доходом сотрудника или зарплатным корректирующим ledger.
- Официальный purpose `payroll-calculation-input-contract.js` остаётся заблокированным до подтверждения mode-dependent компонентов и возможностей движка (`signedRefundAdjustments:false`, `fullEmployeeNetRevenue:false`). Отдельный `candidate_preview` может передать данные в неплатёжный расчёт только при полном подтверждённом наборе фактов и доказанном отсутствии связанных возвратов в том же снимке; это не открывает official calculation или writers.
- `payroll-calculation-run-service.js` создаёт только идемпотентный `blocked/unknown` заголовок. Typed snapshot serializers/persistence — проверяемые примитивы, не подключённые к official-ready маршруту. Запись расхода зарплаты сейчас выполняется только существующим действием `pay` для `payroll_entries`.
- Не изменять order/payment/loyalty/shift ledgers; не выводить отдел из изменяемых `products.category`, названия или `order_items.station` без утверждённого исторического mapping.

## Предлагаемые решения для подтверждения

| Тема | Предлагаемый рабочий default | До подтверждения |
|---|---|---|
| Источник и база комиссии | **Решение владельца:** комиссионная база — чистая сумма товарной строки после распределённой скидки и привязанных к исходной строке возвратов. Для расчёта брать immutable pricing/recognition facts; скидку заказа не вычитать повторно, payout/tender возврата не подменяет возвращённую стоимость товара. Сохранённая версия схемы определяет eligibility и `replace/additive`; некомиссионные товары остаются в полном товарном net. Депозиты, авансы и loyalty-движения в базу не входят. Это решение о составе базы не доказывает полноту источника и само по себе не разрешает официальный расчёт | Candidate line series можно использовать только после доказательства полного source coverage и прохождения mode-dependent input contract; неподдержанные возвратные/сотрудниковые данные остаются `unknown`, не нулём |
| Дата возврата после продажи/увольнения | Использовать immutable `recognizedLocalDate` и timezone, сохранённые у события. Получатель кандидатной корректировки — исходная строка/credited seller, включая бывшего сотрудника; исходную продажу повторно не включать. Текущий timezone заведения не должен переинтерпретировать старый факт | Не менять wages на основании candidate refund |
| Отрицательная переменная сумма | Сохранять знак в расчётном evidence; не создавать отрицательную зарплатную выплату, не удерживать из fixed pay и не превращать остаток в долг сотрудника автоматически. Если approved policy не задаёт допустимое погашение, блокировать финализацию с видимым остатком | Не включать `signedRefundAdjustments` в калькулятор |
| Возврат по закрытому периоду | Разделить дату признания исходного события и период применения зарплатной корректировки. Предложение — не переписывать прежний run/paid entry, а создавать отдельную lineage-linked корректировку позже; signed source и correction должны быть взаимоисключены/сверены, чтобы исключить двойной учёт. Само применение в следующем периоде и подтверждение остатка ещё требуют решения | Не создавать correction run/entry; не выполнять удержание или clawback |
| Личный потолок выплаты | Проверять только по полной согласованной базе дохода сотрудника. Имя candidate-компонента `fullEmployeeNetRevenue` само по себе не доказывает полноту для абсолютного потолка; текущая серия подтверждает товарные строки в своей coverage, а охват иных видов дохода открыт | Все конфигурации, для которых действует абсолютный потолок, остаются blocked |
| Период и закрытие | Вход фиксирует точный venue-local диапазон, timezone и правило закрытого месяца для каждого режима; поздние события не меняют ранее сохранённый snapshot | Не считать доступность источника доказательством полного периода |
| Полнота связанных возвратов | Manifest в одном repeatable-read snapshot независимо читает все raw refund headers и raw refund items выбранного order cohort без ограничения по дате периода, затем сверяет их с recognition events, detailed item history и line events; orphan/mismatched records делают coverage incomplete, watermark scope v3 включает raw records и cohort | Attestation ограничен уже записанной историей на момент snapshot; поздний refund после чтения требует отдельной approved correction/review policy и блокирует зависимый official run |
| Typed snapshots | Один immutable source/input fingerprint и сохранённые engine/config versions; общие поля: tenant, venue, схема и её digest, точный период, timezone, currency, attendance/refund/source watermarks; детализация employee/day/order-line со снапшотами имени/роли/отдела, сумм, правил, округления и lineage. Пороговые/team/margin/milestone-компоненты должны проходить собственные типизированные reconciliation checks | Существующие serializer/DB primitive не считать подтверждением полноты или права на запись |
| Сравнение режимов | Версии используют один замороженный набор исходных фактов и один baseline. Если source policies различаются, производные проекции и их watermarks сохраняются по каждой версии отдельно; одинаковый итоговый projection/input watermark требовать нельзя. Недостающий source означает «несравнимо/blocked», не ноль. Сравнение не создаёт payroll entries и по умолчанию неперсистентно | Не сравнивать версии на разных raw source snapshots и не склеивать их derived projections |
| Run → entries → expense | Отдельное owner-действие создаёт draft entry не более одного раза для сотрудника/run; overlap-check охватывает live legacy rows, включая `rule_id IS NULL`. Для явно lineage-linked коррекции нужен отдельный типизированный exception и уникальность, чтобы он не обходил общий overlap guard. Нужны строгая идемпотентность и атомарный retry; approved/paid snapshots неизменяемы. Расход создаёт только существующий `pay`. Частичная выплата выключена до отдельного контракта | Не подключать snapshot persistence к run service и не создавать новые expense/payroll writer пути |
| Доступ | Конфигурация, точные ставки, расчётные детали и сравнения доступны только owner-only payroll guard, пока отдельно не утверждена более широкая матрица чувствительных зарплатных данных | Не выводить зарплатные суммы через общий `finance_read` API |

Эти пункты — предложения для сверки, а не уже действующие разрешения. Если MASTER/Finance принимает другие варианты, код и критерии приёмки должны отражать утверждённые варианты до writer-интеграции.

## Уточнения после ревью MASTER — 2026-10-19

- В accrual P&L `approved/paid payroll_entries` учитываются один раз по расчётному периоду; связанный payroll expense относится к cash flow по фактической выплате и не повторяет расход в P&L. Для correction entries ещё нужны свои правила признания.
- Возврат сохраняет исходные `recognizedLocalDate`/timezone; будущий расчётный период применения adjustment — отдельное поле/решение и не меняет дату признания POS-события.
- Сравнение фиксирует одинаковые исходные факты, но допускает разные policy-derived projection и watermark для разных версий.
- MASTER согласился, что отрицательный остаток без автоматического долга/удержания и единственный existing pay path — защитные границы. Политику отрицательного остатка, закрытых периодов и состав full-net cap он не утвердил.
- Lineage сам по себе не разрешает пересечение периодов. Любое исключение для correction требует отдельного контракта корректировок и доказуемой защиты от двойного учёта; до него действует общий overlap guard.
- MASTER подтвердил по summary, что эти формулировки отражают его позицию, но не перечитывал обновлённый файл. Документ остаётся черновиком; код и writers этим подтверждением не одобрены.

## Последовательность после согласования

1. Зафиксировать решения по возвратам, отрицательным результатам, полноте личного net, period close, department mapping, snapshot identity и lifecycle в утверждённом контракте.
2. Реализовать недостающие исторически авторитетные read-only источники и их coverage/watermarks; каждая конфигурация режима получает свой dependency set.
3. Подключить проверенный bundle к чистому калькулятору и сравнивать режимы на одинаковых immutable inputs; повторный расчёт обязан воспроизводить тот же output checksum.
4. Только после полного доказательства input completeness подключить immutable typed snapshots и run approval. Проверить line/day/employee reconciliation и replay до создания entries.
5. Отдельно реализовать согласованный run → draft entries → approve → существующий pay → единственный expense путь, с overlap, идемпотентностью, rollback/fault injection и tenant/role QA.

## Обязательные acceptance cases

- Продажа, полный/частичный возврат в том же и другом месяце, возврат после завершения работы исходного продавца, неизвестная атрибуция, переполнение суммы и неполный epoch/period coverage.
- Возврат меньше/равен/больше комиссии; нулевая и отрицательная employee-day/month база; никакого неявного zero-floor или изменения fixed pay.
- Snapshot повторно сериализуется из сохранённых версии конфигурации и source bundle без чтения текущих mutable справочников; событие/строка/день/сотрудник сверяются по сумме и lineage.
- Сравнение нескольких версий использует один input watermark; unsupported dependency не превращается в 0.
- Повтор run/entry/pay не создаёт дубль; overlap блокируется против legacy и run-linked entries; `approve` не создаёт expense; действующий `pay` создаёт ровно один; отказ посередине транзакции не оставляет частичных связей.
- Проверены владелец, другие роли и соседняя площадка; все незатронутые POS/payment/loyalty/shift ledgers совпадают до и после payroll-сценария.

## Уточнение владельца Finance и источника маржи — 2026-10-19

MASTER (чат `01a0ebe0-5276-7c30-8a75-6983bd6d0e4e`) подтвердил финансовое владение и отсутствие отдельного найденного финансового чата. Проверка main `a87b2eb6` и payroll worktree не обнаружила authoritative историческую себестоимость проданной строки: `inventory_purchase_document_lines.receipt_unit_cost` описывает приход, `ingredients.cost` изменяется при новых поставках, а `cost_snapshot_json` миграции087 — контейнер результата payroll, не producer себестоимости продажи.

Источник для `marginCosts` должен предоставляться складским/POS контуром под финансовым контрактом MASTER: immutable sale-line identity, фактический состав и количества списания, историческая оценка, валюта, версия метода, lineage и coverage. Денежный возврат не является доказательством возврата товара на склад или восстановления себестоимости. Payroll читает этот источник; текущая техкарта и цена ингредиента не применяются задним числом. Для legacy/неполных данных сохраняется unsupported/incomplete, не ноль.

MASTER получил задачу на ограниченную локальную реализацию producer либо точный upstream contract, если имеющихся исходных фактов недостаточно. Номера172–175 заняты payroll; новые номера требуют сверки между активными направлениями. Это передача зависимости, не подтверждение готового source или разрешение official calculation.

### Детализированный producer gap

Повторный аудит MASTER и локального `server.js` установил: `depleteRecipeForOrder` объединяет требования по ингредиенту на весь заказ; исторический `order_costs` хранит лишь итог заказа. Связь оценки со строкой `order_items` теряется до записи `stock_movements`. Повторный вызов при отсутствии сохранённого итога может вычислить стоимость по текущим ingredients; этот fallback не является историческим evidence.

Следующая реализация должна сохранить распределение строк до группировки и связать его с реально созданными movement IDs и применённой оценкой внутри той же транзакции. Поле `totalCostMinor` означает стоимость полного количества проданной строки. Метод округления и распределения копеек версионируется и сверяется с итогом заказа; quantities и денежные ledgers остаются прежними. Для non-stock нужно явное основание нулевой складской стоимости; отсутствие recipe/valuation не превращается в ноль. Legacy и физическая обработка возвратов требуют отдельной coverage.

MASTER не начал реализацию: в его чате требуется прямое пользовательское поручение на изменение producer. Он предоставил read-only финансовый handoff, а не готовый источник или разрешение writer. Payroll-координатор продолжает локальную проработку необходимого источника в рамках поручения этого чата; отдельному нативному system_architect поручен аудит транзакций и границ. Текущий этап не считается завершённым.

### Current producer handoff — 2026-10-19

Supersedes earlier notes above that MASTER had not begun implementation: MASTER delivered immutable sale cost producer commit a695981945639a942d4015e60bd4c673ca10560f. Its exact module/migration187 and two transaction hooks are now integrated locally; migration187 must precede server startup. Payroll migrations are188–191 (old172–175). Producer contract: POS_SALE_COST_EVIDENCE.md. Existing integrated PG depletion PASS413; expanded producer QA remains in progress.

Pure payroll-margin-cost-source now validates verified reader results against complete no-refund recognition, exact line/product/quantity coverage and order totals. It remains unconnected to runtime readiness/calculation pending full source binding. No official margin or refund-cost capability is opened. Historical source-gap notes remain as audit history, not current implementation status.

Integrated producer verification completed locally: PostgreSQL depletion528 and sale/manual-stock concurrency suites PASS, fresh owned databases cleaned. Pure margin adapter/input contracts and Docker dependency contract PASS. Runtime payroll cost binding still pending; official calculation remains blocked.

### Explicit ceiling source update — 2026-10-19

Supersedes the open-ended reference above to unidentified other employee income: original ТЗ means employee-attributed daily sales revenue. MASTER/Finance accepted local explicit source `employee_attributed_merchandise_net_v1`, including all immutable attributed lines regardless of commissionability; unallocated minimum/residuals unsupported. Engine now consumes a reconciled explicit daily series, preserved in candidate snapshot, with separate capability explicitNoRefundEmployeeNetRevenue:true. Full official/refund support remains unproven and disabled. Actual HTTP/PG margin acceptance including explicit20100 ceiling source PASS; see WORK_LOG for scope and remaining gates.

## Transition contract checklist — Finance review 2026-10-19

This supersedes any inference that accepted candidate calculations authorize an official writer. Local implementation can proceed under the user's existing assignment; activation, publication and financial execution are separate.

1. Introduce a specifically versioned no-refund official capability. Do not relabel the unsupported general signed-refund/full-net capabilities. Require a fully closed venue-local period and every mode-dependent authoritative source; minimum/residual/legacy gaps block.
2. Recompute source and calculation on the server for the authenticated owner. Browser candidate JSON cannot be promoted. Persist ready run and typed immutable employee/day/line snapshots atomically, including engine/config/source fingerprints and lineage; any failure rolls back all writes.
3. Materialize draft entries through a separate owner action. Enforce exact employee/period/currency/run provenance and DB-level idempotency plus concurrency-safe inclusive overlap covering legacy draft/approved/paid, including requests with different idempotency keys. A read-only diagnostic cannot enforce this.
4. Before entry creation, approval and payment, detect source changes/new refunds. RR snapshot and consumer-only advisory lock are insufficient. Establish a source-writer-compatible serialization/revalidation/invalidation contract before enabling writes. Stale unpaid calculations cannot pay; paid records remain immutable and later changes enter explicit review without automatic withholding.
5. Draft and approval create no expense. Existing pay remains the sole payroll expense writer. Retry, concurrent payment and failure after inserts must not duplicate either entry or expense.
6. Acceptance includes different-key run/materialization races, inclusive overlaps, source/refund races, forced rollback after snapshots and entries, owner/tenant isolation and unchanged money/stock ledgers except the explicitly tested existing pay action.

Next implementation prerequisite: map actual lifecycle/source writer locks and choose a verified locking order. This checklist records the accepted transition requirements, not proof that the transition is implemented.

### 2026-10-20 — Next official persistence handoff

Current verified boundary: versioned closed-period no-refund input is available internally; no ready-run HTTP path exists. Reuse persistPayrollSnapshotBundleInTransaction and existing typed/milestone serializers. Candidate preview JSON is not a persistence DTO and must not be relabeled official.

Next implementation sequence: server-owned source collection and verified calculation; adapter from calculator result plus bound employee/day/line source facts to validatePayrollSnapshotEvidence/mapPayrollTypedSnapshotRows input; server-built run provenance including closure evidence; then atomic owner/tenant/idempotency/source-fenced run persistence and fault/race QA. Before enabling a route, resolve storage of closure/capability provenance and verify all relevant producer families use the compatible fence. Subsequent run-to-entry, approval and payment need their own stale-source checks and inclusive overlap/idempotency constraints.

MASTER live review on this continuation found a failed final turn after a passed POS recognition QA and a failed recipe-sale-manual-movement-race QA (HTTP 400 rather than expected success/409). The source-fence integration is therefore not accepted as complete. MASTER received the input-contract handoff and request to continue its owned producer work; payroll does not overwrite its dirty server/db changes.

### 2026-10-20 — Verified calculation adapter and updated producer handoff

Added internal pure payroll-verified-calculation.js: rebuild the strict no-refund input contract, invoke the engine, reject context/engine/amount failures, retain source reason codes, and return detached frozen input, engineResult and provenance. Outer officialReady/payoutEligible remain false; persistence is none. Coordinator reran verified-calculation, calculation-input and candidate-calculation contract scripts: PASS. Fixture amounts are minor units: 10,000 net at 10% yields 1,000 commission.

Final-month threshold remains gated by closedMonthCoverage (including overrides), full calendar-month engine coverage and monthClosed. Current source service supplies no complete-month attestation, so closure alone cannot enable that mode.

MASTER subsequently reported passing recognition, recipe/manual-stock race and depletion PG QA with its producer fences in local main. Live helper comparison confirms matching venue key, hash seed and lock SQL. This supersedes the previous failed-race status, but is not integrated-checkout acceptance. Direct SQL/old app instances remain uncovered; MASTER also reports a separate refund-suite seed failure before HTTP. Shared server.js remains owned by MASTER.

Next mapper must use immutable employeeName from eligibility revision periods and productName from manifest productFacts. Preserve original soldAt. Existing typed source context assumes soldAt local date equals credited date; overnight order closure can violate that assumption. Resolve soldLocalDate versus recognizedLocalDate explicitly before accepting overnight rows, never substitute timestamps.

### 2026-10-20 — Overnight recognition context

Resolved the timestamp assumption without a schema migration. Typed source context accepts an explicit all-or-nothing recognizedAt/recognizedLocalDate/timezoneSnapshot tuple. Its instant in the snapshot timezone must match the credited localDate and calculator day. Sources without the tuple retain the previous strict soldAt-to-localDate check. Explicit recognition rows preserve original soldAt precision; typed incentive_json.sourceRecognition preserves the immutable recognition tuple. This validates consistency, not caller authority; the server mapper must copy it from its verified manifest.

Source-context, typed-serializer, snapshot-evidence and persistence contracts PASS. Guarded PostgreSQL snapshot-persistence QA PASS including an overnight row with distinct sold_at/local_date and recognition evidence. First QA attempt exposed fixture ISO formatting (`Z` versus `.000Z`) in readback, corrected in the fixture before successful rerun. No financial writer was enabled by this change.

### 2026-10-20 — Verified snapshot input adapter

Added payroll-verified-snapshot-input.js. It invokes verified calculation itself, requires exact manifest/calculator sale ID sets, binds requested-period source rows to calculated lines, resolves employee labels from the verified eligibility revision, copies immutable product labels and recognition evidence, and validates both typed and milestone storage DTOs. Rehire intervals deduplicate to one employee label; conflicting labels reject. Timezone must match readiness and closure. Outputs are detached/frozen with source/calculation/snapshot fingerprints, status verified_snapshot_input, officialReady:false, payoutEligible:false, persistence:none.

Contract PASS covers October 11–31, rehire intervals, overnight sale, forged recognition rejection, and independent MTD turnover: October 5 contributes 50,000 minor units, October 11 contributes 10,000, cumulative is 60,000 while stored sale lines remain within the requested period. Earlier-month sales are intentionally excluded by the source contract; MTD thresholds use the separate venueDailyTurnover source.

Runtime integration remains pending: obtain the complete bundle and closure inside the authenticated source-fenced transaction, carry sourceAttendanceApproval from approvedAttendanceSource for milestone storage, and create ready run/snapshots atomically with provenance and idempotency. The pure adapter does not authenticate caller-created bundles and must never be exposed directly to HTTP. Missing milestone approval context blocks storage preparation.

### 2026-10-20 — Source collector connected, storage still pending

Shared private collectSourcedPayrollContext now powers sourced previews and unrouted prepareVerifiedSnapshotInput. Both source collection and closure happen inside one owner-checked, source-fenced RR read-only transaction; attendance approval envelope is included before hashing. Guarded browser/PG QA proves ordering, rejected unauthorized/forged-source requests and no writes, with incomplete inputs correctly blocked. A successful collected-source-to-ready-run case remains required.

payroll-run-provenance.js prepares exact deterministic JSON bytes and SHA256 binding schemeSnapshot, sourceEvidence, periodClosure, source/calculation/snapshot fingerprints, run identity and total. It recalculates rather than accepting a result. Proposed immutable SQL sidecar is still draft pending actual-chain QA and migration-number coordination (192/193 belong to loyalty). Atomic storage, retries, concurrency and public action remain pending.

### 2026-10-20 — Durable run evidence schema

Promoted the reviewed SQL to migration194 after observing loyalty192/193/195 and announcing payroll194 to both workstreams. payroll_run_provenance is append-only with byte-level SHA256 validation and parent/context/closure binding. Deferred guards require sidecar and daily sum equality for the new engine marker only. Legacy headers remain compatible. Canonical text format is defined by the server builder; PostgreSQL verifies its exact stored bytes rather than claiming equivalence to jsonb reserialization.

Guarded payroll-run-provenance-postgres-qa PASS on the actual migrated fresh database, including replay, missing sidecar, null/missing context rejection, hash mismatch, closed-date checks, mutation/truncate rejection, legacy compatibility, nonzero total1234 and rejection of a later daily append changing that total. Native PostgreSQL timestamp with space and +00 is accepted; the initial strengthened test found the draft regex omitted short offsets, now corrected. Writer and source-fenced atomic transaction integration remain pending; no public action or payout was enabled.

### 2026-10-20 — Atomic provenance storage and private orchestration

The private snapshot writer now requires provenance for payroll-verified-no-refund-v1, validates the checksum and snapshot-input hash against rebuilt DTOs, and inserts header, sidecar, day and line records under one savepoint. It checks and flushes migration194 constraints only for the new engine; legacy callers retain their existing behavior. Pure storage QA and guarded PostgreSQL storage QA PASS, including rollback after sidecar/day/line/constraint failures. The real provenance builder also passes the real storage mapper using a fake DB; that test does not prove source authority.

Unrouted createVerifiedRun in payroll-scheme-service now owns source collection, calculation and persistence on one RR read-write transaction. An exclusive session source lock precedes BEGIN; owner/venue/version locks, active-or-retired status and version effective window are mandatory. Replay checks saved provenance before any new collection; a different request under the same key is rejected. Invalid sources return blocked without a ready header. Rollback or unlock failures cause the connection to be discarded. No public route, payroll entry or expense was added.

Current integration boundary: the existing source/readiness collector accepts periods beginning on day01 only. Pure mapping supports partial periods, but the private service does not yet support first-month schemes beginning midmonth. Do not loosen the parser without auditing month-to-date attendance/turnover/source coverage. Successful real collector-to-storage, persisted replay/concurrency and producer-fence integration remain acceptance requirements. The module is still at stage4/10, not complete.

Acceptance update: guarded scheme-browser PG PASS confirms the private operation's owner/tenant/draft/window denials and source-fenced blocked-source path without financial writes. Initial runtime failure revealed RO-only guards in recognition and department-mapping readers; resolved by a private exact-client/venue RW capability issued only after lock→BEGIN. Guarded source-fence PG PASS confirms unfenced RW denial, fenced readers, producer exclusion and capability revocation. Successful complete-source ready persistence/replay remains pending.

### 2026-10-20 — Successful source-to-storage and shared producer integration

Guarded payroll-verified-run-postgres-qa PASS: historical fixture runs real unchanged recognition triggers under a seed-session clock; actual collector/service uses a separate pool and real DB time. Nonzero1000 cents persisted across run/provenance/day/line rows. Same-key replay, different-request conflict, concurrent same-key deduplication, actual SQL failures after sidecar/line writes with full rollback, active eligibility producer wait and fresh committed watermark all pass. Original run remains frozen after source change; no entries or expenses are created. This is synthetic historical integration, not a real-time next-day POS/payout journey.

Applied MASTER producer-server-db.patch SHA256 D349B19EE8391350C13A37CEDD852FC3A810C17E82B53D6D16B35EEEC9DAC589 after git apply --check. Preserved additive payroll-source-fence helper and one server import. Added Docker COPY for verified calculation/input/provenance. Code-health reviewed scoped producer hunks and local require closure (102JS files, missing COPY0); no Docker image build claimed.

Common payroll checkout guarded pos-payroll-recognition-postgres-qa PASS exit0; recipe-sale-manual-movement-race-postgres-qa PASS exit0, including cost-update waiting on payroll source fence. Runner confirmed removal of owned disposable database. payroll-source-fence-contract PASS. Recipe suite retained checkout cashbox fixture and richer diagnostic changes rather than overwriting the file wholesale.

Architect identified an explicit remaining reproducibility gap: provenance contains frozen scheme, closure and source watermark metadata, not the entire calculator input/result. Typed snapshots can explain the saved calculation, but cannot independently reconstruct an exact engine replay. Public saved-run API/UI is the next local slice. Full module remains incomplete, stage4/10; no release or deployment.

### 2026-10-23 — Current-source inspection for a saved run

The later replay implementation stores complete calculator inputs/results in provenance. Replaying them establishes reproducibility only; it does not establish current-source freshness. The new owner-only `POST /api/payroll/calculation-runs/:id/freshness` accepts exactly `{}` with no query and uses the authenticated tenant. It acquires the existing source fence before starting its repeatable-read read-only transaction, validates the saved evidence, recollects sources using the frozen scheme, and rebuilds a verified calculation with a fresh closure proof.

The comparison uses the full stored/current `inputWatermark` and venue timezone. It never compares the timestamp-dependent closure, calculation, snapshot, or provenance hashes. A newly confirmed source revision is a change even when its money total stays equal. A related refund outside the saved sale month still belongs to the all-time source cohort and blocks the current no-refund capability. Failed evidence integrity, denied access, missing run, and database failures remain errors rather than positive or stale results.

- `current`: current input is verified and the full source hash/timezone match.
- `stale`: current input is verified but the source hash or timezone differs.
- `blocked`: current sources cannot yield a verified calculation; safe reason codes explain the gap.

The response contains only inspection metadata, `checkedAt`, and `validity:transaction_snapshot_only`; `officialReady:false`, `payoutEligible:false`, and `persistence:none` remain mandatory. The UI says when inspection occurred, preserves saved sums, and resets the inspection state after opening the calculation again. A stale response from a different/closed view cannot update the current view.

`checkPayrollRunSourceFreshnessInTransaction` is an internal prerequisite for future write transitions, not a reservation or payout authorization. Future materialize/approve/pay must invoke it again within their own source-fenced write transaction and additionally satisfy replay/result identity, immutable run-entry lineage, cross-rule overlap, finance permissions, and reviewed late-refund adjustment requirements. A prior browser response must never authorize a later write. Shared server/db and financial ledgers are outside this implementation package.

### 2026-10-23 — Persistent refund review before financial integration

The owner can create a review from a saved calculation and reopen its assessment/decision history. Endpoints:

- `POST /api/payroll/calculation-runs/:runId/refund-reviews` accepts only `{idempotencyKey}`.
- `GET /api/payroll/refund-reviews` accepts `runId`, `limit`, `cursor` (tenant-scoped list).
- `GET /api/payroll/refund-reviews/:caseId` returns the latest bounded assessment DTO and decision history.
- `POST /api/payroll/refund-reviews/:caseId/decisions` accepts only `{decision,reason,expectedAssessmentHash,idempotencyKey}`.

All writes use the private source-fenced RR/RW transaction, acquiring the exclusive session fence before BEGIN. Owner identity is revalidated in DB before any replay. Exact request replay returns the frozen original response before recollecting live sources; a new decision requires the current server-collected assessment to match the supplied hash. Source changes never overwrite an earlier assessment or decision. The UI fetches current detail after a successful write or historical retry.

A case is unique per venue/saved run and is explicitly `saved_calculation_unposted`. Two alternative saved runs may show different estimates for the same sale, but neither represents an accrual or deduction. The eventual run-entry binding must select an authoritative earning and enforce economic uniqueness across alternatives before any money application.

The collector reconciles saved replay, exact snapshot-to-canonical-sale linkage, all-time raw refund headers/items and recognition IDs, cumulative return sequence and frozen source amounts. Amounts are server-calculated. Merchandise value, receipt payout, and salary effect remain distinct. Supported scalar effects use the difference between rounded commission on the remaining base before and after each cumulative return. Numeric output is refused for nonlinear modes, caps, milestone dependencies, incomplete lineage or a conflict with the remaining personal-revenue ceiling. Such assessments persist with `impactCents:null` and explicit reasons; unknown is not zero. No fixed pay is reduced automatically.

Allowed decisions are `hold_for_review`, `close_without_payroll_change`, and `acknowledge_no_effect` (complete proven zero only). The last two close that assessment, while a new source assessment requires review again. No decision applies an adjustment, creates debt, selects a future period or invokes payroll_adjustments/applications. All public results retain `officialReady:false` and `payoutEligible:false`.

Migration201 maintains immutable case/assessment/decision/request history, source identity checks and checksum constraints. Read responses currently expose the latest 100 assessments and decisions with truncation flags; all history remains in DB. UI renders refund lines in batches of100. Full module completion still requires the approved monetary correction lifecycle, immutable run-entry linkage, cross-rule overlap, approval and once-only payment through existing expenses, and final end-to-end acceptance. The review journal does not satisfy those later gates by itself.

Уточнение MASTER после проверки текущего `finance-unified-report.js`: P&L зарплаты использует net amount approved/paid и пропорцию календарных дней пересечения периода (`payroll_period_prorated_by_calendar_days`), не дату утверждения/выплаты. Будущий bridge обязан сохранить и объяснить это правило. Возможный target применения — только явно выбранный draft: approved уже признан в P&L и не изменяется автоматически. Применение денежной корректировки — отдельное решение владельца с gross/application/net, не результат технического согласования и не автоматическое удержание. Queue201 этого действия не предоставляет. Согласованная область общего server hunk: payroll create/approve/pay/cancel/delete, bound-entry immutability и source/correction capability, source fence → entry/employee → account/shift; без переноса чужого общего diff.

### 2026-10-23 — Bridge implementation replaces prior blanket overlap proposal

MASTER approved preserving legacy/legacy component entries, while202 excludes all active mixed legacy/run and run/run overlaps. Shared GET/PATCH and payroll register now consume immutable run-linked drafts; DB hard-disallows approved/paid pending the full correction lifecycle. Actual owner materialization is available locally with source-fenced freshness/replay, immutable request history and cancellation. Existing statements above describing materialization as absent are historical; payout and official gates remain disabled. New policy planning arithmetic is pure and does not authorize or persist money.

### 2026-10-23 — migration203 and internal writer implemented; public money gate unchanged

The correction ledger prerequisite now exists and passes actual-store/SQL testing with explicitly synthetic paid sources. Permanent waivers consume the current undisposed increment without requiring a future target. Full cancellation appends exact releases while preserving cancelled historical amount. Actual target net must equal frozen gross minus all active applications at commit; no virtual posting is accepted.202 still blocks linked paid originals and monetary mutations, so this package alone cannot authorize or complete a real payout. Future205 must install immutable approval/settlement proof, expense uniqueness/protection and a coherent source-fenced lifecycle before exposing these writers.204 must retain full refund facts and implement the selected versioned open-run semantics across all modes. These are remaining acceptance conditions, not capabilities proven by203.

### 2026-10-23 — Обновление gate после205

Для подтверждённых сохранённых расчётов доступен owner-only205 lifecycle с текущей проверкой источника и активных корректировок. Его local actual-source acceptance PASS: run→draft→approve→positive/zero settlement→reload, rollback и exact replay, once-only finance.202 receipt остаётся историческим; доступность действий определяется только текущим205 state и повторной серверной проверкой внутри transition. UI metadata или старый receipt не являются разрешением на выплату.

Gate всего payroll не закрыт: public reviewed corrections, zero-settlement correction authority, refund-aware recomputation всех7 режимов и полноценные nonlinear paid corrections ещё требуют реализации и сквозной приёмки. Не снимать существующие ограничения неподдерживаемых источников/режимов на основании205 PASS.

### 2026-10-23 — Public203/206 local acceptance

Public owner correction context/preview/commit and zero settlement authority now pass actual-source PostgreSQL/browser suite23185. No generic financial action is opened: apply/waive use current source assessment, immutable paid authority, explicit future same-employee draft, protected fixed amount, cumulative ledger and exact request journal. Cancellation releases prior applications; zero completion creates no expense. Older statements above describing public corrections as absent are historical. Full payroll gate remains open work:204 refund-aware all-mode recomputation, nonlinear paid differentials and final acceptance/integration. Current limited source/mode denials remain in force.
