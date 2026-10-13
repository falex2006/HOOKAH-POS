# Контракт рабочего места сотрудника POS

Дата: 11.10.2026. Основание: read-only аудит свежего worktree `pos-employee-workspace` от published main и сверка с итоговой локальной реализацией. Реализация касается существующего `/`; вид заказов сохраняется существующим `/?view=orders`. Новые публичные маршруты, административные права и финансовые правила из макета не выводятся. Цвета и компоненты определяются актуальными `DESIGN_TOKENS.md`, `VISUAL_PAGE_RULES.md`, `style.css` и общими UI-стилями обеих тем.

## UI → API → права → сохранение → повторное отображение

| Сценарий | API и запрос | Права / tenant | Сохранение и повторное чтение | Приёмка |
|---|---|---|---|---|
| Доступ и тема | GET `/api/session` | Серверные effective permissions. Для рабочего зала `floor + orders`. Tenant из authoritative session | Изменение token/user/venue/rights инвалидирует pending reads, редакторы, оплату и queue. Тема из user.preferences | Смена пользователя/venue, отзыв orders, обе темы |
| Зал и выбранный заказ | GET `/api/floor`; GET `/api/orders?withPricing=1` | floor/orders; venue сессии | Статусы столов/заказов и execution из PG; `pricingTotal` рассчитан сервером. Сохранять выбор стола и вида при refresh | Reload, второй сотрудник, изменение заказа на другом клиенте |
| Первая позиция | POST `/api/orders` `{tableId,minimumOrderTotal}`; POST `/api/orders/:id/items` `{productId,quantity}` | orders, открытая смена; server tenant и product/table guards | Два запроса: после неудачного add пустой заказ может уже существовать. Автор продажи определяется серверной сессией | Повтор после отказа add не создаёт второй заказ |
| Передача строк | POST `/api/orders/:id/dispatch` `{station,itemIds,expectedVenueId}` | orders, открытая смена; station bar/hookah; только строки выбранного заказа/venue | Одна station за запрос. `new → queued`; неизвестное направление выбирается явно. Родительский order блокируется FOR UPDATE | Mixed bar+hookah; unknown; повтор тех же itemIds; новая строка не захватывается повтором |
| Очередь станции | GET `/api/preparation/queue` | orders и bar_tasks/hookah_tasks; tasks_manage даёт обе станции | Только queued/in_progress, включая closed с незавершённой работой. Cancelled исключён | Бармен не меняет hookah; два сотрудника одной станции видят общую работу |
| Исполнение | PATCH `/api/orders/:order/items/:item/preparation` `{status,expectedStatus,expectedVenueId}` | Только разрешённая station; чужая station 403, чужой order/item/venue 404, stale state 409 | `queued → in_progress → ready`. Повтор сохранённого перехода безопасен. Активный order ready только при ready всех строк; closed не переоткрывается | Конкурентная готовность двух stations, delayed response, closed unfinished |
| Оплата | GET/POST `/api/orders/:id/payments`; POST `{method,amount,idempotencyKey}` и receiptId для reservation | orders; запись требует открытую смену; для брони/зачёта предоплаты дополнительно reservations | due/paid/remaining/closed с сервера. Первый платёж фиксирует pricing. Полная оплата закрывает order, списывает склад один раз, пересчитывает table free/reserved в транзакции | Частичная оплата, повтор idempotency key, final payment race, отсутствие двойного склада |
| Legacy close | POST `/api/orders/:id/close` `{paymentMethod}` | orders и открытая смена | Создаёт остаточную оплату и закрывает. После полного payments не вызывать. Это не фискализация | Existing payment/close regression |

Точки кода исходного аудита: `app.js:58–137,358–387,579–598,652–670,924–1000,1054–1123`; `server.js:283–334,1398–1407,5881–5928,6052–6068,6315–6422,6451–6500`; `order-preparation.js`; `effective-permissions.js`; `db.js:69–76`; `reservation-calendar.js:10–18`. После реализации номера строк могут измениться.

## Объединённая отправка

- Одна осознанная кнопка «Отправить в приготовление» передаёт все подходящие новые строки текущего заказа. Известные preparationStation bar/hookah из настроек позиции сохраняются без отдельного выбора. Только для nullable preparationStation открывается диалог явного выбора bar/hookah; направление не выводится из category. Helper также сохраняет совместимость с прежними queued строками без назначенной station.
- До отправки подготовить snapshot точных itemIds текущего order/venue/accessRevision. Новые строки, появившиеся после snapshot, не захватываются автоматически. После диалога неизвестных направлений повторно проверить контекст.
- Группировать snapshot IDs по station; POST выполнять последовательно. Backend не предоставляет общую атомарную транзакцию двух направлений.
- После каждого persisted ответа применять подтверждённый результат. Если второе направление не сохранено, явно назвать сохранённое и оставшееся; reread перед повтором. Не сообщать полный успех до ответа обоих запросов.
- Pending защищает весь batch одного order. Истечение ожидания не доказывает отказ сервера; сохранять pending до результата/reconciliation. Не повторять весь заказ автоматически.
- Сообщения «Отправлено в бар» / «Отправлено кальянщику» обозначают station. В execution отсутствует assignedEmployeeId: «Отправлено Ивану» недостоверно.

## Счётчики и бейджи

| Подпись | Допустимый источник / смысл |
|---|---|
| В приготовлении | Количество видимых строк queued/in_progress из preparation queue текущих effective stations; подпись/tooltip обозначают строки, не гостей/столы |
| Готовые заказы | Количество активных заказов с непустым items и preparationStatus=ready у всех строк. Одного order.status=ready недостаточно. Готовность исполнения не означает выдачу |
| Бар готов / Кальян готов | Для конкретного активного order все существующие строки данной station ready; если есть новые/незавершённые строки этой station, не показывать полную готовность |
| Открытые счета | Количество активных заказов open/in_progress/ready/awaiting_payment. Это счета, не просьбы гостя об оплате |
| Ожидает оплаты (статус стола) | Подтверждённый table.status=awaiting_payment. Не выводить просьбу гостя об оплате из ready |
| Приготовление N мин | Время от persisted preparationDispatchedAt; null отображается как неизвестно. Это elapsed, не SLA или ETA |
| Сумма заказа | Серверный pricingTotal включает уже оплаченную часть, скидку и VIP-минимум |
| Осталось оплатить | Только authoritative remaining из payments/summary. attentionPaymentDue в списке может быть null до pricing snapshot; null не равно нулю |

Если «Нужно сейчас» используется как сводный показатель, его состав должен быть объясним и не считать один order/table дважды; предпочтительнее конкретные существующие показатели. Не выдумывать просрочку без настройки SLA.

Порядок и координаты столов стабильны. Attention/filter не переставляют физическую карту. Бейджи дополняют текстовый статус, не заменяют его. Loading/error/stale не отображаются как успешный ноль. Для оплаченной работы из queue показывать её настоящий orderId/tableName; не перепривязывать к новому активному заказу того же стола.

## Refresh и конкурентность

В исходной версии preparation polling не обновлял openOrders/floor. Текущая реализация использует coordinated refresh session/floor/orders/preparation каждые 30 секунд и при focus/visibility, с singleflight для фонового цикла; после успешных mutation актуализируются связанные данные и представление. Это polling, не realtime/WebSocket: действие другого сотрудника видно после очередного чтения. При переходе в заказы view сохраняется в URL/reload; приготовление — локальный вид рабочего зала, без нового маршрута.

Сохранить singleflight, venue/access/request revisions, pending mutations, выбранные table/order/view, права и rollback отображения. Медленный ответ прежнего пользователя/venue не применяется. Ошибка источника не обнуляет показатель без stale/error-подписи. Совпадение tableId у исторической closed работы и нового активного order не означает одну задачу.

При background ошибке floor последние столы остаются с явным предупреждением, operational badges убираются до успешного чтения. При initial ошибке без данных показывается отказ загрузки, без утверждения о наличии последних данных. «Обновить зал» повторяет только существующие GET floor/orders; результат не перехватывает фокус у сотрудника, уже выбравшего другой control. Read-only сценарии ошибок, delayed retry и zone/selection/badges зафиксированы в `scripts/pos-workspace-floor-browser-qa.cjs` и `evidence/floor-qa.json` (5 PASS).

Визуальная плотность после финальной доводки: «Вместить» выбирает число колонок по доступной ширине и высоту 132–144 px; карточки с дополнительными данными могут стать выше. Предупреждение прокрутки учитывает фактическую высоту сетки. Ручные 70–130% и существующие scoped preferences сохранены, свободные карточки при 70% имеют прежний минимум 108 px. Подробности и границы проверки: [FINAL_POLISH.md](FINAL_POLISH.md).

## Ограничения API и будущие расширения

Следующие функции отсутствуют в текущем серверном контракте. Их можно добавить отдельными будущими задачами с persisted данными/API/RBAC; интерфейс текущего рабочего места не должен имитировать их наличие.

1. Отдельной base-role «бармен-кальянщик» сейчас нет. UI/API способны обе stations по effective permissions, но scoped editor не имеет bar_tasks/hookah_tasks. Resolver добавляет task helper базовой роли; staff даёт tasks_manage одновременно с кадровыми правами. Не выдавать staff/tasks_manage автоматически для совмещения duties. Показывать только реально разрешённые stations; чистое совмещение требует отдельного RBAC-контракта.
2. Персональный исполнитель и проверка наличия исполнителя на смене: таких полей/API нет.
3. «Выдано», «Вернуть готовность», SLA и assigned-to-me: соответствующих persisted переходов/данных нет. Ready не исчезает после выдачи, потому что выдача не зарегистрирована.
4. Эквайринг «банк подтвердил» / «деньги списаны» и фискальный чек: POST payments сохраняет внутреннюю POS-оплату, не подтверждает банковское или фискальное устройство.
5. Переключение сотрудника по PIN: lock.js разблокирует текущую сессию. Другой сотрудник использует существующий вход/выход; нельзя подписать unlock как смену пользователя.
6. Общий управленческий колокольчик не предоставляется операционному сотруднику. Attention рабочего места — собственное представление реального operational state.
7. Финальная оплата уже освобождает/резервирует стол по серверному контракту. Отдельный новый «Гость ушёл/стол освобождён» lifecycle нельзя дорисовать как реализованный.

## QA и точная граница доказательств

Исходный read-only QA: `node scripts/order-preparation-unit-qa.cjs` PASS (19); `node scripts/order-preparation-ui-qa.mjs` PASS. Это не подтверждает browser/PG/production.

Реальная приёмка использует только disposable PostgreSQL `hookah-full-regression-qa-20261001`, exact loopback31931, postgres:16-alpine, QA label, AutoRemove и единственный anonymous volume. Guards проверяются перед каждым create/drop. Не запускать общий seed/reset для существующих companion fixtures. Current private runtime помещён в ignored `tmp/full-local-qa/runtime.json` только после live guard + PG identity. Original runtime password оказался stale; private credential согласован с текущим guarded Docker POSTGRES environment без вывода и без сброса password.

Минимальная mixed приёмка: bar+hookah+unknown → единая отправка → persisted queue двух stations → reload второго сотрудника → independent transitions → partial payment → price lock → final payment closes/free-or-reserved → unfinished execution stays queue → readiness preserves closed/payment/stock. Дополнительно wrong station/tenant, access revoke, partial batch failure/retry, keyboard focus и обе темы на 1366×768/1920×1080/планшете/телефоне. Общие sidebar/header contracts и parity ключевых staff routes сохраняются.

Воспроизводимые runners находятся в `scripts/pos-workspace-postgres-fixture.cjs`, `scripts/pos-workspace-browser-qa.cjs`, `scripts/pos-workspace-state-browser-qa.cjs` и read-only `scripts/pos-workspace-floor-browser-qa.cjs`; private fixture manifest и server helper находятся только в ignored `tmp/full-local-qa/`. Секреты, токены и пароли не включать в отчёт/скриншоты/документацию.

### Подготовленное локальное окружение

11.10.2026 подготовлен отдельный loopback server `http://127.0.0.1:35397` из этого worktree и runner-owned случайная `audit_qa_*` БД на disposable31931. Наличие/URL каждый раз брать из private manifest, потому что порт случайный. Данные: 10 столов, 2 зала, 5 состояний floor, товары бара/кальянов/неизвестного направления, mixed new+queued+in_progress, ready, а также финансово закрытый через настоящий POST payments заказ с незавершённой execution. Проверены live health=postgres, API queue двух станций и manager override, floor statuses, публичная доступность новых runtime assets. Подготовка fixtures не является визуальной приёмкой.

- Private manifest: `tmp/full-local-qa/pos-workspace-private.json`; содержит base, childPid, database, actors (id/login/password/token/user), ids (venue/zones/tables/products/orders/items). Читать через fs JSON в переменную без console.log manifest/actor/token. Для браузера передать actor в addInitScript и установить crm_session_token и crm_session_user; затем открыть base + `/`. Обычный login с полями тоже доступен.
- Запуск/переиспользование: в PowerShell установить `$env:NODE_PATH='C:\Users\ADMIN\Documents\ChatGPT\HOOKAH CRM 2\node_modules'`, затем `node scripts/pos-workspace-postgres-fixture.cjs`. Готовый existing manifest проверяется и используется без reset/reseed/restart. Failed manifest не сбрасывается автоматически.
- Независимый backend regression: `node scripts/order-preparation-postgres-qa.cjs` (каждый запуск создаёт/удаляет свою случайную БД; guarded private runtime необходим).
- Завершение после browser приёмки: `node scripts/pos-workspace-postgres-fixture.cjs --stop`; runner проверяет ownerTag/root/database, exact Docker guard и PID commandline собственного server helper, останавливает только свой server и удаляет только свою БД. Не использовать до завершения работы координатора.

Минимальный browser маршрут: использовать actor bartender, открыть mixed order на столе2; нажать единую отправку всех новых строк и явно назначить unknown; проверить persisted response обоих dispatch. В другой browser context использовать hookah_master: очередь hookah, reload, В работу/Готово; bartender аналогично только bar. Завершить оставшуюся bar/hookah работу: активный mixed станет ready. Затем в bartender принять часть оплаты и остаток (remaining брать GET payments), проверить closed и floor; отдельно paidUnfinished остаётся в bar queue и финальная готовность не меняет closed/payment ledger. Сохранить dark/light screenshots без credential inputs/служебного текста и проверить поля, focus, отсутствие overflow и network errors.
