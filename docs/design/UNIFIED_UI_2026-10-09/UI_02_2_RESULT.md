# UI-02.2 — общие контролы, типографика и фокус

2026-10-09. **ACCEPTED_SCOPED_WITH_DOCUMENTED_LIMITATIONS**. UI-02.1 принят. Intake HEAD `802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf`; существующее dirty дерево сохранено. Модель/уровень в интерфейсе не подтверждены, текстовое переключение не заявляется. Координатор интегрировал frontend; design lead, QA и code health выполняли независимые проверки.

## Результат

D09/D16/D17 перепроверены по текущему CSS. Вместо миграции всех разделов добавлен явно подключаемый контейнер `.ui-components` и общий набор:

- Кнопки primary/secondary/quiet/danger, icon button; native disabled, ожидание, guard повторного нажатия, резерв геометрии текста/спиннера.
- Input/select/textarea, readonly/disabled/loading/error; checkbox unchecked/checked/indeterminate/disabled/error; пассивные status badges.
- Manrope 400/500/600/700/800; пояснения 12px, основной текст/поля/кнопки 14px, lead 16px, section 20px, page 28px. Числа 20px / 700 с tabular-nums.
- Hit area не меньше 44×44; основная action кнопка 48px. Видимый keyboard focus, semantic цвета двух тем; motion 150/200ms и spinner 900ms, manual/OS reduced-motion декларации.
- [Локальный эталон](components/README.md), каталог вариантов и правила подключения для последующих задач Luna.

Новых декоративных решений нет: поверхности сплошные, существующие фирменные accent/action роли сохранены. Badges содержат текст; цвет не является единственным обозначением статуса. Новые контролы не внедрялись на продуктовые страницы. Старые D09/D16/D17 остаются долгом поэтапной миграции.

Независимые проверки выявили и закрыли конфликты legacy CSS: второй `aria-busy::after` spinner поверх текста, схлопывание резервного busy label через `[hidden] !important`, opacity disabled checkbox, слабую рамку focused select в light theme. Исправления ограничены opt-in family. Подсказки и имена полей явно связаны ID. В локальном эталоне снято унаследованное `body overflow:hidden`, чтобы нижние разделы реально прокручивались.

## Файлы пакета

| Файлы | Изменение |
|---|---|
| `style.css`, `dist/style.css` | 9 332 добавленных байта opt-in CSS; прежние 553 632 байта — точный префикс; только CSS mirror синхронизирован |
| `DESIGN_TOKENS.md`, `COMPONENT_CATALOG.md` | Внедрённые размеры/type/motion, варианты и ограничения использования |
| `components/{UI_02_2_REFERENCE.html,ui-component-reference.css,ui-component-reference.js,README.md}` | Локальная демонстрация и инструкция |
| `scripts/ui-component-primitives-contract.mjs` | Source contract: scope, geometry/type/motion, labels/help/states, no API/storage, mirror |
| `scripts/ui-component-reference-server.cjs` | Повторяемый localhost preview, explicit allowlist/CSP, без production route |
| `scripts/ui-component-browser-measure.mjs` | Read-only измерения через переданный документированный CUA tab |
| `scripts/ui-component-evidence-check.cjs` | Валидация сохранённых наблюдений и manifest; браузер не запускает |
| `evidence/UI-02.2/final`, этот результат, reviews, PROGRESS/PLAN, рабочий журнал/решение | Привязка к исходникам, снимки, замеры, границы приёмки |

CSS SHA-256: `1fd697d80716cc9de52ac13048b6e5eca2dc5ac3ad96a25d68649eae63707bba`. [Scope diff от intake](evidence/UI-02.2/final/scope.patch) отделяет новый пакет от большого прежнего WIP. Во время работы дополнительно изменились `portal.js`/`dist/portal.js`; происхождение этих конкурентных правок не установлено, координатор и три UI-02.2 агента их не редактировали. Они сохранены и исключены из этого пакета. Равенство всего workspace baseline не заявляется.

## Проверки и доказательства

| Проверка | Результат |
|---|---|
| `node scripts/ui-component-primitives-contract.mjs` | PASS |
| `node scripts/ui-semantic-token-contract.mjs` | PASS; сохранён контракт UI-02.1 |
| `node scripts/local-design-contract.mjs` | PASS; 14 routes / 27 dist routes |
| `node scripts/header-shell-contract.mjs` | PASS; 11 management routes |
| `node scripts/dashboard-kpi-design-contract.mjs` | PASS |
| Syntax новой reference JS и четырёх новых scripts, scoped diff | PASS |
| `node scripts/ui-component-evidence-check.cjs` | PASS сохранённых наблюдений: 51 пара, current source bindings, stable before/after, geometry/contrast/focus/guards/states |
| Raster | PASS: 51 JPEG точно совпадают с объявленным clip; [проверка](evidence/UI-02.2/final/raster-checks.json) |
| Независимые ревью | Design, QA, code health — GO в заявленной области; [заключения](UI_02_2_REVIEWS.md) |

Браузер: отдельный localhost reference на 31957, без accounts/API/БД. **1366×768, 1920×1080, фактический 1280×720**, обе темы, top/middle/bottom; 390×844 — отдельная узкая регрессия и дополнительный кадр lower fields. Нижние кадры имеют ненулевой фактический scroll. Большой desktop middle уже достигает bottom — это одинаковая область, а не дополнительные уникальные состояния.

51 кадр: 26 matrix + 8 keyboard focus + 8 pointer/hover + 4 busy before/during + 2 manual reduced-motion + 1 completion + 2 long select. [Checks/manifest](evidence/UI-02.2/final/checks.json) содержит SHA каждой JPEG/JSON пары. JSON `before/after` — до/после снимка одной версии, а не baseline/implementation. Full-page screenshot обрезан по измеренным scroll/viewport bounds; полосы прокрутки могут исключаться через contentWidth. Фактический размер clip хранится отдельно от CSS viewport. Native cropped промежуточные снимки заменены; изображения вне `final/` не являются доказательством приёмки.

| Итоговый минимум | Замер |
|---|---:|
| Active normal-size text | 5.814:1 |
| Meaningful control boundary | 3.752:1 |
| Keyboard focus | 6.499:1 |
| Hit area | 44×44 CSS px |

Расчёт WCAG luminance/contrast использует вычисленные RGBA с compositing solid/transparent предков. Все `paintAssumptions` пусты: opacity1 и отсутствие background images подтверждены, произвольные opacity/gradient случаи этот helper не моделирует. Quiet text button имеет прозрачную границу: требование meaningful boundary к нему не применено, text/focus проверены. Checkbox hit target — label, индикатор 20px; focus/style читаются с actual input. Disabled текст не заявляется как active contrast, но видимая рамка и glyph проверены. Badges пассивны и не требуют 44px hit area.

Keyboard: Tab к primary button; ввод/удаление символа в empty input; Space переключает checkbox, native select ArrowDown/Alt+ArrowDown/Escape. Все 8 expected IDs/:focus-visible подтверждены. Pointer captures — фактический click на локальных образцах с `:hover=true`, не искусственная DOM установка состояния.

Double click: dark `0→1`, light `1→2`; native disabled/aria-busy во время ожидания, один запуск на double click. Размер dynamic button до/во время/после — **206.825×48**; terminal «Проверка завершена», enabled. Это локальный пример блокировки, не продуктовая idempotency/API проверка. Indeterminate установлен actual DOM property reference script, измерен через `matches(':indeterminate')`. Десять `1` и десять `8` имеют одинаковую ширину; длинная сумма читается целиком.

## Ограничения

- **OS reduced-motion фактически не включён:** доступный runtime не предоставляет такую эмуляцию, системное предпочтение false. В обеих темах ручной режим имеет 0ms transitions, spinner animation none, legacy busy pseudo none. [CSSOM](evidence/UI-02.2/final/motion-cssom.json) подтверждает разбор OS media rule и эквивалентность деклараций. Фактическое включение через ОС остаётся отдельной проверкой перед UI-09.1, владелец QA; native OS PASS не заявлен.
- Native collapsed select может обрезать длинный вариант; End выбирает полное `value=long` в обеих темах. Полная видимость всего названия в collapsed select не заявляется. Для длинных категорий UX определяет владелец соответствующего экрана.
- Существующие экраны/роли не используют новый opt-in family: роль×состояние, API/БД/расчёты/PIN/платежи не проверялись этим эталоном. Совместимость обеспечивается точным CSS prefix и focused contracts; это не весь product runtime regression. Полная миграция, mobile/Fold — профильные этапы/UI-09.1/UI-10.1.

Viewport override сброшен. Локальный reference доступен отдельной вкладкой, preview слушает только loopback. Пользовательские sessions/drafts и frozen QA-стенд не менялись. API/БД, tenant/permissions/routes и бизнес-логика пакетом не изменены. GitHub/VPS не публиковались.

**Следующий отдельный подэтап:** UI-03.1 «Единая оболочка сотрудника и портала», GPT-6.1 Sol / High. Автоматически не запущен.
