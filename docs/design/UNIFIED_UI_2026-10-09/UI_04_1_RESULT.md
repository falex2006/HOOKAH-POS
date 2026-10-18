# UI-04.1 — общий контракт окон, полей и сообщений

Дата: 2026-10-10. **ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT** — общая основа и один нефинансовый пилот локально приняты. Архитектор и code health дали SOURCE GO, независимый QA/design — GO в этой области. UI-03.2 принят ранее. GitHub/VPS не публиковались; UI-04.2 не запускался. Рекомендация этапа — GPT-6.1 Sol / High; фактическое переключение модели основного чата не подтверждается.

## Причина и выбранный пилот

D04: у прежних окон различались фокус, блокировка фона и закрытие. D11: короткие уведомления без live region не удерживали ошибку. D12: portal и POS различались required/checkbox/coercion. На исходном «Новая задача» ошибка POST закрывала окно с вводом; это сохранено в трёх `before` парах.

Первым перенесён **«Новая задача», `/admin#tasks`**. У него пять простых полей, прежний POST `/api/tasks`, явные роли owner/manager и повторное чтение сохранённой записи. Редактор гостя связан с лояльностью/счётом, поэтому его риск выше. Редактирование задач, бронь, POS формы и финансовые обработчики остаются прежними.

## Что внедрено

- `ui-dialog.js` / `dist/ui-dialog.js`: именованный custom `role=dialog`, `aria-modal`, уникальные IDs, Tab/Shift+Tab, начальный/ошибочный фокус, inert фона, сохранение и точное освобождение scroll/inert, возврат к инициатору или доступному заголовку. Escape сначала закрывает раскрытый custom select; backdrop закрывает только после начала и конца жеста вне карточки. Оба направления drag через границу проверены в браузере.
- Явные `draftPolicy` и `pendingClosePolicy`. Пилот сохраняет черновик **только в памяти текущего renderTasks** при отмене/Escape/ошибке. Успех или смена контекста очищает его; reload/уход со страницы не обещают долговременный черновик. Pending блокирует повторную отправку, поля и выход, объявляет статус и ожидает ответ; ошибка возвращает доступность формы и удерживает ввод.
- Разные адаптеры: portal required по умолчанию true, checkbox — boolean; staff required по умолчанию false, checked checkbox — строка `on`, unchecked — отсутствующий FormData ключ. Остальные значения остаются строками. Пять полей пилота и запрос сохранены; существующий сервер trim title/description подтверждён SHA неизменённого handler.
- Ошибка поля связана `aria-invalid` / `aria-describedby` с текстом, включая видимый trigger enhanced select. Ошибка операции — inline alert/assertive. Обычные сообщения — status/polite, 4–6 секунд; явные ошибки остаются. Прежние POS сообщения на 8–12 секунд сохранены через явную совместимость адаптера; все прежние POS ошибки ещё не классифицированы как sticky.
- Общая геометрия на существующих токенах: medium 640px в пилоте, small 440px и large 880px в локальном эталоне; ширина ограничена экраном минус 32px, высота — dvh минус 48px. Заголовок/footer доступны, длинное содержимое прокручивается внутри. Исправлены стрелки и native календарь обеих тем. Декоративных эффектов и новых цветовых токенов нет.
- `app.js` / `portal.js` используют общий загрузчик и feedback адаптеры. Пилот ожидает загрузку модуля, снимает блокировку инициатора при отказе и допускает повторную попытку; polling задач учитывает общий dialog. В `server.js` добавлен **один точный public static allowlist путь `/ui-dialog.js`**, без изменения API/auth/RBAC/БД.

## PIN / top layer — основание выбора

До выбора примитива выполнен короткий браузерный опыт: native `showModal()` перекрывает старую div поверхность PIN независимо от высокого z-index; custom окно позволяет уступить ей фокус. Сохранены четыре `experiment` пары, отдельно от final.

Выбран custom overlay. Общий модуль наблюдает существующий screen-locked/native-open, приостанавливает собственное участие в фокусе и сохраняет ввод. В frozen-source эталоне PIN/native yield→resume подтверждены DOM, pixels, неизменность всех значений и draftVersion. **Это статическая поверхность без API, установки PIN и авторизации**, не доказательство настоящей автоблокировки, успешной PIN проверки или security bypass. Полная интеграция и смешанный стек — UI-04.3. Одновременно допускается одна shared форма.

## Проверки и доказательства

| Проверка | Результат и границы |
|---|---|
| Source/VM и static HTTP | 74 проверки actual-source lifecycle: поля, сериализация, pending/retry, контекст, очистка обработчиков, фокус, leases, сообщения; отдельно тот же извлечённый production static handler обслуживает GET/HEAD `/ui-dialog.js`, запрещает POST и частные файлы. Это VM/ephemeral HTTP, не production запуск сервера. |
| Focused contracts | 23 PASS, включая прежние modal/permissions/task/navigation/PIN контракты; financial pending тесты выполняют свои синтетические/source сценарии, не реальные финансовые операции. |
| Синтаксис/diff | 11 `node --check`, scoped `git diff --check` PASS. Четыре runtime source/dist пары byte-equal. |
| Saved browser evidence | **98 JPG/JSON пар, 1044 актуальных source SHA bindings; checker PASS.** 70 кадров с shared формой, 14 pending, 32 явно локальных reference. Before/experiment/diagnostic не входят в этот PASS. |
| Desktop / темы | Owner 1366×768 и 1920×1080, настоящие dark/light, ошибки/поля/длинный select/pending/успех/readback. Actual screen после reset — **1280×720**, обе темы. Narrow **390×844**, обе темы; это ограниченная регрессия, не полная адаптация телефонов. |
| Путь записи | Пять принятых итоговых POST201: четыре owner desktop ячейки и manager. Все пять прежних строковых полей подтверждены последующим настоящим GET `/api/tasks`; учитывается прежняя серверная нормализация trim. Один POST201 на принятый сценарий, pending через 7,5+ секунды остаётся busy, Enter/Escape не создают повторный POST. |
| Дополнительные сценарии | Отмена/reopen/Tab/Shift+Tab/select Escape, ошибка с неизменным вводом после 6,5+ секунд, исчезнувший инициатор и fallback, confirm-discard/keep, long40 внутренний scroll, numeric min/max без callback, module/read failure+retry/loading, пустая синтетическая точка, actual worker UI без task-new. |
| Визуальный review | QA независимо прочитал финальные pixels обеих тем/desktop, errors/narrow/PIN/fallback. Text control contrast ≥4,5, стрелки ≥3, targets ≥44 включая label checkbox, bounds/header/footer/ARIA PASS. Native glyph видимость проверена pixels и правильной схемой/filter; полный численный контраст всех системных glyph/бизнес-экранов не заявлен. |

Команды и фактические outputs: [checks.json](evidence/UI-04.1/checks.json). Verifier: `node scripts/ui-dialog-evidence-check.cjs`; source lifecycle: `node scripts/ui-dialog-lifecycle-contract.mjs`. Ревью: [UI_04_1_REVIEWS.md](UI_04_1_REVIEWS.md). Manifest и безопасные API логи находятся в `evidence/UI-04.1/`.

## Scope и сохранённые ограничения

Исходный HEAD `802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf` и прежний грязный WIP сохранены. Intake: 777 существующих путей, пропавших 0; изменены ровно 7: app/portal/style с mirrors и server. Добавлены модуль/mirror, три QA scripts и локальный reference HTML/JS. Полный старый CSS остаётся точным byte prefix. `lock.js`, `header-shell.js`, `portal-session.js`, HTML продукта и POST task handler неизменны. Документы/журналы учитываются отдельно; git diff от HEAD включает старые этапы.

1. Реальная PIN авторизация/автоблокировка и полный стек legacy окон — UI-04.3. Stale response/user/venue/role race защищены source/VM и локальным context fixture; настоящий concurrent auth race не заявляется как пройденный.
2. Одно pilot окно перенесено. Все остальные редакторы, брони и финансовые lifecycle идут в следующих этапах. Live feedback POS адаптирован, но не проверен отдельным screenshot для каждого прежнего бизнес-сообщения.
3. Старые sidebar/business dark islands/контраст в light, narrow shell долг UI-03.1/03.2 и native BFCache ограничения сохраняются. Device safe-area/Fold и полная мобильная адаптация — поздние этапы.
4. Наследуемый `pin-lock-acceptance-contract.mjs` FAIL остаётся: regex требует одну строку/пробел, серверный expiry guard записан многострочно и не изменён. Local-lock/trusted PIN source/runtime PASS. Auth логика ради regex не менялась.
5. Старые saved-evidence gates UI-03.1/03.2 относятся к своим историческим SHA; после новой версии app/portal/style они не считаются текущими UI-04.1 проверками и не перепривязываются.

## Среда и завершение

Собственный loopback31960 доставлял frozen snapshot **216 публичных файлов** поверх существующего disposable UI01231953 PostgreSQL/auth. Browser сессии и task API реальные, аккаунты/данные синтетические. Fault fixtures ограничены module/read/task response: POST503 отклоняется до записи, pending задерживает доставку уже настоящего ответа. Auth/401/403 не подменялись. Старый работающий backend не перезапускался для новой static записи; его отсутствие нового модуля компенсировалось явным preview delivery fixture и отдельно проверенным actual static handler. Production deployment этим не подтверждается.

Ранние stale-hash/неверно названные темы и промежуточные CSS снимки сохранены только в diagnostic. Итоговые пять записей выбраны прозрачным правилом в `api-evidence-selection.json`; за весь ход пересъёмок создано **19 синтетических задач**, они остаются в disposable БД. Это не пять всех запросов за весь этап.

Fault mode normal, исходные предпочтения owner восстановлены через существующий API; manager предпочтения не менялись. Viewport reset, собственная вкладка8 закрыта, принадлежащий UI041 proxy PID33188/31960 остановлен после проверки command line. Исходные31952/31953/31957 оставлены работающими. Credentials/tokens отсутствуют в принятой evidence. WORK_LOG/DECISIONS дописаны байтами, прежний текст сохранён.

Следующий отдельный этап: **UI-04.2 «Обычные редакторы и бронирования», GPT-6.1 Sol / Medium**. Он не начат автоматически.
