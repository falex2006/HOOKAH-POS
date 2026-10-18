# UI-09.1 — Сквозная приёмка desktop

Дата: 2026-10-11. Координатор: GPT-6.1 Sol / High.

**ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT** — локальные исправления и перечисленные проверки приняты. Это не полный PASS декартовой route × role × state матрицы, не WCAG-сертификация и не разрешение production-релиза. Непроверенные клетки сохранены явно; новые блокирующие регрессии в выполненных проверках устранены. UI-09.2 автоматически не начат.

## Исходное состояние и границы

HEAD `802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf`; большой унаследованный dirty WIP сохранён. Изменения этапа сравнивались с неизменяемым `tmp/ui091/intake`, а не со всем diff от HEAD. UI-08.3 принят локально с зарегистрированным долгом.

Тестирование: отдельные localhost proxy31975/backend31976, PostgreSQL `hookah_ui012`31954, временные роли и выделенное тестовое заведение. Production-сессии, Edge пользователя, GitHub/VPS не изменялись. Пароли, private fixture JSON, сырые журналы сессий/БД не включены в архив доказательств.

## Исправления и первопричины

| Файлы | Причина | Минимальная правка |
| --- | --- | --- |
| style.css, dist/style.css | Несуществующий `--ui-font-caption` | Ссылка на существующий `--ui-font-helper`, 12px |
| те же CSS | Светлая тема наследовала светлый текст/тёмные поверхности в показателях смены | Парные semantic tokens для поля, карточек, сумм и подписей; геометрия сохранена |
| те же CSS | Нечитаемые заголовки остатков/пополнения, warning заказа и действие закрытия смены | Три scoped light-theme правила с semantic foreground/background/border |
| platform.js, dist/platform.js | Общая загрузка по кнопке «Повторить» не очищала сообщение ошибки предыдущего settings-refresh | Одна строка очистки `#settings-result` в начале общего load(); generation guard и API сохранены |
| scripts/ui-role-shell-contract.mjs, scripts/ui052-presentation-contract.mjs | Контракты прежних этапов захватывали поздние CSS-блоки | Границы соответствующих блоков с проверкой маркеров |
| scripts/ui091-desktop-readability-contract.mjs, scripts/ui091-platform-retry-qa.mjs | Нужна защита исправленных сценариев | Проверка source/dist, semantic pairs и выполнение реального load() из исходника с синтетическим GET error/retry |

Нет новых декоративных решений. Согласованный акцент показателей сохранён. Навигация, header, route registry, права, server.js, db.js, финансовые расчёты и idempotency не менялись. Семь защищённых source-модулей байт-в-байт равны intake; platform намеренно изменён одной строкой. Агрегатный patch приложен к [архиву](acceptance/ui091/health-final-intake.patch).

## Выполненные проверки

### Исходники и независимые ревью

- Baseline: 55/55 опубликованных HTML/JS/CSS пар равны, 14 syntax checks PASS. Из 13 старых contracts 8 PASS/5 FAIL на intake. Исправлены undefined token и два пересекающихся test scopes. Два старых UI051/UI052 frozen intake-hash guard оставлены историческими, без подгонки под нынешний WIP.
- Latest: readability, platform retry actual-source VM, semantic token, role shell, effects/cascade PASS; syntax и scoped/whole diff whitespace PASS. CSS и platform root/dist точны. Reverse apply агрегатного patch PASS.
- Актуальный UI071 financial DOM/API-stub QA: 36 PASS/0 FAIL; отдельно от browser/API/PG доказательств. Исторический выход UI071 восстановлен.
- Design/QA: 12 свежих кадров в полном разрешении +68 кадров в контактных листах; дополнительно исправленное пополнение запасов в полном разрешении. Контраст заголовка пополнения измерен CSSOM: 6.81:1. Это не общий WCAG PASS.
- Code health, architect и design/QA: scoped GO с явными границами. [Ревью](UI_09_1_REVIEWS.md).

### Роли, API и изоляция

13/13 реальных ролей успешно вошли и получили ожидаемые default permissions. 402 authenticated/anonymous GET: 390 role×endpoint, 8 чужих venue query, 3 чужих network query, 1 anonymous. Результат: 151×200, 250×403, 1×401; ноль расхождений с контрактом. Все 8 floor foreign-query ответов остаются своим tenant, чужие network venues не видны, чужие задачи не выданы. Architect проверил raw booleans и полноту, а не только поле status harness. Во время этого отдельного API-интервала все 12 журналов были неизменны.

Это проверка default roles и read endpoints, не полный security audit, object-ID/mutation/custom-permissions sweep. У платформенного владельца staff/audit возвращают разрешённый пустой200 — не ошибочно ожидаемый403.

### Браузер и сценарии

Архивный индекс: **1183 PNG/JSON пары**, включая переходные/исторические/отклонённые. Из них **700** имеют server-role assertion под **11 ролями**, ноль actor mismatch, все PNG hashes точны. 23 из этих кадров показывают загрузку и не приняты как ready. Ещё owner grid136 пар охватывает34surface×2desktop×2themes, но имеет отдельную provenance и прежние CSS SHA; его нельзя объявлять полным current-source role gate. Manager и platform_owner проверены отдельными реальными сессиями и целевыми кадрами; это не роль×все страницы матрица.

- Desktop1366×768/1920×1080 и две темы наблюдались; актуальный рабочий размер **598×764**: все34 доступные owner surfaces в обеих темах с server-role assertion. Разные старые viewport labels не переименованы: индекс хранит реальные width/height.
- Hookah_master: новый заказ на свободном UI051 Стол9 → одна позиция1200₽ → отправка → «Ожидает» → «В работе» → «Готово». Pending отключает действия; окно отправки закрывается. После reload статус/1200₽ сохраняются.
- PG: ровно один новый order и item quantity1/unit_price1200; отдельный order_item_execution hookah/ready с последовательными dispatched/started/ready timestamps. Все прежние orders и остальные11 financial/stock journal tables неизменны. Browser payment/refund/close не выполнялись. Immutable item.status=new ожидаем: приготовление хранится отдельно.
- Bartender: каталог свободного стола, Escape/cancel, возврат фокуса на «Новый заказ», без создания заказа.
- Platform_owner: оба desktop/две темы, empty search, искусственный GET503 → retry с8s задержкой → реальный ready. После исправления старое error status очищено. Создание компании только открыто/отменено: initial focus, Shift+Tab, Escape и возврат на trigger; новых компаний/учётных данных нет.
- Narrow390×844: owner floor/menu открыть/закрыть и отдельная платформа — только coarse smoke. Схема зала прокручивается, кнопки и столы доступны. На платформе узкая компоновка занимает лишь часть ширины; полного mobile/Fold PASS нет.

17 целевых пар и санитарные отчёты сохранены в [acceptance/ui091](acceptance/ui091/manifest.json). Полный локальный индекс сохраняет остальные пути в tmp; он не превращает все кадры в independent pixel-review. До/после платформы и порядок заказа сохранены отдельно.

## Неподтверждённое и долг

1. Полная route×role×state×theme×resolution приёмка **UNVERIFIED**. [coverage-matrix.json](acceptance/ui091/coverage-matrix.json) различает observations/access-only, denied N/A и непроверенные клетки. Нет полного independent pixel review700кадров; светлая схема всех service/senior roles и все текущие размеры/состояния для каждой роли не покрыты.
2. Edge пользователя не проверялся; evidence из IAB. Полные WCAG/focus contrast/44px targets, OS reduced-motion, системные курсоры и coarse-pointer fallback не подтверждены этим браузерным проходом; source contracts не заменяют их.
3. Историческое «обрезание» заголовка staff/stock не воспроизвелось после свежего запуска; header patch не внесён. Есть legacy hash-target scroll в середину layout map, долг light POS inactive navigation/admin-return, compact9px/650–750 typography, readonly quantity inputs, delayed initial affordances. Владельцы: frontend/design/system_architect; исправлять отдельным bounded diff с fresh pixels.
4. Старые ограничения: native validation bubble snapshots (две ранее разрешённые оговорки UI012), PIN/full financial browser matrix, delivery detached GET, movement ambiguous retry/idempotency, tab-memory refund/payment intents. Не закрыты нынешним VM/API sweep.
5. Старые security/backend findings из designqa-baseline (other-target PIN, lock preference non-OK, audit CSV escaping) передать владельцам перед release decision; не объявлены исправленными или повторно подтверждёнными.
6. Ранние `role-*` кадры отклонены как actor-unverified после обнаружения гонки QA helper при logout/login. Исправленный harness проверяет server session на каждой странице; logout/login разделены. Не доказана product role-switch regression.

## Завершение и следующий шаг

Изолированный test order сохранён для readback; тестовые темы12 tenant roles и платформы возвращены в dark. Временный viewport сброшен, собственная IAB вкладка и процессы31975/31976 закрыты; PG31954 сохранён. Унаследованный WIP сохранён, commit/push/deploy отсутствуют.

Далее **UI-09.2 «Подготовка релизного пакета», GPT-6.1 Sol / High**: собрать конкретный пакет, проверить применимость известных долгов/непроверенных клеток к release gate. Этот отчёт разрешает scoped handoff, а не публикацию. Fold отдельно UI-10.1.
