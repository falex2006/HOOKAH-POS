# Пустая ячейка графика: один понятный плюс

Прямой запрос пользователя через MASTER. Отдельный пакет поверх frozen128f10e9, без переписывания его истории. У пустой ячейки недели ранее всегда был span с тире, затем добавлялась кнопка «+»: визуально получалось «− +», хотя удаления не было.

Минимальная правка staff-schedule-ui.js/dist: placeholder с тире не выводится только если этой же ячейке разрешён плюс (access.manage && p.active). Read-only и неактивный сотрудник сохраняют исходное «Не запланировано», без кнопки назначения. Tooltip плюса — «Назначить смену»; доступное имя сотрудника/даты, data-add/data-day, обработчики, записи, ночные продолжения и расчёт часов не менялись. CSS/API/БД/portal не менялись.

Компонентный browser final44 observations390/1440 PASS: пять дополнительных календарных состояний empty/read-only/inactive/occupied/night, нет тире рядом с доступным плюсом, пустой день не назван выходным,7read-only placeholder, нет quiet-кнопки для inactive, занятая ячейка/ночное продолжение сохранились и не задвоили часы. Enter с видимого назначения открывает редактор; на desktop передаётся выбранный сотрудник. Дата периода не пуста перед снимком. На390 таблица штатно скрыта: её DOM assertions проверяют контракт, фактический мобильный снимок показывает day cards, не таблицу. Первоначальные12несовпадений включали эту DOM-проверку и tooltip, не12разных визуальных багов.

Root осмотрел empty/read-only/night1440; независимый визуальный аудитор сравнил before/after и mobile390, cell-change GO. Предположение о пустой подписи периода не воспроизвелось на актуальном снимке; добавлен bounded текстовый assert без продуктовой правки. Code-health GO по точечному diff, source/dist/syntax/diff-check и discard/lifecycle9/graphite PASS. Evidence tmp/staff-worktime-hidden-states/report.json, calendar-empty-baseline-report.json, calendar-before-1440.png, calendar-empty/read-only/night-*.

## Сохранность и границы PostgreSQL

На время отдельной final128f PG-проверки U4 была сохранена binarypatch+explicit stash. После terminal0 патч восстановлен и SHA256 совпал: B4C8C2963F8EB99BA526E5FA9007720265BDA98237A0AE59A13097321887E67B. Затем добавлен только assert подписи периода. Stash не удалён. Frozen128f PG PASS23 относится ТОЧНО к128f: рабочее дерево было чистым, captured6assetSHA сверены MASTER; U4 не участвовала. Подтверждены terminal10765exit0, DROPownedDB/absenceassert, отсутствие lock; слот передан PAYROLL209.

Final128f evidence: `C:/Users/ADMIN/Documents/ChatGPT/HOOKAH CRM 2/tmp/ui-release-20261024/worktime-128f10e9/final-pg-128f/`. Это закрывает ранее записанный final-PG pending у128f в пределах23сценариев. Для U4 отдельный PG-run не заявляется: это только markup-condition/tooltip с прежними handlers/payload. Общий будущий integration/release gate остаётся у координатора. GitHub/VPS не менялись; полная исходная UI-цель и прочие U2 states не объявляются complete.
