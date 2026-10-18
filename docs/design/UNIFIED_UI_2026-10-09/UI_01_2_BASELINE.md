# UI-01.2 — частичная визуальная база

**Текущий отчёт: [R2 — связь Edge восстановлена](UI_01_2_BASELINE_R2.md).** Данные и блокер ниже относятся к R1; текущие статусы находятся в R2 manifest и общей матрице.

2026-10-09 · **Исторический срез R1: НЕ ПРИНЯТ, INCOMPLETE / BLOCKED_ENV_BROWSER.** После включения Amnesia VPN соединение восстановилось, идёт повторный сбор R2 в `evidence/UI-01.2/r2`; текущий прогресс — в PROGRESS.md. Следующий подэтап не запускать на основании этого отчёта.

## Результат

UI-01.1 принят. Для UI-01.2 создана изолированная среда с настоящей авторизацией и свежей PostgreSQL; подготовлены пять ролей и два разных tenant fixtures. Сохранены **72 уникальные пары JPG/JSON**, только `owner / dark / baseline` по запрошенным метаданным. Это частичный материал, а не 72 успешно принятых сценария. Имена файлов не доказывают состояние или тему.

Матрица [UI_01_2_COVERAGE.csv](UI_01_2_COVERAGE.csv) содержит **6 480 уникальных ячеек**: 36 поверхностей × 5 ролей × 3 размера × 2 темы × 6 состояний. 72 ячейки имеют `CAPTURED_NOT_ACCEPTED`, остальные 6 408 — `BLOCKED_ENV_BROWSER`. **PASS: 0.** У всех ячеек есть явный исход; запланированная неприменимость ещё не является принятым N/A. Число файлов не переносится на функциональное или визуальное покрытие.

Итоговый [captures.json](evidence/UI-01.2/captures.json) пересобран из последних индивидуальных файлов; повторные записи прежних попыток удалены из индекса. В нём указаны requested route, final URL, CSS viewport, реальные JPEG dimensions и SHA256 обеих частей доказательства. [UI_01_2_EVIDENCE_CHECK.json](UI_01_2_EVIDENCE_CHECK.json) фиксирует число ячеек, существование всех evidence links и проверку исходников.

## Среда

- Исходная база: dirty root на HEAD `802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf`. Прежние пользовательские изменения сохранены. Это не production, не dist и не весь upstream `2e6f557934fe29a9a227dda73277f6c3f99af939`.
- URL `http://127.0.0.1:31952`; data proxy 31952, backend 31953, PostgreSQL loopback 31954. Отдельный контейнер `hookah-ui012-20261009`, свежая БД `hookah_ui012`.
- `AUTH_REQUIRED=true`, `DEMO_MODE=false`. 215 runtime/assets/schema файлов скопированы без изменения байтов; .env, production secrets, существующие private runtime configs, .git и прежние БД исключены.
- [Source manifest](evidence/UI-01.2/source-hashes.json), созданный 07:40:44 UTC: каждый из 215 файлов повторно сверён с mirror и текущим root — расхождений 0. SHA256 самого исходного manifest: `0dd4016ba33f72d03d8e48f458d8825b7e3d85737e678d171c861531f8d7d548`.
- Девять временных аккаунтов: platform_owner и четыре рабочие роли в `long`/`empty` tenants. [Authentication checks](evidence/UI-01.2/authentication-checks.json): 9 login 200, ожидаемые session roles, unauthenticated session 401. Это подтверждение среды, не браузерных page/action gates остальных ролей. Effective permissions отдельно не зафиксированы.
- Long fixture: 8 столов, 12 товаров, 12 гостей и 12 задач с длинными именами/описаниями. Смены, заказы, платежи, payroll и проводки не создавались. Empty tenant изолирован, но в браузере не проверен. Отсутствие данных конкретного региона нельзя заменить названием `long` fixture.
- Data-only proxy умеет delayed loading / synthetic 503 / empty successful GET; auth и upstream 401/403 сохраняются. Во время снимков режим `normal`; искусственные ошибки и empty mode в браузере не прогнаны.
- Приватные credentials остаются только в игнорируемом `tmp/ui012-baseline`, в документы и evidence не копируются. Локальная инструкция запуска/сохранения/teardown — `tmp/ui012-baseline/ENVIRONMENT.md`.
- Независимый code health review обнаружил, что первоначально temp folder не был исключён из Git. Добавлен точечный локальный `/tmp/ui012-baseline/` в `.git/info/exclude`; повторный `git check-ignore` подтверждает оба private файла, `git status --short -- tmp/ui012-baseline` пуст. Эти файлы не staged и не committed. Разбор временных инструментов: [environment review](UI_01_2_ENVIRONMENT_REVIEW.md).

## Проверенные наблюдения и ограничения доказательств

Независимые роли `qa_engineer`, `system_architect`, `design_lead` применены через нативных исполнителей GPT-6.1 Sol / Medium. Переключение модели основного чата не утверждается. Их результаты: [runtime review](UI_01_2_RUNTIME_REVIEW.md), [visual review](UI_01_2_VISUAL_REVIEW.md), [coverage plan](UI_01_2_COVERAGE_PLAN.md).

Design lead фактически открыл все 72 JPG; его отдельная классификация каждого файла перенесена в `observed_class` CSV и `visualReviewClass` manifest. `OBSERVED_CONTENT` обозначает увиденное содержимое и не изменяет `CAPTURED_NOT_ACCEPTED` на PASS.

- D02: на просмотренных settled 1920 снимках floor sidebar 210 px, portal sidebar 280 px; верхняя панель 68 px. Длинные company/user/table labels сокращаются; в floor административная ссылка переносится. Это основание следующего этапа, не исправление.
- Просмотрены settled owner 1920 dark floor, orders, clients, reservations: 8 свободных столов, пустая preparation queue, 0 заказов, 12 карточек гостей, пустая бронь на выбранный день. Полный бизнес-путь заказа/оплаты этим не проверен.
- D17: микротекст в финансовой карточке замечен визуально; достоверная привязка computed typography к текущему raster требует пересъёмки. Контраст, реальный font face и browser zoom не приняты.
- 12 из 72 JPEG имеют размеры, отличающиеся от CSS viewport. Даже совпадение dimensions не доказывает масштаб 1:1: независимый просмотр выявил возможный кадр предыдущего viewport. Геометрия пока не пригодна как окончательная спецификация компонентов.
- Ранние кадры содержали loading/late paint. Некоторые admin hash кадры показывают предыдущий раздел, help — открытое уведомление. AX может включать скрытый PIN и скрытые controls; фильтр прямоугольников сам по себе не доказывает видимость. Не классифицировать это как реальный PIN lock или ожидаемый RBAC deny.
- Переход на `/login` очищает локальную сессию; ранняя batch получила login redirects. Пересъёмка выполнена частично после повторного входа. Нельзя принимать эти redirects как успешный отказ доступа владельцу.
- `/inventory?view=stock` → `/inventory` — ожидаемая нормализация stock view, подтверждена исходником. Остальные route/hash исходы требуют текущего settled screenshot и отдельного открытия редакторов кликом.
- Actual CSS viewport: 1528×828, DPR 1.25. При override наблюдался DPR примерно 1.0. CSS zoom 1 не является измерением browser zoom.

## Конкретный внешний блокер

Во время batch браузерный вызов превысил 60 секунд и сбросил REPL. Два повторных подключения известной локальной вкладки Edge затем не смогли загрузить browser request-header policy. Инвентаризация также вернула ошибку Edge и timeout загрузки Statsig. Получить актуальный DOM/screenshot, восстановить вкладку или продолжить UI через разрешённый инструмент не удалось. Другие способы управления браузером для обхода блокера не использовались.

Нужно восстановить соединение Edge с браузерным инструментом Codex. Повторного разрешения на локальную проверку не требуется. Изолированный стенд и фикстуры сохранены; proxy `normal`. Последние actual captures получены после `viewport.reset()`; финальную проверку viewport и закрытие тестовой вкладки выполнить не удалось. Production вкладки/сессии не изменялись.

## Точный остаток UI-01.2

1. Переснять owner с согласованными DOM/metrics/raster после положительного признака готовности каждой поверхности; удалить загрязнённые overlays, подтвердить font paint и реальный размер screenshot при каждой смене viewport. Проверить все 36 requested surfaces, включая public login и platform deny.
2. Выполнить браузерный вход и route/action gates под manager, hookah_master, bartender и platform_owner; зафиксировать effective permissions и tenant. Backend login 200 не заменяет эту проверку.
3. Проверить поддерживаемую light theme; для auth/platform оформить EX-07 с доказательством, а не автоматически исключать строки light.
4. Пройти actual/1366/1920 с правильной привязкой размеров; подтвердить keyboard/focus и скрытые PIN/dialog regions.
5. Получить empty/loading/error/long-content по реальным регионам каждого доступного экрана; для denied business content принять N/A только после доказанного отказа. Длинные заказы, таблицы payroll/финансов и складские движения ещё не подготовлены/проверены.
6. Снять editor/wizard/catalog/payment states через реальные действия в тестовом tenant; подобрать доказательства к 18 семействам компонентов и повторить независимую приёмку.

Продуктовые JS/CSS, dist, API и права этим этапом не менялись; продуктовые тесты не запускались. Проверены только документы/evidence и byte identity локального стенда. GitHub/VPS публикации не было. UI-02.1 не начат; рекомендуемая модель после принятия UI-01.2 — GPT-6.1 Sol / High. Сейчас продолжать именно UI-01.2, GPT-6.1 Sol / Medium.
