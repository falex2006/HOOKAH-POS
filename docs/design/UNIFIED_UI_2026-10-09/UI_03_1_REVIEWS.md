# UI-03.1 — Независимые ревью

GO относится к desktop geometry >900px и сохранённому role/session/actions contract. Ограничения из UI_03_1_RESULT обязательны; это не release approval. Исторические candidate разделы ниже не заменяют итоговые заключения.

## system_architect

# UI-03.1 — system_architect intake and shell contract

## Scope and state

Read-only product audit. Applicable instructions: system_architect profile, AI_ORCHESTRATOR, AI_TEAM_WORKFLOW, SITE_TREE, route/role matrix, UI-03.1 PROMPTS and D02. UI-02.2 must be accepted before implementation. Scope is app.js/portal.js shell, style.css and shell contracts; no publication, UI-03.2 preference migration or API/DB/business changes.

Source findings are candidates until coordinator browser measurements confirm active cascade. D02's original line references are stale. Current rules:

- `style.css:3937`, desktop >900: POS `.staff-theme .portal-sidebar` width and flex-basis 210px; applies to all authenticated roles using `/`, despite hookah-master-only comment.
- `style.css:4000`: operational portal sidebar width/flex-basis 244px, padding 26px 16px. POS inherits other responsive inline padding, so width is not the only potential mismatch.
- `style.css:4008`: `.employee-portal .portal-header.employee-header` min-height 72px, overriding shared root header-height 68px (`2372–2376` at regular desktop).
- Management portal has width clamp(210px,18vw,280px) at 901–1799 and 280px at wide desktop. POS's later 210px overrides this on the same owner/admin/manager session.
- POS header padding 42px at ordinary desktop and 56px >=1800; management header uses clamp(18px,2.4vw,38px). Root header geometry should be measured with these conflicting rules, not inferred from an old declaration.

## Mandatory shell contract

1. Within the same authenticated role and viewport, `/ → /clients → /admin#tasks → /reservations → /finance` must keep sidebar outer width, header outer height, main origin and horizontal shell spacing stable. Changed page content size or permitted action set is allowed; accidental geometry jumps are not.
2. Desktop contract activates only above existing 900px drawer breakpoint. Do not accidentally override <=900 behavior or user-owned open drawers; ordinary narrow regressions are checked separately, Fold remains UI-10.1.
3. Sidebar uses border-box, fixed nonshrinking basis; header uses border-box and a shared height/min-height (normal desktop currently 68px). Shared inline padding and title/action lane gaps should be tokens or one bounded selector family, not route overrides.
4. Canonical width decision belongs to coordinator + design lead: preserve compact operational POS at 210px and align employee portal; management POS can use existing management clamp under a verified-session management class, OR adopt one approved fixed desktop width for all roles. Whichever is chosen must be identical within each role across routes and evidence-bound. Do not silently change menu identity to achieve geometry equality.
5. O/A/M/D retain management disclosure menu in portal. Operational roles (bartender, hookah_master, senior_bartender, senior_hookah_master, cleaner, security, technician, other_staff, staff) retain flat operational portal links even with custom role labels or extra grants. Root POS currently always flat and its action semantics remain operational.
6. Preserve existing DOM action nodes/IDs/handlers; do not clone or replace header children as a styling fix. Header-shell owns management node normalization; lock.js and notification-center.js mount existing hooks. Portal informative shift status differs deliberately from POS shift operation button.
7. Long staff name remains short display name through `HookahStaffDisplayName`, full name in title/session/avatar. Management roles keep full name. Role label, avatar, clock/date, shift, PIN settings and lock button, notification availability survive. Long venue context may truncate inside its bounded slot; full title may be added safely. Never hide operational actions or controls to conceal overflow at desktop.
8. Controls need >=44px hit targets, visible keyboard focus and no overlaps. Title/name/shift may shrink or wrap within an explicit contract; actions must remain reachable. Theme colors/brand effects remain existing agreed choices.
9. Auth/session/tenant/grants remain authoritative. Any shell class derived from role must be applied after a confirmed session and must not affect server permissions or menu gate predicates.

## UI → API → permission → persistence → QA

| UI / action | Current endpoint / response | Permission / context | Persistence & redisplay | UI-03.1 check |
|---|---|---|---|---|
| Root verified staff shell | GET `/api/session`: user, permissions, current venue | existing staffCanWork: floor AND orders; session token headers | server session, refresh binding; failed session leaves nav/actions inert/hidden | exact grants, failed/loading access unchanged; root shell geometry |
| Portal shell and route navigation | existing portal-session verified session; GET `/api/session` | no new grants; `/clients` orders OR staff OR staff_view; tasks orders OR tasks_manage; reservations reservations; finance finance_read | existing URL/hash/query and venue/workspace forwarding | worker base reservation is forbidden; test route with explicit legitimate grant, and absent-grant separately |
| Name/role/avatar | session user; existing shared staff-display-name helper | own verified identity, tenant context | no extra кадровый fetch; full session name preserved | short operational name, long management name and title, correct role; all routes |
| Venue breadcrumb | GET `/api/venue`; current existing portal context loads | current context/permissions unchanged | current refresh clears old label to `—`, errors `Заведение недоступно` | empty/error/long venue remains bounded; root lacks this breadcrumb by design |
| Portal shift status | GET `/api/shifts`: current | floor OR orders OR finance_read | poll/focus refresh, no mutation | loading/open/closed/error geometry and label remain truthful |
| POS shift control | GET `/api/shifts`; existing POST open / POST `/api/shifts/:id/close` | existing readable/manageable grants; server authorizes | existing pending guard/checklist/cash & refresh; UI031 does not run production mutations | preserve state button, status text, enabled/disabled and handlers; isolated tests only |
| Notification bell | GET `/api/notifications?...`; POST read receipts | existing role/grant and venue rules | server per-user state; existing cross-tab refresh | preserve availability/44px/focus, no new reads marked on production |
| PIN settings/manual lock | GET/PATCH `/api/session/preferences`; PATCH own `/api/staff/:id/pin`; POST `/api/session/unlock` | existing session & PIN checks | timeout prefs/current lock state and overlay | nodes remain reachable, no PIN/state mutation needed for geometry QA |
| Logout | POST `/api/logout` | current authenticated session | existing token/user cleanup and redirect only after success/401 | no geometry code alters handler; no user session logout in QA |

## Bounded dependency map and review requirements

- `app.js`: applyStaffSession/applyStaffHeader after verified GET session; staff root nav permissions, mobile drawer, operational shift button.
- `portal.js`: normalizeEmployeeSidebar/normalizeManagementSidebar; shared name binding; shift contextual refresh. Role lists, route gates, preference storage and nav grouping are untouched UI-03.2 debt.
- `style.css`: desktop sidebar/header/control sizing, scoped to CRM shell; avoid touching UI-02.2 local reference header or platform.
- `header-shell.js`, `lock.js`, `notification-center.js`, `staff-display-name.js`, page templates and server API remain dependencies, not planned behavioral edits.
- Existing tests: `header-shell-contract.mjs`, `sidebar-navigation-contract.mjs`, `sidebar-venue-header-contract.mjs`, `staff-shell-parity-qa.mjs`, `staff-mode-navigation-contract.mjs`, `staff-header-actions-runtime-qa.mjs`. Preserve or update assertions honestly; legacy source assertions do not prove final geometry. New focused parity contract should verify shared tokens/scoping, no action loss and source/dist parity.
- Final architecture GO requires baseline + final screenshots/measurements on 1366×768 and1920×1080, both themes, same-role route sequence, long name/venue/shift opener, session failure/forbidden role smoke, controls/focus and no unintended narrow regression. Record unsupported browser scenarios instead of PASS.

Initial architecture status: contract proposed, product baseline read; final implementation and browser acceptance pending. No product files edited by this role.

## Coordinator decision review — implementation contract GO

Approved minimal desktop decision (>900px only): operational POS/portal sidebar 210px, header height/min-height 68px; management POS/portal sidebar clamp(210px,18vw,280px). Header inline padding clamp(18px,2.4vw,38px); sidebar inline padding follows shared management clamp(14px,1.2vw,22px), with chosen operational padding consistent in both renderers. Marker for management POS is toggled from confirmed `applyStaffSession` role owner/admin/manager/developer after the existing missing-user guard, controls CSS geometry only and does not influence permissions, menus or server authority. Existing action/control nodes and handlers remain intact.

No new root saved-theme application in UI-03.1: that would introduce preference behavior beyond measured geometry. Portal themes can be checked using real preferences. Root POS light can be validated with an explicitly named isolated static class fixture, never reported as runtime theme switching. Root runtime theme-control absence stays a documented legacy limitation. Real root dark and real portal light/dark are still mandatory. Static fixture must load the identical accepted stylesheet and faithfully reproduce actual shell structure; source/CSS proof is complementary to live route proof.

Status: implementation decision GO; final source/evidence review pending.

## Final architecture review — ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT

Independent review of final product source, `scripts/ui-role-shell-contract.mjs`, coordinator/QA/health notes and captured metadata. Executed new role shell source contract: PASS. Final CSS remains an exact intake prefix with one desktop-only additive block. App delta is 233 bytes: pure management role predicate plus verified-session CSS marker, with no permission/route/API/data mutation changes. portal.js/header-shell.js remain source-identical to intake. Geometry uses existing `--crm-header-height` so both renderers follow the same pre-existing responsive token; normal 1366/1920 desktop measured68px. Brand cannot shrink vertically, actual interactive avatar/profile/logout sizing preserved/expanded; route title does not shrink behind venue context.

Independently read all126 current final JSON files, comparing `before==after`, stable:true and every recorded source hash to current disk files: no mismatch. Exact desktop matrix comprises80 cells/16 role×viewport×theme groups,72 allowed renderings plus8 default-worker reservation denials. Allowed shell width is210px for hookah_master/bartender,245.95px at1366 and280px at1920 for owner/manager; header68px and sidebar/header/main x are stable inside each role/viewport/theme group. The differing native scroll gutter right edges are content-scroll differences, not unintended origin shift. QA independently confirms matching header/sidebar padding and all recorded desktop action targets≥44px without overlap. Architecture reviewer directly inspected worker1366light clients native JPEG: readable full «Гости» title, shift/PIN/profile action lane fit, operational flat menu retained.

Supplemental metadata includes real keyboard focus on lock-screen-button, truthful pending/loading state, shift error/recovery, safe PIN-settings/profile overlays, actual navigation clicks, drawer open/Escape and empty fixtures. This reviewer inspected those recorded states; the coordinator operated the browser. No claim of reviewer-operated browser or executed production financial/PIN/notification mutations is made.

Final accepted source hashes: style.css `e224bf12d0a562817beaf02da8258f98698ad1ac0749c7c6c9ac24a9e37719bc`; app.js `e287e4cc695fc2e976019dfb4ed799ef7fe25c2925a6f0b5568d8bbaee6bb5d1`. Hash binding is conditional on keeping these frozen files unchanged; any later product edit requires a new review/capture.

Precise remaining limits:

- Desktop acceptance is >900px, measured1366×768 and1920×1080. Actual672×764 and ordinary390px supplement explicitly expose inherited narrow differences: worker root64/portal72 or phone96px headers, some34/36px controls and hamburger/title overlap. Existing ≤900 CSS was not changed; this is not a whole-device parity/mobile/Fold PASS.
- Root POS light uses declared isolated static class fixture matching accepted CSS. It proves the CSS theme geometry, not a runtime root theme switch or saved-theme application. Portal light/dark uses the actual existing preference path; no new root preference behavior is introduced.
- owner/manager/hookah_master/bartender have rendered desktop evidence; admin/developer/other operational base roles are covered by the exact role predicate/source contracts only, not rendered-route claims.
- Employee reservations with default grants is denied in8cells, correctly preserving RBAC. No permitted employee reservation shell was rendered; not an implicit grant or allowed-shell proof.
- Business sections' inherited light-theme dark islands/contrast remain outside shell geometry. PIN collision with other overlays and complete modal lifecycle are later UI-04 tasks; UI-03.2 group preference/context migration was not started.
- At this review, final RESULT/REVIEWS/manifest were not yet on disk. Coordinator must persist this architecture decision with exact source hashes, evidence counts/provenance and these limits before declaring phase complete. Source and captured desktop contract are accepted; no production release approval is granted.

Architecture decision: GO for scoped local UI-03.1 desktop shell geometry, with the listed documented debts. No product files changed by this role. Next owner: coordinator for final journal/result/evidence manifest; UI-03.2 separately launched for navigation context.


## design_lead

# UI-03.1 — design_lead review

## Baseline diagnosis (source + accepted UI-01.2 evidence)

Product read-only. Read role profile, UI-03.1 PROMPTS, STANDARD D02/shell rules, COMPONENT_CATALOG C01, AUDIT D02; inspected app.js/portal.js/header-shell.js/index/clients/admin/reservations/finance shell and CSS cascade. UI-02.2 primitives remain opt-in and should not be migrated into business pages in this phase.

Accepted UI-01.2 R2 native frame metadata proves these existing differences (not yet current-frame verification):

| Role | Viewport | POS sidebar/header | Portal sidebar/header |
|---|---|---|---|
| owner / manager | 1366×768 | 210 / 68 | 245.95 / 68 |
| owner / manager | 1920×1080 | 210 / 68 | 280 / 68 |
| bartender / hookah_master | 1366×768 | 210 / 68 | 244 / 72 |
| bartender / hookah_master | 1920×1080 | 210 / 68 | 244 / 72 |

Evidence: `evidence/UI-01.2/r2/{role}__{floor,clients,admin-tasks,finance}__{viewport}__dark__baseline.json`, associated JPG files. Employee `/reservations` baseline is access denied and shell rectangles zero; do not treat as a shell defect or grant reservations.

Confirmed source causes: final desktop POS sidebar210 override; employee portal fixed244 and min-height72; management portal existing clamp210/18vw/280 plus desktop media280; POS header horizontal padding28/default,56≥1800 vs portal clamp18/2.4vw/38. No need to rewrite page layout or data flows.

## Minimal contract recommendation

- Employee sidebar210 on all allowed desktop routes; header68. Preserve current220+ style visual family only if necessary pixel evidence demands larger dimensions, not arbitrary.
- Management shell uses existing management width by viewport (clamp210/18vw/280,280 ultrawide) consistently on POS too. Requires architect-approved session role marker on POS; do not infer privilege from appearance.
- Header horizontal padding, logo/brand padding, and first navigation row spacing should come from shared role geometry; establish baseline supported dimensions before changing them. Header controls remain44px and stable core placement by role; POS shift is an action while portal shift is a status, so equal geometry does not mean identical semantics.
- Long venue/name may use bounded ellipsis with full title as current short-name implementation does. Do not hide required short employee name or role to accommodate decorative content. Long route title should remain identifiable; do not let lengthy venue consume it completely.
- Keep action set/PIN/notification handlers, server permissions, short-name helper, shift action and existing management link. No new production menu/reference page, no new gradients, glass, neon, or extra header banner.
- Do not expand unsupported reservation access. `/platform` remains separate EX-07.
- Desktop route stability means common header origin/height/inner padding and sidebar boundaries per same role+viewport; POS vs portal content payload and scrollbar widths may differ legitimately. Compare shell boxes, not whole-page screenshot equality.

## Pending acceptance

Current-frame baseline and final browser captures pending coordinator. Need 1366/1920 both themes, supported owner/manager/bartender/hookah routes, actual viewport, long identity+venue, focus/core action visibility and narrow regression. Final visual GO cannot be granted from source contract alone.

## Candidate source review

Reviewed actual UI-03.1 append block and POS cosmetic role marker. Source design GO pending pixels: role families implement the recommended employee210 and existing management clamp210/18vw/280; common header height token and horizontal padding; shared sidebar padding; unchanged existing visual accents. Desktop scope keeps narrow drawer CSS untouched. Enlarged interactive avatar/profile target and logout to44px is an appropriate shell correction under UI-02.2 accepted control contract. Brand flex-shrink correction preserves normal-size lockup and avoids shrinking the logo to absorb navigation content; no new decoration introduced.

Fresh coordinator before captures16pairs under `evidence/UI-03.1/before/` exist with source hashes/stability fields and reproduce source causes. Final80-frame matrix pending.

## Initial final-pixel checkpoint (not final acceptance)

Visually inspected `final/owner-1366-dark-floor.jpg` and `final/owner-1366-dark-clients.jpg`; corresponding stable JSON confirms sidebar245.95, header68, brand94.8/logo190×60.8 and context origin278.74 match across routes. Required actions/short identity/role fit; primary issue of shell movement is resolved.

**Confirmed remaining blocker before final matrix freeze:** with long venue on portal `/clients`, header clips the route title itself to `Гос…` after the venue. Context width300.59 and existing venue bound permit the venue to consume almost all room. Long venue may ellipsize, but current route must remain identifiable. Minimal shared portal header context flex: shrinking muted venue portion, stable title b, bounded overflow. Do not hide short identity/actions. Coordinator informed immediately before full matrix completion.

## Long-venue correction review

Source correction is bounded to desktop shared portal header context: flex context, shrinking muted venue, nonshrinking route b. No handlers, permission or menu composition changes needed. Visually re-opened updated `owner-1366-dark-clients.jpg`, `owner-1366-dark-reservations.jpg` and `manager-1920-dark-floor.jpg`; full `Гости` and `Бронирования` are now readable while venue ellipsizes. Required short identity+role and PIN/notification/shift controls remain visible; normal-size management brand and shared boundaries preserved. The previously raised long-title blocker is **closed** in these native images.

Partial visual GO for corrected management dark family at1366/1920; all-role/both-theme final acceptance still waits remaining matrix and focused action evidence. Do not cite this as complete80-frame independent pixel audit.

## Desktop matrix final design review

Independent enumeration of the exact80matrix files (`owner,manager,bartender,hookah_master` × `1366,1920` × `dark,light` × `floor,clients,tasks,reservations,finance`) confirms all80stable capture pairs and one source-hash revision group. There are72supported frames and8employee reservations denial frames. Every supported frame has header68; employee sidebar210; management245.95 at1366 /280 at1920. Context origin matches within each same role+viewport. Denials correctly remain outside shell geometry acceptance.

Additional native pixel inspection performed on:
- hookah_master1366lightclients;
- bartender1366darkfloor;
- owner1366lightfinance;
- manager1920lightreservations;
- hookah_master1920lightfloor (explicit isolated light-theme POS fixture);
- bartender1366lighttasks;
- bartender1920darkfinance;
- owner1366lightclients.

Together with earlier corrected management dark native pixels, these cover both role families, themes, desktop sizes, all five route payloads, long synthetic identities and venue, empty finance/reservations and populated clients/tasks/POS. Header brand, short identity+role, current route and action positions remain inside the available shell; active nav labels remain identifiable. Wrapped employee `Рабочий зал` with portal counter on1920 fits its row; portal counters and POS buttons need not have identical payload.

**Design GO for UI-03.1 desktop shell geometry, scoped with documented legacy visual debt.** New work preserves accents and no new decoration introduced. This is not a contrast or whole-page theme acceptance: existing light-theme dark content islands, low-contrast guest names/tab labels and pale POS navigation/PIN icons are visible and remain outside geometry diff; defer to the accepted theme/component migration phases. POS light fixture validates CSS geometry, not a new live theme switch. Functional action tests belong QA. Actual-size/narrow supplemental review still pending.

Evidence housekeeping: directory initially included5earlier `*-admin-tasks` duplicate frames from another source revision, outside the exact80matrix. Coordinator asked to archive/exclude these from accepted manifest; do not describe unfiltered directory contents as one frozen revision.


## qa_engineer

# UI-03.1 — QA review

Product read-only. This reviewer writes only this note. Read QA profile, exact UI-03.1 PROMPTS, shell STANDARD/C01, route-role matrix and three intake role reviews.

## Bounded browser matrix

1. Same temporary owner, manager, hookah_master and bartender identity follows `/ → /clients → /admin#tasks → /reservations → /finance` in order at 1366×768 and 1920×1080, both supported themes. Capture final settled frame/metadata on each cell: 80 role×route×viewport×theme cells. Existing unavailable worker reservations are expected denied cells, never a shell-parity failure or implicit grant. To prove an operational reservation shell, use a separately declared legitimate isolated extra-grant fixture and retain a denied base-role check.
2. Actual browser viewport: owner and one operational worker, both themes, all five route sequence cells. Narrow regression: owner/worker at ordinary 390px (or tool-supported actual narrow), both themes, root plus one portal page, drawer closed/open and reachable header controls. This is a narrow smoke, not Fold acceptance.
3. Isolated long fixture: management full name, operational multi-part name retaining short display name, long role/venue text and open shift/status. At 1366px and actual viewport, both themes, compare root/portal. Assert bounded ellipsis/full title for approved context text; no control hiding, overlap or offscreen controls. Root has no venue breadcrumb by design.
4. Actual keyboard traversal of existing header actions, role-specific notifications availability, PIN/lock hooks and navigation links. Open/close only safe local overlays if needed; no PIN update, no shift/payment mutation. Loading/error/empty/forbidden states must be labeled observed, source-only or unverified individually. A source contract preserves mutation guards but does not prove live actions.

## Geometry assertions

- Compare settled **same role + viewport + theme** sidebar x/width/right, header x/y/height/left/right, main origin and header inner padding on allowed routes. Tolerance <=1 CSS pixel for rounding; content height/scrollbar/page title payload need not be equal.
- Operational canonical sidebar 210px/header68px per proposed contract; management proposed existing clamp(210px,18vw,280px), then280px >=1800. Final expected values need architect/design acceptance; do not silently choose fixed geometry from an old source declaration.
- Record sidebar border-box, padding, brand/nav item rectangles and first item inset: equal sidebar width alone misses baseline padding mismatch. Different POS flat and management portal grouped menus are deliberate, so compare shared chrome bounds rather than requiring identical item contents/order.
- Header controls: native button or linked hit target >=44×44 CSS px; their rectangles entirely inside viewport/header; no pairwise action overlap, no text/action overlap except explicitly contained composite controls. Short worker name, role, clock/date, shift, PIN, lock and permitted notifications remain visible/reachable. Show outline/focus-visible geometry and color for an actual keyboard-focused control.
- Page-level horizontal overflow <=1px in desktop/narrow shell; internal business-table scroll is independent and should not trigger shell failure. Determine clipped controls by rendered visibility/rectangles, not class presence alone.
- Metadata and raster must be bound to the final frozen source SHA; stable pre/post read-only measurement pairs prevent screenshot/state drift. Native JPEG dimensions should match the screenshot backend's actual CSS clip scaling (see final audit refinement below). Keep baseline separate from final accepted evidence.

## Acceptance status

Pending coordinator final source, actual browser route traces/measurements/JPEGs, source hashes and scoped contract results. No rendered QA PASS is granted at intake. No product or production data changed by this reviewer.

## Independent current baseline inspection

Read all 16 `evidence/UI-03.1/before/*-dark-{floor,clients}.json` captured current source. Every frame `stable:true`; current hashes match intake source. Reproduced D02 for all four roles at both desktop widths: workers sidebar210→244/header68→72; management sidebar210→245.95 at1366 and210→280 at1920/header68 unchanged. POS header padding42/56 vs portal32.7936/38. Worker sidebar padding differs16.3968/22 vs16. Both root interactive `.staff-header-avatar`34×34 and portal profile trigger under44px height are inherited violations relevant to this shell work.

Refinement: compare header width with its own main **client** width/scrollbar, not requiring identical root/portal right edge. Current root scroll gap≈15px and portal≈10px is legitimate independent content scroll. Stable sidebar/header left/height/inner padding are decisive. The final comparator must not report these native scrollbar deltas as shell shifts.

Portal profile-trigger interaction confirmed in `staff-profile.js:27`: mount queries `.user,.header-user,.sidebar-profile`, sets role=button/tabIndex0/title, adds `.profile-trigger` and opens profile on click/Enter/Space. Owner1366 clients native metadata confirms `.header-user.profile-trigger`36px tall. Only that interactive host needs44px minimum; passive avatar/copy descendants do not each require44px. Local keyboard profile open/cancel can prove the existing handler survives without saving data.

## Early final candidate inspection (not freeze acceptance)

First16 management dark candidate frames have stable:true, canonical sidebar245.95/280, header68 and padding32.7936/38, page overflow0, no undersized/off-header interactive controls. Viewed native owner1366 floor/clients JPEGs: core actions fit. **Fix requested:** long venue breadcrumb consumes context, short route title «Гости» is rendered «Гос…». This fails the accepted meaningful-title requirement. Bound/shrink venue separately and preserve short route title before final frozen evidence; do not hide actions. These early candidate frames need recapture if CSS is adjusted.

## Final desktop geometry audit

Independently read all80 corrected desktop JSON/JPEG pairs:72 allowed renderings and8 expected worker reservations denials. Five stale pre-correction `admin-tasks` pairs moved to diagnostic, replacement `tasks` pairs use accepted CSS. All80 `stable:true`; all CSS/app source hashes match frozen current files. In all16 role×theme×desktop groups: stable sidebar/header/main x, header68px, shared header padding32.7936px at1366 /38px at1920, shared sidebar padding16.3968px/22px and brand x/y26px. Sidebar worker210px; management245.95px/280px. Allowed desktop controls all>=44×44, inside header, with no pairwise interactive overlap and page horizontal overflow0. Worker denied cells preserve absence of reservation grants and are excluded geometry comparison.

Native raster refinement: this screenshot backend normalizes viewport clips to CSS pixels. The actual672×764 viewport reports DPR1.25 but JPEG is672×764, **not**840×955. Raster binding should require the documented CSS clip dimensions for these native captures; DPR is observed browser metadata, not an assumed image scale. All examined raster pairs decoded correctly; this is not a capture failure.

Visually inspected corrected worker1366light clients, bartender1920dark floor, owner1366light reservations (in addition to initial management pair): shared chrome stable, full short route names readable, action lanes fit. Long venue correction closes earlier blocker. Business-section dark islands/contrast in light theme are inherited UI-02.1 debt outside shell geometry.

Actual672px and ordinary390px are below unchanged901px desktop gate. Observed actual672light POS hamburger overlaps beginning of «Рабочий зал»; existing narrow CSS hides identity/date and keeps worker root64px/portal72px. This must be reported as inherited narrow debt; no all-mobile or actual672 full parity PASS. These narrow rules were not changed by the desktop append. Final scoped desktop GO can be granted with explicit narrow limitations once actual keyboard/action/loading/error evidence is independently reviewed.

## Final supplemental audit and decision

Independently reviewed all126 final metadata/raster pairs:80 desktop matrix +20 actual672×764 both-theme cells +8 ordinary390×844 root/clients cells +18 scenario/action cells. All `stable:true`, all accepted CSS hashes current, all126 native JPEGs decode and match CSS clip dimensions. Supplemental metadata does not widen server grants. Viewed native focus/PIN/profile/loading/error/drawer-open rasters in addition to representative desktop images. This is all-metadata/all-raster-integrity review with representative pixel inspection, not a claim that every pixel of126 images was manually reviewed.

Observed supplemental outcomes:

- Actual owner navigation root→clients→tasks→reservations→finance and worker clients→tasks→finance preserve desktop geometry; worker reservations absent by base permission. Initial80 cells are settled real route loads, six supplemental action records are actual native navigation clicks.
- Keyboard focus after Tab on existing `#lock-screen-button`: `:focus-visible:true`,44×44, computed outline `rgb(255,154,143) solid1.6px`, native raster clearly visible. Only the observed dark worker focused control is claimed; no exhaustive keyboard action test or both-theme focus contrast measurement claimed.
- PIN settings dialog and profile opened by Enter are present in native pixels; coordinator closed/cancelled with no save. Read-only inspection sees existing inputs/actions preserved. PIN updates, manual lock/unlock persistence, avatar upload, profile save, shift mutation, logout and notification read-receipt flows remain source-contract coverage, **not live mutation PASS** in this phase.
- Four empty fixture frames render truthful closed shift status/action and empty workspace; no fake closed shift injected into browser.
- Delayed successful GET shifts/venue loading frame has `pending:true`, shift state loading/text «Проверяем смену…», header68px. Pending is intentional here, not unsettled baseline acceptance.503 isolated read frame has state error/text «Статус смены недоступен» with header68px; restored read frame state open/same geometry. These are actual existing UI states under disposable proxy fixtures.
-390px worker drawer-open body includes `sidebar-drawer-open`; background is inert so helper correctly reports header null. Escape frame restores visible header96px and clears open class. This is functional drawer open/close smoke, not sidebar/header parity while modal drawer is open.

Precise inherited narrow limitations (outside >=901px change): at actual672px worker POS header64px vs portal72px; owner both64px. At390px worker both96px, owner POS96px vs portal112px. Header identity/role text is hidden by existing narrow CSS. Actual672px avatar/profile targets34×34/36×36 and390px32×32 stay below44px. POS title starts behind hamburger at672px. All28 narrow/actual normal frames have page horizontal overflow0 and no header interactive target outside viewport. These are visible inherited limitations, **not narrow/mobile acceptance**. Business light-theme legacy islands and root missing live theme switching also remain separate documented debt; POS light used explicitly labeled isolated existing-class fixture.

**QA decision: GO for UI-03.1 scoped desktop shell; ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT.** D02 corrected across all four required roles, both desktop viewports and supported themes, approved source hash, long contexts and safe read-only action/state smoke. Final report must retain narrow limitations, root light fixture provenance and source-only mutation coverage above. No new product blocker identified. Next owners: responsive specialist/design for inherited narrow debt, UI-03.2 for navigation context, UI-04.1 for existing dialog consistency. No publication authorization implied.


## code_health_engineer

# UI-03.1 — Code health

## Intake / baseline audit

- Role: `code_health_engineer`; scope read-only product inspection. This file is the only artifact written by this reviewer.
- HEAD: `802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf`. Repository already contains extensive tracked and untracked WIP. Git HEAD diff is not a UI-03.1-only diff; coordinator intake snapshots must define the final package.
- Dependency UI-02.2 primitives and UI-02.1 semantic-token source contracts both pass at intake. Their browser acceptance belongs to the existing phase reports.
- Read: role profile, AI_TEAM_WORKFLOW, AI_ORCHESTRATOR, exact UI-03.1 PROMPTS, AUDIT D02, existing STAFF_SHELL_PARITY_RESULT, shell code and focused contracts.

### Scoped SHA-256 at intake

| File | SHA-256 |
|---|---|
| app.js | 486d4db4d2d65a44d46e2a12e352b429e3492998a58b096496c1a1360781cecb |
| portal.js | 323e135376648d3842535c4712d7abc6349790aa935530340323808533880208 |
| style.css | 1fd697d80716cc9de52ac13048b6e5eca2dc5ac3ad96a25d68649eae63707bba |
| header-shell.js | ac8c8e66de48facf83fcf10279b35fbf2e2bf510a17586f292de26c27634bea5 |
| lock.js | 22c937709718b69fec964171e2904602f13fc1f7d5e4eec22202c1424395a530 |
| index.html | 6b5bcb701a2c8114313336852f3a8f158d0fb3ae6e17f0dc88cb0237f91e2854 |

### Confirmed source differences / inherited hazards

1. D02 remains present in current source. `style.css:3937` late desktop POS sidebar has width/flex-basis 210px; `style.css:4000` employee portal sets width/flex-basis 244px. The earlier common clamp rule at 2118 is overridden by these late rules. Browser measurements must establish actual rectangle deltas before choosing canonical dimensions.
2. Shared header height is token 68px (`style.css:2372–2376`), while `.employee-portal .portal-header.employee-header` at 4009 applies min-height 72px. It can force a portal employee jump despite the shared height variable. Existing tablet and mobile header rules are separate; desktop correction should not implicitly change those.
3. Existing employee portal padding26px/16px overrides responsive earlier clamp, POS late210px still inherits responsive padding. Width fix alone may leave brand/menu/first item x/top rhythm different. Measure sidebar border box, padding, brand bounds, nav item bounds, header title start and main start, not only computed width.
4. Portal role classification is explicitly based on authenticated base role (`portal.js:88`). Custom permissions add links; they must not reclassify workers into management. Owner/admin/manager/developer stay management. Empty/custom grants and orders-only/floor-only cases are already exercised by staff-shell-parity QA.
5. Preserve action semantics: POS `#shift-toggle` is a guarded opening/closing action; portal `.header-shift-status` is a live status readout. PIN settings/lock/profile/notifications handlers already exist. Equal geometry does not authorize replacing status with a mutation or reconstructing handler-owned nodes.
6. `header-shell.js` normalizes once using dataset.shellReady, orders existing nodes via replaceChildren; portal employee normalizer adds employee-header class without replacing header. New route role classes should be idempotent and established without awaiting content loading, if used.
7. Existing CSS contains many historical broad header/aside rules, legacy !important PIN icon rules, and gradients. These are inherited debt, not UI-03.1 regressions. A narrowly scoped final shell block is safer than removing broad rules or rewriting shared business JS.
8. Header names already call HookahStaffDisplayName; full name remains title. Preserve short name, displayed role, profile/avatar handlers and complete accessible names. Long venue and identity should be tested via isolated fixtures only.

### Baseline commands executed

All PASS:

- `node --check app.js`
- `node --check portal.js`
- `node scripts/header-shell-contract.mjs`
- `node scripts/staff-shell-parity-qa.mjs`
- `node scripts/sidebar-venue-header-contract.mjs`
- `node scripts/staff-mode-navigation-contract.mjs`
- `node scripts/staff-header-actions-runtime-qa.mjs`
- `node scripts/sidebar-navigation-contract.mjs`
- `node scripts/local-design-contract.mjs`
- `node scripts/ui-component-primitives-contract.mjs`
- `node scripts/ui-semantic-token-contract.mjs`

These checks do not prove rendered desktop shell parity. Header/sidebar source regexes and VM semantics require actual viewport, theme, role and route browser rectangles to close D02.

## Recommended minimal final QA contract

- Use coordinator intake byte snapshots to prove only intentional source changes and exact source/dist equality; preserve all unrelated WIP and previous CSS prefix if appending.
- Add narrow shell source/runtime contract for canonical width/flex-basis, header height/min-height, header padding, nav hit targets, role identity and stable preserved controls. Do not merely assert comments or magic selector presence.
- Actual browser matrix: same worker identity across `/ → /clients → /admin#tasks → /reservations → /finance`; both desktop1366×768/1920×1080 and actual viewport, both themes; management role follows its expected own geometry. Measure sidebar x/width, main x, header x/y/height, title/control bounds and horizontal overflow.
- Long name/role/venue plus truthful empty/loading/error shift states; verify accessible short-name/full-name contract, all action buttons visible and keyboard focus retained. Existing source tests preserve shift mutation guards but do not replace actual PIN/notification path verification.
- Ordinary narrow regression separate from deferred Fold UI-10.1. Verify width/gap changes do not silently override mobile drawer/floating button or clip two-row header.

## Final review

### Candidate source review

Code-health source **GO**, rendered acceptance pending. Reviewed coordinator baseline-to-candidate `git diff --no-index` for app.js/style.css and the two new QA scripts.

- app.js delta: one pure `staffManagementShellRole` predicate (owner/admin/manager/developer) and one body-class toggle based on the `applyStaffSession` actor. No grants, routes, API calls, or business calculations changed.
- CSS: baseline562964 bytes retained as an exact prefix;1294 bytes appended. All new selectors stay inside `@media(min-width:901px)`. Worker210px/management clamp widths, common sidebar/header inline padding, shared header height/min-height, nonshrinking POS brand and actual profile/avatar/logout targets. No new !important/decorative colors/dependency.
- 771 coordinator baseline files compared: missing0; changed only app.js,style.css,dist/app.js,dist/style.css. No existing QA contracts or portal/header-shell code changed.
- portal.js/header-shell.js hashes exactly equal intake; source/dist exact parity PASS via the relevant contracts.
- Candidate SHA app.js `e287e4cc695fc2e976019dfb4ed799ef7fe25c2925a6f0b5568d8bbaee6bb5d1`;style.css `3c732c24012f6299a7b917fd5dd027d25b74b11d85dc3346bdf96be41b2e8dcc`.
- New scripts: ui-role-shell-contract SHA `1da5ff9d206bae03295e182b9e147131f10e6b8cac939e708e91eee44c7faeed`;ui-shell-browser-measure SHA `e10f86b03ec3cfdf41a6c6b8b19dc49ed4eec37b57daf901614ab4534cd82ac2`.

Executed candidate commands: `node --check app.js`, `node --check scripts/ui-role-shell-contract.mjs`, `node --check scripts/ui-shell-browser-measure.mjs`;new UI-03.1 source contract and all nine baseline-related contracts repeated PASS. Scoped `git diff --check -- app.js style.css dist/app.js dist/style.css scripts/ui-role-shell-contract.mjs scripts/ui-shell-browser-measure.mjs` PASS (only ordinary Git LF/CRLF informational warnings).

No newly introduced product blocker found. Nonblocking QA limitation: ui-role-shell-contract tests CSS declarations by inclusion in the UI-03.1 block, rather than parsing attachment to intended selectors; therefore it correctly cannot grant browser geometry PASS. Final route/role/theme measurements remain required. Read-only browser helper does not mutate page state and records actual interactive hosts, styles and geometry.

Final evidence/hash/report scope audit remains pending. This source GO must not be presented as rendered matrix acceptance or release approval.

### Final source and desktop evidence review

Final code-health **GO** for the scoped local source package and recorded desktop geometry. Earlier candidate CSS/helper hashes above are superseded by:

- style.css `e224bf12d0a562817beaf02da8258f98698ad1ac0749c7c6c9ac24a9e37719bc`;
- app.js unchanged candidate `e287e4cc695fc2e976019dfb4ed799ef7fe25c2925a6f0b5568d8bbaee6bb5d1`;
- scripts/ui-shell-browser-measure.mjs `2f40566e5f17e94db834d83df64ae07daea3f93290faf82c1eff387a7031d974`.

Final CSS baseline-to-current diff adds three breadcrumb layout rules inside the same desktop block: context flex row, shrinkable bounded venue text, nonshrinking route title. This addresses the measured cropped «Гости» label without changing handlers/content. CSS exact562964byte prefix still preserved;final564582bytes,1618added. No new !important or change outside the desktop block. Helper now returns null for hidden shell boxes and excludes hidden denied header text from loading observations; this truthfully distinguishes forbidden routes from pending shells.

Repeated10contracts (new UI-03.1 plus nine related baseline contracts),3syntax checks and scoped diff-check PASS after this final adjustment. Exact source/dist enforced by passing contracts. Baseline771 existing files still only changes app.js/style.css and their two dist mirrors, missing0; portal/header-shell remain equal intake.

Independently parsed85 currently available final-frame JSONs and checked850 source-hash references: no stale source hashes, no unstable markers, all matching JPEG files present, horizontal page overflow0. The declared80desktop frames cover owner/manager/hookah_master/bartender ×1366/1920 ×dark/light ×five routes. Eight base-worker reservation cells are truthfully denied with no visible shell rectangles, not counted as allowed shell success. Remaining72allowed frames independently satisfy expected canonical sidebar width (workers210;management min280/max210/18vw), header68, header origin aligned to sidebar, all recorded header interactive targets at least44×44, all inside header bounds;before/after measurement JSON equality confirmed. These are metadata checks, not a claim that this reviewer personally operated the browser or measured JPEG raster dimensions.

Additional five actual-owner/light frames currently captured at672px are outside the modified desktop media query. Each retains an inherited36×36 profile-trigger target (page overflow0). This is a narrow regression/legacy limit to disclose; do not include them in a44px desktop PASS statement. Coordinator and QA notified. Source package changes no ≤900px rules, so this is not introduced by UI-03.1.

Remaining phase acceptance evidence (actual dark/worker/narrow matrix, keyboard/long/loading/error paths, final manifest/report and architecture/design/QA decisions) belongs to coordinator and relevant reviewers. This GO is neither production release approval nor completion of the next phase.

### Final evidence tooling review

Read the new `scripts/ui-shell-evidence-check.cjs` and strengthened `scripts/ui-role-shell-contract.mjs`. Tooling **GO**. Both `node --check` calls and scoped `git diff --check` PASS; independently reran both scripts successfully.

- Evidence checker PASS_SCOPED:126frames,1260 current source-hash references,126 stable before/after pairs and matching JPEG dimensions equal observed CSS clips. JPEG segment reader operates on saved native JPEGs only; no browser or network operation occurs.
- Core80cells:72allowed/8denied. Asserts required role/width/theme/route cell keys, allowed theme/loading/access truthfulness, role-specific sidebar width, header68/origin, header/sidebar padding and brand origins consistent across routes within tolerance1px, interactive44px targets within header, no page overflow, unclipped short route titles and explicit root light fixture disclosure.
- Supplemental46frames receive integrity/hash/stability/JPEG checks; their individual keyboard/state/narrow outcomes are NOT functionally accepted by this script. Final reporting must preserve that distinction and use reviewer evidence for those outcomes.
- Source contract now asserts `.header-context`, its `.muted` child and `b` child declaration bindings; this improves the earlier candidate existential CSS checks for the newly repaired venue/route-title collision. Source/dist and pure verified cosmetic role-marker tests remain PASS.
- Limitations are emitted clearly:≤900px inherited geometry/hit targets, POS light class fixture rather than runtime theme switching, no production/API mutation acceptance. The raster PASS reports observed CSS-clip dimensions without multiplying by DPR or implying unsupported screenshot geometry.

No blocker identified in final read-only QA tooling. Product source hashes stay at the previously reviewed final values; final documentation/status remains coordinator responsibility.

