# UI-01.2 R5 — independent code health review

## Scope

Read-only initial audit временного ignored processor/helper и текущих evidence index/files. Product, browser, DB, services не изменялись и не вызывались. Full source215 повторно не аудитируется: финальная root/mirror сверка R4 дала0/0 mismatches. Данный report не выдаёт UI PASS.

## P2: исторический focus reject переносится на любой новый raster

В `tmp/ui012-baseline/process-r2-evidence.cjs:120` CAPTURE_REJECTED_FOCUS задаётся tuple platform_owner, /platform,1366x768,dark,keyboard-focus и наличием текста R2-E03 в историческом visual report. JPEG SHA не участвует. Первопричина — глобальный исторический текст используется как актуальное решение для новой evidence; переснятый иной bitmap автоматически останется rejected даже после исправления capture fidelity.

Исходный rejected case `platform_owner__platform__1366x768__dark__keyboard-focus` сохранён в current manifest со SHA256 `b9ceb31b672600dfb2f1a70a17e8b1db44eb7f90ed970ec3152eb9d74f98af10`. Независимый hash текущего JPEG совпал с manifest. Visual review R2-E03 описывает DOM focus/scroll против unscrolled bitmap; это исторический capture defect, не доказанный product focus bug. R1 history не содержит этот R2 case; основание SHA здесь — актуальная исходная R2 пара до пересъёмки.

## Минимальный предложенный patch

Добавить в review-decisions.json `focusRejections` с точным key, указанным old SHA, status CAPTURE_REJECTED_FOCUS и defectId R2-E03. В processor валидировать string key,64hex SHA и точный допустимый status, как для raster/theme/state arrays. Заменить tuple+visual.includes условие на поиск exact filename key и hash текущих JPEG bytes. Сохранять CAPTURE_REJECTED_INTEGRITY при совпадающем focus decision; старое R2-E03 присваивать только совпавшему bitmap. Новый SHA без решения остаётся CAPTURED_PENDING_REVIEW, не PASS.

Для обозримости добавить reviewedFocusRejection provenance и matched/unmatched focus keys в check по образцу raster. Исторический visual текст сохранять как отчёт, без автоматического применения к будущему raster. Сам reviewer processor/decisions не менял; итоговый diff ожидается от координатора.

## Helper v10

R4 проверка одинаковых Boolean credential selectors before/after screenshot остаётся применимой: expanded password IDs охватывают Show/type=text; PUBLIC_AUTH_ROLE_INTENT_ONLY добавляет username; after guard находится после domSnapshot и перед первым write. Секретные значения в metadata/exception не передаются. После guard rejection старые files остаются и требуют корректной пересъёмки/index; transient autofill между наблюдениями остаётся ограничением direct visual review. Нового helper diff в этом R5 исходном аудите не заявлено.

**Initial verdict:** GO для предложенного SHA-bound focus matcher. До интеграции unconditional matcher — P2 evidence-processing defect. Ни продуктовая правка, ни полный UI PASS не требуются/не утверждаются этим review.

## Итоговый focused review интеграции

В текущем processor удалено tuple+visual.includes условие. Добавленная focusRejections validation требует string key,64hex SHA и CAPTURE_REJECTED_FOCUS; matcher требует exact filename key и SHA текущих JPEG bytes. Integrity status сохраняет приоритет. reviewedFocusRejection записывает SHA/defect/reference; check содержит matched и unmatched focus decisions. Старое историческое решение с другим новым SHA не сработает; дальнейший pending review не превращается в PASS. `node --check process-r2-evidence.cjs` — exit0; processor reviewer не запускал.

В review-decisions.json одна focus decision точно соответствует ранее проверенному key/SHA. Current manifest сохраняет CAPTURE_REJECTED_FOCUS с тем же reviewedFocusRejection SHA, matchedFocusCount1/unmatched0. Независимые hashes обеих файлов history-r5 совпали с current manifest screenshot/measurement hashes; историческая пара сохранена до будущей пересъёмки.

Saved checkpoint1151 не изменил классификацию: pending review1135, pending capture3721, supported theme11, state rejection4, focus rejection1, business NA1608, PASS0; deferred0. Продуктового/helper diff не заявлено, browser/DB/API reviewer не использовал. Guard v10 review выше остаётся действительным.

**Final verdict: GO SHA-bound focus processing; исходный P2 устранён.** Это принятие узкой instrumentation правки, не принятие исторического focus raster и не завершение UI-01.2.

## Финальная current evidence сверка после R5 пересъёмки

Текущий platform keyboard-focus JPEG имеет SHA256 `a82e9feb5e79b24cf8b442e3c459c24bad5afaab5182a4f7d0c66991ac864d8d` и CAPTURED_PENDING_REVIEW. Current focus matched0/unmatched historical1: старое решение R2-E03 больше не применяется к новой картинке. Историческая пара остаётся в history-r5. Независимая сверка всех1151 manifest JPEG/JSON hashes дала mismatch0/missing refs0. CSV6480 и index согласованы: pending review1136, pending capture3721, supported theme11, state rejection4, focus rejection0, business NA1608, PASS0. Saved all origins=true, raster mismatch0, deferred0. Это файловая сверка, не live API проверка.

Supplement components-r5 содержит19 JSON и19 существующих JPG pairs. Каждый JSON разобран, actual JPEG header1366×768 совпал с declared raster и CSS viewport; consistent=true у всех19. Для всех before/after URL, viewport, visibleText и nestedScroll совпадают; origins31952, nativeCapture=true. Submitted=true отсутствует. Recursive JSON key scan не обнаружил password/token/authorization/cookie/secret/credential value fields; внутреннее сравнение текстов с известными synthetic fixture passwords совпадений не нашло. Значения секретов не выводились и не записывались в report. Это ограниченная проверка omission по schema/известным значениям, не визуальное утверждение о каждом поле в bitmap.

**Current final verdict: GO для SHA-bound processor и согласованной фиксации1151 с19 supplemental pairs.** Их metadata/raster integrity не доказывает product correctness, полный keyboard flow или visual PASS; прямой visual review остаётся отдельным доказательством. Продукт, browser, DB и сервисы reviewer не менял. UI-01.2 complete не утверждается.
