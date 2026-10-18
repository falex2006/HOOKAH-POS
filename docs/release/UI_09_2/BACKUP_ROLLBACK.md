# UI-09.3 — preflight, backup и откат

План подготовлен UI-09.2. Ни одно действие на VPS не выполнено. Выполнять после отдельного запуска UI-09.3 и выполнения release gates manifest.

## Перед изменением сервера

1. Определить текущий production commit, image IDs/digests, compose project, deploy state и migration ledger. Cached origin/main и локальный candidate не являются сведениями о VPS.
2. Проверить clean integration/CI и точный выпускаемый SHA. При merge SHA создать заново архив и сравнить его с Git. Собрать/проверить Node20 Docker image именно этого SHA; пройти критические browser/role/financial сценарии в изолированной среде.
3. Сверить schema compatibility со старым/новым приложением. UI092 не добавляет миграций относительно base, но VPS может отставать. Учесть, что существующий deploy flow запускает app до migration; при несовместимости согласовать maintenance-порядок до старта. Не выполнять автоматический seed существующих данных; применять штатный `SKIP_MENU_SEED_ONCE` по workflow.
4. Сохранить предыдущее приложение: commit/archive и SHA256, app image ID/digest, compose/config fingerprint и безопасные копии необходимых конфигураций. Секреты не включать в пользовательские отчёты. Учесть mutable db/nginx tags: checkout одного commit не возвращает прежние образы.
5. Проверить HTTPS, AUTH_REQUIRED, COOKIE_SECURE и сохранение сессий/tenant permissions. Использовать штатные deployment lock и release fingerprint: `/var/lock/<project>-deploy.lock`, `/var/lib/territory-crm/<project>`.

## Backup и restore rehearsal

Выполнить штатный `backup-postgres.sh`, сохранить backup и checksum в защищённой `/var/backups/territory-crm/<project>`. Подтвердить completion/exit code, целостность и доступность восстановления. Без подтверждённого backup выпуск не начинать.

Restore rehearsal — отдельная БД/volume, с изоляцией от production. **Текущий `verify-backup.sh` устанавливает cleanup DROP до успешного createdb: существующее имя RESTORE_TEST_DB при неудачном createdb может попасть под cleanup.** Release manager проверил это поведение. Перед запуском требуется новое уникальное имя, подтверждённо отсутствующее в целевом PostgreSQL, либо отдельная принятая правка cleanup ownership. Никогда не указывать существующую rehearsal или production БД. В UI092 скрипт не изменялся и restore не запускался.

Подтвердить успешное восстановление и контрольные read-only запросы по согласованной схеме; затем удалить только созданную этим rehearsal временную БД/volume. Записать безопасные доказательства backup/restore, без паролей и строк соединения.

## При регрессии

Остановить затронутые writes при необходимости. Вернуть сохранённый совместимый app image/commit и configuration, выполнить health/session/roles/read-only проверку. Отменять только этот выпуск; не сбрасывать основную dirty папку или чужую работу.

БД не откатывать удалением migration records/таблиц. Сначала оценить совместимость предыдущего app с текущей схемой и сохранить новые транзакции. Если требуется восстановление production БД, нужен отдельный согласованный план восстановления данных, окно и критерии допустимой потери; упаковка UI092 не даёт разрешения на это.

После выпуска подтвердить публичный SHA/health, login/session/roles и рендеринг. Write smoke — только согласованный сценарий в изолированной среде либо отдельное разрешённое операционное действие. Зафиксировать результат и сохранить предыдущие образы/backup до окончания согласованного периода наблюдения.
