# UI-05.2 — Гости, задачи, доставка и список броней

Дата: 10 октября 2026. Основание — прямой запрос пользователя и принятый UI-05.1. Рекомендация GPT-6 Luna / Medium не означает переключение модели.

**ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT.** Гости, задачи, доставка и список броней используют существующие C14/C15 primitives. Доставка открывается одной CTA в прикреплённой форме; список виден первым, черновик/фокус сохраняются, закрытие блокируется в pending. Для гостей разделены loading/error/empty/filter-empty и retry; generation/current-list/context guard исправляет воспроизведённую гонку старой ошибки. Светлые task headings/guest segment surfaces приведены к семантическим токенам с достаточной специфичностью.

PASS: 24 focused/syntax/evidence/API/diff команд, 2 exact mirrors, 18 actual-source presentation checks; 64 final JPG/JSON пар / 128 current-source bindings / 403 целей ≥44px. Desktop1366×768/1920×1080, actual560×764DPR1.25, narrow390×844, обе темы; owner/manager/worker и реальный denied сотрудник. 5 synthetic entities / 8 принятых API операций / 8 последующих real GET, PG tenant/fields/status и нулевые financial/stock journals подтверждены. Independent architect/health/design/QA GO scoped.

Empty final pixels — явно помеченные read-response fixtures после authenticated upstream200, БД не очищалась; actual first-empty DB pixels сохранены только diagnostic при прежнем SHA. Long — длинные строки гостя/задачи/адреса и две доставки, без заявления нагрузочной приёмки. Прежние/переходные кадры не перепривязаны. Fold/UI-10.1, финансовые редакторы/PIN полная повторная приёмка и legacy delivery detached read остаются вне scope. Задачи/доставка сохраняют прежний local theme boot; фактическая тема записана в каждой паре.

Own proxy31964/tab14 закрыты, viewport сброшен, fixture themes восстановлены; прежние preview/backend/Edge сохранены. GitHub/VPS публикации нет. Далее отдельный **UI-06.1 «Каталог, техкарты и справочники», GPT-6.1 Sol / Medium**; автоматически не запущен.

## Причина и изменения

- Редакторы и прежние стили затрудняли доступ к списку и основным действиям. Четыре list consumers получили общие headings, поля, buttons, badges, читаемые панели и перенос длинного текста. Поиск/фильтры доступны до длинной формы; task/delivery text search не добавлен.
- Delivery: одна «Новая доставка», прикреплённая скрываемая форма, один form DOM. Close button входит в исходный snapshot disabled controls; повторная отправка и закрытие при pending блокируются. Draft сохраняется после collapse/reopen; уведомление «Доставка создана» и исходный reset сохранены.
- Clients: unknown/loading/error не показывают фиктивные нулевые KPI; retry сохраняет выбранный период и фильтры. Воспроизведено loadA pending → loadB success → oldA rejection. Узкий общий generation и verified context guard игнорирует устаревшие success/error, включая period vs retry и detached/replaced list.
- Light task titles/column headings и guest group labels конфликтовали с более специфичными legacy styles. Финальная scoped поправка использует существующие --ui-*; новых декоративных эффектов нет.

## Контракты и границы

Изменены portal.js/style.css и точные dist mirrors; добавлены три focused scripts и этот пакет evidence/docs. API, server, app.js, lock.js и ui-dialog.js сохранены в байтах intake. Миграций БД и новых grant/route нет. Shared guest/task/reservation editor lifecycle, financial/loyalty/prepayment/refund/seat handlers заморожены boundary checker. Task manage gate tasks_manage || staff_manage сохранён; bartender видит только назначенную задачу, без create/edit/delete/cancel owner actions, статусы open/in_progress/done. Сотрудник только с finance_read получил настоящий отказ для этих разделов.

Сценарии GUI в disposable PostgreSQL: создание гостя, задачи, доставки, брони без предоплаты; delivery confirmed; bartender in_progress→done; второй delivery total0 для проверки задержанного сохранения. Success/reload/GET/PG привязаны отдельно от presentation fixtures. UI-05.1 три готовых заказа1450/1450/2450 и строки2/2/6 сохранены, финансово не закрывались.

## Проверки и доказательства

[Независимые ревью](UI_05_2_REVIEWS.md). [Acceptance manifest](evidence/UI-05.2/acceptance/manifest.json), [команды](evidence/UI-05.2/acceptance/final-checks.json), [API/PG proof](evidence/UI-05.2/acceptance/api-proof.json).

Каждая финальная пара содержит реальные permissions/session200/user/venue, неизменные before/after DOM, текущие portal/style SHA, SHA изображения и raster 1:1 viewport. Роли/темы не выводились из имени аккаунта. Проверены четыре ошибки чтения и их retry, loading, filter-empty, клавиатура на всех четырёх списках, attached delivery pending и draft retention. Переходный screenshot с ready DOM и loading raster исключён, выполнен native screenshot warm-up и новый сбор.

SHA256 portal: 912bfcca37674ae97fd48a2ca790a8da5147a2e11d83dff65e0c081bdd5d3efd; style: e445cf6d4ffd5161e6c33afdbf9af67e5bb2a5144746553e52a5423959df104a. HEAD intake802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf. Унаследованный WIP сохранён, staging/commit/publish не выполнялись.

## Ограничения и дальнейшие владельцы

- Task column empty copy и reservation search zero copy сохранены; полный набор пустых/ошибочных редакторов не перепринимался.
- Clients readonly race исправлен узко. Delivery detached/global DOM GET debt сохраняется; отдельная задача архитектора/frontend с двумя контекстами и late response.
- Tasks/delivery local theme boot требует отдельного согласования общего preference lifecycle; этот пакет подтверждает фактические две темы, не исправляет общую оболочку.
- Финансовые редакторы, prepayment/refund, seat/stock, полная PIN/mixed stack проверка и мобильный Fold не входят в UI-05.2. Узкая390px проверка не означает полную мобильную приёмку.
- Готовые отдельные header/toolbar/list factories отсутствуют: применены действующие C14 primitives и прежние region DOM. Универсальные factories вынесены как архитектурный вопрос до отдельной необходимости; новый component API не придуман.
