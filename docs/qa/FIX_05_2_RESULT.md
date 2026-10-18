# FIX-05.2 — legacy-выручка в сверке

Выполнен локально 08.10.2026. Изменены две формулы чтения в `server.js`, расширен `scripts/reservation-prepayment-postgres-qa.mjs`, уточнён контракт отчётов в `docs/requirements/FINANCE_MODEL.md`.

## Причина и результат

`GET /api/loyalty/reconciliation` вычислял `legacy_gross` из сохранённых строк и `legacy_paid` из оплат `paid/partially_paid`, но не использовал их в SUM. Заказ без обоих видов ценового снимка увеличивал счётчик продаж, а его суммы пропускались.

Теперь gross выбирается в порядке canonical snapshot → snapshot заказа → сохранённые строки. Net выбирается canonical snapshot → snapshot заказа → сохранённые оплаты. Числовой ноль остаётся действительным значением; fallback разрешён только для NULL. Скидки и доплата до минимума не восстанавливаются из текущих акций или разницы между суммой строк и оплатой. Запрос остаётся read-only, по выбранной точке и локальной дате закрытия; исторические записи не переписываются.

Этот порядок соответствует существующему API.md и отдельным regression-контрактам сверки. Он отличается от начисленного финансового отчёта: в сверке старый заказ без снимка и оплаты имеет net=0; начисленный отчёт может восстановить стоимость по позициям. Различие явно записано в FINANCE_MODEL, новые денежные правила не вводились.

## Проверки и доказательства

До изменения штатный guarded prepayment suite воспроизвёл `500 !== 1000`: legacy-заказ на 500 ₽ не увеличивал baseline gross=500 ₽.

После изменения `node scripts/local-full-pg-regression.cjs reservation-prepayment-postgres-qa.mjs` — полный PASS, включая сохранённые исходные проверки предоплат, возвратов, ролей, идемпотентности и закрытия смены. Runner удалил свою одноразовую БД и проверил её отсутствие (CLEANUP PASS).

Расширенный regression проверяет:

- legacy +500 gross и +500 net; счётчик без canonical snapshot;
- сохранённые позиции без оплаты: gross присутствует, net не выдумывается;
- authoritative нулевые snapshots при наличии позиций и оплат;
- snapshot 700 gross / 100 discount / 50 minimum / 650 net при конфликтующих строках 1500 и оплате 500;
- начало локального дня включительно, конец исключительно, закрытие перед началом периода;
- исключение чужой точки, стабильное повторное чтение;
- удаление только mutable synthetic fixtures и возврат ровно к исходным итогам перед сменными проверками;
- неизменность существующих canonical pricing snapshots.

Дополнительно PASS: `loyalty-reconciliation-contract.mjs`, `finance-api-consistency-contract.mjs`, `finance-timezone-contract.mjs`, `loyalty-memory-period-business-qa.mjs`, `loyalty-reconciliation-memory-qa.mjs`, синтаксис и scoped diff check. Finance/system architect подтвердил контракт; code_health_engineer проверил исходное состояние и точный финальный diff, блокеров нет.

Дополнительный `paid-order-balance-postgres-qa.mjs` через guarded runner завершился FAIL на cleanup: FK `inventory_purchase_reversal_policies_venue_id_fkey`, `loyalty_promotions_created_by_fkey`, `venues_organization_id_fkey`. Его finally может маскировать исходную ошибку, поэтому функциональный PASS этого suite не заявляется. Runner удалил принадлежащую ему временную БД; данный QA-скрипт в FIX-05.2 не менялся. Это отдельный долг тестовой обвязки.

## Границы

Нет миграций, записи в рабочие базы, изменений UI, GitHub или production. Edge не запускался. Полная приёмка FIX-06 остаётся впереди; static mock из FIX-05 и дополнительный cleanup paid-order-balance требуют отдельного ремонта QA.
