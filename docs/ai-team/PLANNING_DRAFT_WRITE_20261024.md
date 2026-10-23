# U2: сохранение и публикация — компонентная приёмка

Пакет поверхd8dac6b6. MASTER независимо прочитал baseline submit()/publishEditor. Реальный mounted browser с синтетическим storage/API воспроизвёл14 несовпадений/20снимков на390/1440: forcedsubmit отправляет второй invalidPATCH/publish и преждевременно восстанавливает pendingcontrols; preview503 показывает parenterror+nativealert, без собственного retry. Это семь проверок на ширину, не14 разных первопричин. Нативный обычный doubleclick уже ограничивался disabled; искусственный повтор проверяет целостность обработчика и не выдаётся за два обычных клика.

## Исправление

В planning submit добавлен per-form inFlight/open guard. FormData по-прежнему собирается до pending; input/change listeners продолжают менять requestKey. Обработчик второго submit не вызывает pendingfalse, пока первый запрос выполняется. Общий schedule dialog pending/dirty helper не менялся. Guard затрагивает planningforms, но приёмка иных его потребителей этим пакетом не заявляется.

publishEditor открывает одно окно сразу, показывает загрузку, закрывается на стадии preview read, локально сообщает escaped ошибку и предлагает повтор без window.alert. Currentparent/child/identity guard игнорирует поздний ответ. Кнопка публикации hidden/disabled до успешного preview; прежние canPublish/conflict/empty gates удаляют её и блокируют formsubmit. Разметка preview, параметры publish/version/fingerprint/confirmWarnings/requestKey и последовательность успешного callback сохранены. Для нового content wrapper добавлен точный CSS scope .schedule-dialog, gridgap12/statusgap8 и естественная ширина retry.

Во время разработки первый CSSscope .planning-dialog не совпал с фабрикой этого окна; rootвизуально и независимый code-health обнаружили потерю отступов. До freeze заменён точным .schedule-dialog[data-publish-content], без изменения ширины/класса/подфонов. Старый draft CSS сохранён. Это исправление введённой ошибки разработки, не дополнительная baselineпроблема.

## Проверки и визуальная оценка

- scripts/staff-schedule-draft-write-browser-qa.cjs: source24/dist24 PASS390/1440, finalterminal83077exit0. Синтетические PATCH/POST failures и storage только внутри fixture. Guard repeatedsubmit, controls/Escape/Close во время отправки; текст и confirm checkbox после503. Unchanged retry сохраняет exactbody+key, редактирование note меняет key. Success→GET503 показывает «изменение сохранено», GETretry не повторяет PATCH; note прочитан повторным открытием редактора.
- Preview503/localretry, heldpreview singleflight/hiddenpublish/close-reopen/late response не стирает новый reason. Publish использует latestfingerprint. Native required checkbox/reason предотвращают отправку без согласия; pendingpublish503 сохраняет ввод, неизменённый retry exactbody/key приводит к синтетическому publishedreadback. Forbidden/conflict/empty состояния не имеют submit и игнорируют forcedsubmit. Это rendering-contract, не реальная RBAC или серверная публикация.
- Snapshot bounds/scrollWidth и финальные saved-read-failed390/publication-error390/blockedforbidden1440 осмотрены root. MASTER independently reran published-assets24, reviewed finalfunctional diff и correctedCSS, открыл refreshedpublicationerror390, дал boundedfunctional/visualGO. Subagent reviews недоступны usage-limit; не приписываются им успешные результаты. Lifecycle9/discard/graphite/syntax/parity/diff PASS (terminal49383, продукт с тех пор неизменён;83077 добавил только assertions).
- Ранний fixture ошибочно искал note в компактной summary, где его по дизайну нет; проверка исправлена на editorreadback, это не дефект продукта. Изначальный baseline использовал dayoff как минимальный payload; финальная fixture использует shift, чтобы preferredwindowwarning соответствовал видимому примеру. RED не объявляется проверкой серверной допустимости warning для dayoff.

## Остаток

Нет настоящих draft writes/публикации/PostgreSQL, серверных конфликтов/ролей/tenant или uncertaincommit доказательства. Перед реальным gate нужен согласованный PG слот; payroll имеет приоритет. Actual attendance69 относится к exactce4f10b7 до новых planningправок, не всему текущему стеку. Другие templates/series/range/customACL и исходная матрица ещё открыты; goal не complete. Evidence tmp/planning-draft-write/{baseline,source,dist}/report.json и снимки. GitHub/VPS не менялись.
