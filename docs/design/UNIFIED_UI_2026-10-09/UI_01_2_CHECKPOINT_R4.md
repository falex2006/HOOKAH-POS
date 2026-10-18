# UI-01.2 — текущий срез R4

2026-10-09. **IN_PROGRESS / NOT ACCEPTED.** Этот срез заменяет R3 как указатель текущего сбора; прежние отчёты и решения по старым SHA сохраняются исторически. Снимки не означают product PASS.

## Собрано

- Все **1 080 baseline slots**: 36 поверхностей × 5 ролей × 3 размера × 2 requested темы; по 216 на роль. Всего processor связывает **1 151** текущий capture с исходной матрицей из 6 480 строк. Независимое принятие каждого обязательного исхода ещё не закончено.
- Бармен и кальянщик: по 34 business surfaces на 1366×768 и 1920×1080 в обоих requested контекстах. Реальная смена собственных настроек тестовых сотрудников проверена через API и повторное чтение; применённая тема измеряется отдельно. Тёмный POS при выбранной светлой теме остаётся дефектом E01.
- Платформенная роль: собственные навигации, фиксированные размеры и фактическое окно. Public login captures обозначены как role intent, не как авторизованная роль. Для `/platform` действует кандидат отдельной фиксированной палитры EX-07; он не распространяется на tenant routes. GET platform preferences дал 404 до PATCH: предпочтение не изменялось.
- В локальном длинном tenant добавлены четыре новых стола с PS5/ТВ и вместимостью 1–5, 3, 2, 7 гостей. Собственные настройки повторно прочитаны через GET `/api/floor`; прежние столы не редактировались. Визуальные кадры бармена показывают эти данные, а также суммы 307/410/615 ₽ и время занятых столов.
- IAB восстановил корректные financial/payroll кадры 1920×1080 и manager clients light. Старые raster/theme rejects не наследуются новым SHA. Мягкость native financial bitmap ограничивает оценку мелкого текста.
- Public login baseline переснят после независимого обнаружения позднего автозаполнения: оба поля очищены, reload между кадрами не выполнялся. Ignored helper v10 проверяет присутствие заполненных паролей, включая раскрытые поля, перед снимком и перед записью; для public auth также проверяет заполненный логин. Никакие значения этот guard не возвращает. Собраны три настоящих Tab/Shift+Tab последовательности и три error кадра после одного входа с несуществующей синтетической записью; перед снимком поля очищены. Эти представители требуют current-hash review. После замены actual focus кадра выполнена новая последовательность, прежний action log не переносился.
- Бронирование владельца: реальные шаги 1→2→3 и возврат 3→2→1, ошибка пустого имени, раскрытый выбор места, длинные имя/комментарий, Next focus и Escape с возвратом к «Новая бронь». Новая бронь не сохранялась. Current step3 кадры сняты в трёх размерах; native API восстановил согласованность modal focus после несогласованного fullPage кадра. Нижние options раскрытого picker не подтверждены одним верхним кадром; дополнительный Tab после последнего Next дал BODY, полный цикл фокуса пока не принят.
- Личные настройки блокировки: открытие, пустые PIN поля, Tab/Shift+Tab, раскрытый интервал. Escape из фактически активного option закрывает список и возвращает focus к trigger; следующий Escape закрывает окно и возвращает focus к «Настроить защиту». PIN и security preferences не менялись, Save не нажимался. Первую попытку Escape с перефокусировкой на trigger не использовать как доказательство поведения активного option.

## Текущий processor

Команда: `node tmp/ui012-baseline/process-r2-evidence.cjs`.

| Исход | Строк |
|---|---:|
| CAPTURED_PENDING_REVIEW | 1 135 |
| SUPPORTED_THEME_DEFECT | 11 |
| CAPTURE_REJECTED_STATE | 4 |
| CAPTURE_REJECTED_FOCUS | 1 |
| N_A_DENIED_BUSINESS_REGION | 1 608 |
| PENDING_CAPTURE | 3 721 |
| PASS | 0 |

6 480 уникальных case IDs и tuples, 180 role×surface pairs сохранены. Все references существуют, origin совпадает с `http://127.0.0.1:31952`, raster mismatches и deferred captures — 0. Это проверки целостности материала, не доказательство готовности UI.

Четыре rejected empty regions: staff с четырьмя аккаунтами, справочники с seeded значениями, сеть с текущей точкой, одиночная карточка интеграции. Их нельзя считать empty только по имени fixture. Старый platform keyboard capture ещё требует действительного forward/back Tab и текущего bitmap review.

## Осталось для приёмки

1. Завершить независимый review текущих baseline SHA, session/route bridges, readiness и requested/actual theme contexts. Pending shift/redirect не принимать за готовый business region.
2. Заморозить конечный source-based ledger обязательных state/component representatives и пройти незакрытые loading/error/keyboard/form/dialog/expanded-content сценарии. [Предложенный ledger](UI_01_2_REPRESENTATIVES_R4.json) сохраняет 716 inventory records исторически и отделяет 42 визуальные группы / 198 visual-state obligations от полного behavioral regression. Это proposed mapping, а не 198 принятых исходов.
3. Явно принять или отклонить [предложенный R4 gate](UI_01_2_BASELINE_GATE_R4.md) через DECISIONS и независимые signoffs. Пока он **PROPOSED / NOT ADOPTED**; сужение обязательств не произошло автоматически.
4. Сохранить непройденные exhaustive сценарии в UI-09.1, без превращения backlog в PASS или N/A.

## Границы

Проверка использует отдельные PostgreSQL fixtures и локальный proxy; финансовые samples — только синтетические GET references с provenance. Proxy возвращён в `normal`. После серий временный viewport override сброшен. Runtime browser — Codex In-app Browser; исторические Edge кадры остаются со своими dimensions и timestamps. Actual окно менялось во время проверки (в том числе 718×764, 1366×768 и 1280×720): каждый JSON сохраняет собственный измеренный размер, общий размер для всей истории не утверждается. После исчезновения временной вкладки 1 документированный список оказался пуст; работа продолжена в новой вкладке 2 того же браузера, без смены способа управления.

Пять дополнительных компонентных пар JPG/JSON находятся в `evidence/UI-01.2/r2/components-r4/`. Они сохраняют отдельные сцены и не увеличивают автоматически число mapped matrix captures; reduced-schema snapshots не наследуют consistency/raster proof другого кадра.

Продуктовые CSS/JS/dist, GitHub и VPS этим пакетом не изменялись. UI-02.1 ещё не начат. Материал и отчёты: [визуальный review](UI_01_2_VISUAL_REVIEW_R4.md), [code health](UI_01_2_HEALTH_R4.md), [контракт](UI_01_2_REMAINING_CONTRACT_R4.md), `evidence/UI-01.2/r2/manifest.json`, `r4-theme-fixture-proof.ndjson`, `r4-table-amenities-fixture-proof.json`, `sample-provenance-r4.ndjson`.
