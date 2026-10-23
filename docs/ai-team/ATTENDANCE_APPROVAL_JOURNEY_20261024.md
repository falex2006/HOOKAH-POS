# U2: реальная цепочка согласования — подготовлена, gate не закрыт

Тестовая надстройка над frozen2d849f8b, без изменений продукта. Existing guarded staff-worktime-postgres-browser-qa.mjs вызывает новый staff-attendance-approval-browser-journey.mjs; runner/allowlist/миграции/сервер и payroll не изменялись. Сохраняются прежние schedule/policy проверки; это не повтор exact128f gate, а проверка нового полного UI-стека и ранее непроверенного request→decision→start→end.

План390/1440: реальные UI login owner/manager; policy approval через owner form; manager personal modal, held POST503 и отсутствие SQL-запроса, сохранение причины, samekey retry; SQL ровно1pending; owner held approve, противоположный submit не отправляется; SQL approved/actor/note/version+1; reload queue; manager approvedstart, SQL1session и consumedapproval; reload/selfend/SQLended/noactive. Измеряются границы attendance-page/dialog, а не только document.scrollWidth. Fault503 происходит до SQL и не доказывает uncertain-commit retry. Тестовые аккаунты и БД создаёт owned fixture, пароли не выводятся.

## Фактически выполнено

Первый подготовительный коммит e7d36e16 запущен один раз в явно согласованном окне после PAYROLL terminal/cleanup. Guard42 PASS без БД-мутаций; основной terminal59256exit1, timedOut=false. Завершение остановилось в helper line58: ожидание201 для retryPOSTrequests. Код staff-attendance-routes.js возвращает200 для всех mutation responses, что независимо подтвердил MASTER. Это установленное несоответствие fixture контракту; фактический status failedresponse в первом run не был записан, поэтому иной статус не объявляется исключённым. Этот запуск не PASS, старый23PASS report к нему не относится. Прежние UI-пакеты этим не переписываются.

Runner finally удаляет только принадлежащую ему случайную orders_qa DB, затем SQL проверяет отсутствие; cleanupFailures не было, lockfalse, терминальный handle закрыт. Слот сразу возвращён MASTER/PAYROLL. Логи: tmp/staff-worktime-approval-pg-terminal.log и tmp/full-local-qa/pg-staff-worktime-postgres-browser-qa.mjs.log; новые tested-assets-before.json и approval-request-pending390. Остальные ранее лежавшие там отчёты исторические, не доказательство этого run.

## Подготовлено после failure, ещё не PG-проверено

Ожидание200 соответствует явному серверному контракту, SQL/reason/key/version assertions сохранены. Ответы retry/decision записываются перед assert в attendance-journey-http.json (только synthetic attendance payload, без login/session). Начало held POST имеет bounded10s wait с clearTimeout/finally, не неограниченный Promise. Будущие run имеют уникальный tmp/staff-worktime-postgres/run-time-random; latest-run.json лишь указатель, не PASS. В начале/конце сравниваются14 SHA исходных/published JS/CSS и записывается testedHead. Syntax/diff PASS; MASTER baseline review дал разрешение одному первому запуску и подтвердил статус-контракт. Повтор не запускался без нового окна.

Команда следующего согласованного окна: `node scripts/local-full-pg-regression.cjs staff-worktime-postgres-browser-qa.mjs` с локально настроенными PLAYWRIGHT_PACKAGE_PATH и CHROME_PATH. Требуются final terminal0, свежий report из уникального run, неизменные14assetSHA, cleanup и отсутствие ownedDB/lock, затем visual/diff review. Общий U2/goal не complete; GitHub/VPS не изменялись, production checks запрещены, payroll слот приоритетный, loyalty paused.
