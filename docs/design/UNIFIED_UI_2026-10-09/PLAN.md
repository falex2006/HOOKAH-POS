# План внедрения

**Актуальная область, 2026-10-11:** по прямой команде пользователя UI-10 / UI-10.1 (Galaxy Fold) исключён из текущего плана и очереди. Не запускать и не учитывать в оставшихся этапах или условиях выпуска. Возврат возможен только по новой отдельной команде. В активном плане 21 подэтап; после подготовленного UI-09.2 остаётся UI-09.3 и его условия выпуска. Упоминания Fold и счётчика 22 в прошлых итогах — исторические записи.

Статус: **UI-01.1 и UI-01.2 приняты как исследовательские пакеты**; доказательства — в [PROGRESS.md](PROGRESS.md) и [итоге UI-01.2](UI_01_2_CHECKPOINT_R6.md). UI-01.2 принят с документированными дефектами; product/runtime PASS 0. UI-02.1 принят в своей области с документированным долгом: [результат](UI_02_1_RESULT.md). UI-02.2 принят в области общих примитивов с документированными ограничениями: [результат](UI_02_2_RESULT.md). UI-03.1 принят scoped desktop с документированным долгом: [результат](UI_03_1_RESULT.md). UI-03.2 принят scoped с документированным долгом: [результат](UI_03_2_RESULT.md). UI-04.1 принят scoped с документированным долгом: [результат](UI_04_1_RESULT.md). UI-04.2 принят **ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**: четыре ordinary редактора и бронь, optional mounted-form lifecycle extension; финансовые handlers не мигрированы. Последнее явное разрешение пользователя включает автоматическое продолжение UI-04.3 после полного принятия UI-04.2, переопределяя прежний PROMPTS запрет. UI-04.3 принят ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT: [результат](UI_04_3_RESULT.md). Автоматический переход завершён; GPT-6.1 Sol / High — рекомендация, не факт переключения. Остальные этапы сохраняют отдельные scope/gates.

## Выбор моделей и экономия

Модели указаны по доступному списку текущего Codex. Распределение ниже — инженерная рекомендация для этого проекта, не гарантия качества/расхода. Astra подходит для неоднозначных решений, Sol — для сложных согласованных работ, Luna — для ограниченных задач по готовому образцу. Официальная рекомендация предлагает оставлять наименее затратную настройку, которая проходит требуемую планку качества: [OpenAI — Model selection](https://developers.openai.com/api/docs/guides/model-selection).

Здесь High означает высокий уровень рассуждения, Medium — средний. Не требуется Max/Ultra по умолчанию. Выбор модели и уровня делается перед запуском задания; текст промпта сам по себе не переключает основной чат. Для помощников модель задаётся только поддерживаемым инструментом и в рамках разрешённой делегации.

Экономим не отказом от проверки, а короткими пакетами, готовыми контрактами и передачей только нужных файлов/доказательств. Не перечитывать всю историю FIX-01…06 для каждой правки. Если Luna дважды не проходит одну приёмку или задача требует новой архитектуры, остановить расширение scope и передать тот же пакет Sol/High с кратким отчётом. Astra/High — для действительно неоднозначного решения, а не повторения типовой CSS-правки. Расход токенов заранее достоверно не рассчитан; время и потребление фиксировать только по доступной фактической статистике.

### Правило «проверить один раз по делу»

UI-01.1 фиксирует базовые контракты и карту. UI-01.2 снимает исходные экраны. Эти артефакты повторно не собирать на каждом шаге: подэтап сверяет только затронутые компоненты/страницы с исходным эталоном и проверяет изменённый сценарий. Code health смотрит baseline/diff каждого программного пакета, а не делает повторный аудит всего репозитория. Архитектор подключается к shell/маршрутам, QA — к затронутым ролям и сценариям. Не запускать все роли на простой CSS-правке.

Общая матрица всех страниц/ролей выполняется один раз в UI-09.1 после миграций. Раньше полный повтор нужен только если изменился общий компонент, есть регрессия или новый факт опровергает исходную базу. В таком случае указать конкретную причину и повторить лишь зависимые строки матрицы. Не запускать один и тот же тест несколькими инструментами, если один надёжно доказывает критерий.

## Этапы

| Этап | Результат | Основная модель |
|---|---|---|
| UI-01 | Актуальные правила и визуальная база | Astra High → Sol Medium |
| UI-02 | Токены и общие контролы | Sol High |
| UI-03 | Оболочка и навигация | Sol High |
| UI-04 | Окна, сообщения, PIN | Sol High/Medium |
| UI-05 | Рабочие страницы сотрудников | Sol High → Luna Medium |
| UI-06 | Каталог и склад | Sol Medium → Luna Medium |
| UI-07 | Критичные операции и финансы | Sol High/Medium |
| UI-08 | Остальное управление и очистка | Sol High → Luna Medium |
| UI-09 | Приёмка, подготовка, отдельная публикация | Sol High |

## Подэтапы

| ID | Работа | Модель / уровень | Зависит от |
|---|---|---|---|
| UI-01.1 | Правила и карта системы | GPT-6 Astra / High | нет |
| UI-01.2 | Визуальная база всех ролей | GPT-6.1 Sol / Medium | UI-01.1 |
| UI-02.1 | Целостность CSS и семантические токены | GPT-6.1 Sol / High | UI-01.1, UI-01.2 |
| UI-02.2 | Общие контролы, типографика и фокус | GPT-6.1 Sol / High | UI-02.1 |
| UI-03.1 | Единая оболочка сотрудника и портала | GPT-6.1 Sol / High | UI-02.2 |
| UI-03.2 | Навигация и сохранение контекста | GPT-6.1 Sol / High | UI-03.1 |
| UI-04.1 | Общий контракт окон, полей и сообщений | GPT-6.1 Sol / High | UI-03.2 |
| UI-04.2 | Обычные редакторы и бронирования | GPT-6.1 Sol / Medium | UI-04.1 |
| UI-04.3 | PIN и стек окон | ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT | UI_04_3_RESULT.md; VM25/default74/mounted16,36pairs108refs; four roles, scoped reviews GO |
| UI-05.1 | Рабочий зал, заказ и приготовление | GPT-6.1 Sol / High | UI-04.3 |
| UI-05.2 | Гости, задачи, доставка и список броней | GPT-6 Luna / Medium | UI-05.1 |
| UI-06.1 | Каталог, техкарты и справочники | GPT-6.1 Sol / Medium | UI-05.2 |
| UI-06.2 | Остатки, пополнение и премиксы | GPT-6 Luna / Medium | UI-06.1 |
| UI-07.1 | Критичные окна: оплата, возврат, проведение | GPT-6.1 Sol / High | UI-06.2 |
| UI-07.2 | Финансовые страницы и отчёты | GPT-6.1 Sol / Medium | UI-07.1 |
| UI-08.1 | Управление заведением и персоналом | GPT-6.1 Sol / High | UI-07.2 |
| UI-08.2 | Сеть, интеграции, вход и платформа | GPT-6.1 Sol / High | UI-08.1 |
| UI-08.3 | Завершение эффектов и очистка каскада | GPT-6 Luna / Medium | UI-08.2 |
| UI-09.1 | Сквозная приёмка desktop | GPT-6.1 Sol / High | UI-08.3 |
| UI-09.2 | Подготовка релизного пакета | GPT-6.1 Sol / High | UI-09.1 |
| UI-09.3 | GitHub и VPS — отдельный запуск | GPT-6.1 Sol / High | UI-09.2 + явная команда публикации |

## Порядок и приёмка

Перед каждым пакетом: актуальный Git status/SHA, состав относящихся файлов, входные доказательства и исходные ошибки. После: локальные проверки, независимый code health для программных изменений, снимки затронутых состояний, запись в PROGRESS.md и рабочем журнале. Зависимый этап начинается после принятия предыдущего, а не просто после окончания генерации кода.

Для shell/маршрутов обязателен system_architect; design lead и frontend подтверждают оформление, QA — поведение. Максимум три параллельных помощника, независимые области; не редактировать одни файлы одновременно. Названия профилей проверить в .codex/team/team.json перед делегацией; при несовпадении использовать действующий профиль по роли.

Дополнительные владельцы: UI-04.3 — security_reviewer; UI-06 — warehouse_domain; UI-07.1/07.2 — finance_domain, при движениях склада также warehouse_domain; UI-08.1/08.2 — security_reviewer для прав/аутентификации; UI-09.2/09.3 — release_manager. Они подключаются к профильной части последовательно, соблюдая лимит трёх помощников.

До выбора реализации общей оболочки UI-04.1 включает короткую проверку совместимости PIN/top layer. UI-04.3 затем выполняет полную интеграцию; риск не откладывается до завершения всех миграций.

Общее правило отката: каждый пакет — изолированный diff/коммит после приёмки. При регрессии откатывать только этот пакет безопасным способом, сохранив пользовательские изменения. Не сбрасывать всю грязную рабочую папку. Релизный rollback описывается отдельно в UI-09.2.

Пользователь видит номер активного подэтапа, итог после его завершения, результаты проверок и следующий рекомендуемый запуск. Статусы: запланирован / в работе / на проверке / принят / заблокирован / отложен. Нельзя отмечать непройденное как принятое. Новая существенная работа получает подномер, причину и зависимости.

Нефункциональная стилизация не должна менять API, БД, расчёты, права, маршруты и tenant. Если исправление требует такого изменения, это отдельная явно описанная задача. Тесты будущих пакетов выполняются в рамках явного задания на реализацию и проверку; текущий аудит их не запускал.

Полный критерий каждого подэтапа и копируемое задание — в [PROMPTS.md](PROMPTS.md).


## Итог UI-04.3 — 2026-10-10

**ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT.** Автоматический переход UI-04.2→UI-04.3 завершён. Native PIN поверх native/shared/legacy, сохранение drafts и pending, общий scroll lease, проверенный возврат фокуса, identity/epoch gates и auth401→login. PASS11syntax/6contracts/evidence/diff/2mirrors;36finalpairs108refs,4roles,8owner matrix,real API/readback и independent architect/security/health/QA GO. [Результат](UI_04_3_RESULT.md), [ревью](UI_04_3_REVIEWS.md). Tall PIN card scroll и settings overflow сохранены как долг. Own proxy/tab закрыты,viewport reset; прежние preview/backend сохранены. GitHub/VPS публикации не было. Далее UI-05.1, GPT-6.1 Sol / High рекомендован; не запущен автоматически.


## Итог UI-05.1 — 2026-10-10

**ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT.** Зал, редактор заказа, каталог и приготовление используют общие операционные примитивы; пустая панель компактна, до выбора стола нет лишней CTA. Сумма, HH:MM, оборудование, плотность и скрытый единственный зал сохранены. Подтверждённая тема берётся из успешной сессии. Исправлены вспышка denied при загрузке и уход busy-каталога ниже экрана из-за generic position:relative.

PASS: 27 команд (16 focused suites, 8 syntax, evidence/API/diff), 2 source/dist mirrors; 17 actual-source presentation checks. **56 final JPG/JSON пар / 112 current bindings / 626 целей ≥44px**, desktop1366×768/1920×1080 обе темы, actual1280×720DPR1/1.25, четыре рабочие роли и denied сотрудник, narrow390×844 ограниченно. В коротком management viewport применяется читаемая прокрутка EX-06; обязательные desktop наборы10 помещаются.

Реальный isolated PostgreSQL/auth: 3 заказа,10 non-stock строк,39 успешных изменений с последующим GET; длинный заказ6 строк/2450 ₽ прошёл бар и кальянную до готовности. Суммы/actor/tenant/timestamps подтверждены PG. Платежей, скидок и складских движений0; заказы остаются финансово открыты. Независимые architect/design/QA/health GO scoped. [Результат](UI_05_1_RESULT.md), [ревью](UI_05_1_REVIEWS.md).

Ограничения: legacy светлые catalog insets/queue heading/narrow sticky strip, Fold отдельно; PIN функциональный DOM/unlock/readback проверен, новый overlay screenshot отсутствует из-за сбоя инструмента, полный контур UI-04.3 не перепринимался. Собственные proxy31963/tab13 закрыты,viewport сброшен,fixture themes восстановлены; существующие preview/backend/Edge сохранены. GitHub/VPS публикации нет. Следующий отдельный **UI-05.2 «Гости, задачи, доставка и список броней», GPT-6 Luna / Medium**; автоматически не запущен.


## Итог UI-05.2 — 2026-10-10

**ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT.** Гости, задачи, доставка и список броней используют существующие C14/C15 primitives. Доставка открывается одной CTA в прикреплённой форме; список виден первым, черновик/фокус сохраняются, закрытие блокируется в pending. Для гостей разделены loading/error/empty/filter-empty и retry; generation/current-list/context guard исправляет воспроизведённую гонку старой ошибки. Светлые task headings/guest segment surfaces приведены к семантическим токенам с достаточной специфичностью.

PASS: 24 focused/syntax/evidence/API/diff команд, 2 exact mirrors, 18 actual-source presentation checks; 64 final JPG/JSON пар / 128 current-source bindings / 403 целей ≥44px. Desktop1366×768/1920×1080, actual560×764DPR1.25, narrow390×844, обе темы; owner/manager/worker и реальный denied сотрудник. 5 synthetic entities / 8 принятых API операций / 8 последующих real GET, PG tenant/fields/status и нулевые financial/stock journals подтверждены. Independent architect/health/design/QA GO scoped.

Empty final pixels — явно помеченные read-response fixtures после authenticated upstream200, БД не очищалась; actual first-empty DB pixels сохранены только diagnostic при прежнем SHA. Long — длинные строки гостя/задачи/адреса и две доставки, без заявления нагрузочной приёмки. Прежние/переходные кадры не перепривязаны. Fold/UI-10.1, финансовые редакторы/PIN полная повторная приёмка и legacy delivery detached read остаются вне scope. Задачи/доставка сохраняют прежний local theme boot; фактическая тема записана в каждой паре.

Own proxy31964/tab14 закрыты, viewport сброшен, fixture themes восстановлены; прежние preview/backend/Edge сохранены. GitHub/VPS публикации нет. Далее отдельный **UI-06.1 «Каталог, техкарты и справочники», GPT-6.1 Sol / Medium**; автоматически не запущен.

[Результат](UI_05_2_RESULT.md), [ревью](UI_05_2_REVIEWS.md).


## Автоматическая очередь — 2026-10-10

Последняя команда пользователя разрешает автоматически продолжать следующие этапы с GPT-6.1 Sol / Medium после их проверенной приёмки. UI-06.1 начат; дальнейшая очередь и текущий checkpoint: [AUTO_CONTINUATION.md](AUTO_CONTINUATION.md). Прежние запреты автоматического перехода в отдельных локальных промптах переопределены этой командой. Публикация/Fold сохраняют отдельные условия плана.


## Уточнение автоматического порядка — 2026-10-10

Пользователь исправил интерпретацию: автоматически выполнять только непрерывную последовательность этапов, которым именно в плане назначена GPT-6.1 Sol / Medium, без замены моделей и без пропусков. В текущей позиции это только UI-06.1. После его полной приёмки остановиться перед UI-06.2 (GPT-6 Luna / Medium); не перескакивать к UI-07.2. Предыдущая запись о всей очереди UI061→092 ошибочна и отменена. Автоматизация hookah-pos-ui и AUTO_CONTINUATION.md исправлены; UI-06.1 остаётся в работе.


## UI-06.1 — закрытие 2026-10-10

**ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**: [RESULT](UI_06_1_RESULT.md), [REVIEWS](UI_06_1_REVIEWS.md). Три inventory представления,35source проверок,52финальные Edge пары,9GUI writes/9GET/PG,30roleGET/20write403,11journals0. Health/architect/QA scoped GO; унаследованный tobacco regex FAIL и editor/lifecycle/readonly-copy/theme/below-fold долг записаны. Исторические evidence не изменены. Локально, без публикации. Автоматическая очередь остановлена перед UI062 (GPT-6 Luna / Medium), UI062 не начат.


## UI-06.2 — закрытие 2026-10-10

**ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**. [RESULT](UI_06_2_RESULT.md), [REVIEWS](UI_06_2_REVIEWS.md). Остатки/пополнение/премиксы: C02/C09/C14, семантические scoped стили, поиск с сохранением выбора, loading/error/retry и guards устаревших GET. 19 focused checks, 8 source QA, 35 UI061 regression, 13 unchanged business spans; 52 final JPG/JSON pairs, 3 GUI writes/3 GET/PG, 15 role reads/12 denied writes, 10 money journals unchanged. Унаследованный narrow shell и readonly quantity/initial-loading affordance долги сохранены явно. Локально без публикации. UI-07.1 — GPT-6.1 Sol / High — не начат.


## UI-07.1 — закрытие 2026-10-10

**ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**. [RESULT](UI_07_1_RESULT.md), [REVIEWS](UI_07_1_REVIEWS.md). Critical payment/refund/movement/purchase/guest shells, pending-close, native cancel/cleanup, captured context и partial mixed payment reconciliation; scoped semantic themes и44px controls. 36 source +3 event-order +20 frozen boundary PASS; 40 final IAB JPG/JSON pairs /160 exact bindings /4 served assets, actual keyboard/focus; real API/PG8checks,6readbacks,6write403 и final orders/items/payments equality. Суммы: paid500/remaining0, separate refund150; session-loss order2 paid100/remaining400; stock+10/+5/−5=10; guest100−50=50. Independent architect/finance/security/health/design/QA GO scoped.

Forced venue/order/individual permission changes проверены VM, actual session loss — browser/API/PG; полного Edge/WCAG/role×theme×state нет. Прежние idempotency/storage ограничения и narrow toast/debts документированы. Source/dist4 совпадают; CSS вне C11/C12 точно равен intake. Own IAB закрыт,viewport reset; own31967/31968 stopped, existing fixturePG31954 retained; старые preview/backend отсутствовали после reboot. GitHub/VPS не опубликованы, WIP сохранён. **STOP перед UI-07.2 «Финансовые страницы и отчёты», GPT-6.1 Sol / Medium**.


## UI-07.2 — закрытие 2026-10-10

**ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**. [RESULT](UI_07_2_RESULT.md), [REVIEWS](UI_07_2_REVIEWS.md). Scoped semantic finance/report/category/payroll, loading/error/retry/stale protection, keyboard cancellation. 11 focused suites,12 QA conservation,42 final pairs; real API/PG,16 denied actions403,12 journals unchanged. Protected7/source outside finance/CSS outside block unchanged; source/dist exact. Own31969/31970 stopped,IAB closed/viewport reset,PG31954 retained. Full role×theme×state/Edge/WCAG/Fold and recorded GUI cancel PATCH response not claimed. No commit/GitHub/VPS. STOP UI081 — GPT-6.1 Sol / High;15/22 closed,6 remain before publication plus separate Fold.


## UI-08.1 — закрытие 2026-10-10

**ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**. [RESULT](UI_08_1_RESULT.md), [REVIEWS](UI_08_1_REVIEWS.md). 14admin hashes, scoped semantic themes/C11roles/read states; staff3views/5columns/scale retained.9/10focused (inherited CRLF harness FAIL),22VM,12QA,69final current pairs/84historical functional pairs;3GUIwrites/API/PG,16denials403,employee restored,12journals unchanged. Protected8/source boundaries/CSS outside block exact,source/dist equal. Own31971/31972 stopped,IAB closed/viewport reset,PG31954 retained. No commit/GitHub/VPS. STOP UI082 — GPT-6.1 Sol / High;16/22closed,5remain beforepublication plus separateFold. QA formalfile historic; finalfeedback and coordinatorclosure explicit.


## UI-08.2 — закрытие 2026-10-10

**ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**. [RESULT](UI_08_2_RESULT.md), [REVIEWS](UI_08_2_REVIEWS.md). Сеть/интеграции/вход/отдельная платформа: семантические темы, pending/reset/error/retry и guards поздних ответов. 7/7 focused,18 VM,23 scope guards;46 current JPEG/JSON пар и53 historical functional. 49 isolated API/PG checks,3 GUI PATCH по одному/3 GET/PG,12 journals unchanged. Auth/server/DB/role spans сохранены; source/dist/HTTP6+alias exact. Own31973/31974 stopped,IAB9/10 closed,viewport reset,themes dark restored,PG31954 retained. No commit/GitHub/VPS. STOP UI083 — GPT-6 Luna / Medium;17/22 закрыты,4 до публикации плюс Fold отдельно.
