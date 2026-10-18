# UI-01.2 R2 — план дополнительных временных фикстур

Статус 2026-10-09: **EXECUTED AFTER GO_FIXTURES; API/DB VERIFIED**. Владелец подготовки `backend_engineer`; координатор разрешает исполнение отдельным `GO_FIXTURES` после исходных снимков. Продуктовые исходники, schema, CSS и существующие аккаунты/столы не изменены. Данные `empty` tenant сохраняются.

## Источник и изоляция

Проверены действующие API в byte-identical snapshot `tmp/ui012-baseline/source/server.js`, `order-preparation.js`, правила `backend_engineer`, workflow и принятая `ROUTE_ROLE_MATRIX.md`. Target: browser proxy `127.0.0.1:31952`, backend `31953`, PostgreSQL `31954`, БД `hookah_ui012`, отдельный контейнер `hookah-ui012-20261009`. Script проверяет private local config, нормальный proxy mode, `current_database()`, real PostgreSQL health, роль owner и совпадение session organization/venue до fixture mutation. Private credentials читаются только внутри процесса, не включаются в отчёт.

## UI → API → права → данные → повторное отображение

| Регион | Минимальная подготовка после GO | API/права | Сохранение и подтверждение | Ограничение |
|---|---|---|---|---|
| Stock / directories | Четыре ингредиента с длинными именами/поставщиками, нулевым остатком, cost=0; отдельные категории bar/hookah | `GET/POST /api/inventory/departments`, `/api/product-categories`; `POST /api/inventory/items`; запись `inventory`, чтение `inventory_read` | Повторные GET каталога и склада, реальные IDs | Движения/закупки не создаются; отрицательные/низкие статусы естественны при onHand=0 |
| Recipes | Два tracked продукта и связанные sale recipes с длинной технологией; ссылки на новые ингредиенты | `POST /api/products`, `/api/recipes`; `inventory` | `inventory_recipe_cards`; повторный `/api/recipes` | Старые non_stock продукты не перенастраиваются; no sale recipe для non_stock |
| Premixes | Две premix recipe metadata без product binding | `POST /api/recipes` с `recipeType=premix`; `inventory` | Повторный `/api/recipes`, отображение рецептуры заготовок | **Produced batch list не подготовлен**: выпуск требует stock production/movements и отдельного решения |
| Orders | Новый зал и шесть новых столов; три открытых неоплаченных заказа только на первых трёх новых столах; два non_stock товара на заказ | `POST /api/floor/zones`, `/api/floor/tables`; `POST /api/orders`, `/api/orders/:id/items`; owner с `floor/orders/inventory` | Orders/order_items; повторный `/api/orders` и floor | Старые восемь столов не меняются. Не закрывать/оплачивать/удалять заказ; historical closed list остаётся пуст |
| Preparation | Dispatch новых позиций отдельно на bar и hookah, по одной позиции каждой станции на заказ | `POST /api/orders/:id/dispatch` с `station,itemIds,expectedVenueId`; чтение `/api/preparation/queue`; `orders` плюс station permissions | `order_item_execution` queued; GET queue по роли | Bare order status не заменяет реальный dispatch; queued display подтверждается браузером |
| Shift prerequisite | Только если нет открытой смены: одна синтетическая смена openingCash=0 | `GET/POST /api/shifts`; `floor OR orders` | Повторный GET current shift | Не закрывается; финансовый ledger capture при close не выполняется |
| Reservations | Шесть будущих бронирований на трёх других новых столах, deposit=0, две персоны, длинные guestName/notes | `POST /api/reservations`; `reservations`; table/date/capacity validation | Реальные reservations, повторный GET с актуальным диапазоном дат | Никаких deposit receipts/seat/link-to-order; старые столы не используются |
| Finance | Текущие empty/list/header данные без фиктивных финансовых записей | Только действующие read endpoints по роли | Screenshot обычного пустого состояния | **Длинные transaction/expense labels не подготовлены**: для них потребовались бы финансовые мутации |
| Payroll | Текущий пустой/denied регион согласно реальным permissions | Read `/api/payroll/*` по настоящим правам | Ошибка/отказ отделены от empty | **Длинные payroll rules/entries не подготовлены**; payroll mutations не выполняются |

Значения name соблюдают лимит 120, recipe category 80, technology 4000, reservation notes 2000. Стоковая иерархия проверена: category должна существовать в том же department; script создаёт отдельные category metadata. Для приготовления используется explicit `preparationStation`; server создаёт item execution в `new`, затем dispatch переводит в `queued`.

## Команды и доказательства подготовки

```powershell
node --check tmp/ui012-baseline/new-long-fixtures.cjs
node tmp/ui012-baseline/new-long-fixtures.cjs plan
node tmp/ui012-baseline/new-long-fixtures.cjs --permissions
```

Первые две выполнены: syntax PASS, plan перечисляет только подготовленные действия. `--permissions` выполнен: real login → `/api/session` → logout для всех девяти временных аккаунтов, без fixture mutations. Снимок effective permissions и tenant contexts сохранён в `evidence/UI-01.2/r2/effective-permissions.json`; passwords/tokens отсутствуют. Эти API-сессии отдельны от браузерных; browser session/cookies не сбрасывались.

Исполнение выполнено один раз после сигнала координатора `GO_FIXTURES`:

```powershell
node tmp/ui012-baseline/new-long-fixtures.cjs --apply GO_FIXTURES
```

До явного сигнала координатора запускать его нельзя: исходные снимки сейчас снимаются на текущих данных. Proxy mode не менялся. Во время apply фиксируются path/method/status/payload/ID каждой fixture mutation в том же evidence JSON, а сохранённые entity IDs используются при продолжении после ошибки. Credentials и auth responses туда не записываются. Это ограниченная повторяемость temp fixture scaffolding, не утверждение об API idempotency. При неоднозначном lost response остановить и проверить реальную запись, особенно order item POST; не повторять автоматически.

После GO и реального исполнения координатор подтверждает GET списка, queue и бронирований, then screenshot visible labels. **Ни одна long-content ячейка не получает PASS только по подготовке скрипта.** Задача не требует полного regression suite и не публикует изменения. Последующий владелец browser evidence — координатор/QA; finance/payroll/batch/history omissions остаются явно непроверенными регионами.

## Результат исполнения R2

Фикстуры выполнены один раз; 43 успешные мутации: 37 HTTP201, 6 HTTP200 dispatch. Категории новых products совпадают с metadata категориями bar/hookah. API GET подтвердили новые stock/products/recipes/orders/reservations и шесть queued позиций preparation. Orders реально перешли в in_progress через dispatch. Существующие аккаунты и исходные восемь столов скрипт не изменяет.

Read-only PostgreSQL проверка подтвердила tenant всех 4 products, 4 ingredients, 4 recipes, 6 reservations, 6 tables и 3 orders. Payments, expenses, payroll_rules, payroll_entries, guest_account_entries, guest_deposit_receipts, reservation_pre_payment_receipts, order_refunds, stock_movements, inventory_premix_batches содержат 0 записей; closed orders и closed shifts также 0. Часовой пояс длинного tenant — Asia/Yekaterinburg; будущие даты брони UTCdate+1…6, время 19:30 local. Доказательства phase timestamp 2026-10-09T09:48:32.963Z, статусы, entity IDs и tenant checks сохранены в effective-permissions.json без credentials/tokens.

Proxy mode остаётся normal. Browser acceptance новых регионов ещё требуется; неподготовленные финансовые/payroll/batch/history регионы сохраняются.
