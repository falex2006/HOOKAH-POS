# Персонал: переключатель вида и фокус поиска

Прямой запрос пользователя передан MASTER, пример `codex-clipboard-2386a8cb-4263-4da8-abbd-2ef00d98c8a4.png`. Локальная база17d93081; frozen worktime128f10e9 не изменяется. PAYROLL подтвердил отсутствие конфликтов staff-view/staff-search CSS, лояльность уведомлена. Только style.css/dist и соответствующий браузерный тест; portal.js, ARIA, маршруты, права, глобальная тема, POS и БД не менялись.

Причина: внешняя рамка staff-view-switch сочеталась с inset-обводкой выбранной кнопки (style.css3810). Глобальный table-search:focus добавлял 3px orange shadow при фокусе мышью, а более поздняя management-theme убирала его только для focus-visible. Родительские overflow могли обрезать внешний halo.

Изменение: единственная общая граница сегментов, внутренние border/shadow убраны; выбранная кнопка имеет нейтральную тональную заливку color-mix12%, равные размеры44px. ui-raised в runtime совпал с фоном группы, поэтому его не использовали для выбранного состояния. Поиск при мыши получает спокойную серую границу; клавиатура сохраняет видимую2px нейтральную внутреннюю outline без изменения размеров и внешнего clipping. Все селекторы ограничены #staff.staff-catalog.

Проверка: actual local memory server/portal, 3desktopвида1440, после каждого сохранённого вида мобильный390 принудительно остаётся одним списком; mouse/keyboard focus обоих контролов, aria-pressed ровно1, одинаковые размеры/no jump, поиск совпадения/пустого результата/сброс, отсутствие pageerror/document overflow. Baseline9issues → final0. После окончания CSS transitions измеренный контраст заливки выбранного сегмента к группе1.4229669 во всех3видах; порог1.3 здесь только регрессия различимости тона, не утверждение полной WCAG-приёмки. Проверка не является PG/RBAC-приёмкой. Начальный fixture password400 был валидатором длины тестовых данных, не дефектом продукта.

Evidence: tmp/staff-directory-focus/report.json, baseline-report.json, before-1440.png, cards/list/table-pointer-search-1440.png, cards-keyboard-button-1440.png, cards-keyboard-search-1440.png, table-preference-mobile-list-390.png. Визуальный аудитор сравнил before/after и3вида; code-health scopedGO. Syntax, visual-page-rules иsource/dist parity PASS. PG/VPS/публикации не было.

Следующий отдельный пользовательский пункт: убрать тире рядом с доступным плюсом в пустой ячейке графика; сохранить read-only семантику «Не запланировано», manage/ночные продолжения/keyboard. Этот staff-пакет не включает календарную правку. Исходная полная UI-цель не complete; final PG frozen128f ожидает слота после Loyalty.
