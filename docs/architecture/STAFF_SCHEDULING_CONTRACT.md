# Контракт универсального планирования смен

Статус: локальная реализация в процессе; требования раздела 4.1–4.3 — согласованный целевой контракт stage 04 и последующей интеграции, не утверждение о готовности этих сценариев. Источник объёма: `docs/requirements/STAFF_SCHEDULING_MASTER_PROMPT.md` в основном checkout. Текущая база разработки — ветка `codex/staff-schedule-month-planning`; ни один контракт ниже сам по себе не означает, что функция уже реализована.

## 1. Существующие границы, которые сохраняются

- Единственный пользовательский маршрут остаётся `/admin#staff-schedule` («Команда → График сотрудников»). Настройки планирования открываются из графика; не создаётся отдельный верхнеуровневый маршрут для каждой настройки.
- Единственный плановый lifecycle остаётся: `staff_schedules` → снимок/операции открытого `staff_schedule_drafts` → preview с fingerprint → публикация с повторной серверной проверкой. Прямые ручные POST/PATCH и копирование остаются совместимыми.
- `staff_schedule_templates.definition` остаётся версионируемым JSON. Старый формат `{pattern,slots}` продолжает читаться и расширяется нормализованным versioned-форматом. Архивирование и изменение шаблона не меняют созданные записи.
- `staff_schedule_grants.access` сохраняет `none/view/manage`, `can_publish` сохраняет отдельное право. Новое `can_manage_settings` выдаётся только владельцем активному admin/manager того же заведения, только при `access=manage`; owner не нуждается в grant. View не даёт мутаций, manager не выдаёт grant себе. Применять уже сохранённые шаблоны может schedule manager; создание, правка и архив шаблона дополнительно требуют `canManageSettings`.
- Все новые DTO и записи ограничены `venue_id`; составные FKs `(venue_id,id)` исключают перекрёстное связывание. Текущая серверная сессия/grant — источник полномочий; должность или имя custom role не дают доступ.
- Планируемые смены не создают и не меняют `staff_work_logs`, payroll entries, cash shifts и оплаченные attendance snapshots.

## 2. Термины и связи

| Сущность | Назначение |
|---|---|
| CRM role | Доступ к CRM и ограничения экрана; `admin`, `manager`, bartender и custom role остаются отдельны от расписания. |
| Work function | Настраиваемая заведением квалификация для конкретного назначения: бар, зал, кальянный мастер и т. п. |
| Employee qualification | Связь сотрудника с разрешёнными work functions; не выдаёт CRM permissions. |
| Template | Переиспользуемая заготовка: общий шаблон времени, фиксированная команда с собственными часами каждого участника либо циклический pattern. |
| Availability | Повторяющиеся часы доступности/предпочтения плюс разовые интервалы; отсутствие остаётся плановой записью своего типа. |
| Series | Ограниченное повторение опубликованных/предложенных назначений с датой начала, горизонтом и исключениями; не заменяет snapshot каждой смены. |
| Demand rule | Минимальная потребность в людях по функции и временному интервалу. |
| Open shift | Запланированный интервал по функции без назначенного человека; не является выходным и не попадает в персональные часы. |

Одна смена сотрудника содержит один work function. Если функция меняется в течение дня, используются соседние интервалы. Один человек с двумя квалификациями не может закрывать две одновременно требуемые позиции без явно заданного заведением правила capacity; v1 по умолчанию считает одного человека одной единицей покрытия. Смена с функцией NULL остаётся допустимой для старых ручных записей.

## 3. Аддитивная модель PostgreSQL

Все таблицы снабжаются `venue_id`, actor/timestamps, версиями для редактируемых документов, индексами по реальным фильтрам и аудитом. Любой составной FK включает tenant key.

1. `staff_schedule_functions`: название, active, version, sort order, creator; уникальность нормализованного активного имени в одном заведении.
2. `staff_schedule_employee_functions`: уникальная пара venue/user/function, active и optional primary/default marker; FK только на сотрудника того же заведения и функцию той же точки.
3. `staff_schedule_template_bindings`: opt-in связь шаблона с CRM role, work function или конкретным employee; unique scoped binding и порядок выбора. Несколько подходящих default не применяются автоматически.
4. `staff_schedule_employee_defaults`: employee/function → предпочтительный template/time preset, versioned и venue-scoped; отсутствие этой настройки разрешено.
5. `staff_schedules`: nullable `function_id`; `series_id`/`series_occurrence_date` nullable; `break_intervals` структурированы и не пересекаются, суммарно равны `break_minutes`, если указаны. Для существующих строк backfill не придумывает функции/серии/интервалы перерыва. Допустить `user_id NULL` только для `kind='open_shift'`, у такой записи обязательны часы и work function. Обычный shift/absence всё ещё требует активного сотрудника. Пересечения сотрудника проверяются по полному UTC-интервалу; параллельные open shifts допустимы и сравниваются с demand, а при назначении проверяется сотрудник.
6. Availability: `staff_schedule_availability_rules` для weekday, effective date range, kind `available|unavailable|preferred`, локальные часы и end-day offset; `staff_schedule_availability_exceptions` для точной даты и того же interval/kind. `unavailable` блокирует; `preferred` только предупреждает; отсутствие/неуказанное окно не превращается молча в выходной. Запланированные absence rows (`day_off`/`vacation`/`sick`/`other_absence`) проверяются как целодневные конфликты. В обследованной схеме нет отдельного approval lifecycle для отпусков/отсутствий, поэтому не называть эти строки утверждёнными запросами.
7. `staff_schedule_series`: employee, function, local anchor date, bounded `until_date`, recurrence JSON, timezone, state/version, immutable template snapshot. На каждой опубликованной occurrence schedule row ссылается на series и local occurrence date. Исключения и персональная ручная правка occurrence сохраняются и не затираются обновлением будущей части серии.
8. `staff_schedule_demand_rules`: функция, weekday или date range/override, local start/end/end-day, required headcount, version/active. Перекрывающиеся правила одного уровня отклоняются или нормализуются детерминированно; приоритет dated override над weekly rule документируется UI.
9. Для публикации серий и open shifts расширить JSON операции draft и атомарный publish в текущей транзакции. Не создавать отдельный путь немедленной записи, обходящий preview/fingerprint/requestKey/audit.
10. Schedule events сохраняют function, series/source, assigned/unassigned state, break interval и причины до/после. Функции/правила/availability/series имеют отдельные tenant-scoped history events либо общий типизированный audit ledger с разрешённым перечнем entity types.

Миграции остаются additive и упорядочены после 103. Конкретное разделение файлов выбирает data engineer после проверки базовой schema/migration runner. `DROP NOT NULL` user_id — единственное изменяющее nullable-свойство существующего schedule столбца; оно обратно совместимо для старых строк, но все SELECT/JOIN/DTO/validators/payroll readers надо проаудировать до изменения. Не добавлять фиктивного сотрудника для open shift. Старые клиенты не должны считать open shift обычной сменой; publish code и API выпускаются синхронно.

## 4. Шаблонный JSON и подстановка

Старый `{pattern,slots}` означает прежнее поведение: один набор слотов для каждого явно выбранного сотрудника. Новый формат содержит `schemaVersion:2`, общий pattern и либо:

- `mode:'selected'`, слоты времени без employee; при применении задаётся один/несколько сотрудников;
- `mode:'team'`, список members с `userId`, function и собственными slots. Редактор применения позволяет временно исключить участника/поменять время; шаблон не изменяется.

В каждом slot задаются kind, локальное время начала/окончания, day offset, break, примечание, function; отсутствие не содержит времени. Повторяющийся внешний pattern задаёт дни; профиль участника при необходимости может иметь ограниченное смещение цикла, но нельзя незаметно порождать выходные/отсутствия вне шаблона.

Подстановка времени в ручном редакторе: явный выбранный шаблон → персональная настройка сотрудника → ровно один активный шаблон, привязанный к CRM role или work function. При нескольких возможностях UI просит выбор; при нуле — ручное время. Подстановка не меняет CRM role/permissions, не заменяет введённые поля без явного действия и применяется только к новой записи. Ролевое значение никогда не является hardcoded business-hour rule.

### 4.1 Применение team-template: редактируемый снимок до preview

Применение фиксированного состава — не команда «развернуть сохранённый шаблон» напрямую, а последовательность `выбрать шаблон → отредактировать временную композицию → preview → применить в черновик`. Редактор получает неизменённую версию шаблона и создаёт отдельный клиентский snapshot. Сохранение snapshot никогда не вызывает `PUT/PATCH /templates` и не меняет `staff_schedule_templates.definition`.

Нормативная форма preview-запроса для группового шаблона:

```json
{
  "templateId": "<uuid>",
  "templateVersion": 4,
  "from": "YYYY-MM-DD",
  "to": "YYYY-MM-DD",
  "composition": [
    {
      "userId": "<venue employee uuid>",
      "selected": true,
      "slots": [
        {
          "kind": "shift",
          "workDate": "YYYY-MM-DD",
          "startTime": "17:00",
          "endTime": "23:00",
          "endDayOffset": 0,
          "breakMinutes": 0,
          "functionId": "<venue function uuid>",
          "note": ""
        }
      ]
    }
  ]
}
```

- `composition` содержит ровно участников исходной версии team-template; пользователь может исключить участника (`selected:false`), но не добавить человека извне этого шаблона. Выбранному участнику можно отредактировать число слотов, даты/дни применения, время, end-day offset, перерыв, функцию и примечание до preview. Удаление всех слотов означает явное отсутствие назначения участника в этом применении. Нельзя трактовать снятый выбор как выходной или создавать для него запись.
- Слоты и функции копируются в draft operations как значения. Для выбранного сотрудника каждый слот несёт собственную функцию и время; функция обязана быть активной и квалификация сотрудника проверяется сервером. Для шаблона режима `selected` редактор строит такую же явную per-employee composition для выбранных пользователей, расширяя общие слоты в их персональные слоты до preview.
- Сервер проверяет, что каждый включённый employee входит в исходный team-template версии, принадлежит текущему venue и активен; template ID/version совпадают с актуальной неархивной записью. Нельзя принимать только произвольный массив уже развёрнутых операций без ссылки на источник и его версию.
- Нормализованный fingerprint включает как минимум draft ID/version и диапазон, venue timezone, исходные `templateId/templateVersion`, канонический состав со всеми `selected` значениями и per-member slots/functions, развёрнутые операции, актуальную base snapshot и версии проверяемых availability/policy данных. Preview возвращает этот fingerprint и нормализованный snapshot, который UI показывает как проверенный результат.
- `range-apply` передаёт тот же source reference, состав и fingerprint. Сервер в одной транзакции заново читает draft, шаблон, base snapshot, разрешения и релевантные ограничения, строит preview заново и сравнивает fingerprint. Любое расхождение — `409 planning_preview_changed`/`template_version_conflict`; клиент сохраняет редакторские данные и предлагает новый preview. Отредактированный snapshot не записывается в сам шаблон.
- Любой hard conflict отклоняет весь набор без добавления части операций в draft. Предупреждения не отклоняются молча: UI показывает конкретные строки и причины; явное подтверждение и причина передаются при apply, а подтверждённые предупреждения и причина сохраняются в audit/draft history. Жёсткие конфликты нельзя подтвердить или обойти. Объём применения должен укладываться в API operation limit; при превышении пользователь уменьшает диапазон/состав и повторяет preview.
- Успешный apply добавляет весь пакет операций в существующий открытый draft одной транзакцией, увеличивает draft version, записывает audit и возвращает обновлённый draft. После этого UI делает GET/readback draft и показывает применённый состав; публикация остаётся отдельным явным действием.

### 4.2 Серии и свободные смены в общем lifecycle

Серия и свободная смена — доменные источники предложений, не альтернативный путь записи графика. Preview серии детерминированно разворачивает ограниченный горизонт и исключения в обычные draft operations с датой occurrence, `seriesId/sourceVersion` и неизменяемым снимком исходного шаблона/правила. Изменение серии после preview делает fingerprint устаревшим. До публикации предложения серии принадлежат draft; постоянная series-запись и опубликованные occurrence rows создаются/связываются только внутри транзакции publish. Пропуск или конфликт одной обязательной occurrence блокирует весь пакет; исключения и ранее индивидуально изменённые occurrence остаются неизменными и явно отображаются.

Свободная смена — draft operation `create` с `kind:'open_shift'`, `userId:null`, обязательными датой, временем и активной рабочей функцией. Она видна в общем preview и покрытии, но не в персональных часах. Публикация создаёт её как обычную schedule row с отдельным kind и audit. Последующее назначение человека проходит через новый draft/preview/publish; в publish повторно проверяются tenant, активность и квалификация сотрудника, доступность и пересечения. Прямая запись или назначение в обход draft lifecycle запрещены.

В обоих случаях `manage` требуется для редактирования draft и preview/apply. Публикация требует владельца либо `manage && canPublish`; права повторно проверяются сервером при каждой операции, включая publish. Одновременное применение обычных смен, series occurrences и open shifts атомарно: либо все валидные операции переходят в опубликованный график вместе с series/event ссылками, либо ни одна запись пакета не коммитится. Запросы защищены существующими version/fingerprint/requestKey/audit механизмами; повтор того же requestKey возвращает сохранённый ответ, а несовпадающий payload с тем же ключом отклоняется.

### 4.3 UI → API → право → snapshot → readback → QA

| Путь | UI и API | Авторизация | Snapshot и повторное чтение | QA-подтверждение |
|---|---|---|---|---|
| Выбрать и редактировать состав | «Добавить по шаблону» в календаре; `GET /templates`, локальный editor state | GET: `view`; применение: `manage` | Источник хранит `templateId/version`; локальная композиция содержит subset, slots и функции, но не меняет шаблон | Browser: снять участника, изменить часы/функцию, убедиться что сохранённая версия шаблона не изменилась |
| Получить preview | `POST /drafts/:id/range-preview` с source ref, диапазоном и composition | `manage`; tenant и eligibility проверяются сервером | Ответ включает развёрнутые operations, конфликты/предупреждения и fingerprint от template ref + composition + draft/base/policy версии | API/PG: корректная персональная развёртка, venue isolation, stale template/draft/availability => 409 |
| Применить весь пакет | `POST /drafts/:id/range-apply` с тем же DTO/fingerprint, подтверждением и причиной предупреждений | Повтор `manage` в транзакции; `requestKey` обязателен для мутации | Сервер повторно читает шаблон, draft/base и ограничения; полный пакет либо добавлен в draft, либо нет; затем `GET /drafts/:id` | API/PG: conflict одной строки не оставляет частичных ops; timeout/replay без дублей; источник template неизменён |
| Опубликовать draft | Сводка diff → `POST /drafts/:id/publish-preview` → явное подтверждение → `POST /drafts/:id/publish` | Preview: `manage`; publish: owner или `manage && canPublish`, проверка заново | Fingerprint пересчитывается; schedule rows, series rows/links, events и финальное состояние draft коммитятся атомарно; затем GET draft/calendar для readback | API/PG/browser: отзыв права, stale preview, атомарный rollback, повтор запроса, reload календаря и источники/версии |
| Опубликовать свободную смену / серию | Те же draft UI и range preview/apply/publish endpoints; тип операции различает open shift или occurrence | Те же schedule grants; отдельной роли/endpoint для обхода не вводится | Open shift хранит `userId:null`; series operation хранит source/version/occurrence; постоянные сущности появляются при publish | API/PG/browser: незакрытая свободная смена не учитывается в персональных часах; повтор occurrence не создаёт дубль; исключения не перезаписываются |

Нерешённые решения, которые не следует домысливать при реализации:

1. Нужно ли при применении создавать только смены или также поддержать шаблонные absence slots. До отдельного решения применять team-template только к назначениям, явно заданным в definition; не выводить выходной из отсутствия участника/слота.
2. Можно ли пропускать отдельную конфликтующую occurrence серии с подтверждением пользователя либо серия всегда применяется all-or-nothing. Без решения использовать all-or-nothing для одного preview/apply пакета.
3. Как обрабатывать изменение опубликованной серии для будущих occurrence: требовать отдельный выбор «одна / выбранные даты / будущая часть» и сохранять персональные правки/исключения; точное разрешение конфликтов с уже опубликованным графиком требует отдельного UX и остаётся незафиксированным.
4. Допустимы ли операции более 200 строк одним пакетом или нужен UI для последовательных атомарных чанков. Пока действует существующий лимит 200; нельзя тихо разбивать один подтверждённый preview на несколько частичных commit.
5. Требуются ли после публикации подтверждение ознакомления и внешние уведомления, их адресаты и политика повторной доставки. Это будущий этап; не создавать фиктивный статус доставки и не менять publish успех.
6. Денежные последствия, расчёт оплаты и юридические нормы расписания не определены этим контрактом и не должны выводиться из длительности смен, серий или предупреждений.

## 5. API/UI/permissions contract

| UI действие | Существующий/добавляемый API | Право | Сохранение и повторное чтение | Обязательная проверка |
|---|---|---|---|---|
| Просмотр календаря | `GET /api/staff/schedule?from&to`; employees/catalog/settings GET | `staff_schedule_view` | Текущий tenant и timezone | view разрешает GET, чужой tenant не раскрывается |
| Смены вручную | POST/PATCH существующего `/api/staff/schedule` | `manage` на сервере | Версия, requestKey, schedule events | reload/readback, conflict, ночной интервал |
| Создать/править шаблон и черновик | Существующие `/templates`, `/drafts`, preview/apply | `manage`; write шаблона также `canManageSettings` | JSON version + audit + идемпотентность | старый `{pattern,slots}` round-trip; settings grant enforced server-side |
| Настроить функции, eligibility и recurring availability | Tenant-scoped `/functions`, `/employees/:id/functions`, `/employees/:id/availability` | `canManageSettings`; owner always | version/requestKey, actor history; availability version входит в preview fingerprint | роль/grant не подменяются body; view/manage separation; stale preview после изменения доступности |
| Применить шаблон/цикл, назначить open slot | Существующие draft range preview/apply; расширить operation DTO | `manage` | fingerprint повторно проверяется; атомарная операция | два человека с разными часами; нет частичного применения |
| Опубликовать | Существующий draft publish-preview/publish | owner либо `manage && canPublish` | row version/events/series references | отзыв grant между preview и publish запрещает запись |
| Печать/CSV | Tenant-scoped read-only export GET | `view`, но только разрешённые поля | Без мутации | CSV formula escaping и отсутствие кадровых/секретных полей |

Demand endpoints пока не реализованы. Venue-level warning policy schema добавлена migration106; её settings/API и применение в planner — отдельный целевой slice stage05, описанный в §5.1 (это не утверждение о реализации).

Состояния всех форм: loading, empty, error/retry, forbidden, saving, dirty confirmation, version conflict, stale preview, success with readback. Экспорт и calendar не возвращают PIN, контакты, паспорт, Telegram, login/password или HR notes.

## 6. Правила конфликтов и временной модели

- Бизнес-даты и повторения задаются в IANA timezone заведения; timestamps смен хранятся как timestamptz. Проверять nonexistent local times на переходе DST и отдельно неоднозначный повторяемый час осенью; UI требует однозначного выбора либо показывает явно принятое правило.
- На фоне строится UTC interval; отображается local start/end с датой окончания. Перерывы вычитаются из покрываемых интервалов только если структурированы и не пересекаются с краями смены.
- Hard conflict: сотрудник неактивен/чужой tenant, сотрудник пересекается, shift конфликтует с approved absence/unavailable interval, function qualification отсутствует, незаконный диапазон/series horizon, устарел base snapshot/preview.
- Hard conflicts остаются самостоятельными блокирующими результатами и не подтверждаются как warnings: в частности, availability `unavailable` и выход за явно заданные `available` окна согласно текущему `staff-schedule-availability.js`. Ни настроенный порог, ни причина подтверждения warnings не понижают hard conflict. Предпочтительное окно (`preferred`) остаётся warning.
- Venue policy warnings: превышение настроенного максимума недельных минут, нарушение настроенного минимума отдыха, максимума последовательных дней и выход за business intervals. Это настраиваемые операционные предупреждения заведения, не юридическая оценка. `NULL` threshold отключает только соответствующую проверку; отсутствующая строка policy эквивалентна всем thresholds `NULL` и `businessHoursEnabled=false`.
- Включённые business hours проверяются по локальным ISO weekday и интервалам заведения; неполное покрытие смены генерирует warning. День без активных интервалов считается закрытым только при `businessHoursEnabled=true`; при выключенном toggle интервалы игнорируются. Конвертация границ в UTC использует IANA timezone venue и существующее однозначное разрешение local time; неоднозначное/nonexistent wall time не угадывать.
- Policy warnings нельзя разрешать молчаливым override. Для apply/publish пользователь подтверждает наличие warnings и передаёт непустую общую причину (лимит 500 символов по действующему `reason`); сервер проверяет это повторно и записывает action, actor, requestKey, policy/availability fingerprints, warning fingerprint, полный warning DTO и reason в стабильный audit snapshot в той же транзакции. Range-apply использует planning event; publish/manual save — schedule event.
- Template/series application сначала возвращает операции, conflicts, warnings, interval coverage and stable fingerprint; никакой частичной записи. Apply сохраняет предложения в draft. Publish повторяет все checks под блокировкой и пишет series/schedules/events одной транзакцией.

### 5.1 Stage05 — venue policy: settings и planner contract

Migration106 (`migrations/106_staff_schedule_venue_policy.sql`) задаёт только схему, не evaluator/API: одна `staff_schedule_venue_policies` на venue с nullable `max_weekly_minutes`, `minimum_rest_minutes`, `maximum_consecutive_days`, `business_hours_enabled=false`, `version`; локальные weekday intervals в `staff_schedule_venue_business_intervals` с `end_day_offset` 0/1, active/version и actor timestamps; `staff_schedule_config_events.entity_type='venue_policy'`. DB check задаёт положительный max weekly/consecutive и неотрицательный minimum rest. Settings mutations обязаны также проверять ограничения диапазона на сервере и завершаться version conflict, а не подгонять/обрезать значения.

**Согласованный путь UI → policy config → preview/apply/publish:** owner/settings manager открывает «График → Настройки → Политика заведения»; UI получает policy + intervals + IANA timezone и версии. Сохранение конфигурации создаёт/обновляет policy и intervals tenant-scoped, с optimistic version, idempotency/requestKey и audit config event. Draft range preview и publish-preview вычисляют результаты по одному server-read snapshot operations + draft base + availability config + venue policy config; возвращают отдельно `conflicts[]` и `warnings[]`. `range-apply` и `publish` требуют совпадающий fingerprint, повторяют evaluator под текущей блокировкой и, если warnings непусты, явное подтверждение и причину. Apply меняет только draft. Publish повторно проверяет и публикует через текущую транзакцию; запись подтверждения предупреждений и schedule/draft events должна быть атомарна с соответствующим действием. После apply UI перечитывает draft; после publish — календарь/draft.

Реализованный endpoint contract:

| Действие | Endpoint / DTO | Право и результат |
|---|---|---|
| Прочитать policy | `GET /api/staff/schedule/venue-policy` → tenant-scoped DTO с thresholds, переключателем и intervals. При отсутствии policy возвращаются version `0`, null thresholds и выключенные business hours. | owner либо `manage && canManageSettings`; tenant берётся из session. |
| Сохранить policy и интервалы | `PUT /api/staff/schedule/venue-policy` body `{version,requestKey,thresholds,businessHoursEnabled,intervals:[{weekday,startTime,endTime,endDayOffset}]}`. Null thresholds отключены; список intervals — атомарная полная замена: предыдущие строки архивируются, новые получают id/version. | owner либо `manage && canManageSettings`; versioned config audit event с actor и before/after. |
| Проверить draft operations | Существующий `POST /api/staff/schedule/drafts/:id/range-preview` и `.../publish-preview`; input остаётся текущим draft/version/operation DTO. Output дополнить `{conflicts,warnings,fingerprint,policy:{version,configurationFingerprint,timezone}}`; warning DTO имеет stable `code`, affected user/schedule/date/interval IDs и безопасные параметры threshold/fact. | `manage`; без записи. Preview fingerprint включает canonical policy row и все active interval IDs/versions/content, toggle, timezone, draft/base, availability configuration и normalized operations. |
| Применить | Существующий `POST .../range-apply` body содержит `fingerprint`, `confirmWarnings:true` и непустой `reason`, если preview вернул warnings; structured warning snapshot пишется отдельным неизменяемым planning event в той же транзакции. | `manage`; hard conflict → 409 без записи; полный пакет атомарен. |
| Опубликовать | Существующий `POST .../publish` body содержит publish-preview fingerprint, draft version, `requestKey`, и при warnings `confirmWarnings:true`, `reason`. | owner либо `manage && canPublish`; повторный check; warning snapshot включается в `staff_schedule_events.after_data`. |

DTO requirements: интервалы — venue-local wall times, ISO weekday 1–7, явный `endDayOffset`; crossing midnight только offset=1; полный local day допускается `00:00`→`00:00`, offset=1. Точные дубли запрещены; максимум 70 intervals. Threshold ranges: weekly 1..10080, rest 0..10080, consecutive 1..93. Смена длиннее local date считается сегментами. Сохраняются текущие caps: draft horizon 92 дня, до 200 операций; warnings/conflicts ограничены 200; исторический запрос scoped участниками draft и необходимой окрестностью.

**Согласованная продуктовая семантика (ответ владельца, 2026-10-14):** неделя — календарная понедельник–воскресенье в часовом поясе заведения; считаются planned смены текущего опубликованного графика и финального плана draft (отменённые и absence исключены); минуты распределяются по локальным календарным датам, `breakMinutes` целиком вычитается из даты начала смены. Отдых — elapsed UTC промежуток между planned сменами; последовательные дни — разные локальные даты с любым пересечением смены. Business hours требуют полного покрытия всего UTC-интервала объединением локальных интервалов; пустой день закрыт при включённом переключателе. Неоднозначное/несуществующее локальное окно не угадывается и выдаёт warning. Все проверки advisory, не юридические нормы/оценка соблюдения закона.

Для policy или availability изменения fingerprint обязан меняться даже если итоговый список warnings совпал. Для policy fingerprint использовать canonical sorted snapshot с явным `policyVersion` и версиями/content всех учитываемых active intervals; изменение toggle, threshold, timezone или interval invalidates previews. Отдельный `configurationFingerprint` можно включить в общий planning fingerprint. Preview/apply/publish используют согласованный server snapshot/lock order и повторяют проверку непосредственно перед записью. Нынешняя migration не добавляет config lock/version для набора intervals: реализация должна сериализовать policy mutation с planning operations venue lock либо обеспечить эквивалентный атомарный compare-and-check; опора лишь на row version policy недостаточна при изменении interval rows.

Стабильный audit snapshot содержит action, actor, requestKey, policy/availability fingerprints, полный warning DTO и reason. Range-apply сохраняет отдельное planning event, publish/manual save вкладывают snapshot в `staff_schedule_events.after_data`, атомарно с мутацией. Повтор `requestKey` возвращает сохранённый результат; другой payload с тем же ключом — `schedule_request_conflict`.

Коды ошибок/API UI: `schedule_settings_forbidden` (403); `schedule_version_conflict` или специализированный `schedule_policy_version_conflict` (409, выбрать совместимый единый код до реализации); `schedule_request_key_required` (400); `schedule_request_conflict` (409); `schedule_reason_invalid` (400); `planning_preview_changed` / `draft_base_changed` (409 stale, перечитать policy/draft и показать повторный preview); `planning_conflict` (409 hard conflicts, не предлагать override); `planning_warnings_confirmation_required` (409 с текущими warning DTO, запросить подтверждение/причину); `schedule_policy_invalid`, `schedule_business_interval_invalid` (400); `schedule_range_invalid` / `planning_operations_limit` (400); `schedule_timezone_invalid`, `schedule_availability_time_ambiguous` (409). Не маскировать 403/409 как общий успех/«сохранено».

Требуемые проверки stage05: owner CRUD/readback и manager только с обоими `manage + canManageSettings`; `view` read-only; чужой venue скрыт/не меняется; optimistic conflict/replay/request-key mismatch; nullable threshold отключает ровно своё предупреждение и нет legal defaults; business toggle off игнорирует интервалы, on + пустой weekday закрывает день; локальные weekday/overnight/UTC и DST границы; hard availability conflict остаётся конфликтом даже с warning confirmation; warning reason и stable snapshot сохраняются; любое изменение policy или interval версии/content/toggle/timezone stale-ит preview на apply и publish; ручной planner UI корректно показывает отдельные conflicts/warnings, причину, retry/re-preview; пределы 92 дня/200 operations и bounded warning output; publish recheck/rollback атомарны.

## 7. Не входит в первый локальный выпуск

Внешняя рассылка, employee self-service заявки, swap/trade, pay forecasting и auto-optimizer. Не показывать нерабочие кнопки и не писать `notified=true` без подтверждения внешнего адаптера.

### Будущая интеграция уведомлений (не реализована)

- Кандидаты событий: `staff_schedule.published` и `staff_schedule.changed`; payload — tenant/venue, идентификатор и версия публикации, автор, время фиксации, затронутые user IDs и краткое изменение без лишних персональных полей.
- Для будущей доставки событие следует записывать в transactional outbox в той же транзакции, что и publish/change; ключ дедупликации должен включать publication/version/event type. Внешняя отправка — отдельный worker/adaptor после commit с ограниченными повторами и журналом попыток.
- Адресаты и каналы пока не утверждены. До решения владельца не создавать outbox-записи, не отправлять сообщения, не показывать «уведомлено» и не менять успешность публикации по доступности внешнего сервиса.
- Подтверждение ознакомления, если его утвердят, должно быть отдельным явным действием сотрудника и уникально для user + опубликованная версия; факт нельзя выводить из доставки или открытия страницы. Эта модель пока не создаётся в БД.

## 8. Обязательные связанные контракты

До кодирования миграции проверить: `migrations/021,101-103`, `staff-schedule-domain.js`, `staff-schedule-service.js`, `staff-schedule-planning.js`, `staff-schedule-pattern.js`, `staff-schedule-access.js`, `staff-schedule-routes.js`, `API.md`, `SITE_TREE.md`, `SITE_MAP.md`, payroll attendance snapshot readers и QA harness. UI остаётся на текущем `/admin#staff-schedule`; изменение этого route/sidebar потребует обновить `SITE_TREE.md`, `SITE_MAP.md`, `site-map.json` и nav contracts.
