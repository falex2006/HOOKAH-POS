# FIX-05 — результат ремонта QA

Текущий итог после FIX-05.4: static 138/138 PASS; полный paid-order-balance PostgreSQL и reservation-prepayment PostgreSQL PASS с очисткой временных БД. Дефект группового snapshot устранён. Memory 23/23 — подтверждённый результат FIX-05.3. Полная браузерная приёмка остаётся FIX-06; ниже сохранена история этапов.

Обновление: дефект изоляции уведомлений ниже исправлен в FIX-05.1; memory и PostgreSQL notification suites теперь PASS. См. `FIX_05_1_RESULT.md`. Числа полного прогона ниже сохранены как исторические результаты FIX-05.

Обновление FIX-05.2: legacy gross/net исправлены, полный `reservation-prepayment-postgres-qa.mjs` и cleanup теперь PASS. См. `FIX_05_2_RESULT.md`. Дополнительная проверка `paid-order-balance-postgres-qa.mjs` выявила отдельную ошибку cleanup, её функциональный итог не подтверждён.

Дата: 08.10.2026. Область: тестовые сценарии и их guarded runner; продуктовый код не менялся, публикации не было.

## Результат по группам

| Группа | Результат |
|---|---|
| QA-A: fixtures реальных столов | `order-delete`, `paid-order-balance-memory`, `recipe-depletion-runtime` (95 проверок) проходят. `notifications-api` доходит до сохранённой проверки межплощадочной изоляции и падает: после выбора второй точки API продолжает возвращать событие первой. Это дефект сессии/изоляции продукта, а не fixture. Assertion сохранён. |
| QA-B: DOM mocks | `inventory-stock-status` проверяет `#stock-visible-count` для полного и фильтрованного списка, сохраняя zero/min/enough; `local-navigation-state` проверяет `dataset`, `getAttribute`, `staffRoute` и fallback. Оба проходят; navigation suite — 52 случая. |
| QA-C: lifecycle | `visual-page-rules-contract.mjs` проверяет актуальный переход, заголовок, контент и scroll; проверки reduced motion и запрета лишней анимации сохранены. PASS. |
| QA-D: cache revision | `local-design-contract.mjs` PASS: source/dist bootstrap и маршруты проверены, каноническая ревизия portal — 474. |
| QA-E: смена | `role-api-matrix-runtime-qa.mjs` PASS: точный whitelist восьми полей, текущая открытая смена, скрытие expected cash при legacy неопределённости, запрет роли без shift scopes, отсутствие закрытой истории и реальная вторая точка. |
| QA-F: PostgreSQL cleanup | `staff-identity` PASS (134 assertions), `audit-privacy` PASS; guarded runner удалил одноразовые базы и проверил их отсутствие. `reservation-prepayment` теперь также очищает базу через runner, но сохраняет функциональный FAIL по legacy-выручке (см. ниже). |

## Обнаруженные продуктовые дефекты

1. В `notifications-api-qa.mjs`: после переключения на вторую точку в памяти выбранный venue не сохраняется в токене сессии. Следующий запрос восстанавливает старый `req.user.venueId`; события первой точки видны во второй. Межплощадочная assertion сохранена. Требуется отдельная продуктовая задача по session venue isolation.
2. В `reservation-prepayment-postgres-qa.mjs`: legacy-заказ на 500 ₽ с NULL canonical pricing fields и без pricing snapshot увеличивает число продаж и число неснапшоченных заказов, но не прибавляет 500 ₽ к `periodBusiness.sales.gross`. Ошибка очистки больше не маскирует этот функциональный результат. Требуется отдельная задача по отчёту legacy-продаж.

## Полные штатные режимы

- `node scripts/local-full-qa.mjs --static`: остановился на первой ошибке; **17 PASS / 1 FAIL из 18 выполненных**, `dashboard-overnight-employee-demo-qa.mjs` падает с `ReferenceError: hasPortalPermission is not defined`. Это вне файлов FIX-05.
- `node scripts/local-full-qa.mjs --memory`: **9 PASS / 1 FAIL из 10 выполненных**; штатно остановился на `notifications-api-qa.mjs` и воспроизвёл дефект изоляции выше.
- `node scripts/local-full-pg-regression.cjs staff-identity-postgres-qa.mjs`: 134 assertions PASS, owned DB drop PASS.
- `node scripts/local-full-pg-regression.cjs audit-privacy-postgres-qa.mjs`: PASS, owned DB drop PASS.
- `node scripts/local-full-pg-regression.cjs reservation-prepayment-postgres-qa.mjs`: функциональный FAIL по legacy gross, owned DB drop PASS.
- `node scripts/local-full-pg-regression.cjs --check-guards`: 42 защитных проверки PASS.

Static и memory runner останавливаются при первой ошибке, поэтому следующие suites после точки остановки в этих двух режимах не заявляются как выполненные. `--all` не запускался: он включает браузерные и мобильные сценарии вне автоматического контура.

## Проверки изменений

Точечные suites QA-A…F запускались, кроме двух случаев с сохранёнными продуктовым FAIL; QA-C, QA-D, QA-E и cleanup своих одноразовых PostgreSQL баз подтверждены. `node --check` изменённых сценариев и `git diff --check` пройдены. Проверка окружения/БД выполнялась только через guarded runner. Изменения продукта, миграций, данных рабочих баз и публикации отсутствуют.

FIX-05 завершает ремонт тестовой обвязки по подтверждённым случаям, но общий PASS невозможен до устранения двух выявленных функциональных дефектов и постороннего baseline-падения static suite.

## Обновление FIX-05.3

Оставшиеся тестовые mocks и устаревшие контракты обновлены: штатный static набор теперь **137/137 PASS**, memory — **23/23 PASS**. Guarded `paid-order-balance-postgres-qa.mjs` теперь проходит собственную очистку disposable DB и доходит до функциональной проверки. Она подтверждает отдельный продуктовый дефект: group-specific скидочный snapshot после закрытия заказа становится `0/0`. Подробности и изменённые harness приведены в `FIX_05_3_RESULT.md`. Поэтому FIX-05 закрывает оставшиеся QA harness сбои, но не заявляет полный общий PASS для PostgreSQL/product behavior.
