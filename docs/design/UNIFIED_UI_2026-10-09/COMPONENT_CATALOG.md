# Каталог компонентов HOOKAH POS

Версия **UI contract 1.2 · 2026-10-10**, UI-04.2 **ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**. Владелец каталога — `design_lead`; общего каркаса — `system_architect`; реализация — `frontend_engineer`; проверка — `qa_engineer`/`visual_auditor`. Реестр сохраняет существующие семейства и цели; opt-in фундамент UI-02.2 дополнен ограниченной миграцией окон. Миграция всех страниц ещё не выполнена.

Связанные документы: [STANDARD](STANDARD.md), [токены](../../../DESIGN_TOKENS.md), [правила страниц](../../../VISUAL_PAGE_RULES.md), [исключения](EXCEPTIONS.md), [route×role](ROUTE_ROLE_MATRIX.md). Право на действие приходит из реального контракта сессии/API; видимость кнопки не выдаёт новое право.

## Реестр

| ID / компонент | Текущая реализация и область | Обязательный контракт цели | Владелец / этап / исключение |
|---|---|---|---|
| C01 Shell | `.portal-sidebar`, `.portal-header`; POS `.staff-theme`; `/platform` отдельный контур | Один активный маршрут, согласованные контролы и порядок; контекст роли/точки; прокрутка меню независима; desktop обе темы | system_architect + design_lead; UI-03.1/03.2; EX-07 |
| C02 Page heading / toolbar | `.page-title`, `.panel-head`, фильтры страниц | Один заголовок, предметное пояснение при необходимости; одно главное действие; подписанные фильтры, стабильная геометрия при pending | design_lead; UI-02.2 и миграции страниц |
| C03 Button / icon button | `.button`, `.primary`, локальные кнопки POS | Default/hover/focus-visible/active/disabled/pending; цель ≥44×44px; иконке доступное имя; повтор submit заблокирован; вторичные действия спокойные | frontend_engineer + design_lead; UI-02.2; EX-04/05 |
| C04 Input / textarea / field group | `.stack-form`, `.form-grid`, формы доменов | Видимый label, required согласно данным, help/error связаны с полем; ввод сохраняется при ошибке; default/focus/disabled/read-only/invalid/pending | frontend_engineer; UI-02.2/04.1; EX-04 |
| C05 Select / date / time | Native select и `.custom-select`; дата/время брони | Клавиатура, раскрытие, выбранное/disabled значение, пустой/ошибочный справочник; Escape сначала сворачивает список; не сдвигать соседние поля; timezone заведения | frontend_engineer; UI-04.1/04.2; EX-01/04 |
| C06 Checkbox / radio / switch | Нативные input и локальные оформления | Checked/unchecked, checkbox indeterminate, focus/disabled/pending/error группы; подпись входит в цель; визуальное обновление не меняет тип значения API | frontend_engineer; UI-02.2/04.1 |
| C07 Tabs / segmented view | Виды персонала, графики, залы, внутренние журналы | Selected/hover/focus/disabled; клавиатура по выбранному паттерну; ссылка для маршрута, кнопка для локального вида; предпочтения не меняют права; единственный зал не занимает строку вкладок | system_architect для маршрута, frontend_engineer для вида; UI-03.2/06.1/08.1 |
| C08 Badge / status | Смена, заказ, приготовление, депозит, товар | Пассивный текст/значок плюс цвет; neutral/success/warning/danger; неизвестное отдельно от нуля/готовности; интерактивность только через явную кнопку/ссылку | design_lead + доменный владелец; UI-02.2/05.1 |
| C09 Table / list | Журналы, склад, финансы; разные существующие scroll/card варианты | Заголовки/суммы/действия читаемы; данные/empty/no-results/loading/error/denied разделены; горизонтальный overflow внутри контейнера, не страницы; сортировка явно объявлена | frontend_engineer + design_lead; UI-06.1/07.2/08.1; EX-02 |
| C10 Staff directory | `renderStaff`, `staffDirectoryPreference`, `.staff-directory-table`, `.staff-table-scroll` | Cards/list/table и scale 1–4; выбранная таблица сохраняет 5 колонок; scale доступен только для плиток, место контрола стабильно; поиск и права одинаковы | frontend_engineer; UI-08.1; EX-02 |
| C11 Dialog / drawer | `ui-dialog.js`, `HOOKAH_UI.open`, `.ui-modal`: UI-04.1 пилот «Новая задача» и UI-04.2 zone/table/network venue/task edit + mounted reservation, medium 640px. Legacy portalAction, POS/catalog/payment, platform и прочие native окна не мигрированы | Имя, Tab/focus fallback, inert/scroll lease; Escape сначала select; backdrop down+up; preserve/block. Ordinary drafts entity-local текущего render; API awaited внутри onSubmit, ошибка сохраняет форму; после readback heading focus с tabindex до blur. Один shared редактор, PIN/native yield сохраняет DOM; scoped PIN stack принят UI-04.3 | frontend_engineer + system_architect; UI-04.2 accepted scoped; optional mount/lifecycle extension — architect; EX-01 закрыт только по геометрии, EX-03 частично |
| C12 Reservation wizard | `renderReservations`, припаркованный `#reservation-form` в `#reservation-dialog`, shared mount, три `[data-reservation-step]`; 640px fixed head/footer + scroll body | Одна CTA и форма: гость → визит → подтверждение; close/error сохраняют DOM/step, block pending; domain validation раскрывает failing step; query tableId/reservationId/action=seat и API payload прежние; post-GET CTA focus только current без нового окна. Квитанции/возврат остаются в списке и прежних handlers | frontend_engineer + design_lead + system_architect; UI-04.2 accepted scoped; EX-01 geometry closed, finance/PIN вне пакета |
| C13 Feedback | UI-04.1: `HOOKAH_UI.feedback`/`fieldError`, адаптеры portalNotice/POS notice, пилот inline error/pending. Остальные доменные `.form-message` и notification-center сохраняют свои сценарии | Общие status/polite, явный error/alert/assertive без таймера; обычные сообщения 4–6с. POS явно заданные 8–12с сохранены; sticky error подключён к выходу, остальные старые POS ошибки ещё требуют классификации. Ошибка поля связана с native control и enhanced trigger; notification-center — отдельный канал | frontend_engineer; UI-04.1 source contract, браузерная приёмка отдельно; EX-03 частично закрыт |
| C14 Async data region | Таблицы/справочники/списки и локальные loading/error handlers | Loading, empty database, no results, denied, error/stale, success различимы; retry не теряет фильтр; старый ответ другой точки/карточки не подменяет актуальный | frontend_engineer + qa_engineer; профильные этапы |
| C15 Floor tile / order / preparation | POS `app.js`, table/card layout и order/preparation sections | Название, сумма, статус, вместимость, оборудование, время по предметной спецификации; исполнение отдельно от оплаты; частые действия доступны без перекрытия | design_lead + frontend_engineer; UI-05.1; EX-06 |
| C16 KPI / summary / disclosure | Финансы, отчёт, смена, склад | Только реальные данные, единицы/период видны; неизвестное не ноль; компактная сетка; раскрытие сохраняет DOM/черновик; без декоративных пустых баннеров | design_lead + доменный владелец; UI-05.1/07.2 |
| C17 Brand / effects / cursor | Lockup, company frame, fine-pointer курсоры сотрудника | Существующие фирменные места, reduced-motion, fallback курсора; каждый новый эффект объясняет назначение | design_lead; UI-02.2/08.3; EX-05 |
| C18 PIN / auth surface | `lock.js`, native modal PIN, login и дымовой фон | PIN top layer, focus/keyboard/pointer guards, DOM/draft/pending сохранены; общий scroll lease, verified identity/token/epoch resume; invalid PIN401 остаётся locked, auth401→login | system_architect + security_reviewer; UI-04.3 accepted scoped;36pairs108refs; EX-03/07, scroll/settings debt |

## Применимые состояния и приёмка

Интерактивные контролы проверяются мышью и клавиатурой; focus-visible не заменяется только hover. Read-only отличается от disabled. Таблицы и списки проверяются с пустыми данными, ошибкой, длинными именами/суммами и недоступным действием. Пассивные метки не получают фиктивного tabindex. При сохранении значения остаются видны, ошибка не очищает форму. Успех подтверждается повторным чтением там, где действие сохраняет данные.

Для UI-01.2: 1366×768, 1920×1080, фактический рабочий viewport и две поддерживаемые темы. Для следующих подэтапов повторяются затронутые строки/состояния; полный обход программы — UI-09.1. Fold отложен до UI-10.1, обычная узкая регрессия имеет отдельный сценарий. UI-01.1 не выполнял эти визуальные проверки.

## Evidence D07/D08, прочитано в UI-01.1

Baseline: HEAD `802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf`, рабочее дерево с прежними незакоммиченными изменениями. Это source evidence, не вычисленные стили и не production.

| Вопрос | Проверяемый указатель исходника | Вывод |
|---|---|---|
| Бронь | `portal.js:5690` `renderReservations`, `5694` разметка dialog, `5702–5752` шаги/закрытие/Escape; `style.css:4267` `.reservation-dialog` | 3 шага, 560px и max-height viewport−32px; постоянная левая форма устарела. Sticky header/footer общей оболочки ещё не доказаны |
| Персонал | `portal.js:2143–2148` defaults/normalizer, `2194` 5 th, `2300–2324` save/read preferences; `style.css:3524–3535` | Сохраняются view и cardScale, не пользовательские колонки; таблица min-width 1080px прокручивается локально |
| Темы | `portal.js:10–13` applyPortalTheme, `1794–1816` сохранение; `style.css:308,1209,1403–1404` | Две темы и коралловый dark link; light overrides не заменяют полную семантическую карту |
| Фирменные эффекты | Company frame и fine-pointer staff cursor заданы отдельно от legacy editor motion | Одна существующая пульсация company; нельзя выводить из этого разрешение на sweep всех редакторов. UI-08.3 отделяет sweep-анимацию от общей border/surface группы: platform modal не получает animation declaration, а platform.css сохраняет статическую semantic surface/outline. Company-specific отключение и legacy modal consumers сохраняются; anchored inventory sweep остаётся до C11 migration |
| Fold | PLAN UI-10.1 и PROMPTS UI-01.1 | Desktop первый; прежнее общее требование Fold для каждой правки не действует в этой программе |

Номера строк фиксируют момент чтения; при следующем пакете искать символ/селектор. Проверять фактическую тему, размеры, Tab, контраст и сохранение в UI нужно отдельно; наличие обработчика не доказывает пройденный сценарий.

Указатель брони выше исторический UI-01.1. UI-04.2 принял новую shared геометрию C11/C12: 98 final пар / 294 current-source refs, 86 open / 2 pending, desktop 1366/1920 и actual 1228×764 обе темы, ограниченная narrow 390×844 регрессия. Optional mounted-form extension сохраняет domain DOM и очищает per-open listeners; default fields/adapters неизменны. Расписание объекта допускает blank `null/null`, сохраняя серверную проверку пары. API collector отдельно подтверждает 20 принятых изменений / 7 final entities, manager flow и ограничения работников; pixels не заменяют API/role evidence. EX-01 закрыт только по geometry; financial/refund, full PIN UI-04.3 и Fold остаются вне этой приёмки. Cleanup preview отмечается координатором по факту.

## Добавление варианта

Перед новым стилем выбрать ID компонента. Если его контракт не подходит, записать сценарий, причину, владельца, состояния, темы и срок в EXCEPTIONS, затем согласовать с владельцем контракта. Не вводить безымянный override ради одной страницы. После миграции удалить старый вариант лишь при отсутствии потребителей; изменение shell/маршрута обязательно проходит system_architect.

## Внедрённые примитивы UI-02.2

Владелец — frontend/design; основная CSS-область `.ui-components`, классы выбираются явно. [Локальный эталон](components/UI_02_2_REFERENCE.html) и его CSS/JS находятся в документации; сервер примера доступен только на loopback, production routes/меню его не подключают. В нём нет auth, API, storage или бизнес-сохранений. Reference CSS задаёт только раскладку образцов. Этот набор — эталон для следующих исполнителей, включая Luna, а не ещё один стиль каждой страницы.

| Семейство / классы | Варианты и состояния | Размер / семантика |
|---|---|---|
| C03 `.ui-button` | Secondary по умолчанию; `--primary`, `--quiet`, `--danger`; default/hover/active/focus-visible/disabled/busy | Минимум 44×44px, primary высотой 48px; `type=button`, submit — только по контракту формы |
| C03 `.ui-icon-button` + `.ui-icon` | Те же states; доступное имя через aria-label | Цель 44×44px, SVG 20px, currentColor, существующий stroke-паттерн |
| C04/C05 `.ui-field`, `.ui-label`, `.ui-input` | Native input/select; textarea `--textarea`; placeholder/readonly/disabled/invalid/busy справочника | Input/select 44px, textarea ≥88px; видимый label; aria-invalid + aria-describedby на ошибку; readonly выделяется и копируется |
| C06 `.ui-check`, `.ui-check-input` | Native checkbox, unchecked/checked/indeterminate/disabled/invalid/focus-visible | Вся связанная label — цель ≥44px; индикатор 20px; `.indeterminate` задаёт вызывающий код, не fake CSS class |
| C08 `.ui-badge` | Neutral по умолчанию; `--success`, `--warning`, `--danger` | Пассивный статус с текстом, без tabindex/фальшивой кнопки; размер 12px/600 |
| C02 текст | `.ui-heading`, `--section`, `.ui-text`, `--lead`, `.ui-helper`, `.ui-error`, `.ui-number` | Page 28/800, section 20/700, body 14/400, lead 16/400, helper 12/400, label 14/600, error 14/500, numbers 20/700; line-height 1.2 headings / 1.5 body |

Заливки/текст/границы/статусы берутся из theme-aware `--ui-*` карты UI-02.1. Primary использует спокойную action-fill, не новый градиент. Quiet не имеет значимой границы: действие определяется читаемым текстом и клавиатурным контуром. Остальные значимые границы используют control/danger/focus роли. Disabled явно недоступен, сохраняя читаемую подпись; readonly остаётся обычным полем для выделения.

Фокус: `:focus-visible`, 3px outline с 3px offset; фактическая raster/CSS толщина фиксируется замерами, а не предполагается из декларации. Переходы 150ms, обычное движение 200ms, spinner 900ms; при системном reduced-motion и явном `.ui-motion-reduced` переходы 0ms, spinner статичен, текст «Сохранение…»/live region остаётся. UI-08.3 распространил остановку legacy busy-spinner на системный и явный reduced-motion, сохраняя подпись состояния. Это не мигрирует редакторы, у которых общий C11 lifecycle ещё не принят.

Pending обязан блокировать повтор в обработчике и семантике, а не только через CSS. Reference использует native disabled + aria-busy/aria-disabled и guard; idle/pending подписи занимают одну grid-ячейку, неактивная получает `aria-hidden=true` и visibility:hidden, spinner имеет отдельный резерв 16px. `[hidden]` для резервируемого текста запрещён: существующий legacy `display:none!important` иначе уменьшит кнопку. Пример действительно завершает локальное ожидание и возвращает доступность; это не подтверждение сохранения доменных данных.

### Контракт подключения для следующих задач

1. Выбрать семейство и состояние по таблице; добавить `.ui-components` на явную область подключения.
2. Мигрировать текст, фон и границы вместе. Не использовать light текст на оставшейся dark поверхности через случайное наследование.
3. Удалить/ограничить только доказанные конфликтующие legacy selectors внутри мигрируемой области; не добавлять локальные important/hex/вес 650/750.
4. Сохранить native семантику, label, error description, disabled/busy guard, роль/tenant/API/порядок действий и возврат фокуса. `aria-disabled` само по себе не подавляет события; links требуют отдельного контрактного обработчика.
5. Измерить реальные hit-area/контраст в двух темах и применимых состояниях, длинное название/сумму, keyboard и reduced-motion; выполнить scoped source/dist checks.

Baseline D09/D16/D17 в старых consumers остаётся: 42px локальные контролы, 9px подписи, веса 650/750 и живая анимация anchored inventory editor/legacy modal consumers. Shell мигрируется UI-03.1, страницы — профильными этапами. UI-08.3 отделяет animation declaration от shared legacy border/surface selector: active platform modal сохраняет прежний border/gradient/outline cascade, а его animation остаётся отключённой platform.css. Не заявляется удаление живой Company action behavior или legacy POS sweep. Доказательства и конкретные ограничения проверки — в отчёте UI-08.3.


## C01 — внедрённая геометрия UI-03.1

Desktop >900px принят scoped: operational POS/portal210px, management clamp210/18vw/280; shared header token/paddings/brand, 44px avatar/profile hosts, venue shrink before route title. Состав меню/handlers не менялся. Владельцы system_architect + design_lead GO. Навигация/контекст UI-03.2 ещё не начаты. Narrow legacy geometry/32–36px targets и POSruntime light остаются отдельным долгом; см. UI_03_1_RESULT.md. Новых декоративных исключений нет.


## Принятый контракт UI-04.3 — C18 / C11

PIN теперь native dialog в browser top layer; нижние shared/native/legacy DOM/drafts сохраняются. Shared и PIN используют один scroll lease с разными владельцами. PIN удерживает focus/keyboard/pointer/submit и восстанавливается после позднего native открытия/неожиданного close. Возврат только в актуальный verified token/user/org/venue/role, stale epoch responses игнорируются; invalid_pin401 сохраняет блокировку, authentication401 переводит на login. Sibling UX signal подтверждается живой GET session; политика серверного PIN не заменена. Shared single-editor и domain API/pending сохраняются.

[Приёмка UI-04.3](UI_04_3_RESULT.md):36pairs108refs,VM25,четыре роли,desktop1366/1920/actual+узкая390 регрессия обе темы. Исторические указания «отложено UI-04.3» выше описывают прежние этапы; этот итог закрывает scoped PIN stack. Tall card scroll/settings overflow, остальные legacy/financial migrations и Fold остаются долгом. Cleanup UI042/UI043 завершён, собственные proxy/tab закрыты.


## C14 / C15 — внедрены scoped UI-05.1

Floor, order, catalog и preparation/queue используют существующие ui-button/ui-input/panel/status primitives. Empty compact context, validated preferences theme, distinct loading/denied/error/filter/retry, station hints and fixed busy catalog.10 tiles fit1366/1920 обе темы; short management and long rows scroll by EX-06.56finalpairs112refs/626targets,17sourcecases,39realacceptedwrites/readback; [результат](UI_05_1_RESULT.md). C16 финансовые/KPI consumers и полная mobile/contrast миграция этим не принимаются.


## C14 / C15 — внедрены scoped UI-05.2

Четыре operational list consumers, semantic labels/controls/cards,44px targets, explicit guests readstates. Delivery list first with attached form disclosure; no universal list factory added. Financial reservation selectors explicitly excluded. [Результат](UI_05_2_RESULT.md).


## UI-06.1 — потребители C14/C15

Каталог, техкарты и основная иерархия inventory используют существующие primitives без новой глобальной factory/observer. Семантические темы, focus, подписанный поиск, loading/error/retry/ready и readonly действия подтверждены scoped [RESULT](UI_06_1_RESULT.md). API/units/costs/cascade и anchored/native editors сохранены.


## Потребители UI-06.2

Остатки, пополнение и партии премиксов используют C02 (поля), C09 (операционная таблица), C14 (панели/toolbar) внутри `.ui-inventory-operations`. Нового самостоятельного компонента/декора нет; scoped descendant semantic rules покрывают динамические числовые поля и production summary.


## C11 / C12 — critical consumers UI-07.1

Опциональный HOOKAH_UI.critical использует настоящие legacy/native формы оплаты/возврата/склада и общий modal lifecycle. Head/body/footer ограничивают прокрутку; pending blocking, focus trap/restore, native cleanup и context-lost conceal не меняют расчёты/API. Existing shared open confirmations используются для post/reverse/guest; формы и intent/key остаются у доменных потребителей. Scoped semantic CSS сохраняет рабочую плотность без декора. [RESULT](UI_07_1_RESULT.md); source/dist4, final40pairs,36/3 lifecycle checks.
