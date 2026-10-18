# Аудит 08.10.2026: исходные проверки

Роль: qa_engineer / code_health_engineer. Проверки выполнены на текущем локальном checkout, Node.js v24.21.0. Продуктовый код не изменялся. Использованы только режимы static и memory существующего runner; PostgreSQL и браузерные suites не запускались. Локальный сервер 31932 не останавливался.

| Команда | Фактический результат |
| --- | --- |
| `node scripts/local-full-qa.mjs --static` | FAIL, exit 1: 48 PASS из 49 запущенных suites, включая 2 guard; остановка на `inventory-stock-status-qa.mjs` |
| `node scripts/local-full-qa.mjs --memory` | FAIL, exit 1: 9 PASS из 10 запущенных suites, включая 2 guard; остановка на `notifications-api-qa.mjs` |

Runner останавливается на первой ошибке. Оставшиеся проверки обоих режимов НЕ ВЫПОЛНЕНЫ; эти числа не являются результатом полного аудита. Общий `tmp/full-local-qa/local-full-results.json` перезаписывается последним запуском, поэтому результаты обоих запусков зафиксированы здесь отдельно.

## BASELINE-01 — устаревший DOM mock складской проверки

Приоритет P2, владелец code_health_engineer. В `scripts/inventory-stock-status-qa.mjs:11` mock возвращает элемент только для `#inventory-rows`. Текущий извлечённый renderer также записывает `textContent` в `#stock-visible-count`; mock возвращает null, и тест падает до проверок статусов остатков. Это подтверждённый дефект тестовой обвязки, не подтверждение дефекта интерфейса. Минимальная последующая правка: добавить реальный mock счётчика и проверить его содержимое, сохранив текущие проверки нулевого/порогового/достаточного остатка.

Доказательство: `tmp/full-local-qa/local-full-static-inventory-stock-status-qa.mjs.log`, `TypeError: Cannot set properties of null (setting 'textContent')`, строка вызова теста 17.

## BASELINE-02 — notifications fixture не проходит создание заказа

Приоритет P2 до уточнения причины, владелец QA совместно с backend. В `scripts/notifications-api-qa.mjs:52` создание заказа с `tableId: notification-qa-table` получает HTTP 409 вместо ожидаемого 201 (assertion строка 53). До этой точки прошли входы владельца/администратора/сотрудника, создание управляющего и scoped admin, отрицательные проверки доступа settings-only admin. Проверки самого события удаления и ленты уведомлений не достигнуты.

Доказательство: `tmp/full-local-qa/local-full-memory-notifications-api-qa.mjs.log`. Тело HTTP 409 существующая assertion не выводит, поэтому точная причина ответа пока не подтверждена. Следующий шаг: в отдельном QA пакете вывести безопасный код ошибки и согласовать fixture заказа с текущими требованиями стола/смены, затем повторить сценарий. Нельзя объявлять отказ дефектом notifications без этой диагностики.

## Ограничения и следующий шаг

- Эти результаты относятся к текущему запуску, исторические PASS от 01.10 не перенесены автоматически.
- Static suites включают VM/runtime извлечения исходников; это не визуальная проверка.
- Memory suites используют собственные локальные процессы без PostgreSQL и не подтверждают сохранение после перезапуска.
- После устранения ошибок тестовой обвязки нужно продолжить остановленные режимы, отдельно проверить роли на PostgreSQL и браузерную цепочку назначения/изменения прав сотрудника.

## Уточнение BASELINE-02 по исходникам

Повторное чтение подтвердило отсутствующую предпосылку: тест отправляет выдуманный `tableId: notification-qa-table`, но не создаёт такой стол. В текущем memory обработчике `server.js:5868` стол ищется в настоящей схеме зала, а строка 5869 возвращает HTTP 409 `table_not_found_or_unavailable` при отсутствии/архивации. Тестовую fixture нужно связать с существующим свободным столом либо создать отдельный стол через предусмотренный API. Удалять проверку существования стола в продукте нельзя. Это вывод по исходникам и фактическому HTTP 409; тело ответа первоначальный тест не сохранил.

## Дополнительные PostgreSQL проверки

По поручению координатора последовательно выполнены отдельные разрешённые nonbrowser suites через `scripts/local-full-pg-regression.cjs`. Wrapper проверяет disposable target и создаёт/очищает собственные тестовые базы. Браузер не запускался, постоянная QA база 31930 и сервер 31932 не затрагивались.

| Команда | Результат |
| --- | --- |
| `node scripts/local-full-pg-regression.cjs scoped-role-dependencies-postgres-qa.mjs` | PASS, exit 0 |
| `node scripts/local-full-pg-regression.cjs acceptance-47-pos-journey-postgres-qa.mjs` | PASS, exit 0; cleanup PASS |
| `node scripts/local-full-pg-regression.cjs recipe-sale-manual-movement-race-postgres-qa.mjs` | PASS, exit 0; cleanup PASS |

Это подтверждает текущие API/PG сценарии зависимости ограниченных ролей, POS journey и конкурентного списания рецепта/ручного движения в объёме существующих suites. Результаты не заменяют визуальную проверку Edge или полный аудит пользовательских ролей.

## Завершение оставшихся static/memory suites

По поручению координатора временный `tmp/full-local-qa/audit-remaining.cjs` продолжил точные allowlists после ранее зафиксированных остановок. Исходный runner и тесты не изменялись. Сохранены очистка унаследованных DB/auth переменных, `DATABASE_URL=''`, loopback, NODE_ENV=test, последовательный запуск и общий lock. Проверена принадлежность спискам static/memory и отсутствие прямых browser/PG launch в их исходниках. Уже выполненные suites и известные ошибки повторно не запускались. Continuation: 93 PASS / 100, 7 дополнительных FAIL.

Итог уникальных suites (guards отдельно): **static 130 PASS / 134; memory 16 PASS / 21. Всего 146 PASS / 155, 9 FAIL.** Обе guard suites прошли при первоначальных запусках. Таким образом первоначальное ограничение «оставшиеся suites не выполнены» снято для static/memory, но не для полного PostgreSQL/браузерного аудита.

| Дополнительный FAIL | Наблюдение |
| --- | --- |
| `local-design-contract.mjs:28` | Ожидание текущей cache version portal JS не совпало с admin.html; нужна сверка контрактной константы и фактических ссылок |
| `visual-page-rules-contract.mjs:35` | Regex контракта lifecycle смены секции не совпал с portal.js; визуальная неисправность этим не доказана |
| `local-navigation-state-qa.mjs:37` | Mock button не содержит dataset, текущий handler читает dataset.staffRoute; TypeError в обвязке |
| `order-delete-qa.mjs:30` | Создание заказа получает409 вместо201; fixture нужно согласовать с реальными столами |
| `paid-order-balance-memory-qa.mjs:30` | Создание заказа отклонено с `table_not_found_or_unavailable` |
| `recipe-depletion-runtime-qa.mjs:90` | Создание заказа отклонено с `table_not_found_or_unavailable` |
| `role-api-matrix-runtime-qa.mjs` | Нарушено ожидание `employee shift omits reconciliation fields`: DTO содержит cashPreviewAt, expectedCash, unresolvedLegacyCashAmount, unresolvedLegacyCashCount. Требуется решение владельца ролевого контракта: разрешены ли эти поля сотруднику или это утечка финансовой информации; нельзя автоматически ослаблять тест |

Точные результаты: `tmp/full-local-qa/audit-remaining-results.json`; отдельные sanitized логи `audit-remaining-<mode>-<suite>.log` в той же папке. Продуктовые изменения не выполнялись. Все перечисленные FAIL являются открытыми результатами аудита, PASS не подменяют разбор этих замечаний.

## Финальный read-only code health

- `npm audit --omit=dev --json`: exit 0, **0 известных vulnerabilities** (включая high/critical); dependencies total 46 по metadata npm. Обновления/установка зависимостей не выполнялись. Это результат advisory-базы npm на момент запроса, не доказательство отсутствия любых уязвимостей продукта.
- `git diff --check`: exit 0. Эта команда не проверяет содержимое новых untracked документов; отчёт отдельно просмотрен.
- Арифметика повторно сверена: 134 static + 21 memory = 155 уникальных suites; 4 static FAIL + 5 memory FAIL = 9; PASS 146. Guard suites и 3 дополнительные PG suites в эти 155 не включены.
- Уточнён `local-design-contract`: это реальное расхождение публикационного контракта, а не произвольное устаревшее ожидание теста. `scripts/sync-published-assets.mjs:9` задаёт portalRevision 464, а `admin.html:16` подключает portal.js?rev=470. Следующий запуск sync способен вернуть более старую ревизию URL. Владелец frontend/release должен согласовать единый источник cache revisions до публикации; текущий визуальный дефект этим не установлен.
- Ошибка role-api-matrix требует решения владельца ролевого/финансового контракта; её нельзя классифицировать как безусловно устаревший тест до проверки допустимости раскрытых полей сотруднику.
