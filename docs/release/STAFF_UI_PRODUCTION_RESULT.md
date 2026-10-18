# Staff UI — production release 09.10.2026

- PR: https://github.com/falex2006/HOOKAH-POS/pull/7 (merged).
- Head: 535e844032f43925c832e6a2c0930b6c9c4c2e0e.
- Production main: dae502deb30ad634c792508d1078dd48d0f22072.
- CI: CRM contracts 37834122313 PASS; AI team contracts 37834122449 PASS.
- Archive: tmp/staff-ui-production.tar.gz; all 960 blobs match merge SHA. Hashes: STAFF_UI_PRODUCTION_MANIFEST.json.
- VPS: /root/hookah-pos-fix01-06-release, clean main; HTTPS health reports PostgreSQL OK. CRM/DB healthy, DB was not recreated.
- Backup: /var/backups/territory-crm/hookah-pos/crm-pre-3962f4c8e90b21068caef9b6727d56d2835df918d5eac90e9b3c0f99ebba4761.sql.gz. Restore verification PASS.
- Previous commit/image IDs/private configuration snapshot: /var/backups/territory-crm/hookah-pos/staff-ui-20261008T1945Z.
- Deploy log: /var/log/hookah-pos-staff-ui-deploy.log. Menu seed skipped. Repeat deployment correctly skipped healthy same release.
- Platform login/session/Secure cookie/logout PASS; anonymous POS API denied.
- Edge production hookah_master: saved elapsed time visible on occupied tables, one Add item action, red arrow/hand/text CSS active, reservations retains flat employee menu and header, return to floor works.
- Local contracts: shell parity, elapsed timer, effective permissions, header actions, navigation52, design/click/static/platform/team/deploy and SaaS/POS boundary PASS. Mock context updated for cursor cleanup and lazy catalog loading.
- Limitations: live bartender sign-in not repeated on production; exact-role behavior covered locally. Mobile/Fold intentionally deferred. No test sales or reservations created in production.
