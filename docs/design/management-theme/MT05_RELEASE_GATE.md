# MT-05: gate защищённого выпуска

Дата: 2026-10-11. Read-only release/source review; публикация и серверные изменения этим документом не выполняются. Desktop входит в согласованную приёмку, mobile/Fold исключены пользователем.

## Кандидат и доказательства

- Локальный кандидат: `9d47e938ccb75ef39b8e8eb0586f881a05131301`; текущая ветка worktree — `codex/management-theme-plan`, не canonical main. Документ добавляется после этого SHA и войдёт в окончательный проверенный пакет.
- По свежему fetch предыдущего исследования main является предком кандидата; перед PR/выпуском повторить fetch и проверку ancestry.
- Координатор подтвердил read-only VPS checkout `/root/hookah-pos-release-b4984208`, clean, HEAD `b4984208`. В этом исследовании архитектор самостоятельно SSH не повторял. Используется существующий SSH alias `hookah-crm-vps`.
- Source integration включает отдельные theme assets в Dockerfile и server static allowlist. Product/API права, payload и миграции темой не расширяются. Бизнес-данные и конфигурация заведения не используются как тестовые fixtures.

## Gates, ожидающие закрытия

1. Итоговая MT-05 desktop приёмка кандидата: роли/вход/выход, разрешённые страницы, темы, shared/legacy окна, pending/unknown, focus/return и отрицательные staff/floor/lock контроли; две исправленные пользовательские претензии и возврат исходной шапки. Результаты фиксирует coordinator/QA.
2. Code-health итогового diff, syntax/diff checks, source/dist и aliases одного release revision, рабочий журнал. tmp и секреты исключаются выборочным stage.
3. PR к canonical main и зелёные `CRM contracts`/`AI team contracts` для конечного SHA. После merge зафиксировать именно опубликованный main SHA, не прежний feature SHA.
4. Непосредственно перед выпуском подтвердить active checkout/container labels, Compose project, PostgreSQL volume, env checksum и исходные data fingerprints. Не выводить env/ключи/credentials.
5. Зафиксировать разрешение и готовность guarded deploy, recovery image и backup; после выпуска закрыть отдельный production receipt. Локальный PASS не подтверждает VPS.

## Минимальный путь подготовки

Из этого worktree выполнить штатный sync и проверки до окончательной фиксации:

```powershell
node scripts/sync-published-assets.mjs
node --check app.js
node --check portal.js
node --check portal-session.js
node --check ui-dialog.js
node --check management-theme.js
node --check notification-center.js
git diff --check
```

Релевантные контракты выбираются по изменённым сценариям. Действующие CI уже включают `ai-team-contract`, SaaS/POS boundary, platform, design, clickability, static/deploy, role/insights/date/login, shell syntax и dependency/package checks. Две последних пользовательские правки требуют своих зафиксированных проверок; native browser UI не объявляется перенесённым темой.

После PR/CI/merge: получить точный SHA опубликованного main и сформировать проверяемый Git bundle `refs/remotes/origin/main`. Перед передачей выполнить `git bundle verify`, сохранить SHA файла. Bundle и server-only окружение не входят в application commit. На VPS использовать новый каталог `/root/hookah-pos-release-<первые12символов-publishedSHA>`; существующий clean checkout сохранить целиком.

Пример последовательности после подтверждения точного SHA и передачи bundle, не команда для немедленного запуска:

```bash
set -euo pipefail
umask 077
published_sha='<полный-проверенный-main-SHA>'
previous_checkout='/root/hookah-pos-release-b4984208'
release_checkout="/root/hookah-pos-release-${published_sha:0:12}"
test ! -e "$release_checkout"
git init "$release_checkout"
git -C "$release_checkout" fetch /tmp/mt05-release.bundle refs/remotes/origin/main:refs/heads/main
git -C "$release_checkout" checkout main
test "$(git -C "$release_checkout" rev-parse HEAD)" = "$published_sha"
install -m 600 "$previous_checkout/.env" "$release_checkout/.env"
cd "$release_checkout"
test -z "$(git status --porcelain --untracked-files=all)"
```

Проверять backup/recovery snapshot перед запуском; копирование env не означает разрешение менять конфигурацию. Existing Compose project и actual PostgreSQL volume должны совпасть с рабочими контейнерами; defaults файла не доказывают текущие значения. Ожидаемый опубликованный volume из release receipt — `territory-crm_pgdata`, но непосредственная проверка обязательна. Не создавать новый volume и не менять project name из-за нового каталога. Проверка `docker compose config --quiet` безопасна; полный config может раскрыть секреты, его не выводить.

## Guarded deploy и post-deploy

Из проверенного нового clean main checkout:

```bash
SKIP_MENU_SEED_ONCE=true ./deploy-vps.sh
```

Если существующая подтверждённая конфигурация использует HTTP/COOKIE_SECURE=false, script требует разовый `ALLOW_HTTP_DEPLOY_ONCE=true`; его добавляет координатор только в согласованном существующем режиме. Не менять env ради прохождения guard.

Текущий deploy-vps.sh проверяет clean/main, auth/env и Compose config, блокирует параллельные deploy, вычисляет release fingerprint, build CRM, останавливает запись, делает финальный backup и `verify-backup.sh` с restoration rehearsal, запускает migrations с `SKIP_MENU_SEED_ONCE=true`, запускает сервисы и проверяет health/release label. При ошибке не выполнять reset/seed/restore production БД. Старый checkout/image сохраняются для управляемого recovery; наличие backup не означает разрешение восстанавливать его поверх текущих данных.

После запуска: exact HEAD/release label/image, database=postgres health, env checksum и прежний volume; data fingerprints/counts до/после; публичные assets соответствуют выбранному commit; read-only desktop вход/session/выход и управленческая навигация. Production заказов, оплат, возвратов, клиентов и taxonomy fixtures не создавать.

`./post-deploy-acceptance.sh` запускается с BASE_URL/CRM_USERNAME/CRM_PASSWORD из защищённого окружения без записи/вывода credentials. Он проверяет health/login/session и `/admin /orders /inventory /finance`. Existing intentional HTTP требует `ALLOW_HTTP=1`; расширенные theme/focus проверки фиксируются отдельно. Gate остаётся **pending** до PR/CI, конечной приёмки и подтверждённого production receipt.
