# Финансы, склад и возвраты — заключительный доменный проход

Дата: 08.10.2026. Применены профили finance_domain, warehouse_domain, qa_engineer. Продуктовые файлы, миграции и постоянная база не менялись. Браузерная проверка принадлежит координатору; здесь PostgreSQL + настоящий локальный HTTP API и отдельный SQL-reproducer.

## Доказанные результаты

| Проверка | Результат | Объём и граница |
|---|---|---|
| Оригинальный `recipe-depletion-pg-runtime-qa.mjs` через guarded wrapper | **PASS, 372 assertions**, exit 0 | Табель по локальному дню → поставка/оплата → остаток → упаковки/бутылки → табачные и коктейльные техкарты → продажа/списание → себестоимость → существующая зарплатная цепочка → P&L/cash-flow. Не подтверждает новый official payroll writer |
| API-часть `pos-order-refunds-postgres-qa.mjs` | **PASS**, exit 0 | Все исходные assertions до обязательного Playwright-блока сохранены. RBAC/чужая точка, split tender, replay/cap/rollback, построчные возвраты092, sequence и before/after, равные timestamps, прямые конкурентные SQL-транзакции, совместимость091, разделение стоимости возврата и фактической выплаты. Число runtime assertions suite не сообщает |
| Предоплаты, копия с заменой только cleanup | **FAIL**, exit 1 | Устранён маскирующий cleanup-сбой; выявлен старый fixture legacy pricing: expected unsnapshottedOrders=1, actual=0. Все более ранние assertions дошли до этого места без отказа, но полный сценарий не PASS |
| D06: timezone SQL в настоящем PostgreSQL | **Дефект воспроизведён, 3 assertions**, exit 0 | При UTC-соединении, Екатеринбург01:00, бронь сегодня18:00: используемое сравнение дат false, сравнение в timezone заведения true. Это проверка выражения на фиксированном времени, не HTTP-закрытие заказа в полночь |

Нехватка сырья проверена в оригинальном stock-suite и при прямом закрытии, и при финальном взносе (`scripts/recipe-depletion-pg-runtime-qa.mjs:320–338`): сохранены заказ/платежи/остатки, не добавлены движения. Проверены совместная потребность нескольких товаров, откат при принудительной ошибке, просроченный премикс, конкурентное повторное закрытие с одним списанием. Это подтверждает серверную сторону D01; сообщение сотруднику проверяет координатор.

## Безопасность и точные изменения временных harness

`tmp/audit-20261008/build-finance-harness.cjs` создал приватные копии; исходные scripts не редактировались. `finance-runner.cjs` использует скопированные проверки `validateConfig`, `validateContainer`, `verifyTarget`, `safeText` из `scripts/local-full-pg-regression.cjs`: точное имя контейнера, ownership label, postgres16-alpine, auto-remove, анонимный volume, только127.0.0.1:31931, проверка фактической identity SQL. Каждый запуск создаёт уникальную `inventory_qa_<16hex>`, применяет schema + все миграции и в finally повторно проверяет цель, затем удаляет **только созданную этим запуском БД**. Все использованные БД удалены; production/persistent31930 не затронута.

- `prepayment.mjs`: относительный import safety/root перенесён к исходному проекту; единственная строка row-by-row cleanup заменена на закрытие соединения. Assertions и тело сценария сохранены. Внешний runner удаляет целиком собственную БД, поэтому immutable guards продукта не выключаются для обхода cleanup.
- `refunds.mjs`: root/import перенесены; сохранён точный префикс исходного теста до `const playwrightPackagePath` (оригинальная строка195). Вместо browser-блока и зависящего от его операций финального хвоста добавлены PASS-marker и закрытие сервера/соединения. Assertions выбранного API-префикса не ослаблялись. Lost-response UI retry, UI-отчёт и финальные assertions после браузера **не входят** в этот результат.
- `timezone.mjs`: read-only SQL с фиксированным `as_of='2026-10-07T20:00:00Z'`, starts_at='2026-10-08T18:00:00+05:00'. `as_of::date` моделирует CURRENT_DATE на этом времени; время системы/продукта не подменялось.
- Первый запуск временной prepayment-копии выявил неверный root из-за отличающегося форматирования строки; исправлено только вычисление root копии, следующая попытка дошла до доменного assertion. Ошибка harness не объявляется дефектом продукта.

Команды: `node scripts/local-full-pg-regression.cjs recipe-depletion-pg-runtime-qa.mjs`; `node tmp/audit-20261008/finance-runner.cjs prepayment`; аналогично `refunds`, `timezone`.

Логи: `tmp/full-local-qa/pg-recipe-depletion-pg-runtime-qa.mjs.log`; `tmp/audit-20261008/prepayment.log`, `refunds.log`, `timezone.log`. Логи runner санитизированы.

## Открытые фактические вопросы

1. **D06 P2 — дата брони:** исходные пути освобождения стола (`server.js:5968`, `:6010`, `:6029`, `:6334`, `:6419`) используют `starts_at::date=CURRENT_DATE`, а создание (`:5634`) учитывает venue timezone. PostgreSQL-expression reproducer подтвердил расхождение. Нужно единое правило локального дня и тест HTTP around-midnight. Владелец backend/system_architect/QA.
2. **Предоплата: устаревший legacy fixture, полная suite не green.** `scripts/reservation-prepayment-postgres-qa.mjs:108` обнуляет только агрегатные поля orders и ожидает отсутствие snapshot. Текущий отчёт (`server.js:3454`) считает отсутствие canonical_gross; канонические POS pricing snapshots остаются. Аналогичное правило видно в `server.js:709–719`. Нельзя считать это доказанным дефектом отчёта: fixture не моделирует реальный старый заказ. Нужен настоящий legacy заказ без canonical producer facts и повтор полного сценария. Assertions после этого места ещё не доказаны этим запуском.
3. **Refund UI:** mandatory Playwright исключён по браузерным правилам. Координатор отдельно проверяет UI через CUA; API PASS не заменяет UI lost-response retry.
4. **Новый официальный payroll** остаётся blocked-only/officialReady:false; PASS372 существующей цепочки не закрывает отсутствующие новые source adapters.

Первый пакет исправлений: ролевые дефекты из общего отчёта → рабочее место/D01/D02 → D06. Серверные guards финансов и списания сохранять. Устаревшие fixtures исправлять отдельно, не отключая immutable guards и не объявляя непроверенный хвост PASS.

## Отдельный continuation предоплат

После сохранённого исходного FAIL координатор поручил проверить независимый хвост отдельно. `build-prepayment-continuation.cjs` создал `prepayment-continuation.mjs`; из его запуска изолирован только участок `const snapshots=...` → непосредственно перед `const report=await api('/api/dashboard/shift-kpis...')`. Это три legacy-simulation assertions (ожидание unsnapshotted=1, legacy gross500, legacy net500) и их временное обнуление/восстановление агрегатных полей. Участок сохранён в `prepayment-omitted-legacy.txt`; исходный failing harness и лог не перезаписаны. Остальные assertions сохранены.

`node tmp/audit-20261008/finance-runner.cjs prepayment-continuation` — **PASS, exit0**, собственная свежая БД удалена. Результат проверяет оставшуюся цепочку предоплаты/частичного зачёта/replay/overdraw/RBAC/audit/отчёта, mixed legacy+verified receipts, частичного/полного возврата квитанции и закрытия смены (expectedCash600, cashVariance50). Это отдельный результат, **не PASS оригинальной полной suite**. Лог: `tmp/audit-20261008/prepayment-continuation.log`.

Уточнение открытого пункта2: независимый хвост теперь проверен continuation. Открыты именно три assertions настоящего legacy pricing fixture без canonical snapshot; создавать такой факт путём отключения immutable-защиты не пытались.
