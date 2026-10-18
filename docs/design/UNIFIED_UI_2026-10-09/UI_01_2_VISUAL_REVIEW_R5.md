# UI-01.2 — независимый визуальный review R5

2026-10-09. Роль design_lead / visual_auditor. **План конечного добора, не приёмка. Общий PASS 0 / INCOMPLETE.**

## Основание и границы

Прочитаны актуальные COMPONENT_CATALOG, профиль design_lead, UI_01_2_REMAINING_CONTRACT_R4 и visualObligationGroups в UI_01_2_REPRESENTATIVES_R4.json. Подтверждён размер предложенного ledger: **42 группы / 198 visual states**. Это предложенные обязательства, а не 198 принятых результатов; approved equivalence из самого группирования не следует. На этом ходе новых JPG R5 не открывал, браузер/БД/код/CSV/evidence/R4 не менял. Создан только этот Markdown.

Приоритет ниже сокращает повтор снимков, но не снимает tuple/role/route/theme обязательства. Снимать первичную фактическую геометрию, обе реально разные палитры; fixed1366/1920 добавлять для наблюдаемого responsive/overflow различия. EX07 допускает отдельную SaaS палитру, но не наследуется tenant guard. У каждого recipient остаются own session/gate/URL/metadata. При изменении current SHA старый DIRECT становится историей и новая картинка требует просмотра.

## Конечный приоритетный добор

| Очередь | Группы ledger | Конкретная новая сцена, полезная для visual baseline | Чего уже просмотренное не доказывает |
| --- | --- | --- | --- |
| P0-1 | 006,010,017,019,032–034 | Platform shell keyboard по реальным nav/action; tenant /platform denial единственная ссылка с Tab/ShiftTab и final ring; fresh portal guard и loaded-hash guard как разные контексты. Platform root: только подлинный terminal restriction с own route, не pending shift | Denial/static baseline доказывает композицию, не фокус; platform root ранее содержит “Проверяем смену…” |
| P0-2 | 021,023 | Реально открытая portalAction форма редактирования задачи с input + textarea + assignee/priority select + date; long draft, один локальный invalid, открытый select, Cancel/Escape и возврат focus. Сохранение не требуется | Reservation native wizard и lock dialog не эквивалентны portalAction; нужен exact generated dialog selector/handler |
| P0-3 | 036,023 | Staff directory: cards/list/table и действительно прокрученная пятиколоночная table; масштаб только cards. Отдельно открыть employee editor/profile, Tab/ShiftTab, readonly/disabled и role/action labels в доступном контексте, закрыть без Save | Четыре ожидаемых accounts в empty tenant не empty staff list; baseline cards не доказывает table overflow/editor |
| P0-4 | 037,007,023 | Help: keyboard раскрыть topic, затем несколько/все topics и нижнюю feedback form в фактической геометрии. Один required error; видимое local feedback сообщение с точной provenance | Не утверждать отправку поддержке. Source локально пишет storage; success после исключения не равно сохранению |
| P0-5 | 016,018 | Platform company modal: реально открыть #company-modal/#organization-form, длинное незаписанное имя, required validation, Close/Escape и focus return; отдельный detail/owner nested modal только если отличается композиция | Просмотр SaaS companies overview не доказывает modal. Политика EX07 не закрывает focus/invalid |
| P1-6 | 025,027 | POS staff-action dialog и payment modal открыть/закрыть без операции: long labels/amounts, видимый focus, disabled tender controls, один безопасный локальный invalid при отсутствии submit side effect | R2 dispatch/preparation не payment. Оплату/закрытие/возврат денег не выполнять для visual witness |
| P1-7 | 012,022,024,035 | Notification bell popup: open/list/empty либо own error; preference toggles checked/unchecked и keyboard без сохранения; KPI disclosure раскрыт со статусом known/unknown и shift settled | Не переносить clients async proof на notification/config/shift; status color без текста не доказывает семантику |
| P1-8 | 008,009,015,039,042 | Inventory grid/card vs journal table vs payroll/stock vs venue editor: выбрать один long/overflow witness каждого действительно иного шаблона и клавиатуру его фильтра/вкладки. Loading/error только при точном доказанном регионе | Finance long-content не покрывает скрытые siblings; DOM row за inner clip не visible; empty DB отдельно от фильтра no-results |
| P1-9 | 011,030,041 | Дополнить существующие dialog: scroll до нижних interval/table options и вернуть footer; reservation step2 closed selection + Back draft witness. Отдельный locked overlay/trusted PIN auth реальным safe UI только с разрешённой fixture | Lock settings не locked screen/trusted auth. BODY Tab unresolved не product trap; нужны видимые states, не новая бронь/PIN Save |
| P2-10 | 001,002,003,004,005,013,020,026,028,029,031,038,040 | Остаток 42 групп закрывать сопоставлением exact region/state текущего свидетельства либо новым material variant. Company form/reversal policy; employee own-today; Telegram config; brand reduced-motion/fallback отдельные source contexts | Static index не asynchronous configuration; один bitmap не animation/reduced-motion evidence; pending/invalid/region equivalence остаётся непринятой |

Это конечные десять очередей для 42 существующих групп; новые группы добавляются лишь при доказанном материальном различии, без размножения endpoint×state. P0 соответствует ближайшему сбору координатора. В каждой очереди сценарий open/focus/invalid/scroll — baseline witness; endpoint-specific success/persistence/retry/lifecycle сохраняется непройденным UI09.1 согласно proposed gate, без автоматического переноса необходимого визуального witness.

## Повторно использовать уже просмотренную часть с узкой областью

**R2 11 components:** bartender catalog-open/added, returned-to-order, dispatch-selection/finished, preparation-accepted/ready, table1-all-bar-ready; hookah preparation-accepted/ready-notice/table1-order-ready. Эти сцены уже рассмотрены в предыдущем review. Они показывают catalog/order/dispatch/preparation/feedback текущего R2 сценария, не финансовый full flow. Для R5 reuse требуется сверка current SHA с прежним review; на этом ходе их текущие SHA заново не сверял и не объявляю автоматически current-approved.

**R4:** reservation 7 сцен и lock settings 4 сцены непосредственно открыты в предыдущем ходе; ниже точные SHA просмотренных файлов. Error брони — guest required; keyboard — Next ring; long step3 — видимый summary/внутренний textarea scroll; picker — только верхние options. Lock — empty PIN/final Close focus/первые interval options/два Escape. Нижние options, полный focus cycle, сохранение данных после Back, PIN lifecycle не доказаны.

| Ранее открытый bitmap | SHA256 при прямом просмотре | Статус ссылки |
| --- | --- | --- |
| owner__reservations__1366x768__dark__long-content.jpg | 316F9B6205F693022CF07B480ABFA197E0B5DF5440419B75F67D48C5C7535E46 | DIRECT in R4; no R5 re-open |
| owner__reservations__1920x1080__dark__long-content.jpg | 71630AFC28BAF3ABC05AAD06174102390DE9C517AF787693722E2E5D6B56D8FB | DIRECT in R4; no R5 re-open |
| owner__reservations__actual__dark__error.jpg | C636EF16872E082E28023D50B7127B00930F4A7DFC61E47C02A5AFAA7955A761 | DIRECT in R4; no R5 re-open |
| owner__reservations__actual__dark__keyboard-focus.jpg | 00ACC58E432732696D24318F8E4ABBC4C261B0F08843FCF0C9B49A4EF93EE996 | DIRECT in R4; no R5 re-open |
| owner__reservations__actual__dark__long-content.jpg | 9AAFA5E39917006E3A3F5FA17CA1261AF54D7821C1B54EB169DE2048E28DEFA1 | DIRECT in R4; no R5 re-open |
| owner-reservation-escape-return.jpg | 446B74C475CBD3C4F7C48F432AD47A3751165202C2EC3A6297C6B7A51FBDBB77 | DIRECT in R4; no R5 re-open |
| owner-reservation-step2-expanded-picker.jpg | 839BA12560416A7A24C2C9E5869520DB7D7B0AC8CAA17BA08897163864398BC6 | DIRECT in R4; no R5 re-open |
| owner__admin-lock-security__actual__dark__keyboard-focus.jpg | 389434A30BF5A6244F2FA2E82033D5132E4C8AAEFAA26358A0BC460C7ED5CF6A | DIRECT in R4; no R5 re-open |
| owner-lock-first-escape.jpg | F59B98814D626F5D46B036661E71CA6C307175BC62B8A298E323FC1B4F06E0DD | DIRECT in R4; no R5 re-open |
| owner-lock-second-escape.jpg | 612C5CE2D95FBFA238AB1D1F257FDEEF2B23E6E86D23E71E7800FE51BB4AE5D9 | DIRECT in R4; no R5 re-open |
| owner-lock-settings-expanded-interval.jpg | 278139A084A4730A9774AFFD9A73105C75593E4A4D569921AB5C7DF30584C0C2 | DIRECT in R4; no R5 re-open |

Public login actual final-focus SHA **1337D928BCB220F359875BBF00D73D2C9F10FDE8DEE32BF06958A26FB12BA623** и три local auth-error кадра были напрямую просмотрены в R4. Public role-intent не означает пять аутентифицированных ролей. Intermediate DBC focus и autofill frames остаются superseded history; R5 их не восстанавливает.

Существующие R4 дефекты сохраняются: dark POS при light intent, низкий контраст light regions, help heading, actual platform/sidebar композиция, размеры Show/security controls. Съёмка нового компонента не исправляет их и не выдаёт product PASS.

## Требование к каждому будущему R5 review

Точный файл + current SHA + direct JPG или explicitly same-SHA representative; own role/route/permissions/requested-versus-actual theme; native raster/viewport и before/after checks. Записывать реально видимые области, scroll position и focus ring. Reduced-schema supplements не наследуют raster/consistent соседнего файла. Pending/overlay/late autofill/DOM-bitmap mismatch — rejection либо ограниченный scope, не PASS. На момент этого отчёта **новых R5 кадров осмотрено 0; все новые сцены PENDING_REVIEW**.

`n## R5 current SaaS shell keyboard witness`n`nDirectly opened current r2/platform_owner__platform__1366x768__dark__keyboard-focus.jpg and read its own JSON. SHA256 A82E9FEB5E79B24CF8B442E3C459C24BAD5AFAAB5182A4F7D0C66991AC864D8D supersedes the historical b9ceb capture described by coordinator; that historical file is not restored or accepted here. Native raster and measured viewport are1366×768; own URL /platform, consistent=true, before/after visibleText/viewport/nestedScroll independently match.`n`nBitmap shows the Companies sidebar link with a clear pink rounded outline, aligned with recorded x18/y234.61, approximately193.2×47.2px and solid pink1.6px outline/2.4px offset. Overview remains the active destination, so focus and current navigation are visibly distinct. Metadata records actual Overview Tab → Companies Tab → Plans Shift+Tab → Companies. This is a directly viewed final focus and local forward/back traversal witness for shell-platform (R4VIS-032); it does not prove link activation, every intermediate focus bitmap, full shell cycle, tenant guard, other geometry or all roles. Three companies and overview KPI remain visible; the third row reaches the viewport bottom as in the earlier baseline.`n`nR5 directly opened images now1. No new defect established in this frame. Overall stage remains INCOMPLETE / PASS0; source grouping/equivalence is not adopted automatically.`n

## R5 twelve supplementary scenes — direct review

All twelve components-r5 JPGs below were directly opened, own JSON read and exact JPG SHA computed. Each capture reports native1366×768, dark and consistent=true; independent before/after visibleText, viewport and nestedScroll comparisons match. URLs and role contexts are retained per file (platform_owner /platform; owner /admin#tasks, /admin#staff, /admin#help). This is capture-integrity support, not full workflow acceptance. R5 direct review count now **13 images** including the earlier platform shell focus.

### Actually visible scope / findings

| Scene | Directly observed | Limits and gaps |
| --- | --- | --- |
| platform-company-form | Real “Подключить компанию” modal; company-name caret/pink border, slug/plan/city/address, owner name/mail/password labels visible | Bottom Cancel/Create controls are partially clipped inside modal scroll. No footer reachability, invalid or long draft, nested owner detail, pending/error proof |
| platform-company-escape-return | Modal absent, “Добавить компанию” pink ring; own focus open-company44px | Local Escape return only, no creation/session/action authorization inference |
| task-invalid | Empty title pink border and native “Заполните это поле” popover; full other fields/footer in viewport | Required client validation, no valid submission. Popover covers part of description region temporarily; not persisted error |
| task-expanded-assignee | Real custom list; long employee options wrap; bounded textarea scroll; long title clipped single-line; current placeholder highlighted | List overlays priority/date/footer while open, a dropdown composition rather than proven product defect. Option selection/scroll/disabled behavior untested |
| task-keyboard-return | List closed, assignee trigger pink border; long draft remains visible | Own sequence first Escape from active option, Tab priority, ShiftTab assignee; intermediate priority bitmap not captured |
| task-escape-return | Modal absent, task-new pink ring; underlying tasks visible | Local second Escape return, no Save/persistence |
| staff-table | Selected table mode, all five headers visible, long names wrap, active status text and Profile action | Right edge clips portions of Block controls at this initial horizontal position. No horizontal-scroll witness yet, no all-row/footer acceptance |
| staff-list | Selected list mode, tile-scale controls visibly dimmed, rows with long names/status/Profile/Block | Bottom staff rows extend below viewport. Disabled semantics require own DOM evidence, not dimness alone; no full directory review |
| staff-editor | Real employee profile, selected name text and pink field border, role, permissions checkbox group, server-role explanation | Lower profile fields/footer below modal scroll window; no Save, credential change, readonly/disabled validation or full focus cycle |
| staff-editor-escape-return | Profile absent, orange outline on original Profile button; cards and long names visible | Exact owner context only; no cross-role editor permission equivalence |
| help-expanded-topics | Expanded shift/orders content partly at top and stock/menu content visible; long text wraps, links remain separated | Not all six topics expanded. Closed guest topic stretches to tall adjacent grid row, producing substantial blank space; density observation, not content-loss proof |
| help-feedback-long-focus | Lower feedback card entirely visible; pink textarea border/caret, long draft and textarea scrollbar; Save visible | Unsaved draft only. No required validation, success/local storage outcome or support delivery proof |

**R5-V01: control dimensions below44px.** Staff editor name input is560×41.2px; expanded task placeholder option approximately458.8×33.6px. These recorded visible rectangles fall below standard44px dimension. The assignee trigger is44px and task-new44.8px. Other option hit regions were not independently expanded/measured; no blanket checkbox hit-area claim.

**R5-V02: staff-table right-edge truncation witness.** Current initial table viewport clips right-side Block action text/control edge. This is an observed overflow condition, not established inaccessible-action defect: the catalog specifies local horizontal table overflow, and a real rightward scroll witness is still required before declaring access failure or acceptance.

No platform/footer or staff-editor lower-control failure is asserted from a scrollable initial position. No exact contrast calculation was performed. No new mutations were performed by this reviewer; metadata records submitted=false and staff credentialsChanged=false.

### Current directly opened SHA ledger

| File (components-r5) | Role / route | SHA256 | Outcome |
| --- | --- | --- | --- |
| help-expanded-topics.jpg | owner / /admin#help | 9562C981612B805379B64A0716B365A174FBA543BE1FD391F0E0AE862B524E78 | DIRECT_LOCAL_VISUAL_WITNESS; limited scope above |
| help-feedback-long-focus.jpg | owner / /admin#help | 57295FAC8376AA51F3DA3954C4951BD89C208E4600A7A14F66CE387859E58D2F | DIRECT_LOCAL_VISUAL_WITNESS; limited scope above |
| platform-company-escape-return.jpg | platform_owner / /platform | 832CB81E93441FDEDAD52BDEC3B806B8CE7A27173098D8D7DE8093AF71F42CF5 | DIRECT_LOCAL_VISUAL_WITNESS; limited scope above |
| platform-company-form.jpg | platform_owner / /platform | BB5CA73EA37CDD16DBC677ADE7E737BF8327C2C1E9784CFB0906D7BDC9848399 | DIRECT_LOCAL_VISUAL_WITNESS; limited scope above |
| staff-editor-escape-return.jpg | owner / /admin#staff | 0074DFD89C4189F6A932B4B51E9AF7C5BB4C302AD8978619793B2F4749D1F595 | DIRECT_LOCAL_VISUAL_WITNESS; limited scope above |
| staff-editor.jpg | owner / /admin#staff | 16361AAAD764A580878BBAA725B3FAC0C493F72041DB3D3409463E27916E61CD | DIRECT_LOCAL_VISUAL_WITNESS; limited scope above |
| staff-list.jpg | owner / /admin#staff | C10DA06E4860B2D9EFC1616BCF4E3EC402F407DCB207089B1C723FE4B8BB7CF2 | DIRECT_LOCAL_VISUAL_WITNESS; limited scope above |
| staff-table.jpg | owner / /admin#staff | CF081E7556E7999AE6088D01A2B93EECE04368C34745D971B6B7700FBD0C26DB | DIRECT_LOCAL_VISUAL_WITNESS; limited scope above |
| task-escape-return.jpg | owner / /admin#tasks | 9D9BEA0E22987F1670259B47403E01A92A6C729A2F64204C333900926C49A803 | DIRECT_LOCAL_VISUAL_WITNESS; limited scope above |
| task-expanded-assignee.jpg | owner / /admin#tasks | FFF88C6F2DD4423D7C8CA5367EB00309223C8DCB67004F24DDAAF2DDD3204538 | DIRECT_LOCAL_VISUAL_WITNESS; limited scope above |
| task-invalid.jpg | owner / /admin#tasks | C4F61B790509D1D9829EFD7CE2F317C65D9F78B3F8E46807F692FACA4AE49E98 | DIRECT_LOCAL_VISUAL_WITNESS; limited scope above |
| task-keyboard-return.jpg | owner / /admin#tasks | 5075BB9B6936491C5F3D6220B389EB89C5EC2C7D01ECA2A1CCDB71FC56F38C51 | DIRECT_LOCAL_VISUAL_WITNESS; limited scope above |

## Explicit design and evidence-QA decision on proposed gate scope

**Design: GO_CONTRACT_ADOPTION_WITH_CONDITIONS** for a visual-baseline gate of1080 baseline slots plus the finite42-group/198-state ledger, while preserving the exhaustive6480 matrix as unpassed UI09.1 backlog. This scope is appropriate for design research only if:

1. Decision/acceptance documents explicitly adopt it and identify superseded gate clauses; neither a proposed ledger nor this signoff silently changes acceptance rules.
2. Every current1080 baseline slot retains own role/session/route/theme/geometry proof and a visually reviewed valid current bitmap or specifically approved equivalent. Missing/rejected/pending-shift screenshots cannot become “known defect” acceptance.
3. Each materially distinct required state in the198 ledger receives genuine reviewed state evidence or an explicit narrowly approved regional applicability decision. Witnesses above close no entire group automatically; a palette/source grouping is not runtime equivalence.
4. Residual product defects are assigned and retained. Visual-baseline acceptance with documented defects is distinct from product PASS/release/deploy approval.
5. All deferred functional scenarios retain pending/rejected/defect outcomes, case IDs and UI09.1 owner; no conversion to PASS/N_A solely because of scope reduction.

**Evidence-QA recommendation: GO_SCOPE_WITH_SAME_CONDITIONS; NO_GO_STAGE_COMPLETION_NOW.** The proposed division does not require exhaustive mutation/lifecycle tests for design research, but required visual states and authentic capture integrity cannot be deferred merely to reach completion. This design reviewer has checked local capture evidence listed here, not all1145+/1080 sessions/API gates or198 state representatives. Independent qa_engineer session/action/provenance signoff remains required; this paragraph does not impersonate that separate QA review. Current reviewed13 R5 JPGs support local witnesses only. Overall **INCOMPLETE / PASS0**.


## R5 seven POS supplementary scenes — direct review

Seven additional components-r5 JPGs were directly opened; own JSON and exact SHA read. All are owner /, native1366×768 dark, consistent=true, and independent before/after text/viewport/nestedScroll comparisons match. R5 total now **20 directly opened current images:19 supplements +1 main platform keyboard**.

- **Selected order:** second zone selected; highlighted occupied table307₽, ready order badge, total307/paid0/remaining307, capacity2 and long table title wrapped in order pane. Tile names ellipsize, long order-position names wrap. Bottom order content extends below the viewport; elapsed04:13 is a captured display, not a timer-correctness test.
- **Catalog open focus:** real product grid, long labels wrap, pink search ring/caret matches product-search; metadata search Tab first product ShiftTab search. Only top product rows are visible, lower cards/return footer require dialog scrolling. No position added.
- **Catalog search-empty:** visible “По запросу ничего не найдено”, query and focused search, Return-to-order button all visible. This is no-results after filtering a loaded catalog, not empty database.
- **Catalog Escape return:** catalog absent and Add position has pink ring matching recorded opener. Local close/return focus witnessed; no full Tab trap acceptance.
- **Payment open focus:** complete payment dialog visible, due307₽ / remaining307₽, cash/card/QR0, explanatory policy text and Save. Cash pink outline/selected0 matches payment-cash; sequence cash Tab card ShiftTab cash. Real GET settlement is coordinator provenance, not a financial lifecycle result; submitted=false/paymentPosted=false.
- **Payment Escape still open:** same dialog remains visible after actual Escape from cash; focus still cash. This is observed behavior, distinct from catalog Escape closing.
- **Payment Close:** dialog absent, underlying order actions expanded. Own metrics focus tag BODY with no returned opener focus; no focus ring on payment opener is visible.

### New scoped defects

**R5-V03 — payment Escape does not dismiss dialog.** Current open/Escape screenshots plus own action metadata show payment modal stays open. This violates target dialog Escape contract for this nonpending unsaved witness. Source read: app.js884/885 implement Close/backdrop by removing open; targeted Escape/keydown search finds catalog/action handlers but no payment dialog counterpart. Owner: frontend_engineer with system_architect dialog contract; UI07.1/payment migration and UI04.1/shared dialog. No payment posted; no claim about all states/roles.

**R5-V04 — payment Close loses focus return.** Close screenshot and metrics record activeElement BODY, with no opener focus restored. app.js884 only increments load revision and removes open; it contains no opener focus restoration. Owner: frontend_engineer + system_architect, UI07.1/UI04.1. This failure must not be hidden under generic “keyboard-focus” capture label; it is a directly reviewed defective outcome.

The payment helper text “Прокрутите список…” sits beside cash/card while QR wraps to a lower row. This is visible mixed payment-grid composition, not established unreadability or clipped-control failure: current complete dialog remains in viewport. Exact contrast and absent tenders/disabled states were not measured. No successful payment, split/discount/delete/close-table mutation or new order position is proved or performed by this reviewer.

| Current directly opened file | SHA256 |
| --- | --- |
| pos-catalog-escape-return.jpg | 9DE900FCC18B1D02C5DF2C6765270D1C820D57CCCD0229C84E919DE76195D190 |
| pos-catalog-open-focus.jpg | 199930A8731F9F8359C7F47C9F5AD4AB03F57D64565273ED53F2CA9F9DAA00CA |
| pos-catalog-search-empty.jpg | 37ED45E283A0CBC4D5FBF97CFED00C650A60833DE5B2AE41696C4D6210CF2B38 |
| pos-payment-close-focus.jpg | DCA44C708BE63866E41786023AF4E6E28EB8C53EA1ECF71ED42C41CF62D8309C |
| pos-payment-escape-still-open.jpg | C3D7710B7AC704382A033726AFD44E16B2C7146EC170D340A0E034403B416489 |
| pos-payment-open-focus.jpg | 925C7B546F514CF99A3D90744E8AE8E0B08557C2820577921F185BBD142E5669 |
| pos-selected-order.jpg | 96C526F4855302931E2A61F18CEFA7939D3497FCC166338B53DA55080FC622E5 |

These scenes are evidence for R4VIS-026/027/028 local appearance states; they do not close all respective ledger states or approve cross-role/theme/geometry equivalence. The earlier GO_SCOPE_WITH_CONDITIONS recommendation persists. **NO_GO_STAGE_COMPLETION, overall PASS0 / INCOMPLETE.**

