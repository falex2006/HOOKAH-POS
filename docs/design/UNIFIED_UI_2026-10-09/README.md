# Единый интерфейс HOOKAH POS

Аудит и план · основание9октября2026 · **UI-09.2: релизный пакет подготовлен с условиями выпуска. Следующий — отдельный UI-09.3. Fold исключён из текущего плана по команде пользователя 2026-10-11; в очереди 21 подэтап.**

## Главное

**Требование пользователя: без шаблонного «нейросетевого» дизайна.** Сдержанное оформление с характером HOOKAH POS, высокая читаемость и полезная плотность. Конкретные ограничения и критерии записаны в STANDARD.md и включены в каждое задание.

Разрозненность действительно есть. Причина — несколько поколений CSS, разные реализации одинаковых окон и противоречия в правилах оформления. Переделывать каждую страницу независимо будет дорого: общие ошибки вернутся. Предлагается сначала согласовать стандарт, затем общие компоненты, после этого переносить страницы небольшими законченными пакетами.

Сохраняем узнаваемый HOOKAH POS: Manrope, тёмные поверхности, красно-оранжевый акцент. Обе существующие темы — тёмная и светлая — входят в контракт; недостающие семантические токены светлой темы относятся к UI-02.1. Операционный экран сотрудника и управленческие страницы могут отличаться составом информации, но одинаковые кнопки, поля, окна и состояния должны работать одинаково.

## Что читать

1. [Аудит: проблемы, доказательства и охват](AUDIT.md).
2. [Стандарт внешнего вида и поведения и границы его принятия](STANDARD.md).
3. [План: этапы, зависимости и модели](PLAN.md).
4. [Готовые задания для каждого подэтапа](PROMPTS.md).
5. [Журнал выполнения](PROGRESS.md).
6. [Матрица маршрутов и ролей](ROUTE_ROLE_MATRIX.md), [каталог компонентов](COMPONENT_CATALOG.md) и [исключения](EXCEPTIONS.md).

## Как продолжать

Текущий этап — **UI-09.2, PREPARED_WITH_RELEASE_CONDITIONS**: [результат](../../release/UI_09_2/RESULT.md). Остался отдельный запуск UI-09.3 «GitHub и VPS», после выполнения условий выпуска и явной команды публикации. UI-10.1 Fold исключён из очереди; автоматически не возвращать его. Прошлые записи ниже сохраняют исторический контекст и не задают текущую очередь.

Для ограниченных правок по готовому образцу используется GPT-6 Luna / Medium; для общих компонентов и сложных взаимосвязей — GPT-6.1 Sol / High. Рекомендации конкретизированы в плане. Автоматическое переключение модели основного чата не предполагается.

## Границы текущего результата

Исторический AUDIT-00 исследовал исходники оформления, навигации и окон и включал ограниченный просмотр рабочего зала в Edge; остальные роли и экраны не были объявлены визуально проверенными. UI-01.1 выполняет документальную сверку исходников и контрактов. Он не повторяет браузерную приёмку и не переносит прежний PASS на новую редакцию. Визуальная база относится к UI-01.2, сквозная приёмка системы — к UI-09.1.

**AUDIT-00/UI-01.1 сохраняли только документы и снимок экрана.** Последующие принятые пакеты меняли локальные исходники и выполняли проверки на disposable данных. UI-04.2: 98 final пар / 294 source refs, 20 принятых API изменений / 7 final entities с отдельным readback; shared 640px fixed head/footer закрывает только геометрию EX-01. Финансовые обработчики, API/tenant/role контракты сохранены. GitHub/VPS не публиковались; cleanup собственного preview фиксируется координатором после выполнения. Narrow — ограниченная регрессия, full PIN — UI-04.3, мобильная адаптация/Fold — последний отдельный этап.


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


## UI-06.1 — закрытие 2026-10-10

**ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**: [RESULT](UI_06_1_RESULT.md), [REVIEWS](UI_06_1_REVIEWS.md). Три inventory представления,35source проверок,52финальные Edge пары,9GUI writes/9GET/PG,30roleGET/20write403,11journals0. Health/architect/QA scoped GO; унаследованный tobacco regex FAIL и editor/lifecycle/readonly-copy/theme/below-fold долг записаны. Исторические evidence не изменены. Локально, без публикации. Автоматическая очередь остановлена перед UI062 (GPT-6 Luna / Medium), UI062 не начат.


## UI-06.2 — закрытие 2026-10-10

**ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**. [RESULT](UI_06_2_RESULT.md), [REVIEWS](UI_06_2_REVIEWS.md). Остатки/пополнение/премиксы: C02/C09/C14, семантические scoped стили, поиск с сохранением выбора, loading/error/retry и guards устаревших GET. 19 focused checks, 8 source QA, 35 UI061 regression, 13 unchanged business spans; 52 final JPG/JSON pairs, 3 GUI writes/3 GET/PG, 15 role reads/12 denied writes, 10 money journals unchanged. Унаследованный narrow shell и readonly quantity/initial-loading affordance долги сохранены явно. Локально без публикации. UI-07.1 — GPT-6.1 Sol / High — не начат.


## UI-07.1 — закрытие 2026-10-10

**ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**. [RESULT](UI_07_1_RESULT.md), [REVIEWS](UI_07_1_REVIEWS.md). Critical payment/refund/movement/purchase/guest shells, pending-close, native cancel/cleanup, captured context и partial mixed payment reconciliation; scoped semantic themes и44px controls. 36 source +3 event-order +20 frozen boundary PASS; 40 final IAB JPG/JSON pairs /160 exact bindings /4 served assets, actual keyboard/focus; real API/PG8checks,6readbacks,6write403 и final orders/items/payments equality. Суммы: paid500/remaining0, separate refund150; session-loss order2 paid100/remaining400; stock+10/+5/−5=10; guest100−50=50. Independent architect/finance/security/health/design/QA GO scoped.

Forced venue/order/individual permission changes проверены VM, actual session loss — browser/API/PG; полного Edge/WCAG/role×theme×state нет. Прежние idempotency/storage ограничения и narrow toast/debts документированы. Source/dist4 совпадают; CSS вне C11/C12 точно равен intake. Own IAB закрыт,viewport reset; own31967/31968 stopped, existing fixturePG31954 retained; старые preview/backend отсутствовали после reboot. GitHub/VPS не опубликованы, WIP сохранён. **STOP перед UI-07.2 «Финансовые страницы и отчёты», GPT-6.1 Sol / Medium**.


## UI-07.2 — итог

[Результат](UI_07_2_RESULT.md), [независимые ревью](UI_07_2_REVIEWS.md). 15 из 22 подэтапов закрыты; до публикации остаётся 6, Fold отдельно. Локально, без GitHub/VPS. Следующий UI-08.1 — GPT-6.1 Sol / High.


## UI-08.1 — закрытие 2026-10-10

**ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**. [RESULT](UI_08_1_RESULT.md), [REVIEWS](UI_08_1_REVIEWS.md). 14admin hashes, scoped semantic themes/C11roles/read states; staff3views/5columns/scale retained.9/10focused (inherited CRLF harness FAIL),22VM,12QA,69final current pairs/84historical functional pairs;3GUIwrites/API/PG,16denials403,employee restored,12journals unchanged. Protected8/source boundaries/CSS outside block exact,source/dist equal. Own31971/31972 stopped,IAB closed/viewport reset,PG31954 retained. No commit/GitHub/VPS. STOP UI082 — GPT-6.1 Sol / High;16/22closed,5remain beforepublication plus separateFold. QA formalfile historic; finalfeedback and coordinatorclosure explicit.


## UI-08.2 — закрытие 2026-10-10

**ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**. [RESULT](UI_08_2_RESULT.md), [REVIEWS](UI_08_2_REVIEWS.md). Сеть/интеграции/вход/отдельная платформа: семантические темы, pending/reset/error/retry и guards поздних ответов. 7/7 focused,18 VM,23 scope guards;46 current JPEG/JSON пар и53 historical functional. 49 isolated API/PG checks,3 GUI PATCH по одному/3 GET/PG,12 journals unchanged. Auth/server/DB/role spans сохранены; source/dist/HTTP6+alias exact. Own31973/31974 stopped,IAB9/10 closed,viewport reset,themes dark restored,PG31954 retained. No commit/GitHub/VPS. STOP UI083 — GPT-6 Luna / Medium;17/22 закрыты,4 до публикации плюс Fold отдельно.
