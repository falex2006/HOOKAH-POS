# Возвраты оплат POS-заказов — контракт проекта

**Статус:** контракт частично реализован локально; оставшаяся часть описывает открытые требования. Не свидетельствует о production deployment.
**Основание:** правило 5 в `FINANCE_MODEL.md`, существующие guest-account и reservation-prepayment reversal ledgers и требование owner-selectable payroll refund policy.

## Что реализовано и что остаётся

Миграция `088_pos_order_refunds.sql` и текущие Finance endpoints предоставляют append-only order-level журнал фактических cash/card/QR POS payout. Это не восстанавливает историю из старого `payments.status='refunded'`; такие строки остаются `unknown`.

Для новых заказов с подтверждённым immutable line snapshot 090 миграция `091_pos_order_refund_items.sql` добавляет item/quantity/net lineage. Возвраты, созданные до этого источника или для legacy заказа без snapshot, остаются `unattributed`; они не реконструируются. Payroll consumer и политика обработки поздней корректировки не подключены. Guest bonus/deposit и reservation prepayment остаются отдельными liability reversal flows; payout 088 не является их сторно.

### Stage 2 implementation evidence · локальный код

Миграция `091_pos_order_refund_items.sql` добавляет append-only `order_refund_items` со связями venue/order/snapshot/order item и immutable pricing source из 090. Cumulative returned quantity capped на замороженном количестве строки; item value определяется разницей накопительной half-up суммы от frozen `net_minor` (полный возврат сходится с net). Отдельная balance row служит только сериализационным guard; 088 payout/tender accounting не менялся. Статус `complete` означает item lines этого возвратного события, `unattributed` сохраняет legacy/неразмеченный факт, `not_applicable` — явный случай без возврата товара только для заказа со snapshot.

Существующий API и UI принимают payout allocations и возвращаемые количества независимо; item quantity включена в idempotency canonical payload. PostgreSQL + Chromium acceptance (`scripts/local-full-pg-regression.cjs pos-order-refunds-postgres-qa.mjs`) проверяет cumulative rounding 4/3/4 коп., full cap, replay/conflict, concurrent cap, rollback и browser lost-response retry. Payroll consumer не подключён; требования к политике влияния позднего возврата на начисления остаются отдельным незавершённым контрактом.

### Stage 3 source-ordering contract · migration 092

`order_refund_items.producer_sequence` is a positive, monotonically increasing sequence scoped to `(venue_id,snapshot_id,order_id,order_item_id)`. It is assigned while the matching `pos_order_item_return_balances` row is locked. The immutable event stores `previous_returned_quantity`, `cumulative_returned_quantity`, `previous_returned_item_value_minor` and `cumulative_returned_item_value_minor`; existing `returned_quantity` and `returned_item_value_minor` remain this event's deltas. Quantity is numeric scale 3; values are integer minor currency units. API DTOs expose these values as camelCase (`producerSequence`, `previousReturnedQuantity`, `cumulativeReturnedQuantity`, `previousReturnedItemValueMinor`, `cumulativeReturnedItemValueMinor`) and mark `sequenceScope='per_source_post_092'`.

Existing 091 rows retain NULL sequence and NULL transition facts and are returned as `sequenceScope='legacy_unsequenced'`. No timestamp, refund UUID or item-event UUID is used to backfill chronology. A first sequence-1 event may use a nonzero previous quantity/value baseline from those prior unsequenced facts; it attests only post-092 serialization order, not complete historic lineage. Payroll's official readiness remains blocked while the unsequenced-history boundary or separate refund-recognition policy is unresolved.

## Целевой принцип

- Возврат — отдельная append-only финансовая операция, которая ссылается на исходный `venue_id`, `order_id`, `payment_id` и сохраняет amount, фактический payout method, обязательную причину, actor, event timestamp, shift и venue-scoped idempotency key.
- Исходный paid payment и закрытый order snapshot не переписываются. Возвраты остаются отдельным отрицательным cash-flow движением по `created_at`; первоначальная продажа остаётся на `closed_at`. Любая политика уменьшения payroll commission применяется отдельно к исходному POS-fact и refund-lineage.
- Денежная выплата допускает только реальный cash/card/QR payout. Возврат в депозит или бонусный кошелёк — liability reversal в соответствующем guest-account ledger, не внешний cash payout и не POS sale refund.
- Оплата `reservation` исключается из общего POS-refund ledger: для неё используется `reservation_pre_payment_receipt_reversals`, чтобы один возврат не считался дважды.

## Предлагаемая схема

Существуют `order_refunds` (операция выплаты), `order_refund_tenders` (фактически возвращённые деньги) и `order_refund_items` (возвращённые количества/стоимость sale lines) с композитными foreign keys на тот же tenant/order/snapshot/item. Attribution statuses: `complete`, `unattributed` и `not_applicable`; последний разрешён только для заказа с pricing snapshot и обозначает явное отсутствие товарного возврата.

Фактическая выплата гостю и возвращённая продажа — разные величины: чек мог быть оплачен наличными и бонусами/депозитом; внешний payout в рублях не равен автоматически исходной net sale value. Хранить их отдельно. Tender lines ограничены отдельными исходными payment amounts; order-item return lines ограничены исходным количеством и immutable net item snapshots после скидки. В mixed tender операция возврата связывает обе стороны, но не пересчитывает и не переписывает закрытый чек.

Заголовок refund хранит `item_attribution_status` и отделяет complete event item lines, legacy/unattributed выплату и явный нетоварный случай. При `complete` item return lines сверяются с исходными line snapshot и ранее возвращёнными количествами/суммами. При `unattributed` фактическую выплату разрешено зафиксировать, но нельзя назначать её сотруднику по эвристике; будущий official payroll run, требующий полного employee net source, должен блокироваться.

Возвратная политика payroll — owner-selected правило в versioned payroll scheme; финансовая refund операция фиксирует факты, но не выбирает, в каком периоде уменьшать комиссию, делать ли clawback или как делить эффект по сотрудникам. Для полной item attribution требуется будущий pricing evaluator snapshot с line-level скидками; нельзя выводить её из текущей цены товара, order opener или равномерно распределять payout.

## Инварианты транзакции

1. Сервер получает tenant и actor из авторизованной сессии. Запросы ограничены finance permission и активным tenant; actor/venue нельзя задать телом запроса.
2. В одной транзакции блокируются заказ, выбранные исходные payments и возвращаемые items (`FOR UPDATE`); перечитываются существующие refunds и replay key. Требуется завершённый заказ и paid/partially-paid external cash/card/QR payment. Bonus/deposit/reservation tenders, pre-close voids и чужой tenant отклоняются или обрабатываются отдельным liability workflow.
3. Повтор одинакового key с теми же order/payment/amount/method/reason/line allocations возвращает уже созданное событие; конфликтующие данные с тем же key получают 409. Два конкурирующих refund не могут переплатить гостю.
4. Сумма внешнего возврата по каждому source payment не превышает его остаток; суммарные item returns по всем tender источникам не превышают возвращаемое количество/net value каждой позиции с учётом скидок и предыдущих возвратов. Оба инварианта проверяются конкурентно под блокировками.
5. Новое событие требует выбранную открытую смену площадки и явную currency precision contract. Фактический cash impact уменьшает ожидаемый остаток смены только для cash; card/QR остаются отдельными выплатами.
6. Ошибка любой проверки откатывает refund header, tender/item lines и audit event. Каждая успешная операция получает audit record.
7. Не переписывать исходный `payments.status` и суммы. Полный refund display status вычисляется из исходной суммы и append-only refund balance. Payment/balance/close/report queries вычитают возвраты ровно один раз.

## Требуемые проверки

- partial и full refund, zero/negative/over-payment rejection, один payment с несколькими payment methods/refund events;
- mixed cash+bonus tender: payout tender total отделён от returned sale/item value; обе стороны восстанавливаются в своих ledgers без двойного учёта;
- параллельные refund с `FOR UPDATE`, идентичный replay и idempotency conflict;
- выбор/tenant/role isolation, отсутствие финансовых данных у сотрудника без права чтения;
- обязательные reason/actor/event date/shift, cash impact отдельно от cashless;
- line return amounts/quantities суммируются с исходными immutable скидочными snapshots, same-order FK и cumulative per-item cap; неполная attribution явно маркируется и блокирует лишь official payroll inference, не Finance receipt recording;
- finance summary и X/Z используют payout `created_at`, не изменяют sales `closed_at`, не удваивают liability refunds;
- cleanup в isolated PG QA удаляет fixture в порядке FK; основная БД не участвует.

## Граница готовности

Локальный Stage 2 acceptance подтверждает POS source и payout separation на синтетическом PostgreSQL/Chromium наборе; он не доказывает production deployment или полный payroll consumer. Нельзя маркировать legacy payout coverage как `complete` и нельзя разрешать official payroll run считать полную net revenue через неатрибутированные возвраты. Этот контракт фиксирует границы источника и сам по себе не выполняет deployment.
