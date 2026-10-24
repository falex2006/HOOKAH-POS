# Возобновление общей локальной приёмки — 24.10.2026

Исходная цель трёх потоков сохраняется. Отдельные опубликованные POS/UI исправления не подтверждают завершение зарплаты, лояльности или полного UI-аудита.

## Текущая база и владельцы

| Поток | Проверенное состояние | Следующий шаг |
| --- | --- | --- |
| MASTER | `f3020e1179355665c95d8a2af2042efc59565498`, исходники чистые; существующий `tmp/` сохранён | Интеграция только точных принятых пакетов, без массового переноса dirty-деревьев |
| ЗАРПЛАТНЫЙ | Новое дерево `payroll-current-integration/HOOKAH CRM 2` на `f3020e11`; read-only evidence audit завершён, runtime из старого дерева не перенесён | После снятия HOLD: зафиксировать candidate SHA/манифест, затем полный локальный payroll PG-run; отдельно остаются half-month, substitute calendar, dashboard и ₽/% reconciliation |
| Разобрать смысл пункта | База `f3020e11`, локальный HEAD `649ac322`: только QA correction/docs, 3 tracked paths, без product UI/API/DB changes | Native `<details>` QA и code-health PASS; широкая PostgreSQL/browser интеграция не подтверждена: единственный прогон остановлен safety-preflight до product scenario |
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
