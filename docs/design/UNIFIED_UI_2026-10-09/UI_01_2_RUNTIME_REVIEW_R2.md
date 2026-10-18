# UI-01.2 — QA и маршрутная применимость R2

2026-10-09 · `qa_engineer` / область `system_architect`. **NOT PASS: полнота UI-01.2 этим review не установлена.** Прочитаны только source и сохранённые evidence; browser/network/private credentials не использовались. CSV, progress, журнал и продукт не менялись. R1 rejected/history не переносится на R2: поздняя отрисовка R1 не доказывает готовность R2.

## Источники и проверяемый объём

Основание: принятые ROUTE_ROLE_MATRIX v1.0, COMPONENT_CATALOG, EXCEPTIONS/EX-07; `portal.js`, `app.js`, login/platform JS и HTML. Координатор сообщил проверку root/tmp mirror **215/215**; независимый повтор этой проверки не выполнялся. SHA/грязное дерево описаны в [coverage plan](UI_01_2_COVERAGE_PLAN.md). Продуктовые source constraints остаются существующим baseline, не изменённым этим этапом.

Файлы R2 находятся в [evidence/UI-01.2/r2](evidence/UI-01.2/r2/); JSON содержит `meta`, `metrics`, `after`, `raster`, `consistent`, `snapshot`, `capturedAt`. Каталог пополняется. В контрольном чтении около **08:50 UTC** было **97 индивидуальных JSON**, owner only: 95 requested light и 2 requested dark. Для этого среза: 0 `consistent=false`, 0 URL-различий между metrics/after, 0 несовпадений raster dimensions с after viewport. Это проверка согласованности записанных полей, не проверка равенства пикселей, разрешений, отсутствия late paint или визуального PASS.

Сверка каждого маршрута находится в [UI_01_2_APPLICABILITY_R2.json](UI_01_2_APPLICABILITY_R2.json): **36 поверхностей, 180 явно представленных default role×route**, минимальные linked regions, реальные read API из исходников, критерий ready, state applicability и допустимый candidate component-equivalence. Это дополнение к 6 480 строкам координатора, не их сокращённая замена. `runtimePass=0`; source applicability не закрывает runtime row.

## Готовность: требовать целевой регион

Requested route в `meta.route` сверять с `metrics.url` и `after.url`; actual theme — с вычисленным состоянием, не только filename. `consistent=true` подтверждает выбранный fingerprint до/после кадра. Оно не гарантирует, что список, суммы, drawer или ошибочное состояние готовы. Readiness требует конкретного региона после соответствующего чтения и видимого результата/empty/error; компания UI012 в шапке удостоверяет fixture identity, но не загрузку склада.

| Семейство | Минимальная отдельная связка readiness |
|---|---|
| POS `/` | `#tables`, `#queue-list`, selected order `#order-total`, preparation `#preparation-list`; таблицы и queue/preparation не заменяют друг друга |
| Orders/clients/reservations/delivery | Соответственно `#orders-rows`, `#clients-list`, `#reservation-list`, `#delivery-list` после своего API; count/filter/date должны совпадать. Guest ledger, booking wizard и delivery submit отдельные действия |
| Inventory | Stock `#inventory-rows`; products `#visual-catalog`; recipes `#recipe-grid`; auto-orders recommendation/history отдельно; movements documents/operations отдельно; premix batches/prerequisites отдельно; directories три cascade уровня с выбранным parent |
| Finance | Chart/summary, payments, expenses и payables независимы. Report и reconciliation независимы. Employee own-today renderer отличается от management dashboard |
| Admin | Directory/tasks/roles/loyalty/audit имеют собственные reads. Company policy и company identity независимы. Settings index static, linked preferences/layout/security не считаются проверенными по карточкам index |
| Notifications/help | Notification overlay открыт и его read outcome установлен. Help — static knowledge без постороннего overlay; локальный feedback не отправляет обращение поддержке |
| Integrations/network/platform | Telegram terminal status, network venue list/current marker, platform overview/org/plans/health — независимые регионы. Platform имеет отдельную SaaS-роль/сессию |

В JSON region selectors обозначают минимальный candidate, не обязательность видимого hidden editor в закрытом baseline. Селектор должен существовать и реально быть доступным/видимым в нужном состоянии. Ready только верхней области не принимает находящуюся ниже формы/таблицы: [визуальный R2 review](UI_01_2_VISUAL_REVIEW_R2.md) отмечает layout/security/audit, где виден лишь верх сфокусированной области. Для этих linked regions нужны scroll/дополнительный кадр или явное ограничение результата.

## Route/hash и формы

`/inventory?view=stock` закономерно нормализуется к `/inventory`: `setInventoryView` явно удаляет `view` у stock, остальные шесть сохраняет. Допустимо ссылаться на один согласованный stock screenshot для канонического и query case IDs при той же роли/теме/viewport/fixture. Это не auth/route failure и не основание исключить одну из двух строк.

Settings-family hashes нормализуются в `dashboardFocus=settings`, затем `applySettingsView` показывает нужный регион. Generic h1 «Настройки CRM» допустим; target panel и его данные всё равно обязательны. Hashchange/direct goto/reload могут отличаться bootstrap/scroll/overlay состоянием — URL отдельно от click-доказательства. `#notifications` открывает bell overlay. `#permissions` не открывает role editor автоматически: modal требует конкретный opener, visible dialog и собственные focus/close проверки.

В R2 help1366 JSON `after.headings` содержит «Обзор заведения»/«База знаний»; design R2 визуально подтверждает чистый help без прежнего notification overlay. R1 help defect не переносится. При сохранении нового overlay сценария его описывать отдельно от clean baseline.

Payroll1366 light snapshot содержит одновременно: «В периоде нет плановых смен: пустое покрытие нельзя утвердить как полный табель», «Для этого периода ещё нет утверждённого снимка» и в реестре «За выбранный период начислений нет». Первые два — отдельное состояние payroll source workflow, не общий service failure и не доказательство пустого регистра. Последнее может подтверждать empty register после успешного чтения entries. Для manager сохраняется finance shell/denied payroll API; сотрудник получает own-today payments через ранний выход, а не payroll workspace.

## Применимость состояний и разрешённый N/A

| Причина | Допустимое действие с матрицей |
|---|---|
| Default page/hash DENY | Только бизнес-content empty/loading/error/long может быть N/A **после** UI-доказательства отказа в валидной сессии. Baseline/focus страницы отказа обязательны; 401 и 5xx не доказывают RBAC |
| Static help knowledge/settings index | Отсутствующая independent collection/read делает региональные empty/loading/read-error условно N/A. Auth/bootstrap, local feedback validation/storage, linked sections и pending/save-error не исключаются |
| Configuration/auth form без коллекции | Empty-input/disabled-config не равно empty DB; N/A лишь отсутствующей business collection. Async check/login/save, invalid/error и keyboard остаются применимыми |
| Login/PIN/platform EX-07 | Отдельная theme policy возможна с source+UI signoff архитектора/design. Platform async списки не получают N/A. Отсутствие browser evidence не доказывает unsupported theme |
| Нет fixture/account/browser или не осмотрен регион | BLOCKED_ENV/UNCHECKED/CAPTURED_PENDING_REVIEW с конкретной причиной, **не N/A** |
| Поддерживаемая light сломана/не применяется | SUPPORTED_THEME_DEFECT; строка темы остаётся, defect evidence сохраняется |

Empty нужно различать по уровню: data collection empty, выбранная дата без брони, search no-results, no selected parent, closed shift и unknown KPI — разные состояния. Baseline с settled empty компонентом может ссылаться на ту же фотографию для empty этой области. Если API outcome неизвестен или видна только пустая разметка, такую equivalence не принимать.

Loading/error требуют безопасного контролируемого read/action trigger в локальной среде и записи результата. Фотография baseline не доказывает retry, удержание черновика, disabled/pending, keyboard/focus, trap или Escape. CSS outline/computed style и отображённый outline заголовка не подтверждают Tab traversal. Long-content принимается по длинным данным **самой области**, количеству строк/переносам/overflow; имя компании не покрывает долгие строки каждой пустой страницы.

## Темы: дефект поддерживаемой карты

В floor1366 requested dark, floor1366/1920/actual requested light actual `after.theme` — `staff-theme`. Данный marker может описывать POS shell, поэтому по нему одному невозможно установить applied color map. Но design R2 просмотрел JPG и подтвердил dark appearance requested light: это **SUPPORTED_THEME_DEFECT**, не EX-07/N/A и не light PASS. Для corrected light потребуются переключение и новая визуальная/вычисленная проверка.

Для остальных owner light JSON `theme=light` стабилен, однако [design R2](UI_01_2_VISUAL_REVIEW_R2.md) подтверждает нечитаемый текст на оставшихся тёмных таблицах/cards/empty surfaces, mixed labels/KPI и отдельные navigation states. Стабильность метрик не устраняет дефект. Transparent row/background нельзя подставлять в contrast как white: нужен computed ancestor/card background. Сохранённый baseline с дефектом может входить в честную исходную базу, но должен содержать defect reference/владельца вместо чистого PASS.

## Component-equivalence без потери полноты

Допустимые минимальные reuse: exact stock/canonical normalization; same-role/theme/viewport shell C01 на повторных hashes; identical resolved closed-shift component на dashboard/focused shift; same open bell/hash notification component при том же scope; baseline explicit empty одного list/data region; static immutable knowledge/settings index после собственной shell/permission проверки. Каждая из 36 поверхностей имеет собственное candidate правило в JSON.

Не переносить по reuse: role authorization, API scope, selected fixture, theme application, другой viewport, hidden lower region, dialogs/inner tab, empty соседней коллекции, действия сохранения или keyboard. Не удалять повторные case IDs и не заявлять целиком одну страницу принятой потому, что совпал общий component.

Передача координатору: интегрировать последний согласованный R2 evidence по case IDs; сохранять существующие visual defects; применить N/A только по конкретной доказанной области/состоянию; отсутствующие условия/роли/темы/состояния обозначить явно. Приёмку всех 180 role×route и 6 480 matrix cells выполняет координатор после полного manifest. Этот отчёт устанавливает применимость и ограничения, не объявляет UI-01.2 завершённым.

## Focused decision: одинаковые denied guard bitmap и theme context

**Условно допустим reuse изображения DENIED_POLICY_UI между routes; собственное доказательство навигации/прав каждого route обязательно.** Совпадающий SHA256 исходных bitmap подтверждает байтовое равенство этих файлов, но не факт обращения к каждому адресу и не RBAC. Для каждого case сохраняются отдельный real UI nav JSON, requested/final URL, роль/время/capturedAt, valid-session login bridge и эффективные permissions того же account/tenant, видимый policy-denial текст, отсутствие business content. Reference общего снимка допустим при том же viewport и guard template; 180 role×route и 6 480 строк не сокращаются. Theme/role/session labels нельзя получать только из имени reused файла.

Source: `portal-session.js:install` записывает verified session и при `!canAccessRoute` вызывает `block(..., true)` **до загрузки portal.js**. Поэтому при свежем direct goto запрещённого business route не запускаются `applyPortalTheme` и `setupThemePreference`. Все 11 канонических portal HTML (admin/clients/delivery/finance-categories/finance/finance-report/integrations/inventory/orders/reservations/network) содержат одну идентичную inline `portal-session-style`: guard surface `#f7f9fc`, text `#202632`, links `#2359a8`, без dark/light selector. `html[data-portal-access=checking]` скрывает остальные direct body children. Это общий фиксированный guard компонент, а не бизнес-страница со светлой или тёмной темой.

Для baseline light/dark denied rows допустима объяснённая component-equivalence **FIXED_GUARD_THEME_INVARIANT**: указать requested preference/context, фактически показанный fixed guard и reused screenshot. Она не подтверждает applied business light и не объявляет её unsupported. Если light preference установлена позже capture, нельзя ретроспективно назвать старую сессию light: записать preference at capture как unknown; доказанный fixed guard допускает ссылку только как компонентное объяснение, а не выдуманное выполнение theme switch. Для точного theme-context кейса предпочтение установить и read-back подтвердить до навигации. При denied hash после ранее разрешённой страницы portal.js уже мог загрузиться и применить тему: этот сценарий сравнивать отдельно, включая body/background и visible content, не переносить fresh-goto инвариантность вслепую.

`portal.js` сначала применяет local key `crm_theme_<account identity>`, затем `setupThemePreference` читает `/api/session/preferences` и применяет сохранённый `theme`. Функция вызывается и в общем bootstrap, даже без settings controls. В `server.js` обработчик GET/PATCH `/api/session/preferences` разрешает `theme` в собственных preferences, валидирует только light/dark и не содержит owner/manager/settings gate для этого ключа. Поэтому в изолированной среде staff account может получить theme fixture через **собственный авторизованный** preferences API, без расширения permissions; нужны успешные PATCH/read-back и applied-theme UI доказательство на разрешённой странице. Недоступность settings toggle сотруднику не делает light неподдерживаемой. Secret/token details в evidence не сохранять.

Guard outcomes различаются исходником: policy deny = «Доступ к этому разделу ограничен…» и retry hidden; pending = «Проверяем доступ…», тоже hidden retry; auth 401 = «Сессия завершена…» + redirect `/login`; service/verification failure = «Не удалось проверить доступ…» и retry visible; asset failure = «Не удалось загрузить интерфейс…». Hidden retry отдельно не отличает deny от pending. Platform_owner `/admin` может пройти generic shell gate и затем исключиться portal role allowlist с redirect на `/`; root inline redirect/pending — отдельный контур, не DENIED_POLICY_UI этого template. Его окончательный valid-role outcome нужно дождаться и сохранить отдельно.

**Keyboard reuse требует самостоятельного фактического Tab/Shift+Tab evidence для каждого common guard template × viewport × role.** Для policy-denied template retry скрыт; ожидание доступных controls: link «Рабочий стол» → link «Войти в другую учётную запись», обратный порядок при Shift+Tab. Записать точный focused control/href, видимый focus ring, отсутствие фокуса скрытого retry/business content и screenshot/DOM sequence. Pending/error template с иным набором controls требует отдельного доказательства; одинаковый bitmap не доказывает keyboard. При подтверждённой template equivalence можно ссылаться на этот keyboard sequence из родственных route rows, сохраняя отдельный route/permission proof.

Оставшиеся реальные ALLOW/READ/OWN_TODAY/SHELL content rows снять во всех **трёх viewport × двух поддерживаемых темах** с их ready regions; общий guard reuse этого требования не заменяет. Новые role captures, восстановленный browser и R2 flags отражают доступность сбора/целостность файлов, а не автоматический VISUALPASS. Итог этой decision — разрешение обоснованных references, **не общий PASS UI-01.2**.
