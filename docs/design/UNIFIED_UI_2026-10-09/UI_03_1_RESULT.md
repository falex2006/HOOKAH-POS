# UI-03.1 — Единая оболочка сотрудника и портала

Статус: **ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**. Локальный программный пакет принят в desktop области шире 900 px. GitHub/VPS публикации нет. Следующий этап не запущен.

## Причина и результат

Текущий baseline HEAD `802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf`, с сохранённым большим незакоммиченным деревом. Свежие 16 исходных кадров подтверждают D02: у сотрудников зал→портал менял меню 210→244 px и шапку 68→72 px; у управляющих меню 210→245.95/280 px, отступы шапки 42/56→32.7936/38 px. Логотип также менял положение из-за сжатия брендового блока.

Согласованный system_architect/design_lead контракт внедрён только внутри `@media(min-width:901px)`:

| Семейство | Меню | Шапка | Внутренние отступы |
|---|---|---|---|
| Сотрудники | 210 px в зале и портале | 68 px на проверенных desktop | header clamp(18px,2.4vw,38px), sidebar clamp(14px,1.2vw,22px) |
| owner/admin/manager/developer | clamp(210px,18vw,280px) в обоих интерфейсах | 68 px на проверенных desktop | те же формулы |

Размеры по семействам сохраняют рабочую плотность. POS получает косметический `staff-management-shell` только из подтверждённого session actor. Действия и пункты меню остаются существующими, короткое имя сотрудника/полное имя в title сохранены. PIN, смена, профиль, блокировка и серверные permissions не переопределены. Операция смены в POS и информационный статус в портале сохраняют свои разные назначения.

Брендовый блок больше не сжимается; интерактивный аватар POS и профиль портала получили desktop цель 44 px. Длинное заведение сжимается внутри своего места, название текущей страницы читается полностью. Новых декоративных решений, цветов, зависимостей или оформления бизнес-страниц нет.

## Изменённые файлы

- `app.js`, `dist/app.js`: чистый предикат роли и один class toggle в `applyStaffSession` (+233 bytes относительно intake).
- `style.css`, `dist/style.css`: точный старый префикс 562964 bytes +1618 bytes scoped geometry; итоговый CSS SHA `e224bf12d0a562817beaf02da8258f98698ad1ac0749c7c6c9ac24a9e37719bc`.
- `scripts/ui-role-shell-contract.mjs`: подтверждённая роль, область CSS, breadcrumb contract, mirrors.
- `scripts/ui-shell-browser-measure.mjs`: read-only браузерные метрики, видимость/denied/pending, реальные interactive hosts.
- `scripts/ui-shell-evidence-check.cjs`: saved source/raster/stability + desktop geometry assertions.
- Каталог C01, DESIGN_TOKENS, PLAN/PROGRESS, этот итог/ревью, журнал/решения и доказательства.

Финальный аудит 771 существующего пути: изменены четыре указанных product files и документ DESIGN_TOKENS.md; пропавших нет. `portal.js`, `header-shell.js`, API, DB, grants, tenant, routes и расчёты равны intake. Предыдущие concurrent изменения портала сохранены. Source/dist app и CSS byte-equal. Git HEAD diff содержит прежний WIP и не равен пакету UI-03.1.

## Выполненные проверки

Основная матрица: четыре временные роли owner/manager/hookah_master/bartender × `/`, `/clients`, `/admin#tasks`, `/reservations`, `/finance` ×1366×768/1920×1080 ×dark/light = **80 кадров**. 72 разрешённых экрана: стабильные sidebar/header/main origin, header68, role width, padding/brand; все действия шапки ≥44×44, внутри шапки, без наложений или горизонтального переполнения. Восемь базовых worker reservations — ожидаемый отказ, скрытая оболочка null; геометрия и тема отказа N/A, права не расширялись.

46 дополнительных кадров:

- 20 на фактическом экране браузера 672×764 DPR1.25, owner/hookah_master, обе темы и пять маршрутов.
- 8 отдельных narrow390×844 кадров, две роли/темы, зал/гости.
- Клавиатурный focus, PIN settings открытие/закрытие, профиль Enter/отмена; без сохранения.
- Шесть фактических переходов через меню: owner зал→гости→задачи→бронирования→финансы; worker гости→задачи→финансы. Отсутствующая worker бронь проверена отдельными denied кадрами.
- Четыре пустых workspace кадра; loading GET /api/shifts,/api/venue с задержкой 5sec, read error503 и recovery; mobile drawer открытие и Escape.

**126 final JPG/JSON**, все before/after метрики равны, 1260 source hash refs актуальны, native JPEG размеры равны CSS clip. DPR записан отдельно: backend снимков нормализует размер в CSS px. 16 baseline и пять ранних diagnostic кадров сохранены отдельно, не входят в final PASS. [Manifest](evidence/UI-03.1/manifest.json) содержит source/tool/evidence SHA. Итоговый [аудит](evidence/UI-03.1/checks.json) сверил 294 хеша evidence files и все 215 snapshot assets с текущим корнем проекта.

Новый source contract и девять относящихся contracts PASS: header-shell, staff-shell-parity, sidebar-venue-header, staff-mode-navigation, staff-header-actions-runtime, sidebar-navigation, local-design, ui-component-primitives, ui-semantic-token. Saved-evidence checker PASS. Syntax/scoped diff checks PASS. Название `runtime-qa` у source script не означает live финансовую операцию.

Независимые system_architect, design_lead, code_health_engineer и qa_engineer дали scoped GO: [ревью](UI_03_1_REVIEWS.md). QA отдельно сверил bounds/overlap/raster; design осмотрел представительские пиксели, не заявляется попиксельный просмотр всех 126 кадров.

## Границы и отдельный долг

1. **≤900 px:** старые различия остаются. Actual672 worker POS64→portal72;390 owner96→112. Имя/роль скрываются; avatar/profile цели32–36px; на672 POS кнопка меню перекрывает начало «Рабочий зал». Page overflow0; drawer/Escape работают. Это явно записанный мобильный долг UI-10.1, без заявления полной адаптации или geometry PASS на этих ширинах. UI-03.1 меняет только >900px CSS.
2. **POS light:** действующий POS не применяет сохранённую тему при старте. Светлые POS кадры — согласованный isolated HTML body `light-theme` class fixture с тем же принятым CSS/app, SHA исходного/fixture HTML в manifest. Реальный portal dark/light проверен через preferences временных аккаунтов. Runtime переключение темы POS не внедрено и не объявляется проверенным. Старые светлые dark islands/контраст относятся к UI-02.1/08.x долгу.
3. Admin/developer и другие operational роли проверены чистым role predicate/source contracts; реальные браузерные аккаунты только четыре перечисленных. Разрешённый worker reservation shell не проверен: базовые permissions запрещают маршрут. Восемь отказов реальны и ожидаемы.
4. Live изменения PIN/профиля, смены, logout, receipts уведомлений/платежи не исполнялись. Сохранность узлов/guard/handlers подтверждена source contracts; открытие PIN/profile и фокус — реально. Сессии пользователя/production не сбрасывались. Fold отдельно UI-10.1.

## Среда и завершение

Изолированный loopback UI03131958 overlay текущих 215 static assets поверх disposable UI01231953 PostgreSQL/auth; только синтетические данные, реальные server permissions. Proxy не подменяет auth/403 и меняет только успешные тестовые GET в именованных read-state сценариях. Private credentials не включены в evidence. Фактический выбор модели в интерфейсе не подтверждён; текстом модель не переключалась.

В конце read faults отключены, исходные темы временных аккаунтов восстановлены, override размеров сброшен. Сохранённые прежние QA сервисы не изменены; собственный proxy UI031 остановлен после сверки созданного PID, процесса Node и listener31958. Production/GitHub/VPS не публиковались.

Далее отдельное поручение **UI-03.2 «Навигация и сохранение контекста», GPT-6.1 Sol / High**.
