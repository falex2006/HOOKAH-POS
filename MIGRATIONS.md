# Миграция PostgreSQL

1. Создать базу и пользователя из `.env`.
2. Применить `schema.sql` одним запуском.
3. Применить `seed.sql` только для тестовой площадки.
4. Проверить индексы и healthcheck CRM.
5. Для production использовать отдельные миграции и резервную копию перед изменением схемы.
6. Для существующей базы применить `migrations/001_auth_sessions.sql` перед включением persistent sessions.

Пример для контейнера:

```bash
docker compose up -d db
# init scripts из /docker-entrypoint-initdb.d выполняются автоматически на новом томе
```

Для существующего тома:

```bash
docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < migrations/001_auth_sessions.sql
```

Либо использовать подготовленный `./migrate-vps.sh`: он дождётся готовности PostgreSQL и применит все SQL-файлы из `migrations/`.

Проверку остановки и повтора оболочки runner можно выполнить командой `bash scripts/migrate-vps-runner-qa.sh`. Она использует временные SQL-файлы и подмену Docker/psql, не подключается к базе и не доказывает откат транзакции PostgreSQL.

Миграция `006_guest_venue_phone_unique.sql` переводит уникальность телефона гостя на составной ключ точки и телефона для сетевого режима.

Миграция `011_user_preferences.sql` добавляет JSON-поле персональных настроек аккаунта: таймер блокировки рабочего места и настройки отображения главной/аналитики. Она безопасна для повторного запуска через `ADD COLUMN IF NOT EXISTS`.

## 099 — отдельное исполнение строк заказа (FIX-03.1)

`migrations/099_order_item_execution.sql` аддитивно добавляет nullable `products.preparation_station` и таблицу `order_item_execution`: одна запись на order_item_id, station bar/hookah/null, status new/queued/in_progress/ready и nullable временные отметки. Tenant/заказ определяются через order_items→orders. Legacy station/status, цены и immutable финансовые guards не меняются.

Повторный запуск безопасен: DDL IF NOT EXISTS и backfill ON CONFLICT DO NOTHING. Переносится только активная история: точные legacy station bar/hookah распознаются, прочие становятся null; order ready→execution ready, in_progress→queued, open→new. Историческое время передачи не выдумывается. Закрытая старая история не заполняется; новые оплаченные работы сохраняются до исполнения.

Порядок выпуска: backup и проверка миграции в изолированной БД, затем099, совместимый API и UI. Старый код может не читать новые поля, но откат приложения требует отдельно учитывать уже созданные работы и ограничить несовместимые изменения. Разрушительный rollback с DROP таблицы/колонки не предусмотрен: он удалил бы факты исполнения. При проблеме сохранять данные, останавливать затронутый функционал и выпускать совместимую исправляющую миграцию. Само наличие документа не означает production-развёртывание.

## Migration 100 — table minimum schedule

`migrations/100_table_minimum_schedule.sql` adds nullable `minimum_order_start_time` and `minimum_order_end_time` to `tables`. Both must be set together and cannot be equal. Null values preserve the existing always-on minimum behavior. The release workflow must apply migration 100 before the updated API starts.
