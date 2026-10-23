# Schedule settings: employee context isolation — 2026-10-24

## Confirmed error and bounded fix

The mounted settings component allowed an old employee A functions/availability response to overwrite selected employee B, including PUT targeting A while B remained selected. Old availability stayed editable during the next load, clearing selection accepted late data, and delayed defaults opened A with current qualifications. Baseline browser run reproduced 24 issues at 390 and 1440 CSS pixels.

Employee reads now invalidate both loaded states and writes immediately, clear stale availability and messages, and commit both responses atomically only for the current selection, generation and open dialog. Late success/error after switch, clear or close is ignored. Failed current reads provide a local retry. Saves capture the selected employee and version, require both loaded identities to match, prevent concurrent writes, and apply responses only to their context. Defaults capture the binding before awaiting. No backend, database, route, permission or CSS change.

## Verification and evidence

- `node scripts/staff-schedule-employee-context-browser-qa.cjs`: source PASS, 16 screenshot observations, zero issues/page errors.
- Same command with `EMPLOYEE_CONTEXT_DIST=1`: published assets PASS, 16 observations, zero issues/page errors.
- Each run covers delayed functions, delayed availability, correct synthetic PUT recipient, delayed defaults, cleared selection, second-read loading/failure/retry, late rejection and closed-dialog late success at 390/1440.
- `node --check` source/dist/new QA and `git diff --check`: PASS. Source/dist byte parity checked.
- Root inspected mobile current-read error and wide recovered screenshots, caught and removed a stale prior success message; final screenshots regenerated and mobile error reviewed.
- MASTER independently reviewed baseline and final diff as code-health: bounded GO for generation, atomic state, captured identity and defaults qualifications.

Evidence: `tmp/planning-employee-context/{baseline,source,dist}/report.json` and screenshots. Tests use actual mounted modules/CSS with a synthetic per-employee API. They do not establish actual PostgreSQL writes, production RBAC or every settings scenario. Existing defaults double-click and uncertain-commit retry semantics are outside this error package; no claim of a complete product audit.

## Release boundary

The latest direct user instruction freezes new improvements and authorizes the verified joint GitHub/VPS release. MASTER is the sole release coordinator; this package is handed over as a committed slice. Unfinished payroll/loyalty work is excluded, preserved separately. No GitHub/VPS operation has been performed by this UI worktree at this point.
