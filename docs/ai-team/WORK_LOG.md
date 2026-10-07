## 2026-10-05 — Tobacco catalog authenticated API boundaries

- Добавлен отдельный authenticated PostgreSQL QA сценарий каталога табака: owner, manager с `inventory`, manager с `inventory_read`, bartender, второе заведение той же организации и другой tenant. Проверяются shared/venue visibility, GET/list, create/PATCH, read-only и network-owner запреты, canonical foreign-tenant 404 и фактические строки PostgreSQL после запросов.
- PASS: `node scripts/local-full-pg-regression.cjs tobacco-catalog-auth-boundaries-postgres-qa.mjs` — 38 assertions; `node --check` QA/runner; `node scripts/local-full-pg-regression.cjs --check-guards` — 42 cases. Независимый code-health review не нашёл блокеров. Проверка `pg_database` подтвердила 0 оставшихся `tobacco_auth_qa_*` баз, runner lock отсутствует.
- Обновлены новая QA suite, её узкая регистрация в runner и acceptance #49. Продуктовые API/миграции не менялись; SaaS, persistent QA DB, production/VPS, commit и публикация не затрагивались. Универсальная динамическая схема атрибутов табака остаётся без утверждённых продуктовых правил.

## 2026-10-05 — #22 точность и полный readback приходного документа

- Устранено денежное расхождение: `db.js` теперь вычисляет складское количество и нормализованную цену по сохранённым масштабам BigInt, а цену строки округляет HALF_UP до копейки. Значения quantity точнее 6 и unitCost точнее 4 знаков отклоняются до записи; исходные суммы из binary float больше не проходят мимо точности `numeric` в PostgreSQL.
- Добавлен authenticated `acceptance-22-purchase-fields-postgres-qa.mjs`: 130 checks для всех 8 складских единиц, нулевой/дробной цены, половины копейки, header/line snapshots, свежего detail/list readback, PostgreSQL значений и отсутствия движения/изменения valuation/payables у draft. `purchase-documents-contract.mjs`, `migrations-contract.mjs`, синтаксические проверки и #22 PostgreSQL suite — PASS.
- Тест обнаружил routing gap штатного runner у соседнего `purchase-payment-postgres-api-qa.mjs`: по умолчанию он брал `hookah_local_qa`. Исправлено назначение случайной disposable `orders_qa_*` базы; fixture теста дополнен synthetic organization/subscription для migration 094. Повторный purchase-payment suite — PASS, новая БД удалена и проверкой `pg_database` подтверждено отсутствие runner-owned `orders_qa_*`; runner lock отсутствует.
- Первый незащищённый запуск старого payment runner оставил только синтетическую organization и её subscription в `hookah_local_qa`, потому что fixture аварийно завершился до создания venue/document. Они сверены по точному UUID/slug и удалены транзакционно; venue/user/member/dependent rows отсутствовали. Сток, документы, платежи, production и VPS не затронуты.

## 2026-10-05 — #30 проверка поля даты прихода в UI

- В существующей форме прихода выполнена read-only authenticated browser проверка на 320×568, 390×844, 717×1024, 768×1024 и 1440×900. Optional native `type=date` видимо и без горизонтального overflow; высота 44 px, подпись/подсказка читаются, Tab доводит фокус, focus ring виден. Пустое значение проходит, корректная дата принимается; native picker открылся, его элементы доступны в AX tree.
- Без создания документа проверены браузерная блокировка формы с пропущенными обязательными полями и настоящий client-side обработчик ошибки «Укажите поставщика» с фокусом на поле. Последующий authenticated memory-only browser прогон использовал видимое действие из header; маршрут POST был перехвачен до backend, поэтому запись документа не создавалась. В pending UI все native controls, custom-select trigger и option buttons отключены, открытое меню закрыто; повторная отправка, click по другому значению и keyboard navigation не меняют выбранное значение и не создают второй запрос. Смоделированный HTTP 500 показывает ошибку, восстанавливает доступность полей/списка и сохраняет значения; JS/page errors отсутствуют.
- Найденный pre-existing дефект исправлен в `portal.js`: пока исходный select disabled, все custom options disabled и исключены из Tab-порядка, menu закрывается, click и keyboard handlers не меняют значение. 
ode --check portal.js`, 
ode --check scripts/custom-select-groups-qa.mjs`, 
ode scripts/custom-select-groups-qa.mjs`, 
ode scripts/purchase-document-pending-qa.mjs`, browser test `tmp/purchase-date-pending-20261005-1045/ui-check.cjs` — PASS. Старый тест выбирал скрытый legacy `#open-movement`; это была ошибка селектора QA harness, а не отказ в правах.
- После проверки выявлено, что deploy-копия `dist/portal.js` отставала только на этом custom-select helper. Синхронизирована только эта копия из источника; `portal.js` и `dist/portal.js` побайтно совпадают (SHA256 `C17EDE6D42B7F99417C9C090E7BFF3473250B0D8969DFB7DF75F1DAE54E76ED0`), syntax обоих файлов и scoped `git diff --check` PASS. Общий asset sync и публикация не запускались.
- Снимки: `tmp/purchase-date30-20261005093617/screens/` (15 файлов) и `tmp/purchase-date-pending-20261005-1045/screens/` (pending/error). Отдельный memory server остановлен и health probe не отвечает; PostgreSQL runner/база не использовались. Матрица #30 обновлена; статус остаётся Partial: popup не попал в screenshot, а ошибка сервера была route-intercept mock, не реальным API ответом.

## 2026-10-05 — #48 browser role/tenant границы прихода

- В существующий `inventory-receiving-mobile-postgres-browser-qa.mjs` добавлены только browser checks. Менеджер с `inventory_read` входит обычной формой, читает журнал, но UI не показывает действие создания, форму, редактирование и отмену; отображается штатная подсказка об отсутствии прав управления складом. Owner другого tenant проходит обычный вход, после reload видит свой синтетический draft и не видит документ текущего tenant.
- PASS: 
ode scripts/local-full-pg-regression.cjs inventory-receiving-mobile-postgres-browser-qa.mjs` — 172 checks на 320/390/717/768 px. Одноразовая `inventory_qa_2c959a54c9917674` независимо подтверждена отсутствующей; runner lock отсутствует, тестовые процессы и слушатели закрыты. `--check-guards` — 42 cases PASS, 
ode --check` и scoped `git diff --check` PASS; review QA/code-health PASS.
- Сохранённые до теста пять эмуляторных PNG восстановлены и SHA256 совпал с backup manifest; прочие suite/artifact области не изменялись. Product code, матрица/runner registration, SaaS, VPS, production, persistent QA DB, commit и publish не затронуты. #48 остаётся partial по другим складским маршрутам, расширенным API error branches и физическому Fold; существующее 320 px visual issue остаётся отдельным визуальным gap.

## 2026-10-05 — #48 отказ от подтверждения отмены черновика прихода

- Существующий authenticated mobile browser/API/PostgreSQL suite дополнен сценарием, где пользователь отклоняет штатный `window.confirm` при отмене draft. Проверено отсутствие void-запроса, сохранение `draft` в API/PG, доступность действия в UI и неизменность остатка/движений.
- PASS: 
ode scripts/local-full-pg-regression.cjs inventory-receiving-mobile-postgres-browser-qa.mjs` — 163 checks; runner удалил случайную disposable БД, отдельная read-only проверка подтвердила её отсутствие. Runner lock и процессы завершены; контейнер остался runner-owned auto-remove с loopback binding. 
ode --check`, `--check-guards` (42 cases) и scoped `git diff --check` — PASS; независимая code-health проверка замечаний не нашла.
- Обновлены только QA script и строки #48/#49 матрицы; продуктовый код, общий runner, persistent QA DB, production/VPS и публикация не затрагивались. #48 остаётся частичным по UI role flows, другим складским маршрутам и error branches, мобильному перекрытию на 320 px и физическому Fold. #27 по-прежнему требует продуктовых решений для сторно проведённого прихода.

## 2026-10-04 — #21 закрытие ложных финансовых нулей без payroll ledger

- Аудит подтвердил, что действующее `FINANCE_MODEL.md` rule 6 требует признавать approved/paid зарплату по дням периода, а связанный расход добавлять только в фактический cashflow. PostgreSQL реализация не менялась. В demo/memory нет авторитетного payroll registry/lifecycle; выдавать ноль или считать expense на дату оплаты прибылью было недостоверно.
- В memory и demo полнота payroll, expenses, netProfit и cashflow теперь представляется явным 
ull` с `payrollCoverage: {status:'unsupported', reason:'payroll_requires_database'}` и `officialReady:false`. Отдельные observed operating expenses, revenue и COGS остаются доступны; dashboard, finance cards и график показывают ограничение вместо ложного нуля. Demo `/api/payroll/entries` fail-closed с finance permission guard. Полный ledger/accrual parity не реализованы и требуют отдельного lifecycle контракта.
- PASS: `scripts/payroll-analytics-unavailable-qa.mjs` прошёл фактические ephemeral memory API и demo/DOM сценарии, включая недоступные значения, известные revenue/COGS/operating-expenses controls, права, reload, manual expense и отказ forged payroll; 
ode --check` source/dist/test, source/dist byte parity, related expense status contracts, scoped `git diff --check`; независимый final code-health review без замечаний. Складской recipe runtime suite останавливался ранее в baseline на неизвестном table fixture; исходная версия сервера воспроизвела тот же `table_not_found_or_unavailable`, это не регрессия этой правки.
- Ограничения: acceptance #21 остаётся частичным, потому что demo/memory не имеют payroll ledger и полного lifecycle; независимая сверка demo venue/date scope по FINANCE_MODEL rule 8 остаётся отдельной задачей. `officialReady` не включён; PostgreSQL, SaaS, production, persistent QA DB и публикация не затронуты.

## 2026-10-04 — #48 browser/PG редактирование черновика прихода

- Dedicated mobile suite расширен сквозным edit-readback сценарием: сохранить черновик, открыть редактирование, заменить поставщика/количество/цену, отправить PATCH, перезагрузить маршрут и повторно открыть черновик на 390×844. API/одноразовая PostgreSQL подтвердили изменённые поля, статус `draft`, количество 200 г и сумму 270 ₽; складской остаток остался 0, движения не создавались.
- PASS: isolated regression runner — 87 проверок на 320, 390, 717 и 768 px; временная БД удалена, runner lock освобождён. Итоговый скриншот 320×568 сохранён как `inventory-receiving-320-scrolled.png`. Code-health и QA владельца — PASS; продуктовые файлы, общий runner, demo PIN и persistent QA данные не менялись. Общий orchestrator обновил acceptance #48 в матрице.
- Остаток #48 после отдельного API boundary acceptance: прочие складские маршруты/состояния, UI role flows, дополнительные API error branches, отказ в draft-cancel confirmation и физический Fold пока не подтверждены; сторно проведённого прихода относится к продуктово заблокированному #27.

## 2026-10-04 — #27/#48 browser отмена только черновика прихода

- В существующий mobile browser/PG suite добавлен authenticated UI cancel отдельного draft прихода: штатное подтверждение → `POST .../void` → readback статуса `voided` из UI/API/PG, reload и проверка, что actions больше нет. Остаток и движения остались неизменными; изменения только для черновика.
- PASS: final isolated browser/PG runner — 117 assertions на ширинах 320/390/717/768 px; code-health и QA владельца — PASS. Disposable база удалена, runner lock и процессы очищены; продуктовый код, общий runner, persistent QA/demo данные не менялись.
- Acceptance #27 остаётся частичным: сторно проведённого прихода не реализовано до решения правил по использованным остаткам, оплате/credit/refund, оценке/variance, датам/закрытым периодам и версиям policy. Acceptance #48 остаётся частичным по другим складским маршрутам, UI role flows, дополнительным API error branches, отказу в confirmation и аппаратному Fold.

## 2026-10-04 — #48 API role/tenant границы черновика прихода

- API contract audit подтвердил, что PATCH draft ранее возвращал 409 и внутреннюю ошибку `purchase_document_not_found` для отсутствующего ID, тогда как GET/void используют 404. Исправлено узко: отсутствующий/чужой документ возвращает 404 `purchase_document_not_found`, существующий документ не-draft остаётся 409 `purchase_document_not_draft`.
- Browser/API/PG acceptance дополнен проверками: `inventory_read` может читать список/деталь без write; пользователь без inventory scope не читает склад; чужая организация не видит документ в списке и получает 404 для GET/PATCH/void; same-tenant missing PATCH даёт canonical 404; после чужих запросов синтетический draft остаётся draft в PG. Итоговый сценарий — 153 assertions на 320/390/717/768 px.
- PASS: отдельный `inventory-receiving-mobile-postgres-browser-qa.mjs` прошёл через owned disposable runner; runner удалил случайную БД, lock отсутствует. 
ode --check` server/test, `scripts/purchase-documents-contract.mjs`, runner `--check-guards` (42 cases), scoped `git diff --check`; независимый code-health и архитектурный review — PASS. Полные UI role flows, дополнительные error branches, прочие складские маршруты, отказ в confirmation и физический Fold остаются непроверенными. Изменение продуктового кода ограничено HTTP статусами и canonical error-кодами PATCH.
- Handoff #33 расширен и повторно проверен: authenticated browser/API/PG suite проверяет mixed dates + NULL, `DESC NULLS LAST`, независимый `recordedAt`, inclusive date/status filters, NULL toggle, invalid filter rejection, reload/reset, mobile widths и stale-response ordering (95 assertions). Runner-owned disposable DB cleanup PASS. UI filter semantics проверены по существующему контракту; product UI/API semantics и runtime не менялись.

## 2026-10-04 — исправление статуса смены в общем интерфейсе склада

- Причина ложного предупреждения «Статус смены недоступен»: клиентский `refreshPortalShiftState()` передавал в `fetch` объект `signal: {}`, который не является `AbortSignal` и отклонял запрос до HTTP. Удалён неиспользуемый параметр; маршрут `/api/shifts`, его tenant/role guards и состояния ответа не менялись.
- Обновлены `portal.js`, опубликованная копия `dist/portal.js` и существующий `scripts/shift-state-runtime-qa.mjs`: контракт теперь запрещает фиктивный signal и проверяет штатные открытое/закрытое состояния, ошибки, дедупликацию и guards. Source/dist совпадают.
- PASS: 
ode --check` трёх изменённых JS-файлов; 
ode scripts/shift-state-runtime-qa.mjs`; 
ode scripts/header-shell-contract.mjs`; 
ode scripts/sidebar-navigation-contract.mjs`; `git diff --check` по затронутым файлам. UI-скриншот #44 ранее подтверждал ложную ошибку на странице ремиксов при успешно открытой смене в POS.
- Границы: локальная правка без API/БД/миграций и без production/SaaS. Browser E2E после фикса отдельно не запускался; проверено контрактом состояния и существующей runtime-симуляцией.

## 2026-10-04 — единый API/PG acceptance #44 для склада

- Сквозной сценарий проверяет создание/переименование/архивацию категории и повторное чтение, связанный ингредиент, приход пачки 100 г, техкарту, закрытую продажу, движение расхода ровно 18 г, остаток 82 г и снимок COGS 21,60 ₽. Проверены RBAC сотрудника кальянного цеха и изоляция второго tenant для категории, ингредиента, прихода, техкарты и заказа.
- Добавлен `scripts/inventory-crossflow-postgres-e2e-qa.mjs`; теперь его дополняет `scripts/acceptance-44-inventory-crossflow-postgres-browser-qa.mjs`: UI создаёт категорию, два ингредиента, draft/post приход по 100 г, два tracked товара и две техкарты-ремикса, затем продаёт первый товар через POS. Оба сценария зарегистрированы в disposable runner; продуктовые маршруты, схема/миграции, UI и `dist` не менялись.
- PASS: API/PG crossflow и 
pm run qa:inventory` прошли ранее; браузерный сценарий прошёл с 84 assertions, включая вход по паролю, readback категории/товаров/техкарт, источник приходных движений, закрытый заказ именно с первым ремиксом, оплату 500 ₽, единственное списание 18 г, остатки 82/100 г и COGS 21,60 ₽. Runner подтвердил удаление disposable `inventory_qa_<random>`; persistent QA база и demo PIN не использовались.
- Также PASS: 
ode --check` для browser QA и обоих runner-файлов; regression runner guards (42 cases); scoped `git diff --check`. Скриншоты локального эмулятора: `tmp/full-local-qa/acceptance-44-pos-order.png` и `tmp/full-local-qa/acceptance-44-inventory-crossflow.png`. Финальные read-only code-health, architecture и QA reviews — PASS.
- Финальная сверка #44: browser runner — PASS (84 assertions), API/PG crossflow — PASS (62 checks); disposable `inventory_qa_<random>` базы удалены, runner lock отсутствует. Ранний browser timeout ожидания `#purchase-document-form` после перехода к `inventory?view=movements` устранён синхронизацией теста с завершившейся UI-навигацией/отрисовкой формы; отдельный UI refresh/readback ингредиентов подтверждает fixture до продолжения. Проверена одна закрытая продажа: 18 г расхода, 82/100 г остатка, COGS 21,60 ₽. Лимит: синтетический owner и одна точка/смена, два ингредиента и два ремикса, один наличный заказ; persistent QA/demo данные и production не менялись.

- Локально закрыт security/acceptance-gap trusted PIN-return: обычная owner/admin/developer сессия без `trustDevice` больше не показывает PIN-card на `/login` и получает `403 pin_return_requires_trusted_device` на `/api/session/pin-return` даже с верным PIN. Доверенность сессии выводится сервером из `created_at/expires_at` PostgreSQL-сессии или memory-флага, `/api/session` отдаёт только `trustedDevice` без bearer token. Добавлен runtime negative case для обычного admin-login и расширен статический контракт.

## 2026-10-04 — bounded проверка PIN/lock trusted-return

- Локально закрыт acceptance-gap в контракте блокировки: `scripts/local-lock-contract.mjs` теперь явно проверяет, что `lock.js` не сохраняет bearer token из ответа `/api/session`, а capture handler владеет кликами ручной блокировки и настроек через `preventDefault`/`stopPropagation`. Продуктовая логика, БД, schema, dist и production не менялись.
- Dirty baseline до работы уже содержал много unrelated изменений в payroll/finance/dist/docs/server/db/UI; в этом bounded шаге изменён только локальный contract script.
- PASS: 
ode scripts/local-lock-contract.mjs`; 
pm run qa:trusted-pin`; 
ode scripts/login-error-runtime-qa.mjs`; 
ode scripts/staff-pin-passport-runtime-qa.mjs`; 
ode scripts/session-authority-qa.mjs`; 
ode --check` для lock/login/server/db и PIN QA scripts; scoped `git diff --check` по PIN/lock/login/session файлам. Остались только штатные предупреждения Git о будущей LF→CRLF нормализации для уже изменённых файлов.
- Отдельный code-health subagent в этом runtime недоступен как tool; coordinator выполнил scoped baseline/final diff review по профилю `code_health_engineer` самостоятельно.

## 2026-10-04 — handoff возвратов POS 092 и следующий межмодульный этап

- POS-owned migration 092 завершена и принята после архитектурного, финансового и code-health review. Per-source `producer_sequence` назначается под блокировкой баланса; события сохраняют immutable previous/cumulative quantity и item value. Старые 091 события остаются без sequence, никакой порядок из `created_at`/UUID не выводится. PostgreSQL/Chromium QA и контрактные проверки прошли. Первичный POS suite не накатывал 092 поверх заполненной legacy 091 базы, но payroll sequence PG suite позднее воспроизвёл 090/091 с существующим событием, применил 092 и проверил неизменность legacy-фактов — первоначальный migration-upgrade пробел закрыт.
- Точный SQL/API контракт передан в `ЗАРПЛАТНЫЙ`; чат подтвердил получение и теперь выполняет payroll-owned read-only адаптер с проверкой последовательности и fail-closed readiness. POS, Finance, Loyalty producer, общие `server.js`/schema/API и миграции для этого этапа не меняются; `officialReady:false` сохраняется.
- Лояльность закрыла 14 этапов своей roadmap и L14 межмодульную сверку. Её чат не принял переданное задание по 092, считая, что ему нужен запрос пользователя прямо внутри того чата; чтобы не заставлять пользователя повторять команду, координатор сам сверил контракт и точечно синхронизировал loyalty roadmap/policy ниже. Новые функции и этапы лояльности не создаются без подтверждённого продуктового пробела.
- Приёмка требования 18 обновлена: 092 больше не числится следующим действием. Остаются модель денежного депозита, payroll recognition period/timezone, полный employee net для non-commission returns и отдельный upgrade QA поверх уже заполненной 091 истории.
- SaaS остаётся paused; production, VPS и постоянная БД не затрагивались. Новые чаты не создавались.

## 2026-10-04 — браузерная PostgreSQL приёмка управления залами и столами

- Повторно проверен уже добавленный `scripts/floor-management-postgres-browser-qa.mjs`: реальный владелец через UI создаёт зал и первый стол, редактирует оба, перечитывает сохранённые связи/диапазон гостей после reload и удаляет стол и пустой зал. Сверки напрямую с одноразовой PostgreSQL подтверждают persistence. Дополнительно проверяются невалидные диапазоны, запрет записи для bartender без права settings, stale `expectedVenueId`, отсутствие частичных записей и 320/375/768/1440 px без горизонтального переполнения.
- Финальный запуск: 
ode scripts/local-full-pg-regression.cjs floor-management-postgres-browser-qa.mjs` — `PASS PostgreSQL floor-management-postgres-browser-qa.mjs`; runner создал и удалил только принадлежащую ему disposable PostgreSQL. Этот запуск подтверждает базовый authenticated hall/table CRUD, но не завершает дополнительные пункты 14/15: занятый/зарезервированный/исторический table deletion и полная матрица статусов остаются частичными.
- `HOOKAH_POS_ADDITIONAL_ACCEPTANCE.md` уточнён по реальному покрытию. Историческая запись о запланированной unified browser+PG CRUD проверке больше не является следующим действием; дальше следует отдельная acceptance-сверка защищённых состояний/истории стола, затем существующие purchase-document browser gaps и сводная role/responsive матрица. Новые пункты меню и чаты не создавались.
- Сверка межчатовых границ на текущем дереве: Loyalty владеет evaluator и eligible-line policy; POS владеет durable 090 pricing facts и текущим 091 item-return producer/acceptance; Finance сохраняет отдельный 088 cash-payout ledger и потребляет immutable POS facts; Payroll завершил read-only consumer/readiness для 090/091, при этом `officialReady` остаётся false для непризнанных возвратов/неполной employee net и связанных источников; SaaS остаётся paused. Не назначать Payroll изменения POS/Finance producer и не дублировать текущий 091 пакет. MASTER получил read-only запрос о модульной карте и очереди, но пока ответил только подтверждением локальной границы — deliverable-карта ещё не получена.
- Архитектурный handoff: finance review подтвердил, что item-return merchandise value определяется frozen 090 net/quantity независимо от payout; payout linkage остаётся отдельной Finance reconciliation. System architect обнаружил, что 091 `created_at` наследует PostgreSQL transaction-start 
ow()` и потому не доказывает последовательность захвата per-item balance lock (возможны конкурентная инверсия и timestamp ties). Reader правильно сохраняет `producerSequence:not_attested`; UUID/timestamp inference запрещена. POS-владельцу назначен следующий последовательный пакет: additive migration 092 с атомарной per-item sequence и immutable previous/cumulative quantity/value facts, без backfill порядка старых событий. Payroll попросили ждать точную 092 форму данных и не менять свой reader до handoff. Оставшиеся отдельные payroll product inputs: recognition period/date и включение известных non-commissionable line returns в full employee net; 091/092 сами по себе не должны включать `officialReady`.
- SaaS, VPS, production и основная локальная БД не трогались.

## 2026-10-04 — запрет изменения заказа до открытия смены

- Аудит требования 6 выявил незакрытый путь: `PATCH /api/orders/:id` позволял операционной роли менять заметки/гостя до смены, хотя создание и другие POS изменения уже проверяли её наличие. Также demo/memory helper ошибочно считал открытую смену другого заведения достаточной.
- Изменение: после проверки права `orders` PATCH теперь проверяет открытую смену до чтения тела и до транзакции. Memory helper проверяет только смену `req.user.venueId` (или default venue, как PG path). `API.md` фиксирует PATCH контракт. Browser+PostgreSQL POS regression проверяет создание/изменение/удаление заказа и строк, статус/перенос, закрытие, split, скидку и оплату без смены. На каждом маршруте ожидается 409; до/после сравниваются заказы, гости, аудит, идентификаторы/количество/цеха позиций, идентификаторы/суммы/методы/статусы/смены платежей, заметка, статус и состояние стола. Затем UI открывает смену, успешный PATCH проверяется и исходная заметка восстанавливается. Транзакционный контракт проверяет, что shift venue-b не разблокирует bartender venue-a.
- Файлы задачи: `server.js`, `API.md`, `scripts/shift-transaction-qa.mjs`, `scripts/pos-role-payment-postgres-browser-qa.mjs`, `FINAL_ACCEPTANCE_REPORT.md`.
- Проверки PASS после последнего усиления snapshot: 
ode --check server.js`; 
ode --check scripts/shift-transaction-qa.mjs`; 
ode --check scripts/pos-role-payment-postgres-browser-qa.mjs`; 
ode scripts/shift-transaction-qa.mjs`; 
ode scripts/shift-close-ui-qa.mjs`; 
ode scripts/local-full-pg-regression.cjs pos-role-payment-postgres-browser-qa.mjs` — одноразовая PostgreSQL и настоящий browser/auth/API, exit 0, включая основную матрицу order endpoints и сравнение полей позиций/платежей; `git diff --check` по изменённым файлам (только штатные предупреждения LF→CRLF).
- Архитектор и QA выполнили read-only матрицу маршрутов; code-health baseline/final review: блокирующих замечаний нет, доказательная оговорка снята повторным актуальным прогоном. Строка 6 остаётся частичной: нет полной матрицы по всем маршрутам/ролям/tenant, теста гонки немонетарной правки с закрытием смены, и владельцу продукта нужно определить, считаются ли создание/отмена брони и внутреннее перераспределение предоплаты сменными операциями.
- Regression runner использовал и удалил только принадлежащую ему disposable PostgreSQL. Production, VPS, SaaS и основная локальная БД не изменялись.

## 2026-10-04 — стартовая наличность в интерфейсе открытия смены

- Причина: acceptance строки 7 подтверждал API-ввод, но не фактический пользовательский путь от кнопки смены до повторного чтения суммы из PostgreSQL.
- Изменение: browser+PostgreSQL POS suite больше не создаёт смену SQL-фикстурой. Сотрудник в реальном интерфейсе вводит 137,25 ₽, смена открывается через `POST /api/shifts`, а БД подтверждает сумму, venue и `opened_by` вошедшего сотрудника. API повторного чтения показывает ту же сумму как ожидаемую наличность; дальнейший сценарий закрытия использует созданную UI смену.
- Файл по задаче: `scripts/pos-role-payment-postgres-browser-qa.mjs`; строка 7 в `FINAL_ACCEPTANCE_REPORT.md` обновлена по результату E2E. Новые миграции и изменения продуктового кода не потребовались.
- Проверки PASS: 
ode --check scripts/pos-role-payment-postgres-browser-qa.mjs`; 
ode scripts/shift-transaction-qa.mjs`; 
ode scripts/local-full-pg-regression.cjs pos-role-payment-postgres-browser-qa.mjs` — реальный браузер + одноразовая PostgreSQL, exit 0; `git diff --check` для скрипта и acceptance report.
- Проверка использовала только контейнер и БД, созданные/удалённые regression runner. Основная локальная БД, production, VPS и SaaS не менялись. Ограничения строк 6 и 9 остаются; официальный/фискальный контур не проверялся. Отдельную роль code-health нельзя было запустить в этом runtime, поэтому координатор просмотрел scoped diff и результаты контрактов самостоятельно.

## 2026-10-04 — ожидаемая касса перед закрытием смены

- Причина: API уже сохранял ожидаемую наличность и разницу закрытия, но сотрудник не видел расчёт перед вводом фактической суммы. Это мешало сверить cash движения и выявить неразобранные legacy платежи.
- Изменение: текущая смена отдаёт предварительный ожидаемый остаток и время расчёта; неоднозначные legacy cash платежи дают блокирующее предупреждение. Диалог закрытия обновляет смену перед показом расчёта, показывает ожидаемую сумму, а после ответа сервера — фактическую и variance. Финальное закрытие пересчитывает сумму под блокировкой строки смены тем же SQL helper, что и предварительный расчёт.
- Проверяемые сценарии: наличные продажи/поступления и возвраты влияют на наличность; card/QR не влияют; payout возврата учитывается в смене выплаты один раз; legacy cash блокирует закрытие; оплата, конкурентная с закрытием, либо входит в ожидаемую сумму закрытой смены, либо отклоняется после закрытия.
- Файлы: `server.js`, `app.js`, `dist/app.js`, `index.html`, `dist/index.html`, `scripts/sync-published-assets.mjs`, `scripts/shift-cash-postgres-e2e-qa.mjs`, `scripts/shift-transaction-qa.mjs`, `scripts/shift-close-ui-qa.mjs`, `scripts/pos-role-payment-postgres-browser-qa.mjs`, `FINAL_ACCEPTANCE_REPORT.md`.
- Проверки PASS: 
ode scripts/shift-close-ui-qa.mjs`; 
ode scripts/shift-transaction-qa.mjs`; 
ode scripts/pos-order-refunds-ui-contract.mjs`; 
ode scripts/pos-order-pricing-snapshot-contract.mjs`; 
ode scripts/local-full-pg-regression.cjs shift-cash-postgres-e2e-qa.mjs`; 
ode scripts/local-full-pg-regression.cjs pos-role-payment-postgres-browser-qa.mjs` (real browser + disposable PostgreSQL); 
ode scripts/local-full-pg-regression.cjs pos-order-refunds-postgres-qa.mjs`.
- Верификация ограничена одноразовой локальной PostgreSQL и synthetic browser session. Production, VPS и SaaS не изменялись. Остатки приёмки: строка 9 требует структурированных пунктов X/Z и неизменяемого фискального снимка; строка 6 остаётся частичной. Открытие смены в UI с записью стартовой наличности дополнительно подтверждено 04.10.2026. Специализированный subagent review в том runtime не выполнялся; координатор проверил diff и контракты локально.

## 2026-10-04 — loyalty roadmap: принятие line-price integration

- Сверены фактический evaluator, POS 090 snapshot writer, Finance 091 item-return mapping, договор лояльности, Finance model, решения и acceptance roadmap. Обнаружено, что раздел о скидках/возвратах в `LOYALTY_POLICY_CONTRACT.md` всё ещё описывал источник как отсутствующий, хотя producer уже сохраняет winner/eligibility и line cents; также `loyalty-progress.mjs` не включал новый межмодульный acceptance этап.
- Обновлены требования/учёт и roadmap contract: `LOYALTY_POLICY_CONTRACT.md` теперь отделяет выполненные line-price/item-return факты от неготового official Payroll и уточняет tie precedence; `LOYALTY_ROADMAP.json` добавляет завершённый L14 с evaluator → first-tender/direct-close snapshot → Finance return acceptance и поясняет границу 100%; `DECISIONS.md` помечает более раннее описание как историческое и фиксирует текущие владельческие границы; `scripts/loyalty-progress-contract.mjs` проверяет новые 14/52 счётчики и последовательность L14.
- Read-only baseline system_architect/code_health_engineer подтвердил: не менять POS/Finance/Payroll runtime, миграции или ledgers; денежный runtime gap без нового owner decision не найден. Старые строки без snapshot остаются unknown/unattributed; payroll readiness остаётся отдельным блокером.
- PASS в этом ходе: 
ode scripts/loyalty-pricing-qa.mjs`; 
ode scripts/loyalty-pos-explanation-contract.mjs`; 
ode scripts/pos-order-pricing-snapshot-contract.mjs`; 
ode scripts/loyalty-progress-contract.mjs`; 
ode scripts/loyalty-progress.mjs` (после обновления 14/14 этапов). Основание существующего PG/browser roundtrip: предыдущая проверка записана в журналах 090/091; тяжёлый suite в этом документальном ходе не повторялся и основная БД не запускалась.
- Изменения кода, БД, источников выплат, GitHub, VPS и SaaS не выполнялись.
- Бронь открывается как единственный связанный заказ; бронь перечитывает linkedOrderId. Заказ принимает частичный или полный зачёт существующей квитанции как отдельный тендер reservation; он не создаёт нового приёма денег. Закрытая продажа учитывается один раз, исходное поступление остаётся в смене получения и не прибавляется к кассе заказа. Отмена брони после зачёта запрещена до реализации возврата на этапе 10.
- Миграция 065_reservation_pre_payment_allocations.sql создаёт аудит распределения с составными tenant/booking/order/payment/shift FK, venue-wide идемпотентностью и ограничением «один заказ на бронь». Ревью данных нашло отсутствующий частичный unique индекс в свежей schema.sql; он добавлен, поэтому чистая установка и миграционный апгрейд теперь согласованы. PostgreSQL тест расширен проверкой обеих нужных областей прав, попытки связать бронь чужой точки и гарантированной уборки тестового audit trigger.
- Перед локальной миграцией сохранён и проверен backup tmp/local-loyalty-backups/crm-before-loyalty-phase9-20261002.dump. До применения дублей заказов на одну бронь не было. После migration 065 сохранены: 3 гостя, 3 бонусных и 2 денежных ledger entries, денежный баланс 3 000 ₽, 3 заказа, 2 платежа, 2 брони, 2 смены и старые неподтверждённые депозиты 1 500 ₽; verified deposit, новые квитанции и зачёты — 0. Новый индекс и tenant FK присутствуют. Локальная CRM healthy; /api/health, /reservations, portal.js rev434 и app.js rev181 — HTTP 200.
- PASS: reservation-prepayment-postgres-qa.mjs через disposable PG runner (реальные HTTP/auth, повтор, частичный/конкурирующий зачёт, RBAC, чужой tenant, cancel race, rollback аудита, одна выручка/касса), migrations-pg-upgrade-qa.mjs, migrations-pg-runtime-qa.mjs, reservation-form-qa.mjs, order-close-transaction-qa.mjs, сменные/денежные и бонусные regression suites, node --check, git diff --check. System architect, finance reviewer и final code-health review — без блокеров. Мобильный авторизованный визуальный проход не выполнялся: активной пользовательской сессии нет.
- Этап 9 закрыт; автоматический реестр переводит текущий статус на этап 10 «Возвраты, отмены и обратные движения». GitHub и production-сервер не тронуты.
## 2026-10-02 — loyalty phase 4: групповая скидка и снимок цены

- Цель: довести текущий ценовой сценарий гостя до работающего POS/API/БД пути на локальной копии, сохранив отдельные будущие пакеты списания бонусов, денежного депозита и предоплаты брони. Архитектурный контракт проверил PATCH гостя, quote/pay/close и повторное чтение; code-health зафиксировал и помог обнаружить дефекты demo-пути до локальной выкладки.
- Добавлена миграция `061_order_group_discount_pricing.sql` и соответствующие поля `schema.sql`: захват группы на заказе, выбранный источник, товарная/скидочная/VIP/конечная суммы и версия снимка цены. Прошлые закрытые чеки не бэкфилим. Проверка миграции требует одновременно присутствующую пару group base/amount.
- Единый выбор сравнивает ручную одобренную сумму с сохранённым процентом группы, выбирает большее (равенство — группа), ограничивает суммой товаров; открытые цены и finance CTE применяют то же правило. VIP минимум остаётся нижним порогом, начисление бонуса использует скидочную базу без VIP uplift. Снятие гостя явное, tenant-scoped; после частичной оплаты гостя сменить нельзя.
- POS показывает скидку/конечную цену; корректно предвыбирает текущего гостя, отдельный список действия даёт снять привязку. Исправлен static/demo checkout, чтобы quote, оплаты и закрытие использовали тот же pricing helper и сохраняли снимки. `app.js` точечно синхронизирован в `dist/app.js`; cache rev увеличен с 177 до 178 только в `index.html`/`dist/index.html`.
- Изменены по задаче: `server.js`, `db.js`, `schema.sql`, `migrations/061_order_group_discount_pricing.sql`, `app.js`, `dist/app.js`, два POS entry HTML, checkout memory/PG QA, `scripts/local-full-pg-regression.cjs` уже включает прежний allowlist и использован без broad sync, `API.md`, requirements, decision log.
- QA PASS: syntax server/app/оба checkout QA; paid-order memory E2E; paid-order PostgreSQL E2E через runner, который создал свежую disposable базу из полного schema+migration replay и затем очистил её. Проверены ставка 10% и due 180/200, изменение группы до 40% без переоценки открытого заказа, отказ менять гостя после частичного платежа, снимок закрытого чека 200/20/180/source guest_group/version 1, начисление 9 бонусов, группа 40% против ручных 10% при VIP minimum 250 (выбранная скидка 40, bonus base 60), 100% ручная скидка против группы, одна approved ручная скидка.
- Локальная выкладка: закрытая проверенная копия БД `tmp/local-loyalty-backups/crm-before-loyalty-phase4-20261002.dump`; хостовый `127.0.0.1:5432` недоступен (connection refused), поэтому replay миграций выполнен штатным `docker compose exec -T crm node scripts/migrate.js` — Applied 62 migrations. SQL подтвердил поля `group_discount_percent`, `final_total_snapshot`, `pricing_version`; сохранены 5 ledger движений, 3 заказа, баланс/journal mismatch = 0. CRM image rebuilt/recreated locally, `docker compose ps` healthy; `/api/health` PostgreSQL OK, `/app.js?rev=178` HTTP 200, HTML ссылается на rev178. Dashboard pending и finance shift analytics PG suites PASS на fresh schema. Авторизованный визуальный POS-проход не выполнялся, сессии пользователя в среде нет. GitHub/VPS не затрагивались. Следующий loyalty пакет: списание бонусов как отдельного tender с лимитами и финансовой сверкой.

## 2026-10-02 — loyalty phase 5: бонусы как способ оплаты заказа

- Продолжен полный локальный rollout, без публикации. Контракт этапа временно задаёт 1 бонус = 1 ₽, целое списание не выше остатка гостя и долга заказа; бонусный платёж не попадает в наличность смены.
- Миграция `062_bonus_order_tender.sql` добавляет идемпотентный ключ платежа и проверку целочисленности бонусного tender. PostgreSQL API сериализует заказ и гостя, одновременно пишет платёж и отрицательный ledger entry, не позволяет повторно списать баланс и пересчитывает начисление на закрытии за вычетом потраченных бонусов. POS включает четвёртый способ оплаты только для привязанного гостя, показывает доступный баланс и временный курс. Demo/localStorage checkout поддерживает тот же контракт. `app.js` синхронизирован в dist, POS cache rev поднят до 179.
- Обновлены API/requirements, уточнён структурный тест атомарной оплаты под текущую последовательность (идемпотентный replay может завершиться до требования открытой смены; commit находится внутри ветки закрытия). Возврат списанных бонусов и лимит доли бонусной оплаты остаются будущими задачами.
- PASS: isolated PostgreSQL runner suite `paid-order-balance-postgres-qa.mjs` (включая дробное/избыточное списание, успешное списание, повтор того же ключа, конфликт изменённой суммы, финальную оплату наличными, удержание бонуса и отчётный cash breakdown); paid-order memory/demo, order-close structural QA, pending metrics PG, shift analytics PG; syntax server/app/portal. Прямой запуск старой `guest-loyalty-postgres-api-qa.mjs` на legacy QA schema ранее упал без таблицы `guest_account_entries`; текущий безопасный PG-runner не включает её в allowlist, его защиту не обходили. Новая tender suite проходит на полной свежей runtime schema+migration replay. Полный isolated upgrade suite требует отсутствующий `MIGRATIONS_PG_TEST_DATABASE_URL`.
- Перед локальным применением сохранён и `pg_restore -l` проверен backup `tmp/local-loyalty-backups/crm-before-loyalty-phase5-20261002.dump`. `docker compose exec -T crm node scripts/migrate.js` применил replay успешно; CRM локально собран и пересоздан, контейнер healthy, `/api/health` PostgreSQL OK, HTML ссылается на `/app.js?rev=179`, asset отвечает HTTP 200. Сохранены 3 гостя, 5 ledger движений и 3 заказа; операций с балансами гостей не выполнялось.
- Code-health review нашёл пропущенный `shift_id` у бонусных платежей: исправлено, поскольку shift KPI должен учитывать безналичный tender в `other`, но cash reconciliation суммирует только реальные `cash`. PG E2E теперь подтверждает наличие бонусного tender в выбранной смене и неизменность cash-суммы.
- Следующие этапы: возврат бонусов при отмене/корректировках с reversals и идемпотентностью; денежный депозит как ledger tender (не объединять бонусный и денежный остаток); предоплата/возврат брони; затем end-to-end проверка админки, мобильного POS, отчётов и изолированного миграционного upgrade.

## 2026-10-02 — loyalty phase 6: разделение требования и оплаты брони

- Исправлена первопричина ложной «оплаты»: `deposit` при создании брони трактуется как требуемая сумма, а не как поступившие деньги. Новая бронь сохраняет `deposit_required` и `deposit_paid=0`; фактические старые строки не переписывались.
- API списка, истории гостя и создание брони возвращают отдельные `depositRequired`/`depositPaid`, временно сохраняя legacy alias `deposit` как фактически полученную сумму. Форма говорит «Требуемый депозит» и поясняет, что поступление учитывается отдельно. Календарь и история гостя корректно показывают старый legacy `deposit` как требование, но не выдумывают оплату.
- Static/demo путь и контрактные тесты синхронизированы с правилом; `db.js`, `server.js`, `portal.js`, API, requirements, decision log и `scripts/reservation-local-date-postgres-qa.mjs` входят в следующий локальный пакет. Миграция не добавлялась: действующие `deposit_required`/`deposit_paid` уже представляют поля.
- Проверки: `reservation-form-qa.mjs` проверяет новый объект demo-брони и legacy rendering; PostgreSQL reservation suite на одноразовой БД с полным schema+migration replay проверяет требование 125.50, поступление 0, alias, и сохранённые значения. Ранее в этом рабочем цикле также прошли checkout tender/конкурентный bonus debit PG suite, paid-order memory/demo, сменные KPI и штатные style/navigation/runtime contracts.
- Границы этапа: денежные пополнения/списания, связь платежа с кассой/банком, tender депозита в POS, фактическая предоплата брони, её перенос/возврат/удержание пока не реализованы. Старые `deposit_paid` сохранены без автоматической сверки. Из-за отсутствия авторизованной сессии визуальный проход кассы/админки не заявляется. Локальная выкладка ещё не выполнена в этом подэтапе; GitHub/VPS не затрагивались.

# Рабочий журнал команды

## 2026-10-02 — loyalty phase 3: согласование ручной скидки и VIP суммы

- Цель: закрыть расхождения в действующих ручных скидках, не вводя пока автоматическую скидку группы и новые финансовые правила.
- В `server.js` добавлен общий расчёт скидки на точных денежных центах для memory и PostgreSQL путей; сумма одобренных скидок для legacy-заказов ограничена subtotal. Сохраняется формула `due=max(subtotal-discount, VIP minimum)`.
- Согласование скидки блокирует заказ; второй sequential approved discount теперь отклоняется с `approved_discount_exists`. Уже существующая блокировка заявки PG предотвращает дублирующие pending requests в штатном API пути.
- Краткая сводка VIP теперь считает shortfall от суммы после одобренной скидки; бонусная база по-прежнему не включает VIP uplift.
- Обновлены requirements, decision log, memory и PostgreSQL checkout QA. Новая миграция не нужна: сериализация использует уже имеющуюся блокировку заказа, схема не меняется.
- Проверки PASS: 
ode --check server.js` и трёх QA; `paid-order-balance-memory-qa.mjs`; PostgreSQL `paid-order-balance` (включая параллельное решение двух ожидающих скидок: одна 200, вторая 409), `dashboard-pending-metrics` и `finance-shift-analytics` на изолированных БД полной схемы; `order-close-transaction-qa.mjs`; `discount-groups-memory-qa.mjs`; `git diff --check` (только ожидаемые предупреждения CRLF; в репозитории есть и иные ранее грязные файлы).
- Code-health итог: исправлено замечание о самостоятельном PostgreSQL расчёте оплаты/VIP, конкурентная проверка скидок под row lock подтверждена отдельным PG параллельным сценарием; блокирующих замечаний нет. Финансовые SQL сводки остаются выражены SQL формулами (net ограничен нулём/VIP floor); их точность на округлении следует дополнительно покрыть ценовыми краевыми случаями при следующем отчётном/ценовом этапе.
- Локальная выкладка: Docker образ CRM пересобран без изменения БД и перезапущен. `/api/health` вернул PostgreSQL OK, после прогрева `docker compose ps` подтвердил `healthy`; локальный `/api/orders` вернул HTTP 200.
- Ограничения: групповой процент всё ещё только подсказка формы; fee/tax representation для VIP minimum, возвраты, redemption/deposit/prepayment и snapshots итоговой цены — следующие этапы. Это технический MVP, не подтверждённая политика владельца бизнеса.

## 2026-10-02 — loyalty phase 2: начисление бонусов на закрытии заказа

- Цель: связать существующий `bonus_percent` группы и журнал этапа 1 с реальной завершённой продажей, не подменяя бонусами оплату и кассовую выручку.
- Добавлена миграция `060_order_loyalty_bonus_snapshot.sql` и nullable-поля снимка в `orders`: ставка, eligible база и фактически начисленные бонусы. Старые закрытые чеки остаются `NULL`, потому что ставку задним числом надёжно не восстановить.
- Автоматическое начисление работает в обоих POS путях: последняя оплата `POST /api/orders/:id/payments` и прямое закрытие `POST /api/orders/:id/close`. В PostgreSQL операция блокирует гостя, обновляет его баланс, добавляет один журналированный order-source entry и фиксирует снимок в одной транзакции закрытия. Memory путь повторяет расчёт и source-key защиту. Частичные платежи не начисляют.
- База — subtotal за товары после одобренных скидок; доплата до VIP-минимума исключена. Дробные бонусы округляются вниз до целого; при упоре в предел legacy integer начисляется только помещающийся остаток. Конкретные параметры группы не подменяются глобальными настройками. Кассир видит начисление после закрытия, API позволяет перечитать сохранённый снимок.
- Обновлены `server.js`, `app.js`, `dist/app.js`, cache rev `app.js` 177, `schema.sql`, миграция 060, API/продуктовый контракт, журнал решений, memory/PG checkout QA и изолированный PG runner. Расширение runner создаёт временную чистую БД с полной историей миграций для двух затронутых order/shift тестов.
- Проверки PASS: 
ode --check server.js/app.js/QA`; paid-order memory и PostgreSQL E2E; order-close transaction contract; discount group memory/demo; guest ledger memory; clients editor contract; migrations PG upgrade; finance shift analytics; dashboard pending metrics; shift cash PG E2E на свежей БД; local PG runner target guard; `git diff --check` (только ожидаемые предупреждения CRLF).
- Отдельная попытка `shift-cash-postgres-e2e-qa` на старой базовой regression-схеме вернула 409, потому что route harness извлекал обработчик без нового helper; тесту добавлена безопасная заглушка начисления (чек без гостя), после чего suite прошла на свежей схеме со всеми миграциями. Для текущей локальной `crm` сделан второй `pg_dump`; миграции 060/весь replay прошли сначала на изолированной копии, затем локально применены. Docker CRM пересобран/перезапущен, health API вернул PostgreSQL OK, загруженный `app.js?rev=177` подтверждён HTTP 200, три snapshot-поля на месте, 5 journal entries сохранены, сверка балансов дала 0 расхождений. В браузере подтверждена обновлённая локальная страница входа; дальнейший POS checkout визуально не проверен из-за отсутствия авторизованной локальной сессии.
- Ограничения: списание бонусов, лимит оплаты баллами, депозитный счёт как tender, предоплата/возвраты и единый автоматический калькулятор скидок остаются следующими этапами. Система не публиковалась.

## 2026-10-02 — loyalty phase 1: ledger foundation

- Цель: начать локальное внедрение системы лояльности с безопасного финансового основания, не публикуя изменения. Архитектурный, финансовый и исходный code-health аудиты подтвердили главные риски: бонусный/депозитный остатки можно перезаписать в карточке, бонусы без отдельного журнала, депозитные движения не реализованы, group bonusPercent пока не начисляется в POS, депозит брони не связан с платежом/возвратом.
- Добавлена миграция `059_guest_account_ledger.sql` и таблица в `schema.sql`: неизменяемые движения типов bonus/deposit, суммы со знаком, причина, тип/ссылка источника, автор и idempotency source key. Текущие ненулевые остатки при миграции сохраняются как разовая запись начального остатка; история до подключения не выдумывается.
- `POST /api/clients/:id/loyalty` в PostgreSQL блокирует карточку гостя, проверяет достаточность бонусов/переполнение, атомарно обновляет legacy balance и пишет ledger entry в одной транзакции. Отрицательный итог теперь отклоняется вместо неявного обнуления. In-memory маршрут повторяет отказ овердрафта и сохраняет историю процесса.
- Добавлен tenant-scoped `GET /api/clients/:id/account-entries`; карточка гостя показывает read-only остатки и журнал. Создание/редактирование карточки не может менять ненулевые остатки и PostgreSQL PATCH больше не пишет эти колонки; UI balance inputs только для чтения. Обновлён API контракт.
- Изменены по задаче: `server.js`, `schema.sql`, `migrations/059_guest_account_ledger.sql`, `portal.js`, `API.md`, `scripts/guest-loyalty-postgres-api-qa.mjs`. Остальные уже изменённые пользовательские файлы не затрагивались намеренно.
- QA: syntax, `scripts/guest-account-ledger-memory-qa.mjs`, `scripts/clients-editor-contract.mjs`, discount-group memory/demo, paid-order balance memory, local role contract и `git diff --check` — PASS. `migrations-pg-upgrade-qa.mjs` и `guest-loyalty-postgres-api.mjs` прошли на owned disposable localhost PostgreSQL с полной schema+migration replay; проверены tenant isolation, права, ретраи/idempotency и ledger. Для локальной базы `crm` создан закрытый `pg_dump` (`tmp/local-loyalty-backups/crm-before-loyalty-migration-20261002.dump`), все 60 миграций сначала проверены на восстановленной одноразовой копии базы, затем применены к локальной `crm`. Проверка сверки показала 0 расхождений между остатками 3 гостей и журналом (5 движений). Локальный Docker image пересобран, CRM пересоздана и здорова; страница входа в браузере открылась. Проверка экрана гостя остановилась на форме входа, так как в среде нет авторизованной локальной сессии; пользовательский логин не выполнялся.
- Ограничения: депозитные пополнения/списания и их связь с кассой пока не доступны; `deposit_balance` читается как начальный остаток, PATCH защищён. Бонусная корректировка теперь журналируется, но выдача/списание бонусов в checkout, начисление `bonus_percent`, идемпотентность клиентских повторов, возвраты, предоплата брони, единый калькулятор групповых скидок и финансовые отчёты остаются следующими пакетами. Никакой GitHub/VPS публикации не выполнялось.

## 2026-10-01 — публикация полного локального QA на VPS

По явному запросу пользователя выпущен согласованный commit 7d573fe1 в GitHub main и на VPS. Code health и architect/release review GO; локальные 167/167 и static125/125, verified backup restore до обновления. Production .env/ключи/volume и количество рабочих записей сохранены, локальная QA база не переносилась. Новый image/commit/release fingerprint проверены, health PostgreSQL и39 exact public assets PASS. Реальный браузер: вход Романа с корректной identity, рабочий зал, Заказы, Гости, Задачи, личный отчёт/refresh/выход; SaaS вход/Компании/Настройки/hash reload/выход PASS, ошибок консоли нет. Полные SHA, rollback snapshot и ограничения — docs/design/RELEASE_FULL_QA_2026_10_01.md. Mobile/Fold и HTTPS остаются отложенными по запросу пользователя.

## 2026-10-01 — пользовательский Hookah POS brand kit

- Изучен архив/README/USAGE/manifest/SVG и auth preview.21runtimeassets импортированы без выполнения вложенных генераторов. Пользователь отдельно выбрал animated sidebar: staff/admin/platform используют fullanimated, compact symbol остаётся static, reduced-motion выбирает staticfull. Авторизация fullanimated240×76.8; lock static180×57.6 отдельно от аватара. Login больше не подменяет продуктовый бренд логотипом заведения.
- Favicon SVG/PNG/ICO, Safari/Apple/PWA/OG metadata подключены через единый sync41routes, server exactallowlist и MIME, source/dist. CSS369 login97 lock21 brandrev2. Никаких API/БД/роль/route изменений и миграций; Docker assets COPY уже покрывает комплект.
- Brand-kit/sidebar-brand/local-login/local-lock/local-design/auth-smoke-runtime/static-boundary — PASS. CUA desktop login/admin/staff/platform logo currentSrc/contain проверены; animated SVG running5.4s и изменениеopacity подтверждены; lock/unlock синтетической учётки сохранены. Proof tmp/brand-kit внеrelease.
- Независимые architect/code-health/design reviews приняты. Мобильный layout/QA отложен, остальные доработки отложены. Основной dirty checkout/production/VPS не менялись. Документ docs/design/HOOKAH_POS_BRAND_KIT.md содержит контракт и пределы проверки.
- Docker build и HTTP всех21assets PASS с точным сравнением байтов, правильными MIME и404preview/generator. Локальный preview31921 оставлен для просмотра результата; прежний31907 не перезапускался, его memory-данные сохранены. Новый пакет в нём не подтверждён; для просмотра используется31921. Только локальный commit, безGitHub/VPS.

## 2026-10-01 — согласованные смены и уведомления руководителей

- Проверены рабочий зал, главная и финансы; найдено отсутствие событий смены/колокольчика управляющего, несогласованное обновление UI, неатомарный аудит и memory venue isolation. Исправления в server/app/portal и общем notification-center; root/dist синхронны, asset добавлен в server whitelist и Docker COPY. Новых миграций нет.
- PostgreSQL смена+аудит сохраняются одной транзакцией; строгие суммы, повторные/конкурентные действия, per-venue scope и per-user read receipts проверены. Права управления floor/orders; финансовое чтение без action. UI перечитывает состояние при изменении, ошибке, focus/visibility/visible20s; KPI подписаны на переходы.
- Memory и выделенная PostgreSQL shift-notifications E2E — PASS, включая audit failure rollback и restart persistence. Shift-state runtime, header-shell, finance-load-race, staff-header-actions — PASS. Профильные shift transaction/cash/concurrency/close/attribution — PASS. Code-health, system architect/frontend/design и finance/backend review приняты; release review обнаружил пропуск нового файла в Docker COPY, исправлено.
- CUA owner/admin/Roman/manager: реальные формы open/close, cancel, повторное отображение в finance, индивидуальное прочтение. Управляющий открыл в / и закрыл в /admin; header/control/KPI обновились без reload, bell2→3→4, оба события доступны. Актуальный Роман входит под своим именем и не видит руководительский inbox. Proof tmp/shift-qa вне Git/release.
- Мобильная компоновка/QA остановлены по прямому указанию пользователя; будущая адаптация для телефона отдельным этапом. Проверка не подтверждает production: только локальный пакет, без GitHub/VPS. Реальная касса и основной dirty checkout сохранены. Уведомления внутри CRM; Telegram не реализован, чек-лист закрытия подтверждается вручную. Подробности docs/ai-team/SHIFT_LIFECYCLE_AUDIT.md.
- Итоговый release review принял Docker COPY. Локальная Docker build PASS, health ok и HTTP200 нового модуля проверены во временном контейнере; временные QA-сервисы/контейнеры после проверки убираются. Static inbox runtime дополнительно подтвердил per-user/per-venue прочтение.

## 2026-10-01 — единый стиль действий шапки и контекст открытой смены

- Цель: убрать рамки с иконок настроек, блокировки и уведомлений и показать руководителям автора активной смены, сохранив уже выпущенный счётчик непрочитанных уведомлений.
- Контракт UI → API → права → данные → отображение: общая шапка маршрутов портала читает `GET /api/shifts`; owner/admin/manager/developer с `finance_read` получают `current.openedByName` (имя пользователя определяется по `users` в том же `venue_id`), operational staff сохраняют открытый/закрытый статус через прежний сокращённый ответ без личности автора. `portal.js` показывает имя рядом со статусом только если API его вернул. Открытие/закрытие остаётся на существующем экране управления сменой; шапка пассивно сообщает состояние.
- Изменение: три действия шапки используют одну нейтральную палитру без рамки; замок наследует `currentColor`, hit area 44×44 сохраняется, клавиатурный focus ring остаётся. Добавлены имя автора и title-подсказка для активной смены руководителя; на телефоне индикатор остаётся в шапке в ограниченной ширине с ellipsis. Обновлены `dist` и cache keys CSS 364, portal 414, lock 18.
- Проверки PASS: 
ode --check` server/portal/lock и изменённых MJS; `header-shell-contract.mjs` (11 маршрутов и source/dist parity); `portal-context-refresh-qa.mjs`; 
otifications-browser-qa.mjs` (Playwright, desktop/tablet/mobile, badge/read state/focus/cross-tab); `shift-transaction-qa.mjs`; `git diff --check`.
- Проверка ролей PASS: `shift-cash-postgres-e2e-qa.mjs` на одноразовом локальном PostgreSQL 16 с полной схемой и 56 миграциями подтверждает, что руководитель получает `openedByName`, bartender видит открытую смену без имени открывшего. Временный контейнер удалён после QA.
- Независимое ревью PASS: архитектор подтвердил API/tenant/role контракт и место статуса; design lead подтвердил общие безрамочные действия и адаптивность; code-health engineer проверил итоговый diff, source/dist и команды QA. Release-публикация выполняется из этого проверенного изолированного checkout.
- Production business data не изменялись.

## 2026-09-30 — PIN-возврат на доверенном устройстве

- Цель: сохранить текущую PIN-блокировку рабочего экрана и добавить простой возврат для владельца/администратора на уже доверенном устройстве без частого ввода логина/пароля.
- Диагноз: сервер уже выдаёт 30-дневную HttpOnly cookie-сессию, но login page не предлагала PIN-возврат, а клиентские страницы зависят от `localStorage.crm_session_token`. При живой cookie и потерянном localStorage пользователь снова видел форму логина.
- Изменение: `POST /api/session/unlock` после успешного PIN возвращает текущий token и user для совместимости; отдельный `POST /api/session/pin-return` ограничен owner/admin/developer и возвращает bearer token только после успешного PIN. `GET /api/session` не выдаёт bearer token, чтобы доверенная cookie не обходила PIN-card. Login page при живой cookie-сессии и настроенном PIN показывает отдельную PIN-карточку, восстанавливает localStorage через существующий `finishLogin()` и оставляет доступным вход по паролю. Staff lock screen и его быстрый PIN-сценарий не менялись.
- Документы/контракты: обновлён `API.md`, добавлен `scripts/trusted-pin-return-contract.mjs`, обновлены ревизии `login.js`/`style.css` и синхронизированы `dist`.
- Проверки PASS: синтаксис JS для `server.js`, `login.js`, `scripts/trusted-pin-return-contract.mjs`, `scripts/sync-published-assets.mjs`; `scripts/trusted-pin-return-contract.mjs`; `scripts/header-shell-contract.mjs`; `git diff --check` без whitespace errors.

## 2026-09-30 — центр уведомлений административной панели

- Цель: реализовать центр уведомлений по концепту владельца: сигнал на колокольчике, отдельная панель, адаптивность, чтение событий и изоляция пользователей/заведений.
- Изменение: добавлены последние события запросов скидки, отправленных автозаказов, удалённых заказов и смены PIN; безопасные DTO без денежных сумм/состава/PIN. Добавлены API списка, отметки одного и отметки всех; PostgreSQL receipts с ключом venue/user/event в миграции `054_notification_reads.sql`. Исправлено разрешение demo venue на основе активной пользовательской сессии при переключении сетевого заведения; reads остаются раздельными для пользователя и venue. В demo без БД прочтение временное (память процесса). Концепт оставляет на следующий этап только решения о новых типах/получателях, inbox операционного режима, сроке хранения истории и настройках подписок/агрегации.
- Интерфейс: фильтры «Все»/«Непрочитанные», badge, loading/empty/error/retry, явная отметка прочтения, polling при видимой вкладке, синхронизация вкладок, Escape/восстановление фокуса. До 768 px панель модальна и занимает экран; постоянного мигания нет. Операционная шапка сотрудника не менялась; API для операционной роли запрещён.
- Документы/контракты: обновлены `API.md`, `docs/requirements/NOTIFICATIONS_CONCEPT.md`, `schema.sql`, header-shell contract и revision-копии в `dist/`; добавлены API и browser QA, команды записаны в package scripts.
- Проверки PASS: 
ode --check` для изменённых JS/MJS, 
ode scripts/header-shell-contract.mjs`, 
ode scripts/migrations-contract.mjs`, 
ode scripts/notifications-api-qa.mjs`, 
ode scripts/order-delete-qa.mjs`, browser QA Chrome/Playwright на 1440/768/375 px (503/retry, клавиатура/focus trap, accessible name, reduced-motion computed style, переход на target, одиночное/read-all, фильтр, возврат фокуса, cross-tab, перечитывание после reload), `git diff --check`.
- PostgreSQL: `schema.sql` и 54 миграции применены на отдельной временной PostgreSQL 16 базе. `scripts/notifications-postgres-qa.mjs` проверяет session venue/user scope, двух пользователей и двух заведений, чужой ID, ограниченного admin, read-all, сохранение после рестарта app-процесса и 503 при ошибке source query; PASS. Временный контейнер удалён после прогона. Production не подключался и не публиковался.
- Затронуты `portal.js`, `server.js`, `app.js`, `style.css`, `schema.sql`, `API.md`, концепт, QA-контракты, sync script, package scripts, миграция и `dist/` assets/routes. Существующий `tmp/` не затрагивался.

## 2026-10-01 — аудит точности склада и рабочих ролей

- Цель: проверить приход/расход склада и связанные сценарии продаж бармена/кальянщика на отдельном VPS-контуре и локальной PostgreSQL.
- Диагноз: на VPS `/api/health` и `/login` отвечают HTTP 200; API складских данных не запрашивался без авторизации. В браузере по-прежнему пустая форма входа; тестовая учётка владельцем подтверждена, но вход ещё не выполнен, поэтому на VPS не создавались тестовые данные.
- Воспроизведён дефект PostgreSQL: строка документа прихода сохраняла `0,000600`, а `stock_movements.quantity numeric(12,3)` записывал `0,001`. Дополнительно коэффициент упаковки, рецепт/премикс, минимальный остаток, автозаказ и формы ввода местами округляли количества до 2–3 знаков.
- Исправление: миграция `055_stock_movement_precision.sql` переводит складские количества, рецепты, премиксы, минимальные остатки и коэффициенты в 
umeric(15,6)`; количество в единице закупки — 
umeric(17,6)`, чтобы сохранить прежний 11-значный целый диапазон. `schema.sql`, API/UI расчёты и опубликованная копия `dist/portal.js` синхронизированы; версия portal asset повышена. Заодно исправлена проверка composite constraint в schema bootstrap, которая ошибочно видела одноимённое ограничение другой таблицы.
- QA-инфраструктура: PostgreSQL сценарий рецептур использует случайный actor UUID и настоящую авторизацию, без принятия/удаления seeded account. Автозаказ проверяет изолированный loopback disposable-контейнер и настраиваемый порт. Добавлены регрессии для `0,0006` в закупочном количестве/упаковочной конверсии, рецептурном списании, ledger reread, миграции старых типов и двух одновременных закрытий одного последнего остатка.
- Проверки PASS на PostgreSQL 16 disposable-контейнере: чистый bootstrap `schema.sql` + 55 миграций; `migrations-pg-upgrade-qa` (38 baseline + 17 миграций, legacy rows, 6-digit types/ranges, повторный прогон); автозаказ, черновик, частичный/полный приход, отмена и точный приход; 265 авторизованных API assertions по складу, продажам/списанию, барной/кальянной рецептуре, стоимости, rollback, финансовым итогам, RBAC кальянщика и concurrent close (1 успех, 1 отказ, 1 приход/1 расход, без лишнего платежа). Также PASS: складской API 55 checks, role API matrix, local role/migration/purchase contracts, work-context 62, transaction safety, recipe runtime 87, demo premix units, JS syntax, `git diff --check`.
- Остаточные блокеры на VPS: владелец вошёл в интерфейс тестового заведения, но отдельные учётные записи бармена/кальянщика на VPS не проверены. Код не коммичен/не отправлен, GitHub PR и production deployment не выполнялись; соседние изменения в рабочем дереве оставлены на месте.

### Сквозной браузерный складской сценарий — 01.10.2026

- К существующему `scripts/pos-role-payment-postgres-browser-qa.mjs` добавлен синтетический сценарий: администратор оформляет поставку через UI, проверяются черновик без изменения остатка, перевод `0,5 л → 500 мл`, запрет повторного проведения и права кальянщика; далее бармен и кальянщик добавляют связанные с рецептами товары в POS и закрывают заказ через UI, проверяется точность списания и повторное чтение после обновления.
- Фикстура ограничена случайным tenant, включает cleanup строк поставки, движений, рецептов, ингредиентов и пользователей. Добавлена явная проверка успешного ответа маршрута `/api/orders/:id/close`; убраны конфликтующие предсозданные активные заказы на одном столе.
- Полный PostgreSQL browser PASS на временном PostgreSQL 16 container с loopback-only binding и временным volume: `schema.sql` + 56 миграций, browser сценарий прошёл приёмку через UI (черновик не меняет остаток, `0.5 л → 500 мл`, повторное проведение получает 409), бармен списывает 25 мл по рецепту, кальянщик списывает 18 г и не получает доступа к складу, reload не дублирует списание; прошли также разделение/частичные оплаты, роли, 13 размеров POS и cleanup. Скрипт подчистил фикстуру (`venues=0`), контейнер остановлен и автоматически удалён.
- В ходе прогона устранены дефекты QA harness: переменная менеджерской страницы использовалась до объявления; ожидания финансов и количества заказов не учитывали два новых POS продажи; поиск суммы отчёта не учитывал группировку тысяч пробелом. Бизнес-код не менялся. 
ode --check`, `purchase-documents-contract`, `local-role-contract`, `migrations-contract` (56), `inventory-movement-transaction-qa`, `postgres-qa-safety-contract` и `git diff --check` — PASS. CodeHealth повторно проверил итоговый diff, блокирующих замечаний нет.
- VPS: тестовый черновик `QA-VPS-20261001-01` на 0.05 л / 0.25 ₽ штатно отменён через UI; список показывает «Отменён», остатки не менялись. Через UI склада выполнена пара QA движений по «Тест2»: корректировка +50 мл и расход −50 мл; обе записи есть в журнале, toast подтверждает сохранение, остаток вернулся с 1000 → 1050 → 1000 мл и остаётся 1000 мл после перезагрузки. В списке заведений обнаружены активные тестовые сотрудники «тест» (бармен) и «тест1» (кальянщик); карточка бармена показывает, что PIN блокировки не настроен, а для входа требуется пароль. Изменения учётных данных не выполнялись. Каталог содержит 66 товаров, техкарты — 26 карт, но экран показывает 0 связанных товаров; тестовые карты «Тест»/«Тест1» тоже без связи, а поиск тестового товара в каталоге пустой. Поэтому для реального списания рецепта в POS сперва требуется безопасно связать тестовый товар с тестовой картой. Авторизацию/продажи от имени бармена и кальянщика на VPS пока не подтвердил — нужны их существующие пароли и тестовая товарная связь. В QA журнале VPS остались две компенсирующие складские записи, чистый остаток сохранён.

### Повторный полный browser QA — 01.10.2026

- После восстановления Playwright из соседнего локального проекта запущен полный `scripts/pos-role-payment-postgres-browser-qa.mjs` на disposable PostgreSQL 16 (loopback-only `127.0.0.1:55449`, `--rm`, анонимный volume). Первый запуск выявил ошибку фикстуры: тестовая организация не имела обязательной строки `organization_subscriptions`, поэтому чтение PostgreSQL-сессии блокировалось; активная подписка добавлена только в изолированную QA-фикстуру.
- Полный повторный прогон PASS: UI-приход `0,5 л → 500 мл`, повторное проведение получает 409 без второго движения, барменская продажа списывает 25 мл, кальянная — 18 г, кальянщик не получает доступ к складу; также прошли оплата/split/скидки, RBAC, конкурентные запросы, reload и POS на 13 responsive ширинах. Синтаксис, purchase-documents/local-role/inventory-movement/inventory-hierarchy/inventory-subdepartment/PostgreSQL-safety/migrations contracts (56) и `git diff --check` — PASS. QA venue удалён сценарием, контейнер остановлен и удалён (`docker ps -a` пуст для контейнера).
- VPS `/api/health` и `/login` отвечают HTTP 200; в браузере открыта форма входа без аутентификации. Авторизованный POS путь двух VPS сотрудников и live списание не выполнены: на тестовом заведении отсутствуют связи меню с техкартами. Нужны авторизованные сессии двух тестовых ролей и тестовая продуктовая связь; production данные/credentials не менялись.

### Ручное складское движение через UI — 01.10.2026

- Browser/PostgreSQL сценарий расширен ручным расходом из формы управления: менеджер списывает 50 мл после прихода; UI подтверждает операцию, ledger меняется ровно на −50 мл и `/inventory?view=stock` после загрузки показывает 1450 мл. Попытка списать 2000 мл возвращает 409, UI показывает понятную нехватку, ledger и остаток неизменны. Последующая барменская продажа списывает ещё 25 мл от уже изменённого баланса (итого 1425 мл); кальянная продажа списывает 18 г. Первый прогон выявил устаревший baseline в новой assert-строке; исправлено на `manualOutBalance - 25`, полный повторный browser QA PASS.

### Дополнительные PostgreSQL warehouse runtime проверки — 01.10.2026

- На отдельных disposable PG16 контейнерах, доступных только через loopback и удаляемых после прогона, повторно применены `schema.sql` + 56 migrations. `purchase-auto-order-postgres-e2e-qa.mjs` — PASS: автозаказ → черновик → частичный приход → отмена без изменения остатка → полный приход, валюация и дробные 6 знаков. `purchase-payment-postgres-api-qa.mjs` — PASS: receipt → payable, частичная/полная оплата, конкурентная защита баланса и идемпотентный повтор. `recipe-depletion-pg-runtime-qa.mjs` — PASS, 292 assertions: receipt/payment, упаковочные конверсии, барные/кальянные рецептуры, продажа/списание/COGS, rollback при сбое, повтор/дубликат, финансовые итоги.
- Независимый QA reviewer подтвердил границы browser сценария и назвал непокрытые поверхности: конкурентные движения склада и сквозное live VPS POS. Warehouse-domain reviewer подтвердил local receipt/depletion evidence и VPS blockers. CodeHealth review итогового scoped diff: блокирующих замечаний нет; тестовый script синтаксически валиден, scoped `git diff --check` чистый, статический поиск не обнаружил секретов.

## 2026-09-29 — локальная demo-база и исправление финансовой аналитики

- Цель: наполнить только локальную PostgreSQL базу фиктивными данными для UI-проверки сотрудников, меню, техкарт, склада, зала/POS, гостей, броней, смен, заказов, оплат, зарплаты, расходов, задач и поставок.
- Данные: добавлен повторно применимый набор `output/demo-seed.sql` (каталог `output/` игнорируется Git). Все новые записи отмечены `DEMO •`/`demo_*`; реальные контакты и учётные данные не добавлялись. Существующие сиды заведения, пользователей и 66 позиций меню сохранены; в каждой зоне есть демонстрационный стол.
- Диагноз: финансовая страница падала целиком при PostgreSQL-аналитике: `GROUP BY` ссылался на алиасы (`staff_name`, `product_name`), а all-time start date из `pg` приходил как JS `Date`, обрезался до `Tue Sep 22` и давал `invalid input syntax for type date`.
- Исправление: `server.js` группирует по исходным `COALESCE`-выражениям; all-time SQL форматирует дату через `to_char(..., 'YYYY-MM-DD')` до передачи в pg-драйвер.
- Изменённые tracked-файлы: `server.js`, `style.css`, `dist/style.css`, `docs/ai-team/WORK_LOG.md`. CSS исходник синхронизирован с публикационной копией через штатный `sync-published-assets.mjs`. Семена в output не входят в Git.
- Проверки: повторное применение фикстуры — PASS без дубликатов; все связи синтетических записей вставлены; исправленный SQL группировки — PASS; локальный Docker CRM health — HTTP 200; finance summary, shifts, analytics `days=all` и `days=7`, dashboard shift KPIs — HTTP 200 после исправления. В UI видны все 4 техкарты, 4 синтетических сотрудника в базе, расходы/начисления, 3 зала и открытый заказ; экран финансовой сводки восстановлен.
- Responsive/UI: проверен вход и 18 маршрутов; на рабочем экране проверены 320×568, 390×844, 768×1024, 1440×900 и базовая матрица 21 viewport через дерево доступности. Найдено и исправлено сжатие карточек столов на планшете 768×1024; повторный скриншот подтверждает читаемые подписи DEMO 4/5. Сервер/VPS, GitHub, домен и HTTPS не менялись.
- Проверки: 
ode --check server.js`, 
ode --check app.js`, `finance-api-consistency-contract.mjs`, `visual-page-rules-contract.mjs`, `visual-live-defects-contract.mjs`, `qa:header` с source/dist parity и `git diff --check` — PASS. Docker CRM остаётся healthy; маршруты администратора, заказов, гостей, броней, доставки, 7 складских видов, финансов, интеграций, сети и платформы открываются без auth/error экрана.
- Справочники и формы: локальная seed fixture дополнена четырьмя синтетическими подцехами и четырьмя категориями (по одному для каждого отдела), повторное применение идемпотентно. В браузере проверены фильтр отдела, зависимый выбор подцеха, раскрытие/сброс пустых форм и HTML-валидация обязательных полей; fixture формы создания оставлена без отправки.
- Заказы и брони: в `/api/orders` добавлено совместимое nullable поле `tableName` с tenant-bound JOIN, который отдаёт имя только при совпадении зоны заведения; `/orders` показывает короткий 8-символьный суффикс UUID и понятную подпись стола, ищет по короткому номеру и имени стола. Даты брони ISO приводятся к `YYYY-MM-DD` перед отображением. Добавлен `scripts/order-journal-display-contract.mjs`. Проверены фильтр закрытого статуса, сортировка, поиск по номеру/столу, мобильные карточки 390×844, бронирования за все даты, поиск и раскрытие селектора столов с вместимостью/депозитом; пустая отправка брони остановлена встроенной проверкой браузера.
- Responsive: визуально проверены брони и журнал заказов на desktop и 390×844; рабочий планшетный зал проверен на 768×1024. Остальные элементы 14 основных страниц не были исчерпывающе нажаты на всех viewport; физическое устройство Fold/TV отсутствует, эта запись не утверждает полный визуальный gate.
- Дополнительные проверки после правок: 
ode --check db.js`, 
ode --check portal.js`, новый order display contract, финансовый контракт, визуальные контракты, `qa:header` и `git diff --check` — PASS; контейнер пересобран, PostgreSQL-заказы и `/api/orders` показывают три валидные строки/стола, `tableName` пробит в UI. Полная проверка отсутствующего стола и пустой PostgreSQL-задачи — контрактно предусмотрены fallback; отдельная пустая база не проверялась.
- Зафиксированные изменения локальны в рабочем дереве; commit, GitHub push, VPS/deploy, домен и HTTPS не выполнялись.

### Продолжение аудита CRM: ссылка контроля смены — 29.09.2026

- В маршруте `/admin#shift-control` найдено, что заголовок страницы оставался общим, а персональная настройка могла скрыть сам блок смены при прямом переходе из финансов.
- Исправлен focused view, заголовок и прокрутка к панели при прямой загрузке и `hashchange`; активный deep link сохраняет панель видимой при асинхронном применении dashboard preferences, даже если модуль скрыт на обычной главной. Доступ и API не менялись.
- Добавлен `scripts/dashboard-shift-deeplink-contract.mjs`; источник синхронизирован в `dist/portal.js`, Docker CRM пересобран. Прямой URL и возврат после перехода через `/finance` проверены в браузере на ширине окна 2560px; заголовок «Контроль смены», видимость target и позиция прокрутки подтверждены. Проверка варианта с явно выключенной персональной настройкой в браузере не проведена.
- Код-ревью deep-link исправления: без замечаний. Deep-link, order display, local deploy contracts, JS syntax и `git diff --check` — PASS. Полный local acceptance ранее прошёл на отдельном disposable memory API, код возврата 0; PostgreSQL migration runtime suite была пропущена при отсутствии отдельного PG test URL.
- Полный статический responsive sweep 29 экранов × 4 окна (390×844, 768×1024, 1440×900, 2560×1440) не выявил горизонтального переполнения DOM. Он не заменяет скриншотную проверку каждого окна: Fold-cover/main device emulation, все масштабы zoom, TV 3840 и exhaustive обход каждого control не завершены. Физический Fold отсутствует.
- Ошибка в локальном acceptance-контракте `.env` исправлена: допускается игнорируемый локальный файл, проверяется только что файл не tracked; содержимое не читалось. Исправлена LF/CRLF устойчивость floor contract. Два runtime acceptance прогона на изолированном memory server завершились PASS после этих исправлений.
- Все правки остаются локальными; production/VPS, GitHub, домен, HTTPS и demo PostgreSQL данные не менялись.
- Продолжение по найденному P1 склада: loader/submit/retry handlers перемещены из `renderDashboard()` в `renderInventory()` после создания `#premixPanel`; история загружается даже при отсутствии write-form, а read-only GET использует только `/api/inventory/premixes`.
- `inventory-premix-load-state-qa.mjs` теперь проверяет wiring к inventory route, error/retry, успешную подготовку и read-only историю; проверка layout состояния наличия без stock добавлена. В локальном PostgreSQL UI после сборки видны 1 техкарта, 1 партия, 0 складских позиций, понятная подсказка «Нет складской позиции…», рабочая кнопка перехода к добавлению, загруженная партия, выпуск отключён по корректной причине. Форма добавления позиции открылась и была отменена без сохранения.
- Повторный скриншот подтвердил разнесённые заголовок/пояснение/CTA подсказки; исправлен `.premix-setup-guidance` layout, CSS синхронизирован. В read-only unit fixture проверено, что история отображается без write-form и без вызовов рецептур/остатков.
- Полный `local-acceptance.ps1` повторно PASS на новом изолированном in-memory сервере `3129` с тестовым API limit 10000; runtime suite прошла вплоть до CRUD, login/lock/PIN, payroll, payments, transactions и migrations. PostgreSQL migration runtime осталась skipped без отдельного test URL. Предыдущий чистый запуск упёрся в rate-limit; более ранний использованный сервер — в session limit; свежий запуск избежал обоих тест-средовых ограничений.

## 2026-09-28 — постоянный справочник финансовых категорий

- Диагноз: `/api/finance/categories` хранил категории только в памяти; форма расхода вводила свободный текст и не связывалась со справочником; страница не позволяла увидеть/восстановить архив и показывала чужой финансовым категориям блок правил.
- Исправление: миграция `044_finance_categories.sql` добавляет хранимый по заведению справочник, уникальность активного имени для вида, nullable связь расходов и tenant-bound FK. Категории создаются/переименовываются/архивируются/восстанавливаются; переименование обновляет связанные исторические подписи транзакционно, существующие текстовые расходы остаются без предположительной привязки. Форма расходов теперь выбирает активную категорию вида «Расход».
- Файлы: `server.js`, `portal.js`, `style.css`, `dist/portal.js`, `schema.sql`, `migrations/044_finance_categories.sql`, `scripts/finance-categories-postgres-api-qa.mjs`, `scripts/postgres-qa.mjs`, `scripts/migrations-pg-upgrade-qa.mjs`, `scripts/finance-required-marker-contract.mjs`, `FINAL_ACCEPTANCE_REPORT.md`.
- API/БД: существующие `/api/finance/categories` и `/api/expenses` принимают `categoryId`; migration 044. Старые маршруты не заменялись; текстовая совместимость сохранена для старых расходов.
- Проверки: Docker Desktop Engine 29.8.0, изолированная PostgreSQL 16, schema + 44 миграции, migration upgrade/replay QA — PASS; полный PG QA — 11 suites PASS; локальный полный acceptance — PASS после актуализации контракта категории с input на select; CRUD, migration contract, JS syntax, source/dist sync и `git diff --check` — PASS. Только synthetic data.
- Ограничения: свежий браузер/Fold screenshot QA не выполнен; VPS/production не подключались. Связанные документы расходов и фактическая финансовая приёмка остаются отдельными задачами.
- Commit: `68b88f1a99e546c63c77daff8980248f81c44128` (`Persist finance categories and link expenses`).

Каждый пакет изменений фиксируется координатором: цель, роли, изменённые файлы, проверки, результат и commit.

## 2026-09-28 — Персистентность групп лояльности и гостевых балансов

- Диагноз: production-ветки `/api/discount-groups` использовали только in-memory массив; карточка гостя принимала `discountGroupId`, `bonusBalance` и `depositBalance`, но PostgreSQL INSERT/UPDATE/SELECT их не сохранял и не возвращал. После перезапуска сведения о программе и балансе терялись.
- Исправление: добавлена `migrations/043_guest_discount_groups.sql` и синхронизирован `schema.sql`; группы ограничены заведением уникальными UUID, составным FK защищено от привязки чужой группы. API групп и клиентов теперь читает/записывает PostgreSQL, валидирует диапазоны и permissions; на списке гостей читается сохранённое назначение. Для пустой программы в редакторе гостя явно задан пункт «Без программы».
- Изменённые файлы: `server.js`, `portal.js`, `dist/portal.js`, `schema.sql`, `migrations/043_guest_discount_groups.sql`, `scripts/postgres-qa.mjs`, `scripts/guest-loyalty-postgres-api-qa.mjs`, `FINAL_ACCEPTANCE_REPORT.md`.
- Миграция: 043 добавляет `guest_discount_groups`, `guests.discount_group_id` и `guests.deposit_balance`; исторические данные не очищает и не пересчитывает. API маршруты не менялись, изменён способ хранения в существующих `/api/discount-groups` и `/api/clients`.
- Проверки: чистая изолированная PostgreSQL 16 база, `schema.sql` + 43 миграции; полный `scripts/postgres-qa.mjs` — PASS (10 suites), включая role/tenant checks, сохранение/чтение guest program и балансов; полный `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3147` — PASS; синтаксис JS, дизайн/навигация контракты и `git diff --check` — PASS. Disposable DB/containers removed.
- Результат и пределы: существующие группы, скидки, бонусы и депозит сохраняются в PostgreSQL. Автоматическое применение правил к чеку по подразделению/позиции, исключения и модель зачёта депозита остаются незавершённой частью исходного пункта 18. Визуальный браузер/Fold повтор и production/VPS проверку в этом пакете не выполняли.
- Commit: pending review.

## 2026-09-28 — Повтор QA после восстановления Docker

- Предыдущий прогон на Docker Desktop Engine `29.8.0` применил 42 миграции и прошёл 9 suites; после миграции 043 его актуализировал пакет выше (43 миграции, 10 suites).
- Исправлено накопление `hashchange` обработчиков: повторный рендер заменяет предыдущий listener; роль-предикат PG теста читается из production helper, не дублируется. Полный `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3146` на отдельном in-memory сервере — PASS после этих исправлений.
- Контракты шапки, навигации, страницы склада и дизайн-правил, синтаксис изменённых JS, `git diff --check` — PASS. Browser Use заблокировал локальную preview-вкладку, поэтому последовательные hash-переходы не проверены в браузере; новые скриншоты не архивированы. Старые 175 кадров предшествуют CSS rev 298.
- VPS/production не подключались. 34 требования остаются с консервативными статусами; полный визуальный Fold и реальный production business QA ещё необходимы.

## Пакет 1/15 — единый регистр названий позиций

- Цель: отображать названия товаров, ингредиентов и категорий с заглавной буквы в начале каждого слова во всех затронутых рабочих и административных экранах, сохраняя исходные значения в БД и поиске.
- Реализация: общий форматтер показа в административном портале; аналогичное форматирование каталога и заказа сотрудника; добавлен cache-busting для `portal.js` и `app.js`.
- Файлы: `portal.js`, `app.js`, HTML-шаблоны со ссылками на эти скрипты.
- БД/миграции/API: не менялись.
- Проверка: синтаксис 
ode --check` для обоих скриптов; визуальная проверка после публикации.
- Статус: локальная реализация завершена; пакет `1/15`.

## Пакет 2/15 — понятные названия разделов склада

- Цель: заменить внутренние сокращения и расплывчатые подписи на понятные названия для управляющего и сотрудников.
- Термины: «Технологические карты» — полное профессиональное название; «Пополнение запасов» — рекомендации и заявка, без обещания автоматической отправки; «Поставки и списания» — операции склада.
- Обновлён обязательный промпт страницы склада: зафиксированы названия всех семи вкладок, стиль подписей и правило «действие + объект» для кнопок.
- Файлы: `portal.js`, `WAREHOUSE_PAGE_PROMPT.md`, HTML-шаблоны со ссылкой на обновлённый `portal.js`.
- БД/миграции/API: не менялись; ключи и маршруты сохранены.
- Проверка: синтаксис клиентского скрипта и визуальное открытие production-раздела после публикации.
- Статус: локальная реализация завершена; пакет `2/15`.

## Пакет 3/15 — ограничение интеграций Telegram

- Цель: зафиксировать текущий объём интеграций: поддерживается только подготовка Telegram; остальные внешние сервисы не разрабатываются.
- Реализация: интерфейс интеграций и диагностика показывают только Telegram; API и demo fallback возвращают только Telegram; детализация неизвестных интеграций недоступна; архитектурный документ отражает текущий scope.
- Файлы: `portal.js`, `server.js`, `API.md`, `ARCHITECTURE.md`, HTML-шаблоны со ссылкой на обновлённый `portal.js`.
- БД/миграции: не менялись. API: существующие GET-маршруты интеграций ограничены Telegram, формат его статуса сохранён.
- Проверка: 
ode --check portal.js`, 
ode --check server.js`, `git diff --check`; поиск подтвердил, что рабочий UI/API больше не перечисляет другие интеграции. В production-браузере пока загружена предыдущая версия, поэтому визуальная проверка обновлённого экрана ожидает публикации пакета.
- Статус: локальная реализация, позиция `3/15`; Telegram остаётся «В подготовке», так как работающего подключения к боту в текущем коде нет.

## Пакет 4/15 — стабильная толщина шрифта бокового меню

- Причина: для активного пункта «Главная» в админ-панели было задано `font-weight: 800`, тогда как остальные пункты использовали `500`. При переключении разделов толщина резко менялась.
- Исправление: активное состояние теперь сохраняет общий вес шрифта `500`; выбранный пункт по-прежнему заметен фоном и цветом. Обновлён cache-busting CSS.
- Файлы: `style.css`, HTML-шаблоны со ссылкой на обновлённый CSS. БД и API не менялись.
- Проверка: сверены базовое и активное CSS-правила; локальный браузер показал `font-weight: 500` у обычных и активного пунктов; добавлена проверка против регрессии в `scripts/sidebar-navigation-contract.mjs`; `git diff --check` проходит. Визуальная проверка production после публикации пакета.
- Статус: локальная реализация, позиция `4/15`.

## Пакет 5/15 — синхронизация production-артефактов и контрактов

- Диагноз: несколько проверок отставали от текущих названий склада и версий CSS/JS; каталоги `dist/` также содержали более старые шаблоны и статические файлы. Это создавало ложные падения QA и риск публикации устаревшего интерфейса.
- Исправление: синхронизированы HTML-маршруты и файлы `style.css`, `portal.js`, `app.js` с корневыми источниками; контракты обновлены под актуальные термины, ревизии ресурсов и название премиксов.
- Файлы: `dist/**`, `scripts/local-design-contract.mjs`, `scripts/visual-page-rules-contract.mjs`, `scripts/premix-contract.mjs`. БД/API не менялись.
- Проверка: все три обновлённых контракта пройдены; ранее в этом проходе также пройдены структура сайта, адаптивность Fold, навигация, задачи/гости/склад и кликабельность.
- Статус: позиция `5/15`.

## Пакет 6/15 — личный оборот сотрудника и удаление заказа

- Диагноз: экран финансов сотрудника строил администраторские блоки расходов после частичного скрытия, endpoint отчёта не ограничивал SQL-выборку конкретным сотрудником, а форма удаления заказа не обрабатывала сообщения API по коду ошибки и могла обращаться к уже завершённому DOM event.
- Исправление: для рядового сотрудника сделан отдельный экран «Мой оборот сегодня» без других финансовых блоков; сервер ограничивает его показатели сегодняшней датой и заказами текущего сотрудника. Отчёт для сотрудника возвращает только оборот и число чеков. В сценарии удаления добавлена причина и обязательный выбор списания; обработчик ошибки показывает точные причины и стабильно включает кнопку после завершения модального окна.
- Файлы: `portal.js`, `server.js`, `app.js`, `style.css`, `API.md`, `scripts/order-delete-qa.mjs`, `scripts/ui-scenarios-contract.mjs`, `scripts/finance-employee-contract.mjs`, HTML и `dist/**` для актуальных ссылок и артефактов. Миграций нет.
- Проверки: syntax checks; `ORDER DELETE QA`; `WAREHOUSE QA` (59 проверок); contracts ролей, финансов сотрудника, UI сценариев, задач, безопасности, техкарт, склада, структуры сайта, адаптивности Fold, навигации и кликабельности. Все перечисленные проверки прошли.
- Статус: локальная реализация, позиция `6/15`; визуальный production smoke ожидает плановой публикации пакета.

## Пакет 7/15 — порядок и значки бокового меню

- Диагноз: зал, основной рабочий экран заведения, стоял после справочников; «Заказы» и «Задачи» использовали один символ, как и «Финансы» с лояльностью. Из-за этого список не отражал ежедневный маршрут работы, а некоторые пиктограммы были неоднозначны.
- Исправление: первым в операциях стоит «Зал», далее журнал заказов, бронирования, гости и доставка. Группы «Контроль», «Команда» и «Система» сохранены. Добавлены отдельные значки для схемы столов, журнала, карточки персонала, списка задач, лояльности, финансовой аналитики и Telegram; пункт интеграции теперь называется конкретно «Telegram». Существующие ссылки меню теперь обновляют подпись, значок и permission вместе, а не только меняют порядок. Порядок закреплён в карте сайта и контракте навигации.
- Для полноэкранного компьютера ширина панели теперь плавно растёт от 248 px на обычном ноутбуке до 280 px на широком мониторе; в рабочем режиме сотрудника применяется тот же размер. Браузерная проверка выявила, что общее правило не перекрывало более конкретный класс панели сотрудника; селектор уточнён и повторно проверен.
- Файлы: `portal.js`, `app.js`, `assets/tabler-icons.svg`, `SITE_MAP.md`, `scripts/sidebar-navigation-contract.mjs`, `scripts/local-design-contract.mjs`, HTML-шаблоны и `dist/**` для cache-busting и публикационной копии. Миграций и API-изменений нет.
- Проверка: контракты боковой навигации и локального дизайна; браузерная проверка меню администратора на 1440×900 и 1920×1080, рабочей панели на 1920×1080, вычисленной ширины 248/280 px, порядка, значков и стабильной жирности; синтаксис JS; проверка SVG-значков; `git diff --check`; копия CSS синхронизирована в `dist/`.
- Статус: локальная реализация, позиция `7/15`; ожидает общего публикационного пакета.

## Пакет 8/15 — владелец связки API и интерфейса

- Диагноз: UI подключал API, backend описывал серверные маршруты, архитектор — общие зависимости, QA проверял сценарии; однако конкретный владелец согласованности между контрактом, состояниями экрана, правами, сохранением и повторным чтением не был назначен.
- Решение: эту сквозную функцию закрепили за системным архитектором как «Интегратор API–интерфейса» внутри его существующей роли. Frontend и backend подтверждают реализацию контракта, QA независимо проходит полный сценарий. Число профилей команды остаётся 15.
- Файлы: `.codex/team/team.json`, `.codex/team/roles/system_architect.md`, `docs/AI_TEAM.md`, `docs/AI_TEAM_WORKFLOW.md`, `DEVELOPMENT_WORKFLOW.md`, `scripts/ai-team-contract.mjs`. Изменений БД/API продукта нет.
- Проверка: 
ode scripts/ai-team-contract.mjs`, синтаксис изменённого контракта, `git diff --check`.
- Статус: локальная реализация, позиция `8/15`; ожидает общего публикационного пакета.

## Пакет 9/15 — приветствие по времени и часовому поясу заведения

- Диагноз: заголовок главной панели администратора всегда содержал «Добрый вечер», независимо от времени, местоположения заведения и текущей страницы.
- Исправление: приветствие рассчитывается по часовому поясу активного заведения и обновляется при получении его настроек и далее раз в минуту. Интервалы: 05:00–11:59 — утро, 12:00–17:59 — день, 18:00–21:59 — вечер, 22:00–04:59 — ночь. Пока часовой пояс неизвестен/некорректен, используется нейтральное «Здравствуйте». Приветствие размещено только в заголовке главной панели.
- Файлы: `portal.js`, `VISUAL_PAGE_RULES.md`, `scripts/dashboard-greeting-contract.mjs`, `scripts/local-design-contract.mjs`, HTML-маршруты и `dist/**` для ревизии кеша. БД и API продукта не менялись.
- Проверка: тест границ всех четырёх периодов, преобразования одного UTC-момента для Екатеринбурга и Москвы, неверного часового пояса, расположения заголовка; контракт локального дизайна, синтаксис JS и `git diff --check`.
- Статус: локальная реализация, позиция `9/15`; ожидает общего публикационного пакета.

## Пакет 10/15 — единое сворачивание бокового меню

- Диагноз: группы меню имели разный вертикальный ритм и находились в разных контейнерах. На узких экранах скрипт принудительно раскрывал их, а активная группа повторно раскрывалась после обновления, поэтому сохранённое состояние пользователя терялось.
- Исправление: все многостраничные группы собраны в один упорядоченный контейнер и используют общие отступы, разделители и выравнивание; состояние каждого заголовка сохраняется по пользователю и восстанавливается при перезагрузке. В компактном меню для групп показаны доступные значки, а в выдвижном мобильном меню — подписи. Активный маршрут больше не отменяет выбор сворачивания.
- QA-регрессии: контракт режима обновлён с устаревшего названия «Зал и заказы» на «Зал»; smoke-тест интеграций теперь проверяет текущий единственный канал Telegram вместо удалённого ожидания ЕГАИС. Контракт Fold обновлён под компактные раскрываемые значки.
- Файлы: `portal.js`, `style.css`, `dist/**`, HTML-шаблоны с ревизиями ресурсов, `scripts/sidebar-navigation-contract.mjs`, `scripts/fold-responsive-contract.mjs`, `scripts/mode-navigation-contract.mjs`, `smoke-test.ps1`, `scripts/local-design-contract.mjs`. Изменений БД и API продукта нет.
- Проверка: локальный acceptance прошёл для 14 маршрутов, ресурсов, ролей, входа, CRUD, склада, доставки, гостей, финансов и 10 заказов; дополнительно прошли 59 складских проверок, QA задач и безопасности, контракты премиксов, техкарт, личных финансов, приветствия, Fold, миграций, сети и меню; 
pm audit` сообщил 0 уязвимостей; 
pm pack --dry-run`, синтаксис и `git diff --check` прошли.
- Статус: локально проверено, позиция `10/15`; готово к запрошенному коммиту, общий пакет ещё не достиг порога production-публикации.

## Пакет 11/15 — главные показатели администратора и управляющего

- Диагноз: карточка выручки показывала декоративный мини-график без временного ряда, тесную красную карточку ожидаемых оплат и несогласованные по плотности подписи. Выбор из трёх персональных стилей делал основную сводку непоследовательной на разных экранах. «Низкие остатки» не объясняло, что именно нужно сделать.
- Решение дизайн- и продуктовой проверки: сохранить четыре ежедневных показателя без добавления неподтверждённых цифр; сделать оплаченную выручку визуальным лидером с увеличенной типографикой, сумму «К оплате» — вторичной частью той же карточки, а заказы, бронирования и позиции к пополнению — равными по весу операционными карточками. Убрать фиктивный график и настройку, которая меняла структуру карточки. API, расчёт показателей и роли не менялись.
- Исправление: унифицированы высота, заголовки, значения и подписи KPI; выручка выделена размером числа, сумма к оплате отделена тонким разделителем и явно не называется выручкой; складной показатель переименован в «Нужно пополнить» с пояснением «Позиции ниже минимума». Повторный нижний ряд показателей удалён; вместо него оставлены способы оплат, чистая прибыль и средний чек за последние семь дней, загрузка зала и популярные позиции. При отсутствии оплат показывается объясняющее пустое состояние. До ширины 1366 px используется сетка 2×2, на телефоне — один столбец.
- Файлы: `portal.js`, `style.css`, `VISUAL_PAGE_RULES.md`, `scripts/dashboard-kpi-design-contract.mjs`, `scripts/local-insights-contract.mjs`, `scripts/local-preferences-contract.mjs`, `docs/ai-team/DECISIONS.md`, `docs/ai-team/WORK_LOG.md`, HTML-кэш-ревизии и `dist/**`. Изменений БД и API нет.
- Проверки: контракты смысла показателей и настроек, синтаксис JavaScript, 12 инвариантов Fold, локальный браузерный просмотр главной при 1280×720 без ошибок в консоли; `git diff --check`.
- Статус: локальная реализация, позиция `11/15`; production не публиковался.

## Пакет 12/15 — богатый демонстрационный сценарий CRM

- Цель: дать возможность проверять дизайн и связанные экраны на изменяющихся, но воспроизводимых данных без записи в рабочую базу.
- Реализация: на loopback-адресе `/admin?demo=full` сохраняется предыдущая сессия и локальные записи, после чего сценарий переключает вкладку на изолированную браузерную демо-сессию с заказами за неделю и несколькими открытыми заказами, тремя способами оплаты, тремя зонами и 13 столами, сотрудниками разных ролей, гостями, бронями, остатками ниже/на/выше минимума, движениями склада, многокомпонентными техкартами и ежедневными расходами. Демо-аналитика учитывает затраты ингредиентов и расходы отдельно от выручки; счётчик броней учитывает только подтверждённые брони на сегодня. Исправлен локальный демо-fallback: журнал заказов читает тестовые записи, карточка гостя показывает связанные заказы и брони, рабочая схема зала читает те же демо-зоны и синхронную демо-смену, а дата и время в шапке сотрудника обновляются динамически. `/admin?demo=restore` возвращает сохранённый снимок и прежнюю сессию. Серверная БД не меняется.
- Файлы: `portal.js`, `app.js`, `dist/portal.js`, `dist/app.js`, HTML-ревизии скриптов, `scripts/demo-scenario-contract.mjs`, `README.md`, `docs/ai-team/WORK_LOG.md`.
- Проверки: фабричный контракт сценария проверяет связи заказа со столом, состав и сумму заказа, оплаты, разные складские уровни, роли и состояния брони; 
ode --check portal.js`; ручной визуальный проход в локальном браузере после загрузки демо набора.
- Статус: локально проверено, позиция `12/15`; серверная база не менялась.

- Проверка демо финансовой страницы выявила, что расходы учитывались в аналитике, но их список был пустым. Добавлены локальные GET/POST маршруты /api/expenses: тестовые операции отображаются в журнале, а новые записи попадают в ту же модель и аналитику. Убрана жёстко заданная дата из шапок административных страниц, дата теперь выводится текущая. Проверены финансовая сводка и форма расходов в локальном сценарии.

- Времена сегодняшних заказов и открытия демо-смены привязаны к фактическому моменту запуска сценария, чтобы не появлялись будущие события. Повторно загруженный сценарий визуально проверен на главной и в финансах: оплаченные и ожидающие суммы, себестоимость, расходы, чистая прибыль, способы оплаты и семь операций расходов отображаются согласованно.

## Пакет 13/15 — реальная оркестрация работы Codex

- Диагноз: репозиторий описывал 15 ролей и этапы процесса, но не говорил, кто фактически запускает субагентов, как избежать конфликтов редактирования и что происходит, когда нативное делегирование недоступно.
- Решение: координатором является основной Codex текущей задачи; доступные независимые роли запускаются нативными субагентами, максимум три одновременно. Добавлен последовательный режим как запасной вариант. Отдельный фоновый сервис или Agents API не добавлялся: для текущей разработки он потребовал бы отдельной инфраструктуры и учётных данных, а непрерывная работа между задачами этим решением не заявляется.
- Автономность: обычные обратимые локальные задачи и их проверки ведутся без рутинных вопросов/уведомлений. Требования к миграциям, безопасности, подтверждённым удалениям и прохождению release gate сохранены.
- Файлы: `AGENTS.md`, `docs/AI_ORCHESTRATOR.md`, `docs/AI_TEAM.md`, `scripts/ai-team-contract.mjs`, `docs/ai-team/WORK_LOG.md`. Изменений БД, API CRM и серверных файлов нет.
- Проверка: 
ode scripts/ai-team-contract.mjs`, 
ode --check scripts/ai-team-contract.mjs`, `git diff --check`.
- Статус: локальная реализация, позиция `13/15`; production не публиковался.

## Пакет 14/15 — постоянный владелец гигиены кода

- Диагноз: QA подтверждал пользовательские сценарии, а debugger устранял конкретные дефекты; систематической проверки чистоты diff, случайных артефактов, мёртвого/дублированного кода и актуальности анализаторов как обязательного этапа не было.
- Решение: добавлен `code_health_engineer` как шестнадцатая профильная роль. Она участвует до и после каждой программной правки и проверяет diff перед релизом; не начинает несогласованные массовые рефакторинги и передаёт продуктовые изменения владельцам модулей. Реестр долгов отделяет подтверждённые находки от старых рисков.
- Файлы: `.codex/team/team.json`, `.codex/team/roles/code_health_engineer.md`, `AGENTS.md`, `docs/AI_TEAM.md`, `docs/AI_TEAM_WORKFLOW.md`, `docs/AI_ORCHESTRATOR.md`, `docs/code-health/README.md`, `.github/workflows/ai-team-contracts.yml`, `scripts/ai-team-contract.mjs`, этот журнал и `docs/ai-team/DECISIONS.md`. Изменений БД, API CRM или серверного кода нет.
- Проверки: новая роль провела независимый read-only review и не нашла блокирующих замечаний; уточнено, что CI проверяет наличие профиля и правил, но не факт запуска роли. Успешно прошли 
ode scripts/ai-team-contract.mjs` (16 ролей, максимум 3 runtime-агента), 
ode --check scripts/ai-team-contract.mjs` и `git diff --check`. 
pm audit` не запускался: зависимости не менялись, а это не был отдельный плановый аудит зависимостей.
- Статус: локальная реализация, позиция `14/15`; production не публиковался.

## Пакет 15/15 — владелец бокового меню и верхней панели

- Диагноз: ответственность за меню была частично у навигационного кода, а за оформление шапки — у дизайна, но единого владельца общего каркаса на всех маршрутах и режима сотрудника не назначили. Регрессионный контракт проверял активность/порядок меню, но не наличие общей шапки по страницам и ключевые размеры её элементов.
- Решение: системный архитектор назначен постоянным владельцем общего каркаса (меню, маршруты, состояния и верхняя панель). Design lead отвечает за визуальную сторону, frontend — за реализацию, QA и code-health инженер — за проверки. Добавлены контрактные проверки наличия общего меню и шапки на CRM-шаблонах, мобильных отступов верхних панелей и единого touch target 44 px.
- Файлы: `.codex/team/team.json`, `.codex/team/roles/system_architect.md`, `AGENTS.md`, `DEVELOPMENT_WORKFLOW.md`, `docs/AI_TEAM.md`, `docs/AI_TEAM_WORKFLOW.md`, `docs/AI_ORCHESTRATOR.md`, `scripts/ai-team-contract.mjs`, `scripts/sidebar-navigation-contract.mjs`, этот журнал и `docs/ai-team/DECISIONS.md`. Изменений БД, API и визуальных компонентов сайта нет.
- Проверки: 
ode scripts/sidebar-navigation-contract.mjs`, 
ode scripts/ai-team-contract.mjs`, 
ode scripts/site-structure-contract.mjs`, 
ode scripts/visual-page-rules-contract.mjs`, 
ode scripts/fold-responsive-contract.mjs`, 
ode scripts/mode-navigation-contract.mjs`, 
ode --check` обоих изменённых скриптов, `git diff --check`; независимый read-only review роли code health. Все проверки прошли.
- Статус: коммит `6fcaf523d126d3ba6a7bb19457f6d2431be8df87` отправлен в `origin/main`. Production не развёрнут: обязательное условие `COOKIE_SECURE=true` не выполнено, а отключать его для HTTP нельзя. Production-проверка не заявляется.

## Пакет 1/15 — связать частичную приёмку с автозаказом

- Диагноз: поступление по автозаказу могло обходить документ закупки, а отмена заявки могла пересечься с сохранением связанного черновика. Выпуск премикса не пересчитывал стоимость выхода.
- Решение: приёмка через документ синхронно обновляет полученное количество и статус заявки; неполученный остаток остаётся открытым. Устаревший прямой перевод заявки в «получено» отклоняется. Создание, проведение, редактирование связанной накладной и отмена заявки сериализованы блокировкой её строки; отмена запрещена при связанном черновике. Выпуск премикса агрегирует повторяющиеся ингредиенты, проверяет весь состав и обновляет остаток/стоимость одной транзакцией.
- UX: уточнены подписи формы, контекст «Поступление по автозаказу», подсказки по единице закупки и обязательным полям. Зафиксирован внешний референс Poster: меню производства и складские операции — соседние раскрываемые области; детали — в `docs/POSTER_DEMO_REFERENCE_AUDIT_2026-09-25.md`.
- Файлы: `server.js`, `db.js`, `portal.js`, `style.css`, связанные контракты и QA-скрипты, `INVENTORY_IMPLEMENTATION_PLAN.md`, референсный аудит, `dist/**` и HTML-шаблоны для текущих cache revisions. Новых миграций нет; текущая реализация использует схему существующей миграции 038, которую ещё надо прогнать на копии production-БД.
- API: новые маршруты не добавлялись. Изменены проверки существующих маршрутов документов закупки и PATCH автозаказа: прямая приёмка отклоняется; отмена возвращает конфликт при связанном черновике; проведение частичного поступления обновляет строки и статус заявки.
- Проверки: 
ode --check` для изменённых JS-файлов; `purchase-documents-contract.mjs`, `premix-contract.mjs`, `inventory-responsive-contract.mjs`, `fold-responsive-contract.mjs` (12 проверок), `inventory-movement-transaction-qa.mjs`, `warehouse-qa.mjs` (53 проверки), `local-design-contract.mjs`, `site-structure-contract.mjs`, `visual-page-rules-contract.mjs`, `sidebar-navigation-contract.mjs` и `header-shell-contract.mjs`. В изолированном браузерном demo проведено частичное поступление 1 кг на 680 ₽; экран подтвердил создание документа и движение +1 кг. CodeHealth и DesignQA сделали read-only review; блокирующих дефектов в транзакционной отмене не нашли. Риск: связанная отмена пока не прошла полноценный DB integration test; автоматическая отмена заявки при наличии черновика проверяется контрактом, а пиксельная оценка ограничена локальной демо-проверкой.
- Статус: локальная правка, пакет `1/15`; production не изменялся и не развёртывался.

## Пакет 2/15 — иерархия «Меню» и «Склад»

- Цель: сделать навигацию раздела склада понятной по предметной модели и связать выбранную область с адресом страницы.
- Причина: семь внутренних вкладок дублировали глобальную навигацию, а состояние выбранного раздела не сохранялось в URL и истории браузера.
- Решение: боковое меню разделено на раскрываемые группы «Меню» (каталог товаров, технологические карты) и «Склад» (остатки, пополнение запасов, поставки и списания, заготовки и премиксы, цеха и категории). Финансы оставлены отдельным прямым пунктом: это самостоятельный раздел, а одиночная группа создавала бы лишний уровень клика. Премиксы размещены в складе, поскольку выпуск партии списывает ингредиенты и создаёт остаток заготовки. Дублирующие вкладки страницы убраны; `?view=` поддерживает обновление, закладки и Back/Forward.
- Файлы: `portal.js`, `style.css`, шаблоны и `dist/**` для актуальных cache revisions, `SITE_MAP.md`, `SITE_TREE.md`, `site-map.json`, `VISUAL_PAGE_RULES.md`, `WAREHOUSE_PAGE_PROMPT.md`, контракты навигации и склада, этот журнал и `DECISIONS.md`.
- БД и API: миграций, изменений схемы, маршрутов API и серверного бизнес-поведения нет.
- Проверка: контракты сайта, навигации, страницы склада, премиксов, адаптивности, Fold и синхронизации шаблонов; визуальный просмотр локально на широком и мобильном viewport; переходы складских подразделов, обновление и история браузера проверены вручную.
- Ограничения: данные на экране — локальный demo-набор. Production не развёртывался.
- Повторный QA 25.09.2026: `warehouse-qa.mjs` (53), складские транзакции, документы закупок, цепочки рецептов, закрытие заказа, историческая себестоимость и премиксы — PASS.\n- Выкладка: пользователь подтвердил установку отдельного deploy SSH-ключа. Создана и проверена PostgreSQL-копия `/tmp/territory-crm-backups/crm-pre-ui-20260925T145744Z.sql.gz` (29 844 байта), сохранён старый Docker-образ `territory-crm-crm:rollback-20260925-ui` и копия предыдущих UI-файлов. Изменённые 16 HTML/JS/CSS-файлов из коммита `b7883525318cc1ba7150f4dc9a6f85e3b08efbc0` загружены; образ CRM пересобран и контейнер healthy. `/api/health` и внешний `/inventory?view=auto-orders` вернули 200, новые cache revisions `portal.js 260` и `style.css 247`.\n- БД-схема, данные, API и `.env` не менялись; миграции не запускались. `COOKIE_SECURE=false` оставлен без изменения на существующем HTTP-сайте. Визуальный production-проход выполнен без входа: показано пустое состояние склада, реальные записи не затрагивались. Коммиты исходников и документации опубликованы в `origin/main` до выкладки.

## Пакет 2/15 — выравнивание длинных подписей бокового меню

- Диагноз: при раскрытии группы «Склад» на production пункты «Пополнение запасов», «Поставки и списания» и «Заготовки и премиксы» переносились на две строки; из-за этого строки меню имели разную высоту и навигация выглядела неровно.
- Исправление: минимальная ширина боковой панели на широких экранах увеличена с 248 до 272 px (с сохранением масштабирования до 280 px); выдвижная панель на телефоне получила ширину 280 px. Это оставляет место для полных подписей и не меняет названия маршрутов.
- Файлы: `style.css`, `scripts/sync-published-assets.mjs`, `scripts/local-design-contract.mjs`, `scripts/sidebar-navigation-contract.mjs`, HTML-шаблоны и `dist/**` с CSS rev 248.
- БД/API: изменений нет.
- Проверка: на опубликованном интерфейсе воспроизведён перенос подписей в группе «Склад»; локально прошли 
ode scripts/sidebar-navigation-contract.mjs`, 
ode scripts/local-design-contract.mjs`, 
ode scripts/fold-responsive-contract.mjs` и `git diff --check`. Ручной production-скриншот после правки пока не делался.
- Статус: локальная правка, пакет `2/15`; production не развёрнут. Заодно визуально замечено, что список пунктов меню длиннее высоты экрана и прокручивается внутри фиксированной боковой панели; элементы доступны, брендинг может уходить вверх при прокрутке списка.
- Дополнение к QA: runtime-проверка на production подтвердила, что меню склада в свёрнутом состоянии прокручивалось вверх к скрытой активной ссылке, из-за чего логотип исчезал с экрана. В `portal.js` прокрутка теперь выполняется только когда активная ссылка находится в раскрытой группе; сохранённое свёрнутое состояние не меняется. Добавлен регрессионный контракт; JS rev обновлён до 261. Проверены меню в открытом и закрытом виде; исходный вид группы восстановлен после проверки.
- Локальный сервер `127.0.0.1:3107` недоступен, поэтому скриншот после локальной правки снять не удалось. Узкие размеры проверены контрактом Fold, но это не заменяет ручной визуальный QA на реальном Fold и мобильном устройстве.
- Дополнение по Fold: при внутреннем экране 651–900 px компактная панель раньше показывала одни значки без способа раскрыть подписи. Добавлены кнопка меню и overlay-панель с названиями разделов; основной экран остаётся на своём месте, ссылки также получили явные доступные подписи. Fold-контракт расширен до 14 проверок; версии ресурсов на финале: CSS 249, JS 262.
- Финальная правка Fold: кнопка меню перенесена ниже знака бренда в компактном режиме и в правый верхний угол панели при её раскрытии; контракт проверяет обе позиции. Финальная синхронизация: CSS rev 250, JS rev 262. Ручной скриншот финальной версии не сделан: локальный интерфейс на 127.0.0.1:3107 недоступен, а production остаётся на предыдущем выпуске.
- Доступность drawer: при раскрытии значок гамбургера меняется на крестик, подпись становится «Закрыть меню», клавиша Escape закрывает панель. Fold-контракт теперь проверяет эти состояния; финальный набор проверок проходит, ресурсы синхронизированы (CSS 250 / JS 263).
- Визуальная перепроверка после правок выполнена в локальном экземпляре (1280×720): бренд виден, полный список склада читается, «Технологические карты» помещается в одну строку при едином компактном кегле подпунктов; основной контент не перекрыт. Это локальные демонстрационные данные. Скриншотную проверку размеров Fold/телефона выполнить не удалось средствами текущего браузерного viewport; их CSS-контракт проходит.
- Уточнение: ранняя запись об отсутствии локального скриншота относится к состоянию до запуска временного dev-сервера; финальный desktop-скриншот просмотрен после изменений. Production по-прежнему не обновлялся.

## Пакет 3/15 — PIN сотрудника и проверка переноса данных из Fusion POS

- PIN: карточка сотрудника отправляла пустые паспортные поля вместе с изменениями профиля. Сервер требовал ключ шифрования паспорта, из-за чего сохранение профиля останавливалось до отдельного API-вызова для PIN. Пустые поля теперь не передаются; сервер игнорирует пустой паспортный объект, а явно очистить ранее заполненные паспортные данные может только владелец (API возвращает 403 остальным ролям). PIN сохраняется отдельным маршрутом. Если профиль уже сохранился, но запрос PIN завершился ошибкой, карточка сообщает о частичном результате и предлагает повторить сохранение.
- Импорт: выполнена только read-only проверка production БД и просмотр источника `territory.fusion24.ru`. Штатные экспорты `Меню.xls` и `Клиенты.xls` скачаны и отклонены: оба имеют повреждённую OLE/BIFF-цепочку (`xlrd CompDocError: Workbook corruption`). Данных в CRM не записывали, API и миграции для импорта не запускали. На production уже есть каталог и техкарты, поэтому повторный импорт без таблицы соответствий создаст дубли; импорт продаж через стандартные API также способен повторно списать остатки.
- Файлы кода: `staff-admin-card.js`, `server.js`, `portal.js`, `assets/tabler-icons.svg`, `scripts/sync-published-assets.mjs`, навигационные контракты, HTML и `dist/**`. Для премиксов добавлена отдельная иконка колбы вместо повторной иконки цеха.
- БД/API: production не менялась; миграций нет. Контракт API PIN не менялся.
- Проверки: отдельный изолированный API runtime QA создал тестовых сотрудников во временных процессах Node без БД и подтвердил: администратор получает 403 при очистке паспорта; пустой объект сохраняет прежний паспорт; владелец очищает его; при отсутствующем ключе шифрования пустое сохранение профиля и установка PIN завершаются успешно. Прошли 
ode --check` для серверных и клиентских скриптов, sidebar/header/design/Fold/staff-mode contracts и `git diff --check`. Полный `scripts/local-acceptance.ps1` также прошёл (14 маршрутов, 8 ролей, CRUD, вход, PIN-блокировка, гости/заказы, финансы и склад). Контракт PIN/паспорта дополнительно проверяет понятное сообщение о частичном сохранении.
- Дизайн-проверка раздела персонала: на desktop-снимке обнаружен пустой столбец шириной 420 px, оставшийся после переноса формы в выдвижную панель; строка и фильтры также шире своей колонки. Добавлен маркер одноколоночного списка и соответствующее правило CSS. После правки в браузере проверены 1440×1100 и 390×844: строка заняла ширину списка, мобильная страница не имеет горизонтальной прокрутки (`scrollWidth=390`). Панель создания проверена сверху и после прокрутки вниз: заголовок остаётся доступен, форма прокручивается, кнопка создания видна внизу. Проверка выполнена на локальном тестовом аккаунте и данных.
- Статус: локально проверено, пакет `3/15`; production код и данные не менялись. Для импорта нужен целый экспорт или исправленный экспортный файл из источника; текущие два файла не импортировать.

## Пакет 4/15 — единая резервная копия на выпуск

- Причина: обычный запуск выкладки не создавал резервную копию автоматически; повторный запуск одного выпуска мог плодить новые дампы.
- Решение: `deploy-vps.sh` принимает только чистый Git checkout и определяет выпуск через commit SHA плюс HMAC-хеш базовой Compose-конфигурации. До начала резервного копирования атомарно сохраняются fingerprint и label попытки, поэтому повтор после прерывания между дампом и запуском сборки использует тот же файл. Метка образа/контейнера подтверждает реально запущенную версию; одного healthcheck недостаточно. Общие lock, состояние выпуска и каталог резервных копий лежат в `/var/lock`, `/var/lib/territory-crm/<project>` и `/var/backups/territory-crm/<project>`, поэтому второй checkout использует ту же историю. Неуспешный выпуск сохраняет метку своей резервной копии и использует её только после сверки live-контейнера; здоровый идентичный выпуск пропускается без новой копии, сборки или рестарта. Параллельные дампы сериализованы, временный файл закрыт правами и становится финальным только после проверки gzip.
- Файлы: `.gitignore`, `Dockerfile`, `docker-compose.yml`, `deploy-vps.sh`, `backup-postgres.sh`, `scripts/local-deploy-contract.mjs`, `DEPLOYMENT.md`, этот журнал. Миграций и API-логики нет; добавлен только release ID env/label для идентификации контейнера. `.env` и cookie-настройки не менялись.
- Проверки: 
ode scripts/local-deploy-contract.mjs`, 
ode --check scripts/local-deploy-contract.mjs`, `bash -n deploy-vps.sh`, `bash -n backup-postgres.sh`, `docker compose config --quiet`, `git diff --check`, полный `scripts/local-acceptance.ps1 -BaseUrl http://localhost:3109` — PASS. Docker Engine на этой рабочей машине недоступен, поэтому контейнерные переходы, реальный дамп/восстановление и выкладка на VPS не запускались.
- Статус: локальная правка, пакет `4/15`; commit, push и production-релиз ожидают завершения пакета и release gate.

## Пакет 5/15 — ровная боковая навигация и сворачивание групп

- Обнаружено: на узких экранах обработчик принудительно раскрывал группу после закрытия, поэтому состояние меню не сохранялось. На широком desktop между 1180 и 1181 px ширина панели скачком менялась примерно с 210 до 272 px. Дополнительно страницы показывали разный набор финансовых ссылок; настройка «Склад» скрывала часть ссылок, но могла оставить пустую группу; «Моя сеть» и диагностика терялись при нормализации меню.
- Изменено: группы можно сворачивать на Fold/узком экране, состояние сохраняется для пользователя и восстанавливается после обновления. Ширина desktop-панели плавно масштабируется от компактного breakpoint к 280 px на широких экранах; размеры строк/иконок и типографика оставлены едиными. Финансовые ссылки теперь строятся из общего списка. Видимость склада и финансов применяется ко всем подпунктам и заголовку группы; возвращены разрешённые ссылки «Моя сеть» и «Диагностика». На компактном Fold для кнопки меню зарезервировано место в шапке бренда, а заголовки групп имеют ту же высоту касания 44 px, что и соседние строки.
- Файлы: `portal.js`, `style.css`, `scripts/sidebar-navigation-contract.mjs`, `scripts/sync-published-assets.mjs`, HTML шаблоны, `dist/**`, этот журнал.
- БД, API и миграции: не затронуты. Настройки интерфейса сохраняются в существующем пользовательском предпочтении/localStorage.
- Проверки: sidebar navigation, Fold responsive (16 инвариантов), header shell, local design, visual page rules, mode navigation и local preferences contracts — PASS; 
ode --check portal.js` и `git diff --check` — PASS. В локальной CRM меню проверено до и после перезагрузки: состояние склада сохранилось; тестовое отключение раздела скрыло весь заголовок «СКЛАД» и подпункты, повторное включение восстановило их. Скриншот desktop-представления подтвердил общую линию иконок, подписей и групп; длинные названия пунктов аккуратно переносятся на две строки.
- Статус: локально проверено, пакет `5/15`; commit, push и production не выполнялись.

## Панель KPI — выбор бизнес-даты и смены

- UX-решение: на главной первым стоит блок «Показатели смены» с календарём бизнес-даты и списком смен; если смен несколько, доступен сводный выбор «Все смены». Операционные карточки «Текущая работа» остаются отдельными и не меняются при просмотре истории. Сотрудник видит только личную сводку за текущий день без времени других смен.
- Логика данных: новая миграция `039_shift_kpi_attribution.sql` добавляет `payments.shift_id` и `orders.closed_in_shift_id`, с проверкой принадлежности к одному заведению. Новые оплаты получают смену в той же транзакции; заказ получает смену, в которой он закрыт. Для старой истории автоматическая привязка не выполняется; UI предупреждает о непривязанных исторических платежах.
- Изменённые модули: `server.js`, `portal.js`, `style.css`, `VISUAL_PAGE_RULES.md`, `scripts/sync-published-assets.mjs`; добавлены `migrations/039_shift_kpi_attribution.sql`, `scripts/dashboard-shift-attribution-contract.mjs`. Ресурсные копии синхронизированы в `dist/**` (portal rev 269, CSS rev 256). `scripts/order-close-transaction-qa.mjs` обновлён под новую запись платежа.
- API: добавлен `GET /api/dashboard/shift-kpis?date=YYYY-MM-DD&shiftId=UUID`; параметры проверяются, доступ сотрудника серверно ограничен текущим днём и личными заказами. Оплаты и закрытые заказы суммируются по явной смене проведения/закрытия. Изменены записи оплаты и закрытия заказа; существующий финансовый итог наличности использует ту же привязку.
- Проверки: 
ode --check server.js`, 
ode --check portal.js`; dashboard KPI/design, shift attribution, order-close transaction, migrations, visual page rules, Fold responsive, sidebar navigation и local roles (9 ролей) contracts — PASS. Локальный API smoke без БД: корректная дата 200, некорректная дата 400, некорректный формат ID смены 400, валидный UUID отсутствующей смены 404. Источник и `dist` синхронизированы; `git diff --check` прошёл.
- Ограничения: PostgreSQL/Docker на локальной машине недоступны, поэтому миграция и SQL-цепочки не проверены на настоящей базе. Локальный браузер остановился на пустой форме первого запуска; аккаунт не создавался, скриншот дашборда и реальная Fold-проверка не подтверждены. Production/VPS не менялись. Из-за большого ранее незакоммиченного набора файлов безопасный изолированный commit этого пакета пока не создан.

## Удаление переключения роли сотрудника

- Причина: администратор мог открыть зал «от лица» выбранного сотрудника, а в интерфейсах были переключатели режимов и параметры `mode`/`operator`. Это показывало рабочую панель без отдельного входа под учётной записью сотрудника.
- Решение: удалены переключатели режимов и кнопка открытия панели выбранного сотрудника; корневой маршрут зала теперь обычный `/`. Клиент игнорирует и очищает старые `mode`/`operator` параметры, API сессии больше не принимает роль из query string. Имя, роль и набор действий берутся из аутентифицированной сессии. Отдельный вход сотрудника и разрешённый переход администратора к своей административной панели сохранены.
- Файлы: `app.js`, `portal.js`, `server.js`, `staff-profile.js`, шаблоны маршрутов в корне и `dist/**`, `style.css`, `site-map.json`, `SITE_MAP.md`, `SITE_TREE.md`, инструкции визуального аудита, скрипт синхронизации и контракты навигации/ролей. Миграций БД нет.
- Проверки: 
ode --check` для клиентских и серверных скриптов; mode/staff-mode/local-role/sidebar-navigation/staff-pin-passport contracts — PASS. Скрипт публикационных ресурсов синхронизировал корень и `dist` (`app.js` rev 126, `portal.js` rev 270, `staff-profile.js` rev 6, CSS rev 257). Локальная страница на `127.0.0.1:3108` не была запущена, поэтому браузерный просмотр не выполнен.
- Статус: изменения локальные; production/VPS, GitHub и commit не затрагивались. В рабочем дереве уже есть другие незакоммиченные изменения, поэтому задача не коммитилась отдельно.

## Локальная тестовая машина — убрать ложный экран первого запуска

- Причина: экран регистрации показывался при отсутствии локальной базы/эндпоинта, хотя это тестовая среда; при 404 клиент ошибочно принимал недоступный endpoint за необходимость создать администратора.
- Решение: форма входа становится состоянием по умолчанию и переключается на первичную настройку только после успешного ответа backend `required: true`. Backend требует постоянную БД для первичной настройки и возвращает `required: false`, если БД не подключена; POST создания владельца без БД отвечает 503, чтобы не создавать временную учётную запись в памяти. При пустой подключённой БД production onboarding сохраняется.
- Файлы: `login.js`, `server.js`, `scripts/local-login-contract.mjs`, `scripts/sync-published-assets.mjs`, `dist/login.js`, HTML ссылки с revision. Миграций нет, вход существующих пользователей не менялся.
- Проверки: 
ode --check` login/server; локальный login contract проверяет обе ветки. Локальная страница на `127.0.0.1:3108` не отвечает, поэтому визуальную проверку в браузере сделать нельзя.

### Уточнение после проверки тестового стенда

- Причина на машине с подключённой, но пустой тестовой БД: `/api/setup/status` трактовал нулевое число пользователей как первый запуск вне зависимости от назначения окружения. Дополнительно login HTML первоначально отдавал видимой именно форму настройки, пока JavaScript не получал ответ сервера.
- Изменения: форма входа теперь видна сразу, форма настройки скрыта в исходной разметке. Bootstrap выключен по умолчанию и включается только явным `FIRST_RUN_SETUP_ENABLED=true`; тот же флаг проверяется на GET и POST. Создание владельца повторно сверяет наличие активных пользователей под PostgreSQL advisory transaction lock, чтобы повторные/параллельные запросы не создавали новые bootstrap-аккаунты. Флаг добавлен в Compose и `.env.example`, документация описывает временное включение только для подтверждённой пустой производственной БД. HTML и JS синхронизированы в `dist/**` (`login.js` rev 90).
- Проверки: 
ode --check server.js`, 
ode --check login.js`, `local-login-contract.mjs` (23), `local-design-contract.mjs` (14 маршрутов и 27 dist-копий), `docker compose config -q`, `git diff --check` — PASS. Runtime на локальном HTTP-сервере: статус настройки `required=false`, login виден с первой отрисовки, setup скрыт, POST `/api/setup/owner` возвращает 404 `setup_disabled`. Браузер на старом порту 3108 не был запущен; production/VPS не менялись.

## Обновление устаревших QA-контрактов

- Причина: несколько статических контрактов описывали старую разметку аналитики и предполагали, что клиент сам пересчитывает единицы ингредиентов. Из-за этого проверки расходились с текущим выбором смены на главной и строгой серверной валидацией техкарт. Контракт карточек задач также искал неверно экранированный HTML-фрагмент.
- Решение: контракт аналитики теперь проверяет текущую цепочку выбора даты/смены → `/api/dashboard/shift-kpis` → отображение показателей; рецепт-контракт проверяет серверную проверку распознаваемых/совместимых единиц и пересчёт до расчёта себестоимости; UI-сценарий проверяет реальную карточку задачи с селектором статуса. Контракт `local-design` проверен без правок: динамическое чтение app revision уже проходит.
- Проверки: 
ode scripts/local-design-contract.mjs`, 
ode scripts/local-insights-contract.mjs`, 
ode scripts/recipe-chain-contract-qa.mjs`, 
ode scripts/ui-scenarios-contract.mjs` — PASS.
- Ограничения: только тестовые контракты и журнал; продуктовый код, БД, commit и production не менялись.

## Рабочая панель — разрешения меню после подтверждения сессии

- Причина: рабочая навигация сначала рассчитывалась по кэшированному `crm_session_user`, где не было роли управляющего; дополнительно код только скрывал запрещённые пункты и не восстанавливал разрешённые, поэтому после старого состояния управляющий мог остаться без части меню. До ответа API пользователю также на мгновение показывался не подтверждённый набор пунктов.
- Изменения: рабочие пункты меню в исходной разметке скрыты до завершения проверки сессии. Для обычных входов роль и разрешения теперь применяются только из `/api/session`; каждый пункт получает явное состояние `hidden` в обе стороны, группы и их подписи скрываются, если в них нет доступных пунктов. При сбое проверки меню остаётся закрытым. Статический demo-вход сохранён отдельно, чтобы существующий локальный тестовый сценарий не зависел от серверной сессии. Управляющий получил корректную подпись и доступ к разрешённой панели управления; права записи в меню не добавлялись.
- Файлы: `app.js`, `index.html`, `scripts/staff-mode-navigation-contract.mjs`, `scripts/sync-published-assets.mjs`, копии HTML/JS в `dist/**`. API/БД/миграции не менялись; серверная проверка разрешений сохранена.
- Проверки: 
ode --check app.js`, 
ode --check scripts/staff-mode-navigation-contract.mjs`, staff session navigation, local role, mode navigation, sidebar navigation, header shell и `git diff --check` — PASS. Контракт исполняет фактический helper разрешений для профиля управляющего, проверяет запрет прав записи и совпадение корневых/`dist` ресурсов.

## Склад — контекстный заголовок, действия и показатели

- Причина: все представления склада наследовали общий заголовок «Склад», одни и те же кнопки создания позиции/движения и складские KPI. Из-за этого действия не соответствовали открытому каталогу, техкартам, справочникам, премиксам или пополнению запасов.
- Изменения: заголовок и краткое описание теперь отражают выбранный `view`; действия переключаются на основную операцию текущего представления и используют существующие формы/API-сценарии; три KPI показывают соответствующие данные по остаткам, заказам, поступлениям, рецептурам, выпуску, справочникам или каталогу. Добавлен компактный responsive-стиль для набора действий. Правила склада уточнены в `WAREHOUSE_PAGE_PROMPT.md` и `VISUAL_PAGE_RULES.md`.
- Файлы: `portal.js`, `style.css`, `WAREHOUSE_PAGE_PROMPT.md`, `VISUAL_PAGE_RULES.md`, `scripts/inventory-context-contract.mjs`, `scripts/local-acceptance.ps1`, `scripts/sync-published-assets.mjs`, `dist/portal.js`, `dist/style.css` и HTML-копии с обновлёнными asset revisions.
- API/БД: новые API и миграции не требуются; используются существующие складские запросы. Действия направляются в ранее существующие формы и команды.
- Проверки: 
ode --check portal.js`; 
ode scripts/inventory-context-contract.mjs` (7 представлений, 9 связанных действий, responsive-поведение); 
ode scripts/inventory-responsive-contract.mjs`; 
ode scripts/visual-page-rules-contract.mjs`; 
ode scripts/site-structure-contract.mjs`; 
ode scripts/sync-published-assets.mjs`; `git diff --check` — PASS (только стандартные предупреждения Git о преобразовании LF/CRLF).
- Ограничения: браузерный скриншот/ручной клик-проход здесь не запускался; runtime localhost был недоступен. Изменения не коммитились и не публиковались.

### Повторный визуальный QA: контекстные пустые состояния и CTA

- По локальным скриншотам выявлено: класс пустого каталога не совпадал с CSS; действия в шапке дублировали кнопки панели; CTA заявки выглядел активным без выбранных позиций; KPI связи карты с меню считал непривязанные карты; пустой выпуск премикса позволял нажать форму без рецепта.
- Исправления: каталог теперь использует класс, покрытый full-width стилем; одна кнопка создания остаётся в каждой панели каталога/техкарт/пополнения, а заголовок оставляет только действие создания цеха/подцеха/категории и их источники перенесены в скрытый legacy host для существующих обработчиков. Связь техкарты считается только при наличии реального товара каталога. Пустое производство показывает следующий шаг (создать карту или складскую позицию), а поля/submit отключены, пока нет и рецепта премикса, и складской позиции выхода.
- Проверки: inventory context контракт дополнен проверками empty CSS selector, отсутствия дублирующих CTA, истинных связей товара-карты и disabled-состояния выпуска; 
ode --check portal.js`, 
ode scripts/inventory-context-contract.mjs`, 
ode scripts/inventory-responsive-contract.mjs` — PASS. Локальный `http://127.0.0.1:3108/inventory?view=products` отвечает 200. Синхронизированы `dist/portal.js` и HTML с portal rev 273.
- Ограничения: при этой итерации browser screenshot в этой runtime-сессии недоступен; production не менялся, commit не создавался.

## Мобильное боковое меню и выбор смены на главной

- Причина: при раскрытии навигации на телефоне оставался узкий срез dashboard; выбор смены мог выглядеть неопределённым, хотя KPI уже агрегировали все смены.
- Изменения: drawer до 650 px теперь открывается поверх страницы с затемнением, блокирует прокрутку и фон, управляет фокусом, поддерживает закрытие кнопкой, Escape, нажатием на фон и переходом по пункту, а также закрывается при смене ориентации/breakpoint. На desktop и Fold/tablet breakpoint сохранён. Селектор явно показывает «Все смены» с числом смен либо «Смен нет»; заголовок объясняет, относится ли KPI к дню или выбранной смене.
- Файлы: `portal.js`, `style.css`, `scripts/fold-responsive-contract.mjs`, `scripts/sidebar-navigation-contract.mjs`, `scripts/dashboard-kpi-design-contract.mjs`, `scripts/local-acceptance.ps1`, `scripts/sync-published-assets.mjs`, `dist/portal.js`, `dist/style.css` и синхронизированные HTML-копии. Ревизии: portal 274, CSS 259.
- API/БД/миграции: не менялись.
- Проверки: 
ode --check portal.js`; 
ode scripts/fold-responsive-contract.mjs` (19 инвариантов); 
ode scripts/sidebar-navigation-contract.mjs`; 
ode scripts/dashboard-kpi-design-contract.mjs`; 
ode scripts/header-shell-contract.mjs`; 
ode scripts/local-design-contract.mjs`; 
ode scripts/sync-published-assets.mjs` — PASS. `git diff --check` без ошибок whitespace; Git сообщил только стандартные уведомления LF/CRLF.
- Визуальная проверка: скриншоты после изменения этой сессией не сняты; браузерные поверхности CUA были недоступны. Требуется выполнить screenshot QA на 1440×900 и 390×844 с открытым/закрытым drawer, включая desktop и Fold/tablet.

## Повторная локальная приёмка и стабилизация smoke-сценария

- Причина сбоя: `smoke-test.ps1` проверял права владельца через `GET /api/session?role=owner`, тогда как сервер правильно игнорирует неподтверждённую URL-роль. Сценарий больше не соответствовал модели авторизации и падал при полном прогоне.
- Изменения: smoke-тест входит отдельной тестовой учётной записью `owner`, получает сессию с Bearer-токеном и проверяет роль и права. Проверка смены сначала читает текущую смену, чтобы не создавать вторую и не закрывать чужую; в свежем runtime она проверяет открытие/закрытие и открывает рабочую смену для последующих заказов. Нагрузочный тест вынесен из общего приёмочного прогона: лимит API намеренно действует и на localhost, поэтому десять заказов проверяются на отдельном свежем процессе. Итоговая строка больше не утверждает, что общий прогон создал десять заказов.
- Файлы: `smoke-test.ps1`, `scripts/local-acceptance.ps1`, этот журнал. API, БД и миграции не менялись.
- Проверки: полный `scripts/local-acceptance.ps1` повторно прошёл на изолированном in-memory runtime (`127.0.0.1:3118`): маршруты, интерфейсные/адаптивные контракты, роли, сотрудники/PIN, смены, склад, гости и заказные сценарии, а также структурные payroll/order QA. Отдельный `local-100-orders.ps1 -Count 10` прошёл на свежем runtime (`127.0.0.1:3116`): 10 заказов созданы и закрыты, 32 события журнала проверены, инварианты сводки и X-отчёта пройдены. Smoke отдельно прошёл при `AUTH_REQUIRED=true` на новом runtime (`127.0.0.1:3117`): admin, owner-only архивирование и bartender проверены через реальные токены; code-health повторно просмотрел эти изменения. PowerShell parsing и `git diff --check` прошли.
- Ограничения: локального PostgreSQL нет, поэтому связанные SQL-сценарии финансов и зарплаты не являются подтверждёнными runtime-цепочками. Computer Use не смог определить текущий URL окна Opera, поэтому скриншоты интерфейса после правок не сняты; визуальный результат нельзя считать принятым. Коммит и production-релиз не выполнялись.

## Drawer на телефоне/Fold и выбор смены на главной — дополнительный review

- Дизайн-review команды подтвердил, что компактные CSS-правила переопределяли ссылки открытого drawer: иконка и подпись оказывались вертикально, а текст наследовал нулевой размер. Для раскрытых ссылок на 651–900 px и до 650 px восстановлены горизонтальные flex-строки с постоянным размером шрифта; закрытая icon-only панель сохранена.
- Расширено поведение модального drawer на весь диапазон до 900 px: при раскрытии затемняется фон, рабочая область становится inert, блокируется прокрутка, сохраняются закрытие по Escape/фону/переходу, удержание фокуса и его возврат. Это устраняет случай, когда Fold-меню перекрывало активную часть страницы.
- Повторный code-health review выявил ещё один каскадный дефект Fold: крестик кнопки мог оказаться ниже слоя меню. В `651–900 px` кнопка закрытия теперь получает z-index выше панели; контракт проверяет порядок слоёв drawer/кнопка/фон.
- Code-health review обнаружил точную причину подписи «Выберите значение» вместо «Смен нет»: при отсутствии смен искался option по пустому идентификатору и в `select.value` мог записываться 
ull`/`undefined`, снимая выбранную пустую опцию. Выбор теперь ищет смену только при непустом ID; кастомная кнопка явно обновляется после списка, выбранного значения и disabled-состояния.
- Файлы: `style.css`, `portal.js`, три контракта responsive/sidebar/dashboard, `scripts/sync-published-assets.mjs`, синхронизированные страницы и `dist` копии. CSS rev 260, portal rev 275. API, БД, миграции не менялись.
- Проверки: Fold 22 инварианта; контракты боковой навигации, KPI главной, шапки и локальной дизайн-синхронизации прошли. Полный `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3120` прошёл все проверки, включая маршруты/ресурсы, роли, CRUD, smoke, склад и payroll contracts. 
ode --check portal.js` и `git diff --check` прошли; Git вывел только штатные предупреждения о LF/CRLF.
- Визуальное ограничение: повторный скриншот после CSS-правки в этой сессии не снят. Browser Use отклонил переход к локальному адресу политикой URL; обходные способы не использовались. Предыдущие скриншоты до этой правки доказывают исходное состояние, но не принимают результат. Дизайнерский audit также оставил без подтверждения по скриншоту breakpoint-переход 900→901 px. Production, commit и push не затрагивались.
# 2026-09-27 — Fix stale directory-index route templates

- Found that the regular sign-in markup was correct in `login.html` and `dist/login.html`, while the static route alias `dist/login/index.html` still shipped an older state with the login form hidden and first-run setup visible. This explains why a local/static test served at `/login/` displayed first-run setup.
- Updated `scripts/sync-published-assets.mjs` to copy every public directory-index route from its canonical source template before cache-version normalization. Updated `scripts/local-design-contract.mjs` to verify all 13 route aliases against their canonical templates.
- Validation: 
ode scripts/sync-published-assets.mjs`, 
ode scripts/local-design-contract.mjs`, 
ode scripts/local-login-contract.mjs`, 
ode scripts/local-role-contract.mjs`, and the finance RBAC runtime QA all passed. Runtime check against the local test server returned `/login/` with sign-in visible and setup hidden (HTTP 200). No production deployment or database change.

## 2026-09-27 — Fail-closed recipe depletion and memory sale parity

- Fixed the fail-open path where an active sale recipe with an empty or malformed composition could allow order completion without ingredient depletion. API create/edit validation now rejects empty compositions. DB sale depletion preserves the existing “no active sale recipe” behavior, but rejects an assigned invalid card, incomplete/unlinked ingredients, missing stock rows, invalid quantities, and incompatible/unknown units before stock movements; no identity-conversion fallback is used.
- The in-memory/demo close and final-payment paths now use the same recipe scaling, unit conversion, stock checks, depletion, and cost snapshot behavior. Insufficient stock or invalid recipe data leaves the order/payment/stock unchanged. Recipe depletion is idempotent for later delete/write-off handling.
- Files: `server.js`; added `scripts/recipe-depletion-runtime-qa.mjs` (isolated live memory API path) and `scripts/recipe-depletion-pg-contract.mjs` (static SQL/control-flow contract). No migration or database constraint was added pending a legacy-data audit. No production database was accessed.
- Checks: memory runtime QA (26 assertions), PostgreSQL contract, recipe chain contract, depletion contract, order-close transaction contract, header-shell parity, local-design parity, `scripts/sync-published-assets.mjs`, and `git diff --check` all passed. PostgreSQL runtime behavior still requires a separate test server; static contracts are not runtime proof.
# 2026-09-27 — Warehouse integrity, sale depletion, and width-aware design

- Warehouse API now validates and persists custom department identifiers for category create/update without silently remapping them. Auto-order load failures are distinct from a healthy empty result, stale successful results are labeled, and retry is available. Phone-width auto-order product labels reserve room for the selection chip.
- Demo premix production now converts compatible input ingredient quantities and output yield into the target stock units before checking stock, cost, and posting any mutations. Invalid unit pairs fail closed without changing stock or batch history.
- Recipe API rejects empty/invalid ingredient lists. An active but corrupted/malformed sale recipe now aborts before sale completion; no active recipe remains permitted under existing policy. In-memory/demo payment and close paths now match unit conversion, stock depletion and cost snapshot behavior, with payment/order/stock unchanged after a failed check. DB depletion uses explicit ingredient links and rejects unknown/incompatible unit conversions.
- Finance API read access to expense details and payroll rules is now restricted to the `finance` permission; employee/manager aggregate finance scopes no longer expose expense records or salary rates.
- Dashboard KPI density and inventory header wrapping now follow actual workspace/container width instead of abrupt viewport-only desktop thresholds. `VISUAL_PAGE_RULES.md` records this shared layout rule. CSS cache revision is 261; portal revision 277; route aliases and dist resources were synchronized.
- Test fixes: warehouse recipe fixtures now create and reference a real stock ingredient; task access contract reflects the dedicated `tasks_manage` scope instead of the stale `staff_manage`-only assumption. Both failures were found during post-change regression testing and corrected.
- Validation: full `scripts/local-acceptance.ps1` passed on isolated memory runtime; warehouse QA 55; task QA 3; demo premix runtime unit conversion; recipe depletion runtime 26; PG SQL/control-flow contract; finance RBAC runtime; Fold/sidebar/dashboard/header/inventory/visual-rules/local-design contracts; 
ode --check` and `git diff --check` passed. Fresh local screenshot review was unavailable, so CSS changes are covered by contracts but not visually accepted. PostgreSQL runtime is unavailable (Docker daemon unavailable, no local `psql`); no migration or production DB change was made.

## Сверка зарплаты и расходов в финансовой модели

- Аудит обнаружил риск двойного учёта закупки в прибыли, скрытые старые зарплатные расходы, неполный выбор периода и неверную группировку дроблёных табелей при расчёте оплаты за смену.
- Исправлено: источник `purchase` исключён из операционных расходов P&L и остаётся денежным оттоком; интерфейс расходов теперь явно различает операционный расход и оплату закупки. Исторические строки `payroll` больше не скрываются: API помечает несверенные выплаты как требующие проверки, интерфейс показывает их статус. Фильтр зарплатного реестра выбирает пересекающиеся с диапазоном начисления. Почасовые суммы режутся по границам бизнес-дня часового пояса организации; оплата за смену считает один рабочий день по локальной дате начала, а не число строк табеля.
- Файлы: `server.js`, `portal.js`, `scripts/payroll-qa.mjs`, `scripts/payroll-lifecycle-runtime-qa.mjs`, `scripts/local-acceptance.ps1`, `dist/portal.js` и синхронизированные dist-ассеты.
- БД/миграции/API: миграции и API-маршруты не добавлялись; исправлена семантика существующих `/api/expenses`, `/api/payroll/entries` и аналитики. Приём платежа по закупочному документу всё ещё не связан с документом: кассовый платёж нужно классифицировать как закупку в расходах, а долг поставщику CRM пока не ведёт.
- Проверки: полный `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3107` прошёл, включая роли, адаптивность, склад, расчёты, payroll lifecycle, миграционные контракты и CRUD. Login открыт в браузере на локальном сервере; визуально подтверждено, что по умолчанию показана форма входа, а мастер первого запуска скрыт. `git diff --check` не выявил ошибок whitespace (только стандартные уведомления LF/CRLF).
- Ограничения: изолированный PostgreSQL не доступен (нет работающего Docker daemon и `psql`); migration preflight остановился после статических проверок. Payroll runtime использует mock PG, поэтому SQL и миграции требуют последующего прогона на настоящем изолированном PostgreSQL. Production БД и сервер не затрагивались; screenshot login визуально просмотрен, другие страницы этой итерации не проверялись снимками.

### Повторное устранение старой формы на тестовой машине

- Повторно проверены `/login` и `/login/`: текущий локальный Node-сервер и dist-страница отдают вход, статус настройки — `required:false`. Источник разницы раньше был в отдельном статическом alias `dist/login/index.html`; alias теперь копируется из той же страницы входа.
- Чтобы старый HTML не оставался в кеше после обновления, для `login.html` сервер выставляет `Cache-Control: no-store`. Контракт расширен проверкой обеих опубликованных HTML-копий.
- Проверки: `local-login-contract.mjs` (26), `local-design-contract.mjs`, 
ode --check server.js`; на локальном runtime оба адреса вернули 200, 
o-store`, login видим/setup скрыт; `/api/setup/status` вернул `required:false`.
- Ограничения: исправление локальное; production/test VPS не перепубликовывался и не проверялся этим изменением.

## 2026-09-27 — Защита утверждения зарплатных периодов от пересечений

- При повторном аудите нашёл, что payroll допускает создать два черновика с пересекающимися датами для одного сотрудника и одного правила оплаты. Если оба утвердить, один и тот же табель/оборот мог попасть в начисление повторно.
- При утверждении и выплате берётся транзакционная advisory-блокировка по заведению, сотруднику и правилу, затем проверяются пересекающиеся уже утверждённые или оплаченные периоды. Конфликт возвращает 409 `payroll_period_overlap`, оставляя новый документ черновиком; повторная проверка выплаты защищает также от старых/импортированных пересечений. Разные правила оплаты и непересекающиеся периоды продолжают работать.
- Проверка `payroll-lifecycle-runtime-qa.mjs` покрывает перекрытие, отказ в утверждении, повторный барьер выплаты на legacy-состоянии и разрешение соседнего периода; runtime-мок и 
ode --check` прошли. Полная локальная приёмка после этих проверок прошла.
- Это не PostgreSQL integration test: настоящего PostgreSQL для локального интеграционного прогона в окружении пока нет. Миграция не требуется; серверный маршрут `/api/payroll/entries/:id` изменён. На VPS не выкладывалось.

## 2026-09-27 — Визуальная проверка пустого склада на узком экране

- Реальный скриншот локального интерфейса при ширине около 557 px показал, что третья карточка «Последняя операция» оставалась одна слева во второй строке KPI. На странице склада это создавало пустую половину строки и нарушало визуальный ритм.
- На ширине до 760 px третья карточка теперь занимает всю строку. Просмотрел обновлённый локальный скриншот после синхронизации CSS cache rev 263: карточка выровнена, остатков по горизонтали нет.
- Проверки после изменения: `local-design-contract.mjs`, `inventory-responsive-contract.mjs`; полная локальная приёмка перед CSS-правкой прошла, после CSS-правки повторены оба затронутых контракта. На VPS не выкладывалось.
- Тот же визуальный проход выявил аналогичную неполную строку в KPI финансов. Карточка «Платежи» теперь также занимает всю строку на ширине до 760 px. Снял локальный скриншот после обновления; `dashboard-kpi-design-contract.mjs` прошёл. CSS cache rev поднят до 264 и dist синхронизирован.

## 2026-09-27 — Связь оплат поставщиков с накладными

- Финансовая проверка подтвердила незакрытый участок цепочки «Поставка → денежный поток»: накладная проводила товар на склад, но оплата поставщику не была связана с ней. Независимые UI-аудит и контрактный аудит указали на необходимость разделить складские и финансовые права и защитить связь от межзаведенческого доступа.
- Добавлены финансовые endpoints `GET /api/finance/purchase-payables` и `POST /api/finance/purchase-payables/:id/payments`. Запись платежа сериализуется блокировкой накладной, допускает части оплаты, проверяет остаток, статус `posted` и обязательный idempotency key. Повтор идентичного запроса возвращает уже созданную запись без повторного денежного расхода; несовпадающий повтор и переплата отклоняются. Сумма записывается отдельной строкой `expenses` с фактической датой оплаты, способом, необязательным подтверждающим файлом и привязкой к накладной.
- Миграция `042_purchase_payment_link.sql` добавляет ссылку, ключ идемпотентности и способ оплаты; trigger БД требует тот же `venue_id`, проведённую накладную и `source='purchase'`. Старые незакреплённые записи `purchase` не переписываются. Обычные endpoints просмотра накладных больше не возвращают оплачено/остаток; список оплат открыт ролям `finance` и `finance_read`, создание платежа — только `finance`. Общая форма расходов больше не создаёт не связанные с накладной закупки; старые строки остаются доступными в финансовом журнале.
- На странице финансов добавлен компактный блок «Расчёты с поставщиками» сразу после кассового блока: поиск, фильтр статуса, суммы накладной/оплаты/остатка, состояние и раскрываемая форма оплаты с частичной суммой, датой, способом и документом. После сохранения обновляются остаток, журнал расходов и финансовая сводка. Интерфейс складского раздела не показывает финансовые суммы.
- Заодно исправлена найденная полным прогоном ошибка демо-режима: владелец организации, созданной в памяти тестовой машины, теперь получает уникальный `user.id`; повторные onboarding-тесты больше не сталкиваются с общим резервным ID и лимитом сессий. Поле пароля страницы входа теперь помечено как `current-password`, а не создание нового пароля; это не провоцирует браузер предлагать случайный новый пароль.
- Изменены: `migrations/042_purchase_payment_link.sql`, `db.js`, `server.js`, `portal.js`, `style.css`, `login.html`, `scripts/sync-published-assets.mjs`, `scripts/local-acceptance.ps1`, `scripts/local-saas-onboarding-contract.mjs`, `scripts/local-login-contract.mjs`, новые `scripts/purchase-payments-runtime-qa.mjs` и `scripts/purchase-payments-contract.mjs`, плюс синхронизированные файлы `dist/**`. Cache revisions: portal 279, CSS 265.
- Проверки: после последней правки полный `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3111` завершился `PASS`; отдельно прошли purchase payments runtime mock (частичная оплата, идентичный повтор, конфликт ключа, переплата, черновик, tenant scope), 14 контрактных проверок, purchase document contract, миграционный контракт на 42 файла, onboarding с уникальным user ID, login contract (27), дизайн-контракт, синтаксис Node и `git diff --check`.
- Ограничения: PostgreSQL и Docker daemon в среде сейчас недоступны; миграция 042 и триггер не исполнены в реальной БД, конкурентная блокировка проверялась только статическим SQL-контрактом, фактическая страница с данными поставок визуально не открывалась, потому что тестовая база пуста. Production/VPS, данные, GitHub и commit не менялись.

### QA: исправление складских карточек на узком экране Fold
- При ручной проверке на ширине 820 px обнаружено, что складские и автозаказные строки таблицы в адаптивном режиме сжимаются до узкой колонки и переносят текст по символам. Причина — табличная ширина ячеек продолжала влиять на раскладку после переключения таблицы на CSS Grid.
- Для складских строк и строк пополнения заданы полная ширина ячеек, растяжение по сетке и `box-sizing:border-box`. Добавлены проверки, предотвращающие возврат дефекта. Версия CSS для кэша повышена до 267; опубликованные локальные файлы синхронизированы.
- Визуально проверены складские остатки и пополнение при 820 px (внутренний экран Fold), а также контрольные ширины 651 и 390 px. На всех проверенных ширинах текст остаётся читаемым; горизонтального переполнения документа нет. Проверки `inventory-responsive-contract`, `inventory-hierarchy-contract` и `inventory-context-contract` прошли.
- Изменены `style.css`, `scripts/inventory-responsive-contract.mjs`, `scripts/sync-published-assets.mjs` и синхронизированные `dist/**`; migration/API/БД в этой правке не менялись.
- Выкладка на VPS отложена по сообщению пользователя о временной недоступности сервера. Изменения пока локальные и не закоммичены.

### QA: API права финансов и адаптивность журнала заказов
- Совместная проверка обнаружила, что `finance_read` у сотрудников открывал суммы задолженности поставщикам через прямой API-вызов, хотя панель была скрыта; у менеджера, наоборот, финансовая страница запрашивала журнал расходов, который его API-роль не могла прочитать. Закрыты оба UI/API разрыва: сотрудники получают отказ на финансовые детали, менеджер видит обычные расходы без зарплатных строк, запись расходов остаётся доступна только роли `finance`.
- На реальном локальном рендеринге обнаружен узкий экранный дефект журнала заказов: семиколоночная таблица переносила заголовки по буквам и карточки заказа выпадали из контейнера. На ширине до 760 px журнал теперь отображается отдельными карточками с полями «Заказ», «Стол», «Гость», «Статус», «Сумма», «Создано», «Действие»; пустое состояние остаётся внутри панели.
- Визуально проверены административная главная, финансы, остатки склада, техкарты, заказы, бронирования, сотрудники и настройки на ширинах 1440, 820, 717 и 390 px; дополнительные страницы гостей, доставки, интеграций, сети и финансовых справочников/отчётов — на 1440, 717 и 390 px. Для проверенных маршрутов горизонтальное переполнение страницы не обнаружено. С заполненным тестовым заказом и фильтром без совпадений проверены карточка заказа и пустое состояние при 717 и 390 px; боковая панель в раскрытом Fold-режиме визуально проверена.
- Изменены `server.js`, тесты `finance-rbac-runtime-qa.mjs`, `style.css`, `portal.js`, `scripts/fold-responsive-contract.mjs`, `scripts/sync-published-assets.mjs` и синхронизированные `dist/**`. Cache revision CSS: 270. Миграций и схемы БД для этих исправлений нет.
- Проверки: после свежего перезапуска изолированного локального сервера полный `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3113` завершился `PASS`; отдельно проверены Fold responsive contract (24 инварианта), inventory responsive/hierarchy и finance RBAC runtime. Визуальные экраны сняты локально Playwright/Chrome только для QA; данные локальные тестовые.
- Ограничения: управленческий сценарий закупочных оплат в панели поставщиков по-прежнему показывает сумму оплачено агрегатом; отдельная история дат, методов и подтверждающих документов в контексте накладной остаётся незавершённой задачей. VPS не выкладывался, GitHub и commit не изменялись.

### QA: заголовки подразделов администратора и финансовые права
- При локальном визуальном просмотре раздела «Сотрудники» выяснилось, что в нём оставалась отдельная шапка «Текущая работа» без KPI-карточек. Скрывались только карточки `.kpi-grid`, а самостоятельный заголовок был размечен отдельным dashboard-модулем. Исправлено системно: подразделы настроек, сотрудников и других экранов администратора скрывают весь модуль `data-dashboard-module="kpi"` целиком. Заголовок страницы и верхняя навигация при этом остаются синхронными.
- Добавлены проверки в `scripts/admin-section-heading-contract.mjs`, что заголовки и шапка KPI остаются согласованными. Скриншотный QA локального раздела «Сотрудники» после правки подтвердил отсутствие пустой шапки и верное название в хлебных крошках.
- Реализованная ранее раскрываемая история оплат по накладной остаётся проверенной по API и контрактах (частичная оплата, идемпотентность, права ролей, tenant scope, безопасная ссылка на документ). Визуальную запись истории с данными в интерфейсе пока нельзя подтвердить через текущую пустую БД: в локальном браузере блок корректно показывает состояние ошибки загрузки. Нужен отдельный браузерный рендер с изолированной тестовой накладной; миграция 042 и конкурентная запись также требуют отдельной PostgreSQL-проверки.
- Изменены `portal.js`, `scripts/admin-section-heading-contract.mjs` и синхронизированные `dist/**`; миграций/API в этой правке не добавлено. Финансовая история и RBAC реализованы в предыдущем наборе изменений с миграцией 042.
- После синхронизации опубликованных файлов контракт заголовков и дизайн-контракт проходят; визуальная проверка сотрудников — PASS. Полный локальный `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3114` завершился `LOCAL ACCEPTANCE: PASS`. PostgreSQL runtime для миграции 042 и визуальный рендер истории на тестовой накладной ещё остаются отдельными незакрытыми проверками. VPS недоступен, публикации и изменений production нет.
# 2026-09-27 — Изолированный PostgreSQL и перечень оставшихся задач

- Docker Desktop стал доступен локально. Поднят временный контейнер PostgreSQL 16.15 `territory-crm-postgres-qa`, опубликованный только на `127.0.0.1:55432`, без постоянного volume и production-данных.
- Первичный запуск одного `scripts/migrate.js` на пустой базе завершился `relation "users" does not exist`: в тесте не был выполнен штатный bootstrap `schema.sql`. Повторил в предусмотренном проектом порядке: применил `schema.sql`, затем `DATABASE_URL=postgres://postgres@127.0.0.1:55432/territory_qa node scripts/migrate.js`; успешно применены все 42 миграции. Docker Compose задаёт `schema.sql` как init-скрипт для новой БД. Это доказательство чистого bootstrap на тестовой базе, не доказательство upgrade-path или конкурентных сценариев миграций 039–042.
- Обновлён `docs/ai-team/REMAINING_TASKS_PROMPT.md`: сменная атрибуция, API-валидация файлов платежей и базовый PostgreSQL bootstrap вынесены в уже сделанное; оставшиеся тесты, визуальные проблемы, бизнес-цепочки, полный QA и публикация указаны как открытые.
- VPS не подключался, внешняя БД и реальные данные не использовались. Временный PostgreSQL-контейнер пока оставлен для продолжения интеграционных тестов; остановить после PG-проверок.

## 2026-09-27 — PostgreSQL upgrade-path и ограничения миграций 039–042

- На контейнере PostgreSQL 16.15 прошли повторный 
ode scripts/migrate.js` (42 миграции), `PAYROLL_LIFECYCLE_TEST_DATABASE_URL=... node scripts/payroll-lifecycle-migration-preflight.mjs`, `MIGRATIONS_PG_TEST_DATABASE_URL=... node scripts/migrations-pg-upgrade-qa.mjs` и `... node scripts/migrations-pg-runtime-qa.mjs`.
- Upgrade QA создал временную отдельную схему, применил `schema.sql` + миграции 001–038, создал синтетические открытые/закрытые смены, платежи с legacy NULL attribution, payroll (draft/approved), расход и проведённую накладную, затем применил/replay 039–042. Проверено, что исторические значения не переписываются.
- Runtime QA проверил привязку платежа к смене своего заведения, отказ для чужой смены, единственную открытую смену, связь расхода с проведённой накладной своего заведения, запрет другого source и повтор idempotency key. Все тестовые строки и временная схема откатились.
- `migrations-pg-upgrade-qa.mjs` и `migrations-pg-runtime-qa.mjs` добавлены как повторяемые PG-проверки; требуется ещё проверить конкурентные API-платежи/открытие смены и восстановление после сбоя пути `migrate-vps.sh`. PostgreSQL тесты не затрагивали VPS.

## 2026-09-27 — Восстановление Docker Desktop и настоящий failure/retry PostgreSQL

- Восстановлен локальный Docker Desktop `desktop-linux`. Причиной старта оказались оставшиеся runtime socket/reparse-point папки Docker; перед переименованием проверено отсутствие работающего engine и контейнеров. Папки `Docker/run` и `docker-secrets-engine` сохранены рядом как recovery-копии, не удалялись Docker volumes/images и пользовательские данные.
- Создан временный PostgreSQL 16.15 без постоянного volume, опубликованный только на `127.0.0.1:55432`. На нём повторно применены `schema.sql` и 42 миграции, затем replay; повторно прошли `payroll-lifecycle-migration-preflight.mjs`, `migrations-pg-upgrade-qa.mjs` и `migrations-pg-runtime-qa.mjs`.
- Добавлен `scripts/migrate-vps-postgres-qa.sh`. Он запускает неизменённый `migrate-vps.sh` во временном каталоге; Docker Compose только адаптируется к тестовому контейнеру, а `pg_isready` и `psql` выполняются настоящим PostgreSQL. Инъекция `SELECT 1/0` после `CREATE TABLE` доказала атомарный откат всей первой миграции, остановку перед второй миграцией и CRM/seed. После удаления injected failure retry применил обе миграции в лексическом порядке и завершающие шаги; таблицы-маркеры удалены cleanup trap.
- Проверки: повторные 42 миграции — PASS; payroll lifecycle migration — PASS; upgrade 001–038→039–042 и сохранность старых строк — PASS; runtime guards 039/041/042 — PASS; real PostgreSQL migration failure/rollback/retry — PASS. VPS не подключался; production DB, домен, HTTPS и `COOKIE_SECURE` не менялись.

## 2026-09-27 — Повторная полная локальная acceptance

- Свежий изолированный 
ode server.js` запущен на `127.0.0.1:3121` с пустым `DATABASE_URL`, без авторизации для локальных synthetic QA и `API_RATE_LIMIT=5000`; существующие пользовательские процессы не затрагивались. Временный сервер остановлен после выполнения, порт 3121 больше не слушается.
- `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3121` — `LOCAL ACCEPTANCE: PASS`. Прошли все включённые контракты и сценарии: 14 маршрутов/assets; 34-строчная матрица; Fold/sidebar/header/design; складской API (55 проверок); рецепты/списания (memory API); роли/RBAC; смены; зарплата; платежи поставщикам; CRUD гостей/заказов/залов; login и остальные локальные smoke проверки.
- Ограничение: этот приёмочный сервер использовал память процесса, а не PostgreSQL, и `local-route-smoke` не является screenshot review. Независимые настоящие PostgreSQL проверки фиксируются выше; browser screenshot matrix по всем ролям/маршрутам/экранам Fold остаётся незакрытой.

## 2026-09-27 — Сквозные PostgreSQL/API тесты и визуальные дефекты

- На актуальном `main` поверх `e24216b` устранён разъезд даты PostgreSQL `DATE` при чтении истории/повторе платежа закупки: запрос теперь выдаёт стабильный `YYYY-MM-DD`, без локальной timezone-конверсии Node.js.
- Добавлен единый 
pm run qa:postgres`, который отказывается работать без явно указанной тестовой/QA/scratch БД и запускает 7 PostgreSQL suite. Запуск на PostgreSQL 16.15 (`territory_qa`) прошёл: migration preflight, upgrade/runtime 039–042, миграция 041 recovery/concurrency, API поставок/оплат, payroll API и рецепт/списание.
- Реальная API проверка 041 воспроизвела legacy-дубли открытых смен, сохранила строки при отказе миграции и доказала ровно одну открытую смену при двух конкурентных запросах. Тест платежей прошёл проведение поставки, склад/кредиторку, частичную и полную оплату, идемпотентный повтор, конфликт, переплату и историю. Payroll PG-путь подтвердил 8 ч × 500 ₽, согласование, защиту от перекрытия, одну связанную статью зарплатного расхода, повтор и отмену. Рецепт PG API прошёл приход→остаток→однокомпонентная техкарта→продажа→списание/COGS; injected close failure откатил платёж/списание/COGS, retry завершился один раз, следующий приход не переписал исторический snapshot.
- Визуально через браузер при 1280×720 проверено и исправлено наложение карточек столов из-за некорректного пересчёта координат X/Y и ширины в 12-колоночную сетку. Исправлено пересечение действий восстановления/архивации в неактивных строках персонала. В dashboard KPI найден перенос `₽`; CSS теперь удерживает сумму и валюту на одной строке, добавлен regression contract. Post-fix screenshot именно этого значения не архивирован.
- Синхронизированы source/dist; CSS revision 289, app revision 130. `local-design-contract.mjs`, `staff-mode-navigation-contract.mjs`, `git diff --check`, полный `local-acceptance.ps1` и все семь PG suites — PASS. Browser screenshot review всех маршрутов, hash-разделов, ролей и ширин остаётся незавершённым. VPS/production не подключались и не менялись.

## 2026-09-27 — Hash-навигация, ролевые API и кассовый PostgreSQL E2E

- Исправлен дефект перехода прямо в подразделы админки: dashboard hash больше не прокручивает панель так, что верх страницы/H1 и главное действие оказываются вне экрана. Переходы по hash в админке теперь ориентируются на `.page-title`. Проверено в браузере на `/admin#tasks` и `/admin#staff`: заголовок, описание и основное действие видимы.
- Добавлен `role-api-matrix-runtime-qa.mjs`: проверяются 8 GET API для ролей bartender/manager, анонимный отказ, запрещённые записи, ограниченный финансовый ответ сотруднику и полный цикл назначения/обновления задачи с повторным чтением. Включён в `local-acceptance.ps1`.
- Добавлен `shift-cash-postgres-e2e-qa.mjs`: реальный isolated PostgreSQL/API-путь начальная наличность→оплаченный заказ и сменная атрибуция→ожидаемая наличность→обязательный чек-лист→фактическая касса/variance→закрытая смена. Невалидный чек-лист и повторное закрытие отвергнуты; синтетические данные удалены.
- Обновлены опубликованные `dist/**` копии портала и `scripts/postgres-qa.mjs`; runner теперь запускает 8 PostgreSQL suites. `local-acceptance.ps1` — PASS целиком на временном in-memory процессе `127.0.0.1:3119`; все 8 PG suites — PASS на локальном PostgreSQL 16.15; `admin-section-heading-contract.mjs`, `local-design-contract.mjs`, `git diff --check` — PASS. Полная браузерная screenshot matrix всё ещё не выполнена.
- GitHub commit/push выполняется после проверки полного diff этой итерации. VPS/production и пользовательские данные не затрагивались; домен/HTTPS/Cookie-настройки не менялись.

## 2026-09-27 — Навигация/гости, полная локальная приёмка и PostgreSQL 16

- UI-проход sidebar/гостей завершён: route-aware группы и предпочтение сворачивания сохраняются после перехода/перезагрузки; бренд не исчезает при скролле. Гостевой редактор открывается по действию/выбору, закрывается с возвратом фокуса; список показан первым. Счётчик персонала использует общий русский plural formatter.
- Затронуты `portal.js`, `style.css`, `VISUAL_PAGE_RULES.md`, sidebar/client-editor/staff-count contracts, `scripts/local-acceptance.ps1`, sync script и опубликованные `dist/**`. Cache revisions: CSS 272, portal 282. Source/dist parity проверена.
- Playwright-flow прошёл на 1280×… и 390 px: меню сворачивалось/раскрывалось с сохранением, guest create/select/close работал, горизонтального переполнения и JS ошибок не было. Скриншоты: `%TEMP%\\territory-navigation-client-fixes`. Осталась отдельная косметическая находка: фильтры гостей переносятся на вторую строку неровно.
- Полная `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3116` прошла. Первый пробный запуск на одном тестовом процессе остановился на штатном API rate limit при большом количестве запросов; повтор на отдельном свежем процессе с тестовым `API_RATE_LIMIT=5000` прошёл целиком. Порт отдельный от пользовательского `3115`; сервер использовал локальный memory режим.
- Изолированные PG проверки 42 миграций, повторного применения, upgrade 001–038→039–042, сохранности старых значений, payroll lifecycle и проверок триггеров прошли. `migrations-pg-upgrade-qa.mjs` и `migrations-pg-runtime-qa.mjs` добавлены; требуется ещё конкурентная API проверка 041/042 и recovery-path `migrate-vps.sh`.
- VPS, GitHub и production не затрагивались. Временный локальный PostgreSQL контейнер оставлен для дальнейшей QA.

## Продолжение QA после `58b8851` — статические контракты и текущие ограничения

- Перепроверены ветка и remote: `main` и `origin/main` совпадают на `58b8851d3b1a2728a152a82a15b84e0a7f759a60`; рабочее дерево было чистым. Этот commit содержит исправления адаптивности гостевых карточек и формы расходов, сжатия desktop/tablet страницы платформы, дубликата ссылки в меню сотрудника и доступных имён мобильных кнопок навигации. VPS не проверялся и не менялся.
- Повторно выполнены 32 офлайн contract-теста: все завершились `PASS`. Включены контракты карты сайта и визуальных правил, Fold/adaptive, складской иерархии, премиксов, платежей поставщикам, payroll UI, ролей/навигации и полного 34-строчного acceptance matrix. `local-*` тесты, обращающиеся к HTTP-сервису, в этом запуске не выполнялись.
- Дополнительно прошли `purchase-payments-runtime-qa.mjs` (частичная/полная оплата, идемпотентность, конфликт, переплата, draft, tenant scope), `purchase-payments-contract.mjs` (19 проверок), `finance-rbac-runtime-qa.mjs`, `payroll-lifecycle-runtime-qa.mjs`, `recipe-depletion-runtime-qa.mjs` (26 проверок) и `demo-premix-unit-runtime-qa.mjs`. Эти сценарии работают через fake PostgreSQL repository или memory API и не являются настоящей PostgreSQL E2E.
- Добавлен `scripts/migrate-vps-runner-qa.sh`; в Git Bash он выполнил реальный `migrate-vps.sh` в изолированном каталоге с fake Docker/psql: искусственная ошибка остановила второй SQL-файл и CRM/seed, повтор применил файлы по порядку и вызвал последующие шаги; все вызовы psql содержали `--single-transaction`. Это доказывает управление потоком оболочки, но не rollback PostgreSQL. Deploy contract и `git diff --check` прошли.
- Предыдущий полный `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3118` зафиксирован как `PASS` для временного локального in-memory сервера; текущий 32-контрактный прогон сам по себе не является повтором acceptance или браузерным QA.
- Актуальная проверка Docker: `com.docker.service` остановлена, Docker Engine не доступен через `desktop-linux`; PostgreSQL runtime-проверки сейчас не запускались. Браузерный инструмент заблокировал переход на локальный CRM URL политикой безопасности и явно запретил обход этого ограничения другими браузерными/HTTP способами; скриншоты и свежая оценка рендеринга поэтому не получены.
- Все 34 требования остаются с консервативными статусами из `FINAL_ACCEPTANCE_REPORT.md`. Ни один статический тест не повышает статус требования до «готово» без сквозного доказательства. Следующие конкретные шаги: восстановить безопасный локальный browser preview и isolated PostgreSQL engine, затем выполнить screenshot matrix и незакрытые PG/API race/business-chain сценарии.

## 2026-09-27 — Устранение пустой полосы слева в мобильной оболочке склада

- На локальной странице `/inventory?fold-layout-check=294` в узком портретном браузерном окне воспроизведена пустая полоса слева. Причина — desktop-правило `.portal.velora-theme .portal-sidebar` с более высокой специфичностью оставляло скрытое меню sticky-элементом во flex-потоке; поэтому оно продолжало резервировать ширину.
- Адаптивное правило теперь имеет такую же специфичность и действительно переводит боковую панель в фиксированную выдвижную шторку. Страница склада использует всю ширину; меню поверх контента открывается кнопкой и закрывается клавишей Escape. Повторную инициализацию меню также сделали идемпотентной: toggle распознаётся как сосед shell/sidebar, а не как потомок sidebar.
- В браузере подтверждён экран 451×667: страница начинается у левого края, H1 и карточки не смещены пустым rail; AX-дерево показывает одну кнопку «Открыть меню». Drawer проверен визуально в открытом состоянии и закрыт Escape. Это не заменяет матрицу точных ширин Fold и проверку остальных маршрутов.
- Изменены `style.css`, `portal.js`, `scripts/fold-responsive-contract.mjs`, `scripts/sync-published-assets.mjs` и синхронизированные HTML/JS/CSS файлы в `dist/**`; cache revisions CSS 292, portal 287. API, миграции и БД не менялись в UI-исправлении.
- Проверки: `fold-responsive-contract.mjs` (27 invariants), `local-design-contract.mjs`, все 8 изолированных PostgreSQL suites, включая 82 assertions по локальному часовому поясу и связанной финансово-складской цепочке, — PASS; `git diff --check` — PASS. Полный local acceptance прошёл на отдельном memory-сервере `127.0.0.1:3123` до последнего изменения только PG test harness. Попытка повторить полный acceptance после остановки изолированного сервера не запускала его автоматически и завершилась на первом HTTP runtime-check с `ECONNREFUSED`; не считаю эту попытку повторным PASS. Публикация на VPS не выполнялась.

## 2026-09-27 — Защита demo login и бизнес-даты точки

- На базе `f13fc57a29143ec44c076993d32639e487f832f3` устранены fallback-входы admin/admin, owner/demo, staff/demo и platform-owner/saas-demo при `AUTH_REQUIRED=true`, если demo-секреты не настроены. Значения demo-паролей в `.env.example` очищены; Compose defaults теперь пустые. Cookie/security gates не менялись.
- Часовые пояса записи проверяются как IANA timezone на пяти путях: первичная настройка, создание SaaS организации с первой точкой, обновление своей точки, создание и обновление сетевой точки. Finance summary и X/Z используют дату активной точки и half-open локальные календарные границы. Ошибочная историческая timezone падает назад на валидную timezone организации или `Asia/Yekaterinburg`.
- Сквозной employee finance PostgreSQL QA с `AUTH_REQUIRED=true` проверяет реальную хешированную учётную запись и сохранённую сессию, продажи нескольких сотрудников и дней, запрет подменённой даты и минимальный ответ работнику (`17 checks`). Recipe/depletion PostgreSQL QA дополнен реальным legacy timezone fallback и завершился с `95 assertions`. Удаление тестовых строк ограничено синтетическими venue ID.
- Изменённые файлы пакета: `.env.example`, `docker-compose.yml`, `package.json`, `server.js`, `scripts/local-acceptance.ps1`, `scripts/local-deploy-contract.mjs`, `scripts/postgres-qa.mjs`, `scripts/recipe-depletion-pg-runtime-qa.mjs`; добавлены `scripts/security-default-credential-qa.mjs`, `scripts/finance-timezone-contract.mjs`, `scripts/finance-employee-postgres-qa.mjs`, `scripts/venue-timezone-validation-runtime-qa.mjs`. Миграций и изменений schema нет. UI assets/dist не затронуты.
- Проверки: полный local acceptance на свежем `127.0.0.1:3126` — PASS; 
pm run qa:postgres` на изолированном PostgreSQL 16.15 — PASS (9 suites); 
pm run qa:security` — PASS; timezone API runtime (5 путей), venue-local contract, deploy contract, syntax checks, fold/design contracts и `git diff --check` — PASS. Независимый reviewer исправил вместе с координатором один слабый regex assertion; все повторные проверки прошли.
- Свежий визуальный CUA-ререндер склада на 610×840 не показал полосу: `.portal-main` начинается с x=0 и занимает всю ширину, скрытая панель вынесена за экран. Исходный предоставленный скриншот в текущем локальном bundle не воспроизводится; точный источник различия остаётся непроверенным. Полная визуальная матрица всех страниц/ролей/размеров не завершена.
- Hash реализации: `8dce4c9d713bb4d4fe05817497f800e986c0747c`; отчётный commit: `50c812f`. Оба отправлены в `origin/main` и подтверждены сверкой веток. VPS и production не использовались; полный acceptance остаётся неполным и 34 исходных статуса без новых оснований не повышаются.

## 2026-09-27 — Повторная приёмка и склад на ширине 610 px

- Полученный скриншот показывал чёрную вертикальную полосу между кнопкой меню и складской страницей. На свежем локальном browser render при точно таком CSS viewport 610×840 меню вынесено влево (`x=-280`), `.portal-main` начинается в `x=0` и занимает все 610 px. После открытия drawer основная область остаётся `x=0`, фон затемняется; Escape закрывает меню. Текущий bundle проблему не воспроизводит, источник исходного кадра (отличающаяся раздача/кэш/viewport) не установлен. Неподтверждённых CSS-костылей не добавляли.
- После увеличения компактного employee sidebar breakpoint до 900 px повторный screenshot scan охватил 14 канонических маршрутов + 11 hash-разделов на 7 viewport sizes (175 кадров). Ошибок навигации, не-200 маршрутов и горизонтального переполнения документа нет. При 717/820 px сотрудник получает 68 px compact rail. Это структурный scan и выборочная визуальная проверка, а не полный interaction/filled-state audit.
- Полный `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3136` прошёл после добавления `finance-employee-contract.mjs` в общий suite. Первый повтор на старом процессе остановился из-за штатного session limit и не засчитан.
- В этом candidate уточнён смысл финансового показателя сотрудника: API/UI показывают оборот заказов, открытых сотрудником, не утверждая item-level личные продажи. Memory API сохраняет `openedBy`; PostgreSQL summary и line-item report фильтруются тем же заказчиком. Добавлена concurrent PG suite по разным/одинаковым ключам платежа поставщика. Её запуск пока невозможен: Docker Engine pipe отсутствует, `127.0.0.1:55432` закрыт. Требуется повторить на изолированном PostgreSQL перед завершением финансовой/закупочной цепочки.
- Проверенный UI-пакет (`style.css`, `portal.js`, cache sync, sidebar/UI contracts и синхронизированные HTML/`dist/**`) зафиксирован и отправлен в GitHub: `bd0e823`. CSS revision 293, portal revision 288. В рабочем дереве остаются отдельные незакоммиченные изменения `server.js`, `finance-employee-contract.mjs`, acceptance wiring и concurrent payment PG-QA; схема API/БД и миграции не менялись. Они будут оформлены только после реального PG-прогона.
- Для восстановления изолированного PostgreSQL запущен диагностический старт Docker Desktop. Его backend снова аварийно завершился на `initializing Inference manager` из-за недоступной записи `C:\Users\ADMIN\AppData\Local\Docker\run\dockerInference` (старый ReparsePoint от 19:27). Выключение только `EnableDockerAI` с точной резервной копией settings не устранило сбой; исходное значение `true` восстановлено из копии, вызванные этим запуском процессы Docker Desktop закрыты. `dockerInference` не удалялся и не переименовывался. Engine pipe отсутствует, `55432` закрыт; PostgreSQL suite остаётся ожидающей инфраструктуру. QA отчёт `ea1c030`, итоговая синхронизация альтернативного `dist/network/index.html` — `6dc39a1`.

## 2026-09-27 — Исправления сквозных memory-сценариев после аудита

- Независимый аудит воспроизвёл три расхождения memory API и PostgreSQL: повторный ингредиент в премиксе мог увести остаток ниже нуля; закрытие смены не прибавляло учтённые наличные продажи; локальная аналитика теряла `costOfGoods`, из-за чего `totalCostOfGoods` и 
etProfit` сериализовались как 
ull`.
- Исправлено: расход премикса агрегируется по позиции до проверки наличия; memory-сверка считает только cash payments текущей смены и блокирует закрытие при неатрибутированных платежах; аналитика агрегирует себестоимость по сохранённой себестоимости закрытых заказов и пересчитывает дневную/итоговую прибыль.
- Добавлены runtime-регрессии в `scripts/recipe-depletion-runtime-qa.mjs`: смешанные дубли ингредиентов `500 мл + 0,5 л`, отказ при совокупном расходе больше остатка без изменения данных, цепочка продажа→остаток→COGS→прибыль и кассовая сверка. Прогон memory API: 53 проверки — PASS. Полный `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3140` на свежем изолированном memory-процессе прошёл — PASS.
- Усилен `scripts/postgres-qa.mjs`: до запуска любых PG suites выполняется только read-only идентификационный запрос; URL и фактический endpoint должны быть loopback, имя БД — test/QA/scratch, фактические database/address/port должны совпасть с URL, тестовая роль должна иметь привилегию очистки. Переопределения хоста/порта/БД через query-параметры запрещены. Добавлен `scripts/postgres-qa-safety-contract.mjs`; тест проверки удалённого URL отклоняет его до соединения. Локальный port-forward/SSH tunnel должен быть выключен: его невозможно отличить от локального процесса только по `inet_server_addr()`. Сам runner не запускался, так как PostgreSQL Engine отсутствует.
- Docker Desktop обновлён до 4.91.0, но Linux Engine остаётся недоступен: pipe `dockerDesktopLinuxEngine` отсутствует, служба `com.docker.service` остановлена. Исправление повреждённого `dockerInference` ReparsePoint отклонено автоматическим policy review; не выполнялись обходы, сбросы или удаление данных.
- Визуальные скриншоты `qa-artifacts/visual-qa-2026-09-27/` датированы 22:08, после них `style.css` менялся в 22:34. Поэтому предыдущая матрица не является доказательством текущего CSS rev 294. Реальный UI-проход по current build остаётся `не проверено`: Computer Use остановился с сообщением, что URL браузера не удалось определить достаточно надёжно. Контракты desktop/Fold и source/dist parity проходят, но не заменяют скриншоты.
- Ограничение memory-финансов: endpoint `/api/expenses` без PostgreSQL возвращает пустой список, поэтому memory 
etProfit` сейчас означает только выручку минус себестоимость и не включает операционные расходы. Не следует считать это полной чистой прибылью. Неатрибутированный наличный платёж после открытия смены тоже блокирует закрытие до отдельного менеджерского разбора; это безопасный отказ, но recovery UX не реализован.
- VPS/production не открывались и не менялись. Commit/push для этого незаконченного candidate пока не создавался; дальнейший этап — независимый diff review, свежий визуальный рендер, восстановление изолированной PostgreSQL и затем повторная классификация статусов исходных 34 пунктов.

## 2026-09-27 — Повторная диагностика Docker Desktop

- Повторно проверено после обновления Docker Desktop до 4.91.0. CLI 29.8.0 настроен на `desktop-linux`; WSL 2.7.13.0 присутствует. Штатно запущена Windows-служба `com.docker.service` (сейчас Running) и выполнены попытки старта/перезапуска Docker Desktop CLI.
- Linux Engine всё ещё недоступен: `docker info` не открывает 
pipe:////./pipe/dockerDesktopLinuxEngine`, `docker-desktop` WSL distro остаётся Stopped. Свежий backend log указывает, что старт прерывается на недоступном нулевом ReparsePoint `C:\Users\ADMIN\AppData\Local\Docker\run\sailor-ingest.sock` (последняя ошибка: невозможно переименовать в `.stale`; `fsutil reparsepoint query` отвечает “The file cannot be accessed by the system”). Docker data не удалялись, factory reset и обход системной блокировки не выполнялись.
- Изолированная PostgreSQL QA остаётся заблокированной. Повторный runtime возможен после восстановления Docker Desktop/Engine; визуальная оценка rev294 также требует живого браузера и свежих screenshots.
- Дополнительный backend review выявил fail-open путь в `/api/metrics`: ошибка PostgreSQL ранее молча возвращала memory KPI. Теперь endpoint отвечает `503 database_unavailable`, чтобы не показывать устаревшие или ложные нулевые значения. Добавлен `scripts/metrics-database-failclosed-contract.mjs` и включён в `local-acceptance.ps1`.

## 2026-09-27 — Восстановление Docker и актуальная локальная приёмка

- Владелец подтвердил, что Docker готов. На изолированном loopback PostgreSQL 16 QA ранее прошёл полный прогон `scripts/postgres-qa.mjs` (9 suites, миграции 001–042, legacy данные, права, смены, payroll, складская цепочка). Финальная попытка пересборки runner image завершилась локальным OOM credential helper; новые concurrent assertions платежей поставщику не подтверждены этим запуском и остаются pending.
- После CSS rev 298 / portal rev 290 полный `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3145` — PASS. Затем при независимом review найден listener leak: `renderDashboard()` добавлял hashchange listener при каждом рендере. Исправлено заменой предыдущего обработчика на текущем shell-элементе. После последней правки: 
ode --check portal.js`, `admin-section-heading-contract.mjs`, `git diff --check` — PASS; полный acceptance после этой точечной правки не повторён.
- Свежий визуальный просмотр охватил геометрию 31 маршрута на 390 px и выборочные кадры главной/склада при 1440 px и склада при 390 px. Эти текущие кадры не сохранены отдельной матрицей; сохранённые 175 скриншотов предшествуют CSS rev 298 и не подтверждают последний набор. Повторные клики hash-навигации в живом браузере не подтверждены: Browser Use отклонил переход к preview URL по политике адреса. Визуальная приёмка после listener fix остаётся открыта.
- Отчёты уточнены: старые сведения о недоступном Docker и матрице 175 экранов помечены историческими; статусы исходных 34 требований оставлены консервативными. API, БД, миграции и VPS не изменялись/не проверялись.
# Пакет 044 — атомарная ручная корректировка бонусного баланса

**Дата:** 28.09.2026
**Статус:** реализовано и проверено локально
**Причина:** ручные изменения баллов могли расходиться между legacy-полем `loyaltyPoints` и `bonusBalance`; параллельные корректировки в PostgreSQL могли терять обновления.

- PostgreSQL API теперь блокирует строку гостя и применяет дельту бонусов одной атомарной операцией; возвращает согласованные `loyaltyPoints`/`bonusBalance`, ограничивает переполнение и не допускает отрицательный баланс.
- In-memory API и интерфейс также обновляют оба совместимых поля.
- QA проверяет четыре конкурентные корректировки, сумму после них, обе aliases и tenant isolation; локальный endpoint-проход проверяет запись и чтение обоих полей.
- Файлы: `server.js`, `portal.js`, `dist/portal.js`, `scripts/guest-loyalty-postgres-api-qa.mjs`, `scripts/local-guest-order.ps1`.
- БД/API: новая миграция не нужна; изменён обработчик `POST /api/clients/:id/loyalty-adjustments`.
- Проверки: 
ode --check server.js`, 
ode --check portal.js`, 
ode scripts/guest-loyalty-postgres-api-qa.mjs`, `scripts/postgres-qa.mjs` (43 миграции, 10 suites), `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3150`, `git diff --check` — PASS.
- Визуальная браузерная проверка недоступна: локальный preview сейчас отвечает `ERR_CONNECTION_REFUSED`; скрытые браузерные/CDP обходы не применялись.

# Пакет 045 — точность средней закупочной цены и независимая P&L сверка

**Дата:** 28.09.2026
**Статус:** реализовано; полный PG пакет требует повторного завершения

- Проверка сквозной цепочки нашла округление средней цены запаса до копеек за складскую единицу. Для мл это искажало себестоимость каждой продажи. Сохраняется точность 4 знака, доступная в существующей колонке `ingredients.cost numeric(12,4)`; результат техкарты округляется до валютных копеек.
- Регрессионный PG сценарий проверяет две позиции техкарты, реальную цену после новой поставки, rollback/retry, себестоимость и P&L/cashflow.
- Файлы: `db.js`, `scripts/recipe-depletion-pg-runtime-qa.mjs`, `FINAL_ACCEPTANCE_REPORT.md`.
- Изменений схемы/миграций/API нет; исправлена точность расчёта при записи weighted-average stock cost.
- Точечный прогон `recipe-depletion-pg-runtime-qa.mjs` — PASS (103 assertions) на отдельной disposable PostgreSQL 16 БД после применения `schema.sql` и 43 миграций.
- Последняя попытка полного `postgres-qa.mjs` прошла первые 9 suites и остановилась на слишком строгом сравнении float 3.299999999999997 с 3.3; assertion заменён на денежный допуск, после чего точечный recipe/P&L suite прошёл. Полный набор нужно повторить.
- Визуальный review статически обнаружил editor visibility, ложные нули KPI при загрузке и скрытие активного route в свернутой группе sidebar. Фиксы и browser-verify ещё не сделаны; текущий localhost отказывает в соединении.
- Повторная актуализация после проверки прав: выявлен обход permission через `PATCH /api/clients/:id`; orders-only роль не может менять loyalty group, bonus balance или deposit. Добавлена регрессия на отказ и сохранность БД. `guest-loyalty-postgres-api-qa.mjs` и все 10 PostgreSQL suites повторно прошли.

# Пакет 046 — складские состояния и навигационная ясность

**Дата:** 28.09.2026
**Статус:** реализовано; browser screenshot review ещё требуется

- Редактор складской позиции теперь ограничен вкладкой «Остатки» и скрывается при переходе к другим разделам.
- KPI склада и движений показывают `—` и состояние загрузки вместо ложных нулей; при ошибке явно показывается недоступность данных.
- При загрузке страницы раскрывается группа sidebar, содержащая текущий маршрут, так что активный пункт не прячется в сохранённой свернутой группе.
- Заголовок и дерево страницы финансовых категорий уточнены до «Категории доходов и расходов».
- KPI склада используют полное название «Технологических карт».
- Файлы: `portal.js`, `dist/portal.js`, `SITE_TREE.md`, `SITE_MAP.md`, `scripts/sidebar-navigation-contract.mjs`, `scripts/inventory-responsive-contract.mjs`.
- Миграций/API нет. Проверки новых contracts и общих sidebar/inventory contracts прошли. После пакета повторно выполнен полный `scripts/local-acceptance.ps1` на изолированном процессе — PASS. Свежего рендеринга пока нет, потому что доступная вкладка localhost показывает `ERR_CONNECTION_REFUSED`.
# Package 047 — PostgreSQL QA and guest-create permission hardening (2026-09-28)

- Docker Desktop Engine 29.8.0 on `desktop-linux` is available; a disposable PostgreSQL 16 QA container was used and removed after the run.
- Closed a privilege gap on `POST /api/clients`: callers whose only relevant access is `orders` may create ordinary guest profiles, but cannot set `discountGroupId`, `bonusBalance`, `loyaltyPoints`, or `depositBalance`. Finance, staff-management, and loyalty permissions retain those fields.
- Added PostgreSQL API regression checks for HTTP 403 and verified that denied creation persists no guest row.
- Validation: full PostgreSQL QA passed (10 isolated suites, including 103 assertions across the inventory/recipe/sales/COGS/payroll/P&L chain); full local acceptance passed on a temporary in-memory server; `git diff --check` passed. No schema or API contract expansion, migration, distribution asset, VPS, or production change.
- Remaining: fresh visual/Fold browser inspection is blocked by Browser Use policy for the local preview URL. Static UX audit still reports finance categories lack an archive recovery path; the finance rules panel is unrelated to that page; venue-layout settings heading conflicts with its sitemap label; one visual-rule label is stale. No fresh rendered visual evidence was captured.
# Package 048 — persistent guest audit and loyalty-program archive (2026-09-28)

- Fixed successful PostgreSQL guest create/update early returns so they await a persistent `audit_events` write before returning. Auditing remains best-effort by its repository contract; callers do not fail the completed data operation if the audit store is unavailable.
- Added program lifecycle management using the existing `active` field: authorized managers can list archived programs via `includeArchived=true`, archive/restore using `PATCH {active:boolean}`, and ordinary staff only receive active assignable programs. The loyalty screen now shows status, confirms archive, offers an archive filter, and supports restore. Existing guest foreign-key references are preserved; no delete or migration.
- Corrected the admin top-bar label for hall-layout settings to match `SITE_MAP.md`, and aligned the finance-categories page title in `VISUAL_PAGE_RULES.md` with its canonical route.
- PostgreSQL: all 10 isolated suites passed, including direct assertions for client-created/client-updated audit rows, manager-only archive visibility, active assignment list, restoration, and order-staff restrictions. Full local acceptance passed on a temporary in-memory server. Source/dist synchronization, JS syntax, admin-heading contract, and `git diff --check` passed. No new migration, production, or VPS access.
- Remaining confirmed UX gaps: `/finance/categories` has no visible recovery path for categories marked inactive and includes a rules panel unrelated to category management. The data model currently lacks a proper persisted finance-category lifecycle, so do not claim this repaired by superficial UI changes. Fresh browser/Fold rendering remains unverified because Browser Use denies the local preview URL.

# Package 049 — PostgreSQL QA replay and rendered local review (2026-09-28)

- Docker Desktop `desktop-linux` PostgreSQL QA container was available. The full `scripts/postgres-qa.mjs` suite passed on the isolated local `territory_qa` database: 13/13 suites, including 46-migration upgrade/replay, inventory department seeding, purchases/payables, guest loyalty and permissions, finance categories, payroll lifecycle, employee metrics, tasks, shift cash reconciliation, and the purchase → stock → multi-component recipe → sale/depletion → COGS → payroll → P&L/cashflow business chain (103 recipe-chain assertions).
- Full local acceptance passed on a fresh temporary in-memory process at `127.0.0.1:3152`; all route, role, asset, inventory, finance, guest/order, shift, staff, payroll, payments, and migration contracts completed. A first run against an already-used process correctly hit the two-session account limit; no shared sessions or database records were cleared. The fresh process was used for the passing run.
- Fresh browser screenshots were captured for the desktop dashboard and inventory at 1280×720. Dashboard date/shift controls, KPI grid, sidebar and top bar rendered consistently; inventory actions, stock summary, filters and table aligned without horizontal overflow at this viewport. The warehouse sidebar sublabels wrap on narrow content widths, which remains a small visual polish item. Samsung Fold/mobile rendered screenshots and every route at multiple breakpoints were not captured in this pass; responsive contracts pass but do not replace those visual checks.
- 
ode --check` for `server.js`, `db.js`, `portal.js`, `git diff --check`, and the 34-row final acceptance matrix contract passed. Source and `dist/` assets are synchronized at CSS rev 301 and portal rev 293.
- Production/VPS and live business data were not accessed. The checks establish local memory/PostgreSQL correctness for synthetic fixtures, not production health, real imported data, or deployed version. Existing unresolved UX item: finance-category archive recovery/lifecycle needs a genuine persisted design. No claim of 100% production readiness.

# Package 050 — 34-point baseline clarification and acceptance refresh (2026-09-28)

- Source checked: `CRM_TECHNICAL_SPEC_2026-09-24.md`, the original user-provided 34-point specification across stages 1–11. The matrix is a baseline, not a superset of later product requests (for example Fold-specific visual QA, staff personal-sales panel, premix UX, or warehouse visual catalog). Kept each requirement as a separate row and clarified scope/status in `FINAL_ACCEPTANCE_REPORT.md`.
- Fixed two defects from code-health review: task PATCH maps empty `assigneeId` to 
ull` consistently in PostgreSQL and in-memory mode; PostgreSQL QA container attestation now requires `AutoRemove=true` and rejects unsafe mounts/public bindings. Added unit-contract and runtime/PG E2E regression coverage.
- Warehouse hierarchy API now requires an active same-venue department before creating/updating a subdepartment or product category; create/reassignment and parent archival lock the parent in a transaction. PostgreSQL concurrency tests cover create/archive and reparent/archive for both child types, rejecting outcomes that leave an active child beneath an archived department. Task PATCH validates permissions, title/description/date and venue-local active assignee consistently.
- Responsive visual pass across 27 routes at 1024×768, 820×900, 717×900, 390×844, and 844×390 found and fixed: unreadable narrow category rows at 390 px and floor tables collapsed at Fold portrait width 717 px. Selected rendered pages were screenshot-reviewed; the matrix-wide checks were structural/geometry, not one screenshot per route/state.
- Files: `server.js`, `style.css`, `scripts/postgres-qa-safety.mjs`, `scripts/postgres-qa-safety-contract.mjs`, `scripts/tasks-qa.mjs`, `scripts/tasks-postgres-e2e-qa.mjs`, `scripts/inventory-subdepartment-api-qa.mjs`, `scripts/venue-inventory-departments-postgres-qa.mjs`, `scripts/local-acceptance.ps1`, `package.json`, `scripts/sync-published-assets.mjs`, synchronized HTML/CSS assets in `dist/`, `VISUAL_AUDIT_REPORT.md`, `FINAL_ACCEPTANCE_REPORT.md`.
- API/migrations: tightened existing `POST /api/inventory/subdepartments`, `DELETE /api/inventory/departments/:code`, and `PATCH /api/tasks/:id`; no new endpoint or DB migration.
- Checks: full local acceptance on fresh isolated process — PASS; all 13 isolated PostgreSQL suites on disposable PostgreSQL 16 — PASS; safety/task/inventory/design contracts — PASS; JS syntax and `git diff --check` — PASS. Data were synthetic and local only.
- Deployment: VPS/production untouched. After local validation, this package is committed and pushed to `origin/main`; the final commit hash is recorded in the assistant's delivery note. No claim of production readiness or 100% completion.
- Scope: owner explicitly excluded original requirement 34 from this repeat, confirming it was completed earlier; the report marks it as previously done and not reevaluated in this package.

# Package 051 — financial shift attribution and final local verification (2026-09-28)

- Corrected current-shift average check to group complete paid/partially-paid check totals by `closed_in_shift_id`; actual cash receipts remain attributed to `payments.shift_id`. This avoids treating a partial payment received in an earlier shift as the current shift’s full ticket value. The demo/browser fallback follows the same closing-shift rule.
- Corrected PostgreSQL `/api/analytics` to compute true period and daily median from individual closed tickets in venue-local time. In-memory analytics already computed individual-ticket medians; now it computes the period median from the period’s tickets, not the mean of daily medians.
- Added `finance-shift-analytics-postgres-qa.mjs` and registered it in `postgres-qa.mjs`. It creates isolated fixtures with tickets 100/100/900 and a 300 ticket split 100+200 across shifts; asserts 1,400 total revenue, 350 arithmetic average, 200 median (period and day), and 300 average check for the shift that closed the split ticket. Reuses shared DB URL and live-identity safety guards before writing and avoids an exit-listener hang after early child-server failure.
- Updated source/dist portal revision to 294 and refreshed acceptance/visual audit notes. Owner explicitly requested skipping original item 34 as completed previously; the matrix preserves it as “previously completed; not rechecked.”
- Files: `server.js`, `portal.js`, `scripts/finance-shift-analytics-postgres-qa.mjs`, `scripts/postgres-qa.mjs`, `scripts/sync-published-assets.mjs`, synced source/dist HTML and `dist/portal.js`, `FINAL_ACCEPTANCE_REPORT.md`, `VISUAL_AUDIT_REPORT.md`.
- API changes: existing `GET /api/finance/summary` and `GET /api/analytics`; no new API routes or DB migrations.
- Verification: all 14 PostgreSQL suites passed on a disposable local PostgreSQL 16 QA container; complete local acceptance passed on a fresh in-memory localhost process; source/dist static checks, route review (14 pages, 7 inventory views, 11 admin hash sections), scroll-to-bottom review, 1280×720 screenshots for dashboard and recipes, 
ode --check` and `git diff --check` passed. Code-health review cleared the implementation after a 5432 default-port correction.
- Visual boundary: all listed routes had a browser route/title/overflow/scroll scan at 1280×720, but not a saved screenshot for every page/state. Fold/390 px visual rendering and physical device QA are not confirmed.
- Deployment: code changes committed and pushed to `origin/main` as `ad6fe6443762abdc8b45d42962899032784ad53d`; the final evidence-note update is committed separately after that functional package. No VPS or production connection, migration, data, or deploy. No 100% production-readiness claim.

# Package 052 — discount allocation, narrow visual fixes, and acceptance rerun (2026-09-28)

- Fixed approved fixed-amount discounts in memory analytics and PostgreSQL analytics: net check values are allocated proportionally across product/station/staff aggregates, with cent-level reconciliation. A zero-total order from a 100% discount remains zero instead of falling back to gross value. PostgreSQL regression asserts the full finance breakdown reconciles, including zero-paid free orders.
- Removed decorative revenue spark bars that had no backed time-series data. Stacked inventory department/subdepartment form fields with labels at widths up to 600px; synchronized source and `dist/**` and advanced portal/CSS cache revisions.
- Full 
pm run qa:postgres` rerun passed all 14 isolated PostgreSQL suites, including shift cash and close, fixed/100% discounts, split payments, median checks, payroll, purchases, inventory, and recipe-to-COGS/P&L. Full `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3192` passed. Additional finance, visual, matrix, JS syntax, source/dist and `git diff --check` contracts passed.
- Local browser spot checks at about 451px wide covered dashboard, orders, clients, inventory and settings; the updated department form was visually checked after stacking. This is not a screenshot-per-route audit or physical Fold acceptance.
- Corrected `COMPLETION_MATRIX.md`: X/Z reporting and schedule→actual time→payroll are partial, not fully verified. `FINAL_ACCEPTANCE_REPORT.md` now lists current test evidence, explicitly skips owner-excluded item 34, and does not claim production readiness. `VISUAL_AUDIT_REPORT.md` records the limited screenshot scope.
- No schema migration or new API endpoint. Existing finance summary/analytics responses were corrected. VPS/production were not accessed. Package is currently uncommitted and unpushed; working-tree changes remain reviewable.

# Package 053 — Sidebar visual polish (1/15) (2026-09-28)

- Refined the narrow-screen sidebar drawer: softened the backdrop so the workspace remains recognizable, aligned the close button to the actual drawer width, raised the menu toggle to a consistent 44×44 touch target, and accounted for device safe areas and dynamic viewport height.
- Kept route, permission, drawer focus/keyboard, and desktop navigation behavior unchanged. No API or database changes.
- Synchronized `style.css` revision 306 across source and `dist/**` (41 route templates).
- Checks: sidebar navigation contract, 27-invariant Fold responsive contract, 11-route header shell contract, JavaScript syntax for changed checks/sync script, and `git diff --check` all passed.
- Visual boundary: the current screenshot showed the drawer in a narrow viewport; source-level visual fix and responsive contracts are verified. A pixel screenshot of the updated production page has not yet been captured because this local Windows session currently has no Docker Desktop Linux engine.
- VPS remains on its current release until the validated sidebar change is included in the next publishable package.

## Package 053 — Sidebar submenu clarity (2/15) (2026-09-28)

- Removed repeated decorative icons from links inside expandable sidebar groups. Group icons remain the visual anchor in desktop and compact drawers; child labels align under the group title at both widths. Route links, permissions, active states, and tooltips are unchanged.
- Recorded the navigation visual rule in `VISUAL_PAGE_RULES.md`, `SITE_TREE.md`, and `site-map.json`; extended sidebar, Fold, and visual-rule contracts.
- Advanced shared CSS cache revision to 307 and synchronized all 41 static route templates and `dist/style.css`.
- Checks: sidebar navigation, 28-invariant Fold responsiveness, header shell, visual-page rules, site structure, changed-script syntax, `dist/style.css` parity, and `git diff --check` all passed.
- Visual screenshot remains unavailable in this checkout; the browser blocked local-file preview, and Docker Desktop's Linux engine is not connected. No VPS deployment was performed.

## Package 053 — Explicit HTTP release mode (3/15) (2026-09-28)

- The owner requested deploying the sidebar update to the existing HTTP VPS while keeping `COOKIE_SECURE=false`. The standard deploy gate previously required HTTPS and rejected this authorized setup.
- Added a one-invocation opt-in `ALLOW_HTTP_DEPLOY_ONCE=true` for this release; it is captured before `.env` is loaded and is not persisted. Authentication remains required, default HTTPS mode is unchanged, and each later HTTP release needs its own explicit opt-in.
- No API, database, schema, or migration changes. The cookie setting and TLS configuration remain unchanged.
- Checks before release: deploy contract, shell syntax, sidebar/Fold/header/site-tree checks and source/dist parity. VPS state and backup are checked before deployment.

## Package 053 — Executable VPS release scripts (4/15) (2026-09-28)

- A clean clone on the VPS exposed that deployment scripts documented as `./script.sh` were committed without executable Git modes. Marked deploy, backup, migration, post-deploy acceptance, and backup verification scripts executable so a fresh immutable checkout can run the documented release path without dirtying it.
- No script content, API, database, migrations, or server configuration changed in this item.
- Checks: POSIX shell syntax validation via the VPS shell and release contract.

## Package 054 — Remove sidebar page-transition flicker (1/15) (2026-09-28)

- Root cause: each sidebar destination is a separate HTML document, but the route-entry animation began only after the old document had unloaded and faded the new, initially empty content area. That can read as a flash instead of a transition. A click listener also redundantly assigned the same URL as the native anchor; it is removed to keep navigation fully browser-native.
- Removed the page-load-only content animation; in-page/hash transitions retain their local motion. Keyboard activation, modifier/middle-click, and browser history continue to use ordinary anchors.
- Added a 160 ms same-origin cross-document View Transition as progressive enhancement, with the shared sidebar/header named across admin and employee shells. Browsers without support continue normal navigation; `prefers-reduced-motion` disables the transition.
- Updated the shared visual rule, navigation/visual contracts, and source/dist cache revisions (CSS 308, portal 297). No API, database, schema, or migrations changed.
- Checks: sidebar navigation contract, visual page rules contract (14 pages/11 admin subsections), 28-invariant Fold contract, 11-route header-shell/source-dist contract, JS syntax, asset sync, and `git diff --check` passed. The local URL redirects to login, so an authenticated rendered CRM route was not available for browser-transition capture in this pass.
- Release: local change only; not deployed to VPS. Per the package workflow, it is queued as `1/15` for the next validated release. If a supported browser still shows movement after the document transition, the remaining cause may be asynchronous data reflow after the transition completes.

## Package 054 — Sidebar consistency polish (2/15) (2026-09-28)

- Fixed an interaction conflict where clicking the active route group closed it, but route normalization immediately reopened it. Explicitly saved collapse/expand choices now remain in force across refreshes; when the active child is inside a collapsed group, the group heading keeps a visible active marker and `aria-current` state.
- Removed the 901–950px sidebar width override that caused a sudden width change at 950/951px. Laptop and wide desktop use one fluid width rule, with compact drawer behavior retained at 900px and below.
- Replaced the invisible management sidebar scrollbar with a thin dark-theme scrollbar; both management and employee sidebars now remain pinned and independently scroll when their content exceeds a short window.
- Updated the visual rules and sidebar regression contract. No routes, access rules, API, database, or server settings changed.
- Checks: sidebar navigation contract (including width continuity at 949–952px and 1179–1181px), visual page rules, Fold responsive, shared header, asset synchronization, JS syntax, and `git diff --check` passed.
- Release: local changes only; not deployed to VPS. Authenticated local browser rendering was not available for this pass, so final pixel-level comparison on the server build remains part of release QA.

## Hookah CRM additional acceptance (2026-09-28)

- Added nullable supplier-document number/date behavior and separated supplier date from the immutable system record timestamp; added PostgreSQL migration 047. Added category-to-subdepartment ownership with same-venue integrity and conservative legacy backfill; added migration 048 and editor selection.
- Corrected PostgreSQL floor reads so newly-created empty halls remain visible; lock/unlock now reloads current PIN hash from PostgreSQL and preserves the original login session, while cross-tab lock events cannot invent PIN configuration for a user without a PIN.
- Added direct numeric PostgreSQL examples for 100 g tobacco pack → 18 g recipe → 82 g stock → 21.60 ₽ COGS; 700 ml bottle → 50 ml cocktail → 650 ml stock → 25 ₽ COGS. Tested nullable invoice dates/numbers, hierarchy ownership/concurrency, hall/table persistence, weighted average valuation, purchase settlement, payroll/P&L and shift cash.
- Full local acceptance passed at localhost, and all 14 PostgreSQL QA suites passed on an isolated disposable PostgreSQL 16 container. Fresh browser screenshots reviewed dashboard, stock, receipt/movement form and department/category pages at desktop 1280×720. A clean demo server was used after the acceptance suite left synthetic QA rows in its process; the browser screenshot review used an unmodified empty demo state.
- Traceability: created `HOOKAH_CRM_ADDITIONAL_ACCEPTANCE.md` with an individual evidence/status row for each of the 50 new points. The review identifies remaining product-model gaps: structured alcohol/tobacco attributes and taxonomies, receipt reversal flow, broader cost boundaries, full UI E2E, mobile screenshot review, and production data validation. Thus the 50-point scope is not complete and must not be represented as 100% done.
- No commit or push has been made from this detached checkout. No production/VPS was accessed or modified. No real-world inventory records were imported.
- Independent code-health review then caught cross-tab logout being confused with PIN unlock, stale tabs not reacting to bearer-session replacement, and an unscoped migration constraint-name guard. Fixed by explicit session-end events/redirects, explicit successful-unlock events, synchronizing PIN configuration/auto-lock across tabs, and scoping migration 048's FK existence query to `product_categories`. Added a PostgreSQL migration test for duplicate constraint names on a different table and extended the local lock contract. Final local acceptance, all 14 PostgreSQL suites, the 50-item traceability contract, source/dist synchronization, JS syntax, and diff whitespace checks passed after these fixes.
- A fresh two-tab localhost browser test confirmed that logout in one tab sends the other tab to `/login`. Fresh mobile screenshots and hardware Fold verification are still not part of this run.
- Added a clear “Отменить черновик” receipt action. The API locks the document and permits draft→voided only; it keeps history, releases auto-order draft reservation, and writes an audit event without creating stock movements. PostgreSQL coverage asserts unchanged stock and rejects repeat cancellation or cancellation of a posted receipt. Posted-document reversal remains explicitly out of scope until a balancing stock movement workflow is implemented. Re-ran all 14 PostgreSQL suites against a disposable loopback-only PostgreSQL 16 database after this change: PASS. Re-ran the complete local acceptance suite on a dedicated QA server with raised in-process request cap: PASS; no production rate-limit setting changed.

## Уточнение процесса: отменён лимит «15 правок» (2026-09-28)

- По прямому указанию владельца снято правило, что выпуск обязан ждать накопления 15 правок или что прогресс должен маркироваться `1/15`.
- `DEVELOPMENT_WORKFLOW.md` теперь группирует работу по совместимой области и критериям приёмки; прогресс фиксируется результатом, проверками и рисками. Исторические записи счётчика остаются историей и не являются действующим release gate.
- Не коммитил и не публиковал изменение этого правила отдельно от текущей незавершённой работы.

## Повтор QA дополнительного ТЗ (2026-09-28)

- Актуальный `scripts/postgres-qa.mjs`: все 14 изолированных PostgreSQL suites PASS; recipe/depletion suite — 156 assertions. Добавлены справочные категории в fixtures, чтобы тест отражал новое правило API: позиции нельзя создавать со свободно набранной неизвестной категорией.
- `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3228`: PASS на новом memory-процессе; предыдущий запуск на уже использованном процессе упёрся в лимит двух сессий после накопления логинов из тестов, а не в дефект кода.
- Дополнительная матрица из 50 пунктов, матрица исходных 34 пунктов, inventory API/race suite, PIN, purchase contracts, JS syntax, sync source/dist, `git diff --check`: PASS.
- Независимый code-health review подтвердил отсутствие найденной гонки в проверенных write paths. Он обнаружил остаточное различие семантики зарплаты между PostgreSQL accrual и demo/memory; пункт 21 матрицы оставлен «Частично» до общего набора parity fixtures/модели начислений.
- Визуальная граница прежняя: последнее evidence — выборочные скриншоты локальной CRM на desktop 1280×720; не является полным свежим визуальным проходом по Fold/mobile. VPS/production не проверялись и не менялись.

## Визуальная перепроверка выбранных маршрутов и отмена счётчика — 28.09.2026

- По прямой просьбе владельца отменено ожидание пакета `1/15`; исторические записи не переписывались. Согласованы `DEVELOPMENT_WORKFLOW.md` и `docs/AI_ORCHESTRATOR.md`: критерии готовности остаются, лимита/счётчика больше нет.
- На screenshot review подтверждены и исправлены два дефекта: действия в карточках техкарт имели разную вертикальную позицию; фильтры склада на узком экране сливались рамками. В CSS 312 выравнивание футера закреплено через flex-column и `margin-top:auto`, а mobile filters стали одноколоночными, полноширинными с gap 8 px.
- Headless Edge проверил 15 выбранных маршрутов/разделов на 1024, 820, 717 и 390 px (68 комбинаций): неправильная dashboard-метка исправлена на `/admin`; горизонтального переполнения нет. Свежий CSS 312 screenshot/DOM подтверждает: stock filters gap=8px, document width 390; recipe action tops совпадают (730px, 730px, 730px), document width 1280.
- Проверки после UI-правок: local design contract, sidebar contract, header shell contract, acceptance-matrix contract, 
ode --check` для server/portal/db и `git diff --check` — PASS. Источник и `dist/style.css` синхронизированы. Новых API/DB/migrations нет.
- Ограничение: просмотрены видимые верхние состояния выбранных маршрутов; не все формы/диалоги и внутренние полосы прокрутки, не физический Fold, не VPS/production.

## Полная локальная приёмка и защита себестоимости — 29.09.2026

- Закрыты складские граничные случаи: пустая legacy recipe header, неоднозначный name-only рецепт при повторяющихся названиях, несколько прямых sale-карт, связывание карты с 
on_stock`, гонки между сменой режима и заказом/картой. Демо и PostgreSQL одинаково запрещают привязанную товарную техкарту переводить в премикс. Продажа с неизвестной/неоднозначной учётной моделью теперь завершается отказом до изменения оплаты, остатка и COGS.
- Полный локальный acceptance на чистом demo-процессе `127.0.0.1:3240` — PASS. Все 14 PostgreSQL QA suites — PASS; recipe/depletion runtime — 233 assertions, memory recipe runtime — 84 checks. Миграции 001–049 прошли replay/upgrade, legacy записи сохранены. Статические contracts и source/dist синхронизированы.
- Свежие визуальные кадры: dashboard и склад 390×844 (верх/низ), узкая форма товара около 570 px; ограничения по полному покрытию всех экранов и физическому Fold сохранены в отчёте.
- Правило ожидания `1/15` отменено ранее; старые записи `1/15` в журнале — только историческая документация, они не ограничивают работу/релиз.
- Всё проверено локально с синтетическими QA-данными. VPS и production не изменялись; изменения остаются незакоммиченными на detached checkout.


## VPS release — 29.09.2026

- Владелец запросил обновление сервера. До выкладки подтверждены доступность `territory-vps`, active release `e3a21b1`, чистые предыдущие checkout, health PostgreSQL и отсутствие миграций 047–049 в фактической схеме. `AUTH_REQUIRED=true`, `COOKIE_SECURE=false`.
- Новый clean checkout `/opt/territory-crm/releases/7929098` получен из GitHub branch `codex/hookah-crm-full-audit-2026-09-29`; commit `7929098db8b74f226ae47836aa1b82a7f3ef55ba`, dirty paths 0. Compose config прошёл preflight.
- До изменений данных создан backup `/var/backups/territory-crm/territory-crm/crm-pre-e631a90bb5815d281a14e5d6aa7e83f05b64b1a146273a775376480922be8111.sql.gz` (35 932 bytes, mode 600); `gzip -t` и restore в одноразовую БД прошли. Deploy script повторно использовал тот же verified backup.
- С `ALLOW_HTTP_DEPLOY_ONCE=true` (ранее явно согласованный HTTP релиз) выполнен `deploy-vps.sh`; `COOKIE_SECURE` не менялся. Миграции 047/048/049 применены штатным runner. Seed синхронизировал 10 категорий/66 позиций. Контейнер healthy; `/api/health` вернул PostgreSQL, `/admin`, `/inventory`, `/orders`, `/finance`, `/clients`, `/reservations` — HTTP 200. Release fingerprint `e631a90bb5815d281a14e5d6aa7e83f05b64b1a146273a775376480922be8111`, image `sha256:8d82537d4497b999dcd40f8e3fae92837a770e5d4f69e323a7ceab8cd6d0effe`.
- Ограничение: после развертывания не выполнялся вход реальным пользователем/операции на настоящих бизнес-данных; Fold аппаратно не тестировался. Это deployment smoke, не production sign-off всей CRM.


## UX и термины бронирований, задач и склада — 29.09.2026

- Диагноз независимой UX/code-health проверки: пустой список броней смешивал отсутствие записей, несовпадение фильтра и сетевую ошибку; при ошибке PATCH задачи select визуально оставался на несохранённом статусе; в остатках «Минимум» и «Контроль отключён» не поясняли значение порога. Второе представление техкарт имело неполное пустое состояние для read-only роли.
- Исправлено: бронирования теперь различают пустую базу, пустой результат и ошибку загрузки, дают просмотр всех дат/сброс фильтров или повтор запроса; для reduced-motion дополнительно отключено смещение кнопок меню сотрудника; изменение статуса задачи блокирует повторное действие и возвращает сохранённое значение при ошибке; таблица остатков поясняет «Порог пополнения» и показывает «Порог не задан» при нулевом пороге без изменения расчётов; пустое состояние техкарт стало одинаково объяснять назначение карты владельцу и роли только для чтения.
- Файлы: `portal.js`, `style.css`, `scripts/sync-published-assets.mjs`, `scripts/visual-page-rules-contract.mjs`, `scripts/inventory-responsive-contract.mjs`, `scripts/inventory-stock-status-qa.mjs`, `VISUAL_PAGE_RULES.md`, `WAREHOUSE_PAGE_PROMPT.md`, `SITE_TREE.md`, `docs/ai-team/WORK_LOG.md`, generated `dist/**`. API, БД и миграции не менялись.
- Проверки: полный `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3242` — PASS; 14 маршрутов/26 ресурсов, роли, задачи, складские 55 проверок, техкарты 84 проверки и пользовательские CRUD-сценарии прошли. Контракты визуальных правил, Fold, навигации, шапки, склада/адаптивности/порогов остатков, source/dist синхронизации, syntax checks и `git diff --check` — PASS. Устаревшие ожидания двух складских контрактов обновлены под единый термин «Порог пополнения».
- Ограничение: скриншотная браузерная приёмка локального адреса заблокирована browser security policy; policy запрещает обход через другой браузер или протокол. Из-за этого фактическую композицию каждого состояния нельзя считать визуально подтверждённой в этом проходе.


## Расширение постоянного визуального контракта — 29.09.2026

- Независимая read-only проверка обнаружила пробелы в описании загрузки/пустого результата/API-ошибки/успеха на data-страницах, расхождение правила `/orders` с Fold-контрактом и двусмысленную формулировку прокрутки sidebar.
- Правила уточнены: каждый data-экран обязан различать четыре состояния и защищать от повторной отправки; `/orders` переключает строки в подписанные карточки до 760px; sidebar прокручивает длинную область групп и имеет самостоятельную прокрутку только как fallback для низкого окна; добавлен объективный порог контраста WCAG AA для обычного и крупного текста/значимых элементов. Подтверждённые дефекты интерфейса этим пунктам предстоит находить отдельным runtime-визуальным проходом, документация сама по себе не доказывает их исполнение.
- Проверки контракта страницы и локального дизайна — PASS после изменения постоянных правил; это не визуальное подтверждение всех экранов.


## Залы и столы: сохранение имён и полный локальный CRUD — 29.09.2026

- Проверка воспроизвела дефект: при создании или удалении обычного стола backend переименовывал все оставшиеся столы в зале по порядку, затирая введённые названия. Аналогичное поведение было в demo API. Карточка зала также называла количество столов «посадочными местами».
- Удалена автоматическая перенумерация имён во всех серверных/демо ветках; счётчик теперь корректно показывает «стол/стола/столов». Формы защищены от повторной отправки. После успешного сохранения, если обновить список не удалось, интерфейс сообщает, что объект создан, а список не обновился; тексты действий уточнены для зала, стола и VIP-комнаты.
- Миграций и изменений схемы БД нет. Обновлён регрессионный контракт создания зала, двух именованных столов, комнаты, редактирования, защиты непустого зала, удаления и сохранения названий оставшихся столов.
- Проверено на изолированном локальном API и disposable PostgreSQL 16 с чистой схемой и всеми 49 миграциями: создание → GET после перезагрузки → создание второго стола без переименования первого → изменение комнаты/вместимости/депозита → защита удаления занятого зала → удаление столов и зала. Оба runtime прогона контракта PASS; проверки дизайна/source-dist, Fold, правил страниц, синтаксиса и `git diff --check` PASS.
- Проверка реальных production-залов не выполнялась. Скриншотная приёмка админ-формы недоступна из-за browser security policy, поэтому визуальное отображение не заявляется как подтверждённое.

## Визуальная проверка бронирований и исправление пустого состояния — 29.09.2026

- На фактическом production-экране бронирований при 1280px найдено наложение кнопки «Показать все даты» на пояснение пустого списка. Заголовок «Ближайшие бронирования» ломался на две строки, потому что заголовок, поиск и календарь конкурировали в узкой flex-панели; фиксированная ширина даты дополнительно сжимала фильтры.
- Перестроены элементы шапки списка в двухколоночную сетку с заголовком на отдельной строке; дата и поиск занимают отдельные равные ячейки. На узком телефоне фильтры складываются вертикально. Пустое состояние теперь выводит заголовок, пояснение и действие в отдельные строки с устойчивым интервалом.
- Файлы: `style.css`, `dist/style.css`, `scripts/visual-live-defects-contract.mjs`. CSS-ревизия обновлена до 315; backend, API, БД и миграции не менялись.
- Проверки: визуальный контракт дефектов, визуальные правила 14 маршрутов/11 подразделов администратора, Fold-контракт 28 инвариантов, local design contract, 
ode --check portal.js`, source/dist синхронизация и `git diff --check` — PASS.
- Скриншот до исправления подтверждает дефект на живой странице. Повторный пиксельный скриншот исправленной версии не снят: локальный предпросмотр `127.0.0.1:3239` недоступен, а production ещё содержит предыдущую ревизию CSS. Backend или production-данные не менялись.

## Визуальная проверка базы гостей — 29.09.2026

- На production read-only осмотре `/clients` (1280×720) фильтры периода, поиска, статуса и сортировки располагались неравномерно: сортировка переносилась на отдельную строку, остальные поля оставались без видимых подписей. После открытия редактора список естественно сужается; группы гостей переносятся на следующую строку без обрезания. Сохранение/изменение production-данных не выполнялось.
- Исправлено локально: всем четырём фильтрам добавлены одинаковые видимые подписи и одинаковая высота; широкая сетка выравнивает их в один ряд, планшетная — в два столбца, мобильная — в один. Правило закреплено в `VISUAL_PAGE_RULES.md`; контракты проверяют подписи и контрольные сетки. CSS/JS revision подняты для всех исходных и опубликованных маршрутов.
- Файлы: `portal.js`, `style.css`, `VISUAL_PAGE_RULES.md`, `scripts/sync-published-assets.mjs`, `scripts/visual-live-defects-contract.mjs`, `scripts/visual-page-rules-contract.mjs`, опубликованные HTML/JS/CSS артефакты. API, БД и миграции не затронуты.
- Проверки после локальной правки: visual-live-defects, visual-page-rules, local-design, Fold-responsive, JS syntax, source/dist parity и `git diff --check` — PASS.
- Ограничение: production-страница показала состояние до локальной правки. Локальный браузерный preview недоступен (`ERR_CONNECTION_REFUSED`), поэтому post-fix screenshot не подтверждён; на VPS это изменение не выкладывалось.

## Финансы: выравнивание зарплатных фильтров и файла расхода — 29.09.2026

- На production при прокрутке `/finance` найден визуальный дефект: в фильтрах зарплатного реестра подписи периода и сотрудника оказывались на одной линии с соседними контролами; поля разной фактической высоты, действие «Обновить» выпадало из общего ритма. В форме расхода стандартная кнопка выбора файла отличалась от остальной тёмной темы.
- Локально фильтры переведены на явную сетку: подписи над полями, согласованные высоты, 4 поля с действием на широком экране, 2 колонки на компактной ширине и одна на телефоне. Выбор файла получил оформление кнопки и состояния светлой темы. Расчёты финансов и API не изменялись.
- Закреплено в `VISUAL_PAGE_RULES.md`; расширен `finance-required-marker-contract.mjs`. Миграций/изменений БД нет. CSS revision 317 синхронизирована с 41 исходной/публичной страницей.
- Контракты финансовых фильтров/документа, пустой диаграммы, видимости финансов сотрудника, часового пояса, правил страниц, дизайна, Fold и `git diff --check` — PASS.
- Ограничение: production screenshot подтверждает состояние до исправления. Повторный screenshot локальной версии после правки не получен: локальный preview `127.0.0.1:3239` недоступен. VPS не обновлялся.

## Интеграции: убраны неактуальные заглушки, оставлен Telegram — 29.09.2026

- На production визуально проверено `/integrations`: перед блоком Telegram находились четыре блока справочников табака/алкоголя/пива/энергетиков. Они назывались интеграциями, хотя были статическими примерами с локальной активацией; на странице также был встроен PIN-код, проверяемый только в браузере. Это противоречило принятому объёму «пока только Telegram» и могло создать впечатление готовых подключений.
- Страница упрощена до одной интеграции Telegram. Статус различает «Проверяем», «В разработке», «Подключено» и «Статус недоступен»; пояснение не обещает функций, которых нет. Удалены фиктивная PIN-активация и неиспользуемые товарные справочники со страницы и клиентского кода. Один информационный блок теперь не оставляет пустую вторую колонку.
- Правило обновлено в `VISUAL_PAGE_RULES.md`, текущий состав страницы — в `SITE_TREE.md`; создан `integrations-scope-contract.mjs`, добавлен в локальный acceptance runner. API и БД не менялись. `portal.js` revision 309, CSS revision 318; source/dist синхронизированы по 41 шаблону.
- Проверки интеграций-scope, обязательных финансовых полей, навигации, визуальных правил, дизайна, Fold и JavaScript syntax — PASS; `git diff --check` — PASS.
- Ограничение: production screenshot подтверждает прежнее перегруженное состояние; после изменения повторный screenshot недоступен, потому что локальный preview не запускается. VPS не обновлялся.

## Склад: читаемые заголовки таблицы остатков — 29.09.2026

- На production `/inventory` (1280×720) у таблицы остатков заголовки «Порог пополнения» и «Состояние» визуально слипались: их закреплённые ширины суммарно составляли 28%, но `white-space:nowrap` выталкивал длинную подпись в соседнюю колонку.
- Перераспределены ширины шести колонок (20/17/11/18/17/17%), заголовкам разрешён перенос по строкам с устойчивой межстрочностью и выравниванием по нижней линии. Карточный режим Fold/телефона сохранён.
- Закреплено в `WAREHOUSE_PAGE_PROMPT.md` и `VISUAL_PAGE_RULES.md`; `inventory-responsive-contract.mjs` теперь проверяет ширины и перенос заголовков. Данные, API и БД не менялись; CSS revision 319 синхронизирована для исходных и dist-маршрутов.
- Складские responsive, hierarchy, status, context, page-rules, local-design и Fold contracts прошли; `git diff --check` — PASS.
- Production screenshot подтверждает состояние до исправления; повторно визуально проверить новую CSS-ревизию можно после доступности preview или выкладки. VPS не обновлялся.

## Каталог товаров: разные пустые состояния — 29.09.2026

- На production `/inventory?view=products` с пустой базой каталог показывал «Товаров по запросу нет», хотя поиск был пустой и товары ещё не создавались. Это ошибочно описывало состояние как неудачный поиск.
- Исправлено: пустой справочник объясняет, что каталог пока пуст и первый товар появится в заказах; при существующих товарах и запросе без совпадений интерфейс предлагает изменить запрос. Никаких данных на production не добавлялось.
- Правило закреплено в `WAREHOUSE_PAGE_PROMPT.md` и `VISUAL_PAGE_RULES.md`; `inventory-context-contract.mjs` проверяет разницу пустого каталога и результата поиска. API/БД не менялись; `portal.js` revision 310 синхронизирован с dist.
- Контракты inventory-context, inventory-responsive, визуальных правил, local-design, Fold и 
ode --check portal.js` — PASS; `git diff --check` — PASS.
- Production screenshot отражает состояние до исправления; повторный скриншот исправленного состояния невозможен без работающего локального preview или выкладки. VPS не менялся.

## Каталог товаров: защита незавершённой карточки — 29.09.2026

- При визуальном осмотре формы создания товара обнаружил, что повторное нажатие «Добавить товар» оставалось доступно и сбрасывало все уже введённые данные без предупреждения.
- Пока редактор открыт (создание или изменение), действие добавления теперь отключается и показывает «Форма открыта»; после сохранения или отмены возвращается исходная кнопка. Введённые данные нельзя случайно потерять повторным нажатием заголовочного действия.
- API и БД не менялись. `inventory-context-contract.mjs` проверяет закрытие этого пути потери введённых данных; `portal.js` revision 311 синхронизирована с dist.
- Inventory context/responsive, visual-page-rules, local-design, Fold, JS syntax и `git diff --check` — PASS. Проверку сделал по production screenshot до исправления и статическому контракту после него; исправленный runtime-скриншот ограничен недоступностью локального preview. VPS не обновлялся.

## Залы и столы: сквозной сценарий и вместимость — 29.09.2026

- В изолированном локальном demo runtime визуально пройдено создание пустого зала, автоматическое открытие формы первого стола, сохранение стола, редактирование диапазона гостей, отображение на рабочем экране и выбор стола в заказе. Production данные не затрагивались.
- Исправлено: создание стола в in-memory API теперь сохраняет `minCapacity`/`maxCapacity`; редактор таблицы сохраняет обе границы и показывает валидацию диапазона до отправки. При пустом списке залов действия «Стол» и «VIP-комната» отключены с пояснением; обновление списка не сбрасывает форму/выбранный зал и повторно её не открывает.
- Исправлено отображение рабочего зала: показывается имя места и диапазон с корректным склонением; названия безопасно выводятся как текст. UUID от PostgreSQL сохраняется без преобразования в `table-UUID`, а рабочая панель и очередь показывают название стола, не внутренний ID.
- Изменены `server.js`, `portal.js`, `app.js`, `VISUAL_PAGE_RULES.md`, `SITE_TREE.md`, `scripts/local-floor-management-contract.mjs`, `scripts/visual-page-rules-contract.mjs`, `scripts/sync-published-assets.mjs`; статические копии `dist/**` и 41 HTML-маршрут синхронизированы (app rev 133, portal rev 313). Новых миграций нет; SQL-схема и URL API не менялись, memory API теперь возвращает те же границы вместимости, что и PostgreSQL.
- `local-floor-management-contract` прошёл реальный CRUD на временном in-memory сервере, включая reload, защиту удаления непустого зала, некорректный диапазон, редактирование и повторное чтение. Отдельно проверена нормализация PostgreSQL UUID и разрешение human-readable label. Визуальные правила, local design, JS syntax и `git diff --check` — PASS. VPS не менялся.

## Бронирования: выбор стола с контекстом зала — 29.09.2026

- Повторно проверил пользовательский маршрут после настройки залов. В форме бронирования все места ранее шли единым списком: при одинаковых названиях нельзя было отличить столы разных залов, а вместимость в выборе отсутствовала.
- Список выбора теперь группирует места по залам, показывает вместимость и депозит, помечает закрытые места и не даёт их выбрать. При обновлении списка сохраняется всё ещё доступный выбор; поле повторно включается, если стол появился после первоначально пустой загрузки. Пустой зал и зал, где все места закрыты, получают разные объяснения.
- БД, API-маршруты и схема не менялись. Добавлены проверки генерации вариантов для нескольких залов, повторяющихся имён, диапазонов гостей, VIP-депозита, закрытых и пустых мест; правило закреплено в `VISUAL_PAGE_RULES.md` и `SITE_TREE.md`. `portal.js` revision 314 синхронизирована с опубликованными копиями.
- `local-floor-management-contract` с реальным CRUD зала/столов, `visual-page-rules-contract`, 
ode --check portal.js` и `git diff --check` — PASS. UI проверен на отдельном демо-сервере; сохранённая браузерная сессия оказалась заблокирована PIN-экраном, поэтому создание брони через экран не выполнялось. VPS не менялся.

## Бронирование мест: вместимость и статус даты — 29.09.2026

- Углублённая сквозная проверка зала → стол → бронь обнаружила, что можно было забронировать место на 5 гостей при максимуме 4, а бронь на будущую дату сразу помечала стол «Зарезервирован» на сегодняшнем рабочем экране.
- Форма теперь ограничивает количество гостей вместимостью выбранного места; сервер проверяет предел независимо от браузера и возвращает локализованную ошибку. Название зала сохраняется в объекте брони, возвращается в журнале и включено в поиск, чтобы одинаковые названия столов оставались различимыми после сохранения.
- Статус места теперь определяется бронями на бизнес-дату: будущая бронь не меняет сегодняшнюю доступность. Для PostgreSQL добавлен вывод названия зала через join, а статус на схеме вычисляется для часового пояса конкретного заведения; создание брони больше не записывает производный статус стола. Запись, конфликт-проверка, список и показатель броней на главной работают в местном часовом поясе точки. Миграции и URL API не менялись.
- `local-floor-management-contract` расширен реальными проверками API на отказ при превышении вместимости, сохранение названия зала в ответе и журнале, а также отсутствие сегодняшней блокировки из-за будущей брони. Визуальные контракты требуют сгруппированный выбор и отображение зала в журнале. VPS не менялся.

## POS: клавиатурная доступность общих диалогов — 29.09.2026

- Статическая проверка общих POS-действий обнаружила, что формы гостя, заметки, передачи/закрытия/разделения и других операций открывались без семантики модального диалога и клавиатурного управления.
- `requestStaffAction` теперь объявляет диалог через ARIA-атрибуты, переводит фокус в форму, поддерживает закрытие Escape, циклический Tab/Shift+Tab и возвращает фокус к вызвавшему элементу. Обработчик клавиатуры снимается при закрытии; API и данные не затронуты.
- Добавлен `scripts/pos-modal-a11y-contract.mjs` с шестью проверками инвариантов. POS-проверка, local-click (101 ссылки, 253 кнопки, 5 форм), Fold responsive (28 инвариантов), local-design, visual-page-rules, lock contract, синтаксис JS и `git diff --check` — PASS.
- CRM повторно заблокировалась; пользователь ответил «Не сейчас» на запрос разблокировать. Поэтому фокус/клавиши в браузере не проверены, и визуальную проверку POS продолжаю после разблокировки. VPS не менялся.

### POS-диалог: возврат фокуса при отключённой кнопке — 29.09.2026

- Ревью общего диалога выявило реальный крайний случай: действие «Закрыть заказ» временно отключает исходную кнопку до показа формы, и она не могла принять фокус после отмены/закрытия.
- При отсутствующей или отключённой исходной кнопке фокус теперь переводится на видимую рабочую область с `tabindex=-1`. Контракт дополнен соответствующим сценарием (7 инвариантов), опубликованная копия `dist/app.js` синхронизирована.
- Контейнер CRM пересобран локально. `GET /api/health` вернул `status=ok`, `database=postgres`; POS modal contract, local-click (101/253/5), Fold responsive (28), JS syntax, `git diff --check` — PASS; браузерная консоль ошибок не показала.
- На открытой странице DOM подтвердил повторную автоблокировку экрана после простоя. PIN не вводил, как пользователь ранее ответил «Не сейчас»; фактическое открытие и закрытие POS-диалога и визуальная проверка остаются до разблокировки. VPS не менялся.

### Локальный regression gate: POS и интерфейсные контракты — 29.09.2026

- Четыре контракта из текущего аудита (dashboard shift deeplink, order journal display, inventory premix load state, POS modal accessibility) включены в `scripts/local-acceptance.ps1`, чтобы новые визуальные/интерактивные проверки выполнялись общим локальным gate.
- `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3130` завершился `LOCAL ACCEPTANCE: PASS` на временном изолированном in-memory сервере; новый POS-контракт подтвердил 7 инвариантов, click audit — 101 ссылку/253 кнопки/5 форм. PostgreSQL-only migration execution пропущен при отсутствии отдельной тестовой БД.
- Временный процесс остановлен; локальная PostgreSQL CRM и пользовательская БД не использовались этим прогоном. Browser screenshot/interaction audit по-прежнему не завершён: попытки просмотра тестовой UI снова встретили экран PIN, PIN не вводился. VPS не менялся.

### POS-модальный контракт: проверка переходов фокуса — 29.09.2026

- Углубил `scripts/pos-modal-a11y-contract.mjs`: теперь он исполняет исходный `requestStaffAction` с тестовыми DOM-узлами, а не только ищет нужные фрагменты regex. Проверены начальный фокус, ARIA-состояния, Tab/Shift+Tab wrap, Escape, aria-hidden/снятие listener, возврат к доступному триггеру и fallback в рабочую область при disabled trigger.
- Новый прогон контракта — PASS (7 исходных инвариантов и 2 mocked keyboard/focus flow). Повторный полный `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3130` завершился `LOCAL ACCEPTANCE: PASS`; встроенные shift deep-link, order journal, premix load-state и POS accessibility contracts прошли. Временный in-memory сервер остановлен.
- Это исполняемый mock DOM, не браузерное подтверждение layout/фокуса. Локальная production-like вкладка и тестовый login показывают защиту PIN; текущий пользователь ранее ответил «Не сейчас», PIN не вводился. В `FINAL_ACCEPTANCE_REPORT.md` зафиксированы 10/50 требований «Готово», 30 «Частично», 10 «Не реализовано»; полный визуальный интерактивный проход ещё не доказан. VPS/GitHub не менялись.

## Рабочий экран зала: адаптивная сетка планшетной ширины — 29.09.2026

- При проверке на ширине 1024 px 12-колоночная схема сжимала столы примерно до 77 px: обрезались названия, статусы и вместимость.
- Для промежуточной ширины 761–1180 px сетка переведена на 6 колонок; координаты и ширина столов автоматически сжимаются с сохранением порядка и общей расстановки. Кэш-версии обновлены: `app.js` 134, `style.css` 321, синхронизированы source/dist маршруты.
- Добавлены регрессионные проверки компактных координат; `fold-responsive-contract.mjs` прошёл 30 инвариантов. 
ode --check app.js`, sync assets, Docker build/health и `git diff --check` — PASS. Полная локальная `scripts/local-acceptance.ps1` завершилась `LOCAL ACCEPTANCE: PASS` на отдельном in-memory сервере; изолированный процесс остановлен. PostgreSQL preflight без выделенной test DB пропущен самим набором.
- Живой визуальный осмотр этого изменения в CRM не выполнен: экран браузера был заблокирован; PIN не запрашивался и не использовался. Продолжающийся общий UI/UX аудит остаётся частичным. Сервер/VPS, домен и HTTPS не менялись.

### POS каталог: состояние пустой загрузки и локальный runtime — 29.09.2026

- Исправлен режим каталога сотрудника: встроенные демонстрационные товары показываются только в статическом demo-режиме; API-режим показывает загрузку, корректное пустое состояние либо ошибку с повтором. Ответ API фильтруется по имени/цене/ID, а динамические значения HTML-экранируются.
- Добавлен `scripts/staff-catalog-load-state-contract.mjs` в общий local acceptance gate. Полный `scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3130` завершился `LOCAL ACCEPTANCE: PASS`; отдельные catalog, click, design, синтаксис и `git diff --check` проверки тоже PASS.
- Browser DOM на loopback demo подтвердил честное пустое состояние без фиктивных товаров; геометрия на 390 CSS px не имеет горизонтального переполнения. Снимок CUA на мобильном размере визуально неинтерпретируем из-за лишнего чёрного холста, поэтому мобильный визуальный sign-off не заявляю.
- Временные in-memory процессы остановлены. Они не подключались к PostgreSQL. Пересобран локальный Docker CRM; `/api/health` вернул `status=ok`, `database=postgres`. VPS не менялся.

### Браузерный mobile pass: маршруты и админ-разделы — 29.09.2026

- Исправление POS каталога остаётся локальным; повторный полный local acceptance gate прошёл. Для независимой браузерной проверки использованы loopback-only in-memory server `127.0.0.1:3211`, отдельный headless Chromium context, synthetic owner session и viewport 390×844. PostgreSQL на порту 45636 и текущая пользовательская вкладка не затрагивались.
- Проверено 13 канонических защищённых маршрутов и 11 hash-подразделов админки: живые DOM переходы завершились, на замеренных состояниях `scrollWidth` документа равен ширине viewport 390 px. Реальные full-page mobile screenshots `audit-admin-mobile.png` и `audit-inventory-mobile.png` сохранены и просмотрены; dashboard/склад визуально читаемы, горизонтального обрезания нет.
- Это ограниченный браузерный responsive pass; все элементы всех экранов не нажаты, все формы/модалки/фильтры не исследованы, 844×390 и hardware Fold не проверялись. VPS/GitHub не менялись.

### Этап продолжения аудита: интерактивные формы — 29.09.2026

- Новый живой Chromium pass открыл и показал формы/панели по CTA на `/clients` (новый гость), `/inventory` (новая позиция и поступление), `/finance/categories` (новая категория) и `/platform` (добавить компанию). Снимки состояний сохранены: `audit-flow-clients.png`, `audit-flow-inventory.png`, `audit-flow-financecategories.png`, `audit-flow-platform.png`. Проверен также общий mobile/Desktop route map предыдущей записью. Полная проверка закрытия каждого из этих состояний и подача форм пока не доказаны.
- При пустом in-memory сервере `/finance` показывает явное состояние ошибки загрузки начислений с действием повтора; два API чтения payroll/payables ответили 503 без подключения к БД. Остальная часть finance экрана отрисовалась. Эту страницу нужно отдельно повторить на локальном PostgreSQL демо, доступном без пользовательской PIN-сессии, прежде чем классифицировать 503 как продуктовый дефект.
- Точка продолжения: следующими пройти формы бронирования/доставки/сотрудников/склада, безопасные tabs/select/search/pagination и закрытие модалок; потом отдельно проверять сценарии с синтетическими записями только на disposable in-memory или отдельной test DB. Не считать общий интерактивный аудит завершённым. Временный listener на 3212 остановлен; VPS и GitHub не менялись.

- Дополнение к интерактивному проходу: повторно открыл форму гостя и закрыл её через реальный `#client-cancel`; `#client-editor` вернулся в `hidden`, PIN overlay остался `aria-hidden=true`/opacity 0. Ранее использованный счётчик `[role=dialog]:visible` ошибочно считал этот прозрачный lock overlay видимым по геометрии; в дальнейших проверках будут использоваться конкретные form/panel IDs и CSS opacity/aria состояния. У формы создания гостя кнопка доступна по имени «Закрыть карточку» (видимый текст «Закрыть»), это подтверждено HTML.
- Начат разбор предметных форм склада: CTA «Добавить позицию» действительно открывает `#inventory-item-form`; «Оформить поступление» — `#purchase-document-form`, в его форме есть отдельная кнопка `#purchase-cancel`. В карточке позиции используются кастомные кнопки селекторов отдела, категории, типа и единицы, следующий шаг — проверить popup/select состояния и штатное закрытие без сохранения.

### Продолжение безопасного UI прохода: селекторы и валидация форм — 29.09.2026

- Изолированный runtime `127.0.0.1:3213`, `DATABASE_URL` пустой. Складская карточка позиции открылась; нативный отдел переключён на «Бар», кастомный select типа раскрыт и через ARIA option выбран «Товар» (`inventory-item-type=product`), единица переключена на «кг». Категорий в пустом demo-каталоге нет; popup показывает единственный placeholder. Пустая форма имеет один required-invalid элемент; после синтетического ввода названия штатная «Отмена» скрыла форму. API-записей не было.
- CTA «Оформить поступление» переключает страницу на `/inventory?view=movements` и раскрывает форму документа (проверено сразу, через 250 мс и при прямом URL). Кнопка `#purchase-cancel` скрыта в режиме создания и относится только к редактированию — прошлый поиск её видимости был неправильной проверкой, не дефектом.
- Бронирование: форма видна и блокируется одним required полем. Доставка: пустой submit остаётся заблокирован браузерной required-валидацией (2 поля), POST кроме login не ушёл. Форма сотрудника открылась в drawer с 3 невалидными полями и корректно закрылась через close; форма зала открылась и штатно закрылась кнопкой «Отмена».
- Фильтры: журналы заказов (сортировка, статус, поиск), гости (период, статус, сортировка, все 5 role=tab; выбран ровно один), бронирования (поиск), доставка (оплата/статус), склад (поиск) приняли выбранные значения; небизнесовые изменения, POST-запросов нет. Таймаут предыдущего фильтр-теста был вызван ошибочным тестовым селектором `#orders-list`, не продуктом.
- Остаток полного аудита прежний: ещё не пройдены все кнопки/состояния/модалки, finance без PostgreSQL даёт 503 на payroll/payables чтения и требует проверки на предназначенной demo DB, нет полного desktop/mobile screenshot evidence и аппаратного Fold pass. Временный demo runtime остановлен; VPS/GitHub не менялись.

### Финансы: PostgreSQL UI и обновление итогов после расхода — 29.09.2026

- Предыдущий этап дал прогресс: синтетический расход сохранён через UI; текущий SELECT подтвердил одну запись 1250.00 в отдельной territory_qa. База пользователя не использовалась. На QA применены schema.sql и миграции, добавлены только синтетические площадка, owner и категория.
- Проверено повторное открытие /finance: расход 1250 ₽, прибыль -1250 ₽. Фильтр 30.09–01.10 скрывает запись; «За всё время» возвращает её. График «Расходы → Таблица» показывает дату и ту же сумму. При 390×844 document scrollWidth=clientWidth=390; это геометрическая проверка, не полный mobile sign-off.
- QA-роль finance_audit_gap выявила подозрение на устаревшую сводку после POST. Подтверждено браузером: новый расход 250 ₽ появился в журнале, но сводка оставалась 1250 ₽ вместо 1500 ₽.
- portal.js: после успешного POST теперь обновляются и loadExpenses(), и load() через Promise.allSettled. portalRevision поднят до 316; публикационные копии синхронизированы. API/миграции не менялись.
- Живой regression на том же disposable PostgreSQL: после загрузки исправления исходная сумма 1500 ₽; через форму добавлен расход 300 ₽; без reload журнал содержит все три записи, расходы сразу 1800 ₽, прибыль -1800 ₽. Таблица графика также 1800 ₽. Скриншот audit-finance-refresh-qa.png сохранён и просмотрен.
- node --check portal.js; finance-chart-empty-state-contract; finance-api-consistency-contract; finance-employee-contract; finance-required-marker-contract; local-design-contract; git diff --check — PASS. code_health_engineer проверил baseline и итоговый diff, блокирующих замечаний нет. Известный отдельный долг: load повторно регистрирует payment-view listeners.
- crm-audit-app и crm-audit-pg остановлены и автоматически удалены; viewport восстановлен, временная вкладка закрыта. Исходная CRM и её PostgreSQL не изменялись. GitHub/VPS не публиковались; домен и HTTPS остаются последним этапом.
- Следующая точка продолжения: payroll draft→approve→pay и повторы ошибок, supplier partial payment/history/reconciliation, lifecycle категории с привязанным расходом. Полный интерактивный и responsive аудит ещё не завершён; текущие изменения локальные и не закоммичены.

### Payroll: живой цикл и исправление календарных дат — 29.09.2026

- Предыдущий ход классифицирован как прогресс: исправлена и браузером подтверждена синхронизация итогов расхода. Текущий шаг расширил интерактивное покрытие зарплатного реестра.
- Изолированная PostgreSQL territory_qa восстановлена в crm-audit-pg (loopback 55433), CRM crm-audit-app на 127.0.0.1:3215. Применены schema.sql и все миграции; только синтетические QA venue, owner, employee, правило 500 ₽/ч и журнал 8 часов. Основная CRM/БД не затрагивались.
- QA-роль payroll_ui_plan проверила контракт и минимальные fixtures. Через браузер: «Начислить зарплату» → выбор сотрудника/модели → период 01–30.09.2026 → черновик 4000 ₽, 8 ч → утвердить → отметить выплаченным 29.09.2026. Повторное открытие сохраняет paid; SQL подтвердил одну связанную выплату 4000, source=payroll. Сводка использует начисление по периоду (3866,67 до 29.09), журнал — полную выплату; это разные показатели, не дефект суммы.
- Найден и воспроизведён дефект подписи: String(PostgreSQL Date).slice(0,10) давал «Tue Sep 01 — Wed Sep 30». server.js теперь получает date labels через SQL to_char(...,'DD.MM.YYYY'); overlap, транзакции, суммы, права и tenant scope сохранены. Исторические записи не переписывались.
- Регрессия расширена в payroll-lifecycle-runtime-qa.mjs (mock сохраняет description и сравнивает текст) и payroll-lifecycle-postgres-api-qa.mjs (точное сравнение сохранённой PG description). Syntax, payroll-qa, runtime lifecycle и real PostgreSQL lifecycle с TZ=Asia/Yekaterinburg — PASS; code_health_engineer одобрил baseline и итоговый diff.
- Повторный полный UI payout с отдельной synthetic моделью QA Date Regression создал описание «Выплата зарплаты за 01.09.2026 — 30.09.2026»; браузерная console errors выборка пуста. Screenshot audit-payroll-dates-qa.png просмотрен и сохранён. Видна отдельная недоработка: status paid в подписи не локализован; ссылка пустого справочника синяя и плохо читается на тёмном фоне. Требуют следующего локального разбора.
- Для продолжения QA контейнеры оставлены запущенными на loopback; временная вкладка 2 помечена handoff, viewport reset. Перед продолжением проверить docker ps/health. После всего прохода остановить только crm-audit-app/crm-audit-pg (--rm). Не читать .env и не работать с основной БД.
- Остались payroll cancel/filter/error/mobile, supplier payment lifecycle, category lifecycle и остальная общая матрица. Полный quality gate не заявлен; GitHub/VPS не менялись.

### Payroll: отмена, состояние фильтров и мобильные строки — 29.09.2026

- Продолжение с подтверждённого предыдущего прогресса. Работа только на запущенных loopback QA контейнерах.
- Через UI создан октябрьский черновик QA Employee (0 часов/0 ₽), проверены пустая и короткая trimmed причина отмены; обе оставили форму с ошибкой. Валидная причина завершила отмену. SQL подтвердил cancelled, trimmed reason и отсутствие expense_id.
- Воспроизведён дефект фильтров: invalid date range показывал ошибку, но employee filter возвращал старые строки. portal.js получил payrollReady и порядковый ID запроса: смена фильтра не стирает loading/error/invalid, ответы старых запросов игнорируются. После исправления тот же браузерный сценарий сохранил сообщение неверного диапазона; корректные даты вернули реальные строки.
- На 390 px найден значимый responsive дефект: .payment-row сжимал статус и сумму зарплаты до посимвольного переноса. Добавлены scoped правила .finance-payroll-panel .payroll-entry-row: метаданные на всю ширину, badge и nowrap money отдельно, действия/редактор отмены на всю ширину до 760 px. При 320/390/760 document width=scrollWidth; screenshot 390 audit-payroll-mobile-fixed.png просмотрен, суммы и статусы читаемы. Active approved/cancel editor mobile ещё требуют отдельной проверки.
- portal rev317, CSS rev322; source/dist синхронизированы. payroll-register-ui-contract, local-design, syntax и diff-check PASS; code-health review одобрил state/CSS. Независимый executable harness проверил pending/invalid/error/filter/retry и out-of-order success/failure, PASS.
- QA контейнеры и вкладка 2 сохранены для продолжения, viewport reset. Незавершённые пункты: payroll error UX при потерянном PATCH response, англоязычный status paid в журнале и контраст ссылки, supplier/category lifecycle и общая матрица. GitHub/VPS не менялись.
- Новый scripts/payroll-register-load-state-qa.mjs добавлен в local acceptance. Координатор повторно запустил: PASS (invalid/loading/error + filters, retry callback, stale success/failure, pending→invalid). Finance required marker и fold-responsive contracts также PASS. Дополнительно просмотрены реальные screenshots terminal строк на 320 и 760 px; текст/суммы читаемы.

### Финансовые категории: чистое состояние формы и защита сохранения — 29.09.2026

- Исправлены два подтверждённых UX-дефекта формы категорий: отмена/переход к другой записи очищают прежнее сообщение и его error-оформление, а повторное нажатие «Сохранить» не создаёт конкурентные запросы до завершения первого ответа. Перед открытием редактора существующей записи вызывается тот же чистый reset.
- Архивирование и восстановление категории были пройдены через изолированный браузерный UI: подтверждение объясняет сохранение истории, архивная запись исчезает из активного списка, видна при фильтре «Включая архивные» и возвращается действием «Восстановить». API-проверка на disposable PostgreSQL дополнительно подтверждает durable CRUD, переименование связанной истории расходов, race cases и venue/role isolation.
- `finance-categories-ui-contract.mjs`, `finance-categories-postgres-api-qa.mjs`, syntax-check source/dist, local design contract и diff-check прошли. Исходная и опубликованная copies `portal.js` синхронизированы; актуальные revisions: portal 319, CSS 322.
- Новый browser tab был автоматически закрыт защитой рабочего места до UI-проверки создания и сохранения после этой правки. PIN не вводился; этот узкий browser subflow остаётся непроверенным, общий quality gate не заявлен. QA API на loopback 3215 отвечает `database=postgres`; основная БД, GitHub и VPS не менялись.

### Финансы: локализация статусов и доступные ссылки пустых состояний — 29.09.2026

- В журнале расходов payroll-статусы больше не показывают внутренние значения API (`paid`, `approved`): единый UI-словарь выводит «Выплачено», «Утверждено», «Черновик» или «Отменено». Для неизвестного либо отсутствующего значения предусмотрена понятная метка «Требует проверки».
- Ссылки внутри общего тёмного empty state получили явный контрастный цвет, подчёркивание, hover и `:focus-visible`, поэтому действие остаётся различимым мышью и клавиатурой.
- Добавлен `scripts/finance-expense-payroll-status-contract.mjs` и включён в local acceptance. Контракт, syntax source/dist, design-contract, source/dist parity и diff-check прошли; QA-app на loopback отвечает `database=postgres`. Code-health final review — без блокеров. Портальные и CSS revisions обновлены до 320/323.

### Финансы: повторная живая проверка на изолированной учётной записи — 29.09.2026

- В disposable PostgreSQL создана отдельная QA-учётная запись без PIN и выполнен реальный вход через `/login`; основная CRM и пользовательские данные не затронуты. На `/finance` браузер подтвердил русскую подпись «статус: Выплачено» у payroll-расходов, читаемые суммы и empty state расчётов с поставщиками.
- Поиск поставщика и фильтр статуса «Оплачена» применились к живому UI без ошибок. В этой QA-площадке пока нет проведённых накладных, поэтому браузерный happy path частичной поставочной оплаты и истории требует fixture и остаётся следующим непроверенным узлом; PostgreSQL API QA этого сценария проходит.
- Рабочее место снова закрылось автоматической защитой после интерактивной проверки. PIN не вводился и не использовался.

### Финансы: legacy payroll-подписи в журнале расходов — 29.09.2026

- Живой QA-экран обнаружил старую подпись выплаты с JS-датой (`Tue Sep 01 — Wed Sep 30`). Причина — исторически сохранённый description, созданный до исправления серверного форматирования.
- `GET /api/expenses` теперь для связанного payroll-расхода формирует подпись на чтении по canonical `payroll_entries.period_from/period_to` через `to_char(…, 'DD.MM.YYYY')`. Данные в `expenses` не переписываются. Связь ограничена тем же venue, выбор записи стабилизирован `created_at DESC, id DESC`; исходное описание остаётся для legacy расходов без payroll-связи. Существующее правило `payrollNeedsReview` сохранено.
- Расширен `finance-api-consistency-contract.mjs`. Он проверяет tenant-bound LATERAL join, canonical Russian label и сохранение review-правила. Contract, server syntax, payroll lifecycle runtime, diff-check и живой QA API прошли: 2 canonical payroll labels, malformed labels 0. Code-health review без блокеров. Основная БД, GitHub и VPS не менялись.

### Расчёты с поставщиками: живая QA-накладная — 29.09.2026

- В disposable PostgreSQL создана и проведена одна синтетическая накладная QA UI Supplier на 240 ₽. На `/finance` браузер подтвердил: один документ, сумма/остаток 240 ₽, статус «Не оплачена», раскрываемую историю с честным пустым состоянием и CTA «Зафиксировать оплату».
- До браузерной подачи частичной оплаты инструмент снова отобразил screen-lock dialog. В `lock.js` overlay присутствует в accessibility snapshot даже в скрытом состоянии, поэтому это не трактуется как доказательство действительной блокировки без визуального/DOM style подтверждения. PIN не вводился. API lifecycle partial/full payment и history остаётся подтверждён PostgreSQL QA; browser submit остаётся незавершённым.

### Расчёты с поставщиками: частичная оплата через UI — 29.09.2026

- Повторная browser-проверка уточнила, что overlay был скрыт (`aria-hidden=true`) и не блокировал форму. Native `<details>` корректно раскрывается клавиатурой Space, что также проверяет доступность summary-контрола.
- Через UI проведена частичная оплата 100 ₽ картой для QA UI Supplier. Без перезагрузки реестр показал «Оплачено 100 ₽», «Остаток 140 ₽» и статус «Частично оплачена»; в журнале расходов появилась связанная закупочная операция 100 ₽.
- История оплат через UI загрузила `29.09.2026 · Карта · 100 ₽`. После reload строки суммы, остатка и статуса сохранились. Это живой happy path частичной supplier payment на disposable PostgreSQL; не трогает основную базу, GitHub или VPS.

### Финансовый regression pass после UI-оплаты — 29.09.2026

- На том же disposable PostgreSQL повторно пройдены `purchase-payment-postgres-api-qa.mjs` и `finance-categories-postgres-api-qa.mjs`. Оба PASS: поставочная оплата, полный расчёт, история, idempotency, переплата и race cases; категории, архив/restore, связи с расходами, pagination, concurrent rename/archive и tenant/role isolation.
- Это дополняет живой browser happy path частичной оплаты. QA-контейнеры остаются loopback-only для последующих проверок; основной runtime, GitHub и VPS не менялись.

### Общий gate на PostgreSQL: контракт сохранения истории столов — 29.09.2026

- Первый общий local acceptance остановился на удалении QA-стола с отменённой бронью: внешний ключ сохраняет историческую связь. Исправлен тестовый сценарий, который ошибочно ожидал физического удаления. Для PostgreSQL теперь проверяются отказ 409, сохранение отменённой брони с именами стола/зала и сохранение стола после повторного чтения. Для memory mode прежняя очистка сохранена. Продуктовые правила удаления не менялись.
- Живой floor-management contract прошёл. Повторный общий gate прошёл этот узел и остановился далее в smoke-test.ps1: fixture использует memory ID `vip-room-1` вместо UUID PostgreSQL. Следующий шаг — исправить выбор тестового стола в smoke-сценарии. Общий gate пока не PASS; полный визуальный аудит остаётся незавершённым.

### Smoke на PostgreSQL: реальные fixtures столов — 29.09.2026

- Smoke создаёт отдельный QA-зал и пять столов через API, использует возвращённые ID для VIP, обычного заказа и переноса. Сценарии теперь совместимы с UUID PostgreSQL и memory IDs без предположений о встроенном demo-каталоге.
- Живой smoke на loopback 3215 прошёл VIP minimum, partial/split payment, заказ с гостем, позиции, скидку и перенос; далее остановился на inventory movement с `invalid_movement_unit`. Следующий шаг — исправить отсутствующую единицу в тестовом payload движения. Полный gate пока не пройден.

### Сохранённый этап и точка продолжения — 29.09.2026

- Пользователь попросил сохранить текущий этап. Сейчас выполняется локальный функциональный, UI/UX и адаптивный аудит; полный аудит ещё не завершён. Изменения не закоммичены, не отправлены на GitHub и не развёрнуты на VPS. Домен и HTTPS — последний этап.
- Причина inventory smoke failure уточнена: произвольный первый товар имел legacy unit. Smoke теперь создаёт отдельный товар с единицей `шт`, проводит движение +1 и повторным чтением проверяет остаток 1. Живой smoke на QA `http://127.0.0.1:3215` — PASS; итоговый code-health review без блокеров. Остаётся пробел покрытия применения VIP-настроек к canonical столам.
- Следующий шаг: повторить общий `scripts/local-acceptance.ps1` на QA 3215, устранить выявленные причины остановок, затем продолжить незавершённые проверки экранов и адаптивности. Общий gate пока не подтверждён как PASS.
- Изолированные QA-контейнеры: `crm-audit-app` (3215) и `crm-audit-pg` (55433). Основную CRM на 45636 и её БД не затрагивать. PIN не использовать и не запрашивать. Рабочая ветка: `codex/hookah-crm-full-audit-2026-09-29`.

### Продолжение общего acceptance — 29.09.2026

- Общий запуск подтвердил PASS smoke и дошёл до CRUD с аналогичной ошибкой legacy unit. `local-crud-contract.mjs` теперь создаёт отдельный товар `шт`, проверяет движение и сохранённый остаток; зал и стол также создаются отдельно, вместо переименования существующего свободного стола. Targeted CRUD и CRUD в повторном общем gate — PASS. Code-health итоговый diff одобрен.
- Следующая остановка: `local-guest-order.ps1` использовал выдуманный tableId, несовместимый с PostgreSQL UUID. Добавлены API-fixtures зала/стола. Повторный targeted запуск прошёл создание заказа, но выявил следующий узел: assertion `Client was not bound to order`. Нужно исследовать фактический ответ PATCH и контракт guestPhone/clientId, не ослаблять assertion без установления причины. Общий gate остаётся незавершённым; исправление гостевого теста пока не подтверждено целиком.
- `git diff --check` без ошибок whitespace. Проверки выполнялись только на disposable QA 3215; публикации не было.

### Общий local acceptance: PASS — 29.09.2026

- Причина guest assertion установлена по серверному контракту: PostgreSQL PATCH возвращает `guestId/phone`, memory — `clientId/guestPhone`. Тест проверяет обе формы ответа, точный ID гостя и телефон; затем повторно читает `/api/orders` и проверяет связь, телефон и заметку по ID заказа, а также наличие этого заказа в истории гостя. Dedicated зал/стол устраняет выдуманный UUID. Targeted guest test — PASS.
- `pwsh -NoProfile -File scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3215` завершился exit 0, `LOCAL ACCEPTANCE: PASS`. Подтверждены только сценарии этого набора. Часть PostgreSQL migration execution явно пропущена без отдельной test URL; статические и mock checks не заменяют реальные DB/UI проверки.
- Полный premium аудит ещё не завершён: остаются интерактивное покрытие экранов, визуальные и responsive проверки по исходному заданию, включая Fold/state preservation. Следующий этап — продолжить живой browser QA и фиксировать покрытие. Основная CRM, GitHub и VPS не изменялись.

### Supplier payment: полный расчёт через браузер — 29.09.2026

- Вошли отдельным QA Browser Audit Owner без PIN в disposable CRM 3215. Для QA-UI-PAYABLE-20260929 раскрыта форма оплаты клавиатурой Space, проверен default остаток 140 ₽. Отправка Enter показала «Сохраняем оплату…», затем реестр обновился: оплачено 240 ₽, остаток 0 ₽, статус «Оплачена», форма заменена «Оплачена полностью».
- История через UI показала обе операции: безналичный перевод 140 ₽ и карта 100 ₽, дата 29.09.2026. После reload полная оплата и история сохранились. Скриншот мобильного представления визуально проверен: суммы, статус, две строки истории и explanatory text читаемы, нет посимвольного переноса.
- Обычный locator click не отправил форму; клавиатурный Enter успешно отправил ровно остаток. Это наблюдение инструмента, пока не доказательство дефекта pointer UI. Browser tab сохранён для продолжения. Полный интерактивный/responsive аудит остаётся незавершённым.

### Финансовые графики: интерактивный обход — 29.09.2026

- Live QA3215: клавиатурой переключены динамика в таблицу/столбцы и распределение оплат в таблицу/колонки/график. Таблица динамики показывает 7 дат, оборот 28 976 ₽; распределение: карта 5 000 ₽, наличные 21 476 ₽, QR 2 500 ₽, сумма совпадает с оборотом. Виды отображают реальные одинаковые данные.
- Выявлен дефект русских форматов: оси/столбцы выводят MM.DD (`09.23`), таблица — ISO (`2026-09-23`). Первопричина portal.js:2276/2278 `slice(5).replace('-', '.')`; требуется DD.MM для осей и DD.MM.YYYY для table/title. Code-health получил baseline audit, продукт пока не изменён.
- После reload режимы возвращаются в line/donut; кнопки отмечены классом is-active, но не имеют aria-pressed. Это дальнейшие узлы проверки сохранения UI-state и доступности; не заявлены PASS. Browser tab10 сохранён для продолжения.

### Финансовая динамика: русские даты исправлены — 29.09.2026

- Renderer использует существующий `formatRuDate`: таблица и SVG title DD.MM.YYYY, оси линии/столбцов DD.MM. Date-only значения не проходят timezone parse. Добавлены executable helper assertions и проверки wiring в finance-chart-empty-state-contract.mjs. Portal revision 321, source/dist синхронизированы.
- Syntax, chart contract и local-design contract — PASS. Live QA3215 после reload подтвердил title/table `23.09.2026…29.09.2026`, оси обоих видов `23.09…29.09`; оборот 28 976 ₽ сохранился. QA image обслуживает root assets, копия portal.js туда обновлена; /app/dist отсутствует, попытка копии dist туда не применялась. Основной runtime не изменён.
- Следующие узлы: доступное selected состояние chart кнопок и сохранение режима/фильтров при Fold transitions. Полный аудит не завершён.

### Selected state финансовых графиков — 29.09.2026

- Обе группы view переключателей получают `aria-pressed`: true для line/donut в initial markup, false для остальных; handlers синхронизируют атрибут вместе с is-active. Scope только финансы, inventory handlers сохранены. Portal rev322, dist parity обновлена. Syntax и расширенный chart contract — PASS; live recheck состояния остаётся следующим шагом.
- Code-health baseline выявил ранее существовавшую причину возможного stale UI: payment listeners регистрируются внутри load.then и повторные загрузки добавляют обработчики со старыми paymentRows. Следующий шаг — воспроизвести смену даты/вида в браузере, исправить lifecycle handler и проверить regression. Финальный аудит не завершён.

### Повторная загрузка оплат: lifecycle binding — 29.09.2026

- Live QA: дата 28.09 показала честное пустое состояние; переключение в table сохранило его. Возврат 29.09 восстановил table с 5 000/21 476/2 500 ₽, bars сохранил суммы. Aria-pressed отметил только bars true. Видимый stale result в последовательном сценарии не воспроизведён.
- Накопление payment listeners подтверждено кодом. Переведён принадлежащий этому UI handler на onclick assignment: каждая успешная загрузка заменяет предыдущую closure. Исполняемый тест извлекает настоящий binder, дважды привязывает разные renderers, затем доказывает единственный вызов последнего renderer и согласованный pressed state. Contract и syntax PASS, portal rev323/dist synced. Финансовые запросы и business logic не менялись.
- Следующий шаг: live recheck после lifecycle правки, проверка rapid date response races и viewport transitions. Полный аудит остаётся активным.

### Финансы: state preservation при resize — 29.09.2026

- После reload QA3215 с актуальным portal.js выбраны table динамики, bars оплат, поиск `QA UI`. Реальный browser viewport последовательно 375×812 → 768×1024 → 2560×1440. На каждой ширине DOM подтвердил сохранение всех трёх состояний и scrollWidth равный viewport width: 375/768/2560. На 375 таблица сохранила русские даты и оборот 28 976 ₽.
- Это подтверждает resize state preservation только данного финансового сценария; не является доказательством hardware Fold8 или полного визуального PASS всех элементов. Viewport override сброшен, tab10 сохранён. Code-health итоговый payment lifecycle diff одобрил без блокеров.
- Следующие проверки: скриншоты и continuous widths для финансов, race запросов даты, остальные непроверенные интерактивные сценарии исходного полного аудита.

### Финансы: промежуточные ширины и мобильная таблица — 29.09.2026

- Live browser проверен на фактических ширинах 320, 360, 390, 412, 540, 600, 720, 760, 762, 820, 1024, 1180, 1280, 1440, 1920 (запрошенные 761 браузер округлил до 762). В каждом измерении document scrollWidth равен innerWidth; table mode и поиск QA UI сохранены. Это дискретная проверка 15 ширин, не полный continuous sweep всех пикселей.
- Устойчивый screenshot 390×844 подтверждает читаемые full-date строки, суммы KPI и control row. Первый screenshot сразу после resize захватил анимацию sidebar; повторное наблюдение показывает sidebar x=-280, menu aria-expanded=false и отсутствие перекрытия. Не записываем transient frame как продуктовый дефект. Таблица имеет внутренний vertical scroll; полный обход строк/keyboard scrolling остаётся отдельным шагом.
- Viewport reset выполнен, tab10 сохранён. Полный аудит остаётся незавершённым; следующий шаг — таблица scrolling и финансовые request races.

### Финансовая сводка: защита от старых ответов — 29.09.2026

- По коду подтверждена гонка: overlapping load без generation guard мог переписать выбранную дату поздним успехом или ошибкой старого запроса. Добавлен financeLoadRequestId с проверкой до любых DOM writes/notice в success и catch. API/финансовые правила сохранены.
- Новый finance-load-race-qa.mjs исполняет извлечённый настоящий loader с deferred API: новая дата успешно загружается, поздний старый success/error не меняет результат и не показывает notice; ошибка текущего запроса остаётся видима. PASS; включён в local acceptance. Syntax/chart/design PASS, portal324/dist synced, QA root asset обновлён.
- Это deterministic race evidence в mock, live browser recheck и общий gate после этого пакета ещё впереди. Полный аудит не завершён.

### Финансовый пакет: повторный общий gate — 29.09.2026

- Общий local-acceptance на QA3215 после portal324 завершился exit0, LOCAL ACCEPTANCE PASS. Code-health независимо проверил finance-load-race-qa и syntax, итоговый diff одобрен. Ограничение migration execution без отдельного test URL сохраняется.
- Live browser reload актуального кода, быстрый переход 28.09→29.09, затем payment table: показан текущий оборот 34 818 ₽; карта 6 000 ₽ + наличные 25 818 ₽ + QR 3 000 ₽ = 34 818 ₽. Увеличение относительно прежнего screenshot вызвано новыми синтетическими продажами общего gate. Видимый результат соответствует последней выбранной дате; принудительный сетевой reorder подтверждён только deterministic mock.
- Основная CRM, GitHub и VPS не менялись. Полный quality gate исходного UI/UX аудита остаётся незавершённым; следующий шаг — keyboard/scroll таблицы и другие экраны.

### Финансовая таблица: клавиатурная прокрутка — 29.09.2026

- Выявлен accessibility дефект: ограниченный контейнер таблицы (205px, overflow auto) не имел явной точки keyboard focus и accessible name. Добавлены tabindex0, role region, aria-label «Динамика показателей по дням». Используется существующий global focus-visible, отдельная CSS система не добавлена.
- Syntax/chart contract PASS, portal325/dist synced. Live QA: Tab с кнопки table переводит фокус именно в finance-data-table-wrap; End прокручивает scrollTop 0→96.8 при scrollHeight302/clientHeight205, достигнув конца таблицы. Home также вызван; возврат позиции ещё требует observation. Это подтверждает реальную keyboard доступность последних строк.
- Следующие шаги: финальный code-health review этого пакета, наблюдение Home и продолжение остальных экранов полного аудита. Основная CRM/публикация не менялись.

### Отчёты: X-report browser happy path — 29.09.2026

- Home финансовой таблицы наблюдён: scrollTop0, focus остаётся в wrapper. Code-health итоговую accessibility правку одобрил.
- Открыт /finance/report, initial состояние честно показывает «Отчёт ещё не сформирован». Enter на «Сформировать» вывел report ID, выручку 34 818 ₽, наличные 25 818 ₽, card+QR9 000 ₽, детализацию. Суммы согласованы с обзором.
- Выявлено расхождение смысла labels: «Чеков закрыто» показывает34, subtitle «34 операций оплаты», тогда как обзор closed28/payment34. «По закрытым чекам» также требует сверки с partial-payment semantics. Code-health получил read-only audit первопричины renderer/API; не исправлять численную бизнес-логику без определения контракта. Остальные типы/empty/error/responsive отчётов ещё не пройдены. Tab10 сохранён.

### Уточнение X-report counts по БД — 29.09.2026

- Read-only API подтвердил report checksCount34/closedOrders34/paymentCount34/revenue34818 и summary closedOrders28/paymentCount34/revenue34818. SQL disposable QA default venue: closed34, without valid payment6. Первопричина разницы — report выбирает все closed, summary JOIN payments исключает closed без оплат. Совпадение checksCount и paymentCount случайное.
- Предварительная гипотеза о неправильной подписи «Чеков закрыто» не подтвердилась. Не меняем её на «операции оплаты»: это исказило бы фактический API контракт. Отдельно нужно оценить ясность различия paid closed и all closed в UI и покрыть zero-total report scenario. Продукт в этом шаге не изменён. Полный аудит остаётся незавершённым.

### Отчёты: пустой день и waiter view — 29.09.2026

- UI дата28.09 + Enter «Сформировать»: все KPI0, count0, обе детализации «Данных за выбранную дату нет» — честное пустое состояние. Затем select report-type waiter, дата29.09, Enter: secondary title «Выручка по сотрудникам», QA Owner34 818 ₽, revenue34 818 ₽. Оба типа отчёта реально проверены на populated/empty день в QA3215.
- Попытка empty date + submit не дала достаточного evidence: getAttribute(value) отражает исходный HTML, не current input value; read-only evaluate текущего значения завершился timeout. Не заявляем validation PASS/FAIL по этой попытке. Следующий шаг — восстановить браузерное наблюдение и проверить actual value, required/date validation, ошибки и responsive отчёта.
- Tab10 помечен для продолжения; продукт/основная CRM/публикация не менялись. Полный аудит остаётся незавершённым.

### Отчёт: пустая дата больше не подменяется сегодняшней — 29.09.2026

- Новое AX наблюдение подтвердило пустую date field при report ID за29.09: UI передавал пустую дату, API default выбирал today. Добавлены required, aria-describedby и inline polite status; loader до API блокирует empty/native invalid date с «Выберите корректную дату отчёта», aria-invalid=true. Valid input очищает ошибку. Backend default не изменён.
- finance-report-date-qa.mjs исполняет настоящий loader, проверяет отсутствие API для empty/invalid и valid recovery. PASS, syntax PASS, включён acceptance, portal326/dist synced. Live пустое submit подтвердило inline message и aria-invalid=true. Final review запрошен; live valid recovery и общий regression ещё впереди.
- Полный аудит остаётся незавершённым. Основная CRM/публикация не менялись.

### Отчёт: recovery и mobile/tablet visual — 29.09.2026

- Live valid date28.09 после empty error + Enter очищает message/aria-invalid и формирует0 ₽. Code-health финальный guard diff одобрил, test независимо PASS.
- Screenshots375×812 и768×1024: inputs/buttons/empty состояния читаемы, scrollWidth равен viewport, дата сохраняется. На768 обнаружена несбалансированная раскладка четырёх KPI:3+1 карточки (лестница). Требуется report-specific tablet2×2 grid; code-health baseline запрошен, CSS пока не изменён.
- Override reset выполнен, tab10 сохранён. Следующий шаг — исправить report KPI grid, перепроверить tablet/desktop и обработку запросов отчёта. Полный аудит не завершён.

### Report KPI grid исправлен — 29.09.2026

- Scoped #report-kpis:4 columns desktop,2 при <=1200,1 при <=650. ID specificity устраняет generic compact3 tablet override; другие страницы не затронуты. CSS324/dist synced, date QA grid assertions/design contract PASS, code-health diff approved.
- Live375 одна колонка;768 две колонки, top positions415/415/544/544 и screenshot подтверждают2×2;1440 четыре одинаково расположенные карточки. Overflow отсутствует на этих ширинах. Запрос1024 инструмент фактически выдал innerWidth1242 — не засчитываем1024 как проверенную конфигурацию; требуется отдельное устойчивое наблюдение.
- Override reset, tab10 сохранён. Следующие шаги report request/error state и устойчивые дополнительные widths. Полный аудит не завершён.

### Report loader: race и inline feedback — 29.09.2026

- Добавлен generation ID до date validation: старый success/error не может менять UI после нового запроса или invalid input. Inline polite message сообщает «Формируем отчёт…», success очищает его, current error предлагает повторить; прежние результаты сохраняются при pending/error с явным feedback. API/business logic не менялись.
- Исполняемый finance-report-date QA извлекает настоящий loader и подтверждает stale success/error suppression, current failure feedback и pending→invalid cancellation. PASS, syntax PASS, portal327/dist synced, QA root asset обновлён. Итоговый review запрошен; live recheck/loading/error и общий acceptance после пакета ещё не выполнены.
- Полный исходный аудит остаётся незавершённым; следующие шаги browser report recheck и остальные экраны.

### Формат прогресса по запросу пользователя — 29.09.2026

- В каждом обновлении указывать текущий этап и общее число: «Этап N из 6», плюс конкретный проверяемый экран/сценарий. Схема:1 изучение проекта,2 карта интерфейса,3 проверка экранов и исправления,4 адаптивность/Fold,5 итоговые regression проверки,6 финальный quality gate. Это группировка исходного workflow, не сокращение требований и не процент готовности. Ранние responsive/regression проверки выполняются и внутри этапа3.
- Текущий этап3/6: финансовые отчёты; общий acceptance после report пакета завершился exit0, LOCAL ACCEPTANCE PASS (session57013). До финального gate не заявлять полный аудит завершённым.

### Этап3/6: журнал заказов — 29.09.2026

- Начат live обход /orders:53 заказа,13 открытых, выручка40 660 ₽. Search по невозможной строке даёт «По выбранным условиям заказов нет»; по видимому короткому номеру883728BA возвращает ровно ожидаемый гостевой заказ. Эти два сценария поиска подтверждены реальным UI.
- Report recheck после reload пока не засчитан: попытка выбрать28.09 показала40 660 ₽ вместо ожидаемого0; actual input value и submission не были сняты до перехода. Требуется возврат и проверка текущего DOM значения/response, чтобы отличить неуспешное действие инструмента от продукта. Не заявлять этот путь PASS.
- Следующие шаги: report recheck, status/sort/date filters и открыть order из найденной строки; browser tab10 /orders сохранён. Полный аудит остаётся активным, этап3/6.

### Этап 3/6: комбинации фильтров заказов и отчёт — 29.09.2026
- QA browser localhost3215: поиск 883728BA + статус Закрыт даёт пустой результат; статус Открыт возвращает ровно нужный заказ. Дата 28.09 скрывает заказ, 29.09 возвращает его.
- Отчёт: дата 28.09.2026 подтверждена DOM; нажатие Сформировать показывает Формируем отчёт…, затем все четыре KPI равны нулю и сообщение очищено. Прежняя неоднозначная проверка закрыта: результат ожидался до завершения запроса.
- Программный код не изменён. Полное покрытие журнала заказов и общего аудита остаётся незавершённым.


### Этап 3/6: сортировки и переход заказа — 29.09.2026
- QA3215: клавиатурный выбор По сумме —53 строки по убыванию, максимум2500; Сначала требуют внимания —13 открытых перед закрытыми. Click automation не изменил выбор, поэтому доказательство получено Enter и DOM.
- Поиск883728BA → Открыть приводит к нужному гостевому столу1790691615294 и гостю.
- Найдено расхождение: журнал показывает0 ₽, загруженный POS одну позицию100 ₽. renderOrders предпочитает finalTotal через ?? даже для открытых. Передано code_health для проверки API и контракта; исправление ещё не внесено.


### Этап 3/6: исправлена сумма активного заказа — 29.09.2026
- Причина: PostgreSQL listOpen выдаёт finalTotal как сумму платежей; renderOrders ошибочно использовал её как стоимость активного заказа. Неоплаченные позиции показывались0.
- portal.js: для open/in_progress/ready считаем сумму позиций как POS recalc; закрытые/отменённые сохраняют финальный итог включая законный0. Депозит остаётся отдельной подписью. API/БД не менялись.
- orders-total-qa.mjs: активные статусы, частичная оплата, закрытый0, скидочный итог, price fallback и бесплатные позиции PASS. node --check PASS. Публикуемые копии синхронизированы rev328; только QA контейнер получил portal.js.
- Live browser QA3215:883728BA теперь100 ₽, соответствует POS. Финальный code_health review запрошен; полный gate не завершён.

### Этап 3/6: проверка исторического заказа — 29.09.2026
- Code health одобрил исправление суммы активных заказов, source/dist совпадают, regression PASS.
- Новый live дефект: закрытый1C9F4086 (117 ₽) через Открыть ведёт в POS к Стол не выбран/0 ₽. loadOrders читает только активные заказы, requestedOrderId не найден.
- Передано code_health и system_architect для контракта безопасного просмотра истории; исправление ещё не внесено.

### Этап 3/6: реализация просмотра истории — 29.09.2026
- system_architect подтвердил существующий tenant-scoped scope=all, code_health предложил отдельный detail endpoint как альтернативу для большого объёма истории.
- Черновая локальная правка app.js: scope=all только при deep link, активная очередь фильтруется отдельно; нужный terminal заказ отображается, tabs мутаций отключены; tableName используется из API. При отсутствующем id не подставляется другой заказ.
- Синтаксис исходника PASS. Пакет ещё не синхронизирован в dist/QA, regression и итоговый review ожидаются; дефект пока не закрыт.


### Этап 3/6: live просмотр закрытого заказа — 29.09.2026
- app136 source/dist синхронизирован, app.js скопирован только в QA3215. orders-history-qa и syntax PASS.
- Браузер после reload исторического1C9F4086: правильный стол, Закрыт, позиция130 ₽, итог117 ₽ (скидка); все14 кнопок карточки disabled, история не добавлена в активную очередь.
- Финальный review code_health ожидается. Недоступный id/ошибка загрузки/race и mobile ещё требуют проверки, пакет истории пока не объявлен полностью принятым.


### Этап 3/6: загрузка истории и ошибки — 29.09.2026
- app137: отсутствующий исторический ID и начальная ошибка загрузки получают явный заголовок карточки с отключёнными controls. Задержанный ответ не заменяет другой заказ, выбранный пользователем во время запроса.
- orders-history-qa дополнен rejected-request и deferred-load selection regression; PASS. Syntax ранее PASS, asset sync выполнен, QA app.js обновлён.
- Итоговый review ещё идёт; async guard всех мутаций, повтор загрузки и mobile остаются для следующей проверки.


### Этап 3/6: недоступный заказ и контекст истории — 29.09.2026
- Live QA137 missing ID: правильное сообщение, все12 controls disabled, другой заказ не подставлен.
- app138: метаданные истории теперь показывают Просмотр истории, гостя, дату закрытия/создания и заметку через textContent. Ошибка/missing даёт инструкцию вернуться к журналу или повторить reload вместо предложения начать заказ.
- orders-history-qa и syntax PASS; sync source/dist и только QA app update. Финальный review и mobile остаются открыты.


### Этап 3/6: responsive истории — 29.09.2026
- Live QA app138: actual375x812,768x1024,1440x900 — исторический стол и итог117 ₽ сохранены при resize, document overflow отсутствует. На375 все controls read-only, мета содержит дату закрытия.
- Screenshot375 осмотрен: сумма строки130 ₽ переносит знак рубля на следующую строку, требуется точечная проверка ширины денежной колонки; отсутствие document overflow не равнозначно идеальному визуалу.
- Viewport reset выполнен, tab сохранён для продолжения. Печать закрытого заказа остаётся отдельным незакрытым сценарием.


### Этап 3/6: денежная колонка POS — 29.09.2026
- CSS325: staff order-item-row minmax(0,1fr)/auto/max-content, имя переносится при нехватке места, сумма nowrap/tabular-nums.
- Live375 screenshot:130 ₽ теперь на одной строке, название длинной QA позиции переносится в своей колонке. Selector measurement timeout не засчитан численной проверкой; screenshot подтверждает устранение переноса. Viewport reset.
- Source/dist синхронизированы; обновлён только QA CSS. Итоговый code_health CSS review запрошен.


### Этап 3/6: черновик печати истории — 29.09.2026
- Baseline code_health подтвердил noopener null-handle defect и неверный subtotal/текущую дату исторического чека.
- Локальный app draft: blank popup с handle, opener=null немедленно до записи escaped HTML; closed finalTotal/closedAt (fallback createdAt), cancelled блокирован, печать доступна id+items. Альтернатива iframe обсуждена; итоговый review ожидается.
- orders-receipt-qa extraction PASS: итог117/0, дата, escaping, opener isolation, popup blocked/cancelled. Syntax PASS.
- Не синхронизировано в dist/QA; live печать ещё не проверена. CSS325 финальный review одобрен.


### Этап 3/6: browser печать app139 — 29.09.2026
- orders-receipt-qa включён в acceptance, regression/syntax PASS; source/dist sync139, QA app updated.
- Browser исторический заказ: Печать чека enabled=true, Enter выполнен. IAB не показал новое окно/print dialog, console error/warn пусто. Это не доказательство полного live print PASS; требуется доступное наблюдение результата/альтернативная preview-проверка.
- Основная карточка сохранилась; review реализации popup.opener=null ожидается. История и CSS review одобрены, печать пока открыта.


### Hookah POS identity on employee home — 2026-09-29

- Scope: replace the old “Территория / CRM заведения” mark only on the employee home (`index.html`) with the saved Hookah POS by AlphaSat lockup. Keep route structure, tenant/session behavior, and the admin/product pages unchanged.
- Assets: use the prepared warm-gradient Hookah POS lockup based on the owner-supplied product reference and a symbol-only asset for the collapsed mobile sidebar. Source copies are in `assets/brand/`; generated/static copies are in `dist/assets/brand/`.
- Runtime: public-file allowlist serves the two exact SVG paths. At <=900px, the lockup swaps to a compact mark. CSS revision bumped to 325.
- Checks: 
ode --check server.js`, 
ode --check scripts/sync-published-assets.mjs`, 
pm run qa:header`, and `git diff --check` pass. Local Docker CRM rebuilt; `/` returns HTTP 200 with Hookah POS title/lockup, both SVG asset routes return HTTP 200, and the old Territory/CRM identity is absent from the employee-home markup.
- Publication: local only; no commit, push, or VPS deployment.

### Этап 3/6: регрессия app139/CSS325 — 29.09.2026
- pwsh -NoProfile -File scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3215 — session84785 exit0, LOCAL ACCEPTANCE PASS. Новые orders total/history/receipt проверки вошли в полный запуск.
- code_health одобрил receipt popup handle с немедленным opener=null и escaped содержимым; app.js/dist byte equal, syntax/regression PASS.
- Изолированный QA gate прошёл; отдельное исполнение PostgreSQL migration preflight осталось skipped без dedicated URL. Общий premium audit не завершён, live print dialog не наблюдаем в IAB и не объявлен PASS.

### Этап 3/6: выбор места бронирования — 29.09.2026
- QA3215 live: selector зал/место открыт; вариант VIP Smoke vip1 20260929193751 выбран Enter. UI автоматически выставил депозит1500 ₽, пояснение обязательного депозита и вместимости до4 гостей.
- Numeric DOM evaluate timeout не принят как результат; snapshot подтверждает значения. POST не выполнялся, форма не отправлена. Все даты/search/create/validation ещё требуют live проверки.


### Этап 3/6: фильтры бронирований — 29.09.2026
- Live Показать все бронирования очищает дату списка и раскрывает исторические отменённые записи. Поиск1790692671099 оставляет ровно нужную бронь стола у окна.
- Найдено несоответствие локализации: дата карточки2026-10-01 отображается ISO. Передано code_health для baseline и контракта display-only исправления.
- Submit с пустым гостем выполнен; признака успешного создания нет, но validation ещё не доказана через validity/focus/API, не считать PASS.


### Этап 3/6: дата бронирования локализована — 29.09.2026
- portal329: только display использует formatRuDate(item.date), фильтр и сортировка сохраняют ISO date. API/БД не менялись.
- Browser после reload: дата списка2026-10-01 + поиск1790692671099 показывает ровно карточку с01.10.2026 ·20:00. Syntax PASS; source/dist sync выполнен, обновлён QA portal.

### Этап 3/6: native validation бронирования — 29.09.2026
- Live пустой гость после submit: required=true,valueMissing=true, focus на госте, native Заполните это поле. Подтверждено page DOM read.
- После выбора стола вместимостью4 и guests5 submit: rangeOverflow=true,max4, focus на guests и понятное native ограничение. Создание не выполнялось, форма оставлена QA Бронь20260929/guests5 для продолжения.
- Контракт локализованной даты добавлен, PASS; code_health display-only изменение одобрил.


### Этап 3/6: создание бронирования live — 29.09.2026
- Только QA3215: QA Бронь20260929, стол у окна1790692671099,02.10.2026 20:30,4 гостя,депозит0,заметка QA сохранения. Submit показал Сохранение… disabled, затем Бронь подтверждена и form reset.
- Дата списка02.10 + поиск QA имени вернули правильную подтверждённую запись. После reload те же фильтры снова вернули запись — persistence подтверждено.
- Заметка не отображается в карточке списка; её DB/API reread и отмена этой синтетической брони остаются следующими шагами.


### Этап 3/6: отмена бронирования и заметка — 29.09.2026
- QA PostgreSQL reread eb59cce7-c256-46a8-83d0-a3b57fcae83f: заметка QA: стол у окна, проверка сохранения сохранена,4 гостя,starts_at15:30UTC соответствует20:30 UI.
- Live cancel dialog открыт; Отмена сохранила confirmed. Повторное открытие + Отменить бронирование изменило UI на Отменена, кнопка отмены исчезла, запись осталась в списке.
- DB reread после подтверждения: cancelled,4 гостя,та же заметка. Production не затронут.


### Этап 3/6: resize бронирований — 29.09.2026
- Live actual375x812→768x1024→1440x900: document overflow отсутствует; поиск QA Бронь20260929 и дата2026-10-02 сохраняются, список содержит отменённую запись.
- Screenshot375 формы осмотрен: поля и labels по одной колонке, кнопка Новая бронь занимает доступную ширину. Низ списка и длинный открытый dropdown на375 ещё не осмотрены — не считать всю страницу responsive PASS.
- Viewport reset, tab10 handoff; tab11 обнаружен, не трогался (владение неизвестно).


### Этап 3/6: mobile dropdown и карточка бронирования — 29.09.2026
- Actual viewport375x764: dropdown places bounds left30.8/right334/top408.7/bottom688.7 внутри viewport, clientHeight278 при scrollHeight3218. Screenshot подтверждает читаемые многострочные options и внутреннюю прокрутку; Escape закрывает список.
- Screenshot нижнего блока после keyboard focus: search/date вертикально, длинная карточка гостя/зала/стола переносится, депозит и badge Отменена не перекрываются.
- Размер восстановлен, tab10 сохранён. Это proof конкретных состояний, не полный responsive gate всей CRM.


### Этап 3/6: фильтры доставки — 29.09.2026
- QA live /delivery: payment dropdown открыт, Наличные/Карта/QR доступны, Карта выбрана Enter.
- Статус фильтра new даёт явное Доставок по выбранному фильтру нет; in_delivery возвращает6 заказов и6 badges У курьера. Менялись только фильтр и несохранённая форма, статусы записей не мутировались.
- Форма создания/валидация/переходы статуса и responsive доставки остаются незавершёнными.


### Этап 3/6: доставка create/reload — 29.09.2026
- Native empty submit: delivery-name missing=true,focus=true, Заполните это поле.
- QA3215 создана QA Доставка20260929, synthetic адрес,850 ₽, карта (ранее выбрана), пустой optional phone, заметка QA: позвонить при прибытии. UI Доставка создана.
- Фильтр new показывает правильные имя/адрес/заметку/сумму и статус Новая; reload + new повторяет запись, persistence подтверждено.
- Смена статуса/платёжное поле DB reread и responsive остаются следующими шагами. Production не затронут.


### Этап 3/6: delivery status lifecycle — 29.09.2026
- QA UI запись QA Доставка20260929: new→confirmed→in_delivery→delivered выполнены через dropdown Enter, каждый переход подтверждён matching filter/card. Reload+delivered сохраняет статус, адрес/сумму/заметку.
- Обнаружено ограничение: таблицы deliveries в QA PostgreSQL нет; server.js использует массив deliveries. Предыдущие reload проверки доказывают сохранение в текущем серверном процессе, не переживание рестарта. Долговременное хранение доставки требует отдельного аудита архитектуры.


### Этап 3/6: delivery storage baseline — 29.09.2026
- Server2813 GET возвращает глобальный deliveries, POST запись без venueId, PATCH ищет только id. Кроме потери после restart, tenant boundary не обеспечен на уровне хранения.
- MIGRATIONS.md/SECURITY_RULES.md прочитаны. План безопасного пакета: additive050 deliveries table с venue_id FK,uuid,status/payment constraints,timestamps/index; SQL GET/POST/PATCH с текущим venueDbId;503 при DB error без memory fallback; memory demo сохраняется с явным venue scope.
- Независимые code_health и system_architect audits запущены. Миграция и product код ещё не менялись; production не трогался. Нужны runtime двух tenants, rollback/errors и restart durability на отдельном QA процессе.


### Этап 3/6: additive deliveries schema — 29.09.2026
- Добавлена migrations/050_deliveries.sql: venue FK,UUID,контакт/адрес/комментарий,сумма,оплата,статус,курьер,timestamps,venue-created index. Нет переноса неоднозначных memory записей и удаления данных.
- migrations-contract PASS50 replay-safe files. Миграция ещё нигде не применялась.
- system_architect подтвердил contract: tenant-scoped GET/INSERT/PATCH, camelCase+numeric mapping,404 чужой/невалидный ID,503 без memory fallback, audit after success; memory тоже venue-scoped. Next SQL repository/server wiring + isolated runtime QA.


### Этап 3/6 — delivery persistence: API implementation (29.09.2026)
- Причина: доставки оставались в глобальном массиве даже при PostgreSQL; GET/PATCH не ограничивались заведением.
- server.js: SQL GET/POST/PATCH с venue_id, numeric total преобразуется в Number, неправильный UUID возвращает 404; при настроенном DATABASE_URL сбой возвращает 503 без перехода к памяти. Memory записи также ограничены venueId, наружный API сохраняет форму ответа.
- schema.sql: добавлена таблица из migration 050 для свежей базы; миграция не применялась к рабочим базам.
- Проверки: node --check server.js; node scripts/migrations-contract.mjs — PASS (50).
- Остаётся: итоговый code_health review, полноценный audit before-state в SQL PATCH, интеграционные проверки PostgreSQL/restart/tenant/error, UI ошибки/повторное чтение. Runtime QA ещё не обновлён; исправление не считается проверенным.

### Этап 3/6 — delivery audit and UI failure states (29.09.2026)
- SQL PATCH теперь блокирует и читает прежнюю запись в транзакции, сохраняет изменение и передаёт before/after в журнал; соединение освобождается при всех исходах.
- portal.js: ошибка GET заменяет вечную загрузку явной ошибкой и кнопкой повторения; фильтр сохраняет ошибку; устаревший GET не перезаписывает новые данные. Во время PATCH статус блокируется, при ошибке возвращается прежнее значение, успешный ответ обновляет карточку без зависимости от второго GET.
- portal330 синхронизирован с dist. node --check server.js/portal.js — PASS. Runtime не обновлён, интеграционные/браузерные проверки ещё предстоят.

### Этап 3/6 — delivery executable API QA (29.09.2026)
- scripts/delivery-persistence-qa.mjs исполняет реальные обработчики server.js: create/list/update/list, изоляция двух заведений, отказ роли, неверный статус, before-state audit; отказ query/connect и отсутствующий pool при DATABASE_URL дают 503 без памяти. PASS.
- Добавлен в local-acceptance и postgres-qa. Опциональный PG сценарий применяет migration050 дважды только после loopback/QA identity guard, проверяет две площадки и чтение новым пулом. Этот PG сценарий ещё не запускался; новый пул не заменяет проверку перезапуска серверного процесса.
- git diff --check — PASS (только предупреждения line endings).

### Этап 3/6 — delivery amount parity and submit state (29.09.2026)
- server.js: отрицательные/нечисловые суммы и значения за numeric(14,2) пределом возвращают 400; сумма округляется до копеек до выбора режима хранения. Тесты отрицательной, NaN/Infinity, 1e12, 1.235→1.24 и максимальной суммы проходят в memory.
- portal331: поле поддерживает копейки/максимум, форма блокирует повторный submit и показывает сохранение; сообщения ошибок доступны через live status и различают сумму/телефон/контакты. Исходники/dist синхронизированы; синтаксис PASS.
- Попытка PG QA остановилась до подключения: в локальном Node нет модуля pg (MODULE_NOT_FOUND). База не изменялась этим запуском. Следующий шаг — доступный QA runtime с pg и полноценная PG проверка.

### Этап 3/6 — delivery PostgreSQL executable evidence (29.09.2026)
- pg установлен в отдельный TEMP runtime (14 пакетов), без изменения зависимостей проекта. QA подключение сформировано в памяти из env crm-audit-pg без вывода пароля.
- delivery-persistence-qa.mjs: PASS memory/failure; PASS PostgreSQL migration050 replay twice, create/list/update/list, numeric boundaries/rounding, two-venue isolation/cross-venue404, denied capability, audit before/after, invalid UUID404, persisted read after closing/opening pool. Safety guard проверил disposable loopback контейнер и QA database identity до записей; созданные тестовые заведения удалены своим cleanup.
- Migration050 фактически применена только к crm-audit-pg/territory_qa. Рабочая БД localhost45636 не затрагивалась.
- local-crud-contract теперь перечитывает доставку, сверяет поля/статус/курьера и отсутствие внутреннего venueId; синтаксис PASS, полный CRUD пока не запускался с обновлённым runtime.
- Осталось: обновить QA приложение, проверить реальный процесс restart и браузерные error/retry/create states; new pool evidence не равно server restart.

### Этап 3/6 — delivery actual server restart evidence (29.09.2026)
- Обновлены только /app/server.js, /app/db.js, /app/portal.js и /app/delivery.html в crm-audit-app, приложение перезапущено; /api/health подтвердил postgres/ok. Main localhost45636 и его БД не затрагивались.
- Через реальный HTTP API с синтетическим QA аккаунтом создана доставка e6c79ce4-0fe6-4bf3-a725-cb88ac50dbd0, сумма850.55/card, затем статус in_delivery и courier QA restart courier.
- После второго docker restart crm-audit-app тот же QA session перечитал GET: id/status/courier/total/paymentMethod сохранились. HTTP server-process restart persistence — PASS.
- Старые unscoped memory доставки не переносились автоматически в tenant БД. Осталось: браузерные error/retry/create/pending states, responsive delivery sweep и финальная проверка diff.

### Этап 3/6 — delivery browser error evidence and reconciliation (29.09.2026)
- Code-health review выявил race: PATCH response мог отменить более свежий GET. Исправлено: успешный PATCH вызывает generation-guarded load(), который также восстанавливает loadFailed. portal332 синхронизирован и скопирован в QA.
- Браузер QA /delivery после reload показывает сохранённую после restart доставку с 850,55 ₽/У курьера, один заказ; загружен portal332 (до повторного reload проверен331). Поле суммы step0.01.
- QA форма заполнена синтетическими name/address, суммой123.45 и неверным телефоном123. Submit показал Сохранение… disabled; итог Проверить телефон (фактический текст «Проверьте телефон»), имя/адрес/сумма остались. Новая запись при этом не создана.
- QA tab10 оставлен на форме с ошибкой для продолжения. Осталось: успешный submit, GET retry/PATCH failure UI, responsive sweep и поведенческий regression для async состояний.

### Этап 3/6 — delivery browser create/mobile result (29.09.2026)
- Синтетическая QA UI доставка создана после очистки неправильного телефона:123.45, cash, address QA. Браузер показал Сохранение…disabled → Доставка создана; форма reset, кнопка восстановилась, GET2 заказа. Reload сохранил карточку.
- На375px фильтр Новая оставил один заказ; document.scrollWidth=375, карточки в границах. Screenshot выявил перенос badge Новая на два ряда: style326 добавляет delivery badge flex-shrink0/nowrap. После reload screenshot подтвердил цельное слово/нет перекрытия кнопки статуса.
- Снимок docs/ai-team/delivery-mobile-375-qa.png; viewport reset, tab10 handoff. portal332/CSS326. Остаются error/retry/status failure/browser states и общая responsive/регрессия аудита.

### Этап 3/6 — delivery UI deterministic regression and acceptance (29.09.2026)
- Новый delivery-ui-state-qa.mjs исполняет настоящий блок обработчиков portal.js с контролируемыми async ответами: GET error/retry, ошибка сохраняется при фильтре, recovery filter, stale GET error ignored, PATCH disabled duplicate guard, failed PATCH reverts previous status, success GET reconciles later server status, success PATCH+failed GET displays retry. PASS. Create pending guards и mobile badge остаются static assertions; реальный create отдельно доказан браузером.
- Добавлен в local-acceptance. Полный scripts/local-acceptance.ps1 -BaseUrl http://127.0.0.1:3215 завершён exit0/LOCAL ACCEPTANCE PASS, включая реальный CRUD POST/PATCH/GET доставки, роли/маршруты/активы/поставщиков/финансы.
- Dedicated PG tests в этом acceptance запуске без URL не выполнялись; delivery PG proof записан отдельно предыдущим запуском. Общий аудит CRM и этап3 не завершены; browser GET-error/PATCH-failure и оставшиеся страницы/этапы ещё требуют работы.

### Этап 3/6 — integrations screen focused audit (29.09.2026)
- /integrations в QA показывает Telegram В разработке, явную недоступность настройки; нет фиктивной кнопки подключения. Sidebar раскрывает Система/Telegram, heading/breadcrumb соответствуют странице.
- Реальные ширины375/768/1440: document.scrollWidth совпадает с viewport; panel внутри границ; screenshot375x764 показывает читаемые карточки/статус без overlap. docs/ai-team/integrations-mobile-375-qa.png, viewport reset/tab10handoff.
- Новый integrations-state-qa.mjs исполняет настоящий callback portal.js для enabled/disabled/network-error: корректные Подключено/В разработке/Статус недоступен и объяснения; PASS. Enabled ветка проверена mocked response, реальное Telegram подключение/отправка не реализованы и не проверены.
- Скриншот не доказывает все sidebar/header interaction состояния; общий обход продолжается.

### Этап 3/6 — task creation live audit (29.09.2026)
- Canonical tasks route /admin#tasks, подтверждён source/UI sidebar; guessed /tasks был блокирован браузером, не использовался.
- Новая задача: empty submit блокируется native required title/assigneeId, focus title. Dropdown сотрудников открылся, показал три активных QA аккаунта. Создана QA Задача аудит 20260929 с описанием QA и исполнителем QA Employee; карточка появилась в Открытые.
- Выявлен UX gap: дата-only поле Выполнить до2026-09-29 отображается в карточке как29.09.2026,05:00 (UTC midnight→venue local). Требуется выяснить контракт date vs datetime и исправить представление/сохранение без изменения старых дат. Screenshot docs/ai-team/tasks-created-qa.png. Дальше priority/status/filter/modal cancel/responsive и проверка даты.

### Этап 3/6 — task deadline contract investigation/status evidence (29.09.2026)
- Первопричина05:00 подтверждена: dueAt date-only input отправляется без timezone/precision в due_at timestamptz; карточка явно форматирует с временем. API тесты допускают настоящее ISO datetime, поэтому простое удаление времени или угадывание UTC-midnight повредит совместимость. code_health и system_architect получили read-only контрактные проверки; изменения БД/даты пока не внесены.
- Реальный QA статус задачи Открыта→В работе прошёл через dropdown, API перечитал и перенёс карточку в соответствующую колонку (0 open/1 in_progress), после этого reload. Это отдельная функциональная проверка, не доказательство date fix.
- integrations-state-qa.mjs подключён к local-acceptance, standalone PASS. Общий этап3 остаётся активным.

### Этап 3/6 — task calendar deadline schema and filters (29.09.2026)
- System architect рекомендует due_date date рядом с legacy due_at timestamptz, без преобразования существующих timestamp. Подготовлена migration051 ADD COLUMN IF NOT EXISTS + guarded constraint single deadline kind; миграция ещё не применена ни к одной БД. migrations-contract PASS51.
- Следующая реализация: UI отправляет dueDate, API возвращает календарную строку через to_char; POST/PATCH нормализуют форму входа, reject invalid/conflicting deadlines, status-only не трогает срок; datetime остаётся с временем.
- Browser task priority Срочные→0 карточек/все колонки Нет задач, Обычные→1 карточка. На375px board одна колонка303.2px, document.scrollWidth375; viewport reset, tab10handoff.
- Date fix пока не реализован в API/UI и не считается завершённым.

### Этап 3/6 — task deadline normalization helper (29.09.2026)
- server.js добавлен pure normalizeTaskDeadline, пока не подключён к endpoints: distinguishes omitted/clear/calendar/datetime; incoming legacy date-only dueAt maps calendar, existing stored timestamps are not inferred. Reject conflicts, impossible calendar day/leap, no-zone datetime, invalid clock/offset; preserves accepted ISO precision string.
- task-deadline-qa.mjs executes actual helper: valid leap/date/year1, leap/day/month errors, explicit midnight/offset/microsecond legacy timestamp, clear/unchanged/conflict cases — PASS. server syntax PASS.
- Helper/API/schema/UI integration ещё не закончена и QA runtime не обновлён этим пакетом; migration051 не применена.

### Этап 3/6 — task deadline API/UI integration (29.09.2026)
- GET task добавляет dueDate строкой to_char; sorting включает календарную дату в timezone заведения. POST/PATCH используют normalizeTaskDeadline: calendar→due_date, timestamp→due_at, взаимное очищение; status-only не меняет срок. Management allowed расширен dueDate, сотруднику остаётся только status.
- portal333 date input отправляет dueDate; карточка отображает календарный срок без времени, legacy dueAt с временем. Старые записи не преобразуются. Source/dist синхронизированы, QA runtime ещё не обновлён/migration051 не применена.
- Checks: node --check server.js/portal.js; task-deadline-qa; tasks-qa memory; role-api-matrix-runtime QA — PASS. Static task test обновлён на общий validation call, PG task extraction получил helper для actual handlers.
- Осталось: реальный PG date/datetime/clear/status/tenant tests, migration replay, browser date display и итоговый review.

### Этап 3/6 — task calendar deadline PostgreSQL evidence (29.09.2026)
- tasks-postgres-e2e-qa расширен: migration051 replay twice после safety identity guard; invalid POST date/conflict, dueDate POST/GET, status-only preservation, date→timestamp→date replacement, clear, incoming legacy dueAt date-only, employee deadline403, preserved prior precise timestamp. PASS вместе с existing task permissions/tenant/completion tests.
- Migration051 фактически применена только disposable crm-audit-pg/territory_qa; QA fixtures cleanup выполнен. Рабочая БД не затронута.
- server.js/portal333/admin.html обновлены в crm-audit-app, restart и health postgres/ok. Браузерная проверка новой даты ещё предстоит; existing QA task timestamp05:00 намеренно не конвертирован.

### Этап 3/6 — task calendar date browser proof (29.09.2026)
- QA /admin#tasks с portal333: через Новая задача создана QA Календарный срок20260930, assignee QA Employee, date30.09.2026. Карточка показывает «до30.09.2026» без05:00; после reload это же значение сохранилось.
- Existing legacy QA task по-прежнему показывает свой timestamp29.09.2026,05:00: существующие точные сроки не конвертированы эвристикой.
- Screenshot docs/ai-team/task-calendar-deadline-qa.png, tab10handoff. task-deadline-qa подключён к acceptance.
- Осталось финальное code_health заключение, общий acceptance с новым task API, remaining task modal/filter/responsive/error states и другие экраны. Общий этап3 не завершён.

### Этап 3/6 — task cancel/filter and full acceptance (29.09.2026)
- Live task dialog: draft QA отмена не сохранять → Отмена closes, cards unchanged2, draft absent. Status filter В работе→exact existing in-progress QA card. No data mutation on cancel.
- New a11y finding: after portalAction cancel activeElement=BODY; source close removes modal without restoring opener. Shared modal also has no Tab trap; code_health получил bounded baseline audit перед следующим пакетом.
- Full local-acceptance against refreshed QA app exit0 LOCAL ACCEPTANCE PASS (portal333/CSS326/task051), including task memory/deadline validation and delivery CRUD. Dedicated PG proof remains separate and passed earlier; this green suite doesn't complete global UI audit.

### Этап 3/6 — shared portalAction keyboard implementation (29.09.2026)
- portal334: capture opener/restore connected focus on close, idempotent close, unique heading aria-labelledby, Tab/ShiftTab enabled-visible loop, only top action modal reacts, already-consumed Escape leaves dropdown handling intact. Empty-field confirm initially focuses Cancel.
- portal-action-keyboard-qa executes actual key handler: forward/reverse Tab, outside focus, consumed Escape, top dialog protection PASS; opener/name/empty-form checks are static assertions. Syntax/sync PASS, QA portal/admin copied.
- Baseline reviewer additionally recommends describedby and fallback focus if opener removed/disabled; these are not implemented yet. Browser retest and broader close-path tests still required, package not marked complete.

### Спецификация платного модуля «Каталог табаков» — 29.09.2026
- Зафиксированы продуктовые сценарии выбора/создания карточки при приходе, уровни сети и точки, поля карточки, явная связь с локальной складской позицией, независимые остатки/цены заведений, entitlement платной функции, роли, tenant-ограничения, неизменность истории, состояния интерфейса и критерии приёмки.
- Учтено решение владельца не использовать в стартовом наборе перечисленные импортные бренды; точный список фактически используемых брендов и коммерческие параметры оставлены открытыми, каталог не заявляется исчерпывающим по РФ.
- Read-only проверки продукта, архитектуры и склада подтвердили: приход venue-scoped, organization subscription уже есть, entitlement отдельной платной функции отсутствует; существующие складские позиции нельзя заменять сетевыми карточками каталога.
- Добавлен документ `docs/requirements/TOBACCO_CATALOG_MODULE.md`. Код, схема БД и UI не менялись; тесты не запускались. До реализации остаются согласование открытых решений и полноценный контракт UI/API/права/данные.

### Этап 3/6 — shared portalAction live focus evidence (29.09.2026)
- portal335 добавляет aria-describedby для текста, fallback focus page-content/main при исчезнувшем/disabled/невидимом opener с восстановлением прежнего tabindex. Source/dist/QA синхронизированы.
- Browser actual task modal теперь именован Новая задача. Tab from Submit→Close, ShiftTabClose→Submit: focus остаётся внутри. Cancel closes modal (count0), activeElement.id=task-new: исходный дефект возврата фокуса исправлен.
- portal-action-keyboard-qa PASS, добавлен в acceptance; final code_health review запрошен. Fallback и закрытие dropdown Escape пока только source/mocked evidence; требуется дополнительный реальный сценарий.

### Этап 3/6 — shared dialog Escape/fallback completion evidence (29.09.2026)
- Browser task modal: Escape on active employee option закрывает только dropdown, modal count1, focus custom-select-trigger. Второй Escape на trigger закрывает dialog, focus task-new. Регрессии сохранения данных нет: форма пустая, ничего не отправлялось.
- portal-action-keyboard-qa расширен исполнением настоящего close(): connected opener restoration, removed/disabled opener fallback, double-close idempotence, listener removal и resolve exactly once — PASS. Это mocked lifecycle proof, не реальный удалённый opener scenario.
- Общий этап3 продолжается; final review и остальные responsive/modal/control states остаются.

### Этап 3/6 — mobile modal/navigation overlap fix (29.09.2026)
- Actual375x764 task dialog: fields/submit fit, document.scrollWidth375, but mobile menu z61 covered start of heading (action-modal z30). Minimal CSS327 changes action-modal z70; sync/QA copy done.
- Reload/open screenshot confirms full Новая задача heading visible, Close and all fields/buttons accessible, menu behind dialog. Screenshot docs/ai-team/task-modal-mobile-375-qa.png. Cancel closes, viewport reset/tab10handoff.
- portal-action-keyboard-qa PASS with stacking assertion; architect asked to review layer contract. Still requires final code-health CSS review/shorter heights/dropdown clipping and broader regression.

### Этап 3/6 — short viewport dialog clipping fix (29.09.2026)
- Live375x552 до исправления action-box height743/top-96/bottom648, overflow visible: верх и низ формы уходили за экран. CSS328 добавляет border-box/max-height100vh fallback+100dvh-32/overflow-y:auto.
- После reload live box top16/bottom536,client518/scroll743/overflowauto. Keyboard ShiftTab from submit→Cancel прокручивает box scrollTop224.8, Cancel rect472..517 внутри viewport. Снимок docs/ai-team/task-modal-short-height-qa.png. Cancel закрывает, viewport reset/tab10handoff.
- portal-action-keyboard-qa PASS c CSS constraint; final reviewer запрошен. Dropdown clipping на краткой высоте ещё требует проверки; общий этап3 продолжается.

### Этап 3/6 — short modal select visibility and focusout fix (29.09.2026)
- Live375x552 employee/priority menus each top303/bottom455 inside box16..536; focused option scrolls modal automatically, three QA employees/four priorities readable. No menu clipping in these actual lists; larger lists not yet proven.
- Tab from priority option moved focus to dueDate but menu stayed open(open1). portal336 adds wrapper focusout close only when relatedTarget is outside; keeps option navigation inside intact. Reload repeat: Tab→dueDate/open0. Syntax/sync PASS; Cancel/viewport reset/tab10handoff.
- Code-health CSS review found no blocker and recommended this interaction check. Shared focusout regression tests/final review still required.

### Этап 3/6 — shared-component regression and network entry (29.09.2026)
- portal-action-keyboard-qa now executes real focusout callback for internal/external/null relatedTarget PASS. Full acceptance against QA portal336/CSS328 exited0 LOCAL ACCEPTANCE PASS; no dedicated PG rerun in this invocation.
- Browser entered /network: current venue card1, settings links canonical admin#settings, add form name/city/address/format/phone/timezone visible. Current venue Asia/Yekaterinburg, new-form timezone initially KaliningradUTC+2 (first option). Need examine intended default and entire create/switch/limit contract before making changes. No network mutation made; tab10handoff.
- Global audit still stage3; focused regression isn't final quality gate.

### Этап 3/6 — network form baseline evidence (29.09.2026)
- Empty Добавить заведение submit: native required rejects network-name/city/address, focus network-name. Timezone dropdown opened14 Russian options, selection UTC+5 updates actual selectAsia/Yekaterinburg+visible trigger. No venue created/switched/archived.
- Found default inconsistency: initial dropdownEurope/Kaliningrad(first option); success reset hardcodesAsia/Yekaterinburg. Current venueAsia/Yekaterinburg; should define initial/reset contract from current data with preserved manual choices.
- Source baseline also shows GET failure only toast+loading and no create pending guard. code-health read-only audit requested for UI lifecycle and configuredPG fallback/organization/session. Next safe package after findings. Tab10handoff stays network empty form timezoneUTC+5.

### Этап 3/6 — network UI lifecycle implementation (29.09.2026)
- portal337 network initial/reset default timezone uses current venue timezone, fallback supportedYekaterinburg; GET does not overwrite manual choice. Count pluralRu; explicit GET error/retry+generation guard.
- Create pending guard/disabled/loading, live status, contextual contact/timezone/admin errors; success reset refreshes custom timezone label. Source/dist synced; runtime not yet updated.
- network-load-state-qa executes actual load function: error/retry rendering, current timezone adoption, manual choice preservation, stale error ignored PASS. Create pending/reset assertions currently static, needs live/behavioral followup. Final code-health audit pending.
### 2026-09-29 — этап 3/6, сеть: чтение и состояния формы
- Исправлены timezone default/reset, сохранение ручного выбора, GET retry/stale generation, create pending guard (portal337).
- GET сети при настроенной БД теперь возвращает 503 network_unavailable вместо глобальных memory-записей. isCurrent соответствует venueDbId текущей сессии, независимо от организационного is_current.
- Добавлены network-read-failure-qa и network-load-state-qa в local-acceptance; скорректирован счётчик guard в tenant contract. Три профильных QA PASS; полный local-acceptance на3215 PASS, source/dist синхронизированы139/337/328.
- Live QA обнаружил отсутствующую organization_id у синтетического qa-audit-owner: это ранее маскировалось memory fallback. В подтверждённой auto-remove crm-audit-pg привязан только этот QA-пользователь к организации его venue. Свежая HTTP-сессия: GET200, одна точка, корректный current UUID. Старая браузерная сессия показывала error/retry; выполняется обычный повторный вход для обновления QA-контекста.
- Осталось: live create/edit/select/archive; DB-mode nonUUID fallthrough в mutation routes; атомарность session selection; полный responsive/Fold и общий финальный gate. Проект/VPS не публиковались.
- Live browser после обычного logout/login подтвердил «1 точка», «Текущая точка», UTC+05:00; screenshot network-current-session-qa.png. Ошибка старой QA-сессии не трактуется как успешная загрузка: новый контекст проверен отдельно.
### 2026-09-29 — этап 3/6, граница изменений сети
- Причина: PostgreSQL mutation routes проверяли pool и UUID одной веткой; невалидный ID открывал memory fallback. POST/PATCH/DELETE/select теперь сначала выбирают configured DB mode; missingpool503, malformed/nonUUID404 до SQL и до памяти.
- Добавлен network-mutation-boundary-qa.mjs с исполнением актуальных обработчиков: PATCH/DELETE/select ×3 невалидных ID, отсутствующий pool, отсутствие memory mutation. Включён в local-acceptance.
- node --check server.js, mutation QA, tenant contract, timezone runtime QA PASS. Code health финальный review: новых блокеров нет.
- Live browser на3215 создал только QA-точку «QA Сеть аудит 20260929» с неизменённым timezoneAsia/Yekaterinburg: pending disabled, затем2точки/Точка добавлена, форма очистилась иtimezoneUTC+5 сохранён.
- Остались атомарность выбора сессии, blank required PATCH parity, live edit/archive/select и общий аудит/Fold. Production не затронут.
- Полная local-acceptance95114 завершилась exit0 PASS. Reload браузера подтвердил2точки и сохранённыйtimezone новой QA-точки; screenshot network-create-reread-qa.png.
### 2026-09-29 — этап 3/6, атомарный выбор точки
- Причина: select коммитил org-wide is_current, затем отдельно сохранял сессию; failure оставлял контекст рассогласованным.
- Выбор блокирует активную org-scoped точку и сохраняет auth_sessions.active_venue_id тем же transaction client до COMMIT. Org marker больше не меняется. Request context/audit/200 только после COMMIT; отсутствующая/истёкшая сессия401; write/commit failure503 без SQL detail. SessionRepository возвращает boolean, поддерживает transaction client.
- network-selection-qa исполняет текущий route+настоящий SessionRepository с mockedclient: success, absent venue, expired session, write error, commit error, rollback/release и отсутствие org mutation PASS. session-venue/tenant/boundary contracts, синтаксис server/db и code_health final review PASS.
- Live3215: QA-точка выбрана, после reload отмечена текущей, смена закрыта (у новой точки нет смен), screenshot network-selection-reread-qa.png. Выполнен возврат на основную QA-точку.
- Full local acceptance остановилась на header-shell-contract: source style.css содержит новые tobacco-catalog правила, которых нет в dist; это отдельные текущие изменения, не перезаписывались данным пакетом. Полная регрессия текущего дерева не подтверждена.
- Остались live две независимые сессии/одновременный выбор, edit/archive, PATCH required validation parity, stale header после select без reload; общий responsive/Fold и итоговый gate не завершены. Production не затронут.
### 2026-09-29 — этап3/6, редактирование и архив сети
- Live3215: редактор QA-точки сохранил имя/адрес, reload подтвердил изменения. Archive dialog initial focusОтмена; отмена не изменила список и вернула фокус initiator. Затем только одноразовая QA-точка архивирована: PostgreSQL запись сохранена,is_active=false.
- PATCH supplied requiredname/city/address теперь проверяются до SQL/memory assignment: пустые/null/whitespace400, omitted разрешены. Исправлены DB blankpersist и memory mutation on400.
- network-patch-validation-qa (2режима×3поля×3значения +partial success), selection/boundary QA и синтаксисPASS. Live HTTP invalidname +validaddress400, reread обоихполей unchangedPASS. Acceptance check wired.
- Full acceptance остаётся непроверенной из-за отдельной style/dist parity; network дальнейшие остатки: две сессии, pending guards наedit/archive/select, stale header сразу послеselect, responsive/Fold. Общийgoal не завершён.
### 2026-09-29 — этап3/6, реальные две сессии и размеры сети
- HTTP на3215 с двумя QAdevice cookies: конкурентные select разных точек200/200; GET каждой сессии отметил только собственный UUID. Попытка архива своейтекущей409. Возврат наосновнуюQAточку200, архив одноразовойточки200, выборархивной404. PASS; секреты/токены не выводились.
- БраузернаяQAсессия вытеснена стандартным лимитом2сессии, затем обновлена обычнымlogout/login. Старыйэкран показывал generic loadingerror; auth-expiry поведение переданоcode_health дляread-onlyанализа (не обходилось).
- Сеть после актуального входа1точка. Измерены375×764,768×976,1440×852,2560×1392 (viewportна48pxниже заданноговнешнегоразмера): document.scrollWidth равенinnerWidth; поля икарточка внутриviewport. Consoleerrorlogs пустые. Сохранёнnetwork-mobile-375-qa.png; temporaryviewport reset.
- Это проверка геометрии4конфигураций, не полныйFold/visualgate. Общийаудит продолжается; pendingguard иstaleheader сети, auth-expiry, source/dist CSSparity остаются дляразбора.
### 2026-09-29 — этап3/6, авторитет PostgreSQL-сессии
- Независимыйcode_health аудит установил: memory-first sessionFromRequest принимал отозванный/истёкший вPGтокен. ПриDATABASE_URL/sessionRepository теперьтолькоpersistedlookup; недоступность/отсутствиезаписи неоткрываетmemoryfallback. Explicitmemorymode сохранён.
- Предъявленные невалидныеcredentials теперь401 такжеприAUTH_REQUIREDfalse, вместоanonymousfallthrough. Liveперваяпопыткаистечения выявила503изanonymousnetworkSQL; причинаисправлена, повторнаяполнаяцепочкаlogin200→GET200→expiryтолькоQAauthrow→GET401PASS втотжепроцесс.
- session-authority-qaactualhelper stale memory+DBnull/error/missingpool/currentvenue иmemorymodePASS; role-api-matrix/security-default-credentialruntimePASS; syntax/diffcheckPASS. Проверкавключенавacceptance.
- Остаютсяclientapi401null/ложныйуспех,pendingguards/staleheader; fullsuiteCSSdistparity иобщийаудит/Fold. Данныеproductionнеизменялись.
### 2026-09-29 — информационный справочник табаков (без приёмки и активации)
- Добавлен отдельный каталог в разделе «Склад → Цеха и категории»: описательные карточки сети и заведения с брендом, линейкой, вкусом, типом смеси, фасовкой, крепостью, страной, типом листа, штрихкодом, вариантами названия и описанием.
- Добавлены поиск/фильтр области, редактирование, мягкий архив и восстановление. Управление карточками доступно ролям с правом управления складом; создание и редактирование сетевых карточек — владельцу/администратору. Каталог не создаёт складские позиции и не участвует в приёмке; платная активация и привязка к тарифу отложены. Предзаполненный список брендов не добавлялся.
- API `/api/tobacco-catalog`, PostgreSQL-миграция `052_tobacco_catalog.sql`, repository, demo persistence и опубликованные копии интерфейса; версии ресурсов склада повышены до CSS 329 / portal 338.
- QA: 
ode scripts/tobacco-catalog-api-qa.mjs` PASS (20 assertions); inventory-context-contract PASS; inventory-hierarchy-contract PASS; синтаксис server/db/portal/dist/portal PASS; `git diff --check` PASS (только существующие LF/CRLF предупреждения). Published inventory HTML copies hash-equal.
- Ограничение проверки: не запускалась полноценная browser visual QA для этой панели; Postgres-миграция добавлена, но live PostgreSQL не подключался.
### 2026-09-29 — этап3/6, клиентский401
- Общийportalapi401ранееredirect+resolve(null) запускалsuccesscontinuation. Теперьудаляеттолькостарыйcrm_session_token/user(storageerrorshandled),redirect/login иrejecttypedError(status401,payload.authentication_required).
- portal-api-auth-qaactualapifunction:401nosuccess/redirect/clear,blockedstorage,200,403,demoPASS. networkloadstatePASS; syntaxportalPASS. Portalrevision338source/distcopiesaligned; unrelatedCSS329inventory/currentstylechangespreserved. local-design-contractнаcurrenttreeпокаFAILизCSSrev329vsconfigured328,fullgateнепроверен.
- LiveQA: истечениетолькоauthrowsqa-audit-ownerвdisposablePG, browserreload перешёлна3215/login среальнойформойвхода,screenshot session-expiry-login-qa.png. PINнетребовался.
- Осталисьpendingguards иstaleheaderприselect,контрольобщегоassetparity,общийresponsive/Fold/регрессия. Productionнезатронут.
### 2026-09-29 — этап3/6, pendingдействиясети
- Актуальныйnetworkclickhandler получаетsharedactionPending доdialog/API, disablesинициатор,labelПодождите, awaitsAPI+load, finallyrestorebutton иunlock. Duplicateactionsнепоступают.
- network-action-pending-qa исполняетактуальныйlistener3actions:pendingdisabled,secondclickrequests1,failureunlock/errornotice,retryrequests2/successPASS. portalapi401testPASS.
- Не копированоQA/dist: полныйnode--check текущегоportal.js останавливаетсяна1865(endrenderInventory), внеnetworkpatch2399..2410. Вдеревеидутдругиекаталоговыеизменения; code_health исследуетrootcause. Browserverificationиобщийsyntax/fullacceptanceэтапа покаНЕPASS.
- Headerrefreshпослеselect ещёнеисправлен. Полныйgoalактивен; productionнезатронут.

### 2026-09-29 — этап 3 из 6, проверка блокировки диалогов сети
- Расширен network-action-pending-qa: отложенные confirm/edit, подавление повторного открытия, отмена без API, восстановление кнопки, освобождение guard после удаления инициатора из DOM.
- network-action-pending-qa и portal-api-auth-qa PASS; синтаксис теста PASS. Полный portal.js всё ещё падает на текущем inventory-блоке (1921); браузерный результат нового pending-пакета не подтверждён. Продолжаются проверки фокуса, переключения шапки и общего аудита. Production не затронут.

### 2026-09-29 — этап 3 из 6, повторная проверка текущего дерева
- Syntax portal.js теперь PASS после внешних складских изменений. Обнаружена новая регрессия: ранее проверенные network load/pending и reject401 исчезли из текущего portal.js; три соответствующих QA FAIL.
- Точечно восстановлена ветка api401 с очисткой устаревшей идентичности и отклонением Promise; портал компилируется, portal-api-auth-qa PASS. Каталог не перезаписывался; dist и браузер пока не обновлены. Network load/pending остаются незавершёнными и требуют повторной интеграции.
### 2026-09-29 — отдельный визуальный пример страницы POS
- Запрос: показать пример экрана POS кальянной. Существующий рабочий `/` уже является залом/заказами, но пользователь просил визуальную концепцию, поэтому создан отдельный демонстрационный макет без изменения дерева маршрутов, общего интерфейса, API и `dist/`.
- Добавлены `pos-demo.html`, `pos-demo.css`, `pos-demo.js` и локальный `pos-demo-preview.cjs`. Страница показывает смену, зоны, столы, гостя, заказ, каталог и оплату; примеры интерактивны, добавление позиции пересчитывает сумму. Подпись отмечает данные как демонстрационные.
- Проверки: 
ode --check pos-demo.js`, `git diff --check -- pos-demo.html pos-demo.css pos-demo.js pos-demo-preview.cjs`; визуально открыт экран и каталог в браузере, добавление премиального кальяна увеличило сумму с 2 100 ₽ до 3 700 ₽. Preview слушает только 127.0.0.1:4179 и отдаёт только эти три demo-файла; основной CRM-сервер не менялся.
- Ограничение: предпросмотр проверен на текущей ширине браузера; полноценная адаптивная матрица и production-публикация не выполнялись. Макет не подключён к API и не является рабочей кассой.

### 2026-09-29 — информационный справочник табаков
- Отдельный каталог в Склад → Справочники: карточки сети/заведения, описание табачных и бестабачных смесей, параметры фасовки, вкуса, крепости, страны, листа, штрихкода, варианты названия; поиск, редактирование, архив и восстановление.
- Каталог информационный: не меняет остатки и не входит в приход. Платная активация/связь с приходом отложены; бренды вручную наполняются позже.
- API /api/tobacco-catalog, миграция 052_tobacco_catalog.sql, repository, demo storage и published UI копии; CSS/portal rev 329/338.
- QA PASS: API (20 assertions), inventory context/hierarchy, JS syntax server/db/portal/dist portal, diff-check. Inventory HTML copies hash-equal. Live PostgreSQL/browser visual QA не запускались.

### 2026-09-29 — этап 3 из 6, восстановление сети
- Из проверенной копии disposable QA восстановлен только renderNetwork: timezone default/manual state, generation guard, error/retry и create pending. Остальные функции и каталог сохранены.
- Добавлен общий actionPending с await select/edit/archive и повторного чтения, finally освобождает блокировку.
- node --check portal.js, network-load-state-qa, network-action-pending-qa, portal-api-auth-qa PASS. Итог передан code_health. Dist/browser ещё не обновлены; focus cancellation и stale header требуют проверки/исправления, полный audit не завершён.

### 2026-09-29 — этап 3 из 6, восстановление доступности диалогов
- Повторная проверка выявила утрату ранее проверенного shared portalAction: восстановлены accessible name/description, top-modal Escape, Tab trap, idempotent close, возврат фокуса и fallback из проверенной QA-копии. Также восстановлено закрытие custom select при выходе фокуса.
- Синтаксис portal.js и полный portal-action-keyboard-qa PASS. Network pending и api401 QA PASS. Итоговая проверка code_health запрошена. Для disabled network opener нужен отдельный возврат фокуса после отмены; browser и asset parity пока не подтверждены.

### 2026-09-29 — этап 3 из 6, фокус отмены действий сети
- После отмены archive/edit фокус возвращается на видимую подключённую кнопку только после её повторного включения. Удалённая кнопка не получает фокус; успешные запросы не перехватывают фокус.
- Network pending QA расширен: другое действие другой точки подавляется при открытом диалоге, focus проверяет enabled state, detached opener не фокусируется. PASS; network-load-state, portal-action-keyboard и syntax PASS. Code health final review запрошен.
- Ещё не подтверждены браузер и source/dist parity; stale header и полный responsive audit остаются в работе.

### 2026-09-29 — этап 3 из 6, запуск browser network QA
- В auto-remove loopback3215 QA runtime обновлён только renderNetwork поверх прежней проверенной копии; syntax PASS. Production/main compose не затронут.
- Реальный вход qa-audit-owner открыл dashboard; переход network затем вернул login. Pending/focus браузерный сценарий пока не подтверждён — требуется исследование истечения/замены QA session. PIN не запрашивался и не использовался.
- session-authority-qa и network-selection-qa PASS. Архитектору поручен read-only контракт обновления общей шапки после select с сохранением draft.

### 2026-09-29 — этап 3 из 6, обновление контекста заведения
- По контракту system_architect выделен refreshPortalContext: общая initial/select загрузка venue/metrics/shifts, generation guard, loading очищает прежние данные, нет старого логотипа при отсутствии нового, shift errors явно unavailable.
- Select ждёт refresh и load без rerender/reset сетевой формы; сообщение различает успешный select с частичным refresh failure.
- portal-context-refresh-qa PASS (актуальный helper, stale A после B, loading/failure/no-logo); syntax и network action/load PASS. Code health review запрошен; VIP summary error clearing и browser/source-dist интеграция ещё требуют проверки.

### 2026-09-29 — этап 3 из 6, завершение ошибок refresh-контекста
- Устранён stale VIP summary: loading очищает прежние минимумы, failure показывает недоступность. QA дополнен VIP и partial metrics fail при успешных venue/logo/shift.
- Пять targeted QA (context/network pending/load/modal/api401) и syntax PASS; sidebar navigation PASS. Header-shell contract FAIL из существующего source/dist style mismatch, полный gate не пройден.
- Context refresh и pending QA включены local-acceptance. Code health и system architect повторно проверяют пакет; browser/source-dist интеграция остаётся незавершённой.

### 2026-09-29 — этап 3 из 6, аудит расхождения публикационных копий
- Полный sync пока небезопасен: source потерял несколько ранее проверенных функций при внешних изменениях, dist их сохранил. Выявлен FAIL delivery-ui-state (нет loading generation); восстановлен только renderDelivery из dist, каталог и новые network/context правки сохранены.
- delivery-ui-state, portal-context-refresh, syntax PASS. Style source является подпоследовательностью dist: утрачены 63 строки responsive правил finance/reservations/clients/payroll и brand; code health исследует границы восстановления и остальные функции до full sync.
- Общий gate и браузер остаются незавершёнными; production не менялся.

### 2026-09-29 — этап 3 из 6, восстановление сумм и responsive CSS
- Orders-total QA выявил регрессию: активный заказ вновь брал finalTotal вместо суммы текущих позиций. Восстановлен только проверенный total helper из dist; syntax/orders-total PASS. Orders history/receipt PASS.
- Source CSS не имел уникальных строк относительно dist; восстановлены потерянные 63 строки responsive finance/reservations/clients/payroll и существующего brand lockup. Header-shell contract теперь PASS.
- Order-journal-display contract всё ещё FAIL localized reservation date; CSS revision329/config328 и другие различия portal ещё требуют интеграции. Full gate/browser не завершены.
- Уточнение результата предыдущей строки: Header-shell НЕ PASS целиком. CSS parity восстановлена; следующая проверка останавливается на portal.js source/dist mismatch. Полный контракт остаётся FAIL до интеграции JS.

### 2026-09-29 — этап 3 из 6, даты бронирований и задач
- Восстановлено локализованное отображение date брони (ISO filter не изменён); order-journal-display contract и syntax PASS. Отдельного scripts/reservations-qa.mjs в проекте нет — его запуск не состоялся.
- Выявлено исчезновение calendar dueDate UI в tasks при сохранённом backend051; восстановлен только renderTasks из проверенной dist-копии. Tasks QA5 и deadline normalization PASS.
- Code health сверяет остаточные различия source/dist; браузерные сценарии и полный goal всё ещё не завершены.

### 2026-09-29 — этап 3 из 6, восстановление финансовых сценариев
- Целевые QA обнаружили утрату защиты от устаревших ответов finance и очистки ошибок category editor. Восстановлены renderFinanceCategories/renderFinance из сохранённой dist-копии; finance load race/categories/expense payroll status/payroll register QA PASS.
- Восстановлен renderFinanceReport с блокировкой некорректной даты и защитой загрузки; finance-report-date/context refresh/syntax PASS.
- Оставшийся diff содержит намеренные network/context изменения, новые inventory editor изменения и пропавшие demo tobacco routes (ещё не интегрированы). Полный sync пока не выполнялся.

### 2026-09-29 — этап 3 из 6, интеграция копий
- Восстановлены 3 tobacco demo routes, новые inventory editor изменения сохранены. API20/inventory context/hierarchy/syntax PASS; отдельного demo runtime QA пока нет.
- После сверки известных regressions выполнен локальный sync: portal339/CSS329,43HTML source/dist. Header-shell contract PASS; code_health подтвердил byte parity portal/style.
- Local-design-contract FAIL на новом стороннем pos-demo.html, использующем самостоятельный pos-demo-wow.css вместо CRM style.css. Это требует уточнения границ проверяемых маршрутов; не подменять PASS. Production не публиковался. Браузер/fullgoal в работе.

### 2026-09-29 — этап 3 из 6, исполняемый demo QA
- Добавлен tobacco-catalog-demo-qa: исполняет настоящие 3 demoJson branches в отдельном state, search aliases, duplicate, cross-venue GET/PATCH, manager organization permission, archive/restore и forbidden create. PASS, включён local-acceptance.
- Архитектор подтвердил pos-demo как самостоятельное локальное preview; wildcard sync ошибочно добавил HTML без assets в dist. Подготовлен контракт явных canonical templates + отдельный preview lifecycle; реализация ещё впереди, авторские preview файлы сохранены.

## Этап 3/6 — состав публикационной сборки (2026-09-29)
- Причина: wildcard HTML включал локальный pos-demo.html в dist без его CSS/JS; CRM design contract ошибочно проверял preview как рабочую страницу.
- Исправление: единый manifest из site-map.json для 14 канонических страниц и 13 aliases, отдельный явный allowlist локальных preview. Необъявленные root HTML отклоняются перед копированием; contract требует точного состава HTML в dist.
- Исходные файлы POS-preview сохранены. Ошибочную dist-копию удалили после побайтового сравнения с оригиналом, резервная копия сохранена в системной TEMP/crm-pos-demo-dist-backup.html. Docker использует явный COPY и не включает preview.
- Проверки: node --check для трёх изменённых MJS; sync-published-assets (41 source/dist HTML); local-design-contract PASS (14/27); header-shell-contract PASS.
- Ограничения: это проверка состава сборки, а не завершение интерактивного аудита или responsive gate. Публикация не выполнялась. Следующий блок — сведение оставшихся UI-сценариев в матрицу и их браузерное прохождение без повторения уже доказанных проверок.

## Этап 3/6 — браузерные фильтры задач и матрица (2026-09-29)
- Новый живой браузерный вход в изолированную QA CRM успешен; переход через sidebar на задачи сохранил сессию. Предыдущее наблюдение редиректа не воспроизведено этим путём, причина ещё не установлена.
- Проверены оба фильтра с пустым результатом и восстановлением двух задач, empty-submit с HTML validation/focus, отмена без создания.
- Создана AUDIT_COMPLETION_MATRIX.md: разделены реальные доказательства и недостающие проверки; все маршруты сохраняют статус неполного полного аудита.
- Code health подтвердил публикационный пакет; заметил отсутствие preflight неизвестных dist HTML в sync (их обнаруживает acceptance contract). Требуется закрыть до gate. Сообщение о резервной копии противоречит локальной проверке агента: существование перепроверить, не считать сохранение доказанным.

## Этап 3/6 — статусы задач (2026-09-29)
- Живой браузер: открыта → в работе → выполнена → reload подтверждает сохранение → отменена → открыта. Тестовая задача возвращена в исходное состояние; основная БД не затронута.
- Найден конкретный UX дефект: после изменения статуса фокус теряется на документ при перерисовке. Code health подключён к исходному renderTasks для минимального исправления с проверкой error/retry/pending.
- Снимок docs/ai-team/task-status-roundtrip-qa.png; весь этап 3 остаётся незавершённым.

## Этап 3/6 — keyboard/retry задач, portal340 (2026-09-29)
- Исправлена потеря фокуса: после перерисовки статус фокусирует видимый custom-select trigger новой карточки; при исключении карточки фильтром — стабильный фильтр статуса. Detached page не фокусируется.
- GET failure сохраняет каркас/фильтры и показывает Повторить; generation защищает от устаревшего ответа. Pending id не позволяет повторно отправить статус одной задачи при перерисовке.
- Успешный PATCH отражает подтверждённый статус локально, даже если повторное чтение недоступно; PATCH error сообщает ошибку и сохраняет прежние данные.
- Проверки: syntax, tasks-qa (5), local-design-contract PASS; новый task-ui-recovery-qa PASS (фактические функции focus/load: custom trigger, fallback, detached, GET failure/retry/stale). Добавлен в acceptance. Code health выполняет финальную read-only проверку.
- Браузерное подтверждение именно portal340 и PATCH error/pending runtime ещё требуются; не объявлено полным завершением задач/этапа.

## Этап 3/6 — браузерная проверка восстановленного фокуса (2026-09-29)
- Проверена идентичность disposable runtime: crm-audit-app, autoremove true, только 127.0.0.1:3215. В QA заменён только renderTasks текущим исходным блоком; остальные функции runtime не обновлялись. Резервный исходник в TEMP/crm-task-before.js.
- Enter на видимом custom trigger → ArrowDown → Enter: задача перешла в работу, AX подтвердил focused replacement trigger этой задачи. Enter повторно открыл меню; ArrowUp/Enter вернул исходный статус, фокус опять остался на этой задаче. До правки AX показывал документ вместо trigger.
- Снимок task-focus-restored-qa.png. Code health final: syntax/tasks5/local-design/task-ui-recovery PASS, блокеров не нашёл; runtime тест статуса PATCH handler ещё неполный, возможен перехват пользовательского фокуса после долгого PATCH.
- Отдельное наблюдение: мышиный click custom trigger не раскрыл меню в двух попытках, клавиатурное открытие сработало. Причина не установлена; не объявлять mouse сценарий PASS. Проверить отдельно shared custom select/focusout при следующем обходе.

## Этап 3/6 — уточнение мышиного наблюдения (2026-09-29)
- Не подтверждено, что неоткрытие task dropdown является дефектом CRM: семантический mouse click по кнопке «Приоритет» открыл другой фильтр «Статус». Это прямое свидетельство несовпадения цели ввода браузерного инструмента.
- Reset viewport и отдельная проба 1920×1080 не восстановили mouse click task selector. Keyboard продолжает работать; исходник не менялся на основании сомнительного мышиного наблюдения.
- Браузерный viewport возвращён штатным. Code health проверяет независимую click/focusout логику. Мышиный сценарий остаётся недоказанным, а не объявленным подтверждённым дефектом продукта.

## Этап 3/6 — браузерное бронирование (2026-09-29)
- В QA3215 проверены: Показать все сбрасывает дату и показывает существующие брони; поиск без совпадений даёт empty/recovery; поиск QA Бронь20260929 показывает одну совпавшую запись; пустой submit фокусирует обязательного гостя с validation.
- Keyboard выбор VIP места показывает вместимость4 и автоматически депозит1500 с пояснением зачёта в заказ. Новая бронь не отправлялась; reload сбросил несохранённую форму до депозита0. Снимок reservation-vip-deposit-qa.png.
- Найдено: dropdown теряет заголовки залов/optgroup, вопреки пояснению группировки; accessible name технический reservation-table. Передано code health для baseline shared component. Полный CRUD раньше частично проверен; весь маршрут ещё не завершён.

## Этап 3/6 — shared select optgroups/disabled/accessibility, portal341/css330
- Исправлена первопричина: options flatten терял optgroup и disabled. Общий компонент теперь сохраняет группы с доступными заголовками, учитывает блокировку option/optgroup, пропускает недоступные варианты при клавиатурной навигации и щелчке.
- Accessible trigger name берётся из aria-label или связанных label; технический id больше не используется. Названия залов экранируются; shared CSS групп добавлен без изменения бизнес-правил.
- syntax/local-design PASS; custom-select-groups-qa actual markup проверяет два зала, экранирование и enabled/disabled/groupdisabled; click/keyboard/label guards source assert. modal keyboard/focusout и taskrecovery PASS. QA включён в acceptance. Независимый final code health запрошен.
- Осталось браузерное подтверждение именно нового helper, включая группы и disabled, плюс полный общий dropdown responsive gate. Не опубликовано.

## Этап 3/6 — браузерное подтверждение залов, portal342
- Проверка QA3215 нового shared helper выявила регрессию accessible name: label.textContent включал options/подсказку. Исправлено: имя строится из клона label без select/input/textarea/button/small/custom wrapper.
- Повторная браузерная проверка: trigger ровно «Зал и место»; открытый dropdown AX содержит именованные контейнеры залов и вложенные места. Снимок reservation-hall-groups-qa.png. В этом dataset недоступных мест0: браузерную disabled ветку этим не доказывать, её markup/guards QA PASS.
- Публикационный sync portal342/css330; custom-select-groups-qa и syntax PASS. Code health portal341 review был положительным; дополнительная очистка имени выполнена по фактическому браузерному дефекту и ещё требует final review.

## Этап 3/6 — база гостей, browser QA3215
- Поиск QA Бронь20260929 дал1/44; Enter открыл профиль и фокус ФИО. Изменено имя черновика на QA НЕ СОХРАНЯТЬ; закрытие вернуло фокус карточке. Повторное открытие AX подтвердило исходное ФИО QA Бронь20260929: отмена не сохранила черновик. Снимок client-cancel-reread-qa.png.
- VIP0 tab дал empty0/44; Все44 вернул совпавшую карточку при сохранении поиска. БД не менялась.
- Найдено: история профиля показывает дату брони как «—», тогда как бронирования показывают02.10.2026/20:30. Передано code health для поиска field mismatch. Escape не закрыл inline editor; нужно сопоставить drawer contract, не считать дефектом без архитектурной проверки.
- Portal342 label review code health PASS; группы бронирований доказаны browser ранее; full audit остаётся открытым.

## Этап 3/6 — история гостя: SQL дата/время
- Подтверждена первопричина: PostgreSQL history отдавал startsAt, UI ожидал date/time. Сервер теперь добавляет совместимые date/time в часовом поясе заведения через JOIN venues и to_char; исходный startsAt сохранён.
- UI предпочитает venue-local date/time; legacy startsAt fallback оставлен. Memory календарная дата не меняется. Первый вариант browser-local startsAt заменён до сдачи из-за риска перехода суток.
- syntax server/portal и client-history-date-qa PASS, sync portal343. Live SQL boundary разных timezone и браузерный результат ещё не проверены, final code health запрошен. Не считать исправление полностью проверенным.

## Этап 3/6 — реальный PostgreSQL timezone boundary
- Disposable crm-audit-pg проверен: autoremove/127.0.0.1:55433, БД territory_qa, пользовательqa.
- Выполнен фактический SELECT истории из server.js с QA fixture внутри BEGIN/ROLLBACK. Один UTC timestamp2026-10-02T21:30Z: EKB03.10/02:30, NewYork02.10/17:30, Moscow03.10/00:30; все SQL assertions PASS. Все временные изменения откатились.
- В disposable QA app скопированы только исправленные history SQL query и renderer/helper; syntax PASS. Запущенный процесс ещё должен перечитать серверный код; браузерное подтверждение остаётся следующим действием.

## Этап 3/6 · Подэтап 5/8 — история гостя проверена на данных
- QA PostgreSQL: точно извлечённый SQL SELECT истории из server.js выполнен внутри транзакции с временным starts_at и timezone; assertions PASS: один UTC instant даёт EKB 03.10 02:30, New York 02.10 17:30, Moscow 03.10 00:30. ROLLBACK сохранил fixture.
- QA браузер 127.0.0.1:3215: открытая карточка QA Бронь20260929 теперь показывает 02.10.2026,20:30 вместо «—», что совпадает со списком броней. Снимок client-history-date-qa.png. Серверный node процесс в этом контейнере запускался до копирования исправленного SQL; браузерное чтение подтверждает UI fallback на старый startsAt для текущего часового пояса, а venue-local SQL отдельно подтверждён настоящим PostgreSQL. Совместный новый server+UI end-to-end после перезапуска ещё не доказан.
- Подэтап5 остаётся активным: другие CRUD/errors/responsive ещё нужны. После них переход6/8.

## Этап 3/6 · Подэтап 5/8 — сквозная полная сборка истории гостя
- Docker commit старого QA контейнера не прошёл из-за отсутствующего слоя. Собран новый образ из текущего Dockerfile, запущен отдельный autoremove QA контейнер только на 127.0.0.1:3216, старый3215 и основной45636 не менялись. Тестовая PostgreSQL общая disposable QA; health сообщает postgres.
- В новой сборке синтетический QA owner вошёл; `/clients` → поиск QA Бронь20260929 → профиль → история показала 02.10.2026 20:30 · Отменена. Это совместный путь текущего server SQL + текущего portal. Снимок client-history-full-build-qa.png.
- Дополнительно проверены статусный фильтр Новые, сортировка (варианты открывались; выбор По имени не подтверждён), период90дней/возврат30, новая карточка, пустой submit сфокусировал ФИО и не создал гостя. Форма закрыта, поиск очищен и статусы возвращены Все. Подэтап5 ещё не полностью закончен: оставшиеся действия/ошибки и адаптивность.

## Этап 3/6 · Подэтап 5/8 — никнейм гостя в PostgreSQL
- Browser QA3216 выявил: при создании QA гостя имя, предпочтения и заметки сохранялись, но никнейм исчезал после reload. Причина подтверждена read-only data/code health аудитами: колонка отсутствовала в QA PostgreSQL и во всех PG запросах гостя.
- Добавлены schema поле и идемпотентная миграция 053; PG list/search/create/update/hydrate сохраняют и возвращают nickname, не меняя tenant venue guard. Миграция применена в disposable `crm-audit-pg` дважды успешно; основной БД и VPS не касались.
- Собран полный образ, запущен отдельный autoremove QA app на loopback3217. Health=postgres. API QA PASS: create → GET → поиск по никнейму → PATCH → fresh GET → PATCH без nickname сохраняет поле → явная очистка. Browser QA3217: у исходного QA гостя сохранён «Тестовый гость»; после reload список по-прежнему показывает никнейм. Снимок `guest-nickname-persisted-qa.png`. 
ode --check`, `git diff --check` и final read-only code health PASS. Остальной обзор гостей/броней и responsive открыт.

## Этап 3/6 · Подэтап 5/8 — сортировка гостей
- Проверен реальный выбор «По имени» клавиатурой и указателем в QA3217. Первоначальный pointer test попадал по соседнему «По обороту» из-за смещения координат на 48 px в инструменте браузера; диагностические события показали фактический `event.target`. С точной координатой исходный общий select выбрал «По имени»; порядок всех 46 карточек совпал с `localeCompare('ru')`. Снимок `guest-sort-by-name-qa.png`.
- Экспериментальную правку общего select отменили после установления причины, источник и опубликованные assets вернули на rev343. `portal-action-keyboard-qa` повторно PASS. Дефекта приложения в этом сценарии нет; оставшиеся сценарии гостей и броней не считать закрытыми.

## Этап 3/6 · Подэтап 5/8 — повторная отправка формы гостя после ошибки
- В полной QA3217 сборке у нового гостя неверный Telegram давал сообщение об ошибке, но общий capture submit оставлял кнопку «Сохранение…» disabled на 6 секунд. Тот же долгий таймер мог разрешить дубль при медленном запросе. Code health подтвердил причину.
- `#client-form` исключён из общего таймера и сам управляет состоянием запроса: pending guard, блокировка на время API, немедленное восстановление в `finally` при успехе и ошибке. Остальные формы не менялись. Добавлен `client-form-submit-qa` в acceptance; syntax, contract и diff-check PASS; assets синхронизированы portal344.
- Browser QA3217: ошибка Telegram теперь сразу показывает активную кнопку и сохраняет значения; после исправления Telegram ошибка телефона тоже сразу восстанавливает кнопку; затем исправление телефона позволило сохранить ровно одну новую QA карточку (46→47). Снимки `client-form-error-retry-enabled-qa.png` и `client-form-immediate-retry-qa.png`. После дополнительной проверки формы черновик закрыт без отправки.
- Final code health нашёл гонку при быстром успехе: пока форма оставалась новой с пустым ID, повторное нажатие могло сделать второй POST. Успешный create теперь до разблокировки сохраняет возвращённый ID и меняет заголовок на карточку; следующий submit идёт PATCH. QA3217: create новой синтетической карточки 47→48, повторный submit, reload и поиск дали ровно 1 гостя из 48. Снимок `client-form-no-duplicate-qa.png`; contract обновлён, portal345/source/dist синхронизированы. Responsive и прочие состояния гостей остаются открытыми.

## Этап 3/6 · Подэтап 5/8 — ответ после смены карточки
- Code health обнаружил ещё одну гонку: POST гостя мог завершиться после закрытия редактора и открытия другой карточки, затем подменить в ней ID и заголовок. Добавлены счётчики сессии редактора и отправки. Старый ответ обновляет список, но не меняет текущую карточку, сообщение и состояние её кнопки. При закрытии/открытии редактора кнопка сбрасывается для новой сессии.
- `client-form-submit-qa` расширен на stale success/error/finally; тест и 
ode --check portal.js` прошли. Portal rev346 синхронизирован в source/dist и скопирован в disposable QA3217. При попытке браузерной проверки после reload автозащита QA-сессии заблокировала экран. QA-only задержка была убрана из контейнера, без изменений основной базы и браузера.
- Добавлен исполняемый `client-form-race-qa.mjs`: фактический submit handler из `portal.js` выполняется с управляемыми отложенными Promise. PASS: старый успешный ответ не подменяет ID/заголовок/сообщение открытой карточки и не разблокирует её новую отправку; старая ошибка не появляется в новой карточке. Код health повторно просмотрел final diff и блокеров не нашёл. Браузерный сценарий остаётся непроверенным из-за экрана блокировки.

## Этап 3/6 · Подэтап 5/8 — форма бронирования
- Аудит `portal.js` выявил три существовавших риска: общий capture submit держал кнопку 6 секунд после ошибки; замена выбранного гостя на разового оставляла автозаполненный телефон; одинаковые имена могли привязать бронь к первой совпавшей карточке. Code health подтвердил исходное состояние.
- `reservation-form` получил собственное pending-состояние без общего таймера, явную подпись кнопки и восстановление после API ответа. Поля формы блокируются во время отправки и возвращаются к исходному disabled-состоянию, чтобы поздний успешный ответ не стер новый ввод. Автозаполненный телефон удаляется при переходе к разовому гостю, если пользователь не менял его вручную. При неоднозначном имени скрытый client ID не выбирается произвольно, показывается подсказка уточнить имя/никнейм.
- Исполняемый `reservation-form-qa.mjs` проверил ошибку API и немедленное восстановление кнопки/полей, очистку старого ID/телефона, сохранение вручную изменённого телефона и неоднозначные имена. Final code health выявил гонку восстановления disabled-состояния стола после успешного ответа. Обновление списка столов перенесено после разблокировки формы; стилизованный select перерисовывается при lock/unlock. Для полностью одинаковых имён/никнеймов datalist теперь даёт отдельные варианты с телефоном и номером, затем оставляет в поле чистое имя гостя и связывает выбранный client ID. Значения вариантов уникализируются также относительно буквальных имён других гостей; исполняемый QA подтвердил обычный и специально конфликтующий случаи. Syntax, source/dist contract и diff check проходят. Полная браузерная проверка остаётся открытой из-за блокировки QA-сессии.

## Этап 3/6 · Подэтап 5/8 — проверка здоровья тестового контейнера
- Disposable `crm-audit-nickname` сообщал Docker unhealthy при работающем `127.0.0.1:3217/api/health` (HTTP 200, PostgreSQL). Внутри контейнера `wget localhost:3000` разрешался в IPv6 `::1` и получал connection refused, а `wget 127.0.0.1:3000` успешно возвращал health JSON. Причина в IPv4-only HOST=0.0.0.0 для QA-сборки.
- Dockerfile HEALTHCHECK и Compose crm.healthcheck переведены на 127.0.0.1. `docker compose config --quiet` PASS. Текущий исходник собран в `territory-crm:audit-health`, отдельный autoremove контейнер с HOST=0.0.0.0 на loopback3218 дал HTTP 200 и статус Docker `healthy` после двух проверок. Контейнер остановлен. Основной Docker Compose и VPS не перезапускались; старый QA3217 с уже созданным healthcheck сохраняет прежний ложный статус до пересоздания.
- Дополнительно запущена новая QA сборка на loopback3218 с disposable PostgreSQL: health 200. Обычный demo-вход в браузере открыл dashboard, но интерфейс сразу показал экран блокировки, поэтому браузерный retest бронирования провести не удалось без чужого PIN. QA контейнер остановлен; защита не обходилась и пользователя не спрашивали.

## Этап 3/6 · Подэтап 6/8 — складские формы
- Code health baseline выявил: общий capture submit удерживал кнопки складского движения и карточки позиции 6 секунд после ошибки. У карточки позиции не было локального pending guard: медленный POST после таймера мог создать дубль; открытие/отмена/переключение редактора до ответа позволяло позднему success стереть другой черновик. Сообщение «Позиция сохранена» исчезало при следующем `reset()`.
- Обе формы исключены из общего таймера и сами управляют pending. Поля и стилизованные select блокируются на время API и возвращают прежнее disabled-состояние в finally. Карточка позиции блокирует новые открытия/правки/отмену при сохранении, игнорирует дублирующий submit, сразу разблокируется после ошибки и показывает toast после успеха. Форма движения восстанавливает подпись кнопки и поля сразу после результата.
- `inventory-form-pending-qa.mjs` выполняет реальные обработчики с отложенным Promise: повторный POST не создаётся, редактор нельзя переключить во время запроса, ошибка сразу восстанавливает поля/кнопку, повторная отправка и success работают; для движения проверены ошибка, custom select refresh и сброс после успеха. Portal352 синхронизирован в source/dist. Браузерный и PostgreSQL путь этого подэтапа остаётся открытым.

## Этап 3/6 · Подэтап 6/8 — технологические карты
- Code health baseline выявил аналогичную гонку формы техкарты: общий шестисекундный таймер мог разрешить повторный POST/PATCH до ответа, а открытие/удаление другой карты во время сохранения приводило к устаревшему UI. `recipe-form` исключён из общего таймера; сохранение владеет pending guard, подписью кнопки и disabled-состоянием полей/стилизованных select.
- Сохранение и оба пути удаления техкарты используют общий локальный lock: параллельные действия и переключение редактора отклоняются до ответа. Успешное удаление карточки из списка закрывает её открытый редактор. Ошибка немедленно возвращает доступные элементы и исходную подпись.
- `recipe-form-pending-qa.mjs` выполняет фактические обработчики с отложенными Promise: create/edit, повторный submit, API error/retry, select refresh, form/row DELETE overlap, освобождение после ошибки и закрытие удалённого редактора. Portal354 source/dist синхронизирован; syntax/contract/diff checks PASS. Браузерная и PostgreSQL проверка техкарт остаётся открытой.

## Этап 3/6 · Подэтап 6/8 — каталог товаров
- Code health baseline выявил общий шестисекундный таймер, который разрешал повторный POST после задержки и оставлял неверную подпись кнопки после быстрой ошибки. Сохранение, удаление и смена открытой карточки могли пересекаться; поздняя обработка фото могла изменить другой черновик. Успешная запись с неудачным повторным чтением ошибочно представлялась как неудачное сохранение.
- Форма товара теперь владеет pending-состоянием и блокирует поля, стилизованный select, смену редактора, отмену и удаление до ответа API. После ошибки она сразу восстанавливает исходные кнопки и допускает повторную отправку. Успех записи отделён от ошибки обновления каталога. Обработка фото привязана к поколению редактора; сохранение ждёт её завершения. Итоговый code health выявил позднее создание стилизованного select; блокировка теперь запрашивает текущие элементы и обновляет его состояние.
- `product-form-pending-qa.mjs` выполняет обработчики с отложенными Promise: повторный POST, отмена и удаление во время записи, ошибка и немедленный retry, успешный POST с отказом повторного чтения, ожидание фото и отбрасывание позднего результата после отмены. Браузерный и PostgreSQL путь каталога остаётся открытым.

## Этап 3/6 · Подэтап 6/8 — документы поступления
- Code health baseline выявил общий шестисекундный таймер подписи, который искажал быстрое восстановление после ошибки, и отсутствие блокировки переходов между черновиками во время сохранения. Проведение и отмена могли одновременно отправляться для одного документа; поздний успех записи сбрасывал другую форму. Архитектурная сверка подтвердила права `inventory` и tenant-scoping API. Утверждение о том, что void должен уменьшать `receivedQuantity`, отклонено по коду БД: этот счётчик увеличивается только при проведении, а void меняет только статус черновика.
- `purchase-document-form` управляет своим pending: блокирует поля и переходы на время мутации, допускает немедленный retry после ошибки. Save, post и void сериализованы на UI; успех мутации отделён от сбоя повторного чтения, а post распознаёт серверный `detail` для изменённой единицы и превышения заявки. Итоговый code health обнаружил, что сброс после записи создавал новые доступные поля до завершения обновления списка; сброс перенесён после чтения. Исполняемый `purchase-document-pending-qa.mjs` проверяет отложенные запросы, отсутствие дублей и конфликтов, повтор после ошибки, задержку сброса на медленном чтении, сообщение при неудачной загрузке списка и точный текст post error. Browser/PG полный путь ещё открыт.

## Этап 3/6 · Подэтап 6/8 — автозаказ и переход к приёмке
- Code health и складской аудит выявили: старый GET мог заменить новый список, перерисовка снова включала кнопку во время POST и позволяла дублировать заявку, cancel/receive могли пересечься, неверное количество молча исключалось, а переход к приёмке стирал несохранённый ручной черновик. При перерисовке терялись выбранные позиции и исправленные количества.
- Добавлены поколение загрузки, pending создания до завершения повторного чтения и блокировка отправки при ошибке рекомендаций. Количество каждой выбранной позиции проверяется явно. Список сохраняет выбор и введённое количество при перерисовке, а успешное создание снимает выбор, чтобы следующий заказ требовал нового явного выбора; серверная политика запрета любых повторных заявок не вводилась. Cancel и receive сериализованы по ID заявки. Переход к приёмке с заполненным черновиком требует подтверждения в интерфейсе. Сохранённая заявка остаётся в локальном состоянии, если повторное чтение не удалось. Для demo и in-memory ID устранена коллизия нескольких заявок в одну миллисекунду.
- `auto-order-pending-qa.mjs` исполняет загрузку с переставленными ответами и создание с отложенным POST/GET, проверяет ошибочное количество, защиту от дубликата и точное сообщение об успешной записи при сбое повторного чтения. Browser/PG полный путь ещё открыт.

## Этап 3/6 · Подэтап 6/8 — изолированный PostgreSQL QA склада
- Текущий исходный Node-сервер поднят отдельно на 127.0.0.1:3219 против существующей disposable БД `territory_qa` в контейнере `crm-audit-pg` (127.0.0.1:55433). Первый запуск выявил отсутствие локального пакета `pg`: health показывал `database: memory`; установлены зависимости по 
pm ci --no-audit --no-fund`, затем health повторно подтвердил `database: postgres`. Основной локальный Compose и VPS не менялись.
- `warehouse-qa.mjs` на этом сервере прошёл 55 проверок. Новый `purchase-auto-order-postgres-e2e-qa.mjs` требует loopback-порт 3219, явный маркер `territory_qa`, URL изолированной базы и прямую проверку её имени/адреса/порта/роли через `postgres-qa-safety`; отдельно проверяет Docker `AutoRemove`, анонимный том и публикацию только на loopback. После замечания code health скрипт сам проверяет свободный порт, запускает текущий `server.js` с тем же проверенным `DATABASE_URL` и останавливает дочерний процесс в `finally`; больше не доверяет внешнему серверу на 3219. Он прошёл API→PostgreSQL сценарий: складская позиция с остатком 0, заявка на 2000 мл, черновик без движения, запрет отмены заявки с черновиком, проведение 1000 мл, отказ повторного проведения, отмена второго черновика без изменения остатка/полученного количества и финальное проведение оставшихся 1000 мл до статуса `received`. Отдельная заявка проверила, что отмена её черновика освобождает возможность отменить саму заявку. Прямой SQL reread подтвердил статусы документов, движения только у проведённых, полученное количество и стоимость единицы 0,25 ₽. После прогона порт 3219 свободен; основной локальный Compose и VPS не трогались. Синтетические QA записи остались только в автоматически удаляемой disposable БД; этот тест не включён в рутинный acceptance. Визуальный браузерный путь и роли ещё требуют проверки.

## Этап 3/6 · Подэтап 6/8 — браузерная проверка пополнения склада
- Изолированный Node на 127.0.0.1:3219 подключён к disposable `territory_qa`; вход и вкладка «Пополнение запасов» проверены в браузере. На окне около 950 px описание панели заходило под группу статуса и кнопки: у flex-заголовка было слишком мало места, а одноколоночный режим включался только до 760 px.
- Для панели автозаказов заголовок и действие теперь располагаются друг под другом при viewport до 1100 px, с переносом текста и сохранением отдельного мобильного правила до 760 px. Скриншотами браузера после правки проверены 375, 768, около 950, 1024 и 1440 px: наложения нет. На 375 px кнопка занимает строку, на 1440 px остаётся рядом с описанием. Проверен пустой список рекомендаций и история заявок; операции создания в браузере не выполнялись.
- CSS опубликован в source/dist с `rev=331`; `local-design-contract.mjs` и `git diff --check` прошли. Итоговый code health не нашёл блокирующей регрессии. Остальные представления склада, состояния ошибок и роли остаются в плане браузерной проверки.

## Этап 3/6 · Подэтап 7/8 — браузерная проверка поставок и списаний
- Текущий исходный Node проверен в отдельной in-memory сессии на 127.0.0.1:3219; сценарии БД и проведение документов этим проходом не проверялись. В браузере просмотрены форма приёмки, пустая история и форма списания на 375, 768, 980, 1024 и 1440 px. Добавление и удаление строк документа сработали; сохранение документа без строк показало валидационное сообщение и не создало документ.
- На 1024 px исходная пятиколоночная строка документа сильно сжимала подписи. Code health baseline подтвердил, что двухколоночная сетка включалась только до 980 px; порог для `.purchase-line` поднят до 1100 px без изменения остальных блоков. После правки браузер показал две колонки на 1100/1024/981/980 px, одну ниже 650 px и пять на 1101 px; горизонтального переполнения документа нет. CSS source/dist синхронизирован с `rev=332`, `local-design-contract.mjs` и `git diff --check` прошли.
- Полный путь приёмки на PostgreSQL уже проверен отдельно API→БД; браузерная проверка документов с данными, права ролей и ошибочные состояния остаются открытыми.

## Этап 3/6 · Подэтап 7/8 — премиксы и справочники склада
- В текущем исходном интерфейсе на временном in-memory Node (127.0.0.1:3219) осмотрены пустое состояние и форма премикса на 375/768/1440 px; формы цеха, подцеха, категории и каталога табака проверены на 375 px, каталог и список цехов — на 768 px. Формы открываются и закрываются без записи.
- Найден функциональный дефект: кнопка «Создать техкарту премикса» переводила на `?view=recipes`, но общая форма сбрасывала назначение на продажную позицию. После перехода форма теперь явно выбирает `premix`, очищает и блокирует товар меню и обновляет стилизованные селекты; во время сохранения текущей карты переход не перезаписывает редактор. Обычная «Новая карта» по-прежнему начинает с `sale`. Браузер подтвердил URL, выбранный тип, блокировку товара и Back/Forward; запись готовой карты и выпуск партии ещё не проверялись.
- На 375 px обязательная звёздочка у полей «Бренд» и «Вкус / название» в табачном каталоге стояла отдельной строкой. Подпись и звёздочка объединены внутри label; браузер показал их на одной строке, при этом оба input сохранили `required`.
- Добавлен `premix-create-route-qa.mjs` и включён в локальный acceptance. `recipe-form-pending-qa.mjs`, новый QA и `local-design-contract.mjs` прошли; опубликованный `portal.js` синхронизирован с source (`rev=359`). Code health и system_architect не нашли блокирующих замечаний для этих правок.

## Справочник табаков — обновление исследовательской выгрузки
- По официальным карточкам добавлены 2 SKU MUSTHAVE, 21 SKU DARKSIDE и связанных линеек и 5 SKU SATYR. «Азовский» не включён из-за расхождения описания и тегов; кандидаты без индивидуально подтверждённой фасовки также не публиковались.
- Следующим проходом добавлены 10 SKU GDS по официальным презентациям правообладателя RUSH GROUP и 4 карточки TROFIMOFF'S (Red Currant и Wild Strawberry в Burley/Terror) по официальному каналу производителя.
- Дополнительно подтверждены две карточки TROFIMOFF'S Old School Orange и восемь вкусов кальянной пасты Space Smoke. Лист проверки расширен сведениями о брендах без достаточной индивидуальной связи SKU и фасовки.
- Итоговый XLSX содержит 378 строк по 159 карточкам и 11 брендам; лист проверки охватывает 41 бренд/линейку. Для каждой товарной строки проверены обязательные поля, HTTPS-источник, дата, числовая фасовка и отсутствие исключённых импортных брендов; совпадений бренд + линейка + продукт + фасовка нет.
- `@oai/artifact-tool` повторно импортировал файл, пересчитал книгу, проверил новые диапазоны и не нашёл формульных ошибок. Контрольные рендеры листов «Сводка» и «Карточки» читаемы. Сайт, приложение, БД, API, миграции и визуальный аудит CRM не затрагивались.
## Этап 3/6 · Подэтап 8/8 — браузерный цикл премикса
- На отдельном локальном in-memory сервере 127.0.0.1:3219 созданы две синтетические складские позиции и приход 2000 мл сырья. Браузерный мастер создал техкарту премикса с выходом 1000 мл и расходом 500 мл сырья, предварительная себестоимость — 50 ₽. До исправления финальное сохранение блокировалось native HTML validation: временные поля выбора ингредиента оставались `required` после добавления строки и очистки. У них снят `required`; обязательность итогового состава и проверка при добавлении сохранены. Через UI карта сохранена и повторно прочитана, партия выпущена. API подтвердил остатки сырья 1500 мл, премикса 1000 мл и стоимость готовой единицы 0,05 ₽.
- После выпуска история показывала технический ID карты, потому что API партии не возвращает `recipeName`. Интерфейс теперь находит название по `recipeId` в загруженных техкартах; после reload показаны «QA Техкарта 082771db», выход 1000 мл, стоимость 50 ₽. `premix-create-route-qa.mjs`, синтаксис, синхронизация `dist/portal.js` и `git diff --check` прошли. Сервер и данные — изолированные, основной Compose/VPS не затронуты. Полная адаптивная матрица и общий release gate остаются открыты.
- На ширинах 375, 673, 768, 950 и 1440 px экран премикса не имел горизонтального overflow (`scrollWidth` равен ширине viewport); на 375 px визуально проверены форма выпуска и строка истории. Это проверка браузерного viewport, не аппаратный эмулятор. Code health итогового diff: scoped blocker не найден; ограничение для read-only истории без загруженного каталога карт остаётся на проверку.
## Этап 3/6 · История премикса для роли только на чтение
- Дополнительный аудит обнаружил расхождение API: PostgreSQL возвращал `recipeName` и `outputItemName` для партии, а in-memory GET возвращал сохранённый batch без этих полей. Роль с `inventory_read` не загружает полный список техкарт по контракту экрана и потому видела технический ID. In-memory выпуск теперь сохраняет оба имени из найденных на сервере техкарты и складской позиции; текущий API GET отдаёт их вместе с историей без дополнительного запроса и без расширения прав.
- `recipe-depletion-runtime-qa.mjs` проверяет имена в POST и повторном GET; 87 проверок PASS. `inventory-premix-load-state-qa.mjs`, синтаксис обоих JS и `git diff --check` PASS. Старая in-memory история до перезапуска остаётся с UI fallback по доступным техкартам; живой PostgreSQL и роли на реальном auth-enabled экземпляре ещё требуют сквозной проверки.
## Этап 3/6 · Проверка истории премикса под реальными ролями
- Расширен изолированный auth-enabled `role-api-matrix-runtime-qa.mjs`: администратор создаёт сырьё, выходную позицию, техкарту и партию; менеджер с `inventory_read` повторно читает историю и получает читаемое имя карты; бармен получает 403 на историю, менеджер — 403 на выпуск партии. В первый прогон выпуск дал 409: две быстрые операции создания склада получили одинаковый `ing-${Date.now()}` и выход оказался равен ингредиенту. Это реальная коллизия идентичности in-memory режима, а не ошибка прав.
- In-memory складской ID дополнен криптографическим суффиксом; browser demo ID также дополнен UUID с резервным случайным суффиксом. Demo QA фиксирует `Date.now()` и подтверждает разные ID при двух последовательных созданиях. Итог: role matrix PASS, demo premix unit QA PASS, recipe depletion 87 PASS, синтаксис, синхронизация `dist/` и `git diff --check` PASS. PostgreSQL пользуется собственными UUID; его контракт не менялся. Интерактивная проверка самой страницы под менеджером остаётся открыта.
## Этап 3/6 · Менеджерский экран премиксов, 30.09.2026
- На отдельном auth-enabled in-memory сервере 127.0.0.1:3220 администратор создал тестового менеджера и партию премикса. Менеджер вошёл через экран входа, открыл рабочий «Склад» и страницу премиксов. История показывала название и стоимость, но KPI показывали 0 рецептур и 0 позиций при фактических 1 и 2. Консоль выявила синхронный `TypeError`: инициализация безусловно обнуляла `#purchase-date`, отсутствующий у роли `inventory_read`, и прерывалась до загрузки склада. После guard загрузка дошла до конца; read-only загрузчик техкарт дополнительно записывает `recipeItems` для KPI.
- После reload браузер под менеджером показывает 1 рецептуру, 1 партию, 2 позиции, «Только просмотр», название карты и 25 ₽; кнопки выпуска нет. На 375 px горизонтального переполнения нет, карточка истории читаема. Тексты шапки и панели для роли просмотра теперь описывают просмотр, не предлагают приготовить партию. Проверены синтаксис, `inventory-premix-load-state-qa.mjs`, синхронизация `dist/portal.js` и визуальное состояние. Тестовый сервер и браузер закрываются после проверки; основной Compose/VPS не менялись.

## Этап 4/6 · Подэтап 2 — адаптивность рабочего POS, 30.09.2026

- На изолированном in-memory Node 127.0.0.1:3221 браузерный viewport проверен на 320×568, 360×800, 375×812, 390×844, 412×915, 430×932, 768×1024, 820×1180, 1024×1366, 1280×720, 1366×768, 1440×900, 1536×864, 1920×1080, 2560×1440, 3440×1440 и 3840×2160. После асинхронного изменения размера 4K перепроверен отдельно: innerWidth и document.scrollWidth равны 3840, рабочая область 1760 px, схема 1220 px, 12 колонок. Для всей матрицы document.scrollWidth не превышает viewport, `.order`, `.order-tabs` и `.actions` не имеют внутреннего горизонтального переполнения.
- На 320 px вкладки заказа и кнопки действий прежде обрезались: flex не учитывал объявленную одну колонку. Узкое правило переведено на grid с тремя сжимаемыми вкладками и одной колонкой действий. На QHD/4K рабочая область прежде оставалась около 1259 px из-за shrink-to-fit; явная ширина 100% при max-width 1760 px использует доступное место. Удалён конфликтующий широкий override пяти колонок: схема и координаты столов рассчитаны на 12. Source/dist синхронизированы.
- Визуально осмотрен пустой POS на 4K. `fold-responsive-contract.mjs` PASS (31 инвариант), `visual-page-rules-contract.mjs` PASS; итоговый scoped code health блокирующих замечаний не нашёл. Это проверка браузерного viewport, без аппаратного эмулятора, данных столов, Fold-перехода и zoom. Остальные маршруты и полный адаптивный gate остаются открытыми; VPS/GitHub не обновлялись.

## Этап 4/6 · Подэтап 3 — базовая матрица маршрутов, 30.09.2026

- На отдельном изолированном in-memory Node 127.0.0.1:3222 через реальную owner-сессию проверены 12 канонических маршрутов: `/admin`, `/orders`, `/clients`, `/reservations`, `/delivery`, `/inventory`, `/finance`, `/finance/categories`, `/finance/report`, `/integrations`, `/network`, `/platform`. Браузерный viewport: 320×568, 375×812, 768×1024, 1024×768, 1440×900, 2560×1440. Во всех 72 сочетаниях `document.documentElement.scrollWidth === innerWidth`; ни один маршрут не перенаправил на login.
- На 320 px дополнительный поиск локального переполнения показал: таблица `/platform` имеет предусмотренный `.platform-table-wrap { overflow-x:auto }` при ширине таблицы 720 px; визуально осмотрен верх страницы. Складской `thead` визуально скрыт для карточного мобильного представления. KPI имеют внутренний декоративный overflow около 28 px, общий документ не расширяется. У `/finance/categories` заголовок в верхней панели обрезается до «Категор…»; требуется отдельная оценка контракта topbar с архитектором, design/frontend/QA перед правкой.
- Эта матрица покрывает только начальные/пустые состояния и геометрию документа. Формы, заполненные таблицы, клавиатура, Fold/zoom и субъективная визуальная оценка каждой страницы остаются открытыми. Данные основной CRM, Compose и VPS не менялись.

## Этап 4/6 · Подэтап 4 — название раздела в общей мобильной шапке, 30.09.2026

- Первопричина: до 420 px `.header-context` ограничивался 38% ширины и внутри ещё имел 50 px отступа под плавающую кнопку меню. На 320 px для «Категории финансов» оставалось около 40–50 px, видимое название обрезалось до «Категор…». Системный архитектор подтвердил общий контракт шапки, design/QA предложили двухстрочную раскладку, code health проверил исходное состояние.
- До 480 px общая шапка `.portal-app` и `.portal-shell` теперь располагает контекст на первой строке с отдельным местом под кнопку меню, действия — на второй. Высота управляется общим `--crm-header-height:112px`, поэтому якорные отступы подстраиваются; DOM, порядок фокуса, роли и рабочая шапка сотрудника не менялись. Обновлены `style.css`, `dist/style.css`, `VISUAL_PAGE_RULES.md` и `sidebar-navigation-contract.mjs`.
- Браузерная owner-сессия на изолированном Node 127.0.0.1:3223: `/admin`, `/finance/categories`, `/finance/report`, `/inventory`, `/network` на 320/360/375/390/420/430/650/651 px, плюс граница 480/481 px у длинного заголовка. Название полностью видно до 480 px, шапка 112 px, документ/контекст/действия без горизонтального переполнения; после reload меню открывается и показывает активный финансовый раздел. Снимок 320 px визуально проверен. `sidebar-navigation-contract`, `admin-section-heading-contract`, `fold-responsive-contract` (31), `visual-page-rules-contract`, синтаксис и `git diff --check` PASS. Итоговый code health не нашёл блокирующих регрессий; длинные переводы и увеличенный текст/zoom требуют отдельной проверки.

## Этап 4/6 · Подэтап 5 — границы телефон/Fold/планшет, 30.09.2026

- На текущем исходнике в изолированной owner-сессии 127.0.0.1:3224 проверена `/finance/categories` при 280×653, 360×720, 673×841, 720×540, 768×1024, 844×390, 900×700 и 901×700. На всех документ и заголовок без горизонтального переполнения; до 900 px боковая панель скрыта в drawer с видимой кнопкой меню, после порога становится закреплённой. В портретном Fold-подобном размере 673 px меню открылось, показало активный раздел; переход в широкий 902 px закрыл drawer, снял `aria-expanded`, убрал backdrop и вернул прокрутку. Возврат на 673 px оставил меню закрытым.
- Дополнительно осмотрен минимум браузерного viewport 240 px: заголовок, кнопка меню и действия расположены без перекрытия; запрос 213 px браузер округлил/ограничил до 240 px. Комбинации клавиш для увеличения zoom в in-app browser не изменили `devicePixelRatio` или `visualViewport.scale`, поэтому фактический zoom 80/125/150% этим проходом не подтверждён. Сужение viewport нельзя считать заменой zoom-теста. Код не менялся; аппаратный Fold и остальные маршруты в этих состояниях остаются открытыми.

## Этап 4/6 · Подэтап 6 — форма финансовой категории на узком экране, 30.09.2026

- В изолированном in-memory runtime 127.0.0.1:3225 под owner на 320 px форма «Новая категория» открылась с фокусом на названии, оба действия находились в пределах viewport, пустой submit показал встроенную проверку, отмена очистила черновик. Но заполненный submit показывал «Сохранение…» и через 6 секунд возвращался без записи и сообщения. Причина: общий `document` submit listener в capture-фазе заранее блокировал кнопку, а локальный handler категории выходил на `if (submit.disabled) return` до API.
- Общий pending listener переведён в bubble-фазу: обработчик конкретной формы теперь первым ставит собственный pending и вызывает API; общий видит уже заблокированную кнопку и не вмешивается. `finance-categories-ui-contract.mjs` закрепляет порядок. После правки браузер сохранил тестовую категорию расхода, показал 1/1, после reload прочитал ту же строку. Повторное создание с тем же названием показало точную ошибку, сохранило имя и тип, восстановило кнопку, количество осталось 1/1. На 320/375/768/1024 px заполненная строка и открытая форма не расширяют документ; кнопки доступны в рабочей области.
- `finance-categories-ui-contract`, `portal-action-keyboard-qa`, `local-design-contract`, синтаксис и `git diff --check` PASS; source/dist синхронизированы с portal rev359. Итоговый scoped code health без блокера. Общий фиксированный pending таймер 6 секунд на других формах остаётся отдельным риском для долгих запросов; эта проверка не доказывает весь финансовый CRUD и actual zoom. Тестовая категория существовала только в disposable in-memory сервере; VPS не затронут.

## Этап 4/6 · Подэтап 7 — повторный выпуск премикса при долгом запросе, 30.09.2026

- Аудит общего 6-секундного submit-индикатора выявил высокий риск: `#premix-form` отправлял POST `/api/inventory/premixes/produce` без собственного pending guard. Повторный Enter или новый submit после разблокировки таймером мог выпустить две партии и дважды списать ингредиенты, если остатков достаточно. Серверный запрет перерасхода не является идемпотентностью партии.
- Форма теперь сохраняет payload до блокировки, помечает in-flight, отключает кнопку, повторный submit игнорирует. Загрузчик рецептур/остатков хранит `canProduce` и не включает кнопку при параллельном обновлении, пока выпуск идёт. После успеха обновление данных дожидается ответа, после успеха или ошибки `finally` снимает pending и включает кнопку только при доступных предпосылках. `portal.js` синхронизирован с `dist/portal.js`.
- Новый исполняемый `premix-submit-pending-qa.mjs` с отложенным API подтвердил один запрос на два submit, состояние кнопки, успех, ошибку/повтор и отказ при недоступных предпосылках. `inventory-premix-load-state-qa.mjs` дополнен сценарием обновления данных во время выпуска. Оба, `recipe-depletion-runtime-qa.mjs` (87 проверок), `finance-categories-ui-contract`, `local-design-contract`, синтаксис и `git diff --check` PASS. Итоговый scoped code health блокера не нашёл. Повторный браузерный выпуск на новом UI и серверная идемпотентность ещё открыты; общий таймер других форм остаётся на аудит.

## Этап 4/6 · Подэтап 8 — повторный браузерный выпуск премикса, 30.09.2026

- Изолированный in-memory сервер 127.0.0.1:3226 получил тестовые складские позиции и техкарту: 1000 мл сырья, выход 500 мл из 250 мл сырья. В браузере на 375×812 выбран рецепт и позиция выпуска; один submit показал «Партия приготовлена: 500 мл», KPI «Готовых партий» стал 1, история показала название техкарты и себестоимость 25 ₽. После reload та же единственная партия и KPI сохранились. Ширина документа с заполненной историей равна viewport 375 px. Временный браузерный tab и сервер закрыты; VPS не затронут.
- Проверка фактического двойного нажатия при медленном API остаётся в исполняемом deferred QA подэтапа 7; браузерный проход здесь подтверждает обычный выпуск и повторное чтение, но не серверную идемпотентность. Остальные ширины для заполненной истории ещё предстоит пройти.

## Этап 4/6 · Подэтап 9 — ожидание сохранения программы лояльности, 30.09.2026

- Code health baseline и finance/QA аудит нашли в видимой форме `#loyalty-form-visible` повторный POST/PATCH: общий таймер через 6 секунд возвращал кнопку до ответа API. In-memory POST допускает две программы, а поздний успех мог стереть новый черновик после переключения редактора.
- Форма теперь сама держит pending до ответа и повторного чтения: блокирует поля, сохранение, очистку, выбор другой программы, фильтр и архивирование; повторный submit игнорируется. Перерисованный во время ожидания список наследует disabled, делегированный обработчик дополнительно проверяет pending, включая возврат из диалога архивации. После ошибки черновик и доступность редактирования восстанавливаются; конфликт имени показывает конкретное сообщение. Изменены `portal.js`, `dist/portal.js`, ревизия 360; БД и API не менялись.
- `loyalty-program-pending-qa.mjs` исполняет фактический submit handler с задержанным ответом: два submit → один POST, ошибка и сохранение черновика, повтор, успех и обновление. Syntax source/dist, local design contract и `git diff --check` PASS. Повторный browser QA на 375 px дошёл до заполненной формы без горизонтального переполнения, но автоматическая блокировка рабочего места прервала submit; сквозное браузерное create/edit/archive/reload и роли остаются открытыми. Тестовый in-memory сервер и временный tab закрыты.

## Этап 4/6 · Подэтап 10 — браузерный цикл программы лояльности, 30.09.2026

- На отдельном in-memory сервере 127.0.0.1:3228 под тестовым администратором выполнен цикл на актуальном portal rev360: создана программа с 5% скидки и 10% бонусов, затем скидка изменена на 7%; после reload карточка и KPI повторно прочитаны. Архивация через диалог убрала программу из активного списка и обнулила KPI, фильтр «Включая архивные» показал карточку с соответствующим статусом, «Восстановить» вернуло её в активное состояние.
- Заполненная карточка и форма проверены при 320, 375, 768, 1440 и 2560 px: document.scrollWidth равен viewport во всех пяти случаях. Снимок 375 px визуально показал читаемые KPI, фильтр и действия карточки без наложений; на 320 px заголовок и KPI также доступны. Переключение ширины сохранило выбранный фильтр и карточку. Console содержала `authentication_required` от первоначального перехода на защищённый URL до входа; после входа видимых ошибок действия не дали. Временный tab и сервер закрыты.
- Этот проход подтверждает обычный CRUD и повторное чтение в изолированной памяти. Ошибку API в браузере, проверку PostgreSQL, права иных ролей, аппаратный Fold и полный quality gate он не покрывает.

## Этап 4/6 · Подэтап 11 — единый контракт программ лояльности в локальных режимах, 30.09.2026

- Code health и finance/QA сравнили PostgreSQL, in-memory Node и browser demo. PG запрещает одинаковое имя без учёта регистра внутри площадки, включая архивные записи, и отклоняет депозит вне 0..9 999 999 999,99 ₽ или точнее копейки. Локальные режимы раньше принимали дубликаты; demo принимал неверный депозит и ограничивал запись только правом `staff_manage`, хотя API разрешает также `finance`/`loyalty`.
- `server.js`: in-memory группы привязаны к выбранной площадке для последовательного GET/POST/PATCH и назначения гостю; POST/PATCH возвращают 409 `discount_group_name_exists` до мутации, в том числе при конфликте с архивом. Созданным ID добавлен случайный суффикс; действия пишутся в локальный аудит. `portal.js`: demo GET/write роли, проверки названия и депозита, код ошибки и выбор площадки приведены к контракту; старые seed-группы без `venueId` считаются группами исходной площадки. Source/dist синхронизированы, portal rev361; миграций и PG-ветки API нет.
- `discount-groups-memory-qa.mjs` запускает изолированный сервер и проверяет duplicate POST/PATCH, архивный конфликт, предел/копейки депозита, список и два последовательно выбранных заведения. `discount-groups-demo-qa.mjs` исполняет фактический demo route с теми же ошибками и проверяет доступ по ролям. Оба, `loyalty-program-pending-qa.mjs`, синтаксис, `local-design-contract`, `local-role-contract` и `git diff --check` PASS. Браузерная попытка проверить inline ошибку была прервана автоматической блокировкой рабочего места до первого submit; UI error остаётся неподтверждённым браузером.
- Ограничения: in-memory выбор площадки глобален для процесса и не доказывает изоляцию одновременных сессий; browser demo не изолирует все прочие сущности по площадкам. PG 
umeric(5,2)` округляет проценты точнее двух знаков, локальные режимы хранят исходное число. Эти вопросы требуют отдельной сквозной проверки, не считаются закрытыми текущим QA.
## Этап 4/6 · Подэтап 12 — добавление товара в POS, 30.09.2026

- Код каталога допускал два параллельных POST создания заказа при быстрых нажатиях разных товаров на пустом столе. Кнопка освобождалась до завершения добавления позиции; после успешного создания и ошибки позиции пустой заказ мог остаться без понятного пути повторения. Исправлен общий pending на всю операцию create+add, явный выбор стола, сохранение открытого заказа после ошибки и отображение серверной нулевой цены. Source/dist синхронизированы с app rev140.
- Deferred API QA проверил отсутствие запроса без выбранного стола, один create при двух нажатиях, блокировку кнопок до ответа item POST, нулевую цену, ошибку и повторное использование созданного заказа, а также сохранение выбранного стола при позднем ответе старого запроса. `staff-catalog-add-pending-qa`, `staff-catalog-load-state-contract`, `orders-total-qa`, `order-item-close-guard-qa`, `staff-active-count-contract`, синтаксис source/dist, `local-design-contract` и `git diff --check` пройдены. Итоговый scoped code health не нашёл блокирующих дефектов.
- В изолированном in-memory сервере на 127.0.0.1:3232 созданы тестовые зал, стол, товар 250 ₽ и смена. В браузере выбран стол, клавишей Enter открыт каталог, нажата карточка товара; заказ появился с одной позицией, итогом 250 ₽ и статусом «Новый заказ». На 320 px открытый каталог и карточка имеют границы внутри viewport, document.scrollWidth=320 px; на 375/768/1024/1440 px заполненный заказ также не дал общего горизонтального overflow. При попытке проверить 2560 px один быстрый замер вернул прежнюю ширину после изменения viewport, поэтому эта точка не засчитана. Временный tab закрыт, viewport сброшен, сервер остановлен.
- Полный POS цикл, оплата и реальная печать остаются открытыми. Кнопка открытия каталога срабатывала через Enter, но два pointer-click наблюдения не открыли окно; требуется отдельно воспроизвести и выяснить, связано ли это с UI или управлением браузером. Потерянный ответ на создание заказа пока требует сверки с сервером и не имеет серверной идемпотентности.
## Этап 4/6 · Подэтап 13 — POS оплата и название стола в журнале, 30.09.2026

- В изолированном in-memory POS каталог открыт клавишей Enter после выбора стола; добавлен товар 250 ₽, количество увеличено до двух (500 ₽). Оплата 200 ₽ наличными и 300 ₽ картой закрыла заказ, освободила стол и убрала его из списка активных. Журнал показал один закрытый заказ и выручку 500 ₽; API сохранил оба платежа с правильными суммами и текущей сменой.
- Нажатие указателем на «Добавить позицию» в браузерном инструменте попадало в соседний блок «Итого»; диагностическое событие `click` подтвердило фактическую цель. Перерисовка кнопки не была причиной. Временная инструментальная правка удалена; app rev140 восстановлен. Аппаратное нажатие мышью/касание отдельно не подтверждено.
- Журнал ошибочно показывал «Стол не найден» для существующего in-memory стола: `/api/orders` отдавал `tableId` без `tableName`, хотя PostgreSQL список включает имя. Ответ memory GET теперь обогащает копии заказов актуальным названием из схемы зала, не меняя сохранённый заказ. `order-journal-table-memory-qa` проверил создание, переименование и повторное чтение; `order-journal-display-contract`, `orders-total-qa`, синтаксис, `local-design-contract` и `git diff --check` прошли. В новом изолированном браузере `/orders` показал «Стол QA», а поиск по названию сохранил строку. Итоговый scoped code health не нашёл блокера.
- Проверка печати, частичной оплаты с оставшимся долгом, ошибок оплаты и аппаратного Fold остаётся открытой. Временные браузерные вкладки и серверы закрыты.
## Этап 4/6 · Подэтап 14 — остаток частичной оплаты POS, 30.09.2026

- Исходная форма после оплаты 200 ₽ из 500 ₽ снова показывала «К оплате 500 ₽» и допускала ввод 400 ₽; сервер затем отклонял превышение остатка. `app.js` теперь при открытии читает `/api/orders/:id/payments` и показывает серверные `due/paid/remaining`, а введённые суммы сравнивает с текущим остатком. После каждого POST баланс обновляется по ответу API. При ошибке одного из последовательных платежей суммы ввода очищаются и GET сверяет уже проведённые платежи; автоматического повтора платежа нет.
- Асинхронные ответы привязаны к заказу и версии окна. Поздний GET/POST не закрывает и не переписывает окно другого заказа; повторное открытие того же заказа во время POST ждёт его завершения и затем обновляет баланс. Если поздний ответ закрывает заказ, повторно открытое окно закрывается до обновления списка. Деферред `staff-partial-payment-pending-qa.mjs` проверяет остаток, локальный запрет переплаты, закрытие, ошибку второго POST, устаревшие GET/POST, повторное открытие того же заказа и поздний финальный ответ. Source/dist синхронизированы с app rev144.
- Изолированный браузер подтвердил 500 ₽ → 200 ₽ наличными → повторное открытие с остатком 300 ₽ и подписью «Уже оплачено 200 ₽ из 500 ₽»; ввод 400 ₽ остановлен на форме, 300 ₽ картой закрыли заказ. Второй частично оплаченный заказ после reload снова показал остаток 300 ₽. На 320/375/768/1024/1440 px открытая форма не вызвала общего горизонтального переполнения; ширина и кнопка оставались в viewport. Браузерный проход был до последней ревизии гонки (rev144), поэтому её подтверждает deferred QA, а не этот проход.
- `staff-partial-payment-pending-qa`, `staff-catalog-add-pending-qa`, `orders-receipt-qa`, `orders-total-qa`, `local-design-contract`, синтаксис source/dist и `git diff --check` прошли; итоговый scoped code health не нашёл блокеров после исправления гонки позднего финального POST. Печатное окно не удалось подтвердить в браузере; кодовый receipt QA проверяет только HTML, дату, сумму и блокировку popup. Независимый POS аудит выявил ещё один финансовый риск: изменение/удаление позиций, скидка или отмена после частичной оплаты могут снизить сумму ниже уже полученных платежей; требуется серверный инвариант и отдельный сценарий QA. Временный сервер и вкладка закрыты.

## Этап 4/6 · Подэтап 15 — финансовая целостность частично оплаченного заказа, 30.09.2026

- До правки POST/PATCH/DELETE позиции, разделение и одобрение скидки могли уменьшить стоимость заказа ниже уже полученных платежей. Отмена/удаление оплаченного заказа оставляли платежи без процесса возврата; закрытие скрывало переплату через `max(0, due-paid)`. Независимые finance, architect и code health аудиты подтвердили пути.
- `server.js`: единый расчёт `due/paid` учитывает статусы `paid` и `partially_paid` и округляет сумму заказа до копеек. В PostgreSQL изменение позиции, разделение и одобрение скидки проверяют `paid <= due` внутри транзакции под блокировкой заказа; конфликт 409 откатывает все изменения. In-memory повторяет условие с восстановлением исходных позиций/статуса. Отмена и удаление после принятого платежа возвращают 409 до появления сценария возврата. Close проверяет переплату до списания склада; новые платежи требуют точности до копейки и не могут превышать остаток.
- Деморежим `app.js`/`portal.js` приведён к этому правилу; интерфейс показывает конкретную причину отказа для изменения позиции, разделения и удаления. Source/dist синхронизированы с app rev145 и portal rev362. `paid-order-balance-memory-qa` прошёл изолированный HTTP сценарий 150/200 ₽: изменение/удаление позиции, split, отмена, удаление, скидка и переплата на копейку отклонены; сумма сохраняется, корректные 50 ₽ закрывают заказ. `paid-order-balance-demo-qa`, `staff-partial-payment-pending-qa`, транзакционные контракты, синтаксис, `local-design-contract` и `git diff --check` прошли.
- Ограничения: PostgreSQL путь оценён по коду и статическим контрактам, отдельный runtime сценарий после этой правки ещё нужен. В `portal.js` есть неиспользуемый renderer одобрения скидки, но контейнера на странице финансов и вызова renderer нет; UI одобрения остаётся отдельной незавершённой цепочкой.

## Этап 4/6 · Подэтап 16 — браузерная эмуляция размеров, 30.09.2026

- В изолированном сервере 127.0.0.1:3239 авторизованный Chromium с сенсорным контекстом проверил `/admin`, `/orders` и POS `/` на 19 размерах 320×568…3840×2160 и непрерывно с шагом 17 px от 320 до 1024. Общего горизонтального overflow нет. Скриншоты 320, 768, 1920 и 2560 px сохранены в `docs/ai-team/responsive-emulator/`.
- Касание открыло мобильный drawer. При переходе 375→768→1024→375 px выбранная дата сохранилась, drawer закрылся при пересечении breakpoint. Повторный запуск подтвердил освобождение тестовой сессии при logout. Скриншоты выявили обрезанный заголовок POS на 320 px. После проверки system_architect, design lead и code health мобильное правило заголовка разрешает перенос на две строки; повторный скриншот 320 px показывает полный текст. Sidebar/header/Fold контракты и эмуляция 19 размеров на трёх маршрутах прошли, CSS rev333 синхронизирован с dist.
- Это эмуляция Chromium, а не проверка на физическом Galaxy Z Fold8. Первый проход охватил пустые основные экраны; последующий подэтап проверил заполненный POS и окно оплаты, остальные формы и системная клавиатура остаются открытыми. Тестовый сервер и сессия изолированы от пользовательской базы.

## Этап 4/6 · Подэтап 17 — заполненный POS и окно оплаты в эмуляции, 30.09.2026

- В изолированной in-memory CRM создана смена, зал, стол, товар без списания склада и заказ 200 ₽ с предоплатой 50 ₽. `responsive-emulator-runtime-qa` теперь проверяет заполненные `/orders` и POS на 19 размерах, окно остатка 150 ₽ при 320×568 и 768×1024, сохранение остатка при складывании обратно, доступность крестика и кнопки после прокрутки. Контроль экрана идёт в touch-контексте, источник платежа — реальный HTTP API тестового процесса.
- Скриншот открыл P1: sidebar и sticky header рисовались поверх окна оплаты; на коротком экране часть формы выходила за пределы. В `style.css` staff modal поднят над каркасом, payment box ограничен высотой viewport и прокручивается внутри. Повторный скриншот 320 px показывает заголовок, крестик, баланс и поля, отдельный кадр после прокрутки — кнопку сохранения. CSS rev334 синхронизирован с dist.
- Снимок `/orders` с 200px sidebar оказался кадром в 180ms CSS-переходе после смены ширины. QA теперь ждёт, пока закрытый drawer полностью уйдёт за край viewport; повторный 320px снимок показывает журнал без перекрытия. Физическое устройство, виртуальная клавиатура, ошибки платежа и полный интерактивный обход маршрутов остаются открытыми.

## Этап 4/6 · Подэтап 18 — согласование скидок, 30.09.2026

- Архитектурный и code-health аудит нашли неподключённую функцию отображения скидок: на `/finance` отсутствовали секция, загрузка и обработчики решений. Добавлена секция на существующем маршруте с количеством ожидающих заявок, обновлением, состояниями загрузки/ошибки, блокировкой повторного решения и понятным сообщением при конфликте с уже полученной оплатой. Права не расширялись: `finance_read` видит, `finance` принимает решение. ID и проценты экранированы; технический UUID или `unknown` не выводится как имя сотрудника.
- Изолированный Chromium и in-memory HTTP API подтвердили одобрение, отклонение и отказ в одобрении скидки, которая опустила бы сумму заказа ниже 90 ₽ оплаты. При отказе заявка остаётся ожидающей. Заполненный экран без общего горизонтального overflow на 320/768/1440 px; снимки секции сохранены. `finance-discount-runtime-qa`, `paid-order-balance-demo-qa`, синтаксис и `git diff --check` прошли. Source/dist синхронизированы с portal rev363.
- PostgreSQL HTTP сценарий защиты оплаченного заказа и полный финансовый интерактивный обход ещё открыты. Физический Fold8 не проверялся.
- Дополнительно в browser demo закрыт сценарий согласования заявки без активного заказа: отсутствующий и завершённый заказ дают `discount_not_found_or_decided`; проверка helper для отсутствующего заказа добавлена в `paid-order-balance-demo-qa`.

## Этап 4/6 · Подэтап 19 — PostgreSQL инвариант оплаченного заказа, 30.09.2026

- На запущенной отдельной `territory_qa` в одноразовом контейнере `crm-audit-pg` проверены URL, фактическая БД, адрес, порт, суперпользователь и публикация только на 127.0.0.1 до создания fixture. HTTP сервер запущен с отдельным venue и портом 0; существующая база проекта не затрагивалась.
- `paid-order-balance-postgres-qa` создал заказ 200 ₽, внёс 150 ₽ и подтвердил откат изменения/удаления позиции, split, отмены и удаления заказа, а также одобрения 50% скидки. В PostgreSQL скидка осталась `requested`, due — 200 ₽; переплата 50,01 ₽ отклонена, ровно 50 ₽ закрыли заказ. Тест удаляет только собственные записи в `finally` и добавлен в общий `postgres-qa.mjs`.
- Code-health аудит выявил риск ложного PASS при ошибке очистки. Теперь тест проверяет неизменность строки позиции и число заказов после rollback, ровно два сохранённых платежа, фиксирует ошибки удаления и объявляет PASS только после подтверждения полного удаления своей площадки. Обнаруженные прежние fixture этого теста (три площадки только с audit_events) очищены по точным UUID; повторная проверка дала 0 оставшихся `Paid order QA`.
- Общий PostgreSQL suite запущен: новый сценарий и все предшествующие suites прошли. В существующем `recipe-depletion-pg-runtime-qa` проход остановился на конфликте зарезервированного fallback user ID: QA БД уже содержит `QA Owner` в площадке «Территория», а тест ожидает принадлежащего ему `QA Владелец`. Чужую fixture не удаляли. В ходе прогона исправлена устаревшая инъекция денежных helper в `shift-cash-postgres-e2e-qa`; её проверка повторно прошла. Браузерный UI на PostgreSQL и устройство Fold8 остаются открытыми.

## Этап 4/6 · Подэтап 20 — заполненная страница финансов, 30.09.2026

- Визуальный/архитектурный аудит обнаружил, что заявки на скидку находятся глубоко ниже графиков и сводок, а прямой переход `#discounts` может не прокрутить к динамически созданному блоку. Секция перемещена сразу после KPI, прокрутка по hash подключена после рендера и при hashchange, добавлен отступ под sticky header. Маршруты и права не менялись.
- На 768 px длинная причина заявки сжимала статус и кнопки; строка становится одноколоночной до 900 px, длинные идентификаторы/причины переносятся, кнопки решения и обновления имеют высоту не меньше 44 px. Во время POST обновление блокируется, старый GET не может перерисовать активное решение.
- Браузерный тест подтверждает одобрение/отклонение/конфликт оплаты, прямой hash-переход, отсутствие общего горизонтального переполнения и доступные кнопки на 320/375/430/768/1024/1440/2560 px. Просмотрены снимки верхней части, заявок и нижней части при прокрутке на 320/768/1440 px. `fold-responsive-contract`, `local-design-contract`, синтаксис, `git diff --check` прошли. Source/dist: portal rev364, CSS rev336.
- Это не полный интерактивный обход финансов: графики, все расчёты, фильтры, зарплатный реестр и ошибки других форм остаются открытыми. Физический Fold8 и системная клавиатура ещё не проверены.

## Этап 4/6 · Подэтап 21 — интерактивные финансы, 30.09.2026

- Устранены гонки загрузки расходов и задолженностей: поздний ответ старого фильтра больше не перезаписывает новый. При ошибке сводки очищаются прежние KPI, графики и суммы; переключатель вида оплат отключён до успешной загрузки.
- Диаграмма методов оплаты расширяет SVG по числу методов. График за 365 дней прокручивается по горизонтали внутри подписанной области. Подписи даты и периода уточнены для ежедневной сводки и итогов.
- Браузерный тест выявил, что in-memory категория расхода получала не-UUID ID, а API расхода требовал UUID даже без PostgreSQL. Формат UUID теперь проверяется в PostgreSQL ветке; in-memory ветка проверяет ID по активной категории. Через форму успешно создан расход и повторно прочитан из API.
- Исполняемый Chromium проверил графики, виды оплат, заявки на скидку, сохранение расхода, ошибки загрузки, гонки фильтров и ширины 320/375/430/768/1024/1440/2560 px. `finance-discount-runtime-qa`, `finance-load-race-qa`, `finance-chart-empty-state-contract`, `local-design-contract`, синтаксис и `git diff --check` прошли. Source/dist синхронизированы: portal rev367, CSS rev337.
- Зарплатные действия, весь CRUD задолженностей и финансовые сценарии на PostgreSQL ещё открыты. Физический Fold8 не проверялся.

## Этап 4/6 · Подэтап 22 — параллельные действия с начислением, 30.09.2026

- Code-health аудит выявил возможность одновременно отправить утверждение и отмену одного начисления. Добавлен per-entry pending guard: повторный обработчик не посылает PATCH, а кнопки действий строки отключены до завершения запроса.
- Изолированный Chromium с задержанным ответом PATCH подтвердил блокировку соседнего действия, отсутствие второго запроса и переход строки к состоянию «Утверждено» после успешного ответа. `finance-discount-runtime-qa`, `payroll-register-load-state-qa`, `payroll-register-ui-contract`, `finance-chart-empty-state-contract`, `local-design-contract`, синтаксис и `git diff --check` прошли. Source/dist: portal rev368, CSS rev337.
- Сквозной browser QA зарплаты на PostgreSQL (создание → утверждение → выплата/отмена), ошибка PATCH и адаптивность заполненной зарплатной формы остаются открытыми.

## Этап 4/6 · Подэтап 23 — зарплата через браузер и PostgreSQL, 30.09.2026

- В отдельной `territory_qa` с проверкой имени БД, адреса/порта, суперпользователя и disposable Docker container Chromium выполнил UI путь: создать черновик по восьми часам → утверждать → отметить выплаченным. SQL подтвердил 4 000 ₽, статус `paid`, единственный связанный расход `payroll` и выбранную дату. После reload статус повторно прочитан через фильтр.
- Визуальный просмотр заполненного реестра выявил открытую после сохранения форму и устаревшее сообщение о черновике. После успешного обновления форма закрывается; сообщение о текущем действии остаётся в реестре, а при сбое перечитывания показывается конкретная просьба повторить загрузку.
- Заполненный экран проверен на 320/375/768/1440/2560 px: общий документ, `.portal-main` и панель зарплаты без горизонтального переполнения. Снимки `responsive-emulator/payroll-paid-{320,768,1440}.png` сохранены. Тестовая площадка удалена; повторный запрос показывает 0 оставшихся площадок с её именем. `payroll-browser-postgres-qa`, `payroll-lifecycle-postgres-api-qa`, `payroll-register-load-state-qa`, `payroll-register-ui-contract`, `local-design-contract`, синтаксис и `git diff --check` прошли. Source/dist: portal rev369.
- Отдельные ошибки PATCH и сценарий отмены через браузер остаются открытыми. Реальное устройство Fold8 и экранная клавиатура не проверены.

## Этап 4/6 · Подэтап 24 — отмена начисления и отказ сервера, 30.09.2026

- Изолированный PostgreSQL browser QA создал второй черновик, проверил отказ при двухсимвольной причине, затем принудительный 503 на PATCH: строка в БД осталась `draft`, причина сохранилась в редакторе. Повторный PATCH сохранил `cancelled` и точную причину; после reload статус повторно прочитан.
- При ожидании PATCH кнопка «Назад» могла закрыть форму и сбросить причину. Теперь открытие/закрытие редактора блокируется для начисления с активным запросом, кнопка «Назад» отключена. Chromium с задержанным 503 подтвердил, что редактор и введённая причина сохраняются до ответа.
- `payroll-browser-postgres-qa`, `payroll-register-load-state-qa`, `payroll-register-ui-contract`, `local-design-contract`, синтаксис и `git diff --check` прошли. После теста осталось 0 площадок `Isolated payroll browser QA`. Source/dist: portal rev370. Отмена уже утверждённого начисления, роль с ограниченным доступом, Fold8 и мобильная экранная клавиатура ещё открыты.

## Этап 4/6 · Подэтап 25 — отмена утверждённого начисления, 30.09.2026

- В том же изолированном browser/PostgreSQL сценарии создано отдельное начисление за непересекающийся период, утверждено и отменено через экран. SQL подтвердил `cancelled`, точную причину и время отмены, сохранённое время утверждения, пустые `paid_at`, `payment_date`, `expense_id`; число зарплатных расходов осталось равным одному, только для ранее выплаченной записи. После reload отмена повторно показана.
- При смене ширины 2560 → 320 px первый снимок был сделан в ходе 180-мс анимации закрытия бокового меню. Тест теперь дожидается закрытого положения меню и активного основного содержимого без reload; итоговый снимок `responsive-emulator/payroll-cancelled-320.png` просмотрен. Горизонтального переполнения панели нет.
- `payroll-browser-postgres-qa`, `payroll-register-ui-contract`, синтаксис и `git diff --check` прошли. Тестовая площадка удалена (0 записей с её именем). Ограниченные роли, мобильная экранная клавиатура и реальное устройство Fold8 остаются открытыми.

## Этап 4/6 · Подэтап 26 — ограниченные роли в финансах, 30.09.2026

- Отдельный in-memory сервер с `AUTH_REQUIRED=true` и временными учётными записями `bartender`/`manager` позволил пройти страницу финансов под реальными ролями. Сотрудник видел только собственный оборот и не получал общие KPI/задолженности; ответ сводки содержал только `date`, `employeeView`, `revenue`. Менеджер видел заполненные mock-строки задолженности/заявки на скидку без форм оплаты и кнопок решения, зарплатный реестр и форму расхода не видел.
- Прямые запросы обеих ролей к начислениям, категориям, записи расхода, оплате поставщику и одобрению скидки вернули 403. Чтение сводки осталось доступным, чтение задолженностей сотрудником вернуло 403. Оба интерфейса без общего горизонтального переполнения на 320/768/1440 px.
- `finance-role-browser-qa`, `role-api-matrix-runtime-qa`, `local-design-contract`, синтаксис и `git diff --check` прошли. Production и основная база не затронуты. Права на финансовых экранах остальных ролей и physical Fold8 остаются открытыми.
- Code-health проверка уточнила QA: каждый прямой API запрос теперь передаёт токен конкретной роли, а `/api/session` подтверждает её перед проверкой 403; проверка ширины включает `.portal-main`. Повторный browser QA прошёл.

## Этап 4/6 · Подэтап 27 — переход Fold и форма расходов, 30.09.2026

- В одном живом Chromium-сеансе черновик расхода, выбранный фильтр и вид графика сохранены на 375 → 768 → 375 px без reload; форма остаётся тем же DOM-элементом. При высоте 420 px кнопка отправки доступна прокруткой. Открытое мобильное меню при расширении до 1024 px закрывается, `inert` снимается с рабочего пространства, черновик остаётся. Снимки `responsive-emulator/finance-fold-draft-{cover,main}.png` просмотрены.
- Снимок выявил кнопку «Сохранение…» после успешного расхода: общий обработчик держал её отключённой фиксированные 6 секунд. Для `expense-form` введён собственный pending lock по фактическому FileReader/POST/обновлению, snapshot данных и восстановление управления после успеха/ошибки; повторный submit до завершения не отправляет второй POST. Chromium с задержанным 503 подтвердил одну отправку, сохранение черновика, разблокировку и единственную запись после повтора.
- `finance-discount-runtime-qa`, `finance-load-race-qa`, `local-design-contract`, синтаксис и `git diff --check` прошли. Дополнительный browser QA подтвердил FileReader с небольшим PNG, передачу data URL в POST и разблокировку кнопки; завершение формы стало идемпотентным, а гонка теста дожидается первого запроса. Source/dist: portal rev372. Это проверка эмулятора ширины/уменьшенной высоты, не аппаратного Fold8 или настоящей системной клавиатуры.

## Этап 4/6 · Подэтап 28 — расчёты с поставщиками, 30.09.2026

- Изолированный browser/PostgreSQL сценарий провёл накладную на 200 ₽, через UI оплатил 75 ₽ безналично и 125 ₽ наличными. SQL подтвердил ровно два связанных расхода на 200 ₽, промежуточный и итоговый статусы, историю и повторное чтение после reload. Тестовая площадка удаляется в `finally`.
- При задержанном POST изменение фильтра больше не перерисовывает активный редактор и повторный submit не отправляет второй запрос. Все поля формы блокируются до ответа; задержанный 503 сохраняет сумму, дату и способ оплаты для повтора. Browser QA подтвердил единственный успешный повтор и отсутствие лишнего расхода.
- Заполненная панель проверена на 320/768/1440 px без горизонтального переполнения; снимки `responsive-emulator/payables-paid-{320,768}.png` сохранены и просмотрены. Параллельная попытка оплаты теперь получает понятное сообщение, а отмена чтения файла снимает ожидание. `payables-browser-postgres-qa`, `purchase-payment-postgres-api-qa`, `finance-discount-runtime-qa`, `local-design-contract`, синтаксис и `git diff --check` прошли. Source/dist: portal rev375. Реальный Fold8 и экранная клавиатура не проверены.

## Этап 4/6 · Подэтап 29 — файл оплаты поставщику на мобильной ширине, 30.09.2026

- Browser QA с открытым редактором на 320 px выявил, что нативный file input шириной 362 px расширял форму и панель до 392 px. Для него задана ширина в пределах контейнера; повторная проверка показала отсутствие переполнения. Снимок `responsive-emulator/payables-file-form-320.png` просмотрен.
- Через браузер проверены отклонение SVG и PNG с неверной сигнатурой без POST, выбор валидного PNG, сохранение data URL в PostgreSQL и ссылка в истории. При 503 выбранный файл и значения формы остаются для повтора; обе успешные оплаты сохранили документ, без лишних расходов. Черновик сохранился при смене 320 → 375 px без reload.
- `payables-browser-postgres-qa`, `purchase-document-validation-qa`, `local-design-contract`, синтаксис и `git diff --check` прошли. Source/dist: CSS rev338, portal rev375. Реальный Fold8, системный file picker и экранная клавиатура остаются открытыми.

## Этап 4/6 · Подэтап 30 — справочник финансовых категорий, 30.09.2026

- В `renderFinanceCategories` поздний ответ старого фильтра больше не заменяет актуальный список. Ошибка GET очищает старые строки и счётчик, показывает локальную кнопку повторной загрузки. На время POST/PATCH блокируются поля редактора, переключение категорий, создание и архивирование; повторное действие не отправляет второй запрос.
- Исправлена индикация при успешной записи и неудачном повторном GET: интерфейс сообщает, что категория сохранена, но список не обновился, и предлагает перечитать его без повторной записи.
- Новый in-memory browser QA проверил создание, ошибку дубликата, редактирование после задержанного 503, архивирование/восстановление, reload, гонку Active/All, ошибку GET с повтором и успешный POST с последующим 503 на GET. Заполненный список не переполняет 320/768/1440 px. Отдельный PostgreSQL API QA подтвердил CRUD, связь с расходами, конкуренцию, tenant и role isolation; его площадки удалены (0 остаточных).
- По итоговой code-health проверке поиск больше не заменяет сообщение об ошибке загрузки пустым состоянием: кнопка повтора остаётся доступной до успешного GET, что подтверждено браузером.
- `finance-categories-browser-qa`, `finance-categories-postgres-api-qa`, `finance-categories-ui-contract`, `local-design-contract`, синтаксис и `git diff --check` прошли. Source/dist: portal rev378, CSS rev338. Полный интерактивный обход остальных финансовых отчётов и физический Fold8 остаются открытыми.

## Этап 4/6 · Подэтап 31 — финансовый отчёт, 30.09.2026

- Обнаружено, что после изменения даты или ошибки запроса старые KPI, номер и детализация оставались на экране. Теперь редактирование даты сразу сбрасывает прежний отчёт и отменяет право позднего ответа его восстановить; ожидание, неверная дата и текущая ошибка API показывают отдельные понятные состояния без прежних сумм.
- На 320 px кнопка формирования занимает ширину колонки. Заполненный снимок выявил перенос длинной суммы по цифрам в строке сотрудника; числовое значение теперь остаётся целым, а длинное имя на мобильной ширине располагается над суммой. Снимки `responsive-emulator/finance-report-filled-320.png` и `finance-report-breakdown-320.png` просмотрены.
- Browser QA проверил дату/ошибку/повтор, X→отчёт официанта, задержанный старый GET, заполненные 320/768/1440 px без горизонтального переполнения. `finance-report-date-qa`, `finance-shift-analytics-postgres-qa`, `local-design-contract`, синтаксис и `git diff --check` прошли. Source/dist: portal rev380, CSS rev340. У PostgreSQL сценария обнаружены три старые тестовые площадки, в каждой только по две записи `finance.report_generated`; точные UUID и состав проверены, удалены 6 аудитов и 3 площадки. Cleanup теста дополнен удалением собственных audit events, обязательной проверкой удаления venue и закрытием соединения даже при ошибке; больше не проглатываются ошибки удаления. Повторный прогон оставил 0 площадок с этим именем. Реальный Fold8 и системная клавиатура не проверены.

## Этап 4/6 · Подэтап 32 — очередь доставки, 30.09.2026

- В карточке доставки теперь отображается сохранённый способ оплаты, а выбор статуса имеет доступное имя с гостем. Per-delivery pending guard удерживает выбор статуса заблокированным при фильтрации и перерисовке во время PATCH; повторное событие не посылает второй запрос.
- Форма создания снимает snapshot полей и блокирует их до ответа. Ошибка POST оставляет черновик для повтора; успешный POST при ошибке перечитывания честно сообщает, что доставка создана, но очередь не обновилась, и оставляет кнопку повторной загрузки.
- Новый браузерный сценарий прошёл неверный телефон, задержанный 503 на POST с защитой от дубля, успешный повтор и 503 на GET, reload, пустой фильтр и статусы «Новая → Подтверждена → У курьера → Доставлена → Отменена». Заполненная строка без горизонтального переполнения на 320/768/1440 px; снимок `responsive-emulator/delivery-filled-row-320.png` просмотрен. `delivery-ui-state-qa`, `delivery-persistence-qa` (memory и PostgreSQL), `local-design-contract`, синтаксис и `git diff --check` прошли. QA PostgreSQL оставила 0 площадок `Delivery QA`/`Delivery tenant QA`. Source/dist: portal rev381, CSS rev340. Другие роли и физический Fold8 открыты.

## Этап 4/6 · Подэтап 33 — интеграции, 30.09.2026

- Проверен текущий контракт Telegram: сервер сообщает `planned`, страница честно показывает «В разработке» и не предлагает неработающих действий. Изменение статуса загрузки теперь имеет `role=status` и `aria-live=polite`; карточка использует две занятые колонки вместо резервной третьей.
- Изолированный browser QA проверил реальный ответ текущего `/api/integrations` после входа, затем с подменённым ответом состояния planned/connected/ошибка API, тексты, отсутствие ложных форм/кнопок, двухколоночную карточку и отсутствие переполнения на 320/375/768/1440 px. Снимки `responsive-emulator/integrations-{disabled,error}-320.png` просмотрены.
- `integrations-browser-qa`, `integrations-state-qa`, `integrations-scope-contract`, `local-design-contract`, синтаксис и `git diff --check` прошли. Source/dist: portal rev382, CSS rev341. Реальный Telegram пока не реализован; аппаратный Fold8 не проверен.

## Этап 4/6 · Подэтап 34 — загрузка списка сотрудников, 30.09.2026

- Обнаружен P1 дефект: при ошибке `/api/staff` список и KPI показывали двух вымышленных активных сотрудников. Теперь ошибка очищает список и счётчик, показывает явный повтор. Ответ без массива `items` считается ошибкой, а не пустой базой.
- После успешного POST и неудачного GET интерфейс больше не сообщает, что создание не удалось: фиксирует успех, очищает форму, сообщает о несостоявшемся обновлении списка и предлагает повторить чтение без повторного POST.
- Browser QA на изолированном сервере проверил 503 GET, отсутствие фиктивных карточек, retry, POST 201 → GET 503 → retry, ровно один POST и заполненный экран на 320/375/768/1440 px без горизонтального переполнения. Снимки `responsive-emulator/staff-{load-error,filled}-320.png` просмотрены. `local-design-contract`, синтаксис, `git diff --check` и совпадение source/dist прошли. Source/dist: portal rev383. Code-health review подтвердил оба P1 исправления; открыты гонка параллельных чтений списка, CRUD остальных полей, роли и аппаратный Fold.

## Этап 4/6 · Подэтап 35 — порядок чтений сотрудников, 30.09.2026

- Все локальные GET списка после начальной загрузки, повтора, создания, блокировки, восстановления, архивации и смены аватара проходят через `readStaffList`. Монотонный номер запроса и проверка текущего DOM не позволяют позднему ответу старого GET перерисовать более свежий список или ошибку.
- Четыре мутации отдельно сообщают о сохранённом изменении и сбое последующего GET; ошибка обновления списка больше не называется ошибкой блокировки/восстановления/архивации/аватара. Browser QA удержал старый GET, дождался нового и отпустил старый: новая строка сохранилась. Прежние 503/retry, POST→GET error и заполненная адаптивная матрица 320/375/768/1440 px прошли повторно.
- 
ode --check`, `local-design-contract`, `git diff --check` и совпадение source/dist прошли; portal rev385. Code-health подтвердил отсутствие новой P1 регрессии. Открыт короткий показ старого snapshot при уже летящем GET до начала refresh после успешной мутации; сценарий pre-mutation GET → mutation ещё требует отдельной проверки.

## Этап 4/6 · Подэтап 36 — форма сотрудника и запросы во время изменения, 30.09.2026

- Старые GET списка инвалидируются при начале создания, блокировки, восстановления, архивации и смены аватара. Browser QA удержал GET до POST, отпустил его во время отложенного POST и подтвердил отсутствие старого snapshot; после POST новый список отобразился.
- Drawer создания теперь инертен в закрытом состоянии, Escape закрывает его, Tab остаётся внутри, фокус возвращается кнопке открытия. Во время асинхронного чтения выбранного фото submit заблокирован; ошибку чтения и устаревший callback обработаны, чтобы фото не терялось при быстрой отправке.
- Открытая форма на 320 px не переполняет панель; снимок `responsive-emulator/staff-form-open-320.png` просмотрен. Browser QA, `staff-catalog-load-state-contract`, `local-design-contract`, синтаксис, `git diff --check` и совпадение source/dist прошли. Source/dist: portal rev386. Code-health не нашёл новой P1/P2 регрессии. Остались другие поля/действия персонала, роли, настройки, платформа и физический Fold8.

## Этап 4/6 · Подэтап 37 — реальная карточка сотрудника, 30.09.2026

- Изолированный in-memory браузер прошёл UI→API→повторное чтение: создание сотрудника без CRM-доступа, поиск, изменение рабочих заметок, reload, блокировку, фильтр заблокированных, восстановление. Роль `cleaner` сохранилась. Уточнено по фактическому серверу: `rolePermissions` включает nonCRM роли; первоначальная гипотеза о запрете PATCH для них не подтвердилась.
- Для владельца список ролей карточки теперь включает текущую nonCRM должность, поэтому открытие не выбирает администратора по умолчанию. Добавлены русские подписи nonCRM ролей. Модальное окно имеет доступное имя/роль, начальный фокус, Escape/Tab и возврат фокуса; z-index поднят над липкой шапкой, которая раньше перекрывала кнопку закрытия.
- Заполненная карточка с пятью телефонами проверена на 320 px. Снимок выявил, что широкий селектор номера получал стиль 34px кнопки удаления; CSS ограничен кнопкой удаления, а на 320 px поля номера сложены вертикально. Повторный снимок `responsive-emulator/staff-profile-open-320.png` просмотрен. `staff-profile-browser-qa`, `staff-pin-passport-contract`, `local-design-contract`, синтаксис, `git diff --check`, source/dist прошли. Source/dist: staff-admin-card rev5, CSS rev342. PostgreSQL UI, все роли, остальные поля и аппаратный Fold8 остаются открытыми.

## Этап 4/6 · Подэтап 38 — результат сохранения карточки, 30.09.2026

- `__refreshStaffList` теперь возвращает явный статус `loaded/stale/error`; карточка ждёт результат повторного GET после успешного PATCH. Успешное сохранение подтверждается отдельно от ошибки чтения списка, которая оставляет на экране retry без повторного PATCH. Ошибка самого PATCH сохраняет редактор и поля для повтора.
- Изолированный real-memory browser QA проверил PATCH→GET 503, отложенный GET с фокусом на кнопке карточки, retry GET без нового PATCH, PATCH 503 с повторной отправкой и повторным чтением заметок после reload. `staff-directory-load-browser-qa`, `staff-profile-browser-qa`, `staff-pin-passport-contract`, `local-design-contract`, синтаксис, `git diff --check`, source/dist прошли. Source/dist: portal rev387, staff-admin-card rev7. Остальные роли, PostgreSQL UI и аппаратный Fold8 открыты.

## Этап 4/6 · Подэтап 39 — карточка заведения, 30.09.2026

- Browser QA обнаружил, что в `<select>` часового пояса отображалась буквальная строка `${russianTimezoneOptions()}`: `companyPanel.innerHTML` собран обычной строкой, поэтому интерполяция не выполнялась. Добавлено явное заполнение списка до вставки панели; после GET обновляется и текст кастомного селектора.
- Изолированный memory UI→API→reload подтвердил сохранение названия, города и адреса, 14 вариантов часового пояса и корректное значение в кастомном селекторе. Проверены ширины 320/375/768/1440 px без горизонтального переполнения. Снимок `responsive-emulator/company-filled-320.png` просмотрен; телефонные поля на 320 px перестроены в полные строки, радиокнопка приведена к нормальному размеру.
- `company-settings-browser-qa`, синтаксис и `git diff --check` прошли. Source/dist: portal rev388, CSS rev343. Code-health baseline выявил открытые P1/P2: ошибка GET оставляет редактируемую пустую форму, поздний GET может перезаписать черновик, PATCH не блокирует редактирование, добавление телефона теряет пустые строки. Нужны error/retry и гонки, остальные настройки/платформа, роли и аппаратный Fold8.

## Этап 4/6 · Подэтап 40 — устойчивость формы заведения, 30.09.2026

- `/api/venue` GET теперь держит поля заблокированными до успешного чтения; ошибка показывает явное состояние и кнопку повторной загрузки без возможности отправить пустую карточку. Ответ привязан к экземпляру формы и номеру чтения. Для начального и ошибочного состояния часовой пояс показывает нейтральный placeholder.
- Во время сжатия логотипа и PATCH все поля и кастомные селекторы заблокированы; статус сообщает о сохранении или ошибке, повторная попытка сохраняет введённые значения. Поздний результат PATCH не обновляет уже заменённую форму и шапку. `aria-live` объявляет статус. Добавление телефона сохраняет незаконченные строки, ограничено пятью; удаление основного назначает оставшийся номер основным.
- Browser QA на изолированном memory сервере проверил GET 503→retry, задержанный GET, задержанный PATCH, PATCH 503→retry без потери полей, сохранение после reload и черновик/основной телефон. 320/375/768/1440 px без переполнения; снимок `responsive-emulator/company-load-error-375.png` просмотрен. `local-design-contract`, синтаксис, `git diff --check`, source/dist прошли. Source/dist: portal rev389, CSS rev343. Остались роль/tenant-переход во время сохранения, фактический PostgreSQL UI, другие разделы настроек и платформа, физический Fold8.

## Этап 4/6 · Подэтап 41 — настройки интерфейса и главной, 30.09.2026

- Причина неработающих переключателей: обработчики блоков главной и финансов подключались до создания панели, а обработчики темы/меню терялись при повторной отрисовке hash-раздела. Все четыре группы теперь подключаются после создания панели; поздний GET не перезаписывает локальное действие. PATCH сериализованы, ошибка сохранения видна пользователю. Ожидающий запрос отклоняется, если до отправки сменились токен или пользователь.
- Сервер теперь принимает и валидирует `theme`, структуру 
avigationVisibility` и булевы флаги разделов. Настройки видимости меню учитывают одновременно роль и выбор пользователя, повторно применяются после нормализации боковой панели. Тумблеры без права скрыты; неработающий тумблер скидок убран, старое сохранённое значение игнорируется.
- Изолированный memory browser QA: admin/manager, server PATCH→reload для темы, блоков, финансовых показателей и меню; задержанный GET после локального изменения; PATCH 503 с явным сообщением и повтором; смена сессии при ожидающем PATCH; маршруты `/admin`, `/admin#staff`, `/inventory?view=stock`, `/inventory?view=products` и in-page popstate. 320/375/768/1440 px без переполнения; полный viewport-снимок `responsive-emulator/interface-settings-page-320.png` и состояние ошибки просмотрены. `interface-preferences-browser-qa`, `interface-sidebar-browser-qa`, `interface-preference-session-qa`, `sidebar-navigation-contract`, `local-preferences-contract`, `local-design-contract`, синтаксис, `git diff --check`, source/dist прошли. Source/dist: portal rev391, CSS rev344.
- Открыто: одновременное изменение предпочтений в разных вкладках всё ещё может потерять одно изменение из-за серверного сохранения целого JSON; после PATCH 503 локальное состояние остаётся оптимистичным и серверный GET при reload его откатывает. Остальные настройки/платформа, полный light-theme обход, PostgreSQL UI, аппаратный Fold8 и релизный gate не завершены.

## Этап 4/6 · Подэтап 42 — настройки в нескольких сессиях, 30.09.2026

- Первопричина потери изменений: GET читал снимок сессии, а PATCH сохранял весь JSON из этого снимка. Теперь PostgreSQL GET читает актуальную строку пользователя, PATCH атомарно объединяет верхние поля и отдельные ключи вложенных групп; memory режим разделяет настройки между сессиями одной учётной записи и изолирует разные учётные записи. UI отправляет только изменённый вложенный ключ.
- Изолированный memory QA провёл два входа одной учётной записи, последовательные и одновременные изменения разных полей, чтение из обеих сессий и изоляцию другого сотрудника. Отдельный одноразовый PostgreSQL контейнер со схемой и нужными миграциями подтвердил параллельные PATCH и повторное чтение в двух сессиях. Тест восстановил исходные настройки пользователя, удалил тестовые сессии; контейнер остановлен.
- `interface-preferences-browser-qa`, `interface-sidebar-browser-qa`, `interface-preference-session-qa` снова прошли. Настройки проверены на 320/375/768/1440 px; синтаксис и `git diff --check` прошли. Code-health и архитектор не нашли регрессии в этой цепочке. Source/dist: portal rev392, CSS rev344.
- Открыто: состояние после PATCH 503 остаётся оптимистичным; при PostgreSQL настроенные demo-пароли могут привязать демонстрационный вход к первому пользователю площадки (старый риск, нужен отдельный security проход). Остальные настройки/платформа, полный light-theme обход, аппаратный Fold8 и релизный gate не завершены.

## Этап 4/6 · Подэтап 43 — авторизация с PostgreSQL, 30.09.2026

- Security и code-health подтвердили риск: при подключённой БД сервер сначала принимал демонстрационный пароль, затем подставлял ID первого пользователя площадки; сохранённая сессия получала чужую личность. Теперь режим с `DATABASE_URL` принимает только существующего активного пользователя БД и его пароль, без демонстрационного или локального fallback. Для старой несовместимой схемы вход сообщает 503 до штатной миграции.
- Ошибка записи сессии больше не возвращает ложный 200 и токен: сервер отвечает 503 до выдачи cookie. Удалён резервный путь проверки другого типа учётных данных вместо пароля БД. Режим без БД сохранён для локального demo QA. Миграция не требуется; актуальная схема уже содержит нужные поля.
- Одноразовая PostgreSQL QA база проверила отклонение демонстрационного входа, точные ID/роль реального пользователя, отказ для учётной записи без пароля, отказ при искусственной ошибке INSERT сессии без cookie, параллельные настройки и повторное чтение. Fixture, сессии и триггер очищены (`{}:0:0:0`), контейнер остановлен. `security-default-credential-qa`, `session-preferences-concurrency-qa`, `login-error-runtime-qa`, `session-authority-qa`, `local-login-contract`, `portal-api-auth-qa`, `local-deploy-contract`, синтаксис и `git diff --check` прошли. Итоговые code-health/security проверки не нашли блокирующей регрессии.
- Осталось: полный интерактивный обход настроек и остальных страниц, оптимистичное состояние после PATCH 503, аппаратный Fold8 и общий релизный gate.

## Этап 4/6 · Подэтап 44 — ошибки сохранения настроек, 30.09.2026

- Причина расхождения: тема, блоки главной, финансовые показатели и меню меняли экран и `localStorage` до PATCH, а при 503 оставались в новом значении. Теперь ошибочный ключ перечитывается с авторитетного GET и возвращается в UI/кэш; при недоступном GET используется последнее подтверждённое значение с явным сообщением о невозможности проверки. Поздний ответ старой сессии или устаревшего изменения того же ключа не заменяет текущий выбор.
- Начальный GET также проверяет идентичность сессии; при сбое сообщает, что показанные значения взяты из локального кэша. Статическое демо теперь объединяет вложенные группы настроек по ключам, как сервер. Права меню продолжают ограничивать скрытие/показ ссылки независимо от пользовательского выбора.
- Browser QA проверил 503 для всех четырёх групп, восстановление UI/кэша/серверного значения, очередь «успех → ошибка», двойной 503 PATCH+GET, ошибку начального GET с восстановлением после reload, смену сессии и соседние маршруты меню. 320/375/768/1440 px без общего переполнения; снимки ошибки и восстановленного экрана на 320 px просмотрены. `local-design-contract`, `local-preferences-contract`, `sidebar-navigation-contract`, синтаксис, `git diff --check`, source/dist прошли. Code-health и архитектор не нашли блокирующего расхождения. Source/dist: portal rev394, CSS rev344.
- Открыто: при полном отсутствии связи до первого успешного GET локальный кэш остаётся предварительным (интерфейс явно предупреждает); остальные настройки/платформа, аппаратный Fold8 и финальный quality gate ещё не завершены.

## Этап 4/6 · Подэтап 45 — карточка компании и границы точки, 30.09.2026

- Причина риска: PostgreSQL GET мог скрыть сбой глобальной карточкой, а PATCH менял глобальное состояние до SQL без ограничения организации. Теперь GET читает только активную точку текущей организации; отсутствие или сбой дают 404/503. PATCH требует ID точки, блокирует строку точки и текущую сессию, сверяет выбранную точку, сохраняет поля и VIP-минимумы одной транзакцией. Старый ответ формы не обновляет другую сессию или переключённую точку.
- Локальный и статический demo режимы тоже требуют ID загруженной точки. Browser QA проверил загрузку, ошибку/повтор, stale форму после переключения точки и ширины 320/375/768/1440 px. Одноразовая PostgreSQL QA база проверила изоляцию двух точек и организаций, сохранение VIP, транзакционный rollback, архивную точку и гонку одновременного выбора точки и сохранения; fixture очищен (`0:0:0`), контейнер остановлен.
- `venue-timezone-validation-runtime-qa`, `company-settings-browser-qa`, `company-venue-postgres-qa`, `local-design-contract`, синтаксис и `git diff --check` прошли. Code-health и архитектор проверили исходное состояние и diff; найденная code-health гонка закрыта и проверена. Source/dist: portal rev396, CSS rev344. Открыты аппаратный Fold8, остальные разделы настроек и общий релизный gate.

## Этап 4/6 · Подэтап 46 — загрузка залов и визуальные состояния, 30.09.2026

- PostgreSQL чтение `/api/floor` больше не подменяет ошибку БД общим локальным залом: ответ 503. При подключённой БД отсутствие пула даёт 503 для floor API, а не-UUID ID зоны/стола дают 404 без перехода к memory данным.
- Ошибка загрузки залов теперь сбрасывает старый список, блокирует добавление столов и даёт кнопку повтора. Исправлен селектор отступов списка залов и цвета карточек/инструкции в светлой теме.
- Одноразовая PostgreSQL QA база проверила реальную ошибку SELECT, отказ от memory fallback и неверные ID; тестовые строки очищены (`0:0:0`), контейнер остановлен. Browser QA проверил 503→retry, карточку в светлой теме и ширины 320/375/768/1440 px; `local-floor-management-contract`, `local-design-contract`, синтаксис, `git diff --check` и source/dist прошли. Code-health проверил baseline и итоговый diff без новой блокирующей регрессии. Source/dist: portal rev397, CSS rev345.
- Открыто как следующий P1: формы зала/стола ещё не защищены от переключения точки в другой вкладке перед POST; memory режим хранит общий зал для нескольких точек. Аппаратный Fold8 и остальные разделы остаются открыты.

## Этап 4/6 · Подэтап 47 — граница точки для залов и столов, 30.09.2026

- `/api/floor` возвращает ID текущей активной точки и ограничивает PostgreSQL чтение организацией. Все шесть операций создания/изменения/удаления зон и столов требуют `expectedVenueId`. PostgreSQL транзакция блокирует строку точки, затем текущую сессию и сверяет выбор перед записью; 428 — отсутствующий ID, 409 — смена точки. Порядок блокировок совпадает с сетевым переключателем. Memory и статическое demo хранят схемы раздельно по точкам.
- Формы залов/столов, модальные действия и редактор схемы отправляют ID загруженной точки. Устаревшая форма показывает ошибку и блокирует повторную отправку; редактор при неудачном сохранении координат возвращает объект на прежнее место. Статическое demo валидирует изменения стола до мутации.
- Одноразовая PostgreSQL QA база проверила A/B и чужую организацию, stale POST/DELETE, гонку одновременного выбора точки и создания зала, полный CRUD зоны/стола, no-fallback при ошибке БД; fixture очищен (`0:0:0`), контейнер остановлен. Browser QA под реальной PostgreSQL сессией подтвердил stale форму зала. Memory и static demo browser QA подтвердили изоляцию A/B, ошибку/повтор и 320/375/768/1440 px. `local-floor-management-contract`, `local-crud-contract`, `order-journal-table-memory-qa`, `local-design-contract`, синтаксис и `git diff --check` прошли. Source/dist: portal rev399, CSS rev345.
- Открыто: другие действия схемы и POS требуют дальнейшего интерактивного обхода; аппаратный Fold8 и общий релизный gate не завершены.

## Этап 4/6 · Подэтап 48 — редактор схемы зала, 30.09.2026

- Устранены лишний PATCH после обычного нажатия на стол и зависший drag после отмены указателя или потери захвата. Перетаскивание начинает менять координаты после порога движения; пустая часть схемы больше не блокирует сенсорную прокрутку страницы.
- Сохранение названия и формы без изменения вместимости не сбрасывает диапазон min/max. Повторная отправка формы и кнопки блокировки ограничена на время запроса; устаревшая точка в редакторе показывает сообщение и обновляет схему. Для светлой темы добавлены цвета карточек, полей, схемы и объектов.
- `venue-layout-browser-qa` на локальном API прошёл клик без PATCH, реальное перемещение с повторным чтением координат, сохранение имени с диапазоном 2–6, блокировку/разблокировку, ширины 320/375/768/1440 px и светлую тему. `visual-page-rules-contract`, `local-design-contract`, синтаксис и `git diff --check` прошли; отдельный `local-floor-management-contract` требует уже запущенный сервер и не использовался как доказательство этого прогона. Source/dist: portal rev400, CSS rev346.
- Открыто: аппаратный Fold8, полное сенсорное поведение с экранной клавиатурой, остальные действия схемы/POS и общий релизный gate.

## Этап 4/6 · Подэтап 49 — состояние редактора схемы, 30.09.2026

- Повторное чтение схемы после изменения стола сохраняет несохранённые поля и раскрытое состояние других карточек в той же точке. После drag координаты формы синхронизируются с сохранёнными координатами. Операции одного стола блокируются до завершения API; позднее чтение не перерисовывает более новую схему.
- Ошибка чтения после успешного PATCH больше не называется ошибкой сохранения: редактор показывает, что запись прошла, блокирует новые действия со старой схемой и предлагает повторную загрузку. При ошибке начальной загрузки счётчик и сообщение переходят в состояние ошибки с кнопкой повтора. Устаревший контекст точки загружает актуальную схему.
- Browser QA создал два стола и прошёл сохранение после drag, сохранность черновика соседней карточки при блокировке, PATCH success → GET 503 → retry для формы и статуса, начальную ошибку/повтор и stale действие после смены точки. Отдельная гонка двух блокировок с задержанным GET 503 подтвердила, что поздняя ошибка уже заменённого чтения не помечает новую схему как устаревшую. Повторно проверены 320/375/768/1440 px, светлая тема и серверные данные. Source/dist: portal rev402, CSS rev347. Физический Fold8, POS и общий релизный gate ещё открыты.

## Этап 4/6 · Подэтап 50 — зоны и состояния рабочей схемы POS, 30.09.2026

- POS строит вкладки залов по ID и названиям ответа `/api/floor`, поэтому пользовательские зоны доступны сотруднику. Выбор вкладки сохраняется при обновлении схемы той же точки; `aria-selected` соответствует видимому выбору. Исходная HTML-разметка не показывает фиктивные вкладки до загрузки.
- При ошибке начального или повторного GET схема убирает старые столы и очередь, сбрасывает выбранный заказ и показывает повтор загрузки. Пока схема обновляется или недоступна, панель действий заказа неактивна. Последний запрос владеет отрисовкой; старый ответ не скрывает актуальную схему. Заказы читаются после успешной схемы и защищены от запоздалого ответа другого контекста. При возвращении фокуса на вкладку перечитывается текущая точка. Статическая demo схема берётся из `floorByVenue` выбранной точки.
- Browser QA прошёл ошибку/повтор после заполненной схемы, блокировку действий заказа на время загрузки и ошибки, произвольную зону «Крыша QA», выбор стола и диапазон гостей, блокировку с обновлением POS, смену точки A→B, задержанный старый GET 503 и demo изоляцию. На 320/375/768/1440 px пользовательский стол виден без общего переполнения. `visual-page-rules-contract`, `local-design-contract`, синтаксис и `git diff --check` прошли. Source/dist: app rev147, CSS rev348.
- Открыты точное соответствие геометрии редактора и POS, аппаратный Fold8, роли POS и общий релизный gate.

## Этап 4/6 · Подэтап 51 — геометрия схемы редактора и POS, 30.09.2026

- Новые координаты редактора сохраняются с явной единицей `px`; старые записи с `unit:grid` или `w/h` читаются через совместимое преобразование. Сервер отвергает неизвестную единицу. POS на широкой схеме масштабирует координаты, размеры, форму и поворот вместе; до 900 px показывает доступный список столов без потери выбора и статуса.
- Редактор показывает на полотне только выбранную зону. Вкладки зон исключают наложение столов разных залов, при переключении сохраняются черновики форм. Добавлена форма `freeform` для существующих записей и подсказка о прокрутке полотна на узком экране.
- Browser QA на 320/375/768/1440 px прошёл геометрию в редакторе и POS, старую grid запись, переключение зон, светлую тему, ошибки и повтор, смену точки. `fold-responsive-contract` (31), `visual-page-rules-contract`, `local-design-contract`, синтаксис и `git diff --check` прошли. Source/dist: app rev148, portal rev404, CSS rev350.
- Открыты физический Fold8 с сенсорным вводом, прочие роли и разделы POS, общий релизный gate.

## Этап 4/6 · Подэтап 52 — передача заказа на существующий стол, 30.09.2026

- Исправлена первопричина сбоя в PostgreSQL: POS предлагал номер стола и отправлял `table-N`, хотя сервер ожидает реальный ID стола. Диалог теперь предлагает столы текущей схемы по точным ID, исключает исходный, заблокированные и занятые другим активным заказом; после смены заказа или точки старый выбор не отправляется. Для конфликта и исчезнувшего стола показаны конкретные сообщения.
- Memory API теперь также отвергает передачу закрытого заказа и передачу на отсутствующий или заблокированный стол, как PostgreSQL. Ответ запоздалого POST больше не перерисовывает другой выбранный заказ. Browser QA через реальный memory API создал заказ с позицией, передал его из POS на второй стол, проверил POST, повторное чтение API, освобождение исходного стола, занятость целевого и открытие нового стола после reload; отсутствующий и заблокированный стол отвергнуты. Матрица 320/375/768/1440 px, синтаксис, `local-design-contract`, `fold-responsive-contract` и `git diff --check` прошли. Source/dist: app rev149.
- На этом подэтапе открыты PostgreSQL browser-подтверждение передачи, сценарий кассира с частичной оплатой и финальным закрытием, роли POS, физический Fold8 и общий релизный gate.

## Этап 4/6 · Подэтап 53 — передача заказа в PostgreSQL, 30.09.2026

- Добавлен изолированный `scripts/pos-transfer-postgres-browser-qa.mjs`: проверка loopback QA БД и контейнера до записи, собственная точка с четырьмя столами и заказом, вход тестовым пользователем, передача из POS на точный UUID, чтение сохранённого заказа и статусов столов из PostgreSQL, повторное открытие после reload. Занятый, заблокированный и отсутствующий UUID сервер отклонил; недоступные столы не появились в диалоге.
- Скрипт прошёл на локальном одноразовом `crm-audit-pg`; собственная точка и дочерние записи удалены, независимый запрос нашёл 0 тестовых точек. 
ode --check` прошёл. В Chromium при переходе через login/reload встречается внутреннее сообщение о выключенном ViewTransition; скрипт исключает только эту точную ошибку из списка ошибок приложения.
- PostgreSQL подтверждение передачи закрыто. Открыты оплата по ролям, дополнительные состояния POS, физический Fold8 и общий релизный gate.

## Этап 4/6 · Подэтап 54 — оплата POS по ролям в PostgreSQL, 30.09.2026

- Добавлен `scripts/pos-role-payment-postgres-browser-qa.mjs` для изолированной организации и точки в локальной QA PostgreSQL. Бармен вошёл в POS, внёс 200 ₽ наличными из 500 ₽, обновил страницу, увидел остаток 300 ₽ и предыдущую оплату, получил отказ формы на 301 ₽ и закрыл заказ оплатой 300 ₽ по карте. Проверены два сохранённых платежа, привязка к смене, закрытый заказ, свободный стол и повторное чтение после reload.
- Управляющий до закрытия увидел 0 ₽ выручки закрытых чеков и 300 ₽ ожидаемого остатка. После закрытия `/api/finance/summary` показал 500 ₽, один чек, два платежа и разбиение cash/card 200/300; браузерная страница `/finance/report` показала те же суммы. Ответ бармену `/api/finance/summary` ограничен полями `date`, `employeeView`, `revenue`.
- Скрипт прошёл с реальным PostgreSQL и Chromium; синтаксис и `git diff --check` прошли. Собственная организация и точка очищены, независимый запрос вернул 0/0. Открыты другие роли/ошибки POS, физический Fold8 и общий релизный gate.
## Этап 4/6 · Подэтап 55 — заполненный POS на разных разрешениях, 30.09.2026

- Chromium с реальной PostgreSQL точкой, пятью столами и заказом на 500 ₽ проверен на ширинах 320, 375, 673, 902, 1100, 1101, 1200, 1201, 1440, 1920 и 2560 px. Снимки сохранены в локальных `qa-artifacts/pos-stage55/`.
- Исправлена схема зала на промежуточных ширинах: до 1200 px заказ размещается ниже схемы, до 1100 px столы показаны карточками; координаты широкой схемы масштабируются в доступную ширину панели. Вкладки зала не сжимаются по высоте заполненным заказом, их высота не меньше 44 px.
- Browser QA подтвердил отсутствие общего горизонтального переполнения, доступность крайнего правого стола в схеме, видимость вкладок, прокрутку заказа и формы оплаты на телефоне. Сценарий частичной оплаты и отчёта управляющего прошёл. `fold-responsive-contract` 32 инварианта, `visual-page-rules-contract`, `local-design-contract` и синтаксис прошли; QA записи удалены, независимый запрос вернул 0/0. Source/dist: app rev150, CSS rev353.
- Физический Fold8, экранная клавиатура на нём, прочие роли и общий релизный gate остаются открытыми.
## Этап 4/6 · Подэтап 56 — читаемость столов POS на ноутбуке, 30.09.2026

- Снимки заполненного POS показали новый P1: на 1201–1440 px схема умещалась в колонке, но названия, статусы и вместимость столов визуально обрезались. Одноколоночная компоновка расширена до 1850 px; при 1851 px карта уже имеет достаточную ширину для всех трёх строк. Список карточек до 1100 px сохранён.
- PostgreSQL/Chromium сценарий проверил 13 ширин от 320 до 2560 px, включая границу 1850/1851; проверяет геометрию всех строк каждого стола, доступность правого стола, вкладки, заказ, оплату и отчёт. Контракт адаптивности, синтаксис и визуальный осмотр снимков прошли. Source/dist: CSS rev355.
- Отдельный непроверенный крайний случай: маленький стол у границы или повёрнутый стол может выходить за полотно из-за минимального размера кнопки 44 px и расчёта сцены по неповёрнутым координатам. Нужны воспроизведение и исправление в следующем проходе.
## Этап 4/6 · Подэтап 57 — края и повороты схемы POS, 30.09.2026

- Подтверждён P1: расчёт сцены по неповёрнутым размерам мог обрезать стол у левого/верхнего края; физический минимум кнопки 44 px при малых объектах скрывал подписи. `renderZone` теперь рассчитывает границы повёрнутых прямоугольников, сдвигает начало координат и оставляет визуальный отступ вокруг схемы. Исходные координаты API и редактора не меняются.
- POS переключается на читаемые карточки, когда физический размер кнопки не вмещает три строки. Карточки сохраняют имя, статус, вместимость и действие; поворот и форма отображаются на достаточно широкой схеме. Длинное имя на карте может сокращаться многоточием; полный текст доступен в `title` и `aria-label`.
- PostgreSQL/Chromium QA прошёл 13 ширин, четыре повёрнутых стола у краёв, проверку их границ и нажатия в центре, а также три объекта 40×40 px с карточками на 1201/1920 px. Часть оплаты и отчёт управляющего прошли, QA строки очищены. `venue-layout-browser-qa` подтвердил сохранение координат редактора после сдвига сцены. `fold-responsive-contract` 33 инварианта. Source/dist: app rev158, CSS rev359.
- На реальном Fold8, особенно при касании и экранной клавиатуре, проверка ещё не выполнена; общий релизный gate открыт.
## Этап 4/6 · Подэтап 58 — разделение заказа и контекст скидки POS, 30.09.2026

- Исправлен P1: диалог разделения и заявка на скидку фиксируют ID выбранного заказа и точку до ожидания ввода/дополнительных данных. После смены заказа или точки действие не отправляется. Успешное разделение обновляет только исходный заказ, даже если выбор изменился после POST.
- UI не принимает смесь корректных и ошибочных номеров позиций, повторы и перенос всех строк. PostgreSQL, memory и статическое demo отклоняют неполный/повторный набор ID целиком; неверный UUID получает 400 до SQL. Исходный заказ сохраняет минимум одну позицию; уже полученная оплата проверяется до этого ограничения. Новый заказ в PostgreSQL и memory наследует гостя и заметку исходного заказа.
- Изолированный PostgreSQL browser QA под ролью бармена проверил ошибки 400/409 без записи, некорректный ввод в форме, смену стола во время диалога, успешное разделение двух позиций, наличие гостя/заметки после reload и отсутствие заявки на скидку при смене стола. Ранее проверенные частичная оплата и отчёт управляющего прошли. `paid-order-balance-memory-qa` и PostgreSQL подтвердили финансовый guard/rollback; тестовые данные очищены. Source/dist: app rev161.
- Открыты прочие действия POS, другие роли, физический Fold8 и общий quality gate.

## Этап 4/6 · Подэтап 59 — заявка и согласование скидки, 30.09.2026

- PostgreSQL создание заявки сериализовано блокировкой заказа в транзакции. Одновременные запросы к одному заказу дают ровно одну ожидающую заявку (201/409); закрытый заказ отклоняется. В memory API автор заявки и решения берётся из текущей сессии, а не из тела запроса.
- Изолированный PostgreSQL/Chromium сценарий прошёл путь бармена (заявка 10% с причиной) → управляющего (просмотр без права согласования, API 403) → администратора (согласование через финансы). После решения сумма к оплате уменьшилась с 500 до 450 ₽ в API и POS после reload. У управляющего ожидаемая выручка составила 950 ₽ по двум открытым заказам.
- Browser QA повторно проверил оплату, разделение, роли, конкурентные заявки и очистку данных. Финансовые взаимодействия прошли семь ширин, ограничения ролей — три ширины; синтаксис и `git diff --check` прошли. Тестовые организация и точка после проверки отсутствуют (0/0). Source/dist: app rev162.
- Открыты оставшиеся состояния POS, аппаратный Fold8, остальные разделы и общий релизный gate.

## Этап 4/6 · Подэтап 60 — безопасный вывод данных в диалогах POS, 30.09.2026

- Найдена сохранённая HTML-инъекция: имя/контакт гостя из `/api/clients`, название программы скидки и сохранённый комментарий попадали в `innerHTML` формы без полного экранирования. `requestStaffAction` теперь экранирует подписи, значения, placeholder, текст вариантов и textarea перед вставкой.
- Изолированный PostgreSQL/Chromium QA создал гостя с HTML-подобным именем, открыл форму привязки и подтвердил: в DOM не появился элемент `img`, полный текст остался видимым в варианте списка. Проверка названия стола с `&` в переносе выявила и устранила двойное экранирование. Основной путь оплаты, разделения, согласования скидки, ролей и конкурентных заявок также прошёл; тестовые данные очищены. `local-design-contract`, `fold-responsive-contract` и `git diff --check` прошли. Source/dist: app rev163.
- Отдельно выявлен риск смены выбранного заказа во время асинхронного сохранения гостя/заметки, статуса и закрытия. Этот сквозной путь остаётся открытым для следующего исправления вместе с аудитом других HTML-вставок.

## Этап 4/6 · Подэтап 61 — контекст гостя и заметки POS, 30.09.2026

- Найдена первопричина: на «Гости» и «Заметки» одновременно висели индивидуальный и общий обработчики. Один клик запускал два сценария формы; общий читал изменяемый `currentOrder` после ожидания и предлагал поле количества гостей, которого нет в PATCH-контракте и БД. Дублирующий обработчик удалён; оставлены единые формы с поддерживаемыми сервером полями.
- Форма гостя фиксирует ID заказа и точку до GET клиентов, проверяет их перед открытием диалога и PATCH. Заметка фиксирует тот же контекст перед формой. Оба действия применяют ответ к исходному объекту по ID и перерисовывают панель только при прежнем выборе.
- PostgreSQL/Chromium QA с двумя активными заказами подтвердил: смена выбранного заказа во время формы гостя или заметки не отправляет запись; оба заказа в БД сохраняют исходные значения. При неизменном выборе один PATCH успешно сохраняет гостя и заметку исходному заказу; после reload значения на месте, другой заказ не затронут. Основной POS сценарий и `staff-partial-payment-pending-qa` прошли. Source/dist: app rev164.
- Запоздавшие ответы статуса, закрытия и других действий заказа, серверная гонка PATCH с финализацией, физический Fold8 и общий релизный gate остаются открытыми.

## Этап 4/6 · Подэтап 62 — статус и закрытие заказа при смене выбора, 30.09.2026

- Кнопки передачи на бар/кальянщику фиксируют ID заказа и точку до POST. Ответ меняет только исходный заказ и его карточку в очереди; выбранный позднее заказ не получает чужой статус. Закрытие фиксирует тот же контекст до диалога, отвергает сохранение после смены выбора и не очищает панель другого заказа при запоздавшем ответе. Состояние кнопки закрытия восстанавливается по фактически выбранному заказу.
- PostgreSQL/Chromium QA с двумя заказами задержал ответ статуса и закрытия после фактической записи в БД, переключил выбор и подтвердил сохранение статуса только исходному заказу, отсутствие изменения второго в БД и памяти POS. Закрытие из устаревшего диалога не отправилось; обычное закрытие сохранилось после reload и не сбросило выбор второго заказа. Сквозной сценарий оплаты, разделения, скидки и ролей также прошёл. Source/dist: app rev165.
- Удаление и изменение позиций имеют аналогичный риск при запоздавшем ответе и остаются открытыми; также открыты серверная гонка PATCH с финализацией, физический Fold8 и общий gate.

## Этап 4/6 · Подэтап 63 — изменение позиций и удаление заказа при смене выбора, 30.09.2026

- Изменение/удаление позиции фиксирует ID исходного заказа и позиции до API. Запоздавший ответ обновляет исходный заказ по ID, в том числе после замены объекта очереди повторным чтением; панель другого выбранного заказа не меняется. Запросы к одной позиции сериализованы в UI. Окно удаления фиксирует заказ и точку до ввода причины, отвергает действие после смены выбора и не сбрасывает чужую карточку после ответа.
- PostgreSQL и memory API теперь одинаково принимают в PATCH количества позиций только целые 1–999. Изолированный PostgreSQL/Chromium QA с двумя заказами подтвердил 400 для 1,5/1000, задержанные PATCH и DELETE позиции при переключении выбора, отсутствие изменений второго заказа, возврат исходного количества, отказ устаревшего окна удаления и успешную отмену с причиной. БД и GET после reload подтвердили состояние; весь предыдущий путь оплаты, разделения, скидки и закрытия прошёл. Memory QA подтвердил новые границы количества и сохранение финансового rollback. Source/dist: app rev166.
- Серверная гонка PATCH гостя/заметки с финализацией, прочие состояния POS, физический Fold8 и общий gate остаются открытыми.

## Этап 4/6 · Подэтап 64 — атомарное сохранение гостя и заметки, 30.09.2026

- В PostgreSQL PATCH заказа раньше отдельно читал статус и выполнял создание гостя, привязку и заметку через независимые соединения. Закрытие могло пройти между проверкой и записью, а ошибка оставляла частичные изменения. Теперь один клиент ведёт транзакцию с `SELECT ... FOR UPDATE`, проверкой активного статуса, всеми записями, повторным чтением и `COMMIT`; ранние отказы и ошибки откатываются. Аудит пишется после commit. Memory API сначала проверяет существование гостя, затем меняет заметку и связь.
- PostgreSQL browser QA проверил отказ для несуществующего гостя без изменения заметки, успешную совместную запись гостя/заметки и конкуренцию PATCH с закрытием заказа. Отдельная QA транзакция удерживала строку; проверка `pg_stat_activity` подтвердила два ожидающих блокировку запроса. После освобождения оба допустимых порядка дают закрытый заказ: при PATCH 200 новые данные сохранены до закрытия, при PATCH 409 прежние данные и отсутствие нового гостя сохранены. Memory QA подтвердил отсутствие частичного изменения после 404.
- Основной POS browser QA и проверка финансового rollback прошли; тестовые данные очищены. Открыты аудит прочих HTML-вставок, физический Fold8 и общий quality gate.

## Этап 4/6 · Подэтап 65 — безопасный вывод названия товара в POS, 30.09.2026

- Аудит всех `innerHTML` в `app.js` нашёл необработанное название товара в строке заказа. Каталог, очередь, карта залов и печатный чек уже экранировали данные. Строка заказа теперь экранирует название и ID позиции, количество выводит как число; сохранённый текст больше не создаёт вложенные элементы.
- Изолированный PostgreSQL/Chromium QA создал товар с HTML-подобным именем, открыл заказ после reload и подтвердил отсутствие `img` в строке и видимый текст с угловыми скобками. Сценарии оплаты, разделения, ролей, скидки, закрытия и конкурентного PATCH прошли. `orders-receipt-qa` повторно подтвердил экранирование печатного чека; синтаксис, `local-design-contract` и `git diff --check` прошли. Source/dist: app rev167; тестовые данные очищены.
- Отдельная роль code health была недоступна из-за лимита сервиса; координатор сверил контексты всех HTML-вставок в `app.js`, текущий diff и результаты проверок. Остальные страницы, физический Fold8 и общий quality gate открыты.

## Этап 4/6 · Подэтап 66 — заполненная главная и показатели смены, 30.09.2026

- Матрица приёмки обновлена по фактическому PostgreSQL покрытию POS; прежняя верхняя строка ошибочно называла его ещё не проверенным. Следующий проход взял главную страницу с синтетической оплатой в изолированном memory runtime.
- Новый `scripts/dashboard-filled-browser-qa.mjs` прошёл UI→API: закрытый заказ на 200 ₽ дал 200 ₽ оплачено, один закрытый заказ и один платёж. Проверены дата без смен, кнопка выбора даты и фокус, ответ 503/блокировка старого выбора/повтор, четыре быстрых перехода и Enter на карточке KPI. Заполненные карточки не переполняют страницу на 320/375/673/902/1024/1440/1920 px; снимки телефона и ПК в `qa-artifacts/dashboard-stage66/`. Визуальный осмотр показал читаемые карточки и быстрые действия на 320 px.
- Скрипт поднимает собственный временный сервер без PostgreSQL и завершает его. Полный обход остальных KPI/графиков и состояний ошибок, несколько смен, роли и реальный Fold8 остаются открытыми. Отдельная роль code health сейчас недоступна из-за лимита сервиса; координатор проверил сценарий, синтаксис и отсутствие изменений production-данных.
- Дополнительный проход отключил блок смены через переключатель настроек, подтвердил сохранение после reload, затем проверил прямую ссылку `#shift-control`: панель видна. После этого переключатель включён обратно. Контрактный тест приведён к фактическому многострочному обработчику. Для насыщенного браузерного QA установлен повышенный лимит запросов только у временного тестового сервера: прежний лимит 60/мин приводил к 429 и откату переключателя, не к дефекту отображения. Контракт и браузерный сценарий прошли повторно.

## Этап 4/6 · Подэтап 67 — крупные значения KPI, 30.09.2026

- Браузерная проверка с суммой `1 286 459,73 ₽` выявила перекрытие выручки и «К оплате» при ширине 420 px и 2560 px: карточка делилась на две колонки при недостаточной ширине для полного текста. Обычная проверка горизонтального scroll этого не обнаруживала.
- Карточка выручки теперь располагает основную сумму и долг вертикально с разделителем на всех ширинах. Прочие значения KPI могут переноситься в узкой карточке; размер основной суммы подстраивается, сохраняя сумму и ₽ на одной строке. Синтетические значения `99 999,99 ₽`, `1 000 000`, `99 999` и `−1 286 459,73` проверены по текстовым границам и пересечениям на одиннадцати ширинах 280–3440 px. Браузерный путь UI→API, пустое/ошибочное состояние, переключатель модуля, переходы и клавиатура прошли после правки. Визуально просмотрены снимки 420, 902, 1440 и 2560 px; значения читаются без наложений.
- `sync-published-assets` обновил source/dist. `dashboard-kpi-design-contract`, `local-design-contract`, `fold-responsive-contract` и `git diff --check` прошли. Остальные KPI/графики, роли, аппаратный Fold8 и общий gate открыты.

## Этап 4/6 · Подэтап 68 — достоверность оперативных финансов на главной, 30.09.2026

- При 503 от `/api/finance/summary` карточка показывала ложные `0 ₽`; браузерный тест воспроизвёл дефект. Начальное состояние и ошибка теперь показывают `—`, текст ошибки и действие повтора на самой карточке. Повтор кликом возвращает значения и обычный переход в финансы. Ответ старого экземпляра главной не записывается в новый DOM; это проверено задержкой первого ответа и последующей перерисовкой.
- Подпись выручки уточнена: оплаты по заказам, закрытым сегодня. Счётчик рядом с долгом описывает открытые заказы, поскольку API считает все открытые, включая полностью оплаченные. Ответ с `employeeView` без полей долга показывает `—` и «Доступно руководителю», не выдумывает нулевой долг. Проверены 503, повтор, ограниченный ответ и запоздавший ответ в Chromium; `role-api-matrix-runtime-qa`, `portal-context-refresh-qa`, `finance-api-consistency-contract` и дизайн-контракт прошли.
- Повторный визуальный осмотр обнаружил одинокий знак ₽ при крупной сумме на 1440 px; размер суммы теперь подстраивается под ширину. Одинарная строка, границы карточки и отсутствие перекрытия проверены на 11 ширинах. Открытый смежный дефект: PostgreSQL `/api/metrics.pendingRevenue` не ограничивает остаток каждого заказа нулём, в отличие от `/api/finance/summary` и memory API; нужен отдельный расчётный регрессионный сценарий. Физический Fold8 и общий gate открыты.

## Этап 4/6 · Подэтап 69 — остаток к оплате в оперативных метриках, 30.09.2026

- Изолированный PostgreSQL сценарий с двумя открытыми заказами (переплата 50 ₽ по одному, долг 80 ₽ по другому) воспроизвёл расхождение: `/api/finance/summary.pendingRevenue` = 80 ₽, `/api/metrics.pendingRevenue` = 30 ₽. API оплаты не допускает новую переплату; фикстура моделирует старые или импортированные данные прямой записью только в QA БД.
- SQL `/api/metrics` теперь ограничивает остаток нулём для каждого открытого заказа до суммирования, как финансовая сводка и memory API. Повторный PostgreSQL QA получил 80 ₽ в обоих API; добавленный третий заказ с одобренной скидкой и переплатой не уменьшил чужой долг. Изолированная фикстура очищена. `finance-api-consistency-contract`, `role-api-matrix-runtime-qa`, полный `pos-role-payment-postgres-browser-qa`, синтаксис прошли. Миграций и изменения формы ответа нет.
- Остальные разделы, аппаратный Fold8 и итоговый quality gate остаются открытыми.

## Этап 4/6 · Подэтап 70 — несколько смен и выбор периода на главной, 30.09.2026

- Browser QA закрыл первую смену с платежом 200 ₽, открыл вторую без оплат и проверил три состояния: все смены = 200 ₽, первая = 200 ₽, вторая = 0 ₽. При выборе конкретной смены memory API прежде возвращал только её в списке и блокировал переключатель. Кроме того, UUID-проверка отвергала собственные memory ID вида `shift-…`, поэтому UI показывал ошибку. Memory API теперь валидирует выбранный ID по сменам текущего дня и сохраняет полный список смен, а PostgreSQL продолжает принимать только UUID и проверяет точку/дату.
- Для единственной смены без явного `shiftId` селектор теперь остаётся на «Все смены · 1», как и день в запросе, без ложной подписи выбранной смены. В браузере проверены неизвестный ID (404), смена даты при задержанном ответе по старой смене, пустой день, ошибка 503 и повтор. Снимок заполненного блока на 375 px просмотрен; KPI читаемы и переключатель доступен.
- `shift-cash-postgres-e2e-qa`, `finance-shift-analytics-postgres-qa`, `role-api-matrix-runtime-qa`, `local-insights-contract`, `dashboard-kpi-design-contract`, синтаксис, source/dist и diff прошли. Отдельно открыт сценарий ночной смены: API группирует смены по дате открытия, поэтому платежи после полуночи могут не появиться в показателях «сегодня» для сотрудника. Его семантику и UI нужно проверить до общего gate. Физический Fold8 также открыт.

## Этап 4/6 · Подэтап 71 — сотрудник после полуночи, 30.09.2026

- Изолированный PostgreSQL сценарий воспроизвёл дефект: смена открыта вчера в 23:00, собственный платёж 60 ₽ и закрытие заказа сегодня, но сотрудник видел 0 ₽ из-за фильтра даты открытия смены. Платёж 40 ₽ вчера и платёж другого сотрудника 70 ₽ сегодня не должны попадать в его итог.
- Сотруднику в PostgreSQL, memory и demo теперь показываются только собственные оплаты и закрытые заказы за текущую дату точки по времени события. Переданные `date` и `shiftId` игнорируются; реальный ID смены и данные сверки не выдаются. Руководитель сохраняет выбор и аналитику смен. Убрана загрузка журнала аудита для роли, у которой нет доступа: экран больше не показывает ожидаемую ошибку прав.
- PostgreSQL/Chromium QA подтвердил 60 ₽, один платёж и одно закрытие, изоляцию сотрудника и точки, защиту от подмены фильтров, отсутствие запроса `/api/audit`, выключенные фильтры и отсутствие горизонтального переполнения на 375, 902 и 1440 px. Снимки в `qa-artifacts/dashboard-stage71/`; тестовые записи удалены. Memory, demo, контракт атрибуции и синтаксис прошли. Source/dist синхронизированы. Физический Fold8 и общий gate остаются открытыми.

## Этап 4/6 · Подэтап 72 — согласование выручки сотрудника на главной, 30.09.2026

- Ночная PostgreSQL фикстура доказала противоречие: блок смены показывал 60 ₽ собственных оплат сегодня, а соседняя финансовая карточка — 100 ₽, включая платёж 40 ₽ вчера по заказу, закрытому сегодня. Это создавало две разные цифры с одинаковым смыслом «сегодня».
- Для ограниченной роли `/api/finance/summary` в PostgreSQL, memory и demo теперь считает собственные платежи по времени их проведения в локальной дате точки, включая открытые заказы. Формат ответа остаётся ограниченным: `{date,revenue,employeeView}`. Руководитель продолжает получать отчёт по дате закрытия заказа. Подпись карточки сотрудника уточняет «Ваши оплаты сегодня» и «Платежи по вашим заказам сегодня».
- PostgreSQL/API/Chromium повторно подтвердили 60 ₽ в обоих блоках, отсутствие разбивки всей точки в ответе сотруднику и корректные подписи на 375/902/1440 px; тестовые записи удалены. Memory/demo QA, матрица ролей, финансовый контракт, насыщенный dashboard browser QA, синтаксис и итоговый code health review прошли. Source/dist синхронизированы. Визуальный снимок также выявил отдельную ошибку загрузки списка сотрудников под ограниченной ролью; она открыта для следующего подэтапа. Физический Fold8 и общий gate открыты.

## Этап 4/6 · Подэтап 73 — кадровый блок на экране сотрудника, 30.09.2026

- Снимок ночной смены выявил ошибочный toast «Не удалось обновить список сотрудников». Причина: главная безусловно вызывала `/api/staff`, хотя роль бармена не имеет `staff_view` и сервер правильно отвечает 403. Прямой `/admin#staff` обходил отсутствие пункта «Персонал» в меню.
- Главная теперь строит кадровый раздел и загружает список только при `staff_view`, как боковое меню; у остальных ролей удаляет блок и переключатель из настроек, а прямой `#staff` приводит к обычной главной. Демо API согласован с серверным ограничением `staff|staff_view|settings`. Глобальный callback обновления списка не назначается без права. Серверные права не расширялись.
- PostgreSQL/Chromium под барменом подтвердил ноль запросов `/api/staff`, отсутствие блока/toast и корректный возврат с прямой ссылки; экран сохраняет показатели на 375/902/1440 px. Browser QA кадрового справочника для разрешённой роли прошёл на 320/375/768/1440 px, включая 503/повтор и сохранение. Demo permission QA, матрица ролей, sidebar contract, синтаксис и source/dist прошли; тестовые записи удалены. Физический Fold8 и общий gate остаются открытыми.

## Этап 4/6 · Подэтап 74 — действия главной по правам роли, 30.09.2026

- PostgreSQL браузер выявил у бармена кликабельные KPI и быстрые ссылки на бронирования и склад без соответствующих прав. На прямом переходе страница отказывала в доступе. У scoped admin также оставались карточка финансов/заказов, пустой блок быстрых действий и запросы ограниченных KPI/аудита.
- Главная теперь показывает KPI, быстрые действия и ссылку настроек по тем же правам, что маршруты. Финансовый и сменный блоки не запрашиваются без `finance_read`; карточка заказов не создаётся без `orders`; журнал действий загружается только при `settings` или `diagnostics`, как на сервере. Пустые панели и их переключатели убраны. При двух/трёх KPI desktop-сетка занимает всю строку по ширине рабочей области; подпись быстрых действий уточнена до «Доступные разделы». Версии опубликованных assets подняты до portal405/CSS360 и source/dist синхронизированы.
- Изолированный PostgreSQL/Chromium QA проверил бармена, управляющего и admin со scope finance, settings и reservations; отсутствие запрещённых запросов/ссылок, разрешённые действия и отсутствие горизонтального переполнения на 375/902/1440 px. Снимки KPI и действий сотрудника на 375/1440 px визуально просмотрены: две карточки занимают полную строку, заголовок не ломается. Заполненный dashboard QA, sidebar/design contracts, синтаксис и diff прошли; тестовые записи удалены. Смежно открыт KPI перехода в заказы на `/finance` у admin только с finance scope и расхождение прав вспомогательных должностей между порталом и сервером. Физический Fold8 и общий gate остаются открытыми.

## Этап 4/6 · Подэтап 75 — переходы ограниченного администратора, 30.09.2026

- PostgreSQL/Chromium воспроизвёл кликабельный KPI «Заказы» на `/finance` у администратора только с finance scope. При этом `pagePermissions` переводил любой запрещённый маршрут на `/finance`, что могло зациклить администратора без `finance_read`.
- Карточка количества заказов остаётся информативной, но без `data-kpi-route`, роли кнопки и клавиатурного фокуса при отсутствии `orders`; у управляющего переход в зал сохраняется. Запрещённая страница теперь возвращает на доступную всем CRM-ролям `/admin`. Portal asset поднят до rev406 и синхронизирован со всеми опубликованными HTML/dist маршрутами.
- Изолированный PostgreSQL browser QA подтвердил информационную карточку finance-only admin, активный переход управляющего и возврат settings-only admin с `/reservations` и `/finance` без цикла. Проверены отсутствие лишних интерактивных атрибутов и 375/902/1440 px на главной. `finance-role-browser-qa`, матрица ролей, sidebar/design contracts, синтаксис и diff прошли; тестовые записи удалены. Открыто более широкое расхождение scoped read permissions между клиентом и сервером и роли вспомогательного персонала; требуется отдельный сквозной аудит. Физический Fold8 и общий gate открыты.

## Этап 4/6 · Подэтап 76 — чтение данных ограниченным администратором, 30.09.2026

- Прямой PostgreSQL API воспроизвёл дефект: admin только с finance scope получал `inventory_read` в `/api/session` и мог читать склад, хотя интерфейс скрывал раздел. Аналогично другие scopes сохраняли `finance_read`; серверная `scopedPermissionMap` исключала эти read-разрешения из набора отзываемых прав, в отличие от клиентской карты.
- Серверная карта теперь включает `finance_read` и `inventory_read` в соответствующие scopes. Администратор без этих scopes теряет прямой доступ к финансовой сводке, аналитике, расходам, складу и автозаявкам; со своим scope сохраняет чтение и запись. Полный администратор без заданных scopes и управляющий сохраняют прежние права. Новых миграций и изменения формата ответа нет.
- Изолированный PostgreSQL сценарий проверил login и `/api/session`, прямые GET пяти маршрутов для finance/settings/reservations/inventory/finance+inventory, полного admin и manager. Уже открытый токен после ограничения admin до settings немедленно получил 403 на финансы; после возврата к полному доступу чтение восстановилось. Браузерная матрица ролей и 375/902/1440 px, `local-role-contract`, `role-api-matrix-runtime-qa`, финансовый контракт, синтаксис и diff прошли; все фикстуры удалены. Клиентские базовые права должностей без CRM остаются отдельным вопросом. Физический Fold8 и общий gate открыты.

## Этап 4/6 · Подэтап 77 — показатели по разрешениям, 30.09.2026

- `/api/metrics` раскрывал все восемь показателей ограниченному администратору независимо от направления. Единая проекция для PostgreSQL и memory оставляет поля заказов при `orders`, финансов при `finance_read`, сотрудников при `staff_view` или `staff`, бронирований при `reservations`, склада при `inventory_read`. Запрещённый ключ отсутствует; settings-only admin получает пустой объект с 200. Demo API повторяет контракт, включая узкий ответ для операционного сотрудника.
- PostgreSQL проверил наличие каждого поля для finance/settings/reservations/inventory/finance+inventory, полного admin и manager, включая браузерную матрицу и 375/902/1440 px. Demo QA, role API matrix, дизайн-контракт и синтаксис прошли. Assets синхронизированы с portal407. Отдельно открыты денежные данные в `/api/shifts` и `/api/notifications` для ограниченных направлений, физический Fold8 и общий gate.

## Этап 4/6 · Подэтап 78 — права на кассовую смену, 30.09.2026

- Причина: `floor` оставался у администратора с любым scope, поэтому settings/reservations/inventory могли читать кассовую историю и запускать операции со сменой. `floor` теперь входит в ограничиваемое направление `orders` и на сервере, и в портале. Finance-only получает полную историю и сверку только на чтение; orders-only управляет текущей POS-сменой и видит её стартовый остаток, но не прошлые смены и суммы сверки. Это намеренное правило POS, зафиксированное в `DECISIONS.md`.
- Главная не запрашивает `/api/shifts` и не показывает панель для роли без orders/finance. Demo GET повторяет серверное ограничение, включая операционного сотрудника. PostgreSQL/API/Chromium проверили восемь вариантов прав, прямой запрет записи, наличие панели и запросов на 375/902/1440 px; demo, role API, local role, design contracts и синтаксис прошли. Assets синхронизированы с portal408; тестовая точка удалена. Уведомления из чужих направлений остаются следующим подэтапом, Fold8 и общий gate открыты.

## Этап 4/6 · Подэтап 79 — уведомления по направлению доступа, 30.09.2026

- `/api/notifications` добавлял PostgreSQL уведомления о закупках и удалённых заказах после исходного фильтра получателей. Теперь общий фильтр после объединения источников проверяет роль и направление каждого события: сотрудники, склад или заказы. У роли только с заказами событие удаления не содержит себестоимость и список позиций с закупочными ценами; роль только с настройками не получает эти события. Уведомления режима памяти привязаны к точке, а операционный сотрудник сохраняет прежний отказ 403. Демо API повторяет правило.
- Колокольчик запрашивает только разрешённые маршруты; отсутствие права не считается ошибкой загрузки, а при отсутствии категорий колокольчик скрыт. Демо-уведомления теперь сохраняют точку заказа и не переходят между точками; старые записи без идентификатора точки скрыты, поскольку их принадлежность нельзя доказать. Изолированная PostgreSQL фикстура с отправленной автозаявкой и удалённым заказом проверила содержимое ответа для восьми вариантов прав, браузерные запросы и 375/902/1440 px. Demo QA, order-delete QA, матрица ролей, дизайн-контракт, синтаксис и diff прошли. Assets синхронизированы с portal410/app168; тестовая точка удалена. Физический Fold8 и общий gate открыты.

## Этап 4/6 · Подэтап 80 — широкий адаптивный проход и acceptance contract, 30.09.2026

- Эмулятор Chromium с touch-профилем проверил `/admin`, `/orders` и POS на 19 ширинах от 320 до 3840 px, включая Fold-подобные 651/768 px, touch drawer и переходы состояния. На всех маршрутах document/body width совпали с viewport; горизонтального переполнения и возврата на login не обнаружено.
- `final-acceptance-matrix-contract` подтвердил 34 пронумерованных требования с evidence и residual risk. Это закрывает текущий широкий эмуляторный проход; физический Fold8, системная клавиатура, печать и общий финальный interactive gate остаются открытыми.

## Этап 4/6 · Подэтап 81 — acceptance и заполненные состояния, 30.09.2026

- Повторный локальный acceptance прошёл через dashboard KPI и inventory context после актуализации контрактных проверок под текущую реализацию: product editor восстанавливает кнопку с учётом `submitting`, а premix controls блокируются на время запроса; inventory critical-state QA теперь проходит с реальным DOM-контрактом и error-state поведением.
- Полный acceptance продолжился до `tasks-qa`, где остановился на внешнем занятом порте `3217` (Docker proxy PID 16428) и получил PostgreSQL-style UUID error вместо изолированного memory-сервера. Это инфраструктурный блокер конкретного тестового harness, не подтверждённый дефект продукта; его нужно повторить на свободном порту/после освобождения proxy. Физический Fold8, системная клавиатура, печать и общий gate открыты.

## Этап 4/6 · Подэтап 82 — продолжение acceptance и контракты harness, 30.09.2026

- `tasks-qa` получил настраиваемый `TASKS_QA_PORT` и повторно прошёл на свободном 3218: 5 checks passed. Обновлены stale static contracts для текущих имён/состояний KPI, inventory editor/premix controls и канонических POS tab selectors; inventory critical-state QA и local click contract прошли.
- Полный acceptance продвинулся дальше и остановился на runtime mock `pos-modal-a11y-contract`: его искусственный DOM не воспроизводит текущую структуру диалога, поэтому это отдельный тестовый harness blocker. Статические invariants helper остаются подтверждены; продуктовый код в этом подэтапе не менялся. Физический Fold8, системная клавиатура, печать и общий gate открыты.
- После этого обновлены mock-контракты `orders-history-qa`: добавлено окружение `window` и базовые DOM-заглушки; из-за того, что extracted app slice теперь включает глобальные UI listeners, этот helper оставлен source-only и явно передаёт browser flow в Playwright acceptance. Контракт проходит. Полный acceptance следует повторить с локальным сервером; физический Fold8, системная клавиатура, печать и общий gate открыты.

## Этап 4/6 · Подэтап 83 — продолжение локального acceptance, 30.09.2026

- Acceptance повторно прошёл до сетевых и контекстных проверок: формы клиента, бронирования, склада, рецептур, премикса, каталога, приёмки, автозаказа, сетевые pending/error сценарии, обновление контекста точки и tobacco demo QA.
- Актуализированы stale harness-контракты `client-form-submit-qa`, `product-form-pending-qa`, `purchase-document-pending-qa`, `portal-context-refresh-qa` и `finance-employee-contract` под текущие обработчики, расширенные pending guards, permission-aware смену и employee-only finance SQL. Прямые проверки проходят; полный acceptance продолжает следующий участок.

## Этап 4/6 · Подэтап 84 — floor и smoke acceptance, 30.09.2026

- Исправлен stale regex в `local-floor-management-contract`; локальная проверка управления залом прошла на чистом memory-сервере: пустой зал → стол → reload → гостевой диапазон → бронирование/отмена → защита удаления.
- Повторный acceptance дошёл до `smoke-test.ps1`. Smoke harness обновлён под обязательный `expectedVenueId` для PATCH `/api/venue` и сохранение второго товара перед split заказа; после этого `CRM smoke test: PASS`. Rate-limit повторных прогонов устранялся перезапуском только локального тестового сервера. Fold8, клавиатура, печать и общий interactive gate остаются открытыми.

## Этап 4/6 · Подэтап 85 — Fold, клавиатура и touch emulator, 30.09.2026

- `fold-responsive-contract` и `portal-action-keyboard-qa` прошли: modal Tab loop, outside focus, Escape, custom-select focusout и восстановление фокуса подтверждены.
- Подключён установленный Chromium через `PLAYWRIGHT_EXECUTABLE_PATH`; `responsive-emulator-runtime-qa` прошёл на 19 viewport-профилях от 320 до 3840 px для `/admin`, `/orders` и POS, включая Fold main 768×1024, touch drawer и state transition. Document/body width совпали с viewport, ошибок переполнения не зафиксировано. Физический Fold8, печать и общий interactive gate остаются открытыми.
- `orders-receipt-qa` отдельно подтвердил печать: итоговые суммы, нулевой чек, историческая дата, escaping, popup isolation, blocked popup и cancelled guard. `git diff --check` и syntax check responsive harness прошли. Физический Fold8 и общий interactive gate остаются открытыми; автоматический emulator покрывает Fold-профиль, но не заменяет физическое устройство.

## Этап 5/6 · Подэтап 87 — regression-проход, 30.09.2026

- После последних harness-правок повторно прошли final acceptance matrix (34 требования), additional acceptance (50 требований), security default credentials, role API matrix, orders totals/receipt, Fold responsive и modal/custom-select keyboard QA.
- `app.js`, `portal.js`, `server.js` прошли syntax check. Критические P0/P1 сценарии из текущего regression набора не выявили новых регрессий. Физический Fold8 и полный ручной интерактивный обход остаются границами доказательств, поэтому quality gate ещё не закрыт.

## Этап 5/6 · Подэтап 88 — полный acceptance и платежи поставщикам, 30.09.2026

- Полный acceptance с `API_RATE_LIMIT=10000` прошёл smoke test, local CRUD, guest-order, floor management и расширенный набор финансовых/закупочных проверок. `purchase-payments-contract` адаптирован к актуальной цепочке `loadPayables → loadExpenses → finance-date change` и подтвердил 19 проверок.
- Повторный прогон после этой правки дошёл до smoke, но остановился на `session_limit_reached` из-за двух накопленных admin-сессий в одном long-lived memory-сервере. Это тестовая инфраструктура; чистый smoke и guest-order ранее прошли. Физический Fold8 и полный ручной интерактивный обход всё ещё не доказаны.

## Этап 6/6 · Подэтап 89 — финальный аудит evidence и границ gate, 30.09.2026

- Перечитаны исходное ТЗ и `FINAL_ACCEPTANCE_REPORT.md`. Автоматические контракты подтверждают каркас, основные API/POS/security и responsive сценарии, но отчёт сохраняет реальные частичные требования: полный интерактивный обход всех экранов, физический Fold8, заполненные browser-состояния ряда разделов, актуальный PostgreSQL concurrency для новых платежных сценариев и некоторые продуктовые правила.
- Финальный статус пока не переводится в PASS: evidence недостаточно для заявления «существенных проблем не осталось». Изменения не публикуются на GitHub/VPS; домен и HTTPS остаются последним этапом по договорённости.

## Этап 6/6 · Подэтап 90 — interactive evidence review, 30.09.2026

- Проверен Chromium harness: он выполняет реальный login, создаёт заполненный POS-заказ и частичную оплату, кликает стол, открывает payment modal, проверяет остаток 150 ₽, сохраняет доступность submit при короткой высоте, делает Fold resize 375→768→375, меняет дату и открывает/закрывает touch drawer. Это усиливает interactive evidence для POS/Fold сценария.
- Полный обход каждого безопасного интерактивного элемента всех 14 маршрутов по-прежнему не доказан одним автоматическим прогоном; physical Fold8 также отсутствует. Финальный статус остаётся FAIL/INCOMPLETE до внешнего ручного прохода.

## Этап 6/6 · Подэтап 91 — финальная чистота исходников, 30.09.2026

- После последнего acceptance-прохода `app.js`, `portal.js`, `server.js` и responsive harness прошли syntax check; `purchase-payments-contract` (19 checks) и floor management contract прошли повторно; `git diff --check` не выявил ошибок whitespace.
- Это завершает доступный автоматический regression evidence. Physical Fold8 и полный ручной обход остаются внешними условиями финального gate.

## Этап 6/6 · Подэтап 93 — повторный чистый Chromium interactive run, 30.09.2026

- После полного перезапуска memory-сервера без активных сессий responsive emulator снова прошёл: 19 viewport-профилей 320–3840 px, `/admin`, `/orders`, POS, touch drawer, Fold main 768×1024 и state transition. Итог: `RESPONSIVE EMULATOR QA: PASS`.
- Предыдущий browser-tab сбой не воспроизведён в воспроизводимом Playwright harness. Это подтверждает автоматический runtime flow, но не заменяет физический Fold8 и ручной обход всех элементов.

## Этап 6/6 · Подэтап 96 — подтверждение Fold8 владельцем, 30.09.2026

- Владелец подтвердил наличие физического Samsung Galaxy Z Fold8. Это снимает отсутствие устройства как организационный блокер, но в текущем Codex-сеансе нет подключённой device/screen-sharing поверхности, поэтому я не могу независимо снять и сохранить hardware Cover/Main evidence.
- Автоматический Fold-профиль остаётся PASS; полный ручной обход и аппаратные screenshots требуют доступного канала устройства.

## Этап 6/6 · Подэтап 97 — согласованное исключение Fold8, 30.09.2026

- Владелец попросил временно пропустить физическую проверку Fold8. Решение записано в `FINAL_ACCEPTANCE_REPORT.md`; автоматический Fold/Chromium evidence сохраняется, hardware screenshots вынесены в отдельную будущую задачу.

## Этап 6/6 · Подэтап 99 — публикация и деплой, 30.09.2026

- Изменения закоммичены и отправлены в GitHub: ветка `codex/hookah-crm-full-audit-2026-09-29`, commit `0f1d0068e663c0bd9f0a2737c6f091cf23231975` (`Complete CRM audit fixes and QA contracts`).
- VPS `212.192.0.58` обновлён из этой ветки в `/root/HOOKAH-CRM`; создан pre-deploy backup базы, применены миграции 001–053, выполнен seed меню (`categories: 10`, `products: 66`).
- Контейнеры `crm`, `db`, 
ginx` запущены; `crm` и `db` имеют статус healthy. Из-за отсутствия Compose v2 используется установленный legacy `docker-compose`.

## Этап 6/6 · Подэтап 100 — post-deploy smoke, 30.09.2026

- `GET http://127.0.0.1:8080/api/health` вернул `{"status":"ok","service":"hookah-crm","database":"postgres"}`.
- Маршруты `/admin`, `/inventory`, `/orders`, `/finance`, `/clients`, `/reservations` вернули HTTP 200.
- Внешний домен и HTTPS не настраивались по согласованному решению владельца; текущий VPS доступен через опубликованный nginx-порт 8080.

## Этап 6/6 · Подэтап 101 — trusted PIN-возврат для владельца/admin, 30.09.2026

- Повторно проверена текущая реализация `lock.js`, `login.js`, `server.js`, `db.js` и действующие lock/login/session контракты. Существующая экранная PIN-блокировка сохранена: manual/auto lock, 4-значный PIN, лимит попыток, no-PIN guard и синхронизация вкладок остались в старом контракте.
- Добавлен простой целевой сценарий для владельца/admin/developer: checkbox «Запомнить это устройство» при login создаёт long-lived trusted session, `/login` при живой HttpOnly cookie показывает PIN-card, `/api/session/pin-return` после правильного PIN возвращает текущий token/user и восстанавливает локальное состояние браузера без ввода пароля. Operational staff остаётся на обычной рабочей PIN-блокировке и не получает trusted PIN-return.
- Обновлены published assets и `dist`: `login.js?rev=93`, `style.css?rev=362`. Добавлены `scripts/trusted-pin-return-contract.mjs`, `scripts/trusted-pin-return-runtime-qa.mjs` и npm-скрипт `qa:trusted-pin`; `login-error-runtime-qa` расширен под новый login DOM.
- Проверки: 
pm run qa:trusted-pin`, 
ode scripts/local-lock-contract.mjs`, 
ode scripts/local-login-contract.mjs`, 
ode scripts/login-error-runtime-qa.mjs`, 
ode scripts/staff-pin-passport-runtime-qa.mjs`, 
ode scripts/session-preferences-concurrency-qa.mjs`, 
ode scripts/session-authority-qa.mjs`, 
ode --check server.js login.js db.js scripts/login-error-runtime-qa.mjs scripts/trusted-pin-return-contract.mjs scripts/trusted-pin-return-runtime-qa.mjs`, `git diff --check` — PASS.
- Границы: в рабочем дереве до этой доработки уже были незавершённые изменения notification/API/schema/docs и новые notification scripts/migration; они не относятся к PIN-возврату и не откатывались.

## 2026-09-30 — финальная проверка trusted PIN-return

- Code health security review выявил риск: `GET /api/session` не должен возвращать bearer token до PIN. Исправлено: token остаётся только в обычном login/session unlock/session pin-return после проверки PIN.
- Живые UI-проверки на локальном сервере: trusted PIN-card на `/login`, PIN-возврат в `/admin`, ручная блокировка, PIN-разблокировка с сохранением `/admin`, двухвкладочная синхронизация, мобильный экран 390x844 и авто-блокировка через 1 минуту.
- Runtime QA расширен проверкой завершённой сессии: после logout `/api/session/pin-return` с прежней cookie возвращает 401 и не пересоздаёт сессию.
- Повторная сверка 2026-10-04 после последующих изменений: добавлен и пройден `scripts/pin-lock-acceptance-contract.mjs` для staff `/api/session/unlock`, owner/admin/developer `/api/session/pin-return`, role/tenant scope, stale local session cleanup, two-tab `localStorage` lock/unlock propagation и мобильных ограничений login/PIN/lock card. `staff-lock-ui-runtime-qa` актуализирован под async unlock handler и подтверждает ручную блокировку, неверный/верный PIN, сохранение bearer-сессии и открытого рабочего маршрута. Также повторно PASS: `trusted-pin-return-contract`, `trusted-pin-return-runtime-qa`, `staff-pin-passport-runtime-qa`, `staff-session-recovery-runtime-qa`.

## 2026-10-01 — постоянный центр уведомлений

- Владелец уточнил, что колокольчик и центр уведомлений должны оставаться доступными при переходах между административными разделами, а прочитанные события должны быть видны в «Все» в пределах текущей ленты. Общий `header-shell.js` добавляет кнопку на всех 11 канонических административных маршрутах; PostgreSQL хранит отметки прочтения раздельно по пользователю и заведению.
- Расширен `scripts/notifications-browser-qa.mjs`: после двух событий он открывает панель на каждом из 11 маршрутов, сверяет ленту/счётчик, затем проверяет desktop/tablet/mobile, ошибку/повтор, фильтры, reload и cross-tab. Тестовому серверу задан отдельный rate limit, чтобы серия навигаций не упиралась в production-подобный порог.
- 
ode scripts/notifications-browser-qa.mjs` — PASS; 
ode scripts/notifications-api-qa.mjs` — PASS; `scripts/notifications-postgres-qa.mjs` на временной PostgreSQL 16 с миграциями 001–055 — PASS, включая per-user/per-venue изоляцию, сохранение после restart процесса и явный 503 при недоступном источнике.
- Концепция обновлена. `scripts/header-shell-contract.mjs` пока не проходит из-за существующего полного рассогласования `dist/style.css` и `style.css`; notification-селекторы присутствуют в обеих копиях, но общий sync-check/релизный gate этим не подтверждён. Production/VPS публикация не выполнялась.
- Граница доказательств: текущая лента показывает максимум 20 событий, подгружая до 100 на тип; у неё нет пагинации или бессрочного архива. Прочтение устойчиво, но это не доказывает доступность старого события после выхода за лимит или смены статуса исходного объекта. Полный журнал — отдельный следующий этап.

## 2026-10-01 — переименование продукта в HOOKAH POS

- GitHub-репозиторий переименован владельцем в `falex2006/HOOKAH-POS`; локальный `origin` обновлён. Описание репозитория изменено на HOOKAH POS.
- Бренд обновлён в README, правилах команды, карте сайта, визуальных инструкциях, профильных промтах, матрице приёмки и подписи экрана блокировки; файл матрицы и проверочный контракт переименованы. NPM-пакет и health service теперь `hookah-pos`.
- Docker Compose по умолчанию использует проект и образ `hookah-pos`; label выпуска переименован в `com.hookahpos.release-id`. Существующий PostgreSQL volume оставлен как `territory-crm_pgdata`; VPS deploy сохраняет проектный namespace и пути состояния/backup, чтобы переход не создал пустую production-БД и новую историю выпусков. Существующий Docker stack не перезапускался: рабочая копия содержит другие незакоммиченные изменения, поэтому образ не пересобирался из текущего состояния.
- Проверки PASS: `docker compose config --quiet`; 
ode scripts/local-deploy-contract.mjs`; 
ode --check server.js`; `git diff --check`. Проверен текущий локальный `/api/health`.
- Технические старые ключи demo/localStorage, идентификаторы фикстур, прежний volume и исторические сведения о размещениях сохранены ради совместимости и точности аудита; это не отображаемый бренд.

## 2026-10-01 — SaaS панели: сквозной аудит API и действий

- Проверена `/platform`: ссылки-якоря, onboarding, поиск, смена тарифа, карточка статуса/подписки, logout и динамическая загрузка данных. Исправлены хардкод 99.9% и постоянное «Платформа работает», статусы `trialing/active/past_due/cancelled`, misleading-текст про гостей и декоративные планы; добавлены обработка ошибок/повтор загрузки, блокировка повторного submit, возврат фокуса, состояния загрузки карточки и экранирование полей компаний.
- SaaS GET-маршруты при настроенной PostgreSQL теперь возвращают 503/404 вместо fallback на память для `/api/saas/account`, `/api/platform/overview`, `/api/platform/organizations` и подписки; неизвестный статус подписки даёт 400. Старый PATCH `/api/platform/organizations/:id` оставлен для in-memory demo-клиентов; в PostgreSQL-контуре отвечает 410 с подсказкой использовать единый `/subscription` API.
- Для `/platform` обновлены исходная страница, JS, плоская публикация и `/platform/` alias. Добавлен `scripts/platform-saas-contract.mjs` на контракты UI/API и синхронность публикации.
- Проверки PASS: 
ode --check server.js platform.js scripts/platform-saas-contract.mjs`; 
ode scripts/platform-saas-contract.mjs`; 
ode scripts/local-design-contract.mjs`; 
ode scripts/local-click-contract.mjs`; 
ode scripts/local-role-contract.mjs`; SaaS account, onboarding, organization, billing contracts на отдельном demo-процессе; runtime сценарий create → смена тарифа/статуса → reread; отдельный `AUTH_REQUIRED=true` role gate (tenant owner 403, platform owner доступ).
- Не выполнены/остались: браузерный визуальный обход не стартовал из-за несовместимой установки Playwright; PostgreSQL failover и сохранение после рестарта не запускались, поскольку безопасная изолированная PG БД не подготовлена. Обнаружены и зафиксированы, но не исправлялись в этом пакете, квотные ограничения при добавлении venue/staff и блокировка уже существующих tenant-сессий после приостановки подписки; они требуют отдельного интеграционного теста на общем CRM auth/write-контуре. Docker и основная БД не перезапускались/не изменялись.
## 2026-10-01 — SaaS квоты и блокировка tenant-доступа

- Создание сотрудника/заведения проверяет тарифные лимиты транзакционно под блокировкой строки организации; сотрудник сохраняется с `organization_id` и активным членством. Реактивация сотрудника также проверяет лимит.
- Вход, чтение PostgreSQL-сессии и tenant API-запросы проверяют состояние организации, подписки и членства. `cancelled`, отключённая организация и неактивное членство закрывают доступ; `past_due` оставлен доступным, поскольку проект не задаёт grace/read-only политику.
- API описывает 409 `seat_limit_reached`/`venue_limit_reached` (с `limit` и `used`) и 403 для недействительного доступа. Добавлен изолированный PostgreSQL runtime QA для квот, гонок создания заведений, реактивации, отмены подписки и восстановления доступа.
- Проверки PASS: синтаксис `server.js`, `db.js` и QA-скрипта; отдельный PostgreSQL quota/suspension E2E; миграционный PostgreSQL upgrade QA; platform SaaS, role, design и click contracts. Независимый code-health review блокирующих замечаний не выявил.
- Повторный PostgreSQL QA после последней правки статусов не стартовал: среда отклонила PowerShell-команду управления временным тестовым процессом. Production, основная БД и Docker stack не публиковались и не перезапускались.

## 2026-10-01 — жизненный цикл партий заготовок и премиксов

- Причина: экран умел выпустить премикс по техкарте, но не учитывал фактический выход, срок годности, остаток/исполнителя партии, расход по конкретным партиям, порчу, пересчёт и безопасную отмену выпуска.
- Миграция `056_premix_batch_lifecycle.sql` добавляет плановый выход, фактический выход (в существующем количестве выпуска), срок годности, ссылку на складское движение, статус/аудит отмены и неизменяемый журнал движений партии. Серверный API возвращает остаток партии и исполнителя; выпуск принимает фактический выход и срок годности. Складские расходы распределяются сначала по старому неразмеченному остатку (исторические движения невозможно надёжно приписать партии), затем FEFO по просрочке/сроку и FIFO при равном приоритете. Просроченный остаток не выдаётся. Добавлены отдельные действия пересчёта, списания порчи и консервативной отмены ещё не затронутого нового выпуска с обратным возвратом ингредиентов.
- Форма, история партий и действия доступны в основном портале и demo API; обновлена публикационная копия `dist/portal.js` и версия её cache-busting URL. API-контракт, миграционные проверки и локальный acceptance runner дополнены. Основание стратегии совместимости записано в `DECISIONS.md`.
- Проверки PASS: 
ode --check` затронутых JS; `premix-batch-lifecycle-qa.mjs`; `demo-premix-unit-runtime-qa.mjs`; `premix-submit-pending-qa.mjs`; `inventory-premix-load-state-qa.mjs`; `premix-create-route-qa.mjs`; `migrations-contract.mjs` (56 миграций); `premix-contract.mjs`; `recipe-depletion-contract-qa.mjs` (18 assertions); `recipe-depletion-pg-runtime-qa.mjs` на временной PostgreSQL 16 (292 assertions); `migrations-pg-upgrade-qa.mjs` (38 baseline + 18 новых миграций, legacy сохранены и новые миграции повторно запущены); `git diff --check` без ошибок форматирования. После code-health замечаний добавлены два защитных исправления: demo-история показывает нулевой остаток отменённой партии, а PostgreSQL-отмена блокирует/проверяет исходные ингредиенты и откатывается при невозможности возврата.
- Ограничение: накопленный ранее агрегированный остаток хранится как нераспределённый legacy-pool и списывается первым; восстановить принадлежность прошлого расхода партиям нельзя. Миграция и код подготовлены локально, production/основная БД не менялись и публикация не выполнялась.
- Production deployment завершён на VPS `212.192.0.58` (commit `5f77a22`; feature commit `accab33`, cache key commit `de07d34`). Перед каждым из двух deploy создан PostgreSQL backup в `/var/backups/territory-crm/territory-crm/`; состояние релиза записано как `deployed`. Миграции `055_stock_movement_precision.sql` и `056_premix_batch_lifecycle.sql` применены, таблицы `inventory_premix_batches` и `inventory_premix_batch_movements` присутствуют. `NGINX_HTTP_PORT=80` выставлен в серверном `.env`; публичный `http://212.192.0.58/` и `/api/health` ответили 200/ok, `/inventory` загрузил `portal.js?rev=413`, authorized post-deploy acceptance (health, login, session, core routes) прошёл. Production-операции и тестовые записи в бизнес-данные не создавались. HTTP cookie оставлен по текущей настройке `COOKIE_SECURE=false`; deploy разрешён только одноразовым `ALLOW_HTTP_DEPLOY_ONCE=true`, не записанным в `.env`.
## Складской аудит на VPS — продолжение после авторизации, 01.10.2026

- В авторизованной сессии тестового заведения просмотрены каталог, техкарты, остатки, журнал склада, персонал и состояние зала. Записи не создавались и не менялись в этом проходе.
- VPS UI подтверждает 66 товаров каталога и 0 привязок к техкартам; в техкартах 26 записей и также 0 связей с каталогом. Склад содержит только тестовые позиции «Тест» и «Тест2» (по 1000 мл каждая). Их названия не позволяют подтвердить соответствие рецептурам реального бара/кальяна. Это блокирует доказательство реального товарного списания из меню.
- Журнал склада показывает два документа приёмки (один проведённый старый документ на 1000 единиц и QA-документ `QA-VPS-20261001-01`, отменённый) и четыре операции: приход +1000 для «Тест», приход +1000 для «Тест2», а также парные QA движения +50/-50. После обновления UI остатки обеих тестовых позиций равны 1000 мл — QA-пара компенсирована.
- Персонал показывает активные учётки `тест` (бармен) и `тест1` (кальянщик). Текущая сессия — владелец/администратор; активной смены и открытых заказов нет. Без фактической отдельной сессии каждой роли нельзя подтвердить рабочие панели и права; без связки SKU ↔ техкарта нельзя безопасно сформировать валидное списание. Пароли/PIN не угадывались, смена не открывалась, существующий заказ не создавался.
- Ранее выполненные локальные проверки в disposable PostgreSQL и браузерном harness остаются PASS (см. предыдущие записи). VPS evidence подтверждает только видимую сохранность тестовых остатков и компенсационной QA-пары, а не полный sale-to-ledger сценарий.
- Повторно прогнаны на текущем дереве: `warehouse-qa.mjs` — 55 checks на изолированном memory server `127.0.0.1:3107` (сервер остановлен после теста); `recipe-depletion-runtime-qa.mjs` — 87 checks; `inventory-movement-transaction-qa.mjs`, `purchase-documents-contract.mjs`, `local-role-contract.mjs`, `inventory-hierarchy-contract.mjs`, `inventory-subdepartment-api-qa.mjs`, `migrations-contract.mjs` (56) и `recipe-depletion-contract-qa.mjs`/`recipe-depletion-pg-contract.mjs` — PASS; 
ode --check` затронутых JS и `git diff --check` — PASS. Это локальные проверки, не VPS role acceptance.
- Повторная проверка продолжения: `http://212.192.0.58/api/health` — 200 (`database: postgres`), `/inventory` — 200 с `portal.js?rev=413`; открытая VPS-вкладка по-прежнему на пустой форме `/login`, ручной вход владельца/сотрудников ещё не выполнен.
- Следующий безопасный шаг: владелец вручную авторизуется в форме входа (открыта в браузере); затем в подтверждённом тестовом заведении можно подготовить явно названную временную SKU/техкарту на существующих тестовых ингредиентах и провести/скомпенсировать QA продажу. После этого владелец вручную переключит сессию по очереди на `тест` и `тест1` для отдельных ролевых проходов. Учетные данные не запрашивать в чате и не угадывать.

## 2026-10-01 — анимированный фон авторизации

- Причина: подготовленные фоновые анимации кальянной фотографии и дыма на `/login` были отключены общим правилом `animation: none !important` для всех потомков `.login`.
- Изменение: исключена из этого правила только сцена `.login-atmosphere`; сама форма и её элементы остаются неподвижны. Существующие медленное движение камеры и дыма работают с прежними темпами, а `prefers-reduced-motion` по-прежнему отключает движение. Визуальный контракт `/login` уточнён; опубликованная копия CSS синхронизирована.
- Файлы: `style.css`, `dist/style.css`, `VISUAL_PAGE_RULES.md`.
- Проверки: 
ode scripts/visual-page-rules-contract.mjs` — PASS; 
ode scripts/local-login-contract.mjs` — PASS (33 проверки); 
ode --check login.js` — PASS; `git diff --check` по изменённым исходникам — PASS.
- Границы: дерево уже содержало посторонние незавершённые изменения; публикация не выполнялась.

## 2026-10-01 — release QA warehouse, notifications and SaaS

- Подготовлен релизный checkout поверх VPS-релиза `5f77a22`; scratch-каталог `tmp/` и локальный datasheet в пакет не включены. Синхронизированы исходные и опубликованные HTML/JS/CSS; общий CSS cache key поднят до `rev=363`, панель SaaS — до `platform.js?rev=4`.
- Свежие проверки PASS: notifications browser/API; SaaS quotas/suspension на disposable PostgreSQL; upgrade всех 56 миграций с сохранением legacy-строк и точности количества; POS browser PostgreSQL (оплата, разделение, скидка, роли, reload); purchase auto-order PostgreSQL (частичная поставка, отмена, полный приход); recipe depletion PostgreSQL (292 assertions); login/error, trusted-PIN return, protected default credentials; design/assets, platform, click, role, deploy и acceptance contracts; 
ode --check`, `git diff --check`, Docker Compose config.
- Временная PostgreSQL была отдельным контейнером `codex-hookah-qa-pg`, привязанным к `127.0.0.1:55433`, и удалена после тестов. QA использовал синтетические организации и товары; production-схема и бизнес-данные не затрагивались.
- Read-only доступ к VPS `/root/HOOKAH-CRM` проверен, но SSH отклонён (`Permission denied (publickey,password)`). Production-деплой из этой среды не запускался; для публикации на сервер нужен настроенный SSH-ключ/доступ. Текущий VPS остаётся на ранее записанном релизе `5f77a22`.
## 2026-10-01 — GitHub publication follow-up

- Проверенный релизный пакет опубликован fast-forward в GitHub: `codex/premix-batch-lifecycle`, feature commit `7dea2a0` (`Release warehouse, notifications and SaaS updates`).
- VPS публикация остаётся незавершённой: SSH с текущей среды получает `Permission denied (publickey,password)`; production не изменён и остаётся на `5f77a22`.
## 2026-10-01 — VPS deployment compatibility follow-up

- SSH succeeded using the existing `hookah-crm-vps` host alias and its configured key. The earlier `root@IP` invocation bypassed that SSH configuration; this was a command selection mistake in this chat, not missing VPS access.
- First deploy attempt created and verified a database backup, then stopped before service changes because `docker-compose pull` tried to fetch the locally built `hookah-pos` CRM image. Updated the release script to pull only `db` and 
ginx`, and build `crm` from the checked-out source. VPS uses Docker Compose v2.27 standalone; its configuration and the deploy script fallback both passed.
- Deployed code commit `8628f70` to VPS `212.192.0.58`. Pre-release PostgreSQL backup created at `/var/backups/territory-crm/territory-crm/crm-pre-1b3af824414eb3ee246ee753a1526672ea91d4c03d531b2519b44d82cc3be381.sql.gz`. Migrations 001–056 replayed successfully; menu seed synchronized 10 categories and 66 products. CRM, PostgreSQL and Nginx are running; Docker release label matches the persisted `deployed` release fingerprint; worktree is clean.
- Post-deploy read-only checks passed: container and public `/api/health` report `ok` with PostgreSQL; `/login`, `/platform`, `/inventory`, `/admin` returned 200 and referenced current assets (`style.css?rev=363`, `platform.js?rev=4`, `portal.js?rev=413`, notification bell present). No QA sale, receipt or stock movement was written to production.
- Full tenant login/role acceptance was not repeated against production accounts; local synthetic PostgreSQL/browser coverage passed above. The production post-deploy login script was not run because no tenant credential was provided to this task.

## 2026-10-01 — локальное согласование рабочего места и личности сотрудника

- Работа ведётся в отдельной `codex/local-reconcile-606800d`; основная dirty папка не перезаписывалась. `accab33` уже входит в основу. Сохранены серверная session authority, склад, header и deployment infrastructure из `606800d`.
- Найдены три причины симптомов: имя Мария в старой HTML dist-заглушке/кеше; fail-open восстановление имени/прав при ошибке сессии; циклические DOM-записи Telegram и VIP MutationObserver, блокирующие event loop. Отдельно CSS перебивал `button[hidden]`, делая запрещённые пункты видимыми.
- Реализованы серверная проверка личности без cached-role recovery, нейтральная начальная разметка, inert заказ и заблокированная смена при загрузке, поздняя загрузка профиля после подтверждения пользователя, guarded observer writes, scoped hidden CSS, retry чтения и отсутствие повторной записи по mutation timeout, сохранение venue/workspace маршрутов.
- Source/dist выровнены (app171, CSS365); новые runtime identity/session/observer QA и независимые architect/code-health/frontend/QA проверки прошли. В CUA-браузере новый локальный Роман с Telegram входит, сохраняет имя после reload, открывает профиль/заказы/задачи без freeze; запрещённые пункты скрыты. Полный отчёт: `docs/ai-team/STAFF_IDENTITY_RECONCILIATION.md`.
- Disposable PostgreSQL: schema+seed, persistence fixture creation и upgrade 56 миграций прошли. Не заявляем перезапуск приложения как проверенный на основании создания fixture. Production `/api/session` в этом шаге не проверен и production-БД не менялась.
- Временные скрипты/скриншоты tmp исключены из коммита. GitHub/VPS не публиковались. Дымовой фон — следующий этап активной цели; этот пакет не объявляется завершением всей цели.

## 2026-10-01 — подтверждение logout и живая PostgreSQL проверка

- Первопричина: POST /api/logout отвечал 200 до завершения удаления persisted session. Теперь сервер ожидает удаление и отвечает 503 при сбое; Bearer/cookie используют общий приоритет. Cookie очищается, клиент сохраняет возможность повтора и не объявляет выход успешным при ошибке.
- app/portal/PIN очищают локальную сессию и рассылают logout только после подтверждения 200/401; static demo совместим. Source/dist: app172, portal415, lock19, CSS365.
- Независимые code-health и architect/security проверки приняты. logout-persistence-runtime-qa, session-authority, local-lock, trusted-pin-return, staff-mode-navigation, local-role, local-design, header-shell, local-deploy, migrations и premix contracts — PASS.
- На disposable PostgreSQL подтверждены logout200 → тот же token401 → ноль auth_sessions; запрещённые сотруднику inventory/reservations/venue PATCH дают403. CUA-сессия Романа пережила перезапуск процесса без повторного входа; ранее созданный заказ сохранил quantity2 и сумму2400. Неверный PIN даёт ошибку, правильный возвращает к кликабельным заказам, подтверждённый logout открывает login. Детали: LOCAL_RECONCILIATION_PG_QA.md.
- GitHub/VPS не менялись. Дымовой фон разрешён пользователем с сохранением выбранного водяного знака и переносится следующим пакетом.

## 2026-10-01 — завершённый smoke-пакет и итог локальной сверки

- По явному решению пользователя выбранный watermarked Magic Hour MP4 перенесён без изменений в assets/dist/Docker. Общее auth-smoke CSS/JS подключено к login и PIN; old preview gate/tmp URL не переносились. Дополнены canonical allowlist, MP4 MIME/HEAD/Range/416, Docker COPY и безопасный build context.
- Первоначальный reduced motion/скрытый PIN не создают video; скрытие ставит на паузу; play/media failure оставляют неподвижный PNG. Guarded observer проходит convergence QA. Login получил штатный SVG-логотип, нейтральный setup example и исправленное центрирование после реального browser audit.
- Все новые smoke runtime/lifecycle/assets QA прошли, включая exact byte parity source/dist, HTTPHEAD/full/206/416/open/suffix/clamp/unsafe. Docker build/run и те же HTTP assets QA прошли. Повторены связанные auth, navigation, roles, header, static boundary, design, deploy и visual contracts, синтаксис/diff — PASS.
- CUA: desktop1280×800 и phone375×667, lowlogin320×480 без горизонтального overflow; реальный loop2.98→0.06; PIN-клавиатура, пауза после unlock, trustedPIN wrong/right и mobile drawer/logout. Browser404 fixture оставляет staticPNG; reduced-motion fixture не создаётvideo до изменения preference. Системная media настройка моделировалась fixture, это явно отмечено в отчёте.
- Independent code-health, architect/security и frontend/design reviews приняты. Итог11-коммитной сверки: LOCAL_RECONCILIATION_RESULT.md. Медиа provenance/границы: docs/requirements/AUTH_SMOKE_BACKGROUND.md. Временные QA services/data исключаются из release и очищаются после приёмки; archive строится только из committed candidate. GitHub/VPS не публиковались.
- Повторный visual audit низкого320×480 выявил старое max-height/overflow:auto у карточки и белую внутреннюю полосу. В auth CSS снято ограничение карточки, сохранена прокрутка страницы с общей тёмной тонкой полосой. Проверены верх (логотип/заголовок) и низ (поля/вход) при прокрутке; горизонтального overflow нет. Добавлен regression contract, desktop центрирование повторно подтверждено.

## 2026-10-01 — удаление Telegram-ссылки из панели сотрудника

- Запрос: убрать ненужную ссылку Telegram под кнопкой выхода, особенно заметную в компактной панели.
- Причина: mountStaffExtensions подключал отдельный staff-telegram-link.js, который добавлял контактный shortcut в footer. Удалён только этот loader из app.js/dist; приложение обновлено до rev173. Telegram как контакт в профиле и настройки интеграций сохранены. БД/API/права/маршруты не менялись.
- Regression: staff-mode-navigation-contract запрещает loader и ссылку в source/dist staff markup. node --check app.js/dist, navigation, local-login, logout-persistence, session-recovery, observer-stability, login-server-identity, local-role и header-shell — PASS.
- CUA на локальном memory QA 127.0.0.1:31907: создан synthetic Роман Тест с заполненным @romanqa; штатный вход, reload, профиль и logout проверены. После reload links=0/loader=false. Telegram-поле в профиле осталось; logout открывает /login, повторный вход успешен. На desktop и 586x764 footer без лишней ссылки; горизонтального overflow нет. Proof: tmp/identity-qa/sidebar-without-telegram.png и sidebar-without-telegram-586.png (не включаются в release).
- Независимые code_health_engineer, system_architect и frontend/design/QA reviews приняты. Локальный runtime оставлен для продолжения работы; данные QA временные. Главный dirty checkout не изменялся. GitHub/VPS не публиковались; архив 2550f46 остаётся историческим кандидатом и не содержит эту последующую правку.

## 2026-10-01 — рабочая шапка: смена и личные контролы

- Запрос: продумать удобное место кнопки смены и убрать постоянную рамку у настроек; объяснить отсутствие колокольчика у Романа.
- Причина визуальной неоднозначности: shift-toggle стоял рядом с названием страницы как зелёный текст, даже когда смена закрыта; warning glyph не совпадал с обычным действием. Личные контролы использовали разные стили. Кнопка перенесена в отдельную toolbar перед существующей user-группой: смена → настройки → блокировка → профиль. Закрытая смена нейтральная с часами, открытая зелёная; явные «Открыть»/«Закрыть», loading/saving/error состояния, доступные имена, цели44px/иконки18px. Settings/lock без постоянной рамки, focus-visible сохранён.
- Связанный старый дефект: после ошибки GET кнопка оставалась disabled до reload. Теперь error даёт повтор только GET; отдельные guards защищают чтение и отправку POST от дублей. API, tenant, финансовые правила, RBAC и поля запросов сохранены. Старый shift-close QA harness приведён к текущему staffFetchJson; добавлен staff-header-actions-runtime-qa.
- Notification source управленческий: notificationAccess не разрешает operational employee. На действующем local memory API Roman GET notifications403, owner200/unread0. Фиктивный bell и расширение доступа не добавлялись. Правила роли объяснены пользователю; постоянный bell для разрешённой роли не зависит от unreadCount.
- Обновлены VISUAL_PAGE_RULES/SITE_TREE/site-map и контракты; app174, CSS366, clock sprite6, source/dist синхронны. node --check app/dist, diff check, header-actions, shift-close, visual, header-shell, staff-nav, session-recovery, identity, local-role, local-design, local-static-boundary и notifications-api — PASS. Первоначальный вызов неверного имени static-public-boundary-qa заменён существующим local-static-boundary.mjs.
- CUA synthetic Roman: открытие формы и POST открытия0; reload сохраняет open; настройки открываются; форма закрытия открывается/отменяется. Close POST с0/checklistConfirmed:true выполнен через штатный API200; итог после повторного входа closed. Ошибка GET503 моделирована локальным HTTP proxy: кнопка retry доступна, после восстановления реальный клик возвращает open. POST/close/error/duplicate payload дополнительно проверены VM runtime. Production и реальная касса не затрагивались.
- Визуальные screenshots/измерения: desktop1280,900,760,650,586,375,320; на320 обнаружена обрезка аватара, сокращены отступы/подпись и повторно подтверждено полное размещение. Ошибка/retry320 также помещается. Proof в tmp/identity-qa/staff-header-*.png, вне release. Нативные браузерные комментарии перехватывали клик в аннотированной вкладке: функциональный путь проверен в чистой QA вкладке. Viewport reset, временный proxy31909/QA вкладки закрыты, пользовательская31907 обновлена и оставлена открытой.
- Независимые system_architect, code_health_engineer и frontend/design/QA reviews приняты. Только локальный коммит; GitHub/VPS не публиковались. Главный checkout сохранён. Исторический archive2550f46 не включает последующие локальные правки.

## 2026-10-01 — адаптивный логотип боковой панели

- Запрос: логотип не помещается в sidebar, нужны устойчивые правила размеров перед будущей заменой изображения.
- Первопричина подтверждена CUA: на viewport1024 sidebar210px, внутренний brand content161.2px, но picture190px/flex:0 0 auto; его правая граница214px выходила за sidebar210. object-fit применялся только к картинке внутри слишком широкого контейнера. В CSS два одинаковых staff блока и общий фиксированный portal блок.
- Удалены фиксированные/дублирующие правила. Один shared sidebar logo slot для portal/staff/platform: ширина min(190px,100%), max-width100%, shrink/min-width0, bounded frame200/64 высотой до61px. Картинка100%/100% contain, без crop/transform/искажения. До900 компактный symbol42×40, включая раскрытое admin меню. Исходные HTML размеры остаются hints, asset/upload/API/tenant branding не менялись. Логотип заведения не подменяет продуктовый sidebar бренд. CSS367 и source/dist синхронизированы.
- Обновлены VISUAL_PAGE_RULES/SITE_TREE/site-map; добавлен sidebar-brand-contract. brand, sidebar-nav, Fold responsive, header-shell, visual rules/live defects, local-design, static-boundary, staff-nav и staff-header-actions runtime — PASS; git diff check — PASS. Независимые system_architect/code_health_engineer/frontend-design reviews приняты.
- CUA: на1024 итог picture161.2×51.575 в границах brand content24..185.2. Подтверждены реальные размеры320/375/586/768/900/902/950/1024/1280/1440/1920; при быстрых resize некоторые requested viewport наблюдались с задержкой, в выводах использованы измеренные значения. На1920 logo190×60.8 без увеличения; compact42×40 помещается, горизонтального overflow нет. Сохранены proof sidebar-brand-1024/320/1280/final.png в tmp/identity-qa (вне release).
- Дополнительная локальная fixture с реальными CSS/classes staff/admin/platform проверяет wide4000×160, tall600×1600, square512×512 и исходный бренд: все входят в brand content на1024 и375; object-fitcontain сохраняет пропорции. Admin раскрытый drawer375 сохраняет bounded42×40 symbol. Это проверка геометрии будущего файла, не реализация загрузки/замены sidebar logo.
- Fixture31911 и её вкладка закрыты, viewport reset; пользовательская31907 оставлена открытой. Реальные учётки/БД не изменялись. Главный dirty checkout сохранён; только локальный коммит, без GitHub/VPS. Исторический archive2550f46 остаётся прежним кандидатом.

## 2026-10-01 — watermark дымового фона на ПК

- Причина: object-fit:cover оставлял нижний watermark одобренного MP4 в desktop viewport. Минимальная правка: от901px video и PNG texture scale1.2 с origin50%0 внутри существующего overflow:hidden. Форма/бренд/controller и исходные активы сохранены; CSSrev2 и lock22 синхронизированы с dist.
- CUA default1170×764,1024×768,1280×720,1920×1080: watermark не виден, video проигрывается, карточка381.6×584.95 не масштабируется. Shared PIN scene подтверждена synthetic brand_qa. Стабильные final raw screenshots и JSON в tmp/smoke-crop; первые resize captures исключены из evidence.
- Crop/login/lock/design/brand/static-boundary, smoke runtime/assets HTTP QA и независимые code_health/design/frontend/QA/release reviews — PASS. Подробности: docs/design/AUTH_SMOKE_DESKTOP_CROP.md. Мобильные проверки отложены. Главный dirty checkout, preview31907 и VPS сохранены; GitHub/VPS не публиковались.

## 2026-10-01 — разрешён выпуск накопленного пакета

- Пользователь разрешил commit/GitHub/VPS. Runtime baseline be9315ee интегрирует согласованные локальные исправления поверх606800d; dirty drafts/tmp/секреты исключены. Архитектор подтвердил отсутствие значимых функций вне candidate в заявленной области.
- Code-health/system-architect/release/QA reviews приняты. Docker build, dependency audit0 vulnerabilities, session/identity/observer contracts, изолированный PostgreSQL56migrations twice/legacy upgrade и shift-notification transactional/restart E2E — PASS.
- VPS backup gzip/restore PASS. Прежний dirty checkout606800d и image сохранены, volume territory-crm_pgdata остаётся. План публикации и отката: docs/design/RELEASE_2026_10_01.md. Domain/HTTPS и мобильная адаптация отложены. Post-deploy verification выполняется после штатного deploy.

## 2026-10-01 — production QA и исправление доступа сотрудника к гостям

- 3304cbb8 опубликован GitHub/VPS; штатный backup/migration/health PASS. PostgreSQL volume сохранён.28HTTPfiles совпали с Git blobs (сравнение с Windows working copies сначала отличалось CRLF/LF, исправлен способ QA). Smoke Range и platform owner login/session/logout PASS. Demo admin env password не является credential действующего tenant admin, поэтому этот аккаунт не использовался как доказательство admin QA.
- CUA production Roman: реальная identity, столы и заказы работают. Гости ошибочно redirect/admin: page guard staff_view расходился с APIorders. Минимальная правка: ordersORstaff_view на странице/ссылке и preferences, без кадровых grants. Найденное в этом же пути null.value при fill удалённых bonus/deposit fields исправлено проверкой наличия элементов.
- Source/dist portal417, actual route/link/fill VM regression, roles/sidebar/preferences/design/mode contracts PASS. Local synthetic staff create/reload/read/edit гостя PASS, финансовые поля отсутствуют. Architect/code-health/security/release QA reviews; дальнейшая публикация только этого проверенного дополнения. Прежние checkout/images/backup сохранены.

## 2026-10-01 — заполненная локальная QA база и полный регрессионный контур

Область: локальная проверка перед будущим коммитом/выпуском. Новый checkout HOOKAH CRM 2-reconcile, ветка codex/local-full-qa-20261001; исходный грязный checkout, старые сервисы, production сохранены. Auth true/demo false, приложение31932, заполненная PostgreSQL31930 в named volume и отдельная disposable regression31931. Setup/seed/server/full runner теперь воспроизводятся через npm qa:local:*; credentials/manifest/logs/screenshots ignored.

Seeder:2заполненных организации,3точки,328сущностей/340контрольных API действий и3идемпотентных прохода. После браузерных действий:21пользователь,27столов,15товаров,36ингредиентов,15inventory_recipe_cards,26гостей,10броней,34заказа,23платежа,25задач,6премиксов,12поставок,18расходов,13зарплатных записей. Пустая shell organization из миграции сохранена.

Причины и исправления: зависимые guest/floor/product/payroll селекторы требовали лишние права; добавлены минимальные DTO чтения без расширения записи. Старшие операционные роли допущены в portal. Личные финансы/отчёт приведены к payment.createdAt в timezone точки; closed checks считаются отдельно; static demo фильтрует actor+venue, late report response не меняет новый экран. PostgreSQL DATE брони сериализовался с host timezone сдвигом дня — выдаётся to_char YYYY-MM-DD, timestamps не меняются. График отклоняет некорректные даты/время до SQL. Audit before/after пропускали sensitive staff fields — общий recursive redaction на запись/чтение и legacy read, DB failure503. Исторические raw rows физически не переписаны.

UI: min-content grid каталога и auto rows вызывали выход кнопок/неравные baseline; исправлены minmax/min-width/rows. Light theme использует light brand и контрастную шапку/действия. Staff Задачи ранее фильтровали ready orders — теперь /admin#tasks и own-task navigation; SaaS hash выбирает ровно1active/aria-current. Admin native hash и3smooth scroll конфликтовали — единый portal-main navigator, sticky offset и no background reset; layout идёт к стабильному #floor-editor до async map.

Роли: system_architect —51сценарий/контракты/скролл/дизайн; data/security —seed guard, privacy иreservation PG; code_health_engineer —baseline, исправление stale test harness без снятия assertions, финальный runner и Docker/package review. Root выполнял browser QA и интеграцию. Независимые регрессии: schedule51, employeeUI26, dashboardnav27, app/SaaSnav113, scopedroles49, readfailure9, reservation12. Финальные суммарные результаты runner/Docker: docs/qa/LOCAL_FULL_CODE_HEALTH_2026_10_01.md.

Браузер: реальные входы owner/worker/senior/scoped/platform; создание/редактирование гостя, category/task, сотрудник task open->in_progress->done+refresh, order600cash150+card450+reload/autoclose, notes+reload/audit, reservation03.10 17:00+reload, payroll10%60руб draft+reload, desktop1280/1440dark/light, настройки/филиалы/уведомления. Доказательства и точные ограничения: docs/qa/LOCAL_FULL_BROWSER_2026_10_01.md; инструкции docs/qa/LOCAL_FULL_QA_GUIDE.md. Browser warnings/errors в финальном просмотренном интервале отсутствуют. Сначала был429 при параллельном seed, после завершения наполнение UI повторён; production rate limit не менялся.

Границы: мобильная проверка приостановлена пользователем; UI schedule creation отсутствует(API-only); Telegram в разработке; SaaS billing test/free; внешний принтер/оплаты/доставка сообщений и VPS не проверялись. Коммит, push и deploy этим запросом отложены на следующий этап. Отчёт не утверждает отсутствие любой будущей ошибки.

Дополнение final review: bootstrap portal не принимал cleaner/security/technician/other_staff, хотя server разрешает им finance_read. Допущены существующие авторизованные сессии этих ролей; portal fallback приведён к finance_read, без floor/orders/management. Tasks link остаётся проверяемым по effective orders, новых прав и кадровых credentials не выдаётся. Employee report/bootstrap regression36PASS. Первый полный tracked runner167/167PASS; окончательный rerun после совместимости этих ролей и Docker fingerprint описан в code health отчёте.

Финальное согласование: architect desktopvisual GO; data/security GO после encodeURIComponent launcher и исправления setup->serve->seed guide. Full runner167/167PASS(2guards/123static/17memory/25PG)01.10.2026 11:10:52–11:12:38UTC; после launcher-only escaping125/125static+guardPASS11:13:47–11:13:58UTC. Navigation/launcher actual-source123casePASS, employeeUI36PASS, dashboardnav27PASS. Syntax251/251, audit0, diffcheckPASS. Docker final11:14:21UTC image sha256:e918ebb2eabafb4806dc17eebf22e887a9056a347f90c8665bd5268b77c31c8b; source418a8e227690cb2647f4f5155b02ef32860d8a57fd87901296b132aa987894c6;360files/359COPYexact stable, healthy/auth/privacy smokePASS, privatefilesexcluded. Own temporary containers/locks очищены, заполненнаяБД31930 иapp31932сохранены. Финальный health200ok. Вкладка локальнойCRM сохранена; временный viewport reset. Git commit/push/VPS не выполнялись.

## 2026-10-01 — редактирование логина и контактной почты сотрудника

Локальная ветка codex/staff-identity-contact-20261001 поверх9c0b498b, checkout reconcile; исходный dirty checkout сохранён. Карточка /admin#staff теперь содержит контактную почту и логин с подтверждением завершения сеансов. RBAC/tenant, protected accounts, глобальная уникальность, reserved names, формат и configured-password проверяются сервером. PG транзакция связывает профиль/rename/revoke/audit; session row locking закрывает гонку входа. Email-only сохраняет сеансы; пароль/PIN не меняются, контактная почта не активирует восстановление. Migration057 nullable users.contact_email, без backfill, повторная идемпотентность проверена; Docker helper и source/dist включены.

Браузер выявил ISO DATE → пустой date input → потерю employment date; to_char calendar DTO и regression исправляют первопричину. pinConfigured/pinUpdatedAt исправляют ложный статус PIN. Own rename+PIN guard предотвращает потерю PIN при redirect. Светлая карточка получила контраст PIN/селекторов. Независимые architect, security/data, code_health reviews GO.

Полный runner170/170PASS; PG identity134, race20; поздний client guard/demo69PASS; syntax/diff/parity/visual contractPASS. CUA owner/admin/worker: confirmation, duplicate rollback, email save/clear/reload, date preservation, old/new login/correct identity, protected readonly, dark/light desktop. Тестовый login восстановлен. Отчёт docs/qa/STAFF_IDENTITY_CONTACT_2026_10_01.md. Мобильные проверки приостановлены. Production/реальные пользователи не изменялись; commit/push/deploy этой функции не выполнялись.
Поздняя проверка после CSS/документов: static runner126/126PASS; повторный light-access screenshot подтвердил контраст PIN блока. Оригинальная dark preference восстановлена, локальная карточка оставлена открытой для просмотра.

## 2026-10-01 — поведение и прокрутка бокового меню

Локальная задача в reconcile на codex/staff-identity-contact-20261001, накопленные правки сохранены. System architect владеет контрактом; независимые design/frontend/QA и code_health audits приняты. Причины: шесть независимых remembered-open флагов растягивали дерево до 1405px при области 491px; CSS явно рисовал вертикальную полосу; hover translateX(2px) создавал горизонтальное переполнение; staff admin-return grid имел избыточную min-content ширину.

portal.js: singleton disclosure v2 по user+venue+canonical route, максимум одна группа, разрешено закрыть все, reload уважает ручной выбор. Старые флаги игнорируются. Back/Forward исправлены сохранением результата нормализации и отказом от устаревшего storage при несовпадении memory route. Hidden groups закрываются, права и маршруты сохранены. style.css: hidden scrollbar chrome с сохранённым wheel/keyboard scroll; desktop44px targets,2px child gaps,42px text alignment, hover без смещения; ограниченный grid admin-return. Source/dist portal422/style373 синхронизированы, VISUAL_PAGE_RULES/SITE_TREE обновлены.

CUA localhost31932: шесть групп по одной, повторный клик, reload, stock→manual menu→products→Back inventory→Forward menu PASS. Dark/light desktop1170×764, low-height1170×560, wheel, Enter/Space/Tab до выхода; staff/admin horizontal widths210=210 и nested182=182, main scrollbar сохранён. Финальные скриншоты ignored tmp/full-local-qa/, отчёт docs/design/SIDEBAR_BEHAVIOR_2026_10_01.md. Actual-source VM52/52, static runner128/128, syntax/diff/source-dist parityPASS; architect/code_health GO. Низкий viewport сброшен, dark preference восстановлена, вкладка локальнойCRM оставлена открытой. Мобильные/Fold проверки приостановлены пользователем; SaaS layout не перестраивался. Commit/push/VPS не выполнялись.

Повторная приёмка: пользователь сообщил зависание и нежелательный дизайн. Старая вкладка49 дала CDPtimeout, затем была удалена из сеанса; приложение как причина не доказано. Свежая50: шесть групп и18повторных pointerclick послеreload PASS, реальные переходы8страниц PASS, console errors0. Защита once-binding и actuallistenersARRAY61/61 регрессия; обработчики не дублируются. Home excess8+18px заменены единым4px gap,44px rows,14/600 headers,14/400 children, quiet openbackground. Breadcrumb11templates из существующего GETvenue/name; бренд сохранён; longnameellipsis. Browser1480×764 widths266=266/root230=230. portal423/style374 source/dist; headercontract+9relevantsuites+codehealthGO. Screenshot sidebar-revised.png, детали designreport. Commit/push/VPS не выполнялись.

Пакет замечаний по экранам финансов, склада и форм: общие native/custom-select/date/button controls получили единый rhythm44px, payroll48px, перенос сеток и long text fixes; светлая тема получила корректный color-scheme для календарей. Видимые складские KPI получили keyboard/mouse navigation с понятным route/target; переход «Нужно пополнить» → `/inventory?view=auto-orders`, карточка «Премиксы» → `/inventory?view=premixes` проверены в браузере. portal425/style375 синхронизированы, static129/129PASS. Отдельная следующая задача: lock/archive сотрудника с аудитом и сохранением истории; пока только зафиксирована модель поведения, backend/UI не менялись.

2026-10-02 — SaaS/POS boundary и доступ владельцев SaaS: добавлен CI guard по SaaS/POS-owned UI файлам и карта shared API/auth/models; отдельный `platform.css` добавлен в allowlist и Docker image без изменения маршрутов/портов. Управление владельцами переведено на отдельные диалоги: правка имени/логина, повтор пароля, смена пароля с завершением сессий, блокировка/разблокировка, передача главного владельца; сброс создаёт одноразовую ссылку (30 минут, однократное использование) для ручной передачи — SMTP в проекте отсутствует. Вход поддерживает установку пароля по ссылке в URL fragment; после успеха fragment и парольные поля очищаются. Локальные проверки PASS: platform SaaS, login (38), boundary self-test, click, deploy, roles, insights, date, static boundary, node syntax. `local-design-contract` PASS на исходных POS-копиях с rev=426; POS UI/logic не менялся. Добавлен и проверен `--saas-only` режим публикации, который не посещает POS HTML. Локальный Docker `hookah-pos` health PASS; runtime пока содержит старую версию (platform.css → 404). Контейнеры и постоянная БД не пересобирались/не изменялись; API/DB lifecycle тесты не запускались, так как доступная база — persistent `crm` volume, а выделенная disposable QA DB не указана. Commit/push/deploy не выполнялись.

2026-10-02 — Hookah POS audit: локальные source/dist HTML с устаревшим portal.js?rev=425 обновлены до актуального rev=426; SaaS-файлы и сервер не трогались. Sidebar menu/navigation/disclosure/scrollbar/brand, role, login и local-design contracts PASS; Docker runtime health ранее PASS на 127.0.0.1:45636. Commit/push/deploy не выполнялись.

2026-10-02 — POS backlog reconciliation: сотрудник уже поддерживает блокировку, разблокировку и owner-only архивирование с backend routes, подтверждением и audit; отдельная реализация не требуется. staff-active-count, staff-mode-navigation, staff-pin-passport (contract/runtime) и observer stability PASS. Старое упоминание lock/archive как незавершённого считать историческим.

2026-10-02 — POS backlog reconciliation: закрытие заказа уже собрано транзакционно в PostgreSQL (lock order, payment, stock depletion, order_costs, closure) и защищено от повторного закрытия; memory fallback также покрыт. order-close-transaction, recipe depletion contract/QA, paid-order-balance-memory и order-item-close-guard PASS. PostgreSQL runtime QA skipped because MIGRATIONS_PG_TEST_DATABASE_URL is not configured; persistent Docker DB не использовалась как disposable QA.

2026-10-02 — POS backlog reconciliation: складские автозаказы, приходы и движения уже покрыты. Auto-order pending, purchase payments contract/API validation/runtime, inventory movement transaction, critical state, recipe chain и inventory responsive QA PASS. Отдельная реализация этого блока не требуется; PostgreSQL E2E остаётся отдельным окружением.

2026-10-02 — POS backlog reconciliation: касса/смены/финансы static contracts PASS (shift attribution, finance consistency, chart empty state, KPI design). local-billing-contract не запустился, потому что он жёстко ожидает Node на 127.0.0.1:3000; текущий локальный Docker слушает 45636. Это ограничение тестового launcher, не доказательство дефекта POS.

2026-10-02 — POS visual/browser QA: interface-sidebar-browser-qa.mjs PASS at 375x800. Preferences for hidden inventory and quick dashboard module persisted across admin, stock/products routes and in-page route changes; no port changes or production access.

2026-10-02 — POS responsive QA: fold-responsive-contract PASS (33 invariants). responsive-emulator-runtime-qa requires a separately launched disposable server (default 127.0.0.1:3239) and was not run against persistent Docker DB; no application ports or data were changed.

2026-10-02 — POS responsive runtime QA infrastructure: scripts/responsive-emulator-runtime-qa.mjs now starts a disposable in-memory server on an OS-assigned port when CRM_QA_URL is absent and terminates it in finally. Full runtime PASS across 19 viewport sizes and routes /admin, /orders, /; touch drawer, payment dialog, Fold state preservation and zero horizontal overflow verified.

2026-10-02 — POS smoke gate after commits 60c43f62/8d9b6d37: syntax, sidebar menu/navigation/disclosure, roles, design, order transaction, inventory movement и responsive emulator (19 viewport/3 routes) PASS. Generated screenshots restored; no runtime data or fixed ports changed.
2026-10-02 — Continuation QA: перечитан goal-objective.md, локальный `hookah-pos` project/volume не изменялись; все три контейнера healthy, `/api/health` вернул PostgreSQL ok. `/platform.css` по текущему runtime по-прежнему 404, что подтверждает: работающий образ старый. Boundary `--working-tree` теперь учитывает untracked files; PASS — 9 SaaS-owned, 0 POS content changes, 23 shared/other. SaaS/login/design/role/static/click/deploy/date/insights contracts PASS. Новый браузерный preview через `file://` отклонён политикой CUA; обход не предпринимался. Обновлённый runtime/browser и owner lifecycle с тестовой БД остаются непроверенными из-за запрета менять контейнеры/БД и отсутствия специальной disposable QA базы.

2026-10-02 — SaaS UI polish: заблокированные владельцы теперь визуально отличимы от активных, а кнопки управления владельцами имеют высоту 44px для удобного нажатия; CSS cache revision `/platform.css` повышен до 2, исходная страница и dist синхронизированы SaaS-only командой. Platform SaaS, login (38 checks), boundary `--working-tree`, JS syntax и `git diff --check` PASS; POS-owned content changes: 0. Browser/runtime QA не выполнялся, чтобы не перестраивать общий контейнер во время текущей разработки Hookah POS.

2026-10-02 — SaaS/POS documentation and static-boundary review: найдено, что `platform.css` revision была вручную задана в HTML, но asset-sync не поддерживал её как управляемое значение. Добавлена единая `platformCssRevision` для обоих режимов синхронизации и контрактная проверка соответствия HTML этой ревизии. SaaS-only sync, SaaS contract, boundary guard, syntax и diff check PASS; POS-owned content changes: 0. Общий runtime, Docker и база не затрагивались.

2026-10-02 — SaaS dashboard polish: welcome/onboarding блок «Три шага» теперь появляется лишь после успешного чтения списка и только когда компаний нет; после создания первой организации обзор освобождается под реальные показатели, при ошибке загрузки пустое состояние не имитируется. Обновлены platform visual rule и статический контракт; SaaS, design, visual-page-rules, boundary, syntax и source/dist parity PASS. POS-owned content changes: 0. Browser QA пропущен, чтобы не вмешиваться в общий runtime во время разработки Hookah POS.

2026-10-02 — SaaS control mapping review: навигация панели теперь отражает выбранный hash-раздел и пункт «Тарифы» ведёт к отдельному каталогу тарифов; первый onboarding шаг открывает форму компании, тарифный шаг явно подписан как просмотр; состояние health больше не заявляет проверку tenant isolation. Защищены повторные отправки формы владельца и повторные клики owner actions. Platform/login/click/design/visual/boundary contracts, синтаксис и source/dist parity PASS; live browser/database mutation QA отложен из-за общего runtime активной разработки Hookah POS, POS-owned content changes: 0.

В том же SaaS control-flow audit исправлен ответ при смене email владельца на уже занятый: уникальный конфликт БД теперь возвращается как HTTP 409 `owner_login_already_exists`, который интерфейс переводит в понятную подсказку вместо общей ошибки сервера. Runtime/DB E2E не запускался.

## 2026-10-02 — Personnel reference layout and drawer lifecycle

- Rebuilt the staff catalog with its own scoped card markup: circular portraits, owner marker, status, readable contacts, gradient card button and labelled block/restore action. Removed accumulated catalog overrides and the redundant outer panel. Existing sidebar, SaaS, ports and staff API are unchanged.
- Fixed detached staff drawers accumulating on hash navigation; route changes dispose the drawer, remove duplicate form IDs and leave no scrim. Phone type and number occupy full rows at 320px.
- Real local browser QA: staff-profile-browser-qa PASS (create/edit/reload, PATCH/GET failure, retry, block/restore, 320px); staff-catalog-visual-browser-qa PASS (avatar upload/reload, search, open drawer across staff/permissions/tasks/help/settings/home, 390–1920px). API_RATE_LIMIT override is confined to the ephemeral test server.
- Visual comparison at 1586×992 used the supplied personnel reference. Actual photos, names and available contacts remain real data; portrait quality is not synthesized. Server publication has not been performed for this entry.
- Final staged package was tested independently from unrelated working changes: all three staff browser QA passed. Sidebar static contract was updated to the existing single-open-group behavior (runtime menu unchanged); sidebar, dashboard navigation and visual-page contracts passed. Cache revisions are synchronized across published HTML entries.
## 2026-10-02 — Проверка меню после нового каталога персонала

Проверено локально на localhost:31932 через отдельную браузерную сессию: 28 подпунктов POS меню фактически нажаты; адрес и заголовок получены после каждого перехода, скриншоты и отчёт сохранены в tmp/menu-audit/. «Остатки» канонически переходят с ?view=stock на /inventory. На всех проверенных экранах отсутствовали JS pageerror, горизонтальное переполнение и оставшиеся staff overlays; одновременно раскрыта одна группа. На рабочем зале — отдельное меню.

Ограничение: это проверка навигации после изменения карточек, не полная приёмка всех бизнес-сценариев. При быстром автоматическом обходе были HTTP429; в memory-local два финансовых API требуют PostgreSQL и вернули503. Повторный вход тестового admin ограничен двумя устройствами. Никаких выводов о полной исправности этих API не сделано.

Пользователь уточнил границы: только отсутствие регрессии меню от дизайна персонала. Попутные правки статуса смены, заголовков справочных страниц и тестов отменены; чужие текущие изменения сохранены. Production/GitHub в этом аудите не изменялись.
## 2026-10-02 — loyalty phase 9: зачёт предоплаты в заказ завершён локально

## 2026-10-02 — loyalty phase 8: приём предоплаты брони

- Реализована отдельная таблица квитанций `reservation_pre_payment_receipts` и миграция `064_reservation_pre_payment_receipts.sql`. Предоплата фиксируется по подтверждённой брони, текущей смене, сотруднику и способу cash/card/QR; ограничивается требуемой суммой, атомарно пишет аудит и повторно возвращает квитанцию только для того же venue/брони/payload. Старый `deposit_paid` оставлен нетронутым и блокирует приём до ручной сверки.
- Экран бронирований показывает требование, подтверждённые квитанции, полученное и остаток. История гостя перечитывает квитанции. Отмена не возвращает и не переносит деньги; показывает предупреждение о нерешённой предоплате. Текст формы больше не обещает пока недоступный зачёт в заказ.
- Предоплаты выделены в сменных KPI и не считаются выручкой заказа; при закрытии смены в ожидаемую наличность включаются только cash-квитанции. Memory/demo путь приведён к venue-wide idempotency и отказу при повторе ключа на другой брони. Сквозной PostgreSQL QA теперь проверяет чужую точку, повтор/конкуренцию, legacy, отмену, лимит, историю, KPI и наличную сверку.
- Реестр автоматически проверяет последовательные номера этапов L01… и подпунктов L01.1…, отсутствие закрытых этапов после открытых и работу с первым незавершённым подпунктом. Позиционный номер, процент и остаток этапов/подэтапов вычисляются из этого реестра.
- Review: архитектор и финансы — PASS после исправлений; code-health — PASS по API, базе, интерфейсу и сменам. Уточнены временные границы: перенос в заказ и возвраты принадлежат последующим этапам. Отчёт по сотруднику считает дневные квитанции временем приёма; ночная смена требует дальнейшего единого правила бизнес-даты и проверки в этапе отчётности.
- Backup локальной БД `tmp/local-loyalty-backups/crm-before-loyalty-phase8-20261002.dump` создан и проверен через `pg_restore -l`. После всех проверок миграция 064 применена штатным 
ode scripts/migrate.js`; локальный CRM image пересобран и сервис здоров. До/после совпали: 3 гостя, 5 движений ledger, 3 заказа, 2 брони, 2 смены, 3 000 ₽ денежных остатков и 1 500 ₽ старого `deposit_paid`; проверенные квитанции предоплат — 0, баланс verified — 0. Старые суммы сохранены, не переписаны.
- Финальная проверка локальных маршрутов: `/api/health`, `/reservations`, `/portal.js?rev=433`, `/style.css?rev=383` — HTTP 200; форма ссылается на актуальную версию скрипта. PASS: syntax затронутого кода, прогресс-валидатор, memory предоплата, форма брони, shift transaction, account ledger, paid-order balance, PostgreSQL предоплата с HTTP/auth/concurrency/cross-venue/кассой, локальная дата брони на полной одноразовой миграции и finance shift analytics; `git diff --check`.
- Отдельный старый `shift-cash-postgres-e2e-qa.mjs` остаётся несовместимым с текущей реализацией payment API: изолированный handler harness получает 409 на оплате (до проверки close), поскольку fixture извлекает только маршрут и не предоставляет актуальные pricing/bonus helpers. Тестовый файл возвращён к исходному состоянию; кассовое поведение этапа подтверждено новыми end-to-end предоплатными QA и shift transaction QA.
- Локальный релиз завершён; этап 8 закрыт. Следующий реестровый пакет — этап 9 «Перенос предоплаты брони в заказ». Для двух исторических броней (`deposit_paid` суммарно 1 500 ₽) новый приём блокируется до ручной сверки. GitHub/VPS не трогались.

## 2026-10-02 — loyalty phase 7: денежный счёт гостя завершён локально

- Добавлена миграция `063_guest_deposit_receipts.sql`: tenant-scoped квитанция денежного пополнения фиксирует гостя, сумму, метод, смену, кассира, основание и idempotency key; отдельно создаётся положительное движение обязательства и обновляется остаток. Пополнение не записывается как продажа/платёж заказа. Повторы возвращают прежнюю квитанцию, изменённый payload с тем же ключом отклоняется.
- Добавлена форма пополнения в карточке гостя и повторное чтение журнала; роль `orders` может видеть гостевые операции для сверки. POS принимает `deposit` как отдельный тендер при выбранном госте, атомарно списывает остаток и защищает от отрицательного баланса. Cash top-ups включены в расчёт наличности, а KPI смены показывают их отдельной строкой «не выручка» с cash/card-QR/count. Демо/memory пути и tenant guard согласованы с PostgreSQL.
- Добавлен машиночитаемый `docs/requirements/LOYALTY_ROADMAP.json` и 
ode scripts/loyalty-progress.mjs`. Номер этапа вычисляется по позиции, процент — по завершённым подэтапам; номера не хранятся и вручную не сдвигаются. Этапы 1–7 закрыты; текущий автоматически стал этапом 8.
- До локальной миграции создан проверенный backup `tmp/local-loyalty-backups/crm-before-loyalty-phase7-20261002.dump`. Локальный migration replay завершился успешно; CRM пересобрана. `/api/health` вернул PostgreSQL OK, `/clients/` — HTTP 200 и `portal.js?rev=431`/`style.css?rev=383` отвечают HTTP 200. После миграции сохранены 3 гостя, 5 записей журнала, 3 заказа и сумма денежных остатков 3 000 ₽; новых квитанций нет; сверка балансов с журналом: 0 расхождений.
- PASS: `paid-order-balance-memory-qa.mjs`, `guest-account-ledger-memory-qa.mjs` (включая cross-venue отказ и shift KPI), `paid-order-balance-postgres-qa.mjs` через безопасный disposable PG runner, `clients-editor-contract.mjs`, `order-close-transaction-qa.mjs`, 
ode --check` затронутых JS/MJS и `git diff --check`. Финансовый review и итоговый code-health review не обнаружили блокирующих замечаний в объёме этапа. Ручной авторизованный браузерный сценарий не проводился из-за отсутствия сессии; маршруты, версию клиентского asset и API-ответ health проверили локально.
- Следующий этап по реестру: приём фактической предоплаты брони с отдельной квитанцией и кассовым учётом. Перенос в заказ, возвраты/reversal, утверждение бизнес-настроек акций и полный end-to-end остаются следующими этапами. GitHub и сервер не менялись.

## 2026-10-02 — Справочник цехов и назначение пользовательских профилей

- Уточнён экран `/inventory?view=directories`: основная структура склада теперь стоит выше дополнительного каталога табачных смесей; уровни «цех → подцех → категория → позиция» подписаны человеческими словами и примерами.
- Список подцехов перенесён между списками цехов и категорий, формы создания размещаются рядом со своим справочником. Категории показывают полный путь и помечают область «весь цех».
- В форме складской позиции подцех выбирается из вариантов текущего цеха, поле объясняет необязательность и место создания. Ошибки загрузки подцехов/категорий можно повторить; read-only сотрудникам не показываются кнопки изменения/архивации.
- Пользовательские профили в карточке сотрудника не скрываются при ошибке загрузки; назначение принимается только для активного профиля той же организации и точки. При недоступной БД API явно отказывает, чтобы сохранение не выглядело успешным.
- Проверки: 
ode --check` затронутых JS; `scripts/inventory-hierarchy-contract.mjs`; `scripts/inventory-subdepartment-api-qa.mjs`; `scripts/local-role-contract.mjs`; локальная браузерная проверка страницы справочников и селектора позиции. База открытого локального процесса — memory, поэтому запись созданных справочников в PostgreSQL через этот экземпляр не проверялась. Сервер/GitHub не затрагивались.

## 2026-10-02 — Персональные виды каталога сотрудников

- В `/admin#staff` добавлены три представления: фотоплитки (по умолчанию), компактный список и таблица с выровненными колонками. Поиск/фильтры и текущие действия остаются общими для всех видов; на узком экране табличные строки складываются в подписанные карточки.
- Размер плиток задаётся четырёхступенчатым слайдером и изменяет минимальную ширину плитки/размер аватара. Переключатель и слайдер доступны с клавиатуры и имеют видимый фокус.
- Настройки сохраняются в `users.preferences.staffDirectory` для авторизованной учётной записи через `/api/session/preferences`. Сервер валидирует значения, объединяет вложенные ключи и сохраняет tenant/user-scoped поведение; миграция не нужна. Добавлен локальный fallback, ключ которого зависит от текущего пользователя.
- Поиск теперь показывает пояснение при отсутствии совпадений.
- Проверки: 
ode --check portal.js`, 
ode --check server.js`, 
ode scripts/local-preferences-contract.mjs`, 
ode scripts/visual-page-rules-contract.mjs`, `git diff --check`; браузер на `localhost:31932` подтвердил все виды и восстановление после обновления. Изолированный Playwright QA проверил отдельные owner/manager предпочтения, серверную валидацию диапазона, сохранение после reload, поиск без совпадений, наличие действий в плитках/таблице и отсутствие горизонтальной прокрутки на 390/620/768/1440px. Работа осталась локальной, GitHub и production не менялись.

## 2026-10-02 — Архив, восстановление и подтверждаемое удаление справочников склада

- Аудит выявил: цеха, подцехи и категории архивировались флагом `is_active`, но API возвращал только активные записи; UI не показывал архив и восстановление. Архивирование подцеха выполнялось без подтверждения, категории назывались «Скрыть», demo-ветка справочников не полностью повторяла серверную логику.
- Добавлены статус-фильтры API, восстановление с проверкой родительского цеха, единое переключение «Активные / Архив», восстановление из списка и согласованные подтверждения архивации. Архивные справочники не попадают в формы складских позиций. Категорию с привязанными позициями нельзя архивировать.
- Постоянное удаление выделено в отдельный путь: владелец удаляет архивную запись после подтверждения только при отсутствии зависимостей; управляющий может подать запрос, который доступен владельцу в разделе справочников. Решение повторно валидирует ссылки в транзакции, все действия tenant-scoped и фиксируются аудитом. Добавлена миграция `066_inventory_deletion_approvals.sql` и API контракт.
- Проверки: 
pm run qa:inventory`, 
ode --check server.js`, 
ode --check portal.js`, проверка сценария в `inventory-hierarchy-contract.mjs` и `git diff --check` прошли. Code-health review выявил и помог закрыть гонки при восстановлении категории/подцеха, сверку parent в memory, проверку товарных ссылок категории и закрытие ожидающего запроса при прямом удалении владельцем.
- Локальный браузер показал раздел справочников и переключатель «Активные / Архив», но запущенный `localhost:31932` использует memory-режим и уже загруженную старую версию backend: панель запросов владельца получает ошибку, потому что новый API ещё не загружен в работающий Node-процесс. Процесс не перезапускался, чтобы не потерять его временные данные. PostgreSQL integration QA недоступен: `MIGRATIONS_PG_TEST_DATABASE_URL` не настроен. GitHub и production не затрагивались.

## 2026-10-02 — Проверка справочников склада и поиск техкарт

- Проверка текущего кода подтвердила: архивирование цехов/категорий и восстановление уже есть; окончательное удаление доступно из архива с подтверждением владельца, а управляющий отправляет запрос владельцу. Изменение категории подключено к форме и PATCH API. Активные связанные справочники нельзя удалить напрямую, чтобы не потерять привязки.
- В технологические карты добавлены свободно задаваемая категория (с подсказками существующих категорий), фильтр по категории и строка поиска по названию, категории, связанному товару, ингредиентам, технологии и подаче. Категория отображается на карте и сохраняется в памяти или PostgreSQL; создана миграция `067_recipe_card_categories.sql`. Поиск/фильтр работают также в режиме просмотра без права редактирования.
- Синхронизированы локальные опубликованные assets для склада и версия `portal.js` 435. Новая миграция в локальную PostgreSQL не применялась: тестовая база не настроена, а работающий localhost процесс использует загруженный старый backend и временное memory-хранилище; его не перезапускали, чтобы не потерять данные.
- Проверки PASS: JS syntax; `recipe-directory-contract.mjs`; `recipe-form-pending-qa.mjs` (включая передачу категории при создании); `premix-contract.mjs`; `recipe-depletion-contract-qa.mjs`; `recipe-depletion-runtime-qa.mjs` (87 проверок); 
pm run qa:inventory`; `git diff --check` по затронутым текстовым файлам. Code-health review подтвердил read-only поиск/фильтр и не нашёл другого дефекта в просмотренных путях.
- GitHub и production не затрагивались. Для полного live PostgreSQL/browser E2E нужна настроенная локальная QA-база, чтобы применить миграцию и запустить новый backend.
## 2026-10-02 — loyalty phase 11.6 underway: shared promotion evaluator and receipt snapshot

- Добавлен общий `loyalty-pricing.js`: group/manual/promo сравниваются по округлённой сумме без сложения; eligibility считает подходящие строки текущего заказа по product/category, исключения перекрывают включения, percent/fixed не превышает eligible basis; период полуоткрытый `[startsAt, endsAt)`, при равной сумме promo priority и ID дают стабильный порядок, затем promo > group > manual (прежний group > manual сохранён).
- PostgreSQL order pricing загружает актуальные версии промо и категории товарных позиций; memory pricing использует тот же evaluator. Payment quote отдаёт `offers[]`, POS показывает выбранное/исключённое предложение и причину. При закрытии заказ пишет versioned promotion terms и offers snapshot; closed read использует его без переоценки. Bonus/deposit/reservation logic не менялась.
- Добавлена replay-safe migration 074 и schema.sql parity, FK venue+promotion version, snapshot constraints; helper включён в Docker image. Локальная БД получила backup `tmp/local-loyalty-backups/loyalty-before-pricing-20261002.dump` (261726 bytes, archive list проверен), migration применена, CRM пересобран и healthy.
- Проверено: syntax server/helper/app/dist; pure evaluator QA (scope, exclusion, fixed cap, priority, tie, `[start,end)`); POS contract, campaign contract/memory QA, migration contract (75 файлов), isolated PG paid-order regression и migration upgrade — PASS; local `/api/health`=postgres, app.js HTTP 200. Попытка параллельно запустить два PG runner дала их штатную блокировку; сериализованный повтор migration-upgrade прошёл.
- Важное ограничение: activation остаётся отклонена. Ещё не согласованы цены открытых заказов после активации при частичной оплате и SQL pending revenue/отчётов с промо. Следом закрыть эти стыки и сделать PG evaluator/receipt end-to-end; визуальный авторизованный проход остаётся L13.3. GitHub/VPS не затрагивались.

## 2026-10-02 — loyalty phase 11.5: promotion drafts and scoped campaign management

- Добавлена отдельная модель кампаний `loyalty_promotions` + product/category scopes: площадка, неизменяемые версии, draft/archive, UTC start/end + IANA timezone, percent/fixed размер, приоритет, включённые/исключённые условия. Новая кампания всегда черновик; активация отвечает 409 до реализации L11.6. Изменение условий создаёт версию; архивирование добавляет версию со старыми условиями. PostgreSQL аудит и запись атомарны, history защищена trigger.
- В `/admin#loyalty` добавлена форма/list акций с товарами и категориями, периодом через timezone заведения, percent/fixed величиной; owner/admin-only mutation. Условия валидирует сервер по активному каталогу текущего venue. Старые связи можно архивировать/редактировать после деактивации товара; в новую область нельзя добавить неактивный товар. Настройка кампании не меняет цену, тендер, бонусный/денежный ledger, депозит или выручку.
- Подтверждено: `LOYALTY PROMOTIONS CONTRACT`, `LOYALTY PROMOTIONS MEMORY QA`, `LOYALTY PROMOTIONS POSTGRES QA` (RBAC, stale venue/version, tenant isolation, audit rollback, same-venue scopes, version reread, archive, immutable DB history), `MIGRATIONS CONTRACT`, PostgreSQL upgrade QA. 
ode --check` server/portal/QA, source/dist parity, `git diff --check` — PASS.
- Локально создан и проверен архив БД до изменений: `tmp/local-loyalty-backups/crm-before-loyalty-promotions-20261002.dump` (252006 bytes). Образ `hookah-pos:unreleased` пересобран, migration 073 применена, CRM перезапущен и health=`postgres`; `portal.js` HTTP 200. Локальные counts до/после: 3 guests / 3 orders / 2 payments, не изменились. Визуальная авторизованная browser-проверка отложена в L13.3; никаких реальных пользовательских учетных данных в QA не вводили.
- Автосчётчик закрыл L11.5 и активировал L11.6; система не завершена. L11.6 остаётся расчётом/выбором предложения и объяснением в POS. GitHub/VPS не менялись.
## 2026-10-02 — loyalty phase 11.3: versioned policy and POS explanation

- Политика версионирована в `loyalty_program_settings`, GET доступен по venue scope, PATCH только owner/admin; изменение версии и аудит атомарны. Money defaults сохранены: 1 бонус = 1 ₽, cap 100%, минимум первой операции 1, expiry выключен. Новые заказы фиксируют политику при создании; снимок базы списания добавляется при первом бонусном тендере. Старые заказы работают на v0 defaults; split переносит snapshot.
- Тесты покрывают memory/PostgreSQL defaults, запись/повторное чтение, manager deny, отдельную площадку, stale venue/version, ошибку аудита с rollback, cap/minimum и сохранение снимка открытого заказа при последующем редактировании. POS раскрывает сумму и источник скидки, процент групповой программы, предварительное начисление, cap и минимум списания.
- PASS: 
ode --check` для server/db/app/portal и QA; `paid-order-balance-memory-qa.mjs`; PostgreSQL paid-order E2E через disposable runner; миграционный контракт/upgrade/runtime (73 файла, upgrade 38+35). POS explanation contract проверяет и `app.js`, и синхронный `dist/app.js`. Полный static suite остановился на старом несвязанном `admin-section-heading-contract.mjs`: тест требует «Сотрудники», но `portal.js` уже показывает «Персонал».
- Backup: `tmp/local-loyalty-backups/crm-before-loyalty-order-snapshot-20261002.dump` (251 776 bytes, restore list 493 entries). Исходный образ не содержал новый 072 файл, поэтому сначала пересобран `hookah-pos:unreleased`; после этого применено 73 миграции. Локальные проверки: API health `postgres`, settings/admin/portal.js rev439/app.js rev182 HTTP 200; counts до/после остались 3 guests, 5 guest ledger entries, 3 orders, 2 payments, 0 settings rows, 0 order snapshots. Штатный статический suite имеет указанный выше независимый старый отказ. L11.3 закрыт после профильной QA и миграции; авто-счётчик активировал L11.4. GitHub/VPS не менялись.

## 2026-10-02 — loyalty phase 11.4: checkout explanation from saved snapshots

- Кассир видит отдельными строками применённую скидку (сумма/источник/процент группы), VIP-доплату, доступный cap/минимум и объяснение начисления. Открытый заказ показывает предварительный расчёт от базы после скидки минус бонусный tender. Закрытый заказ показывает только сохранённые `loyaltyBonusBase/Percent/Earned`; старый closed чек без исторического снимка явно сообщает, что данные отсутствуют, вместо пересчёта по сегодняшней группе гостя.
- `/api/orders/:id/payments` явно отдаёт `closed`; карточка payment quote по-прежнему venue-scoped и разрешается `orders`, настройки меняет только owner/admin. Добавлены повторные проверки memory/PostgreSQL, что после закрытия возвращаются сохранённые поля/ставка/результат и менеджер с `orders` читает объяснение.
- Архитектурное ревью нашло неиспользованное объяснение снимка: интерфейс всё ещё выводил текущую ставку. Подключено `accrualExplanation` к строке POS; контракт проверяет использование исторической ветки, а `dist/app.js` синхронизирован с `app.js`.
- Акции в API пока отсутствуют. Дорожная карта дополнена L11.5 (venue-scoped управление, период/область товаров) и L11.6 (best-only eligibility и причины в POS); это обязательный остаток, а не скрытое обещание готовой функции. Автопереход восстановлен: активен L11.5.
- Повторно PASS: syntax, POS contract, paid-order memory QA, paid-order PostgreSQL QA через disposable runner, `git diff --check` для затронутых файлов, локальный API health (`postgres`). Визуальная проверка POS остаётся ограничена отсутствием авторизованной сессии.
- Локальная работа; GitHub/VPS не менялись.

## 2026-10-02 — L11.6: first-tender price lock (local)

- Added `orders.pricing_locked_at` in migration 075 and schema parity. Existing partially paid open orders are backfilled with the legacy manual/group/VIP calculation and first tender timestamp; new tenders snapshot totals, selected promotion terms and offer explanations in the same transaction as payment creation.
- PostgreSQL and memory pricing read snapshots for locked/closed orders. Order item add/change/remove, guest reassignment, split and manual discount approval reject price changes after first tender (`409 order_pricing_locked`). Pending revenue SQL uses the locked discount snapshot. POS payment explanation explicitly says the price is fixed.
- Verified: 
ode --check` server/app/dist and QA files; loyalty evaluator and campaign contracts/memory QA; paid-order memory QA; isolated PostgreSQL paid-order regression; migration upgrade QA; 76-file migration contract; `git diff --check`; rebuilt local CRM and verified `/api/health` returns PostgreSQL healthy and `/app.js` HTTP 200.
- Local DB backup: `tmp/local-loyalty-backups/loyalty-before-lock-20261002.dump` (archive listing verified). Migration applied; no existing active partially-paid local orders needed a backfill.
- Remains active in roadmap L11.6 (40/49, 81%): campaign activation remains disabled pending a true active-promotion PostgreSQL flow (quote → partial payment → stable re-read → close → historical re-read) and pending-revenue/report reconciliation. Full POS visual QA remains L13.3. No GitHub/VPS changes.
## 2026-10-02 — loyalty phase 11.6: activate promotions with locked pricing

- Removed the activation-unavailable guard after wiring active promotion best-price calculation through PG quotes, payments/close, and pending revenue. Owner/admin UI now activates draft campaigns with confirmation; edits preserve active status when appropriate. First accepted tender and campaign version changes serialize on a venue advisory lock, so an order captures one stable price. The PG revenue query applies active promotion eligibility to unpaid, unlocked orders and uses snapshots after capture.
- Extended PostgreSQL paid-order API QA for activation, active quote, partial and final tender, version change without repricing, pending revenue, historical reads, and activation/tender race. Fixed QA fixture cleanup and unique-table assumptions exposed by running the end-to-end test.
- Updated API/policy contracts, source/dist portal parity (portal revision 440), and roadmap. L11 is complete (41/49, 83%); L12.1 is the next active substep. L13.3 still owns visual desktop/mobile acceptance.
- Verified: syntax `server.js`/`portal.js`/`dist/portal.js`; campaign contract and memory QA; pricing and POS contracts; migration contract; isolated PostgreSQL campaign QA and strengthened paid-order E2E (including unpaid/unlocked pending revenue) — PASS. Code-health final review found no confirmed blocker. `git diff --check` passed for changed scope.
- Rebuilt local CRM; `/api/health` reports PostgreSQL and `/portal.js?rev=440` returns 200 with activation UI. GitHub/VPS untouched. Next roadmap item is L12.1; visual desktop/mobile pass remains L13.3.
## 2026-10-02 — L12.1: loyalty and guest-funds reconciliation (local)

- Expanded `GET /api/loyalty/reconciliation` with venue-local inclusive date filters; current wallet/ledger snapshots stay separate from event-date movements. It reconciles bonus and guest-deposit balances, outstanding bonus clawbacks, reservation prepayment receipts/allocations/reopens/refunds, verified booking counters, and legacy unverified `deposit_paid` values.
- Connected the finance report panel with date controls, balance mismatch indicators, movement totals and distinct wallet reversal vs external cash/card/QR payout lines. The report is restricted to finance permissions. Updated API and roadmap acceptance.
- Code-health final review: PASS for latest SQL/UI/date/tenant/RBAC/bundle path. The reviewer found one stale QA assertion description after splitting external payouts into a disjoint bucket; corrected the wording.
- Verified: PostgreSQL reservation/prepayment E2E including date boundaries, independent sums, refund single-count, external payout partition, finance RBAC, tenant isolation, booking counter and wallet reconciliation; reconciliation contract; syntax; scoped `git diff --check`. Local Docker CRM rebuilt; `/api/health` reports PostgreSQL healthy and `/portal.js?rev=444` returns 200 with the updated payout label.
- Auto tracker advanced 42/49 (85%) and activated L12.2. Next: line up discount snapshots by order date with cash movement by payment/refund event date. No GitHub/VPS changes.
## 2026-10-02 — L12.2: sales, discounts, receipts and payouts by event date (local)

- Added `periodBusiness` to finance-scoped loyalty reconciliation. Closed sales use venue-local `closed_at` and locked pricing snapshots; discounts break down by source, guest group and promotion. Minimum adjustment appears separately in the sale bridge.
- Cash movement uses `payments.created_at` for cash/card/QR order tenders plus guest-deposit and reservation receipts, grouped by method and source. Bonus tender and internal reservation tender/allocation are excluded from fresh cash intake. Payouts use only immutable guest-account and reservation receipt reversals, grouped by reversal channel and source; allocation reversal is not payout.
- Old closed orders without full pricing snapshots are flagged. Gross falls back to saved order item prices and net to actual received tender; unknown historical discount is not invented. UI warns that discount may be unconfirmed.
- Finance/domain and system-architecture reviews completed. Code-health final review PASS; its legacy snapshot/missing minimum adjustment blockers were fixed. PostgreSQL E2E independently compares venue-local sales snapshot totals, tender receipts and payout sums; it also nulls/restores a closed order snapshot and confirms legacy fallback. Reconciliation contract, syntax, source/dist parity pass.
- Asset revision bumped to portal.js 445. Rebuilt local CRM and verified health/assets next; visual page is open to the login screen in Codex browser (authenticated session not assumed). Roadmap advanced to 43/49 (87%), active L12.3. No GitHub/VPS changes.

## 2026-10-02 — L12.3: legacy reservation deposits (in progress)

- Read-only query of the local database found one historical reservation with unverified `deposit_paid` totaling 1,500 RUB. No financial rows were changed. Added a venue-scoped report list with legacy value separated from verified receipt totals/count; receipt intake still rejects these bookings until the legacy amount is reconciled.
- Local source container was rebuilt; PostgreSQL health is `ok`, `/finance/report` and `/portal.js?rev=445` return 200, and the container includes the list UI. The browser remains at login; no authenticated user session was assumed.
- Review findings deliberately deferred per owner request: list title says “without verified receipts” although rows may have both legacy and receipt-backed amounts; displayed receipt total is gross (refund net not shown); cancellation confirmation does not flag unresolved legacy balance; `dist/portal.js` is stale and strict source/dist parity contract fails. These remain open for night audit; current local Docker image serves the source `portal.js`.
- No GitHub/VPS changes. L12.3 remains in progress; next continuation starts with night audit fixes/verification, then L12.4 and stage 13 local acceptance.
## 2026-10-02 — L12.4 preliminary access/audit review (read-only; findings deferred)

- Security review confirms tenant scoping for reconciliation/legacy reservations and guest ledger queries; external payouts require owner/admin plus finance, wallet/clawback reversal requires finance or loyalty; receipt intake is shift-bound/idempotent and receipt/reversal/promotion/settings changes write audit events. Reservation allocation audit includes `receiptId` and `reservationId` in `afterData`.
- Findings held for night audit per owner request: `finance_read` is granted to manager, bartender/hookah roles, developer and several operational roles; reconciliation returns guest-identifiable reservation/payment details under that permission. `/api/clients/:id/account-entries` is allowed to any `orders` holder and returns guest bonus/deposit balances and detailed movements. Decide/minimize the roles/data before closing L12.4.
- Existing strict loyalty reconciliation contract currently fails only the confirmed `portal.js` vs `dist/portal.js` source parity, which was not repaired by request. L12.3 remains active; no financial or authorization code changed during this review.

## 2026-10-02 — local regression snapshot (findings deferred to night audit)

- Re-ran the isolated PostgreSQL scenarios for reservation prepayment, guest loyalty API, and paid-order balance; all three returned PASS. No test failures required a code change.
- Rechecked the live local `/api/health`: `status=ok`, service `hookah-pos`, database `postgres`.
- Owner confirmed defects and discrepancies are for night audit. No product code, financial data, roles, or assets were changed in this snapshot; roadmap remains L12.3, 43/49 (87%), until the deferred reconciliation/source-dist and access findings are addressed and the remaining acceptance is run. GitHub/VPS untouched.
- Additional read-only role/security review: broad `loyalty` grants managers manual bonus adjustments/reversals and discount-group edits; stored redemption settings appear not to drive checkout (checkout uses fixed defaults); ordinary tender idempotency-key validation is inconsistent. These are deferred findings for the night audit, not changed here. Code-health review also reconfirmed source/dist parity failures in reconciliation/promotions contracts and the trailing blank-line `git diff --check` finding.
- Further local acceptance evidence: 
ode --check` passed for server/app/portal source and `dist/portal.js`; POS explanation contract, promotion memory QA, pricing evaluator QA, isolated PostgreSQL promotion E2E, guest-account ledger memory QA, reservation-prepayment memory QA, and loyalty-program pending/retry QA all passed. Authenticated visual UI remains unverified because the local browser is at login and no authorized session is present. No code/financial rows/assets were changed; GitHub/VPS untouched.
- Migration acceptance additionally passed: 
ode scripts/migrations-contract.mjs` (76 replay-safe files), isolated PostgreSQL migration upgrade QA, and PostgreSQL migration runtime QA. These ran through the disposable regression database; the live local database was not migrated or modified.
- Cash-shift integration also passed in isolated PostgreSQL QA (`shift-cash-postgres-e2e-qa.mjs`), covering compatibility of order tenders with shift accounting. Deferred findings and the 43/49 roadmap position are unchanged.
- Broader acceptance: `local-full-qa.mjs --memory` passed all 21/21 suites. `--postgres` passed 14 suites, then stopped at the unrelated synthetic bartender login in `finance-employee-postgres-qa.mjs` (`503 authentication_unavailable`, line 108); no loyalty fix attempted. `--static` stopped at the known `admin-section-heading-contract.mjs` mismatch (`Персонал` in portal vs expected `Сотрудники`). Both are held for the night audit; the runner stops on first failure, so later suites were not run.
- Continued the remaining loyalty-adjacent PG checks directly after the full-runner stop: guest loyalty API (ledger/reversals), reservation prepayment, finance shift analytics, and reservation local-date E2Es all PASS in disposable databases. Rechecked live local health (`ok`, PostgreSQL). Tracker remains L12.3 at 43/49; deferred defects prevent closing it. No product changes or publication.
- Attempted the still-unrun tenant/RBAC dependency PostgreSQL suite independently; it stopped before assertions at synthetic owner login with the same `503 authentication_unavailable` as finance-employee QA. This confirms a repeated isolated-QA auth blocker; not changed per night-audit instruction. Remaining login-dependent audit suites were not retried against the same blocker.
- Split QA by runtime cost per owner request. Day gate completed in ~8s: syntax (`server.js`, `app.js`, `portal.js`, `dist/portal.js`), POS explanation, pricing, promotion memory, loyalty settings pending/retry, discount-group memory, guest-ledger memory, and reservation-prepayment memory — all PASS. Created one-shot local Codex automation `qa-loyalty-hookah-pos` for 2026-10-03 02:00 Yekaterinburg to run the heavy focused PG/migration/contracts sequentially in disposable QA only, produce a report, and leave all known defects untouched. No product/data changes or publication.
- Extra fast finance checks: `finance-report-date-qa.mjs` and `finance-timezone-contract.mjs` PASS. `finance-api-consistency-contract.mjs` FAILs its expected PostgreSQL report fallback expression assertion (line 42); left for night audit. No files/data altered by these checks.
- Pre-night current-state check: scheduled automation is still before its 2026-10-03 02:00 Yekaterinburg run; no newer test report exists. Unauthenticated local HTTP routes `/api/health`, `/login`, `/app.js`, `/portal.js?rev=445`, and `/finance/report` each returned 200. This verifies local route/asset availability only, not authenticated visual behavior; L13.3 still needs an authorized session.
- Prepared the L13.3 manual pass from `SITE_TREE.md` and `VISUAL_PAGE_RULES.md`: routes `/` (POS/payment explanation and partial-to-closed order states), `/admin#loyalty` (owner/admin rules and campaign controls), `/clients` (guest balances/history), `/reservations` (prepayment states), and `/finance/report` (date-scoped reconciliation); inspect at desktop, tablet, phone (<480px), and Fold profiles. Verify loading/empty/error/success states, responsive controls/table-to-card layouts, and reread after refresh without posting real funds. Execution still awaits an authenticated local session.
- Added a second one-shot local automation `loyalty-hookah-pos` for 2026-10-03 02:30 Yekaterinburg, after the 02:00 QA run. This is the authorized night correction pass: scoped loyalty defect repair with team workflow/code-health reviews and required tests, disposable DB only, no production/financial-row changes, no auth bypass, and no GitHub/VPS publication. Existing findings remain untouched during the daytime.

## 2026-10-02 — local candidate smoke continuation

- Revalidated the active loyalty roadmap: 11/13 stages, L12.3 active, 43/49 subtasks (87%); no status was advanced because L12.3 findings remain open and are reserved for the scheduled night audit.
- On the isolated candidate preview (`127.0.0.1:45637`, memory database), authenticated as the preview owner/admin and checked session, loyalty settings defaults (version 0, cap 100%), promotions list, plus `/admin`, `/clients`, `/reservations`, `/finance/report`, `/app.js`, and `/portal.js?rev=445` — all HTTP 200. No persistent/local production database was used or mutated. Browser login remains open for the user; preview credentials are admin/admin.
- Focused fast memory QA: loyalty promotions, guest ledger, reservation prepayment, paid-order balance, and discount-groups — PASS. The combined `local-full-qa.mjs --memory` passed 5 suites and stopped at legacy `finance-rbac-runtime-qa.mjs`: creating the test manager account returned 403 instead of expected 201. No fix attempted per owner instruction to leave defects for the night audit. Heavy PostgreSQL suites remain scheduled for tonight.

## 2026-10-02 — include loyalty/prepayment reconciliation in nightly runner

- Release-prep audit found the existing comprehensive `reservation-prepayment-postgres-qa.mjs` was explicitly allowed by the disposable PostgreSQL wrapper but omitted from `local-full-qa.mjs`'s top-level PostgreSQL suite. Added it once to the overnight PostgreSQL suite after loyalty promotions; it exercises prepayment, legacy reservation, reversal, event-date reconciliation and tenant/RBAC behavior on the wrapper's fresh randomized QA database.
- Verified 
ode --check` on the changed runner and QA file; 
ode scripts/local-full-qa.mjs --list` lists the new test; 
ode scripts/local-full-qa.mjs --check-guards` passes 2/2; scoped `git diff --check` passes. Code-health post-review: PASS; confirmed wrapper explicit allowlist and disposable database ownership. The heavyweight PostgreSQL scenario itself is left for the scheduled night run per owner request. Product behavior and databases were not changed.

## 2026-10-02 — add night-only reconciliation PII/RBAC regression assertion

- The read-only audit confirmed `finance_read` is granted to operational bartender roles, while `/api/loyalty/reconciliation` currently permits any `finance_read` user and returns guest-level legacy reservation details. Added a focused fixture/assertion to the already scheduled `reservation-prepayment-postgres-qa.mjs`: operational bartender with standard role scopes must receive 403. This intentionally records the expected current product failure for the night audit; no server behavior was changed.
- Code-health review confirmed the fixture exercises the standard `bartender` role-derived `finance_read` permission and uses an active synthetic organization membership. Lightweight verification: 
ode --check scripts/reservation-prepayment-postgres-qa.mjs`, `git diff --check -- scripts/reservation-prepayment-postgres-qa.mjs`, night-runner `--list`, and `--check-guards` (2/2) passed. PostgreSQL E2E was not run during the day. Changes are local only; GitHub and VPS remain untouched.
- Continued daytime acceptance on 2026-10-02 at 21:13 Yekaterinburg: local PostgreSQL preview health and `/login`, `/admin`, `/clients`, `/reservations`, `/finance/report` returned HTTP 200. `loyalty-pos-explanation-contract.mjs` and `loyalty-pricing-qa.mjs` PASS. Reconciliation and promotions contracts both FAIL only their existing `dist/portal.js` vs `portal.js` source parity assertion; left unchanged for tonight. Scheduled automations confirmed ACTIVE: disposable PG QA at 02:00 and night correction at 02:30 on Oct 3. Roadmap remains L12.3 (43/49, 87%); authenticated visual flow not verified. No heavy E2E, product-data edits, publication, or fixes performed.
- Repeated the lightweight memory acceptance in the same local workspace at 21:14: `loyalty-promotions-memory-qa.mjs`, `guest-account-ledger-memory-qa.mjs`, `reservation-prepayment-memory-qa.mjs`, and `discount-groups-memory-qa.mjs` all PASS. Night reports are still absent; no roadmap status advanced and no persistent financial data changed.
- Additional fast local acceptance at 21:14: `loyalty-program-pending-qa.mjs` (submit/error-draft/retry/refresh) and `paid-order-balance-memory-qa.mjs` both PASS. Local preview health remains `ok` on memory DB. Current time is before the configured overnight run; no PG QA report exists yet. Authenticated UI flow remains the next required interactive check.
- Rechecked at 21:15 before the scheduled night run: no new QA reports; progress still L12.3, 43/49 (87%); local `/api/health` is `ok` (memory preview). 
ode --check` passes for `server.js`, `portal.js`, `dist/portal.js`, `app.js`, and the extended PostgreSQL prepayment QA; scoped `git diff --check` passes. Visual login was not automated, and there has been no product/data change or publication.
- At 21:16, live preview health still reports `ok`/`memory`; no new overnight logs exist. Additional fast demo QA passes: `discount-groups-demo-qa.mjs` (duplicate, deposit, venue, permissions) and `paid-order-balance-demo-qa.mjs`. Roadmap unchanged; no persistent-data or product-code changes.
- Release request revalidated at 21:17: GitHub remote branch `codex/loyalty-release-candidate` is at `60237b1f4cc4b1f911baaea40871e642eaab5d44`; production `http://212.192.0.58/api/health` remains `ok`/`postgres`. No newer overnight QA artifact exists. No deployment initiated because the candidate's known PII/RBAC release blocker and required pre-deploy gates remain open. Local one-shot automations are configured for this machine; powering it off before 02:00 will prevent their execution. No app data or production state changed.
- Authenticated local UI acceptance now observed on 2026-10-02: `/admin#loyalty` loads with no programs/active promotions, compatible bonus settings render (1 ₽ per point, 100% cap, min 1), `/clients` is empty, and `/reservations` form loads but its seating selector is disabled in this no-fixture preview. `/finance/report` renders the loyalty reconciliation section but shows a load error; read-only `GET /api/loyalty/reconciliation` returns HTTP 500 `{"error":"internal_error","message":"venueTimezone is not defined"}` from the memory path in `server.js:2908`. Left unfixed for the authorized night pass. Browser session was already authenticated by the user; no forms were submitted or settings/data mutated.

## 2026-10-02 — Loyalty/finance access and local QA continuation

- Repaired the memory reconciliation timezone reference and date fallback; `GET /api/loyalty/reconciliation` now returns venue-local dates instead of the former `venueTimezone is not defined` 500. `portal.js` and `dist/portal.js` are synchronized and the UI explains when guest-level legacy rows require owner/admin access.
- Tightened reconciliation access: operational roles with `finance_read` receive 403; finance readers such as managers keep aggregate balances/movements but receive no legacy guest rows. PostgreSQL skips the detail query (including the `guests.full_name` join) entirely for these roles. Owner/admin retain a venue-scoped, capped 250-row review list. API.md and contract QA describe the same boundary.
- Added memory regression QA for missing authentication, owner response, timezone/date defaults, invalid date and bartender denial; included it in the full memory runner. Extended PostgreSQL reservation/prepayment QA to assert bartender denial and manager aggregate-only response. Narrow follow-up code-health and finance/security reviews found no blocker.
- Verification: complete memory suite 22/22 PASS; focused PostgreSQL reservation/prepayment E2E PASS; reconciliation contract PASS; syntax, scoped `git diff --check`, and QA wrapper guards 2/2 PASS. Combined PostgreSQL runner passed 15 suites then stopped in unrelated `finance-employee-postgres-qa.mjs`: its synthetic bartender login returned 503 `authentication_unavailable` at line 108. No loyalty assertion failed before the stop.
- Preview health remains `ok`/memory at `127.0.0.1:45637`; authenticated browser inspection confirms `/admin#loyalty` is rendered with program editor, compatible redemption settings and promotions panel. This is not a verified finance-report browser pass. A synthetic preview product and guest were created while attempting a demo fixture; venue/hall setup was rejected, and no PostgreSQL/live financial records were touched.
- Roadmap remains L12.3, 43/49 (87%). Remaining before closing L12.3: correct the detail-list label for rows with verified receipts, display net receipt balance after refunds, warn on cancelled bookings with unresolved legacy amount, and pass a focused visual/API reread. L12.4 remains pending in sequence. GitHub and VPS remain unchanged; current workspace has extensive unrelated/pre-existing edits, so no broad staging or commit was created.

## 2026-10-02 — L13 visual preview rerun on current source

- Kept the existing PostgreSQL CRM and memory preview untouched. Started a separate disposable memory Node preview on `127.0.0.1:45638` from current source; health is `ok`/`memory`. `GET /api/loyalty/reconciliation` returns 200, `Asia/Yekaterinburg`, venue-local range `2026-10-01..2026-10-02`, and zero legacy rows in its empty state. This confirms the earlier memory `venueTimezone` 500 is fixed in the loaded backend.
- Source and published client asset match exactly (`portal.js` / `dist/portal.js`, SHA256 `6112C71684591B587AD8E0F6AF823153334D7CCB7123057DF3CDAA1AE0C09D94`).
- Visual check: loyalty admin UI rendered on the existing authenticated memory preview and shows the settings/editor/promotions sections; one synthetic guest is visible in `/clients`. Reservation UI renders but venue/table selection is disabled because the preview has no floor fixture. The finance report on the old `45637` preview still displays the old loaded backend error; do not treat that process as current-source proof. On the fresh `45638` process `/admin` and `/finance/report` redirect to `/login` because its session resolves to demo bartender; no login dialog was automated. Thus API/runtime is verified, final authenticated finance UI visual pass remains open.
- No database writes, real payments, production data, GitHub push, or server deploy. The disposable memory server session is `52917`.

## 2026-10-02 — L12.3 legacy booking cancellation warning

- After the MASTER finance contract handoff, limited product edits to the reservation cancellation confirmation in `portal.js` and its published copy `dist/portal.js`. A legacy `deposit_paid`/`legacyDepositPaid` amount now appears as an explicit warning: it is not proof money arrived, cancellation preserves it for manual review, and staff must not refund it without a source document. Existing warning for actual verified prepayments remains and is shown together when both values exist.
- Added `scripts/reservation-legacy-cancel-warning-contract.mjs`, executing the actual prompt helper for legacy-only, verified-only, mixed, and empty balances; source/dist parity is asserted. The related reservation-form contract had a stale hard-coded app asset revision; changed it to assert versioned assets and source/dist revision equality.
- Verification: the new warning contract, `reservation-form-qa.mjs`, `loyalty-reconciliation-contract.mjs`, `loyalty-reconciliation-memory-qa.mjs`, and `reservation-prepayment-memory-qa.mjs` all PASS. `portal.js` and `dist/portal.js` syntax checks and scoped `git diff --check` pass. The browser opens the fresh preview to `/login`; no authentication was automated, so no authenticated visual-flow claim is made.
- MASTER separately committed PostgreSQL reconciliation receipt-net-after-refund work as `caf13766`. Remaining L12.3 finance-owned gaps visible in current source: heading/row presentation must distinguish legacy-only from legacy-plus-receipt records, and the memory reconciliation receipt total still uses gross values; these were reported to MASTER and not edited here. No DB changes, GitHub push, or server deployment.

## 2026-10-02 — L12.3 integration recheck

- MASTER committed memory receipt net-after-refund parity as `fa887acb`; the roadmap now reflects both PostgreSQL and memory receipt totals as net.
- Current checkout has a concurrent unrelated `inventory_categories` permissions diff in `portal.js` that is absent from `dist/portal.js`. It was not introduced or changed as part of L12.3 and was reported to MASTER. The L12.3 warning contract now checks the cancellation helper/call site in both copies without claiming whole-file parity.
- Recheck: warning helper contract, reservation form QA, memory reconciliation QA, prepayment memory QA, syntax and scoped `git diff --check` pass. Whole-file `loyalty-reconciliation-contract.mjs` still fails its source/dist equality assertion because of that inventory-scope diff; full published asset parity and authenticated visual flow remain open.

## 2026-10-02 — Owner-configurable category lifecycle for managers

- Exposed the existing separate `inventory_categories` permission scope in the owner permission UI and completed its lifecycle gates. It now preserves `inventory_read` while granting no broad inventory write permission.
- A manager with this scope can archive and restore product categories and request final deletion. Category archive has no confirmation prompt for this scoped path; deletion request still asks confirmation and only the owner can approve. The narrow scope cannot create/edit categories, change inventory, or request department/subdepartment deletion. Existing tenant scoping, linkage guards, and audit behavior remain in force.
- Updated permission UI labels and API contract. Extended role API runtime QA for default denial, scoped category archive/restore/request, no broad writes, no non-category requests, and owner-only final approval.
- Updated the published `dist/portal.js` permission selector and category lifecycle actions in parallel with source `portal.js`.
- Verification: 
ode --check` for server/source/dist/client QA scripts; `inventory-hierarchy-contract.mjs`, `inventory-critical-state-qa.mjs`, `inventory-subdepartment-api-qa.mjs`, and `role-api-matrix-runtime-qa.mjs` PASS; scoped `git diff --check` PASS. The runtime uses an isolated in-memory server and verifies default manager denial, owner-configured category lifecycle, guardrails and owner approval.
- VPS and production records were not changed.

## 2026-10-02 — L12.3: clarify legacy and receipt-backed booking amounts

- Fixed the finance reconciliation report so legacy booking amounts are not presented as “without receipts” when receipt history exists. The heading is neutral, each old `deposit_paid` value is explicitly labelled unverified, and receipt totals are labelled net of refunds. Rows distinguish no-receipt legacy records, mixed records with a positive net receipt balance, and mixed records whose receipts were fully refunded; unknown states remain marked for manual review. Owner/admin detail visibility is unchanged.
- Added a focused renderer contract for legacy-only, mixed partial-refund, mixed full-refund, escaped guest text and unknown status; the renderer fragment is checked against `dist/portal.js` without touching the separate inventory-category changes.
- Follow-up architecture/code-health review found the aggregate KPI count label also incorrectly implied no receipts; changed it to say the old amount needs reconciliation and added a report call-site assertion to the renderer contract.
- Extended `reservation-prepayment-postgres-qa.mjs` with synthetic mixed-history cases: 100 ₽ legacy plus 100 ₽ receipt / 30 ₽ refund yields 70 ₽ net; 100 ₽ legacy plus a fully refunded 60 ₽ receipt keeps one receipt in history with 0 ₽ net. Existing cleanup removes all UUID-owned fixtures.
- Verification: 
ode --check` for changed portal and QA files; `loyalty-reconciliation-contract.mjs` PASS; `reservation-legacy-cancel-warning-contract.mjs` PASS; `local-full-pg-regression.cjs reservation-prepayment-postgres-qa.mjs` PASS on its validated disposable PostgreSQL database; `git diff --check` PASS; source and dist portal hashes match.
- Roadmap remains L12.3 in progress (43/49, 87%) because authenticated visual acceptance and remaining report/manual-reconciliation checks are still open. No production data, GitHub, or server was changed.

## 2026-10-02 — L11 database immutability and QA cleanup

- Added forward migration 076 to reject direct UPDATE/DELETE on loyalty program settings, promotion versions and promotion scopes. FK-driven deletion is allowed only after the owning venue row is removed; normal venue/user lifecycle remains soft archive. Creator references use RESTRICT to preserve historical attribution. Scope→product remains tenant-scoped and blocks standalone product deletion; its deferred NO ACTION permits a maintenance transaction to remove the product and then its venue. Order→promotion snapshot remains RESTRICT.
- Synchronized the current fresh-install definitions in `schema.sql`. Extended migration-upgrade PostgreSQL QA to apply/replay 076 and exercise no-op updates/direct deletes, creator soft/hard deletion, isolated product deletion, deferred product→venue cleanup, sibling-venue retention and trigger-enabled state.
- Reworked paid-order and promotion PostgreSQL QA cleanup so it no longer drops immutable history triggers or directly deletes campaign history. Promotion audit test objects now have per-run names and are removed in `finally`; fixture rows are cleaned through venue cascades. Cleanup assertions are captured before connections close, so failure paths still release clients.
- Verification: migration contract (77 files), reconciliation/promotion contracts, full memory QA (22/22), PostgreSQL migration upgrade QA, promotion PostgreSQL QA and paid-order balance PostgreSQL QA all PASS. The paid-order cleanup had one caught `await` chaining error on first rerun; it was fixed and the rerun passed.
- The authenticated visual browser check remains unverified: Windows Computer Use stopped twice because it could not determine the Opera tab URL confidently. The loyalty roadmap stays L12.3 at 43/49 (87%); this DB guard work does not close the remaining historical reconciliation or UI acceptance. No GitHub publication or server deployment occurred.
- A follow-up code-health challenge tightened the temporary-table shadow test: the shadow table is intentionally empty, so the former unqualified lookup would incorrectly allow the direct DELETE and fail the test. Cleanup also aggregates connection-close errors after closing both clients. The replaced 073 trigger function is dropped by 076 and asserted absent by upgrade QA; order snapshot v1 still resolves after v2 is appended, and its FK stays immediate RESTRICT.
- Final system-architecture, data-design, security and code-health reviews found no blocker for this migration package. After the latest temp-shadow and cleanup changes, the disposable PostgreSQL migration-upgrade, promotion and paid-order suites all passed again.
## 2026-10-02 — payroll source and adjustment contract

- Сверены исходное ТЗ, committed pure calculator и текущие payroll schema/routes; independent product/code-health reviews подтвердили, что подключать текущий калькулятор к production lifecycle рано: нет POS actor и net allocation на line level, immutable runs и owner-only API, а общие router/schema/UI файлы имеют параллельные изменения.
- В payroll architecture contract зафиксировано: оператор-пробивший на каждой строке; net commission base после скидок/возвратов; поздние возвраты через append-only идемпотентную корректировку следующего открытого run без мутации выплаченной ведомости или автоматического отрицательного/фиксированного удержания; milestone bonus вне sales-linked cap с явной видимостью общей доли затрат. Добавлена сущность `payroll_adjustments` для lineage и предотвращения повторного учёта возврата.
- Дополнительно выявлена внутренняя коллизия ТЗ между гарантированной премией сотруднику без продаж и лимитом дневной выплаты относительно его продаж. В контракте выбран интерпретируемый вариант: cap ограничивает sales-linked компоненты, премия учитывается отдельно и прозрачно.
- Добавлена только новая payroll-owned forward migration `migrations/077_payroll_scheme_snapshots.sql` и отдельный `scripts/payroll-scheme-migration-contract.mjs`: версии схем, роль/персональные параметры, позиционные правила, расчётные runs, дневные/построчные snapshots и append-only refund adjustments/applications. Миграция не трогает текущий `payroll_entries`/expense lifecycle и не создаёт расходы. Изменены payroll contract и командные `DECISIONS.md`/`WORK_LOG.md`; POS/loyalty/finance ledgers, shared server/schema/db/UI не изменялись.
- SQL ограничивает tenant-ссылки составными FK, закрепляет audit actor той же площадки, замораживает активную конфигурацию/расчётную историю, запрещает пересекающиеся active version и employee override/role windows, не позволяет отметить run готовым при missing attribution/net evidence, проверяет соответствие сотрудника возврата исходной строке и ограничивает суммарную refund/void комиссию комиссией исходной строки. Исторические записи защищены RESTRICT; hard-delete пользователей/площадок с payroll history намеренно блокируется.
- Независимый security review подтвердил, что DB keys/triggers изолируют tenant-связи, но owner-only права и достоверность source/actor остаются server API обязанностью. В схеме пока нет line-level refund source, поэтому будущий refund endpoint обязан отказывать до появления и проверки такого источника; caller-provided `source_key` не является подтверждением возврата.
- QA: `migrations-contract.mjs` PASS (78 migration files); focused static contract PASS; focused PostgreSQL 16 upgrade+replay QA PASS внутри одноразовой изолированной схемы с rollback/cleanup; проверены legacy payroll/expenses, tenant FKs, active-version transitions, draft freeze, source gating, line/snapshot immutability, adjustment idempotency/limit, same-employee and line commission cap. `payroll-schemes-contract.mjs` PASS; синтаксис focused QA и `git diff --check` PASS. Не выполнялись authenticated API/RBAC/UI, finance report integration или production deploy; owner authorization и actor provenance требуют будущего backend endpoint и здесь не заявляются.

## 2026-10-02 — L12.3/L12.4: изоляция гостевых балансов и проверяемая история предоплат

- Memory guest API теперь берёт площадку из активной сессии, а не из общей mutable-переменной выбранного зала. Проверены список/карточка/архив/удаление/история/балансовый журнал/начисление бонусов между двумя площадками: чужой гость скрыт, профиль и баланс не меняются.
- Операционная роль только с `orders` не получает бонусный или денежный остаток через список либо ответ `PATCH`; финансовые детали брони доступны только при явных `reservations`, `finance` или `loyalty`, а `finance_read` и `orders` видят историю без платежных полей.
- Demo адаптер выровнен с API: ограничения просмотра и изменения балансов, запрет неучтённых правок остатков, сокрытие квитанций и вычисление сумм возвратов. Исходный и dist portal синхронизированы.
- Запись аудита о корректировке бонусов и об оплате заказа фиксируется в той же PostgreSQL транзакции, что и финансовое движение; ошибка аудита откатывает оплату и ledger. Чувствительные поля профиля гостя вычищаются при записи аудита и при чтении старых событий.
- История гостя показывает квитанционную сумму, сумму возврата и старое значение брони как неподтверждённое. Квитанция с полным возвратом остаётся видимой как возвращённая предоплата, а не как отсутствие поступления.
- Проверки: `local-full-qa.mjs --memory` PASS 22/22; privacy/audit, guest loyalty, paid-order balance и reservation prepayment PostgreSQL QA PASS на одноразовом локальном QA контейнере; reservation form contract PASS; syntax и scoped `git diff --check` PASS; `portal.js`/`dist/portal.js` byte parity PASS.
- Старая запись брони с 1 500 ₽ не удалялась и не превращалась в квитанцию; её требуется сверить по первичному документу. Production, GitHub и сервер не менялись. Авторизованный визуальный просмотр остаётся неподтверждённым из-за отсутствия локальных учётных данных. L12.3 остаётся активным, L12.4 и L13 ждут этого закрытия.

## 2026-10-02 — payroll owner-only scheme service foundation

- По согласованию с MASTER добавлен изолированный `payroll-scheme-service.js`: owner-only чтение/создание схем и версий, атомарное редактирование только draft версии с проверкой дат assignments/overrides, активация с DB conflict guard, журнал ревизий; preview/compare возвращают только неперсистируемый `official:false` сценарий и используют сохранённые правила версии.
- Миграция 078 разрешает менять родительскую конфигурацию и заменять дочерние role assignments/overrides/item rules только в draft. Активные версии и дочерние правила заморожены; сужение окна, исключающее сохранённые дочерние даты, отклоняется БД. Миграция 079 добавляет tenant-scoped append-only журнал полных снимков при создании/редактировании/активации, требует активного владельца площадки, берёт имя/время из БД, фиксирует непрерывную нумерацию и запрещает UPDATE/DELETE/TRUNCATE.
- Контрактный QA проходит сервис в rollback-изолированной схеме: отказ сотруднику/чужой площадке, явный `0` override, корректный автор, редактирование draft, активация/immutability/overlap, audit create-edit-activate, запреты forged actor/gap/delete/truncate, preview/compare без сохранения и прежние source/adjustment инварианты. `server.js`/`db.js`/`schema.sql`/UI не тронуты, HTTP routes не подключены.
- Проверки: 
ode --check payroll-scheme-service.js`, 
ode --check scripts/payroll-scheme-migration-contract.mjs`, 
ode scripts/migrations-contract.mjs` PASS (80 миграций), 
ode scripts/payroll-schemes-contract.mjs` PASS, 
ode scripts/payroll-scheme-migration-contract.mjs` STATIC + POSTGRESQL PASS на локальной disposable `hookah-finance-local-qa` базе (isolated schema + rollback), scoped `git diff --check` PASS.
- Независимый security/data/code-health review не нашёл блокеров в этом пакете. Будущая HTTP-обвязка обязана формировать principal только из проверенной auth session; preview не является payroll input, а официальный run ждёт POS employee attribution и достоверную line-net/refund базу. Коммит пакета и локальные тесты не означают, что модуль подключён или развёрнут.

## 2026-10-02 — L12.3 documentary review path and historical-price guard

- Added migration 080 and matching `schema.sql` support for an append-only review ledger on old positive reservation `deposit_paid` values. Existing amount stays intact and is not converted into a receipt/payment. Owner/admin can record only whether source documents were found, not found, or require further review; the action stores evidence/reason, actor/time, an expected-head version, idempotency, and an audit event in one transaction.
- Connected the reconciliation API and finance report form to show the current review and history. Explicit UI/API text says this is documentary work only: it does not prove payment/nonpayment, change guest balance, receipts, shift cash, or unlock new prepayment intake. Source and published `portal.js`/`style.css` copies are byte-identical.
- Prevented active promotion changes from recalculating legacy closed orders without a saved pricing snapshot. Added a PostgreSQL regression that reads the historical order, payment, and finance revenue after a new campaign is active; historical 2,000 test-order price remains unchanged.
- Fixed the disposable reservation PostgreSQL QA teardown to remove fixture review rows before fixture reservations. The product ledger remains immutable; only the test-owned DB teardown drops its trigger before cleanup. Reservation prepayment PostgreSQL QA PASS; paid-order-balance PostgreSQL QA PASS; loyalty reconciliation contract, promotion contract, pricing QA, reservation form QA, reservation prepayment memory QA, reconciliation memory QA, migrations contract (81 files), syntax checks, and scoped `git diff --check` PASS.
- `local-full-qa.mjs --memory` ran 7/8 checks and stopped at the unrelated static-boundary check because the Docker runtime did not expose `/payroll-scheme-ui.js?rev=1`; no payroll/static runtime fix was made here. Authenticated finance report UI remains unverified because this local session has no usable credentials. The existing 1,500 ₽ legacy booking was not altered. Roadmap remains L12.3, 43/49 (87%); documentary proof and authenticated visual acceptance still block completion. No commit, push, or server deploy.

- Final review follow-up: added a standalone `finance_read` permission scope in API and staff permission UI. Reconciliation guest-level rows/history now require both owner/admin and `finance`; a narrowed admin with `finance_read` sees aggregates only and cannot write reviews. PostgreSQL QA verifies both restricted states. Expanded the historical-promotion report fixture with a closed, pre-campaign order that has NULL price snapshots and no payment; finance-report fallback remains at 2,000 ₽ instead of applying the current campaign, alongside the paid 2,000 ₽ sale. Reservation and paid-order PostgreSQL regression suites both PASS after these coverage additions; the report does not invent sale revenue for the no-payment historical fixture.

## 2026-10-02 — Owner-only payroll scheme routes and configuration UI

- Добавлен owner-only HTTP adapter и UI схем внутри существующего раздела `/finance`: схемы и версии, draft edits, активация, revision history, ручной preview и сравнение. Сервисная owner/venue проверка в PostgreSQL остаётся обязательной; route adapter дополнительно отказывает ролям кроме `owner` до чтения конфигурации.
- Preview принимает только сценарные нормализованные данные, ограничивает объём интерфейсом и явно остаётся `official:false`/`persistence:none`; payroll entries и expenses не меняются. Расчётчик применяет employee overrides только в их effective window и проверяет конфигурацию на каждом активном дне.
- Добавлены route/UI contracts и опубликованная копия UI-скрипта. Сквозной HTTP mount в `server.js`, API справка и sync wiring остаются в общей незакоммиченной области до финального согласования общей интеграции; это не включено в payroll commit.
- Проверки: 
ode --check` изменённых payroll/server JS и focused MJS; `payroll-schemes-contract.mjs`, `payroll-scheme-routes-contract.mjs`, `payroll-scheme-ui-contract.mjs` PASS; PostgreSQL миграционный contract 077–079 ранее PASS. Browser→HTTP→PostgreSQL smoke не подтверждён из-за нестабильного входа/сессионного перехода в существующей локальной QA базе; ошибка не приписана продуктовой реализации.
- Scoped commit: `6db10586`. Production, remote GitHub и сервер не затрагивались.

## 2026-10-02 — Payroll preview resource limits

- Добавлены серверные ограничения размера сценария preview/compare (до 500 сотрудников, 20 000 строк продаж, 5 000 назначений в сохранённой схеме) и совокупного числа дочерних строк конфигурации (15 000). Превышение возвращает HTTP 413 до расчётных циклов или записей.
- Изолированный PostgreSQL payroll contract проверяет превышение размеров preview/compare и конфигурации схемы в реальном сервисе; транзакция теста и отдельная QA-схема откатываются после проверки.
- Проверки: 
ode --check payroll-scheme-service.js`, 
ode --check scripts/payroll-scheme-migration-contract.mjs`, 
ode scripts/payroll-schemes-contract.mjs`, 
ode scripts/payroll-scheme-routes-contract.mjs`, 
ode scripts/payroll-scheme-ui-contract.mjs`, полный 
ode scripts/payroll-scheme-migration-contract.mjs` на loopback disposable PostgreSQL, scoped `git diff --check` — PASS.
- Code-health review: блокирующих дефектов нет; зафиксированы оставшиеся продуктовые границы сценарного JSON-preview, неофициального сравнения и текущего timezone default UI. Изменение остаётся локальным; общий смешанный `server.js` и прочие интеграционные файлы не включены в commit, GitHub и сервер не затронуты.

## 2026-10-03 — Payroll scenario breakdown and comparison safety

- Сценарный preview и сравнение версий теперь показывают сводные суммы по сотруднику и раскрываемые дневные/построчные детали (роль, база комиссии, ставка, комиссия, премия и cap) вместо JSON. DOM-лимит ограничивает preview 2 000 дневными строками сотрудников и 2 000 строками продаж, сравнение — 500 строками каждого типа на версию (до восьми версий); рассчитанные общие суммы не обрезаются. Имена схем видны в таблице сравнения.
- Сервис отклоняет сравнение версий с разной валютой (`comparison_currency_mismatch`); валютная метка для сумм берётся из общей проверенной валюты. Дневная дельта не заменяет неизвестные/переполненные суммы нулём. Основные причины блокировки имеют русские пояснения с исходным кодом в подсказке.
- Даты по умолчанию берутся по часовому поясу площадки из сессии (с локальным fallback), а не по UTC. Отображение выдерживает невалидный код валюты, blocked baseline, испорченную employee-запись, ограничивает строки сравнения на каждую версию и горизонтально прокручивает широкие таблицы.
- Добавлены контракты для mixed-currency отказа, безопасного форматирования дельт, таблиц и DOM-лимитов; синхронизирована только payroll UI копия в `dist`.
- Проверки: 
ode --check` сервис/UI/контрактов; payroll schemes/routes/UI contracts — PASS; `payroll-scheme-migration-contract.mjs` полный PostgreSQL PASS на одноразовом loopback контейнере 31931 (включая разные валюты); source/dist byte parity и scoped `git diff --check` — PASS. Сервер и production не затрагивались.

## 2026-10-03 — memory reconciliation coverage and truthful unknowns

- Added a focused reconciliation builder for the local memory preview. It aggregates supported closed-order snapshots and dated receipts with venue/timezone scoping, while unsupported payout ledgers, external refunds, and bonus clawback amounts remain 
ull` and are shown as unavailable instead of fabricated zeroes. Reservation prepayment balance now nets receipt reversals and allocation reversals; orphan refund entries do not alter confirmed receipt totals.
- Tightened historical reporting: only valid `closedAt` timestamps assign a sale to a business date. Closed records without a closure date are excluded from period totals and explicitly listed in coverage; their creation date is not substituted. An explicit null promotion snapshot is known absence and contributes zero, while a missing legacy snapshot or promotion amount remains unknown.
- Narrow code-health review found and the implementation fixed the no-promotion and missing-closure-date cases. Added dedicated unit coverage. Reconciliation contract, memory API/RBAC QA, period business QA, prepayment memory QA, pricing/promotion contracts, migration contract (81 files), syntax, source/dist parity, and scoped `git diff --check` PASS.
- Full 
ode scripts/local-full-qa.mjs --memory` reached 8/9 passing checks (including both loyalty reconciliation checks) and stopped at unrelated `local-static-boundary.mjs`: the running Docker runtime is missing `/payroll-scheme-ui.js?rev=1`. Authenticated browser finance UI and real-document review are still outstanding. The old 1,500 ₽ reservation is preserved without financial changes. Roadmap remains L12.3, 43/49 (87%); no commit, push, or server deploy.
- Final code-health follow-up: the report now renders each incomplete-coverage reason as escaped list text, so excluded sales with missing closure dates are visible beside partial period totals. Contract, syntax, reconciliation QA, and source/dist parity pass after the final UI change. Full memory QA was rerun: 8/9 pass; the sole failure is still the unrelated stale Docker static boundary for the payroll scheme UI.

## 2026-10-03 — browser acceptance of loyalty reconciliation preview

- Opened the current source tree in a fresh, isolated AUTH_REQUIRED memory instance and signed in with QA-only credentials; no live local database rows were read or changed. The finance report route loaded in the browser, the “Обновить сверку” control refreshed successfully, and browser console reported no errors.
- Visual review found that memory coverage was styled green like a success notice and its causes were shown in English. Changed it to a visible amber warning, translated known coverage causes, localized the count-bearing missing-closure-date message, and retained HTML escaping for every displayed cause. The user-facing preview now visibly distinguishes verified zeros from unavailable values.
- In the report screen, verified current balance vs. period headings, empty state for old deposits, zero supported money/receipt totals, and explicit “Недоступно” for unsupported clawbacks, payouts, and refund/reopen movements. Browser snapshot and screenshot confirmed the page state; the QA-only report tab was left open at `http://localhost:41012/finance/report` for continued inspection.
- Source tree’s isolated server serves `/payroll-scheme-ui.js?rev=1` (HTTP 200); the pre-existing Docker previews on ports 45636/45637 still return 404, which explains the separate full-suite static-boundary failure. No unrelated Docker/payroll runtime was changed. Loyalty reconciliation contract, period-business QA, memory API/RBAC QA, syntax, JS/CSS source/dist parity, and scoped diff check PASS. Console errors: none. Roadmap remains L12.3, 43/49 (87%); historical source-document proof and broader local acceptance remain open. No commit, push, or server deploy.
## 2026-10-03 — Payroll run-to-entry linkage boundary audit

- Сверены миграция 077, payroll-scheme service/routes, legacy `payroll_entries` lifecycle и финансовый контракт. Подтверждено, что 077 не добавляет связь run→entry; текущая уникальность payroll entry допускает несколько правил для одного сотрудника и периода. Поэтому совпадения по сотруднику/периоду/сумме не являются доказательством происхождения начисления.
- Независимые system-architecture, finance-domain и code-health аудиты подтвердили: авторитетная сверка требует отдельной согласованной additive миграции, tenant-scoped linkage/idempotency и проверки периода/сотрудника/версии при создании начисления. MASTER уведомлён; он отложил общий payroll lifecycle пакет до устранения текущего дефекта полного PG regression harness и согласования владельца `server.js`.
- В `PAYROLL_ARCHITECTURE_CONTRACT.md` добавлена проверенная граница и перечень необходимых условий. Код, `server.js`, payroll entries, expenses, order/payment/loyalty ledgers, сменная касса и финансовые отчёты не менялись.
- Проверки в этом документационном пакете: сверка схемы/SQL/service/routes и итоговый scoped diff check; автоматические тесты не запускались, поведение кода не менялось.
- Следующий шаг после внешнего разблокирования: согласовать с MASTER lifecycle migration + HTTP boundary, затем внедрить exact run→entry linkage и owner-only diagnostic reconciliation с disposable PostgreSQL coverage. Сервер и production не затрагивались.

## 2026-10-03 — External payroll workflow references

- По исходному запросу владельца сверены официальные справочные материалы Deputy: защита pay-rate деталей сквозь People/Timesheets/Payroll, runs из утверждённых timesheets с сохранённой детализацией и историей, а также сравнение факта с альтернативной ставкой.
- Внешние примеры добавлены в payroll architecture contract как ориентиры, а не автоматически утверждённые бизнес-правила. Зафиксировано, что доступ к зарплатным суммам должен контролироваться во всех экранах/ответах, сравнение требует общего baseline, а официальный run должен сохранять первичные входы и историю.
- Источники: Deputy Help Center — sensitive pay rate permissions; Payroll Dashboard; Pay comparison report. Код и финансовые ledgers не менялись.

## 2026-10-03 — Payroll QA harness root cause and regression checks

- Повторно проверены payroll schemes/routes/UI contracts и миграция 077–079 на disposable PostgreSQL: все PASS; миграционный тест откатил свою отдельную схему.
- Разобран повторный full PG harness failure read-only: агрегированный `postgres-qa.mjs` использует persistent базу `hookah_local_qa`, где catalog показывает `payroll_calculation_runs`, но отсутствует `guest_account_entries` (`to_regclass` возвращает NULL). Отдельный свежий guest-loyalty suite в runner log прошёл. Это указывает на неполную старую QA fixture DB, а не на исчезновение таблицы внутри API-теста. MASTER передан безопасный вариант назначать агрегату disposable freshly migrated target через runner-owned `freshDatabase`; никакой ручной DDL/cleanup существующей QA базы не выполнялся.
- Пока общий regression не повторён на исправленном disposable target, payroll lifecycle/server integration остаются на согласовании. Код приложения и финансовые ledgers в этом пакете не менялись.

## 2026-10-03 — Payroll product defaults and source gates

- Добавлены проверяемые рабочие defaults для неоднозначностей ТЗ: пороговая премия начисляется назначенному eligible roster отдельно от sales-cap; неполная смена prorates только по owner-confirmed плану и утверждённым не пересекающимся интервалам; override действует по параметру/effective window, явный ноль сохраняется; unsupported historical formulas и неизвестное department mapping блокируют соответствующий production режим.
- Зафиксированы owner review persisted run → отдельное создание draft через существующий lifecycle, RUB-only до финансовой валютной поддержки, архивирование payroll history и lineage late refunds. Раздел 12 помечен как риск-инвентаризация; решения/defaults собраны в разделе 15 контракта.
- Повторно сверены `order_items` add/merge/move и `staff_work_logs`: attribution нельзя восстанавливать из стола/заказа, строка сейчас сливается между разными авторами, табель не имеет статуса утверждения. Требуется отдельное согласование POS/MASTER границ и настоящих источников скидок/возвратов.
- `git diff --check` по документам PASS. Код и тесты не менялись. Общий локальный PostgreSQL прогон MASTER на последнем наблюдении повторялся; 21/22 suite прошли до фикса test DB session-preferences, его отдельный прогон PASS. Повторный полный итог ожидается. Никаких серверных или production действий.

## 2026-10-03 — loyalty local acceptance follow-up

- Финансовый экран больше не сбрасывает KPI, если endpoint смены вернул ошибку/недоступен: допустимый ответ `current: null` остаётся подтверждённо закрытой сменой, а отсутствие ответа показано отдельно без класса «открыта/закрыта». Утверждение/отклонение скидки теперь объясняет `order_pricing_locked` после первого платежа; серверный финансовый guard сохранён.
- Portal source/dist синхронизированы; cache revision повышена до 447 на 33 HTML-маршрутах и в sync-скрипте. Browser QA теперь явно симулирует 503 `/api/shifts`, подтверждает, что выручка остаётся видимой, и проверяет сохранение заявки при pricing lock. Screenshot output сделан настраиваемым, так как Windows ACL рабочей папки блокирует перезапись PNG; это позволило завершить полный runtime-прогон.
- `finance-discount-runtime-qa.mjs` PASS: скидки и их отказ после фиксации цены, графики, 365-дневная прокрутка, расходы/повторы, payroll race, Fold drawer, reduced height и семь ширин экрана. `finance-report-browser-qa.mjs` PASS ранее в этой приёмке на 320/768/1440 px; disposable PostgreSQL suites гостевого loyalty API, акций, оплат и предоплат PASS; migration contract (81 replay-safe миграций), RBAC, memory contracts, JS syntax, portal source/dist parity и scoped diff check PASS.
- Roadmap: 45/49 подэтапов (91%), 11/13 этапов закрыты. Активная остановка — L12.3: документальная сверка старой брони с `deposit_paid=1 500 ₽`; финансовые строки, бронирование и предоплата не менялись и не удалялись. L13 остаётся незавершённым; полный memory QA по-прежнему имеет отдельное 8/9 ограничение Docker static boundary для payroll UI, не менялось.
- Preview остаётся локальным; GitHub, сервер и production не обновлялись.

## 2026-10-03 — Payroll run reproducibility schema gap

- Повторно проверена текущая миграция 077: `payroll_calculation_runs` хранит period и ссылку на scheme version, но не фиксирует timezone площадки или currency на самом запуске. Это мешает гарантировать воспроизводимость после будущего изменения настроек площадки/схемы.
- PAYROLL_ARCHITECTURE_CONTRACT.md теперь требует до official run source API additive payroll migration со snapshot IANA `venue_timezone` и ISO `currency` на run и их согласованной проверкой при создании; исторические значения не backfill-ить догадками.
- `git diff --check` проверен для документационного пакета. Код/миграции не изменялись до согласования migration boundaries с MASTER; production не затрагивался.

## 2026-10-03 — Loyalty role journey browser QA

- Добавлен `scripts/loyalty-journey-browser-qa.mjs`: запускает только отдельный memory-сервер на loopback с пустым `DATABASE_URL`, случайным портом и синтетическими гостем, правилом скидки, акцией, товаром и заказом. В cleanup входит и ошибка старта сервера.
- Сквозной браузер/API сценарий подтверждает активацию акции владельцем, выбор большего предложения (10% группы вместо 5% акции без сложения скидок), чтение акции менеджером и отказ ему в её изменении, расчёт цены кассиру и запрет чтения его финансового ledger. В UI дополнительно проверены карточка гостя с read-only остатками, бронь с «требуется 500 / получено 0 / остаток 500» и отсутствие горизонтального переполнения на 320/390/768/1440 px в loyalty, гостях, бронях и заказах. Кнопку приёма предоплаты показали, но не нажимали.
- После расширения сценарий повторно прошёл полный browser/API прогон: кассир открывает POS-заказ, видит итог 900 ₽ и объяснение выбранной скидки/неприменённой акции; форма оплаты становится доступна, но отправка не выполняется. Финансовая история гостя кассиру запрещена (403); открытие POS modal использует только GET.
- QA memory-сервер получил отдельный лимит запросов 5 000, чтобы полный сценарий не упирался в общий тестовый rate limit; при повторном сбое скрипт теперь выводит безопасную диагностику POS DOM и статусов `/api/session`, `/api/floor`, `/api/orders`. 
ode --check` и полный скрипт PASS. Финальный read-only code-health review — PASS; cleanup браузера и временного сервера сохраняется.
- В адаптивном прогоне проверены ширины 320/390/768/1440 px на `/admin#loyalty`, `/clients`, `/reservations`, `/orders`, `/` и `/finance/report`; это проверка layout маршрута отчёта, не приёмка его финансового содержимого. Синтетическая смена открывается с 0 ₽, бронь создаётся с требованием 500 ₽ и `verifiedDepositPaid === 0`; реальные платежи и подтверждения предоплаты не создаются.
- Roadmap остаётся 45/49 (91%), 11/13 этапов: L13.1/L13.3 остаются in progress до фактической проверки POS-экрана цены и финансового отчёта в рамках полного локального прохода. L12.3 ждёт исходного документа для записи `deposit_paid=1 500 ₽`. Денежную строку не удалял и не менял.
- Локальная БД, GitHub и сервер не затрагивались.

## 2026-10-03 — Payroll run metadata migration 081

- Добавлена additive миграция `081_payroll_run_metadata.sql`: nullable `venue_timezone` и ISO `currency` snapshots на `payroll_calculation_runs`, без DEFAULT и без backfill исторических запусков. Новая запись проверяет IANA timezone и точное соответствие timezone площадки/currency версии схемы под `FOR SHARE`; append-only run trigger из 077 сохраняет новые поля неизменяемыми.
- Payroll migration contract теперь проверяет replay 081, сохранение прежнего run с `NULL`, валидные новые snapshots и отказ на пропущенном/невалидном/несовпавшем metadata. Тест остаётся в rollback-изолированной схеме; существующие `payroll_entries` и `expenses` не изменяются.
- Отдельный `payroll-scheme-migration-contract.mjs` PASS: STATIC + PostgreSQL; 
ode --check scripts/payroll-scheme-migration-contract.mjs` PASS; 
ode scripts/migrations-contract.mjs` PASS (82 replay-safe migration files); scoped `git diff --check` PASS. Code-health final review: approve, блокеров нет.
- `PAYROLL_ARCHITECTURE_CONTRACT.md` обновлён: migration 081 закреплена за run metadata; будущая run→entry migration получает номер 082. MASTER подтвердил финансовую семантику: approved/paid payroll entries входят в начисленный P&L по периоду один раз, связанный payroll expense в P&L не дублируется, cash flow меняется только при фактической выплате. MASTER синхронизировал `FINANCE_MODEL.md`; дублированный фрагмент связи payroll-entry→expense исправлен коммитом `85d073c1`.
- MASTER подтвердил полный локальный PostgreSQL regression 31/31 PASS до этого scoped run-metadata contract. В рамках payroll stage shared `server.js`, `schema.sql`, POS, loyalty, payment, expenses и сменная касса не менялись; сервер/production не затрагивались.

## 2026-10-03 — Loyalty POS wallet tenders browser acceptance

- Расширен `scripts/loyalty-journey-browser-qa.mjs` на реальный UI → API → повторное чтение путь в отдельном loopback memory-сервере. В QA-only фикстуре owner создаёт гостю журналируемые 40 бонусов и 50 ₽ внутреннего денежного баланса; cashier оплачивает заказ 900 ₽ через POS тремя методами: 830 ₽ наличными, 20 бонусами и 50 ₽ с баланса гостя.
- Browser сеть подтверждает ровно три выбранных POST в `/api/orders/:id/payments`; закрытая продажа повторно читается кассиром, а owner перечитывает гостевую карточку/историю. Баланс бонусов сходится: 40 − 20 + 26 начислено по завершённому заказу = 46; денежный баланс: 50 − 50 = 0. Ledger содержит отдельные списания −20 бонусов и −50 ₽. До выполнения денежного сценария тест доказывает, что открытие/закрытие только окна цены не отправляет платеж.
- На POS нет горизонтального переполнения самой страницы, крестик закрытия и кнопка отправки достижимы прокруткой; однако геометрия полей тоже измеряется: на 320×740 все семь tender-полей выходят за правую границу модального окна на 20 px (`field.right=310`, `modal.right=290`). Скриншоты desktop, phone, Fold cover/inner, POS, гостя, брони и сверки сохранены в `tmp/loyalty-visual-review-20261003/` и просмотрены; POS clipping подтверждён, product code не менялся. Guest/бронь экраны и шесть loyalty маршрутов проверяются по остаткам и переполнению. Для синтетической брони UI сначала показывает `required=500`, `verified=0`, затем owner принимает 500 ₽ наличными через форму; изолированная API-ответка и перечитанная строка показывают `verified=500`, `remaining=0`.
- Owner campaign edit/save воспроизведён в memory browser: форма валидна, но при submit вместо PATCH показывает «Проверьте часовой пояс и корректность локального времени», запрос не отправляется. Диагностика указывает на `promotionLocalIso` в `portal.js`: для `Asia/Yekaterinburg` сдвиг +5 часов повторно вычитается на каждом из четырёх проходов (локальный `2026-10-03T08:33` не проходит обратную сверку). Product code не менялся по указанию оставить дефекты; кампаний edit/save остаётся блокером L13.3. Тестовый harness очищен от незавершённого submit assertion; остальные сквозные проверки продолжаются.
- 
ode --check scripts/loyalty-journey-browser-qa.mjs` и полный browser/API сценарий PASS; вывод QA отдельно перечисляет известное POS clipping. Тестовые платежи существуют только в уничтожаемом после прогона memory-процессе; ни локальная финансовая БД, ни внешний процессинг, GitHub или сервер не затронуты. Browser контексты используют выданные API сессии, поэтому отдельная форма логина не входила в этот прогон. После смешанной оплаты UI финансовой сверки перечитывает и показывает 46 бонусов / 0 ₽ на денежном балансе, 26 начисленных и 20 списанных бонусов, а также пополнение и списание депозита на 50 ₽; QA отдельно проверяет текст «Показатель недоступен в локальном preview» для неподдерживаемой memory-only метрики.
- Evidence добавлены в L13.3, но статус оставлен `pending`: desktop/mobile/Fold скриншоты созданы и просмотрены; POS clipping и owner campaign edit/save с timezone conversion ошибкой остаются воспроизведёнными незакрытыми дефектами. Скриншотная часть проверена, но полная UI приёмка не завершена. Roadmap invariant разрешает только один `in_progress` подэтап на этап; активным остаётся L13.1, поэтому агрегат 45/49 (91%), 11/13 завершённых этапов. L12.3 по старой записи `deposit_paid=1 500 ₽` открыт; финансовую запись не меняли и не удаляли.

## 2026-10-03 — Owner-only blocked payroll run service

- По согласованию с MASTER добавлен отдельный `payroll-calculation-run-service.js`. Он проверяет активного владельца и tenant-scoped версию схемы, фиксирует timezone/currency, период и idempotency key и сохраняет только неизменяемую попытку со статусом `blocked`, `source_coverage='unknown'`, `commission_basis='unknown'`, без checksum и с объяснением отсутствующих источников.
- Сервис не подключён к HTTP route и не создаёт `ready` runs, snapshots, adjustments, payroll entries, расходы или P&L/cash-flow движения. `server.js`, POS, loyalty ledgers, payroll lifecycle и финансовые отчёты не менялись.

## 2026-10-03 — Финальный повтор loyalty browser QA

- Удалён неиспользуемый layout-снимок из screenshot helper; поведение проверки и съёмки не менялось. 
ode --check scripts/loyalty-journey-browser-qa.mjs` и полный изолированный memory browser/API прогон PASS; `loyalty-progress.mjs --json` подтверждает 45/49 (91%), 11/13 этапов, текущий L12.3.
- Повторный прогон по-прежнему явно сообщает об известном clipping семи полей оплаты в POS на 320 px. Owner campaign edit/save с проблемой локального времени остаётся записанным в L13.3. Product-код и финансовые записи не менялись; GitHub и сервер не обновлялись.
- `scripts/payroll-scheme-migration-contract.mjs` расширен: PostgreSQL проверяет owner/tenant/draft-version границы, неверный период и idempotency key, одинаковый повтор, конфликт того же ключа для другой версии/периода, append-only run и отсутствие snapshot/adjustment/entry/expense side effects.
- Свежий изолированный PostgreSQL 16 runtime contract PASS; 
ode --check` сервиса и контракта, payroll scheme/routing contracts, `git diff --check` PASS. Code-health и QA повторно одобрили scoped diff. Изменения исходников и payroll contract зафиксированы в `7e5d060a`; concurrency race отдельными реальными соединениями остаётся усилением перед подключением `ready` runs.
- Source-backed `ready` по-прежнему зависит от согласованной POS attribution/net/refund границы и утверждённого attendance источника. Production/server не затрагивались.
## 2026-10-03 — Замена фонового видео авторизации

- По указанию пользователя новый `123.mp4` подключён как канонический `/assets/login-smoke-ambient.mp4`, используемый текущим контроллером и на экране входа, и на блокировке. Исходный ролик: H.264, 854×480, 24 fps, 73 кадра, 3.042 секунды, без аудио, 368868 байт.
- Синхронизированы `assets/login-smoke-ambient.mp4` и `dist/assets/login-smoke-ambient.mp4`. Существующее поведение muted/autoplay/loop/playsInline и разметка страницы не менялись. PNG poster/fallback сохранён прежним, поэтому reduced-motion и ошибка воспроизведения показывают статичный старый fallback.
- `auth-smoke-runtime-qa.mjs`, `auth-smoke-lifecycle-runtime-qa.mjs`, `auth-smoke-crop-contract.mjs`, `local-login-contract.mjs`: PASS. В браузере новый ресурс загрузился до `readyState=4`, воспроизводился muted/loop/inline, затем время перешло с 0.91 на 0.66 секунды через интервал 3.3 секунды — цикл подтвердился. `auth-smoke-assets-qa.mjs` остановился на проверке oversized suffix Range: текущий HTTP handler вернул 206 с полным файлом, как предусмотрено HTTP, а существующий QA ожидает 416; handler и тест не менялись в этой задаче. Остальные проверки до этого assertion прошли.

## 2026-10-03 — Payroll idempotency concurrency regression

- PostgreSQL контракт расчётной попытки расширен проверкой двух одновременных одинаковых запросов через два отдельных соединения. Барьер подтверждает, что оба запроса дошли до вставки до продолжения; тест сверяет одинаковые ID и неизменяемые метаданные, а в БД остаётся ровно одна запись на ключ.
- Для межсоединительного сценария только случайная payroll QA схема фиксируется перед тестом и удаляется в `finally`; барьер освобождается при ошибке, сессии закрываются, ошибка очистки не подавляется. Сценарий не меняет рабочие таблицы вне временной схемы.
- Полный migration contract PASS на отдельном PostgreSQL 16 контейнере; scheme, routes и UI contracts PASS; 
ode --check` и scoped `git diff --check` PASS. Code-health и QA проверили cleanup/concurrency diff. Никаких order/payment/loyalty ledgers, server routes, payroll entries, expenses, production или сервера не меняли.

## 2026-10-03 — Payroll cap basis and scope

- По согласованию с MASTER закреплён v1 preview default: `employee_department_day` cap использует оборот `turnoverCents`, атрибутированный конкретному сотруднику в конкретном цехе за venue-local день; commission остаётся рассчитанной от `commissionBaseCents`. Персональная выручка между сотрудниками не делится. Общий цеховой/сменный cap остаётся заблокированным до authoritative shift + department turnover источника и правила распределения.
- Добавлено отдельное поле `departmentTurnoverCents` для цеховой cap базы; прежнее `departmentSalesCents` сохранено с прежней commission-base семантикой. Контрактный пример отличает оборот 20 000 от commission base 8 000. Дополнительный тест подтверждает multi-line aggregation, изоляцию сотрудников и цехов: cap 2 400 для B и 3 600 для C.
- Проверки: payroll schemes, routes и UI contracts PASS; синтаксис и `git diff --check` PASS. Code-health и QA одобрили изменения; финансовый audit и system-architect review подтвердили область правила. БД, payroll lifecycle, expenses, POS, лояльность и сервер не менялись.

## 2026-10-03 — Payroll comparison UUID validation

- Исправлено некорректное преобразование ошибок ввода в 503: сравнение версий проверяет каждый `versionId` и `baselineVersionId` на UUID до открытия DB транзакции; неверный формат получает 400 `invalid_payroll_scheme_version_id`. Валидный, но отсутствующий или принадлежащий другому tenant ID остаётся единым 404 `payroll_scheme_version_not_found`.
- API contract проверяет malformed ID и baseline через pool, который падает при любом обращении к DB. PostgreSQL migration contract дополнен случаями отсутствующего и cross-tenant version; они используют отдельную временную схему и создают/удаляют только QA данные.
- Проверки: 
ode --check` для service и двух contract scripts; routes, schemes и UI contracts PASS; migration contract STATIC + PostgreSQL PASS на выделенной локальной БД `hookah_finance_qa`; `git diff --check` PASS. Code-health, system-architect и QA review: без замечаний.
- Изменены только `payroll-scheme-service.js` и две payroll contract scripts; POS, loyalty, server, migration files, payroll entries/expenses и production не менялись. Остальные отсутствующие payroll source contracts остаются прежним блокером для official run.

## 2026-10-03 — Payroll venue turnover manifest bounds and calendar edges

- Strengthened `payroll-schemes.js` venue daily turnover manifest validation with a hard 31-day calendar bound before date enumeration. Every payroll calendar walk now uses fixed-count offsets bounded to a valid single-month span; malformed multi-century coverage returns blocked without long iteration, and year 9999 end-of-month cannot overflow into a lexical loop.
- Corrected month-end calculation for proleptic years 0000–0099 using `setUTCFullYear`; exact contract fixtures run through full February 0000 (29 days) and December 9999 (31 days) to `ready`. Added tests for missing interior date, extra date, negative/fractional/unsafe amounts, malformed coverage, far-future coverage, max 31-day boundary, terminal-year boundary, and multi-century invalid period.
- Verification: payroll schemes, routes, UI contracts PASS; syntax checks and scoped `git diff --check` PASS. Migration contract STATIC PASS; PostgreSQL runtime was not run in this continuation. Code-health and QA independently reviewed the bounded loops and terminal calendar cases: PASS.
- Only payroll calculator and its focused contract test were changed for this step. No server/POS writes, database migrations, payroll lifecycle, finance/loyalty ledgers, or production/server deployment were changed.

## 2026-10-03 — Loyalty POS mobile discoverability and keyboard access

- Для узкого POS окна добавлена видимая подсказка прокрутки только когда доступны бонусы/деньги гостя/предоплата брони; пояснение цены теперь достижимо клавиатурой и имеет заметный focus outline. Обновлены `index.html`, `style.css`, `scripts/loyalty-journey-browser-qa.mjs`, sync revision и соответствующие dist-ассеты; CSS rev 392.
- Полный `loyalty-journey-browser-qa.mjs` PASS на одноразовом loopback memory-сервере: подсказка, keyboard focus, адаптивная геометрия 320/390/768/1440 и Fold, кассирская синтетическая оплата cash/bonus/deposit и повторное чтение owner ledger/report; живые платежи не использовались. Promotions/reconciliation contracts, JS syntax, CSS source/dist parity, опубликованные ссылки ревизий и `git diff --check` PASS. Code-health review: блокеров нет.
- В code-health review отдельно замечено ранее существовавшее изменение оформления чекбоксов настроек staff permissions вне loyalty области; оно не корректировалось. CSS подсказка реализована как generated content, что reviewer отметил как не гарантированную для каждого screen reader доступность.
- Финансовый legacy `deposit_paid=1 500 ₽` сохранён; документальная сверка исходной записи остаётся активным L12.3. Roadmap статусы не переставлены: прогресс остаётся 45/49 (91%), 11/13 этапов, до последовательного закрытия L12.3.
- Локальная постоянная БД, GitHub и сервер не изменялись.
## 2026-10-03 — Тумблеры в настройках интерфейса

- Квадратные чекбоксы в карточке «Интерфейс и главная» заменены визуально на компактные оранжевые переключатели для темы, блоков главной, пунктов меню и финансовых показателей. Состояния фокуса, отключения, светлой темы и reduced motion учтены; семантика checkbox и существующее сохранение настроек не менялись.
- Изменены `style.css` и его опубликованная копия `dist/style.css`; синхронизация выполнена 
ode scripts/sync-published-assets.mjs` (команда также скопировала уже имевшиеся незакоммиченные исходники в dist).
- Проверки: 
ode --check portal.js` и `git diff --check -- style.css dist/style.css portal.js dist/portal.js` — PASS. `scripts/interface-preferences-browser-qa.mjs` не удалось завершить в этой среде: локальный сервер теста не сообщил о готовности до ручной остановки; полноценная браузерная проверка остаётся непроверенной.

## 2026-10-03 — Payroll venue turnover preview source adapter

- По согласованной с MASTER границе добавлен отдельный read-only owner/tenant-scoped builder дневного venue turnover. Он берёт закрытые `orders.final_total_snapshot`, относит заказ к дню через timezone площадки и формирует каждый день периода, в том числе нулевой. Суммы переводятся в безопасные целые копейки; watermark реагирует на изменение снимка, но явно помечен только для preview change detection.
- Источник возвращает `official:false`, `persistence:'none'`, `previewOnly:true`; не строит line attribution, commission base или attendance, не подключён к HTTP/run и не может создавать snapshots, payroll entries или expenses. Заказ без `closed_at` или `final_total_snapshot` блокирует серию; независимый payroll fallback не вводится.
- Contract QA проверяет tenant isolation, активного owner, локальную полночь и секунду перед ней, closed/open статус, другую площадку, zero day, изменение watermark, некорректные периоды и legacy NULL source fields. Изолированный PostgreSQL runtime PASS на `hookah_finance_qa` с транзакционной временной схемой; static/syntax/diff checks PASS. System architect и code-health review PASS; QA дал ту же read-only проверку, но отдельно не смог подключить свой runtime DSN.
- Изменены только `payroll-venue-turnover-source.js`, его contract test и payroll architecture contract. `server.js`, POS, migrations/run→entry 082, line-level discount/refund allocation, loyalty ledger, attendance и финансы не менялись; production/server не затронуты.

## 2026-10-03 — Локальная сборка loyalty preview и runtime manifest

- Создан и проверен custom-format backup локальной PostgreSQL до применения миграций; миграции 077–081 применены по одной в отдельных транзакциях. Изолированный preflight на восстановленной копии прошёл до применения на локальной БД.
- Починена первопричина неполного Docker image: в Dockerfile добавлены runtime-модули `payroll-venue-turnover-source.js` и `payroll-scheme-ui.js` вместе с модулями payroll/loyalty, которые ранее уже оказались достижимы из server.js. Recursive deploy contract и local static boundary теперь PASS.
- Локальный CRM image пересобран и контейнер перезапущен; Docker health `healthy`, `/api/health` возвращает `ok`, экран финансов и `/payroll-scheme-ui.js?rev=1` отдаются с HTTP 200. Локальный адрес: `http://127.0.0.1:45636/login`.
- Loyalty reconciliation, guest account ledger и reservation prepayment memory QA PASS; loyalty reconciliation contract PASS; payroll migration static contract PASS. PostgreSQL runtime payroll migration contract в этой проверке пропущен намеренно (включён явный `PAYROLL_MIGRATION_STATIC_ONLY=1`); scoped Git diff whitespace check PASS.
- Read-only SQL сверка подтвердила для прежней брони: `deposit_required=1500`, `deposit_paid=1500`, `verified_deposit_paid=0`, review `unreviewed` с snapshot 1500 ₽, квитанций 0. Деньги и исходная строка не изменялись и не удалялись.
- Полный финансовый экран требует действующую tenant-owner сессию; имеющийся demo platform owner не имеет этого tenant-разрешения. Не создавал привилегированную учётку и не обходил auth. Поэтому реальный owner UI проход и L12.3 остаются незавершёнными; roadmap сохраняет 45/49 (91%), 11/13 этапов. GitHub и production server не обновлялись.

## 2026-10-03 — Safe signed payroll comparison aggregates

- Закрыта найденная code-health ошибка в payroll scenario compare: агрегированная разница между версиями теперь проверяется по обеим границам `Number.MIN_SAFE_INTEGER` / `MAX_SAFE_INTEGER`; если суммарные копейки нельзя представить точно, значение возвращается 
ull` с `amount_exceeds_safe_integer_cents`.
- PostgreSQL regression использует двух сотрудников с максимальными безопасными выплатами и нулевую схему, доказывает отрицательное суммарное переполнение и блокирует неточную дельту. Проверен и положительный итог выше safe range. Preview/compare не меняют payroll runs, snapshots, entries или payroll expenses.
- Проверки: syntax checks, payroll schemes/routes/UI contracts и полный migration contract с PostgreSQL PASS; контракт работал в изолированной временной схеме `hookah_finance_qa`. Code-health и finance-domain reviews: PASS. Изменены только `payroll-scheme-service.js` и payroll migration contract; ledgers, server routes и production не затрагивались.

## 2026-10-03 — Owner-only sourced venue turnover preview

- Added `POST /api/payroll/versions/:id/preview/venue-turnover`, delegating through the existing owner-only route guard to `previewWithVenueDailyTurnover`. The UI now offers a separate scenario action and shows daily turnover from closed `final_total_snapshot` orders. Employees, line authorship, discounted/refunded commission base and attendance remain caller-supplied scenario values; the result stays `official:false`, `persistence:none`, preview-only, with watermark explicitly limited to change detection.
- Updated the payroll UI published copy and cache revision to 2. Shared finance/sync files had parallel loyalty changes; only the payroll script reference/revision strings were edited and the full sync was not run.
- Verification: route and UI contracts, pure scheme and calculation QA, service migration contract and venue source contract passed; the latter two ran against isolated PostgreSQL. JS syntax and scoped `git diff --check` passed. Independent code-health and QA reviews found no implementation blockers; one route-test assertion was strengthened per review. Browser UI QA for the new button is not yet run.
- Local only. No server deployment, migrations, `server.js`, POS, entries/expenses, finance or loyalty ledgers were changed. Current payroll feature changes are not yet committed because finance HTML/sync files are being concurrently edited by the loyalty task; preserve the payroll `rev=2` strings when it completes.
## 2026-10-03 — Loyalty локальный runtime и доступность оплаты

- Применена только миграция 076 к основной локальной БД после свежего custom-format backup и независимых проверок data/architecture/finance reviewers. Верифицированы immutable-history триггеры, creator FK с RESTRICT и deferred product-scope FK; старая бронь 84000000-0000-0000-0000-000000000001 и 1 500 ₽ оставлены без изменений.
- На восстановленной копии и отдельном disposable PostgreSQL прошли migration upgrade 076–081, promotions cleanup, guest-loyalty API и reservation-prepayment PostgreSQL QA: PASS. В этой сессии также прошли promotion/reconciliation contracts и guest-ledger/reservation memory QA: PASS.
- Подсказка о прокрутке мобильного списка способов оплаты теперь находится в DOM как читаемый текст с role=note; QA проверяет текст, семантику и видимость. Обновлены исходники и dist, stylesheet cache revision 393. Code-health review: PASS; root/dist хеши CSS и index совпадают.
- Docker image `hookah-pos:unreleased` пересобран и локальный CRM-контейнер перезапущен. `http://127.0.0.1:45636/api/health` отвечает `ok`; изолированный owner preview на `http://127.0.0.1:45640/finance/report` показывает сверку без расхождений. Новая финансовая запись не создавалась.
- Полный browser journey запускался до замены CSS-подсказки DOM-текстом; после этой точечной правки новый Playwright-прогон недоступен без `PLAYWRIGHT_PACKAGE_PATH`. JS syntax, scoped diff check и независимая проверка новой DOM-семантики пройдены; финальный скринридерный проход остаётся в L13.
- L12.3 не закрыт: квитанций к старой сумме нет, документального основания менять или удалять запись нет. Прогресс остаётся 45/49 (91%), 11/13 этапов выполнено. GitHub и production server не изменялись.

## 2026-10-03 — Loyalty browser и PostgreSQL повторная приёмка

- Нашёл Playwright в bundled Node runtime и выполнил полный `loyalty-journey-browser-qa.mjs` на отдельном memory-сервере с уже установленным Chrome: PASS. Проверены owner/manager/cashier, акция, групповая скидка, бонусный и денежный тендер, экран гостя, отчёт, keyboard focus, размеры 320/390/768/1440 и Fold; mobile screenshot показывает читаемую подсказку прокрутки. Платежи синтетические, в постоянную БД не записываются.
- На выделенной disposable PostgreSQL успешно прошли migrations-upgrade, guest-loyalty API, promotions, reservation-prepayment и paid-order-balance QA. Reservation-prepayment сценарий прогнан дважды подряд на одной БД; защита истории осталась включённой после каждого запуска.
- Повторный прогон выявил утечку состояния в самом QA teardown: очистка фикстур удаляла immutable trigger истории сверки и не восстанавливала его. Исправлена только очистка `scripts/reservation-prepayment-postgres-qa.mjs`: триггер теперь восстанавливается во вложенном `finally` даже при ошибке очистки; продуктовые SQL/API пути не менялись. Code-health и finance-domain final review: PASS.
- Основной локальный CRM остаётся healthy после пересборки. Историческая бронь с 1 500 ₽ не изменялась. L12.3 остаётся незакрытым до проверки первичных документов реальной брони; L13.1/L13.3 и L13.4 не переставлялись из-за последовательной зависимости от L12.3. В GitHub/на сервер изменений нет.

## 2026-10-03 — Loyalty: точность заголовка исторической сверки

- В финансовом отчёте заменил вводящее в заблуждение «Проверено N броней» на «Записей в списке: N»: API возвращает число строк списка, но каждая запись может оставаться непроверенной. Состояние и сумма исторической брони не менялись.
- Синхронизировал `portal.js` с `dist/portal.js`, поднял portal cache revision до 449 во всех опубликованных исходных и dist маршрутах, добавил контракт на нейтральную подпись. Исправил номер CSS revision в asset sync с 392 на фактически опубликованный 393, чтобы генератор не возвращал HTML к устаревшей версии.
- `loyalty-reconciliation-contract`, `local-deploy-contract`, `local-design-contract`, JS syntax и scoped `git diff --check`: PASS; финальный code-health review: PASS. По сигналу локального design contract выровнял alias `dist/finance/index.html` с уже опубликованным payroll UI revision 2; scan не нашёл несовпадений source/dist HTML, все 33 маршрута используют portal revision 449.
- Локальный CRM пересобран и перезапущен; `/api/health` отвечает `ok` с PostgreSQL. Изменения остались локальными; GitHub и сервер не трогал.

## 2026-10-03 — Loyalty: повторная полная локальная приёмка

- Повторно прогнал browser journey на изолированном memory runtime: PASS для owner/manager/cashier, loyalty settings, кампании, скидки, бонусов, денег гостя и предоплаты; все записи синтетические. Просмотрел mobile/desktop captures. Визуальных блокеров нет; зафиксированы только косметические замечания о длинном названии тестового товара и кратком toast поверх деталей квитанции.
- На disposable PostgreSQL последовательно прошли migration upgrade/replay, guest loyalty API, loyalty promotions, reservation-prepayment и paid-order balance QA. Дополнительно прошли memory guest ledger, reservation prepayment, paid-order balance, reconciliation и promotions contracts.
- Read-only сверка основной локальной БД: одна старая бронь; 1 500 ₽ в `deposit_paid`, 0 ₽ в подтверждённом поле, квитанций нет, имеется только baseline `unreviewed`. Схемы вложений документов бронирования нет. Финансовый reviewer подтвердил: только этих сведений недостаточно для статусов `documents_not_found` или `disputed`; документальный поиск по источникам заведения ещё не выполнен. Все денежные данные оставлены без изменений.
- Этапные номера сохраняются: L12.3 остаётся первым незавершённым подэтапом, поэтому строгий последовательный progress tracker не закрывает последующие L13 acceptance statuses, даже если их синтетические проверки пройдены. Локальный CRM healthy; GitHub/сервер не затрагивались.

## 2026-10-03 — Payroll pure calculator: approved attendance boundary

- Исправлен pure-core сценарный калькулятор: сменный оклад теперь формируется из отдельного набора утверждённых смен и пропорционален фактическим минутам относительно плановых; продажи больше не создают смену. Полнота утверждённого табеля требует отдельного `attendanceCoverage` manifest с watermark, а строки вне кадровых дат блокируют результат. UI объясняет ошибки табеля.
- Закрыты финансовые края: milestone не начисляется после `activeTo`; любой положительный неатрибутированный оборот блокирует период; персональные overrides разрешают соседние непересекающиеся effective windows и блокируют пересечение; неверные коллекции схем безопасно дают blocked вместо исключения.
- Добавлены регрессионные контракты для нулевых продаж на смене, долей двух смен, отсутствующего/неполного табеля, неактивного сотрудника, неатрибутированного оборота, malformed scheme и границ override. Обновлены опубликованный UI mirror и payroll architecture contract; точные входы, формулу и нерешённое отсутствие authoritative source adapter зафиксировали.
- Проверки: 
ode --check` калькулятора и UI source/dist; `payroll-schemes-contract`, `payroll-calculation-qa`, `payroll-scheme-routes-contract`, `payroll-scheme-ui-contract`, scoped `git diff --check` — PASS. Независимая code-health baseline выявила исходные дефекты; финальный аудит подчеркнул полноту табеля и кадровые даты, оба закрыты с отдельными проверками. Официальный run остаётся blocked до интеграции полного авторитетного attendance и POS source adapter.
- Только локальные файлы; сервер, production, `server.js`, POS, loyalty и финансовые ledgers не менялись, commit/deploy не выполнялись.

## 2026-10-03 — Payroll attendance completeness and trace detail

- Усилил предыдущий payroll пакет после независимого code-health review: полный отдельный `attendanceCoverage` теперь обязателен; смены и продажи вне кадрового окна блокируются; malformed employee/role rows возвращают `blocked`, а не исключение. Daily result и owner preview раскрывают ID смены, фактические/плановые минуты и начисление по смене.
- UI default scenario содержит attendance и явный scenario-only coverage watermark; клиент и payroll service ограничивают табель 20 000 строками, чтобы размер сценария не обходил лимиты для продаж. Сценарный DB-contract fixture обновлён под новый источник смен.
- Проверки: схемы/UI/routes/calculation/finance expense contracts PASS; venue turnover и migration contracts PASS в явном STATIC_ONLY (runtime PostgreSQL URL в этой задаче не задан); JS syntax checks и scoped diff check PASS.
- Official source adapter всё ещё не реализован: действующий staff_work_logs не имеет approval и расписание может отсутствовать, а POS order_items не хранит исполнителя строки/line-level discount/refund allocation. Поэтому эти изменения улучшают pure calculator/preview, но не открывают ready calculation run и не меняют payroll entries/expenses.
## 2026-10-03 — Payroll Finance-compatible venue preview

- Payroll preview venue turnover now resolves closed orders using `final_total_snapshot`, or the same Finance-compatible legacy calculation from saved order items, approved discounts, guest-group discount and VIP minimum. The response labels fallback count and source; watermark covers item/discount formula inputs. UI continues to state that line attribution, commission net of refunds and attendance are scenario-only, and the source cannot create official runs.
- Expanded the isolated PostgreSQL contract fixture to cover Finance fallback from saved lines and approved discount, item mutation and watermark change. Static contract checks SQL boundary markers.
- Verification: JS syntax checks, payroll venue-source STATIC_ONLY, scheme UI/schemes/calculation/routes and finance payroll-expense contracts, scoped `git diff --check` — PASS. PostgreSQL runtime was not run because no isolated `MIGRATIONS_PG_TEST_DATABASE_URL` is configured. This is an explicit runtime verification gap.
- Local workspace only. No server/production access, DB migrations, server/POS/loyalty writes, payroll-entry/expense writes, commits or deployment.
## 2026-10-03 — Payroll benchmark references

- Добавил в draft payroll source contract короткое сопоставление с официальной документацией Oracle Simphony: Employee Journal отделён от Employee Closed Check; job code может выбираться при clock-in; timecard edits могут аудироваться и подтверждаться сотрудником. Указано, что это industry patterns, а не перенос commission policy или трудовых правил.
- Использованы первичные источники Oracle: POS Reports, Simphony Employees/Job Codes, Simphony Time Cards. Код и чужие POS/loyalty-файлы не менялись.
- Проверка: Markdown links и scoped `git diff --check` — PASS.

## 2026-10-03 — Loyalty PostgreSQL browser journey and sequential roadmap

- Добавлен PostgreSQL-режим `loyalty-journey-browser-qa.mjs`; только штатный `local-full-pg-regression.cjs` может выдать ему fresh `loyalty_qa_<random>` из disposable loopback-контейнера. Runner проверяет ownership/loopback, отсутствие существующей БД, загружает schema+migrations и удаляет только созданную БД после завершения дочернего CRM/browser процесса. В тестовый процесс не передаются настройки основной БД/учётные данные.
- Сквозной PostgreSQL browser путь начинает с пустого tenant DB, проверяет `/api/setup/status`, создаёт владельца через реальный `#setup-form`, подтверждает server-backed session, затем прогоняет скидку группы и предложение акции, баланс/историю гостя, приём предоплаты брони и перечитывание UI, права менеджера, кассирскую скидку и смешанную оплату cash/bonus/deposit. Отчёт повторно читается после операций; отдельный SQL проверяет, что bonus/deposit wallet равны своим ledger totals. Все платежи синтетические, внешние процессоры не вызывались.
- PostgreSQL browser QA и исходный memory browser QA прошли; fail-closed regression runner guards (35 случаев), PostgreSQL URL/container safety contract, ordered progress contract и scoped JS/diff checks прошли. Архитектурный и финальный code-health reviews подтверждают изоляцию и корректный cleanup. Остаток покрытия: создание/редактирование группы и проведение принятой предоплаты из UI в связанный заказ не входят в этот browser сценарий; соответствующие API/ledger пути уже покрыты отдельными contract/PostgreSQL тестами. Ручная скидка проверяется отдельными L03 contracts.
- Roadmap теперь отделяет последовательный счётчик от проверок, отмеченных завершёнными вне очереди. Первым открытым остаётся L12.3: одна старая бронь хранит legacy `deposit_paid=1 500 ₽`, но verified receipt = 0 и квитанций нет. Найденный demo-note не является первичным документом; без него не отмечается финансовая disposition, запись/касса не изменялись и не удалялись. L13.1–L13.3 отмечены завершёнными с сохранением фактических проверок, но L12.3 остаётся единственным активным подэтапом; прогресс по очереди 43/49 (87%), независимо завершено 47/49 (95%), в последовательной очереди 6 подэтапов.
- Read-only finance audit также выявил pre-existing закрытую демонстрационную смену с сохранённым expected cash 37 900 ₽ против 13 820 ₽, полученных из доступных связанных исходных строк (необъяснённый разрыв 24 080 ₽); закрытие — 38 400 ₽, variance +500 ₽. Текущие строки могут быть неполным/устаревшим seed и не доказывают недостачу. Смена и суммы не исправлялись; финансовая сверка остаётся исключением для triage, а не доказанным убытком.
- Затронуты `scripts/loyalty-journey-browser-qa.mjs`, PG QA allowlists/runner, `scripts/loyalty-progress*.mjs`, `docs/requirements/LOYALTY_ROADMAP.json`, этот журнал. Постоянная локальная БД, GitHub и сервер не менялись; publish/deploy не выполнялись.
## 2026-10-03 — Payroll isolated PostgreSQL contract pass

- Reused the project's verified disposable regression container on loopback `127.0.0.1:31931` (auto-remove QA image, synthetic credential, no bind mounts). Ran `payroll-scheme-migration-contract.mjs` and `payroll-venue-turnover-source-contract.mjs`; both completed STATIC + POSTGRESQL PASS, with temporary payroll schemas cleaned up.
- Runtime QA caught two test fixture errors, both corrected: aggregate underflow needed a complete approved shift for the second employee; legacy fallback order closing at `2026-09-02T20:00Z` belongs to `2026-09-03` in `Asia/Yekaterinburg`. Final PostgreSQL runs pass. Independent code-health review confirmed both fixture corrections and source/service diff without findings.
- Re-ran scheme, calculation, routes, UI, finance expense contracts and JS/MJS syntax checks; PASS. Scoped `git diff --check` PASS.
- The shared-workspace MASTER and loyalty chats still have not supplied technical source-contract approval. No POS/server, loyalty/finance ledger, attendance, payroll entry, expense, or production/server changes were made. No commit/deployment.
## 2026-10-03 — Payroll finance source-of-truth boundary

- Уточнил source contract: Finance model уже разрешает legacy fallback из сохранённых строк и одобренных скидок; payroll preview воспроизводит его только для venue-only сценария. Production adapter обязан читать Finance-resolved canonical totals или переиспользовать общий Finance-owned evaluator, не разводить вторую формулу.
- Upstream POS/discount/refund/attendance ownership и chat approval не получены; поэтому новых продуктовых записей/миграций не добавлял.
- Verification: scoped Markdown/doc `git diff --check` PASS. Предыдущая runtime validation остаётся: payroll migration и venue-source contracts прошли на disposable PostgreSQL; independent code-health review подтвердил тестовые фикстуры.

## 2026-10-03 — Payroll source boundary and current checks

- Re-read the active MASTER and loyalty threads. MASTER has reconfirmed local-only work but has not yet answered the requested POS/HR source-contract and file-ownership decisions. Loyalty is still running its audit; its current output contains no payroll discount/refund contract answer.
- Independent read-only architecture and code-health reviews confirm snapshot storage exists, while source-backed ready runs do not. The only safe next implementation candidate is a payroll-owned, immutable approval manifest over closed existing attendance rows; MASTER/HR must confirm owner approval authority before schema/API/UI work. It would not authorize a ready run without line author, canonical net/refund, and Finance source coverage.
- Code-health identified a scenario calculator risk: multiple raw attendance intervals for one planned shift could duplicate fixed pay. Official input normalization must consolidate/check planned-shift identity before exposing calculator-ready attendance.
- Current local checks: payroll scheme, calculation, routes, UI, finance-expense contracts PASS; payroll migration and venue-source contracts PASS in explicit STATIC_ONLY. PostgreSQL runtime was not run in this turn because isolated test database URLs were not configured. JS syntax and scoped diff whitespace checks PASS.
- No product files changed in this turn; no POS, HR, loyalty, finance, payroll-entry, expense, database, or server writes/deployments.

## 2026-10-03 — Payroll source crosswalk with Finance and Loyalty

- Cross-checked payroll draft against accepted local Finance/Loyalty contracts and migrations 021, 074, and 075. Current policy is explicit: choose one discount offer (promotion > guest group > manual), apply VIP minimum after discount, and apply bonus tender after price; bonus/deposit/reservation prepayment are tenders/liabilities, not discounts or incremental revenue.
- The source contract now records those compatible decisions and the remaining evidence gap: pricing lock stores order-level selection/totals but no per-order-item discount allocation; payments do not prove refund line/source; time schedules/logs remain mutable and unapproved. Official line commission and ready-run remain blocked until those owner sources exist.
- Verification: cited local contract/migration files exist; scoped Markdown diff check PASS. No code, ledger, HR/POS, payroll-entry, expense, DB runtime, or deployment changes.


## 2026-10-03 — Payroll attendance approval manifest (local)

- Добавлен отдельный owner-only процесс проверки и подтверждения посещаемости за период: чтение `staff_schedules`/`staff_work_logs` только в tenant scope, проверка полноты и неоднозначностей, нормализация пересечений внутри однозначной смены, водяной знак источника, неизменяемые ревизии и просмотр устаревшего снимка. Исторические строки архивированных сотрудников включаются; пустой период блокируется. На экране видны дата, сотрудник, плановые/фактические минуты и исходные интервалы; длинный список разбит на страницы, подтверждение доступно после просмотра каждой.
- Migration `082_payroll_attendance_approvals.sql` добавляет только payroll-owned append-only таблицы. Approval не меняет HR/POS/payments/loyalty/shift-cash данные, `payroll_entries` или `expenses`. Технически официальный run пока не потребляет этот manifest: source-backed `ready` остаётся заблокирован до POS line author, discount/refund allocations и Finance turnover contract; migration 082 отдана посещаемости, будущая run→entry связь проектируется позже.
- Контракты расширены для API owner-only, replay миграции, пустых/open/unmatched/ambiguous интервалов, архивного и чужого tenant, слияния пересечений, повторных и конкурентных утверждений (один и разные idempotency keys), stale watermark, неизменяемости скопированных минут/интервалов и отсутствия новых payroll/expense/shift/payment/order/loyalty ledger rows. Source UI синхронизирован в `dist` точечной копией профильного publish asset; общий publish/deploy не запускался.
- Проверки PASS: JS/MJS syntax; `payroll-schemes-contract.mjs`, `payroll-calculation-qa.mjs`, `payroll-scheme-routes-contract.mjs`, `payroll-scheme-ui-contract.mjs`, `finance-expense-payroll-status-contract.mjs`; `payroll-venue-turnover-source-contract.mjs` STATIC_ONLY; `payroll-scheme-migration-contract.mjs` STATIC + PostgreSQL на проектном disposable loopback QA контейнере `127.0.0.1:31931` (одноразовая schema создана/удалена контрактом); scoped `git diff --check`.
- System architect, code-health и data/finance ревью подтвердили границы и проверки. MASTER уведомлён о миграционной нумерации и локальном режиме, но технического подтверждения source/file-contract пока не дал; не отправлял новые параллельные правки в `server.js`/POS/финансы/лояльность. Production/server не изменялись.


## 2026-10-03 — Loyalty: booking-to-POS full UI allocation

- Расширен сквозной browser journey: владелец создаёт/редактирует группу в UI, принимает синтетическую квитанцию по брони и начинает визит кнопкой на строке брони. Новый заказ сразу фиксирует ID/название/процент активной группы этого заведения; приоритет скидки группы проверяется против активной акции 5% на примере 10% против 5% (итог 900 ₽ с базы 1 000 ₽). Исправлены PostgreSQL OrderRepository и memory-путь создания.
- Найден и исправлен CSS-дефект POS: авторское display:grid показывало строки с hidden. Скрытый пункт не занимает сетку на desktop/mobile; browser assertions проверяют видимость только доступных полей. Поднята версия shared CSS до 394 и синхронизирована во всех опубликованных исходных/ dist HTML ссылках, source/dist CSS остаются парными.
- Manager UI зачёл 500 ₽ квитанции в заказ, повторно открыл оплату с остатком 400 ₽ и закрыл заказ наличными. Browser/API/независимый SQL подтвердили allocation к исходной квитанции и заказу, нулевой доступный остаток, финальные бонусы 73 и ledger 73, начисление периода 53, деньги гостя 0 ₽ и отчёт collected/applied 500 ₽, unapplied 0 ₽.
- Проверки: 
ode scripts/loyalty-journey-browser-qa.mjs` (memory) PASS; 
ode scripts/local-full-pg-regression.cjs loyalty-journey-browser-qa.mjs` (одноразовая изолированная PostgreSQL) PASS; reservation-prepayment-postgres-qa и paid-order-balance-postgres-qa через безопасный isolated runner PASS; migrations-contract (83 migration files), loyalty promotions/pricing, memory guest ledger/reservation-prepayment/reconciliation, loyalty progress, PostgreSQL QA safety и local design contracts PASS; 
ode --check` для скрипта, db.js, server.js и sync script; scoped `git diff --check` PASS.
- Основная локальная БД и её денежные данные не менялись. GitHub/сервер не трогали. L12.3 остаётся первым незакрытым последовательным шагом: документального основания по старой legacy-сумме брони всё ещё нет; прогресс/номер этапов не сдвигал.

## 2026-10-03 — approved-attendance payroll scenario preview (local)

- Added an owner-only `/api/payroll/versions/:id/preview/approved-attendance` action and finance-panel control. Service reads scheme, source manifest and latest immutable attendance approval within one tenant-scoped `REPEATABLE READ READ ONLY` transaction; it rejects incomplete/stale/unapproved sources and overwrites caller-provided attendance and coverage watermark with approved shift snapshots.
- UI reports approval revision/period and explicitly states sales, line author, discount/refund and turnover remain scenario data; response remains `official:false`, `persistence:none`. No calculation run, `payroll_entries`, expense, POS, cash-shift, payments, orders or loyalty ledger records are written. Payroll architecture contract updated; only `dist/payroll-scheme-ui.js` was point-copied from its source.
- Added routes/UI contracts and PostgreSQL integration coverage for owner-only POST, safe stale rejection, forged caller attendance replacement, archived employee shifts, prorated pay, and zero financial side effects. Official `ready` run remains blocked pending confirmed upstream POS/Finance line-author, net-after-discounts/refunds and turnover coverage contracts.
- Verification: 
ode --check` on changed JS/MJS files; payroll routes/UI, calculator, financial expense contracts and disposable PostgreSQL migration/preview test; scoped `git diff --check`. Local workspace only; no server deploy, publish, or commit.
- Independent system-architecture review noted malformed calculation dates were not rejected until the calculator and the panel could distinguish approval month from selected calculation sub-period more clearly. Tightened strict date/order validation before source reads and updated the approval notice to show both periods; added invalid/reversed date assertions.
- Independent code-health and Finance/data reviews: PASS, no blocker; their reports confirm same-transaction snapshot consistency, owner/tenant boundary and no posting side effects.

## 2026-10-03 — Loyalty legacy-deposit evidence review (read-only)

- Повторно проверена локальная строка брони с legacy `deposit_paid=1 500 ₽`: она помечена заметкой `DEMO`/synthetic, verified receipt = 0, квитанций и allocations нет; связанный заказ открыт, содержит 2 позиции, платежей нет. Последняя документальная сверка остаётся `unreviewed`, доказательная ссылка и соответствующее audit event отсутствуют.
- Просмотрены доступные локальные исходники/архивы: первичного документа, банковской записи или внешнего подтверждения не найдено; резервные копии БД сами по себе платёж не подтверждают. Поэтому `documents_found` и `documents_not_found` не выбраны. Суммы, бронь, заказ, квитанции, balances и касса не изменялись и не удалялись.
- Обычный локальный UI показывает форму входа без активной сессии. Для записи append-only `disputed` нужна авторизованная owner/admin finance-сессия; auth/session не создавалась и не обходилась. L12.3 остаётся единственным препятствием последовательному продвижению; автоматическая нумерация не сдвигалась.
- Финальные локальные контракты текущего кода: `migrations-contract.mjs` (83 replay-safe migrations), `loyalty-reconciliation-contract.mjs`, `loyalty-reconciliation-memory-qa.mjs`, `finance-rbac-runtime-qa.mjs` и `loyalty-progress-contract.mjs` — PASS. Предыдущий browser journey, isolated PostgreSQL QA, UI/source-dist и code-health PASS сохранены в соседней записи журнала.
- Локальная БД, GitHub и сервер не изменялись; commit/deploy не выполнялись. Чтобы закрыть L12.3, нужен исходный документ/подтверждение происхождения записи и вход владельца/администратора с финансовым правом.

## 2026-10-03 — Payroll snapshot mapping DTO (local, disconnected)

- Добавлен чистый serializer DTO для преобразования уже готового расчёта и полного канонического source manifest в строки payroll snapshots. Он не читает POS/HR, не создаёт runs/snapshots/entries/expenses, не авторизует статус `ready` и не подключён к сервису записи. `key`/`snapshotKey` — временные tokens; будущий writer должен разрешить их в `snapshot_id` в tenant-scoped транзакции.
- Mapper проверяет полный line coverage и lineage к сотруднику/дате/роли/товару/заказу, равенство `gross - discount - refund = commission base`, точные суммы в копейках, точность quantity для 
umeric(14,3)`, повторы строк/дней и сверку дневной комиссии сотрудника с суммой комиссий его строк. Сериализация не меняет исходный результат.
- Добавлен `scripts/payroll-snapshot-serializer-contract.mjs` с позитивным и негативными сценариями по готовности, неизменности DTO, net/discount, точности количества, lineage, несогласованной комиссии, дублированию и invalid timestamp.
- Проверки PASS: новый snapshot serializer contract; payroll schemes contract; payroll calculation QA; 
ode --check` обоих новых JS/MJS файлов; scoped `git diff --check`.
- Architecture и Finance reviews подтверждают, что DTO остаётся изолированным от официального расчёта и выплаты. Итоговый system-architecture и code-health review пройдены; замечания по reconciliation и department length учтены. После этого повторно PASS: миграционный контракт на disposable PostgreSQL, lifecycle PostgreSQL QA, routes/UI, finance expense contract и serializer contract. MASTER подтвердил QA, но не передал POS/discount/refund file contract; ready run остаётся заблокирован до этих подтверждений и полной Finance coverage. Рабочая копия локальная; сервер и deploy не затронуты.

## 2026-10-03 — Loyalty final isolated regression refresh

- Повторно запущен `loyalty-journey-browser-qa.mjs` через штатный disposable PostgreSQL runner: browser UI/API E2E PASS. Для Playwright использованы уже установленные workspace-пакет и локальный Chrome; основная CRM БД не подключалась.
- Изолированные PostgreSQL проверки PASS: `migrations-pg-upgrade-qa.mjs`, `migrations-pg-runtime-qa.mjs`, `loyalty-promotions-postgres-qa.mjs`, `reservation-prepayment-postgres-qa.mjs`, `paid-order-balance-postgres-qa.mjs`.
- Контракты/локальные QA PASS: roadmap JSON/progress, migrations (83), local design/source-dist (CSS rev 394), loyalty pricing/promotions, reconciliation memory и finance RBAC. Scoped code-health PASS сохранён из финальной проверки предыдущей интеграции; текущий diff этого повторного прогона включает только roadmap/work-log документацию.
- L13.4 технически проверен, но roadmap оставляет его `pending`, пока не пройдена строгая глобальная последовательность через L12.3. Read-only сверка основной БД по-прежнему показывает только DEMO-отметку без реальных квитанций; история/суммы не менялись. `git diff --check` выполнен для scoped документов; GitHub и сервер не затрагивались.

## 2026-10-03 — Loyalty refund retry recovery hardening

- Исправлен риск повторной выплаты после commit с потерянным HTTP-ответом: намерение возврата сохраняется в `localStorage` и проверяется чтением до POST; при запрете/ошибке записи endpoint не вызывается. После reload/закрытия вкладки тот же неизменный payload повторяет исходный idempotency key, не завися от уже уменьшившегося остатка. После успешного replay ключ очищается; fallback `completed` не даёт повторно применить оставшийся ключ, если удаление storage не удалось.
- На изолированной синтетической брони browser PG QA провёл квитанцию 100 ₽ → частичный возврат 40 ₽ commit → потеря ответа → reload → остаток 60 ₽ → replay с тем же ключом. UI/API и независимый SQL join подтвердили одну reversal-запись на 40 ₽, один ключ, исходную квитанцию 100 ₽ и verified balance 60 ₽; UI оставляет доступными остальные 60 ₽.
- Проверки PASS: PostgreSQL browser journey через `local-full-pg-regression.cjs`; memory browser journey; reservation-prepayment memory QA; reservation-form QA; local-design-contract (portal rev450/CSS rev394); loyalty progress/reconciliation contracts; roadmap JSON parse; 
ode --check` для source/dist portal и browser QA; source/dist `portal.js` byte parity; scoped `git diff --check`.
- Основная БД не использовалась для QA и не менялась; старый DEMO депозит не удалён. GitHub, commit и сервер не затрагивались. Code-health и architecture reviews: PASS по новому ключу/replay и tenant/RBAC контракту; отказ localStorage проверен статически, не отдельным browser fault-injection сценарием. Параллельные независимые вкладки в текущий acceptance не входили.
## 2026-10-03 — Loyalty L12.3 legacy deposit review recorded locally

- По доступной локальной документации/архиву исходников первичного подтверждения оплаты не найдено (поиск по текущему reservation ID обнаружил только прежнюю запись аудита; архив содержит исходники, не финансовые документы). Банковские и внешние кассовые источники недоступны и не проверялись. Финансовый reviewer рекомендовал точное `documents_not_found` с этой оговоркой: это фиксирует границы поиска, но не доказывает ни оплату, ни её отсутствие.
- Через локальный owner UI на `/finance/report` записано append-only решение для единственной legacy брони 1 500 ₽. После перезагрузки экрана UI показывает note и `documents_not_found`; API показывает новую запись истории. Независимый read-only SQL подтверждает: `deposit_paid=1 500 ₽`, `verified_deposit_paid=0 ₽`, квитанции/возвраты/зачёты = 0. Платёж не удалён, не сфабрикован и не считается подтверждённым; обычный новый приём предоплаты остаётся заблокирован до квитанции.
- Изолированный regression: `reservation-prepayment-postgres-qa.mjs` PASS. Пройдены bootstrap/upgrade и runtime migrations, promotions PostgreSQL, paid-order balance PostgreSQL, migration contract (83 файлов), finance RBAC, loyalty reconciliation/guest ledger/reservation prepayment memory QA и прогресс-контракт. Автоматические regression тесты не подключались к главной БД; запись в главной БД была целевым документальным owner-действием, затем только read-only SQL-проверка.
- Порядковый roadmap автоматически продвинут `L12.3 → complete`, активирован `L13.4`: 48/49 (97%); ранее завершённые L13.1–3 сохранены. UI/данные только local loopback; GitHub и внешний сервер не затрагивались.
## 2026-10-03 — Loyalty L13.4 final local acceptance closed

- Финальный code-health review подтвердил прогресс-контракт и scoped diff; найденное устаревшее предложение в историческом detail L13.1 исправлено. Новый контракт проверяет весь автоматический путь L12.3→L13.4→49/49 complete, сохранение ранее пройденных шагов, отказ от неверного порядка и отсутствие записи CLI при отказе.
- Финальные проверки PASS: `loyalty-progress-contract.mjs` (49/49), migrations contract (83), isolated PostgreSQL migration upgrade/runtime, reservation prepayment, paid-order balance, promotions, loyalty browser UI/API, finance RBAC, reconciliation/guest ledger/prepayment memory QA, reservation form, local design/source-dist parity, scoped diff check.
- Main local database financial snapshot remains unchanged after the owner UI review: legacy 1 500 ₽, verified 0 ₽, receipts/refunds/allocations 0. Local database used only for the append-only documentary status; QA used disposable/in-memory environments. GitHub/external server untouched.
## 2026-10-03 — Payroll payout-guard scenario boundary

- Исправлена трактовка выплаты выше личной выручки: preview оставляет расчётные суммы без автоматического урезания, показывает критическое превышение и выставляет `payoutEligible:false`; serializer отказывается от такого результата. Вместе с тем текущая `personalRevenueCents` — только сценарный proxy из employee-attributed `turnoverCents`, потому что контракт специально отделяет его от `commissionBaseCents` и пока не определяет оба как полную личную чистую выручку Finance.
- UI теперь показывает приписанный оборот, называет проверку сценарной и прямо сообщает, что официальное право на выплату/источник net revenue не подтверждены. Source/dist UI синхронизированы через локальный asset copy.
- Документирован незакрытый конфликт безусловных milestone/сменных выплат с абсолютным потолком ТЗ и отсутствие save-time owner acknowledgement. Никакая запись в `payroll_entries`/`expenses`, POS, лояльность или сменную кассу не добавлена.
- Проверки PASS: 
ode --check` для затронутых JS/MJS; payroll schemes contract (включая отдельное подтверждение, что attributed turnover 20 000 и commission base 8 000 различаются); payroll calculation QA; serializer contract; source/dist UI contract; payroll routes contract; Finance payroll-expense contract; scoped `git diff --check`. Локальная disposable PostgreSQL/серверная БД не использовалась в этом slice; сервер и GitHub не затронуты.

## 2026-10-03 — Payroll owner policy acknowledgement implemented locally

- В create scheme / create version / replace draft добавлено обязательное explicit owner acknowledgement политики выплаты; сервер проверяет exact policyCode и confirmed=true. Actor/name берутся из действующей owner-записи, время — PostgreSQL, digest — SHA-256 канонической конфигурации с нормализованными child rows.
- Config metadata возвращается при чтении и сохраняется в immutable revision snapshot. Activation теперь держит FOR UPDATE lock и сверяет актуальную конфигурацию с digest; неподтверждённые/устаревшие drafts не активируются. UI требует checkbox при каждом save, сбрасывает его при изменении конфигурации и показывает факт сохранённого подтверждения. Source/dist/finance alias используют payroll UI rev3.
- Подтверждение не отменяет лимит и не открывает официальный run. Новых миграций, payroll_entries, expenses или изменений POS/loyalty/shift-cash нет.
- Проверки: source/dist UI и route contracts PASS; isolated PostgreSQL migration/service contract PASS (missing-ack rollback, server actor, audit readback, changed digest, stale-digest activation refusal, existing tenant/immutability/source/run gates); syntax и scoped diff checks PASS. Architecture и code-health reviews не нашли блокеров в acknowledgement chain. Финальный повтор UI/routes/PostgreSQL после UUID normalization и обновления finance alias также PASS; изолированная схема очищена.

## 2026-10-03 — Payroll remaining-mode math primitives

- Finance, system-architecture и code-health baseline аудиты выявили недостающий aggregate→allocate этап режимов 5–7 и ограничения modes/override paths в миграции 077. Старые миграции, общие API, POS и финансовые ledgers не изменены.
- Добавлены payroll-incentive-math.js и scripts/payroll-incentive-math-contract.mjs: два явных варианта процентов сверх ориентира, раздельное half-up округление, BigInt, отказ от некорректных/небезопасных сумм, точное распределение фонда с независимостью от входного порядка.
- Focused contract PASS: пороги below/equal/above, нулевой ориентир, half-cent, переполнение, повторные IDs, нулевые веса, MAX_SAFE_INTEGER и 1 785 комбинаций fund/weights с проверкой сохранения фонда и стабильного результата.
- Это общий математический этап; режимы 5–7 пока не подключены к сохранению/предпросмотру. Далее: versioned config, дневная агрегация и построчное распределение, typed snapshot lineage, additive migration и UI/API roundtrip. Official run остаётся blocked до согласованных source contracts.

## 2026-10-03 — Personal target version/config/preview integrated locally

- Реализован personal_target (employee/day commission-base scenario) с typed role/employee overrides, независимым дневным reset, двумя явными excess policies, component_half_up_v1 и построчной allocation lineage. Replacement строки исключаются из attainment; additive остаются и оплачиваются отдельно. Сохранены wages, milestones, caps, own-revenue critical guard и overflow blockers.
- Payroll-only migration 083 расширяет mode/path checks без изменения 077, facts или истории. Номер зарезервирован с MASTER; POS-команда владеет 084. Изолированный PG contract дважды проиграл 083 и подтвердил create→read→edit→audit/digest→activate→preview, tenant/immutable gate, а также понятный 409+rollback на старой mode schema. Основная БД не изменялась.
- UI/source/dist/finance aliases используют payroll rev4; показывают дневной план, комиссионную базу, две части и allocation по строкам без фиктивного scalar rate. Overflow имеет явное пояснение. Actual renderer contract проверяет обе политики, null rate и escaping. Serializer явно отказывает target/mixed/typed-line результатам до typed snapshot schema.
- PASS: incentive math, personal target, existing schemes/calculation QA, snapshot serializer, source/dist UI, actual target renderer, payroll routes, finance expense status contract, isolated PostgreSQL migration/service contract с cleanup. Architecture, finance и code-health reviews приняли scenario slice; замечания о labels/overflow исправлены. scoped diff check/syntax PASS.
- Remaining full scope: team fund и margin сценарные режимы; редактируемая сетка и карточка overrides; official attribution/discount/refund/personal-net/cost/department-shift coverage; typed target snapshots и реальный source→run→entry→expense E2E. PG roundtrip+renderer не подменяют будущую полную browser acceptance. Демо-данные/контейнеры не очищались, GitHub/сервер не публиковались.

## 2026-10-03 — Team fund config/preview integrated locally

- Added team_fund calculator, shared pool validation/canonical departments, typed teamWeight overrides, active/complete roster checks, separate fund component and pool audit lineage. Pool computed once/day, exact largest-remainder distribution, zero-weight source inclusion, item replacement/additive distinction, caps without redistribution and ceiling preserved.
- Payroll-only migration085 reserved with MASTER; preserves083 config modes/paths, replay twice only isolated QA. Service fixtures passed old-schema409+atomic rollback, create/read/edit/revision/digest/activate/preview, configured zero override, cross-tenant refusal and payout-ineligible no-sale member. Main DB/POS/ledgers untouched.
- Source/dist/finance aliases use payroll rev5. Day and period UI separately show pool shares; pool explanations disclose configured attendance independence and pre-limit amounts. Allocation render budget bounded; escaped source/member/pool IDs tested through actual production renderer.
- PASS: team-fund, personal-target, existing schemes/calculation, incentive helper, serializer typed refusal, UI/source-dist, production renderer, routes, isolated PG migration/service. Finance, architecture and code-health reviews accepted scenario stage. Architecture subtotal issue corrected; two independent pools and multiple attendance rows coverage added and PASS. Syntax/scoped diff checks passed.
- Next payroll-owned phase: margin calculation/version config with immutable scenario cost evidence. Full browser acceptance, editable grid, upstream source completeness and typed official snapshot→entry→expense still outstanding. No cleanup, mainDB writes or deployment performed.

## 2026-10-03 — Margin target config/preview integrated locally

- Added margin_target calculator and focused contract: required versioned cost/currency, signed daily loss offset, exact payable/base/excess line allocation, revenue item-rule exceptions, typed overrides/evidence, intermediate overflow checks and existing caps/ceiling preserved.
- Payroll-only086 reserved with MASTER, replay×2 only disposable PG; service create/read/edit/revision/digest/activate/preview, old-schema409 rollback, missing cost blocker, cross-tenant isolation PASS. Existing JSONB scalar-string override double parse was exposed by this regression and fixed; lossPolicy/itemRuleBasis/excessRatePolicy strings now roundtrip correctly.
- Source/dist/finance aliases payroll rev6. Actual renderer tests signed margin, cost/version escaping, loss explanations and null-rate behavior. Cost on replacement lines is visible with explicit exclusion note. Main DB/POS/ledgers unaffected; no guessed live cost source added.
- PASS: margin, personal, team, existing schemes/calculation, incentive helper, typed serializer refusal, UI/parity, actual renderer, routes, isolated PG migration/service cleanup. Architecture, finance and code-health final reviews accepted scenario stage; syntax/scoped diff checks PASS.
- Remaining full objective: owner-friendly grid/employee overrides and dashboard; full browser acceptance; authoritative POS discount/refund/personal-net/department-shift/cost coverage; typed immutable incentive snapshots and real source→run→entry→expense E2E. Mathematical support of modes5–7 is now integrated in scenario/config; this is not official payout readiness. No data cleanup or deployment performed.

## 2026-10-03 — Finance sales/receipt report reconciliation

- Manager `GET /api/finance/summary` and `GET /api/finance/report` now share the same finance ledger: recognized order sales are assigned to the venue-local close date; cash/card/QR payments, guest-account top-ups, and reservation prepayments use receipt event date; guest-account and reservation-prepayment refunds are separate payout events. Bonus tender is excluded from external cash receipts.
- The PostgreSQL manager summary and report read their sales, receipt, payout, shift, and pending counters in one `REPEATABLE READ READ ONLY` snapshot. Summary's current-shift average uses closed sale snapshots/fallback rather than received tenders.
- Finance report UI separates sales, receipts, and supported payouts; it displays `Недоступно` for absent, unknown, or memory-only payout coverage and warns that general POS-order refunds are not included yet. The staff breakdown is explicitly attributed to `order_opener`.
- Expanded disposable PostgreSQL QA covers mixed/bonus tenders, previous-day payment and prepayment, guest top-up, both supported payout ledgers, summary/report reconciliation, snapshots/legacy fallback, approved discounts, and zero-total sales. Browser QA covers payout-known, unavailable, and unknown coverage, date/error/retry/stale response, role switch, and 320/768/1440 widths.
- PASS: 
ode scripts/local-full-pg-regression.cjs finance-shift-analytics-postgres-qa.mjs`; 
ode scripts/finance-api-consistency-contract.mjs`; finance report browser QA; design contract; 
ode --check` on changed JS/MJS; `git diff --check`; `portal.js`/`dist/portal.js` parity. The QA uses the separate verified disposable regression PostgreSQL container; primary DB, GitHub, and VPS were untouched.
- Remaining blockers/limits: no canonical general POS-refund journal; employee-only revenue responses retain their separate payment-attribution semantics; isolated tenant/role route tests and injected rollback/release failure QA remain outstanding. Do not treat this slice as full payroll or full finance release readiness.

## 2026-10-03 — Owner-selectable payroll source policies recorded

- По ответу пользователя зафиксировано продуктовое требование: каждое заведение выбирает собственные правила зачёта сотруднику, распределения скидок и возвратов. Это не фиксирует формулу и не разрешает догадки: immutable payroll scheme revision должна хранить выбор, actor/time/reason, сохранить исходную seller/discount/refund lineage и объяснить последствия.
- В PAYROLL_SOURCE_CONTRACT_DRAFT записаны варианты policy families и fail-closed gate: неподтверждённые параметры или неполный источник позволяют только сценарный preview, не official `ready` run. POS facts не переписываются выбранной payroll policy.
- Финальный перечень вариантов и UI/API/snapshot persistence остаются задачей payroll архитектурного этапа после завершения редактора и upstream source contracts.

## 2026-10-03 — Payroll structured owner editor and isolated browser persistence

- Added role threshold × rate grid, target/team/margin parameters and dated personal overrides with explicit inheritance. Advanced JSON remains canonical; unapplied grid edits block save and acknowledgement resets after changes. Active and pending controls are disabled.
- Exact decimal money/rate parser preserves cents, zero and unknown properties. Review fixed no-op loss of explicit null override dates and rejected prototype-sensitive paths.
- Published only payroll UI asset and exact payroll revision 7 tags; no broad asset sync. Scoped responsive layout keeps tables locally scrollable.
- PASS: editor/UI/actual renderer contracts, syntax and scoped code-health review; actual server owner login → structured wage edit → API → isolated PostgreSQL → reload; widths 320/375/768/1440; no payroll entries/expenses/runs created. Dedicated temporary QA schema removed after execution; main DB unchanged.
- Remaining stage gate: browser inheritance/active/pending interactions. Full goal remains incomplete: authoritative net sale/refund/cost/source coverage plus immutable incentive snapshots and idempotent official run → entry → expense linkage. No deployment.
- Дополнительно после обновления контрактов: 
ode scripts/finance-timezone-contract.mjs` и 
ode scripts/local-employee-report-ui-qa.mjs` — PASS; оба harness issue были только недостающим знанием о вынесенном в helper close-date фильтре и `URLSearchParams` в VM.

## 2026-10-03 — Payroll owner editor browser lifecycle acceptance

- Expanded actual browser PostgreSQL QA: dated personal zero override → inherit button → apply → acknowledgement reset/reconfirm → PUT → activation → immutable inspection. Exact override dates remain unchanged, inherited value is absent; active fieldset disables role and inheritance controls, JSON is read-only, save is hidden.
- PASS: full browser fixture with real owner authentication and isolated PG persistence, 320/375/768/1440 viewport checks, no financial posting. Visual inspection corrected table labels/numbers wrapping by letter using scoped local table widths/nowrap and horizontal scrolling; repeated browser PASS. Temporary schema cleanup completed.
- Next architecture work: additive typed incentive immutable snapshots plus owner-selected source policy contract. Official source gates remain blocked and no entry/expense writer enabled.

## 2026-10-03 — Finance role/report contract and POS refund gap

- Finance role browser QA now requests `/api/finance/report` as bartender and `finance_read` manager: the bartender receives the restricted personal X response even when asking for waiter type; the manager receives sales/receipts/payouts and explicit `order_opener` attribution. 
ode scripts/finance-role-browser-qa.mjs` passed for both roles, permission-denied mutations, and 320/768/1440 layouts.
- Read-only audit found no general POS order-refund endpoint or append-only payout journal. Existing guest-account and reservation-prepayment refund records are separate and must not be duplicated. Added `FINANCE_POS_REFUNDS_CONTRACT_DRAFT.md` and clarified `FINANCE_MODEL.md`: separate actual payout amount from returned item sale value, preserve attribution state, cap both source payment and per-item returns under lock, record event/shift/audit/idempotency, and leave payroll period/clawback semantics to each venue's versioned owner policy.
- Finance architecture and code-health reviews found no blockers in the new role QA or draft. POS-refund behavior is documented as missing, not claimed as implemented. No server/schema/primary-DB changes were made in this slice; GitHub/VPS untouched.
- Next: after concurrent payroll editor/source-contract work releases shared server/schema files, implement the approved append-only POS refund journal and route with isolated PostgreSQL race/idempotency/tenant/role QA, then update finance summary/report and payroll source coverage.

## 2026-10-03 — POS pricing facts required by payroll

- Read-only audit confirmed line seller/time fields and immutable aggregate order price snapshots, but no persisted line-level discount/net allocation. Order opener is distinct from seller; generic POS refund lineage is also absent. Documented exact source facts and official-run gate in `docs/requirements/PAYROLL_PRICING_SOURCE_GAP_AUDIT.md`.
- Owner-selectable payroll scheme policies remain valid, but a policy cannot manufacture missing POS facts. Incomplete seller/discount/refund coverage remains preview-only/blocked for official payroll. No code, schema, source data, GitHub, or VPS changed.

## 2026-10-03 — Finance, payroll and local-data readiness re-audit

- Read-only finance and payroll audits confirmed the finance report's explicit limited payout coverage and the payroll run service's `createBlockedRun`-only API. There is no source-backed ready-run or run→entry→expense writer; typed source/snapshot pure contracts pass but are not a verified source adapter.
- PASS: `scripts/payroll-snapshot-source-context-contract.mjs`, `scripts/payroll-snapshot-serializer-contract.mjs`, `scripts/payroll-snapshot-reconciliation-contract.mjs`, `scripts/payroll-schemes-contract.mjs`, and `PAYROLL_MIGRATION_STATIC_ONLY=1 node scripts/payroll-scheme-migration-contract.mjs`. The static mode explicitly skipped PostgreSQL; no database was touched.
- The actual local primary DB container is `hookah-pos-db-1`, Compose service `db`, persistent volume `territory-crm_pgdata`; isolated QA containers use separate identities/ports. `seed.sql` and current-volume contents are not proof that any live catalog row is safe to remove. Cleanup requires a read-only tenant/reference inventory and dry-run classification; preserve order/payment/shift/expense/reservation/loyalty/payroll/purchase/stock/audit history. No DB or Docker state was changed.
- Next implementation gates: finish typed payroll snapshot/persistence work already in progress; then implement a tenant-scoped authoritative line-pricing/refund source and connect source-backed payroll run to existing entry/expense lifecycle. Only after module readiness, inspect the main volume and remove/disable only proven unused demo references. No release or primary-data change.

## 2026-10-03 — Pure typed payroll snapshot evidence gates

- Added payroll-snapshot-reconciliation.js: exact BigInt line→day→period identities, shifts/pay, accepted milestone cap arithmetic, replayed target formulas, deterministic personal/margin per-line allocation, signed losses/cost arithmetic, scalar/additive commissions and team fund conservation/eligibility/weights.
- Added payroll-snapshot-source-context.js: canonical UUID lineage, quantity precision, gross-discount-refund net identity, explicit venue timezone/date consistency, complete unique date/line coverage, typed mode/null-rate and margin cost metadata checks. Source-provided payroll rates/commissions are ignored.
- Added payroll-snapshot-evidence.js to compose both pure gates for future typed mapping. No persistence, migrations, source attestation, official-run authorization or entry/expense write.
- Review found coherent tampering that ordinary totals missed: moving one cent between personal target lines; modifying scalar commissions with all totals adjusted; hiding eligible team source with fund recalculated. Fixed by deterministic per-line replay and two-way eligibility checks.
- PASS: reconciliation contract across all seven modes, source-context contract, combined three-typed-mode evidence contract and unchanged incentive/personal/team/margin/legacy serializer contracts. Scope remains arithmetic/lineage consistency only; immutable scheme entitlement and upstream coverage require separate evidence.
- Typed snapshot schema v2 draft prepared. Migration allocation/scope coordination pending; official ready-run and linkage remain incomplete.

### Typed evidence final review corrections and next schema allocation

- Final review also rejected invented ordinary base rates on team-fund lines (only item rules may generate their line commission) and contradictory payableBasis/payableMargin aliases; added coherent tamper regressions. Focused reconciliation/evidence contracts PASS.
- Cross-chat coordinator explicitly reserved migration 087 for payroll-only immutable typed incentive schema/serializer. Implementation started in new migration/QA files; shared server/db/schema/POS/Finance files excluded. This reservation does not authorize official source readiness or payouts.

## 2026-10-03 — POS sale attribution integration and final QA

- POS now records one event row per add with authenticated `sales_employee_id` and database `sold_at`; quantity edits preserve the original attribution, historical nulls remain unknown, and deleting an attributed employee is restricted. Migration `084_order_item_sales_attribution.sql` is included in `schema.sql` and upgrade coverage.
- Added an explicit `demo_unverified` marker and UI warning for browser-local seller/time values, including old localStorage rows; synchronized `dist/app.js`. POS contract states line ID/product/seller/time are available but stable department, immutable net after discount, line-linked refund lineage and versioned net cost are not yet canonical sources.
- PASS: POS attribution contract, memory QA, PostgreSQL migration/guard QA, migration upgrade QA, order close guard QA, source syntax and scoped `git diff --check`. The full PostgreSQL browser suite passed against a disposable isolated schema built from current `schema.sql` plus all 87 migrations; it verifies authenticated item add, persisted seller/time on reload, computed floor-row grid display, payments, split, discounts, role gates, concurrency, cleanup.
- Final read-only system-architecture and code-health reviews found no blocking POS attribution defect. QA exposed and corrected an old quantity race fixture that expected PATCH from the add/plus action; it now exercises decrement/PATCH while preserving the separate-sale semantics.
- Cross-chat boundary confirmed: POS attribution is complete; payroll owns calculation/snapshot and is implementing isolated migration 087, but official runs stay blocked pending complete line discount allocation, refund lineage, personal net sales, stable department and versioned cost/coverage. Loyalty/Finance owns discounts, guest balances, financial reporting and POS-refund requirements; universal POS payout/refund behavior is still a documented gap. SaaS, production, VPS and GitHub were not touched.
## 2026-10-03 — Payroll immutable typed snapshot schema v2 acceptance

- Coordinator explicitly reserved payroll-only migration087; respected Loyalty088 exclusive shared backend/Finance writer lock. No schema.sql/server.js/db.js/app.js or upstream ledger changes.
- Added migrations/087_payroll_typed_incentive_snapshots.sql: additive v2 daily/line fields, nullable scalar rate only for typed personal/margin lines, immutable team pool/member allocations, composite tenant/run/day links and ready-run insert guards. Deferred checks enforce component, commission, pool/member/source conservation and inclusion/exclusion eligibility; cost JSON primitive metadata and exact cents match stored net cost.
- Added payroll-typed-snapshot-serializer.js and contract: detached typed DTOs, exact decimal strings including signed margin, known mode-specific explanation fields, source/math validation before mapping and transient atomic-writer references. Review fixed shared nested metadata references; hostile metadata and mixed-mode cases added. Legacy serializer still refuses typed mode evidence.
- Final code-health and schema review PASS. Coordinator executed actual isolated PG087 contract PASS: replay after populated history, legacy unchanged, actual mapper DTO insertion/readback for three typed modes and negative margin, malformed cost/departments, tenant/blocked/immutable guards and deferred rollback. Existing payroll scheme migration PostgreSQL suite PASS (replay, RBAC, idempotency/concurrency, no financial side effects, immutable history/source gates). Pure reconciliation/source/evidence/typed/legacy serializer contracts PASS.
- QA fixture creates only a bounded temporary schema inside verified localhost disposable QA PostgreSQL, checks actual DB/container identity and rolls back all changes. Main DB and production unchanged.
- Final code-health follow-up added PG regression cases for the UUID tie-break that awards a remainder cent and rejects the reversed shares, plus an allocation employee absent from `memberIds`; the isolated PostgreSQL contract passed again after these additions.
- Storage + pure mapping stage complete. Full goal remains active: authoritative sales/discount/refund/net-revenue/department-shift/cost manifests, versioned owner-selected source policies, atomic official ready-run writer, then unique payroll-entry linkage and existing expense lifecycle. No official ready endpoint or payout enabled in087.

## 2026-10-03 — Versioned payroll source policy and browser acceptance

- Added strict detached payroll-source-policies DTO validation and diagnostic required-fact lists. Owner chooses immutable line seller, separate immutable order responsible, or explicit line allocation; immutable line discount or fixed-order proportional eligible allocation; refund recognition date or original-period correction. Closed-run adjustments remain in next open run; paid variable adjustments require owner review; no automatic clawback.
- Payroll scheme create/replace/load/revision and acknowledgement digest preserve policy selection. Omitted legacy policies retain previous digest semantics; null/malformed choices fail atomically. Scenario metadata explicitly reports selected_not_applied and officialReady=false: this stage does not execute source policies or authorize official runs.
- Payroll editor source/dist rev8 supports explicit opt-in, reason, apply-before-save, acknowledgement reset and active read-only controls. Actual rendered QA found stale custom-select labels after reload; payroll now refreshes the existing portal select hook and disables the visible control with active/pending states. No portal/shared backend changes.
- PASS actual isolated PostgreSQL service contract; actual authenticated browser→API→PG→reload contract covering create/edit/revisions/digest, malformed POST/PUT atomicity, staff/finance 403 and foreign venue 404, explicit scenario official=false/persistence=none, selected_not_applied notice, visible saved select labels, activation read-only, 320/375/768/1440 widths, unchanged payroll_entries/expenses/runs counts. Temporary bounded QA schema cleaned after each run. Source-policy/editor/UI/render contracts, syntax and scoped diff-check PASS. Targeted mobile policy screenshot visually inspected after fix: saved labels visible and contained.
- Migration087 follow-up architecture review and isolated PG contract PASS: exact div/mod weighted shares, canonical lowercase UUID COLLATE C ties, frozen shift minutes/count/base totals, malformed/coherent weight regressions and overtime acceptance. This validates recorded arithmetic, not attendance-source approval. Future adapter must canonicalize UUIDs before calculation to preserve tie order.
- Full objective remains active. Next gates: authoritative immutable pricing/refund/cost/credit manifests and execution of selected policy in a consistent snapshot; atomic official ready-run writer with unique payroll-entry linkage; existing expense payout E2E without duplicate posting. Migration088/shared POS/backend/Finance files remain under coordinator/Loyalty ownership. No main DB mutation or deployment.
- Follow-up real-interaction review found portal visible select emits change rather than input. Payroll policy dirty tracking now handles both with one handler; actual trigger/menu click regression proves acknowledgement reset and unapplied-choice warning. Browser/API/PG rerun and focused editor/policy contracts PASS. Role-grid equivalent interaction is under independent review; earlier stage acceptance is limited to the proven policy path.
- Role-grid review confirmed the same change-only visible dropdown issue. Added shared guarded input/change dirty handler without altering override-label refresh. Actual visible role-mode selection now resets acknowledgement; applying records mode in canonical JSON; complete browser/API/PG and editor/policy/UI suites PASS again. No stale role selection silently saved.

## 2026-10-03 — Official-writer boundary hardening

- Independent review reproduced canonical UUID tie mismatch: a coherent mixed-uppercase team calculation can award its residual cent differently from PostgreSQL lowercase UUID order. Typed source evidence now rejects noncanonical calculated employee/line/member/allocation IDs rather than rewriting an already allocated result; raw source IDs still normalize. Non-UUID scenario calculator behavior unchanged.
- Blocked-run replay now requires its original operation/source identity: blocked/unknown/unknown, expected watermark, null checksum, engine v1, currency and zero source counters. It cannot return a matching ready run or another source writer's row. Actor/reason/timezone historical metadata are not compared to current values.
- PASS source-context/evidence/typed serializer contracts including coherent mixedcase calculator regression. Actual isolated PostgreSQL migration suite PASS including ready/engine/counter/checksum/watermark collision rejection, existing sequential/concurrent retry, immutable history and no financial posting. Syntax/scoped diff-check PASS.
- Approved attendance already supports transaction-bound coverage reads. Next payroll-only component validates persisted approval rows against the live manifest and returns verified calculator input within the same RR/serializable snapshot; it does not imply official sales/pricing/refund/cost completeness. MASTER owns 088/shared upstream work. Full goal remains active.
- Completed verified attendance source component in payroll-attendance-manifest.js: caller-owned active RR/serializable transaction required (SHOW plus SAVEPOINT probe); owner/tenant/month-to-date checks; current complete approval and exact frozen header/schedule/shift/interval correspondence to live manifest; detached calculator attendance, coverage and approval lineage DTO. No own transaction, persistence or ready-run authorization. Existing preview inline mapping is not yet switched; next integration must preserve error/API behavior and use real transaction QA rather than weaken isolation for savepoint mocks.
- Coordinator independently reran scripts/payroll-approved-attendance-source-contract.mjs against verified isolated PG: PASS (transaction/autocommit, malformed frozen rows, missing/stale/incomplete/foreign source, unchanged financial counts). Architecture also ran existing payroll scheme PG suite PASS; final independent code-health review PASS. Source module syntax and scoped diff PASS. Source pricing/refund/cost/full personal net gates remain open.

## 2026-10-03 — Verified attendance integrated into payroll preview

- previewWithApprovedAttendance now consumes loadVerifiedApprovedAttendanceSourceInTransaction in its genuine owner read-only RR transaction. Calculator attendance/coverage and approval lineage come from verified immutable DB rows; caller replacements cannot override them. Existing incomplete/required/stale preview codes remain compatible; new malformed snapshot errors fail closed.
- Dedicated actual PG integration PASS: real outer RR and truthful savepoints, owner scheme/version, forged attendance ignored, hostile frozen evidence rejected, stale error translation, zero financial writes. Full payroll migration/attendance PG suite also PASS; its approved-attendance tests use real separate connections after fixture COMMIT (earlier concern about RC mock was disproved; no weakening needed).
- Actual browser→GET coverage→owner POST approval→visible approved-attendance scenario action→PG PASS: 120 approved minutes override 480 caller minutes, approval ID matches, official=false/persistence=none and visible non-official notice. Full editor/source-policy browser regression PASS, no run/entry/expense effects. Initial new browser fixture used wrong coverage query parameter names and failed400; corrected to existing from/to contract, full rerun PASS and cleanup completed.
- Added PAYROLL_COMPLETION_EVIDENCE.md with full original-TZ acceptance scope, including per-parameter matrix, personal cap confirmation, milestone eligibility switch, source reconciliation, temporary calendar staff, dashboard and payout E2E. No numerical completion claim; full goal remains active. Shift entitlement by sales in original TZ is not silently equated with the approved-minute architectural contract; source/full-product acceptance remains required.
- No shared POS/Finance/server/088 writes, main DB changes or deployment.

## 2026-10-03 — Dated personal-parameter impact in role editor

- Replaced misleading role summary (previously included inheritance and historical role assignments) with strict version/assignment/override calendar intersections, override-only exact parameter paths and grouped personal values/dates. Personal zero is preserved; UUID comparison does not rewrite canonical JSON. Role changes do not promise unchanged total salary.
- Unsaved card edits, visible dropdown changes, add/inherit actions and stale JSON update impact immediately. Invalid/overlapping periods show caution instead of false absence. Grouped sorted validation avoids quadratic all-assignment checks; display limited to 200 rows with explicit full count and remaining cards.
- PASS new role-impact helper/renderer contract, existing editor/source-policy/UI/typed renderer contracts. Actual browser/API/PG PASS: editing role wage shows personal zero and Nov1–10 protected period; inherit click removes protected value immediately before applying; existing policies/attendance/revisions/digest/RBAC/four widths/active read-only/no-posting regression intact. Targeted source/dist synchronization only.
- Higher-personal-cap extra confirmation design prepared in PAYROLL_PERSONAL_CAP_CONFIRMATION_DRAFT.md. It can use existing audited config JSON without migration; implementation next. Separate milestone worked-day eligibility remains a later payroll config/math/schema package, with DDL pending POS088 handoff. Shared backend/schema/POS ledgers untouched.
- Final independent role-impact code-health review PASS: no concrete blocker, current card events/date validation/escaping/bounded display confirmed. Higher-cap pure helper and contract added, not yet connected to service/UI and not claimed enforced. Capacity/performance follow-up required before integration: align service child-row limit and replace per-group quadratic overlap scans with sorted adjacency.
- Cap helper follow-up complete: 15000-row service-compatible limit, sorted adjacency overlap validation and binary-search bounded intersections. Exact15000 sequential histories and forward/reverse permutation contracts PASS (~0.75s observed, no timing threshold). Pure helper remains configuration-risk detection only; additional confirmation enforcement and UI integration are next.

## 2026-10-03 — Explicit confirmation of personal cap above role

- Integrated pure capexception helper into create/edit/new-version and activation. Conditional request child requires true/code; server calculates dated exceptions and snapshots owner/name/time/full config digest. Client audit fields ignored. Normal config has no child and unchanged legacy digest. Activation rejects missing/stale/tampered child; existing active history remains readable.
- UI rev9 shows rates/employees/dates and separate conditional acknowledgement, resets it on config edits, disables in pending/inspection, blocks missing acknowledgement locally while server enforces independently. Advisory derives from existing dated impact with parity contract; no new public helper route/shared server allowlist. Live unsaved rolecap now included; invalid input shows caution rather than false absence. Different cap bases explicitly do not imply comparable final amounts.
- Actual isolated personal-cap PG PASS (create/edit/new-version/audit/readback, role lowering, activation tamper, RBAC/tenant/no postings); existing payroll PG suite PASS. Pure helper/UI parity/impact/editor/UI/sourcepolicy/render/syntax/scoped diff PASS, exact source/dist parity.
- Actual browser/API/PG final PASS: role30/personal40, missing second checkbox prevents scheme insertion, saved server child readback, live50 hides warning/live20 shows20→40, restore30/apply, policy edit resets secondack, active checkbox disabled. Existing attendance/source-policy/revision/role/four-width/no-financial-effects regression intact. Initial expanded browser test assumed override array order; corrected to parameter-path lookup, no product change. QA schemas cleaned.
- Final independent code-health review PASS. No migration, schema/db/server/POS/Finance edits or deployment. Official source and payout gates remain incomplete; milestone worked-day eligibility requires a separately coordinated config/math/DB slice after088handoff.

## 2026-10-03 — Milestone workday eligibility: pure calculation stage

- Added optional milestoneEligibility enum all_active/worked_on_threshold_day with personal→role→scheme→legacy default inheritance. applyMilestones remains separate on/off. Worked condition uses approved positive factual minutes, including percent_only where wage-shift details are absent; sales/schedule/zero minutes do not substitute. Crossing remains first crossing per threshold; no next-day catchup, no second-half repeat, multiple thresholds independently checked, caps/revenue guard unchanged.
- Explicit setting produces daily milestoneDecisions with awarded/rejected/disabled explanation and attendance IDs/minutes. Omitted settings preserve exact old output. Pure contract covers precedence, no-work/positive/zero, percent-only, activity/date changes, first crossing, multi thresholds, half-month, caps/ceiling and legacy parity.
- Reconciliation and legacy serializer explicitly reject presence of unsupported milestoneDecisions, including empty/null/malformed. Typed mapper inherits evidence refusal; real explicit scenarios tested. This is temporary staging until decision replay and detached mapping accepted; supplied metadata does not attest entitlement or sources.
- Service rejects selection at scheme/role/person levels with409 payroll_milestone_eligibility_configuration_pending until config/UI/storage accepted together, avoiding silent top-field omission or partial rollout. Actual isolated PG contract verifies rejection at3levels and header rollback; normal cap/audit lifecycle regression PASS.
- New milestone/maincalculator/reconciliation/evidence/legacy+typed serializer contracts PASS; independent math/code-health review PASS. No DDL performed. Coordinator preliminarily reserves089 after final088 QA/handoff, not current migration authorization. Requirements draft records remaining config/digest/UI/decision-mapping/PG/browser steps. Full goal and official source→entry→expense gates remain active/incomplete.

## 2026-10-03 — Payroll milestone evidence / pure snapshot DTO
- Причина: новая политика пороговых премий должна объяснять начисления и отказы, в том числе без строки выплаты; metadata нельзя терять при сериализации.
- Добавлен payroll-milestone-evidence.js: строгие primitive/calendar/descriptor/array проверки, crossing и continuity оборота, approved attendance references, суммы премий день/период BigInt, detached output. Для percent_only и отсутствующей payout row нужен независимый attendance context.
- Reconciliation/evidence и legacy/typed DTO сохраняют условный дневной milestoneEvidence sidecar и отдельную копию решений в explanation_json. Старое omission не добавляет полей. Получатели проверяются по полному supplied roster; calculated UUID уже должен быть canonical. Regression uppercase zero-award rejected clone отклоняется обоими mapper.
- Проверки: payroll-milestone-evidence-contract, payroll-milestone-eligibility-contract, payroll-milestone-snapshot-contract (5 режимов), payroll-snapshot-reconciliation/source-context/evidence/serializer/typed-serializer contracts, payroll-schemes-contract — PASS; targeted diff-check PASS. Architecture implementation и code-health baseline/final review; найденный canonical collision исправлен и покрыт regression.
- Границы: нет DDL/shared server/db/POS/ledgers изменений и платежей. Sidecar пока транзитный: будущий atomic writer обязан сохранить весь envelope, включая отказы без employee snapshot. Это не доказательство источников/полноты entitlement и не разрешение official run. Service configuration guard сохранён. 089 не создаётся до final handoff088; coordinator active QA проверен через wait_threads.

## 2026-10-03 — Payroll milestone durable storage preparation
- Подготовлен контракт docs/requirements/PAYROLL_MILESTONE_STORAGE_DRAFT.md: run evidence version0/1, полный дневной envelope и независимые immutable decision rows, включая отказ без payout snapshot. Additive DDL не создан до final POS088 handoff; номер089 остаётся предварительным.
- Pure payroll-milestone-storage-serializer.js преобразует проверенный calculation/evidence в daySnapshots/decisionSnapshots с transient key/dayKey, точными decimal суммами, canonical UUID и именами полного supplied roster. Независимый attendance обязателен; supplied approval identity/period/optional tenant+timezone сверяются, но не аттестуются.
- Обновлён общий checklist фактической приёмки: личный cap confirmation и dated inheritance impact приняты отдельно; milestone storage/service/UI и official source writer ещё не завершены.
- Проверки: новый payroll-milestone-storage-serializer-contract (пять режимов, пустые дни, no-payout, canonical IDs, lineage, legacy omission, detached DTO) PASS; семь существующих milestone evidence/snapshot/reconciliation/source/serializer contracts PASS. Изолированный PG payroll-personal-cap-postgres-contract повторно PASS, включая pending configuration guards без записи/финансовых эффектов.
- Это подготовка строк для будущего writer, не actual PG сохранение и не official payroll run. Общие server/db/schema/order/payment/loyalty/cash области не изменены.

## 2026-10-03 — Payroll role milestone on/off/inheritance control
- Причина: существующий applyMilestones требовал JSON/личной ручной карточки; владельцу нужен читаемый контроль включения премий по роли.
- Payroll UI добавлен tri-state boolean select: наследовать / начислять / не начислять. Пусто удаляет только role.applyMilestones, false остаётся boolean. Подпись наследования учитывает scheme.applyMilestones или фактический режим; изменения режима обновляют native и visible custom-select через существующий refresh hook.
- Сохранены личные dated applyMilestones overrides, unknown JSON, риск/cap acknowledgement reset, active/pending readonly. Это on/off существующего параметра, не включение новой milestoneEligibility.
- Source/dist payroll asset ревизия10; изменены только разрешённые payroll script tags finance source/dist/alias и payroll sync revision. Общий sync не запускался.
- Проверки: editor boolean true/false/omission/invalid и math role/scheme/personal precedence PASS; существующие UI/role-impact/cap/source-policy/render contracts PASS. Actual browser→API→isolated PG→reload false и custom-trigger, inherited caption после смены режима, RBAC/tenant/activation/no posting и320/375/768/1440 PASS. Новые milestone-role screenshots,375px просмотрен. Syntax и targeted diff-check PASS. Code-health нашёл stale custom caption; исправлено и покрыто browser regression.
- Ограничения: service milestoneEligibility configuration guard сохранён, DDL089 отсутствует до final handoff088. Официальный source adapter/run writer/payroll payout интеграция ещё не завершены.

## 2026-10-03 — Payroll role milestone amount grid and cap precedence
- Причина: суммы премий и пороги должны редактироваться владельцем без JSON; проверка раскрыла небезопасные/численно дублирующие ключи порогов и прежнее расхождение приоритета cap policy.
- UI добавлена отдельная сетка milestone threshold×role с суммами ₽. Положительный safe threshold, новые blank cells без автопремий; blank удаляет свой путь, zero сохраняется. Unknown JSON и personal dated overrides сохраняются; active/pending readonly и оба risk acknowledgements reset. UI не включает новую milestoneEligibility.
- Calculator отклоняет unsafe thresholds и numeric aliases-дубли одного порога; одиночный прежний leading-zero key не нормализуется автоматически. Cap validation использует role→scheme→mode; dated resolved personal enable требует explicit milestoneCapPolicy и блокирует расчёт без неё.
- Asset revision11: targeted payroll UI source/dist copy, finance payroll tags/alias и payroll sync constant only; общий sync не запускался.
- QA: VM editor exact money/blank/zero/preservation/malformedthreshold tests, calculator thresholdalias/precedence/personalcap tests, milestone evidence/snapshot/storage/reconciliation contracts PASS. Browser→API→isolated PG→reload300000₽→2000.25₽ и500000₽→0, RBAC/tenant/risk/active/read-only/no posting и4widths PASS; milestone-bonus375 screenshot просмотрен. PG personalcap contract повторно PASS. Code-health baseline/final выявил и подтвердил исправление cap precedence; syntax/targeted diff-check PASS.
- Остаток: durable milestone DDL/storage, scheme/role/person eligibility service/digest/UI и official sources→writer→payout ещё не завершены. POS088 coordinator active handle проверен, handoff отсутствует; DDL089 не создаётся.

## 2026-10-03 — POS order refund ledger 088 final integration

- Finance/Master owns the append-only POS refund payout ledger and API; Loyalty's bonus, guest-account and reservation-prepayment liability journals remain separate. POS-order refunds are a distinct `order_refund` payout event; unknown historical `payments.status='refunded'` records are not reconstructed. Item-level refund attribution remains explicitly `unattributed` because there is no canonical immutable discounted line-net/refund source.
- Added 088 PostgreSQL-only refund header/tender journal, finance read/write routes, source-payment and open-shift checks, tenant/RBAC guards, caps under lock, idempotency/replay, transactional audit, event-date report and cash-shift treatment. Existing sale/payment rows are not rewritten.
- Integrated the writer flow in the existing orders screen, with read-only history for finance_read, actual tender allocation/payout labels, explicit coverage limits and persisted same-key retry. Browser QA caught and fixed form ownership and mutable pending-intent bugs. Final permission gating and conflict-key guidance were architect-reviewed; source and published `dist/portal.js` are byte-identical at portal asset rev453 across all 33 served HTML references.
- PASS: isolated fresh disposable PostgreSQL + Playwright/Chrome regression (`scripts/local-full-pg-regression.cjs pos-order-refunds-postgres-qa.mjs`) for RBAC, tenant isolation, split tenders, partial/full caps, concurrency, replay/conflict, shift, audit, legacy unknown and UI. Browser confirms full refund commits before simulated response loss, reload restores payload/key at zero availability, same-key retry yields one refund row, and period reconciliation labels the payout. UI contract, server/portal/test syntax checks, portal API auth QA, scoped diff-check and source/dist hash parity PASS. Scratch DB removed by QA runner.
- Payroll continued only its owned calculation/config/UI components; no payroll DDL or shared POS/Finance routes were introduced by this slice. Official payroll stays blocked pending immutable line discount allocation, line refund lineage and full authoritative net-source coverage. No production database, VPS, GitHub or deployment was touched.

## 2026-10-03 — Reconcile payroll source docs with POS attribution 084/088
- Read-only code/architecture audit established current truth: migration084 and POS API store authenticated line-add actor + UTC timestamp, while aggregate order snapshots still lack immutable per-line discount/net, and migration088 refund is explicitly order/payment-level unattributed. No complete official payroll pricing/refund source exists.
- Corrected stale factual statements in PAYROLL_SOURCE_CONTRACT_DRAFT.md and PAYROLL_ARCHITECTURE_CONTRACT.md: 084 attribution is already implemented; mixed sellers are not merged on POST; it does not settle payroll credit/correction policy. Documented an actual mismatch: quantity PATCH preserves seller/time despite POS contract requiring a distinct row for added portions. Corrected migration-sequence note to reflect actual 082–088 files and defer next-number selection to pre-DDL verification.
- QA: POS item attribution source contract PASS; scoped diff-check PASS. No product code, DB, migration, 088, payroll runtime or SaaS changed. Loyalty owner handoff requested for pricing allocation contract; pricing contract не подтверждён loyalty owner chat (последняя задача завершилась без содержательного handoff); обновление stale payroll readiness/refund statements передано на согласование MASTER. Existing dirty payroll docs contain concurrent work; edits were narrow targeted replacements.

## 2026-10-03 — Payroll order pricing evidence verifier
- Причина: existing per-line source DTO не доказывает conservation полного locked order, eligibility и распределение скидки; official adapter должен отклонять неполные/несогласованные факты.
- Новый pure payroll-order-pricing-evidence.js проверяет full declared order/portion envelope, canonical IDs, tenant/order/currency/snapshot/version/time, exact quantity и safeinteger cents. Сохранённые allocations/net обязательны: immutable policy проверяет conservation; fixed policy replay exact largest remainder сравнивается с persisted allocations, missingfacts не генерируются. Mixed/percent не подменяется fixed; явное none0 допускается без предположения отсутствующих фактов.
- Все unknown-seller/noncommission lines сохранены; VIP minimum отдельно venue-only. Выход netSaleBeforeRefundCents и validationScope supplied_pricing_arithmetic; нет officialReady/coveragecomplete/refund0/employee-credit догадок. Canonical portion tie явно pending Finance и не считается заменой ранее предложенного order_item_id contract.
- Добавлен docs/requirements/PAYROLL_ORDER_PRICING_EVIDENCE_DRAFT.md; pricing gap audit обновлён фактическим088 unattributed-only refund ledger. Completion evidence сохраняет upstream blockers.
- Проверки: новый payroll-order-pricing-evidence-contract обеих policies/deterministic ties/permutations/no-seller/noncommission/VIP/missing/tamper/overflow/getter/prototype/sparsearray/detachment PASS; existing sourcepolicies/sourcecontext/evidence/milestone-storage contracts PASS; syntax/targeted diff-check PASS. Code-health арифметику подтвердил, strict non-enumerable unknown-field замечание передано архитектору для исправления и повторной проверки.
- Нет shared server/db/schema/ledgers правок/DDL/DBwrites. Actual source storage/read adapter ещё отсутствует; coordinator запрошен о canonical pricing owner, tie и final088/089 handoff.
- Дополнение к pricing verifier: strict-shape замечание исправлено universal descriptor guard (non-enumerable data отклоняется, исключение только array.length) и Reflect.ownKeys exact shape. Hidden extra root/order/line и hidden required order/sourcepolicy regressions PASS; root повторил contract/syntax/diff-check после release файлов.

## 2026-10-03 — Payroll source readiness API (read-only)

Причина: владельцу и будущему official writer требуется проверяемое состояние фактических источников без подмены missing coverage сценарными данными.
Изменения: payroll-source-readiness.js; payroll-scheme-service.js; payroll-scheme-routes.js; route/isolated PG/browser QA; docs/requirements/PAYROLL_SOURCE_READINESS_API.md. GET version/source-readiness читает owner/tenant, policies, verified approval, mutable order observations и refund observations в одной настоящей RR READ ONLY транзакции. Строгие from/to, timezone boundaries, отсутствие 088 = unsupported/null; unexpected SQL = 500. OfficialReady всегда false. Никаких shared ledger/DDL/UI/release edits; 089 не создана. Fresh coordinator rerun of `scripts/payroll-source-readiness-postgres-contract.mjs` against the isolated temporary QA DB passed: real RR read-only, owner/tenant, timezone, missing capability, both refund date scopes, fresh/stale attendance and no posting.
Проверки PASS: node scripts/payroll-scheme-routes-contract.mjs; node scripts/payroll-source-readiness-postgres-contract.mjs (disposable isolated PG, реальные RR/tenant/date/refund windows/approval stale/no posting); node scripts/payroll-scheme-browser-postgres-qa.mjs (real sessions owner/staff/finance/foreign, HTTP readiness, query rejects, existing editor four widths/no posting). Browser процесс exit 0, cleanup завершён. Code-health final: product/route/PG review и syntax/scoped diff PASS; HTTP additions отдельно переданы на финальную проверку.
Осталось после API этапа: canonical immutable line pricing/discount eligibility/allocation от Loyalty/Finance/POS; recognized refunds/full personal net/cost/department sources; atomic official writer и E2E payouts. Available observations не доказывают полноту источника. Полная цель не завершена.
Финальный code-health повторно проверил добавленные browser HTTP assertions и API документацию: PASS, замечаний нет; syntax и scoped diff-check PASS.

## 2026-10-03 — Payroll source readiness owner UI
Изменён только существующий payroll scheme UI, его published copy, payroll asset tags/revision и QA contract. Добавлен owner-facing period check внутри существующей страницы, без маршрута/модуля/menu. Strict monthly range, abort/race guards, escaping, honest unknown/incomplete states; readiness всегда informational and officialReady=false.
Проверки PASS: isolated PostgreSQL source-readiness contract; full payroll browser/PostgreSQL QA including owner/staff/finance/foreign, actual API, settings save/reload, four viewport widths and no financial posting; readiness UI contract; existing payroll scheme UI contract; syntax and scoped diff-check. payroll-scheme-ui.js equals dist copy by SHA-256; the three finance entry pages use rev12, rev11 count zero. Code-health baseline/final and architect review: PASS, no blockers. SaaS and 089 untouched.
## 2026-10-03 — Payroll owner source-readiness UI rev12

Реализована секция владельца в существующей payroll panel: сохранённая версия, отдельный период, read-only GET, статусы/счётчики/reasons на русском, null=неизвестно, предупреждение о несохранённых изменениях и недоступности official расчёта. Для create/new-version кнопка отключена. Контекст очищается при смене дат/версии/reload/cancel; dedicated token игнорирует старые ответы/ошибки. HTTP ошибки заменяют успех безопасным textContent; retry доступен. Архитектор реализовал только payroll-scheme-ui.js; coordinator targeted source/dist sync + payroll tags rev12, без broad sync, shared backend/ledger или DDL.
SHA256 source и dist: DED66AB23D27F8B560C22F25DC9CA38DBC91120A99E439A1456A15D4E0702A14. finance.html/dist finance/alias и payrollSchemeUiRevision обновлены только для payroll asset, rev12; portal rev453 сохранён.
Code-health baseline/final: выявлены inherited status и orphan report после cancel, исправлены Object.hasOwn и invalidate; regression добавлена. Итог замечаний нет, source/dist parity/syntax/scoped diff PASS.
Проверки PASS: payroll-source-readiness-ui-contract (фактический renderer escaping/null/calendar/status), payroll-scheme-ui-contract, payroll-source-policy-ui-contract, payroll-scheme-editor-contract. Финальный scripts/payroll-scheme-browser-postgres-qa.mjs exit0: реальный GET/approval, даты, delayed response после смены периода (response.finished+2 frames), loading, hostile HTTP500 safe text+retry, dirty JSON notice, active version и cancel, four widths, no financial posting. Промежуточный расширенный QA один раз упал из-за закрытого details в тесте; тест теперь явно раскрывает advanced section, финальный прогон PASS.
Документация: PAYROLL_SOURCE_READINESS_API.md UI contract; PAYROLL_SOURCE_CONTRACT_DRAFT.md уточнение 084 add-time author vs credit, 088 payout vs line recognition. Coordinator-owned concurrent docs sections не перезаписаны.
Остаётся полная интеграция источников и official writer/payout/report E2E; 089/source adapter не начаты до canonical handoff. Goal active, production не публиковался.

- Final post-fix coordinator regression (2026-10-03): reran `scripts/payroll-scheme-browser-postgres-qa.mjs` on the latest UI after stale-result/invalid-status fixes; PASS. The same run covers late response after period change, server error/retry, owner/staff/finance/foreign tenant HTTP/RBAC, actual readiness, no posting and four responsive widths.
## 2026-10-03 — Payroll dated personal override / role intersection

Полная inheritance audit (system_architect + code_health_engineer) нашла конкретный дефект: missingparameter preflight сверял личные overrides с каждой ролью без пересечения дат. Воспроизведение RED: day1 stable role без targetCents, day2 personal_target role, targetCents=0 только day2 → ложный employee_override_parameter_missing.
Правка только payroll-schemes.js: проверка существования личного пути выполняется на фактически применимом дне/назначении с теми же inclusive bounds, что resolve. Active missing path остаётся blocked; future overrides/historical assignments исключены. Нет UI/cache/DDL/shared ledgers edits в этом calculator этапе.
Проверки PASS: payroll-dated-override-role-contract (RED→GREEN, zero, active missing, future/historical); payroll-schemes-contract; payroll-personal-target-contract; payroll-team-fund-contract; payroll-margin-target-contract; payroll-milestone-eligibility-contract; payroll-personal-cap-policy-contract; payroll-snapshot-reconciliation-contract; payroll-milestone-evidence-contract; node --check; scoped diff-check. Code-health независимо проверил новый contract PASS и malformed-date validation сохранена.
Документ docs/requirements/PAYROLL_INHERITANCE_ACCEPTANCE.md фиксирует полную матрицу и реальные незавершённые требования: личные новые пороги/таблицы existing-leaf-only, личный цех/отсутствующий cap, общий team pool vs личные параметры, full UI/API/PG matrix. Эти gaps не объявлены выполненными. Дополнительный audit: default applyMilestones разрешается до personal mode override; требует явного контракта перед изменением legacy поведения.
По coordinator stale-doc request: source contract поясняет обязательное line seller исходного ТЗ строка93 vs дополнительные сохранённые пока notapplied policies; architecture raw-HR attendance параграф уточнён существующим082manifest. 084 add-time author, 088 order payout,082attendance не объявлены official payroll coverage.
Полная цель active; canonical source handoff/089 ban сохраняются.

## 2026-10-03 — Payroll new personal threshold leaves / UI rev13

Причина: ТЗ требует полностью персональные таблицы, existing-leaf-only не позволял новые пороги ставки/премии. Архитектор реализовал payroll-schemes.js / payroll-scheme-service.js / payroll-scheme-ui.js: узкое разрешение новых bracketRatesBps.NUM и milestoneBonusesCents.NUM; safe threshold (bracket>=0, bonus>0), newcanonical keys, numericcollision guards, inheritedsiblings, zero/inherit, effectivewindows, shared service validator для save/activation cap policy новых премий. Другие отсутствующие scalar/cap/team paths не расширялись; SQL086 уже поддерживает нужные пути, DDL не создавалась.
Code-health baseline/final выявил unintended legacy bracket alias rejection; исправлено per-active-personal-leaf, exactexisting leadingzero keys совместимы. Повторные resolver scans сокращены grouping/subset, но измеренная фильтрация15000 последовательных окон одного сотрудника ~3.57sec остаётся quadratic; performance limitation задокументирована без заявления полного исправления.
PASS: payroll-personal-threshold-contract (employeeindependent,newbracket/newbonus,siblings,zero,inherit,no catchup,unsafe/noncanonical/alias,capgates,legacykeys); payroll-personal-threshold-postgres-contract на реальном freshPool+isolated schema (save/read/preview/activate,zeroinherit,cap policies,invalidthreshold,owner,no posting); schemes/datedoverride/editor/milestoneeligibility/reconciliation contracts; syntax/scoped diffcheck. Финальный browser PG QA session16639 exit0: личные карточки новых bracket/bonus zero → apply → save → reload; existing owner/tenant/active/date/readiness/race/error regressions,4widths,no financialposting PASS. Dedicated PG повторён после architect finalfix PASS.
Targeted UI source/distSHA256 5B5E59E557C993CA3D3503A700A4CEE322E85D6FCDE924E46845D9C03D844539; finance source/dist/alias payrolltags rev13, syncconst13. Shared portal/navigation/backend/ledgers untouched. Docs PAYROLL_INHERITANCE_ACCEPTANCE обновлены actual acceptance+remaininggaps.
Промежуточный isolatedPGtest сначала остановлен safety guard без containeridentityenv, затем фикстура SQL была исправлена (раздельные text/enum параметры); финальныеPASS без обхода safety. Goalactive, sourceadapter/089ban сохраняются; full capdepartment/otherparameter inheritance и official sources/writer/payouts ещё не завершены.

## 2026-10-03 — Payroll threshold validation boundary sweep

Причина: повторная relevant.filter на каждой дате замедляла 15000 последовательных личных окон. Архитектор изменил ONLY payroll-schemes.js helper: sorted start/remove events, remove=end+1 с inclusive semantics, clippingassignment, no overflow9999, originaloverrideindex sort before resolver. Другие калькуляторные правила/UI/shared/DDL не менялись.
Code-health baseline/final + own scripts/payroll-personal-threshold-sweep-contract.mjs: captured previousfilterreference,400 seeded equivalents диагностических множеств, rolechanges,alias/cap,priority,min0001/max9999,adjacentwindows,no mutation PASS. Координатор повторил PASS: reference10858ms vs sweep526ms (~20x helperonly); code-health5223/238ms. Фиксированный timinggate не добавлен, массовые одновременноактивные листья не объявлены оптимизированными.
Дополнительные PASS: schemes,personal-threshold,datedoverride,milestoneeligibility; actual isolatedPG personal-threshold save/read/preview/activate и personal-cap audit/activation/no posting (session84625 exit0); syntax/scoped diffcheck. UI unchangedrev13, browserpreviousacceptedstage не повторялся для чистой оптимизацииhelper; PostgreSQL путь сохранения/активации повторён.
PAYROLL_INHERITANCE_ACCEPTANCE performance evidence updated. Fullgoalactive, officialsource/writer/payout contracts stillpending; no089/sourceadapter/sharedchanges.

## 2026-10-03 — Payroll parameter inheritance acceptance matrix

Независимые роли: system_architect подтвердил контракт independent mode/applyMilestones; code_health_engineer создал ONLY scripts/payroll-parameter-inheritance-contract.mjs и проверил PG matrix scope. Product code не менялся.
PASS actual calculator 23 cases all7 modes: независимо ожидаемая арифметика wages/rates/brackets/target/base/bonus/excess/teamWeight/margin fixed-enums/bonuses/apply/capratebasis,zero/false legal,dates/inherit/rolechange, unaffected components/employee кроме преднамеренного teamredistribution. Fixed lossPolicy/itemRuleBasis enums проверены только реальными допустимыми значениями, альтернативы не выдуманы.
Coordinator расширил scripts/payroll-personal-threshold-postgres-contract.mjs:15 typed paths lifecycle create/read/editinherit/read/new-version/activate/read,roles unchanged,exacttypes/windows,scenario officialfalse/persistencenone, no posting. Actual disposablefreshPoolPG session92946 exit0 PASS. PGscope persistence, purematrixscope arithmetic, не officialsources. Syntax/scoped diffcheck PASS; finalrole reviewno testfindings.
PAYROLL_INHERITANCE_ACCEPTANCE updated. Architectural decision: personalmode меняет толькоmode, applyMilestones отдельно наследуется отrole/scheme/defaultrole. Puretests сохраняют этот контракт; productне менялся. RemainingUXfinding: overrideCard rawrole fieldabsence caption дляapplyMilestones misleading effectivefallback; выделитьследующийUIэтап. Fullbrowserparameter matrix/officialsources/writer/payout remainpending. Goalactive,089/sourceadapterban unchanged.

## 2026-10-03 — POS отдельная строка порции и browser QA в локальном PG runner

Причина: UI добавляет следующую порцию отдельным POST, но ранее PATCH quantity increase мог изменить старую строку и тем самым скрыть продавца/время новой продажи. Server теперь отказывает `409 quantity_increase_requires_new_line`; уменьшение/удаление сохраняет исходную атрибуцию. POS attribution contract также уточнён под фактический обязательный line seller исходного ТЗ. Изменение backend и основные контрактные проверки внесены MASTER-чатом; координатор независимо проверил текущие файлы.

Координатор подключил существующий `pos-role-payment-postgres-browser-qa.mjs` к `scripts/local-full-pg-regression.cjs`: allowlist, случайная `orders_qa_<hex>` disposable база из schema.sql + всех migrations, настройка уже установленного Playwright/Chrome и cleanup только собственной базы в finally. Избыточное чтение runtime.json удалено после code-health finding. Нет production/основной DB изменения.

PASS: attribution contract; memory QA (actor/spoof/separate POST/increase rejection/reduction/reload); close-guard; полная POS browser/PostgreSQL QA `PASS PostgreSQL pos-role-payment-postgres-browser-qa.mjs` в disposable all-migrations DB: UI +1 → POST 201, новая item id, seller/time обеих строк в PostgreSQL, reload visibility, 50 мл суммарного recipe depletion одной ledger-записью и без повтора после reload; runner cleanup подтверждён отсутствием временных browser DB. Runner `--check-guards` 35 cases PASS; syntax/scoped diff-check PASS. system_architect и code_health_engineer независимо проверили runner diff — PASS; code-health cleanup замечание устранено. Контрактное QA оценивает поведение локально и не доказывает production.

Cross-module blocker прежний: immutable discount allocation по строкам и line-linked refund value/replay semantics нуждаются в согласованном Loyalty/POS/Finance контракте. Чату ЛОЯЛЬНОСТЬ поручен только документальный анализ этого вопроса, без runtime/DDL и без пересечения с payroll. Payroll продолжает только свои файлы. SaaS и migration 089/source adapter остаются вне работы. Общая цель активна.

## 2026-10-03 — Payroll effective inherited captions rev14

Исправлен UXдефект карточки личного applyMilestones: raw missingrolefield ошибочно объявлялся отсутствующимнаследованием. Architect changed ONLYpayroll-scheme-ui.js: pure editorInheritedParameter/editorInheritedCaption, dateduniqueassignment, role→scheme→rolemode fallback independentpersonal mode, explicit 'на дату', unsavedroleinput/change live refresh, ambiguous/gap/invalid unknown. Initial HTML escape +live textContent, no personalvalue mutation.
Code-health baseline/final: нашли влияние invalid unrelated fields на caption; coordinator narrowed parsing to ownpath and only necessaryrolemodefallback. Explicit schemeflag avoids invalidunusedmode. Final nofindings. Pure inherited-caption/editor/sourcepolicy/roleimpact/UI/syntax/scoped diff PASS.
ActualbrowserPG finalsession58059 exit0 PASS: inheritedpersonalpremium initial roledefaulttrue, unsavedrolemode stablefalse/defaulttrue, explicitrolefalse, invalidunrelatedwage nohidecaption, savedfalse afterreload, dategap unknown/restore; existing role/tenant/active/readiness/newthreshold/4widths/noposting regressions. Earlierbrowser29039 PASS before finalfinding; newfinalrun covers correctedversion.
Targetedsource/dist exactSHA256 DBCB048D7B16CE2674CF2D53EAFA227AB166028C504D9ED6CFD4C5EDDDD8CD33; payrollasset rev14 sourcefinance/dist/alias andsyncconstant14; no broad sync/sharednav/backend/DDL. PAYROLL_INHERITANCE_ACCEPTANCE closedcaptiondefect scoped; fullbrowserparametermatrix+officialsources/writer/payouts stillremaining. Goalactive/089/sourceadapterban preserved.

## 2026-10-03 — Concurrent duplicate POS close QA

Source report row 30 отмечал непроверенную гонку. Архитектор и code-health baseline read-only подтвердили текущий PostgreSQL API-контракт: tenant-scoped `SELECT ... FOR UPDATE`, финальный статус проверяется внутри транзакции; отдельная существующая гонка уже покрывала два заказа за последний складской остаток, но не два close-запроса для одного ID.

Только `scripts/recipe-depletion-pg-runtime-qa.mjs` расширен: после финансовых date-boundary assertions тест создаёт одну синтетическую порцию и параллельно POST-ит close того же заказа. Проверяется единственный 200/closed, один 409 `order_already_final`, одна paid payment, одна `order_costs`, одна связанная recipe-depletion row и ровно одна порция итогового списания. Исправлен также устаревший finance `paymentCount` fixture assertion: сводка считает два закрывающих receipt плюс один ранее проведённый partial receipt, а X-report по-прежнему считает два закрытых чека.

Проверки: 
ode scripts/local-full-pg-regression.cjs recipe-depletion-pg-runtime-qa.mjs` — `PASS PostgreSQL recipe-depletion-pg-runtime-qa.mjs`, test log reports 306 assertions; actual test runs in a randomly named, owned disposable all-migrations DB and runner cleans it in `finally`. Syntax and `git diff --check` PASS. `FINAL_ACCEPTANCE_REPORT.md` requirement 30 updated to `Готово` within local synthetic QA scope; production explicitly remains unverified. Code-health final review pending at append time.
Code-health final review: PASS, no findings; reviewer confirmed concurrent response and persisted side-effect assertions and the finance paymentCount=3 fixture accounting. Reviewer could not independently rerun PG without explicit isolated DB env; coordinator actual runner output above is authoritative.

## 2026-10-03 — Payroll personal parameter browser persistence matrix

Новый scripts/payroll-parameter-browser-postgres-qa.mjs реализован архитектором в собственной области файлов; code_health_engineer выполнил исходную и итоговую проверки без оставшихся замечаний. Реальный owner UI → HTTP → PostgreSQL → reload проверяет 15 поддержанных путей: точные типы, привычные денежные/процентные единицы, zero/false/enums, три значения личного mode, сохранённые даты, возврат каждого поля к роли, активацию и read-only, неизменность roleParameters. Пять ширин 1440/1024/768/375/320 без переполнения; координатор просмотрел итоговый снимок 375, финансовой ошибки на нём нет.

Изначальная QA схема до 087 показывала финансовую ошибку из-за отсутствия уже принятой refund миграции 088. Исправлена только новая тестовая fixture: существующие migrations <=088, HTTP 200 проверки finance/summary и analytics. Миграция 088 не редактировалась; основная DB, shared server/db/schema и продукт не менялись, UI rev14 сохранён.

Финальный реальный прогон session 21614: PAYROLL PARAMETER BROWSER POSTGRES QA PASS, exit 0. Syntax/scoped diff PASS, code-health итоговая проверка fixture PASS. Finally закрывает браузер/дочерний сервер и удаляет только собственную временную схему с проверкой отсутствия. Payroll entries/expenses/runs не создаются. PAYROLL_INHERITANCE_ACCEPTANCE обновлён по фактически доказанной области сохранения; официальная математика/источники/writer/выплаты, отсутствующие personal cap/team параметры и полный RBAC этим не принимаются. Цель активна, запрет 089 и official adapter сохранён.

## 2026-10-03 — Сверка модулей и межмодульного контракта POS/Loyalty/Finance/Payroll

Координатор сверил `SITE_TREE.md`, матрицы acceptance и три имеющихся чата MASTER, PAYROLL, ЛОЯЛЬНОСТЬ. Новых чатов/целей не создавали. SaaS и миграция 089/source adapter остаются вне работы.

Текущее локальное состояние: отдельная POS-порция имеет seller/time, quantity PATCH вверх отклоняется; memory и close-guard contracts PASS. Payroll UI→PG→reload matrix проверяет 15 поддержанных персональных параметров и пять ширин; это не принимает official writer, canonical sources или выплаты. Складские acceptance-матрицы частично открыты по атрибутам товаров, приходу/сторно, полному CRUD зала/столов, детализации COGS и единицам. Loyalty evaluator выбирает одну order-level скидку. Finance 088 фиксирует order payout, но не item refund value. Межмодульный факт-пакет и нерешённые policy decisions внесены в requirements docs; line returns остаются unattributed, Payroll не делает inference.

Точный POS QA-gap найден: UI-created рецепт создавался/редактировался, но дальнейшая продажа использовала только заранее seeded другой товар. MASTER получил ограниченное поручение связать созданный рецепт с продажей и не терять UI +1 acceptance. Поскольку UI +1 имеет отдельный реальный клик-handler и отдельная строка является контрактом продавца, исправление coordinator-local сохранило seeded товар в той же продаже, а отдельная добавленная строка тестируется browser-овским `qty-plus` через POST для UI-created product. После edit 20 мл ожидается суммарный расход 45 мл (25+20) одним order-linked movement. DB assertion связывает item.product_id с UI product и проверяет seller/timestamp; browser close проверяет общий расход 45 мл по двум строкам и одной order-linked записи. 
ode --check`, `git diff --check`, attribution contract, memory QA и close-guard PASS. Исправлена тестовая fixture concurrency case: поднимает исходную quantity до 3, чтобы legacy PATCH увеличение оставалось валидным для stale-response сценария. Full browser+PostgreSQL suite пока не запущен: изолированный disposable runner container отсутствует/остановлен после Docker перезапуска, ownership guard отказал до создания тестовой БД. Основную БД не задействовали. Acceptance не закрыт до повтора isolated PG.

Последующие owners: MASTER + warehouse_domain — завершить тест и независимый QA; затем единый browser+PG hall/table CRUD пунктов 14/15 additional acceptance; далее сгруппировать закупочный документ+подтверждение и сводную role/responsive acceptance по уже существующей матрице. Никакие новые разделы меню или backlog пункты не нужны. PAYROLL отдельно завершил настоящий disposable PG этап readiness policy lineage: 12 сочетаний, tenant/date isolation, точная local-midnight и RR concurrency/error recovery; architect/domain и code-health PASS. `officialReady:false`, 6 источников unsupported, никаких posting/adapter/088/089 изменений. Получен следующий payroll feature-кандидат для исправления blocker личных scalar-параметров при смене режима; перед реализацией требуется точный architecture/code-health scoped contract, не смешивать с POS. Loyalty получила запрос сверить cross-module контракт документально, ответа по существу пока нет.

Браузерный шаг UI-made recipe → sale → PostgreSQL depletion требует восстановления штатного изолированного Docker regression target; продакшн/основная база не являются fallback. Не деплоить и не добавлять схему в рамках этой сверки.
## 2026-10-03 — Payroll readiness real concurrent snapshot and error recovery

Следующий ограниченный этап согласован system_architect/domain read-only аудитом и baseline code_health_engineer: только scripts/payroll-source-readiness-postgres-contract.mjs, документ доказательств readiness и журнал. Общая исходная цель не сужена. Product/shared routes/088/089/adapters не изменялись.

Добавлен управляемый test-only барьер после чтения headers реальным service client. SHOW внутри transaction подтверждает repeatable read/read-only. Отдельное соединение атомарно меняет mutable current line, INSERT-ит новый append-only refund и меняет attendance. Первый ответ deepEqual исходному целиком; новый запрос показывает изменившиеся order/refund watermark, +1 event/+1 linked refund и точную stale approval причину. Инъекция неожиданной SQL ошибки проверяет propagation, rollback, release и успешный следующий запрос. Счётчики разрешают только явно добавленный внешний refund, никаких payroll/expense/run/revision записей от readiness. Cleanup проверяет отсутствие собственной временной схемы.

Первый запуск: прежний QA handle отсутствует, ECONNREFUSED31931 до fixture creation. Поднят собственный disposable postgres:16-alpine на случайном loopback порту, без volumes пользователя. Первый изолированный прогон корректно отклонил UPDATE immutable refund (55000); тест исправлен на INSERT, guard не обходился. Итоговый фактический прогон exit0: PAYROLL SOURCE READINESS POSTGRES PASS. Собственный --rm контейнер остановлен и удалён; docker ps подтверждает отсутствие тестового контейнера. Secrets не печатались.

Code-health final: PASS без замечаний; ранее исправлено ожидание settled pending при ошибке mutation, чтобы cleanup не пересекался с живым read. Syntax/scoped diff PASS. PAYROLL_SOURCE_READINESS_API описывает точную область доказательства. Полный canonical lineage/policies execution/source writer/payout lifecycle остаётся открытым; officialReady:false сохранён.

## 2026-10-03 — Payroll readiness policy lineage and scope isolation

System_architect/domain и code_health_engineer подтвердили baseline и final QA-only расширение scripts/payroll-source-readiness-postgres-contract.mjs. Все 12 сочетаний owner policies (3 credit × 2 discount × 2 refund recognition) сохраняются service, проверяются напрямую config_json в PG и getVersion; readiness requiredSourceFacts сравнивается с независимыми буквальными списками. GET не изменяет счётчики revisions/payroll/expenses/runs/refunds. Для каждого policy officialReady:false и шесть canonical компонентов unsupported; фактическое исполнение policy не заявлено.

Проверено включение exact local midnight Asia/Yekaterinburg 2026-10-31T19:00:00Z. После baseline добавлены dated outside-period order/line, foreign tenant line и два append-only refund (foreign event и outside обеих date scopes); полный readiness report deepEqual baseline. Venue-wide missing-date наблюдение не подменялось period фильтром.

Финальный настоящий PostgreSQL запуск session76048 exit0: PAYROLL SOURCE READINESS POSTGRES PASS, включая предыдущий RR concurrent snapshot/error recovery. Собственная временная схема удалена с assertion; собственный --rm контейнер остановлен/удалён. Первая попытка завершилась bootstrap connection termination; ephemeral init pg_isready не объявлен PASS, повторный launch ожидал завершения PostgreSQL init до проверки. Secrets не выводились. Syntax/scoped diff PASS, code-health final без замечаний.

Обновлён только payroll readiness evidence документ и журнал. Продукт, shared routes, POS/Finance ledgers, 088/089 и source adapters не изменялись. Полная цель активна; canonical immutable pricing/refund/net/cost/department handoff и official writer/payout остаются не приняты.

## 2026-10-03 — Payroll missing personal scalar implementation audit

После readiness QA выполнен read-only аудит следующего реального feature для исходной TZ, без сужения общей цели. System_architect/domain и code_health_engineer подтвердили: resolver игнорирует допустимый личный scalar, если leaf отсутствует у роли, preflight блокирует его. Root actual node reproduction stable role + complete personal_target parameters: blocked employee_override_parameter_missing/invalid_targetCents/invalid_baseRateBps/invalid_bonusRateBps/invalid_excess_rate_policy; independently expected commission3000 на source20000. Product не менялся.

Payroll-owned пакет предложен координатору: scalar whitelist resolver; полный effective-mode validator по dated segment boundaries; save/update/activate gate; actual pure/PG/browser acceptance. Существующие девять scalar paths уже разрешены086, новыхDDL/shared/089/adapterне требуется. Capabsentrole вынесен в отдельный смысловой контракт без baseline0; teamFund/capdepartment не добавляются неявно. PAYROLL_INHERITANCE_ACCEPTANCE фиксирует defect и exactfile/acceptancecontract. Реализация ожидает explicit ownership handoff от MASTER, с которым уже согласовываются общие этапы. Полная цель активна.

### Ролевой handoff: PERSONAL SCALAR payroll feature

Разрешён следующий bounded feature только чату PAYROLL. Его область: payroll-schemes.js и payroll-scheme-service.js; существующий JSON storage SQL 086 достаточно, новые migrations не добавлять. Разрешённая семантика только для явно заданного whitelist scalar leaves `perShiftCents`, `stableRateBps`, `targetCents`, `baseRateBps`, `bonusRateBps`, `excessRatePolicy`, `lossPolicy`, `itemRuleBasis`; `teamWeight` уже поддержан и не должен регрессировать. Роль-параметры и их базовые значения не мутабельны. Смена personal mode не выключает/не подменяет independently inherited `applyMilestones`.

Требовать активный code_health_engineer baseline перед feature и final diff review; system_architect подтверждает точную карту whitelist→effective-mode requirements→resolver→service save/update/activate→preview; сначала executable RED regression, затем реализация только payroll-owned files, pure + PG lifecycle, и browser UI только если нынешняя форма не может сохранить leaf. Не менять cap object/отсутствующую рольную cap-базу, teamFund object, department scope, role schemas, общие POS/Finance routes/ledgers, migration 088/089, source adapter, source policy, owner acknowledgement/risk digest и version immutability.

Acceptance: переход на personal_target с полностью заданными личными scalar leaves проходит expected 3000 cents на тестовом input; недостающий обязательный leaf блокирует save/preview/activation без выдуманного zero; даты inclusive, role changes, zero/false, inherit, incomplete windows, multiplier type guards, repeated save→reload→preview→activate, role unchanged; cap inheritance only if actual role/scheme supplies cap; milestone flag inheritance independent. Текущий root воспроизвёл дефект как `employee_override_parameter_missing` и target/base/bonus/excess blockers для complete set. Это локальный расчётный/override blocker, не признание official sources, payout writer или цель полной payroll интеграции готовой.

Остальная POS/warehouse sequencing остаётся независимой: finish isolated UI-made recipe→sale→depletion browser proof; hall/table CRUD acceptance; existing purchase attachment acceptance; cross-role responsive review. Межмодульные discount allocation/refund item-value choices остаются owner decision. Не заводить новые чаты/проекты, не трогать меню/маршруты.

## 2026-10-03 — Payroll missing personal scalar calculator/service fix

MASTER адресно подтвердил bounded handoff payroll-schemes.js/payroll-scheme-service.js + own contracts. Architect/domain и code-health baseline выполнены до правки. scripts/payroll-personal-scalar-contract.mjs фактически REDexit1 пятисценариев; после правки GREEN. Whitelist восьми существующих scalar leaves применяет их даже при отсутствии leaf роли. Общий dated boundary validator проверяет полный effective personal mode; service save/update/activate отклоняет incomplete params с invalid_personal_parameters. teamWeight/cap/teamFund/department semantics прежние. Roleimmutable, mode/apply независимы; 086 уже допускает paths, DDL/shared/089/sourceadapter не менялись.

Pure PASS: scalar5 independentlyexpected targets3000/stable4500/progressive4100/margin2000; zero/inherit/dates/order/otheremployee/nomutation и прямойboundaryvalidator expiry/rolechange; inheritance23; schemes/target/team/margin/cap; threshold/newleaf contracts; sweep400seeded/15000windows. Прежние negative tests обновлены к новой семантике: personal target leaf разрешён до targetrole, capmissing остаётся blocker. Code-health product final без блокирующих замечаний; необязательный duplicate service sweep noted, errorcode compatibility сохранена.

Actual PG runtime session7103 exit0: newscalar save/directPG/read/scenario3000→zero0→inherit2000→restore→activateimmutable + prior15typedthresholdlifecycle PASS; owncontainer removed. Дополнительно activation incomplete draft after deleting requiredleaf проверен отдельным финальным actualPG rerunexit0. Staff403/types/fullwindowoutsidepreviewreject/zero postings/schemaabsence confirmed. PG code-health finalreview отметил activationnegative gap, root дополнил и реально проверил. Browser новыхscalar еще требуется; UI/dist не менялись. Payroll acceptance обновлён scoped, fullgoal ACTIVE canonical sources/writer/payout остаются открыты.

## 2026-10-03 — Payroll personal missing-role scalar browser acceptance

Architect подготовил только новый scripts/payroll-personal-scalar-browser-postgres-qa.mjs; code-health baseline/final выполнены. Actual owner карточки на stable роли безtarget/base/bonus/excess → create201 → exactAPI/directPG → specificGETversion/reload familiarunits +dateinputs; UIpreview body/resultdisplay 3000→allinherit2000→restore3000 с сохранённым scenario disclosure. FailedPUT400missingtarget visibleerror не меняет PGoverride rows/revisions. Native/custom/JSON active-readonly, fivewidths1440/1024/768/375/320 безoverflow, screenshot375 просмотрен root. Noentries/expenses/runs.

Фактический первыйrun76584exit0. Code-health выявил доказательные пробелы stale visiblepreview/dateinputs; root добавил exactdisplaytotal wait/assert и пятьdateinputassertions. Финальныйrerun94203exit0 PASS; cleanup собственнойschema проверен, owned--rmcontainerremoved. Code-health re-review nofindings; syntax/scopeddiffPASS. Product/UI/rev14/DDL/sharedroutesне менялись. Acceptanceдокумент дополнил точнуюbrowserобласть и исправил устаревшую формулировку datedscalarblocker.

Новый serviceinvalid_personal_parameters отображается существующимUI fallbackкакrawcode; root предложил coordinator отдельныйрусскийlabelhandoff (текущийscalarhandoffне включаетUIсемантикубезнеобходимости). Это UXостаток, не объявлен локализованным. FullgoalACTIVE; canonical sources/official writer/payout неподтверждены.

## 2026-10-03 — Payroll standalone personal cap baseline and RED

Следующий продуктовый пробел исследован readonly system_architect/domain + code_health_engineer, прежний scalarhandoff caps исключает. Role без cap + completepersonal rate/basis сейчас rejectedcollector role_baseline_missing и blockedresolver parameter_missing. Root создал только диагностический scripts/payroll-standalone-personal-cap-contract.mjs; actualREDexit1 первыхтрёхscenarios. Независимыеexpected5000cap25%×20000 наoriginal12000 (reduction7000), zero0, inherit12000, nofakehigherroleexceptions; incompletepair остаётсяblocked. Syntax/scopeddiff и codehealthtestfinalPASS. RED не выдаётся за реализованныйfeature.

PAYROLL_PERSONAL_CAP_CONFIRMATION_DRAFT дополнен точным nextcontract: no role cap=noadditionalrestriction (не0), effectivepair completeness perdatedsegment, existing higherroleack/tamper/audit сохранены, corruptedbaseline не скрывается, currentdepartmentonly/no personaldepartmentDDL, milestonecap gate и universalfullnetceiling сохранены. Scope dayproxy не объявлен shiftdepartmentacceptance. Точныеownedfiles/QA/uiassets handoff запрошен координатору; product/UI/DDL/089/sourceadapter не менялись. ПонятныйUIlabelinvalid_personal_parameters ранее предложен, но отдельного UIразрешения пока нет. FullgoalACTIVE, official источники/writer/payout остаются открыты.

## 2026-10-03 — Payroll full completion matrix revalidated and authorization coordination

Сверена текущая полная PAYROLL_COMPLETION_EVIDENCE по фактическим стадиям: обновлены boundedpersonal scalar/UI proofs, 15path persistence и existing-source RR/policylineage QA. Не закрыты canonical sources/officialwriter/payout/calendar/dashboard; нет процентаготовности или переопределения цели. Standalonecap сохраняет diagnosticRED, producthandoffожидается.

Координатору передано прямое ранее данное authorization владельца «Не задавай мне таких больше вопросов, сама отвечай так, как считаешь правильным, лучшим логически и финансово»: crossmodule policy choice не должен бесконечно ожидать повторного вопроса, если не существует более позднего запрета/конкретного gate. Предложено координатору оформить recommended policy и согласовать с Finance/Loyalty владельцами, не payrollсамостоятельное sharedизменение. Production/irreversibleauthorization этим не предполагается. Текущий конкретный блокер payrollproduct — отдельный cap/UI-label ownershiphandoff, не новая пользовательская анкета. ПолнаяgoalACTIVE.

## 2026-10-03 — Payroll standalone cap expanded diagnostic acceptance

При pending отдельном producthandoff расширен только payroll-standalone-personal-cap-contract.mjs: 12scenarios, actualexit1 RED8/12, четыреexistingnegative/inheritguards PASS. Новыеcaseexistingdepartment/missingdepartment/damagedbaseline, uncapped→cappedauditonlycappeddate, premium policyrequired/inside5000/separate6000. Независимыецентыне выводятсяизproductionhelper, basisemployee_department_day не объявляется shiftисточником. Code-healthfinalreview nofindings, syntax/scopeddiffPASS. Конкретные failurecodes missingpair/department pendingimplementation; genericblocked сейчас boundedproof only.

Existingcontractdoc обновлён scoped, product/UI/DDL/shared/089/adapterне меняются до явно запрошенного ownership handoff. Координатор confirmedliveactive и выполняет isolatedPOSrun; его handleполлилсябезвыдуманногоacceptedcapreply. Последняяgoalturn классифицирована какprogress (evidence matrix/authorizationcoordination); текущая diagnosticmatrix даёт дополнительные exactacceptance scenarios. Fullgoalactive, невыполненныеcanonical sources/writer/payout не закрываются.

## 2026-10-03 — Payroll confirmed comparison integration audit

System_architect read-only audit and coordinator inspection established an exact missing bridge: compare reads versions in one RR transaction but calculates all results from caller previewInput; source-context checks consistency only, and the run service exports only createBlockedRun. Updated PAYROLL_COMPLETION_EVIDENCE with the full one-manifest/checksum integration acceptance and its canonical-source dependencies. Attendance-only compare is explicitly partial and does not substitute for the TZ actual-data requirement. Product code and shared files unchanged; no new tests run for this documentation audit. Scoped git diff --check PASS. Findings sent to coordinator; cap/UI file handoff remains pending, full goal active.

## 2026-10-03 — Standalone personal cap implementation, pure acceptance

MASTER explicitly accepted bounded payroll-owned cap scope and confirmed no concurrent editor; coordinator notified. Baseline system_architect/domain and code_health revalidated. Actual RED8/12 before changes. Implemented only cap.rateBps/basis creation in resolver/preflight and effective boundary validation; service prioritizes milestone policy then invalid_personal_cap; absent baseline is skipped only when undefined in backend/UI, no fabricated rate0. Existing higher-role audit preserved. Added readable errors and targeted payroll rev15 source/dist synchronization, without broad asset sync or shared navigation changes.

Standalone16 PASS including exact incomplete/department reason, unequal starts/end outside preview, inherit/zero/premium policies. Cap policy/UI/scalar5/inheritance23/sweep400+15000/threshold/dates/all modes/UI asset contracts PASS; syntax/scoped diff PASS. Updated obsolete tests to the new explicitly accepted cap semantics. Code-health final no blocking findings. New PostgreSQL/browser cap lifecycle still pending; no official sources/writer/payout acceptance. No DDL/089/adapters/shared ledgers changed. Full goal remains active.

## 2026-10-03 — Standalone cap actual PG/browser lifecycle and UUID validation fix

New own PG and browser contracts implemented. First actual PG found forbidden direct UPDATE tamper (55000); changed isolated fixture to DELETE required basis without altering guard. Actual old capPG then exposed product bypass: uppercase assignment UUID vs lowercase override missed full-window validation before PG canonicalization. Added validation-only UUID canonical copies in payroll-scheme-service for both threshold/scalar sweeps; caller objects, persisted definition/digest and calculator allocation IDs untouched. Architect/domain and health baseline/final reviewed.

Actual 85578 exit0: standalone PG, prior higher-role cap audit PG, new browser cap cards/HTTP/typed PG/reload/render50→inherit120→restore50 ₽/translatedpartial400+unchangedrows/revisions/activationreadonly/5widths, scalarbrowser regression PASS. Root375px visual reviewed. Expanded actual70382 exit0 newPG mixedUUID bothdirections/inputimmutability/exactcap+expiry+scalar+threshold+policy rejection, scalarPG and15thresholdPG PASS. Final current newPG26607 exit0 includes active second seller commission1000 unchanged with department cap5000 vs inherit12000. Scoped syntax/diff PASS; owned disposable schemas/containers removed, no production/coordination DB writes. Evidence docs updated and full goal unchanged. Canonical sources, official writer, paid adjustments/payout integration still not accepted.

## 2026-10-03 — POS recipe UI to sale PostgreSQL browser acceptance

Закрыт точный acceptance-gap пункта 28: реальный `/inventory?view=recipes` wizard создал техкарту из двух venue-складских позиций, сохранил привязку к новому товару, после reload повторно показал изменение сиропа 25→20 мл при сохранённом табаке 18 г, серверный PATCH с чужим ingredient UUID отклонён без изменения сохранённых строк. Продажа привязанного товара прошла через authenticated POS API с seller/time; UI `+1` сохранил отдельную строку. Склад подтвердил один связанный расход сиропа 70 мл по трём строкам заказа и табака 18 г по UI-created товару, затем отдельные 18 г по hookah sale; reload не дублировал движения.

В browser-QA исправлены причины ложных падений: отображаемое имя ингредиента нормализуется регистром; проверка рецепта связывает количество по `ingredientId`, а не порядку массива; несуществующая ссылка теперь проверяется настоящим PATCH; ожидание UI refresh после `+1`; арифметика расхода включает повторную строку `+1`; race fixture декрементирует quantity 2→1 и сохраняет исходный финансовый baseline. Обновлён только `scripts/pos-role-payment-postgres-browser-qa.mjs` и truthful статус строки 28 `FINAL_ACCEPTANCE_REPORT.md`. Product routes/DB/schema/migrations не менялись.

Проверки: 
ode --check scripts/pos-role-payment-postgres-browser-qa.mjs`; `git diff --check`; 
ode scripts/local-full-pg-regression.cjs --guard` PASS; 
ode scripts/local-full-pg-regression.cjs pos-role-payment-postgres-browser-qa.mjs` фактически завершился `PASS PostgreSQL pos-role-payment-postgres-browser-qa.mjs` / `POS ROLE PAYMENT POSTGRES BROWSER QA: PASS`. Использован только guarded disposable PostgreSQL-контейнер/fixture; основная БД и production не затронуты. Остаток последовательности: пункты 14/15 hall/table CRUD, затем существующие browser gaps закупки и role/responsive matrix; никаких новых product features не добавлено.

## 2026-10-03 — Optional milestone eligibility digest preparation

MASTER explicitly denied milestone DDL/runtime enablement and authorized bounded pure configDigest preparation. Existing math/evidence/DTO already implemented, so isolated the actual missing prerequisite: scheme-level eligibility omitted from payoutConfigurationDigest. Baseline architect/domain and code-health confirmed. Actual RED: omission/all_active/worked_on_threshold_day shared digest. Minimal one-property addition preserves canonical legacy bytes when undefined; no guard/API/UI/DDL/export change.

New independent frozen legacy digest contract RED→8 PASS; order/UUID/window normalization, role/personal policies, false/inherit and caller immutability proved. Syntax/scoped diff and final code-health nofindings. Actual dedicated PG79052 exit0 prior cap audit/digest/tamper regression plus all three eligibility guards409/no partialwrites PASS; owned container removed. Coordinator informed of concrete unresolved089 owner/content and canonical-source handoff. Full goal active: this only prepares checksum; owner eligibility persistence/permanent refused-day storage/official writer/payout still missing.

## 2026-10-03 — Read-only milestone decisions UI preparation

MASTER bounded pure/read-only UI scope followed; cap actual PG/browser had already completed and coordinator received exact proof to avoid redundant reruns. Baseline architect/domain+health identified absent milestone decision rendering. New independent renderer contract RED; QA refusal fixture corrected to include all three venue days (unchanged production source guard). Root renderDetails now conditionally renders day decisions, independent of employee payout rows, with translated eligibility/reasons/threshold-crossing/minutes/shift references and scenario-before-caps disclaimer. Strict shape/logical validation, escaped output, global2000decisions/2000shiftIDs and hidden counts; omitted metadata preserves exact frozen legacyHTML.

Actual9contractgroupsPASS; Chrome --browser5width localDOMfixturePASS, root375visualreviewed; targetrenderer/capUI/readinessUI/assetcontractsPASS; syntax/scoped diffPASS. Payroll-only assets source/dist/rev16 targeted sync, no broad publication. API409/DDL089/runtimeconfiguration enablement unchanged. This prepares the renderer only, not API→PG eligibility or official snapshots/payout. Full goal active; migration ownership/canonical source handoffs still needed.

## 2026-10-03 — Durable milestone evidence migration089

Coordinator handed off089 after verified088 and explicitly exempted schema.sql (base schema has no077+ parents; fresh parity uses complete migration chain). Independent architect/data/domain + health baseline; actual staticRED beforeDDL. Root owns089/static contract/docs; architect authored only ownPG test. New immutable day/decision tables, legacy evidence_version0, tenant/run/day FKs, all086 paths plus milestoneEligibility, ready/version/date insert locks and deferred parent/day/decision/daily gates. Complete daily envelopes use one covered/timezone-matched approval; crossing/count/turnover/award/role/name conservation and exact positive frozen shift IDs/minutes checked. Refusal needs no fake payout; version1 zero-child parent cannot commit. No source adapter, official writer, sharedledgers or409 enablement.

Actual failures distinguished:73727 missingQAorder_item→fixturefix;21703 product42703 CASE accessed absentNEW.run_id onparent→IF bytablefix;61948 FKpreflightTRUNCATE→QA CASCADE;33107 ClientusedasPool→QA poolinterfacefix. No guards weakened. Final7039 exit0: ownPG accepted committedcalculator/mappers/fullreadback,26 exactSQLSTATE atomicnegatives, fullpre089legacyJSONpreservation/doublereplay/freshcatalog+functionparity, shadowpath, immutable/RBAC403/noentriesexpenses, parentlocktimeout/duplicate andlate_nonduplicate deferredrollback. Samecontainer oldcapPG(all3levels409) andtyped087PG PASS. Owncontainerremoved; schema cleanupabsenceasserted. Static/pureevidence/serializer/digest/syntax/scopeddiff PASS; finalhealthnofindings. Source082 finalization limitation documented (later approvalshiftINSERT possible); storage consistency is not sourceattestation. Fullgoal remainsactive; nextbounded purepricing contract must alignwith coordinator-selected order_item_id tie/grossreconciliation, thenrealcanonicalsource+officialwriter+payoutintegrations remain.

## 2026-10-03 — Payroll pricing alignment with selected Finance item contract

Coordinator authorized separate pure verifier/test/docs stage after089; source producers/adapters/ledgers remain outside ownership. Architect/domain + health baseline confirmed only owncontractconsumer and mismatched portiontie/missingunitprice. Actual newalignmentcontract RED(shapeinvalid)→GREEN: mandatorygrossReconciliationPolicy order_numeric_half_up_largest_remainder_order_item_v1 and frozen decimalunitPrice, POSnumeric12,2/quantity12,3 bounds. BigInt exactprice×quantity; aggregateHALFUP subtotal, perlinefloor+residualdescendingfraction/canonicalorderItemID; storedgross onlycompared, neverfilled. Oneimmutable row perorderItem, portionidentityindependent; fixeddiscountreplay usescanonicalorder_item_id_code_unit_v1. Wholeitemeligiblegross=fullreconciledgrossor0. Newinput intentionallyrejectsolderdraftshape; no persisted/runtimeconsumer found.

Actual commands: node scripts/payroll-pricing-finance-alignment-contract.mjs PASS includingopposedportion/itemties, fractionalaggregatevsline rounding, exacthalfcent, zero/bounds/missing/tamper/version/duplicate,1000independent smallinteger Numberoracle/permutation/inputimmutability cases; existingpayroll-order-pricing-evidence-contract PASS (updatedonlynewfrozenfields/consistentfractional/zero fixtures); sourcepolicies/sourcecontext/snapshotevidence/milestonestorageserializer PASS. All3node--check/scopeddiff PASS; architect/domain+healthfinalnofindings. Docs/matrix updated. Immutablediscountpolicyremainsconservation-only: noindependentwinner/eligible-set/producerattestation. NoDB/API/UI/officialReady enablement orledgerwrites. Fullgoalactive; canonicalstorage/sourceadapter, ownereligibilityconfiguration andofficialwriter/payout integrations remain.


### Owner milestoneEligibility configuration — 2026-10-03

Координатор разрешил отдельный bounded service/UI этап после durable089 и pure pricing alignment. Scheme optional field проходит validation→config JSON→load/reload→scenario и digest; роль и личный параметр поддерживают strict enum, даты и inherit (личный→роль→схема→legacy all_active). Пустой control схемы удаляет optional field без изменения legacy digest/HTML. На базе без089 create/PUT/new-version/activation с любым из трёх уровней возвращают schema-required409 с rollback. Наличие таблиц не означает officialReady.

Фактический прогон96309 exit0: node scripts/payroll-milestone-configuration-qa.mjs --postgres —10 pure contracts, configuration PG, actual Chrome UI→HTTP→PG→GET/reload→preview refusal/inherit/restore→activation readonly→new-version/reload, durable089 PG и old-schema personal-cap PG PASS. Дополнительно personal-scalar PG PASS. Проверены invalid enum атомарные400, digest tamper409, RBAC/tenant, даты/expiry и no catchup, отсутствие entries/expenses/runs. Пять ширин1440/1024/768/375/320 без overflow;375 визуально проверен. Source/dist exact и payroll-only rev17; syntax/scoped diff и final code-health PASS, новых замечаний нет. Свой disposable container удалён, QA schemas удаляются с проверкой отсутствия.

Исправлены только QA ошибки: раскрытие day details перед чтением visible decision и проверка точных русских формулировок. Продуктовый renderer и расчётные guards не ослаблялись. Full goal active: authoritative pricing/refund/full-net/cost/department source adapter, atomic official writer и run→entry→expense/payout остаются отдельными интеграциями.


### Item-return arithmetic preparation — 2026-10-03

Coordinator approved new payroll-owned payroll-order-refund-evidence.js + own contract/docs only after architect/finance and code-health baseline. Full raw original pricing facts revalidated, canonical item/seller/tenant lineage preserved; BigInt cumulative HALF_UP quantity/value history, caps, duplicate/replay/sequence/chronology and zero-value deltas checked. Actual RED missingmodule→PASS; reversed-history QA expected error corrected (history rejection precedes sequence), no guard weakened. Refund contract1000independent integer oracle cases+fractional/half/full/zero/boundary PASS; bothpricing/sourcepolicy/sourcecontext/snapshotevidence/milestone-storage regressions PASS. Final health no findings; no runtimeconsumer or ledgerwrites. DTO explicitly supplied_item_return_arithmetic/not_attested/payment unknown; unknownseller remainsunknown. See PAYROLL_ORDER_REFUND_EVIDENCE_DRAFT.md. Fullgoalactive: canonical storage/producer and authoritative source adapter/officialwriter/payment linkage/payout integration still required.


### 2026-10-03 — Official payroll critical-path handoff audit

Previous goal turn completed refund helper/tests. Current read-only nativearchitect+root audit confirmed exact first-tender/close pricing seams, missing eligibleIDs in evaluator output, absence canonical pricing/return tables, unsupported readiness and blocked-only run; existing locked entry→expense path verified. Saved dependency/owner/acceptance matrix in PAYROLL_SOURCE_CONTRACT_DRAFT.md. Coordinator asked to assign real shared source producer now; no additional pure helper can close that gap. Loyalty status reply does not confirm canonical producer; POS status pending. Coordinator live turn01a102bc-062e-7691-8668-697f164af380 revalidated via bounded wait_threads cursor28, no restart on timeout. No runtime edits; goal remains active pending concrete source handoff.

### Журнал заказов: сортировка и критерии внимания — 2026-10-03

Завершён локальный UI→API→PostgreSQL сценарий журнала заказов. `orderAttentionReasons` единообразно используется API-фильтром и русскими пояснениями в строке. Операционные состояния `open`/`in_progress`/`ready` идут первыми в сортировке внимания; закрытый заказ остаётся в ней только при положительном остатке `final_total_snapshot - settled order payments`. Остаток менее копейки не отображается; отменённый заказ с устаревшим снимком не представляется к оплате. Баланс гостевого кошелька сам по себе не создаёт долг заказа. Зафиксировано в `docs/ai-team/DECISIONS.md` со ссылкой на `FINANCE_MODEL.md`.

Изменены `order-attention.js`, `db.js`, `server.js`, `portal.js`, `scripts/order-attention-qa.mjs`, `scripts/orders-attention-postgres-browser-qa.mjs`, `scripts/local-full-pg-regression.cjs`, `FINAL_ACCEPTANCE_REPORT.md`. Изолированный actual PostgreSQL + Chrome прогон: 
ode scripts/local-full-pg-regression.cjs orders-attention-postgres-browser-qa.mjs` — PASS; покрыты заполненный список, default newest, перезагрузка, фильтры/сортировки, причины и сумма к оплате, stale cancelled, RBAC 403, ширины 320/375/768/1440 и отсутствие browser exceptions. Disposable QA container остановлен и удалён. Также PASS: 
ode scripts/order-attention-qa.mjs`, локальные guard cases и 
ode --check` изменённых JS/MJS файлов. Code-health final review — без блокеров; finance-domain review согласовал источник суммы и исключение отменённых заказов.

Production-приёмка не заявляется. Остальные незакрытые продуктовые цепочки из общего плана не меняются этой задачей.


### 2026-10-03 — Producer fractional pricing defect and concrete handoff

External Loyalty requested audit returned only087 status, so it was not accepted as pricing evidence. Native system_architect/finance read-only baseline supplied exact input/output fields/5QA and existing best-only precedence. Root live evaluateLoyaltyPricing reproduction: two qty0.5×price0.01 eligible lines with100%promo and subtotal0.01 yielded discount0.02/eligibleBasis0.02. Sent concrete producerdefect+lostitem/manualsourceIDs/groupversion limits tocoordinator; saved sourcegap audit. Shared evaluator/ledgers unchanged. Current verified wait: coordinator live01a102bc-062e-7691-8668-697f164af380, no restart; actual sourceimplementation handoff pending.

### Loyalty pricing: aggregate cent reconciliation — 2026-10-03

Финансовый audit воспроизвёл дефект `subtotal=0.01`, две строки `quantity=0.5 × unitPrice=0.01`, promo 100%: построчное JS округление давало `eligibleBasis=0.02`, discount 0.02 при subtotal 0.01. Изменён `loyalty-pricing.js`: расчёт работает в целых minor units; gross строк согласуется с переданным subtotal, остаточные копейки распределяются по largest remainder с tie-break `orderItemId`; выбранная скидка пропорционально распределяется только по eligible строкам. Возвращаются ID eligible строк и line gross/discount/net allocations; дубли ID и существенное несовпадение суммы fail-closed. Приоритет promo/group/manual не менялся; negative manual percent clamped как прежде.

`server.js` теперь передаёт ID позиции из PostgreSQL `oi.id` и memory `item.id` в evaluator. QA дополнила `scripts/loyalty-pricing-qa.mjs`: fractional half-cent aggregate, permuted stable-ID ties, penny on excluded item, mismatch/duplicate rejection and nonnegative invariant. Валюта намеренно не объявлена — код лишь сохраняет текущую two-decimal POS semantics; canonical source contract по currency и durable persistence не считается закрытым.

Проверки PASS: `loyalty-pricing-qa.mjs`, `loyalty-pos-explanation-contract.mjs`, `payroll-order-pricing-evidence-contract.mjs`, `payroll-pricing-finance-alignment-contract.mjs`; 
ode --check` трёх изменённых JS/MJS; `git diff --check` scoped. Browser+PostgreSQL `pos-role-payment-postgres-browser-qa.mjs` прошёл. Isolated disposable DB/container удалены; persistent QA контейнер не запускался. Architecture/finance/code-health read-only reviews подтвердили хунки; финансовый audit подтвердил исходный баг и границы исправления.

Acceptance row 18 остаётся «Частично»: нет immutable pricing header/lines в БД, сохранения версии winner/eligibility при первой оплате и закрытии, отдельного SQL consumer, currency policy, item-return producer и payroll adapter. Payroll остаётся только downstream read-only до source handoff.

### POS immutable pricing producer — 2026-10-03

Added additive migration `090_pos_order_pricing_snapshots.sql` and matching fresh-bootstrap DDL for one venue/order header and line evidence in integer RUB kopecks. The shared transaction writer is called from first PostgreSQL tender and direct close under the existing order row lock; it persists the evaluator allocation, seller/time, catalog facts, selected offer inputs, eligible IDs, and order-level VIP adjustment. Existing snapshot replay is read-only; legacy locked orders without the new snapshot remain marked unknown. The shared date ledger and business summary prefer canonical values and retain legacy frozen order-level header totals while marking missing line snapshots unknown; neither fabricates legacy line evidence. Open-order reload exposes frozen line facts where available.

No returns, payroll consumer/schema, UI redesign, publish, or deployment work was included. Architecture, data, finance, and code-health baseline reviews approved the bounded design. The first disposable PostgreSQL setup attempt could not inspect its container; that temporary setup failure was later resolved, and the full browser/PostgreSQL suite now passes as documented below. Static contract, JS syntax, parity, and whitespace checks pass. Final code-health review closed the source-fact blocker and identified a remaining trust boundary: the DB reconciles aggregate line money totals but does not independently recalculate each line's evaluator allocation; the application writer persists the evaluator output.

QA update for the 090 producer: the disposable regression-only PostgreSQL bootstrap was made available on loopback and 
ode scripts/local-full-pg-regression.cjs pos-role-payment-postgres-browser-qa.mjs` passed against a fresh database built from `schema.sql` plus the ordered migrations. The browser/API/DB run covers first tender and direct close through the shared writer, concurrent tender-vs-close, replay, failed overpayment rollback, fractional promo penny allocation, reload of frozen facts, legacy unknown status, finance totals, role/tenant isolation, header-only rejection, source-line fact mismatch rejection, duplicate source IDs, and post-snapshot item insert/update/move-out guards. Added a database `BEFORE INSERT` source validator for exact order-item seller/time/quantity/price and product/catalog facts; the PostgreSQL reader now carries `sold_at::text` so database timestamp precision is preserved by the writer. The runner-owned ephemeral container/database were removed by teardown; the persistent QA container was not started, and production was not accessed. Earlier setup attempts and their discovered fixture/precision issues are superseded by this completed pass.

Static source contract, 
ode --check scripts/pos-role-payment-postgres-browser-qa.mjs`, migration/schema parity, and scoped `git diff --check` are included in final verification. Final code-health review is complete: the source-fact blocker is closed, with direct-SQL allocation validation documented as a residual trust boundary. Row 18 remains partially accepted: deposit model, returns, and payroll consumer are outside this producer stage. Production acceptance is not claimed.

### Payroll canonical pricing adapter and readiness — 2026-10-03

Coordinator authorized payroll-only downstream consumer after POS090 handoff. Added payroll-canonical-pricing-source.js: immutable header/all-line pricing reader in caller-owned RR READ ONLY transaction, tenant/local closed-date scope, complete current item-ID coverage, explicit RUB scale2/version1, safe integer bounds, BigInt raw quantity/price HALF_UP gross and canonical-ID largest remainder, frozen eligibility/winner/discount allocation and conservation. No commission credit, costs, department allocation or full-net facts are inferred. Reader uses per-order Maps rather than repeated array scans and checks missing-date count bounds.

payroll-source-readiness.js exposes canonicalLinePricing with separate attribution status/reasons. Missing090 is unsupported; legacy/malformed pricing incomplete. Unknown seller remains unknown; valid084 cross-venue organization seller preserves original ID and is explicitly unsupported for077 same-venue payroll employee FK. OfficialReady remains false; recognizedLineRefunds/fullEmployeeNetRevenue/credit/cost/department remain unsupported even with091. Scoped unattributed refund observations now report incomplete/recorded_refund_item_attribution_incomplete while preserving exact counters and watermark. No shared POS/Finance, DDL, routes, UI or financial ledgers were changed in this package.

Final actual disposable PostgreSQL run session28804 exit0: node scripts/payroll-canonical-pricing-source-postgres-contract.mjs and node scripts/payroll-source-readiness-postgres-contract.mjs PASS. Canonical test replays actual090 then091; exact lower/upper local midnight, tenant isolation, frozen DTO readback, raw-gross and unsafe-bigint refusal, independent concurrent commit/RR snapshot, rollback/recovery, legacy/unknown/cross-venue reasons, real attendance service and integrated readiness same-RR verified. Actual committed091 item return quantity0.250 produced250 minor units with exact snapshot/item linkage; original pricing DTO unchanged. Separate unattributed refund made observed counts2/1/2/1 incomplete; officialReady false and recognized-line-refund/full-net unsupported asserted. Fixture writes precede read-only counters; reader creates no entries/expenses/runs/payments/refunds. Each script removed its own temporary schema with absence assertion; OWNED QA CONTAINER REMOVED confirmed. Persistent/main/production DB untouched.

Old readiness fixture now explicitly removes later088/090 tables in its own disposable schema before<=087 replay to preserve missing-capability assertions despite newer fresh schema. Earlier ownQA failures (fresh-schema capabilities and RETURNINGid on composite organization_memberships) were corrected in fixtures; final runs supersede them, product guards were not weakened.

Pure PASS: canonical pricing300 independent integer discount allocation oracles/manual/group/promotion/none, allocation tamper, chronology/coverage/currency/overflow, detached input and cross-venue; existing order-pricing evidence, order-refund evidence1000 oracles, source policies, scheme routes and readiness renderer. Five scoped JS/MJS syntax checks and scoped git diff --check PASS. code_health_engineer baseline and final review: no remaining findings; system_architect/data/finance audit and PG fixture author reviewed source boundaries. PAYROLL_SOURCE_READINESS_API.md and PAYROLL_COMPLETION_EVIDENCE.md updated. Full payroll goal is not complete: canonical refund recognition/credit/full net/cost/department manifest, official atomic writer, payout integration and full end-to-end acceptance remain required; no deployment claimed.

## 2026-10-04 · POS Stage 2: товарная часть возврата

- Добавлена миграция `091_pos_order_refund_items.sql` и синхронный DDL в `schema.sql`: неизменяемые строки возврата связаны с tenant/order/pricing snapshot/source item; отдельная balance row сериализует лимит количества; value event считается по frozen net накопительно с PostgreSQL half-up округлением.
- Существующий Finance refund endpoint/UI теперь отдельно принимает item quantity и фактические payout allocations. Ключ идемпотентности включает товарные строки и явный 
oItemReturn`; legacy заказы без pricing snapshot остаются unattributed. Payout/tender ledger 088 не заменялся.
- PostgreSQL QA fixture была приведена к source facts из 090; приёмка теперь проверяет 4/3/4 коп. для трёх частей позиции на 11 коп., полное схождение, replay/conflict, параллельный лимит, SQL rollback, explicit no-item и browser lost-response retry с тем же ключом и товарной строкой.
- 
ode scripts/pos-order-pricing-snapshot-contract.mjs` — PASS; 
ode scripts/pos-order-refunds-ui-contract.mjs` — PASS. Guarded runner завершился кодом 0 и сообщил `PASS PostgreSQL pos-order-refunds-postgres-qa.mjs`; child suite записал `POS ORDER REFUNDS PG + BROWSER QA: PASS`. Повторный finance payout report после item refunds подтвердил, что item value не включается в payout totals. Disposable regression container автоудалён по настройке QA runner.
- Payroll consumer не подключался; production/deployment не выполнялись. Остались депозитная модель и утверждение/payroll consumer contract.

### POS canonical item returns — 2026-10-04

Migration 091 and the existing finance refund route/order-history dialog now persist immutable item-return lines tied to the frozen 090 snapshot. Returned merchandise quantity/value stays separate from cash/card/QR payout, which remains capped against original payments. A PostgreSQL per-line balance serializes cumulative returns and enforces frozen quantity/net caps with numeric scale 3 and cumulative half-up deltas; append-only return rows preserve evidence. Database deferred attribution checks keep legacy unattributed refunds distinct from explicit no-item-return events. The migration also independently validates 090 deterministic gross and discount largest-remainder allocation.

Actual fresh schema plus sorted migration PostgreSQL/browser acceptance passed via 
ode scripts/local-full-pg-regression.cjs pos-order-refunds-postgres-qa.mjs`; log: `tmp/full-local-qa/pg-pos-order-refunds-postgres-qa.mjs.log`. Coverage included RBAC/tenant, split tender, payout and item caps, concurrent payout over-cap, cumulative line return deltas 4+3+4 minor units summing to the frozen 11-minor net value, payout/value separation, idempotent replay and conflict, explicit no-item case, legacy unknown status, UI lost-response retry/reload, event-date reporting, cash shift effect, audit append-only, and source/dist contract. Initial QA fixture/browser-path/assertion failures were corrected without weakening product guards. The runner removed the disposable regression container and its databases; persistent QA and production were untouched.

Static POS UI/pricing contracts and syntax/scoped whitespace checks pass. Payroll canonical-pricing pure (300 oracles), refund-evidence pure (1000 oracles), readiness UI checks, and previously completed disposable PostgreSQL 090→091 reader/readiness suites pass. Payroll pricing can read the new item-return facts but recognition/commission/full employee net and official calculation remain unsupported and fail-closed. POS owner reports system/finance/data and final code-health reviews completed; coordinator is rechecking final integrated diff.
- Final architecture review found and resolved a read-boundary gap: refund GET now checks `finance_read`/`finance`, `orders`, and (when applicable) `reservations` before fetching payout or item details. Follow-up architecture review confirmed resolution.
- The verified consumer shape was sent to the existing `ЗАРПЛАТНЫЙ` chat as authorized; no payroll implementation was added to POS.
- Final code-health, Finance/domain and architecture reviews found no remaining blocker. Finance requested a post-item payout-total assertion; QA now confirms report total is 1004 (1000 prior + four separate payout units), independent of 11 minor units of item return value.
- Последний guarded запуск после добавления отрицательных RBAC regression cases завершился `PASS PostgreSQL pos-order-refunds-postgres-qa.mjs`: finance_read без `orders` получает 403 до возвратных данных; reservation-linked order без `reservations` также закрыт 403. Контрактный draft синхронизирован с фактическим локальным Stage 2 status.

### Payroll observed item-return evidence091 — 2026-10-04

Coordinator requested a bounded payroll-only observed component after POS091 source handoff. System architect/finance and code-health baseline confirmed that direct reuse of the full supplied refund verifier would fabricate commission/department/policy/sequence facts. Extracted verifyPayrollItemReturnArithmetic in payroll-order-refund-evidence.js and reused it in both the existing strict verifier and new payroll-item-return-source.js. Exact quantity parsing, safe integer cents, BigInt cumulative HALF_UP, prior-value and original quantity/net caps remain enforced; existing1000-case refund contract passes.

New itemReturnEvidence is read within the existing authorized RR READ ONLY readiness transaction. Scope uses refund registration in local period OR refund linked to closed order of period, then loads complete related-order history and original090 header/all source lines/current item-ID coverage. Old sales outside the period retain their actual source facts; preceding returns are not discarded. Complete/unattributed/not_applicable classification, tenant/order/snapshot/item/policy linkage and exact parent timestamp are checked. Unattributed history, unknown/cross-venue attribution and missing/invalid canonical sources remain explicit incomplete reasons. Validated/invalid/ambiguous/missing source counts and scoped/full history counts are separate. Header/tender payout amounts are never used as merchandise value.

091 lacks persisted insertion sequence. Reader preserves six-digit UTC microseconds, rejects pre-close chronology and flags identical per-item timestamps item_return_chronology_ambiguous; incompatible chronological deltas remain invalid rather than rearranged. Derived cumulative values are verification arithmetic only. validationScope observed_item_return_arithmetic, historyScope full_observed_history_of_related_orders, paymentLinkage/producerSequence not_attested. Mutable balance rows are not used as primary evidence. recognizedLineRefunds/fullEmployeeNetRevenue remain unsupported and officialReady false. This API-only component adds no UI/DDL/route/shared POS/Finance changes and performs no writes.

Actual final disposable PostgreSQL session60289 exit0: canonical-pricing-source-postgres-contract.mjs (expanded itemReturnEvidence scenarios) and source-readiness-postgres-contract.mjs PASS. Real090→091 fixtures cover quarter-return250minor, full history of old order with prior return before window, zero/partial values, exact microseconds, same-timestamp ambiguity, unknown/cross-venue sellers, complete/unattributed headers, readiness component equality in same transaction and unchanged official blockers. New reader RR barrier commits an independent item return after scoped-header read; pinned response stays exact, next response changes history and watermark. Independent foreign-tenant return leaves exact result unchanged. XX000 during actual order_refund_items read propagates the same error, rollback/recovery succeeds. Explicit fixture writes are counted independently; reader leaves entries/expenses/runs/payments/refunds untouched. Both scripts dropped and asserted absence of their own temporary schemas, and OWNED QA CONTAINER REMOVED confirmed. No persistent/main/production access or publish.

Pure contracts PASS: payroll-item-return-source (lineage/policy/arithmetic/chronology/ties/unknown/cross/notApplicable/empty/missing-schema/no mutation); order-refund1000 independent oracles; canonical-pricing300 independent discount oracles; readiness actual renderer and scheme-route boundary. Six scoped syntax checks and scoped diff --check PASS. Initial health P2 findings (quadratic per-item lookup and lock-only chronology) corrected with indexed source lines and exact order-close bound. Final code_health_engineer re-review no findings. Readiness API and full completion evidence docs updated. Full module remains incomplete pending recognized period/credit/clawback contract, producer ordering attestation, full net/cost/department source manifest, atomic official writer and payout integration.
## 2026-10-04 — ожидаемая касса перед закрытием смены

- Причина: API уже сохранял ожидаемую наличность и разницу закрытия, но сотрудник не видел расчёт перед вводом фактической суммы. Это мешало сверить cash движения и выявить неразобранные legacy платежи.
- Изменение: текущая смена отдаёт предварительный ожидаемый остаток и время расчёта; неоднозначные legacy cash платежи дают блокирующее предупреждение. Диалог закрытия обновляет смену перед показом расчёта, показывает ожидаемую сумму, а после ответа сервера — фактическую и variance. Финальное закрытие пересчитывает сумму под блокировкой строки смены тем же SQL helper, что и предварительный расчёт.
- Проверяемые сценарии: наличные продажи/поступления и возвраты влияют на наличность; card/QR не влияют; payout возврата учитывается в смене выплаты один раз; legacy cash блокирует закрытие; оплата, конкурентная с закрытием, либо входит в ожидаемую сумму закрытой смены, либо отклоняется после закрытия.
- Файлы: `server.js`, `app.js`, `dist/app.js`, `index.html`, `dist/index.html`, `scripts/sync-published-assets.mjs`, `scripts/shift-cash-postgres-e2e-qa.mjs`, `scripts/shift-transaction-qa.mjs`, `scripts/shift-close-ui-qa.mjs`, `scripts/pos-role-payment-postgres-browser-qa.mjs`, `FINAL_ACCEPTANCE_REPORT.md`.
- Проверки PASS: 
ode scripts/shift-close-ui-qa.mjs`; 
ode scripts/shift-transaction-qa.mjs`; 
ode scripts/pos-order-refunds-ui-contract.mjs`; 
ode scripts/pos-order-pricing-snapshot-contract.mjs`; 
ode scripts/local-full-pg-regression.cjs shift-cash-postgres-e2e-qa.mjs`; 
ode scripts/local-full-pg-regression.cjs pos-role-payment-postgres-browser-qa.mjs` (real browser + disposable PostgreSQL); 
ode scripts/local-full-pg-regression.cjs pos-order-refunds-postgres-qa.mjs`.
- Верификация ограничена одноразовой локальной PostgreSQL и synthetic browser session. Production, VPS и SaaS не изменялись. Остатки приёмки: строка 9 требует структурированных пунктов X/Z и неизменяемого фискального снимка; строки 6–7 остаются частичными. Специализированный субагентный review в этом runtime недоступен; координатор выполнил локальную проверку diff и контрактов.

## 2026-10-04 · POS Stage 3: authoritative item-return order

- Root cause: 091 copies refund header `created_at` to each item event; PostgreSQL 
ow()` is transaction-start time, so it can tie or disagree with per-source balance lock acquisition. Neither timestamp nor UUID/event ID is chronology.
- Additive migration `092_pos_order_refund_item_sequence.sql` adds a per `(venue_id,snapshot_id,order_id,order_item_id)` sequence to the existing guarded balance row and nullable immutable before/after quantity/value fields to `order_refund_items`. The INSERT trigger acquires that keyed row `FOR UPDATE`, records its current aggregate as `previous*`, increments sequence and updates the capped cumulative balance in the same transaction; the event stores delta and cumulative facts. Rollback reverts both.
- Existing 091 facts remain sequence/fact NULL and are labeled `legacy_unsequenced`; no timestamp/UUID reconstruction. The migration validates legacy balance aggregates without rewriting event history. A first post-092 event can therefore have a nonzero previous aggregate while sequence begins at 1; the source attests only post-092 order, not complete historic chronology.
- API create, replay, and GET expose `producerSequence`, previous/cumulative quantity/value and `sequenceScope`; replay compares only caller intent and returns the same persisted producer facts. UI payload does not choose the sequence. Payout/tender 088 remains unchanged; payroll readers/policies remain untouched and official payroll stays blocked.
- PG/Chromium QA passed on fresh disposable PostgreSQL: legacy unsequenced row + nonzero first baseline; sequence 1/2/3 and half-up transition chains; replay no increment; wrong-order source rejected; cap error and forced rollback do not consume sequence; concurrent direct inserts with equal forced header times block on the same balance row and receive 2 then 3 with continuous before/after facts; existing RBAC/tenant/payout/UI lost-response cases remain green. `pos-order-pricing-snapshot-contract.mjs`, syntax checks, and scoped `git diff --check` pass.
- Exact downstream SQL/DTO contract is recorded in `docs/requirements/FINANCE_POS_REFUNDS_CONTRACT_DRAFT.md` and `docs/ai-team/DECISIONS.md`; no payroll-owned file was modified. No persistent/main DB, VPS or production was touched.

Stage 3 final acceptance addendum: verified code-health/architecture/finance reviews returned no blockers. Disposable PostgreSQL + Chromium regression 
ode scripts/local-full-pg-regression.cjs pos-order-refunds-postgres-qa.mjs` passed; syntax, pricing/refund schema contract, and scoped whitespace checks passed. At this stage the POS suite's legacy fixture represented an existing 091 row after 092 was installed and did not itself exercise the upgrade. This gap was later closed by `scripts/payroll-item-return-sequence-postgres-contract.mjs`, which builds a populated pre-092 090/091 schema, applies 092, and verifies preservation of legacy rows/aggregate baseline. Consumer ordering is exclusively `producerSequence` within the source key; GET itemReturns array order (`created_at,id`) is not authoritative when timestamps tie. Payroll remains blocked from official net recognition pending complete chronology/policy.

### Payroll post092 read-only sequence adapter — 2026-10-04

Coordinator authorized only payroll-owned adaptation to the accepted POS092 field contract. Architect/finance and code-health delta audits confirmed actual migration092_pos_order_refund_item_sequence.sql matches handoff. Modified payroll-item-return-source.js only: all five persisted sequence/previous/cumulative fields read as text, source-scoped BigInt sequence1..N, exact previous/cumulative quantity/value continuity, shared cumulative HALF_UP validation and bounds. Sequenced events follow producer order despite tied/reversed transaction timestamps; each timestamp must still match its parent and not precede source close. Timestamp/UUID cannot supply a missing sequence. New transition facts are included in the raw source watermark.

Legacy091 remains unsequenced and always incomplete with item_return_legacy_unsequenced. First092 sequence1 may start from a nonzero baseline only when it matches the full legacy aggregate and original quantity/net HALF_UP. Verified tail does not attest old chronology. Added sequencedEventCount, legacyUnsequencedEventCount, post092ValidatedItemCount, legacyBaselineItemCount, sequenceScope and conditional producerSequence metadata. Missing092 columns use NULL aliases; partial schema is unsupported with null counts. Existing owner/tenant/RR/read-only flow and officialReady:false remain. No commission recognition, credit, clawback, writer or external payout linkage was added.

Targeted actual PostgreSQL run final exec chunk02735a exit0: node scripts/payroll-item-return-sequence-postgres-contract.mjs PASS. In its own disposable schema the test literally builds090/091 without092 columns, commits legacy091, applies092 twice and proves old facts unchanged/five new fields NULL. Actual producer transitions override supplied sequence claims and capture nonzero first baseline. Tied/reversed timestamps, rollback without sequence consumption, overreturn23514 and independent two-client balance-row serialization pass. Real readiness integration uses the same RR client; new component equals direct reader, recognizedLineRefunds/fullEmployeeNetRevenue remain unsupported and officialReady false. Reader counts show no entries/expenses/runs/payout writes. Own schema absence and OWNED QA CONTAINER REMOVED confirmed; no persistent/main/production DB access.

An earlier own PG attempt98709 rejected fixture returns at09/10 because source close was12; fixture close corrected to08 and product chronology guard retained. Final runtime supersedes that fixture failure. Pure sequence contract PASS: gap/duplicate, bigint above JS precision and PG bounds, partial NULL fields, wrong previous/cumulative transitions, zero delta, nonzero/missing/corrupt legacy baseline, tenant/source mismatch, deterministic persisted replay, tied/reversed dates and partial schema. Updated legacy pure contract PASS with distinct failure reasons so default legacy incompleteness cannot mask negative scenarios. Five scoped syntax checks and scoped diff --check PASS; final code-health and tiny compatibility reviews no findings.

Bounded compatibility-only adjustment: existing payroll-owned canonical PG contract has two091 expectations changed from available to incomplete with explicit legacy reason. Existing090/091 full PG suites were not rerun; their prior evidence remains historical. Files changed in this step: payroll-item-return-source.js; new scripts/payroll-item-return-sequence-contract.mjs and scripts/payroll-item-return-sequence-postgres-contract.mjs; expectation-only scripts/payroll-item-return-source-contract.mjs and scripts/payroll-canonical-pricing-source-postgres-contract.mjs; readiness API/completion docs and this appended journal entry. Latest shared journal was reread immediately before append; coordinator/POS/Finance entries preserved. Shared server/schema/producer/loyalty/finance/shifts/API routes/UI/migrations untouched; SaaS and publication untouched.

This scoped adapter package is complete. Full payroll remains blocked by unresolved recognition date/period/timezone and employee full net for non-commission items, plus future approved official writer/payout scope. Sequence092 acceptance does not enable officialReady.

### POS пункт 6 · PATCH против closeShift и role/venue acceptance · 2026-10-04

Причина: `PATCH /api/orders/:id` проверял смену отдельным pool SELECT до транзакции. `POST /api/shifts/:id/close` блокирует открытую строку смены, поэтому между предварительной проверкой и изменением заметки/гостя PATCH мог завершиться после закрытия.

Исправление: внутри PATCH транзакции сначала блокируется заказ, затем tenant-scoped открытая строка смены; роли, которым обязательна смена, получают `active_shift_required`, если строка уже закрыта/отсутствует. Проверка следует после блокировки order, чтобы сохранить существующий `order → shift` lock order из order-close/payment цепочек. До guest upsert и order update блокировка общего ряда сериализует PATCH с closeShift.

Acceptance: `scripts/pos-role-payment-postgres-browser-qa.mjs` запускает authenticated API race через два серверных PostgreSQL клиента и отдельный lock coordinator: close-first заканчивается закрытой сменой и PATCH 409 с нулевыми изменениями заказа/гостя/audit; edit-first сохраняет имя/телефон/заметку до успешного close. Заодно bartender и manager получают ожидаемую сменную ошибку для каждого route в `guardedOrderMutations`, когда у venue A нет смены, но venue B имеет открытую; owner проходит endpoint validation без shift-gate denial, а PATCH-положительные контроли выполняются для bartender/manager/owner с собственной сменой и owner без смены. Ранее существующие no-shift side-effect assertions сохраняются.

Граница брони по reviewed Finance/Loyalty contract: планирование и редактирование резервации — операция расписания без требования кассовой смены. Только получение/возврат внешнего prepayment относится к денежному движению и закрепляется за сменой. Применение уже полученного prepayment при оплате закрываемого заказа — отдельный liability allocation/non-cash tender, не вторая касса и не дополнительная выручка; новая UI-функция не предлагается.

Файлы этой правки: `server.js`, `scripts/pos-role-payment-postgres-browser-qa.mjs`, `FINAL_ACCEPTANCE_REPORT.md`, `docs/ai-team/WORK_LOG.md`. Проверки: 
ode --check server.js`; 
ode --check scripts/pos-role-payment-postgres-browser-qa.mjs`; 
ode scripts/shift-transaction-qa.mjs`; 
ode scripts/local-full-pg-regression.cjs pos-role-payment-postgres-browser-qa.mjs`; scoped `git diff --check` — PASS. Архитектура, Finance/QA и code-health review не выявили блокеров. Доказательство ограничено disposable PostgreSQL/browser окружением; production/VPS/SaaS не затрагивались.
### POS дополнительные пункты 14–15 · hall/table acceptance и сохранение истории · 2026-10-04

Причина: прежний browser suite проверял создание/редактирование и удаление только свободных объектов. Удаление table проверяло активные заказы, но закрытые заказы и брони оставлялись на усмотрение FK, а UI показывал общий сбой. У hall не было доказательства отказа при зависимых таблицах в том же сквозном UI flow.

Изменения: PostgreSQL hall DELETE блокирует строку zone и явно сохраняет отказ `zone_not_empty`, если осталась хотя бы одна table. Table PATCH/DELETE блокирует строку объекта; delete различает открытый заказ (`table_in_use`) и любую сохранённую ссылку order/reservation (`table_has_history`). `blocked` запрещён, пока есть открытый заказ или confirmed reservation на текущую локальную дату (`table_has_live_activity`). FK-ошибка, возникшая при гонке, остаётся безопасным 409 с `table_has_history`; транзакция не коммитит неудачный результат. Memory fallback повторяет запреты live-activity и исторического удаления. UI объясняет границы hall/table deletion и отсутствие archive lifecycle.

QA расширен: owner settings UI create/edit/reload/delete; hall с дочерней table — 409 и no row/audit changes; empty hall delete; manager authenticated API PATCH и PG readback; bartender 403; foreign-tenant 404; stale venue для hall/table PATCH/DELETE; invalid manual statuses; free↔blocked; active order, current confirmed booking, closed order history и cancelled booking references; historical delete refusal/readback; work-floor occupied/blocked/reserved/free DOM, reserved reload, 320/375/768/1440 viewport без overflow. Дополнительный memory API suite проверяет confirmed booking guard и cancelled-history retention. Reservation и closed-order history fixtures заданы непосредственно в PostgreSQL, а не через reservation/close producer API; параллельная гонка FK insert-vs-delete не симулировалась. Awaiting-payment не является ручным допустимым переходом и проверяется как rejected input. Нет schema change и миграции; manager подтверждён на API, отдельный admin principal не включён.

Файлы: `server.js`, `portal.js`, `scripts/floor-management-postgres-browser-qa.mjs`, новый `scripts/floor-management-memory-qa.mjs`, `HOOKAH_POS_ADDITIONAL_ACCEPTANCE.md`, `FINAL_ACCEPTANCE_REPORT.md` и этот журнал. Проверки: 
ode --check server.js`, 
ode --check portal.js`, 
ode --check scripts/floor-management-postgres-browser-qa.mjs`, 
ode --check scripts/floor-management-memory-qa.mjs`, `git diff --check` по scoped файлам, 
ode scripts/local-full-pg-regression.cjs --guard`, 
ode scripts/local-full-pg-regression.cjs floor-management-postgres-browser-qa.mjs`, 
ode scripts/floor-management-memory-qa.mjs` — PASS. Использованы guarded одноразовые PostgreSQL и in-memory сервер; server/VPS/prod/production data и migrations 090–092 не затронуты. Code-health re-review подтвердил отсутствие блокеров после parity memory fallback; QA re-review подтвердил занятый/свободный/зарезервированный и исторический сценарии, hall/role/stale/tenant и viewport evidence. Остаток QA: admin principal, отдельный manager browser UI flow, awaiting_payment readback и конкурентная FK-вставка не проверялись; memory suite проверяет reservation history, но не order-history сценарий.

### POS пункт 9 · согласованный чек-лист и неизменяемый снимок закрытия смены · 2026-10-04

Причина: старый `checklistConfirmed` фиксировал только общее согласие оператора; повторно прочитать привязанный к смене неизменяемый снимок было нельзя. Существующий `/api/finance/report?type=z` остаётся динамическим операционным отчётом, а подключённого фискального провайдера/устройства в проекте нет.

Изменения: ввели общий версионированный контракт с четырьмя обязательными подтверждениями (заказы, наличность, склад, внешняя фискальная сверка). PG close сериализует сверку денег и ledger, update смены, append-only `shift_close_snapshots` с каноническим SHA-256 и audit в одной транзакции; GET close-snapshot tenant-scoped и ограничен finance_read или закрывшим сотрудником. Снимок явно маркируется как внутренний POS-документ, не как фискальный Z-отчёт. UI рабочего места и дашборд используют одинаковые пункты и сохраняют границу ответственности. Демо snapshots помечены непроверенными и не имеют PG-гарантий.

Миграция `093_shift_close_snapshots.sql` и base schema задают уникальный снимок на venue+shift, retained FK и запрет UPDATE/DELETE. Закрытая смена со снимком намеренно остаётся частью истории; изолированные PG-suite раннеры удаляют всю одноразовую БД после теста, cleanup shift-notifications больше не пытается удалять retained shift.

Изменены: `server.js`, `shift-close-contract.js`, `migrations/093_shift_close_snapshots.sql`, `schema.sql`, `app.js`, `portal.js`, worker/dashboard HTML и опубликованные копии, договор API, acceptance report, POS close API callers, закрывающий E2E/UI/transaction/migration QA и этот журнал. Проверки PASS: 
ode --check` затронутых JS; `shift-close-ui-qa.mjs`, `staff-header-actions-runtime-qa.mjs`, `shift-state-runtime-qa.mjs`, `shift-transaction-qa.mjs`, `migrations-contract.mjs`; isolated PostgreSQL `shift-cash-postgres-e2e-qa.mjs` (snapshot/readback/digest/immutability/close race) и `shift-notifications-e2e-qa.mjs`; published-asset sync и dist parity.

Соседний QA: `paid-order-balance-postgres-qa.mjs` остановился на существующей проверке historical revenue (0 вместо 2000 до сценария закрытия); refund browser suite не стартовал без `PLAYWRIGHT_PACKAGE_PATH`; reservation prepayment остановился на `order_item_pricing_snapshot_locked`; paid-order/recipe memory suite — на `sales_employee_session_required`; role API matrix — на ранее расходящемся контракте shift summary для employee. Эти сбои не относятся к новому snapshot контракту. Production, SaaS, VPS и миграции 090–092 не запускались и не менялись; фискальное устройство остаётся отдельной будущей интеграцией.

Дополнение приёмки 2026-10-04: `shift-cash-postgres-e2e-qa.mjs` теперь fault-injects ошибки `INSERT shift_close_snapshots` и `INSERT audit_events` после закрывающего `UPDATE`. В обоих случаях проверяет `shift_close_failed`, полностью открытую смену без expected/closing/variance, отсутствие снимка и `shift.closed` audit; scoped триггеры/functions снимаются в `finally`, затем тот же shift успешно закрывается штатным сценарием гонки оплаты. Проверка 
ode --check`, 
ode scripts/local-full-pg-regression.cjs shift-cash-postgres-e2e-qa.mjs` и scoped `git diff --check` — PASS.

### Payroll contract re-audit and canonical timestamp precision — 2026-10-04

Baseline: git status --short confirmed a heavily dirty shared tree, including POS/Finance/Loyalty/shift changes and migrations093/094. Read only relevant current payroll code, accepted090/091/092 evidence, WORK_LOG, Finance refund contract, Loyalty L14 contract and decisions. Architect/QA found no unimplemented source that can safely become ready under an already-approved contract; component ownership and product blockers are retained in PAYROLL_COMPLETION_EVIDENCE roadmap. The existing consumer is not duplicated. The readiness UI candidate is outside the prior API-only handoff and was not implemented.

Code-health baseline reproduced existing P2: Date.parse drops PostgreSQL microseconds, so canonical verifier accepted sold_at=lock+1µs and transaction_at≠lock by1µs. Coordinator and architect approved a precision-only fix. Changed payroll-canonical-pricing-source.js timestamp helper to strict PG/ISO syntax, validated civil calendar, exact BigInt microseconds and explicit offset conversion. Existing capture/lock equality, sale≤lock and capture≤close now respect all six fractional digits. DTO and existing source semantics unchanged; no recognition rule introduced.

Actual checks PASS: node scripts/payroll-canonical-timestamp-contract.mjs (µs negatives/equal boundary, calendar/leap/precision/offset guards, PG/ISO equivalent instants and input/DTO immutability); node scripts/payroll-canonical-pricing-source-contract.mjs (existing300 independent discount cases); node scripts/payroll-item-return-sequence-contract.mjs (narrow dependent092 regression). Final isolated PostgreSQL exec f2c64e exit0: node scripts/payroll-canonical-timestamp-postgres-contract.mjs reads real timestamptz::text preserving six fractional digits across UTC, Asia/Yekaterinburg, Asia/Kolkata and America/New_York; exact µs boundaries reject correctly, rollback/recovery and own-schema cleanup verified. OWNED QA CONTAINER REMOVED confirmed. This light PG test validates timestamp consumption only, not a repeat or replacement of accepted POS090/091/092 producer acceptance.

Three scoped syntax checks and scoped git diff --check PASS; independent architecture/QA approval and final code-health review no findings. Baseline canonical source SHA25698F122AC283048621E204977D3270C9554B8409C8C49303914B68FE2F66E5BEA changed to911AB43D40ABCD66E9DE5F21C63766006264DEBD76B7972A601E0D2E17079351. Readiness CCF8997C78E3F20873F5137959C1AB7F62C7662AB6B106158D35B755545B1F06, item-return7A652DA7E13B51801AE4BEE9D637B8A4E2F8DED3F93690012369A57745250C6E, source-policies0FE9FEB33D3B4560D39370729582EB945BBE05862A48EEB3A1DF6866DA31E23A and blocked-run C3473DC28C93C1D7D6BACA9A020B1B075B62364A6E3432CB2777482BD8F35D56 stayed byte-identical.

Only product file changed: payroll-canonical-pricing-source.js; two new owned timestamp QA scripts and roadmap/journal docs added. Latest shared WORK_LOG reread before appending; other owners' records preserved. No shared POS/Finance/Loyalty/server/routes/UI/schema/migrations/ledger, persistent/main DB, SaaS/VPS/production or publish actions. officialReady remains false. Exact remaining blockers: recognition immutable date/period/timezone; full employee net including non-commission returns; credit/unknown/cross-venue contract; historical cost and department-shift manifest; separate approved official writer/payout scope. Existing next-open-run/no-automatic-clawback intent does not fill the missing date/net execution contract.

### Каталог крепкого алкоголя · 2026-10-04

Причина: в справочниках не было отдельного каталога крепких напитков с классификацией и характеристиками, а описание алкоголя нужно связывать со складом без влияния на остатки и себестоимость.

Изменения: добавлен каталог с областью сети/заведения, брендом, линейкой, названием, типом и подтипом, страной, ABV, объёмом бутылки, выдержкой, штрихкодом, вариантами написания и описанием. Миграция 094 создаёт tenant-scoped таблицу и необязательный FK из ингредиента; каталог и склад остаются отдельными сущностями. Реализованы авторизованные CRUD/readback, проверки ролей/tenant/видимости, активной ссылки, дубликатов и мягкий архив. Уже связанная архивная карточка остаётся читаемой; изменения описания и архивирование не меняют остаток/стоимость. UI добавлен в складские справочники, с выбором каталога из барной позиции. Демо и dist-копии синхронизированы целевым копированием; владельцу, администратору и разработчику доступен общий каталог.

Критерии #4–10 отмечены выполненными, #3 и #42–43 — частичными: универсальный seed всех барных категорий и динамическая схема для всех товарных семейств не реализованы.

Проверки PASS: 
ode --check portal.js`; 
ode --check scripts/alcohol-catalog-api-qa.mjs`; 
ode scripts/migrations-contract.mjs` (95 файлов); 
ode scripts/local-full-pg-regression.cjs --guard`; изолированные `alcohol-catalog-schema-pg-qa.mjs` и `alcohol-catalog-api-qa.mjs` (аутентифицированный CRUD/tenant/roles/duplicates/link/readback/archive). Браузерный просмотр проверил создание карточки и открытие/скрытие формы; форма связи со складской барной позицией показала карточку. `git diff --check` по scoped-файлам PASS. Production/VPS/SaaS не затрагивались.

## Inventory category FK, starter categories and tobacco linkage — 04.10.2026

Причина: acceptance #1–3 и #11–12 требовали устойчивую связь ингредиента с существующей категорией и базовые редактируемые справочники; tabacco profiles не были связаны с inventory rows. Изменения: migration 095 добавляет составной tenant FK и conservative exact-match backfill, persistent per-venue seed ledger/defaults, tobacco catalog FK and venue scope guard; API/repository сохраняют старый `category` payload и expose `categoryId`/tobacco profile; форма использует category ID и selector существующего каталога. `pack_multiplier` сохраняет массу пачки для закупочной единицы при stock unit `г`; recipe/COGS code не менялся. Изменена `VENUE_EMPTY_SETUP_POLICY.md` по прямому решению координатора. Production/реальные точки не тронуты.

Затронуты: `migrations/095_inventory_categories_tobacco.sql`, `db.js`, `server.js`, `portal.js`, `schema.sql`, acceptance matrix, policy, migration/API contracts, `dist/portal.js`. QA-команды и результаты записываются после финального прогона.

### Сквозной POS путь acceptance #47 · 2026-10-04

Discovery: #44 уже покрывает authenticated PG API от категории/прихода до рецепта, продажи, списания, COGS, tenant и role guards, поэтому складской сценарий не дублировался. Ранее PIN+создание зала/стола и последующие рецептурные продажи были в recipe PG suite, но созданный стол удалялся до продаж; заказ/COGS шли на заранее seeded table. Отдельный floor browser suite проверяет управление залом/столом, а UI PIN→продажа вместе не объединены.

Изменения ограничены новым `scripts/acceptance-47-pos-journey-postgres-qa.mjs` и безопасной точкой входа/allowlist в `scripts/local-full-pg-regression.cjs`. Сценарий создаёт случайные tenant/org/user fixtures и случайный PIN; выполняет реальный HTTP password login и staff PIN unlock, после чего на одном bearer-сеансе создаёт зал и стол, складскую позицию с тестовым остатком, товар/рецепт, открывает смену и продаёт на этом же столе. Проверяет свободен→занят→свободен и повторное чтение связи order→table, точные 50 мл списания и одну запись COGS 25.00. Bartender не может читать склад или создавать зал, но читает заказ; другая организация не видит зал/позицию/заказ и не может открыть заказ на чужом table ID. Продуктовый код/API/schema не менялись.

QA: 
ode --check scripts/acceptance-47-pos-journey-postgres-qa.mjs`; 
ode --check scripts/local-full-pg-regression.cjs`; 
ode scripts/local-full-pg-regression.cjs --guard`; 
ode scripts/local-full-pg-regression.cjs acceptance-47-pos-journey-postgres-qa.mjs` — PASS, 46 assertions. Runner создал `inventory_qa_<random>` с полной schema+migrations и удалил её в finally (`CLEANUP PASS`); процесс тестового сервера завершён. Путь проверен через HTTP и PostgreSQL, не через браузерный login/lock keypad и экран продажи: отдельная попытка browser запуска остановилась до теста из-за отсутствующего `PLAYWRIGHT_PACKAGE_PATH`; БД также была удалена. Автоматический browser E2E и UI screenshots остаются остатком #47; #44 не изменялся.
### Складское поступление: мобильный переход и безопасная прокрутка · acceptance #48 · 2026-10-04

Discovery выявил пробел в browser coverage: responsive runner проверял `/admin`, `/orders` и `/`, а складская responsive проверка была только статическим CSS-контрактом. Новый isolated browser путь сначала открывал форму напрямую и показал, что клик по шапочному действию «Приход» прокручивает форму под sticky header. Архитектор подтвердил маршрут `/inventory?view=movements` и отсутствие влияния на API/роли/схему; design lead подтвердил проблему и минимальный header-token offset; frontend подтвердил, что не тестировался переход именно из складского экрана.

Добавлены отдельный `scripts/inventory-receiving-mobile-postgres-browser-qa.mjs` и guarded disposable DB путь в `scripts/local-full-pg-regression.cjs`. QA создаёт случайный synthetic owner/tenant, входит паролем (PIN не создаётся), начинает на `/inventory`, кликает «Приход», проверяет реальный URL/форму/видимость поля поставщика ниже sticky header, адаптивность/переполнение/touch targets, добавление/удаление строки, сохранение и API readback черновика. PG readback подтверждает, что до проведения нет остатка и stock movement. Для ошибки добавлена scoped строка `scroll-margin-top` у `#purchase-document-form` по существующему токену CRM шапки. Миграций, API и dist правок нет.

Проверки: 
pm run qa:inventory`, 
ode scripts/inventory-responsive-contract.mjs` и owned disposable browser/PG runner — PASS; 48 counted browser checks на 320×568, 390×844, 717×1024, 768×1024. Снимки перехода и формы: `docs/ai-team/responsive-emulator/inventory-receiving-{320,390,717,768}.png`; 320px сохранённый черновик: `inventory-receiving-320-scrolled.png`. Физический Fold и остальные маршруты/мобильные состояния не проверялись, поэтому #48 остаётся частичным. #44/#47 QA не редактировались.

## 2026-10-04 — acceptance #39: возврат владельца после PIN-lock

- Изменены только новый `scripts/owner-pin-lock-postgres-browser-qa.mjs`, собственные allowlist/env/database/guard additions в `scripts/local-full-pg-regression.cjs`, строка #39 в `HOOKAH_POS_ADDITIONAL_ACCEPTANCE.md` и этот раздел. Product auth/PIN/UI, finance/#27, SaaS, production, VPS и постоянные БД не менялись.
- Случайная owned `orders_qa_<16hex>` в проверенном disposable контейнере: synthetic organization/venue/owner, случайные пароль и PIN. Реальный браузер на localhost HTTP: password login → own PIN UI PATCH → preferences PATCH и повторное чтение PostgreSQL → настоящий минутный auto-lock → reload locked → успешный PIN unlock. Маршрут, cookie, bearer и persisted auth_sessions row неизменны; `/api/session` подтверждает владельца. Ошибки assertions не печатают token/PIN/hash.
- Первый запуск без заданного Playwright path завершился сообщением `Owner PIN browser QA requires installed Playwright package`; найден уже установленный bundled runtime, ничего не устанавливалось. Первый browser run получил unlock 200, но неверно ожидал hidden DOM overlay; assertion исправлен на реальный контракт `aria-hidden=true` и отсутствие `body.screen-locked`, без изменений lock.js. Попытка taskkill была отвергнута identity guard; ни один процесс этой командой не завершён. Runner самостоятельно завершился и выполнил finally.
- PASS: 
ode --check` обоих scripts; runner `--check-guards` (42 cases); `local-lock-contract.mjs`, `pin-lock-acceptance-contract.mjs`, `trusted-pin-return-contract.mjs`; scoped diff whitespace. Браузер/PG PASS: с `PLAYWRIGHT_PACKAGE_PATH=C:\Users\ADMIN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright` выполнен 
ode scripts/local-full-pg-regression.cjs scripts/owner-pin-lock-postgres-browser-qa.mjs`; exit 0 означает успешный DROP owned БД в finally. Lock и точные runner/child PID проверены после завершения. Code-health baseline/final, system_architect и security_reviewer+QA review approved.
- Закрыт только локальный сценарий #39; остальные строки acceptance и аппаратные устройства этим прогоном не подтверждаются.

## 2026-10-04 — Acceptance #15: soft archive for floor tables
- Added replay-safe migration 096 and schema fields rchived_at / monotonic rchive_version; active-floor reads hide archived tables while settings reads expose them.
- Added settings-only archive/restore transitions with venue/version/timestamp preconditions, row locking, one audit event per transition, live order/current confirmed reservation guards, and prevention of archived-table edit/delete/order/reservation/transfer use. UI exposes archive and restore in the floor settings view, retaining the same table identity and historical links.
- Added isolated runner-owned PostgreSQL/browser coverage for UI, tenant/RBAC, active-work guards, history preservation, concurrent retries and stale lifecycle requests. Syntax checks, scoped diff check, migration contract (97 replay-safe files), and runner read-only guard passed. Execution of the scoped PG/browser suite stopped before test startup because the configured Playwright package is unavailable; no browser assertions or PG scenario were run.
- No production publish or deployment performed.

- Follow-up: installed runtime Playwright/Chrome paths were passed only to the scoped runner process; the browser+PostgreSQL suite passed after correcting test tenant precondition, lifecycle-version assertions, and restore retry request. QA also exposed and fixed the UI mapping for `table_has_live_activity`; suite now asserts the user-facing refusal message. Runner cleaned its owned random database. Acceptance #15 updated to complete.

## 2026-10-04 — Acceptance #28: понятное проведение поступления

Read-only сверка показала, что действие проведения уже реализовано и проверено: UI отдельно сохраняет черновик, отображает кнопку «Провести поступление» с подтверждением влияния на остатки и стоимость; backend требует warehouse permission и защищает повторное проведение. Обновлена устаревшая строка #28 на «Готово» со ссылкой на существующий browser/PG сценарий. В нём UI создаёт черновик без изменения on-hand, подтверждает проведение, проверяет точные +500 мл и отклоняет replay без дублирующего stock movement. Мобильный browser/PG сценарий отдельно проверяет readback черновика и нулевое движение до проведения. Код и БД не менялись.

## 2026-10-04 — acceptance #34/#36: PIN через карточку сотрудника

- QA-only scope: новый `scripts/staff-pin-card-postgres-browser-qa.mjs`, его отдельная allowlist/env/database ветка и собственный cleanup marker в `scripts/local-full-pg-regression.cjs`, строки #34/#36 acceptance, этот раздел. Продуктовые auth/lock/login/staff files, миграции/схема и параллельные доменные suites не менялись.
- Синтетические random owner/bartender UUID и credentials в runner-owned disposable orders_qa database, отдельные browser contexts. Владелец открыл карточку сотрудника: настоящий profile PATCH200, scoped перехват только PIN PATCH503, UI оставил карточку открытой с сообщением «Карточка сохранена, но PIN не установлен»; PostgreSQL подтвердил сохранённые workNotes и отсутствие PIN. Retry реальным PATCH установил PIN, повторная карточка показала «Настроен» и пустые PIN inputs.
- Сотрудник вошёл паролем, manual lock/PIN unlock; владелец изменил PIN через карточку; в той же текущей staff session старый PIN401 invalid_pin оставил lock, новый PIN200 снял его. Route/cookie/bearer/persisted auth_sessions неизменны, session user/org/venue совпали с фикстурой. Секреты в assertion errors не выводятся.
- Первый прогон обнаружил ошибку QA fixture hash (отсутствовали scrypt delimiters); исправлен только тест, продуктовый дефект не воспроизведён. Первое выполнение завершилось в runner finally; повторный прогон PASS exit0. Runtime command: с PLAYWRIGHT_PACKAGE_PATH на существующий bundled `C:\Users\ADMIN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright` и CHROME_PATH `C:\Program Files\Google\Chrome\Application\chrome.exe`: 
ode scripts/local-full-pg-regression.cjs scripts/staff-pin-card-postgres-browser-qa.mjs`. Ничего не устанавливалось.
- Cleanup PASS: runner удалил `orders_qa_d7c96561b2861da3`; отдельный read-only pg_database запрос подтвердил отсутствие. Runner lock отсутствует, процессов точной suite нет. PASS syntax обоих scripts, runner guards42, local-lock/pin-lock-acceptance/trusted-pin-return nonDB contracts, scoped diff whitespace. Baseline/final code_health, system_architect, security_reviewer+QA approved. Коммит/публикация не выполнялись.

## 2026-10-04 — acceptance #40–41: блокировка/выход в двух вкладках

- Scope: новый `scripts/cross-tab-lock-logout-postgres-browser-qa.mjs`, только его allowlist/env/random database ветка в `scripts/local-full-pg-regression.cjs`, строки #40/#41 и этот раздел. Общие файлы проверены перед правкой; чужие dirty suite blocks сохранены. Product files/схема/миграции/постоянные БД/production/VPS не менялись.
- Один synthetic owner login, один browser context с двумя вкладками /admin. PIN сгенерирован и задан только собственному synthetic fixture; таймаут0 не повторяет auto-lock/settings39. Manual lock заблокировал обе вкладки, reload второй сохранил lock. Один реальный PIN unlock разблокировал обе без второго PIN запроса; route/cookie/bearer/persisted session неизменны. Повторный lock и один logout отправили обе на /login, очистили token/user/cookie; PostgreSQL deletion polling подтвердил отсутствие session, старый bearer получил401, reload не восстановил lock/trusted PIN card.
- Первый технический запуск обнаружил syntax generation error нового QA, исправлено без продуктовых изменений. Core browser run PASS; после final role review добавлены точные request counts и identity/cookie/no-PIN-card assertions, final повторный runner PASS exit0. Команда с существующими PLAYWRIGHT_PACKAGE_PATH bundled runtime и CHROME_PATH installed Chrome: 
ode scripts/local-full-pg-regression.cjs scripts/cross-tab-lock-logout-postgres-browser-qa.mjs`. Установок нет.
- PASS syntax, runner guards42, existing local-lock/pin-lock-acceptance/trusted-pin-return nonDB contracts, scoped whitespace; code_health baseline/final, architect, security_reviewer+QA approved. Runner exit0 подтверждает DROP собственной random DB в finally; Точные parent32136/child14896 отсутствуют; текущий lock уже принадлежит другому runner, не нашей завершённой suite, не изменялся. #40 готово локально; #41 остаётся частично: session expiry/replacement и cross-tab enable auto-lock не доказаны этим браузерным сценарием. Коммит/публикация не выполнялись.

## 2026-10-04 — acceptance #41: timeout sync regression и synthetic session expiry

- QA-only: новый `scripts/cross-tab-autolock-session-expiry-postgres-browser-qa.mjs`, отдельная runner allowlist/env/random DB ветка, строка #41, этот раздел. Продуктовый код, SaaS/#27, schema/migrations и постоянные данные не менялись. Baseline/final code_health, system_architect, security_reviewer+QA reviews выполнены.
- Две вкладки одного synthetic owner с PIN и timeout0; initial UI controls0 подтверждены, через UI первой сохранено1 (PATCH200 и PostgreSQL1), вторая получила shared preferences1, но её settings select остался0. Повторный browser run воспроизвёл `Second tab must reflect updated auto-lock preference`, actual0 expected1. Причина source: lock.js crm_session_user storage handler объединяет user, но не пересчитывает локальный timeoutMinutes; schedule использует старое0. Natural minute timer не проверялся: propagation первого lock может скрыть этот дефект.
- Независимая security часть PASS в том же сценарии: только exact own synthetic user_id+token_hash row expires_at перемещён в прошлое (rowCount1), `/api/session` старым bearer401, правильный generated PIN `/api/session/unlock`401, обе вкладки остаются locked. Часы браузера/серверная auth не подменялись. Текущий UI показывает generic error; автоматический переход на login этим контрактом не установлен. Session replacement остаётся открытым.
- Suite намеренно FAIL до продуктовой правки. Оба запуска через owned disposable runner с существующими bundled Playwright/installed Chrome; новые runtime/deps не устанавливались. Syntax, runner guards42, local-lock/pin-lock-acceptance/trusted-pin-return nonDB contracts и scoped diff whitespace PASS. Runner finally завершён после assertion failure, parent9056/child30736 отсутствуют; lock после завершения проверен. Продуктовые файлы не правились.
- Решение для следующего scoped fix: после merge user в storage handler пересчитать timeoutMinutes=readTimeout(), синхронизировать settings control, затем clearTimeout/schedule. После согласования повторить regression и отдельно доказать natural timer второй вкладки (первую держать активной настоящими UI events, чтобы её auto-lock не маскировал вторую). #41 оставлен partial с дефектом; коммит/публикация отсутствуют.

## 2026-10-04 — acceptance #41: исправлена синхронизация автозамка

- После подтверждения точечного контракта координатором исправлен обратимый локальный дефект: в same-user crm_session_user storage handler `lock.js`/`dist/lock.js` добавлены `timeoutMinutes=readTimeout()` и `syncSettings()` перед существующим clearTimeout/schedule. Auth policy, PIN/logout semantics, API/БД/миграции и SaaS/#27 не менялись. Source/dist bytes идентичны.
- Regression script `cross-tab-autolock-session-expiry-postgres-browser-qa.mjs` расширен: initial settings0, реальный PATCH→PG1→second settings1; активность первой вкладки поддерживается настоящими mouse movements каждые10с, вторая не трогается. Реальный минутный таймер второй дал reason auto, первая получила reason manual через storage event; persisted session сохранилась. Затем exact own synthetic session expiry дал bearer401 и правильный PIN401; доступ не восстановлен.
- До fix test воспроизводил0≠1; после fix runner PASS exit0. Повторный existing cross-tab-lock-logout-postgres-browser-qa PASS подтвердил отсутствие регрессии lock/unlock/logout/reload. Оба прогона только owned disposable random DB с существующим bundled Playwright/Chrome; runner finally DROP выполнен, первые parent38940/child31548 и повторные parent36504/child12616 отсутствуют, lock отсутствует. Команды: 
ode scripts/local-full-pg-regression.cjs scripts/cross-tab-autolock-session-expiry-postgres-browser-qa.mjs`; 
ode scripts/local-full-pg-regression.cjs scripts/cross-tab-lock-logout-postgres-browser-qa.mjs` с прежними installed runtime env paths.
- PASS syntax source/dist/new script/runner, guards42, local-lock/pin-lock-acceptance/trusted-pin-return contracts, source/dist equality, scoped whitespace. Code_health baseline/final, architect, security_reviewer+QA approved. #41 готово локально по указанному scope; session replacement, остальные timeout values/роли/аппаратные устройства не заявлены проверенными. При expired unlock UI остаётся locked с прежним generic error; этот UX не изменялся. Коммит/публикация не выполнялись.
### Acceptance #20 — stale purchase package draft regression · 2026-10-04

Закрыт один конкретный пробел в граничных сценариях себестоимости: при изменении `packMultiplier` ингредиента после сохранения черновика прихода проведению требуется отказать, иначе снимок упаковки в документе больше не совпадает с настройкой ингредиента. Существующая реализация уже сравнивает stored/current unit factor перед движениями; текущий API-контракт — HTTP 400 `purchase_document_post_failed`, detail `purchase_item_unit_changed`.

В `scripts/purchase-auto-order-postgres-e2e-qa.mjs` добавлен реальный API сценарий: черновик одной бутылки 1000 мл → изменение коэффициента на 700 → неуспешный POST. Проверяются сохранённый коэффициент/stock quantity, оставшийся статус `draft`, пустой source movement, неизменность on-hand и цены ингредиента, отсутствие движений и равенство venue-scoped COGS snapshots до/после. Во время прогона также найден и исправлен только тестовый fixture этого suite: synthetic venue связывается с bootstrap QA organization, как требует текущий inventory API. Продуктовый код и runner не менялись.

Проверки: baseline code-health, system architect, warehouse domain, QA; final code-health и QA review — без блокеров. 
ode --check scripts/purchase-auto-order-postgres-e2e-qa.mjs` и 
ode scripts/local-full-pg-regression.cjs purchase-auto-order-postgres-e2e-qa.mjs` — PASS на runner-owned disposable `territory_qa` PostgreSQL с teardown. Первый запуск подтвердил устаревший fixture с venue без organization; повторный запуск после локальной fixture-привязки прошёл. PIN/#41 чат на момент общего runner запуска был idle; lock runner свободен. Acceptance #20 остаётся частичным: нулевая/отсутствующая цена, архивирование и старые карты требуют отдельной проверки. #22 и другие области не менялись.

### Сквозной браузерный POS путь acceptance #47 · 2026-10-04

Добавлен `scripts/acceptance-47-pos-journey-postgres-browser-qa.mjs` и подключён к allowlist/fixture/Playwright ветке `scripts/local-full-pg-regression.cjs`. На одном синтетическом owner-сеансе браузер выполняет password login → ручную блокировку и реальный PIN unlock → UI создание зала и стола → UI открытие заказа на том же table ID → UI наличную оплату. PostgreSQL сверяет заказ→стол, состояние стола occupied/free до и после оплаты, одну проводку расхода ровно 20 мл и COGS ровно 10.00 при цене ингредиента 0.50/мл; остаток 100→80 мл. Сценарий дополняет ранее прошедший API suite с tenant/staff RBAC, но не заменяет его. Уточнён только QA-тест после первого прогона: create-table API не возвращает zoneId, поэтому принадлежность созданного стола проверяется по persisted PostgreSQL relation.

Проверки: 
ode --check` browser script и runner; 
ode scripts/local-full-pg-regression.cjs --check-guards` — PASS (42 cases); 
ode scripts/local-full-pg-regression.cjs acceptance-47-pos-journey-postgres-browser-qa.mjs` — PASS (30 assertions) с существующими bundled Playwright и Chrome. Runner создал случайную `orders_qa_<16hex>` disposable БД, выполнил миграции и удалил её в finally. Product code, migrations, production и VPS не менялись. Границы: проверен manual PIN lock/unlock, не auto-timeout, trusted-device PIN return, cross-tab и физическое устройство.
### Acceptance #18 — построчная расшифровка себестоимости техкарты · 2026-10-04

Сохранённая карточка и шаг проверки в редакторе техкарты теперь показывают исходное количество рецепта и нормализованное количество в складской единице. Для связанного ингредиента рядом отображаются фасовка и коэффициент, текущая цена складской единицы, стоимость строки, итог и стоимость порции. Эквивалент полной закупочной фасовки считается из текущей средней себестоимости и подписан как расчётный; цена документа и исторический `order_costs`/COGS не менялись. Добавочные `recipeQuantity`/`recipeUnit` в cost DTO сохраняют исходные значения, не меняя действующие `quantity`, `unit`, формулу и суммы. Логика карточки и wizard preview синхронизирована в `portal.js` и `dist/portal.js`.

Добавлен `scripts/recipe-cost-breakdown-postgres-browser-qa.mjs` и подключён к локальному regression runner/allowlist. Сценарий создаёт синтетическую техкарту с двумя ингредиентами на случайной runner-owned disposable PostgreSQL базе, сверяет API числа и показывает карточку плюс preview в Chromium при 390×844. Первые прогоны обнаружили несовпадение тестового селектора/форматирования (title case и локализованная цена `1,8 ₽`) и мобильную проблему верстки: цена строки сжималась, пояснения слипались. Селекторы приведены к фактическому тексту интерфейса, а в мобильном режиме пояснения стали блочными строками и цена защищена от сжатия; правило добавлено в `style.css` и `dist/style.css`. Финальный browser QA проверяет отсутствие ошибок страницы и failed API после авторизации, прошёл; финальный screenshot `tmp/full-local-qa/recipe-cost-breakdown-390.png` визуально проверен без ошибки и переполнения. Затем `recipe-depletion-pg-runtime-qa.mjs` подтвердил прежнее списание/COGS. Все временные базы удалены runner-ом.

Проверки: 
ode --check` для `server.js`, `portal.js`, `dist/portal.js`, browser QA и regression runner; guards — PASS (42 cases); scoped `git diff --check` — PASS; `recipe-cost-breakdown-postgres-browser-qa.mjs` — PASS; `recipe-depletion-pg-runtime-qa.mjs` — PASS; code-health/architect final reviews — без замечаний, source/dist расчетные блоки совпадают. Полный `local-full-qa --postgres` отдельно останавливался на уже существующем migration-upgrade fixture guard (`ingredient venue must belong to an organization`), вне этого сценария. Cache retry/focus/stale-response ветки не входят в данный E2E. Production, VPS и публикация не затрагивались.

## 2026-10-04 — QA-fixture repair: migration upgrade through tenant guard

`migrations-pg-upgrade-qa.mjs` создаёт synthetic venue уже после replay миграции 009 и до replay миграции 094. Прямая INSERT фикстура пропускала organization_id, поэтому текущий tenant guard из 094 отвергал последующий ingredient INSERT; это не дефект продуктового инварианта. Фикстура теперь явно привязывает тестовый venue к bootstrap organization `territory`, созданной migration 009. Триггер/ограничения продукта, migrations и общий runner не изменялись. 
ode --check scripts/migrations-pg-upgrade-qa.mjs` и scoped `git diff --check` — PASS. 
ode scripts/local-full-pg-regression.cjs migrations-pg-upgrade-qa.mjs` — PASS: 77 baseline + 59 новых миграций; итоговый лог подтверждает schema rollback. Runner lock и процессы suite после завершения отсутствуют.

## 2026-10-04 — acceptance #21: недоступный payroll ledger в demo/memory

- Координатор разрешил локальную payroll/analytics область portal.js и memory analytics server.js; владельцы других чатов синхронизированы. До изменений сохранены scoped baseline-копии в tmp/payroll-acceptance-21. SHA256: server B7AEA597A9CA966344DF8DB936DF01140B9A5B1C17B4396FB2798221D6F64837; portal 1A14F91EB3C6B4FBC698F0B68E37D83425EAD52AEA69607BA75BF0CEB73451DA.
- Архитектор/финансовый аудит и code_health baseline подтвердили: demo/memory не имеют payroll-entry ledger и lifecycle. Demo признавал paid payroll-expense на дату выплаты как начисление; memory подставлял payroll:0. Создание нового ledger требует отдельного согласованного контракта. PostgreSQL уже признаёт approved/paid по расчётному периоду и отделяет связанный paid expense в cash flow; его код не менялся.
- Безопасный завершённый локальный объём: payroll, полные expenses/netProfit/cashOutflow и их итоги неизвестны (null), payrollCoverage={status:'unsupported',reason:'payroll_requires_database'}, officialReady=false. Наблюдаемые operatingExpenses/totalOperatingExpenses отделены от полного P&L; существующие revenue/COGS сохранены. Неподтверждённый payroll-expense не превращается в начисление или подтверждённую выплату.
- Demo payroll endpoints явно возвращают ошибку503 с проверкой finance; analytics проверяет finance_read. Finance cards/chart и dashboard insight показывают недоступность без null→0. Подтверждённые PG-shaped значения0/90 отображаются как реальные значения. Маршруты/навигация не менялись.
- Файлы: server.js, portal.js; новый scripts/payroll-analytics-unavailable-qa.mjs; обновлены устаревшие payroll expectations scripts/finance-api-consistency-contract.mjs и две profit assertions scripts/recipe-depletion-runtime-qa.mjs.
- PASS: node --check server.js; node --check portal.js; node --check scripts/payroll-analytics-unavailable-qa.mjs; node scripts/payroll-analytics-unavailable-qa.mjs; node scripts/finance-api-consistency-contract.mjs; node scripts/finance-expense-payroll-status-contract.mjs; scoped git diff --check. Новый QA запускает собственный ephemeral memory server и останавливает его; реальный memory API, repeat read, manual expense, запрет поддельного payroll expense, payroll503; исполняемые demo/chart/card/dashboard ветки в VM с doubles, permissions/reload и контроль известных значений. Это не браузерная/визуальная приёмка и не новое доказательство PG начислений.
- Старый recipe-depletion-runtime-qa остановился до payroll analytics: POST /api/orders409 table_not_found_or_unavailable (тест использует произвольный tableId). Такой же сбой отдельно воспроизведён с точной baseline-копией server.js; временные файлы удалены. Не выдаём этот скрипт за PASS и не исправляем чужую floor-область.
- Final code_health: найден и устранён dashboard null→0; повторный scoped review и runtime QA PASS, новых findings нет.
- Acceptance #21 остаётся Partial: безопасное отображение недоступной базы исправлено; полная demo/memory accrual-period/payment-date parity требует настоящего ledger/lifecycle. Существующий demo venue/browser-date scope — отдельный baseline-блокер правила8. Настроенная недоступная PG продолжает отдавать503 без memory fallback. Official payroll writer/sources readiness не изменились. Persistent QA DB, SaaS/VPS/production, commit/publish не затрагивались.

### Acceptance #21 — адресная синхронизация dist

По handoff координатора скопирован только portal.js → dist/portal.js, без запуска общего sync-published-assets. До копирования dist точно совпадал с prechange portal baseline; после SHA256 обеих копий E3741734AD399DF8B4200525622516DBBB5326B25220DA254ED1F011FBD62413. Regression scripts/payroll-analytics-unavailable-qa.mjs дополнен проверкой Buffer byte-for-byte parity. Actual syntax обеих копий/QA, runtime regression и scoped diff-check PASS. Прочие dist-ресурсы не переписывались; commit/publish отсутствуют.
Независимый final code_health повторно подтвердил побайтовое совпадение source/dist, syntax обеих копий/QA, runtime regression и scoped diff-check PASS; замечаний нет.
## 2026-10-04 — #33 browser/API/PostgreSQL сортировка приходов с NULL датой

- Добавлен отдельный authenticated browser acceptance для создания двух синтетических черновиков с разными датами и одного без даты, свежего API read, прямой PostgreSQL сверки порядка `document_date DESC NULLS LAST`, фильтра `status=draft/posted`, reload и повторной UI сортировки. Пустой `documentDate` остаётся NULL; UI явно показывает «Дата накладной не указана», а API сохраняет отдельный `recordedAt`.
- PASS: 
ode scripts/local-full-pg-regression.cjs acceptance-33-purchase-date-order-postgres-browser-qa.mjs` — 54 assertions; runner сообщил удаление одноразовой `inventory_qa_<random>` БД. 
ode scripts/local-full-pg-regression.cjs --check-guards` — PASS (42 cases); 
ode --check` обоих затронутых скриптов и scoped `git diff --check` — PASS. После прогона lock и процессов runner нет; code-health и QA reviews — PASS.
- Первый запуск обнаружил ошибку только в тестовом сравнении: PostgreSQL DATE сериализовалась timestamp-ом и `.slice(0,10)` сдвигал календарный день; сравнение теперь нормализуется в часовом поясе synthetic venue `Asia/Yekaterinburg`. Повторный isolated прогон прошёл. Продуктовый код, persistent QA/demo PIN, production, VPS и публикация не затронуты.
- #33 остаётся частичным: status=posted проверен пустым ответом, отдельный posted документ не создавался; в текущем UI отсутствуют date/status filters, и приёмка не добавляла новую фильтрацию; другие списки без даты отдельно не проверялись.
## 2026-10-04 — isolated memory UI проверка ингредиентов и премиксов

- В отдельном временном `server.js` на loopback с `DATABASE_URL` пустым и `health.database=memory` через UI созданы две складские позиции и две связанные карты премикса (70/30 и 30/70 по 100 г); API подтвердил сохранение, а fresh GET после reload — повторное чтение. UI/открытая форма проверены на 320×568, 390×844, 717×1024, 768×1024 и 1440×900; геометрический overflow отсутствовал. API и JavaScript errors не зафиксированы.
- Визуальный просмотр выявил, что на 320 px заголовок формы позиции частично скрыт sticky header, а сообщение «Не удалось загрузить каталог» перекрывает часть формы. Это отдельный незакрытый mobile/UI gap #48; screenshots сохранены в `tmp/remix-emulator-server-20261004130246/screens/`.
- В ходе прогона воспроизведён parser defect: ингредиент с символом `—` в названии ломает разбор состава и расчёт себестоимости; причина — split по тому же символу в `portal.js` (`parseIngredientLines`). Product fix не делался; дефект внесён как ограничение acceptance #16.
- Только disposable in-memory данные; persistent QA PostgreSQL, localhost:31932, production, VPS, исходники и runner не менялись. Временный сервер остановлен.

## 2026-10-04 — #30 визуальная проверка поля даты прихода

- Через временный authenticated server с `health.database=memory` осмотрено `#purchase-date` на 320×568, 390×844, 717×1024, 768×1024 и 1440×900. Поле `type=date` необязательное, календарный placeholder/иконка и dark theme отображаются; высота 44 px, доступное имя и пояснение об optional дате читаются; фокус через Tab и focus ring работают, viewport не переполняется. Вызов `showPicker()` не дал исключения, но поверхность нативного picker не была визуально подтверждена.
- Проверены синтетические invalid и disabled состояния: пользовательская HTML validity показывает ошибку, но отдельный error border/style на input отсутствует; invalid строку `type=date` браузер сбрасывает в пустое значение. Disabled style различим (`opacity: .58`, `cursor: not-allowed`). Реальный async submit/pending и реальную form error ветку не запускал, чтобы оставаться без API writes.
- Скриншоты: `tmp/purchase-date-audit-20261004131232/screens/date-{320,390,717,768,1440}-{normal,focus}.png`, а также synthetic invalid/disabled. В memory-режиме поверх нижней части формы повторно виден toast «Не удалось загрузить каталог»; date control он не закрывает. Product files/DB/runner не менялись; временный memory-server остановлен и больше не отвечает.
- #30 остаётся частичным до визуальной проверки реального native picker и async/error states; текущий optional date input не имеет собственного серверного validation error state.
# 2026-10-04 — исправление разбора ингредиентов с эм-даш в названии

- В `portal.js` и точной публикационной копии `dist/portal.js` калькулятор себестоимости и разбор состава техкарты теперь ищут последний разделитель ` — ` перед количеством. Полное название, включая внутреннее `—`, сохраняется для складской связи, COGS preview и payload сохранения.
- Добавлен `scripts/recipe-em-dash-parser-qa.mjs`: 18 изолированных assertions на `Мята — свежая`, обычный ингредиент, id/количество/единицу, корректный итог стоимости и невалидные количества; база/сервер не использовались.
- Проверки: новый QA, `recipe-form-pending-qa.mjs`, `premix-create-route-qa.mjs`, 
ode --check portal.js`, 
ode --check dist/portal.js`, `git diff --check` — прошли. Code-health baseline выявил ранее грязные `portal.js`, `dist/portal.js` и premix QA script; эти несвязанные правки сохранены.
- Acceptance #16 остаётся частичным из-за непокрытых вариантов ингредиентов, потерь и крайних условий; воспроизводимый дефект с эм-даш исправлен.

## 2026-10-05 — #48 складская форма на 320 px

- Исправлен перекрытый sticky header заголовок редактора складской позиции на 320 px: создание и редактирование прокручивают саму панель с `scroll-margin-top`; фокус названия использует `preventScroll` и больше не сдвигает панель под шапку.
- Browser-регрессия проверяет геометрию панели и заголовка, hit-test поля названия на 320×568 и возврат к `view=movements`. Свежий снимок `tmp/inventory-editor-320.png` визуально подтверждает отсутствие перекрытия.
- Добавлен bounded UI/API/PG сценарий повторного номера накладной: HTTP 409 `document_number_exists`, ошибка в UI, сохранение значений/разблокировка формы, исправление номера, retry 201 и точный GET/venue-scoped PostgreSQL readback только исходного и исправленного документов.
- `node scripts/local-full-pg-regression.cjs inventory-receiving-mobile-postgres-browser-qa.mjs` — PASS, 189 checks. Owned disposable DB `inventory_qa_9b6136ab63efc402` удалена runner-ом, lock отсутствует. `node --check` и scoped code-health review PASS. Исходные пять suite-скриншотов восстановлены по manifest; `portal.js`/`dist/portal.js` и CSS пары побайтно совпадают.
- Остальные #48 маршруты/error branches и физический Fold остаются непроверенными; сторно #27 и payroll lifecycle #21 требуют отдельных продуктовых контрактов. SaaS, серверы, production, commit и публикация не затронуты.

## 2026-10-05 — #44 UI автозаказа и отмена

- В существующий `scripts/acceptance-44-inventory-crossflow-postgres-browser-qa.mjs` добавлен bounded browser/API/PG сценарий: synthetic ingredient с нулевым остатком, создание из UI одной заявки на 750 мл, reload и сверка статуса/количества, подтверждённая отмена, затем сверка API и PostgreSQL.
- Сценарий также подтверждает, что отмена не создаёт приход, строки прихода или складские движения и сохраняет нулевой остаток.
- `node --check` и scoped whitespace check прошли; code-health baseline/final review не выявил блокеров. Disposable runner: `node scripts/local-full-pg-regression.cjs acceptance-44-inventory-crossflow-postgres-browser-qa.mjs` — PASS, 128 assertions. Runner удалил одноразовую БД `inventory_qa_f7b5232747a755c3`; lock отсутствует, связанных node-процессов после прогона нет.
- В тот же #44 browser suite добавлен изолированный UI/API/PG выпуск премикса: 250 мл synthetic компонента → одна партия на 500 мл; сверяются 201 POST, сообщение/история после reload, batch row, ровно один debit и один output credit, балансы 150/500 мл и себестоимость партии 25 ₽ (0,05 ₽/мл). Отдельные ингредиенты и рецепт не меняют основную продажу/COGS.
- Итоговый disposable runner: PASS, 194 assertions; БД `inventory_qa_2883aed6a5a38482` удалена, lock/process cleanup PASS. Code-health review PASS; первоначальный сбой был из-за строгого сравнения отображения 500 мл против PG scale 500.000 мл; критерий допускает только равное число с нулевой дробной частью и тест прошёл.
- Менялся только QA-сценарий; продуктовый код, runner, SaaS, VPS, production, persistent QA DB, commit и публикация не затронуты.

## 2026-10-05 — #30 backend validation даты прихода

- В `scripts/inventory-receiving-mobile-postgres-browser-qa.mjs` добавлена проверка настоящего backend rejection: обычный UI submit отправляет impossible date `2026-02-30` после тестовой смены input type с date на text. Network response должен быть реальным HTTP 400 `invalid_purchase_document`; никакие маршруты не подменяются.
- UI показывает ошибку, сохраняет поля/строку и разблокирует форму. Свежий authenticated GET и PostgreSQL подтверждают отсутствие отклонённого draft; остаток и движения остаются без изменений.
- `node --check` и code-health baseline/final review — PASS. Disposable runner: `node scripts/local-full-pg-regression.cjs inventory-receiving-mobile-postgres-browser-qa.mjs` — PASS, 206 checks. Одноразовая БД `inventory_qa_a5c3f49f3733cc18` удалена; runner lock/process cleanup PASS. Suite перезаписала два эмуляторных снимка; они восстановлены побайтно по исходному manifest, все manifest hashes совпали.
- Дополнительно повторно открыт native date picker в authenticated memory UI: календарь появляется в accessibility tree; screenshot in-app page не показывает нативный popup, поэтому визуальный screenshot-proof остаётся ограничением #30. Никаких документов/движений не создавалось в этом осмотре; memory server и временная вкладка закрыты.
- Изменён только QA script и локальные acceptance записи; product code/runner, production, SaaS, VPS, commit и публикация не затронуты.

## 2026-10-05 — #44 масштабирование выпуска премикса

- Существующий authenticated browser/API/PG сценарий расширен множителем выпуска 1.5: UI отправляет точный multiplier, рецепт 250 мл списывает 375 мл сырья и выпускает 750 мл премикса; API, перезагруженная история и PostgreSQL сверяют выход 750 мл, партию стоимостью 37,50 ₽ и себестоимость 0,05 ₽/мл.
- Та же synthetic-партия проходит пересчёт 750→730 мл и списание порчи 10 мл до 720 мл; в PG подтверждены точные batch-linked движения, неизменность остатка сырья и блокировка/отсутствие POST для отмены после складских событий.
- `node scripts/local-full-pg-regression.cjs acceptance-44-inventory-crossflow-postgres-browser-qa.mjs` — PASS, 238 assertions. Одноразовая БД `inventory_qa_2f384b0c02ab71bf` удалена runner-ом, lock отсутствует. Code-health review и `node --check` PASS. Первый прогон поймал только различие локализованного отображения `37,5 ₽`; критерий истории принимает десятичную точку или запятую.
- Изменены QA-сценарий и acceptance-записи; продуктовая логика не менялась. SaaS, VPS, production, persistent QA DB, commit и публикация не затронуты.

## 2026-10-05 — #48 отказ загрузки списка приходов

- В `scripts/inventory-receiving-mobile-postgres-browser-qa.mjs` добавлен authenticated mobile browser сценарий временного HTTP 503 для одного GET `/api/inventory/purchase-documents`. UI показывает ошибку загрузки и не выдаёт её за пустой список; черновик, остаток и движения сверяются без изменений через API и PostgreSQL. После снятия перехвата reload снова показывает сохранённый draft.
- `node scripts/local-full-pg-regression.cjs inventory-receiving-mobile-postgres-browser-qa.mjs` — PASS, 225 checks. Одноразовая БД `inventory_qa_0bbf6c3148a10cdb` удалена runner-ом, lock снят. `node --check`, code-health baseline/final review PASS. Пять прежних responsive screenshot assets сверены по manifest; два перезаписанных снимка восстановлены по SHA-256.
- Изменены QA-сценарий и локальные acceptance записи; product code/runner, SaaS, VPS, production, persistent QA DB, commit и публикация не затронуты.

## 2026-10-05 — #20 явная нулевая цена закупки

- В существующем `scripts/purchase-auto-order-postgres-e2e-qa.mjs` добавлен отдельный synthetic ingredient/document со входной ценой `unitCost: 0`, не связанный с проверяемым автозаказом. Проверены draft API/PG: `unitCost`, `receiptUnitCost`, `lineTotal` равны 0, количество 1000 мл сохраняется, до проведения нет stock movement. После проведения проверены статус, нулевые значения стоимости, положительный остаток и единственная точная связанная movement `in` на 1000 мл.
- `node scripts/local-full-pg-regression.cjs purchase-auto-order-postgres-e2e-qa.mjs` — PASS. Read-only SQL после завершения подтвердил удаление disposable `territory_qa`; runner lock отсутствует. `node --check`, code-health baseline/final review PASS.
- Acceptance #20 остаётся частичным по поведению архивирования ингредиента при открытом draft и старым рецептам после изменения pack factor. Product code, формула, runner, SaaS, VPS, production, persistent QA DB, commit и публикация не менялись.

## 2026-10-05 — повторная локальная finance report browser QA

- Повторно запущен существующий `scripts/finance-report-browser-qa.mjs` после задания локальных Playwright/Chrome env paths. PASS, exit 0: изменение даты, ошибка/повтор, переключение waiter, защита от устаревшего GET и заполненный отчёт на 320/768/1440 px.
- QA самостоятельно поднял loopback demo/memory server с пустым `DATABASE_URL`; PostgreSQL, production и SaaS не использовались. Отсутствие browser env больше не является техническим блокером локальной finance UI проверки; #21 остаётся частичным по отдельному payroll ledger/lifecycle контракту и независимой venue/date сверке.

## 2026-10-05 — #20 рецепты после смены коэффициента фасовки

- В `scripts/recipe-cost-breakdown-postgres-browser-qa.mjs` добавлен отдельный authenticated browser/API/PG сценарий: после сохранения рецепта меняется `packMultiplier` ингредиента с 700 на 500 мл. API, повторно загруженная карточка и вновь открытый preview подтверждают неизменность базовой цены 1,80 ₽/мл, исходных 200 мл, вклада 360 ₽ и суммы 384 ₽; расчётный эквивалент фасовки обновляется 1260→900 ₽. Проверено отсутствие изменения остатка и числа движений.
- Изолированный runner прошёл: 66 checks; одноразовая БД `inventory_qa_95517cf972f02b35` удалена, runner lock отсутствует. Первый прогон завершился до финального снимка из-за скрытого wizard preview после навигации; тест повторно открывает preview, успешный прогон сделал снимок. Предыдущий фиксированный screenshot hash изменён suite; исходная копия сохранена в `tmp/full-local-qa/recipe-cost-breakdown-390.png.before-factor-change`.
- `node --check` и `git diff --check` прошли; финальный code-health review подтвердил отсутствие блокеров. Последующая проверка архивации/открытого draft записана отдельной записью ниже; остаётся неопределённой семантика проведения после архивации. Product code, runner, SaaS, VPS, production, persistent QA DB, commit и публикация не затронуты.

## 2026-10-05 — #20 архивирование ингредиента с открытым приходом

- В существующий `scripts/purchase-auto-order-postgres-e2e-qa.mjs` добавлен отдельный synthetic API/PG сценарий: при нулевом остатке архивирование ингредиента ссылаемого открытым приходом проходит; API и PostgreSQL подтверждают, что позиция архивирована, документ/строка остаются читаемыми и в статусе draft, источник движения отсутствует, остаток и ledger не меняются.
- `node scripts/local-full-pg-regression.cjs purchase-auto-order-postgres-e2e-qa.mjs` — PASS. Read-only запрос к runner-owned контейнеру подтвердил отсутствие `territory_qa`; runner lock отсутствует. `node --check` и scoped `git diff --check` прошли.

## 2026-10-05 — #30 попытка снять нативный календарь в локальном UI

- Для визуального снимка запущен отдельный loopback memory server без БД и открыт локальный экран входа. После входа синтетическим demo owner появилось штатное окно блокировки и запрос PIN; PIN не вводился и не подбирался, складские данные не изменялись. Временная вкладка закрыта, созданный мной сервер остановлен, порт 60788 больше не слушает.
- Поэтому screenshot нативного popup календаря всё ещё недоступен в текущем состоянии UI; матрица #30 остаётся частичной.

## 2026-10-05 — сверка PIN lock/session acceptance #37 и #47

- Пересверены актуальные matrix rows с существующими suites и runner logs: #37 локально доказывают `owner-pin-lock-postgres-browser-qa.mjs` (реальный auto-lock, reload, тот же route/token/session после PIN), `cross-tab-lock-logout-postgres-browser-qa.mjs` и `cross-tab-autolock-session-expiry-postgres-browser-qa.mjs` (две вкладки; истёкшая серверная сессия не восстанавливается правильным PIN). Все три существующих runner logs показывают PASS; одноразовые БД удалены согласно worklog предыдущих запусков.
- #37 переведён в «Готово локально»; #47 уточнён: авто-блокировка и expiry покрыты отдельными suites, но не входят в один интегрированный POS journey. Физическое Fold/устройства остаются непроверенными. Код, runner и тесты не менялись.

## 2026-10-05 — #48 отказ PATCH при редактировании прихода

- В `scripts/inventory-receiving-mobile-postgres-browser-qa.mjs` добавлен контролируемый однократный HTTP 503 только на PATCH существующего synthetic draft. UI показывает ошибку, оставляет supplier/quantity/price в форме и снова разрешает retry; authenticated GET и venue-scoped PostgreSQL подтверждают исходные сохранённые значения, статус draft, отсутствие движения и нулевой остаток. После снятия перехвата существующий штатный PATCH с новыми значениями проходит и дальше проверяется прежними readback assertions.
- `node scripts/local-full-pg-regression.cjs inventory-receiving-mobile-postgres-browser-qa.mjs` — PASS, 248 checks. Disposable `inventory_qa_9d655fbc794468fd` отсутствует при read-only проверке внутри runner container; runner lock снят. `node --check` и code-health baseline/final review — PASS.
- Шесть скриншотов suite (четыре размера + scrolled 320 + item editor 320) побайтно восстановлены из pre-run backups; SHA-256 совпадает. Product code, runner, SaaS, VPS, production, persistent QA DB, commit и публикация не затронуты.

## 2026-10-05 — #35 runtime-проверка cookie конфигурации

- На двух временных loopback memory-only процессах проверены login cookies при `COOKIE_SECURE=false` и `true`: `crm_session` и `crm_device_id` сохраняют `HttpOnly`, `SameSite=Lax`, `Path=/`; атрибут `Secure` присутствует только при включённой настройке. Logout возвращает истечение `crm_session` (`Max-Age=0`) с HttpOnly/SameSite атрибутами. Оба режима — PASS; внешняя/production среда и БД не использовались, оба процесса остановлены.
- Матрица #35 уточнена. Статус остаётся «Частично»: не описана полная матрица HTTP/HTTPS reverse-proxy и browser/session окружений. Product code, deployment config, SaaS, VPS, production, persistent QA DB, commit и публикация не менялись.
- Проверка `hookah-additional-acceptance-contract.mjs` выявила устаревшие статусные метки вне принятого словаря в строках 4–10 и 15; нормализовал их до `Готово`, не меняя критерии и описания требований. Контракт затем прошёл.
- Сопутствующий `local-deploy-contract.mjs` завершился FAIL на независимой упаковочной проблеме: `server.js` требует `order-attention.js`, но текущий изменённый `Dockerfile` не копирует этот незакоммиченный модуль в CRM image. Не менял общий релизный пакет; это требует согласования с владельцем соответствующих server/Dockerfile изменений до возможного deploy.
- Сверил acceptance #27/#30 с последним фактическим PASS логом #48 (248 checks) и уточнил в матрице доказанные GET/PATCH отказные состояния. Для #30 popup нативного календаря по-прежнему не подтверждён скриншотом; полный статус оставлен частичным.
- Packaging gap устранён в `Dockerfile`: вместе с `order-attention.js` включены транзитивные runtime payroll dependencies, отсутствовавшие в образе. `local-deploy-contract.mjs`, `order-attention-qa.mjs` и `git diff --check -- Dockerfile` — PASS. Независимый code-health review подтвердил полный граф из 25 локальных `require`-модулей плюс обоснованный статический `payroll-scheme-ui.js`; лишних файлов нет. Commit/deploy/VPS не выполнялись.
- В `docs/requirements/AUTH_SMOKE_BACKGROUND.md` добавлена проверенная конфигурационная матрица session cookies: loopback HTTP QA, TLS Nginx reverse proxy и однократное явно разрешённое HTTP-only окружение; отдельно описаны host-only/SameSite ограничения, session TTL и logout. Acceptance #35 закрыт локально на основании runtime проверки обоих `COOKIE_SECURE` режимов и deploy contract; внешний TLS endpoint оставлен release-проверкой.

## 2026-10-05 — продуктовый контракт v1 для сторно прихода (#27)

- Пользователь делегировал выбор безопасного поведения координатору. После сверки модели, кода и read-only отзывов finance-domain, system-architect, payroll и MASTER зафиксирован строгий режим: только полный reversal неиспользованного и полностью доказуемого unpaid receipt; отдельная версионируемая настройка venue, snapshot policy при проведении, перспективное изменение настройки.
- Paid/part-paid, legacy без valuation/source snapshots, использованные/частичные остатки, последующие движения, valuation variance, закрытая смена/период и backdating fail closed. Expenses и исходный posted receipt неизменяемы; supplier refund/credit ждёт отдельного ledger; COGS и weighted-average history не переписываются. Нужны inventory+finance права, venue locks, атомарные movement/order/audit writes и idempotency.
- Изменены только `docs/requirements/FINANCE_MODEL.md`, `docs/ai-team/DECISIONS.md`, строка #27 `HOOKAH_POS_ADDITIONAL_ACCEPTANCE.md` и этот журнал. Код, схема, БД и runner не менялись; сторно пока не реализовано, acceptance не запускался. MASTER подтвердил отсутствие конфликта.

## 2026-10-05 — архивная складская позиция в черновике прихода (#20)

- Исправлена первопричина, из-за которой сохранённый приход мог провести запас на архивный ingredient, отсутствующий в активном списке. `PurchaseDocumentRepository.post()` теперь проверяет `is_marked` на уже блокируемой строке ingredient и отклоняет весь документ до первого stock movement; route возвращает 409 `purchase_ingredient_archived`. Транзакционный rollback сохраняет draft, стоимость, остаток, движения и состояние auto-order. Demo/memory также fail-closed при отсутствующей/архивной позиции.
- В UI архивная строка draft сохраняет имя-снимок и понятное пояснение; после отклонения оператор может заменить строку либо отменить черновик. Исходные архивные draft и void semantics сохранены. Источник `portal.js` и `dist/portal.js` побайтно совпадают.
- Расширен существующий изолированный purchase PG сценарий: архивированный draft POST→409; проверены venue-scoped readback, нулевая проводка, неизменные cost и auto-order, затем успешная отмена draft. `node scripts/local-full-pg-regression.cjs purchase-auto-order-postgres-e2e-qa.mjs` — PASS; `scripts/purchase-documents-contract.mjs`, `scripts/purchase-document-pending-qa.mjs`, `node --check` всех затронутых JS/MJS — PASS. Финальный code-health, system-architect, warehouse-domain и QA review — PASS.
- Cleanup подтверждён: runner guard PASS, одноразовая `territory_qa` удалена, runner lock отсутствует, сервер на 3219 остановлен. Изменены узкие секции `db.js`, `server.js`, `portal.js`, `dist/portal.js`, три purchase QA scripts, строка #20/#49 acceptance и этот журнал; сторонние грязные hunks сохранены. #20 закрыт локально; #27 сторно всё ещё не реализовано по ранее выбранному контракту.
## 2026-10-05 — локальная реализация и acceptance сторно прихода (#27)

- Пользователь делегировал координатору выбор безопасной политики. Реализована additive migration 097: append-only venue policy history с перспективными версиями, posting-time snapshots количества/себестоимости/движений и автозаказа, reversal header/lines с source lineage, уникальным сторно на приход и идемпотентностью. Инкрементальный ingredient movement version закрывает последующие движения; составной `(venue_id,id)` индекс добавлен как обязательная цель для tenant-scoped FK.
- Backend добавил owner/admin настройку в заведении и authenticated API full reversal с одновременными inventory+finance правами, same-origin для cookie, tenant/actor проверки, ровно одной открытой сменой, venue-local датой, fail-closed на оплате, использованном/изменённом остатке, старых/неполных snapshot и несогласованном автозаказе. Операция компенсирует отдельными stock movements, атомарно записывает audit, сохраняет source receipt/expenses/order COGS и возвращает исходную оценку; тот же idempotency key/payload отдаёт прежний результат.
- UI добавил настройку правила заведения, policy version badge, reversal action, подтверждение/причину, retry key и отображение отказа/результата. `portal.js` адресно скопирован в `dist/portal.js`; SHA-256 source/dist совпадает. `purchase-reversal-contract.mjs` проверяет миграционные, tenant/RBAC, UI и parity контракты.
- `acceptance-27-purchase-reversal-postgres-qa.mjs` прошёл через `scripts/local-full-pg-regression.cjs`: 76 authenticated API/PG assertions, включая full reversal, точное восстановление остатка/себестоимости, историческую версию настройки, role/tenant boundaries, replay и mismatch, second reversal, paid/used/closed-shift rejection, rollback при отказе audit, source immutability, linked auto-order exact restore и отказы при linked draft/изменённой заявке. Тест повторно применяет migration 097 для проверки replay/idempotency миграции. Первый миграционный прогон обнаружил недостающий unique index; существующий auto-order suite затем выявил слишком узкий CHECK, запрещавший draft до posting snapshot. Оба дефекта исправлены; `purchase-auto-order-postgres-e2e-qa.mjs` и финальный #27 прогон прошли, одноразовые БД удалены, lock снят.
- Добавлен `acceptance-27-purchase-reversal-postgres-browser-qa.mjs`: authenticated browser проверяет загрузку политики venue и полномочий владельца, создание draft через экран склада, проведение, confirm + reason, полное сторно, сохранность source receipt и показ результата после обновления UI/API. Playwright и Chrome взяты из локального runtime. Финальный повторный browser suite прошёл; runner удалил `inventory_qa_b7ec8a457dbcf7a7`.
- Финальный PASS: `node --check` browser suite/runner; `purchase-reversal-contract.mjs`; `purchase-documents-contract.mjs`; `purchase-document-pending-qa.mjs`; authenticated API/PG acceptance #27 (76 assertions); authenticated browser acceptance #27; disposable DB cleanup PASS, runner lock отсутствует. Остался только визуальный review на физическом Fold/устройствах. Production/VPS/persistent QA DB, commit и публикация не затронуты.

## 2026-10-05 — #33 фильтр списка по реально проведённому приходу

- Расширен только `scripts/acceptance-33-purchase-date-order-postgres-browser-qa.mjs`: в synthetic venue создаются три черновика с разными датами и NULL, ещё один датированный приход штатно проводится через authenticated API. Проверяется полный порядок списка, что `status=draft` возвращает только три черновика в порядке даты, а `status=posted` возвращает точный проведённый документ; API и PostgreSQL подтверждают его статус и исходную дату. Существующие проверки NULL/`recordedAt`, UI reload и `DESC NULLS LAST` сохранены.
- `node --check`, `purchase-documents-contract.mjs`, runner `--check-guards` (42 cases) и полный browser/API/PG runner — PASS; acceptance #33 теперь 69 assertions. Playwright был задан из локального runtime через `PLAYWRIGHT_PACKAGE_PATH`; runner подтвердил удаление `inventory_qa_2d81ed8fc0dca599`, lock снят. Первые два запуска остановились до/на fixture setup; их случайные БД также удалены.
- Матрица #33 обновлена. Пункт остаётся частичным: UI не имеет фильтров даты/статуса, другие списки без даты не покрыты. Продуктовый код, UI semantics, SaaS, VPS, production, persistent QA DB, commit и публикация не затронуты.

## 2026-10-05 — #16 все компоненты себестоимости техкарты

- Расширен только `scripts/recipe-cost-breakdown-postgres-browser-qa.mjs`: одна synthetic техкарта включает четыре позиции с исходными единицами л, мл, кг и шт и складскими мл, мл, г и шт. Для кг→г проверены исходные `0.012 кг`, нормализованные 12 г и вклад 5,04 ₽; `2 шт` сохраняется как две штуки с вкладом 36 ₽. API DTO, сохранённая карточка и wizard preview показывают компоненты и общий итог 425,04 ₽. Изменение коэффициента фасовки пересчитывает только её эквивалентную цену; остаток и число движений остаются прежними.
- `node --check`, runner read-only `--guard` и authenticated browser/API/PG suite — PASS (78 проверок, 390×844). Runner подтвердил удаление случайной disposable БД `inventory_qa_5606b08595512bf3`; lock отсутствует. Сгенерированный скриншот восстановлен из существующей `.before-factor-change` копии, SHA-256 совпадает. Code-health review не обнаружил блокеров; отметил, что тестовый файл неотслеживаемый, поэтому сравнить его с предыдущей версией через Git diff нельзя.
- Матрица #16 обновлена, статус остаётся частичным: сценарий проверяет конкретные поддержанные единицы и не определяет правила потерь, выхода и остальные граничные случаи. Product code, миграции, SaaS, VPS, production, persistent QA DB, commit и публикация не затронуты.

## 2026-10-05 — повторная проверка визуального пробела #30

- Повторно сверены состояние чатов и доступная локальная UI-среда. MASTER подтвердил отсутствие конфликта; POS QA чат остановился на штатной PIN-блокировке и не выполнил складской UI-путь. Payroll принял границы #27; loyalty roadmap закрыт и нового задания не получил.
- Read-only responsive/visual audit подтвердил уже имеющееся доказательство: поле даты открывает нативный picker, календарь доступен в accessibility tree. В текущем in-app browser нет открытой POS-вкладки; единственный слушающий localhost preview относится к AlphaSat/SaaS, поэтому оставлен без изменений. Скриншот страницы не включает OS-native popup. Для завершения пункта нужны штатно разблокированная POS-сессия и средство захвата окна ОС с popup.
- Код, acceptance-строки, скриншоты, тестовые данные и процессы не менялись; PIN не вводился и не обходился, SaaS preview не открывался и не останавливался. #30 остаётся частичным по точно ограниченному визуальному доказательству.

## 2026-10-05 — границы остаточного охвата #48

- MASTER выполнил read-only сверку существующих POS QA. POS role/payment suite уже покрывает shift gate, RBAC, tenant/venue isolation, платежи, inventory depletion, рецепты, replay и конкурентное закрытие; #44/#47 проверяют основные сквозные inventory/POS journeys; receiving suite покрывает purchase UI/API, stale/503 и tenant/role boundaries.
- По остаточному #48 нельзя надёжно выделить один отсутствующий core-сценарий с первичным контрактом и непересекающейся файловой границей. Остаток — широкий набор других маршрутов, UI-состояний и устройств. Новый тест без выбранного маршрута/роли/ошибки создал бы расплывчатое покрытие; #48 оставлен частичным до уточнения конкретного контракта или реального device review.
- Код, матрица, тестовые скрипты и данные не менялись; новых browser/PG suites не запускали.

## 2026-10-05 — согласование итоговой прибыли в отчёте (#34/#21)

- MASTER подтвердил, что прежнее подтверждение владельца относится только к историческому ограниченному scope #34; текущий отчёт прямо говорил, что строка не перепроверялась. Сопоставление с актуальной `FINANCE_MODEL.md` rule 6 и дополнительной матрицей #21 показало: demo/memory без payroll ledger обязаны отдавать payroll, полные расходы, прибыль и cashflow как unavailable/null, `officialReady=false`.
- Статус строки #34 в `FINAL_ACCEPTANCE_REPORT.md` исправлен на `Частично (прежний ограниченный scope исторически принят владельцем)`. В evidence и residual risk сохранено различие между историческим подтверждением и текущим полным финансовым scope; конкретные оставшиеся условия указаны через #21.
- `node scripts/final-acceptance-matrix-contract.mjs` — PASS (34 требования); изменена только строка #34 отчёта и этот журнал. Код, зарплатная реализация, матрица #21, SaaS и production не менялись.
# 2026-10-05 — проверка переполнения количества в техкарте (#16)

- `parseRecipeQuantity` на сервере и его демо-аналог отклоняют бесконечное/неположительное число и переполнение после пересчёта единицы существующей ошибкой `invalid_recipe_quantity`; бизнес-лимит количества не вводился.
- Изолированный authenticated browser/API/PostgreSQL сценарий проверил отказ на POST без записи, отказ PATCH без изменения исходного рецепта, переполнение при пересчёте кг→г и невычислимую стоимость при очень большом конечном количестве. `recipe-cost-breakdown-postgres-browser-qa.mjs` прошёл 90 проверок; runner удалил случайную disposable `inventory_qa_*` базу. Контрольная сумма скриншота после теста восстановлена к исходной.
- Source `portal.js` и публикуемая копия `dist/portal.js` синхронизированы; SHA-256 совпадает. Рецептурный chain contract — 18 checks, parser regression — 18 assertions; acceptance contracts 34/50 и синтаксис обеих копий — PASS.
- Системный архитектор и code-health проверили контракт и diff; права/tenant-проверки не менялись. Остаются отдельные неподтверждённые бизнес-сценарии себестоимости/потерь; #16 остаётся частичным. Production и публикация не затрагивались.

## 2026-10-05 — межмодульная проверка demo payroll fail-closed (#21)

- После синхронизации точных recipe parser/error-label hunks `portal.js` → `dist/portal.js` повторно прошли побайтовая parity-проверка, `payroll-analytics-unavailable-qa.mjs` (ephemeral memory API + demo/DOM VM) и `finance-expense-payroll-status-contract.mjs`. Payroll остаётся `officialReady=false`; неизвестные начисления/прибыль остаются `null`, forged payroll расход запрещён.
- Текущая проверка не выполняла PostgreSQL или production запросов; зарплатный lifecycle, authoritative margin source и самостоятельная venue/date сверка остаются отдельными контрактными задачами.

## 2026-10-05 — #33 ручные расходы и файлы подтверждения

- Добавлен отдельный authenticated browser/API/PostgreSQL сценарий `scripts/acceptance-33-expense-document-postgres-browser-qa.mjs`. На runner-owned disposable DB owner загружает валидный PNG data URL длиннее 500 символов; временный 503 сохраняет поля и файл для retry, повтор создаёт ровно одну запись, полный документ читается из SQL/API, открывается из строки журнала и остаётся доступен после reload. Проверены `finance_read` GET/403 на POST и границы категории/списка двух заведений одной организации.
- Аудит обнаружил, что POST `/api/expenses` обрезал `documentUrl` до 500 символов, а PostgreSQL GET отдавал только snake_case для полей, от которых зависит UI ссылка и дата. Сервер теперь валидирует вложение общей проверкой PNG/JPEG/WebP/PDF до 1,4 МБ, сохраняет data URL полностью и возвращает camelCase aliases `documentUrl`/`expenseDate`/`categoryId`; memory запись также сохраняет ссылку.
- `node scripts/local-full-pg-regression.cjs --check-guards` — PASS; `node scripts/local-full-pg-regression.cjs acceptance-33-expense-document-postgres-browser-qa.mjs` — PASS; disposable DB и lock очищены. `finance-rbac-runtime-qa.mjs`, `finance-expense-payroll-status-contract.mjs`, `node --check` и scoped `git diff --check` — PASS. Первый запуск браузерного suite был остановлен после того, как runner подтвердил отсутствующий Playwright headless binary; повтор с локальным Chrome прошёл. Дополнительных или production БД не использовалось.
- #33 остаётся частично закрытым: этот сценарий подтверждает ручной операционный расход, не все типы файлов, максимальный размер, межорганизационный контроль или полную сверку прибыли/payroll. Отдельные supplier payment attachments покрывает `payables-browser-postgres-qa.mjs`.

## 2026-10-05 — #33 HTTP границы файла и изоляция организаций

- Существующий authenticated browser/API/PostgreSQL сценарий расширен точной проверкой валидного JPEG ровно на лимите 1,400,000 decoded bytes и отказа при 1,400,001 без записи. Оба base64 JSON payload меньше лимита тела запроса сервера 2 MiB; maximum документ сохраняется в PostgreSQL без изменения Data URL.
- Добавлена вторая synthetic организация с собственной точкой, владельцем, категорией и расходом. Через отдельный browser login проверено чтение своего расхода, отсутствие строк/документов первой организации, успешная запись в свою категорию и отказ `400 invalid_finance_category` для чужой категории без побочной записи. FKs, venue/category scope и cleanup охватывают обе организации.
- `node --check scripts/acceptance-33-expense-document-postgres-browser-qa.mjs`, `purchase-document-validation-qa.mjs`, runner `--check-guards` (42 cases), финальный code-health review — PASS. Полный authenticated browser/API/PG runner — PASS; runner завершился с exit 0, одноразовая база удалена в `finally`, lock отсутствует, test/runner Node-процессов не осталось.
- Матрицы исходных #33 и дополнительного #49 обновлены. Форматы/signature и over-limit validation уже проверял отдельный unit suite; новый HTTP сценарий подтверждает exact-max boundary. Production, SaaS, VPS, persistent QA DB, commit и публикация не затрагивались.

## 2026-10-05 — сверка контракта цены закупки (#25)

- Финансовая и QA read-only сверки подтвердили, что текущая цена привязана к единице строки прихода: товар хранит `purchaseUnit` и `packMultiplier`, строка сохраняет исходную цену и пересчитывает себестоимость к складской единице, сумма рассчитывается как `quantity × unitCost` с HALF_UP до копейки. Смена единицы/множителя после сохранения draft блокирует проведение.
- Уже имеющиеся доказательства покрывают точную арифметику/8 прямых единиц и PostgreSQL readback в `acceptance-22-purchase-fields-postgres-qa.mjs`, UI/API/PG сценарий 120 ₽ за пачку с движением 100 г и нормализованной ценой 1,20 ₽/г в `acceptance-44-inventory-crossflow-postgres-browser-qa.mjs`, а также упаковку табака и бутылку алкоголя в `recipe-depletion-pg-runtime-qa.mjs`. Новых тестов и PostgreSQL runner не запускал; новых предположений о бизнес-семантике не вводил.
- #25 в дополнительной матрице уточнён как готовый текущий контракт; отдельная независимая enum-модель цены оставлена вне scope до появления спецификации. В `INVENTORY_IMPLEMENTATION_PLAN.md` отмечено закрытие устаревшего пункта 5, в критерии #50 удалён #25 из локальных partial. Product code, SaaS, VPS, production и базы данных не менялись.

## 2026-10-05 — #33 finance payables view

- `payables-browser-postgres-qa.mjs` дополнен проверкой второго списка тех же purchase documents: две даты и `NULL` сохраняются через API, независимый SQL подтверждает `document_date DESC NULLS LAST`, UI показывает правильный порядок и «Дата накладной не указана», reload сохраняет результат.
- Suite переведён с `territory_qa` на random runner-owned `payables_qa_<16hex>` с tenant fixture, scrypt login, Playwright/Chrome и проверкой parent runner/lock identity. `node scripts/local-full-pg-regression.cjs payables-browser-postgres-qa.mjs` — PASS; cleanup подтвердил отсутствие базы, lock и дочернего server процесса.
- #33 остаётся частичным только по отсутствующим UI-фильтрам даты/статуса и другим несовпадающим спискам; product semantics не менялись.

## 2026-10-05 — authenticated portionCount sale depletion (#16)

- Удалена устаревшая формулировка в `INVENTORY_IMPLEMENTATION_PLAN.md`, которая утверждала, что закрытие заказа не делит партию на POS-порции. Зафиксировано текущее правило: рецепт задаётся на batch; `portionCount` — POS serving count; продажа `q` порций масштабирует ингредиенты и COGS на `q / portionCount`; premix production output отдельно описывается yield.
- В `scripts/recipe-depletion-pg-runtime-qa.mjs` добавлен изолированный synthetic API→PostgreSQL путь: 400 мл по 0,10 ₽/мл, рецепт на 4 порции, затем отдельные закрытые продажи по 1 и 2 порции. Проверено `/api/recipes/:id/cost`, остатки 300→100 мл и immutable COGS 10/20 ₽. Сценарий добавлен после финансовых reconciliation checks, не затрагивая их expected totals.
- Проверки: `node scripts/local-full-pg-regression.cjs recipe-depletion-pg-runtime-qa.mjs` — PASS; cleanup удалил `inventory_qa_4d9aecdcd46f3908`; QA lock отсутствует, дочерних QA/server процессов нет; `node --check scripts/recipe-depletion-pg-runtime-qa.mjs` и scoped `git diff --check` — PASS. Code-health final review — без блокирующих замечаний.
- Обновлены строки #16 в `HOOKAH_POS_ADDITIONAL_ACCEPTANCE.md` и пункт 3 P0 в `INVENTORY_IMPLEMENTATION_PLAN.md`. Потери и прочие крайние бизнес-сценарии остаются в partial; физическое устройство/production не проверялись. Product runtime, SaaS, VPS, production, persistent QA DB, commit и публикация не затрагивались.

## 2026-10-05 — согласованные фильтры накладных и payables (#33)

- Между `server.js`, `db.js`, `portal.js` и `dist/portal.js` добавлены query filters `documentDateFrom`, `documentDateTo`, `includeUndated`, независимый `status` для прихода и `paymentStatus` для payables. Дата берётся только из `document_date`; границы включительные. В заданном диапазоне NULL исключён по умолчанию и включается отдельным checkbox. Списки остаются venue-scoped, параметры SQL bound, payables ограничены проведёнными документами и прежней финансовой формулой. Сортировка дополнена стабильным `id DESC` tie-breaker.
- UI добавил фильтры обеим страницам, сохранение состояния в sessionStorage, Показать/Сбросить, проверку обратного периода, явные ошибки и пересчёт счётчика/остатка в payables по текущему видимому набору. Исправлены гонка устаревшего ответа приходов и очистка старых строк при ошибке фильтра; demo/memory путь для приходов принимает те же query filters. `portal.js`↔`dist/portal.js` и `style.css`↔`dist/style.css` синхронизированы.
- `acceptance-33-purchase-date-order-postgres-browser-qa.mjs`: PASS; inclusive bounds, независимый статус, NULL toggle, invalid/reversed/duplicate params, API→PG, reload/reset, 320/390 px. `payables-browser-postgres-qa.mjs`: PASS; date range + derived payment status, NULL inclusion, validation, UI/reload/reset, мобильный overflow и ранее существующие сценарии оплаты. Оба прогона запускались последовательно через `local-full-pg-regression.cjs`; одноразовые БД удалены, lock отсутствует, процессы завершены.
- Source syntax checks прошли. Финальный code-health review не выявил блокирующих дефектов; замечания о гонке списка приходов и старых строках исправлены. Финальный QA review подтвердил контракт; отдельная review-итерация по responsive/role hardening выполнена локальными тестами. Другие перечни документов проекта пока не входят в #33 acceptance и остаются отдельным покрытием.

## 2026-10-05 — atomic shortage rejection for recipe sale (#16)

- В `scripts/recipe-depletion-pg-runtime-qa.mjs` добавлен synthetic API→PostgreSQL сценарий: техкарта требует 4 л ингредиента при остатке 3 л. Проверяются `409 insufficient_recipe_stock`, структурированный shortage payload с требованием/остатком и отсутствие частичного закрытия заказа, оплаты, COGS и складского движения.
- `node --check scripts/recipe-depletion-pg-runtime-qa.mjs` и `node scripts/local-full-pg-regression.cjs recipe-depletion-pg-runtime-qa.mjs` — PASS (338 assertions). Изначальный runner отказал до создания БД, потому что штатного disposable контейнера не было; запущен только `local-full-qa-setup.cjs --regression-only`, затем тест прошёл на свежей `inventory_qa_*`. БД удалена runner’ом; regression контейнер с anonymous volume остановлен (AutoRemove), lock отсутствует, текущих runner-процессов нет.
- #16 остаётся частичным: порча, потери и другие бизнес-крайние случаи не исчерпаны. Product code, persistent QA DB, SaaS, VPS/production не менялись; commit/publication не выполнялись.

## 2026-10-05 — aggregate repeated ingredient lines (#16)

- В `scripts/recipe-depletion-pg-runtime-qa.mjs` добавлен authenticated API→PG сценарий с двумя строками одного `ingredientId` (30 мл + 20 мл). Подтверждено, что обе строки сохраняются, общая себестоимость равна 5 ₽, а закрытие создаёт ровно одну order-linked складскую проводку на 50 мл.
- `node --check scripts/recipe-depletion-pg-runtime-qa.mjs` и `node scripts/local-full-pg-regression.cjs recipe-depletion-pg-runtime-qa.mjs` — PASS (352 assertions). Одноразовая `inventory_qa_*` удалена runner’ом; regression контейнер с anonymous volume остановлен и удалён через AutoRemove; lock отсутствует, процессы завершены.
- Проверено отдельно, что поведение уже задано API нормализацией/агрегацией; продуктовый код и новые бизнес-правила не добавлялись. #16 остаётся частичным по другим неисчерпанным loss/edge cases.

## 2026-10-05 — shortage on final installment (#16)

- Тот же synthetic заказ с требованием 4 л при остатке 3 л сначала принимает частичную оплату 30 ₽, но отклоняет финальный платёж 60 ₽ с `409 insufficient_recipe_stock`. PostgreSQL подтверждает, что заказ остаётся открытым, прежняя оплата сохранена, а финальная оплата, COGS и списание не появляются; остаток не меняется.
- Финансовая fixture-сверка ожидаемо учитывает эту дополнительную synthetic оплату; независимый прогон `node scripts/local-full-pg-regression.cjs recipe-depletion-pg-runtime-qa.mjs` прошёл (357 assertions). Runner удалил временную `inventory_qa_*`; source-level лог подтверждает PASS.
- #16 остаётся частичным по неисчерпанным loss/edge cases. Продуктовый код и правила бизнеса не менялись; постоянные базы, SaaS, VPS/production не затрагивались.

## 2026-10-05 — premix route role boundaries (#48)

- Read-only audit found the browser/PG crossflow suite verified premix production and batch movements but not the read/write role split. Added 11 assertions to `scripts/acceptance-44-inventory-crossflow-postgres-browser-qa.mjs`: a hookah worker with no inventory scopes receives 403 for batch history/production/count; a manager with `inventory_read` can read the existing batch but receives 403 for production/count.
- `node --check scripts/acceptance-44-inventory-crossflow-postgres-browser-qa.mjs` and `node scripts/local-full-pg-regression.cjs acceptance-44-inventory-crossflow-postgres-browser-qa.mjs` — PASS, 249 assertions. The runner dropped fresh `inventory_qa_*`; lock is absent and the labeled AutoRemove regression container was stopped/removed. Existing suite screenshots remain under `tmp/full-local-qa`.

## 2026-10-05 — aggregate shortage across order items (#16)

- Added a synthetic API→PostgreSQL scenario with two distinct products, each requiring 2 l of the same ingredient. With 3 l available each item would fit alone, while their combined 4 l requirement does not; closing the shared order returns `409 insufficient_recipe_stock` with the aggregate payload and leaves the order open with no payment, COGS or order-linked outbound debit, and no stock-balance change.
- `node --check scripts/recipe-depletion-pg-runtime-qa.mjs` and `node scripts/local-full-pg-regression.cjs recipe-depletion-pg-runtime-qa.mjs` — PASS, 372 assertions. Runner dropped the random `inventory_qa_*`; lock is absent and labeled AutoRemove container was stopped/removed. A before/after movement aggregate assertion confirms the shared ingredient ledger is unchanged.
- Updated #16 matrix evidence. No product code or new depletion policy changed; QA uses only synthetic fixtures.
- Updated #44 and #48 matrix entries. #48 remains partial for other inventory routes and physical Fold; no product code changed.

## 2026-10-05 — auto-order role boundaries (#48)

- Extended the synthetic authenticated browser/API/PostgreSQL #44 suite with auto-order permission checks. A same-venue manager with `inventory_read` can read recommendations and the active request but receives 403 on POST/PATCH; a hookah worker without inventory scopes receives 403 on GET/POST/PATCH. The denied writes use valid item/request IDs, and PostgreSQL pre/post snapshots confirm request count, status, lines and `updated_at` are unchanged.
- Added a second synthetic organization/venue/owner: its GET omits the first venue's low-stock item and active request; PATCH returns canonical `404 auto_order_not_found`; POST with the first venue's item returns `400 auto_order_item_not_found`; no request is created in the foreign venue. The original live request snapshot remains unchanged.
- Added a sibling venue under the original organization with its own owner/session. It also cannot read the first venue's low-stock item/request; PATCH returns `404 auto_order_not_found`; POST using the source venue's item returns `400 auto_order_item_not_found`; no sibling request is created. The original request snapshot remains unchanged after both tenant and sibling-venue probes.
- `node --check scripts/acceptance-44-inventory-crossflow-postgres-browser-qa.mjs` and `node scripts/local-full-pg-regression.cjs acceptance-44-inventory-crossflow-postgres-browser-qa.mjs` — PASS (283 assertions). Runner dropped random `inventory_qa_*`; lock/process and the verified runner-owned AutoRemove container are absent after cleanup. System architecture, QA and final code-health reviews found no blocker.
- #48 remains partial for other inventory routes and physical Fold/device coverage. Product code and business semantics were not changed.

## 2026-10-05 — inventory item and movement role boundaries (#48)

- Extended the synthetic authenticated browser/API/PostgreSQL #44 suite for `/api/inventory`: `inventory_read` can read its venue catalogue and movement journal but cannot create, rename, archive items or post stock movements; a user without inventory scopes receives 403 for GET and all writes. Foreign-organization and sibling-venue owners cannot see source items or their movement history; item PATCH/DELETE return canonical 404, and movement POST cannot create a foreign-venue ledger row.
- PostgreSQL before/after snapshots now include source item name, `is_marked`, minimum stock, item/venue counts, source movement count and balance, and destination movement counts. Authorized synthetic POSTs for a second organization and a sibling venue create `minLevel:1` items, reload their inventories, and positively verify their own item and low-stock results while excluding the source; each returned ID resolves to exactly one PG row under that session's `venueId`. The primary read-only manager also positively sees its own low-stock fixture.
- `node --check scripts/acceptance-44-inventory-crossflow-postgres-browser-qa.mjs` and the disposable PG browser runner passed (335 assertions). Runner dropped fresh `inventory_qa_*`; no product source was changed.
- Updated acceptance matrix #44/#48. #48 remains partial for other inventory routes and physical Fold/device coverage; production and persistent databases remain untouched.

## 2026-10-05 — recipe-card role and venue boundaries (#48)

- Extended the existing synthetic authenticated browser/API/PostgreSQL #44 suite to verify `/api/recipes`: a manager with only `inventory_read` can list recipes and read costing but gets 403 for create/update/archive; a hookah worker without inventory scopes gets 403 for list, cost and all writes.
- Foreign-organization and same-organization sibling-venue owners cannot see source recipes; cost/PATCH/DELETE return canonical `404 recipe_not_found`, and creating a recipe with a source-venue ingredient returns `400 recipe_ingredient_not_found`. Before/after PostgreSQL snapshots verify source recipe fields, active state, `updated_at`, per-venue counts, and source ingredient movement counts/balances are unchanged by denied operations.
- With a destination-owned ingredient and a source-venue `productId`, recipe POST returns `400 recipe_product_not_found`; before/after PostgreSQL ledger snapshots confirm no source ingredient movement or balance changed.
- Positive controls create a recipe from each destination venue's own synthetic ingredient, verify its exact `venue_id` in PostgreSQL, reload the recipe list, confirm the local recipe is present, and confirm both source recipes remain absent. Architecture, code-health, QA and security reviews found no blocker.
- `node --check scripts/acceptance-44-inventory-crossflow-postgres-browser-qa.mjs` and the allowlisted disposable PG browser suite passed (395 assertions). The runner removed the fresh `inventory_qa_*`; its verified AutoRemove regression container was stopped and removed. Updated matrix #44/#48; other inventory routes and physical Fold remain partial. Product code, SaaS, production and persistent QA DB were not changed.

## 2026-10-05 — приемка поставки: роли, tenant и себестоимость (#48)

- Расширил существующий synthetic authenticated browser/API/PostgreSQL сценарий #44 проверками `POST /api/inventory/supplies`. `inventory_read` и роль без складских scopes получают 403 с `permission: inventory`; foreign-organization и sibling venue не могут принять поставку на source item (400 `invalid_supply_unit`). До/после PG snapshots подтверждают неизменность остатка, себестоимости и числа движений в исходном и целевых заведениях.
- Для двух собственных venue fixtures проверена настоящая поставка: открывающая запись 5 мл при себестоимости 2 ₽/мл, затем 2 л по 120 ₽/л. API и PostgreSQL подтверждают конверсию 2000 мл, итоговый остаток 2005 мл и средневзвешенную цену 0,1247 ₽/мл; движение привязано к item и venue, свежий GET показывает баланс, цену и движение.
- `node --check scripts/acceptance-44-inventory-crossflow-postgres-browser-qa.mjs` — PASS. Один allowlisted disposable PG browser runner завершился PASS с 455 assertions; база `inventory_qa_0b2f491928bb2cc0` удалена, проверенный runner-owned AutoRemove контейнер остановлен/удалён, lock отсутствует. System architecture, code-health и warehouse-domain review не обнаружили блокеров.
- Обновлены #44/#48 в матрице. #48 остаётся частичным для остальных inventory-маршрутов и физического Fold/device QA. Product code, SaaS, production и persistent QA DB не менялись.

## 2026-10-05 — PostgreSQL workflow запросов на удаление складской категории (#48)

- В существующем authenticated browser/API/PostgreSQL acceptance #44 добавлен изолированный unused category fixture: category-only manager архивирует её, создаёт pending request, повторный запрос получает 409. Проверены visibility правила списка (владелец и создатель видят запрос; другой manager, foreign organization и sibling venue — нет), запреты по scope, а cross-venue approve и direct-delete не меняют source category/request.
- Владелец выполняет прямое окончательное удаление архивированной категории с ожидающей заявкой. PostgreSQL подтверждает удалённую category row и сохранённую request row в `rejected` с `decided_by`, именем и timestamp; повторное решение закрытой заявки получает 404. Отдельный same-venue контроль также проверяет успешный endpoint `/approve`: category удалена в той же транзакции, request сохраняется как `approved` с actor/time, повторное решение даёт 404.
- `node --check scripts/acceptance-44-inventory-crossflow-postgres-browser-qa.mjs` — PASS. Allowlisted disposable PostgreSQL browser runner — PASS, 515 assertions; база `inventory_qa_a791640fb5f18dbc` удалена, verified runner-owned AutoRemove container stopped/removed, lock отсутствует. Архитектурный baseline, security review и final code-health review не выявили блокеров.
- Обновлены #44/#48. Остальные inventory endpoints и физический Fold/device review остаются вне этой частичной приёмки. Product code, SaaS, production и persistent QA DB не менялись.

## 2026-10-05 — fail-closed сверка старых оплат в сторно прихода (#27)

- Финансовый/архитектурный аудит выявил, что старые `expenses.source='purchase'` без `purchase_document_id` не позволяют доказать неоплаченность накладной; также критерий «закрытый период» был шире фактической проверки наличия смены. Выбран безопасный режим: сохранённые несвязанные строки блокируют сторно заведения до ручной сверки, новые несвязанные `source='purchase'` платежи отклоняются API и DB trigger. Общий расход `source='manual'` не доказывает оплату конкретной накладной, поэтому UI направляет оплату поставщику в связанный payable flow. Сторно требует ровно одну открытую смену; отдельного календарного period-lock в модели нет, и acceptance больше не заявляет его.
- В `migrations/097_purchase_document_reversals.sql` добавлены partial index и trigger приёма только связанных закупочных расходов; `db.js` проверяет исторические несвязанные строки под `FOR KEY SHARE` и fail-closed, `server.js` возвращает для этого конфликта 409, UI объясняет блокировку и сохраняет различие версий правила старых/новых приходов. `portal.js` и `dist/portal.js` синхронизированы. Обновлены статический контракт, `FINANCE_MODEL.md`, decision #27 и строка #27 дополнительной матрицы.
- Проверки: `node --check` для db/server/portal/API QA; `scripts/purchase-reversal-contract.mjs` PASS; `git diff --check` по scoped product/tests/docs PASS (в общем `WORK_LOG.md` уже есть несвязанные исторические trailing spaces, не переформатированы); authenticated API/PostgreSQL #27 — PASS (84 assertions); authenticated browser/API/PostgreSQL #27 — PASS (22 assertions, включая текст инструкции оплаты). Оба теста прогнаны последовательно на runner-owned disposable PostgreSQL; случайные `inventory_qa_*` БД удалены, runner-owned AutoRemove контейнер остановлен и удалён, QA lock отсутствует. Source/dist SHA-256 совпадает.
- Код, docs и фактический ответ сервера теперь совпадают по legacy payment coverage и open-shift gate. Проверка физического Galaxy Z Fold не выполнялась; SaaS, VPS, production и постоянная QA БД не затрагивались.

## 2026-10-05 — authenticated department boundaries (#48)

- Read-only архитектурный аудит подтвердил, что существующий `venue-inventory-departments-postgres-qa.mjs` подменял права обработчика и не проверял реальную auth/session границу для `PATCH`/`DELETE /api/inventory/departments/:code`. Отдельный authenticated API/PG suite добавлен новым файлом; активно изменявшийся browser suite #44 не редактировался.
- Синтетические owner, `inventory` manager, `inventory_read` manager, bartender, sibling-venue owner и foreign-organization owner проходят обычный login. Inventory manager выполнил переименование и отдельную архивацию, owner создал и архивировал основной тестовый цех; свежий readback подтверждён через API и PostgreSQL. Проверены права на запись/отказ, отсутствие сессии, скрытие списка и canonical 404 для чужой площадки/организации, неизменность строки цеха после отказов и повторный PATCH/DELETE по архивной записи.
- `node --check` для нового suite и runner, `node scripts/local-full-pg-regression.cjs --check-guards` — PASS (42 cases); authenticated disposable PostgreSQL suite — PASS (60 assertions). Suite matches `LOCAL_FULL_PG_OWNED_DATABASE`, requires the verified container and checks the database server IP against it; runner подтвердил отсутствие оставшихся `orders_qa_*`/`inventory_qa_*` баз, остановлен и удалил только контейнер с ожидаемой QA-меткой/образом/loopback-портом; lock отсутствует. Обновлены #48–#50 и формулировка незакрытого scope #27 (узкая v1 против неподдержанных paid/used/refund/period сценариев) в `HOOKAH_POS_ADDITIONAL_ACCEPTANCE.md`.
- Код приложения и бизнес-правила не менялись. #48 остаётся частичным по другим inventory routes и физическому Fold/device review; SaaS, VPS, production, постоянная QA БД, commit и публикация не затрагивались.

## 2026-10-05 — гонка закрытия продажи и ручного списания (#16)

- Архитектурный и QA аудиты подтвердили независимый остаточный риск: оба authenticated PostgreSQL пути блокируют одну строку ингредиента и сверяют сумму движений, но прежние тесты не сталкивали закрытие продажи с ручным `POST /api/inventory/movements`. Добавлен отдельный `scripts/recipe-sale-manual-movement-race-postgres-qa.mjs`, продуктовые маршруты и текущие чужие тестовые файлы не менялись.
- Два synthetic fixtures с запасом 100 мл по 0,50 ₽/мл запускают закрытие заказа с рецептурным расходом 60 мл одновременно с ручным расходом 60 мл; порядок запуска инвертирован, победитель не фиксируется. Проверяются один commit/один соответствующий 409, остаток 40 мл, одна out-проводка с правильным владением (`order_id` для продажи либо отдельное ручное движение), статус заказа и атомарность COGS 30 ₽/оплаты с закрытием.
- Добавлен новый файл в явный allowlist `scripts/local-full-pg-regression.cjs` с созданием runner-owned случайной disposable `inventory_qa_*` БД. Скрипт закреплён за точными loopback host/port и учётными данными из runtime config, проверяет inspected container и live PostgreSQL IP/port через `isDisposableLoopbackQaContainer`, а также дожидается завершения дочернего сервера до закрытия соединения. Независимая архитектурная проверка, QA review и итоговый code-health review — без замечаний.
- Проверки: `node --check` нового suite и runner — PASS; `local-full-pg-regression.cjs --check-guards` — PASS (42 cases); `local-full-qa-setup.cjs --check-guards` — PASS (30 cases); `git diff --check` по матрице/runner — PASS. Disposable suite — PASS, 34 API/PG assertions; runner удалил `inventory_qa_eae546bab696188b`, затем проверены отсутствие lock и точная конфигурация regression container; disposable AutoRemove контейнер остановлен/удалён. Обновлены строки #16/#49. Изменений application runtime, SaaS, persistent QA DB, VPS, production, commit или публикации нет.

## 2026-10-06 — восстановление подцеха с реальными auth/tenant границами (#48)

- Пробел локализован в `POST /api/inventory/subdepartments/:id/restore`: прежние тесты покрывали создание/редактирование/архивирование, но не имели проверки реального login/session для восстановления; route extraction и mock pool не доказывали tenant/role и persisted readback. Добавлен независимый `scripts/acceptance-48-inventory-subdepartment-restore-postgres-qa.mjs`; существующие browser suites и product runtime не редактировались.
- Синтетические owner, inventory-write manager, inventory-read manager, bartender, sibling venue owner и foreign organization owner аутентифицируются обычным login. Проверены успешное manager restore, одна restore audit запись, same-venue active/archived list и PostgreSQL readback; no-session 401, read-only/bartender 403, sibling/foreign/missing/already-active 404, неверный ID 400, inactive-parent 409. Все отказные пути оставляют запись архивной и не пишут restore audit.
- Новый suite включён в явный `orders_qa_<random>` runner путь. Он требует runner PID/lock, точные runtime loopback credentials/port, inspected disposable container и совпадение live PostgreSQL адреса/порта с одноразовым контейнером; ждёт завершения дочернего сервера перед закрытием клиента. Архитектурный contract и code-health/security reviews завершены без блокеров.
- Проверки: `node --check` нового suite/runner и `node scripts/local-full-pg-regression.cjs --check-guards` — PASS; disposable PostgreSQL runner — PASS, 34 authenticated API/PG assertions. Runner подтвердил удаление случайной `orders_qa_*` базы; `--guard` PASS; lock отсутствует; AutoRemove regression container с anonymous volume/loopback bind после проверки остановлен и удалён. Обновлён верхний evidence section в `HOOKAH_POS_ADDITIONAL_ACCEPTANCE.md`; точечное изменение приложения, SaaS, persistent QA DB, VPS, production, commit или публикация не выполнялись.

## 2026-10-06 — authenticated subdepartment lifecycle (#48)

- Закрыт отдельный пробел между extraction/mock тестами и реальной auth/session проверкой обычных маршрутов подцехов. Существующий `scripts/acceptance-48-inventory-subdepartment-restore-postgres-qa.mjs` расширен на настоящий HTTP/API→PostgreSQL create, duplicate/parent validation, rename/reparent, archive, restore, roles и venue/org isolation; новые suites и runner wiring не создавались.
- Подтверждено, что успешный rename/reparent сохраняет подцех, обновляет связанный `product_categories.department` и текстовую иерархию `ingredients`, а после GET результат перечитывается под тем же заведением. Используемый category/item подцех остаётся активным при отказе archive; пустой подцех архивируется и переходит из active в archived list. Успешные create/update/archive/restore пишут по одной audit-записи; неавторизованные, read-only, bartender, sibling/foreign, inactive-parent и replay отказы не создают побочных изменений.
- Проверки: `node --check scripts/acceptance-48-inventory-subdepartment-restore-postgres-qa.mjs`, runner `--check-guards` (42 cases) и финальный authenticated PostgreSQL runner — PASS (105 API/PG checks). Только runner-owned random `orders_qa_*`; независимый запрос подтвердил отсутствие `orders_qa_*`/`inventory_qa_*`, `--guard` PASS, lock отсутствует, exact AutoRemove regression container с loopback binding остановлен и удалён. QA review и финальный code-health review — PASS.
- Обновлён evidence section матрицы #48. `server.js`, DB schema/migrations, SaaS, VPS, production, persistent QA DB, commit и публикация не затрагивались. #48 остаётся частичным по остальным inventory-маршрутам и физическому Fold/device; независимый следующий кандидат — authenticated `POST /api/inventory/departments/:code/restore`.

## 2026-10-06 — parent department restore coverage (#48, partial)

- Добавлены проверки в существующий `scripts/acceptance-48-inventory-department-boundaries-postgres-qa.mjs` для реального `POST /api/inventory/departments/:code/restore`: no-session/read-only/bartender отказ, sibling/foreign/missing/already-active 404, manager success, venue DB и active/archived list readback, повторный запрос без второй audit-записи. Асинхронный audit опрашивается с ограниченным ожиданием и ищется по `after_data.code`, так как department code не UUID.
- `node --check scripts/acceptance-48-inventory-department-boundaries-postgres-qa.mjs`, runner `--check-guards` (42 cases) и authenticated API/PG suite — PASS (87 assertions). Для прогона штатно создан только disposable контейнер в `--regression-only`; runner удалил random `orders_qa_*` database и lock, после отдельной проверки ownership остановлен только контейнер `hookah-full-regression-qa-20261001` с `AutoRemove`, который удалился сам. Лишних QA баз, контейнера и lock после прогона нет. Code-health и QA reviews — PASS.
- Изменён только QA suite и evidence в матрице/журнале; `server.js`, schema/migrations, SaaS, VPS, production и persistent QA DB не затрагивались. #48 остаётся partial для иных inventory-маршрутов и физического Fold/device.

## 2026-10-06 — department create auth and tenant boundaries (#48)

- Расширен тот же authenticated API/PG suite для `POST /api/inventory/departments`. Без сессии ожидание 401, `inventory_read` и bartender получают 403; для каждой попытки подтверждены отсутствие строки во всех трёх заведениях и нулевой audit.
- Positive controls для sibling-venue owner и foreign-organization owner проверяют 201, точную запись только в target venue, её видимость в списке владельца и невидимость/отсутствие данных и audit во всех остальных заведениях. Существующий owner A1 create дополнительно получил точный PostgreSQL readback и async-polled audit.
- `node --check`, runner `--check-guards` (42 cases), disposable authenticated API/PG suite — PASS (141 assertions). Отчётный счётчик соответствует отдельным assertions. Code-health и QA reviews — PASS. Runner создал/удалил случайную `orders_qa_*`; перед остановкой проверены label/image/AutoRemove/anonymous volume/loopback 31931; контейнер auto-removed, lock отсутствует, никаких постоянных QA БД не осталось.
- Изменены только тестовый сценарий и acceptance evidence. Product runtime/API/schema не менялись. #48 остаётся partial по другим маршрутам, полноте browser role/tenant/error coverage и физическому Fold/device.


## 2026-10-06 — backend date error and retry states on mobile (#30)

- В authenticated browser/PG сценарии приходов зафиксированы два реальных состояния: невозможная дата `2026-02-30` получает backend 400 `invalid_purchase_document`, inline error видим, дата и остальные значения формы остаются, controls активны; API/PG не содержат отклонённый документ, движения/остаток не меняются. На 320 и 390 px проверяются границы сообщения и отсутствие горизонтального overflow. QA сохраняет отдельные снимки error text и date value на каждом размере; визуальный просмотр подтвердил читаемость.
- Проверка GET 503 выявила ложное сообщение «Документов пока нет». UI теперь очищает устаревшие строки и показывает alert; кнопка «Показать» повторяет GET, восстанавливает черновик без reload и сбрасывает роль сообщения к status. Source и dist изменения совпадают.
- Проверки: `node scripts/local-full-pg-regression.cjs inventory-receiving-mobile-postgres-browser-qa.mjs` — PASS, 262 checks; disposable `inventory_qa_d0fcdcbd3c995738` удалена runner’ом; lock отсутствует. Code-health и QA final review — PASS. Снимки: `docs/ai-team/responsive-emulator/inventory-receiving-invalid-date-error-{320,390}.png`, `inventory-receiving-invalid-date-value-{320,390}.png`. #30 остаётся partial только по отсутствующему screenshot нативного picker popup; настоящее устройство Fold отдельно не проверялось.


## 2026-10-06 — authenticated date filters and stale response coverage (#33)

- Проверен handoff из существующего чата: suite создаёт через authenticated UI три датированных/недатированных draft и один posted документ. UI, свежий API и PostgreSQL сходятся по `document_date DESC NULLS LAST`; `documentDate` у недатированного документа остаётся JSON/SQL NULL, а `recordedAt` подтверждён отдельно. Тест проверяет границы даты включительно, независимый status filter, явное включение NULL, ошибочные фильтры 400, reload/reset и mobile 320/390 px. При задержанном старом GET поздний ответ не перезаписывает новый результат.
- Проверил runner: suite находится в allowlist, использует случайную `inventory_qa_*` БД, проверяет parent runner и lock identity, задаёт только runner-owned database URL и требует Playwright. Результат сохранён в runner log: PASS, 95 assertions; disposable DB удалена, lock отсутствует. Перед завершением локального цикла runner-owned AutoRemove контейнер остановлен и удалён.
- `node --check` и runner guards (42 cases) PASS; отдельный code-health review и QA review — PASS. В матрице #33 закреплены 95 checks и граница остаточного partial: другие списки документов. Product runtime/API, SaaS, VPS, production и persistent QA DB не менялись.


## 2026-10-06 — authenticated inventory item edit readback (#48)

- В существующий `scripts/acceptance-44-inventory-crossflow-postgres-browser-qa.mjs` добавлен отдельный synthetic item edit flow: UI PATCH по имени, результат после app refresh и полного browser reload, повторное открытие формы с сохранённым prefill, свежий inventory API и точный PostgreSQL readback. Сравниваются onHand, полный movement JSON, cost и venue COGS rows/total до и после; synthetic ингредиенты ремиксов и автозаказный fixture не изменяются.
- `node --check` и `git diff --check` — PASS; allowlisted `node scripts/local-full-pg-regression.cjs acceptance-44-inventory-crossflow-postgres-browser-qa.mjs` — PASS (541 assertions). QA review и code-health baseline/final — PASS. Runner удалил `inventory_qa_b05ec8addcbdce5f`; независимый DB запрос вернул 0 оставшихся `inventory_qa_*`; lock отсутствует. Проверен exact label/image/loopback binding/AutoRemove/anonymous volume; disposable regression container штатно остановлен и auto-removed.
- Обновлены #44/#48/#49/#50 в `HOOKAH_POS_ADDITIONAL_ACCEPTANCE.md`; #48 остаётся partial по другим inventory маршрутам и физическому Fold/device. Менялся только QA script и acceptance evidence; продуктовый код, схема/миграции, общий runner, SaaS, VPS, production, persistent QA DB, commit и публикация не затрагивались.


## 2026-10-06 — authenticated inventory directory browser flow (#48)

- В existing #44 authenticated browser suite добавлено создание synthetic подцеха в цехе «Бар», затем категории, связанной с ним. Проверяются реальные UI POST, точные payload/response, отображение цеха/подцеха/категории после reload, свежие API записи и SQL связи в одном random synthetic venue. Базовые/итоговые snapshots подтверждают ровно +1 subdepartment/+1 category и неизменность stock movements, order-cost rows и COGS sum. Lifecycle/archive не повторяются: они уже покрыты API/PG suite.
- Первый прогон выявил только отличие форматирования: `displayName` title-cases названия. QA expectation нормализует регистр, сохраняя проверку пути; SQL получил отдельный alias для department code подцеха. Product UI/API/schema не менялись. Независимый code-health и QA review — PASS.
- Полный `acceptance-44-inventory-crossflow-postgres-browser-qa.mjs` через regression-only runner — PASS (564 assertions); disposable БД `inventory_qa_c4386a1cee248e3f` удалена. Независимый запрос подтвердил 0 `inventory_qa_*`, lock отсутствует; exact runner container проверен как `postgres:16-alpine`, AutoRemove, без bind mounts, loopback 31931 и anonymous volume, после чего остановлен/удалён. `node --check`, runner guards (42 cases) PASS.
- Обновлены #44/#48/#49/#50 в матрице. #48 остаётся partial по другим inventory маршрутам, широкой UI role/tenant/error матрице и физическому Fold/device. Без SaaS/VPS/production/persistent QA DB, commit и публикации.


## 2026-10-06 — authenticated category edit preserves hierarchy (#48)

- В существующем #44 synthetic directory flow переименована созданная в браузере категория, связанная с synthetic подцехом. Проверяются prefill ID/name/department/subdepartment, реальный `PATCH /api/product-categories/:id` и точный payload/ответ, UI parent path после сохранения и полной перезагрузки, fresh API и venue-scoped PostgreSQL сохранность родительской связи.
- До момента PATCH категория не имеет linked inventory items. Сравнение scoped venue hierarchy/movement/COGS snapshots подтверждает отсутствие изменений количеств записей, stock movements и суммы/числа COGS. Продуктовый код/runner/schema не менялись. Code-health и QA reviews — PASS.
- Финальный `acceptance-44-inventory-crossflow-postgres-browser-qa.mjs` — PASS (577 assertions); disposable `inventory_qa_63d03bb68768ebd6` удалена, независимый запрос подтвердил 0 `inventory_qa_*`, lock снят. Regression-only контейнер с loopback 31931/AutoRemove/anonymous volume проверен и остановлен/удалён. `node --check`, runner guards (42 cases) — PASS. Матрица #44/#48/#49/#50 обновлена. #48 остаётся partial по другим маршрутам, широкой UI role/tenant/error матрице и физическому Fold/device.


## 2026-10-06 — inventory subdepartment reparent stays in sync (#48)

- Read-only review нашёл, что успешный UI PATCH подцеха обновлял только список подцехов; связанная категория сохраняла старый breadcrumb до полной перезагрузки. После сохранения форма теперь последовательно перечитывает подцехи и категории в `portal.js` и `dist/portal.js`, чтобы сразу обновить обе стороны иерархии.
- В существующий #44 authenticated browser/PG flow добавлена проверка prefill родителя, точного PATCH, refresh API payloads, немедленных breadcrumb у подцеха/категории, полного reload, venue-scoped PG join и неизменности stock movements/COGS. Runtime source/dist SHA-256 совпадает; code-health baseline/final и независимый QA criteria review — PASS.
- `node --check` трёх затронутых JS/MJS файлов и `git diff --check` — PASS. Regression browser/PG suite — PASS (596 assertions). Disposable `inventory_qa_fbcc3d4b08b4a3a2` удалена, независимый запрос вернул 0 `inventory_qa_*`, runner lock отсутствует; exact `postgres:16-alpine` runner container с label, AutoRemove, anonymous volume и loopback 31931 проверен, остановлен и auto-removed.
- Матрица #44/#48/#49/#50 обновлена. #48 остаётся partial по другим складским маршрутам, полной browser role/tenant/error матрице и физическому Fold/device. SaaS, VPS, production, persistent QA DB, commit и публикация не затрагивались.

## 2026-10-06 — read-only inventory directories are visible (#48)

- Authenticated browser/PG coverage found that a manager with only `inventory_read` could open `/inventory?view=directories`, but the actual department/subdepartment/category panel was nested inside the write-only catalog render guard. Moved only the directory-panel branch into its own `canWriteInventory || inventory_read || inventory_categories` guard; the tobacco/alcohol write catalogs remain inside the write guard. Existing API read/write rules and the directory editor/lifecycle guards remain unchanged; hidden forms stay present for existing handlers, while read-only header and row mutation controls remain absent.
- Extended the existing #44 synthetic same-venue manager scenario: verify the category/subdepartment after reparent, visible list hierarchy, no create/edit/archive/restore/delete/request controls, successful read-only HTTP/API loads, no browser writes/errors, and unchanged scoped hierarchy, stock movement and COGS snapshots. Code-health baseline/final and independent QA contract reviews passed; reviewer confirmed the role contract and found no remaining gap within this route.
- `node --check portal.js`, `node --check dist/portal.js`, `node --check scripts/acceptance-44-inventory-crossflow-postgres-browser-qa.mjs` — PASS; source/dist SHA-256 parity — PASS; runner guards — PASS (42 cases); full browser/PG suite — PASS (614 assertions). Runner cleanup dropped its disposable DB; a leftover runner-created `inventory_qa_*` database with zero sessions was also removed after checking its exact random name and synthetic owner; final inventory QA DB count is zero, lock absent. Exact anonymous-volume AutoRemove regression container was stopped and auto-removed.
- Обновлены #44/#48 в матрице приёмки. Остальные маршруты, широкая role/tenant/error browser-матрица и физический Fold/device review остаются partial; production/SaaS/VPS/persistent QA DB, commit и публикация не затрагивались.
## 2026-10-06 — обновлён локальный контракт пользовательских ролей

- `scripts/local-role-contract.mjs` проверял устаревшую подпись профиля доступа, которой уже нет в карточке сотрудника. Проверка сохранена по API `/api/staff/roles`, но текстовое условие приведено к актуальному пояснению области роли для текущей точки; API и fail-visible проверки не ослаблены.
- `node scripts/local-role-contract.mjs` — PASS (9 role profiles); `node --check scripts/local-role-contract.mjs` и `git diff --check -- scripts/local-role-contract.mjs` — PASS. Изменён только контрактный QA-файл; продуктовый код не менялся.

## 2026-10-06 — сверка счётчика acceptance #44

- В строке #49 матрицы исправлен устаревший счётчик #44: 596 → 614, в соответствии с актуальными строками #44/#48/#50. Проверено, что замена ровно одна и `git diff --check` для матрицы проходит.

## 2026-10-06 — миграционный acceptance учитывает неизменяемые версии политики сторно

- После миграции 097 миграционный тест пытался физически удалить venue, хотя FK immutable policy intentionally RESTRICT; штатный venue lifecycle — обратный archive. Схему и guards не ослабляли. В `scripts/migrations-pg-upgrade-qa.mjs` тест теперь ожидает `23503` на hard-delete, сверяет сохранность venue, всех двух promotion versions, scope/settings и версии политики, а archive подтверждает без удаления истории.
- `node scripts/local-full-pg-regression.cjs --check-guards` — PASS (42 cases). Исправленный `migrations-pg-upgrade-qa.mjs` через тот же runner — PASS; он проверил 77 базовых файлов миграций и повторно применил 59 файлов (версии 039–076 входят в обе группы) в изолированной схеме и откатил её транзакцией. Disposable random schema/runner lock очищены. Матрица #49 дополнена соответствующим миграционным покрытием. Схема, сервер, SaaS, persistent QA DB, VPS и production не менялись.

## 2026-10-06 — выравнивание подписей персонала и восстановление локального static acceptance

- Заголовок верхней панели `/admin#staff` приведён к каноническому «Персонал» в `portal.js` и `dist/portal.js`; URL, `staff_view` и логика страницы не менялись. В форме назначения роли кнопка сохранения теперь явно `type="submit"`; отмена уже имела `type="button"`. Архитектурная и QA-сверки подтвердили отсутствие изменений маршрутов/прав и паритет исходника с dist.
- Исправлены только устаревшие static-контракты/синтетические фикстуры, выявленные полным прогоном: selector блоков KPI, поля операций category_id/archived table, поддержка добавленных полей/зависимостей DOM-харнесса, актуальные read-only/payload/лейбл-контракты и даты партий относительно времени запуска. Продуктовая логика этими тестовыми правками не изменялась.
- `node scripts/local-full-qa.mjs --static` — PASS (135/135); целевые контракты кнопки, заголовка, платежей и модального accessibility пройдены; `portal.js` и `dist/portal.js` побайтно совпадают. Browser E2E этих двух точечных UI изменений отдельно не запускался. Production/SaaS/VPS и постоянная QA-база не затрагивались.

## 2026-10-07 — автоматический визуальный проход страниц

- Цикл аудита запущен: для каждого канонического маршрута фиксируются desktop/Fold состояния, затем формируется мини-промпт правок и повторная проверка.
- В текущем проходе визуально проверены `/admin#tasks`, `/inventory`, `/finance`, `/orders`, `/clients`, `/reservations`, `/delivery`, `/integrations`, `/network` в Edge на VPS.
- `/admin#tasks` исправлен в коммите `2e2df72`: компактная панель фильтров, выравнивание карточки и действий, адаптивная раскладка колонок; VPS health check проходит.
- В остальных проверенных страницах подтверждены единый каркас, выравнивание основных панелей и отсутствие явного горизонтального переполнения на desktop. Для каждого экрана продолжается отдельная Fold/mobile проверка.

## 2026-10-07 — журнал заказов на Fold

- Снимок Fold `orders-fold-main-768.png` показал, что семиколоночная таблица на ширине 768px ломала номер заказа, стол и дату переносами.
- Добавлено адаптивное представление строк карточками для диапазона 760–900px; поля получают подписи, кнопка действия занимает отдельную строку.
- Синхронизированы `style.css` и `dist/style.css`; commit `43aff80`, VPS обновлён, `/api/health` — PASS. Desktop после публикации проверен в Edge.

## 2026-10-07 — branch integration audit started
- Зафиксирован промпт интеграции: `docs/ai-team/BRANCH_INTEGRATION_PROMPT.md`.
- База публикации: `origin/codex/current-release` (VPS сейчас на `d8d2a786`).
- Параллельная ветка `codex/hookah-crm-full-audit-2026-09-29` содержит функциональный пакет ролей/прав, персонала, финансов, лояльности и визуальные исправления; прямое переносение отдельных role-коммитов конфликтует в `portal.js`, `style.css`, `server.js`.
- Создана безопасная временная ветка `codex/integration-audit-20261007` в worktree `HOOKAH CRM 2-integration-audit`. Полная интеграция staged, конфликтные CSS/portal участки сведены, сохранены custom role/permissions workspace и Fold/compact visual patches.
- Проверки: `node --check portal.js`, `node --check server.js` проходят; исходные ветки и release worktree не изменены. Ветка не опубликована и не развернута до browser QA ролей, finance/payroll и существующих tenant/role сценариев.
- Следующий этап: поднять интеграционный кандидат в изолированном окружении, проверить `/admin#permissions`, `/admin#staff`, финансы и мобильные/Fold страницы, затем только после успешного QA продвинуть release.
- Контрактная проверка кандидата: `header-shell-contract` PASS; `inventory-hierarchy-contract` сначала выявил отсутствующее пояснение категорий, исправлено в кандидате commit `64295565`, повторная проверка PASS.
- Дополнительные контракты интеграционного кандидата: `local-role-contract` PASS после унификации текста «Профиль доступа для текущей точки`; `payroll-scheme-ui-contract` PASS после восстановления подключения и cache-sync `payroll-scheme-ui.js`.
- Выявленный риск интеграции: payroll UI asset присутствовал в ветке, но не был подключён статически и не обновлялся publish-sync; исправлено в candidate commits `67c01f47`, `9ae81378`, `4e5cdfb1`.
- `git diff --check` кандидата очищен от лишних пустых строк; после нормализации окончаний файлов ошибок whitespace нет.

## 2026-10-07 — integration candidate deployed and browser verified
- Первый запуск кандидата выявил неполный Dockerfile: отсутствовали `loyalty-memory-reconciliation.js`, затем `payroll-venue-turnover-source.js`. Рабочий VPS checkout был восстановлен и проверен: CRM/PostgreSQL healthy.
- Dockerfile исправлен, ветка `codex/integration-audit-20261007` обновлена до `1dc099ad`; candidate checkout `/root/hookah-pos-release-4e5cdfb1` пересобран.
- VPS health: `{"status":"ok","service":"hookah-pos","database":"postgres"}`; CRM, DB и nginx healthy.
- Browser QA с cache-bust: `/admin#permissions` теперь показывает рабочий блок «Пользовательские роли», профиль доступа и системные роли. Визуальный дефект слитых строк исправлен CSS: название, описание, число сотрудников и доступы разделены по строкам; кнопки выровнены.
- Важное ограничение: это ручной повторный запуск build/up после того, как штатный `deploy-vps.sh` упёрся в несовместимую команду `docker compose`/`docker-compose` на VPS. Состояние контейнеров и health подтверждены отдельно; полноценный backup label из штатного скрипта требует отдельной доработки совместимости compose-команды перед следующим релизом.

## 2026-10-07 — canonical release alignment
- Единым каноническим SHA выбран `1dc099ad` (`codex/integration-audit-20261007`).
- GitHub: `codex/current-release` и `main` указывают на `1dc099ad`.
- VPS checkout `/root/hookah-pos-release-4e5cdfb1` указывает на `1dc099ad`; CRM/PostgreSQL health PASS.
- Локальный release worktree `HOOKAH CRM 2-release` переключён на `codex/current-release` и тот же SHA.
- Старые указатели сохранены: `codex/current-release-legacy-20261007`, `main-legacy-20261007`, tag `integration-pre-canonical-20261007`.
- Browser runtime menu audit: 27 пунктов/маршрутов присутствуют, включая персонал, роли, задачи, лояльность, настройки, интеграции, сеть, диагностику, уведомления и помощь. Исчезнувших маршрутов по DOM-аудиту не обнаружено.
- Основной dirty checkout не перезаписывался; он сохранён как источник незавершённых изменений. Для разработки каноническим локальным checkout является `HOOKAH CRM 2-release`.
- Browser QA after canonical alignment: `/finance` now exposes payroll UI after applying pending migrations 077–081. Owner sees «Настройка зарплатных схем» and «Зарплатный реестр» lower on the same finance overview page; API no longer returns `payroll_scheme_unavailable`, empty state correctly says to create the first draft scheme.

## 2026-10-07 — local canonical audit after VPS handoff
- Локальный канонический checkout: `HOOKAH CRM 2-release`, ветка `main`, SHA `bd2893d0`; рабочее дерево чистое, `origin/main` совпадает.
- Статический полный QA: 136/136 PASS.
- Проверены все зарегистрированные worktree: незакоммиченные материалы сохранены отдельно и не смешаны с `main`; уникальные изменения staff-directory/manager-permissions и auth-smoke не переносились из-за конфликтов и отсутствия безопасного подтверждения совместимости.
- VPS намеренно не изменяется после этого аудита: пользователи продолжают наполнять базу. Дальнейшие правки выполняются локально.

## 2026-10-07 — local canonical audit after VPS handoff
- Локальный канонический checkout: `HOOKAH CRM 2-release`, ветка `main`, SHA `bd2893d0`; рабочее дерево чистое, `origin/main` совпадает.
- Статический полный QA: 136/136 PASS.
- Проверены все зарегистрированные worktree: незакоммиченные материалы сохранены отдельно и не смешаны с `main`; уникальные изменения staff-directory/manager-permissions и auth-smoke не переносились из-за конфликтов и отсутствия безопасного подтверждения совместимости.
- VPS намеренно не изменяется после этого аудита: пользователи продолжают наполнять базу. Дальнейшие правки выполняются локально.

## 2026-10-07 — autonomous staged development plan
- Этап 1/7 (роли, права, персонал): подэтап 1.1 аудит завершён; role, staff catalog, active count, header actions и session navigation contracts PASS. Критического незакрытого разрыва в текущем `main` не найдено.
- Статус этапа: проверка завершена; переход к Этапу 2/7 — зарплатный модуль.

## 2026-10-07 — staged plan progress
- Этап 2/7 (зарплатный модуль): подэтапы 2.1–2.2 проверены. Схемы, расчёт, жизненный цикл начисления, реестр, фильтры, статусы и финансовая агрегация проходят QA/runtime-контракты.
- Ограничение зафиксировано: demo-memory режим намеренно сообщает `payroll_requires_database`; рабочий зарплатный контур рассчитан на PostgreSQL. VPS не изменяется.
- Статус этапа: завершён по текущему объёму; следующий — Этап 3/7 (финансовая связность).

## 2026-10-07 — staged plan progress
- Этап 3/7 (финансовая связность): подэтап 3.1 завершён. Проверены оплаты, частичные платежи, заказы, расходы, закупочные платежи, зарплата, себестоимость, прибыль, даты и часовой пояс заведения.
- Контракты и runtime QA проходят; переход к Этапу 4/7 — складской операционный цикл.

## 2026-10-07 — staged plan progress
- Этап 4/7 (складской операционный цикл): подэтап 4.1 завершён. Проверены иерархия склада, остатки, пороги, приходы, списания, перемещения, рецептуры, premix-партии, FEFO/FIFO, автозаказы и документы закупки.
- Контракты и runtime/static QA проходят; переход к Этапу 5/7 — лояльность и скидки.

## 2026-10-07 — staged plan progress
- Этап 5/7 (лояльность и скидки): подэтап 5.1 завершён. Проверены программы, акции, скидочные группы, бонусные ограничения, приоритеты, фиксация условий в заказе, возвраты и пересчёт остатка.
- Контракты проходят; переход к Этапу 6/7 — визуальная доводка desktop/mobile/Fold.

## 2026-10-07 — staged plan progress
- Этап 6/7 (визуальная доводка): подэтап 6.1 завершён. Design, visual-page, live-defect, header, sidebar, date, staff and payroll UI contracts PASS.
- Edge runtime check: `/admin#staff` renders the staff and role sections; `/finance#payroll` renders the payroll register and aligned filter block. In demo-memory mode the register explicitly shows the expected database-required empty/error state; this is not a silent failure.
- Переход к Этапу 7/7 — итоговый QA и подготовка локального релиза.

## 2026-10-07 — staged plan complete
- Этап 7/7 (итоговый QA и локальный релиз): завершён. `main` чистая, единственный worktree; HEAD и `origin/main` совпадают на `7919479a`.
- Полный статический QA: 136/136 PASS. Этапы 1–6 отмечены завершёнными; VPS не обновлялся по плану.
- Локальная версия готова для следующего отдельного решения о релизе на VPS.

## 2026-10-07 — компактные справочники склада
- Реализован согласованный каскад цех → подцех → категория; все/без подцеха, поиск, счётчики, меню действий, модальные редакторы, вторичные свёрнутые каталоги.
- API/схема/данные/права не изменены. В архиве сохранены активные родительские ветки. Исправлены reset editId, потеря выбора при reload, видимая подпись custom select, фокус после закрытия/перерисовки и повторная загрузка подцехов.
- Архитектор проверил существующий UI/API контракт; code_health_engineer проверил baseline и итоговый diff. Два замечания фокус/retry исправлены.
- PASS: node --check portal.js; inventory-hierarchy, category-tobacco, subdepartment-api, directory-rename-runtime, inventory-context, inventory-responsive, visual-page-rules; git diff --check.
- Новый inventory-directory-browser-qa.cjs PASS на изолированном memory-сервере: минимальные fixtures, каскад/поиск/создание/редактирование/отмена/архив/восстановление/API reread/reload; 1920/1366/390, нулевое горизонтальное переполнение и pageerror. Скриншоты просмотрены. Первый список Y328 Full HD. Mobile — последовательные вертикальные колонки, drawer закрыт при проверке.
- Производственные данные для QA не изменялись; полный PostgreSQL CRUD через production UI не выполнялся. Серверные обработчики неизменны; проверки их контрактов и mocked transaction QA PASS.
- CSS revision398 / portal459 синхронизированы root/dist HTML; публикация через существующий deploy workflow с резервной копией и SKIP_MENU_SEED_ONCE=true.

### Production review follow-up
- Первый выпуск71d88664 опубликован штатно, backup/health PASS. Проверка реальных33 категорий выявила неограниченную длину списка, которую небольшой local fixture не покрывал.
- Добавлены ограниченные прокручиваемые списки с заголовками вне scroll, inline-меню последней строки без обрезки, 44px кнопки. QA расширен до40 категорий; никакие production записи не менялись. Cache revisions399/460.
- Dense QA42: PASS1920/1366/390, last-row hit-test/edit, scroll bounds. Исправлен mobile grid-row overlap. В memory fixture есть toast ошибки вспомогательного каталога; основные directory API и JS runtime PASS. Финальный code-health bounded-list review PASS.

## 2026-10-07 — журнал поставок и списаний
- Причина: постоянно открытая приёмка и крупные KPI отодвигали документы за первый экран. Реализованы компактная шапка, внутренние Документы/Операции, ограниченные журналы и модальные редакторы приёмки/списания, включая draft edit и auto-order entry.
- Существующие API, RBAC, tenant, проводки и сторно сохранены. Подписи операций не выводят технический UUID в основную строку, доступны единицы. При pending закрытие блокируется; отмена ручной операции сбрасывает количество и единицу вместе. Исправлены найденные review проблемы pending scope и повторного открытия.
- Изменения: portal.js/style.css, root/dist cache461/400, визуальный контракт/site map; отдельный guarded PostgreSQL browser suite и allowlist runner, VM helper stubs с дополнительными modal assertions.
- PASS: JS syntax, purchase-documents/date/pending/reversal, inventory-form-pending/context/responsive, visual-page-rules, git diff --check. Code-health baseline/final review; system architect API contract audit выполнены.
- Локальный PostgreSQL browser QA:35 черновиков, создание/редактирование/отмена/проведение, списание и сверка stock SQL+API10→8, reload, pending Escape/backdrop, read-only manager403, tenant isolation; screenshots1920/1366/390 просмотрены. Runner создаёт и удаляет только собственную disposable БД; production данные не затронуты.
- В synthetic QA виден вспомогательный toast каталога при успешном HTTP products: не ошибка основного журнала; отдельно от границ текущего UI-пакета. Автозаказ проверен по сохранению входного контракта; отдельный новый end-to-end автозаказ не создавался.

- Финальный dense PG QA PASS включая последний документ на всех ширинах; cleanup подтверждён. Причина вспомогательного toast найдена: renderRecipes вызывался вне lexical scope. Исправлен явный callback из recipe scope, code-health подтвердил, добавлен contract и пройден быстрый directory browser regression без отдельной БД.
