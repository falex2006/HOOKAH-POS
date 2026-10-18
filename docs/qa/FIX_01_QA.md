# FIX01: план регрессии эффективных прав

Статус: **PostgreSQL runtime PASS, 926 assertions, exit0**, после интеграции FIX01 и исправления personal null reset. Это результат API-матрицы, не заявление о готовности всех модулей/браузерных сценариев.

## Harness

Новый `scripts/effective-permissions-postgres-qa.cjs` будет самостоятельным владельцем случайной одноразовой БД `audit_qa_<16hex>` на существующем guarded31931. Перед созданием: штатные `validateConfig`/`validateContainer`, `validateQaDatabaseUrl`/`assertQaDatabaseIdentity`. Только точный контейнер postgres16-alpine с ownership label, auto-remove, анонимным томом и loopback31931. Schema и все миграции применяются в свежей БД. Реальный локальный сервер запускается со случайным портом, auth=true, очищенными унаследованными DB/credential env. Пять синтетических аккаунтов: owner/admin/manager/bartender/hookah_master. Секреты не выводятся.

Cleanup: остановить собственный дочерний сервер, закрыть подключения, повторно проверить container/SQL identity и удалить только БД, созданную данным запуском. Не удалять immutable строки по отдельности и не отключать продуктовые защиты. Shared persistent31930/31932 и existing scripts не изменяются.

## Матрица после получения контракта

1. Реальный login/session/owner-read profile: совпадающие эффективные наборы прав для пяти ролей.
2. System/custom/personal источники по утверждённому приоритету; clear/reset, отсутствующее значение, null и явно пустой список по контракту.
3. Тот же токен после предоставления и отзыва прав: session/profile и прямой API склада200/403; новый login подтверждает тот же итог.
4. Изменение назначенной custom роли, изменение системной роли, персональное перекрытие и возврат наследования.
5. Owner exception; non-owner не меняет права ролей.
6. Чужая/архивная custom role не назначается; после отказа исходное назначение и эффективные права сохраняются; чужой профиль не доступен.

Старый `tmp/audit-20261008/roles-reproduction.cjs` специально утверждал наличие багов и служит только исходным evidence. Новый тест будет проверять целевой контракт; его exit0 должен означать исправность, а не успешное воспроизведение дефектов. CUA/UI выполняется координатором отдельно.

## Реализованный целевой контракт

`node scripts/effective-permissions-postgres-qa.cjs`: protected owner; exact baseline всех пяти ролей (manager inventory_read без inventory); personal null/[] наследует baseline, непустой выбирается; active custom перекрывает personal, включая пустой deny; system-row ограничивает expanded permissions ceiling, при отсутствии выбранного custom/personal сам становится источником. Проверяются system[] deny и отсутствие row отдельно. `inventory_categories` ceiling с custom inventory даёт только inventory_read, POST inventory/items403. bar_tasks/hookah_tasks сохраняются только с orders; diagnostics только для base-роли с этим правом и настроенным settings. Login/session/profile сверяют permissions и policy(version/source/ceiling/blocked), включая вложенные поля user. Неизменный токен и повторный login покрыты. Platform/unknown-role и отказ загрузки DB-source требуют unit-проверок координатора; они не выдаются за покрытые пятью tenant-аккаунтами.

Дополнительно проверен active venue через изменение только synthetic fixture `auth_sessions.active_venue_id`: custom inventory домашней точки не переносится во вторую точку той же организации; её system orders применяется как источник, выдаёт floor/orders/bar_tasks, inventory403. Возврат active venue восстанавливает custom inventory. Это session/API-проверка, не UI переключателя.

## Выполненная регрессия

Команда: `node scripts/effective-permissions-postgres-qa.cjs`.

- Первая попытка: FAIL — PATCH personal permissionScopes:null возвращал400. Assertion сохранён; координатор исправил API на reset/inherit с хранением []. Это была выявленная несовместимость API с утверждённым контрактом.
- Повтор после изменения server: **PASS926**, все пять ролей, defaultmanager read-only, policy metadata всех ответов, custom/system/personal, наследование/deny, grant/revoke прежнего токена, повторный вход, owner exception, чужая/архивная роль.
- Источник прав недоступен: в своей БД таблица system_role_permission_overrides временно переименована. Session401, login503, profile401 (отказ авторизации до доступа к профилю); после восстановления таблицы прежний токен снова получает точные custom-права. Restore выполняется в finally.
- Каждая попытка удалила только созданную ею одноразовую БД, вывод `CLEANUP PASS owned disposable database removed`. Продукт/миграции/старые tests этим исполнителем не менялись.

Platform и unknownrole остаются областью unit-проверок координатора; browser обновление интерфейса — CUA-проверкой координатора. Наличие API PASS не подменяет эти границы.
