# U2: список планов — загрузка, ошибка, повтор и закрытие

Сценарий исходной матрицы planning hidden states, пакет поверх9a530cb8. Baseline независимо прочитан MASTER: reloadHome вызывал общий mutation pending helper для GET, блокируя Close/Escape; catch оставлял прежние активные строки, не давал локального повтора, успех не убирал старый error. BrowserRED12 несовпадений (шесть на каждую ширину390/1440),10снимков сохранены отдельно.

Минимальная правка reloadHome в staff-schedule-planning-ui.js/dist: capturedpanel, GET-local singleflight и снимок disabled native action/list buttons, восстановление прежних attached control states. Close/Escape остаются доступными; общий mutation helper не менялся/не обходился. Старый список заменяется status загрузки, ошибка показывает escaped rolealert и локальный retry. Поздний ответ закрытого окна не применяется. Успешный повтор даёт свежий список и очищает старый error. Создание/запись/публикация draft, payload, backend и права не менялись.

Визуально подтверждённый flush error/retry исправлен расширением прежнего12px alert selector на data-drafts. Смещённый маленький Unicode caret «Ещё» присутствовал уже в baseline; реальное clipping не утверждается. Для законченного видимого сценария согласована точечная planning-home CSS стрелка из border8px+margin8px с двух сторон (24px footprint), closed45/open225. Она выровнена через существующий flex; общие стрелки, sidebar, focus и native details states не изменены.

## Доказательства

- scripts/staff-schedule-planning-home-browser-qa.cjs: actual mounted schedule/planning modules/CSS, syntheticGET-only API, source12/dist12 PASS390/1440. Loading, empty, populated,503+no actionable stale rows/localretry, recovered/errorclear, close/reopen while oldGET resolves. Дополнительно forced повтор GET остаётся singleflight; Escape закрывает heldGET и поздний ответ не открывает окно. Held-start bounded7s/clearTimeoutfinally. Все API requests обязаны быть GET.
- Snapshot ждёт конечных анимаций и проверяет dialog bounds/scrollWidth. Открытый/закрытый disclosure на390/1440 осмотрен root; computed pseudo-element8x8/static/emptycontent/nonzero transform проверен. Не объявляется полный shell/RBAC proof. Нового overlay spinner не добавляли — loading имеет role=status.
- Lifecycle9/discard/graphite/syntax/source-dist JS+CSS parity/diff PASS, точный focused terminal30680exit0. Независимый MASTER baseline/finalJSdiff, dist12 rerun и визуальный reopened1440; disclosure correction дополнительно согласована отдельно. Subagent reviews недоступны usage-limit, их GO не заявляется.

Артефакты tmp/planning-home/{baseline,source,dist}/report.json и снимки. Это GET-компонентная приёмка списка планов, не реальные draft mutation/publish/PG/customACL/вся planningсистема. Actual attendance69 boundsexactolderce4f10b7, не новый planningPG. Другие исходные U2 состояния остаются открытыми; production/GitHub/VPS не изменялись, PG слот остаётся у payroll.

MASTER incremental finalCSS review: new error390 vector caret aligned/fullyvisible, error/retry gap clear, scoped GO8paths; prior independentJS/dist12 remains. No global navigation contract affected.
