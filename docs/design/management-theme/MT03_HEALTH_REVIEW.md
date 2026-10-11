# MT-03 — проверка исходников общих компонентов

Дата: 11 октября 2026. Проверяющий: code_health_engineer. Область: управленческий resolver, scoped CSS и минимальные точки подключения; страничное внедрение MT-04 и выпуск MT-05 сюда не входят.

## Исходное состояние и границы

Прочитаны профиль роли, MANAGEMENT_THEME_PLAN и MT01_ROUTES_CONTRACT, действующие portal-session gate, portal custom-select и shared dialog lifecycle. Рабочий пакет находится в изолированном worktree; исходный checkout не редактировался этим reviewer. Ранее существовавший tmp/ не включён в пакет. Поведение prototype combobox не перенесено в приложение: применяется существующий portal adapter.

Проверены management-theme.js/css, portal.js, portal-session.js, notification-center.js, ui-dialog.js, server.js, HTML подключения, sync-published-assets.mjs и Dockerfile. Правки server/Dockerfile ограничены публикацией двух runtime assets. API payload, права, расчёты и схема БД не меняются.

## Найденные и исправленные замечания

| Приоритет | Причина / воспроизведение | Исправление и владелец |
| --- | --- | --- |
| P1 | CSS содержал буквальный placeholder S в правилах shell/modal/content: реальные узлы не получали эти стили. | Frontend заменил все S на точный scoped selector; повторно прочитано. |
| P2 | Общий field :is наследовал specificity трёх отрицаний и подавлял disabled/readonly цвета. | Frontend использует :where для общих полей, отдельные state/focus и leaf-root правила; повторно прочитано. |
| P1 | Runtime координатора обнаружил скрытый #floor-editor как marked разрешённую панель на управленческой главной. | Architect добавил #floor-editor/.floor-editor-panel в исключения scope и provenance; повторно прочитано. Браузерный повтор фиксируется отдельно. |
| P2 | Bootstrap portal-session сохранял старую rev при изменении загружаемого portal.js. | Coordinator обновил bootstrap/HTML revision через штатный sync; source diff сверён. |
| P3 | Новая sync loop дублировала существующий copy notification-center. | Coordinator удалил дублирование; финальная loop содержит только два новых assets. |

Это новые замечания пакета. Общий аудит прежней бизнес-логики не выполнялся.

## Результат статической проверки

Resolver требует проверенную server session, управленческую роль и существующий route gate. Demo, blocked/checking, неизвестные маршруты/hash/view и employee context исключены. Token сравнивается с запомненным verified-session token; роль из localStorage не используется для разрешения темы. CSS не устанавливает tokens на body/html и подавляется во время checking.

Mixed company/dashboard ветви обходятся рекурсивно: исключённые staff/permissions/floor/layout/profile/lock ветви не наследуют marker. Body overlays получают opaque ticket от разрешённого origin; key и generation отзываются при смене маршрута/контекста. Неподтверждённый notice с null ticket остаётся вне темы. Это безопасная граница, а не подтверждение тематизации всех notice callers.

Capture hashchange зарегистрирован до bubbling session guard; teardown не зависит от позднего portal listener при denied stopImmediatePropagation. Programmatic history, storage, bfcache и html guard учитываются. MutationObserver не наблюдает marker/scheme, а setters идемпотентны: самоподдерживающийся цикл от собственной маркировки не создаётся.

Shared dialog / legacy action / notification hooks добавляют только capture/attach/detach. Pending, draft, focus, scroll/inert leases и cancel policies остаются у существующих JS владельцев. Обязательна дальнейшая классификация конкретных domain callers в MT-04: разрешённый URL или случайный current opener сами по себе не разрешают неизвестное окно зала/кадров.

## Выполненные минимальные проверки

- node --check: management-theme.js, portal.js, ui-dialog.js, notification-center.js, scripts/sync-published-assets.mjs, server.js — PASS на прочитанном интеграционном состоянии.
- git diff --check — PASS.
- Широкие tests, npm audit, DB/write сценарии и production проверка этим reviewer не запускались.
- Координатор сообщил PASS финального source/dist сравнения шести runtime файлов по hash, node syntax и diff-check. Эти результаты фиксируются также в итоговом документе этапа.

Координатор сообщил финальный локальный runtime `127.0.0.1:31934` на in-memory API с обычной проверенной owner session; PostgreSQL и customer writes не использовались. Подтверждены stock/editor/product custom-select, dark/light markers, shared reservation ui-modal marker и Cancel с возвратом фокуса, notification-panel marker при aria-modal=false, отсутствие Console warning/error. Отрицательные сценарии: `/`, `/admin#staff`, `/admin#venue-layout-settings` — 0 markers; company hidden floor editor/layout note и profile modal без marker. Это результаты координатора, не самостоятельный runtime-аудит данного reviewer.

Последняя статическая сверка подтвердила CSS leaf/root parity, light active sidebar/summary и одиночную focus границу search wrapper, а также capture/attach в обоих notification open handlers (включая legacy portal.js, используемый inventory). Повторный node syntax для resolver/portal/bootstrap/ui-dialog/notification-center и git diff --check — PASS.

**Статус: source/diff review PASS.** Известных блокирующих дефектов в стабильном пакете не осталось. Manager/admin проверены только в исходном role gate, отдельного runtime этих ролей нет. Lock и reduced-motion проверены только по исходникам. Native directory editor намеренно unclassified/unmarked до MT-04; portalNotice по умолчанию с null ticket также вне темы. Полная приёмка всех компонентов, desktop страниц и production не заявляется.
