# UI-02.1 — независимые финальные ревью

2026-10-09. Ниже финальные выводы реально запущенных ролей `/root/ui021_design`, `/root/ui021_health`, `/root/ui021_contract`. Координатор реализовал frontend-пакет и выполнил браузерный QA. Старые промежуточные выводы с ошибкой кодировки не являются текущим verdict. Уточнение таблицы вычисленных legacy значений уже применено. Итоговая приёмка и доказательства: [UI_02_1_RESULT.md](UI_02_1_RESULT.md).

## design_lead — независимый итог

### Final re-review after UTF-8 restoration and recapture

**Final design disposition: GO for UI-02.1.** This supersedes the earlier conditional disposition and stale-frame observations above.

Current CSS SHA-256 is `4a2ddc09acc9060c857f38f2d2107484361e0e81aea47ae0dbbfd377fef27b46`. Re-read the scoped diff against the UTF-8 intake and confirmed that the unrelated arrow/minus/comment corruption is absent; the focused test console now uses ASCII `x`.

Individually inspected 11 regenerated final JPGs: paired before/after staff at 1366 dark/light (4); paired finance at 1366 light (2); paired inventory at 1366 light (2); final staff editor, focus and table at 1366 light (3). The sampled JSON records `stable:true`, names the full-page screenshot clipped to CSS viewport at page origin, and distinguishes intake from UTF-8-restored final CSS. These current images are crisp enough to assess labels; the earlier soft-frame limitation is closed for these re-reviewed references.

The paired finance and inventory compositions retain their original geometry, content and colors. The final finance pseudo-content reads “Разделы финансов”; the earlier mojibake observation is stale and is not a remaining defect. The earlier header/title overlap is also absent in these origin-aligned frames and does not establish a regression.

Staff repair visibly restores light-requested card names, statuses, filter choices and the primary action, while dark staff gains its intended local palette and card borders. Editor labels remain readable; keyboard focus is visibly distinct. Table mode retains five columns and local horizontal scrolling. No new page or component variant is introduced.

Remaining limits: full light migration of the preserved dark catalog and finance/inventory dark islands is still pending; low-contrast finance nav/expected-payment text and faint inventory dark table headings are visible in **both** before and after pairs and are existing debt. Global contrast, gradient text, geometry targets, complete role/state regression and mobile acceptance are not claimed by this scoped review.


## code_health_engineer — независимый итог

### Stable UTF-8 final CSS audit

Coordinator regenerated final source from explicit UTF-8 intake after an intermediate encoding corruption. Current stable source/dist SHA-256: 4a2ddc09acc9060c857f38f2d2107484361e0e81aea47ae0dbbfd377fef27b46. Earlier SHA values describe intermediate states and must not bind final evidence.

Exact scoped-delta proof: normalize only semantic/legacy blocks to intake blocks; resulting UTF-8 source equals intake transformed by exactly 8 bare var(--text) -> inherit, 23 var(--text, -> var(--text-primary, and the single malformed comment opener repair. TRUE. Other source text/glyphs, palettes, rules, geometry and declarations preserved. Source/dist raw byte equality TRUE. Previous additional changed glyph lines are absent after regeneration.

All four focused contract runs, newcontract node--check and scoped diffcheck repeated on stable current CSS: PASS. Source code health verdict GO for declared scope. Independent browser value/theme/style preservation remains separate gate and must bind this stable CSS SHA. Exact semantic-value assertions strengthening is recommended and coordinator is implementing; final QA-file review may be refreshed separately.

### Final QA strengthening and product hash gate

Newcontract now checks all 20 dark/light values against explicit expected pairs and prints ASCII. Re-read reviewed implementation; node--check and contract run PASS. Scoped diffcheck PASS. Final hashes:

- style.css + dist/style.css: 4a2ddc09acc9060c857f38f2d2107484361e0e81aea47ae0dbbfd377fef27b46.
- DESIGN_TOKENS.md: 53d815844d459782221db607e22b35d6c67c56e3210ba02ab6209185b1a4c643.
- scripts/ui-semantic-token-contract.mjs: 59d25051f08c1ccbc83431216c0a5d9cf15146bf520205174448e3d33792cb6b.
- tmp/ui012-baseline/source/style.css restored to intake b3eedd25c289c8d979428653698bb25c39864e2cc874f414409590ac689f5425, same as tmp/ui021/qa-style.css.before.

Compared all 215 product source paths bound by UI-01.2 source-hashes.json: 1 changed, 0 missing. Changed paths: style.css. No other bound product files changed. This comparison excludes documentation/new QA script by design; does not claim git tree globally clean. Code-health GO for stable scoped package.


## system_architect — независимый итог

### Final correction review — supersedes the eight-bare-call caveat above

The final source now preserves the eight original bare `var(--text)` color calls as explicit `color:inherit`, matching the baseline invalid-at-computed-value inherited result. Only the 23 calls with explicit fallbacks move to declared root compatibility `--text-primary`; their fallback text is retained. Constructing the exact expected final CSS from the intake snapshot using these allowed transformations returned equality `True`. No additional selector, geometry, visibility, route or behavior change was found.

DESIGN_TOKENS contract 1.1 correctly separates implemented theme maps from incomplete component migration and unverified global contrast. It documents root-resolved aliases, preserved dark islands, deprecated --text, the 23/8 migration split and excluded demos. Minor wording recommendation sent to coordinator: label the current-state table values as computed legacy values, because declarations themselves now reference aliases.

The focused source contract is explicitly source-only and keeps browser CSSOM as a separate gate. It checks the 20 role declarations in each scope, documentation, removed ambiguous calls, preserved deprecated alias, staff comment/definition, known reference definitions, compatible aliases, eight inherited colors and source/dist equality. Reading it is not claimed here as an independent test execution.

Read the saved browser records: `before-staff-1366-light.json` has actual body `portal velora-theme light-theme`, no staffRule and empty semantic tokens; `after-staff-1366-light.json` has the repaired staff rule and all 20 light semantic values. This independently corroborates the original malformed-rule effect and new map parsing. Within each evidence JSON, `before`/`after` are capture stability frames, while filename before/after identifies the product version; the report must not conflate them. Runtime reference records examined for staff, finance and inventory show empty issue lists in actual dark portal context. These are focused references, not proof of every role/component or full contrast.

**Final architecture/contract disposition: GO.** The scoped code and documentation preserve the agreed compatibility policy and route/role/tenant/API contract. Visual rendering acceptance remains with design/coordinator; no architecture blocker remains.
