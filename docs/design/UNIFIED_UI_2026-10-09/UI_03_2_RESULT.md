# UI-03.2 — Навигация и сохранение контекста

Статус: **ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**. Локальный пакет завершён; независимые architect, QA/design и code-health подтвердили приёмку в согласованной области. GitHub/VPS не опубликованы; следующий подэтап не запускался.

## Причина и результат

Baseline HEAD `802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf`; большой прежний WIP сохранён. D03 перепроверен в текущем исходнике: шесть независимых флагов раскрытия не включали точку; закрытие соседней группы не сохранялось. Поиск оставлял группы раскрытыми/скрытыми после очистки и мог показывать ссылки, скрытые настройкой интерфейса. Hash/query и история не синхронизировали состояние всего меню после bootstrap.

В `portal.js` внедрён один локальный объект `{version:2, route, openGroup}` на подтверждённые `user.id + venueId`. Legacy флаги игнорируются без переноса и массового удаления. Обычное меню раскрывает одну группу; повторное нажатие сохраняет полностью закрытое состояние. Reload того же URL восстанавливает ручной выбор. Другой URL, hash, inventory view, назад/вперёд и BFCache синхронизируют доступную группу маршрута и активные ссылки. Изменения истории не создают дополнительной записи.

Поиск временно раскрывает совпавшие доступные группы, не сохраняет запрос/раскрытия и при очистке возвращает обычный выбор. Видимость пересекает подтверждённые permissions, существующие ограничения роли и настройки интерфейса, включая позднюю загрузку preferences. Если обычная выбранная группа становится недоступной, применяется доступная группа текущего маршрута либо `null`. Native summary Enter/Space и click используют одну синхронную смену состояния; отложенный `toggle` не записывает устаревшие флаги.

Подтверждённый сопутствующий дефект `/inventory?...#keep` исправлен внутри matcher: активный пункт определяется view независимо от постороннего hash; сам hash, другие query и история сохраняются. Admin hashes и finance payroll сохраняют прежнюю семантику. Все канонические anchors остаются ссылками. Дополнительного переноса venue/workspace query во все управленческие ссылки нет: tenant задаёт подтверждённая сессия. Операционные роли сохраняют плоское меню.

Оболочка, CSS, серверные права, API/DB, бизнес-операции, расчёты и idempotency не менялись. Новых декоративных решений нет.

## Изменённые файлы и привязка

- `portal.js`, `dist/portal.js`: scoped controller, валидатор/namespace, search lifecycle, лёгкие hooks active navigation/preferences/history.
- `scripts/ui-navigation-context-contract.mjs`: actual-source VM и matcher проверки.
- `scripts/sidebar-disclosure-runtime-qa.mjs`, `scripts/sidebar-navigation-contract.mjs`, `scripts/sidebar-menu-audit-contract.mjs`: контракты нового состояния и прежних маршрутов; устаревшее menu-audit утверждение приведено к существующему owner-only guard без изменения прав.
- `scripts/ui-navigation-browser-measure.mjs`: read-only метрики для сохранённых браузерных доказательств.
- `SITE_TREE.md`: реализованный локальный контракт состояния/поиска/контекста; этот итог и ревью. Manifest/checker, PROGRESS/PLAN/WORK_LOG и решения обновлены.

Замороженный portal SHA256: `300a7d893ce1303747f2415793f751759185e2f16166cf2f5d7bcb94a47addbe`. Source/dist byte-equal. Принятые UI-03.1 источники неизменны: style.css `e224bf12d0a562817beaf02da8258f98698ad1ac0749c7c6c9ac24a9e37719bc`, app.js `e287e4cc695fc2e976019dfb4ed799ef7fe25c2925a6f0b5568d8bbaee6bb5d1`.

По независимому source audit: 774 intake пути, пропавших 0; существующие изменения пакета — portal/mirror, SITE_TREE и три navigation contracts. Итоговые журналы и документы учтены отдельно в checks.json. Новые документы/scripts/evidence учитываются отдельно. Diff от Git HEAD включает прежний WIP и не является diff этого этапа.

## Итоговые проверки

Code-health source GO: новый actual-source VM **56 checks PASS**, включая manual single/null, reload, malformed/unknown/legacy state, identity collision/isolation, временное summary закрытие при поиске, modified home activation, позднюю preference fallback, BFCache и duplicate route events. Отдельно исполняется actual-source matcher для шести route/query/hash случаев. Runtime script импортирует тот же VM набор; это не дополнительные 56 независимых сценариев.

По source audit 12 относящихся contracts PASS: ui-navigation-context, sidebar-disclosure-runtime, sidebar-navigation, sidebar-menu-audit, portal-context-refresh, portal-effective-permissions, portal-api-auth, header-shell, ui-role-shell, mode-navigation, staff-mode-navigation, local-navigation-state. Шесть syntax checks и scoped diff check PASS. VM/source названия runtime/QA не означают самостоятельное управление браузером или исполнение финансовых операций.

Координатор сохранил owner desktop матрицу: 1366×768 и 1920×1080, реальные portal dark/light, по 15 последовательных состояний. Проверяются последовательное раскрытие групп, reload manual/null, Enter/Space, поиск нескольких групп/названия/no results/clear, переход из поиска, admin hash и назад/вперёд. Дополнительно сохранены пять сценариев реального preference hide/show и пять inventory view/query/history состояний.

Архитектор непосредственно прочитал пять tenant кадров `owner-venue-a-finance`, `owner-venue-b-team`, `owner-venue-a-restored-finance`, `owner-venue-b-restored-team`, `owner-venue-a-final`: одинаковый подтверждённый user ID, два различных подтверждённых venue ID из успешного GET `/api/session`, A раскрывает finance, B — team, повторное возвращение/reload восстанавливает соответствующие выборы. Выбор точки выполнен координатором через существующий isolated API/UI сценарий. **B уже имела сохранённое состояние на начальном входе; проверка не заявляет чистую новую точку или новый namespace с нулевой историей.** Query `?venueId=` не использовался как доказательство смены tenant.

Финальный frozen-source набор принят: 115 пар, 1150 hash refs. Ранние diagnostic кадры исключены из final PASS. Независимое архитектурное заключение — GO_SCOPED_WITH_DOCUMENTED_DEBT; [ревью](UI_03_2_REVIEWS.md).

## Границы и отдельный долг

1. Геометрия UI-03.1 сохранена. Его обычный narrow ≤900 px долг — различающиеся размеры шапок, часть маленьких целей нажатия, скрытое имя/роль и отдельное перекрытие меню/заголовка — не исправляется этим navigation пакетом. Узкие проверки подтверждают только конкретные drawer/keyboard/search действия, не полную адаптацию. Fold — UI-10.1.
2. Portal dark/light используют реальную preference временных аккаунтов. Наследуемые light-theme dark islands/контраст бизнес-контента вне scope. POS runtime saved-theme/light ограничение UI-03.1 сохраняется; этот пакет POS оформление не меняет и отдельный class fixture не требуется.
3. Изоляция по user+venue относится к disclosure state этого пакета. Полная миграция всех других исторических UI preference keys не входит в UI-03.2. URL context не предоставляет permissions.
4. Недоступные worker routes остаются отказами и не считаются разрешёнными shell/accordion экранами. Реальная смена точки выполнена только временным owner в собственной тестовой БД; пользовательские production сессии/черновики не сбрасывались.
5. Source/VM malformed storage и BFCache force-branch проверки необходимо отличать от реально выполненной browser BFCache ветви. Не заявлять native BFCache hit без подтверждённого браузерного события.

## Среда и завершение

Собственный loopback preview UI03231959 обслуживает snapshot assets поверх disposable UI01231953 PostgreSQL/auth. Сессии и серверные permissions реальные, данные синтетические; fault fixtures ограничены именованными тестовыми read GET и не подменяют auth/401/403. Tokens/login/password отсутствуют в evidence. Фактическое переключение модели не подтверждено.

Read faults отключены, исходные owner/hookah темы dark и точка A восстановлены, viewport reset. Реальный размер после reset — 1366×768, DPR1.25; прежний размер UI031 здесь не заявляется. Собственный proxy31959 PID1820 остановлен после проверки принадлежности, предыдущие31952/31953/31957 сохранены. PATCH preferences объединяет объекты: видимость Finance восстановлена в исходное эффективное true, но явное finance:true остаётся только у disposable owner; точное JSON восстановление не заявляется. Синтетическая вторая точка остаётся в тестовой БД. GitHub/VPS публикации нет.

Следующий отдельный этап — **UI-04.1 «Общий контракт окон, полей и сообщений», GPT-6.1 Sol / High**; автоматически не запускать.

## Финальная браузерная приёмка и границы доказательств

**115 final JPG/JSON пар, 1150 актуальных source hash bindings; saved-evidence checker PASS_SCOPED.** Основная матрица владельца — 60 состояний (15×1366/1920×dark/light). Управляющий прошёл ещё 15 последовательных состояний, поиск запрещённых network/permissions, изоляцию пользователя и настоящий cross-document Back. Семь flat-menu кадров сотрудника и один ожидаемый отказ в бронированиях сохраняют прежний рабочий контур. Дополнительно: реальные hide/show preferences, inventory query/view/history, A/B возврат, actual viewport в обеих темах, narrow drawer/Enter/search/clear, пустые данные, загрузка, ошибка и восстановление.

Загрузка зафиксирована с DOM pending=true. Ошибка read GET venue/shifts показывает «Заведение недоступно»/«Статус смены недоступен»; ручная Team работает, после восстановления/reload остаётся Team. Не подменялись auth/permissions и не совершались финансовые операции. Все 115 safe identity записей независимо сопоставлены с фактическими успешными browser GET /api/session; credentials/tokens отсутствуют.

12 source contracts PASS, новый actual-source VM56, syntax8 и scoped diff check PASS. Runtime script импортирует те же VM56; они не считаются дважды. QA независимо измерил 110 desktop кадров и 434 header targets≥44px, bounds/overlap/focus PASS. Это проверка затронутой оболочки, не полный контраст всех экранов.

111 fullPage JPG точно равны CSS clip. Четыре narrow drawer снимка сделаны документированным viewport screenshot, поскольку fullPage недоступен при scroll lock: native JPEG390×843 при CSS390×844, near1 DPR, отдельное округление1px. DOM до/после стабильна. Три первоначальных owner кадра отставали на один paint; они исключены в diagnostic и заменены после отдельной CUA итерации. Новые pixels соответствуют Team/query/clear. Это ограничение снимков, а не точная raster geometry PASS.

В светлой теме унаследован низкий контраст также у expanded non-active summary «Команда» на белом sidebar, помимо main-content dark islands. Полная визуальная адаптация не принята. Отдельно обнаружен старый resize debt: после закрытия narrow drawer при расширении до desktop может сохраниться inert sidebar; handler не менялся в UI032. Диагностический кадр сохранён, итоговый actual desktop переснят после reload. Исправление responsive shell и полный Fold остаются отдельным обязательством, не помечаются исправленными.

Native BFCache hit не подтверждён: реальный cross-document Back и VM force pageshow branch проверены отдельно. Свежий пустой namespace второй точки не заявляется; проверен повторный возврат к её существующему выбору. Подробные машинные результаты: [checks](evidence/UI-03.2/checks.json), [manifest](evidence/UI-03.2/manifest.json), [независимое QA](evidence/UI-03.2/qa-review.md). Исторические UI031 доказательства сохранены; его checker с current portal хешем после UI032 не является проверкой этого пакета.
