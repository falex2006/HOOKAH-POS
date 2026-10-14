# Staff schedule production release — 2026-10-14

## Published package

- PR #41: https://github.com/falex2006/HOOKAH-POS/pull/41 (merged after both GitHub workflows passed).
- Runtime commit: `622be0f0e3ea48661e145e24b70af5779d6abc63`.
- VPS checkout: `/root/hookah-pos-release-622be0f0e3ea`, clean committed `main`.
- Runtime release ID: `301e61d2eee84993341a787099a0025b02946e1575bb288ef2361fdc66e274f7`.
- Public entry: https://212.192.0.58/admin#staff-schedule — Команда → График сотрудников.

Calendar (week/month/day/list), overnight continuations, shifts/absences, owner-delegated access, history, copy, repeating templates and draft publication are deployed with migrations 101–103. Owner retains full access; administrator/manager access is not granted automatically. Publish permission controls draft publication; manage still permits direct schedule editing. No automatic actual-attendance, payroll, orders or payment writes were added.

## Acceptance evidence

- Integrated candidate `ec696cde3af4a11bde7ea1ff40413116a02baf90`: `acceptance-1791962936774.json`, 27/27 suites PASS, source/dist parity and unchanged product-source hashes PASS. Includes real local browser writes, roles, calendar, planning, keyboard, concurrency and migration recovery against isolated PostgreSQL.
- Release gate found missing explicit button types. Final net fix is confined to schedule action buttons plus whitespace preventing a static-regex false positive. Existing submit semantics remain unchanged. Independent code-health review confirmed no duplicate type attributes, no changed submits and no blockers.
- Both GitHub workflows passed, including design/click/static/deploy contracts, API role/insights/date/login checks, dependency audit and team contract. Unrelated old payroll/sidebar/visual-page-rules text-test limitations remain as documented in the handoff; this is not a claim that every repository test passed.
- Before deployment, a production dump was restored into the separate `staff_schedule_release_20261014072758` database and every migration was applied successfully. Hashes/counts for all 89 original public tables matched the preflight production observation.
- The guarded deploy built the image, stopped CRM writes, created the final backup and passed its restore rehearsal before migrations. Menu seeding was explicitly skipped. CRM and PostgreSQL are healthy.
- Final backup: `/var/backups/territory-crm/hookah-pos/crm-pre-301e61d2eee84993341a787099a0025b02946e1575bb288ef2361fdc66e274f7.sql.gz`.
- Existing `.env` checksum and PostgreSQL volume `territory-crm_pgdata` were preserved. Previous checkout/image remain available. No manual Docker pruning was performed.
- Post-deploy hashes/counts matched for all 89 original tables. For `staff_schedules`, comparison excludes only the seven newly introduced columns; all original row values are compared. These are live before/after observations, not a guarantee that outside writers were held throughout the interval.
- Eleven public HTTPS assets match exact runtime Git blobs: portal/session, three schedule assets, app, three POS assets and two management-theme assets. Public PostgreSQL health is OK; unauthenticated schedule access returns 401.
- Read-only checks inside the deployed application validated owner permissions/calendar reads and the existing manager's lack of an automatic grant. No active administrator exists in the production fixture; administrator behavior is covered by isolated acceptance.
- Live owner login/browser verification was not attempted because the configured owner password did not match an active owner's stored credential. No credential was changed or exposed. This does not constitute a login failure; authenticated browser acceptance was performed locally, not on production.

Private evidence remains under local `qa-artifacts/staff-schedule/` and server `/var/lib/territory-crm/hookah-pos/`; no credentials, database dumps or fixture manifests were committed.

## Rollback and remaining operational limits

Migration 102 removes the uniqueness constraint used by the old blind-upsert endpoint. Old application image alone is incompatible immediately after that migration, even before multiple shifts exist. On a failure while writes remain stopped, recovery requires the verified pre-release database backup together with the old image/configuration. Once writes resume, prefer a forward fix: restoring the old backup would discard subsequent writes and requires a separate data-preserving recovery decision. The guarded script deliberately does not perform an automatic destructive rollback.

The VPS has approximately 982 MiB free (94% used) after this release. Existing backups and rollback images were retained; additional disk-capacity/retention work is outside this release.

This receipt is documentation only and does not require another application deployment.
