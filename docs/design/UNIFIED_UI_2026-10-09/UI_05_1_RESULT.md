# UI-05.1 — Рабочий зал, заказ и приготовление

Дата: 10 октября 2026. Статус: **ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**. Основание: принятое UI-04.3 и прямой запрос пользователя на UI-05.1. Рекомендация модели GPT-6.1 Sol / High не подтверждает переключение в интерфейсе.

## Что изменилось

- POS floor/order/catalog/queues/preparation используют существующие семантические панели, текст, поля, статусы и кнопки с целью44px. Финансовые controls не мигрированы.
- До выбора стола редактор компактный, без disabled-дубликатов действий. Выбранный пустой стол имеет один основной вход «Новый заказ». Дальнейшая подсказка соответствует фактическому состоянию заказа.
- Плитки показывают сумму заказа главным числом, время HH:MM вторичным, сохраняют вместимость/оборудование и полное accessible имя. Существующие density70–130%/«Вместить», sole-room hiding и timer calculation сохранены.
- Бармену и кальянщику показано своё направление из реальных permissions. Очередь различает загрузку, пустой список, пустой фильтр и ошибку с повтором. Ошибка обновления не уничтожает известные карточки.
- При ожидании проверки разрешений показывается загрузка. Настоящий отказ и ошибка имеют отдельные сообщения. Прежняя вспышка denied была воспроизведена на delayed real GET floor.
- POS читает dark/light preference только из успешной подтверждённой сессии текущего token. Preference не записывается и новых прав не появляется.
- Устранён фактический pending CSS дефект: generic loading/aria-busy rule ставил catalog position:relative, и окно уходило к y720 ниже viewport. Scoped fixed rule сохраняет прежний overlay, не меняя add/close/finally handlers. Финальный кадр показывает busy-каталог top0/full720 и обе disabled кнопки внутри viewport.

## Границы изменения

Продукт: app.js/style.css и соответствующие dist mirrors. Добавлены focused source/evidence checks; три старых test fixtures адаптированы к текущим callback/focus/classList. API/server/DB schema, цены/quantity/stock, payment/refund/idempotency, execution requests, tenant/role/route, density/time formulas не менялись. Boundary contract проверяет12 frozen app scopes и полный сервер против intake. В наследуемом большом WIP не выполнялись reset, stage-all, commit или публикация.

Начальный HEAD: 802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf. Final app.js: 01a1e81090b2fde6324f5b5a657dc7b91d9d5c8e5460bbd3b5259780038a5120; style.css: e32d0f58ff192b0ff96d034c8c4ebe28763734801a632e3f9c0ebd3360f90a82. Source/dist равны. Исторические UI-04.3 hashes сохраняют собственную приёмку, а старые снимки UI-05.1 исключены в diagnostic без перепривязки.

## Проверки

| Проверка | Итог и граница |
| --- | --- |
| Focused runners | 16 PASS, включая17 actual-source presentation cases,12 frozen boundaries, table density/time, catalog loading/refresh/pending, execution/order status, payment/refund compatibility, effective permissions,84 management policy cases, shared74/mounted16 |
| Syntax / diff / mirrors | 8 syntax PASS, scoped diff PASS, app/style mirrors2 PASS |
| Saved pixels | 56/56 JPG/JSON 1:1,112 current source bindings,626 common button targets≥44px; before/after measurements equal, horizontal overflow/overlap absent |
| Desktop | Owner1366×768/1920×1080 обе темы: контрольные10 плиток помещаются. Actual1280×720DPR1 и1.25: management short view допускает EX-06 прокрутку с подсказкой; workers readable |
| Роли / состояния | Owner/manager/bartender/hookah_master в обеих темах, отдельный denied other_staff; empty/loading/error/manual retry/filter/long content, catalog Tab wrap/Escape→CTA, pending disabled/visible controls |
| Narrow |390×844 обе темы, bounded regression; длинные editor/queue области прокручиваются, full mobile/Fold не принимается |
| Реальное приготовление | Table→catalog→add→dispatch bar/hookah→take→ready→owner login/readback; корректные toast/закрытие каталога проверены, существующая business последовательность сохранена |

Всего27 команд в [final-checks](evidence/UI-05.1/provenance/final-checks.json). Independent reviews находятся в [UI_05_1_REVIEWS.md](UI_05_1_REVIEWS.md). VM guards для late token/venue/session response проверяют механизмы; параллельные browser race не заявляются воспроизведёнными. Измерение button targets не заменяет полную accessibility/contrast приёмку.

## Реальные данные и сохранение

Только собственная синтетическая точка в disposable hookah_ui012 на loopback31953/31954:10 столов,2 non-stock товара,5 тестовых ролей. GUI создал3 заказа (1450,1450,2450 ₽); всего10 строк quantity1. Длинный заказ содержит5 чайных строк по250 и кальян1200; все6 готовы. Повторный вход владельца показывает2450 и6 строк. Готовность приготовления отделена от оплаты:3 заказа остаются financially open.

Collector сохранил39 accepted POST/PATCH и последующий успешный GET для каждой затронутой записи/заказа. Это linkage readback, не доказательство deep equivalence каждого промежуточного ответа. Итоговый read-only PG отдельно подтвердил суммы, item count, sales actor/sold_at и dispatched≤started≤ready по обеим станциям. Нулевые payments/discounts/stock movements и shift openingcash0 проверены. Stock/payment workflow не принимался: тестовые товары non_stock, финансовые POST не вызывались. См. [api-proof](evidence/UI-05.1/provenance/api-proof.json).

## Ограничения и оставшийся долг

1. В light catalog остаются прежние тёмные search/flow-note insets; light preparation queue heading бледный; narrow light sticky table actions имеют прежнюю тёмную полосу. Это сохранённый legacy долг, не full contrast PASS.
2. Согласованные1366/1920 floor fit подтверждены. Короткий1280×720 management и длинный выбранный заказ используют прокрутку. Прежний1228×764 кадр после смены CSS стал diagnostic и не объявляется final-source доказательством.
3. Native PIN функционально проверен: DOM/modal/focus, настоящий unlock200, сохранение6 строк и2450 после unlock. Ранний pending catalog DOM/unlock/readback согласован архитектором как bounded regression. Overlay screenshot недоступен из-за зависания screenshot tool; нет нового PIN pixel PASS и повторной полной UI-04.3 приёмки. Последняя manual проверка без открытого каталога сохранена отдельным [DOM record](evidence/UI-05.1/provenance/pin-functional-current.json).
4. Native/shared financial dialogs, stock lifecycle и production безопасность этим этапом не принимаются. Fold — UI-10.1.

## Завершение среды

Fault mode normal; defaults собственных fixture themes восстановлены (owner dark,manager light,bartender light,hookah dark). Own tab13 закрыт, viewport override сброшен, proxy31963 остановлен. Существующие listeners31952/PID30032,31953/PID21648,31957/PID42756 и пользовательский Edge сохранены. Синтетические venue/users/orders оставлены для воспроизведения; финансовые закрытия и удаление не выполнялись. Credentials/private runtime/tokens не включены в evidence. GitHub/VPS публикации не было.

Следующий отдельный этап: **UI-05.2 «Гости, задачи, доставка и список броней», GPT-6 Luna / Medium**. UI-05.2 автоматически не запускался.
