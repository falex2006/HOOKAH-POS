# Исключения и миграционные отклонения UI

Версия **UI contract 1.0 · 2026-10-09**, UI-01.1. Владелец реестра — `design_lead`; route/shell/security решения подтверждает `system_architect`. Основание: [STANDARD](STANDARD.md), [каталог](COMPONENT_CATALOG.md), [токены](../../../DESIGN_TOKENS.md), [правила страниц](../../../VISUAL_PAGE_RULES.md).

«Предметный вариант» — намеренно сохранённое поведение; «миграционный долг» — обнаруженное расхождение, которое нельзя распространять на новые страницы; «отложенная проверка» — результат неизвестен. Запись не выдаёт права доступа и не подтверждает визуальную приёмку. У каждого исключения есть владелец и условие закрытия.

| ID / статус | Область и исключение | Причина / ограничение | Владелец / этап | Условие удаления или пересмотра |
|---|---|---|---|---|
| EX-01 · геометрия закрыта UI-04.2, предметный wizard сохранён | C12 бронь: прежняя форма и три шага монтируются в C11 shared medium640px; sticky head/footer, scroll body | 98 final кадров и focused/API QA подтверждают bounded geometry, draft/error/pending, stable CTA focus после GET. Draft только текущего DOM/render; durable reload draft не обещается. Гость/место/депозит и финансовые handlers сохраняются | frontend_engineer + design_lead + system_architect; UI-04.2 принят scoped | PIN/mixed stack UI-04.3, финансовые окна UI-07.1 отдельно. Трёхшаговое поведение пересматривать только по продуктовому основанию |
| EX-02 · предметный вариант | C09/C10 персонал: выбранная таблица сохраняет 5 колонок с локальным horizontal scroll; явный «Список» доступен отдельно | Пользователь осознанно выбрал table; принудительное превращение в карточки отменяло бы preference. Cards/list/table и cardScale не являются правами или настройкой колонок. `/orders` сохраняет свой существующий узкий card-вариант | design_lead + frontend_engineer; UI-08.1 | Сохранить при миграции; удалить только после принятого изменения модели видов и проверки preferences/доступности |
| EX-03 · PIN stack закрыт scoped UI-04.3; прочий legacy долг | C11 ordinary/mounted формы UI-04.2 и C18 native PIN UI-04.3: DOM/drafts/pending сохраняются, общий scroll lease, focus/identity/epoch guards |36finalpairs108refs и source/VM/real API scoped QA; legacy portalAction/POS/catalog/payment формы не объявляются мигрированными. Tall PIN card scroll/settings overflow и классификация старых notices остаются долгом | frontend_engineer + system_architect + security_reviewer; UI-04.3 scoped GO | Финансовые окна UI-07.1, mobile/Fold UI-10.1 и остальные legacy migrations отдельно; full security acceptance не заявлена |
| EX-04 · миграционный долг | C03–06 и все темы: старые размеры/aliases/локальные hex, неполная светлая карта | Два существующих режима нельзя свести к dark-only; новая `--ui-*` карта пока документальная. CSS-declaration не является замером hit-area или контраста | frontend_engineer + visual_auditor; UI-02.1/02.2 | Объявлены обе семантические карты, потребители перенесены, измерены реальные пары и цели; legacy aliases удалены после проверки потребителей |
| EX-05 · сохранённый бренд + миграционный долг | C17: градиент в существующих акцентах, lockup, staff fine-pointer курсоры, company pulse 8с; anchored inventory/legacy modals сохраняют свои состояния; platform modal анимацию не наследует | Anchored editor и portalAction окна ещё не прошли общий C11 lifecycle migration. Company action имеет явный статический override. Platform сохраняет прежнюю border/surface группу и outline, но animation declaration снята с platform selector; platform.css уже задаёт animation:none | design_lead + frontend_engineer; UI-02.2/08.3 | Согласованные брендовые места сохраняются до отдельного решения; sweeps убрать при migration каждого C11 consumer; подтвердить contrast/focus/reduced-motion и fallback cursor |
| EX-06 · предметный вариант | C15 POS: выбранный заказ остаётся постоянной рабочей панелью рядом с очередью/залом по доступному месту; плотность плиток 70–130%/«Вместить» | Частое редактирование заказа требует видимого контекста, правило «список прежде формы» не скрывает рабочий заказ. Реальные данные имеют приоритет; произвольное число столов не обязано помещаться без прокрутки | design_lead + frontend_engineer; UI-05.1 | Сохранить после проверки читаемости/перекрытия; пересмотр только с полным сценарием заказа и сохранением пользовательской плотности |
| EX-07 · граница контура | C01/C18 `/platform` и login/PIN сохраняют собственный состав навигации/поверхность; employee и management shell различают действия | Общий язык компонентов не объединяет SaaS и venue права. Контракт двух тем относится к CRM/POS, не обещает новый theme toggle каждой отдельной поверхности. Кандидат sidebar 210px не заменяет adaptive management sidebar | system_architect + design_lead; UI-03.1/08.2/08.3 | Пересмотр только с route×role и подтверждением контуров; визуальные различия, обусловленные задачей, сохраняются |
| EX-08 · отложенная проверка | Fold/mobile новая компоновка и полная приёмка вне desktop-этапов | UI-01.1 приоритет 1366×768/1920×1080/фактический viewport. Существующие обычные узкие сценарии сохраняются; физические пиксели устройства не равны CSS viewport | responsive_specialist + qa_engineer; UI-10.1 после UI-09.3 и отдельного запроса | Реальный CSS viewport/масштаб/ориентация и screenshots зафиксированы, выполнены сценарии; до этого не заявлять Fold PASS |

Связанное ограничение брони: действующая предметная спецификация отмечает зависимость выбора места от `/api/floor` и гостей от `/api/clients`. Роль с одним permission `reservations` может не получить вспомогательные данные. UI-01.1 это не исправляет, новые selector endpoints не считаются существующими; владельцы — system_architect/backend_engineer, описание — route×role. Аналогично server permissions не выводятся из demo defaults.

Новые исключения записываются до реализации с ID компонента, воспроизводимым сценарием и условием закрытия. Если после подэтапа долг остаётся, обновляется evidence и следующий владелец; нельзя закрыть его одним чтением CSS. UI-01.1 не объявляет ни один непроверенный визуальный сценарий PASS.


## EX-06 — подтверждён scoped UI-05.1

Постоянная панель выбранного заказа сохранена; unselected compact340px при1181–1320 и380px выше1320 только floor-view. Контроль10 плиток помещается1366×768/1920×1080 обе темы. Actual1280×720 management показывает честную подсказку о прокрутке; long orders/prep и390px narrow тоже прокручиваются. Density70–130/persist/fit,HH:MM/equipment/accessible names сохранены. Не обещается initial viewport fit произвольного числа столов.

Смежный миграционный долг light catalog search/flow-note, pale queue heading и narrow dark sticky strip остаётся у frontend/design. PIN current DOM/unlock/readback проверен, overlay screenshot отсутствует из-за инструмента; immutable UI-04.3 приёмка сохранена. Fold/UI-10.1 отдельно. Подробности и условия следующей приёмки — [UI-05.1 RESULT](UI_05_1_RESULT.md).


## UI-05.2 — сохранённые границы

Финансовые guest/reservation editors, PIN full reacceptance, Fold/UI-10.1 и delivery detached GET исключены из scoped list migration. Task/reservation empty-copy и local theme boot debt владельцы frontend/architect; условия закрытия — отдельные актуальные context/late-response и two-theme boot сценарии. Empty response fixtures и real PG readback не смешиваются. Universal header/list factories — отдельный вопрос архитектуры при необходимости. [RESULT](UI_05_2_RESULT.md).


## UI-06.1 — сохранённые границы

Anchored product editor, recipe wizard и native directory editors остаются прежними. CAT lifecycle и вторичные loaders требуют отдельной domain/QA приёмки; full migration не заявлена. Readonly empty-copy, theme boot denied, omitted PATCH defaults, inherited tobacco regex и below-fold coverage остаются долгом профильных владельцев. Закрывать отдельной правкой и актуальным source/browser/role доказательством; [RESULT](UI_06_1_RESULT.md).


## UI-06.2 — зарегистрированный долг

На 390px унаследованный `.portal-main max-width:calc(100vw - 68px)` оставляет около78px справа. Владелец: system_architect/frontend оболочки; устранить и проверить в UI-10.1. Auto-order initial create enabled до GET безопасно остановлен checked.length guard; readonly quantity inputs допускают локальный несохранённый ввод при отсутствии submit и server403. Владелец inventory frontend; заменить static/disabled и отключить initial action в отдельной polish-задаче с повторной визуальной проверкой. Это не новые права записи.


## UI-07.1 — границы critical acceptance

Forced venue/order/individual rights during pending покрыты actual-source VM; actual session loss и суммы — IAB/API/PG. QA/system_architect дополняют реальные комбинации до production release. Movement API ambiguous retry без idempotency, payment tab-memory keys и прежний refund intent storage не расширены; finance/warehouse owners принимают новый протокол отдельно. Полный Edge/WCAG/Fold/PIN и соседние financial screens исключены. Narrow zone toast может временно закрывать CTA; shell owner/UI-10.1 должен проверить размещение. Final checkbox18×20 находится внутри44px label; высота подтверждена real DOM. Исторические pending/error/role снимки имеют прежние SHA, final visual толькоv8. Подробности — [UI_07_1_RESULT.md](UI_07_1_RESULT.md).

## UI-09.1 — scoped desktop acceptance boundaries

Полная Cartesian role×route×state×theme×size и WCAG/Edge/OS reduced-motion/system cursor приёмка не выполнена: [RESULT](UI_09_1_RESULT.md), [explicit matrix](acceptance/ui091/coverage-matrix.json). Owner actual598×764 обе темы/34surfaces и platform targeted отдельно; narrow390 только smoke, legacy platform width и POS header/menu overlap остаются UI101 shell debt. Compact typography, light POS secondary nav, hash layout scroll, readonly inventory affordances, native validation/PIN/financial permutations и prior security findings требуют своих владельцев frontend/design/architect/backend перед production release. Семантические readability fixes и platform stale-error retry проверены. Старые QA helper role-* доказательства отвергнуты; не основание закрывать матрицу.
