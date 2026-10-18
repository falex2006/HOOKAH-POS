# UI-01.2 — продолжение R5

2026-10-09. **В работе, приёмка не завершена.** Исходная продуктовая реализация не менялась. R4 остаётся историческим срезом; текущая матрица сохраняет все 6 480 IDs, PASS 0.

## Что выполнено

- Исправлен ignored evidence processor: исторический отказ R2-E03 теперь связан с точным key и SHA256 старого JPG, а не переносится на любой новый кадр. Integrity rejection имеет приоритет. Исторические JPG/JSON сохранены в `evidence/UI-01.2/r2/history-r5/`. Независимая проверка: [HEALTH R5](UI_01_2_HEALTH_R5.md).
- Переснят platform keyboard при 1366×768: Обзор → Tab Компании → Tab Тарифы → Shift+Tab Компании. Реальная розовая рамка совпадает с metadata, native screenshot consistent=true; независимый direct review выполнен. Новая запись остаётся CAPTURED_PENDING_REVIEW в общей матрице, а не автоматическим PASS.
- Сняты **19 дополнительных JPG/JSON пар** в `evidence/UI-01.2/r2/components-r5/`: форма компании и Escape; ошибка обязательного названия задачи, раскрытый выбор сотрудника, Tab/Shift+Tab и два уровня Escape; table/list и редактор персонала с закрытием; раскрытые темы справки и длинный черновик обращения; выбранный POS заказ, каталог, пустой поиск и возврат; окно оплаты, Escape и закрытие.
- Все дополнительные пары сняты helper v10 одним native screenshot при измеренных 1366×768, DPR/scroll/context сохранены; consistent=true проверяет стабильность кадра, не принятие дизайна. Имена supplemental scenes не являются новыми route surfaces или новыми пройденными matrix cases. Черновики не сохранялись. Платежи, позиции, права и PIN не менялись. Вид персонала возвращён к исходным плиткам M.

## Наблюдаемое поведение

Форма компании закрывается Escape с возвратом на «Добавить компанию». У задачи первый Escape закрывает dropdown и возвращает фокус на trigger; следующий Escape закрывает окно. Каталог закрывается Escape с возвратом на «Добавить позицию». Это локальные реальные UI-свидетельства, не проверка сохранения и всех ролей.

**R5-V03 / R5-V04:** Escape из поля «Наличные» не закрывает окно оплаты. После click «Закрыть» activeElement=BODY, рамки возврата на «Оплата частями» нет. В `app.js:884–885` закрытие только удаляет class open; обработка возврата фокуса отсутствует в этом пути. Владелец: frontend + system_architect; UI-07.1 / UI-04.1. Кадры `pos-payment-escape-still-open` и `pos-payment-close-focus`; реальное чтение показало 307 ₽ к оплате, оплачено 0 ₽; «Сохранить платежи» не нажималось. Все 19 дополнительных кадров и новый main keyboard непосредственно осмотрены независимым design reviewer; SHA записаны в отчёте.

Нижние части формы компании и редактора сотрудника требуют отдельных scroll witnesses. В таблице персонала правое действие обрезано контейнером; горизонтальная доступность ещё не доказана. Длинные поля, высота раскрытых блоков справки и малые цели фиксируются в [VISUAL REVIEW R5](UI_01_2_VISUAL_REVIEW_R5.md), со ссылками на точные SHA. Hidden PIN markup в DOM не считается видимым экраном блокировки.

## Текущий индекс

После пересъёмки: **1 151 mapped captures**, включая все **1 080 baseline slots**. Статусы: 1 136 CAPTURED_PENDING_REVIEW, 3 721 PENDING_CAPTURE, 11 SUPPORTED_THEME_DEFECT, 4 CAPTURE_REJECTED_STATE, 1 608 N_A_DENIED_BUSINESS_REGION. Текущий CAPTURE_REJECTED_FOCUS исчез вследствие нового SHA; старый reject сохранён исторически и новый кадр независимо осмотрен. PASS 0; raster/origin mismatches 0; все evidence refs существуют. Дополнительные 19 пар не включены в этот счётчик.

Команды: `node --check tmp/ui012-baseline/process-r2-evidence.cjs`; `node tmp/ui012-baseline/process-r2-evidence.cjs`. Проверяемый файл: `evidence/UI-01.2/r2/processor-check.json`.

## Остаток

Scope введён отдельным решением D-UI012-R5: [действующий gate R5](UI_01_2_BASELINE_GATE_R5.md). Независимые architect/QA/design подтвердили объём, но не завершение. Code health сверил все 1 151 JPG/JSON hashes с manifest: mismatch/missing 0; все 19 supplemental pairs имеют согласованные raster/viewport/scroll/origin. Исторический focus reject не применяется к новому SHA; секретные значения в проверенном evidence не обнаружены в пределах описанного аудита.

[Контракт R5](UI_01_2_CONTRACT_R5.md) сохраняет 1 080 baseline + 42 appearance groups / 198 visual-state obligations. Точный порядок оставшихся девяти пакетов записан там; список не закрывается количеством снимков. Нужны reconcile текущих references/own-session bridges, остальные distinct guards, auth/PIN, lower scroll, grid/layout, общие сообщения/контролы и независимая приёмка. Полный functional regression backlog 6 480 сохраняется для UI-09.1. UI-02.1 не начат; GitHub/VPS не публиковались.

В конце browser viewport override сброшен. Proxy остаётся normal; tab сохранён для продолжения.
