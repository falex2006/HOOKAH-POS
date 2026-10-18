## 2026-10-15 — Attendance: operational workflow and in-app notifications

- User requested completion of the local attendance workflow, renamed management section and linked notifications. Manager section is «Выходы сотрудников», existing route stays `/admin#staff-attendance`; personal action stays «Выход на работу». Daily overview is separate from «Правила и доступ».
- Reuse the existing notification bell and per-user `notification_reads`. Attendance notifications are derived from committed requests/sessions with stable keys and current server-side access, so failed/rolled-back mutations cannot send phantom events. No external push, SMS or Telegram is introduced. Active clients poll; after mutation and cross-tab signals refresh promptly.
- Only owner and current approval delegates see pending requests; personal decisions/expiry/recovery are visible only to the subject. Operational employees must not gain existing financial/order notification categories. Revoke is effective on the next server read. Pending/overdue alerts disappear when no longer actionable; a read receipt never means approval.
- Forgotten-session recovery has an independent owner-delegated permission, separate from approval/policy. The action closes an open other-employee session at the server's current time with mandatory reason, optimistic version and immutable audit. It does not invent a historical actual end, close cash, modify a schedule or write payroll. Self sessions use ordinary self-end.
- Reminder is advisory: an open session is prompted one hour after its snapshotted planned end; without a planned end, after16 hours from start. The reminder is not a no-show/disciplinary decision and never auto-closes work. These thresholds are explained in help; future configurable thresholds are outside this local iteration.
- No publication or production migration is included in this stage. Preserve existing calendar/attendance WIP and unrelated shared-root work.

## 2026-10-09 — D-UI012-R5: область приёмки визуальной базы

- Введён UI_01_2_BASELINE_GATE_R5.md: 1 080 baseline + 42 appearance groups / 198 visual-state obligations. Основание PLAN UI-01.2 vs UI-09.1; независимые architect/QA scope GO в CONTRACT_R5, design scope GO в VISUAL_REVIEW_R5.
- Заменено расширенное требование terminal acceptance всех 6 480 exhaustive cases до завершения исходного визуального исследования. Все IDs, pending/rejected/defect outcomes сохранены как UI-09.1 backlog; необходимые distinct visual states, own-role/session/route, integrity, theme, геометрия и независимое review остаются обязательными. Автоматические PASS/equivalence не вводятся.
- Terminal restriction с неуместным pending shift control допускается как inspected baseline defect только после current bitmap + own-session/source bridge и назначения владельца. Непроверенный pending остаётся gap, whole shell N_A запрещён. Это явное уточнение исторического R3 gate, не признание исправленного shift lifecycle.
- Stage NOT ACCEPTED, product/release PASS отсутствует. Независимые scope signoffs не заменяют итоговые подписи фактической приёмки. Координатор продолжает конечные visual obligations.

## 2026-10-02 — безопасный контракт управления акциями L11.5

- Кампания — отдельная сущность от группы гостя, с version history, tenant scope, явным периодом, IANA timezone, выбранными товарами/категориями, размером выгоды и приоритетом. Интервалы храним как UTC instants; ценовой evaluator должен трактовать их как `[start,end)`.
- Любая новая кампания создаётся как черновик. До готовности L11.6 нельзя активировать кампанию через API, потому что пока нет серверного применения к цене и POS объяснения. Конфигурация не создаёт скидку, оплату, бонусное/денежное движение, кассовую запись или выручку.
- Изменение/архивация добавляет новую неизменяемую версию; ожидаемая площадка и версия обязательны; PostgreSQL audit event сохраняется в той же транзакции. Owner/admin — единственные управляющие роли.
- Включение требует хотя бы одного товара или категории; выбранные записи должны быть активными и принадлежать площадке. Exclusion wins при пересечении категорий/товаров. Не вводить бизнес-значения и бюджеты без отдельного решения.
- Финансовый review выявил конфликт tie-break; единая развязка зафиксирована решением L11.6 ниже и покрыта pure QA.
## 2026-10-02 — фиксировать скидку группы при привязке гостя к заказу

- Политика: групповая и одобренная ручная скидки взаимоисключающие; применяется скидка с большей денежной выгодой, равенство отдаёт предпочтение группе.
- Основание: не складывать постоянную льготу и исключительную ручную уступку, сохранять понятное объяснение цены и не переоценивать уже открытый заказ после изменения карточки/настроек группы.
- Групповая скидка фиксируется при привязке гостя: id, имя и ставка. Перенос гостя после первой принятой оплаты блокируется; до оплаты сотрудник может сменить или явно отвязать гостя.
- VIP минимум применяется к сумме после выбранной скидки; бонусы считаются по discounted товарной базе до VIP uplift. При закрытии заказа сохраняется полный ценовой снимок; исторические чеки остаются без реконструированного снимка.
- Область решения: локальная техническая реализация. Пороги/категорийные исключения и бизнес-подтверждение коммерческой политики остаются отдельной задачей.

# Журнал решений команды

## 2026-10-02 — базовые границы payroll-расчёта

- Для каждой строки чека комиссионный сотрудник — тот, кто пробил позицию; исполнитель услуги и открывший заказ не подменяют строкового оператора. Комиссионная база — net конкретной строки после скидок и возвратов, полученный из POS/finance allocation; payroll не реконструирует его и блокирует неподтверждённый источник.
- Закрытый payroll run и выплаченная запись неизменяемы. Поздний возврат учитывается append-only корректировкой следующего открытого run с исходной строкой, refund reference и idempotency; не создаём отрицательную выплату и не удерживаем фиксированную оплату автоматически. Не покрытый будущими переменными начислениями остаток остаётся явно перенесённой корректировкой до отдельного разрешённого финансового процесса.
- Refund adjustment разрешён только после сверки с настоящим line-level refund allocation; в текущем POS такого источника ещё нет, поэтому будущий API до его появления обязан блокировать такие корректировки. SQL дополнительно требует совпадение сотрудника исходной продажи и суммарно ограничивает возврат/void размером комиссии по исходной строке, но эти барьеры не доказывают фактический возврат.
- Milestone bonus — отдельное фиксированное начисление по событию порога вне sales-based дневного cap. Иначе нельзя одновременно соблюдать ТЗ «каждому сотруднику, независимо от продаж» и кэпировать выплаты личной выручкой; dashboard обязан явно показывать бонус и итоговую долю ФОТ/cap breach.
- Основание: явное указание владельца не задавать ему рутинные продуктовые вопросы; выбрать логически/финансово наиболее последовательные правила. Источник: ТЗ зарплатного модуля, ответы владельца о line-net базе и owner-only настройке. Финансовую report/expense интеграцию сверить с MASTER до API/DB интеграции.
## 2026-10-02 — временный профиль бонусов для L11.1

- До отдельного бизнес-решения не менять денежное поведение: курс 1 бонус = 1 ₽, списание до 100% остатка заказа, минимальное списание 1 бонус, бонусы без автоматического срока сгорания; начисление определяется ставкой группы, discounted товарной базой до VIP и округлением вниз.
- Групповые ставки сохраняются без изменений. Будущая глобальная конфигурация должна быть площадочной, версионируемой и аудируемой; изменение действует только на новые заказы. Сгорание нельзя включать одним полем срока без раздельных начислений/сроков и проверяемых обратных движений.
- Это временная техническая совместимость, а не утверждённая коммерческая политика. Владелец должен подтвердить курс, долю оплаты, срок/уведомление и исключения до изменения расчёта. Акции/конфликты скидок рассматриваются в L11.2.


| Дата | Решение | Основание | Кто согласовал | Commit |
| 2026-10-02 | Возвраты и сторно — отдельные неизменяемые записи со ссылкой на исходную операцию, частью суммы, причиной, idempotency key и фактической сменой выплаты. Валютные возвраты считаются в чистую выручку/кассовый отток по дате выплаты; wallet restore не является внешней выплатой. Списанные/начисленные бонусы возвращаются ledger-движением; доступные начисленные бонусы сторнируются, а уже потраченная часть образует удержание из будущих начислений без отрицательного баланса. Закрытый чек не открывается задним числом; броневая allocation сторнируется до возврата исходной квитанции. Выплату может провести только владелец/администратор с finance. | Статус refunded исходного платежа уничтожил бы сумму частичного возврата и портил исторический отчёт. Иммутабельный журнал, остаточный лимит и отдельные payout/refund flows сохраняют аудит и правильную наличность. Уже использованные бонусы требуют удержания, иначе законный денежный возврат создаст несверяемое обязательство либо отрицательный баланс. | Координатор после финансового, системно-архитектурного и code-health аудита | политика этапа 10.1, реализация локальная впереди |
| 2026-10-02 | Предоплату брони разрешено вернуть после полного сторно её активных зачётов; зачёт можно сторнировать целиком только до закрытия заказа. Частичный или полный фактический возврат проходит отдельной квитанцией возврата через открытую смену и роли owner/admin+finance; отмена не запускает выплату автоматически. | Сохранить исходные суммы и аудит; не допустить одновременного зачёта и внешнего возврата одного остатка; отражать наличную выплату в смене, где она реально произошла. Скидка/отмена остаётся финансово прозрачной без автоматического объявления предоплаты невозвратной. | Координатор после finance, system-architect и code-health review | L10.3 локально, migration 069 |
| 2026-10-02 | Зачёт полученной предоплаты брони в заказ — это отдельный тендер `reservation`, связанный с исходной неизменяемой квитанцией и бронью. В зачёте нет нового движения денег и новой кассовой наличности; продажа учитывается один раз при закрытии заказа. Один заказ на бронь, tenant-consistent FK, venue-wide idempotency и аудит в одной транзакции защищают связь и повторы. Отмена блокируется после зачёта; возврат/перенос остаются отдельным этапом. | Повторная запись приёма в кассу или выручку завысила бы денежные итоги; изменяемая/неограниченная связь позволила бы повторное использование предоплаты. | Координатор после системно-архитектурного, финансового и code-health review; PostgreSQL QA | применено на локальной CRM, migration 065 |

|---|---|---|---|---|
| 2026-10-02 | Предоплата брони принимается отдельной квитанцией, привязанной к заведению, подтверждённой брони, открытой смене и сотруднику; максимум до остатка требуемого депозита. Старая `deposit_paid` сумма остаётся неподтверждённой и блокирует новые поступления до сверки. Приём не создаёт выручку заказа и не пополняет денежный счёт гостя; только наличная часть входит в физическую кассу. Отмена не инициирует возврат/зачёт автоматически; квитанция остаётся открытым обязательством до утверждения правил следующего этапа. | Разделить факт денег от старого поля, обязательства и выручки; избежать фиктивной истории, повторного приёма и необоснованного возврата/переноса. | Координатор после архитектурного и финансового review; локальный технический контракт | локально, не опубликовано |
| 2026-10-02 | Пополнение денежного счёта гостя оформляется отдельной квитанцией со способом оплаты и сменой, плюс положительным движением обязательства в журнале. Оно не становится продажей/платежом заказа. При оплате заказа со счёта отдельный `deposit` тендер и отрицательное движение списывают доступный остаток атомарно; наличная сверка включает только пополнения cash. | Деньги, внесённые заранее, принадлежат гостю до зачёта в заказ. Объединение пополнения с выручкой и обычными платежами завысило бы продажи; единый idempotency key защищает от повторного приёма денег. | Координатор после финансового и системно-архитектурного review; временная локальная политика | локально, не опубликовано |
| 2026-10-02 | Временный локальный контракт этапа 3: максимум одна одобренная ручная скидка на заказ; исторические множественные скидки рассчитываются с общим пределом стоимости товаров. VIP минимум остаётся нижней границей итоговой оплаты, а дефицит VIP считается после скидки. Автоматическое применение скидки группы не включается этим пакетом. | Несколько одобренных скидок могли уменьшить итог ниже нуля; расчёт скидок дублировался в память/PG; VIP краткая сводка использовала gross subtotal и расходилась с оплатой. Finance и system architect рекомендовали узкий совместимый пакет без изменения ролей и бонусной базы. | Временное техническое решение координатора; требуется будущая бизнес-валидация | локально, не опубликовано |
| 2026-10-02 | Локальное начисление бонусов при полном закрытии заказа использует процент активной группы гостя. База — сумма товаров после скидки до VIP-минимума; целые бонусы округляются вниз. Ставка, база и результат фиксируются на закрытом заказе и в журнале; старым заказам неизвестные условия не реконструируются. Это технический стартовый контракт, подлежащий подтверждению владельцем бизнеса; денежное списание бонусов до выбора курса/лимита не включать. | `bonus_percent` уже хранится в настройках групп, `loyalty_points` имеет целый формат, VIP-надбавка не является продажей товара. Начисление проводится в той же транзакции, что платёж/закрытие, и не меняет кассовые поступления. | Координатор; продуктовая политика временная, требуется подтверждение владельца | локально, не закоммичено |
| 2026-10-02 | В локальном этапе 5 бонусы можно списывать на оплату заказа по временному курсу 1 бонус = 1 ₽, целым количеством, в пределах баланса гостя и остатка заказа; отдельный процентный лимит временно не задан. Списание, tender, журнал и остаток фиксируются атомарно и идемпотентно. Бонусный платёж попадает в разрез оплат своей смены как безналичный `other`, но не в наличную сверку. База нового начисления уменьшается на списанные бонусы. | Совместимость целого бонусного баланса с рублёвым чеком; защита от повторов и earn-on-spend; сменная аналитика должна содержать погашение закрытого чека, а физическая наличность — только реальные cash tenders. Финансовая политика временная; возврат/лимит и подтверждение владельца остаются следующими решениями. | Координатор после finance и code-health review | локально, не опубликовано |
| 2026-10-02 | При создании брони поле `deposit` означает требуемую сумму. До фактического приёма оплаты новая бронь имеет `deposit_paid=0`; требование и полученные деньги показываются отдельно. Старые записи не переписываются, даже если `deposit_paid` не подтверждён отдельным платежом/движением. | Финансовый review обнаружил, что прежний create приравнивал `deposit_paid` к требованию без cash/card/QR receipt, ledger или shift movement. Нельзя фабриковать поступление или уничтожать неподтверждённую историю; старые строки требуют отдельной сверки. | Координатор после finance и system-architect review | локально, не опубликовано |
| 2026-09-28 | Отменить ограничение, требующее копить до 15 правок и помечать прогресс `1/15`, `2/15` и т. д. Выпускать работу по совместимости изменений, готовности и критериям приёмки; журналировать результат без счётчика. | Владелец прямо отменил правило «15»; фиксированный счётчик задерживает полезный выпуск и не является критерием качества. | Владелец проекта | локальная правка, ещё не закоммичена |
| 2026-09-25 | Главная показывает выручку за сегодня как ведущую метрику, неоплаченные суммы — отдельной вторичной величиной; нижний блок не повторяет показатели первого ряда и не рисует фиктивный тренд. Сетка: четыре карточки на широком экране, 2×2 до 1366 px, один столбец на телефоне. | Оперативная главная должна быстро отвечать на вопросы «сколько оплачено», «что сейчас в работе» и «что требует действия». Текущая страница дублировала эти цифры, а декоративные столбики выглядели как аналитика без данных. | Продуктовая проверка, UX/UI, финансовая логика, визуальный QA | локальная правка, пакет 11/15 |
| 2026-09-25 | Оркестратор CRM — основной Codex в текущей задаче, использующий до трёх нативных субагентов; если делегирование недоступно, роли проходят последовательно. Отдельный постоянно работающий сервис не нужен для текущего процесса. | В проекте уже есть 15 профилей; Codex предоставляет runtime для делегирования. Отдельный сервис потребовал бы самостоятельной эксплуатации, учётных данных и бюджета. Обычная локальная работа должна идти без рутинных прерываний, при сохранении проектных security и release gates. | Решение координатора на основании аудита runtime и workflow | локальная правка, пакет 13/15 |
| 2026-09-25 | Добавить инженера качества кода как 16-ю роль. Он проверяет состояние до и после каждой программной правки и финальный diff перед релизом; новые продуктовые правки остаются у владельцев модулей. | QA и debugger закрывают сценарии и конкретные дефекты, но не имеют закреплённой постоянной ответственности за гигиену изменений и накопление технического долга. Проверка включена в orchestration contract. | Решение координатора по запросу владельца проекта | локальная правка, пакет 14/15 |
| 2026-09-25 | Системный архитектор — единый владелец бокового меню и верхней панели на основных страницах и в режиме сотрудника; визуал, реализация и QA подтверждаются профильными ролями. Регрессионный контракт проверяет общий shell на канонических HTML-маршрутах и базовые размеры шапки. | Общее меню/шапка влияют на каждый маршрут и режим, а прежняя ответственность была разбросана между визуальной и frontend-ролями. | Решение координатора по запросу владельца проекта | локальная правка, пакет 15/15 |
| 2026-09-25 | В боковой навигации склад разделён на две предметные группы: «Меню» (продаваемые позиции и технологические карты) и «Склад» (остатки, пополнение, движения, премиксы и структура хранения). Разделы склада сохраняют выбранный экран в `?view=` и истории браузера. Финансы остаются одиночной ссылкой; премиксы относятся к складу из-за списания компонентов и оприходования выхода. | Старая полоса вкладок скрывала навигацию и не сохраняла экран после обновления; разделение следует рабочему потоку «меню → ингредиенты/запасы → производство». | Системный архитектор, UX и визуальная проверка | локальный пакет 2/15 |
| 2026-09-30 | Направление `orders` ограниченного администратора включает `floor` и право управлять кассовой сменой, включая стартовый остаток. История и сверка смен требуют `finance_read`; направление `finance` читает их, но не открывает и не закрывает смену. | POS уже позволяет операционному сотруднику с `orders/floor` открывать и закрывать смену. Отделение истории и сверки от текущего состояния сохраняет этот рабочий сценарий и не раскрывает его другим направлениям администратора. | Системный архитектор, security review, координатор | локальная правка, ещё не закоммичена |
| 2026-10-01 | Новые списания отслеживаемых заготовок распределяются по партиям FEFO (ближайший срок годности, затем дата выпуска). Старый агрегированный остаток без прослеживаемой партии расходуется первым как legacy pool; прошлые движения задним числом к партиям не привязываются. Отмена возможна только до любых дальнейших движений по позиции и восстанавливает сырьё обратными движениями. | Исходный ledger хранит движения только по складской позиции, поэтому историческую партию восстановить достоверно нельзя. Legacy-first сохраняет равенство общего остатка и партийного, а строгая отмена исключает переписывание уже использованного выпуска. | Системный архитектор, складской домен, инженер данных | локальная правка, ещё не закоммичена |

| 2026-10-02 | Настройки программы и версии акций/областей остаются неизменяемой историей: UPDATE и прямой DELETE запрещены. Удаление истории допускается только как FK-каскад после удаления родительского venue; обычный lifecycle venue — обратимая архивация. Ссылки scope→товар остаются tenant-scoped и запрещают отдельное удаление товара, но deferred NO ACTION позволяет обслуживающей транзакции удалить зависимый товар и затем venue. Снимок заказа продолжает удерживать точную версию акции через RESTRICT. created_by ссылается на пользователя через RESTRICT, поскольку пользователи архивируются мягко, а SET NULL переписал бы immutable историю. | Триггер 073 раньше блокировал и прямые удаления, и заявленный venue cascade; settings вовсе не были защищены. Для QA обход триггеров неприемлем. Архитектурный lifecycle подтверждает soft archive для venue/user и отсутствие штатного hard-delete маршрута. | Системный архитектор, data engineer, security reviewer | миграция 076 и isolated PostgreSQL acceptance |

| 2026-10-02 | Архив цехов, подцехов и категорий — единая обратимая операция; окончательное удаление отделено и доступно владельцу, управляющий отправляет запрос на подтверждение. | До правки API сохранял `is_active=false`, но не давал увидеть или восстановить записи; кнопки были несогласованы, а подтверждение в браузере не является проверкой личности владельца. Текстовые ссылки складских позиций и история не должны удаляться автоматически. | Возвращать архив через статус-фильтр и отдельный POST restore. Удалять физически только архивную запись без зависимостей; manager request записывается в tenant-scoped очередь и владелец решает запрос после повторной проверки ссылок и аудита. Любой конфликт оставляет запись в архиве. | Применено локально к UI, API и миграции; проверить PostgreSQL QA после завершения реализации. |
# 2026-10-02 — L11.6: порядок выбора скидки и безопасная активация

- Округлённая фактическая скидка выбирается по максимальному денежному эффекту; меньшее предложение не выигрывает только из-за priority. При равной скидке promotions упорядочиваются по большему priority, затем по promotionId. Между классами равенство разрешается promotion > guest_group > manual; существующее group > manual сохранено.
- Eligibility промо считается по снимку позиций заказа и их сохранённым unit price; включение — объединение товарных/категорийных условий, исключение товара/категории перекрывает включение. Процент/фикс ограничен суммой подходящих строк; VIP minimum применяется после скидки.
- Единый pure evaluator отдаёт расчёт и причины предложения для POS; закрытый чек фиксирует промо-версию/условия/базу/сумму и перечень offers. Сервер продолжает запрещать активацию до завершения price/report reconciliation и безопасного поведения для открытых заказов с частичной оплатой.
- Bonus, guest deposit и reservation prepayment не являются скидками: их tender-пути не менялись.

## 2026-10-02 — L11.6 first-tender price lock

The first accepted payment fixes the total and complete discount explanation snapshot for that order. This prevents subsequent promotion versions or guest/discount edits from changing an already partially paid balance. Price-affecting edits, guest reassignment, split, and manual discount approval return `409 order_pricing_locked`; note-only edits remain allowed. Refunds do not unlock historical pricing. Migration 075 backfills legacy partially paid active orders. Promotion activation stays disabled until active-campaign PostgreSQL and report reconciliation pass.

## 2026-10-02 — сохранять неподтверждённую legacy-предоплату до сверки

- Найденная старая сумма 1 500 ₽ остаётся исходной записью брони и помечается как неподтверждённая. Не удалять, не менять баланс и не создавать квитанцию без платёжного документа.
- API/история показывают отдельно legacy-сумму, квитанции и возвраты. Погашение или корректировка legacy-суммы допускается только после документированной сверки и отдельного решения владельца.

## 2026-10-02 — статус поиска документов не является платёжным статусом

- Старая сумма брони `deposit_paid` остаётся источником неподтверждённых данных. Результаты `documents_found`, `documents_not_found` и `disputed` описывают только поиск/проверку первичных документов; они не утверждают факт оплаты либо её отсутствия.
- Результат хранится append-only со снимком исходной суммы, последовательностью, actor/time, заметкой, ссылкой на документ, ожидаемой версией и idempotency key. Запись аудита атомарна с событием. Ни статус, ни ссылка сами по себе не меняют денежные поля/кассу и не разрешают новую квитанцию; финансовое разрешение требует отдельного доказательства и решения.
- Основание: в старой записи нет платёжной квитанции/метода/даты/ссылки на возврат. Автоматическое удаление или признание оплаты создало бы неподтверждённую финансовую историю.
- `finance_read` и `finance` — разные grants: finance_read открывает агрегаты отчёта, а не гостевые суммы брони и не право записывать финансовые сверки. Guest-level legacy history и POST сверки требуют owner/admin плюс явный finance scope.

## 2026-10-03 — локальная memory-сверка не подменяет отсутствующие журналы

- Memory-preview считает только показатели, для которых источник данных существует и позволяет подтвердить сумму. Отсутствующие журналы выплат, внешних возвратов и удержаний бонусов возвращают неизвестное значение (`null`), а UI явно показывает недоступность.
- Период продажи определяется только валидным `closedAt`; `createdAt` заказа не используется как замена. Закрытый заказ без даты закрытия отражается как ограничение полноты отчёта и исключается из датированной выручки. Явный `selectedPromotionSnapshot: null` означает «акции не было», а отсутствие снимка остаётся неизвестным.
## 2026-10-03 — payroll owner-approved attendance manifests

- Решение payroll slice: отдельная additive payroll migration 082 сохраняет append-only snapshots/coverage manifest утверждённой посещаемости из закрытых `staff_work_logs` и соответствующих `staff_schedules`. Источник читается tenant-scoped; исходные HR таблицы и routes не меняются.
- Утверждение — отдельное owner-only действие с actor только из live server session, временем, причиной, периодом/venue timezone, revision, idempotency key, source watermark и checksum. Клиент не может передать `approved=true` или присвоить actor. Неполная/неоднозначная coverage блокирует approval; редактирование исходника не переписывает snapshot и требует новой revision.
- Migration 082 ранее была зарезервирована для run→entry. Формально переставлен порядок: attendance идёт до официального расчёта как первичный источник; run→entry номер получит только после появления ready runs и сверки файлов/миграций. Миграции 001–081 не меняются; перед server release сверить реально применённую историю.
- Approval manifest не создаёт calculation run, `payroll_entry`, expense и не меняет POS, payment/refund/loyalty ledgers или сменную кассу. Комиссионное авторство, line discount/refund allocation и Finance turnover остаются отдельными блокерами ready run.
- Основание: миграционный/data и system-architecture read-only reviews; источник требований — payroll architecture/source contracts, migration 021/077/081 и FINANCE_MODEL. MASTER получил синхронизацию, но на технический вопрос ответил только подтверждением локального режима.

## 2026-10-03 — payroll: owner payout ceiling and scenario-only evidence

- Сохранять суммы оклада за смену и milestone без скрытого уменьшения. Если дневной итог выше личной выручки, отмечать critical error и запрещать официальный расчет/снимок; конфликт безусловной премии с абсолютным ограничением ТЗ не считать разрешённым.
- Пока нет авторитетной Finance-семантики полного личного net revenue, pure preview сверяет сумму только с attributed turnover как ориентир. Отдельные `turnoverCents` и `commissionBaseCents` нельзя взаимозаменять; UI обязан называть результат сценарным и не писать «готово к фиксации». Serializer остаётся чистым mapper, его успех сам по себе не является аттестацией источников.
- Для официального run нужны: подтверждённая полная личная выручка после скидок/возвратов, проверенная авторизация строки, распределение скидок, line refund lineage, сменный/цеховой turnover согласно ТЗ и одновременная полнота Finance/POS/approved attendance manifests. Owner acknowledgement для опасной версии схемы остаётся отдельным незавершённым требованием.
- Основание: исходное ТЗ из `C:\Users\ADMIN\Downloads\Telegram Desktop\ТЗ_Гибкий_модуль_расчёта_зарплаты_CRM.md`; финансовая сверка и system-architecture/code-health reviews.

## 2026-10-03 — payroll configuration policy acknowledgement

- Каждая новая или изменённая версия требует явного owner подтверждения политики дневного ограничения. Оно означает понимание риска блокировки расчёта, не разрешение выплатить сумму выше личной выручки и не доказательство безопасности сценария.
- Подтверждение связывается сервером с нормализованной конфигурацией SHA-256, действующим owner и временем PostgreSQL. Metadata хранится в config_json и append-only ревизии 079; повторное сохранение требует нового подтверждения. Активация блокирует строку и сверяет текущий digest, защищая от устаревшего подтверждения.
- Выбран общий обязательный gate для всех сохранений, поскольку без authoritative revenue source нельзя достоверно классифицировать только опасные настройки. Сценарный preview остаётся без сохранения; источник POS/Finance и официальный run не изменены.

## 2026-10-03 — Target/excess and team allocation primitives

- Для режимов ТЗ 5–7 выбран явный параметр `excessRatePolicy`: `replace_base` = round(min(B,T) × baseRate) + round(max(B−T,0) × bonusRate); `add_to_base` = round(B × baseRate) + round(max(B−T,0) × bonusRate). Рекомендуемый исходный вариант — replace_base; ставки/планы задаются владельцем в версии, историческое среднее не выводится из неполного preview.
- Координатор выбрал рекомендованное finance-domain раздельное half-up округление двух компонент. Альтернатива архитектора — одно округление общего числителя — даёт другой результат на долях копейки; она не применяется молча. Отдельный контракт фиксирует различие: 1 копейка до плана и 1 копейка сверх при 50%/50% дают две отдельно округлённые копейки. Эту политику необходимо сохранить в объяснении будущего snapshot.
- Общий фонд распределяется один раз методом наибольших остатков: целые веса, floor долей, остаток по убыванию дробной части и стабильному code-unit ID без localeCompare. Положительный фонд с нулевыми весами запрещён. Индивидуальный cap применяется после распределения без скрытого перераспределения удержанного остатка.
- Реализованные pure helpers не включают режимы в API/UI и не открывают official run. Следующие этапы обязаны сохранить дневную/построчную lineage, отдельную маржу и cost evidence, полный состав командного фонда, версии config и согласованную additive migration; commissionBaseCents не переименовывается в личную Finance-net выручку или маржу.

## 2026-10-03 — Personal target daily interpretation

- Из вариантов личного плана выбран явно дневной ориентир employee/day, поскольку исторические режимы 5–7 сравнивают день/обычный день. Месячный план не подразумевается и требует отдельного scope в будущем. Source label разделяет commission-base scenario и личную Finance-net выручку.
- Позиционная replacement ставка независима от плана: строка исключается из target attainment; additive ставка остаётся в общем target basis. Largest remainder даёт порядок-независимую построчную lineage вместо произвольной очереди строк, оплаченных по повышенной ставке.
- 083 зарезервирована и согласована как payroll-owned migration; POS-команда владеет 084. Official scalar snapshot schema не расширяется фиктивным effective rate: typed target snapshot требует отдельной реализации, текущий serializer явно отказывает.

## 2026-10-03 — Team fund allocation semantics

- Shared pool rates/target/scope are role-level consistent parameters; employee overrides may adjust teamWeight/ordinary wages/caps, never silently define a different common fund. Scope uses explicit department IDs and active roster, not product-name inference.
- Configured weights deliberately apply independently of attendance for flexible owner policy; approved_minutes is the attendance-based alternative. UI spells out this distinction. Zero-weight authors retain fund contribution. Any payout above personal revenue remains critical, not silently capped/waived.
- Team fund payout is separate teamFundCents, with typed day pool/source/recipient evidence. Post-cap remainder never redistributes. Migration085 belongs to payroll, while084 remains POS-owned. Main DB untouched; official typed schema still pending.

## 2026-10-03 — Margin target cost/loss policy

- Margin means net sale revenue minus normalized net total line cost. It excludes payroll/overhead; signed losses offset eligible positive margins within employee/day before rates. Only combined payable basis is clamped at zero. Per-line losses remain visible and reduce positive allocations.
- Item percentages explicitly remain net-revenue based: replacement line excluded from margin target, additive retained and separately paid even for negative-margin day. Both require cost evidence in margin mode to avoid hiding lineage.
- Migration086 is payroll-owned and config-only. Historical cost/refund source and typed snapshots remain required for official payout; caller cost metadata cannot attest that source. JSONB string policy reload bug fixed by accepting node-postgres decoded scalar instead of parsing twice.

| 2026-10-03 | Finance summary and manager reports define revenue as recognized closed sales on the venue-local close date; monetary receipts (cash/card/QR, guest-account top-ups and reservation prepayments) and supported refunds are separate event-date ledgers. Payout coverage is explicit and the UI shows unknown/memory coverage as unavailable. | Reconcile dashboard and X/Z reports without classifying bonus tender or deposit/prepayment liabilities as new sale revenue. Migration 088 now provides the canonical order-level POS payout journal; line-level employee/refund attribution remains explicitly unknown until the immutable line-net contract is implemented. Legacy `payments.status='refunded'` remains unknown coverage. | Координатор после finance-domain, architecture, QA и code-health review | локально, не опубликовано |

| 2026-10-03 | Исходное ТЗ требует фиксировать продавца, пробившего каждую строковую порцию; это обязательный source fact для official payroll. Owner-selected варианты `line_seller`, `order_responsible` и explicit allocation допустимы только как сценарные/будущие policy modes до отдельного утверждённого product decision и не заменяют обязательного line seller. | Исторические конфиги/начисления не переписываются. Сценарный preview может сравнивать варианты с явной provenance; official run остаётся fail-closed при отсутствии line seller, immutable discount allocation или refund lineage. | Координатор после уточнения источников POS/Loyalty/Finance | локально, не опубликовано |

## 2026-10-03 — POS refund and loyalty ledger ownership boundary

- The Finance/Master domain records cash-flow facts: receipts, POS refund payouts, event-date reports and shift-cash impact. Loyalty owns the value rules and liability ledgers for discounts, bonuses, guest balances and reservation prepayments. A POS-order refund payout is not a bonus/deposit reversal and must not be counted twice across those ledgers.
- POS owns order and line facts (product, quantity, seller/time, sale-price snapshot); Loyalty owns the discount decision and its immutable rule/source; Finance owns the external refund payout event. The coordinator selected the line-allocation and cumulative partial-return value contract in `LOYALTY_POLICY_CONTRACT.md` after finance/domain and system-architecture review, under the owner's standing authorization to choose ordinary financial rules. Until that contract is implemented and end-to-end verified, new order refunds stay `unattributed`, old status flags stay unknown, and payroll remains fail-closed for periods with incomplete line facts.
- Payroll owns calculation policy and snapshots; it consumes approved immutable source facts and may not infer missing discount, refund, department, or net revenue values. Payroll migration work can proceed only in payroll-owned files/numbers after the 088 handoff; it does not take ownership of shared POS/Finance routes or ledgers.
- Basis: `FINANCE_MODEL.md`, `POS_SALE_ATTRIBUTION_CONTRACT.md`, current migration/API boundaries and final 088 integration review. No new menu, chat, or duplicate ledger is required.

## 2026-10-03 — Selected line discount allocation and partial item-return value

- The selected best-only group/manual discount is allocated over all merchandise lines; a selected promotion is allocated only over its actual eligible item set. Gross cents reconcile exactly to the stored order subtotal using PostgreSQL `numeric`, then discount cents use proportional largest-remainder allocation with stable `order_item_id` ties. The accepted winner, version, source, eligible item IDs, and each line's gross/discount/net cents are captured atomically with the existing pricing snapshot at the first accepted tender. Later catalog, promotion, or category edits never reconstruct the historical set.
- Partial returns derive item value from that immutable line-net snapshot: `round_half_up(original_line_net_cents * cumulative_returned_qty / original_qty) - previously_returned_item_value_cents`, calculated with PostgreSQL numeric arithmetic at the existing `numeric(12,3)` quantity scale. Full quantity returns exactly the original line net; returned quantity/value are cumulative and capped. External cash/card/QR payout remains a separate Finance fact. Bonus/deposit/reservation reversals remain in their own liability ledgers. Historical rows without line snapshots remain unattributed.
- VIP minimum adjustment is order-level and excluded from seller/item lines. A Finance refund does not automatically create inventory stock. Payroll seller coverage is a separate gate: any unknown seller leaves the order unavailable for employee-attributed source coverage, while Finance can still record fully proven item/quantity/value facts. No code/source adapter is enabled by this decision; local implementation and isolated UI/API/PostgreSQL QA remain required.
- Owners for the future source chain remain POS (seller/line and sale snapshots), Loyalty (discount decision and eligible-set snapshot), Finance (payout and returned item facts), and Payroll (consume verified facts under versioned payroll rules). Existing order-level migration 088 remains unchanged; after its verified final QA handoff, migration 089 is allocated only to payroll-owned milestone-evidence persistence.

## 2026-10-04 — POS item-return source ordering boundary

- Migration 092 adds an authoritative `producer_sequence` scoped to `(venue_id,snapshot_id,order_id,order_item_id)`. It increments only while the existing per-source balance row is locked, in the same transaction as quantity/value update and immutable `previous_*`/`cumulative_*` facts. `created_at` remains business/display time and is not ordering evidence; neither UUID nor insertion ID is chronology.
- Existing 091 events stay `producer_sequence=NULL` with all predecessor/cumulative fields NULL. No sequence is backfilled. The first 092 event starts at sequence 1 and its `previous*` facts may be a known aggregate baseline containing 091 deltas whose internal order is unattested; therefore the post-092 sequence does not establish complete historical chronology. Any official payroll consumer must preserve the legacy boundary and remain fail-closed until coverage and correction policy are independently accepted.
- SQL/API producer DTO fields: `producer_sequence`, `previous_returned_quantity`, `cumulative_returned_quantity`, `previous_returned_item_value_minor`, `cumulative_returned_item_value_minor`; existing `returned_quantity`/`returned_item_value_minor` remain the event deltas. Quantities use scale 3, values are integer minor units, and payout/tender rows remain separate.
- Basis: code-health baseline, data-engineer, system-architect and finance-domain review; disposable PostgreSQL concurrency/replay/rollback acceptance. No payroll-owned reader or official readiness policy is changed by this decision.

## 2026-10-03 — критерий внимания в журнале заказов

- Заказ требует операционного внимания в статусах `open`, `in_progress`, `ready`. Независимо от статуса положительный остаток оплаты определяется только по сохранённому `final_total_snapshot` минус связанные с заказом платежи в состояниях `paid`/`partially_paid`; reservation prepayment учитывается после явного применения как payment.
- Отменённый заказ не помечается как требующий оплаты по устаревшему снимку. Независимый баланс гостевого кошелька не является долгом этого заказа. Закрытый заказ с подтверждённым остатком остаётся видимым как финансовое исключение для сверки, а не утверждением, что нужно повторно списать сумму.
- Основание: `docs/requirements/FINANCE_MODEL.md` §§1, 4, 8; проверки `scripts/order-attention-qa.mjs` и `scripts/orders-attention-postgres-browser-qa.mjs`. Это критерий локального интерфейса; он не меняет бухгалтерские проводки и не означает production-приёмку.

## 2026-10-03 — согласование копеек по строкам в расчёте скидки

- Устранено расхождение, при котором две позиции по 0,5 × 0,01 ₽ отдельно округлялись до двух копеек, хотя subtotal заказа равнялся одной копейке: сумма строки теперь согласуется с subtotal в целых minor units, остаток распределяется по largest remainder с tie-break по `order_item_id`; discount пропорционально раскладывается только на eligible lines выбранного предложения.
- Промежуточный расчёт проверяет ID строк на дубли и fail-closed при материальном расхождении суммы заказа и строк. Все старые правила выбора winner сохранены; evaluator возвращает eligibility IDs и line allocations для следующего source-writer этапа.
- Это исправляет только общий расчёт и его контракт. Денежная точность сейчас остаётся двухзнаковой, как в POS, но `currency` ещё не объявлена в источнике. Код не создаёт durable snapshot и не снимает блокировки official payroll: migration/header/line writer, first-payment+close atomicity, финансовый SQL reader, item returns и явная валюта остаются следующими согласованными этапами.
- Основание: подтверждённый Finance/code review контрпример; `LOYALTY_POLICY_CONTRACT.md` и `FINANCE_MODEL.md`. Проверки: `scripts/loyalty-pricing-qa.mjs`, `scripts/loyalty-pos-explanation-contract.mjs`, payroll pricing evidence/alignment contracts и POS PostgreSQL/browser regression.

## 2026-10-03 — canonical POS pricing snapshot producer

Approved source v1 is explicit `RUB`, scale 2. At first successful tender or direct close, one transaction under the existing venue-scoped order lock writes immutable header and lines; line allocations are the evaluator's stable-ID integer-cent result, while VIP minimum remains header-level. The header is unique per venue/order and line set reconciles to the order's source item count and totals at commit. Post-snapshot order-item update/delete and snapshot update/delete/truncate are rejected. Historical locked/closed orders without the new producer remain unknown and are not backfilled. Finance ledgers prefer canonical values and may use a pre-existing frozen order-level header for historical totals while preserving line evidence as unknown; they do not rebuild old lines from current catalog facts. Payroll remains gated until separate consumer readiness approval.

Basis: read-only system_architect, data_engineer, Finance, and code_health_engineer baseline reviews. This decision does not approve returns, payroll schema/routes, publication, or production changes.

## 2026-10-04 — завершённый локальный стык loyalty pricing → POS → Finance

- Обновление статуса: ценовой evaluator возвращает детерминированные eligible IDs и line gross/discount/net minor units; миграция 090 фиксирует результат при первой принятой оплате или прямом закрытии; миграция 091 добавляет отдельную доказуемую стоимость возврата товара по снимку строки. Устаревшие формулировки ниже по истории о том, что этот producer/return mapping ещё отсутствует, относятся к состоянию до сквозной локальной приёмки и больше не являются текущим статусом.
- Подтверждение в рабочем дереве: `scripts/loyalty-pricing-qa.mjs`, `scripts/pos-order-pricing-snapshot-contract.mjs`, `scripts/pos-role-payment-postgres-browser-qa.mjs`, `scripts/pos-order-refunds-postgres-qa.mjs`; подробные PostgreSQL/browser результаты и изолированная среда отражены в `docs/ai-team/WORK_LOG.md` за 2026-10-03/04. В текущем аудите повторно прошли evaluator, explanation, static snapshot и loyalty progress contracts; PostgreSQL/browser full suites здесь заново не запускались.
- Владение сохраняется: Loyalty — выбор скидки и eligibility; POS — immutable source line/price/seller facts; Finance — payout и товарные возвраты; Payroll — независимый потребитель с fail-closed readiness. 088 payout не равен item value, бонусы/депозиты/предоплаты не дублируются, исторические строки без 090 не восстанавливаются. Ни official payroll run, ни публикация этим статусом не одобрены.

## Складские категории и табачный профиль, 04.10.2026

Для локального inventory-пакета изменена policy пустой точки: существующие и новые заведения получают минимальные редактируемые категории только для имеющихся цехов «Бар» и «Кальяны». Seed запускается миграцией/provisioning один раз по устойчивым ключам; повтор не восстанавливает архивные/удалённые defaults, не переименовывает пользовательские строки и не затрагивает custom категории. Legacy ingredient category backfill выполняется только при единственном совпадении в том же tenant и department; остальные значения остаются в тексте с `category_id=NULL`. Складской tobacco profile ссылается на существующий каталог; упаковка в граммах использует `purchase_unit`/`pack_multiplier`. Alcohol profile остаётся в migration 094. Production и реальные tenant базы не использовались.

## 2026-10-05 — точность сумм приходных строк (#22)

- Выбрана точная десятичная арифметика; сумма каждой строки округляется до копейки HALF_UP, итог документа суммирует округлённые строки. Quantity ограничен хранимой точностью 6 знаков, закупочная цена — 4 знаками; лишняя точность отклоняется без частичной записи.
- Основание: масштабы `inventory_purchase_document_lines` (migration 055 и 038) и финансовая консистентность сохранённой цены с суммой. `Number(...).toFixed(2)` неправильно обрабатывал половину копейки из-за бинарного float; сохранённая `numeric(14,4)` цена также могла расходиться с рассчитанной из исходного значения суммой.
- Реализовано локально в `db.js`, добавлен authenticated API/PostgreSQL acceptance на все поддерживаемые складские единицы, zero/fractional prices, half-cent boundary, over-precision rejection, API→PG→fresh detail/list и отсутствие складского/обязательственного эффекта draft; #22 suite прошёл 130 checks на случайной disposable `inventory_qa_*` базе. Дополнительно исправлена изоляция соседнего payment suite на disposable `orders_qa_*` и его synthetic organization fixture. Production/публикация не затрагивались.

## 2026-10-05 — безопасная политика v1 для сторно прихода (#27)

- По делегированному пользователем выбору утверждён консервативный контракт: при настройке заведения предлагается только полный строгий режим v1; выбранная версия policy фиксируется вместе с приходом при его проведении, а изменение настройки действует перспективно. Проведённый документ остаётся неизменяемым; исправление — отдельная идемпотентная compensating operation с причиной, актором, временем и audit.
- V1 допускает сторно только при доказуемом неиспользованном остатке, отсутствии последующих движений затронутых ингредиентов, полных valuation snapshots, точном обратимом совпадении стоимости, отсутствии оплаты по связанному supplier-payables ledger и атомарной согласованности связанного автозаказа. Фактическую оплату вносят через связанную накладную; общий ручной расход нельзя надёжно отнести к конкретному поставщику. Старые расходы `source='purchase'` без ссылки на накладную блокируют сторно до сверки; новые несвязанные записи блокируют БД и API. Только полный документ; использованное/частичное количество, variance и legacy-приходы без доказательств отклоняются fail-closed. Операция привязана к фактической venue-local дате и ровно одной открытой смене; отсутствие открытой смены и backdating запрещены. Отдельного календарного финансового-period lock в текущей модели нет.
- Для оплаченного/частично оплаченного прихода сторно остаётся выключенным до отдельного supplier-credit/refund ledger; существующие expenses неизменяемы, supplier refund — отдельный фактический cash event. Исторические COGS/order-cost snapshots и текущая weighted-average цена задним числом не корректируются; valuation variance потребует отдельного журнала. Нужны совмещённые inventory+finance права и транзакционные venue locks/audit/idempotency.
- Основание: решение пользователя делегировать выбор координатору; сверка с `FINANCE_MODEL.md`, system-architect, finance-domain и payroll владельцами. MASTER подтвердил отсутствие конфликта с финансовым контрактом и необходимость смены/policy-version gate. Контракт локально реализован в миграции 097 и UI/API/репозитории; authenticated API/PostgreSQL acceptance и отдельный authenticated browser путь `settings → draft → post → reverse → reload` прошли на runner-owned disposable БД. Доработка fail-closed по legacy unlinked purchase expenses отдельно проверяет API и DB guards; физический Fold и production не проверялись. Это не правовое/налоговое заключение.

## 2026-10-05 — контракт количества POS-порций техкарты (#16)

- Для карты продажи ингредиенты задаются на полную партию, `portionCount` задаёт число POS-порций этой партии; заказ количества `q` потребляет `q / portionCount` нормы и получает соответствующую долю COGS. `yieldQuantity`/`yieldUnit` описывают выход партии и сами по себе не меняют количество, продаваемое одной POS-позицией.
- Для premix `yieldQuantity`/`yieldUnit` задают планируемый выход производства; `portionCount` не масштабирует приготовление. Продажа premix-позиции расходует настроенную норму техкарты этой позиции.
- Основание — существующие `recipe-depletion.js`, API стоимости и закрытия заказа, unit contract, а также новый authenticated API→PostgreSQL сценарий: карта 400 мл/4 порции, продажи 1 и 2 порций, остаток 300 и 100 мл, COGS 10 и 20 ₽. Исторические карточки и snapshots не переписываются.
- Дополнительный сценарий прошёл в runner-owned disposable `inventory_qa_*`; runner удалил базу, lock отсутствует, дочерних QA/server процессов не осталось. Это локальное продуктовое правило приложения, не утверждение о бухгалтерской или налоговой норме.

## 2026-10-05 — фильтры даты и статуса накладных (#33)

- Согласованный локальный контракт: диапазон `documentDateFrom`/`documentDateTo` относится только к `document_date` накладной; даты включительны и валидируются как реальные ISO-календарные даты. Изменённый статусный фильтр применяется независимо. При заданном диапазоне `NULL`-даты исключены, пока пользователь явно не включит `includeUndated=true`; без диапазона список сохраняет все документы. Сортировка: `document_date DESC NULLS LAST, recorded_at DESC, id DESC`.
- В реестре расчётов с поставщиками выдаются только `posted`-документы; `paymentStatus=unpaid|partially_paid|paid` фильтрует вычисленный статус оплаты независимо от даты накладной. Дата оплаты не подменяет дату документа и не участвует в фильтре накладных. Поиск поставщика/номера остаётся UI-фильтром.
- Основание — system_architect и finance_domain read-only review, существующее разделение `document_date`/`recorded_at`/`expenses.expense_date`, локальная потребность в работе со старой и недатированной накладкой. Контракт не задаёт налоговые или бухгалтерские правила.
- Authenticated browser/API/PostgreSQL acceptance покрывает сортировку, status+date combinations, inclusive bounds, explicit NULL inclusion, invalid input, tenant-scoped SQL, persistence через reload, reset и mobile layout. Локальные показатели списка пересчитываются по видимому результату. SaaS/production не затрагивались.

## 2026-10-06 — календарная граница финансовых операций (#27)

- Для локальной POS v1 отдельный календарный period-lock не вводится. Финансовая защита обеспечивается неизменяемыми event/snapshot фактами, запретом backdating и выполнением сторно только по текущей venue-local дате при одной открытой смене.
- Любая будущая операция, которая должна корректировать закрытый период, обязана стать отдельным корректирующим событием с lineage; молчаливое изменение исторической записи запрещено. Supplier credit/refund и официальный payroll adjustment остаются отдельными будущими контрактами.
- Это решение закрывает неопределённость о механизме v1 без расширения текущей схемы и не меняет уже подтверждённый fail-closed scope.

## 2026-10-06 — источник официального payroll lifecycle (#21)

- Официальным источником начислений для локальной POS считается PostgreSQL-контур `payroll_entries`: draft → approved → paid/cancelled, с блокировкой пересекающихся утверждённых периодов, аудиторским следом и привязкой выплаченной записи к расходу.
- Demo/memory режим остаётся preview-only и fail-closed: без постоянного реестра он возвращает `null`/`unsupported`, не создаёт фиктивные расходы и не объявляет прибыль подтверждённой.
- Это не ограничивает локальную рабочую систему: рабочая финансовая и зарплатная модель использует PostgreSQL; preview не является вторым источником истины.

## 2026-10-06 — нативный календарь прихода (#30)

- Popup системного `input[type=date]` не является частью DOM-дизайна приложения и зависит от ОС/браузера. Для локальной приёмки проверяются поле, формат, реальная дата, серверная валидация, focus/error/retry и отсутствие overflow.
- Отдельный screenshot нативного popup не является обязательным критерием готовности.

## 2026-10-06 — финансовый scope фильтров документов (#33)

- Обязательный date/status/payment filtering применяется к приходам и расчётам с поставщиками, поскольку эти реестры формируют закупочную стоимость и обязательства.
- Справочные и операционные списки без финансового эффекта не блокируют готовность финансового модуля; их фильтры могут развиваться отдельно.

## 2026-10-06 — локальный набор складских единиц (#17/#23)

- В локальном scope поддерживаются базовые `шт/г/кг/мл/л` и явный коэффициент упаковки/бутылки. Произвольный каталог единиц и универсальные пользовательские конвертации не входят в обязательный контракт POS v1.
- Некорректные или неподдержанные единицы отклоняются fail-closed; текущие recipe/purchase PG проверки подтверждают поддерживаемые преобразования и упаковочные коэффициенты.

## 2026-10-06 — товарные атрибуты POS v1 (#42/#43)

- Атрибуты зависят от товарного профиля: алкоголь и табак используют собственные структурированные карточки, связанные со складской позицией.
- Универсальный runtime-конструктор произвольных полей для всех категорий не входит в обязательный POS v1 scope; неизвестные поля не должны молча влиять на цену, остаток или COGS.

## 2026-10-06 — границы завершения POS v1 (#16/#27/#48)

- #16 считается готовым в поддержанном scope: batch/portion semantics, unit conversion, duplicate ingredient aggregation, atomic shortage rejection, concurrent sale/manual movement guard и premix waste покрыты тестами; новые бизнес-типы потерь без отдельного контракта не блокируют v1.
- #27 считается готовым в консервативном fail-closed scope: сторно разрешено только при доказуемом полном неоплаченном неиспользованном приходе, а оплаченные/legacy/variance/supplier-refund случаи явно отклоняются.
- #48 считается готовым для core inventory маршрутов, которые покрыты authenticated API/UI/PG проверками и tenant/role границами; новые несогласованные inventory-подмаршруты не являются скрытым требованием текущей матрицы.

## 2026-10-08 — FIX-01: политика эффективных прав
- Системный override принят как верхняя граница над развёрнутыми custom/персональными permissions. Legacy personal[]/null наследуют; явные system/custom[] запрещают направления. Нетронутая роль сохраняет точный базовый набор; defaults редактора не становятся скрытым расширением доступа.
- Owner/platform защищены. Bar/hookah helper зависит от orders; diagnostics исходного обладателя зависит отsettings. Источники читаются согласованно с presence flags и organization/venue/active; ошибки не возвращают базовый доступ.
- Принято на основании migration007, подписи системных ограничений в карточке, аудита ROLE01/02/05 и independent security/architect review. Полный контракт docs/architecture/EFFECTIVE_PERMISSIONS_CONTRACT.md. Интерфейсное применение и объяснение потолка принимаются в FIX-02.


## 2026-10-08 — FIX-02: единый источник прав UI
- Авторитетен только свежий /api/session.permissions; базовые role maps сохранены исключительно в явном static demo. UI-only aliases (dashboard/clients/staff view/tasks/role editor) не дописываются в серверный Set.
- Classic portal сохраняет глобалы для расширений; отдельный session bootstrap загружает его после проверки. Изменение identity/venue/role/permissions/policy приводит к одной перезагрузке, исключая stale closures. Ошибка сессии закрывает защищённые элементы до проверки и восстановления.
- Кадровые возможности требуют и permission, и конкретных серверных role/target ограничений. Наличие административного перехода определяется доступными направлениями; название должности не возвращает отозванные права.


## 2026-10-08 — FIX-03.1: приготовление отдельно от финансов
- Мутируемое исполнение хранится в order_item_execution, не в защищённых pricing snapshot строках order_items. Category остаётся категорией; nullable preparation_station задаёт исполнителя отдельно.
- Оплаченные незавершённые позиции остаются в очереди. Готовность не повторяет складское списание и не переоткрывает финансово закрытый заказ.
- Переданные строки нельзя уменьшать/удалять без отдельного будущего процесса отмены работы. Увеличение создаёт новую строку; разделение до оплаты сохраняет ID/исполнение.
- Legacy активные строки backfill только по точным bar/hookah, неизвестные направления назначаются явно; исторические закрытые заказы не реконструируются.


## 2026-10-08 — FIX-03.2: источник актуальности каталога
- Сервер остаётся источником текущей доступности и цены. POS перечитывает каталог при открытии, при возврате к открытому каталогу и с интервалом60секунд только в видимой вкладке. `no-store`, `expectedVenueId`, single-flight и проверка revision сессии/точки отбрасывают устаревшее чтение.
- Ошибка чтения закрывает добавление товара до успешного повтора. Смена цены/архивация не изменяют сохранённые строки заказа; при добавлении цена берётся из ответа сервера.


## 2026-10-14 — универсальное планирование смен (локальный контракт)
- Продолжать текущую ветку `codex/staff-schedule-month-planning`: использовать существующие `staff_schedules`, template/draft/preview/publish lifecycle и audit, не строить параллельный scheduler. Сначала пройти additive migration + recovery на выделенной PostgreSQL.
- CRM access role, рабочая функция (work function) и time preset независимы. Template definition расширяется с versioned-совместимостью старого `{pattern,slots}`; time-only template подставляет выбранным людям одинаковые значения, team template хранит отдельных members с собственными часами/функцией. Вход пользователя не меняет CRM permissions.
- Сохранить grants `view/manage/canPublish`; отдельно добавить owner-issued `canManageSettings` для справочников функций, кадровых квалификаций, правил доступности и покрытия. Владелец всегда администратор собственного графика; admin/manager получают только явно выданные гранты текущего venue. Это не расширяет общие кадровые permissions.
- Серия, availability, demand rules, open shift и функция привязываются к venue и имеют версию/аудит. Для open shift разрешён отсутствующий `user_id` только при отдельном `kind` и обязательной функции/времени; операции публикации остаются в том же draft transaction. Старые записи не получают вымышленных значений.
- Покрытие по умолчанию считает одного человека единицей capacity, даже если он квалифицирован на несколько функций; перекрывающееся двойное назначение не предполагается. Перерывы вычитаются из покрытия только по известному временному интервалу; legacy duration-only break помечается как неопределённость.
- Планирование и публикация не создают фактические логи, кассовую смену, payroll entry или денежное начисление. Внешние уведомления/обмен сменами/автооптимизатор остаются следующими интеграциями без фиктивных состояний UI.
- Проверка формы и прав идёт через текущие server-side role/grant resolvers, tenant-scoped DTO и версии/requestKey. Право просмотра read-only; `canPublish` и `canManageSettings` независимы; overrides конфликтов пишут причину и историю.
- Подробный UI/API/data/error contract и порядок additive changes: `docs/architecture/STAFF_SCHEDULING_CONTRACT.md`. Принято для проектирования и локальной реализации; не является разрешением на GitHub merge/VPS release.

## 2026-10-14 — дополнение stage 04: editable template composition и общий draft lifecycle
- Применение team-template проходит через неизменяемую ссылку на source template ID/version и отдельный редактируемый per-member composition snapshot до preview. Для применения разрешено исключать исходных участников и менять их слоты/функции; нельзя добавлять постороннего сотрудника. Сохранённый шаблон не меняется. Fingerprint связывает template ref, composition, диапазон, draft/base и актуальные проверки; server повторно читает их на apply.
- Пакет применяется целиком: hard conflict отклоняет весь пакет; soft warnings требуют явного подтверждения и причины с аудитом. Preview/apply меняют только существующий draft. Series occurrences и open shifts проходят тот же preview/apply/publish путь; постоянные series/schedule записи и audit links коммитятся вместе одной транзакцией публикации. Для open shift допустим `user_id=NULL` только с отдельным kind, временем и рабочей функцией.
- Маппинг UI→API→authorization→snapshot→readback→QA и открытые вопросы записаны в `docs/architecture/STAFF_SCHEDULING_CONTRACT.md`. Пробелы по шаблонным отсутствиям, частичным конфликтам серий, правкам опубликованных серий, пакетам свыше 200 строк, уведомлениям/ознакомлению и правовым/денежным правилам остаются явно нерешёнными; контракт не вводит payroll или legal policy.
- Это архитектурное уточнение для локальной реализации, не подтверждение готовности функции и не разрешение на GitHub/VPS публикацию.

## 2026-10-14 — stage05 venue policy contract и согласованные определения
- Решения о расчёте согласованы владельцем, а не TBD: недельные суммы используют local-date segments, отдых — elapsed UTC, последовательные дни — даты пересечения, business-hours требуют полного покрытия; сменный break целиком снимается с workDate.
- Stage 05 local implementation findings: shared venue transaction lock serializes policy replace, direct schedule CRUD, and planning apply/publish. Keep a single config read per transaction; do not add nested readers that can observe mixed state.
- Migration106 трактуется как отключённая по умолчанию схема venue warning policy: nullable weekly/rest/consecutive thresholds не активны, отсутствие policy row эквивалентно disabled policy; business intervals применяются только при `business_hours_enabled=true`, и пустой weekday тогда закрыт.
- Policy warnings подключаются к существующим draft range/publish preview → apply/publish, остаются отдельными от hard availability conflicts, требуют явного подтверждения и причины; fingerprints включают полный versioned venue policy/interval snapshot, поэтому изменение config делает preview stale. RBAC использует owner или `manage && canManageSettings` для настроек; planner сохраняет текущие manage/canPublish требования.
- Владелец согласовал: неделя пн–вс по timezone заведения; считаются planned смены, интервальные минуты распределяются по датам, перерыв вычитается из даты начала; отдых — UTC gap; подряд дни — даты локального пересечения; бизнес-время требует полного покрытия. Все правила — advisory, не юридические ограничения. Список business intervals заменяется атомарно целиком; API/DTO/errors — в `docs/architecture/STAFF_SCHEDULING_CONTRACT.md` §5.1.
- Это архитектурный контракт для проектирования stage05, не подтверждение реализации и не разрешение на GitHub/VPS публикацию.

## 2026-10-09 — D-UI012-R6: приёмка исследовательской визуальной базы

UI-01.2 принят по scope D-UI012-R5: 1 080 исходных ячеек и 198 компонентных обязательств, все текущие SHA и собственные role/session bridges сверены. 174 reviewed + 14 documented source defects + 10 narrow source N/A; pending 0. Принятие относится к полноте исследования и доказательств; product/runtime PASS не присваивается. Матрица 6 480 IDs/статусов сохранена для UI09.1.

Conditional appearance допускается только с точными исходными шаблонами/стилями, own receiver baseline, source hashes и отдельным origin/type; без claims реального сохранения, прав, auth, focus-return или timing. Source cursor asset/fallback evidence не утверждает системный cursor bitmap/failure. Нативные validation bubbles фактически появились в сохранённых оригиналах; R7 исключение, разрешённое пользователем, исторически сохранено, но не применяется.

Следующие программные этапы исправляют записанные дефекты по владельцам. UI02.1 разрешён как следующая зависимая задача после принятия UI01.2, автоматически не запускался. Итог/подписи: docs/design/UNIFIED_UI_2026-10-09/UI_01_2_CHECKPOINT_R6.md.

## D-UI021 — 2026-10-09: theme map и compatibility snapshots

Для UI-02.1 приняты отдельные theme-aware --ui-* карты и root-resolved legacy aliases. Глобальная миграция текста старых тёмных островов в light отложена до парной миграции поверхности/текста: иначе возможен тёмный текст на тёмной панели. Восьми прежним invalid-at-computed-value --text декларациям оставлено явное наследование; 23 fallback consumers используют согласованный dark primary. Design lead/system architect/code health согласовали scoped пакет. Удаление aliases возможно только после отсутствия потребителей и проверки обеих тем. Доказательства: docs/design/UNIFIED_UI_2026-10-09/UI_02_1_RESULT.md.


## UI-02.2 — scoped acceptance and staged adoption, 2026-10-09

Новый family применяется только через `.ui-components`; массовой миграции legacy CSS нет. Shared primitive boundary включает geometry/type/states/accessibility/motion, local reference не является production page. Приёмка по51финальной source-bound паре и independent design/QA/codehealth GO; native OS reduced-motion activation открыто передUI09.1, manualactual+parsedCSSOM отдельно. Native collapsed long select truncation documented. Concurrent portal.js copies preserved/excluded. Статус ACCEPTED_SCOPED_WITH_DOCUMENTED_LIMITATIONS; UI03.1 отдельно. Полный результат docs/design/UNIFIED_UI_2026-10-09/UI_02_2_RESULT.md.


## UI-03.1 — desktop shell contract — 2026-10-09

System_architect согласовал >900px: operational210px, management существующий clamp(210px,18vw,280px), shared header/padding. Role marker применяется после verified session и управляет только CSS. Права и действия сохранены. Заголовок маршрута не сжимается раньше длинного заведения; avatar/profile цели44px.

Мобильная переработка и POS saved-theme поведение остаются отдельным долгом. Приёмка:72allowed/8denied основных ячеек,126 итоговых кадров; независимые architect/design/QA/health scoped GO. UI-03.2 автоматически не запускается; release этим пакетом не согласован. Границы: UI_03_1_RESULT.md.


## UI-03.2 — state namespace/search/history — 2026-10-09

Architect согласовал crm_sidebar_state_v2:<verifiedUserId>:<venueId> с{version:2,route,openGroup}; legacyflagsignore, неизвестнаяidentitymemoryonly. SameURLreloadmanual/null; arrivals/historyroutegroup; searchtemporarymulti,clearrestorenormal,permission∩role∩prefs. Не добавлятьtenantqueryко всемanchors. Inventory auxiliaryhashнеопределяетactiveview. Приёмка scoped115frames/VM56; inheritedcontrast/resizerenderdebt/BFcachehit/Fold явноrecorded вUI_03_2_RESULT.md. Исторические evidence не перепривязываются к новым хешам. Publication/UI041 отдельно.


## 2026-10-10 — UI-04.1: примитив окна и границы миграции

Принято: общий custom overlay с одним shared form, явными draft/pending/context policies и разными portal/staffrequired/checkbox adapters. Причина: четырёхкадровый actualbrowser static top-layer опыт показал PINdiv за native dialog; переход всей auth/stack системы превышаетUI-04.1. Staticyield/resume не объявляетсяреальнойPINавторизационнойпроверкой; UI-04.3владелец полногоконтура. Первыйпилот — «Новаязадача»: меньше финансовыхсвязей, пятьстарыхстроковыхполей и неизменныйPOST/readback. Ошибкасохранения остаётсявокне; draftживёттолькоrenderTasks. ТаймерыPOS8–12sявносохранены, полнаяклассификацияошибокотложена. Ранниеstale-hash/wrongtheme/iconкадры вынесенывdiagnostic; frozenматрицавновьснята. ScopedGOархитектора,healthиQAподтверждены;98пар/1044refs/5acceptedwrites. Productionнепубликоватьпоэтомуэтапу. Результат:docs/design/UNIFIED_UI_2026-10-09/UI_04_1_RESULT.md.


## 2026-10-10 — UI-04.2: существующая reservation form в shared shell

System architect согласовал optional mount/validateMounted/onPending/result-onClose с парковкой прежнего DOM, поскольку domain wizard owns steps/identity/validation/payload. Default generated adapters сохранены; финансовые handlers не переносились. Draft только текущего render/entity/context; pending не отменяет API. Focus после readback — stable heading/CTA с current guard и lifetime tabindex до blur. UI043 отдельно проверяет PIN/mixed stack; автоматически запускается по прямому разрешению пользователя.


## 2026-10-10 — UI-04.3

UI-04.3: native PIN устраняет воспроизведённый D05; shared сохраняет custom single-editor и DOM. Общий scroll owner lease предотвращает ранний release при pending. Разблокировка привязана к verified identity/token+epoch; GET session для peer signal не является проверкой PIN. Остальные legacy/finance migrations не расширены. См. docs/design/UNIFIED_UI_2026-10-09/UI_04_3_RESULT.md.


## 2026-10-10 — UI-05.1

UI-05.1: retain C15 permanent selected editor; compact unselected only floor view, preserve density/time/API/financial boundaries. Apply semantic primitives scoped; session-verified theme consumer approved architect. Confirmed busy modal relative loading override fixed narrowly with position:fixed, handlers untouched. Strict 1:1 saved pixels replace provisional scaled/offscreen records as diagnostics; current PIN functional DOM/unlock accepted bounded, overlay pixel limitation explicit. UI-05.2 requires separate request.


## 2026-10-10 — UI-05.2

Use existing C14 primitives, no invented factories. Attached delivery disclosure approved with same form DOM, pending snapshot and focus/draft preservation. Narrow client GET generation+verified context guard approved after reproduced new stale-error overwrite; no business mutations/grants changed. Legacy CSS specificity fixed only affected task/guest semantic consumers. Current empty response fixtures are presentation evidence, not emptyPG claim; old SHA/raster mismatch remain diagnostic. UI-06.1 requires separate request.


## UI-06.1 — итог 2026-10-10

Принят scoped с документированным долгом. Первопричины: read-state перерисовка/устаревший GET, readonly фото, контраст и flex стоимость; первоначально зависшие child loaders при parent error. Исправлены portal/style +точныеdist, права/API/units/payload/frozen business сохранены.35VM,12focused независимоPASS;52Edgeпары и9GUI/GET/PG;5roles30reads20write403,11journals0;health/architect/QA GO. Прежний tobacco regex FAIL явно отделён. Архив и границы: docs/design/UNIFIED_UI_2026-10-09/UI_06_1_RESULT.md. WIP сохранён, без commit/deploy/миграций. Автоочередь заканчивается послеUI061, UI062LunaMedium не начат. Помощники SolMedium, переключение основного чата не заявлено.


## 2026-10-10 — UI-06.2

ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT; три inventory views, source portal40794456/stylec2fd3213, 19 checks/8VM/35regression/13 frozen spans, 52 pairs, GUI3→GET3→PG cost25/stock450+100, role15/denied12. Read-error поиск остатков ранее убирал retry; исправлен short-circuit при state != loaded и добавлена regression. Semantic light inputs/summary исправлены; desktop themes reviewed. Архив docs/design/UNIFIED_UI_2026-10-09/evidence/UI-06.2/acceptance. Production/GitHub не публиковались; UI071SolHigh не запущен. Узкая оболочка, readonly quantity affordance, initial action и Edge detached cleanup документированы.


## 2026-10-10 — UI071 critical pending-close и контекст

Решение: во время финансового/складского POST обычное закрытие/Escape/повтор блокируются до settlement, без abort запроса. При утрате контекста старые финансовые поля скрыты, pending status остаётся; после settlement cleanup. Shared native lifecycle учитывает observer перед queued close, не освобождает leases старым событием после reopen. Mixed payment продолжает следующий tender только в исходном venue/order/auth/access; частичный успех перечитывается у исходного заказа, при смене точки — после возврата. Сохранены бизнес-payload/keys/revisions/server permissions. Неопределённый результат не называется подтверждённым отказом. SourceVM и realAPI/PG доказательства разделены; перечень исключений и следующих владельцев в UI_07_1_RESULT.md. Это локальная scoped acceptance, без разрешения publication либо UI072 auto-start.


## 2026-10-10 — UI-07.2

Разделять продажи, поступления и выплаты по существующим данным; не менять формулы, права и периоды в визуальном этапе. Payroll cancellation использует настоящий submit/Enter; read-state guards предотвращают показ денег старой даты. Полная матрица и публикация сохраняют отдельные этапы. **ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**. [RESULT](UI_07_2_RESULT.md), [REVIEWS](UI_07_2_REVIEWS.md). Scoped semantic finance/report/category/payroll, loading/error/retry/stale protection, keyboard cancellation. 11 focused suites,12 QA conservation,42 final pairs; real API/PG,16 denied actions403,12 journals unchanged. Protected7/source outside finance/CSS outside block unchanged; source/dist exact. Own31969/31970 stopped,IAB closed/viewport reset,PG31954 retained. Full role×theme×state/Edge/WCAG/Fold and recorded GUI cancel PATCH response not claimed. No commit/GitHub/VPS. STOP UI081 — GPT-6.1 Sol / High;15/22 closed,6 remain before publication plus separate Fold.


## 2026-10-10 — UI-08.1

Визуальная миграция admin не меняет ролевую модель/серверные права/расчёты. Пустая custom role отключает направления; role→employee acceptance только isolated. Исторические functional screenshots с прежнимCSS не перепривязываются к новой surface; latest assets проверяются отдельным readonly proof. **ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**. [RESULT](UI_08_1_RESULT.md), [REVIEWS](UI_08_1_REVIEWS.md). 14admin hashes, scoped semantic themes/C11roles/read states; staff3views/5columns/scale retained.9/10focused (inherited CRLF harness FAIL),22VM,12QA,69final current pairs/84historical functional pairs;3GUIwrites/API/PG,16denials403,employee restored,12journals unchanged. Protected8/source boundaries/CSS outside block exact,source/dist equal. Own31971/31972 stopped,IAB closed/viewport reset,PG31954 retained. No commit/GitHub/VPS. STOP UI082 — GPT-6.1 Sol / High;16/22closed,5remain beforepublication plus separateFold. QA formalfile historic; finalfeedback and coordinatorclosure explicit.


## 2026-10-10 — UI-08.2

Сохранить отдельный platform control plane и login C18 fixed-dark. Theme платформы — отдельный storage key; auth/API/tenant/delete guards неизменны. Owner modal sibling устраняет inherited inert; pending/reset/late answers исправлены без расширения прав. Legacy isPrimary checkbox иcredential/reset GUI acceptance остаются явным долгом. Текущие46 и historical53 различаются SHA; не перепривязывать старые снимки. Закрыто scoped;STOP перед UI083,GPT-6 Luna/Medium.
## Премикс как готовый складской компонент

Премикс остаётся физически приготовленной складской позицией. Техкарта премикса закрепляет одну позицию результата; производство списывает сырьё по её составу и приходует готовую партию в эту позицию. Техкарта продажи использует ту же позицию как компонент, поэтому продажа списывает готовую партию по FEFO и не раскрывает сырьевой состав повторно. Неоднозначную историческую связь не угадывать: до выпуска владелец склада назначает позицию вручную.

## 2026-10-17 — категории финансовых источников

Категория — явная аналитическая классификация, а не денежное событие. Зарплатное начисление получает выбранную статью расхода при создании черновика; после утверждения ID и историческое название статьи фиксируются. Единственная выплата по-прежнему создаётся существующим payroll-переходом в `expenses` и несёт ту же статью. Отчёт отдельно показывает начисление за период и денежную выплату по дате платежа; их нельзя складывать как два расхода. Старые начисления и выплаты без стабильного ID остаются неклассифицированными, сопоставление по словам «Зарплата» запрещено.

Проведённая закупочная накладная получает одну явную статью расхода на уровне документа; она обозначает назначение закупки/классификацию связанных денежных платежей, но не превращает стоимость прихода товара в P&L-расход. Все частичные платежи наследуют категорию документа и остаются отдельными фактическими строками `expenses`. Приход товара и оплата показываются в разных разделах отчёта. Старые документы/платежи остаются без категории; сопоставление по строке «Закупка» запрещено. Смешение статей внутри одной накладной в этой модели не поддерживается: до проведения пользователь разбивает закупки на документы по назначению. Категория документа неизменяема после проведения.

Смена вида использованной статьи блокируется ссылками payroll/document/expense; архивирование сохраняет историю и запрещает новый выбор. Категорийный фильтр применяется только к тем источникам, где есть достоверный ID; неразмеченные legacy-источники показываются как неклассифицированные и не притворяются совпавшими с выбранной статьёй. Эта связка не активирует новую payroll scheme и не делает её официальный расчёт готовым.

## 2026-10-17 — разовый бизнес-доход вне POS

Не использовать `payments` (обязателен заказ POS), `expenses` (это денежный расход) или закупочные/зарплатные источники для ручного поступления. Прочий бизнес-доход хранится отдельным документом основания с доходной статьёй, контрагентом, основанием/ссылкой, датой признания и неизменяемой суммой. Проведение документа подтверждает признанный доход по этой дате; факт денег не выводится из проведения.

Поступления хранятся отдельно от документа как append-only события с суммой, датой фактического получения, способом (`cash`, `card`, `qr`, `bank_transfer`, `other`), автором и обязательным ключом идемпотентности. Сумма поступлений не превышает утверждённую сумму документа; частичное поступление поддерживается. Статья должна быть активной и типа `income` при проведении; после проведения ID и имя являются историческим снимком, а последующие поступления продолжают наследовать классификацию документа и после архивации.

Взносы владельца, займы, переводы между своими счетами, депозиты/авансы и предоплаты не являются `business_income` и этим маршрутом не записываются. Они требуют отдельной модели балансовых/обязательственных событий. Исходный проведённый документ и квитанции остаются неизменяемыми; отдельное сторно признания ограничено чистым признанием, а возврат денег связан с конкретной квитанцией и ограничен её невозвращённым остатком. Оба события требуют дату, причину, автора и venue-unique idempotency key.

Отчёт разделяет `otherIncomeRecognition` (проведённые документы по дате признания), `otherIncomeAdjustments` (уменьшения признания по дате корректировки), `otherIncomeReceipts` (фактические поступления по дате денег) и `otherIncomeRefunds` (возвраты конкретной квитанции по фактической дате выплаты). Корректировка признания не создаёт денежный возврат; возврат не изменяет признанный доход. Источники раскрываются по документу и не складываются с POS-признанием, POS-платежами или друг с другом. Банковский перевод считается фактом поступления денег наряду с наличными, картой и QR; способ «другое» не включается в классифицированный денежный эквивалент. Общие итоги прибыли/оборота из этих независимых источников не строятся.

Источниковые таблицы прочего дохода не являются вторым общим кассовым регистром: POS payments ограничены заказом, expenses описывает исходящие события, а unified report остаётся read-only представлением раздельных фактов. Корректировка признания хранится как отдельное append-only уменьшение с причиной, датой события, автором и ключом; возврат денег связан с отдельной исходной квитанцией и ограничен её невозвращённым остатком. Оба события блокируют исходный документ и сохраняют историю. Возвраты не сверяются с кассой/сменой; POS возвраты остаются отдельной моделью.

## 2026-10-17 — признание арендных и иных договорных расходов

Подтверждение обязательства, признание расхода и оплата — независимые состояния. `approved` фиксирует долг, но не доказывает факт оказания услуги. В approved-обязательстве расход можно признать только отдельным действием finance-пользователя: неизменяемая запись с датой признания, суммой и снимками статьи/контрагента/периода. Для аренды предлагается полная сумма в явно выбранную дату (по умолчанию конец периода услуги); автоматического дневного распределения и признания при генерации/подтверждении нет.

`expenses` и связанная выплата остаются единственным денежным событием. В P&L связанные с `finance_payable_payment_links` расходы исключаются полностью; вместо них включаются события признания и отдельные отрицательные сторно по их собственным датам. Срезы показывают исходное признание gross и signed adjustments раздельно. Обязательство/денежный остаток считается только по сумме документа минус связанные оплаты; recognition не меняет долг или cash. Простое изменение суммы/периода проведённого факта запрещено.

Additive migration не заполняет историю автоматически. Approved обязательства без признания отображаются как непокрытие accrual-данных по пересечению периода услуги и явно предупреждают, что общий P&L неполный. Отмена признанного обязательства запрещена до полного сторно; оплаченного — запрещена существующим cash guard. Сторно recognition не возвращает деньги и не уменьшает договорный долг; изменения долга/зачёты/денежные возвраты требуют своих отдельных событий. Ошибки, требующие увеличить сумму сверх исходного обязательства, оформляются новым подтверждённым документом с основанием.

Переход меняет историческую классификацию: старые связанные выплаты перестают быть P&L-расходами по cash date, но отсутствие исторического recognition не исправляется backfill-ом. Отчёты сохраняют cash history и раскрывают legacy coverage gap. В рамках того же пакета обновляются P&L и unified report; добавлять только accrual-таблицу без исключения связанных cash expenses запрещено из-за двойного расхода.

## 2026-10-17 — финансовый отчёт по выбранному заведению

Фильтр отчёта выбирает одно активное заведение организации на запрос и не переключает `auth_sessions.active_venue_id`. Доступный список вычисляется из текущей активной membership/subscription и эффективных прав пользователя для каждой площадки: base/personal/custom scopes с target venue system-role ceiling. В отчёт попадают только роли с `finance_read` или `finance`; операционные роли исключены, а payroll требует target-venue `finance`. Категории перечитываются под тем же target-venue guard. Сырые ID не доверяются, сетевой итог и склейка статей между заведениями не формируются; даты каждого отчёта трактуются в часовом поясе выбранной точки.

## 2026-10-17 — счёт оплаты обязательства и привязка к POS-смене

Миграция 112 и сквозной контракт подключают явный venue-scoped счёт к существующему `expenses` событию оплаты обязательства. Пара «счёт–метод» проверяется сервером и БД; наличная POS-касса требует текущую открытую смену. Оплата блокирует строку смены, как и закрытие, поэтому результат гонки целостен. Cash flow и close snapshot читают тот же расход один раз; связь payable не создаёт второго движения. Исторические расходы остаются unknown. Реестр пока не является банковским остатком: остальные денежные писатели, начальные остатки и переводы не подключены. Поставщицкие возвраты и зачёты требуют отдельного append-only контракта.
## 2026-10-17 — ручной расход: draft, correction, refund

Принято для следующего этапа: существующий `expenses` остаётся неизменяемым источником фактической выплаты. Новый UI не сохраняет «черновик» в него; draft хранится отдельно с venue scope, переживает reload и при проведении создаёт ровно один linked expense. Исправление ошибочных реквизитов после проведения оформляется append-only correction с причиной/автором/временем и исходным ID; реальный возврат денег — отдельный receipt на выбранный денежный счёт и дату получения. Correction не изображает реальный возврат; refund не является продажей и не меняет исходный expense. Простое PATCH/DELETE проведённой строки запрещено. Права записи — `finance`, чтение — `finance_read`; исходники и исторические строки не backfill-ятся по тексту.

Основание: текущая ручная форма сразу вызывает `POST /api/expenses`, а связанные API/отчёты считают эту строку фактическим cash outflow. Разделение защищает денежный журнал, отчёт прибыли и историю. Полный контракт и критерии — `docs/architecture/FINANCE_UNIFIED_MODEL.md`, раздел «Жизненный цикл ручного расхода». Решение реализовано локально для этапа draft → post: миграция 116, отдельные API/UI, tenant/RBAC, DB lifecycle guards и QA. Коррекции проведённого расхода и фактический возврат остаются следующим отдельным этапом.

## 2026-10-17 — идемпотентное создание обязательств

POST для ручного обязательства и нового регулярного правила требует явный idempotencyKey. Сервер связывает venue + тип операции + ключ с fingerprint нормализованного payload и первоначальным ответом внутри той же транзакции, что создаёт документ. Точный повтор возвращает тот же документ; тот же ключ с иными данными получает 409. Естественная уникальность по сумме, названию и датам не вводится, потому что реальные обязательства могут совпадать. UI сохраняет payload и ключ перед запросом, восстанавливает попытку после перезагрузки и очищает её только после readback. Генерация периодов остаётся защищена уникальным ключом правила и месяца.

Follow-up по неопределённому COMMIT: если acknowledgement потерян после фиксации, сервер отвечает `503 finance_create_result_unknown`, а клиент сохраняет ключ и отправляет точный replay при повторе. Это предотвращает новую сущность с новым ключом после неизвестного исхода. API-контракт и fault-injection регрессия включены; UI не снимает pending attempt до readback.

## 2026-10-17 — первая коррекция проведённого ручного расхода

Первая версия исправления затрагивает только сумму и статью несвязанных `manual|other` расходов. Сумма меняется как signed delta на исходной дате/счёте для P&L; исходная строка `expenses` и исходная сумма движения остаются неизменными. Замена статьи переносит эффективную сумму между статьями без изменения общего P&L. Причина, автор, время и полные снимки до/после записываются append-only с ожидаемой версией и ключом идемпотентности.

Payable-linked, purchase- и payroll-расходы принадлежат своим subledger и не могут исправляться общей ручной коррекцией. Коррекция является accounting adjustment: cash flow, ожидаемая наличность и закрытый сменный снимок продолжают показывать исходную выплату без дельты. Отдельная знаковая строка коррекции показывается в P&L на исходную дату; реальный возврат денег — будущий отдельный cash inflow. Изменение даты/счёта и возврат оставлены за пределами этого пакета.

Основание: `docs/architecture/FINANCE_UNIFIED_MODEL.md`, раздел «Контракт первой коррекции проведённого расхода»; финансовая domain-проверка подтвердила знаки дельты и исключения linked sources. Эта запись фиксирует узкий контракт для реализации; полная коррекция и возврат остаются отдельными следующими этапами.

## 2026-10-18 — ручное восстановление пропущенных периодов регулярных обязательств

После простоя генератора финансовый пользователь может выбрать диапазон и проверить каждый полный период до создания черновиков. Подтверждение привязано к снимку правила, версий и существующих документов, создаёт только отсутствующие периоды и безопасно повторяется тем же ключом. Оплаты, признания и статусы существующих обязательств не меняются. Из-за отсутствия истории интервалов паузы фоновое автоматическое восстановление не выполняется; пользователь явно исключает согласованные паузы из диапазона.

## 2026-10-18 — фактический возврат по несвязанному ручному расходу

Локальный v1 допускает отдельное положительное поступление только для точного `source='manual'|'other'` расхода без purchase document, payable link и payroll link. Лимит считается от исходной суммы выплаченного расхода за вычетом прежних возвратов; коррекция расхода не увеличивает лимит. Событие immutable, связано с исходным expense ID, получает выбранные активный счёт и совместимый метод, фактическую дату, причину, автора и идемпотентный ключ. Поступление в POS cashbox допускается только наличными за сегодняшнюю локальную дату при одной открытой смене и попадает в её cash summary/close ledger один раз.

Возврат не меняет исходный расход, не является бизнес-доходом, не создаёт supplier/payable/payroll/inventory-связей и не получает пока P&L-признание. Unified report показывает его как отдельный cash inflow по фактической дате и без фильтра категории; общая аналитика ставит `totalExpenses` и `netProfit` в `null` при наличии возврата за период, сохраняя только отдельные известные subtotal/knownNetProfit. Следующий отдельный финрешающий пакет нужен для выбора даты/знака и утверждения P&L-политики, а затем только можно уточнить обработку неполной аналитики.

## 2026-10-18 — единый отчёт свыше 500 строк

Пользователь выбрал фиксированный серверный снимок на 15 минут с подгрузкой страниц и раскрываемых документов из одного и того же материализованного набора. Все строки, итоги, количества, coverage и basis дат должны происходить из одного `REPEATABLE READ READ ONLY` чтения; страницы используют стабильную сортировку и курсор, повторная авторизация проверяет актуальный доступ к заведению на каждом запросе. Снимок истекает через 15 минут с явным `410`, обновление создаёт новый снимок, а неизвестные/чужие ID не раскрывают данные. Текущая согласованность одного API-запроса не считается реализацией этой функции; требуется отдельная серверная модель хранения и API.

## 2026-10-18 — выбран полный scope балансовых событий

Пользователь ответил «все» на выбор балансового сценария. В scope входят четыре класса: невозвратный вклад владельца; получение займа и возврат principal; атомарный внутренний перевод между счетами; подтверждённый opening balance. Это не означает включение событий в P&L или создание параллельного реестра гостевых депозитов/авансов. До реализации применяются консервативные границы контракта: RUB, без изъятия капитала владельцем в первом пакете, текстовый snapshot кредитора/основания без лишних персональных данных; процент/комиссия отдельно от principal; POS cashbox — только текущая открытая смена с попаданием в её cash snapshot; opening balance создаётся finance-пользователем с документом/основанием. Полный остаток счёта остаётся скрытым при неполном coverage.


## 2026-10-18 — неполный месяц регулярной аренды

Принят явный режим `calendar_days` с включительными датами и HALF_UP по каждой строке в целых копейках (BigInt); default `full_months_only`. Политика неизменяема в рамках правила, ставка версионируется ежемесячно. Due date сохраняет договорный день (с ограничением длиной месяца), но не предшествует началу услуги; окончание услуги не переносит срок оплаты назад. Снимок первоначального расчёта сохраняется отдельно от уточнённой суммы переменного черновика. Количество/цена единицы не добавляются: существующая модель строк — название и месячная сумма; proration не требует расширять её. Архитектурный и финансовый аудиты получены; финальное независимое code-health выполнение недоступно из-за лимита агентов, координатор выполняет review и runtime проверки.


## 2026-10-18 — распределение договорных оплат без нового денежного события

Принят контракт FINANCE_PAYABLE_OFFSETS_CONTRACT: сохранять исходный expense ID на всей цепочке зачётов, не определять допустимость пары по равенству названий контрагентов, показывать явное основание соглашения. Денежный возврат ограничить распределением, оставшимся на исходном обязательстве; для зачтённой суммы сначала обратное распределение. paidAmount/netPaidAmount сохраняют существующую семантику, settledAmount отдельно включает зачёты. Обязателен единый порядок блокировок для исходного/затронутых payable и expense. Реализация и runtime-приёмка ещё впереди.
