# FIX-03.1 — независимые проверки

08.10.2026. Продуктовый код данным агентом не изменялся. Созданы durable targeted тесты и обновлены только необходимые зависимости существующих QA mocks.

## Выполненные команды

- `node scripts/order-preparation-postgres-qa.cjs`: **PASS123 assertions**, cleanup PASS. Собственная случайная `audit_qa_*` БД на проверенном disposable PostgreSQL31931; отдельный auth API на случайном loopback порту; schema+миграции. Persistent31930/production не затрагивались.
- `node scripts/order-preparation-unit-qa.cjs`: **PASS19 cases** чистых helper-функций.
- `node scripts/order-preparation-ui-qa.mjs`: **PASS** исполнения фактического app preparation блока в Node VM, без браузера.
- Все12 связанных FIX-02 suites повторены, PASS; перечень в FIX_02_QA.md. Bootstrap asset assertion теперь сверяет canonical portalRevision из sync-script вместо фиксированного472; право/route assertions сохранены.
- Синтаксис order-preparation.js/server.js/db.js/app.js/portal.js — PASS; `git diff --check` выявил лишнюю пустую строку EOF server.js, передано координатору.

Первый запуск нового PG теста дошёл до оплаченного заказа и не нашёл его через open-only GET/orders. Исправлен только тестовый reader на `?scope=all`; следующий полный запуск PASS121. Первичная и повторная собственные БД очищены. Это ошибка harness, не продуктовый дефект.

## Что доказано

PG: product preparationStation roundtrip; смешанный заказ2бар+кальян; отправка/replay; частичная готовность; параллельное завершение разных станций; общий ready; новая строка возвращает in_progress; две роли повторно читают одинаковое состояние. Queue ограничена station, manager видит обе; чужая роль403, чужая точка404, expectedVenueId mismatch409, legacy общий status bypass409.

Неизвестная станция назначается первой отправкой; последующий конфликт409. Qty/delete отправленной строки409. Split до оплаты сохраняет item ID/execution; queue переносит orderId, старый URL подготовки404, оба aggregates актуальны.

Финансы/склад: dispatch/start/частичная оплата не создают списаний; partial pricing snapshot не изменяется; финальная оплата создаёт ровно1 out-движение. Оплаченный незавершённый заказ остаётся в queue; последующий ready не меняет closed, payments или stock. Closed dispatch409, cancelled отсутствует в queue и не готовится; отзыв orders в текущем токене даёт403.

Unit19: агрегат new/queued/progress/ready, сохранение closed/cancelled, mixed station selection, unknown queued assignment, invalid/duplicate/missing IDs, неверная станция, переходы/replay/stale expectedStatus.

UI VM: singleflight queue; старый ответ после смены прав отброшен; отправляются только выбранные IDs; позиции другой станции исключены, неизвестная queued не отмечена автоматически; изменение прав во время модального выбора предотвращает отправку.

## Review и границы

Отдельная execution table сохраняет финансовую immutable модель. Parent order locking согласован с оплатой/изменением строк; готовность оплаченного заказа не переводит финансовый статус обратно. UI использует FormData: unchecked поля отсутствуют, поэтому выбранные IDs через Object.hasOwn соответствуют фактическому контракту формы.

Браузерную приёмку проводит координатор отдельно через CUA. Данный отчёт не объявляет её выполненной. Полная регрессия проекта и все сочетания migration/legacy данных не запускались. Новые тесты не заменяют существующую широкую recipe-depletion suite; stock continuity здесь проверена на одном реальном tracked рецепте10мл. Окончательный выпуск требует проектного workflow.

Дополнительно после найденного координатором Edge дефекта seller name обновлён DTO: PG asserts проверяют salesEmployeeName в dispatch/progress response. Повтор123 PASS с cleanup PASS. UI VM проверяет expectedVenueId в payload. Первоначальный PASS121 сохранён как промежуточный, окончательный результат123.

## Дополнительные UI замечания, переданные координатору

Браузерная приёмка ещё не завершена: координатор обнаружил перекрытие очереди абсолютными элементами зала, frontend исправляет layout. При source review найдены активный minus у уже отправленной позиции и generic409 сообщение; plus корректно создаёт новую строку, но локальный aggregate статуса ready не обновляется немедленно. Эти замечания переданы владельцу frontend; данный документ не объявляет их исправленными до повторной проверки.

Последующее обновление: координатор сообщил Edge PASS раздельной работы бармена/кальянщика, start/ready, reload, агрегата и plus после ready. Source review подтвердил guard minus с понятным объяснением и refresh loadOrders после plus. Повтор preparation UI VM, staff effective/session recovery/catalog PASS; syntax/diff PASS. Header suite временно остановлена только source/dist CSS parity во время последней правки overflow; ожидается синхронизация и повтор. Точные окончательные browser доказательства оформляет координатор отдельно.

Финальная синхронизация CSS завершена: повтор `node scripts/staff-header-actions-runtime-qa.mjs` PASS. Временно наблюдавшееся расхождение source/dist устранено, все5 повторённых focused suites прошли.


## Итоговая проверка координатора в Edge

Две отдельные сессии на loopback127.0.0.1/localhost31932: бармен видит чай, кальянщик — кальян. Через UI выбраны и отправлены позиции, каждая принята в работу. После готовности чая общий заказ остаётся «Готовится»; после кальяна — «Готово». Перезагрузка сохраняет исполнение. Плюс после готовности создаёт третью строку и сразу возвращает общий «Готовится»; старые минусы disabled с пояснением, авторы продажи сохранены.

Визуальный тест выявил сжатие workspace и перекрытие preparation секцией floor; устранено нормальным потоком и grid для staff-orders-view. Дополнительно ширина queue возвращена auto, карточки border-box: на1920 правый край карточки и её контейнера1466.8px, до панели заказа1485px. Размеры проверены через DOM:1366×768 и1920×1080, горизонтального переполнения viewport нет. После финальной синхронизации staff-header-actions-runtime-qa PASS.

Снимки: output/qa/fix03-1/hookah-1366.png, order-1920.png. Viewport сброшен, собственные вкладки закрыты. Собственный сервер31932 оставлен работающим. Миграция099 применена координатором только к локальной synthetic31930; disposable PG suite31931 отдельно. Начальные замечания layout/parity/EOF выше устранены.
