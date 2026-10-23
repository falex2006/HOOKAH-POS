# Миграция PostgreSQL

## Payroll provenance194 — локально, 2026-10-20

`194_payroll_run_provenance.sql` добавляет неизменяемую запись доказательств расчёта. Она обязательна только для новых ready-run с точным `engine_version=payroll-verified-no-refund-v1`; старые ready/blocked записи не переписываются. Проверяются SHA256 сохранённых JSON-байтов, соответствие площадке/версии/периоду/валюте, закрытие периода и итоговая сумма дневных снимков. Запрет UPDATE/DELETE/TRUNCATE сохраняет доказательства.

Номер192 отклонён после обнаружения коллизии. На диске лояльности заняты192/193/195;194 объявлен payroll в MASTER и чате лояльности. Перед общей интеграцией требуется сверка объединённой цепочки. Guarded payroll-run-provenance-postgres-qa PASS на текущей реальной цепочке этой ветки, включая повтор миграции, ненулевой итог и отказы при нарушениях. Это не доказывает общий chain с ещё не интегрированной лояльностью и не включает официальный writer/API.

## Текущая нумерация payroll — 2026-10-19

Для устранения пересечения с веткой лояльности локальные, ещё не опубликованные payroll-миграции переименованы без изменения SQL:

| Исторический номер в журналах | Текущее имя |
| --- | --- |
| 172 | `188_payroll_employment_eligibility_history.sql` |
| 173 | `189_payroll_product_department_mapping_revisions.sql` |
| 174 | `190_payroll_refund_related_order_index.sql` |
| 175 | `191_payroll_attendance_function_context.sql` |

Диапазон172–186 принадлежит лояльности,187 зарезервирован для общего источника себестоимости. SHA256 каждого SQL до и после переименования совпал. Рабочие базы пользователя не изменялись; исторические записи QA сохраняют прежние номера. Текущие скрипты используют188–191. Проверки этой ветки не подтверждают совместную цепочку до интеграции лояльности172–186 и источника187.

## График сотрудников — локальная проверка101/102

Сверка schema-only не заменяет строки SQL. Только в двух вновь созданных проверенных disposable БД CHECK повторно разбираются PostgreSQL до стабильного определения, с сохранением комментариев и проверкой неизменности строк; inherited constraints отклоняются проверяющим скриптом. Нормализация этих тестовых схем фиксируется до сравнения дампов; рабочая БД исключена. Из сравнения исключены лишь случайные psql restrict tokens. Заполненные frozen attendance header/shift/interval и состояния sequences также сверяются. Независимый review и прогон21cca012b5d1 — PASS.

101 создаёт grants и историю доступа;102 добавляет виды/статус/перерыв/версию/историю/идемпотентность и снимает уникальность сотрудник+день. Старые строки, NULL-время, авторство и заметки не переписываются. Удаление unique означает, что старый server с blind upsert несовместим: миграции и новый API/UI должны входить в один выпуск. Запись в новом API требует requestKey, изменение — id/version; см. API.md.

Локальная репетиция: `node scripts/staff-schedule-migration-recovery-qa.cjs`. Скрипт проверяет pinned Docker identity/volume из schedule runtime, создаёт две новые случайно именованные базы исключительно в этом контейнере; рабочую staff_schedule_qa не изменяет. Применяет schema + миграции до101, проверяет101/102 на пустой таблице, создаёт синтетические legacy строки и pg_dump backup, проверяет transactional rollback, upgrade/replay, сохранность всех старых полей и сторонних таблиц. Восстанавливает dump в другую новую БД, сравнивает данные и schema-only dump, затем повторяет upgrade. Базы и backup/report в игнорируемом qa-artifacts/staff-schedule сохраняются для проверки. Production backup или production rollback этим не подтверждаются.

При выпуске заранее сделать полный backup и отдельно проверить восстановление. Откат приложения к старому SQL после записи нескольких смен за день недопустим. Восстановление прежнего backup потеряет последующие записи, поэтому не является автоматической операцией; нужен согласованный порядок остановки записи и переноса изменений. Ни downgrade, ни удаление строк этот модуль не выполняет.

1. Создать базу и пользователя из `.env`.
2. Применить `schema.sql` одним запуском.
3. Применить `seed.sql` только для тестовой площадки.
4. Проверить индексы и healthcheck CRM.
5. Для production использовать отдельные миграции и резервную копию перед изменением схемы.
6. Для существующей базы применить `migrations/001_auth_sessions.sql` перед включением persistent sessions.

Пример для контейнера:

```bash
docker compose up -d db
# init scripts из /docker-entrypoint-initdb.d выполняются автоматически на новом томе
```

Для существующего тома:

```bash
docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < migrations/001_auth_sessions.sql
```

Либо использовать подготовленный `./migrate-vps.sh`: он дождётся готовности PostgreSQL и применит все SQL-файлы из `migrations/`.

Проверку остановки и повтора оболочки runner можно выполнить командой `bash scripts/migrate-vps-runner-qa.sh`. Она использует временные SQL-файлы и подмену Docker/psql, не подключается к базе и не доказывает откат транзакции PostgreSQL.

Миграция `006_guest_venue_phone_unique.sql` переводит уникальность телефона гостя на составной ключ точки и телефона для сетевого режима.

Миграция `011_user_preferences.sql` добавляет JSON-поле персональных настроек аккаунта: таймер блокировки рабочего места и настройки отображения главной/аналитики. Она безопасна для повторного запуска через `ADD COLUMN IF NOT EXISTS`.

## 099 — отдельное исполнение строк заказа (FIX-03.1)

`migrations/099_order_item_execution.sql` аддитивно добавляет nullable `products.preparation_station` и таблицу `order_item_execution`: одна запись на order_item_id, station bar/hookah/null, status new/queued/in_progress/ready и nullable временные отметки. Tenant/заказ определяются через order_items→orders. Legacy station/status, цены и immutable финансовые guards не меняются.

Повторный запуск безопасен: DDL IF NOT EXISTS и backfill ON CONFLICT DO NOTHING. Переносится только активная история: точные legacy station bar/hookah распознаются, прочие становятся null; order ready→execution ready, in_progress→queued, open→new. Историческое время передачи не выдумывается. Закрытая старая история не заполняется; новые оплаченные работы сохраняются до исполнения.

Порядок выпуска: backup и проверка миграции в изолированной БД, затем099, совместимый API и UI. Старый код может не читать новые поля, но откат приложения требует отдельно учитывать уже созданные работы и ограничить несовместимые изменения. Разрушительный rollback с DROP таблицы/колонки не предусмотрен: он удалил бы факты исполнения. При проблеме сохранять данные, останавливать затронутый функционал и выпускать совместимую исправляющую миграцию. Само наличие документа не означает production-развёртывание.

## Migration 100 — table minimum schedule

`migrations/100_table_minimum_schedule.sql` adds nullable `minimum_order_start_time` and `minimum_order_end_time` to `tables`. Both must be set together and cannot be equal. Null values preserve the existing always-on minimum behavior. The release workflow must apply migration 100 before the updated API starts.
## 103 — локальное расширение планирования

`103_staff_schedule_planning.sql` добавляет can_publish к grants и их истории (default false, CHECK требует manage), отдельные drafts/templates/planning_events. Существующие смены, часы, начисления и frozen snapshots не переписываются. Совместный выпуск требует актуальных backend/UI и миграции103; без колонки разрешений новый backend не совместим со старой схемой. Владелец сохраняет полный доступ, ранее выданный manage не получает публикацию автоматически.

Расширенный `staff-schedule-migration-recovery-qa.cjs` проверяет101–103: пустая/заполненная база, rollback ошибочной транзакции, повторное применение, точное восстановление backup и сохранность legacy/frozen payroll. Прогон `migration-recovery-d78cd4c864cb.json` PASS на отдельных локальных БД; исходная schedule_qa при этом не менялась. Production восстановление этим не подтверждается. Не удалять новые таблицы для downgrade: черновики, шаблоны и аудит являются пользовательскими данными.

## 116 — ручные финансовые обязательства

`migrations/116_finance_payables.sql` добавляет разовые обязательства, месячные правила с неизменяемыми версиями условий, строки обязательств и append-only связи фактических оплат с существующими `expenses`. Генерация повторяема и создаёт только черновики. Подтверждённые суммы/строки не редактируются; частичная оплата ограничена остатком и не создаёт второй денежный реестр. POS, закупки и payroll сохраняют собственные источники истины. Миграция аддитивная; production не запускать в составе локальной задачи.

## 117 — классификация признанной POS-выручки

`migrations/117_finance_pos_income_categories.sql` добавляет неизменяемые помесячные соответствия между замороженной категорией меню и финансовой статьёй дохода, а также snapshot/allocations на закрытом чеке. Итог сверяется с canonical `pos_order_pricing_snapshots`; надбавка минимального чека хранится отдельной строкой. Старые чеки не классифицируются автоматически. Суммы возвратов показываются отдельно и не вычитаются из выручки до утверждения политики признания возвратов.


## 118 — явные категории профильных финансовых источников

`migrations/118_finance_source_category_links.sql` добавляет nullable `finance_category_id` и `finance_category_name_snapshot` в `payroll_entries` и `inventory_purchase_documents`. Составные venue FK с RESTRICT сохраняют историю. DB guards проверяют активную расходную статью при назначении и утверждении/проведении, фиксируют историческое название, разрешают последующую оплату/отмену после архива и блокируют смену направления используемой статьи. Старые строки сохраняют NULL; backfill отсутствует. API/UI изменения должны выпускаться вместе с миграцией. Существующие guards закупочного сторно не заменяются. Локальный SQL-contract не подтверждает применение/исполнение в PostgreSQL; production-миграция не выполнялась.

## 119 — прочие бизнес-доходы вне POS

`migrations/119_finance_other_income.sql` adds tenant-scoped recognition documents and append-only partial receipt facts. Documents require an explicit income category, historical name snapshot, recognition date, basis and idempotency key; only drafts can be edited/cancelled, posting freezes the document. Receipt rows have a separate date/method/actor/key, lock their document, reject receipts for non-posted documents and prevent total receipts from exceeding the posted amount. No existing POS, expenses, payroll or purchase source is rewritten. Owner contributions, loans, transfers, deposits/advances and refunds remain outside this business-income slice. Local migration contracts do not prove PostgreSQL execution or production installation.

## 120 — корректировки признания и возвраты прочих доходов

`migrations/120_finance_other_income_reversals.sql` adds immutable reductions to recognized non-POS income and immutable refunds linked to a specific received receipt. Both preserve the original event and use event date, required reason, actor and venue-unique idempotency key. Parent-document row locks serialize the cumulative caps; refunded amounts cannot exceed a specific receipt, and recognition corrections cannot exceed gross recognition. Refund events do not mutate income recognition or create general expense rows. Database execution and browser lifecycle remain subject to guarded disposable QA.

## 121 — recognition для обязательств

Следующая схема `121_finance_payable_recognition.sql` добавляет неизменяемые recognition/reversal события для уже существующих обязательств. Migration additive; автоматического исторического признания и изменения документов нет. До миграции читатели должны оставаться совместимыми со схемой без этих таблиц; после неё обновлённый P&L исключает только linked payable cash expenses и добавляет доступные recognition events, а coverage явно показывает approved обязательства без признания. `expenses` и payment links не переписываются.

## 122 — исправляемые версии POS category mappings

`migrations/122_finance_income_mapping_corrections.sql` сохраняет существующие mapping-строки append-only, снимает уникальность одного соответствия на источник/месяц и добавляет tenant-scoped ссылку `supersedes_mapping_id`. Исправление пишет новую запись; селектор применяет последнюю созданную версию для данного effective month. Уже закрытые POS snapshots/allocations не пересчитываются.

## 123 — порядок и конкуренция POS mapping corrections

`migrations/123_finance_income_mapping_revision.sql` нумерует версии каждого источника/месяца в историческом порядке и запрещает повтор revision tenant-scoped уникальным индексом. Новая revision назначается после advisory lock; клиент также передаёт `expectedMappingId`, поэтому устаревший повтор после чужого исправления завершится конфликтом, а не вернёт старое решение. POS allocations остаются snapshot facts и не переписываются.

Миграция не содержит собственных `BEGIN`/`COMMIT`: границы транзакции задаёт migration runner, который применяет весь набор атомарно.

## 124 — подтверждение переменной суммы обязательства

`migrations/124_finance_variable_payable_confirmation.sql` сохраняет автора и время подтверждения суммы для черновиков, созданных из правила с переменной оплатой. Проведение такого обязательства невозможно без явного подтверждения; фиксированная сумма не требует дополнительного шага. Связь с пользователем и пара полей подтверждения проверяются на уровне PostgreSQL.

## 125 — счета оплаты обязательств и POS-смена

`migrations/125_finance_accounts_and_payable_payment_sources.sql` добавляет venue-scoped каталог касс/счетов, POS-кассу по умолчанию, account ID и snapshot в `expenses`, а также необязательную ссылку на смену. Legacy расходы остаются с неизвестным источником. POS cash требует активную POS-кассу и смену; внешние cash и bank/electronic источники не изменяют кассовую смену. Каталог не создаёт параллельный денежный ledger: оплата по-прежнему ровно одна строка `expenses`, а payable link — только связь. Миграция аддитивна; применение и PostgreSQL runtime требуют guarded disposable QA.

## 126 — источники счетов для прочих доходов

`migrations/126_finance_other_income_account_sources.sql` добавляет к фактам поступления и возврата прочего дохода явный счёт, снимок его названия и, для наличных, связь со сменой. Ограничения проверяют принадлежность заведению, совместимость способа оплаты и счёта, а также обязательную смену для POS-кассы. Старые факты остаются без счёта: источник не восстанавливается по способу оплаты.

## 127 — счета POS-тендеров и выплат возвратов

`migrations/127_pos_tender_finance_accounts.sql` добавляет account ID и неизменяемый snapshot названия к новым денежным POS-платежам и каждой выплате по возврату. Триггеры проверяют заведение, активность, совместимость метода и счета; POS cash привязывается к смене, card/QR не увеличивают кассу. Бонусы, депозит гостя и зачёт предоплаты остаются без счёта. Исторические события остаются неатрибутированными; ни миграция, ни отчёт не угадывают их источник. Перед применением требуется guarded PostgreSQL QA.

## 128 — целостность распределения POS-дохода

`migrations/128_finance_pos_income_snapshot_integrity.sql` закрывает снимок дохода только через промежуточное состояние `building`; незавершённый снимок нельзя зафиксировать. Отложенная проверка на commit сверяет дату и момент закрытия с источником, использует сохранённый часовой пояс заведения и требует точного соответствия каждой строке pricing snapshot по позиции, сумме и замороженным данным категории/цеха/названия. Она проверяет отдельную доплату минимального чека и mapping на активную доходную статью при создании; направление статьи после использования защищено. Архив доходной статьи не переписывает исторические снимки, а версии mapping не пересчитывают старые распределения. Проверка PostgreSQL должна подтвердить успешный и отклонённые транзакционные сценарии до выпуска.

## 129 — черновики ручных расходов

`migrations/129_finance_expense_drafts.sql` добавляет venue-scoped черновики ручных расходов с версиями, которые не входят в кассу и P&L до проведения в одну связанную строку `expenses`. Проверки БД защищают жизненный цикл черновика, соответствие проведённого расхода, неизменяемость ручного денежного факта и направление использованной категории. Существующие строки не меняются; контрагент остаётся NULL, если он явно не задан.

## 130 — повторы создания обязательств и правил

`migrations/130_finance_create_idempotency.sql` добавляет общий venue-scoped журнал ключа, fingerprint запроса и первоначального ответа для ручных обязательств и новых правил регулярных платежей. Резервирование ключа и создание строк выполняются одной транзакцией; точный повтор возвращает исходный результат, а повтор ключа с изменёнными данными отклоняется. Автоматическое создание месячных периодов продолжает использовать собственную уникальность по правилу и месяцу.

## 131 — append-only коррекции ручных расходов

`migrations/131_finance_expense_corrections.sql` хранит последовательные снимки до/после, причину, автора, время, signed amount delta и сохранённый ответ для точного идемпотентного повтора. DB guard блокирует изменение/удаление события, проверяет версию под блокировкой исходного расхода и запрещает коррекцию расходов другого source-ledger, закупки, зарплаты или оплаты обязательства. Исходная выплата `expenses` не переписывается.

## 132 — устранение неоднозначности в проверке переменного обязательства

`migrations/132_finance_payable_variable_confirmation_ambiguity.sql` переименовывает локальный признак переменной суммы в функции подтверждения обязательства, чтобы PostgreSQL однозначно разрешал столбец и не отклонял проведение из-за неоднозначной ссылки.

## 133 — tenant-ссылки категорий в истории исправлений

`migrations/133_finance_expense_correction_category_refs.sql` добавляет generated category IDs из неизменяемых снимков «до/после», tenant-scoped FK и guard типа «расход». Миграция сначала блокирует конкурентные записи и смену направления категории, проверяет старые снимки и завершает работу с ошибкой при неизвестной либо доходной категории. Операции не переписываются; уже использованную статью можно переименовать или архивировать, но нельзя менять её тип.

## 134–135 — предпросмотр ставки и восстановительная генерация регулярных обязательств

`migrations/134_finance_recurring_version_preview_idempotency.sql` связывает подтверждение новой ставки с просмотренным снимком и сохраняет безопасный точный повтор. `migrations/135_finance_recurring_generation_idempotency.sql` добавляет тот же tenant-scoped журнал для подтверждённой генерации пропущенных периодов; сущность ключа обязана быть обязательством того же заведения. Генерация создаёт только черновики, а не платежи или признания. Изменения применяются migration runner; production не затрагивался.

## 136 — журнал возвратов ручных расходов

`migrations/136_finance_manual_expense_refunds.sql` добавляет append-only события фактического возврата денег по точному ручному расходу, сохраняя исходную выплату и отдельно фиксируя cash event.

## 137 — снимки единого финансового отчёта

`migrations/137_finance_unified_report_snapshots.sql` хранит полную неизменяемую venue-scoped JSON-проекцию отчёта на 15 минут, с creator-scoped идемпотентностью и подписанными курсорами. Истёкшие строки разрешено очищать; до истечения изменение и удаление запрещены.

## 138 — документы вкладов владельца и principal займов

migrations/138_finance_funding_events.sql добавляет tenant-scoped документы funding и append-only денежные события. Триггеры сериализуют principal limit/repayment под блокировкой документа, сверяют активный счёт и POS-смену, блокируют переписывание и очистку event-таблицы. Backfill нет.

## 139 — переводы между счетами и начальные остатки

`migrations/139_finance_transfers_opening_balances.sql` добавляет атомарные переводы с двумя неизменяемыми движениями по счетам и не включает их в бизнес-доход или расход. Начальный остаток хранится отдельно как подтверждённая позиция на дату; последующие уточнения записываются append-only корректировками. Проверки связывают счёт, заведение, автора, смену и ключ идемпотентности; перенос не создаёт поступлений или выплат в кассовом реестре.

## 140 — явный расчёт неполного месяца аренды

`140_finance_recurring_partial_month.sql` добавляет policy правила с default `full_months_only` и nullable immutable `proration_snapshot` обязательства. Существующие правила/документы не переоцениваются. Migration replay сохраняет значения; схема свежей установки содержит тот же блок. Сначала применяется миграция, затем приложение. Старое приложение не понимает `calendar_days`: перед его откатом следует остановить генерацию таких правил и сохранить записи. DROP колонок не является безопасным rollback. Проверки выполняются только на disposable PostgreSQL.


## 141 — возврат оплаты обязательства

`migrations/141_finance_payable_payment_refunds.sql` расширяет существующий `finance_expense_refunds`: связь `payable_id` выводится из точной неизменяемой связи платежа, эффект признания обозначен `separate_payable_recognition`. Исходный платёж сохраняется; возврат увеличивает долг и разрешённую сумму повторной оплаты. Отмена требует нулевой оплаты за вычетом возвратов и полного сторно признания. Миграция не создаёт второй денежный реестр и не меняет старые ручные возвраты. Повторное применение проверено guarded PostgreSQL QA.


## 142 — неденежное распределение договорной оплаты

`migrations/142_finance_payable_offsets.sql` добавляет append-only распределения существующего expense между обязательствами, функции доступной доли оплаты и итогового погашения, проверки цепочек/сторно и единый порядок блокировок. Денежный возврат ограничен долей на первоначальном обязательстве; оплата и отмена учитывают распределения. В fresh schema включён точный блок миграции. Guarded PostgreSQL replay и конкурентные сценарии прошли. API/UI зачётов и подключение всех отчётов пока не завершены; это не готовый пользовательский релиз.

## 201 — журнал проверки зарплаты после возвратов

`201_payroll_refund_review_proposals.sql` зарезервирована чатом ЛОЯЛЬНОСТЬ за payroll-source-integration 2026-10-23 после проверки локальных worktree. Она добавляет только payroll-owned таблицы `payroll_refund_review_cases`, `payroll_refund_review_assessments`, `payroll_refund_review_decisions`, `payroll_refund_review_requests`.

Обращение относится к конкретному сохранённому расчёту (`saved_calculation_unposted`). Оценки и решения неизменяемы; повтор запроса возвращает исходный сохранённый ответ. Новые источники создают новую оценку с сохранением истории. Tenant/run/provenance, идентичность исходных продаж и возвратов, контрольная сумма и сумма числовых эффектов проверяются при записи. Подтверждение отсутствия влияния допустимо только при доказанном нуле. Нет backfill, начислений, удержаний, выплат и изменений POS/loyalty-реестров.

Совместимость: сначала миграция, затем приложение. Старое приложение игнорирует новые таблицы. При откате приложения журнал следует сохранить; удаление таблиц не является процедурой отката. Повторное применение использует IF NOT EXISTS и заменяет только собственные функции/триггеры. Общая цепочка интеграции с миграциями лояльности 192, 193, 195–200 отдельно проверяется в MASTER.

### 202 — saved calculation entry bridge (local, payout disabled)

Adds nullable immutable run/provenance/employee snapshot materialization to payroll_entries and append-only request responses. Preserves legacy component overlaps; mixed legacy/run and run/run draft/approved/paid periods excluded by two GiST constraints. Linked approve/pay blocked in DB; only draft cancellation allowed. Replay checks exclusion/index definitions; invalid active historical periods abort without repair. See docs/requirements/PAYROLL_CALCULATION_ENTRY_BRIDGE.md and WORK_LOG for evidence/remaining gate. Number reserved with loyalty. No source/payments/loyalty ledger mutation.

### 203 — reviewed correction ledger (local prerequisite)

Adds immutable claims, owner batches, apply/waive/release events and exact request responses. Economic claim uniqueness is venue + canonical refund line + employee; original paid entry, expense, saved snapshot and complete assessment are bound at insert. Each partial application consumes source capacity; permanent waiver and exact once-only release are separate events. Target capacity protects sum(min(saved base pay, saved final amount)) and deferred checks reconcile actual entry amount with all active applications. Full cancellation releases every active application, including multiple partial applications and different originals, while preserving the cancelled entry's historical amount.

203 does not enable public monetary operations or weaken202. Real linked original paid entries remain unavailable and draft net updates remain refused until the coherent lifecycle migration. No bypass flags or production fixtures are provided. Isolated PostgreSQL QA uses shadow synthetic source tables to exercise actual203 SQL; it is not authenticated source/payment acceptance. Existing POS/refund/loyalty tables are only referenced.205 is reserved for immutable approval/settlement and expense protection;204 remains reserved for the refund-aware input/provenance capability.


## 205 — утверждение, выплата и отмена расчётного начисления

`205_payroll_calculation_entry_lifecycle.sql` зарезервирована с MASTER/ЛОЯЛЬНОСТЬ для payroll. Добавляет неизменяемые переходы и журнал точных повторов, разрешает корректировки203 только в draft и проверяет их полный итог при COMMIT. Approve/pay требуют доказательство текущих источников из новой owner-транзакции. Положительная выплата создаёт один новый расход; `expenses.payroll_calculation_entry_id` назначается только при INSERT, сохраняет tenant-связь и исключает повторное присвоение. Нулевое завершение сохраняет transition без расхода и без счёта. Отмена освобождает все применения203 атомарно, сохраняя историческую сумму отменённого начисления.

Старые немаркированные расходы и legacy-компоненты сохраняют свои правила. Имя выбранной статьи в linked начислении остаётся историческим; активность и тип проверяются при утверждении. Миграция не изменяет POS/payment/loyalty ledgers. Требуется применение перед новым приложением; downgrade приложения не должен удалять историю или возвращать старый generic PATCH для linked начислений. Полная готовность всех режимов и возвратов отдельно подтверждается в PAYROLL_COMPLETION_EVIDENCE.

### 206_payroll_zero_settlement_correction_authority.sql

Adds optional immutable205 settlement reference to203 claims, retaining positive expense authority through an exclusive alternative. A zero source must match paid entry/run/employee/provenance, payment metadata, actual daily gross/fixed and incoming correction total. Claim/batch guards preserve legacy positive v1 and accept explicit zero v2 plans; no monetary record is fabricated. Deploy only with complete payroll205/206 application package and local acceptance. Migration number reserved with LOYALTY;204 remains payroll refund projection.

## 204 — payroll refund-aware v2 provenance (local storage accepted)

Adds schema2/capability employee_attributed_remaining_net_refund_v2 with exact engine payroll-verified-remaining-net-v2, preserving v1 bytes and guards. The new envelope includes a replayable source bundle, full refund evidence, quantities and explicit owner economic policy. Deferred provenance/snapshot sum guards cover both known engines. This migration does not enable v2 entry approval or payment:205 remains v1-only pending lifecycle integration. No destructive rollback or production application is authorized by this note.

Guarded local PG69383/38375 PASS: actual source-backed v2 storage, exact concurrent replay, full-return zero run, rollback after real writes,10 negative/deferred/immutable guards and204 replay twice over populated snapshots. Whole-module acceptance and release remain pending.

## 207 — atomic unpaid v2 run replacement (local private acceptance)

`207_payroll_unpaid_run_supersession.sql` is reserved with MASTER/LOYALTY. It permits proven v2 draft entries, while approval and payment remain refused. An immutable journal binds the old complete employee cohort, cancellation receipts, released incoming corrections and the new run/cohort. Deferred checks reject partial replacement, changed frozen scheme/period, mismatched net/gross/category and missing receipts; one child per original prevents branching. Chained replacement is permitted after subsequent source changes. Historical cancelled amounts remain unchanged.

Guarded PG8064 PASS: two employees including zero, partial and chained full returns, eight actual-write rollback stages, stale intent and exact concurrent/historical retries; no expense. PG35451 additionally passed ten rollback-only storage guards. The draft-only limitation describes207 alone;208 extends the same exact capability through the guarded lifecycle. Public207 browser acceptance is tracked separately.

## 208 — whole-period paid refund corrections (local implementation, full acceptance pending)

Reserved payroll number, separate from Loyalty192. Immutable period assessments and stable per-run/employee claims share the existing correction event journal. First assessed amount is historical audit; each new apply/waive is limited by the current complete assessment and all prior dispositions. Cancellation releases its exact parent application. A locked original run cannot mix legacy line claims with whole-period claims. Exact v2 schema/capability/engine now enters the existing owner/source-proof/receipt-protected approval and settlement path. Unknown capabilities remain closed.

The distinct schema3 policy reviewed_period_variable_pay_only_v1 protects the original net paid amount above fixed pay; zero-net v2 settlement creates no new reduction debt. Legacy206 keeps its original policy. V2 settlement proofs bind exact sorted ledger event IDs and their hash; later outgoing operations do not alter the historical captured set. Timestamp cutoffs are not used. This is an additive local upgrade; retain journals when rolling back the application and never downgrade to a generic linked-entry writer.

PG94909 passed the actual source-backed208 monetary service journey and then found a legacy event-validator variable/alias collision; that SQL defect has been fixed. Final default PG11166 exit0 PASS covers12 rollback-only208 storage guards/replay twice, all7 modes/21 saved runs/14 paid entries, whole-period nonlinear assessments and public207/208 UI→HTTP→DB→reload, Finance once and the unchanged legacy203/205/206 path. No release or deployment is authorized by this note.
