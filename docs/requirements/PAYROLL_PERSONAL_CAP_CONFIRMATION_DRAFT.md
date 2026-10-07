# Дополнительное подтверждение личного cap

Статус: пакет реализован и проверен локально 2026-10-03. Отдельное подтверждение повышения личного cap выше роли сохраняется сервером вместе с общим подтверждением риска. Не открывает официальный расчёт или выплату.

## Контракт

- Сервер вычисляет исключения из `employeeOverrides` с `mode=override`, `path=cap.rateBps`, где личная ставка выше объявленной ставки роли на включительном пересечении сроков версии, назначения роли и override. Наследование, равные/меньшие ставки и непересекающиеся периоды исключены.
- Дополнительный запрос: `payoutRiskAcknowledgement.personalCapIncrease={confirmed:true,policyCode:'payroll-personal-cap-above-role-v1'}`. Автор, время, digest, ставки, сотрудник и периоды берутся сервером, а не из тела запроса.
- Если исключения есть, create/new-version/PUT без отдельного подтверждения отклоняются `400 payroll_personal_cap_increase_acknowledgement_required` в общей транзакции. Если исключений нет, старый клиент и digest сохраняют поведение; дополнительная запись отсутствует.
- Сервер сохраняет `personalCapIncrease` внутри существующего risk acknowledgement: policyCode, полный configDigest, acknowledgedBy/Name/At и детерминированный список exceptions (employeeId,roleId,path,effectiveFrom/To,roleRateBps,personalRateBps).
- Activation пересчитывает исключения и сверяет сохранённое подтверждение: policy/digest/список/audit. Несовпадение — 409; старый черновик с повышением требует повторного сохранения. Активная история не переписывается.
- UI показывает отдельный условный checkbox, ставки, сотрудников и периоды. Любая правка конфигурации сбрасывает оба подтверждения. Невалидный ввод показывает ошибку проверки, а не отсутствие риска.
- Сравнение процентов при разных cap bases не доказывает большую/меньшую итоговую сумму: предупреждение явно показывает basis. Удаление cap/изменение basis требует отдельной приёмки и не маскируется как подтверждение rate increase.

## Хранение и границы

Первый пакет может использовать существующий object `config_json` и журнал ревизий без миграции. Это должно быть доказано actual PG round-trip и activation tamper QA. Миграции и shared schema/backend не разрешены до handoff POS 088. Payroll не меняет formula cap или абсолютный предел полной личной net выручки.

## Приёмка

Equal/lower/inherit/zero; повышение на 1 bps; смена роли по датам; открытые/граничные сроки; uppercase source IDs; stable sorting; invalid dates/rates; forged request audit; owner/tenant; create/PUT/new-version→PG→reload→revision; rolecap lowering; altered digest/exceptions activation rejection; active readonly; actual browser visible edits reset acknowledgement; отсутствие run/entries/expenses.

## Доказательства

### Следующий пакет: личный cap при отсутствии cap роли

Завершение локальной lifecycle-приёмки 2026-10-03: actual изолированный PG contract PASS (финальный прогон26607 exit0) — save/direct typed PG/read, independent5000/zero/inherit12000/rate10000, полный период вне preview, atomic create/PUT/new-version rejection, cap/milestone errors, capped→uncapped роли, activation missing leaf/active immutability, owner/tenant, zero posting. Mixed-case UUID в assignment/override выявили обход проверки до PostgreSQL; service теперь использует только validation-only canonical copies. Обе стороны регистра, отсутствие мутации caller, scalar required leaf/threshold alias/milestone/cap errors проверены реальной БД. Активный второй продавец сохраняет комиссию1000 при cap/inherit первого; department/day остаётся сценарной базой.

Actual browser contract PASS (85578 exit0): две новые cap карточки→HTTP201→PG→reload с процентом/базой/датами, видимая сумма50 ₽→оба inherit120 ₽→restore50 ₽; partial basis PUT400 с переведённым сообщением и неизменными rows/revisions; отсутствие фиктивного higher-role checkbox/audit; activation readonly и пять ширин. Root визуально проверил375px. Предыдущий cap audit PG, personal scalar PG/browser и15 typed threshold PG regression PASS. Каждый собственный disposable schema/container удалён. Официальные sources/writer/payout и department×shift этим не принимаются; предыдущие RED/ожидание PG ниже — история этапов.

Обновление 2026-10-03: MASTER явно подтвердил bounded file handoff и отсутствие concurrent editor. Реализованы только два разрешённых новых личных листа cap.rateBps/basis, full-window validation, отсутствие фиктивного повышения от baseline0, UI/backend parity и понятные сообщения invalid_personal_cap/invalid_personal_parameters. Service сохраняет отдельный milestone_cap_policy_required. UI source/dist и payroll-only asset revision синхронизированы на rev15.

Фактический прежний RED8/12 переведён в GREEN; расширенный standalone contract — 16 PASS с точными negative codes, несовпадающими starts/expiry вне preview и возвратом к отсутствию cap после одновременного окончания обоих листьев. Cap policy/UI parity, scalar5, inheritance23, threshold/sweep400/15000, семь режимов и UI asset contract PASS; syntax/scoped diff PASS. Code-health final review новых блокирующих замечаний не выявил. Это приёмка чистого расчёта и кода: PostgreSQL save/update/activate и browser→HTTP→PG→reload новой функции ещё не проверены. Ни official writer, ни выплаты не принимаются этим этапом. Описанные ниже RED результаты сохраняются как история исходного дефекта.

Аудит system_architect/domain и code_health_engineer 2026-10-03 подтвердил текущий пробел: collector/UI отклоняют отсутствующий baseline; resolver не создаёт личные cap leaves. scripts/payroll-standalone-personal-cap-contract.mjs — новый диагностический RED, фактический exit1: полный личный cap и явный ноль blocked, collector выдаёт role_baseline_missing. Независимый ожидаемый пример: оклад10000 + комиссия2000, venue turnover20000, личный rate2500 → сумма5000, reduction7000; явный ноль →0; оба inherit → исходные12000. Это сценарные суммы, не официальный источник.

Предлагаемый контракт: отсутствие role.cap означает отсутствие дополнительного процентного ограничения, а не baseline0. Оба личных листа cap.rateBps/basis должны быть полными в каждом dated segment; частичный inherit или несовпадающие окна отклоняются save/update/new-version/activate. При наличии cap роли текущая по-листовая наследуемость и подтверждение повышения rate сохраняются. Отсутствующий cap не создаёт фиктивное исключение повышения; повреждённый существующий cap не объявляется отсутствующим. Department basis использует только существующий department роли; личный cap.department не добавляется. Milestone cap policy и универсальный полный personal Finance-net ceiling сохраняются. Day basis не объявляется эквивалентом обязательного cap цеха за смену.

Диагностическая матрица расширена до 12 случаев: фактический RED exit1, восемь ожидаемых отказов новой функции и четыре проверки существующих ограничений. Дополнительно заданы независимо ожидаемые результаты для существующего department роли, отсутствующего department, повреждённого baseline, uncapped→capped назначения (audit только capped дня), отсутствующей milestone policy и обеих premium policies. При премии1000 inside-cap итог5000, separate-policy итог6000. Code-health review и syntax/diff PASS. Generic blocked в отрицательных случаях неполноты/отсутствующего цеха ещё не доказывает конкретную причину; её требуется закрепить после реализации. Этот RED не является готовностью продукта.

Границы следующего согласуемого handoff: payroll-schemes.js, payroll-scheme-service.js, payroll-personal-cap-policy.js, UI parity helper и targeted payroll assets/contracts. cap.rateBps/basis уже допускает 086; DDL, shared Finance/POS, 089 и source adapters не требуются. Product в этом аудите не изменён; новый тест не является зелёной приёмкой, реализация ждёт отдельного handoff координатора.

`payroll-personal-cap-policy-contract.mjs` и UI parity contract PASS; actual isolated `payroll-personal-cap-postgres-contract.mjs` PASS; существующий payroll PG набор PASS. Browser→API→PG→reload PASS: отсутствие второго подтверждения не сохраняет схему, подтверждение фиксирует серверный список 30%→40%, правки сбрасывают checkbox, активная версия read-only. Live unsaved baseline 50% скрывает повышение, 20% показывает 20%→40%. Source/dist rev9 совпадают; независимый code-health review PASS. Общая готовность модуля не заявлена.
