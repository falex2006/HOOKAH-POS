# Релизный пакет FIX-01…06 — локальный кандидат

Дата: 08.10.2026. Публикация не выполнялась. Основной checkout и его индекс сохранены.

## Состав

База: `802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf` (проверенный origin/main на этапе подготовки). Изолированная локальная копия: `tmp/release-fix01-06`, ветка `codex/release-fix01-06`, без новых коммитов. Её origin — локальный исходный репозиторий; не использовать его для push на GitHub.

160 выбранных файлов наложения на базу:155 POS-кандидатов исходной описи,3 обновления ссылки общей CSS в platform HTML,1 контракт границ и1 документ границ. Полный архив содержит954 файла. Точный список и SHA256 каждого файла: `FIX_01_06_PACKAGE_MANIFEST.json` рядом с этим отчётом. Исходная RELEASE_2026_10_08_FILES.json — историческая опись кандидатов, не окончательный manifest.

- FIX-01/02: resolver прав, серверная сессия, portal-session, карточка персонала и единое применение разрешений.
- FIX-03: исполнение направлений, актуализация каталога, миграция099 и schema mirror.
- FIX-04: ошибки техкарт/остатков, суммы оплаты, история возвратов, календарная дата бронирований.
- FIX-05: исправления финансовых снимков/legacy/уведомлений и QA.
- FIX-06: отчёты приёмки и доказательства в документации; временная QA БД и screenshots в архив не входят.
- Runtime dependencies: effective-permissions.js, order-preparation.js, reservation-calendar.js, portal-session.js и опубликованная копия; Dockerfile включает серверные модули.

Исключены8 файлов AlphaSat: migration098,6 adapter scripts,deploy helper. Их функциональность не подключена текущим server/db/API. Исключены tmp, .git, node_modules, runtime/seed config, секреты, локальные БД. Рабочие исходники исключённых изменений сохранены.

## Узкое изменение проверки CI

Архитектор рекомендовал включить3 platform HTML, меняющих только `/style.css?rev=403` на405. Их исключение нарушало обязательный design contract общей CSS. Boundary теперь допускает только эти3 точных пути и только числовую ревизию общей CSS; CRLF/LF нормализуется как Git-текст. Изменения разметки, других URL, query suffix и иных SaaS файлов по-прежнему запрещены. Сам файл проверки относится к shared governance. Существующий platform contract проверяет равенство source/dist/alias. Правила не отключены.

## Проверки именно изолированного состава

| Проверка | Результат |
|---|---|
| Static, включая guards |138/138 PASS|
| Memory, включая guards |23/23 PASS|
| SaaS/POS working-tree boundary |PASS,3 cache-only;29 POS content|
| Platform source/dist contract |PASS|
| Deployment contract |PASS|
| PostgreSQL schema + migrations без098, migrations runtime |PASS|
| Guarded paid-order-balance PostgreSQL |PASS; удаление своей одноразовой БД подтверждено|
| Boundary self-tests + независимые32 negative cases |PASS|
| Syntax boundary, scoped git diff --check |PASS|
| Scoped secret/artifact review954 файлов |Проверенные QA секреты/private key markers/опасные имена не найдены; не полная security-сертификация|
| Распаковка архива и сверка954 SHA256 |PASS|

Static/memory JSON: RELEASE_2026_10_08_PACKAGE_STATIC.json и RELEASE_2026_10_08_PACKAGE_MEMORY.json. Полный static проход был до последней узкой правки boundary; сам изменённый boundary проверен отдельно после неё. Full remote CI не запускался. Предыдущие browser/PG результаты FIX-06 относятся к функционально идентичному POS-коду рабочего checkout; повторной полной браузерной приёмки архива не заявляется. Fold/mobile по указанию пользователя отложены.

## Артефакт

`tmp/FIX-01-06-candidate.tar.gz`

SHA256: `4f3d96e03c73a82614d317e7605c477642f92f38d79b6b1db5ad0111a58288b7`.

Это проверяемый **незакоммиченный кандидат**, не production-архив опубликованного commit. Содержимое сверено с manifest после распаковки в tmp/release-archive-verify. Изолированная папка содержит отдельно игнорируемый runtime для локальных PG checks и junction node_modules; они отсутствуют в архиве. Не архивировать эту папку целиком и не использовать git add . в основном дереве.

## Перед публикацией

1. Зафиксировать этот точный набор в отдельной Git-ветке, прогнать boundary по реальному base…head, создать PR и дождаться CI. GitHub remote: falex2006/HOOKAH-POS; team.json со старым именем HOOKAH-CRM не является назначением push.
2. После принятого commit SHA заново создать архив из commit и проверить соответствие SHA/состава. Текущий candidate не выдавать за такой архив.
3. На сервере подтвердить цель, текущую версию, HTTPS/auth и путь приложения, сделать backup с проверкой восстановления. Боевые секреты остаются на сервере.
4. Применить099 согласно MIGRATIONS.md и совместимый API/UI через deploy-vps.sh из чистого checkout. Не делать DROP для отката: это уничтожит факты исполнения.
5. Проверить health, вход/выход, права, заказ→приготовление→оплата→склад и историю. Если регрессия — остановить затронутый сценарий и применить согласованный план восстановления с сохранением данных.

Подготовка состава завершена; коммит, PR, push, миграции рабочей БД и production deploy в этой задаче не выполнялись.

## 2026-10-08 — коммит, PR и CI FIX-01…06

По отдельному разрешению пользователя создан и отправлен коммит ce4684e4fafbe358e4f589b71cd9aceb4f60a05d, ветка codex/release-fix01-06.
PR: https://github.com/falex2006/HOOKAH-POS/pull/5

- GitHub CRM contracts (run 37827169706): success.
- GitHub AI team contracts (run 37827169698): success.
- Реальный base…head boundary и финальный diff --check: PASS. Независимый code-health review состава: PASS.
- Перед коммитом удалены только хвостовые пробелы/пустые EOF в четырёх QA документах; исторический candidate manifest сохранён отдельно.
- Итоговый архив: tmp/FIX-01-06-ce4684e4.tar.gz. Создан git archive с core.autocrlf=false для точных байтов Git и Linux.
- SHA256 архива: b1a69fcdfc9f58dd66246ee3b11822aa7bb9b281270283333bde22fc3b071661.
- Все 954 файла архива побайтово сверены через Git blob hashes с деревом commit: PASS. Итоговый manifest: docs/release/FIX_01_06_COMMIT_MANIFEST.json.
- Merge, серверные миграции и deployment не выполнялись. Следующий этап: согласованный merge и подготовка серверного выпуска по DEVELOPMENT_WORKFLOW.md. Основной рабочий checkout и его индекс сохранены.
