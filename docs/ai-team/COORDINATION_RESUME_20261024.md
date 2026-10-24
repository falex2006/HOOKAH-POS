# Возобновление общей локальной приёмки — 24.10.2026

Исходная цель трёх потоков сохраняется. Отдельные опубликованные POS/UI исправления не подтверждают завершение зарплаты, лояльности или полного UI-аудита.

## Текущая база и владельцы

| Поток | Проверенное состояние | Следующий шаг |
| --- | --- | --- |
| MASTER | `f3020e1179355665c95d8a2af2042efc59565498`, исходники чистые; существующий `tmp/` сохранён | Интеграция только точных принятых пакетов, без массового переноса dirty-деревьев |
| ЗАРПЛАТНЫЙ | Новое дерево `payroll-current-integration/HOOKAH CRM 2` на `f3020e11`; read-only evidence audit завершён, runtime из старого дерева не перенесён | После снятия HOLD: зафиксировать candidate SHA/манифест, затем полный локальный payroll PG-run; отдельно остаются half-month, substitute calendar, dashboard и ₽/% reconciliation |
| Разобрать смысл пункта | Локально приняты test-only коммиты `44478ab8` и `584a66b3` поверх `f3020e11`; product UI/API/DB/dist не менялись | Role-shell, visual-live-defects и actual-source navigation contracts PASS; browser acceptance и широкая PostgreSQL-интеграция не подтверждены, поэтому это QA evidence, не runtime release |
| ЛОЯЛЬНОСТЬ | Изолированная копия на `f3020e11`; broad manifest `372` payload files, 18 modified tracked + 354 untracked, conflict markers `0`; реестр `14/47` | Modal visibility QA PASS и focused partial-payment resubmit QA PASS (Chromium; product source unchanged). Full POS/PG, V1/V2/API→DB→reload и migration/source/dist parity не доказаны; NO-GO для merge/release |

Старые исходники и dirty/untracked зарплатного дерева сохранены владельцем; путь сохранения `tmp/payroll-transfer-preservation-20261024-201109`. Это сохранение, а не принятый release manifest.

## ACL зарплаты

На текущем источнике подтверждены общий route `role=owner`, service `assertOwner`, дополнительный owner guard внутри calculation-entry lifecycle и owner guard attendance reader, вызываемого freshness. Правка только route/service была бы незаконченной.

Договорённая граница: конфигурация/activation/ретроактивные операции/correction остаются у фактического владельца; обычные сохранённые расчётные результаты и существующий lifecycle используют текущее effective `finance` только в пределах отдельно утверждённой чувствительной матрицы. `finance_read` не открывает зарплатные суммы автоматически. Рабочий draft `PAYROLL_OFFICIAL_CALCULATION_GATE.md` дополнительно удерживает точные ставки, расчётные детали и сравнения в owner-only до отдельного утверждения; это нужно согласовать с §1, прежде чем расширять доступ. Пять GET-readers сохранены как непринятый кандидат в `tmp/payroll-acl-held-20261024-205009`; дополнительные DB owner-барьеры (triggers/205/208/206/202) подтверждены. Существующий owner helper не ослабляется глобально. Канонический permission resolver можно передать в service одной factory-строкой `server.js`; роль, active/deleted, tenant, custom role и system ceiling перечитываются из БД. Точная передача доверенной авторизации в lower layers и проверка отзыва прав требуют архитектурной приёмки до реализации.

## Последовательность PostgreSQL

Live preflight не обнаружил соответствующего node runner или established-соединений к 31931; payroll подтвердил отсутствие своего процесса. UI назначен один локальный isolated run точного `fc82fa25` для `pos-role-payment-postgres-browser-qa.mjs`: отдельный disposable PostgreSQL на свободном loopback 55438, случайная owned DB и штатные safety guards. Нужны process/session handle, точное имя DB, SHA до/после, terminal result и cleanup/absence/lock proof. Failure не разрешает повтор автоматически. Payroll в это окно PG не запускает.

Первая UI-подготовка завершилась до suite из-за Windows ESM-path; disposable container/DB удалены и их отсутствие проверено. После исправления wrapper один запуск дошёл до штатного safety preflight и остановился до product scenario: сгенерированное имя `pos_audit_*` не удовлетворило требованию `test/QA/scratch` для `MIGRATIONS_PG_TEST_DATABASE_URL`. `result.json` сохранил `code:1`, `unchanged:true`, `containerAbsent:true`; повтор не запускается автоматически. Это не доказательство продуктового сбоя, но и не успешная PG-приёмка. На ветке UI оставлены только QA-документы/коррекция теста, продуктовый код не менялся.

## Границы продолжения

Только локальная работа. Новые GitHub/VPS действия и серверные тесты не выполняются. Зафиксирован внешний побочный инцидент UI-потока: после локального test-only аудита он успел сделать read-only fetch/HTTP checks и отправить ветку `codex/verified-ui-release-20261024` (коммиты `8a3ae947`, `9f0fcb60` поверх QA-коммитов); `main`, runtime-файлы и VPS не изменялись. Я остановил дальнейшие внешние действия; ветка не является разрешённым релизом и не включается в интеграцию без отдельного решения. Пользовательский запрос единого центра отчётов сохранён отдельно в `docs/requirements/UNIFIED_OPERATIONAL_REPORTS.md`; продуктовых правок по нему пока нет, он не подменяет исходный общий объём.

## Статус после возобновления цели

- **ЗАРПЛАТНЫЙ:** остаётся остановлен по неизменённому ACL/HOLD. Evidence-аудит завершён, нового принятого runtime-коммита нет; это не сбой процесса и не потеря изменений.
- **ЛОЯЛЬНОСТЬ:** после третьей повторной проверки без снятия ограничения доступная read-only подготовка исчерпана; поток ожидает согласования migration baseline и границы интеграции. Dirty-дерево не переносится.
- **Разобрать смысл пункта:** продолжает локальную классификацию 27 падений из 106 контрактов. До завершения классификации считать их дефектами продукта нельзя; внешние проверки и публикация запрещены.

Общий goal остаётся активным: независимый UI-аудит ещё может дать безопасный локальный результат, а payroll/loyalty требуют отдельного решения по своим блокировкам. Ни один из этих статусов не является основанием для GitHub/VPS-релиза.

Дополнительная локальная проверка loyalty lineage: после установки lockfile-зависимостей `pg` untracked-скрипт `flexible-loyalty-current-main-lineage-qa.mjs` остановился до проверки БД, потому что его импорт `scripts/payroll-migration-replay-compat.cjs` отсутствует во всех трёх локальных деревьях и в Git-истории. Это классифицировано как stale/неполный QA harness, а не как доказательство дефекта продукта; файл из другого worktree не подменялся.

Read-only сверка миграций относительно `HEAD=f3020e11`: все 162 tracked migration-файла имеют нулевой hash drift; loyalty-worktree содержит 50 дополнительных untracked migration-файлов (включая 145–186, 192–193 и 195–200). Поэтому базовая версия сохранна, но extra-пакет остаётся отдельным dirty-кандидатом и не может быть принят без отдельной проверки каталога, schema и replay.

Локально принят test-only пакет UI `c2b4d6a8` (`ui043`, `ui051`, `ui091`) и подтверждённый runtime-пакет `6ef89486` + `8fc8433b`: исправлен один устаревший CSS-токен, а cache revision `style.css` поднят `2026102403 -> 2026102404` во всех 41 канонических HTML-алиасах. Code-health дал GO; изменения ограничены CSS, синхронизатором и точными HTML revision-строками. После cherry-pick все 15 локальных UI-контрактов, source/dist parity, синтаксис и `git diff --check` прошли. Это локальная приёмка, не публикация.
