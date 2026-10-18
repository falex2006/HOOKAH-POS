# UI-09.2 code health baseline

Date: 2026-10-11. Role: code_health_engineer. Independent read-only audit; only this report was written. No product/scripts/index/DB/deploy changes.

## Current identity and inherited state

- HEAD/main: `802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf`. Index has no staged paths. `git status --porcelain --untracked-files=all` lists 12,209 entries at audit time, heavily including tmp/evidence. This is not a release file list.
- 133 tracked paths differ from HEAD (8,168 added/1,948 removed lines at audit time). Existing backend/db/schema/migration/business changes are inherited, not UI-09.2 work. UI scope must be selected by prior accepted stage intake/final provenance or an independently approved compatible base; do not archive everything.
- UI-09.1 intake comparison: seven protected modules unchanged (`app.js`, `portal.js`, `portal-session.js`, `ui-dialog.js`, `server.js`, `db.js`, `site-map.json`). CSS, platform retry and two scoped contracts differ as documented by accepted UI-09.1; new UI091 contracts also require explicit inclusion. Historical UI051/UI052 frozen hashes must remain historical guards, not silently rewritten.
- Current CSS SHA256: `c3506edcc251ecc354e4d1bf733153c95b9da849ae2f1d70fb14109ed282b82f`; current platform.js: `c9859cbb361bc110371f054c842282337bf2ed662593140a022724c389dd31e3`.
- UI-09.1 accepted scoped with documented debt, expressly not publication approval/full Cartesian matrix/WCAG PASS.

## Structural checks actually executed

- 55/55 published HTML flat/alias and root/dist JS/CSS pairs byte-identical (from published-html-manifest plus mirrored dist modules).
- `node --check` PASS for 14 root modules: app, portal, platform, login, lock, ui-dialog, portal-session, staff-display-name, staff-admin-card, server, db, order-preparation, table-minimum-schedule, effective-permissions.
- Whole tracked `git diff --check`: PASS, no whitespace diagnostics.
- package.json/package-lock.json unchanged from HEAD; no dependency update planned, npm audit not run in this baseline. Runtime host Node v24.21.0; Docker declares node:20-alpine. Syntax on host does not prove Docker image build.
- Existing `node scripts/local-deploy-contract.mjs`: **FAIL** at line 78: reachable server runtime module table-minimum-schedule.js must be copied into the CRM image.
- No browser, production, full regression or archive checks run by this baseline. All test results are baseline source observations, not candidate validation.

## Findings and minimum fixes

1. **P1 inherited release blocker: Docker runtime module missing.** server.js requires `./table-minimum-schedule` at line 9; current Dockerfile excludes that file. Module-not-found prevents container startup. Owner: release/frontend-backend integration. Minimum remedy in approved candidate build composition: explicitly copy the accepted module (and preserve its business provenance); re-run reachable-module deployment contract and actual candidate closure. Do not sneak unrelated server/schema changes into a UI-only package to satisfy closure.

2. **P1 inherited release blocker: shared dialog asset omitted from Docker/sync.** app.js line 12 and portal.js line 721 dynamically request `/ui-dialog.js?rev=1`, server static allowlist serves it, root/dist copies currently exist, but Dockerfile COPY and sync-published-assets list omit it. Locally accepted modal behavior would degrade on image/static publication. Owner: release/frontend. Minimum remedy: candidate build explicitly copies ui-dialog root+dist and records their accepted hash; build guard must find dynamic scripts with optional whitespace. Existing local-static-boundary regex matches `script.src=` only; current consumers use `script.src =`, so its scan can miss this dependency. It was inspected, not executed here.

3. **P1 scope/provenance hazard: naive archive of dirty tree.** `.gitignore` has only `/tmp/full-local-qa/`, not all tmp; current untracked tmp contains private runtime/credential files and disposable data. `.dockerignore` excludes tmp/env but is not an archive policy. Owner: coordinator/release. Use positive path allowlist, exact hashes, no symlinks/junctions, exclude tmp/.git/node_modules/archive-recovery/deploy-unapproved/local databases/backups/secrets. Reject unclassified files; .env.example may be included only explicitly as template.

4. **P2 deterministic sync hazard.** sync-published-assets rewrites all declared source and dist HTML, version URLs, portal-session bootstrap, brand injection and copies assets. Do not run on primary dirty tree to prepare UI092. Run only in a selected isolated candidate if reviewed or use exact selected mirrors. `--saas-only` is intentionally narrow and cannot prepare complete CRM/POS UI.

5. **P1 release decision debt (not re-exploited):** UI091 lists other-target PIN protection, non-OK lock-preference PATCH, audit CSV escaping and incomplete Edge/WCAG/matrix evidence. Preserve explicit owners/conditions; source packaging alone cannot mark them fixed. Existing prior release docs about migration/rollback/server cookie flags are historical evidence and must not be asserted as fresh server state.

## Existing release procedure suitable for reuse

- DEVELOPMENT_WORKFLOW requires coherent accepted changes, syntax/diff/role-save/mobile gates and archive correspondence to published commit SHA. UI092 explicitly forbids publishing.
- Historical FIX_01_06_PACKAGE.md uses base commit plus positive overlay manifest, per-file SHA256, isolated local candidate, scoped static/memory checks, secret/artifact review, archive extraction and all-file hash verification. Candidate without new commit is explicitly labelled uncommitted; publishable archive is later regenerated by `git archive` from accepted SHA and verified by Git blobs. Reuse this separation, not its old path/allowlist/status.
- package.json has no `build`/`archive` script. Existing sync and published HTML manifest are asset tooling; tar/git archive are archive tools. No new package dependencies needed.
- Final review must cover exact candidate payload, recursive server/module and HTML/dynamic JS asset closure, source/dist hashes, manifest membership/no extra files, archive SHA + extraction, script syntax/diff and relevant current contracts. Candidate product identity must be compared to accepted inputs, not main checkout existence alone.

No secrets were read or printed. No commits, push, fetch, merge, build, archive, migration or deployment performed.
