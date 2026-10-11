# Общие компоненты и состояния управленческой темы

Исходное состояние: опубликованный код f7e7af13 и документационный план 8ef9f147. Это каталог по исходникам, не результат браузерной приёмки. Функции и селекторы — точки поиска; номера строк при внедрении могут меняться. Доменные формы перечислены в каталогах разделов.

## Обозначения

- **Есть** — состояние или механизм найден в текущем коде. Это не утверждение, что все потребители уже визуально согласованы.
- **Образец** — нужно показать в MT-02, затем проверить на внедрённом потребителе.
- **Граница** — поведение/право/данные, которые оформление не изменяет.
- **Не запускали** — упомянутые ниже скрипты найдены в репозитории, в MT-01 не выполнялись; их результат не объявляется PASS.

## Реестр

| ID | Компонент и точка кода | Есть / образец | Граница и контроль |
| --- | --- | --- | --- |
| C01 | Кнопки `.ui-button`, `.button`, `.icon-button`; style.css блок UI-02.2 | Есть primary/quiet/danger, disabled, aria-busy, hover/active; образец normal/hover/focus/pressed/pending/disabled, короткий и длинный текст | Одна высота внутри группы; иконка с доступным именем; pending не создаёт повторный запрос. Контроль локальной геометрии и клавиатуры |
| C02 | Типографика `.ui-heading`, `.ui-text`, `.ui-helper`, `.ui-number`, `.muted` | Есть semantic tokens, tabular numbers; образец заголовок/подпись/денежная сумма/многострочный текст | Цвет/размер не подменяет период, единицы или precision; без анимационного счётчика |
| C03 | Поля `.ui-field`, `.ui-label`, `.ui-input`, `.ui-input--textarea` | Есть placeholder/readonly/disabled/invalid; образец required/hint/error/long text и отсутствие optional значения | HTML required/min/max/step/name/FormData остаются прежними; field IDs/labels/help связаны |
| C04 | Checkbox/radio/switch, `.ui-check-input`, `.ui-check` | Есть checkbox adapters; образец selected/unselected/focus/disabled | `HOOKAH_UI.adapters.portal` Boolean и staff `on` — разные контракты. Не менять serialization или адаптер |
| C05 | Enhanced select `enhancePortalSelect`, `.custom-select-trigger`, `.custom-select-menu`, `.custom-select-option` | Есть native source, selected/disabled/group options и refresh; образец длинные options, ошибка, открытое меню и keyboard | Native `select` остаётся источником значения. Ошибка/label/focus относится и к trigger; dropdown поверх окон не обрезается |
| C06 | Date/time/number, native input controls | Есть нативные форматы, доменные ограничения; образец пусто/ноль/invalid/disabled и даты периода | Системные popup браузера не перекрашиваются CSS. Единицы и timezone заведения сохранены |
| C07 | Общая форма `HOOKAH_UI.open`, `fieldMarkup`, `fieldError` в ui-dialog.js | Есть generated fields, form-level error и pending; образец обычная и длинная форма, ошибка поля/API, повтор после ошибки | При ошибке ввод остаётся; успех после awaited onSubmit; доменные required/read правила сохраняются |
| C08 | Обычный редактор `createPortalEditorScope`, `portalEditorIdentity` в portal.js | Есть entity-keyed draft в памяти render, context/isCurrent, preserve/block и restoreFocus; образец cancel/reopen, success/readback | Черновик не пересекает verified user/venue/role; не создавать новый persistent draft механизм |
| C09 | Shared shell `.ui-modal`, `.ui-modal-card`, `.ui-modal-head/body/footer`, `[data-ui-dialog]` | Есть sizes small/medium/large, title/description, scroll lease, inert, Tab/Escape, opener/fallback; образец длинное содержимое и пропавший opener | Сохраняются семантика dialog, focus trap/return и body-scroll; разные окна не получают глобальный стиль сотрудников |
| C10 | Несохранённое/ожидание `[data-ui-discard]`, `[data-ui-pending]`, pendingClosePolicy | Есть preserve/confirm-discard/discard, explicit block при pending; образец две альтернативы закрытия и pending | Не вводить одинаковое discard поведение всем формам; caller выбирает политику |
| C11 | Mounted wizard `open({mount,...})`, `validateMounted`, `onPending` | Есть парковка существующей FORM, listener cleanup; образец длинная многошаговая бронь | Существующие form IDs/steps/guest match не заменять универсальным генератором |
| C12 | Критические окна `HOOKAH_UI.critical`, `portalCriticalAction`, `portalCriticalContext`, `styleCriticalControls` | Есть native/custom shell, pending guard, context invalidation и PIN/native coexistence; образец подтверждение, неизвестный результат, retry | Идемпотентность и request intent принадлежат доменному handler. Дизайн не переизобретает их |
| C13 | Legacy `.modal.action-modal.open`, `.action-box`, `.action-fields/footer`; `portalAction`, `portalConfirm` | Есть отдельная оболочка с focus/Escape/close, resolve значений; образец варианты архива/удаления | Не считать её автоматически равной awaited `HOOKAH_UI.open`: многие API вызываются после получения результата. Миграция поведения отдельна от темы |
| C14 | Toast `portalNotice`, `HOOKAH_UI.feedback`, `#portal-notice`, `.ui-feedback[data-kind]` | Есть success/info/error, status/polite или alert/assertive, обычный 4–6с, error без таймера; образец длинное сообщение и несколько событий | Fallback portalNotice остаётся при ошибке загрузки shared UI. Не обещать ручное закрытие/очередь: их общая реализация не подтверждена; сохранять важную ошибку в контексте |
| C15 | Встроенное сообщение `.form-message`, `.ui-error`, `.ui-modal-message` | Есть local validation/API text; образец сообщение у поля и общее, успех и неизвестный результат | Нельзя стирать форму или показывать успех при сетевой неопределённости; текст ошибки остаётся actionable |
| C16 | Центр уведомлений `#notification-bell`, `#notification-panel-content`, `.notification-panel`, `.notification-list` | Есть loading/empty/error/retry, unread count и ограниченные href; образец длинный текст, unread/read, keyboard close | История уведомлений и краткий toast разные компоненты; не смешивать unread count с задачами или финансовыми показателями |
| C17 | Карточки показателей, `.dashboard-shift-*`, `.stat-card`, `.panel` | Есть текущие/сменные показатели; образец zero/unknown/loading/error/large amounts | У каждого периода и источника своя подпись. UI не суммирует разные выборки и не превращает ошибку в 0 |
| C18 | Таблицы, карточки списков, `.empty`, `[aria-busy]`, `[data-read-state]` | Есть разные рендеры по разделам; образец 0 rows/no matches/long values/loading/partial/error и действия строки | Не добавлять sort/page/bulk selection, если их нет у потребителя. Таблица финансов/склада сохраняет столбцы/единицы/точность |
| C19 | Toolbar/search/filters, details/summary, tabs существующих разделов | Есть разные контролы; образец clear/no result/selected/expanded и keyboard | Фильтр не меняет источник общей суммы без явной подписи. Не дублировать существующий sidebar view новыми вкладками |
| C20 | Навигация, шапка, crumb, профиль/уведомления | Реестр и ограничения в MT01_ROUTES_CONTRACT.md | system_architect владеет контрактом; не расширять дизайн на сотрудника через общие selectors |
| C21 | Session guard `#portal-session-guard`, `portal-session.js`; lock overlays lock.js | Есть verified access/loading/redirect и блокировка; образец theme teardown при deny/lock | PIN/lock security и профиль сотрудников не переделывать. Оформление не задерживает guard и не показывает запрещённый контент |
| C22 | Экспорт и файлы у существующего потребителя | Реальный CSV — `#audit-export` в журнале аудита; company logo/media, guest avatar и document upload forms по каталогам | Финансовый CSV/печать не подтверждены и не добавляются. Валидность файла, DOM escaped text, имя экспорта, CSV privacy/precision — действующий контракт |
| C23 | Badge/status, tooltip/native title, secondary text | Есть цветовые и textual состояния; образец contrast, длинная подпись, focus keyboard | Статус всегда назван, не кодируется одним цветом. `title` не единственный способ объяснить disabled |
| C24 | Motion/layers/shadows; ui motion tokens/reduced-motion | Есть tokens 150/200ms и reduced-motion rules; образец focus/hover/open при normal/reduced | Не использовать shine/sweep/pulse в новой теме. Сохранять явные исключения существующего STANDARD до отдельного решения |

## Повторное использование проверок

Найденные точки для будущего запуска: `ui-dialog-lifecycle-contract.mjs`, `ui-dialog-mounted-form-contract.mjs`, `ui042-ordinary-editor-contract.mjs`, `ui043-lock-lifecycle-contract.mjs`, `custom-select-groups-qa.mjs`, `notifications-browser-qa.mjs`, `notifications-api-qa.mjs`, `portal-context-refresh-qa.mjs`, `interface-preference-session-qa.mjs`, `local-design-contract.mjs`, `local-click-contract.mjs`, `local-static-boundary.mjs`. Статический контракт не заменяет проверку вычисленных стилей. Не запускать весь список для каждого цвета.

## Геометрия и тема

Переиспользовать DESIGN_TOKENS: Manrope, spacing 4/8/12/16/24/32, radius 8/12/16, controls 44px и action 48px. Кнопки одной группы привести к одной высоте выбранного режима (44 или 48), длинная подпись не обрезается. Числа tabular, ширина по содержимому, единицы рядом. Контраст обычного текста ≥4,5:1, крупного и значимых контролов/focus ≥3:1; проверять реально вычисленные цвета. Новую тему проектируем в тёмном варианте; существующий переключатель light сохраняется, а исключённые страницы не получают новые правила. Полная повторная матрица light не входит в MT-01.

Меню/окна/feedback часто добавляются непосредственно в body. Future scope — явный разрешённый признак владельца конкретного экземпляра, а не `body .ui-modal` и не только роль. При уходе на исключённый hash, блокировке доступа или смене verified context признак должен сниматься. Не размечать все body overlays только потому, что последняя страница была управленческой.

## Вопросы, решённые для MT-02

1. Образец показывает и новую shared оболочку, и legacy action-modal; красивый общий screenshot не доказывает обе.
2. Persistent error/toast в текущем коде не имеет общего закрывающего action: в образце можно показать предложенный close, но внедрение требует отдельной локальной правки lifecycle и проверки, а не одного CSS.
3. Размер и состояние нативного date/validation popup контролирует браузер. Приёмка разделяет browser-native и стилизуемые элементы; недоступный screenshot не объявляется PASS.
4. Изображения концептов не задают новые разделы, тестовые данные или семантику показателей. Каталоги и доменные контракты приоритетнее.
5. Общий `money(value)` использует `Number(value || 0)`. Сам helper не отличает неизвестное от подтверждённого нуля. В MT-02 нужны отдельные образцы неизвестного/ошибки; при внедрении проверять caller до formatter, не менять финансовое округление глобально.
