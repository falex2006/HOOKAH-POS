# UI-03.2 — Независимые ревью

Статус: **ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**. Заключения ниже относятся к локальному navigation пакету и не являются разрешением production release. Финальная браузерная приёмка и числа приведены ниже.

## system_architect — контракт и candidate review

Владелец sidebar/header контракта прочитал актуальные role/workflow/SITE_TREE/PROMPTS, перепроверил D03 и рассмотрел intake-relative portal diff. Одобрен scoped verified user+venue namespace с одним versioned объектом и полным игнорированием legacy flags; unknown identity работает только в памяти. Native summary change синхронна с preventDefault, последующие toggle события не пишут state. Reload same URL возвращает manual single/null; новые URL/hash/query/history и BFCache arrival синхронизируют группу маршрута без structural rebuild.

Поиск одобрен как временный multi-open exception с restore normal selection после очистки, group-title/item matching и пересечением permissions/role/interface visibility. Контракт не требует добавлять venue/workspace query во все anchors: session остаётся источником tenant, существующие management URL, inventory query forwarding и employee context сохраняются.

Найденный архитектурой candidate integration defect закрыт: dashboard/finance/inventory permission-only resets теперь вызывают controller refresh, поэтому settings visibility не теряется после hash/view перехода. Code-health замечание late preference unavailable selection также исправлено fallback на доступную route group/null с сохранением normal state. Подтверждённый browser дефект inventory arbitrary hash исправлен только в active matcher; query/hash сохраняются, admin/finance semantic не меняется.

Прямое чтение пяти final tenant JSON подтвердило stable=true, portal SHA `300a7d893ce1303747f2415793f751759185e2f16166cf2f5d7bcb94a47addbe`, один owner ID, разные venue A/B IDs, A finance/B team и их повторное восстановление. B уже имела прежнюю сохранённую настройку; fresh namespace не заявляется. Браузером управлял координатор, reviewer не заявляет собственные live действия.

Финальное архитектурное решение: **GO_SCOPED_WITH_DOCUMENTED_DEBT**. Независимо выполнены checker115/1150/60 и VM56, прочитан исправленный actual-light JSON и осмотрены actual-light/1920-light-search-title пиксели. Роль/desktop/theme/history/search/preferences/user isolation и дополнительные состояния включены в итог с точными ограничениями. При любом изменении замороженного portal требуется новое source-bound доказательство.

## code_health_engineer — независимый source GO

Источник заключения: `tmp/ui032/health-notes.md`, финальный source audit на portal SHA `300a7d893ce1303747f2415793f751759185e2f16166cf2f5d7bcb94a47addbe`. Product файлы этот reviewer не изменял.

- Diff ограничен controller/helpers, disclosure wiring, active URL matcher, независимой visibility composition и лёгкими history/preferences hooks. Source/dist portal byte-equal; API/DB/auth/grants/calculations/прежняя UI-03.1 geometry не менялись.
- Выполнены actual-source VM 56 checks, шесть matcher случаев, 12 scoped contracts, шесть syntax checks и scoped git diff --check: PASS. Импорт VM из runtime contract не создаёт дополнительный независимый набор.
- Intake scan 774 files: missing0, существующие changes — SITE_TREE.md, portal.js, dist/portal.js и три navigation contracts. Новые scripts/docs/evidence учитываются отдельно.
- Найденная P2 late-preferences fallback исправлена; unused routeChange/captured URL/path/hash удалены. Owner-only menu-audit assertion соответствует существующему guard; серверные права не расширены.

Решение: **SOURCE GO**. Фактические native keyboard/history/tenant действия и визуальная приёмка относятся к browser QA, а не к source audit.

## qa_engineer / design_lead — итоговое подтверждение

QA составил независимую матрицу N01–N13 в `tmp/ui032/qa-notes.md`: последовательное раскрытие/закрытие, reload single/null, route hash/query/history, multi/title/no results/clear search, preference visibility, modified anchors, actual user/venue selection, employee flat-menu and denied route, malformed/legacy/storage exception unit branches.

Первый candidate checkpoint подтвердил три stable кадра раскрытие→reload и представительные пиксели; дал source/initial pixels GO с требованием реальной verified identity в evidence и дополнительных modified-home/temporary-search-summary tests. Кандидат затем обновлён; исторические три кадра не заменяют frozen-source final set. Финальное независимое QA/design заключение: **GO_SCOPED_WITH_INHERITED_DEBT**; checker115/1150 и VM56 PASS, все safe identity metadata115/115 соответствуют реальным browser GET, desktop geometry110/434targets PASS. Три repaired narrow JPG осмотрены повторно и соответствуют JSON, исправленный actual-light sidebar доступен после reload. Контраст светлого summary и старый resize inert явно оставлены долгом.

## Общие ограничения приёмки

Наследуемый narrow UI-03.1 долг и light business-content contrast/dark islands остаются явно вне scope; нет обещания полной phone/Fold адаптации. Worker denied destinations не превращаются в разрешённые страницы. Native BFCache hit не подтверждается одним VM force-branch. Мигрируется только disclosure state, не все UI preferences. Tokens/credentials не входят в evidence; publication отсутствует. Следующий этап отдельно.

## Final acceptance

Координатор заморозил portal300a7d89 и свёл независимые заключения. Code-health: источник и обновлённый checker GO, 12 source contracts/VM56/syntax/scoped diff PASS. QA/design: **GO_SCOPED_WITH_INHERITED_DEBT**,115 пар/1150 hash refs, actual IDs115/115 matched, desktop geometry110/434header targets. Исправлены stale paint narrow captures и недостоверный actual-light кадр после inherited resize inert; старые кадры только diagnostic. Native viewport raster rounding4×1px явно отдельно.

Права/tenant/user/history/search/preferences проходят в своей области. Светлый sidebar summary и business contrast, прежний narrow→desktop inert, native BFCache hit, full Fold и другие исторические state keys остаются указанными ограничениями. Architect final notes приложены отдельно; frontend координатор подтверждает реализацию согласованного controller без route/permission/API redesign. Это локальная приёмка, не production release.
