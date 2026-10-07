# Локальная PostgreSQL база для полного QA — 01.10.2026

## Область и безопасность

Роль: `data_engineer`, экспертиза `warehouse_domain` и `finance_domain`. Изучены профили, `SECURITY_RULES.md`, правила складского каталога, `schema.sql`, миграции до 056, `server.js`, `db.js` и существующие PostgreSQL QA.

Изменения этой роли: `scripts/seed-local-full-qa.mjs` и данный план. Production, основной грязный checkout, существующие локальные превью и реальные учётные данные не используются.

Сидер допускает только конфигурацию `tmp/full-local-qa/runtime.json`, приложение `http://127.0.0.1:31932`, PostgreSQL `127.0.0.1:31930`, имя БД `hookah_local_qa`. Проверяет Docker label `hookah.local-qa=20261001`, образ PostgreSQL, loopback публикацию и объявленный QA volume. Выполняет SQL только для чтения имени подключённой БД. Все бизнес данные создаются через реальные API при `AUTH_REQUIRED=true`, `DEMO_MODE=false`; `/api/health` обязан показать `postgres`.

Не запускать старый `seed.sql`: он содержит прежний бренд, демо Марию, фиктивные plaintext credential hash и вставки без естественных уникальных ключей. `scripts/seed-menu-catalog.js` полезен для стандартного каталога, но не заменяет тестовые связанные рецепты, остатки, оплату и роли.

Секреты локальной среды случайные; manifest с синтетическими credentials сохраняется только в игнорируемом `tmp/full-local-qa/seed-manifest.json`, не печатается и не публикуется. Он не содержит пользователей production. Пароли staff берутся из локального случайного пароля с ограничением API 4–11 символов; PIN — отдельное четырёхзначное поле через API. Пароль владельца tenant требует минимум 8 символов.

## Набор данных

| Область | Наполнение на каждом из трёх заведений |
| --- | --- |
| SaaS | 2 независимые организации; enterprise для свободного полного наполнения, 2 филиала у первой организации, 1 у второй; инфраструктурный platform_owner |
| Команда | В основном заведении admin, manager, senior_bartender, senior_hookah_master, bartender, hookah_master, developer, cleaner, security, technician, other_staff; owner отдельно; scoped admin с orders/reservations; архивный staff. В дополнительных заведениях admin/bartender/hookah_master |
| Зал | 3 зоны, 9 столов, координаты/формы, обычная и VIP вместимость, минимальный заказ, blocked стол |
| Склад | 4 цеха, по подцеху и категории; 12 позиций: мл/г/шт, покупная упаковка и множитель, сырьё, расходник, инвентарь, мало/нет остатка |
| Меню | 5 продуктов: бар, кальян, кухня, non_stock услуга, напиток на премиксе; aliases; 4 связанные sale техкарты |
| Производство | premix рецепт; отменённый выпуск, активная партия с фактическим выходом ниже планового и сроком; waste/count с журналом движений |
| Поставки | auto-order и partial receipt; draft/posted/voided документы; дата задана и пустая; частичная и полная оплата с постоянным idempotencyKey |
| Гости | 8 гостей с nickname, телефонами, предпочтениями, аллергеном, new/regular/vip/blocked, архивным гостем; 3 группы скидок/бонусов/депозита; отдельное начисление баллов |
| Брони | обычные/VIP будущие брони, депозит и вместимость, отменённая бронь |
| Доставка | new/confirmed/in_delivery/delivered/cancelled; cash/card/qr |
| Задачи | 8 задач; все статусы и приоритеты; сроки в прошлом/сегодня/будущем; конкретный активный исполнитель |
| Финансы | expense/income категории, 3 обычных расхода, закупочные платежи; правила hourly/monthly/percent_revenue/per_shift; draft/approved/paid/cancelled payroll; оплаченная запись связана с expense |
| Учёт времени | график и 8 часов закрытого work log для каждого staff, без пересечений |
| Продажи | 6 закрытых заказов с guestId, 2 позициями, cash/card/qr и утверждённой скидкой; 5 текущих сценариев open/in_progress/ready/cancelled/частично оплаченный |
| Смены/аудит | согласованная закрытая смена с openingCash+cash receipts=closingCash; новая открытая смена; реальные API создают аудит и уведомления; один receipt прочитан |

Данные филиалов идентичны по названиям, но имеют разные UUID. Это намеренная проверка принадлежности tenant/venue и утечки при смене активного филиала. У второго филиала timezone `Europe/Moscow`, у основного `Asia/Yekaterinburg`.

## Точный порядок и API поля

1. Platform login: `POST /api/login {username,password}`. Создать организации через `POST /api/platform/organizations {name,slug,ownerName,ownerLogin,ownerPassword,plan,timezone,city,address}`. Сервер сам создаёт organizations, venues, users, membership и subscription в транзакции. Ответ UUID tenant; owner login даёт `user.venueId`.
2. Owner login, `PATCH /api/staff/:ownerId/pin {pin}`. Дополнительный филиал `POST /api/network/venues {name,city,address,timezone}`. `POST /api/network/venues/:id/select` записывает activeVenueId в текущую persisted session; повторный `/api/session` подтверждает выбранный UUID. Не писать глобальный venue_id напрямую.
3. Staff: `POST /api/staff {name,role,login,password,birthDate,employmentStartedAt,workNotes,phoneNumbers}`. NonCRM роли cleaner/security/technician/other_staff без password/login доступа. `permissionScopes` задаёт только owner и только admin. Архивирование: сначала `PATCH /api/staff/:id/status {active:false}`, затем `POST /api/staff/:id/archive`. Нельзя создать роль owner через staff API. Platform owner — инфраструктурная identity env, не fake users row.
4. Зоны: `POST /api/floor/zones {name,expectedVenueId}`. Столы: `POST /api/floor/tables {zoneId,name,capacity,minCapacity,maxCapacity,minimumOrderTotal,expectedVenueId}`. Layout/status: `PATCH /api/floor/tables/:id {expectedVenueId,layout:{x,y,width,height,shape,unit},status}`. **expectedVenueId обязателен**: без него 428, чужой/устаревший UUID 409.
5. Hierarchy: `/api/inventory/departments {code,name,color}` → `/api/inventory/subdepartments {departmentCode,name}` → `/api/product-categories {name,department,subdepartmentId}`. Позиция использует department code, но subdepartment/category **имена**. Нельзя привязать категорию подцеха A к подцеху B.
6. Stock: `POST /api/inventory/items {name,department,subdepartment,category,itemType,unit,cost,minLevel,purchaseUnit,packMultiplier,supplier,note}`. Допустимы units шт/г/кг/мл/л/порция/уп/упаковка, types ingredient/product/consumable/equipment. Начальный остаток только движением: `/api/inventory/movements {itemId,delta,unit,reason}`. onHand не редактируется в item.
7. Menu: `/api/products {name,category,price,inventoryMode,aliases}`. Режимы tracked/non_stock. Recipes: `/api/recipes {name,productId,ingredients:[{ingredientId,quantity:'20 г'}],technology,serve,yieldQuantity,yieldUnit,portionCount,recipeType:'sale'}`. Sale на tracked продукте, только одна active sale карта. Для premix recipeType=premix и productId отсутствует. У премикса выход мл, ingredients идентифицируются UUID, рецепт не содержит outputItem как свой ингредиент.
8. Premix: `/api/inventory/premixes/produce {recipeId,outputItemId,multiplier,actualOutput,expiresAt}` → `/api/inventory/premixes/:id/waste {quantity,reason}` / `count {actualQuantity,reason}` / `void {reason}`. Отмена до расхода, партийных движений и последующего stock activity; себестоимость и возврат сырья через транзакцию API. Срок должен быть будущим.
9. Auto-order: `/api/inventory/auto-orders {items:[{itemId,quantity}],note}`. Покупка: `/api/inventory/purchase-documents {supplierName,documentNumber,documentDate,sourceAutoOrderId,lines:[{ingredientId,quantity,unit,unitCost}],note}` → `/:id/post` / `/:id/void`. Документ draft не увеличивает склад; post увеличивает один раз. Покупная упаковка конвертируется через item.packMultiplier. Закупочная оплата отдельно `/api/finance/purchase-payables/:id/payments {amount,paymentDate,paymentMethod,idempotencyKey,documentUrl}`; methods cash/card/bank_transfer/other. Idempotency key 8–128 символов; постоянный для повторного запуска.
10. Guest groups: `/api/discount-groups {name,discountPercent,bonusPercent,depositMin}`. Guests: `/api/clients {name,nickname,guestStatus,phoneNumbers:[{number,primary:true}],discountGroupId,bonusBalance,depositBalance,tobaccoPreferences,bowlPreferences,barPreferences,allergies,notes}`. PhoneNumbers максимум5, ровно1primary; тестовые +7(000) номера. Loyalty `/api/clients/:id/loyalty {delta,reason}`. Привилегированные поля нельзя создавать от operational employee.
11. Reservation: `/api/reservations {guestName,clientId,phone,date,time,tableId,guests,deposit,notes}`. Будущее время, доступный стол, вместимость, deposit>=minimumOrderTotal; `/:id/cancel`. Доставка `/api/deliveries {customerName,phone,address,comment,total,paymentMethod}` и PATCH `/:id {status,courier}`.
12. Tasks: `/api/tasks {title,description,status,priority,assigneeId,dueDate}`. owner назначает, staff меняет status только своей задачи. `dueDate` — календарная дата, не подменять её timezone timestamp.
13. Team schedule `/api/staff/schedule {userId,workDate,plannedStart,plannedEnd,note}` upsert на user/date. Time `/api/staff/time {userId,startedAt,endedAt,source,note}`; ISO instant с timezone, overlap409. Payroll rules `/api/payroll/rules {name,ruleType,rate}`; entry `/api/payroll/entries {userId,periodFrom,periodTo,ruleId}` → PATCH `/:id {action:'approve'|'pay'|'cancel',paymentDate,reason}`. Payroll оплачивается только этим lifecycle, не ручным expense source=payroll.
14. Expense categories `/api/finance/categories {name,kind}`; expenses `/api/expenses {categoryId,amount,expenseDate,description,source:'manual'}`. Для закупки и зарплаты не создавать дубликат расхода вручную.
15. Shift `/api/shifts {openingCash}`. Order `/api/orders {tableId,notes}` → PATCH `/:id {clientId}` → POST `/:id/items {productId,quantity}`. Статус `/status {status:'in_progress'|'ready'|'cancelled'}`. Скидка `/discount-requests {type:'percent',value,reason}` и admin `/api/discount-requests/:id/approve`. Частичная оплата `/payments {amount,method}`; закрытие `/close {paymentMethod}`. Закрытие создаёт недостающую оплату и списывает техкарту; нельзя обойти через status=closed. Закрыть смену `/:id/close {closingCash,checklist:{version:1,items:{ordersReviewed:true,cashCounted:true,inventoryReviewed:true,externalFiscalReportsHandled:true}}}` после подсчёта cash receipts, затем открыть новую смену. Orders/shifts/stock должны согласовываться после повторного GET и рестарта.
16. Notifications `/api/notifications` → PUT `/api/notifications/:key/read`; receipts пользовательские. Audit `/api/audit` создаётся бизнес API; не синтезировать fake success audit rows SQL.

## Повторный запуск

Manifest хранит stable logical keys для сущностей и действий. Сущность ищется GET по namespace, если manifest ещё не записан; создаётся только при отсутствии. Закупка найдётся по уникальному documentNumber. Выполненные действия не повторяются; purchase payment дополнительно защищён серверным idempotencyKey. Credentials пересобираются по существующим данным, но значения не логируются. Каждая успешная операция сразу сохраняется.

Протокол не обещает exactly-once при аварии между HTTP commit и записью manifest для всех endpoint. Для payment именно закупки есть idempotencyKey; прочие бизнес POST (stock movements, loyalty, orders items) пока его не имеют. При таком узком crash окне нужен read/reconcile перед повтором; полностью удалять БД или replay все движения запрещено. При штатном завершённом rerun новые domain mutations отсутствуют.

API ограничен 180 запросами/min на IP. Сидер выдерживает минимум370ms между запросами, учитывает 429/Retry-After, не увеличивает product rate limit. Login/logout отдельные; не оставлять больше2сессий одной учётной записи. Ошибки выводятся только как method/path/status/error, без request bodies, токенов и credentials.

## Проверка данных и минимальные сценарии

- Два tenants: чужие UUID в read/update/close/stock/recipe/task/purchase/guest/floor должны дать 403/404/400 без изменений; второй tenant не видит данные первого. ActiveVenue переключается только в своей организации и session, не глобально.
- Staff: каждая CRM роль проходит login → authoritative session → PIN → разрешённый desktop; запрещённые API403 без обхода через прямую ссылку. Scoped admin получает только orders/reservations, nonCRM роли не получают UI login. Roman-like hookah_master не превращается в демо Марию.
- Заказ: add/change/remove qty → transfer/split → частичная/полная оплата → close → история/receipt. Повторное close, переплата, изменение paid order ниже paid, cancelled paid order, qty999+1 возвращают conflict, движения/оплата не дублируются.
- Stock: receipt draft/post/repost, shortage, packaging conversion, unit change after movements, recipe ambiguity/missing card/non_stock recipe, precision0.000001, premix expiration and lot consumption, void after activity. Проверить no negative stock и quantity ledger sums.
- Финансы: сумма cash/card/qr соответствует payments, только received payments учитываются; purchase cost и purchase expense не смешиваются с COGS. Payroll draft re-calc/approve/pay/cancel, repeated pay и overlap reject. Оплаченная зарплата связана ровно с одним expense.
- Смена: duplicate open race/close race; audit и owner/admin/manager notifications; stock and financial transactions survive app restart. ClosingCash ровно openingCash+cash paid receipts, expectedCash/variance сверить с DB.
- Гости/брони: nickname, balances, discount group, archive, история покупок; operational guest UI без финансовых editor полей; blocked/capacity/VIP/time reservation conflicts; уникальный телефон внутри venue.
- UI: для каждого desktop route открыть sidebar, формы create/edit/cancel, dropdowns, поиска/фильтров/пустых и заполненных состояний; screenshot до/после. API PASS не заменяет визуальную кликабельность. Mobile/Fold QA пока остановлен по пользователю.
- Настройки/preferences: sidebar/dashboard/theme/notifications, logout persists, 401/503/429 recovery, reload без hanging Promise, нет console error и мерцания font/layout.
- SaaS: создание tenant, plan upgrade/downgrade, seat/venue cap, concurrent quota, suspended session/new login и resume через PATCH `/api/platform/organizations/:id/subscription {plan,status}`. PlatformOwner не приобретает tenant financial роль. Низкие quotas/suspension проверять в отдельном маленьком tenant или regression DB, а не лишать основную наполненную сеть доступа.

## Что не является данным доступного API

`integration_events` — техническая история интеграций, `/api/integrations` read-only заглушки/health, настоящие Telegram/оплаты/внешние сервисы не активируются. Legacy `recipes`/`recipe_items` поддерживают старую структуру, основное API пишет `inventory_recipe_cards`; не дублировать одну sale карту в обеих системах. `order_costs` и premix lot movements должны появиться через штатное закрытие/расход. Sessions/notification_reads/audit создаются соответствующим runtime, SQL fixtures не нужны. Отдельной публичной CRUD alcohol-catalog в текущем `server.js` нет — наличие класса repository не означает доступную функциональность.

## Существующие связанные QA

- `migrations-pg-upgrade-qa.mjs`, `migrations-pg-runtime-qa.mjs`, `migrations-pg-041-recovery-concurrency-qa.mjs`
- `role-api-matrix-runtime-qa.mjs`, `saas-quota-suspension-postgres-qa.mjs`, `company-venue-postgres-qa.mjs`, `session-preferences-postgres-qa.mjs`
- `recipe-depletion-pg-runtime-qa.mjs`, `premix-batch-lifecycle-qa.mjs`, `purchase-auto-order-postgres-e2e-qa.mjs`, `purchase-payment-postgres-api-qa.mjs`
- `payroll-lifecycle-postgres-api-qa.mjs`, `finance-shift-analytics-postgres-qa.mjs`, `finance-employee-postgres-qa.mjs`, `guest-loyalty-postgres-api-qa.mjs`
- `shift-notifications-e2e-qa.mjs`, `shift-cash-postgres-e2e-qa.mjs`, `paid-order-balance-postgres-qa.mjs`, `tasks-postgres-e2e-qa.mjs`, `delivery-persistence-qa.mjs`

Некоторые существующие QA напрямую создают/удаляют fixtures или запускают отдельный server на фиксированном3219. Их запускать только в **отдельной disposable regression БД** с их штатными safeguards; они не должны уничтожать интерактивную наполненную QA базу. Основную базу проверять CUA и безопасными scoped API, результаты/исправления интегрирует координатор.

## Выполненное наполнение и доказательства

Сидер выполнен против выделенного localhost PostgreSQL при обязательной авторизации. Первый завершённый проход: **2 созданных tenant, 3 заведения, 328 manifest entities, 328 actions**. Второй проход добавил только медиа и синтетические документы: avatar/photo одного admin, guest avatar, product image в каждом заведении; паспорт сохранён в зашифрованных полях users с `STAFF_PASSPORT_KEY`. Третий штатный проход: **328 entities / 340 actions без прироста**. Создание бизнес сущностей, денежных и складских движений не повторялось; выбор текущего филиала создаёт новый административный audit event как ожидается.

Проверены syntax и запрет другого config path. Если БД уже содержит `qaprimary`/`qasecond`, но manifest потерян, скрипт теперь останавливается до бизнес POST: требуется восстановить manifest, повторять financial/stock actions с пустым журналом нельзя. Отсутствие файла не принимается за разрешение переиграть наполненную базу.

Агрегаты после наполнения (координатор параллельно проверяет UI, поэтому некоторые его локальные fixtures включены):

| Таблицы | Количество |
| --- | ---: |
| organizations | 3: 2 тестовых tenant + исходная оболочка миграции009 |
| venues / users / zones / tables | 3 / 21 / 9 / 27 |
| products / ingredients / inventory_recipe_cards | 15 / 36 / 15 |
| inventory_premix_batches / inventory_premix_batch_movements | 6 / 9 |
| inventory_purchase_documents / inventory_auto_orders | 12 / 3 |
| guests / guest_discount_groups / reservations / deliveries | 25 / 9 / 9 / 15 |
| tasks / staff_schedules / staff_work_logs | 24 / 17 / 17 |
| payroll_rules / payroll_entries | 12 / 12 |
| orders / payments / order_costs | 33 / 21 / 18 |
| expenses / stock_movements / notification_reads | 18 / 111 / 3 |

У всех созданных закрытых смен `cash_variance=0`. В базе нет скопированных production данных. API и SQL агрегаты не выводили credential, содержимое паспортов или контакты.

Первый пробный payload графика использовал `12:00` вместо полного timestamptz, получив409; исправлен на полный ISO instant с timezone. Это не повреждало данные. Backend проверку входного schedule времени перед PostgreSQL координатор рассматривает отдельно.

Наполнение синтетического паспорта обнаружило privacy defect: staff profile записывал plaintext passportData в audit, а manager мог прочитать его через доступ settings. Координатор добавил общий audit redaction на запись/чтение; отдельный PostgreSQL/HTTP regression PASS описан в `docs/security/LOCAL_AUDIT_PRIVACY_2026_10_01.md`. Исторические raw audit rows сохраняются, но read boundary исключает sensitive keys; это не утверждение об удалении старых значений из физической БД.

## Исправление календарной даты бронирования

В визуальной проверке локальной заполненной базы бронь на **03.10.2026 в 17:00** не отображалась после сохранения под выбранным днём. PostgreSQL правильно хранил момент `2026-10-03T12:00:00Z` для заведения `Asia/Yekaterinburg`. Причина находилась в чтении: SQL `localStartsAt::date AS date` возвращал PostgreSQL date, который стандартный драйвер `pg` преобразовывал в JavaScript Date в часовом поясе процесса. JSON превращал местную полночь в `2026-10-02T19:00:00.000Z`; UI извлекал первые десять символов и относил бронь ко второму октября. Это затрагивало уже созданные брони и давало впечатление потери сохранённой записи.

Координатор заменил только календарную проекцию списка на `to_char(localStartsAt,'YYYY-MM-DD') AS date`. Формат контракта теперь всегда строковый, часовой пояс берётся из заведения. PostgreSQL timestamps, фильтр по локальной дате и история сохранённых данных не требуют переписывания или миграции.

Новый `scripts/reservation-local-date-postgres-qa.mjs` **PASS** на выделенной disposable PostgreSQL `127.0.0.1:31931`. Реальный `ReservationRepository.create/list` проверен в двух отдельных Node процессах: host TZ `Asia/Yekaterinburg` и `America/Los_Angeles`. Каждый процесс создаёт брони в двух независимых организациях/заведениях с этими часовыми поясами на 00:15, 17:00 и 23:45: **12 сценариев**. Проверены точный тип/string `2026-10-03`, сохранение после JSON serialization, список с фильтром и без, отсутствие в соседних датах/чужом заведении, ожидаемый UTC instant включая переход через полночь. Отдельный отрицательный прогон воспроизводит старую SQL date-проекцию только в тестовом адаптере и подтверждает, что тот же regression её отвергает. Исходники продукта при этом не подменяются.

Guard требует точные loopback порт, QA database, имя/label/image disposable контейнера и анонимный AutoRemove volume. Создаются только случайные собственные UUID fixtures; все они удаляются в `finally`, наполнение интерактивной базы на31930 не меняется. Запуск: `node scripts/local-full-pg-regression.cjs scripts/reservation-local-date-postgres-qa.mjs`. Syntax и scoped diff whitespace check также PASS. Этот результат дополняет браузерную проверку координатора, а не заменяет её.
