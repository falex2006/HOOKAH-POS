# UI-09.2 — system_architect independent provenance audit

Date: 2026-10-11. Read-only investigation; only this report was written. No Git/product/runtime/publication changes.

## Decision

A reproducible **local review candidate** can be built safely using the fixed cached upstream commit `2e6f557934fe29a9a227dda73277f6c3f99af939` and explicit accepted-stage deltas. Whole working-tree overlays are unsafe. This review does not certify a release-ready candidate until its own focused checks, dependency closure and scope manifest pass; it does not grant publication.

UI-09.1 is ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT. This permits package preparation; it does not make its unverified matrix, security concerns or current-source evidence valid for a reconstructed candidate automatically.

## Verified baseline

- Local HEAD remains `802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf`; cached origin/main is `2e6f557934fe29a9a227dda73277f6c3f99af939`, 31 intervening commits. No network refresh was performed by this reviewer, so this is a fixed available base, not a claim of latest live GitHub/VPS state.
- `tmp/ui012-baseline/source-hashes.json`: all **215/215** frozen files exist and exactly match their stored SHA-256.
- Relative to that frozen source, exactly **8** existing source files changed: `app.js`, `lock.js`, `platform.css`, `platform.html`, `platform.js`, `portal.js`, `server.js`, `style.css`.
- Raw Git-vs-worktree hashes differ widely because of LF/CRLF. With only CRLF normalized to LF, **24/215** baseline paths differ from origin/main. This establishes inherited content divergence, not only line-ending divergence.
- Important divergent inherited baseline: `app.js` order-card preparation summary; related CSS; `portal.js` table-schedule handling; `server.js`/`db.js` schedule and other additions; `table-minimum-schedule.js` normalization; `schema.sql` and `migrations/091_pos_order_refund_items.sql`; `migrations/098_alphasat_readonly_adapter.sql` absent origin. Several HTML files differ only/primarily in stale revision counters.
- Upstream `2e6f5579` specifically contains replay-safe refund migration logic missing from frozen/local schema. Overwriting schema or migration091 would regress that fix.

## Recommended exact provenance strategy

1. Materialize base from the immutable full commit, including its migrations, server, DB, Dockerfile and package files.
2. Derive normalized **UI012 frozen source → accepted current source** deltas for the eight changed existing files. Keep one patch/input hash per file. Apply only those deltas onto the base; reject or explicitly reconcile conflicts with bounded span provenance. Do not copy whole app/portal/server/style files from the dirty root.
3. Add `ui-dialog.js` and its mirror as a new accepted UI-04.1 module. Later UI04/07 changes are documented by stage-specific intakes and RESULT files. Include only the explicitly selected UI QA scripts; scripts requiring private `tmp` fixtures are local evidence helpers, not production runtime dependencies.
4. Include `site-map.json` only as a declared UI-01.1 **documental registry** change: PROGRESS lines31 onward records metadata, permissions/notifications/help hashes, payroll and canonicalization. Canonical entries and old fields are preserved; runtime does not read it. This is an explicit accepted baseline exception, not license to import arbitrary baseline files.
5. Documentation additions must be a finite reviewed allowlist. Do not import all docs/release, deploy, archive-recovery, private fixtures or older QA reports wholesale. Prior production-result documents are historical references, not authorization.
6. Generate source/dist pairs and aliases only inside the candidate. The accepted root mirrors have CRLF-specific evidence SHA; normalized/rebased candidate hashes must be recorded separately. Historical browser evidence cannot be rebound to them by renaming.

Stage provenance exists at `tmp/ui021/*.before`, `tmp/ui031/*.before`, `tmp/ui032/*.before`, `tmp/ui042/intake`, `tmp/ui043/intake`, `tmp/ui051/intake`, `tmp/ui052/intake`, `tmp/ui061/intake`, `tmp/ui062/intake`, `tmp/ui071/intake`, `tmp/ui072/intake`, `tmp/ui081/intake`, `tmp/ui082/intake`, `tmp/ui091/intake`, plus immutable stage acceptance manifests. UI091 aggregate intake patch covers its minimal CSS/platform/tests fixes only, not all UI stages.

## Build dependency closure

| UI / runtime | Required closure | Evidence / permitted action |
| --- | --- | --- |
| POS and portal shared feedback/dialog loader | `/ui-dialog.js?rev=1`, module, exact server static allowlist | `server.js` frozen→current diff is exactly one line adding `/ui-dialog.js`; UI04.1 RESULT explicitly accepts it. No API/auth/RBAC handler edits. |
| Docker runtime | Copy shared module into image | Origin and root Dockerfiles both lack `ui-dialog.js` COPY. Add only this bounded build dependency in candidate. **Retain upstream `COPY table-minimum-schedule.js ./`; root dirty Dockerfile omits it.** |
| Published static package | `ui-dialog.js` root/dist equality after rebuild | Current sync-published-assets does not copy this new module. Add bounded build copy or explicit deterministic candidate mirror step and verify it. |
| Browser cache | New revisions for changed app/portal/lock/platform/CSS and indirect portal bootstrap | Root keys CSS420/app221/portal481 are inherited, unchanged through UI stages. Assign concrete fresh keys inside candidate build, update HTML + bootstrap + source/dist and verify. Do not ship changed bytes under old keys. |
| Canonical pages, headers, role routes | Retain origin aliases and server/default permission logic; replay only accepted nav controller | UI03.2 source delta owns disclosure/search/history; no permission widening or canonical route rewrite. UI091 architect GET402 validates current source, not every rebased candidate mutation. |
| API/DB/calculations | Retain immutable origin server/DB/schema/migrations apart from static allowlist | No UI stage requires backend business changes or new DB migrations. Verify exact protected hashes/normalized blobs in candidate. |

## Candidate-specific acceptance caveat

The inherited `orderCardPreparationState` helper and matching card-state CSS exist in frozen UI012/current but not origin/main. They are outside the pure post-baseline UI delta. UI091 observed the current order-ready card and amount. A candidate excluding these inherited spans must **not** claim that exact current card evidence as its own. If later UI changes depend on those spans, resolve their narrowly declared dependency using prior accepted feature provenance and a separate scope decision; do not silently include the entire app baseline. Otherwise retain origin behavior and document the difference, then run focused candidate order/preparation checks. This is a release scope/QA obligation, not a reason to overwrite unrelated business code.

## Remaining conditions before publication

- Specific candidate commit/tree, finite file+span allowlist and origin-vs-candidate diff must be reviewed. UI-stage acceptance alone does not approve imported inherited changes.
- Deterministic reconstruction/archive must match its exact candidate Git tree and content hashes, not HEAD802d or working-root source hashes. Rebuild twice and compare.
- Focused syntax/contracts/source-dist/cache/Docker closure and candidate-specific smoke must pass. Full matrix/Edge/WCAG remain UNVERIFIED unless actually run.
- UI091 documented security/backend findings (other-target PIN, ignored non-OK lock prefs, audit CSV escaping) require applicability/owner disposition at release decision; this audit did not reproduce or close them.
- Obtain current target release SHA, DB version, backups and rollback metadata during the separate publication task; no secrets in public artifacts. Backup restore proof must precede publish. Historical VPS report paths are not current verified facts.
- GitHub/VPS publication requires explicit UI09.3 instruction and workflow. Fold UI10.1 remains separate.

## Handoff

Coordinator owns candidate construction/reconciliation; code_health owns final diff/dependency review; QA owns fresh candidate evidence. Architect scope recommendation: GO for bounded reconstruction, CONDITIONAL for candidate acceptance, NO publication authorization. No hidden API, money, tenant or role contract change is proposed.

## Follow-up — exact three-way merge resolutions (2026-10-11)

Reviewed `tmp/ui092/ui-only.patch`, `merge-probe.jsonl`, and `delta/merged-{app.js,portal.js,style.css}` against the frozen before inputs and cached origin. Managed candidate base is `C:/Users/ADMIN/.codex/worktrees/ui092-release-candidate/HOOKAH CRM 2`, origin SHA2e6f. This reviewer did not modify its files.

- **app.js conflict:** UI branch includes unchanged baseline `orderCardPreparationState` followed by new `mountPosPrimitives`. The merged prototype contains **one** occurrence of `orderCardPreparationState` (its definition); the merged drawOrder retains origin's status rendering and has no call to that helper. Remove exactly that baseline helper, retain the UI05.1 function and its call. This resolves inherited context leakage without introducing an undefined reference. The status-card evidence caveat above still applies.
- **style.css conflict:** unchanged baseline `/* Clear next steps for employee order flow. */` block is prepended to new UI02.2 blocks by merge conflict context. Remove that exact prefix through the blank separator before `/* UI-02.2 opt-in primitives... */`; retain the UI02.2 block and following accepted UI content. The older `.order-head .status[data-order-state=...]` blocks present in frozen/current input are absent in the merged prototype; later `.ui-pos .status[data-order-state=...]` selectors are genuinely added UI05.1 scope and may remain even if inactive under upstream status markup.
- **portal.js conflict:** retain the UI ordinary-editor branch to preserve shared draft/pending/focus lifecycle; both minimum time fields and the same PATCH payload are present. **Required reconciliation:** the UI branch removes origin's `Boolean(start) !== Boolean(end)` local validation. `createPortalEditorScope` and ui-dialog provide no replacement table schedule validation. Preserve this upstream condition in the new validate callback, returning a field error for the missing partner and message `Укажите оба времени или очистите оба поля`. Otherwise a known local guard is lost and a needless invalid PATCH replaces it. Retain current API error handling for equal times/server rejection. Validate paired-empty, both-set and each one-sided case with actual-source or focused UI QA.
- `server.js` merged source differs from origin only by the approved static allowlist addition `/ui-dialog.js` (17 bytes including separator). No whole baseline server overlay is justified.
- The other five file merges reported status0; that fact alone is not final scope/QA PASS. Record their input/output hashes, compare final origin diff to the accepted-stage patch, and retain the documented protected backend/migration hashes. Clean merge is compatibility evidence, not browser acceptance.

**Follow-up decision:** proposed app/CSS conflict resolutions are GO; portal resolution is GO **after** restoring the upstream time-pair guard. Candidate-specific validation remains required. This is still bounded release construction, no publication authorization.

## Follow-up — explicitly declared presentation prerequisites restored

Reviewed `restore-prerequisites.cjs`, `prerequisites.json`, the current managed candidate and frozen `docs/release/UI_09_2/inputs/manifest.json` after the coordinator restored bounded dependencies. **34/34 frozen input SHA256 values match**.

The earlier app/CSS exclusion recommendation is superseded only for these explicitly named spans: they are now declared prerequisites with hashes and accepted scenario provenance, rather than accidental three-way context. This is appropriate because UI051/UI091 acceptance depends on the close/back/keyboard/pending/result and preparation-card presentation they provide.

Independent checks:

- Catalog modal and order-next-step paragraph from current index exactly match normalized immutable UI012 index fragments. Entire index/root HTML was not overlaid: reconstruction starts from origin and replaces only these fragments before deterministic revision/brand synchronization.
- Restored11 order-status CSS rows match the frozen baseline exactly. Restored Clear-next-steps catalog/footer CSS exists exactly in frozen baseline. The diff remains localized to catalog/status display.
- The refreshed catalog handler span is2334bytes and contains no POST/PATCH/DELETE/PUT method declaration. It implements focus return, close/Done, Escape/Tab containment and product GET refresh.
- Catalog addition pending start/finally changes only busy/disabled controls. Successful addition replaces auto-close with a result status, preserving the accepted multiple-item workflow. Actual order-create and item-create handler span **999bytes** is byte-equal after LF normalization to origin: SHA256 `29a0bd03e53d0a9a8d33a462544b3716c247f0328e65f4e245911c645259ea22`. Extraction required both positive boundary anchors; no empty-span comparison was used for this conclusion.
- Candidate orderCardPreparationState equals the accepted current helper; it is presentation-only over existing item preparationStatus/order.status. It has one definition, current label/next-step consumers restored together. It does not write data or change pricing/execution APIs.
- Candidate db.js, schema.sql, migration091, package.json, package-lock.json and table-minimum-schedule.js exactly equal origin normalized blobs. Candidate server equals origin after removing only the static allowlist `, '/ui-dialog.js'` addition. Thus no unrelated backend, schedule-normalization or migration WIP was imported in the checked set.
- Candidate Docker retains upstream table-minimum-schedule COPY and adds ui-dialog COPY. Portal ordinary-editor minimum-time pair validation is now present, preserving the required upstream guard.

**Architect decision: GO for these narrowly declared presentation dependencies and bounded candidate scope.** No additional backend WIP leakage was found in the checked protected set. This is a source/scope conclusion, not independent browser pixel acceptance; candidate source/VM/smoke tests and exact archive-to-commit checks still govern package readiness. Security/backend applicability and the publication conditions above remain open; no publication authorization is implied.
