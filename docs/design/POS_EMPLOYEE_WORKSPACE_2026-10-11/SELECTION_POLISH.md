# Спокойное выделение выбранного стола

11.10.2026. Владелец указал, что контур при выборе стола слишком жирный. Причина: border 1 px плюс внешний outline 2 px с отступом 2 px.

В scoped `pos-workspace.css` внешний outline явно отключён, чтобы не вернулась legacy рамка из `style.css`. Остались одна тематическая граница 1 px и существующая заливка 6%, без тени. Отдельный `:focus-visible` сохранён после selection: 3 px dashed с отступом 5 px для клавиатурного доступа. Стили используют прежний `--ui-focus` в обеих темах; API, геометрия, selection handlers и права не менялись.

CSS/index source и dist совпадают, CSS rev4. Старый polish runner берёт ожидаемый CSS href из index вместо устаревающего hardcoded rev3.

`node scripts/pos-table-selection-browser-qa.cjs` — PASS: GET-only fixture, обе темы, pointer outline 0 px / border 1 px / no-shadow, tint, неизменная геометрия внутри уже открытой панели, единственный выбранный стол, отдельный keyboard focus, повторный выбор мышью после перехода на другой стол; JS errors0 / API writes0. Native Chrome может сохранять focus-visible при повторном клике по уже сфокусированному клавиатурой элементу — стандартная эвристика доступности не переопределялась.

Design lead подтвердил screenshots обеих тем: визуальный PASS. Semantic-token, component-primitives и local-design contracts, syntax обоих browser runners и diff-check — PASS. Full viewport/business matrix не повторялась для одной CSS декларации. Независимый code-health: PASS, новых замечаний нет. Exact baseline comparison подтвердил единственное изменение CSS outline/offset и CSSrev в index; app.js, pos-workspace.js и style.css неизменны. Baseline CSS `1C87D621…85B587`, index `363285E8…EDBA2D`.

Доказательства: [pointer dark](evidence/selection-softening/dark-pointer.png), [pointer light](evidence/selection-softening/light-pointer.png), [keyboard dark](evidence/selection-softening/dark-keyboard.png), [keyboard light](evidence/selection-softening/light-keyboard.png), [qa.json](evidence/selection-softening/qa.json).

[Фактический Edge screenshot](evidence/selection-softening/edge-preview.png). Локальный Edge обновлён с сохранением стола1 и ручного размера90%. Worktree isolated `pos-employee-workspace`; исходный dirty checkout не изменялся, production не публиковался.
