# Проверка завершения финансовой цели

Дата: 2026-10-18. Локальная приёмка исходной финансовой цели завершена. Ниже сохранены границы доказательств и история выявленных пробелов. Проверены текущие файлы; чужие изменения сохранены (382 записи git status при начале сверки). Публикация не выполняется.

## Требования и доказательства

| Исходное требование | Текущее доказательство | Результат сверки |
| --- | --- | --- |
| Статья не создаёт платёж, тип/архив/история/счётчик | server.js category routes; свежий guarded finance-categories-postgres-api-qa PASS: CRUD, история, счётчики, archive/restore, гонки archive/rename, venue/role | Проверено на БД в этой сверке |
| Системные статьи, используемый тип, UI категории | finance-categories-ui-contract PASS; income-categories и source-category-schema contracts PASS | Контракты и свежий isolated demo-browser create/edit/archive/restore/reload/errors/3 widths PASS; persistence/tenant отдельно проверены guarded PG |
| Аренда60000, оплаты20000+40000, версия65000, пауза/восстановление | payables-browser-postgres-qa: строки263,440,467–511,608,616; последний полный guarded прогон PASS | Сквозной сценарий проверен |
| Предпросмотр, переменная сумма, неполный месяц | recurring preview/calculation contracts PASS; partial-month browser helper в полном прогоне | Проверено в пределах явных full_months_only/calendar_days |
| Возврат/зачёт/отмена без утраты исходной оплаты и признания | refund/offset PostgreSQL и browser сценарии; payable recognition contract PASS | Проверено; полный исходный scope не сводится к этим сценариям |
| Черновик и корректировка проведённого факта | expense corrections/refunds contracts PASS; профильные PG suites существуют | Свежие guarded expense-drafts и expense-corrections PostgreSQL PASS: версии/проведение/смена, история A→B→C, replay, tenant, append-only |
| POS-продажи из снимков, явные статьи без угадывания | income-categories и source-category-schema contracts PASS; legacy zero/null browser assertions | Свежий guarded income-snapshot-integrity PostgreSQL PASS: точные item/category facts, complete/unmapped, minimum adjustment, запрет неконсистентных состояний и rollback |
| Закупки/зарплата из профильных источников без двойной оплаты | category snapshots в полном браузерном прогоне; unified report DTO содержит purchaseDocumentId/payrollEntryId | Связи и защищённое открытие purchase/payroll/POS подтверждены полным guarded browser run14640 (exit0/PASS), включая selected venue,403/404 |
| Прочий доход: основание, признание, частичные оплаты | other-income contract PASS; browser suite содержит проведение, поступления/возвраты и конкурентный replay | Последний общий прогон PASS |
| Вклад/заём/перевод/начальная позиция не P&L | funding/account contracts PASS; funding и balance browser helpers в полном прогоне | Проверено; полный баланс счёта намеренно не заявлен при неполном покрытии |
| Депозит/предоплата и внешние возвраты отдельно | guest_advance PG/browser PASS:4 события, net225, signed refunds, source IDs, исключение внутренних применений | Проверено; account ID отсутствует в источниках и остаётся unknown |
| Раздельные план/обязательство/признание/cash/debt | source-separated unified report + payable recognition contracts PASS | API-контракт и source-separated строки снимка подтверждены; суммы секций раскрываются до записей. POS/закупка/payroll дополнительно открывают первичный источник |
| Период/статья/контрагент/источник/статус/заведение | unified report/filter/venue contracts и browser snapshot test | Контрагент — текстовый q; исключения фильтра статьи раскрыты в coverage |
| Больше500 строк: снимок15 минут, неизменные итоги | snapshot contract PASS и full browser create/replay/paging/permission | Проверено; исправлена подпись all-unknown секции, dynamic renderer check501 строк PASS |
| Точные суммы, локальные даты, unknown | BigInt/calculation/timezone contracts PASS; unknown не равен нулю | Контракты прошли; нет утверждения о полной официальной прибыли |
| Навигация, source actions, ошибки, reload, mobile/Fold | полный browser rent/funding/offset/report320/768 PASS; SITE_TREE содержит /finance/categories | Expense и report source actions→domain/selected-venue API→document проверены в браузере; role/target policy отдельно покрыты source-document contract |
| Миграции, транзакции, конкурентность, tenant/RBAC | guarded suites, source contracts, current browser PASS | Свежий локальный source-viewer image собран; модульная загрузка9 financial modules и server/portal syntax в network-none контейнере PASS. Нет production proof |
| Независимые роли и финальная проверка diff | три существующих агента остаются errored usage-limit; orchestration допускает последовательный fallback | Проверка координатором, независимый GO не заявлен |

## Итоговая приёмка

Все три пункта заключительной сверки выполнены:

1. Переходы к источникам реализованы и проверены: текущий список расходов и выбранное заведение общего отчёта, purchase/payroll/POS, read-only просмотр, исходный ID,403/404. Неудачный прогон4838 не засчитывался; финальный14640 завершился exit0/PASS после исправления импорта теста.
2. Свежие guarded runtime проверки POS classification, expense drafts/corrections и категорий прошли; полный сценарий аренды/возвратов/зачётов/финансирования/депозитов/снимков повторно прошёл на текущем коде. Category UI отдельно проверен на isolated demo, его результат не подменяет PG persistence.
3. Текущий локальный Docker image собран и проверен без сети/БД; syntax, source/dist equality, scoped diff и относящиеся контракты прошли. Производственная публикация в локальную приёмку не входит.

Ниже оставлены исторические записи аудита: слова «не завершено»/«в процессе» в них относятся к состоянию до итогового прогона14640, а не к актуальному статусу.

Официальная прибыль и полный остаток недоступны при неизвестных источниках согласно FINANCE_MODEL. Это явно заданная граница покрытия, а не разрешение скрывать незавершённый пользовательский сценарий.


## Уточнённый контракт перехода к источнику

Текущий список расходов (portal.js, render payment-row около5243) показывает описание и приложенный документ, но не кнопку исходного payroll/purchase-документа. В unified report source IDs выводятся текстом. Это незавершённый пункт исходного запроса, не только отсутствие теста.

Существующие чтения источников сохраняют собственные права и активное заведение сессии:

- Закупка: GET /api/inventory/purchase-documents/:id, inventory_read или inventory, repositories.purchaseDocuments.get(venueDbId,id), чужой/отсутствующий ID404.
- Зарплата: GET /api/payroll/entries/:id, finance; pe.venue_id=venueDbId, отсутствующий ID404. finance_read не достаточен.
- Чек: GET /api/orders/:id/summary, orders; id+venue_id проверяются до pricing. Это ценовая сводка, не полный документ чека.

Не добавлять безусловный href только потому, что report DTO содержит UUID. Для другого выбранного заведения отчёта нельзя молча читать источник из активной точки сессии или переключать её. Нужен явный контракт открытия документа с проверенными target-venue правами либо чтение финансовой проекции по авторизованному venue. UI должен различать загрузку, отсутствие прав,404 и ошибку; обновление и повторное открытие проверяются на реальных API. Следующий пакет должен закрыть этот сценарий, сохранив текущие ограничения доменных API.


### Реализация переходов из списка расходов

Добавлены кнопки закупки/начисления и read-only просмотр существующего источника; GET expenses возвращает payrollEntryId. Доступ по прежним domain API, same-venue, без смены активного заведения. Динамический тест проверяет ID, контекст,403 и readOnly. Полная браузерная приёмка в процессе; источники в multi-venue report и POS ещё требуют отдельного завершения.
