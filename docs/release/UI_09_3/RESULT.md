# UI-09.3 — GitHub и VPS

Дата: 2026-10-11. Статус: **DEPLOYED_SCOPED_WITH_DOCUMENTED_DEBT**.

Пользователь явно разрешил публикацию подготовленного выпуска; затем подтвердил продолжение. Fold исключён из плана. Во время финальной проверки пользователь попросил пропустить мобильную версию и другие размеры экрана; дальнейшая проверка размеров остановлена.

## Опубликованный пакет

- GitHub `main`: **ace7b365d77dfc89ce0a3303ba2d6c152c9e6115**, tree **d3d34f2433108ff1ed99a63ca2d6d7834b044a9e**.
- Последовательные PR: [20 — POS/shared](https://github.com/falex2006/HOOKAH-POS/pull/20), [21 — платформа](https://github.com/falex2006/HOOKAH-POS/pull/21), [22 — подпись таймера](https://github.com/falex2006/HOOKAH-POS/pull/22). Все прикреплены к задаче и merged. Разделение сохраняет действующий SaaS/POS boundary contract.
- Итоговый CI: [CRM contracts](https://github.com/falex2006/HOOKAH-POS/actions/runs/38112993402), [AI team contracts](https://github.com/falex2006/HOOKAH-POS/actions/runs/38112993438) — success именно для опубликованного SHA.
- Архив `tmp/ui093/UI-09.3-ace7b365d77dfc89ce0a3303ba2d6c152c9e6115.tar.gz`: **31 921 480 bytes**, **1011 Git blobs**, SHA256 **572c5f9b4a682d72cd908339bde03af866467440b0d26cbce775020af7e21b80**. Проверены каждый blob, executable bits и commit annotation; runtime/temp files и сигнатуры секретов не найдены. Экспорт с `core.autocrlf=false`; это проверка известных сигнатур, не универсальный поиск секретов.
- Базовый UI092 commit11b81f6 и его frozen evidence сохранены. Основное грязное рабочее дерево не публиковалось и не сбрасывалось; интеграция выполнена в отдельном управляемом worktree.

## Исправления условий выпуска

1. PIN: существующая политика управления сотрудниками применяется к non-self targets в memory и PostgreSQL; venue/active/deleted ограничения сохранены, UPDATE проверяет прочитанную роль против гонки изменения роли.
2. Автоблокировка: timeout/storage/schedule/закрытие окна фиксируются после успешного PATCH. Ошибки оставляют прежнее значение; успешный PIN и неуспешные preferences дают точное сообщение о частичном результате, повтор не отправляет PIN снова. Поздний стартовый GET не отменяет сохранение.
3. Audit CSV: опасные префиксы формул нейтрализуются; кавычки, разделители и переносы сохраняются. Это ограниченный контракт экспорта, не сертификация всех spreadsheet consumers.
4. Финальный GUI обнаружил устаревшую подпись custom select при правильном native value. `syncSettings` вызывает существующий `_customSelectRefresh`; source/dist и lock revision1103 синхронизированы. В браузере подтверждено «Через 5 мин» после повторного открытия; тестовый профиль восстановлен Dark/timeout0.
5. Три platform source assertions приведены к принятому pending/restore/close поведению; обязательства не ослаблены, отрицательные пробы проверены.

Новых schema/migrations/dependency изменений нет. Документы UI092 содержали устаревшее описание deploy/restore; фактический принятый parent уже выполняет stop → backup → restore rehearsal → atomic migrations → start. Исправление этих helpers текущему этапу не приписывается.

## Проверки до выпуска

- Независимые system_architect, code_health_engineer, qa_engineer и release_manager: scoped GO; отчёты в `tmp/ui093`.
- PIN actual-source VM54; lock/preferences/CSV actual-source VM38; существующий lock lifecycle25; platform8 selected suites — PASS. Syntax, mirrors, immutable diff и границы пакетов подтверждены.
- Node20 Docker final image с release label **ace7b365…**. На изолированном clone PostgreSQL: **13 ролей / 454 API checks**, 0 failures. **128 PIN/preferences/financial checks** выполнены на предыдущем accepted tree и связаны с финальным выпуском точным равенством backend Git blobs и container server hash. Whole tree после исправления lock label отличается — это явно записано.
- Исходная тестовая БД, credential hashes и бизнес-журналы сохранены; временные изменения PIN/прав/venue/preferences восстановлены. Полная финансовая пересборка не заявляется.
- Локальный браузер: owner floor/catalog Escape/Done/focus, finance/report, staff route reload/profile cancel, theme persistence, lock save/reload; platform create dialog Escape/focus, logout. Производственных бизнес-записей в этих локальных проверках нет.

## Сервер и восстановление

- Сервер: **https://212.192.0.58**. Чистый canonical main checkout `/root/hookah-pos-ui093-release` — exact final SHA.
- Runtime CRM image **sha256:256fa072bff9f6a943597adeb7186af913aa8f17c905e49c722579f1c8c9e563**, healthy; Node **20.20.2**, sharp **0.35.5** загружается.
- Fingerprint **52e0669d9593d747ae62d05c4812bd9971164ca00330b85f2a7c11653cc80cc4** совпадает с container/image label, приватной конфигурацией и deployed state.
- PostgreSQL container/image и volume **territory-crm_pgdata** сохранены; nginx image прежний, контейнер пересоздан для нового пути bind mount. TLS и Secure cookie сохранены; auth=true, setup=false.
- Выпуск: build CRM → stop writes → защищённый backup → restore rehearsal → прежние101 atomic migrations → CRM start → nginx refresh. Menu seed пропущен явным scoped флагом. `deploy-final.log`: exit0, BACKUP RESTORE TEST PASS, CRM is healthy.
- Backup `/var/backups/territory-crm/hookah-pos/crm-pre-52e0669d9593d747ae62d05c4812bd9971164ca00330b85f2a7c11653cc80cc4.sql.gz`: **2 707 122 bytes**, mode600, parent700; gzip проверен, SHA256 **c8bcc7ecd443435fcd51c38db98cd914418f759e0028c46aa53080b5bb4aa444**. Защищённый checksum sidecar записан и проверен.
- Уникальная rehearsal DB **ui093_restore_20261011_ace7b365_f84d197a** успешно восстановлена и удалена; production DB restore не выполнялся.
- Application rollback: `/var/backups/territory-crm/hookah-pos/ui093-dd467aeb-rollback`, mode700; прежние exact image/archive/env/config/state сохранены с проверенными checksum. Для отката пересоздаётся только CRM из сохранённого образа и обновляется nginx, PostgreSQL сохраняется. Не запускать deploy helper как rollback; DB restore требует отдельного recovery решения.

## Подтверждение production

- HTTPS с обычной проверкой сертификата, health PostgreSQL, anonymous session401 — PASS.
- **24/24 public frontend assets** byte-exact к финальным Git blobs; server.js отдельно проверен внутри контейнера и публично не выдаётся.
- API login/session/Secure cookie/role/platform reads/logout/expired session — PASS для существующего platform_owner.
- Начальные provisioning credentials owner/admin/staff вернули401 по одному разу. Пароли и пользователи не изменялись; повторных попыток не было. Эти credentials не доказывают состояние реальных рабочих учёток.
- Пользователь вошёл своим действующим аккаунтом владельца. В **Edge на production** подтверждены owner profile/overview, рабочий зал, чтение существующего заказа, каталог с «Кальян День Акция 1200 ₽» и возврат без добавления, finance и сформированный report/reconciliation. Console errors:0. Пользовательская сессия сохранена, вкладка возвращена на главную. Новые заказы/оплаты/складские движения/изменения сотрудников для smoke не создавались.
- Production admin/bartender login отдельными реальными аккаунтами не проверялся; их роль/API политика проверена на изолированном PostgreSQL. Полная Edge role×theme×state матрица, WCAG и motion certification не заявляются. Прежние scoped долги этапов и две native browser validation popup capture limitations UI012 остаются в исходных отчётах. Mobile/other sizes дальнейшие проверки пропущены по последней команде пользователя; Fold исключён.

Пакет выпуска завершён; дальнейших этапов в текущей очереди нет. Локальный QA runtime31978 и clone оставлены для воспроизведения, исходный PostgreSQL fixture не удалён. Release report/manifest локальные; итог выпуска также записан в GitHub PR22 без приватных скриншотов и credentials.
