# Матрица маршрутов и ролей HOOKAH POS

Контракт **UI-01.1 v1.0 · 2026-10-09**. Владелец: `system_architect`. Область: карта страниц, вложенных представлений, ролей и существующих ограничений. Это документальная сверка исходников, без изменения маршрутов, прав, API, БД или продуктового JS/CSS.

## 1. Версия и источник истины

- Локальный HEAD: `802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf`; рабочее дерево содержит существовавшие до UI-01.1 изменённые и untracked файлы, включая `server.js`, `portal.js`, `app.js`, `portal-session.js`, `effective-permissions.js` и `SITE_TREE.md`.
- Свежий `origin/main`: `2e6f557934fe29a9a227dda73277f6c3f99af939`. Совпадение отдельных контрактов с этим SHA не означает равенство всего локального дерева, `dist` или production. HTTP и браузер production в этом этапе не проверялись.
- Аудит [AUDIT.md](AUDIT.md) на `2786addedc26ed5afa44e19dc5fa8a225403d4b4` — историческое основание; строки из него не применяются вслепую.
- [SITE_TREE.md](../../../SITE_TREE.md) и [site-map.json](../../../site-map.json) — актуальный реестр; эта матрица уточняет доступ. [VISUAL_PAGE_RULES.md](../../../VISUAL_PAGE_RULES.md) и [DESIGN_TOKENS.md](../../../DESIGN_TOKENS.md) определяют оформление. Прежняя `SITE_MAP.md` не заменяет эту сверку.
- Доказательства ниже — чтение исходников. PASS документации не является PASS сценария с реальной сессией. Демонстрационные данные и режим `AUTH_REQUIRED != true` не доказывают рабочий RBAC.

Опорные исходники: [server.js](../../../server.js) — `staticFile`, `rolePermissions`, `scopedPermissionMap`, `denyUnless`, `notificationAccess`; [effective-permissions.js](../../../effective-permissions.js) — `createPermissionResolver`; [portal-session.js](../../../portal-session.js) — `canAccessRoute`, `install`; [portal.js](../../../portal.js) — `adminSectionTitles`, `focusedAdminDashboardHashes`, `inventorySections`, `normalizeEmployeeSidebar`, финансовые представления; [app.js](../../../app.js) — `staffCanWork`, `setStaffWorkspaceView`; [platform.js](../../../platform.js) — `verifyRole`; [nginx/default.conf](../../../nginx/default.conf) — нормализация слеша. Символы надёжнее исторических номеров строк.

## 2. Роль, разрешение и оболочка

Серверный `rolePermissions` содержит **13 базовых ролей**: `owner`, `admin`, `manager`, `developer`, `bartender`, `hookah_master`, `senior_bartender`, `senior_hookah_master`, `cleaner`, `security`, `technician`, `other_staff`, `platform_owner`. Имена пользовательских ролей не добавляют новые системные роли.

| Группа в таблицах | Базовые роли | Серверный профиль по умолчанию |
|---|---|---|
| O | `owner` | Полный набор заведения; защищён от переопределения; редактор ролей только владельцу |
| A | `admin` | Полный операционный набор заведения; редактор ролей владельца не разрешён |
| M | `manager` | `floor`, `orders`, `reservations`, `inventory_read`, `finance_read`, `staff_view`, `tasks_manage`, `settings`, `loyalty` |
| D | `developer` | `floor`, `orders`, `reservations`, `inventory_read`, `finance_read`, `staff`, `staff_manage`, `staff_view`, `tasks_manage`, `settings`, `diagnostics`, `integrations`, `delivery` |
| B/H | `bartender`, `senior_bartender`, `hookah_master`, `senior_hookah_master` | `floor`, `orders`, `finance_read`; соответственно `bar_tasks` или `hookah_tasks` |
| C/S/T/X | `cleaner`, `security`, `technician`, `other_staff` | Только `finance_read` |
| P | `platform_owner` | `platform`, `diagnostics`, `settings`; отдельная SaaS-оболочка, без доступа в tenant-портал |

**`staff` — legacy/demo имя**, принимаемое frontend allowlist и плоской оболочкой, но отсутствующее в текущем серверном `rolePermissions`. Не считать его четырнадцатой серверной ролью или гарантированным рабочим доступом. В `portalBasePermissions` demo также есть `orders/floor` у C/S/T/X; реальные сессии берут `permissions` из `/api/session`, поэтому demo не является эталоном ограничений этих ролей.

`permissionScopes` редактора — направления, а `permissions` сессии — конкретные возможности. Например, scope `orders` разворачивается в `orders + floor`; `finance` — в `finance + finance_read`; `inventory_categories` — в `inventory_categories + inventory_read`; `staff` — в `staff + staff_manage + staff_view + staff_sensitive + tasks_manage`.

Действующая политика resolver: owner/platform_owner сохраняют защищённые базовые права; активная пользовательская роль заменяет персональный список, непустой персональный список заменяет базовый. Системное переопределение ограничивает выбранный список сверху. Пустая активная пользовательская/системная роль не равна отсутствию настройки. При отсутствии настроек сохраняются точные серверные defaults, а не более широкие defaults редактора. `bar_tasks/hookah_tasks` возвращаются только при наличии `orders`; `diagnostics` наследуется базовой ролью только при наличии `settings`.

Поэтому таблицы ниже описывают **default real-session profile**, а окончательный доступ определяется подтверждёнными сервером permissions, ролью, tenant-контекстом и API-проверкой конкретного действия. `dashboard` в портале — маркер оболочки, не бизнес-разрешение. `mode: admin` в JSON — семейство HTML-шаблона, не запрет сотруднику. O/A/M/D используют управленческое меню; B/H и C/S/T/X — плоское рабочее меню, даже при дополнительных правах; P — отдельный SaaS-контур.

## 3. Четырнадцать страниц: route × default role

`Да` = вход в рабочую страницу разрешён при базовом профиле; `Нет` = не разрешён; `Оболочка` = общий портал открыт, данные и действия отдельно ограничены; `Личные` = собственные оплаты текущего дня; `Вход` = публичная форма авторизации. Это не разрешение на все действия страницы.

| Канонический адрес | Условие | O | A | M | D | B/H | C/S/T/X | P |
|---|---|---|---|---|---|---|---|---|
| `/` | `staffCanWork`: `floor AND orders` | Да | Да | Да | Да | Да | Нет | Нет |
| `/login` | Публичная форма | Вход | Вход | Вход | Вход | Вход | Вход | Вход |
| `/admin` | Подтверждённая tenant-сессия и frontend allowlist; hash проверяется отдельно | Оболочка | Оболочка | Оболочка | Оболочка | Оболочка | Оболочка | Нет |
| `/orders` | `orders` | Да | Да | Да | Да | Да | Нет | Нет |
| `/clients` | `orders OR staff OR staff_view` | Да | Да | Да | Да | Да | Нет | Нет |
| `/reservations` | `reservations`; зависимости формы см. §7 | Да | Да | Да | Да | Нет | Нет | Нет |
| `/delivery` | `delivery` | Да | Да | Нет | Да | Нет | Нет | Нет |
| `/inventory` | `inventory_read` | Да | Да | Да | Да | Нет | Нет | Нет |
| `/finance` | `finance_read`; роль ограничивает представление | Да | Да | Да | Да | Личные | Личные | Нет |
| `/finance/categories` | `finance` | Да | Да | Нет | Нет | Нет | Нет | Нет |
| `/finance/report` | `finance_read`; API ограничивает сотрудника текущим днём | Да | Да | Да | Да | Личные | Личные | Нет |
| `/integrations` | `integrations` | Да | Да | Нет | Да | Нет | Нет | Нет |
| `/network` | `settings`; API и организация определяют данные/действия | Да | Да | Да | Да | Нет | Нет | Нет |
| `/platform` | frontend `role === platform_owner`, API `platform` | Нет | Нет | Нет | Нет | Нет | Нет | Да |

Базовые M/D имеют чтение финансов и склада, но не `finance`/`inventory`. Просмотр не означает проведение документов, зарплаты или доступ к чувствительным полям. У `/clients` финансовые поля и ledger требуют отдельных возможностей (`finance`, `loyalty`, `staff_manage` в соответствующих обработчиках). У `/admin#staff` чтение каталога не даёт `staff_manage`/`staff_sensitive`; API также проверяет целевую роль сотрудника.

## 4. Семь inventory views и payroll

Все inventory views находятся в одной `/inventory`, используют входной `inventory_read` и сохраняются в URL. Отсутствующее или неизвестное `view` нормализуется к `stock`. Defaults по ролям у всех семи такие же, как у `/inventory` в §3; разрешения действия могут отличаться.

| URL | Группа меню | Содержание и дополнительная граница |
|---|---|---|
| `/inventory?view=products` | Меню | Каталог товаров; запись по `inventory` |
| `/inventory?view=recipes` | Меню | Технологические карты; запись по `inventory` |
| `/inventory?view=stock` | Склад | Остатки; запись по `inventory` |
| `/inventory?view=auto-orders` | Склад | Пополнение; операции проверяют `inventory` |
| `/inventory?view=movements` | Склад | Документы/операции — внутренние переключатели, запись `inventory`; сторно документа дополнительно `finance` |
| `/inventory?view=premixes` | Склад | Заготовки/премиксы, производство по `inventory` |
| `/inventory?view=directories` | Склад | Цех → подцех → категории; `inventory_categories` даёт отдельные операции жизненного цикла категорий, не полный склад |

`/finance#payroll` — **одна hash-область существующей финансовой страницы**, не пятнадцатая страница. Вход/ссылка проверяют `finance_read`; `/api/payroll/rules`, `/api/payroll/entries` и изменение зарплаты требуют `finance`. O/A по умолчанию могут работать с зарплатой; M/D могут попасть в финансовую оболочку по ссылке, но payroll API запрещён, а зарплатный реестр создаётся только при `finance` и неоперационной роли. Операционные B/H и C/S/T/X в финансовом рендерере получают собственные оплаты сегодня и ранний выход, включая payroll hash. Наличие hash не отменяет это ограничение. Без БД расчётные записи возвращают `payroll_requires_database`.

## 5. Пятнадцать admin hashes

Набор сверен одновременно с `adminSectionTitles` и `focusedAdminDashboardHashes`. Корневой `/admin` без hash не входит в число 14. В таблице перечислены группы с доступом при default-профиле; P исключён из tenant-портала во всех строках.

| Адрес | Page gate / базовые группы | Дополнительная граница |
|---|---|---|
| `/admin#staff` | `staff OR staff_view`: O/A/M/D | Чтение списка; изменение/чувствительные поля и целевая роль проверяются API |
| `/admin#staff-schedule` | `staff_schedule`: O/A и роли, которым владелец выдал отдельный scope | Недельный план смен; POST/DELETE требуют `staff_schedule`, чтение допускает также `staff_view`; плановые смены не смешиваются с фактически отработанным временем |
| `/admin#permissions` | Только `role === owner`: O | `role_editor` — frontend predicate, не отдельный серверный permission; API ролей owner-only |
| `/admin#tasks` | `orders OR tasks_manage`: O/A/M/D/B/H | При отсутствии `staff_manage/tasks_manage` только свои задачи, изменение статуса; не кадровое управление |
| `/admin#loyalty` | `loyalty`: O/A/M | Отдельное право лояльности; не равно чтению гостей |
| `/admin#shift-control` | `orders OR floor`: O/A/M/D/B/H | Чтение и действия смены проверяются API; уведомление может вести на этот hash |
| `/admin#settings` | `settings`: O/A/M/D | Центр настроек; доступ к конкретному действию не следует из наличия карточки |
| `/admin#company` | `settings`: O/A/M/D | Изменение идентичности заведения дополнительно ограничено O/A/D (`canManageVenueIdentity`) |
| `/admin#venue-layout-settings` | `settings`: O/A/M/D | Залы/столы; записи проверяют tenant и предварительное условие актуальной точки |
| `/admin#lock-security` | `settings`: O/A/M/D | Настройки безопасности; собственная PIN-блокировка сотрудника доступна отдельно в его шапке |
| `/admin#settings-dashboard-modules` | `settings`: O/A/M/D | Настройки главной и интерфейса; не выдача прав |
| `/admin#audit` | `settings`: O/A/M/D | Входной gate; сервер определяет доступные поля журнала |
| `/admin#diagnostics` | `diagnostics`: O/A/D | Диагностика не является правом изменения платформы |
| `/admin#notifications` | Оболочка: O/A/M/D/B/H/C/S/T/X | Открывает существующий колокольчик. Реальные события доступны только управленческим ролям и при правах категорий; операционным сотрудникам API запрещён |
| `/admin#help` | Оболочка: O/A/M/D/B/H/C/S/T/X | Справка. Кнопка перехода в теме показывается лишь при доступе к её маршруту; финансовая тема не ведёт операционного сотрудника в личные оплаты вместо финансового обзора. Текст вопроса копируется для ручной передачи управляющему; резервная копия сохраняется локально в `crm_help_feedback`. Автоматической отправки нет |

D15 устранён **в реестре**: `permissions`, `notifications`, `help` добавлены в `adminSubroutes`. Код уже поддерживал эти адреса; расширения прав или маршрутов не было. Доступ к `#notifications` как hash-оболочке не является доказательством доступа к данным центра. `notificationAccess` в реальном auth-режиме проверяет роль O/A/M/D и возможности конкретных категорий (`finance_read`, `orders`, `inventory_read`).

## 6. Алиасы, параметры и сохранение контекста

У каждой из 14 `entries` в JSON есть внутренний `file`. `server.js:staticFile` возвращает 308 с `/<file>` на `path`, сохраняя query: `/index.html` → `/`, `/admin.html` → `/admin`, `/finance-categories.html` → `/finance/categories`, `/finance-report.html` → `/finance/report`; остальные по тому же явному соответствию. Hash обрабатывается браузером и серверу не передаётся. `nginx/default.conf` нормализует вложенный trailing slash через 308; `/` сохраняется. Прямой Node static handler нормализует путь для выдачи файла — это не самостоятельное доказательство nginx-редиректа в развёртывании.

`/?view=orders` — рабочая очередь внутри `/` при `floor AND orders`; при `orders` без `floor` сотруднику предлагается `/orders`. Это разные представления уже существующих страниц, не новые страницы. Возврат из `/admin` на `/` с `mode`, inventory `view`, параметры контекста `venue/venueId/workspace` и ссылки брони `tableId/reservationId/action=seat` не расширяют права. Query никогда не является доказательством права на чужое заведение: серверный session/tenant остаётся обязательным.

`#settings` остаётся самостоятельным центром настроек; `#company` и `#settings-dashboard-modules` — сфокусированные разделы, а не HTTP-алиасы. Иные финансовые якоря (`expenses` и внутренние секции) не прибавляются к числу страниц или отдельному payroll workspace. API `/api/*`, файлы JS/CSS и папки публикации `dist/*/index.html` не считаются страницами навигации.

## 7. Связка UI → API → права → повторное чтение

Ниже зафиксированы существующие точки интеграции для последующих UI-пакетов. Это не повторная функциональная приёмка API. Полные формы данных задаются обработчиками; менять их при визуальной миграции запрещено без отдельного согласованного пакета.

| UI/действие | API и данные | Права / контекст | Сохранение и повторное чтение | QA-статус UI-01.1 |
|---|---|---|---|---|
| Вход в portal route | `GET /api/session` → `user`, `permissions`, `permissionPolicy` | Подтверждённая сессия, пользователь и точка | Gate проверяется до загрузки `portal.js`; смена подписи сессии вызывает reload | Код: `portal-session.js`; runtime не запускался |
| `/admin#permissions`, системная роль | `GET /api/staff/system-roles`; `PATCH /api/staff/system-roles/:role` с `permissionScopes[]` | Только owner, валидные organization/venue; owner не редактируется | `system_role_permission_overrides`; повторный GET и обновление сессии | Код: `server.js:systemRolePath` |
| `/admin#permissions`, пользовательская роль | `GET/POST /api/staff/roles`, `PATCH /api/staff/roles/:id`; `name`, `description`, `permissionScopes` | Только owner, organization/venue; БД обязательна | `custom_staff_roles`; перечитывание списка и session permissions | Код: `server.js:customStaffRolePath` |
| `/admin#tasks`, статус | `GET /api/tasks`; `PATCH /api/tasks/:id` с `status` | Page gate: `orders OR tasks_manage`; API: `orders OR staff_view OR staff_manage OR tasks_manage`; собственные задачи без прав управления | Сохранённая задача, повторный GET; персонал не открывается автоматически | Код: task handlers |
| `/admin#notifications`, прочитать | `GET /api/notifications`; `PUT /api/notifications/:id/read`; `POST /api/notifications` — прочитать все | `notificationAccess`, пользователь/точка | Read state; повторный GET, счётчик и BroadcastChannel | Код: notification handlers; операционный запрет сохранён |
| `/admin#help`, вопрос | API отправки нет; текст вопроса копируется в буфер обмена | Доступная справочная оболочка | `localStorage.crm_help_feedback`, максимум 20 записей; пользователь передаёт текст управляющему сам, при запрете копирования текст остаётся выделенным | Код: help feedback listener |
| `/finance#payroll`, начисление/переход | `GET/POST /api/payroll/entries`; `PATCH /api/payroll/entries/:id` с `action`, для pay `paymentDate`, cancel `reason`; создание: `userId`, `ruleId`, `periodFrom`, `periodTo` | `finance`, venue, БД; UI-вход не заменяет эти проверки | `payroll_entries`, при выплате связанный расход; повторный GET | Код: payroll handlers; расчёт/выплата не выполнялись |
| Бронирование, зависимые селекторы | Локальный и текущий upstream renderer читают `/api/clients`, `/api/floor`; потом `/api/reservations` | Вход `reservations` не гарантирует `orders/staff/staff_view` и `floor` для зависимостей | API сохраняет бронь; список перечитывается после сохранения | Код; сценарий роли только с `reservations` не принят |
| Зарплата, выбор сотрудника | Текущий renderer использует `/api/staff` вместе с payroll API | `finance` не гарантирует API-чтение сотрудников: `staff OR settings OR staff_view` | Список сотрудников зависит от своего endpoint | Код; роль только с `finance` не принята |

Для будущих UI-миграций обязательны отдельные состояния проверки доступа, загрузки, пустого результата, запрета и ошибки сервиса; успешная запись подтверждается ответом и повторным чтением. В частности, portal gate показывает проверку/повтор/denied, 401 завершает сессию, отсутствие БД payroll — ошибка возможности, а не пустая успешная зарплата. UI-01.1 не утверждает, что все остальные формы уже полностью соблюдают единый контракт состояний.

## 8. Выявленные расхождения и границы приёмки

| Наблюдение | Решение UI-01.1 / следующий владелец |
|---|---|
| D15: 11 hashes в JSON против 14 в коде | Реестр дополнен тремя существующими hash. Владелец `system_architect`; документальный критерий закрыт |
| Demo/legacy `staff` и C/S/T/X не совпадают с серверными defaults | §2 отделяет эти режимы. `system_architect` + backend/security при следующем изменении ролей; права в этом этапе не исправляются |
| Payroll ссылка по `finance_read`, данные по `finance`; сотрудник получает собственные оплаты | Записаны оба уровня, без ложного обещания зарплаты читателю. Frontend/backend сверяют UX при финансовом пакете UI-07.2 |
| `#notifications` проходит shell gate, API блокирует операционные роли | Документировано как разные уровни доступа; shell/API не переопределены. `system_architect` + frontend/QA при UI-03.2 |
| SITE_TREE ранее заявлял реализованные `/api/reservations/guests` и `/api/payroll/employees` | На локальном дереве и `origin/main` `2e6f557` их нет; также нет `/api/reservations/tables`. Сохранено как историческое требование, фактические зависимости описаны в §7. Backend/security + `system_architect`: отдельная сверка ограниченных селекторов; не блокирует инвентаризацию, не считается принятым сценарием |
| D03: правило аккордеона user+venue против существующего хранения и поиска | SITE_TREE задаёт целевое правило, реализация принимается отдельно в UI-03.2; UI-01.1 не выдаёт его за исправленный код |
| Грязное локальное дерево отличается от опубликованной базы | Сверены контрактные источники; не выполнялись merge, reset, source/dist sync, релиз или production QA |

Приёмка этой матрицы: JSON разбирается; каждый канонический адрес соответствует `staticFile`; набор 7 views совпадает с `inventorySections`; набор 14 hashes совпадает с обоими перечнями portal; payroll и алиасы явно описаны; роли сверены с серверным `rolePermissions`, ограничения — с gate/resolver/API. Продуктовые тесты, браузерные роли, изменения данных и сквозные выплаты в документальном UI-01.1 не выполняются. Команды и фактический результат сверки передаются координатору для PROGRESS/WORK_LOG.

Статическая сверка 2026-10-09: **PASS** — 14 страниц, 7 inventory views, 14 admin hashes, 13 серверных ролей; маршруты, views, оба набора hash и базовые permission-массивы совпали с текущим `origin/main`. Отсутствие трёх selector endpoints подтверждено в локальных и upstream `server.js`/`portal.js`. Это сравнение извлечённых деклараций и документации, без запуска приложения. `git diff --check -- SITE_TREE.md site-map.json` завершён без whitespace-ошибок.

Совместимость реестра: `version: 1` и все прежние поля, кроме дополненного `adminSubroutes`, сохранены. `entries` и `inventoryViews` не изменены; `contract`, `financeSubroutes` и `canonicalization` добавлены как метаданные. Продуктовые browser/server runtime не читают JSON. `scripts/published-html-manifest.mjs` использует только неизменённые `entries` для manifest публикации; его потребители — синхронизация артефактов и проверки. `portal-effective-permissions-qa.mjs` также читает только `entries`; `site-structure-contract.mjs` сверяет страницы/views. `visual-page-rules-contract.mjs` проверяет наличие всех `adminSubroutes` в правилах — новая редакция должна включать `permissions`, `notifications`, `help`. Эти продуктовые проверки и синхронизация публикации в UI-01.1 не запускались.
