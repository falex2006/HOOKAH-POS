# Постоянное хранение решений о пороговых премиях

Статус: координатор передал payroll номер089 после подтверждённой локальной приёмки POS088. Миграция `089_payroll_milestone_snapshots.sql` принята локально на disposable PostgreSQL. Pure mapping и таблицы не разрешают официальный расчёт или выплату.

## Совместимость

Будущий run получает `milestone_evidence_version`: 0 для прежнего формата, 1 для явной политики eligibility с полным дневным envelope. Старые данные не переписываются. Writer версии1 обязан атомарно записать все дневные envelopes и решения либо завершиться ошибкой; sidecar нельзя отбросить.

## Дневной envelope

Предлагается `payroll_milestone_day_snapshots`: id/venue_id/run_id, local_date, attendance_approval_id, previous_venue_turnover, cumulative_venue_turnover, decision_count, awarded_total. Суммы numeric(16,2), число решений integer. Уникальность venue/run/date; tenant FK на run и frozen attendance approval. Для каждого дня периода нужна строка, включая пустые дни и дни без выплат.

## Решения

Предлагается `payroll_milestone_decision_snapshots`: id/venue/run/day_snapshot/date, employee_id/name snapshot, role snapshot, threshold_amount, declared_bonus, eligibility, apply_milestones, employee_active, eligible, reason, approved_worked_minutes, awarded_amount, qualifying_shift_ids UUID[].

Уникальность venue/run/date/employee/threshold. Композитный FK на дневной envelope и tenant FK сотрудника. Обязательного FK на employee payout snapshot нет: отказ не создаёт фиктивную выплату. Суммы неотрицательны; award равен declared bonus при eligibility, иначе0; previous < threshold <= cumulative. Logical gate и reason должны совпадать.

## Проверки перед commit

Под блокировкой parent run проверяются полный набор дней, непрерывность оборота, число решений, дневные/сотруднические суммы премий. Положительный award требует employee daily snapshot с той же суммой milestone_bonus; нулевой отказ без такой строки допустим. Дневной оборот сверяется с имеющимися employee snapshots.

Qualifying shift IDs уникальны и относятся к frozen approval того же сотрудника и дня; набор положительных approved shifts и сумма минут совпадают полностью. Approval покрывает нужный период и timezone. Актуальность approval относительно изменяемого расписания/логов проверяет транзакционный source adapter; FK её не доказывает.

Новые таблицы требуют immutable UPDATE/DELETE/TRUNCATE guards, проверки run/date и tenant. Существующие guards077–087 сохраняются. Личный parameter_path CHECK расширяется только `milestoneEligibility`, сохраняя все пути086.

Миграция проверяет полноту также при INSERT самого run, чтобы версия1 без дочерних записей не могла завершить транзакцию. Версия0 сохраняет прежние данные и запрещает новые milestone sidecars. Все дни версии1 используют один approval, его месяц/покрытие/timezone проверяются против frozen run. Qualifying IDs — именно `payroll_attendance_approval_shifts.id`, а не `schedule_source_id`.

`schema.sql` в этом репозитории не содержит payroll077+ родителей. Координатор подтвердил исключение из прямого schema append: fresh parity проверяется через реальный bootstrap `schema.sql + migrations001..089` против upgrade через088 с двойным replay089 и сравнением каталогов таблиц/ограничений/триггеров/индексов.

Ограничение источника082 сохраняется: guards запрещают UPDATE/DELETE/TRUNCATE, но не закрывают последующий INSERT новой смены в существующий approval. Миграция089 проверяет полный набор видимых утверждённых смен в момент commit; финализацию и актуальность approval обязан доказать будущий source adapter. Эти таблицы не объявляются аттестацией источника.

## Локальная приёмка после разрешения DDL

Фактический полный прогон7039 завершён exit0, собственный random disposable container удалён. `payroll-milestone-postgres-contract.mjs` проверяет committed calculator→milestone/typed mapper→PG→полное readback; пустой день, отказ без payout,26 отрицательных пакетов с точными SQLSTATE и полным rollback, версию0, UPDATE/DELETE/TRUNCATE guards, RBAC403 и отсутствие entries/expenses. История создана до089: полные JSON run/daily сравниваются после двойного replay, исключается только новый version column. Fresh/upgrade сравниваются по columns/constraints/indexes/triggers и функциям. Hostile shadow search_path не подменяет контекст таблиц. Два клиента подтверждают parent lock timeout, duplicate rejection и rollback позднего недублирующего решения на deferred conservation; это не доказательство всех будущих official writer races.

В том же контейнере actual personal-cap PG regression (сохранён409 на схеме/роли/личном параметре) и typed087 PG regression прошли. Static contract RED→PASS, pure milestone evidence/serializer/digest и итоговые syntax/diff/code_health проверки прошли. Runtime выявил и исправил продуктовую ошибку PL/pgSQL: CASE ссылался на отсутствующий NEW.run_id родительской записи; теперь используется IF по TG_TABLE_NAME. Ошибки QA fixtures исправлены без ослабления guards: создан source order_item, TRUNCATE CASCADE достигает immutable trigger, service получает корректный Pool interface.

Replay дважды; прежняя история; фактический calculator→mapper→PG→readback; отказ без payout row; пустой день; tenant/run/date isolation; дубли и uppercase calculated UUID; неверные shift IDs/минуты; award conservation; пропущенный день; immutable history; полный rollback при ошибке. Только изолированная QA база.

Owner service/UI guard снимается после полного сохранения scheme/role/person поля, digest, migration QA и браузерного сценария. Наличие этих таблиц не восполняет отсутствующие pricing/refund/net/cost источники official writer.

## Pure DTO подготовки

`mapPayrollMilestoneStorageRows(input)` возвращает `milestoneEvidenceVersion`, `daySnapshots`, `decisionSnapshots`. Для старого результата без явно добавленных решений — версия0 и пустые коллекции. Для явной политики — версия1 и все дни периода. `key`/`dayKey` являются временными связями, которые writer должен разрешить в UUID дневной записи.

Mapper повторно проверяет arithmetic/source-reference evidence и полную supplied roster, переводит копейки в decimal без округления, переносит имена сотрудников и canonical qualifying UUID. Он требует независимый attendance и совпадающие supplied `attendanceApprovalId`/`sourceAttendanceApproval.approvalId`, проверяет заявленное покрытие периода. Эти данные остаются предоставленными вызывающей стороной: mapper не читает БД, не проверяет tenant ownership источников и не подтверждает актуальность approval. Внешний writer обязан получить контекст через утверждённый транзакционный adapter.


### Configuration integration accepted — 2026-10-03

Следующий bounded owner service/UI этап принят фактическим suite96309: optional scheme/role/personal сохранение, API→PG→reload/browser, inheritance/dates/digest/activation и no posting. Прежний безусловный pending409 заменён capability409 на базе без089; official writer/source attestation не включены. См. PAYROLL_MILESTONE_ELIGIBILITY_DRAFT.md.
