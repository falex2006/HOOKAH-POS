# Verified UI release — 2026-10-24

## Scope

Base: `17d93081fd6f6c3f1208632735d0fa38ac9a775a` (fresh origin/main fetch confirmed).
Product acceptance head: `7209b076126100b5e3e0f62976e6903a7312dc11`.

Includes committed schedule/attendance loading, error/retry, confirmation and published-history fixes; employee selection context isolation; staff view/search focus fixes. Subsequent release-only changes update the cache chain to2026102401 with no route/role/API changes.

No new database migrations, server business logic, dependencies or Docker changes. New private payroll v4 and unfinished loyalty are excluded and preserved in their existing worktrees. This release does not complete their original goals.

## Evidence

- Actual local UI/API/PostgreSQL/reload at7209b076: attendance69 assertions, terminal59983 exit0, run1792792008165-988b22; planning50 assertions, terminal34298 exit0, run1792792045826-c55a03. Both reports errors[], owned runner cleanup completed.
- Candidate employee context dist16 observations and draft write dist24: zero issues. Synthetic per-person API, not independent actual settings database proof.
- Attendance pending20 component observations, zero issues.
- Staff directory actual local memory server:3desktop views1440/mobile390, zero issues. Not PostgreSQL role proof.
- Design, click, static boundary, deployment and AI-team contracts PASS. Updated cache-chain design/static contracts PASS; final code-health review recorded separately.
- Earlier frozen evidence and scoped limitations remain in individual docs under docs/ai-team.

## Preservation and release boundaries

Primary worktree was not reset:130 tracked modified files copied to ignored candidate tmp/primary-preservation;255 status entries inventoried. UI owner compared older primary variants against released17d and confirmed they must not overwrite newer candidate files. The only verified missing sibling package, staff-view-focus, was incorporated with additive journal merge.

User release request was conveyed from UI chat01a14689-e4c5-7532-8145-3b3b3ee39343: finish existing errors, publish all verified changes together, verify after update. MASTER is sole release coordinator. No parallel deploy. Loyalty remains explicitly paused.

## Deployment and rollback

Deploy only merged canonical main after CI. Use existing guarded deploy-vps.sh; retain its preflight, backup, previous release/image and health checks. Do not overwrite .env/uploads/database or import private test data. This UI-only package introduces no schema rollback requirement. On failure, use saved previous release/image and preserved configuration; do not drop or restore production data without a concrete necessity and authorization.

Before deployment verify actual host/repository state, backups and available storage. Record exact GitHub merge SHA, deployed SHA, health and allowed browser smoke after deployment. At creation of this document publication and production verification remain pending; never treat local evidence as a VPS result.
