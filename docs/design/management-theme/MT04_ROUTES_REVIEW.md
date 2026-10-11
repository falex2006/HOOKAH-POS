# MT-04: оставшиеся точки происхождения окон и сообщений

Роль: system_architect. Статическое целевое исследование, 2026-10-11. JS/CSS, маршруты, права и обработчики не изменены; браузерная приёмка не выполнялась. Профиль роли, MT01_ROUTES_CONTRACT, MT01_OPERATIONS_SETTINGS и текущие portal.js/ui-dialog.js прочитаны. Управленческие finance/network/integrations renderers находятся в portal.js, а не в отдельных finance/network/integrations продуктовых скриптах.

## Выполнимые пробелы

| Потребитель / source anchor | Минимальная точка интеграции | Граница |
| --- | --- | --- |
| Категории финансов: `portal.js:4592`, `openEditor`, native `dialog.finance-category-dialog` | Сохранить ticket из `editorOpener` перед `showModal()`, attach конкретный `dialog`; повторное открытие получает новый ticket | Страница `/finance/categories`, существующий finance gate. Pending/cancel/reset и payload не менять |
| Приход/движение: `portal.js:3330`, `openMovementEditor`; диалоги `#purchase-document-dialog`, `#inventory-movement-dialog` | Origin уже передан как `opener`: capture до `await editor.ready`. Передать сохранённый ticket в lifecycle конкретного `ui.critical` открытия | Не вычислять происхождение по activeElement после await. Общий critical adapter сейчас сам захватывает activeElement при open; требуется согласованный per-open ticket, иначе последующий attach(null) снимет заранее поставленный marker |
| Возврат заказа: `portal.js:5549`, `renderRefundOrder`; `refundShell.open()` на 5566 | Явный opener из `[data-order-refunds]`/реального обработчика строки; capture до ожидания `refundShellReady`, передать per-open ticket | Сохранить existing finance/orders/reservations gates, intent/idempotency, pending/context. Не делать ticket из запасного `main` |
| Shared ordinary editor: `portal.js:803–823`, `createPortalEditorScope` | Использовать уже явный `opener`; capture до загрузки shared UI и переиспользовать для ошибки открытия и результата вызывающего handler | Успех формы и её серверный результат различны. Не сохранять ticket на весь renderer бессрочно |
| Toast/notice: `portalNotice` на 732 принимает третий аргумент, большинство domain callers его ещё не передают | Capture в начале разрешённого click/submit/change, сохранить в замыкании, передать третьим аргументом во все связанные success/error branches | Не добавлять глобальный fallback current page/activeElement внутрь portalNotice. Read errors без действия могут захватывать конкретную разрешённую panel при начале чтения |

Приоритетные notice anchors: смена `2256/2263` (`#shift-actions`); фото товара `3739/3746` (input события, ticket до FileReader); расходы `4824/4831/4833` (`#expense-form`, ticket до FileReader); доставка `5242` (кнопка статуса); задача `5853–5901` (delete/edit/new opener); возврат `5690/5700/5717` (ticket соответствующего refund intent); предоплаты брони `6425/6429/6440/6441/6491/6495` (конкретная кнопка receipt/allocation/refund); сохранение брони `6554` (ticket открытия разрешённого reservation wizard). Это примеры конкретных handler families, а не требование переписывать весь portal.js.

## Native окна требуют отдельного решения

CSS не изменяет браузерные `confirm/prompt`. Оставшиеся разрешённые точки:

- `portal.js:3861/3862`: отмена выпуска premix и причины void/waste/reconcile.
- `4060/4061`: удаление техкарты из формы/списка.
- `4189`: удаление товара.
- `4419`: отмена черновика прихода.
- `4438`: замена текущего черновика приёмкой по заявке.
- `4471`: отмена заявки пополнения.

Для MT-04 либо явно принять native UI как границу, либо переносить отдельный сценарий в shared UI с сохранением отмены, reasons, draft/pending и domенового payload. Native date picker и `reportValidity()` также остаются браузерными; их нельзя объявить принявшими новую тему.

## Сеть и интеграции

`renderNetwork:5398`: `network-edit` уже использует shared ordinary editor с явным `opener: button`; ему нужны tickets сообщений результата, а не ещё одна форма. `network-archive:5443` проходит portalConfirm; сохранить ticket исходной кнопки для подтверждения/результата. `network-select:5442` вызывает `refreshPortalContext()` после смены tenant: прежний ticket должен остаться отозванным. Показывать результат inline в новом подтверждённом контексте либо получать новый panel ticket только после подтверждения; не переносить старый через границу venue. `renderIntegrations:5383` содержит статусы/retry и placeholder, новых окон подключения нет.

## Исключённые обработчики

Без management tickets остаются: создание/архив/восстановление залов и столов `2099–2170`, схема/геометрия/блокировка стола `2562–2645`, персонал/фото/кадровый drawer `2359–2495`, роли/назначение прав `3016–3020`, lock/PIN/profile overlays, demo сценарии `1138–1147`. `#floor-editor`, `.floor-editor-panel`, `#venue-layout-settings`, `.company-layout-note` исключены независимо от hidden. Выбор места внутри reservation wizard — разрешённые данные брони; рабочая страница зала и окно стола остаются исключены.

## Сохранить контракт

Не менять sidebar/header и server/session gates. Markers применяются к точному подключённому экземпляру; capture только от разрешённого origin. До async capture, после mount attach, после route/role/tenant/lock смены старый ticket не принимается. Уведомления уже имеют provenance hooks в обоих местах: portal.js и notification-center.js; новый blanket resolver им не нужен. Следующие владельцы: coordinator/frontend для выбранных callers, QA для повторного открытия, pending, stale completion и отрицательных кадровых/зальных сценариев.

## Итоговая проверка реализации MT-04

Проверен целевой текущий diff portal.js/ui-dialog.js и source anchors после интеграции. Исходные номера строк выше относятся к моменту исследования; ориентиром для дальнейшей работы служат также названные функции/ID.

- Directory native editors и finance-category-dialog теперь получают explicit origin ticket и attach конкретного dialog при открытии. Не классифицируются по одному наличию класса modal.
- `openMovementEditor` и `renderRefundOrder` захватывают ticket до await и передают его через `critical.open({managementTicket})`. Shared adapter принимает per-open ticket; явный null не заменяется capture нового контекста. Ordinary editor, reservation wizard и создание задачи передают pre-await ticket в `ui.open`.
- Приход из верхней панели сначала меняет inventory view/journal, затем получает новый подключённый `[data-inventory-header-action="receipt"]`. Это устраняет потерю provenance из-за демонтированного прежнего opener. Координатор сообщил о browser PASS для marker окна и возврата фокуса после отмены; архитектор самостоятельно браузерный сценарий не повторял.
- Подтверждено 51 локальное event binding `const portalNotice = bindManagementNotice(...)`. Ticket захватывается до async действия; сохраняются existing API payload, role checks и доменный результат. Этот счётчик характеризует подключённые event handlers, не все существующие вызовы portalNotice и не полноту функциональной приёмки.
- Network select сохраняет ticket исходного действия; `refreshPortalContext` отзывает его. Старое сообщение не получает оформление нового tenant. Подключение по неподтверждённому current page fallback не добавлено.
- Native confirm/prompt и native validation/pickers остались browser UI. Перечисленные выше native сценарии не объявляются перенесёнными или стилизованными. Неподключённые фоновые read notices сохраняют прежний вид.
- В просмотренном целевом diff изменения кадровых, зальных и lock handlers отсутствуют; sidebar/header и tenant/route gates не расширены.

Блокирующих архитектурных замечаний к проверенному MT-04 diff не найдено. Это source review и подтверждение контрактных точек, не самостоятельное доказательство всех browser/API сценариев. Следующий владелец — coordinator/QA: завершить выбранные lifecycle и отрицательные контроли, сохраняя отдельные доказательства проверок.
