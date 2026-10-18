# UI-01.2 R6 — независимая итоговая integrity сверка

## Область и результат

Read-only аудит текущих source/hash proof, temporary helper/processor и сохранённого evidence index. Reviewer не использовал browser/API/DB/services, не запускал capture/processor/fixtures и не менял продукт. Единственная запись — этот report. **GO для текущей согласованности instrumentation/evidence processing; блокер не обнаружен.** Полный UI PASS и завершение UI-01.2 этим аудитом не утверждаются.

## Source и локальная изоляция

Proof: `tmp/ui012-baseline/source-hashes.json`,215 записей. Каждая запись сверена через Get-FileHash -Algorithm SHA256 с root файлом и копией `tmp/ui012-baseline/source`. Root mismatch0, mirror mismatch0. Это совпадение с принятой исходной рабочей snapshot, не утверждение pristine Git HEAD.

Mode proof `tmp/ui012-baseline/mode.json`: normal, targets0, samples0. Это чтение управляющего файла, не live health endpoint. `git check-ignore` подтвердил ignored browser-evidence-v10.mjs, process-r2-evidence.cjs, private-runtime.json и credentials.json. Временные секреты не переносились в report.

## Helper/processor

`node --check tmp/ui012-baseline/browser-evidence-v10.mjs` и `node --check tmp/ui012-baseline/process-r2-evidence.cjs`: exit0. V10 сохраняет одинаковые Boolean credential guards до screenshot и после domSnapshot перед первой записью. Раскрытые password IDs и scoped пустой public username включены; значения не возвращаются в Node/log. Nested/document scroll и single chosen screenshot сохраняются. Transient autofill между наблюдениями остаётся пределом guard и требует прямого visual review.

Focus matcher остаётся exact key/current JPEG SHA; историческое R2-E03 не переносится на новую картинку. Integrity rejection сохраняет приоритет; новых automatic PASS условий нет. Старые исследования R4/R5 не повторялись сверх текущей source/syntax/invariant сверки.

## Current index/refs

Proof files: `UI_01_2_COVERAGE.csv`, `evidence/UI-01.2/r2/manifest.json`, `evidence/UI-01.2/r2/processor-check.json`. CSV6480, mapped/captureFiles/manifest captures1151. Независимый hash всех1151 JPG и1151 measurement JSON совпал с manifest: mismatch0; missing refs0.

| Статус | Количество |
|---|---:|
| CAPTURED_PENDING_REVIEW | 1136 |
| PENDING_CAPTURE | 3721 |
| SUPPORTED_THEME_DEFECT | 11 |
| CAPTURE_REJECTED_STATE | 4 |
| N_A_DENIED_BUSINESS_REGION | 1608 |
| PASS | 0 |

Сумма matrix statuses6480. Saved origin assertions all=true, raster mismatch0, deferred0. Business NA67 role-route pairs; baseline/keyboard NA0. Эти integrity counters не являются acceptance всех1151 кадров. Заявленные другим reviewer reconciliation1080+198 следует оценивать отдельно по его критериям; этот audit не присваивает им runtime PASS.

## Credential omission

Внутреннее сравнение1325 текстовых файлов design report/evidence (.json/.ndjson/.csv/.md/.txt/.log) с известными generated password/secret/token/key значениями из приватных local fixture/runtime файлов: совпадений0. JSON parse failures0. Ни приватные значения, ни содержимое environment не выводились. Проверка не включает распознавание bitmap текста и не доказывает отсутствие неизвестного секрета; credential guards/direct visual review остаются отдельными доказательствами.

## Команды и границы proof

Использованы PowerShell ConvertFrom-Json/Import-Csv/Get-FileHash для source и evidence, node --check для syntax, git check-ignore для local exclude и read-only Node fs для внутреннего omission scan. Полные API/DB/браузерные проверки не выполнялись. При будущей перезаписи любого pair нужен новый processor и current SHA сверка; настоящий snapshot1151 согласован на момент этого чтения.

## Incremental checkpoint — real session transport latency

Read-only повторная проверка после добавления ignored `proxy.cjs:7–9` и `real-session-transport-latency.json`. Независимая ветка действует только при exact pathname `/api/session`, method GET и уже полученном реальном upstream 2xx. Разрешены задержки 3000/12000 ms; 0 и иные значения не добавляют задержку. Это конфигурация транспортного времени, а не подмена status/body/identity. POST login, logout, не-2xx 401/403 и business-route response mutation этой веткой не затрагиваются. Query string при exact pathname возможен. Upstream loopback 127.0.0.1:31953, proxy listen 127.0.0.1:31952 сохранены. Logging содержит timestamp, kind, path, upstreamStatus, delayMs; headers/body/credentials не записывает.

Первоначальный новый P2: appendFileSync до response delivery без catch внутри async end мог при FS сбое привести к rejected promise и потере ответа. Передан координатору; текущий source исправлен best-effort try/catch, далее реальная доставка продолжается. `node --check proxy.cjs` exit0; файл/config ignored через git check-ignore. Исправленный код прочитан, сервис не перезапускался этим reviewer; координатор сообщил, что процесс пока со старой веткой, но задержка0. При дальнейшей активации delay нужен запуск исправленного helper владельцем среды. На уровне прочитанного исправленного source **GO incremental instrumentation**, нового блокера нет.

Saved provenance: components-r6/fresh-guard-checking.json notes указывает реальный session2xx delay3000; fresh-guard-service-timeout.json — delay12000, client AbortController10s и отсутствие backend503/authmock. Source portal-session.js:38–51 действительно создаёт checking guard и управляет Retry; :93–94 abort через10000ms. Это проверка согласованности объяснения/source/saved metadata, не live network proof или прямой визуальный review. Метаданные пока называют state keyboard-focus; финальная компонентная семантическая аннотация остаётся следующему reviewer.

Повторные source hashes:215 root/mirror, mismatch0/0. Manifest1151 JPG/JSON hashes mismatch0, missing refs0. Parse всех1366 JSON в design report/evidence: failures0. Внутреннее сравнение1412 текстовых файлов с известными приватными password/secret/token/key строками длиной>=8: matches0, значения не выводились. Не покрывает неизвестные/короткие секреты и bitmap OCR. Supplemental components11 + r4=5 + r5=19 + r6=83 JPG имеют одноимённые JSON, missing0; это file pairing, не финальное принятие198 component requirements и не semantic metadata acceptance.

На момент этого чтения latency config delayMs0; **mode.json=empty**, targets `/api/floor`, `/api/staff`, `/api/platform/organizations`, samples0 (changedAt2026-10-09T14:55:59.077Z). Координатор подтвердил намеренный текущий сбор трёх empty сцен. Предыдущая normal запись в отчёте — исторический checkpoint; итоговое восстановление normal пока не подтверждено. После последней capture нужен отдельный read-only checkpoint normal/targets0/samples0/delay0 и текущих refs; текущим разделом final environment restore не заявляется.

## Incremental checkpoint — source-rendered conditional previews

Проверены ignored `build-source-previews.cjs`, `source-preview-server.cjs`, все8 generated HTML, provenance и8 сохранённых source-preview JPG/JSON pairs. Только чтение файлов/hash/syntax; browser/API/DB/server не запускались. **GO для исправленного builder/server как conditional appearance instrumentation**. Runtime поведение, роли, native modality и UI PASS не утверждаются.

Новый первоначальный P1: сервер разрешал любой `[-a-z]+.html`, включая raw template HTML со script tags, без response CSP. Это обходило границу preview, если открыть raw template URL. Координатор исправил whitelist из8 provenance records и authoritative response CSP: `script-src 'none'; connect-src 'none'; form-action 'none'`. Текущий сервер слушает только127.0.0.1:31956, допускает GET и только exact record filename, проверяет resolved parent directory. Правка source прочитана; live restart/HTTP proof reviewer не выполнял. CSP допускает CSS/fonts/images из isolated31952, inline styles и data assets; script/media/form/API запрещены. Существующие links не удалены: ручная навигация по ним могла бы покинуть preview, поэтому ограничение относится к сохранённой scene, а не к произвольным действиям пользователя в ней. Whitelist/provenance остаются доверенными локальными generated файлами. Synchronous parse/read не имеет fallback при FS сбое: это availability limitation временного local helper, не расширение origin/API прав.

Новый первоначальный P2: `<use href="/assets/tabler-icons.svg#x">` с base31952 на preview31956 мог терять SVG из-за cross-origin external-use ограничения. Исправлено inline exact original symbol contents; source hash `assets/tabler-icons.svg` добавлен в provenance. Close x теперь содержит ровно исходные2 path (`M18 6l-12 12`, `M6 6l12 12`), внешний SVG fetch для него не нужен. CSS links и enclosing SVG classes сохранены. Из8 HTML осталось18 use nodes для receipt-2/edit/activity: эти symbols отсутствуют в исходном sprite, поэтому builder оставляет их без выдуманного изображения. Это исходное ограничение template/sprite, не новая потеря builder. Exact-inline scan имел18 unresolved symbols именно этой причины; не интерпретируется как18 потерянных существующих symbols.

Native dialog adapter сохраняет source CSS, measured backdrop background/filter и центрирует open dialog через explicit fixed overlay. Он не воспроизводит native top layer/inert/focus trap/showModal interaction. Добавление error текста законно меняет высоту при source CSS, потому перенос исходного measured rect как неизменного geometry не требуется. Provenance фраза «same ... centered dialog semantics» читается только как appearance; runtimeBehaviorTested=false обязателен. Reservation pending воспроизводит disabled controls/close и label; dataset.submitting и outside #focus-reservation runtime state не полностью воспроизведены. Login pending очищает значения ради omission, тогда как runtime pending не очищает их. Эти явные appearance пределы исключают полный runtime branch proof.

Source branches сверены с lock.js validation/generic-save-catch/pending idle-label, platform.js owner-validation-catch/create-pending label, login.js pending text/label, portal.js reservation submit/syncFormMode. Generated current HTML: scripts0, quoted/unquoted event attribute scan0; preview SHA/template SHA/source SHA mismatches0. Все8 records включают appearance-only, sessionRole NONE, runtimeBehaviorTested=false, credentialEntry=false. Synthetic login-long identifier является искусственной visual строкой, не account или credential. Regex очистка не универсальный sanitizer произвольного HTML; current trusted templates прошли scan, а CSP служит независимым ограничением.

Proof provenance checkpoint `2026-10-09T15:26:08.444Z`, SHA256 `b2f8df9ce0fbdd8009aa4d704e98eb07a458cc64725b95ab7cbd5bdd05834054`. По времени этого чтения pin-invalid/platform-error/platform-pending/reservation-pending уже имеют newer captures. Pin-error/pin-pending15:25:22/23 предшествуют SVG rebuild, поэтому их текущие pixels не подтверждают исправление close; координатору передана рекомендация переснять. Login shots тоже старше rebuild, но SVG0; без recorded per-scene previewSHA их неизменность на момент capture независимо не доказана. Metadata содержит ссылку на mutable provenance path, а не pinned per-capture HTML/provenance hash: сохранить current hashes в final ledger рекомендуется. Само наличие JPG/JSON pair не считается visual acceptance.

Повторная source215 proof: root mismatch0, mirror mismatch0. Manifest1151:2302 JPG/JSON refs, missing0, SHA mismatch0. JSON design+preview1389 parse failures0. Text evidence/report/preview1447 files сравнен с известными private password/secret/token/key строками длиной>=8: matches0, значения не выводились. Scan не покрывает неизвестные/короткие secrets и bitmap OCR. Generated HTML input values очищены, кроме explicitly synthetic login-long. `node --check` builder/server exit0; `git check-ignore` builder/server/provenance confirmed. Продуктовые исходники не изменены этим reviewer.

Restore checkpoint: mode.json normal, targets0, samples0, changedAt2026-10-09T15:13:14.656Z; latency delayMs0. Это file-state proof, не health endpoint. Предыдущий empty checkpoint выше исторический. После новых captures сохраняется необходимость current refs/metadata reconciliation; ни финальное принятие198 component requirements, ни завершение UI-01.2 этим разделом не утверждается.

## Incremental implementation — additional isolated source previews

По отдельному поручению координатора создан и локально выполнен только ignored `tmp/ui012-baseline/build-additional-previews.cjs`. Он добавил8 HTML/records к preview whitelist provenance: inventory-purchase-long, inventory-movement-long, status-success, status-warning, status-danger, preferences-toast-long, staff-cursor-fallback, cursor-assets. Первые8 stable records и их bytes/hash защищены preflight и сохранены; исходный builder/server и продукт не правились. Browser/API/DB/services не использовались.

Inventory purchase/movement markup извлекается непосредственно из source template literals drawPurchaseDocuments и movement-row. Выполняются только отдельные reviewed pure formatting definitions и literals через локальный Function, приложение не импортируется. Synthetic19 purchase docs (draft/posted/voided labels) и19 positive/negative movement rows существуют только в HTML. No posting/reversal/DB/API; purchase canWriteInventory=true и canReverse=false явно обозначены appearance assumptions, не доказательство реальных permissions. Replacement ищет balanced receiver element boundary, сохраняет outside DOM. Проверены row counts19/19 и div balance0. Все filenames фиксированы builder; input/textarea values, scripts/events очищаются; source SVG exactinline и CSP original restrictions сохранены.

Telegram success/warning/danger используют исходные status/note/help тексты и классы исходного receiver. Neutral отсутствует в этой ветке и не синтезирован на integrations; отдельный actual floor-editor-count остаётся самостоятельным evidence. Toast использует portalNotice div/id/class/data-kind=error с самым длинным actual preference failure сообщением про финансовые показатели и exact unverified-read suffix restoreFailedPreference. Timer4200ms заморожен ради appearance, prefs write/read behavior не проверяется.

Staff raw receiver имел staff-theme floor view без staff-red-cursor. Builder явно добавляет только исходный conditional role class (bartender/hookah_master) ради selector appearance; sessionRole NONE сохраняется. Six fallback variables переопределены на исходные auto/pointer/text/grab/not-allowed/wait; требуются browser computed-style proofs на соответствующих receiver controls. Отдельный cursor-assets record имеет type SOURCE_CURSOR_ASSET_AND_FALLBACK_DECLARATION_ONLY:6 exact source SVG dataURL, decodedSVG/declaration SHA и fallback keywords. Gallery labels служат индексом assets; OS cursor, pointer predicate, изображение настоящего cursor и failure behavior этим не доказываются. Fine-pointer media condition по-прежнему берётся из source CSS.

Verification: node --check exit0; builder run success8new/stable8; total provenance16records preview hash mismatch0, scripts0/events0/input-value attrs0 в8newHTML. Source215 root/mirror mismatch0/0. git check-ignore подтвердил новый helper. Runtime PASS отсутствует; capture/direct design review выполняет координатор после этого checkpoint. Повторный запуск обновляет только собственные8 preview records/files, удерживая остальные записи; preflight всех сцен происходит до первого write. Запись пары HTML/manifest не transactional при FS failure, поэтому source/hash integrity check обязателен после каждой сборки. Новых production/DB действий не было.

## Final freeze checkpoint — research package/source hygiene

**GO_RESEARCH_PACKAGE_SOURCE_HYGIENE** на текущем сохранённом checkpoint. Это независимый read-only integrity результат, не product/UI PASS, не завершение всех UI acceptance условий. Source215 root и isolated mirror совпадают с исходной snapshot: mismatch0/0. Reviewer не выполнял API/DB/browser/server mutation, capture, processor или bitmap processing.

Main manifest1151 captures/2302 JPG+JSON refs: missing0, current SHA mismatch0. CSV6480:1136 CAPTURED_PENDING_REVIEW,3721 PENDING_CAPTURE,11 SUPPORTED_THEME_DEFECT,4 CAPTURE_REJECTED_STATE,1608 N_A_DENIED_BUSINESS_REGION; PASS0. Независимое чтение5518 непустых CSV evidence/measurements refs: missing0. Эти сохранённые статусы не превращены в product acceptance.

Immutable source preview package теперь находится в `evidence/UI-01.2/r2/components-r6/source-previews`, содержит16 sanitized HTML и provenance SHA256 `6539801b6a94b71c572dd510884d9536295b82c11407a6ce0b402acd85afe9c1`. Все16 HTML hashes и source hashes совпали; scripts/events0. Все16 capture JSON прикрепляют exact current sourceRecord, appearance/asset evidenceType, relative immutable preview/provenance refs и SHA; record/type/hash mismatch0. RuntimeBehaviorTested=false, credentialEntry=false, sessionRole NONE сохранены. Mutable tmp provenance limitation ранее описанного checkpoint закрыта pinned retained package/metadata. Pin-error и pin-pending пересняты15:27:25/26 после inline SVG fix; первоначальное stale issue закрыто этим обновлением.

JPEG SOF dimensions независимо прочитаны из16 original source-preview raster files: mismatch с JSON raster0. Cursor assets1351×817 при CSS viewport1366×768 прямо отмечен rasterIsViewport=false/fullPage content raster, поэтому viewport/responsive claim отсутствует. Exact6 cursor assets и fallback declarations по-прежнему scoped source asset appearance, без OS cursor/failure/runtime claim. Native dialog adapter пределы (top layer/inert/focus behavior) и synthetic rows/prefs timer остаются явно appearance-only.

Native validation proof SHA256 `3ef7b6b35c853c607d2ecf6bc2b6217d173f66b6142f6fc2132330d162569f95` сохраняет overlayPixelsCaptured=true и originalOverlayPixelsCaptured proof при пустом native validationMessage getter и empty required inputs. Не требуется менять getter proof ради direct bitmap. Прямое наличие browser bubble в originals независимо просмотрели design и координатор; этот code-health этап проверяет metadata согласованность и не заменяет их visual review. Provenance сохраняет original CUA bytes/no manipulation/no injected overlay; reviewer bitmap не обрабатывал и не пересоздавал.

Supplemental current pairs156 JPG/JSON, missing JSON0. Aggregate current inventory SHA256 `64a59a0a7a1c10dfa54fbd0366d135a8836107903694f61d99bec838726dfcb4` получен SHA256(JSON.stringify(sorted records {file, jpgSHA256, jsonSHA256})) с workspace-relative paths normalized slash и localeCompare sort. Это freeze fingerprint, а не direct acceptance156 pictures. JSON1410 parse failures0; text1473 (.json/.ndjson/.csv/.md/.txt/.log/.html) known private password/secret/token/key length>=8 matches0. Значения не выводились. Unknown/short secrets и bitmap OCR не покрываются этим omission scan.

Syntax exit0: browser-evidence-v10.mjs, process-r2-evidence.cjs, proxy.cjs, build-source-previews.cjs, build-additional-previews.cjs, source-preview-server.cjs. Mode file normal, targets0/samples0, changedAt2026-10-09T15:37:13.116Z; latency delayMs0. Это final saved-control-state proof, не live health endpoint. Новый blocker source/evidence processing не найден. При последующей перезаписи capture/metadata нужны новые current SHA/refs; текущий отчёт не предрешает design final findings или runtime acceptance.
