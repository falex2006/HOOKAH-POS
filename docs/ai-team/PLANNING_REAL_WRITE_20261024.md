# U2: реальная запись и повтор публикации после потери ответа

Actual owned PostgreSQL/browser gate завершён на exact62b8b9476a0ea79944892088b3363cf1cc3b3b62, продукт frozene50b5a54. Scenario planning отдельно от прежнего attendance69; default attendance path сохранён без удаления проверок. Добавлен только helper и явный выбор WORKTIME_BROWSER_SCENARIO; guard/runner/server/миграции не менялись. Planning JS включён в before/after asset manifest:16 SHA исходных/dist JS/CSS, не прежние14.

## Выполненный путь

На390/1440 реальные owner UI login и создание однодневного будущего плана для syntheticmanager. Create201/SQL1draftv1. Первый PATCH удержан/заменён503 до API: editor locked, forcedsubmit не отправляет вторую запись, SQLoperations0. Неизменённый UIretry реального PATCH200 имеет тот же body/key; SQL1operation/note/version2 и1receipt, live schedule пока отсутствует. Успешная запись с намеренным GET503 показывает savedfeedback; GETretry не выполняет PATCH, note перечитан через editor.

Реальный preview → publicationreason → удержанный POST. route.fetch действительно вызывает backend и получает committed200/publishedv3. Именно этот успешный ответ заменён503 для браузера, который остаётся в окне с прежним reason. SQL уже содержит publisheddraft и ровно1live dayoffrow. Второй UIsubmit отправляет exactsamebody/key/fingerprint/version2; backend возвращает cached200/publishedv3, несмотря на уже изменившиеся state/version. Payload replay сравнен с первым committedresponse. Это модель потери успешного ответа после COMMIT, а не просто pre-request503; другие классы сетевого сбоя и прочие endpoints не заявляются проверенными.

После replay и повторно после настоящего browserreload SQL подтверждает ровно1publicationreceipt,1planningpublishaudit,1livescheduleaudit,1liverow. Draftversion не увеличилась повторно, kind/note/actor опубликованы точно. Reload UI показывает publishedstate без editor/publish actions. Нет синтетического backend storage в этом gate, SQL читается из той же случайной ownedDB, которой пользовался локальный сервер.

## Доказательства и сохранность

- Команда: env WORKTIME_BROWSER_SCENARIO=planning с настроенными PLAYWRIGHT_PACKAGE_PATH/CHROME_PATH, `node scripts/local-full-pg-regression.cjs staff-worktime-postgres-browser-qa.mjs`. Слот явно передан MASTER после payrollterminal96404/cleanup; одновременных DB-прогонов не было.
- Terminal46821exit0, countedchecks50 плюс directdeepasserts, errors[]. Fresh artifacts tmp/staff-worktime-postgres/run-1792790955598-aa2d53/: report.json scenario planning, planning-write-http.json, tested-assets-before.json и actualscreens. HTTPcreate201/v1, save200/v2, actualcommittedpublish200/v3 и replay200/v3 на обеих ширинах.
-16 productSHA совпали до/после. Рабочее дерево product/test не менялось в процессе; testedHead записан. Current scoped report не использует исторические23/69PASS и не заменяет их границы.
- Owned runner DROP randomDB+SQLabsenceassert не дал cleanupFailures, lockfalse после terminal, слот немедленно возвращён MASTER/PAYROLL. Это runner guarantee с terminal0, не отдельный ручной запрос после удаления. Лог tmp/planning-write-pg-terminal.log и sanitized runner log сохранены в архиве.
- Root осмотрел actuallostreply390 и publishedreload1440. MASTER независимо прочитал terminal/report50, пересчитал16SHA, визуально открыл эти снимки, дал boundedactualGO. Подготовительные sourcechecks syntax/diff PASS. Пароли/токены не выводились и не входят в evidence; только синтетические attendance/schedule данные.

## Границы остатка

Проверен ownerdayoffplanning create/save/publish/replay. Настоящие warnings/conflicts/managerdelegatedpublish/foreigncustomACL, шаблоны/серии/range и вся исходная матрица остаются отдельными gate. Component24 покрывает дополнительные UIварианты, но не является DBдоказательством для них. Физический Fold/все ролевые состояния не объявлены завершёнными. Minor visible copy finding: publisheddetail ещё называет историю «предложениями»; это следующий отдельный polish, не переписывать tested62 evidence.

Общий goal не complete. PostgreSQL/VPS production не тронуты, GitHub/VPS не обновлялись; payroll приоритет и loyalty paused сохранены.
