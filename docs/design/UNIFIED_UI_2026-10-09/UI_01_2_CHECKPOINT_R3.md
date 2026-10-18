# UI-01.2 — контрольный срез R3

2026-10-09. Статус **IN_PROGRESS / NOT ACCEPTED**. Текущий блокер: достоверная съёмка прокрученных финансовых регионов в Edge. Продуктовый код и dist не изменялись; публикации GitHub/VPS не было.

## Собрано

Индекс содержит **588 уникальных matrix JPG/JSON** и 11 дополнительных кадров заказа. Все 6 480 исходных сценариев сохранены: 578 CAPTURED_PENDING_REVIEW, 6 SUPPORTED_THEME_DEFECT, 1 CAPTURE_REJECTED_THEME, 2 CAPTURE_REJECTED_RASTER, 1 CAPTURE_REJECTED_FOCUS, 1 608 N_A_DENIED_BUSINESS_REGION, 4 284 PENDING_CAPTURE. Общий PASS — 0. N/A относится только к четырём бизнес-состояниям 67 подтверждённых пар роль/маршрут; baseline и keyboard не исключены.

Собраны разрешённые baseline экраны управляющего: по 29 маршрутов dark/light на 1366×768 и 1920×1080. Пять standalone отказов на фиксированных размерах остаются неснятыми из-за screenshot timeout. Для бармена дополнительно собраны 11 разрешённых маршрутов 1920×1080 light. Эти новые кадры проходят отдельный визуальный review; количество файлов не является приёмкой.

Управляющий /admin#company: форма показана, но правило заведения не загружается, отображается ошибка. Этот исход не классифицируется как полный отказ в доступе. Светлая тема рабочего зала бармена остаётся тёмной.

## Локальные финансовые примеры

Независимый code_health_engineer дал GO_APPLY_SAMPLES после проверки exact GET/query, исходного HTTP200, свежей настоящей session/role/tenant/permissions и immutable hashes. Координатор исправил candidate P2: журнал provenance записывается до замены ответа, отказ записи сохраняет исходные bytes/headers/status; fallback logging best effort. 31 проверка sample-validator и success/failure mock журнала — PASS. Проверки не подтверждают финансовый lifecycle.

Активированы только внешние ignored proxy/controller на локальном стенде 127.0.0.1:31952. Samples — три нулевые строки расходов, три отменённые строки зарплаты и три отменённых записи истории; POST/PATCH/DELETE не подменяются, операции с этими entities не выполнялись. Настоящий API расходов и зарплаты вернул200, UI получил по3 длинные строки. История заказов в браузере на этом срезе не проверена. [Provenance](evidence/UI-01.2/r2/sample-provenance-r3.ndjson) содержит контекст без tokens/cookies/passwords, persistenceValidated=false/actionsValidated=false. См. [план](UI_01_2_SAMPLE_PLAN_R3.md).

## R3-E06 — блокер качества снимка

Два owner1920dark long-content кадра finance/payroll отклонены по текущим SHA в [review-decisions](evidence/UI-01.2/r2/review-decisions.json). На bitmap запрошенный журнал не виден. При зарплатном capture измерено main.scrollTop 981.6 → 142.4, register.top 622.6 → 1461.8; document.scrollTop при этом0. Повторный вход, reset viewport и новая локальная вкладка не дали достоверного кадра: native screenshot новой вкладки показывает верх страницы при DOM register.top461.7. [Witness](evidence/UI-01.2/r2/r3-e06-native-witness.json), [bitmap](evidence/UI-01.2/r2/r3-e06-native-witness.jpg). Причина в продукте или браузерном инструменте не установлена.

V6 consistent сравнивал только document scroll, поэтому не замечал изменения вложенного main. Подготовлен ignored browser-evidence-v7.mjs: before/after nestedScroll входит в consistent. Старые кадры не объявляются принятыми задним числом. Детектор не устраняет расхождение paint/DOM; нужна достоверная повторная съёмка поддерживаемым инструментом.

## Сохранение состояния

Proxy возвращён в **normal**, targets/samples пусты, /api/health — ok. Viewport override сброшен. Проверены 215 файлов root и runtime mirror: SHA несовпадений0. Пользовательские production вкладки и данные не трогались. Локальные fixtures и evidence сохранены для продолжения.

Остаток: fixed viewports остальных ролей, empty tenant, состояния доступных регионов, формы/диалоги/keyboard, long history/stock/finance регионы и независимая итоговая приёмка. Для продолжения визуального acceptance требуется восстановить соответствие screenshots реальному прокрученному экрану; менять продукт ради обхода сборщика не допускается.

## R3-E07 — неверно заявленная тема одного кадра

Независимый design review подтвердил manager clients1920light: bitmap тёмный, metrics/after.theme dark при meta.theme light. Current SHA исключён как CAPTURE_REJECTED_THEME; причина ошибки подготовки или продукта не установлена. Остальные27 manager1920light baseline имеют metrics light, floor — staff-theme. Это не доказательство визуальной приёмки остальных кадров. Processor сохраняет current-hash gate и integrity priority; всего четыре rejected slots с учётом старого focus и двух R3-E06.
