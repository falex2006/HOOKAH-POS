# UI-01.2 — явная поправка gate R7

2026-10-09. **SCOPE AMENDMENT AUTHORIZED BUT UNUSED.** Первоначальная подпись этого документа принимала только scope; итоговая research stage acceptance отдельно записана в FINAL `UI_01_2_CONTRACT_R6.md` после actual native pixels и всех198 terminal dispositions.

## Основание и согласование

Пользователь явно одобрил завершение исследования с двумя названными ограничениями: **«Да, завершить с двумя явно указанными ограничениями»**. Координатор передал точную формулировку и предмет ответа: native validation popup для POS025 и public login029. Источник approval — сообщение человека в основном чате, retrospective coordinator attestation в задании R7; это не вывод из молчания или времени ожидания.

Design предложил `CHECKED_NATIVE_VALIDATION_CAPTURE_LIMITATION` в `UI_01_2_VISUAL_REVIEW_R6.md`. System_architect + QA contract owner ранее отклонил такой terminal outcome при **неизменённом R5**. Настоящий документ явно изменяет это правило только для двух IDs ниже. Architect + QA подтверждают **GO_SCOPE_AMENDMENT_R7** по прямому разрешению пользователя и при сохранении точных доказательств/ограничений. Это не подпись приёмки всех1080/198.

## Единственное изменение R5

Для исследовательской приёмки UI-01.2 разрешён terminal outcome `CHECKED_NATIVE_VALIDATION_CAPTURE_LIMITATION` ровно для:

- `R4VIS-025::one-invalid-field-message-appearance` — собственный POS action form, numeric input min1/value0, native rangeUnderflow/invalid; constraint preempts submit handler. Current own bitmap показывает поле/форму/focus, но native engine popup отсутствует в bitmap capture.
- `R4VIS-029::one-invalid-field-message-appearance` — обычный public login, оба поля пусты, required/valueMissing; constraint preempts sign-in handler. Public role intent не является authenticated session. Current own bitmap показывает форму/поле/focus, но native engine popup отсутствует в bitmap capture.

Каждая строка обязана иметь current JPEG/JSON SHA, inspected own form/field pixels, отдельный read-only validity + точный native `validationMessage` proof, source constraint/handler references, provenance blocked submit без POST, independent design review и QA/architect reconciliation. Proof не включает значения пароля, tokens, cookies или credential entry. Пока exact proof не привязан, outcome остаётся pending по доказательствам.

Outcome принимает **материал исследования с явным capture limitation**, а не native message pixels. Он не является PASS, SOURCE_N_A, product failure, actual unique-message appearance acceptance или доказательством поведения всех validators. Bubble не рисуется и не подменяется unrelated native required popup.

Неполученные native popup pixels сохраняются отдельным обязательным visual follow-up в UI-09.1 с исходными exact IDs, своим будущим capture/review и owner QA + frontend. Там статус **UNVERIFIED_NATIVE_OVERLAY_PIXELS**, не PASS и не N_A. Это именно одобренное изменение прежнего запрета R5 на перенос данных двух mandatory pixel gaps; поправка не называется «неизменённый R5».

## Сохраняемые требования

Все **1080 baseline IDs,42 groups/198 state IDs,6480 exhaustive IDs** сохранены. CSV/history не переименовываются в PASS. Другие196 visual-state obligations и все baseline constraints R5/R4 остаются обязательными: own role/route/session bridge, actual theme/geometry, exact current bitmap/source predicates, narrow approved equivalence/N_A, видимые target regions, независимый review и documented defect ownership. Другие missing/partial representatives не получают terminal capture limitation автоматически.

Исследовательская приёмка возможна только после честных terminal dispositions всех остальных obligations и отдельных final design/QA/architect signoffs, current evidence integrity и coordinator reconciliation. Product correctness, финансовые операции, auth isolation, persistence и release этим документом не приняты.

**Текущее решение:** GO только для принятия этой узкой поправки scope. **NO_GO_STAGE_ACCEPTANCE** до завершения остального review и exact двух proof bindings.

## Последующее обнаружение actual native pixels

После разрешения R7 design независимо обнаружил в **исходных неизменённых JPEGs** оба native popups: POS «Значение должно быть больше или равно 1.» и public login «Заполните это поле.». Координатор подтвердил сохранение screenshot bytes без postprocessing/overlay injection; native-validation-proof.json сохраняет первоначальную ошибочную оценку overlayPixelsCaptured=false как историю и current actual pixel observation=true. Login read-only validationMessage getter остался пустой строкой; текст popup установлен просмотром bitmap, не выдуман из getter.

Поэтому исключение R7 сейчас **AUTHORIZED_BUT_UNUSED / SUPERSEDED_BY_ACTUAL_PIXEL_EVIDENCE** для обоих IDs. При current-SHA design/QA reconciliation эти states закрываются обычным actual native appearance outcome R5, а не CHECKED_NATIVE_VALIDATION_CAPTURE_LIMITATION. Future native pixels для этих exact captured states не переносятся в UI09.1 как отсутствующие. Пользовательское разрешение и поправка сохранены в истории; другие state/behavior follow-ups не меняются. Эта запись ещё не принимает этап целиком.
