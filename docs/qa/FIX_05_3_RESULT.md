# FIX-05.3 — оставшиеся тесты

Дата: 08.10.2026. Область: тестовые harness, контракты и guarded runner. Продуктовый код не менялся.

Обновление FIX-05.4: описанный ниже дефект group snapshot исправлен. Полный paid-order PostgreSQL suite и cleanup теперь PASS; API-проверки groupDiscountBase/Amount восстановлены. Причиной были SQL NULL (которые Number преобразовывал в 0), а не сохранённые числовые нули. См. `FIX_05_4_RESULT.md`. Ниже сохранён исторический результат FIX-05.3.

## Что исправлено

- Static runners прокидывают `hasPortalPermission` в извлечённые из `portal.js` ветви и тестируют его через ту же permission-набор-модель.
- Обновлены устаревшие ожидания в контрактах сессии, PIN-return и гостевой страницы под текущий серверный permission resolver и клиентский guard.
- Дополнены DOM-заглушки формы товара, включая создание селекта направления приготовления.
- Уточнены контексты для shift-state, tobacco-catalog, API fail-closed и employee-report QA; сами проверки доступа и отказа при ошибках сохранены.
- Guarded PostgreSQL runner для paid-order-balance теперь отделяет функциональную ошибку от cleanup, проверяет свою одноразовую БД и сообщает об успешном удалении после завершения дочернего процесса. Проверка ответа использует существующее поле `discountTotal`; отдельная сверка group-specific полей остаётся на сохранённом снимке в БД.

## Проверки

- `node scripts/local-full-qa.mjs --static` — **137/137 PASS**.
- `node scripts/local-full-qa.mjs --memory` — **23/23 PASS**.
- `node scripts/local-full-pg-regression.cjs paid-order-balance-postgres-qa.mjs` — функциональный **FAIL**, cleanup **PASS**. Guarded runner удалил созданную им БД `orders_qa_5357017c57607961` и подтвердил её отсутствие.
- Все изменённые точечные QA, включая role contract, product form, reservation form, shift-state, staff guests, tobacco catalog, trusted PIN return, API read failure и employee report, проходят.
- `git diff --check` — PASS.

## Оставшийся продуктовый дефект

PostgreSQL-сценарий создаёт заказ с групповой скидкой 10% от базы 200 ₽. После полного закрытия сохранённые `group_discount_base` и `group_discount_amount` оказываются `0/0`, хотя общий `discountTotal` ответа равен 20 ₽. В ответе закрытия нет поля `groupDiscountAmount`; поэтому тест сверяет публичное поле `discountTotal`, а отдельная assertion читает group-specific снимок из БД. Она сохранена и падает на фактическом перезаписывании snapshot. Это не ошибка fixture и не дефект тестового runner. Исправление относится к отдельной задаче продуктового кода; в FIX-05.3 оно не вносилось.

Проверка в полном PG-suite намеренно остаётся красной до исправления снимка групповой скидки. Остальные результаты не объявляются полным PostgreSQL PASS.

## Границы

Изменялись только QA scripts, guarded runner и документация результата. Не выполнялись коммит, публикация, production deployment или изменения рабочих данных.
