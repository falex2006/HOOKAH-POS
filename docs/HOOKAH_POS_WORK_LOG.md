# Hookah POS — локальный рабочий журнал

Документ относится только к Hookah POS. SaaS, сервер и production сюда не входят.

## 2026-10-02

- Проведён изолированный PostgreSQL QA-прогон: миграции, платежи, закупки, инвентарь, задачи, зарплаты, tenant/venue isolation и смены — PASS.
- Исправлена согласованность отчёта сотрудника со сводкой: учитываются фактические платежи за дату, включая частичные и платежи открытых заказов.
- В API смен имя открывшего доступно руководителю только в пределах того же venue/organization и скрыто от операционных сотрудников.
- Восстановлены вход и подписи всех операционных ролей; для них возвращён отдельный отчёт только по собственным оплатам и закрытым чекам.
- Source/dist синхронизированы для `portal.js`; локальные контракты роли, header, меню, дизайна и employee-report прошли.
- Responsive emulator прошёл 19 размеров на `/admin`, `/orders` и `/`, включая touch drawer и payment state.
- CRUD-контракт прошёл на одноразовом локальном сервере; при 401 notification observer теперь останавливается до очистки сессии.

## Правила следующей работы

- Работать только локально в Hookah POS.
- Не менять сервер, IP, production, закреплённые порты или Docker volume без отдельного разрешения.
- Не смешивать POS-коммиты с SaaS-файлами.
- Для изменений меню проверять структуру, одну раскрытую группу, маршруты, права, мобильность, клавиатуру и source/dist parity.

- Playwright QA стабилизирован локально: POS browser-скрипты принимают PLAYWRIGHT_EXECUTABLE_PATH; проверены sidebar preference QA и responsive emulator (19 размеров, 3 маршрута) на установленном Chromium 1243. Коммит d2de5cba.
- Повторный полный PostgreSQL-регрессионный прогон после Playwright-изменения: 
ode scripts/local-full-pg-regression.cjs — PASS; локальная disposable QA-среда, tenant/role/API цепочки без регрессий.
- Финальный локальный аудит POS: `node scripts/local-full-qa.mjs` — **173/173 PASS**. Синхронизированы scoped-role контракты с актуальными POS-маршрутами; каталог разрешён для `inventory_read` без расширения записи; API сотрудников возвращает календарные даты, email и `pinConfigured`, защищает системные роли, архивные записи и резервированные логины, отзывает сессии при переименовании и пишет аудит логина.
- Браузерная проверка: sidebar preference QA — PASS; responsive emulator — **19 размеров × 3 маршрута** (`/admin`, `/orders`, `/`) с touch drawer и отсутствием переполнения — PASS.

## 2026-10-05 — isolated role matrix fixture repair

- `scripts/role-api-matrix-runtime-qa.mjs` was failing before its zero-total finance assertions because it opened an order against a nonexistent synthetic table. The isolated memory test now reads the active venue, creates a venue-scoped zone and table through the authenticated API, then uses the returned table ID.
- `node --check scripts/role-api-matrix-runtime-qa.mjs` and `node scripts/role-api-matrix-runtime-qa.mjs` — PASS. The script owns and terminates its isolated memory server; no persistent DB was used. Focused code-health review found no blocker. Product code and business behavior were not changed.

## 2026-10-06 — acceptance #48 category restore boundaries

- Extended the existing isolated inventory hierarchy PostgreSQL suite with authenticated product-category restore coverage: `inventory` and `inventory_categories` writers, role/venue denial, malformed/missing/already-active IDs, inactive department/subdepartment parents, case-insensitive active-name conflict, active/archived list and PG readback, exact audit actor/data, and repeat-restore idempotency. Product behavior was not changed.
- `node scripts/local-full-pg-regression.cjs acceptance-48-inventory-subdepartment-restore-postgres-qa.mjs` — PASS, 158 authenticated API/PG checks. The runner-owned random `orders_qa_*` database was dropped; runner locks were absent; the exact auto-remove regression container was stopped and removed. The check remains isolated to local QA.

## 2026-10-06 — acceptance #48 department archive guard

- Extended the existing authenticated department boundary suite with an active synthetic category under a manager-created department. The API returns `409 inventory_department_in_use`; PostgreSQL and the fresh active list remain unchanged, and no department-archive audit is emitted. After deleting only the synthetic category fixture, the same department archives successfully as a positive control.
- `node scripts/local-full-pg-regression.cjs acceptance-48-inventory-department-boundaries-postgres-qa.mjs` — PASS, 149 authenticated API/PG assertions. The runner-owned random `orders_qa_*` database was dropped; locks were absent; the exact auto-remove regression container was stopped and removed.
