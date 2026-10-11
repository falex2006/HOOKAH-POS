# MT-01 — маршруты, общий каркас и границы темы

Дата: 2026-10-11. Владелец: system_architect. Baseline: `8ef9f147f0923ae73c854e1bdc5c3e3bb8cd5afe`.
Статус: каталог исходного кода; браузерная/серверная приёмка не выполнялась. Приложение, API и права не изменены.
Источники: `server.js:staticFile`, `portal-session.js:canAccessRoute`, `portal.js`, `header-shell.js`, `lock.js`, `staff-profile.js`, `ui-dialog.js`, `SITE_TREE.md`.
`site-map.json` используется как справочный индекс; актуальные условия ниже подтверждены текущим кодом.

## Маршрутная матрица

Права в таблице — существующий клиентский gate проверенной `/api/session`, не разрешение записи. Сервер остаётся источником прав.
«Включён» означает управленческий контекст владельца/администратора/управляющего и доступ по session gate. Операционный контекст того же URL исключён.
Роль developer и индивидуальные расширения операционной роли не считаются автоматическим согласием на управленческую тему; до решения владельца темы исключены.

| Канонический адрес / представление | Действующий gate / дополнительные ограничения | MT-01 и контроль |
| --- | --- | --- |
| `/admin`, пустой hash | Любая подтверждённая сессия; это не gate управленческой роли | Включён только управленческий контекст; `renderDashboard`, `#page-content`; не включать скрытые кадровые/зальные узлы |
| `/inventory`, `/inventory?view=stock` | `inventory_read`; запись проверяется отдельно | Включён; оба адреса — остатки, default `stock` |
| `/inventory?view=products`, `recipes` | `inventory_read`; действия имеют собственные gates | Включены меню/техкарты; значения `view` перечислены, новых маршрутов нет |
| `/inventory?view=auto-orders`, `movements`, `premixes`, `directories` | `inventory_read`; действия имеют собственные gates | Включены; `movements` содержит локальные «Документы» / «Операции», не `/operations` |
| `/finance`, `/finance#payroll` | `finance_read`; операции требуют отдельного права | Включены управленческие обзор/зарплата; сотруднический вариант исключён |
| `/finance/report` | `finance_read`; сотрудник получает ограниченный собственный отчёт | Включён только управленческий отчёт; дату/тип формы не объявлять новым URL |
| `/finance/categories` | `finance` | Включён |
| `/orders` | `orders` | Включён журнал в управленческом контексте; рабочая очередь `/?view=orders` исключена |
| `/clients` | `orders` ИЛИ `staff` ИЛИ `staff_view` | Включены гости в управленческом контексте; сотруднические поля/вариант исключены; отсутствие бонусов/депозита нормально |
| `/reservations` | `reservations` | Включены список и форма брони; таблицы/залы как выбираемые данные не разрешают оформление зальных диалогов |
| `/reservations?tableId=…` | Тот же gate; tableId-only открывает создание | Существующий deep link сохраняется; тематизация только формы бронирования, не окна стола |
| `/reservations?reservationId=…`, `action=seat` | Тот же gate; существующая запись / посадка; операции заказа имеют дополнительные права | Существующие query сохраняются; переход на рабочий зал исключён |
| `/delivery` | `delivery` | Включены управленческие список/редактор доставки; `renderDelivery` |
| `/admin#tasks` | `orders` ИЛИ `tasks_manage`; создание/редактирование UI: `tasks_manage` ИЛИ `staff_manage` | Включён управленческий вариант; личные поручения сотрудника исключены |
| `/admin#loyalty` | `loyalty` | Включена лояльность; `renderLoyalty` |
| `/admin#settings` | `settings` | Включён hub; ссылка на исключённый зал сохраняется, его формы не оформляются |
| `/admin#company` | `settings`; owner/admin UI имеет собственные ограничения | Включена карточка заведения `#company-form`; зальный блок внутри company исключён |
| `/admin#settings-dashboard-modules` | `settings` | Включены настройки интерфейса; видимость ссылок не отменяет разрешения |
| `/admin#lock-security` | `settings` | Включена страница настроек; общие lock overlay/lock settings dialog исключены до отдельного подтверждения |
| `/admin#audit` | `settings`; кадровые/журнальные данные имеют дополнительные gates | Включён управленческий журнал; не расширять видимость данных |
| `/admin#diagnostics` | `diagnostics`; renderer дополнительно owner/admin/developer | Включён только доступный owner/admin вариант; не обещать manager контент |
| `/admin#notifications`, `/admin#help` | Разрешены любой подтверждённой сессии на уровне route gate | Включены только управленческий контекст; колокольчик проверяется отдельно |
| `/integrations` | `integrations` | Включён текущий статус Telegram; `GET /api/integrations`, «Подключено»/«В разработке»/ошибка; формы подключения пока нет |
| `/network` | `settings`; мутации/выбор точки имеют отдельные серверные ограничения | Включены доступные список/форма/выбор; `renderNetwork`, `GET /api/network/venues` |
| `/operations` | Отсутствует в `staticFile` и `canAccessRoute` | Не существует как страница; «Операции» — `data-nav-group="operations"` |
| `/platform` | Отдельные `platform.js`, platform auth/API | Исключён до уточнения: самостоятельный платформенный контур, не тема заведения |
| `/`, любые `mode`/`operator`/`view`, `/login` | Рабочий режим / авторизация | Исключены полностью |
| `/admin#staff`, `/admin#permissions` | staff/staff_view; permissions — только owner | Исключены полностью, включая кадровые окна и профиль сотрудника |
| `/admin#venue-layout-settings` | `settings` | Исключены зал, столы, VIP, создание/правка/архив/восстановление и все их подтверждения |
| `/admin#shift-control` | `orders` ИЛИ `floor` | Управленческий контекст включён как фокус существующей карточки смены D03; сотруднический контекст и рабочая кнопка на `/` исключены |
| Неизвестный hash / `view`, прямые HTML-имена | HTML alias даёт 308 с query; неизвестный hash не гарантирует отдельного экрана | Не включать по fallback-заголовку «Главная»; whitelist, нормализация только существующего маршрута |

## Общий каркас: потребители и контракт

| Семейство | Реальные точки подключения | Сохранить / состояния / проверка |
| --- | --- | --- |
| Sidebar | `.portal-sidebar`, `.portal-nav a`, `.sidebar-nav-groups`, `details.sidebar-nav-group[data-nav-group]`, `#sidebar-menu-search`; `createSidebarNavigation`, `syncActiveNavigation` | Одна открытая группа; явное сворачивание; поиск; active `aria-current=page`, summary `aria-expanded`/`has-active-child`; группы по role/venue/user; deep link/back/forward/reload |
| Навигационный контекст | `sidebarRouteGroup`, `normalizeEmployeeSidebar`, `employeePortalRole`, `employeeOrdersRoute`; `view`, `mode`, `operator`, venue query | `mode` — представление, не авторизация; не терять существующий контекст при переходах; управление меню не добавляет права |
| Header | `.portal-header .header-context`, `.header-right`, `.header-user`, `[data-admin-section-title]`, `[data-venue-name]`, `[data-current-date]`; `header-shell.js`, `updateAdminSectionTitle`, `updateHeaderDate` | Venue из `GET /api/venue`, раздел из hash; длинное название; неизвестное/ошибка не подменяются актуальными данными; нормализация `data-shell-ready` идемпотентна |
| Смена в header | `.live-dot.header-shift-status`, `data-shift-state`, `role=status`, `aria-live=polite` | Loading → открыта/закрыта/«Статус смены недоступен»; источник API, не декоративный индикатор; рабочие кнопки смены исключены |
| Уведомления | `#notification-bell`, `#notification-count`, body `#notification-panel`, `#notification-panel-content`, `[data-notification-filter]`; `refreshLeaderNotifications`, `loadNotifications`, `closeNotificationPanel` | Доступ зависит от роли и разрешённых источников, не количества событий; `GET /api/notifications?limit=20&filter=…`; read API, фильтры, busy/error/retry/empty, Escape/возврат фокуса; desktop dialog `aria-modal=false`, не требовать modal trap |
| Общие lock/profile controls | `#lock-screen-button`, `.lock-settings-button`, `.header-user`, `.sidebar-profile`; `lock.js`, `staff-profile.js` | Кнопки доступны в общем каркасе, но `.staff-profile-modal`, `.screen-lock-overlay`, `.lock-settings-dialog` исключены; focus/имя/действие сохраняются |
| Session guard | `html[data-portal-access="checking"]`, `#portal-session-guard`, `[data-session-retry]`; `__portalSessionGate.refresh/block/canAccessRoute` | Checking/error/retry/denied/401; `GET /api/session`, token/storage/focus/visibility refresh; блокировка должна иметь приоритет над темой |
| Shared ordinary/action UI | `portalAction`, `portalConfirm`, `createPortalEditorScope`, `portalEditorIdentity`; `.modal.action-modal`, `.form-message`, `#portal-notice` | Label/description, Tab trap в action-modal, Escape/outside по существующему договору, focus return/fallback, invalid, cancellation, длинные формы; API success отдельно от результата ввода |
| Critical UI | `portalCriticalAction`, `portalCriticalContext`, `loadSharedUI` → `ui-dialog.js`, `[data-ui-dialog]`, `.ui-feedback` | Draft/intent, pendingClosePolicy=block, context/isCurrent, inert/scroll leases; смена tenant/user/role/route отменяет представление по договору без повторной записи |

## Безопасное включение темы: будущая реализация MT-03

1. Новый явный marker, например `[data-management-theme="mt"]`, не присутствует сейчас; название предложено, не объявлено внедрённым API.
2. Marker вычисляется по whitelist нормализованного pathname + известного hash/view + подтверждённой session + управленческого контекста. `.velora-theme`, `body[data-page=dashboard]`, `.ui-admin-pages` сами по себе недостаточны: они обслуживают исключённые экраны.
3. Рекомендуемый root для содержимого — отдельный разрешённый контейнер/панель, header/sidebar маркируются отдельно. Не ставить наследуемые переменные без ограничения на весь body: это затронет кадровые, зальные и lock/profile окна.
4. `/admin` меняет hash без reload и повторно рендерит `#page-content`. Перед сменой контекста снять marker; после session/route проверки установить заново. Сценарии admin → staff → permissions → venue-layout → company → admin обязательны.
5. `portal-session.js` может остановить `hashchange` через `stopImmediatePropagation` при denied. Нельзя полагаться только на поздний listener `portal.js`: при block/checking marker должен сниматься независимо, скрытый предыдущий экран не остаётся оформленным как доступный.
6. Учесть `popstate`, `pageshow`/bfcache, query view, session refresh/storage, смену venue/role и программу `history.replaceState` (она сама не порождает hashchange). Один центральный resolver вместо отдельных противоречащих флагов.
7. Body-mounted action-modal/notification-panel/ui-dialog/portal-notice не наследуют marker внутри `#page-content`. Добавлять marker только конкретному экземпляру после проверки инициатора/контекста; его стили/токены объявляются на этом экземпляре. Не использовать общий `body[marker] .modal`.
8. Происхождение окна важнее текущего адреса: даже на `/admin` или `/reservations` любое окно стола/зала, кадра/прав или staff profile исключено. Смешанные company/settings узлы требуют явного исключения, а не правила «все дочерние формы».
9. Перед повторным использованием persistent notification tray проверять новый контекст; при исключённом hash снять оформление tray/notice. При async completion не возвращать marker от старого контекста.
10. В MT-02 отдельный образец имеет собственный root и явно примерные данные. Его темы/скрипты не подключать к опубликованным страницам и не менять бизнес-маршруты.

## Проверки: найденные имена и недостающее покрытие

Имена ниже — существующие файлы `scripts/`, прочитанные как карта проверок; в MT-01 не запускались и не являются доказательством PASS.

| Область | Существующие проверки | Нужная проверка темы |
| --- | --- | --- |
| Route/nav/header | `sidebar-navigation-contract.mjs`, `sidebar-disclosure-runtime-qa.mjs`, `mode-navigation-contract.mjs`, `ui-navigation-context-contract.mjs`, `header-shell-contract.mjs`, `sidebar-venue-header-contract.mjs`, `admin-section-heading-contract.mjs` | Whitelist marker; active group/search/back/forward/reload; длинный venue/title; одно исключённое рабочее место |
| Admin/settings | `admin-company-route-contract.mjs`, `local-dashboard-navigation-qa.mjs`, `interface-preference-session-qa.mjs` | Hash transitions с teardown; скрытые staff/venue-layout узлы; denied hash со stopImmediatePropagation |
| Guests/tasks/reservations/delivery | `clients-editor-contract.mjs`, `client-form-race-qa.mjs`, `tasks-qa.mjs`, `reservation-wizard-qa.mjs`, `reservation-form-qa.mjs`, `delivery-ui-state-qa.mjs` | Управленческий/операционный контексты того же адреса; theme форма брони против исключённого floor dialog; ошибки/пусто/длинные значения |
| Finance/shared dialogs | `finance-role-browser-qa.mjs`, `finance-report-browser-qa.mjs`, `finance-load-race-qa.mjs`, `ui-dialog-lifecycle-contract.mjs`, `ui-dialog-mounted-form-contract.mjs`, `ui042-ordinary-editor-contract.mjs` | Provenance body dialog, focus/pending/context loss; сотруднический finance/report остаётся исключённым |
| Connected pages | `integrations-state-qa.mjs`, `integrations-scope-contract.mjs`, `network-load-state-qa.mjs`, `network-selection-qa.mjs`, `network-mutation-boundary-qa.mjs` | Loading/error/empty/retry/disabled, смена venue снимает старый контекст; placeholder Telegram не становится формой |
| Notifications/session | `notifications-browser-qa.mjs`, `notifications-api-qa.mjs`, `session-authority-qa.mjs`, `session-venue-contract.mjs` | Unread=0 не скрывает разрешённый bell; denied/no source; marker после logout/session expiry/tenant switch; notice от старого запроса |

Следующий владелец: coordinator + frontend (resolver/provenance), design lead (токены/каркас), QA (theme marker и отрицательные контрольные сценарии). MT-01 не принимает mobile/Fold и не заявляет доступность по результатам статического поиска.
