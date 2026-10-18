# UI-01.2 — правила принятия evidence и N/A, R3

2026-10-09 · QA / system_architect. **Предложение координатору; GO_NA ещё не выдан.** Только read-only сверка исходников и сохранённой evidence. CSV, processor, manifest, BASELINE, PROGRESS и WORK_LOG этим документом не изменяются. Здесь нет runtime PASS и нет утверждённых N/A.

Основание: [ROUTE_ROLE_MATRIX](ROUTE_ROLE_MATRIX.md), [R2 applicability](UI_01_2_APPLICABILITY_R2.json), [R2 runtime decision](UI_01_2_RUNTIME_REVIEW_R2.md), [визуальный R2 review](UI_01_2_VISUAL_REVIEW_R2.md), `portal-session.js`, `effective-permissions.js`, theme/preferences handlers `portal.js`/`server.js`, [effective-permissions evidence](evidence/UI-01.2/r2/effective-permissions.json), [theme fixture proof](evidence/UI-01.2/r2/theme-fixture-proof.json), [authentication checks](evidence/UI-01.2/authentication-checks.json) и реальные route JSON. Срез checkpoint-459 остаётся историческим состоянием сбора; новые fixed-size/empty captures проверяются самостоятельно.

## 1. Единица решения и неизменная полнота

Все **180 role×surface и 6 480 case IDs** остаются в реестре. Единица N/A — конкретное состояние **запрещённого business region**, а не роль целиком, страница отказа, тема или viewport. Baseline и keyboard-focus запрещённой поверхности не исключаются. Одно доказательство может обслуживать несколько case IDs только через явный список references и ограниченную equivalence; количество bitmap не является процентом готовности.

Рекомендуемые разные outcomes: `N_A_DENIED_BUSINESS_REGION` после GO_NA; `CHECKED_WITH_BASELINE_DEFECT` для фактически осмотренного доступного состояния с дефектом; `CHECKED_COMPONENT_EQUIVALENCE` для доказанного общего компонента; `PENDING_CAPTURE`/`CAPTURED_PENDING_REVIEW` для отсутствующей проверки; `CAPTURE_REJECTED_*` для негодной evidence. Ни один из этих статусов сам по себе не принимает весь UI-01.2. Имя статуса согласует координатор; этот документ не записывает его в CSV.

## 2. Что подтверждает реальную роль

`effective-permissions.json` содержит account ID, tenant/organization/venue, fixture, checkedAt, permissions и permissionPolicy. В прочитанном long-пакете manager/hookah_master/bartender используют `source=base`, без системного ceiling; owner/platform_owner — `source=protected`. `effective-permissions.js` подтверждает: custom активная роль заменяет scope selection, system ceiling ограничивает результат; пустая активная роль не равна отсутствующей; owner/platform_owner сохраняют защищённые defaults. Прочитанные результаты сопоставляются с матрицей, но runtime роль не выводится из неё.

Authentication checks доказывают login 200 и sessionRole; **bridge к каждой последовательности браузера** должен дополнительно связывать временную роль/account/fixture с реальной активной UI-сессией, её permission snapshot и периодом captures. Meta.role, профильное имя в bitmap, разрешения другого account или login предыдущего fixture недостаточны. Новый empty fixture, смена account/venue, reload после policy change требуют своего bridge или доказанного неизменного session signature. Токены/пароли/cookies не включать.

Из theme-fixture-proof подтверждены собственные PATCH preferences light для hookah_master/bartender: 200, before/after, account IDs/tenant, точные permissions и `tenantAndPermissionsUnchanged=true`; время предшествует соответствующим actual light captures. Это позволяет документировать requested light context этих accounts. Оно **не доказывает applied light на `/`**: actual staff-theme и визуально dark floor остаются `SUPPORTED_THEME_DEFECT`. Нельзя переносить proof на другую роль/empty account или на capture до указанного времени.

## 3. GO_NA: четыре состояния реально запрещённого business region

Для **каждой пары role×route** координатор должен иметь все основания:

1. Реальную валидную сессию и связанный effective-permissions snapshot, account/tenant/fixture и временную цепочку UI login/navigation.
2. Точный source predicate этой поверхности и вычисленный результат на этих permissions/role. Например inventory `inventory_read`, finance categories `finance`, admin permissions `role===owner`; query/hash сохраняются в проверке. Это предметное обоснование, а не строка default DENY из CSV.
3. Собственную real UI navigation evidence: requested route, правильный local origin `http://127.0.0.1:31952`, final URL/hash/query до/после, capturedAt, собственный snapshot с терминальным policy-denial и отсутствием business region. Source объясняет наблюдение; наблюдение не заменяется исходником.
4. Актуальный valid bitmap этого policy guard либо ссылку на visually-reviewed одинаковый bitmap/template с совпавшим **текущим SHA256**, geometry/scroll и отдельным own-route JSON. E03 current rejected не принимается; superseded E02/E04/E05 не используются как текущий reject без matching SHA. `consistent=true` недостаточен.
5. Установленную область отказа: page/hash gate полностью исключает соответствующий business region. Доступная оболочка или личные оплаты при запрещённом вложенном действии не превращают всю страницу в DENY.

Только при выполнении этих условий и **GO_NA координатора** четыре business-content rows `empty`, `loading`, `error`, `long-content` могут получить `N_A_DENIED_BUSINESS_REGION`, с точной причиной: «эта business область не создаётся/недоступна в подтверждённой сессии из-за predicate …». N/A означает, что нельзя честно показывать эти состояния закрытого бизнес-раздела с данной ролью; он не говорит о состоянии guard или отсутствии дефекта.

Применимость бизнес-состояний не зависит от размера экрана. После доказанной неизменности account/permissions/source gate решение можно ссылочно распространять на три viewport и два requested theme slots **для той же role×route**, без 24 одинаковых дополнительных business-state картинок. Темы/viewport rows сохраняются. Baseline/focus каждого доступного guard template×role×viewport остаются отдельным требованием; для fixed theme-invariant guard dark/light references объясняются по §4. Изменённая role policy/fixture/source инвалидирует распространение до повторной сверки.

| Наблюдение | Решение о business-content N/A |
|---|---|
| Standalone «Доступ к этому разделу ограничен…», retry hidden, собственный route доказан | Candidate по пяти условиям выше |
| «Проверяем доступ…»/pending | Не deny; N/A не принимать |
| 401/login redirect/«Сессия завершена» | Auth failure; N/A не принимать как роль-запрет |
| «Не удалось проверить доступ»/5xx/timeout/asset failure | Ошибка среды/сервиса; N/A не принимать как роль-запрет |
| Platform_owner tenant route → `/` с inline restriction/pending shift | Отдельная source chain role exclusion/redirect; не standalone guard reuse. Business denial candidate только после ручного architect/QA подтверждения цепочки и valid role evidence. Baseline pending shift остаётся incomplete; простого default DENY недостаточно |
| Employee `#notifications` открывает shell с error/Retry | Shell доступен; API/event-data denial подтверждать отдельно по server predicate/outcome. Нельзя N/A всех состояний shell: показанная ошибка и keyboard Retry доступны |
| Manager payroll shell без `finance`; сотрудник payroll hash показывает OWN_TODAY | Payroll business workspace может быть отдельным denied-region candidate; shell/личные оплаты имеют собственные empty/loading/error/long/keyboard, поэтому whole-route N/A запрещён |
| READ inventory/finance без write permissions | Read business state обязателен; запрет save/post не исключает чтение списка |
| `/login` | Публичная auth поверхность; роль-intent не создаёт business page gate denial |

## 4. Fixed guard reuse: доступ, тема и keyboard отдельно

Свежий direct denied portal goto блокируется `portal-session.install` **до загрузки portal.js**. Inline guard style одинаков у 11 canonical portal HTML и имеет fixed surface/text/link colors без theme selector. Поэтому визуально принятый одинаковый policy guard может быть общим reference в рамках одного template/role/viewport; собственное nav/permissions доказательство каждого route сохраняется. Совпавший SHA подтверждает bitmap, не сессию или разрешения.

Для denied requested light row записать `actual surface = FIXED_GUARD_THEME_INVARIANT`, requested preference proof/unknown и собственный маршрут. Нельзя называть business light unsupported или applied только потому, что guard выглядит одинаково. Preference, заданная позже capture, не устанавливает ретроспективный light context. Hash deny после уже разрешённого portal имеет другую bootstrap/history цепочку и может наследовать theme/background: сравнивать отдельно, не применять fresh-goto предположение автоматически.

Keyboard acceptance требует фактической **forward/back Tab sequence** каждого common guard template × role × viewport: exact focus control/href, видимый focus ring на bitmap, Shift+Tab назад, отсутствие фокуса скрытых controls/бизнес DOM. Standalone policy guard: «Рабочий стол» → «Войти в другую учётную запись»; retry hidden. Error guard с Retry — другой template/state; root inline/platform restriction — ещё другая композиция. Реальный sequence можно ссылочно использовать у эквивалентных routes той же роли/geometry при отдельных route gates; outline declaration/стабильный BODY focus не считается sequence. Два requested theme slots фиксированного guard могут ссылаться на один sequence только с объяснённой source+bitmap invariance, без выдуманной theme switch.

## 5. Ограниченная equivalence для доступных компонентов и settings forms

Общая spec C03–C06 не доказывает одинаковую реализацию. Перед reuse указать **конкретные source selector/template, handler, state, session scope, computed styles, theme, viewport, visible labels/values, screenshot и case IDs**. Представитель обязан быть визуально осмотрен; для behavior нужны реальные действия. У каждого recipient route сохраняется own baseline gate, visible target region и готовность его данных.

| Candidate | Что можно повторно использовать | Что остаётся отдельно |
|---|---|---|
| Settings index `.settings-hub` | Static card geometry/labels и source-established отсутствие independent collection/read; один подтверждённый static state reference | Own role shell/URL, theme/viewport; linked company/layout/security/data не наследуются |
| Preference toggles modules/theme/lock | Один **идентичный primitive** unchecked/checked/focus/disabled/pending/error appearance с доказанной одинаковой CSS/template и geometry; same handler may share save/error recovery sequence only when endpoint/payload/validation/session identical | Текущие preferences/read readiness, разные server fields/validators и toggle permissions. Эти формы не stateless: GET/PATCH `/api/session/preferences`, local state и rollback действуют |
| Company identity | Геометрия общего input/button primitive в соответствующей теме/viewport | Role-conditioned editable/read-only/hidden identity, venue/policy read, validation и сохранение; не эквивалентно module toggles |
| Layout editor | Общие primitive styles | Selected venue/room/table dependencies, content/empty и focus/validation/actions; общий endpoint floor не делает POS и editor одним UI |
| Static help knowledge | Immutable accordion/card content geometry при одинаковом markup/state с own shell proof | Local feedback required validation/storage outcome/keyboard; открытые accordion states и нижняя форма; business API error не выдумывать |
| Exact stock/canonical query | `/inventory` и `?view=stock` одинаковые stock data/surface после source normalization; общий baseline/empty region bitmap при exact tuple | Own requested/final URL; другой inventory view, fixture, inner journal/editor не наследуются |
| Baseline с terminal empty конкретного list | Тот же снимок и API/ready proof могут покрыть baseline+empty этой одной области | Empty DB/no-results/выбранная дата/no selected parent/unknown KPI различаются. Другие async regions не наследуют empty |

Для действительно статического index **read-collection empty/loading/read-error отсутствуют на уровне region**: можно предложить отдельный source applicability outcome с аргументом no-collection/no-async и ссылкой на baseline; это другой вид решения, его не кодировать как `N_A_DENIED_BUSINESS_REGION`. Нельзя выдавать pending auth/bootstrap или save-error forms за статический N/A. В R3 автоматическая запись любого такого outcome запрещена до отдельного решения координатора.

Число отдельных файлов ограничивается классами реально различающихся компонентов, а не 6 480 строками. Например C04 focus в одной CSS/template реализации можно документировать одним представленным instance на role-context/theme/viewport и списком идентичных recipients; C05 dropdown, C11 dialog, validation message и rollback требуют своих representatives. Разная подпись/ширина/overflow, role-specific visibility, pending/error handler или computed style разрывают equivalence. Long labels/data необходимо показать на каждом существенно другом layout; длинное имя компании не покрывает пустой список.

## 6. Минимальный evidence ledger для GO_NA и reuse

Каждое решение хранит: decision ID/type, case IDs, role/account/fixture, permission snapshot+source predicate refs, own route JSON refs, latest bitmap SHA, template/region/handler ID, viewport/theme policy, actual dims/scroll, representative state/action proof, explicitly excluded siblings, reviewer/date и coordinator GO_NA/ref. При re-capture hash mismatch решение возвращается в pending до проверки нового bitmap; при совпадении content hash всё равно проверить freshness route/session bridge.

Таким образом denied business content может быть честно закрыт без повторного создания недоступных состояний; доступные forms/components могут быть проверены представителями без удаления matrix cases. **До GO_NA CSV не меняется.** Общий статус остаётся incomplete, пока не закрыты baseline и keyboard отказов, реальные allowed/READ/OWN_TODAY регионы, три viewport/две поддерживаемые темы и независимые состояния/дефекты по утверждённым references.
