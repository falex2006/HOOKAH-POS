# UI-04.1 — независимые ревью

Дата: 2026-10-10. **GO_SCOPED_WITH_DOCUMENTED_DEBT** для общего UI lifecycle и одного new-task пилота, локально.

## Разделение работы

Координатор применял профиль frontend_engineer, интегрировал продукт и выполнял реальные CUA сценарии, API readback, focused tests и сводку. Три нативных помощника выбраны по team.json; им не поручались одновременные записи в один файл. Они проверяли baseline/контракты/итоговый diff и сохранённые pixels независимо. Их source/saved review не выдаётся за отдельное самостоятельное управление теми же браузерными сценариями.

- **System architect — SOURCE GO.** Выбор task пилота и custom overlay после статического PIN опыта, контракт adapters/domain/lifecycle, отсутствие изменений API/tenant/permissions/финансовых handlers. Замечания по native inert, single-form lease, visible select ARIA, discard/resume focus, pointerup/cancel, title и callback settlement исправлены. Последний CSS-only delta отдельно прошёл health/QA. [Полные notes](evidence/UI-04.1/reviews/system_architect.md).
- **Code health — SOURCE GO.** Baseline и final, 777 путей без удаления, ровно 7 существующих изменений, 4 mirrors, точный old CSS byte prefix и один static allowlist entry. 74 actual-source checks, 23 focused scripts, syntax/diff; исправлена регрессия сокращения прежних POS8–12s. Финальные две CSS правки схемы/иконки даты проверены. Наследуемая PIN regex ошибка отмечена отдельно. [Полные notes](evidence/UI-04.1/reviews/code_health_engineer.md).
- **QA/design — GO в области UI-04.1.** Обнаружены и исправлены stale capture binding, ошибочные light labels, pale light chevrons/calendar и dark inverted calendar. Координатор переснял зависимые кадры, не переписал старые bindings. Независимо просмотрены final desktop/ошибки/narrow/PIN/fallback; checker PASS98пар/1044refs/5accepted201. Нормализация readback привязана к SHA старого task POST handler. [Полные notes](evidence/UI-04.1/reviews/qa_engineer.md).

## Границы GO

Static PIN опыт не проверяет настоящую авторизацию, auto-lock или unlock; mixed stack и реальный concurrent auth race остаются UI-04.3. Один shared form и один бизнес-пилот; legacy/финансовые окна и полная мобильная адаптация не мигрированы. POS сообщения имеют отдельную совместимость таймеров, не полную новую классификацию всех ошибок. Старые light/sidebar/business дефекты сохраняются. GO не означает публикацию в GitHub/VPS.

[Результат и точные проверки](UI_04_1_RESULT.md) · [check outputs](evidence/UI-04.1/checks.json)
