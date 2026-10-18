# UI-09.2 candidate code health review

Date: 2026-10-11. Candidate: `C:/Users/ADMIN/.codex/worktrees/ui092-release-candidate/HOOKAH CRM 2`. Base: `2e6f557934fe29a9a227dda73277f6c3f99af939`. Main checkout left intact. Read-only review; this report/results only written in main tmp. Source VM tests wrote excluded candidate tmp outputs.

## First candidate checkpoint

- 18 listed UI/source-VM checks plus existing local-deploy contract: **17 PASS / 2 FAIL**. Exact stdout/stderr/status: `health-candidate-contract-results.json`.
- 32 changed/new JS/MJS syntax checks PASS. Source/dist 55/55 pairs exact. Dynamic script dependency scan with optional whitespace found eight assets, all present and Docker-copied. Existing deploy recursive server-module closure PASS. No package/lock or DB/schema/migrations diff against pinned candidate base.
- `git diff --check` PASS. Structural evidence: `health-candidate-structural-results.json`.
- Main packager syntax PASS. It requires isolated Git checkout, exact base, clean status, unique relative input paths, forbidden tmp/env/git/dependency/backups paths and per-input SHA256, then explicitly adds ui-dialog to Docker/sync and bounded cache revisions before isolated sync. It does not deploy or commit. Current code uses lexical containment, not symlink-realpath denial; acceptable only for coordinator-created trusted clean candidate with no input/target links. User-facing general-purpose reuse should add realpath/link validation and prevalidate all inputs before writes.
- Candidate Docker retains upstream table-minimum COPY and adds shared ui-dialog COPY, closing both baseline runtime omissions. server.js delta is only static allowlist addition. Sync adds seven fresh cache keys and shared dialog copy; portal-session indirect URL revision is generated. No backend business overlay proposed.

## Blocking first-checkpoint findings

1. **P1 lost accepted catalog lifecycle/flow dependency:** candidate app.js retains upstream direct catalog open/close and auto-close on add, lacks closeCatalog, Done wiring, aria-hidden, Tab/Escape/focus and pending exit guards. UI051 source check produces 15 PASS / 2 FAIL. This is a real candidate mismatch with accepted UI091 behavior, not a stale test signature. These spans appear inherited in UI012; a pure post-baseline patch can omit them while later accepted tests depend on them. Coordinator must explicitly add narrow accepted feature provenance, rather than suppress tests or copy whole dirty app.

   Minimal accepted root anchors: declaration `let catalogReturnFocus=null;` (line620 at review); close/open/keyboard handlers between `const refreshOpenCatalog=` and `function recalc()` (lines629-634); only grid-add pending line645, successful flow-note line659 replacing auto-close, and finally restore line667. Product/order POST payload/error/readback block otherwise matches origin and remains intact. Do not transplant payment/order business blocks.

   HTML also lacks #catalog-done, #catalog-flow-note, #order-next-step, catalog aria-hidden and dialog labeling. UI051 VM manufactures its own catalog DOM; JS-only PASS cannot prove actual controls exist. Restore the bounded accepted catalog HTML fragment (and corresponding note/footer CSS) as declared dependency. Order-next-step/state-card helpers are separate accepted feature scope; include with explicit provenance or declare their absence, never reuse UI091 card pixels as candidate proof.

2. **P2 incomplete check dependency:** ui-component-primitives-contract cannot read `docs/design/UNIFIED_UI_2026-10-09/components/UI_02_2_REFERENCE.html`; accepted reference needs finite frozen inclusion or the test cannot run. Do not skip it and report PASS.

No candidate acceptance recommendation until these exact findings are closed. Financial actual-source VM already PASS 36/36 at this checkpoint; that is VM/source evidence, not new browser/PG persistence acceptance.

## Scope and evidence limits

Reviewed frozen-input manifest (32 entries initially), eight merged sources/helper, Docker/sync/portal bootstrap delta, accepted-stage/protected base boundaries and the focused contracts. No tests changed by this reviewer. Full inherited source/API/security behavior, browser role matrix and target production remain unverified. Archive membership/hash extraction, reproducibility and secret filename/marker scan are still required after the corrected candidate is frozen.

## Corrected prerequisite checkpoint

Coordinator added explicit accepted catalog/order-card presentation prerequisites and their HTML/CSS dependencies. Actual source now has close/done/Tab/Escape/return focus, pending exit disable/restore and retained catalog success status. Candidate index contains actual Done/flow/next-step elements and dialog labeling/aria-hidden. UI051 rerun: **17/17 PASS**, without modifying its test. Independent comparison reconstructed the exact pre-prerequisite app input (SHA256 a58834f0...) from merge prototype; final entire grid-add handler equals that earlier handler byte-for-byte after removing only the three documented presentation line edits. Its order/item POST payloads, error paths and readbacks therefore remain unchanged. Evidence: `health-candidate-final-structural-results.json`.

32 changed/new syntax checks, 55 source/dist pairs, whitespace all PASS after restoration. Financial VM remains 36/36. Second full focused run: **18/19 PASS**; component reference HTML now exists, but `ui-component-reference.js` remains a missing check dependency at this checkpoint. Coordinator notified to add exact finite JS/CSS reference inputs. `health-candidate-final-contract-results.json` is the accurate second-run output; do not label all checks passed yet.

Packager fail-closed negative tests actually executed: no candidate arg, primary shared checkout, already dirty isolated checkout each rejected before writes with the expected assertion. Results: `health-packager-negative-results.json` (3/3 PASS). No positive rebuild or archive was performed by this reviewer; coordinator owns those steps.

## Final corrected candidate recommendation

**GO for the bounded local release candidate**, conditional on coordinator/QA completing exact archive reconstruction/extraction/hashes and final secret/artifact membership review. This is not publication approval.

Fresh final verification at 2026-10-11T04:11:28Z:

- **19/19** focused UI/source-VM and local-deploy scripts PASS. UI051 17/17; UI071 finance 36/36. No harness checks weakened by this reviewer or to close these findings.
- **34/34** syntax checks PASS (33 changed/new candidate JS/MJS plus main packager).
- **55/55** published source/dist pairs exact; candidate diff whitespace PASS.
- **36/36** frozen input hashes match manifest. UI022 reference HTML/JS/CSS all now finite included inputs. Earlier ENOENT and lost catalog findings are CLOSED by actual restored source/dependencies.
- DB/schema/migrations/package/lock unchanged against immutable origin base2e6f. server delta remains static shared-dialog allowlist only; previous exact catalog POST/error/readback preservation proof remains applicable.
- Reviewed final packager now also denies physically identical primary checkout and linked target path segments, rejects noncanonical backslash/colon input paths, and prevalidates/hash-checks every input before any copy. These additions address the earlier identified isolation caveat. Final packager syntax PASS; no general OS filesystem race/security certification claimed.
- Full final command statuses/stdout/stderr/syntax/hash/mirror data: `health-candidate-final-results.json`. Earlier checkpoint JSON is retained as failure/recovery evidence, not final status.

Remaining conditions: deterministic reconstruction should match exact hashes and positive archive allowlist; archive must be labelled uncommitted candidate unless tied to actual accepted commit; no secret/private/tmp/dependency/QA DB payloads; no API/RBAC/tenant/money/calculation expansion; Node20 Docker image/runtime and candidate-specific browser coverage are not established by Node24 syntax/VM checks. Prior Edge/WCAG/matrix/security debts remain explicit. Before a separate UI09.3 release, fresh target SHA/backup restore/auth/cookie/rollback/CI/health proof is still required. No commits, staging, push, DB migration, browser test or deployment performed by this reviewer.

## Artifact-ready checkpoint: 38 frozen inputs

Fresh rerun at 2026-10-11T04:14:21Z after adding candidate readiness and read-only archive verifier:

- 19/19 selected contracts/source VM PASS; 36/36 syntax checks including candidate verifier and both main release tools PASS; 55/55 mirrors exact.
- 38/38 frozen input hashes match; staged and complete HEAD-relative diff whitespace PASS; no unstaged candidate delta; DB/schema/migrations/dependencies unchanged against base.
- Independently compared every included existing QA script to normalized root: only three (`ui042-ordinary-editor`, `ui042-table-schedule`, `ui051-presentation`) have trailing EOF newlines trimmed. Assertions/content before EOF remain exact. Evidence: `health-eof-guard-proof.json`.
- Current statuses/logs: `health-candidate-artifact-results.json`. This supersedes prior 36-input totals for this checkpoint.
- Candidate readiness correctly distinguishes previous WIP browser evidence from fresh rebased candidate requirements and retains security/CI/VPS/backup/rollback conditions.

Archive verifier reviewed as read-only Git commit/TAR regular member/blob/executable-bit and scoped secret-signature checker. No extraction/deploy paths. Initial verifier output name `archiveModesExact` overstates its Boolean executable-bit comparison; use `archiveExecutableBitsExact` or compare complete permissions. Reject unsupported PAX size/linkpath/global.path keys and nonzero data following TAR EOF before claiming complete parsed inventory. These finite hardening suggestions were sent to coordinator; actual generated archive verification and independently malformed fixtures remain to be run after final script freeze. No candidate product blocker found in this checkpoint; local package GO remains conditional on those accurate archive/membership proofs.

## Final archive guard review

**GO: verifier hardening findings CLOSED.** Final script SHA256 `cbf7c2e74e88002ebbaad9f1aa293632b4a608eb883f07307286d4e239082643` matches frozen manifest and candidate bytes. Syntax PASS. Output accurately calls its permission check `archiveExecutableBitsExact`; global/local PAX override keys are bounded; unexpected directories and nonzero bytes after EOF rejected; Git commit annotation required exactly.

Independent actual-source VM fixtures with mocked read-only Git/archive IO: **12/12 PASS** — valid annotated content/mode, rejection of trailing nonzero bytes, unsupported global path/local size, wrong blob, executable mismatch, unsafe path, unexpected directory, duplicate member, symlink, missing inventory and missing commit annotation. This is deterministic guard behavior evidence, not verification of the actual production archive. Evidence: `health-archive-verifier-selftests.json`; final script hash/guard counts appended to `health-candidate-artifact-results.json`.

No remaining source/build/guard blocker in the reviewed bounded local candidate. Coordinator-reported fresh reproducibility tree `c70e4ad4997491f4aec8588f412a492efa4a5756`/88 changed paths and idempotent sync were not independently rerun by this reviewer; archive/tree/source-list correspondence remains final coordinator/QA evidence. All publication, target runtime/browser/security conditions above remain explicit.
