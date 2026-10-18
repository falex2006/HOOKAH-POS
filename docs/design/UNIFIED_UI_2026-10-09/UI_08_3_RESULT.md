# UI-08.3 — завершение эффектов и очистка каскада

Дата: 2026-10-10  
Статус: **ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**  
Исходный HEAD: `802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf`; рабочее дерево было грязным до этапа. Baseline code-health/QA/frontend сохранён в `tmp/ui083/*-baseline.md`. Перед правкой `style.css` и `dist/style.css` совпадали побайтно (SHA-256 начинался `C98B5D415F638CF07`); прошлые WIP изменения были унаследованы и не переписывались.

## Результат

- Системный `prefers-reduced-motion` и явный `.ui-motion-reduced` теперь останавливают общий legacy spinner на `.loading` и `[aria-busy="true"]`. Текст загрузки, `aria-busy` и блокировка указателя остаются прежними.
- Sweep animation отделена от общей border/surface группы: platform modal больше не получает declaration вращающейся анимации. Общая прозрачная border declaration сохраняется; поздний `platform.css` задаёт semantic `--ui-panel` фон, `animation:none` и статичный outline. Живые legacy portalAction окна и company-specific override не удалялись.
- В `COMPONENT_CATALOG.md` и EX-05 уточнены границы эффектов и отложенные миграционные исключения.
- Cursors и role gate не менялись. Исправленный VM mock `staff-cursor-zone-qa.mjs` проходит role allowlist, состояния, SVG/native fallbacks и source/dist sync. Фактический рендер SVG системным курсором не проверен.
- `style.css` и `dist/style.css` синхронны.

## Сознательно оставлено

`inventory-item-modal` реально создаётся/удаляется как anchored editor в `portal.js`; он пока не использует принятый общий C11 modal lifecycle. Его sweep оставлен до миграции. Старые POS catalog/payment/action и custom-role consumers также не объявлены мигрированными и не менялись. Company action сохраняет специальный статичный стиль. Отдельная пульсация frame на Company остаётся согласованным брендовым ambient эффектом; поведение при reduced-motion сохраняется.

D10 undefined `var(--text)` из исторического аудита в текущем stylesheet не воспроизводится; D17 9px/650/750 оставлены без blanket normalization: компактные статусы/табличные элементы требуют отдельного рендер-замера.

## Проверки

- `node scripts/ui083-effects-cascade-contract.mjs` — PASS.
- `node --check scripts/ui083-effects-cascade-contract.mjs` — PASS.
- `git diff --check` — PASS; `style.css` и `dist/style.css` побайтно равны.
- `node scripts/ui-component-primitives-contract.mjs` — PASS after narrowing its `!important` scan to the UI-02.2 component block.
- `node scripts/staff-cursor-zone-qa.mjs` — PASS after completing the VM table mock (`dataset`, `setAttribute`, `removeAttribute`); role allowlist, six cursor states, fallbacks and copies pass.
- CSS parser and browser pixel/computed-style comparison on 1366×768, 1920×1080, actual viewport, both themes and live roles were unavailable/not run. This is scoped CSS contract acceptance, not full visual PASS. Old inventory/portalAction sweep debt remains registered until C11 migration.

The two existing harness failures identified during UI-08.3 were fixed in a follow-up test-only change; no product files changed.

## Публикация и следующий этап

GitHub/VPS не публиковались, production не затрагивался. UI-09.1 — следующая рекомендуемая точка плана (GPT-6.1 Sol / High); автоматически не начат.
