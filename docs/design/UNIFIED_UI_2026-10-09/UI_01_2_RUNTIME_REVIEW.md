# UI-01.2 — независимая сверка runtime evidence и маршрутного контракта

2026-10-09 · `qa_engineer` + область `system_architect`. Read-only review сохранённых JSON/JPG и относящихся исходников; браузерные действия, HTTP-запросы, продуктовые тесты и изменения продукта этим исполнителем не выполнялись. CSV, PROGRESS и WORK_LOG не редактировались. Это проверка доказательств координатора, не самостоятельный полный runtime PASS.

## Основание и время среза

Принятые [ROUTE_ROLE_MATRIX.md](ROUTE_ROLE_MATRIX.md), [COMPONENT_CATALOG.md](COMPONENT_CATALOG.md), EX-07 из [EXCEPTIONS.md](EXCEPTIONS.md). Прочитаны локальные `portal.js` (`setInventoryView`, `focusedAdminDashboardHash`, `renderDashboard`, `dashboardHashChangeHandler`, `applySettingsView`, notification handlers), `login.js`, `platform.js`, auth/surface HTML. Происхождение грязного дерева описано в [UI_01_2_COVERAGE_PLAN.md](UI_01_2_COVERAGE_PLAN.md): HEAD `802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf`, remote-tracking `origin/main` `2e6f557934fe29a9a227dda73277f6c3f99af939`; равенство served source с SHA этим review не установлено.

Evidence: [evidence/UI-01.2](evidence/UI-01.2/), локальный origin `http://127.0.0.1:31952`. Каталог дополнялся и переснимался во время чтения. В срезе **08:09:14 UTC** было 68 индивидуальных JSON: только owner/dark/baseline по именам, 35 для 1366×768, 16 для 1920×1080 и 17 actual. Это промежуточный счёт, не окончательный manifest и не оценка всех 6 480 ячеек. Наблюдения ниже относятся к указанным версиям файлов; координатор должен пересверить заменённые снимки перед присвоением исхода CSV.

В последующем чтении `captures.json` содержал 151 entry и 47 групп повторных `key`. Пересъёмка с тем же именем не создаёт независимое доказательство: текущий JSON/JPG представляет последнюю записанную версию, а прежний manifest entry может описывать другую. Для итоговой интеграции выбрать актуальную запись на key, проверить соответствие файла и размеров либо явно сохранить историю версий с уникальными именами/временем.

## Авторизация: что уже доказано, что ещё нужно

`tmp/ui012-baseline/authentication-checks.json` от 07:53:50 UTC показывает девять loginStatus 200: platform_owner отдельно без tenant venue; owner/manager/hookah_master/bartender в long и empty fixtures с двумя разными venue IDs. Ответы `/api/session` возвращают ожидаемые базовые роли; unauthenticatedSessionStatus = 401; health.database = postgres. Секреты в прочитанном файле не напечатаны.

Эти результаты подтверждают возможность логина и различие auth/tenant fixtures. Они не содержат эффективного массива permissions/overrides и не доказывают page/action gates каждой роли. До принятия default RBAC нужна обезличенная связь реальной браузерной сессии с role/permissions/venue. LoginStatus 200 другой роли не переносится на owner screenshot. Нет доказательства deny для четырёх остальных ролей в рассмотренном промежуточном owner-срезе.

## Final URL и отображённая поверхность

В индивидуальных JSON фактический адрес хранится в **`metrics.url`**, а requested route — в `meta.route`. Поле верхнего уровня `finalUrl` отсутствует; нельзя извлечь из него пустоту и объявить redirect. Заголовок и snapshot должны соответствовать URL, а не только имени файла.

| Requested route / evidence | Наблюдение и сверка исходника | Вывод для интеграции |
|---|---|---|
| `/inventory?view=stock` → `metrics.url` `/inventory` | `setInventoryView` выбирает неизвестное/пустое view как stock и **явно удаляет `view` только для stock**. Snapshot/заголовок «Остатки» | Ожидаемая нормализация default view. Это не auth redirect, deny или потеря маршрута. Сохранять отдельные case IDs `/inventory` и stock, допустима общая ссылка при объяснении нормализации |
| Шесть остальных `/inventory?view=…` | products/recipes/auto-orders/movements/premixes/directories в прочитанных JSON сохраняют свой query и предметные заголовки | URL+region подтверждают выбор view, но не заполненные данные, разрешённую запись или все внутренние вкладки |
| `/inventory` и stock actual | Actual snapshot: «Позиций пока нет», «Добавьте первую складскую позицию»; heading «Позиции 0» | Settled **empty stock**, несмотря на long-account/company fixture. Длинное имя компании не доказывает long-content склада |
| `/finance#payroll` owner | URL сохраняет hash, headings «Зарплата», «Настройка зарплатных схем», «Зарплатный реестр» | Payroll поверхность создана для owner. Наличие DOM не доказывает расчёт/сохранение, manager finance-read или employee OWN_TODAY ограничения |
| `/admin#staff`, `#permissions`, `#tasks`, `#loyalty`, `#shift-control` owner | Адреса сохранены, snapshot/metrics показывают соответствующие предметные заголовки | Hash по назначению распознан. Owner-only permissions не подтверждает отказ manager/staff |
| Settings family: `#settings`, `#company`, `#settings-dashboard-modules`, `#venue-layout-settings`, `#lock-security`, `#audit` | Исходник нормализует эти hashes в `dashboardFocus = settings`, затем `applySettingsView` выбирает секцию; generic h1 «Настройки CRM» допустим для сфокусированных подвидов | Принимать по целевому panel/heading/control, а не требовать новый HTTP route или название hash в h1. Проверять scroll position и доступность содержимого |
| `/admin#diagnostics` | Есть «Диагностика Telegram»/«Журнал действий» при общем «Обзор заведения» | Generic h1 сам по себе не означает route failure. Нужны доступность diagnostic region и соответствие правам фактической роли |
| `/admin#notifications` | Исходник вызывает `notification-bell.click()` через timeout; прочитанный snapshot содержит notification dialog | Это hash-triggered overlay, а не новая самостоятельная страница. Его data/API outcome отдельно от shell gate |
| `/admin#help` owner1366 dark | На просмотренном JPG видна «База знаний», **поверх неё открыт блок уведомлений**; snapshot содержит bell expanded и dialog «Уведомления», «Пока нет уведомлений» | Help route распознан, но clean baseline загрязнён дополнительным overlay. Переснять с закрытым overlay либо явно описать состояние help+notifications; не считать снимком свободного help workspace |

Неизвестные inventory views, внутренние movements documents/operations, staff cards/list/table scales, query tenant context и финансовые hashes сверх payroll этим чтением не принимаются автоматически. Это соседние проверки при наличии относящегося evidence, а не добавочные канонические страницы.

## Прямой goto, hash click и окна

Прямой goto `/admin#…` и click на hash в уже открытом `/admin` запускают разные последовательности bootstrap/hashchange. Источник `dashboardHashChangeHandler` сначала `disposeStaffDrawer`, затем повторно рендерит dashboard/tasks/loyalty и плавно скроллит нужную область. `#notifications` дополнительно кликает колокольчик; документальный URL сам по себе не удостоверяет, что окно открыто или закрыто.

Settings hashes выбирают встроенные panels через `applySettingsView`; это не обещание auto-open модального редактора. В частности, role/system-role editor создаётся обработчиком отдельной кнопки, а не присутствием `#permissions` в URL. Для C11 доказательства **открытого редактора** нужны явный opener/action, visible dialog, title, focus и return-focus после закрытия. Снимок direct goto hash доказывает лишь соответствующий раздел, пока не показано окно. Если click отличается от direct goto/reload, сохранить два сценария с последовательностью; не свести их к одному успешному URL.

Перенесённый notification overlay на help подтверждён визуально. Без истории действий причина может быть сохранённым состоянием страницы/повторным hash переходом или другой последовательностью сборщика; review не приписывает продукту неизученную первопричину. Владелец воспроизведения — координатор/QA; маршрутного решения — system_architect.

## Loading, empty, error, denied и скрытый PIN

Ранние owner1366 файлы были обозначены baseline, но метка файла не является проверкой ready. Просмотренный `owner__inventory-view-stock__1366x768__dark__baseline.jpg` содержал KPI «Загружаем данные склада…», тире и header «Проверяем смену…», тогда как отдельно прочитанный JSON/AX уже показывал «Позиции 0» и settled текст. Возможны разные моменты снятия/перезапись файлов; до согласованной ready-съёмки эта пара не подтверждает settled baseline. Loading можно сохранить как наблюдаемое начальное состояние, но без управляемого trigger оно не доказывает весь loading contract/retry.

Для четырёх 1920 dark поверхностей floor/orders/clients/reservations координатор передал settled подтверждение design review; это полезная независимая оценка, но не переносить её на весь owner batch, light, employee или API-ошибки. Пересъёмка с видимой fixture и AX ready должна использовать предметный регион: присутствие UI012 в профиле/шапке подтверждает личность, но не готовность inventory/payroll data.

| Классификация | Обязательное основание |
|---|---|
| Loading | Видимый pending конкретного региона; не выводить из нуля или отсутствующей строки |
| Empty / no-results | Settled пустой ответ/fixture и текст пустоты; no-results отдельно от пустой БД |
| Expected denied | Валидная сессия/permissions плюс отказ policy/403, без бизнес-данных; shell и action/API deny записываются отдельно |
| Auth failure | 401/отсутствующая или истёкшая сессия/login redirect по причине auth; не засчитывать как успешный deny |
| Service error | 5xx/timeout/ошибка зависимости/БД при валидной сессии; не считать empty или запретом роли |
| Route failure | 404/неверный target/hash/asset, не ожидаемая stock нормализация |

У большинства прочитанных AX snapshot присутствует PIN dialog «РАБОЧЕЕ МЕСТО ЗАБЛОКИРОВАНО»/«Вернитесь к работе». При этом `metrics.dialogs` пусто, а просмотренный settings JPG показывает обычный workspace **без PIN overlay**. Поэтому наличие текста в AX не доказывает фактическую блокировку экрана. Проверять видимость, DOM hidden/inert/ARIA/computed state и focus. Возможное попадание невидимого auth dialog в accessibility tree — отдельное наблюдение для C18, которое требует воспроизведения; оно не становится подтверждённым auth failure или действующим focus trap из одного snapshot.

## Viewport и темы

Actual измерен в текущих JSON: **1528×828 CSS px, DPR 1.25, cssZoom 1, browserZoom unknown**. Ранний manifest тоже показывал 1528×828/DPR1.25. Отсутствующий browser zoom оставить неизвестным; не считать DPR измерением zoom. Для заданных 1366/1920 сверять `metrics.viewport`, а не имя файла или размер JPEG.

В рассмотренном промежуточном срезе все имена dark. Это не подтверждает light ни одной роли. Ранний owner login actual manifest содержит `theme: ""` при dark в имени: filename/`meta.theme` может быть requested label, а не применённый режим. Для принятия темы нужны `metrics.theme`, вычисленные цвета/атрибуты и визуальная проверка.

По EX-07 login/PIN/platform сохраняют свои поверхности; общий двухтемный контракт CRM/POS не обещает новый toggle этим контурам. Отсутствие theme marker на login не даёт автоматически отметить light UNSUPPORTED: установить source/behavior отдельной поверхности и получить architect/design rationale. Platform loginStatus200 подтверждает сессию, не визуальную тему/размеры SaaS. Неполные light overrides CRM — defect поддерживаемой темы, не оправдание удалить её строки.

## Итог handoff

Подтверждено review: stock query normalization объяснена исходником; предметные inventory/admin/payroll регионы сопоставлены с фактическими URL; actual viewport установлен; auth fixtures имеют ожидаемые роли; выявлены границы metadata/ready и загрязнённый help overlay. Продуктовые изменения не требуются для самого review.

До интеграции координатору нужны согласованные последние JSON/JPG для settled снимков, устранение повторных manifest keys как счётчика независимых кейсов, permissions/session linkage, отдельное описание direct-goto vs clicked-open modal, clean help baseline, явные deny/auth/service исходы и evidence недостающих ролей/тем/состояний. CSV outcome принимается по конкретной текущей версии evidence; этот документ не поднимает общий статус UI-01.2 до PASS.
