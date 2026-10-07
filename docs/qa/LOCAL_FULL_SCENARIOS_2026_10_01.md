# Полная локальная проверка HOOKAH POS — 01.10.2026

Исходное состояние: `c4e000bc53630c5d1353d53f0cf188a42cec6616`. Владелец контракта: `system_architect`; дополнительно применены профили `security_reviewer` и `finance_domain`. Документ задаёт сценарии и критерии, а не объявляет их выполненными. Фактические результаты координатор фиксирует отдельно с командой, датой и доказательством.

## Границы и критерий завершения

- Только отдельная локальная PostgreSQL QA-база и loopback-сервер. Проверять `current_database()`, имя с `qa/test/scratch`, фактический адрес/порт и безопасный Docker-контейнер по `scripts/postgres-qa-safety.mjs` перед заполнением или очисткой.
- Синтетические сотрудники/контакты/паспорта/документы; никакой копии production, действующих Telegram-адресов или отправки внешних уведомлений. Реальные ключи интеграций не используются.
- Desktop: 1280×720 и 1440×900; светлая/тёмная схема. Мобильная компоновка и Fold отложены пользователем.
- GitHub и VPS не публикуются этим аудитом. Сначала исправления, независимая проверка diff, журнал и проверяемый локальный пакет.
- Пройденный сценарий означает: пункт меню → экран → реальный API → результат в PostgreSQL → повторное GET/перезагрузка страницы → связанный модуль. Контракт по тексту исходника, API-тест и визуальная проверка учитываются отдельно.
- Для каждой изменяемой формы: валидное создание, редактирование, отмена, повторный быстрый submit, Enter, ошибка/тайм-аут, retry, пустой результат, перезагрузка и второй пользователь. Запрещённое действие должно быть скрыто/недоступно в UI и отклонено сервером.
- «Все возможные будущие ошибки исключены» не является проверяемым критерием. Критерий: найденные ошибки исправлены, добавлены регрессии; не реализованные функции и непроверенные сценарии перечислены явно.

## Набор данных

| Группа | Минимальное разнообразие |
|---|---|
| SaaS | Platform owner; организации A/B с одинаковыми названиями товаров/гостей и разными UUID; trial/active/past_due/cancelled; тарифы starter/growth/network/enterprise; квоты на границе |
| Сеть | Две активные точки A и одна B, архивная точка, разные timezone; один пустой tenant для empty-state |
| Персонал | Owner, admin, manager, developer, bartender, hookah_master, senior_bartender, senior_hookah_master; отдельные admins со scopes orders/reservations/inventory/finance/staff/settings/delivery/integrations/loyalty; заблокированный/архивный сотрудник; не-CRM карточки cleaner/security/technician/other_staff |
| Зал | ≥3 зала, ≥12 столов; одинаковые имена в разных залах, свободный/занятый/забронированный/blocked; VIP с минимумом; min/max capacity; сохранённые layout |
| Гости | ≥8: одинаковые ФИО, разные телефоны, без телефона, несколько телефонов с одним primary, прозвище, дата рождения, архивный, группа скидок, бонус/депозит; история оплаченных и отменённых заказов |
| Меню | ≥15 продуктов: бар/кухня/кальян/услуга; активный/архивный; фото/без фото; recipe/no_depletion; разные цены; табачный справочник venue и organization |
| Склад | ≥15 ингредиентов/позиций: г/кг/мл/л/шт, purchaseUnit/packMultiplier; остаток 0/ниже/равен/выше min; min=0; стоимость 0; несколько поставщиков; цех/подцех/категория; заготовки |
| Техкарты | Продажа и premix, ≥3 ингредиентов; корректная конверсия единиц; выход/порции; ингредиент с недостаточным остатком; продукт без обязательной карты |
| Документы | Поставка draft/posted/void; заявка sent/partially_received/received/cancelled; оплаты partial/full; PDF/PNG fixture; просроченная и действующая партия премикса, consumption/writeoff/reversal |
| Операции | ≥30 заказов: open/in_progress/ready/closed/cancelled; cash/card/qr/split, partial payment, VIP minimum, скидка requested/approved/rejected; несколько гостей, столов, сотрудников и дат |
| Смены | Текущая открытая, закрытые прошлые, ночная через полночь, opening/closing cash, cashVariance; смена другой точки |
| Команда/финансы | Задачи все 4 статуса/4 priority, assigned/overdue; графики/пересекающиеся work logs; payroll hourly/shift/fixed/percent, draft/approved/paid/cancelled; расходы manual/other, категории active/archived |
| Аудит/уведомления | Изменение профиля/прав/заказа/склада/смены, прочитанные/непрочитанные события; отдельные receipts для owner/admin/manager; событие другого tenant |

Наполнять предпочтительно существующими API, прямые fixture-вставки использовать для исторических дат и состояний, недоступных в штатном UI. После seed проверить FK, связность tenant/venue, суммы заказа и оплат, статус стола, себестоимость, остатки и хронологию. Fixture для негативной проверки создаётся отдельно от здорового набора.

## Роли и ограничения

Источник серверных прав: `rolePermissions` + `effectivePermissions` в `server.js`, авторитетная `/api/session`. UI не должен повышать права из browser cache.

| Профиль | Допустимое | Основные отрицательные проверки |
|---|---|---|
| Owner/admin без scopes | Управление CRM текущего tenant по server permissions | Не SaaS platform owner; UUID другого tenant недоступны |
| Scoped admin | Только назначенные scopes, зависимые чтения для своего экрана | Скрытие кнопки не заменяет 403; ни один фикс чтения не выдаёт write других scopes |
| Manager | Рабочие операции, inventory/finance read, tasks_manage, settings/loyalty по текущему серверу | Нет inventory/finance write, staff_manage, staff_sensitive; спорную кадровую политику не менять молча |
| Bartender/hookah + senior | Зал/заказы/гости/свои задачи, ограниченные финансы | Нет payroll/payables/expenses detail, менеджерских уведомлений, staff directory |
| Developer | Текущие технические и кадровые права из server map | Нет passport/PIN plaintext, inventory/finance write и SaaS platform |
| Не-CRM карточки | Кадровая/зарплатная карточка без рабочего логина | Не превращать автоматически в операционного пользователя; валидировать роль/логин |
| Platform owner | Organizations/subscriptions/overview/plans | Не смешивать SaaS-роли с владельцем заведения; обычный owner получает403 |

## Матрица UI → API → права → сохранение → повторное отображение

Для каждого ряда обозначенные права относятся к существующему контракту. Исправленные зависимые чтения согласованы в разделе дефектов. `:id` всегда проверяется на принадлежность текущей точке/организации.

| ID / экран и действие | API и поля | Права | Что сохраняется / повторное чтение | Негативы и связанные QA |
|---|---|---|---|---|
| A01 `/login`: вход каждой CRM роли | POST `/api/login` username/password/device; GET session | Активная учётка/подписка | auth_sessions; правильные id/name/role после refresh | Неверный пароль, disabled, лимит сессий, кеш «Мария»; login-server-identity, session-authority |
| A02 PIN/lock/logout | POST session/unlock, session/pin-return, logout; PATCH preferences | Своя session/identity | Блокировка, PIN/preferences, revoked session401 | Ошибочный PIN, повтор, reload, другая вкладка; local-lock, trusted-pin, logout-persistence |
| A03 Sidebar/header | Канонические routes, GET session/venue/shifts | Server permissions + интерфейсные preferences | Active item, группы/тема/скрытие меню после refresh | Все маршруты, back/forward, hashes, cache, senior roles; sidebar/staff-mode/mode-navigation |
| A04 Главная KPI/инсайты | GET metrics, dashboard/shift-kpis date/shiftId, analytics | По полям: orders/finance_read/inventory_read/staff_view | Суммы по выбранной дате/смене, ограничения employee | Ночь, timezone, paid/cancelled/partial, stale request; dashboard-* QA |
| S01 Открыть смену | POST shifts openingCash | floor OR orders | Ровно одна open shift; header/admin/workspace совпадают | Двойной click/race, invalid money, server503; shift-state/transaction/cash |
| S02 Закрыть смену | POST shifts/:id/close closingCash/checklist version 1 with all four items confirmed | floor OR orders | closedAt/cashVariance + audit + recipients | Повтор закрытия, старая смена, неподтверждённый checklist, тайм-аут; shift-close-ui/notifications |
| S03 Уведомления | GET/POST notifications; PUT notifications/:id/read | Серверное management разрешение | Отдельные receipts + unreadCount после restart | Чужое событие, employee403, одинаковый read дважды; notifications/shift-notifications |
| F01 Зал/этаж создать/изменить/архив | GET floor; POST/PATCH/DELETE floor/zones[/:id], expectedVenueId/name | settings write; согласованное read | zones/sortOrder, список на `/` и в бронях | Другая точка, пустое имя, зал со столами; venue-layout/company-venue |
| F02 Стол/VIP/layout/block | POST/PATCH/DELETE floor/tables[/:id], zoneId/capacity/minimum/layout/expectedVenueId | settings write | tables; refresh и `/` с тем же layout/status | capacity/min/max, занятой стол, foreign zone, смена venue во время формы; local-floor/venue-layout |
| O01 Выбор стола/новый заказ | GET floor/products/orders; POST orders tableId/reservationId | floor read, orders write, открытая смена для employee | orders + occupied; повторное GET и журнал | blocked, чужой стол, двойной заказ на столе/race, нет смены; role-api/order-* |
| O02 Позиция ±/удаление | POST orders/:id/items productId/quantity; PATCH/DELETE items/:item | orders, открытая смена | order_items; сумма/каталог/журнал после refresh | 0/-1/999/1000/fraction, inactive/foreign product, closed/cancelled; paid-order-balance/items guard |
| O03 Отправка/готовность/статус | POST orders/:id/status; PATCH items/:item status | orders + station-specific workflow | Статусы заказа/позиции, рабочая очередь | Запрещённые переходы, чужая station, close через status; order-attention/item-close-guard |
| O04 Гость/заметки заказа | PATCH orders/:id notes/clientId/guestName/phone | orders | guests link + notes; clients history | Одноимённые гости, invalid phone, foreign UUID, closed immutable; local-guest-order/history |
| O05 Перенос/разделение | POST orders/:id/transfer tableId; POST split | orders + смена | Новый стол/заказ, старый стол свободен при отсутствии активности | Занятая/blocked/foreign target, частичная оплата, повтор; pos-transfer/orders-total |
| O06 Частичная/полная оплата | GET/POST orders/:id/payments amount/method/status | orders + смена | payments, debt, shift attribution | 0/negative/subcent/overpay, гонка, потеря ответа; staff-partial-payment/paid-balance |
| O07 Закрытие оплаченного заказа | POST orders/:id/close paymentMethod/payment/checklist according UI; GET summary | orders + смена | closed, payments, order_costs, stock, free table, loyalty | Недоплата, VIP minimum, недостаток stock/карты, два close; order-close-transaction/recipe-depletion |
| O08 Удаление активного заказа | DELETE orders/:id comment/writeoff | orders + смена | cancelled + причина + optional stock writeoff + audit | Paid/closed нельзя, пустая причина, повтор, stock rollback; order-delete |
| O09 Журнал/чек/поиск | GET orders includeClosed/filter; GET summary/payments | orders | История не теряется; чек = позиции−скидки/VIP/оплаты | Empty, длинное имя, имя стола/зала, скачивание; orders-history/receipt/journal |
| G01 Гость create/edit/archive | GET/POST clients; PATCH clients/:id; POST archive | Read orders OR staff_view OR staff; write orders OR staff_manage | guests; карточка и поиск после refresh | Телефоны/primary/дубли, нет бонусных editors у employee; staff-guests/client-form/editor |
| G02 Owner delete/история | DELETE clients/:id; GET history | Owner + staff_manage delete; текущие read права | История/ссылки согласованы; audit | Employee/admin403 delete; foreign guest404; client-history-date |
| G03 Бонусы/группы/лояльность | POST clients/:id/loyalty delta/reason; GET/POST/PATCH discount-groups; venue loyalty settings | staff_manage OR finance дляadjust; группы staff_manage/finance/loyalty | Points/group/rules; применяются в продаже | Отрицательная корректировка, лимит, role403, повтор; guest-loyalty/discount-groups/loyalty-pending |
| G04 Скидка к заказу | POST orders/:id/discount-requests; GET discount-requests; decision route | orders request, finance decision | requested/approved/rejected, итоговый total | Одновременная оплата/скидка, сверх paid balance; finance-discount/paid-order-balance |
| R01 Бронь/поиск гостя/стола | GET reservations/floor/guest choices; POST reservations name/date/time/tableId/guests/deposit | reservations; зависимые read | reservations, tableName/zoneName, tenant timezone | Ёмкость, blocked, VIP deposit, одинаковые имена, foreign UUID, календарная дата; reservation-form/venue-layout |
| R02 Отмена/бронь→заказ | POST reservations/:id/cancel; POST orders reservationId | reservations + orders при заказе | cancelled/history, освобождение без порчи occupied | Двойная отмена, race same table/time, timezone, refresh; reservations/order integration |
| M01 Товар/фото | GET/POST/PATCH/DELETE products[/:id]; POST/PATCH image as UI | inventory write; read floor OR inventory_read после fix | products/prices/image/active/inventoryMode | Scoped inventory, invalid money, photo read error, archived sale; product-pending/brand/catalog |
| M02 Табачный справочник | GET/POST/PATCH tobacco-catalog[/:id] brand/flavor/scope | inventory[_read]; org edits owner/admin | tobacco_catalog_items; venue/org visibility | Duplicate/foreign tenant/scope, inactive, long aliases; tobacco-catalog API/demo |
| M03 Цех/подцех/категория | GET/POST/PATCH/DELETE inventory/departments, subdepartments, product-categories | inventory_read / inventory write | Directories + привязки ингредиентов/товаров | Rename propagation, mismatch category/department, used delete; hierarchy/directory-rename/subdepartment |
| M04 Техкарта/себестоимость | GET/POST/PATCH/DELETE recipes[/:id]; GET cost; productId/type/ingredients/yield/portions | inventory_read / inventory write | inventory_recipe_cards; привязка к sale и depletion | Decimal unit conversion, missing item/card/cycle, zero yield, duplicate product binding; recipe-chain/depletion/form |
| W01 Складская позиция/остаток | GET inventory; POST/PATCH/DELETE inventory/items[/:id] measurement/threshold/cost | inventory_read / inventory | ingredients + movements; status при min0/ниже/равно/выше | Pack/unit/mismatch, other venue, deleted used item, stale form; warehouse/stock-status/runtime |
| W02 Поставка/списание | POST inventory/supplies, movements itemId/direction/quantity/reason | inventory | stock_movements + cost; linked finance | Недостаток, отрицательное, fractional, повтор, atomic rollback; inventory-movement-transaction |
| W03 Заявка на пополнение | GET/POST/PATCH auto-orders selected lines/quantities | inventory_read / inventory | Заявка и received quantities, supplier totals | Pending double-click, partial receive, cancelled request, duplicate receive; auto-order-pending/purchase-auto-order |
| W04 Накладная lifecycle | GET/POST/PATCH purchase-documents; POST :id/post/:id/void lines/date/document | inventory_read / inventory | draft→posted/void + stock ledger + payable | Повтор post/void, invalid attachment/units/date, partial payment; purchase-document validation/pending/PG |
| W05 Премикс производство/партии | GET premixes; POST produce recipeId/quantity/expiry; lifecycle routes | inventory write | batches + batch_movements + aggregate stock | Expired stock, FEFO, cancellation after consumption, rollback insufficient; premix-batch-lifecycle/recipe-depletion |
| C01 Сотрудник CRUD/статус/архив | GET/POST staff; PATCH profile/status; POST archive; DELETE staff/:id | staff read/settings/staff_view; staff_manage write | users/membership, active flags, audit | Login duplicate, birthdate, role escalation, deactivate logged-in, foreign employee; role-matrix/staff-profile |
| C02 Телефоны/аватар/PIN/passport | GET/PATCH profile; PIN/avatar routes | Self limited OR staff_manage; staff_sensitive protected | users/preferences/encrypted blocks | Invalid file/key, no plaintext in DTO/log, primary phone validation; staff-pin-passport/security |
| C03 График/рабочее время | GET/POST staff/schedule, staff/time starts/ends/userId | staff_manage write; staff_view read | schedules/work_logs, расчёт часов | Overlap, unfinished log, timezone, cross tenant; staff-worklog/payroll-calculation |
| C04 Задачи | GET/POST/PATCH tasks[/:id] title/assignee/deadline/status | tasks_manage/staff_manage create; employee only own status | tasks; четыре lanes и refresh | Foreign assignee, another employee task, deadline, server fail retry; tasks-postgres/task-ui-recovery |
| $01 Финансы overview/отчёт | GET finance/summary, report, analytics date/from/to | finance_read; employee limited | Totals from ledger after refresh; no artificial fixture totals | Employee own view, overnight, mixed payment, partial, expense double count; finance-shift/employee/report |
| $02 Категории/расходы | GET/POST/PATCH finance/categories; GET/POST expenses categoryId/amount/date/document | finance write; management finance_read expenses read | categories/expenses; отчёт и audit | Archive linked category, wrong kind, unsafe attachment, invalid dates/filter race; finance-categories/expenses |
| $03 Оплата поставщику | GET purchase-payables[/:id/payments]; POST payments amount/date/method/idempotencyKey/document | finance_read management read; finance write | purchase payments + balance; cash flow ≠ duplicate COGS | Overpay, duplicate/race key, void/unposted, document bad, denied employee; purchase-payment/payables PG |
| $04 Зарплата | GET/POST payroll/rules; GET/POST entries; PATCH entries/:id approve/pay/cancel; GET payroll/employees after fix | finance only | payroll_entries + один expense на pay, status after refresh | Overlapping period/rules, repeated pay, cancel reason, zero hours, timezones, DTO privacy; payroll-lifecycle/calculation |
| N01 Компания/timezone/preferences | GET/PATCH venue expectedVenueId; GET/PATCH session/preferences | settings venue; self preferences | venues/org tz, own preference separate users | Invalid timezone, save after network switch, stale 503 vs local values; company-settings/context/preferences PG |
| N02 Сеть/выбор точки | GET/POST/PATCH/archive network/venues; POST :id/select | settings/diagnostics read, settings mutations and role checks | venue/org membership/session current venue | Other organization UUID, archived select, pending/error, restart; network-* |
| N03 Интеграции/диагностика/аудит | GET integrations[/provider], audit action/entity/from/to | diagnostics/settings/integrations as API; audit role controls | Read states, audit filters/export, no external send | No secrets in page/export; unavailable ≠ connected, wrong scope; integrations-*/security |
| P01 SaaS onboarding | GET overview/plans/organizations; POST organizations name/slug/owner/tz | platform only | org+subscription+venue+owner+membership atomically | Duplicate slug/login, owner invalid, PG rollback, tenant A/B login; SaaS-onboarding/company-venue PG |
| P02 SaaS подписка/квоты | GET/PATCH organizations/:id/subscription plan/status; GET saas/account | platform mutation; tenant own account settings/diagnostics | organization_subscriptions; quotas enforced live | Trial/active/past_due/cancelled; concurrent seat/venue quota; revoked session; saas-quota-suspension PG |

## Обнаруженные несоответствия исходного состояния

На 01.10.2026 проверено чтение исходников и выполнение настоящих фрагментов `portal.js`/`server.js` в Node VM. Браузерный и PostgreSQL прогон в этой подзадаче не выполнялся. Продуктовые файлы меняет координатор.

| ID | Воспроизведение и первая причина | Согласованный минимальный контракт и регрессия |
|---|---|---|
| D01 P1 | Войти senior_bartender/senior_hookah_master → `/orders`, `/clients`, `/finance`. `portal.js:3` allowlist исключает seniors, хотя server и карта portal поддерживают их. VM реального bootstrap: обе роли делают replace(`/`), обычные bartender/hookah — нет. | Допустить эти две рабочие роли в bootstrap, добавить labels. Не допускать platform_owner и не-CRM роли этим фиксом. Выполнить actual bootstrap + server session + UI переход/refresh для обеих seniors. |
| D02 P1 | Admin scope inventory: effectivePermissions = inventory/inventory_read. Каталог `/inventory?view=products` зовёт GET products, но `server.js` требует floor →403. | GET products: floor OR inventory_read. POST/PATCH/DELETE/image остаются inventory. Inventory-only read200; finance-only403; inventory_read manager не получает write. |
| D03 P1 | Admin scopes reservations либо settings не имеют floor. `/reservations` и `/admin#venue-layout-settings` оба читают GET floor →403; форма столов не загружается несмотря на право своего раздела. | GET floor: floor OR reservations OR settings. Все floor writes остаются settings и expectedVenueId. Finance-only/inventory-only403; foreign venue недоступен; scoped reservations не получает создание/изменение столов. |
| D04 P1 | Admin scope finance: форма payroll draft зовёт GET staff для select; server допускает staff/settings/staff_view →403, хотя POST payroll entries требует именно finance. | Новый GET `/api/payroll/employees`: finance only, DTO строго id/name/active, venue_id и deleted_at filter. PostgreSQL недоступен →503, без memory fallback. Portal использует его вместо кадрового API. Не расширять GET staff. Manager/employee finance_read403; finance-only staff403; phone/photo/login/passport/workNotes/PIN отсутствуют. |
| D05 P2 | Reservations-only дополнительно зовёт GET clients для выбора существующего гостя; тот разрешён staff/staff_view/orders →403. После D03 ручная бронь работает, выбор существующей карточки остаётся неполным. | Согласован новый GET `/api/reservations/guests`: reservations only, DTO строго id/name/nickname/phoneNumbers, текущий venue, исключены archived гости; legacy phone нормализован в phoneNumbers. Portal бронирований использует его. Не выдаются orders write или read полной `/api/clients`. Finance-only/operational employee403; другой tenant исключён; balances/notes/preferences отсутствуют. |

### Согласование безопасности и финансов D01–D04

Изменения совместимы при сохранении указанных границ: только зависимые чтения собственных экранов; финансовый сотрудник получает минимальный список для начисления, без доступа к кадровой карточке. Server permissions остаются авторитетными. DTO нового payroll read должен иметь allowlist полей и fail503 при отсутствии PostgreSQL, как его write lifecycle. Ни суммы/модели расчёта, ни создание расходов/платежей не меняются.

### Проверка реализации D01–D05

Архитектор повторно просмотрел diff `server.js`, `portal.js` и `scripts/scoped-role-dependencies-postgres-qa.mjs`. Итог: **GO для архитектуры, безопасности и финансов этого исправления**. Связанные reads реализованы с минимальными DTO и без расширения write-прав; миграции/расчёты денег/ledger не меняются. Совместимость browser static demo обеспечивается соответствующими lookup-ветками; static demo не является доказательством сохранения в PostgreSQL.

| Проверка | Результат / доказательство | Ограничение |
|---|---|---|
| Авторизация/scoped reads/denied writes/DTO/tenant isolation/product persistence | Координатор сообщил PASS `scripts/scoped-role-dependencies-postgres-qa.mjs`: 49 реальных HTTP-проверок на disposable local PG 31931, включая actual senior bootstrap | Архитектор прочитал тест, повторный PG-запуск не выполнял; полная CRM-матрица этим тестом не покрыта |
| Ошибка новых lookup-запросов | Независимая Node VM выполняет настоящие server route fragments. `/api/payroll/employees` и `/api/reservations/guests`: pool.query throws →503; DATABASE_URL задан, pool отсутствует →503; denied role →403. Всего 6 PASS | Инъекция в точном route-коде, без HTTP/перезапуска PostgreSQL; в PG script этих failure injection кейсов пока нет |
| Синтаксис | Независимо `node --check server.js`, `portal.js`, `scripts/scoped-role-dependencies-postgres-qa.mjs` PASS | Не заменяет браузерное исполнение |
| Чистота diff | Независимо `git diff --check -- server.js portal.js scripts/scoped-role-dependencies-postgres-qa.mjs` PASS | Git предупреждает о штатной LF→CRLF конверсии, ошибок whitespace нет |
| Браузер | Координатор выполнил фактический desktop прогон, журнал `docs/qa/LOCAL_FULL_BROWSER_2026_10_01.md`: старший кальянщик/гости, scoped admin форма бронирования, owner payroll draft+refresh, каталог и settings | Отдельный UI вход inventory-only/settings-only/finance-only и все три страницы обеих senior ролей этим журналом не заявляются; их API/PG guards покрыты49 real HTTP. Не превращать отдельные проверки в UI PASS всей матрицы |

Первоначальный остаток вне D01–D05: GET `/api/products` скрывал ошибку PostgreSQL repository, возвращая memory products200. Координатор исправил route: исключение repository либо configured DATABASE_URL без repository возвращает503 `products_unavailable`. Архитектор подтвердил чтением актуального исходника; memory каталог сохранён только для режима без PostgreSQL. Полный HTTP failure/recovery сценарий фиксируется отдельно координатором.

UI scoped settings сейчас сохраняет роль admin и `dashboard` в portal map; login отправляет её в `/admin`; виден `#settings`/`#venue-layout-settings` по settings. Scoped reservations видит `/reservations` по reservations. Отсутствующие floor-права являются причиной зависимой загрузки; общий переход/страницу не нужно открывать дополнительными широкими scopes. После исправления это проверяется реальными кликами и refresh, а не только картой.

### Различия политик, которые нельзя молча превращать в права

`STAFF_DATA_POLICY.md` описывает кадровое управление/passport у manager и отсутствие кадрового write у developer. Действующий `rolePermissions` содержит обратное для staff_manage/staff_sensitive: manager view-only, developer staff_manage без sensitive. Это существующее несоответствие документа/реализации. В текущих сценариях ориентироваться на серверные права, не повышать manager и не отзывать developer этим scope-fix. Координатор должен явно зафиксировать выбранную политику/остаток.

### Дополнительные согласованные исправления и проверки

| Область | Причина / контракт | Независимое доказательство | Браузер |
|---|---|---|---|
| График персонала API | Time-only `12:00` приводил к raw PG error409; конец до начала принимался. POST теперь требует реальный workDate и ISO timestamp с timezone, end > start; undefined/null/empty план допускается; false/0 запрещены. Сохраняется staff_manage и tenant employee lookup | `scripts/local-schedule-validation-qa.mjs`: **51 PASS**, actual handler VM; invalid input не вызывает SQL, tenant/deleted/inactive404, denied403, valid overnight/offset/null201 | Создание графика из продукта UI не найдено; API проверен, UI сценарий отсутствует |
| Личный финансовый отчёт | Выручка сотрудника относится к дате поступления его платежей по timezone точки, включая partial/open orders. Число закрытых чеков считается независимо по closed_at, включая чек без платежа. Manager closed-order semantics сохраняются. Ответ после ухода со страницы проверяет identity кнопки старого render; success/error не меняет новый экран и не бросает null DOM ошибку | Новый `scripts/local-employee-report-ui-qa.mjs`: **36 PASS**, actual demo report/summary и actual renderer/dispatcher, восемь operational roles, own venue/actor, overnight boundary, pending/error/retry, success/error после navigation и отсутствие manager полей/редакторов даты/типа | Координатор выполняет real HTTP/PG и браузер отдельно; VM не заменяет screenshot/click |
| Переходы /admin hashes | Несколько smooth scrollIntoView + native anchors конкурировали; прокручивался .portal-main с остатком от предыдущего раздела. Один installer после initial dispatch перехватывает same-page известные anchors, history.pushState + render, один rAF scroll с sticky header+12px. Обычные страницы начинаются сверху; settings target heading; background renders не сбрасывают scroll. Layout идёт к первому #floor-editor heading, а не форме после асинхронно расширяющейся карты. Geometry animation/forced reflow для hash navigation удалены намеренно | `scripts/local-dashboard-navigation-qa.mjs`: **27 PASS**, actual helper VM; initial/hash/same hash/latest revision, tasks/loyalty, offsets/clamp, exact layout selector и no background reset, modifier/cross-page не перехватываются. `node --check portal.js`, `git diff --check` PASS | **Staff/layout desktop PASS**: owner-staff-scroll-fixed.png и owner-layout-heading-fixed.png независимо просмотрены; схема/heading не обрезаны. Координатор сообщил back/settings/company/audit/refresh PASS в общем browser журнале. Short settings/audit достигают естественного max scroll, оставаясь видимыми |
| Задачи рабочего зала | Кнопка «Задачи» показывала ready orders, а не назначенные поручения. Реализован маршрут /admin#tasks, main operations link для operational staff; GET tasks остаётся own-assignee, PATCH только own status, management права не добавляются | Архитектурный контракт и актуальный app/portal diff согласованы; API имеет own-task guards | Координатор: **PASS** owner assignment → сотрудник «В работе» → refresh → «Выполнено» → refresh; audit содержит оба события. Evidence worker-task-completed.png, browser журнал |
| Каталог/темы/SaaS active nav | Каталог min-width image вылезал из grid card, auto rows разводили baseline; light brand/header плохо читались; Overview platform оставался active на любых hashes. Реализованы scoped grid/rows/copy, существующие light brand assets с reduced-motion/compact override, один active known platform hash | Исходники и финальные screenshots просмотрены архитектором: owner-products-light-final.png — **visual GO**, карточки/изображения/кнопки не пересекаются, бренд/header/warning читаемы | Координатор: desktop1280/1440, SaaS health/settings ровно1active+aria-current, refresh PASS, platform-navigation-fixed.png. Reduced-motion подтверждён source контрактом, live эмуляция не заявляется; mobile/Fold не выполняются |

Эти локальные регрессии не означают, что каждая строка общей матрицы уже получила UI/PG PASS. Финальный журнал координатора должен отделять actual browser, real HTTP/PostgreSQL и VM проверки.

Финальный compatibility review обнаружил такой же bootstrap redirect для cleaner/security/technician/other_staff: server уже поддерживает их действующие operational sessions/own tasks/own report, а hall navigation ведёт в portal. Отдельно от D01 согласован и реализован допуск этих четырёх existing session roles и own-task link без новых API прав. Создание новых кадровых карточек остаётся без CRM credentials/passwordHash, их вход этим исправлением не активируется. Итог `scripts/local-employee-report-ui-qa.mjs` теперь **36 PASS**: прежние26 плюс actual bootstrap для8operational roles и отказ platform_owner/unknown_role. Четырём ролям не добавляются adminNavigationAllowed, tasks_manage/staff_manage или финансовые write права. Ранее ограничение строки D01 касалось первоначального seniors fix; оно не означает дополнительный grant в этом совместимом UI исправлении.

**Итог согласования архитектора:** GO по проверенному контракту scoped reads, fail503 products, личных финансов, графика API, Tasks маршруту без расширения прав и single-scroll dashboard навигации. Новые тесты и syntax/diff checks пройдены независимо; real PostgreSQL/browser прогоны ведёт координатор. **Visual GO** для финальных desktop catalogue light/layout screenshots после последней версии CSS/scroll fix; промежуточные изображения сохраняются как evidence дефекта. Фактический UI объём, оплата600руб, payroll draft60руб, persisted note/task и ограничения перечислены в `docs/qa/LOCAL_FULL_BROWSER_2026_10_01.md`. Полная матрица, mobile/Fold, live reduced-motion и внешние live интеграции не объявляются выполненными этим согласованием.

## Дополнительные обязательные цепочки и восстановление

1. Поставка → остаток/стоимость → премикс → техкарта → продажа → списание → COGS/прибыль → оплата поставщику. Ни один промежуточный повтор не создаёт двойное движение/расход.
2. Гость → бронь → заказ → скидка/bonus → частичная+полная оплата → закрытие → история гостя → KPI смены; даты относятся к timezone точки.
3. Новый сотрудник → role/scopes/PIN → вход → меню/задача → заказ → рабочее время → payroll draft/approve/pay → один расход → refresh/restart.
4. SaaS onboarding A/B → владельцы → точки → ограниченный admin → новый staff/venue до quota → превышение → plan/status update → действующая сессия пересчитывает доступ.
5. Потеря HTTP-ответа после сохранения: повторный click/retry не повторяет необратимое действие; UI сообщает «сохранено, список не обновился» отдельно от «не сохранено».
6. PostgreSQL недоступен: критичные finance/stock/session/tenant reads и writes не маскируются успешными демо-данными. После восстановления обновление страницы продолжает штатный сценарий.
7. Между двумя вкладками/пользователями: logout, role/venue change, stale form, simultaneous close/pay/stock depletion, pending state после ответа. Нет бесконечного spinner/observer loop.
8. Restart локального сервера/контейнера: fixture и обычные CRUD сохраняются; revoked sessions не оживают; каждый receipt отдельный; ошибка загрузки доступна через понятный retry.

## План исполнения и фиксация

- Координатор/data role готовит постоянную PostgreSQL local QA базу и seed manifest со счётчиками, checksum и способом повторного запуска без дублей. Изолированные разрушительные/миграционные тесты используют отдельную disposable QA-базу.
- API/runtime: существующие безопасные тесты из строки матрицы; не запускать исторические `local-*.ps1`/browser scripts вслепую на общей fixture, сначала прочитать target/auth/cleanup. Memory QA не заменяет PG-проверку.
- CUA: авторизация каждым типом роли, все видимые меню/вкладки/основные действия, screenshot desktop; минимум одна реальная CRUD-цепочка каждого модуля. Не использовать browser CLI вместо разрешённого browser session.
- Финальная запись для каждого ID: `API PASS/FAIL`, `PG reload PASS/FAIL`, `UI PASS/FAIL/NOT RUN`, точный test/скриншот, defect и commit/diff. Если функция внешнего сервиса проверена только mock/sandbox, это явно указывается.
- Gate: нет открытых P1 в проверенном объёме; regressions PASS; все наблюдаемые P2 либо исправлены, либо конкретно названы; синтаксис/diff/code-health; QA evidence не содержит секретов или данных production. Затем пользователь получает результат и ссылку на локальный стенд; commit/deploy выполняются последующим этапом.
