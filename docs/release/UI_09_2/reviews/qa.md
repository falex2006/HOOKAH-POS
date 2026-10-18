# UI-09.2 — independent candidate QA

Date: 2026-10-11. Candidate: `C:/Users/ADMIN/.codex/worktrees/ui092-release-candidate/HOOKAH CRM 2`. Base: `2e6f557934fe29a9a227dda73277f6c3f99af939`. Reviewed while candidate remained uncommitted; final commit/archive identity pending. No product edits, API/DB/browser writes or publication performed by reviewer. Only this report added to shared tmp scope.

## Observed validation

1. **Frozen inputs → candidate: PASS**. Manifest contains32 inputs.31 candidate files match frozen input SHA after LF normalization. The remaining platform.html differs only by three intended style/platform.css/platform.js cache revision substitutions to2026101101, independently asserted against frozen HTML. This post-build difference is expected, not an input integrity failure. Candidate commit must record final built hashes separately from input hashes.
2. **Three-way delta reconstruction: PASS**. Independently reran Git merge-file on the preserved upstream/UI012/current inputs for eight product files. Seven frozen outputs reproduced exactly; style.css differed only by declared final EOF whitespace normalization. Conflicts restricted to app.js, portal.js and style.css; all three required bounded resolutions reproduced. No frozen output was accepted solely because merge status0.
3. **Server business boundary: PASS**. Candidate server.js equals base server.js after exactly one replacement adding `/ui-dialog.js` to browser static allowlist, under LF normalization. No API/auth/role/money/server behavior changes included.
4. **Protected upstream files: PASS**.112 files equal base after LF normalization: db.js, schema.sql, effective-permissions.js, order-preparation.js, table-minimum-schedule.js, package.json/lock, deploy/migrate/backup scripts, docker-compose.yml and all101 current migration files. Thus no root dirty backend/schema/migration/dependency overlays were imported into these paths.
5. **Conflict scope: PASS**. Candidate app.js excludes inherited `orderCardPreparationState` definition and retains UI051 `mountPosPrimitives`. Candidate CSS removes inherited conflict-prefix order-flow styles while retaining UI02.2 onward. UI091 exact status-card screenshot evidence is not automatically candidate evidence because candidate intentionally retains upstream behavior here.
6. **Minimum schedule reconciliation: PASS4/4 actual-source VM cases**. Extracted the actual table ordinary-editor `validate: values => ...` expression from candidate portal.js and executed with controlled ordinary values (valid name, min2/max4); no hand-written replacement validator and no API calls.

| Input schedule | Actual result | Expected |
| --- | --- | --- |
| Both blank | null | Allow untimed minimum |
|18:00 /09:00 | null | Allow complete schedule |
|18:00 /blank | field minimumOrderEndTime, pair-required message | Reject missing ending |
|blank /09:00 | field minimumOrderStartTime, pair-required message | Reject missing beginning |

Upstream paired-time guard is preserved in migrated editor and targets the missing field. Equal times are not rejected by this local expression; retained server error handling remains responsible. No successful PATCH or persistence was claimed by these VM tests.

## Build closure observed

- Candidate Dockerfile delta adds exactly `COPY ui-dialog.js ./`; upstream schedule module COPY retained.
- Candidate sync script updates seven intended revision constants and adds shared-module dist copy. Builder operates only against clean pinned base checkout, validates frozen input hashes and excludes obvious private/temp paths. Health owner is independently checking syntax/contracts/mirror/cache and runtime closure; this review does not claim their not-yet-received results.
- Build-generated source/dist HTML/JS revision changes are expected bounded outputs; frozen input count32 is not the final total changed file count.

## Evidence and remaining conditions

**Scoped QA GO for reviewed candidate provenance, protected boundaries and four minimum-time validation cases.** Final packaging acceptance remains conditional on exact candidate commit/tree, archive/source/dist verification, clean checkout, reproducible reconstruction and completed health records. No fresh candidate browser session or pixel matrix was run. UI091 report/assets originated from accepted dirty-root implementation; normalization and rebase change identities, so keep them historical context rather than rebinding to this candidate SHA.

Prior UI091 security/backend findings (other-target PIN, non-OK lock preferences, audit CSV escaping), incomplete current role×route×state desktop matrix, finance/warehouse ambiguous retry and storage limitations remain open for release disposition. Full Edge/WCAG/Fold are not claimed. A final manifest may say prepared/validated with release conditions; it must preserve `deploymentReady:false` until publication gate conditions are satisfied. UI093 remains separately authorized.

## Follow-up — explicit accepted prerequisites restored

The initial checkpoint above is historical. Health actual-source UI051 checks caught missing accepted catalogue lifecycle despite the first provenance-only review passing. Coordinator explicitly expanded frozen scope to34 inputs and seven positively bound accepted prerequisites; this changes the earlier app-helper exclusion decision. Restored helper/state labels and catalog DOM/flow remain bounded accepted scope, not a full dirty-root overlay. No first-checkpoint claim is silently rewritten.

Independent final follow-up inspections:

- **App positive allowlist PASS:** reconstructed first reviewed candidate app using only declared return-focus declaration, catalog handlers, two pending lines, success flow-note, order-card helper/status/next-step lines. Result equals final candidate app exactly after LF normalization. Bytes outside those spans, including API calls/payloads/math/error/readback/financial handlers, unchanged relative to first reviewed candidate. Added handlers only call existing read loader; no new API mutation contract.
- **Prerequisite proofs PASS7/7:** independently sliced actual candidate app and frozen HTML, recomputed all seven recorded SHA256. Candidate CSS includes exact recorded catalogue/status presentation span. Hashes match `tmp/ui092/prerequisites.json`.
- **Frozen index HTML bounded reconstruction PASS:** upstream index plus exact catalog fragment plus one order-next-step paragraph equals frozen input. Other inherited root HTML was not copied wholesale.
- **Frozen input integrity PASS34/34:** recomputed hashes for every immutable input.32 normalized candidate files equal their frozen inputs; platform.html/index.html are expected build-transformed HTML. Cache revisions remain build output and need final manifest hashes.
- **Table minimum-time validator PASS4/4 again:** bothblank and18:00/09:00 accepted; each one-sided pair targets missing partner. Executed actual expression extracted anew from final candidate source, with no API writes.

**Updated scoped QA GO** for reviewed positive scope/provenance and VM validation. Final commit/archive and health19-suite results remain coordinator-owned evidence; no fresh browser/DB acceptance was performed by this reviewer. The old app-helper absence claim no longer applies to final candidate, but old UI091 screenshot identities still cannot be rebound to new normalized/rebased SHA.

## Final commit/archive review

Candidate commit independently verified: `11b81f6abea615f5aca35ad3714ae3382be388db`, tree `c70e4ad4997491f4aec8588f412a492efa4a5756`, parent `2e6f557934fe29a9a227dda73277f6c3f99af939`. Candidate Git status is completely clean including untracked files. Final frozen scope38 inputs;88 changed paths are all input paths or declared build products (Docker/sync/cache/bootstrap/source-dist/HTML aliases). No unexpected changed path.

Read coordinator reproduction records and independently asserted exact candidate/reproduced tree, exact changed paths, sync idempotence and19/19 suite exit0 with null signals. These are source/VM/build checks, not browser/API persistence tests. Final38-input scope additionally closes reference JS/CSS test dependencies and includes candidate readiness/archive verifier; prior32/34-input checkpoints remain historical.

First Windows-default archive was independently **REJECTED** for Git blob mismatch at backend_engineer.md. Coordinator diagnosed core.autocrlf Windows archive export and retained rejected artifact. Correct final export explicitly uses `git -c core.autocrlf=false archive`; candidate commit unchanged. Reviewer reran read-only archive verifier on corrected final bytes and got:

- Archive SHA256 `ae1d4e0fe272475ba8a42d56c9a1ab3d05a7859fe557b778787408dfeff8062a`.
-31,916,725 compressed bytes;1009 regular Git blob members exact.
- Complete inventory, executable bits, TAR checksums/safe paths and commit annotation exact.
-0 findings under stated high-confidence private-key/provider-token signatures and private/runtime filename scan. This finite scan is not a universal secret detector.
- Result equals coordinator `archive-verification.json` SHA/identity fields.

**Final scoped QA GO for reproducible prepared package and exact archive.** Coordinator filesystem extraction/repeated-export check is separate and pending at this reviewer checkpoint. Publication readiness remains false: fresh exact-candidate critical desktop/browser/role/financial smoke and prior security/domain release disposition, current VPS backup/restore/rollback preflight and separate UI093 authorization are still required. Nothing in this review claims deploy, Edge/WCAG/Fold or new browser persistence acceptance.
