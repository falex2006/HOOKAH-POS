# FIX-01…06 — merge и подготовка сервера

Дата: 08.10.2026. Этап: merge выполнен, production deployment не выполнялся.

## Подтверждено

- PR https://github.com/falex2006/HOOKAH-POS/pull/5 merged.
- Main SHA: 1ceb09c9f9d9b210558aa810e5af807884a0af43. Дерево идентично проверенному ce4684e4; PR CI CRM/AI team success. Отдельный post-merge push CI в этом отчёте не подтверждён.
- Архив tmp/FIX-01-06-main-1ceb09c9.tar.gz: 954 файла побайтово соответствуют Git blobs merge commit. SHA256: d06e3423e053dc0ffeb937ed94132e77c73f51e24c2df1253d652afe14ea9db8. Manifest: FIX_01_06_MAIN_MANIFEST.json.
- Сервер: SSH alias hookah-crm-vps; действующий checkout /root/hookah-pos-release-1ae58fd0, main 802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf, clean.
- Контейнеры hookah-pos crm/db healthy. HTTPS https://212.192.0.58/api/health проверен curl без отключения проверки сертификата: status ok, PostgreSQL.
- Резервная копия: /var/backups/territory-crm/hookah-pos/fix01-06-20261008T185249Z/database.sql.gz.
- SHA256 backup: 92debcae6d881f8ba8cb1c39d7b2e7d2bb4b65b4c00b67253e6c4a7061ef1beb.
- gzip integrity и восстановление в отдельно созданную БД PASS; users/orders/payments присутствуют. Временная БД удалена только после успешного создания; отсутствие временной БД повторно подтверждено. Рабочая БД не изменялась.
- Image IDs и приватные env/compose/nginx сохранены рядом с backup на сервере с закрытыми правами. Секреты не скачивались и не выводились. Это локальная серверная копия, не независимое внешнее backup-хранилище.

## Условия перед обновлением

1. Исправить ownership guard verify-backup.sh: cleanup должен удалять только успешно созданную самим запуском БД. Текущий trap ставится до createdb, поэтому при конфликте имени способен удалить чужую БД. Во время подготовки использован отдельный guarded restore; штатный опасный скрипт не запускался.
2. Обеспечить порядок миграция099 → новый API/UI. Текущий deploy-vps.sh запускает crm до migrate-vps.sh, а новый код уже обращается к order_item_execution. Требуется согласованное окно обслуживания и корректный порядок переключения.
3. HTTPS исправен, но COOKIE_SECURE=false. Для штатного HTTPS deploy требуется COOKIE_SECURE=true; HTTP opt-in не применялся. Согласовать HTTPS-only доступ сотрудников и изменение cookie перед выпуском.
4. Для выбранного состава не выполнять повторное заполнение меню: SKIP_MENU_SEED_ONCE=true. Сохранить прежние image IDs и настройки: mutable pull db/nginx не откатывается одним checkout старого commit.
5. Перед фактическим переключением повторить backup и restore-check (нынешняя копия фиксирует время подготовки), подтвердить текущий SHA и состав рабочего checkout. После выпуска: health, вход/выход, роли, заказ → приготовление → оплата → склад, история.
6. Откат099 через DROP запрещён: после новой работы таблица содержит факты исполнения. Возврат старого приложения требует остановки затронутых сценариев и плана сохранения новых операций.

Независимый read-only review: code_health_engineer подтвердил риски скриптов и отсутствие нового дефекта самой099. Продуктовые файлы, серверная конфигурация и активные контейнеры в этом этапе не менялись.
