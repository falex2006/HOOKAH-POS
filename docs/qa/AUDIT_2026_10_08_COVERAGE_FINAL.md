# Итоговая матрица покрытия аудита 08.10.2026

Владелец проверки: code_health_engineer / QA. Это карта доказательств, а не обещание полного покрытия каждого сочетания данных. Прочитаны профиль роли, SITE_TREE и текущие baseline/roles/domain/browser/report. Продуктовый код этим агентом не изменялся. Браузерные наблюдения ниже взяты из отчёта координатора, не выполнены этим агентом.

## Основные модули

| Модуль / маршрут | Проверено сейчас | Дефект / остаточный пробел |
| --- | --- | --- |
| Вход, сессии, блокировка /login | Static/memory auth, security, PIN, session preference PASS; Edge вход 5 ролей | Полный logout/expiry/cross-device visual цикл отдельно; роль может расходиться с UI |
| Роли, персонал /admin#staff | PG scoped dependencies PASS; отдельные реальные ROLE проверки; staff VM suites PASS | ROLE-01…05; staff-identity функциональный PASS не считается suite PASS из-за cleanup |
| Рабочий зал / | Edge заказ + reload + управляющий, частичная200 и окончательная275 оплата475, освобождение стола; PG POS journey и гонка складского движения PASS | D01/D02 воспроизведены в Edge, добавлен D08 остатка долга; исправления ещё не приняты, см. BROWSER_FINAL |
| Заказы /orders | Static journal/totals/receipts/transaction PASS; PG journey PASS | Memory order-delete/paid-balance/recipe fixtures не доходят до целевых проверок |
| Гости /clients | Memory loyalty/ledger suites PASS; Edge управляющего PASS | ROLE-04 у операционных ролей; полный PG/Edge CRUD и все финансовые сценарии не закрыты этой матрицей |
| Бронирования /reservations | Form/legacy-warning PASS; PG continuation предоплат PASS; D06 воспроизведён фиксированным SQL выражением | Оригинальный prepayment suite FAIL: cleanup и 3 legacy assertions. Continuation исключает эти3 и не заменяет полный PASS; timezone HTTP в реальную полночь не проверен |
| Доставка /delivery | delivery-ui-state PASS | Текущая сохранность PostgreSQL и полный Edge путь не подтверждены; наличие persistence suite не означает выполненную проверку |
| Меню, рецепты /inventory products/recipes | Form/catalog contracts, PG journey, recipe/manual race и полный recipe-depletion372 PASS; Edge D01/D02 | Каталог200 показывает добавление275, неверное объяснение отказа техкарты; memory fixture всё ещё требует ремонта |
| Остатки, движения, заготовки /inventory | Ряд static/runtime contracts PASS; PG POS+stock; Edge управляющий read-only | Stock-status mock; scoped admin лишние кнопки ROLE-03; все документы производства/приёмки отдельно |
| Финансы /finance, categories/report | Finance VM/memory; PG372; refunds API-префикс; Edge платежи200+275 и возврат25 с reload/API | D08/D09 интерфейса; полный refunds browser suite/lost-response retry не выполнен; shift whitelist требует ремонта. См. FINANCE_FINAL/BROWSER_FINAL и REPORT |
| Зарплата /finance#payroll | Calculation/lifecycle/form contracts PASS | officialReady:false — не готовый официальный автоматический расчёт; внешние/производственные начисления не подтверждены |
| Задачи /admin#tasks | tasks memory и deadline/recovery contracts PASS | Полный текущий Edge цикл назначения другим сотрудником не выполнен в этой части аудита |
| Уведомления | UI/source permissions частично, notifications API до fixture | notifications memory блокируется несуществующим столом; внешняя отправка Telegram не подтверждена |
| Настройки, схема зала /admin | Site/header/sidebar/settings contracts частично PASS | Два navigation mocks/contracts FAIL; полный редактор схемы Edge не подтверждён |
| Сеть /network | Дополнительные 5 source/VM suites PASS, перечислены ниже | Это не реальные PostgreSQL транзакции и не browser switching across tenants |
| SaaS /platform | platform contract, SaaS quotas/suspension PG по отчёту координатора PASS | Реальные биллинг/платёжный провайдер не подтверждены; boundary self-test PASS |
| Интеграции /integrations | integrations scope/state contracts PASS | Telegram planned; фактическая доставка внешнему сервису не реализована/не подтверждена |
| Публикационная копия /dist | Ряд suites проверяет собственный source/dist parity | Cache revision 464/470 расходится; полный выпускной manifest не проверен, production не выпускался |

Fold/mobile отложены пользователем. Печать, физическое оборудование, внешние платежи и серверный деплой не входят в подтверждённые локальные результаты.

## Дополнительные проверки этого прохода

Каждая команда `node scripts/<suite>` завершилась exit0: `network-selection-qa.mjs`, `network-mutation-boundary-qa.mjs`, `network-read-failure-qa.mjs`, `network-tenant-contract.mjs`, `network-patch-validation-qa.mjs`, `saas-pos-boundary-contract.mjs`. Это чтение исходников / выполнение извлечённых handlers с mock repositories; живой сервер/DB/browser не используются. PG wrapper не занимался, конфликт с finance агентом исключён.

Эти 6 suites учитываются отдельно от первоначальных **155 static/memory: 146 PASS, 9 FAIL**. Baseline guards и отдельные PG suites также не прибавляются к 155. npm audit дал 0 известных vulnerabilities, без обновления зависимостей.

## Полный ремонт девяти FAIL: ограниченные задания

Вместо нынешнего FIX-05, охватывающего только 2 ошибки, выполнять QA-A…QA-E. Каждый пакет заканчивается отдельным PASS либо конкретным новым продуктовым finding. Нельзя менять бизнес-guards, чтобы сделать устаревший тест зелёным.

### QA-A — fixtures реальных столов: 4 FAIL

Модель для реализации: Luna; владелец QA, backend проверяет контракт. Файлы: notifications-api-qa.mjs, order-delete-qa.mjs, paid-order-balance-memory-qa.mjs, recipe-depletion-runtime-qa.mjs. Создать/выбрать реальные свободные столы через действующий floor API внутри собственного memory сервера. Исключить конфликты активных заказов между кейсами. Сохранить исходные проверки notifications/delete/payment/depletion; ошибки ответов показывать безопасным code без токенов. Критерий: все 4 suites доходят до целевых assertions и exit0; отрицательная проверка выдуманного/архивного стола продолжает получать отказ. Очистить только свои ресурсы.

### QA-B — DOM mocks: 2 FAIL

Модель Luna, владелец QA. inventory-stock-status-qa.mjs: добавить #stock-visible-count и проверить значение вместе с состояниями zero/min/enough. local-navigation-state-qa.mjs: mock кнопки должен предоставлять dataset/getAttribute, как реальный DOM; покрыть staffRoute и fallback. Не заменять исключения try/catch ради PASS. Оба suites exit0, контракт видимости/навигации сохранён.

### QA-C — lifecycle navigation: 1 FAIL

Модель Luna, system_architect сверяет контракт. visual-page-rules-contract.mjs ожидает конкретный scrollIntoView после handler, хотя используются общие route helpers. Сопоставить действующий lifecycle, обновить проверку на фактический helper/поведение title-content-scroll, отдельно сохранить reduced-motion и запрет лишней анимации. При обнаружении реального недостающего scroll оформить продуктовый дефект, не ослаблять assertion до наличия имени функции. Критерий: актуальный контракт и VM regression на переход/повтор/ошибку.

### QA-D — единая cache revision: 1 FAIL

Модель Luna, frontend + release, code_health review. local-design-contract.mjs корректно обнаружил portalRevision464 в sync-published-assets.mjs против470 в admin.html. Согласовать canonical revision с фактическим актуальным набором, синхронизировать только публикационные активы предусмотренным workflow. Проверить все published HTML и dist, отсутствие отката версии, diff. Не повышать/понижать номер вслепую и не отключать проверку.

### QA-E — whitelist текущей смены: 1 FAIL

Модель Astra для решения контракта, Luna для ясной тестовой реализации. role-api-matrix-runtime-qa.mjs ожидает отсутствие expectedCash/cashPreviewAt/unresolvedLegacyCash*. Документ от04.10 разрешает preview текущей смены для закрытия. Обновить точный whitelist по утверждённому контракту; проверить только текущую разрешённую точку, запрет истории/чужой точки/лишних reconciliation полей, отсутствие доступа роли без floor/orders. После исправления fixture прогнать весь тест до конца, чтобы не скрыть последующие FAIL. Не объявлять поля утечкой без контекста и не разрешать произвольные ключи DTO.

## QA-F — три cleanup ошибки PostgreSQL, отдельно от 9 baseline FAIL

Модель Astra для выбора безопасной очистки; владелец QA/backend. `staff-identity-postgres-qa` удаляет venues при оставшейся зависимости inventory_purchase_reversal_policies (точное FK в логе). `audit-privacy-postgres-qa` оборачивает cleanup в общий error и скрывает исходную причину: сохранить безопасный error.code/constraint и диагностировать порядок зависимостей. `reservation-prepayment-postgres-qa` удаляет order_items, которые защищены pricing snapshot trigger, и получает order_item_pricing_snapshot_locked; исходная функциональная ошибка могла быть замаскирована finally.

Предпочесть полное удаление только runner-owned одноразовой базы после закрытия соединений. Если нужен scoped cleanup — учитывать все зависимости, сохранять действующие production constraints и выполнять его только в подтверждённой тестовой БД. Нельзя глобально отключать триггеры вне owned disposable target. При ошибке функционального теста и cleanup сохранять обе причины. Приёмка: все 3 exit0 с functional PASS и cleanup PASS, повторный запуск без residue; искусственная ранняя ошибка также убирает собственную fixture и не маскируется finally. Историческая печать PASS до finally недостаточна.

## Общая приёмка ремонта QA

После QA-A…F запустить штатные static/memory полностью, выбранные PG через guard; отчёт должен содержать число реально исполненных suites и все остаточные FAIL. Полный `--all` сейчас содержит browser и мобильные сценарии — его не запускать автоматически в обход CUA и текущих границ. Исправления QA не являются доказательством исправления ROLE-01…05 или D01/D02/D06: они имеют отдельные продуктовые задачи и приёмку.

## Независимая финальная сверка

Сверены REPORT, ROLES_FINAL, FINANCE_FINAL, BROWSER_FINAL, STRUCTURE с исходными baseline и временными harness. Числа согласованы:155 baseline/146PASS/9FAIL;6 дополнительных source/VM отдельно;5 полных PG включают recipe-depletion372, а не плюс ещё одну suite. Continuation предоплат и refunds prefix корректно обозначены неполными исходными suites. Вывод ROLE-06 снят; поле expectedCash не объявляется доказанной утечкой. ROLE reproducer exit0 означает успешное воспроизведение, включая дефекты.

Обновление QA-F: FINANCE_FINAL уже диагностировал скрытый prepayment assertion после безопасной замены cleanup: fixture обнуляет aggregates, сохраняя canonical pricing facts. Нужно моделировать настоящий legacy заказ без canonical snapshot;3 исключённых assertions остаются открытыми. Независимый хвост continuation прошёл. Это дополняет, но не отменяет cleanup repair.

`tmp/audit-20261008/browser-fixtures.cjs` проверен чтением: фиксированный base127.0.0.1:31932, синтетический qaprimary, пароль читается из ignored runtime, token/password не выводятся; изменение цены имеет200→275 и restore200; payment-check проверяет409 и неизменность payments. Helper предназначен только для уже проверенного локального контура, сам не выполняет Docker/DB identity guard и выводит сырые данные synthetic product/orders: не переносить его на рабочие данные и не считать универсальным безопасным runner. В текущем заданном контуре блокирующей проблемы helper не найдено.

`git diff --check` снова exit0 (предупреждение лишь о LF/CRLF WORK_LOG); новые untracked документы проверены чтением. Диагностический аудит завершён при перечисленных ограничениях покрытия. Это не приёмка всех состояний CRM и не разрешение выпуска; P1 ролей и первый рабочий пакет требуют исправлений/приёмки.
