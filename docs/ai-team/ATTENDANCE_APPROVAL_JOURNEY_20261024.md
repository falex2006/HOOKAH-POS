# U2: реальная цепочка согласования — локальный PASS69

Актуальный результат: исправленный frozen ce4f10b7 прошёл отдельный согласованный прогон terminal61138exit0,69 assertions на390/1440. Свежие отчёт/HTTP responses/снимки: tmp/staff-worktime-postgres/run-1792788719595-e1f953/. Ниже сохранена история первого failure и подготовки; она не подменяет успешный новый run и не расширяет его область на весь U2.

Тестовая надстройка над frozen2d849f8b, без изменений продукта. Existing guarded staff-worktime-postgres-browser-qa.mjs вызывает новый staff-attendance-approval-browser-journey.mjs; runner/allowlist/миграции/сервер и payroll не изменялись. Сохраняются прежние schedule/policy проверки; это не повтор exact128f gate, а проверка нового полного UI-стека и ранее непроверенного request→decision→start→end.

План390/1440: реальные UI login owner/manager; policy approval через owner form; manager personal modal, held POST503 и отсутствие SQL-запроса, сохранение причины, samekey retry; SQL ровно1pending; owner held approve, противоположный submit не отправляется; SQL approved/actor/note/version+1; reload queue; manager approvedstart, SQL1session и consumedapproval; reload/selfend/SQLended/noactive. Измеряются границы attendance-page/dialog, а не только document.scrollWidth. Fault503 происходит до SQL и не доказывает uncertain-commit retry. Тестовые аккаунты и БД создаёт owned fixture, пароли не выводятся.

## Фактически выполнено

Первый подготовительный коммит e7d36e16 запущен один раз в явно согласованном окне после PAYROLL terminal/cleanup. Guard42 PASS без БД-мутаций; основной terminal59256exit1, timedOut=false. Завершение остановилось в helper line58: ожидание201 для retryPOSTrequests. Код staff-attendance-routes.js возвращает200 для всех mutation responses, что независимо подтвердил MASTER. Это установленное несоответствие fixture контракту; фактический status failedresponse в первом run не был записан, поэтому иной статус не объявляется исключённым. Этот запуск не PASS, старый23PASS report к нему не относится. Прежние UI-пакеты этим не переписываются.

Runner finally удаляет только принадлежащую ему случайную orders_qa DB, затем SQL проверяет отсутствие; cleanupFailures не было, lockfalse, терминальный handle закрыт. Слот сразу возвращён MASTER/PAYROLL. Логи: tmp/staff-worktime-approval-pg-terminal.log и tmp/full-local-qa/pg-staff-worktime-postgres-browser-qa.mjs.log; новые tested-assets-before.json и approval-request-pending390. Остальные ранее лежавшие там отчёты исторические, не доказательство этого run.

## История подготовки исправленного повтора

Ожидание200 соответствует явному серверному контракту, SQL/reason/key/version assertions сохранены. Ответы retry/decision записываются перед assert в attendance-journey-http.json (только synthetic attendance payload, без login/session). Начало held POST имеет bounded10s wait с clearTimeout/finally, не неограниченный Promise. Run имеют уникальный tmp/staff-worktime-postgres/run-time-random; latest-run.json лишь указатель, не PASS. В начале/конце сравниваются14 SHA исходных/published JS/CSS и записывается testedHead. Syntax/diff PASS; MASTER baseline review дал разрешение одному первому запуску и подтвердил статус-контракт. Повтор дождался отдельного окна после PAYROLL93333terminal0/cleanup.

## Успешный повтор и точные границы

Команда: `node scripts/local-full-pg-regression.cjs staff-worktime-postgres-browser-qa.mjs` с локальными PLAYWRIGHT_PACKAGE_PATH и CHROME_PATH. Actual terminal61138exit0, no timeout, fresh report69/errors[], testedHeadce4f10b7.14productasset SHA до/после совпали, продукт соответствует frozen2d849f8b; тестовые файлы и docs новее. Fresh HTTPcapture подтверждает200pending и200approved на обеих ширинах, а SQL assertions — reason/одну запись/actor/note/version+1/approved_exception/consumedapproval/ended/noactive. Reload проверен на реальных portal/POS. Manager management403 и foreign policy isolation также прошли; это не все роли/customACL.

Runner finally DROP своей случайной ownedDB+SQLabsenceassert завершился без cleanupFailures, lockfalse; PG слот сразу возвращён MASTER/PAYROLL. Это runner cleanup contract плюс terminal0, не отдельный ручной запрос после удаления. Текущие логи: tmp/staff-worktime-approval-pg-rerun-ce4f10b7-terminal.log и соответствующий sanitized runner log, скопированные в frozen evidence после завершения. Старый report23 в родительской папке не используется.

Root осмотрел approval-decision-pending390 и approval-running-reloaded1440: actual owner portal и manager POS personal modal, bounds/overflow assertions есть на обеих ширинах. Длинное личное окно прокручивается; снимок не означает, что вся история помещается одновременно. Initial503 преднамеренно до SQL: uncertain commit retry не проверялся. Результат дополняет synthetic pending20/20, не заменяет все lifecycle/ошибки/role combination. Общий U2/goal не complete; GitHub/VPS не изменялись, production checks запрещены, payroll приоритетный, loyalty paused.

MASTER independently accepted bounded journey69: fresh report/terminal read,14testedAssets recalculated14MATCH; actual decision-pending390 and running-reloaded390/1440 opened visually. This is independent scoped diff/evidence/visual acceptance, not whole U2 or uncertain-commit retry.
