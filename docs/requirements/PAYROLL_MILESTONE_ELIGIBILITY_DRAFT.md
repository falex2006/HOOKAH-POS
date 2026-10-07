# Условие выплаты пороговой премии

Статус: payroll math, durable089 и owner configuration service/UI приняты локально. Настройка доступна только при наличии storage089; на старой схеме сохраняется409 `payroll_milestone_eligibility_schema_required`. Официальный writer и денежные ledgers не включены.

## Правило владельца

`milestoneEligibility`: `all_active` (прежнее поведение) или `worked_on_threshold_day` (подтверждённые положительные фактические минуты в локальный день первого пересечения порога). Приоритет: личный override → роль → схема → all_active. Наследование не переопределяет роль. `applyMilestones=false` отключает премии независимо от eligibility.

Премия не переносится на следующий отработанный день. Несколько порогов, пересечённых в один день, проверяются отдельно; каждый платится один раз. Порог, достигнутый до начала расчётной половины месяца, не повторяется. Расписание без фактических минут, нулевые минуты, продажи без подтверждённой работы не подтверждают условие. `percent_only` использует факт attendance, даже если оклад/счётчик оплаченных смен отсутствует.

Условие «работал» использует принятый payroll attendance contract. Исходное ТЗ также описывает факт смены по журналу продаж; это не равнозначные источники и не является доказательством исполнения исходного правила оплаты смен. Отдельное согласование факта смены сохраняется в полном чек-листе.

## Пакеты и доказательства

1. Чистый calculator: enum validation на трёх уровнях, первый crossing, положительные approved minutes, dated role/override и cap/revenue invariants. Omission сохраняет legacy формулу и форму результата.
2. При явном выборе — `day.milestoneDecisions`: employee/role, порог, заявленная премия, правило, qualifying attendance IDs, eligible/reason и awarded cents, включая отказы без employee payout row. Новая metadata не должна молча теряться при mapping.
3. Проверки объяснения и detached snapshot mapping: crossing/уникальность/суммы/ссылки; полнота прав требует authoritative scheme/roster/attendance в official writer. Pure DTO сохраняет отдельные дневные `milestoneEvidence`, включая отказы без строки выплаты, и отдельную копию решений сотрудника в `explanation_json`. Для percent_only и отсутствующей строки выплаты требуется независимый attendance context. Omission не добавляет поля старому DTO. Durable089 проверен отдельно; будущий writer обязан сохранить весь дневной envelope, а не только объяснения имеющихся строк. Схема087 сама по себе не доказывает сохранение отказов.
4. Service/UI: optional scheme field сохраняется и входит в digest только при наличии; роль/личное наследование; читаемое объяснение отказа; actual API→PG→reload и browser path. Personal override persistence требует расширить named parameter_path CHECK после handoff088, сохранить все старые пути и replay-safe QA.
5. Официальный writer по-прежнему требует остальные источники продаж/net/refunds/cost и не открывается этой настройкой.

## Приёмка

### Подготовка объяснения в интерфейсе — 2026-10-03

В разрешённом MASTER read-only UI scope renderDetails показывает отдельную секцию day.milestoneDecisions при наличии metadata. Решения не зависят от строк начисления: отказ сотруднику без payout row тоже виден. Показаны threshold/crossing, policy, четыре переведённых reason, declared/awarded суммы до лимитов, approved minutes и ссылки на смены. Это сценарное объяснение; оно не подтверждает источник табеля или право на выплату. Ошибочные enum/types/crossing/award/flags превращаются в предупреждения, а не разрешённую премию. Общее отображение ограничено2000 решений и2000 ссылок на смены; скрытые количества явные, все IDs/имена экранированы.

Actual production renderer contract RED→9 PASS: real calculator all_active/worked/refusal без payout/no catch-up, malformed metadata, escaping, budget и frozen legacy HTML exact parity. Первый refusal fixture требовал добавить нулевые venue days для полного трёхдневного scenario; production validation не ослаблялась. Actual Chrome local DOM fixture пяти ширин PASS и375px визуально проверен; это не API/storage lifecycle. Target/incentive renderer, cap UI, readiness UI и asset contract PASS; source/dist targetedrev16. Runtime409 guard, DDL089, shared files и owner configuration enablement не менялись.

### Подготовка контрольной суммы — 2026-10-03

MASTER разрешил только bounded pure configDigest/optional payload и собственные contracts; DDL089 и runtime activation остаются запрещены. Исправлен найденный пробел: scheme-level milestoneEligibility входит в payoutConfigurationDigest, как уже входили role/person settings. При отсутствии или undefined legacy canonical payload сохраняется точно; explicit all_active и worked_on_threshold_day дают разные hash. Исходная конфигурация не мутируется; порядок UUID/коллекций, даты, false и inherit сохраняют прежние правила.

Новый payroll-milestone-digest-contract.mjs: фактический RED только для scheme-field omission →8 PASS; независимый frozen legacy projection/hash, syntax/scoped diff и code-health final PASS. Реальный isolated PG regression79052 exit0 подтверждает прежний cap acknowledgement/digest/activation tamper и неизменный 409 guard на схеме/роли/личном параметре, без частичных записей; собственный disposable container удалён. Это подготовка контрольной суммы, не разрешение владельцу включить настройку: config persistence/UI, permanent day/refusal envelopes и official writer всё ещё требуют отдельного handoff.

Legacy parity; on/off; role/person/scheme/inherit; positive/zero/missing attendance; percent-only; нулевой оклад; inactive/unassigned; role/date switch; несколько порогов; exact boundary; первая/вторая половина без повтора; без catch-up; обе cap policies; own-revenue guard; malformed/tampered explanation; serializer preservation/refusal; old-schema failure rollback; отсутствие official posting.


### Owner milestoneEligibility configuration — 2026-10-03

Координатор разрешил отдельный bounded service/UI этап после durable089 и pure pricing alignment. Scheme optional field проходит validation→config JSON→load/reload→scenario и digest; роль и личный параметр поддерживают strict enum, даты и inherit (личный→роль→схема→legacy all_active). Пустой control схемы удаляет optional field без изменения legacy digest/HTML. На базе без089 create/PUT/new-version/activation с любым из трёх уровней возвращают schema-required409 с rollback. Наличие таблиц не означает officialReady.

Фактический прогон96309 exit0: node scripts/payroll-milestone-configuration-qa.mjs --postgres —10 pure contracts, configuration PG, actual Chrome UI→HTTP→PG→GET/reload→preview refusal/inherit/restore→activation readonly→new-version/reload, durable089 PG и old-schema personal-cap PG PASS. Дополнительно personal-scalar PG PASS. Проверены invalid enum атомарные400, digest tamper409, RBAC/tenant, даты/expiry и no catchup, отсутствие entries/expenses/runs. Пять ширин1440/1024/768/375/320 без overflow;375 визуально проверен. Source/dist exact и payroll-only rev17; syntax/scoped diff и final code-health PASS, новых замечаний нет. Свой disposable container удалён, QA schemas удаляются с проверкой отсутствия.

Исправлены только QA ошибки: раскрытие day details перед чтением visible decision и проверка точных русских формулировок. Продуктовый renderer и расчётные guards не ослаблялись. Full goal active: authoritative pricing/refund/full-net/cost/department source adapter, atomic official writer и run→entry→expense/payout остаются отдельными интеграциями.
