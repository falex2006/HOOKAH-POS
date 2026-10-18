# UI-09.2 — release_manager final review

2026-10-11. Scope: read-only release review; this report is the only file written by this reviewer. No product/candidate changes, GitHub publication, deployment, backup or live database actions.

## Decision

**GO for the concrete reproducible local package, with documented publication conditions. `deploymentReady:false` remains required.** No blocker to completing UI-09.2 was found in the reviewed package identity, reconstruction, archive or release plan. UI-09.3 is a separate task requiring explicit publication authorization and completed gates below.

## Exact reviewed identity

- Base/parent: `2e6f557934fe29a9a227dda73277f6c3f99af939` (cached origin/main; not a fresh remote or VPS observation).
- Local branch: `codex/ui092-release`.
- Commit: `11b81f6abea615f5aca35ad3714ae3382be388db`.
- Tree: `c70e4ad4997491f4aec8588f412a492efa4a5756`.
- Archive: `tmp/ui092/artifacts/UI-09.2-11b81f6abea615f5aca35ad3714ae3382be388db.tar.gz`.
- SHA256: `ae1d4e0fe272475ba8a42d56c9a1ab3d05a7859fe557b778787408dfeff8062a`.
- Correct export: `git -c core.autocrlf=false archive --format=tar.gz --output=<archive> <commit>`.

## Review performed

Read release_manager role, DEVELOPMENT_WORKFLOW, UI-09.2/UI-09.3 prompts and roadmap, CANDIDATE_READINESS, frozen manifest, identity, reproduction/extraction and final health records, independent QA and architect reports, builder/archive verifier, and existing deploy/backup/restore scripts.

Independently executed read-only candidate Git status/log and archive verifier. Candidate status was clean, and commit/tree/parent were exact. Archive verifier passed for 1,009 Git blobs, complete inventory, executable bits, TAR checksums, safe paths and Git commit annotation. Compressed size: 31,916,725 bytes. Zero findings under the explicit finite runtime/private-file and high-confidence token/private-key scan; this is not universal secret detection. Direct Git diff of db.js/schema.sql/migrations/package.json/package-lock.json against base was empty.

Reviewed and summarized actual completed health records: 38 frozen inputs with zero integrity failures; 19/19 focused source/VM checks; 36/36 syntax checks; 55 mirrored source/dist pairs with zero mismatches; diff check zero. Independent reviewers confirmed bounded catalogue/order-card prerequisite spans and unchanged upstream financial mutation handlers/protected files. No broad dirty-root overlay is approved.

Reviewed fresh reconstruction evidence: candidate and reproduction have exact tree `c70e4ad4997491f4aec8588f412a492efa4a5756`, identical 88 changed paths, 19/19 reproduced checks and idempotent sync. Extraction record binds 1,009 exact blobs/inventory and repeat-export identical SHA256. Reviewer did not rerun full reconstruction or extraction; those results are coordinator evidence, reinforced by the independently rerun archive-to-Git verification.

The first Windows-default autocrlf archive was correctly rejected. Final archive is the explicitly autocrlf-disabled export; rejected bytes are not a release artifact. Source/VM and packaging proof does not stand in for browser, API persistence or current VPS proof.

## Backup/rollback plan assessment

CANDIDATE_READINESS correctly requires current deployed SHA/image IDs, migration ledger and compatible startup order, protected backup, integrity/restore rehearsal, HTTPS/auth/session configuration, deployment lock/fingerprint and disabled automatic menu seed for existing data. No new migration relative to base is included, but an older VPS can still require base migrations. Preserve previous compatible image/commit and configuration; rollback must retain new transactions and must not remove migrations or restore production data without a separate data recovery decision.

Concrete precaution for UI-09.3: existing verify-backup.sh registers DROP cleanup before createdb. If a caller supplies an already-existing RESTORE_TEST_DB, failed creation can trigger removal of that database. Before executing it, use a newly generated unique, verified-absent rehearsal database name, or first fix cleanup ownership in an separately reviewed script change. Never point this helper at an existing or production database. This does not block package preparation because no restore was run; it is a required execution preflight for the next stage.

## Gates for separate UI-09.3

1. Explicit user command to publish this prepared candidate; integrate through clean reviewed GitHub/CI workflow. Recreate identity/archive if merge changes SHA.
2. Fresh exact-candidate critical desktop checks for affected roles, both themes, login/logout, keyboard/focus, orders/preparation, editors and finance in an isolated environment. UI-09.1 root browser artifacts are historical evidence, not acceptance of this rebased tree.
3. Disposition of prior PIN/lock non-OK response/audit CSV security findings by appropriate owners. Do not silently waive unresolved applicable findings.
4. Current VPS SHA/images/migration ledger and startup compatibility; protected verified backup and safe restore rehearsal; concrete rollback metadata captured before deploying.
5. Record required uncovered role/theme/state scenarios. Full Cartesian, Edge, WCAG, OS reduced-motion and Fold are not claimed; Fold stays UI-10.1.
6. Final external manifest/report must link exact SHA/tree/archive/check records and preserve the above conditions. No automatic UI-09.3 start or production test data creation.

Coordinator owns final manifest and stage/work-log completion. Release manager owns publication gating; QA owns fresh candidate browser acceptance; security/domain owners own finding disposition; deploy operator owns live preflight and recovery evidence.
