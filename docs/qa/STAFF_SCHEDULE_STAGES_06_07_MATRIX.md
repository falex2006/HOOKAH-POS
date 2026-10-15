# Матрица приёмки этапов 06–09: серии, покрытие, календарь и экспорт

Статус на 2026-10-15: этапы 06–09 локально PASS. Полный acceptance — [`acceptance-1792038715423.json`](../../qa-artifacts/staff-schedule/acceptance-1792038715423.json): 44/44 suites PASS, `distParity=true`, `sourcesUnchanged=true`. Изолированная PostgreSQL `staff_schedule_qa`; GitHub/VPS/production не тронуты.

| Область | Реализация | Доказательство |
|---|---|---|
| Серии и исключения | Повторяемые смены, стабильный occurrence lineage, skip/replace/manual exceptions; серия ограничена диапазоном планирования | `series-domain`, `series-pg`, `planning-pg`, `planning-browser` suites — PASS |
| Потребность | Weekly/date-range rules, version/requestKey, tenant/settings permission, audit; effective cross-scope overlap (включая overnight) запрещается | `demand-domain`, `demand-pg`, `planning-http`, `planning-browser` — PASS |
| Покрытие | Интеграция по временным интервалам и функциям, один сотрудник не засчитывается одновременно в несколько ролей; DST/ambiguous local time и неизвестные breaks явно показываются | `coverage-domain`, `open-shifts-pg`, `planning-browser` — PASS |
| Открытая смена | Создание и публикация как незанятой смены; назначение не происходит скрыто и не превращается в payroll событие | `open-shifts-pg`, `planning-http`, `planning-browser` — PASS |
| Календарь | Месяц/неделя/день/список, переходы дат, overnight continuation, coverage/open shift details, мобильный first-card fit, фильтры и роли | `calendar`, `role-labels`, `month-planning`, `visual`, `keyboard` — PASS |
| Массовые действия | Сдвиг и отмена создают черновые операции с причиной; серии вынесены из bulk selection, чтобы не терять occurrence exception; до publish live rows не меняются | `planning-browser` и draft/version/concurrency suites — PASS |
| CSV/печать | CSV использует текущие фильтры; formula-dangerous cells защищены, контакты, логины, внутренние IDs и заметки не экспортируются; print view содержит диапазон и timezone | `planning-browser` suite; `schedule-print-preview.png` визуально проверен |
| Ограничения по неделям | Неделя пн–вс в TZ заведения; exact break intervals относятся к фактической неделе. Неразмещённый break через границу недель не распределяется наугад и создаёт advisory | `venue-policy-domain`, `planning-http`, общий acceptance — PASS |
| RBAC, tenant, payroll | Owner grants отдельно управляют view/manage/publish/settings; tenant isolation и payroll separation проверяются; открытая смена не создаёт назначенную явку | `access-*`, `service-pg`, `payroll-pg`, `browser-roles` и общий acceptance — PASS |

## Принятая семантика предупреждений

- Понедельник–воскресенье локального timezone заведения.
- Фактическое время между сменами для rest advisory; consecutive days по локальным датам.
- Если break time точно размещён — его минуты вычитаются на неделе фактического интервала; если только задано общее число и ночная смена пересекает неделю, выдаётся `schedule_weekly_break_unknown`, а точность не имитируется.
- Пороговые правила — операционные подсказки, не юридический комплаенс и не официальный payroll.

## Вывод

Локальные acceptance ворота этапов 06–09 закрыты. Не выполнены GitHub push и VPS deployment; для этого требуется отдельная команда пользователя.
