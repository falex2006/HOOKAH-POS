# Payroll: сверка immutable pricing заказа и строк

Статус: pure verifier для будущего source adapter. Это проект интерфейса предоставленных фактов, а не существующее POS хранилище. Shared price-lock writer и новое pricing DDL принадлежат Finance/Loyalty/POS и требуют отдельной передачи.

## Вход

`verifyPayrollOrderPricingFacts({venueId,currency,sourcePolicies,orderSnapshot,lineSnapshots})` принимает выбранную owner policy и полный заявленный pricing envelope заказа.

Order snapshot: order/venue identity, snapshot identity/version, pricing version, pricingLockedAt/closedAt, currency, обязательная `grossReconciliationPolicy: order_numeric_half_up_largest_remainder_order_item_v1`, subtotal/discount/minimum adjustment/final total в копейках, selectedDiscount kind/amount, sourcePortionIds.

Line snapshot: portion/orderItem/order/venue identity, snapshot identity/version/currency, точное количество и обязательная замороженная `unitPrice`, gross cents, declared discountEligible/eligibleGross cents, **сохранённые** allocatedDiscount cents/netSale cents, seller identity или unknown attribution, commission eligibility и frozen department.

Quantity — десятичная строка positive numeric(12,3), до999999999.999; unitPrice — строка nonnegative numeric(12,2), до9999999999.99. Числа JavaScript, exponent, знак, whitespace, лишняя шкала и ведущие нули отклоняются. Предыдущая draft shape без цены/policy отвергается; runtime потребителей или сохранённой истории этого интерфейса нет.

Все строки обязательны: вне цеха зарплатной роли, некомиссионные и без известного продавца. Идентификатор snapshot не доказывает, что строка действительно зафиксирована в БД.

## Арифметическая проверка

- Уникальность и совпадение полного заявленного списка portions, tenant/order/currency/version и времён lock/close. На каждый orderItem — одна immutable строка; portionId может отличаться от orderItemId. Разбиение одного source item на несколько portions требует отдельного контракта и сейчас отвергается.
- Raw стоимость строки в тысячных долях копейки = exact quantityMilli × unitPriceCents. Общий subtotal округляется HALF_UP один раз: (sumRaw+500)/1000. Gross каждой строки = floor(raw/1000) плюс остаточные копейки по убыванию fractional remainder, затем по canonical orderItemId. Сохранённые subtotal и gross сравниваются с этим replay; недостающие суммы не подставляются.
- Сумма gross равна locked subtotal; сумма allocations равна locked discount; сумма line net + отдельный minimum adjustment равна locked final total.
- Eligibility и её frozen база явно предоставлены; не выводятся из сегодняшней категории или акции. EligibleGross равен полному reconciled gross для eligible строки, иначе0. Это проверка предоставленных whole-item фактов, не подтверждение winner/реального eligible set evaluator.
- Immutable line policy требует все сохранённые allocations/net и сверяет их арифметику.
- Fixed policy допускает только явно выбранную fixed-order скидку с amount, равным полной скидке заказа, либо явно зафиксированное отсутствие скидки с нулевой суммой. Mixed/percentage скидка не переименовывается в fixed. Replay распределения пропорционален frozen eligible gross; суммы сравниваются с сохранёнными allocations, а не подставляются вместо отсутствующих фактов.
- Выбранный координатором Finance контракт использует canonical orderItemId и порядок code units для gross и fixed-discount ties. Fixed результат помечен `allocationTieContract: canonical_order_item_id_code_unit_v1`; portion UUID больше не является tie key.

Нет округления через float. Входные суммы и возвращаемые копейки безопасны для integer JavaScript; промежуточная арифметика BigInt. DTO отделён от изменяемого ввода.

## Границы результата

Результат имеет scope `supplied_pricing_arithmetic`. Он не утверждает official readiness, source coverage или права записи. Полноту перечисленных строк БД adapter должен доказать против канонического источника в одной транзакции.

Line net обозначает `netSaleBeforeRefundCents`. Возвраты не предполагаются нулевыми. Отдельный refund/credit adapter должен сформировать commission base и полный Finance personal net, включая некомиссионные строки. VIP minimum adjustment остаётся отдельно от employee commission; его employee attribution не изобретается. Bonus/deposit/reservation tenders не повторно уменьшают цену.

## Доказательства для production интеграции

Bounded pure этап принят локально: независимый RED→GREEN Finance-alignment contract, противоположный порядок portion/item IDs в gross и discount, дробные количества/half-cent/DB bounds/zero price/tamper/duplicate/version/missing fields,1000 независимых малых integer oracle случаев и permutations. Existing pricing contract, source policies/context/evidence/milestone mapper, syntax/scoped diff и architect/domain+health final PASS. Immutable-line policy по-прежнему conservation-only для сохранённой скидки: независимо подтвердить source winner, eligible set и все виды discount replay она не может.

Finance handoff canonical storage и price-lock writer; immutable eligibility/item/portion identity и unit price/quantity; сохранённые reconciled gross/allocations/net по выбранной policy; line refund lineage; полная personal net серия по selected credit policy; tenant/timezone/currency/source manifests; source→verify→calculate→atomic persist→reload. Pure PASS сам по себе эти этапы не закрывает.
