# UI-01.2 R2 — targeted review evidence processor

2026-10-09 · `code_health_engineer`. Read-only просмотр `tmp/ui012-baseline/process-r2-evidence.cjs` и независимая сверка текущих manifest/check/CSV. `node --check` — exit 0. Processor reviewer не исполнял, R1 matrix не перезапускал, API/данные/source не менял. **Verdict: обработка пригодна для индексации непринятого evidence; UI PASS и N/A не выдаются.** Результаты относятся к снимку из 265 captures; сбор продолжается.

## Подтверждено

- CSV проверяет обязательные columns при доступе, одинаковую длину строк, 6 480 case IDs и уникальные role/route/viewport/theme/state tuples. Applicability связывается с 36 URL. Unknown tuples и incomplete JPG/JSON попадают в deferred; auxiliary JSON не принимается за capture.
- Настоящие JPEG dimensions вычисляются из bytes; hashes относятся к сохранённым JPG/JSON. Captures не принимаются автоматически по `consistent`; manifest явно отделяет role gate, visual и state acceptance. Stock route normalization выделена отдельно, final URL и requested URL сохраняются.
- До mapping очищаются старые dimension/evidence/permissions/defect fields. R1 capture index копируется отдельно; прежний CSV сохраняется один раз. Старый R1 finalizer не запускается. Output writes используют temp file/rename для каждого файла, unchanged text не перезаписывается.
- Сохранённый снимок: 6 480 строк/уникальных IDs, 265 manifest captures и processor mapped 265; 261 `CAPTURED_PENDING_REVIEW`, 3 `SUPPORTED_THEME_DEFECT`, 1 `CAPTURE_REJECTED_FOCUS`, 6 215 `PENDING_CAPTURE`. PASS 0. Независимая сверка всех capture refs и SHA256: missing 0, mismatches 0; manifest/CSV status mappings: mismatches 0; deferred 0.
- Requested theme, actual theme, geometry и routeMatches доступны для дальнейшей проверки. Effective permissions сами по себе не превращаются в role acceptance, поле permissions_ref не придумывается.

## Переданные замечания

1. **P2: приоритет integrity rejection.** В owner/floor/light ветке статус `SUPPORTED_THEME_DEFECT` присваивается после `CAPTURE_REJECTED_INTEGRITY` и может перезаписать его. Сценарий: невалидный raster/before-after pair с actual `staff-theme`. Причина — последовательные присваивания одного статуса. Владелец: координатор/processor. Минимальная мера — сохранять integrity rejection, theme class/defectId добавлять отдельно. В проверенном снимке нет integrity-rejected captures; риск относится к последующим входным данным.
2. **P2: fixed origin.** routeMatches сравнивает pathname/search/hash; requestedUrl строится относительно actual URL. Одинаковый path другого origin способен дать routeMatches=true. Владелец: координатор/processor. Добавить fixed `http://127.0.0.1:31952` origin assertion/flag и reject чужой origin. Текущий pipeline направлен на изолированный стенд; pending policy предотвращает выдачу PASS.
3. **P2: снимок во время записи пары.** mtime guards замечают изменение каждого файла во время отдельного read, но не доказывают принадлежность JPG и JSON одному capture attempt при overwrite между ними. No-PASS policy сохраняет корректность приёмки. Владелец: координатор. Итоговый processing выполнять после завершения relevant captures либо использовать unique attempt IDs/commit pair, затем повторить hash/mapping check.
4. **P2: latest vs usable.** Самый новый capture выбирается даже если rejected, более старый usable не подставляется. Это честный отрицательный исход последней попытки, но historical attempts нужно сохранять для review; в manifest index включён только latest. Оригинальные attempt files остаются источником истории. Не считать latest selection доказательством максимального покрытия.

Межфайловая атомарность manifest/CSV/check отсутствует: rename атомарен для каждого отдельного файла. После прерывания processor повторить и сверить outputs перед итогом. Missing runtime review останавливает processor до записи, поскольку его SHA256 вычисляется при построении manifest.

Подтверждение приёмки требует актуальных role/tenant session bridges, requested/actual theme и viewport checks, settled screenshot и region/state review. Факт обработки 265 captures подтверждает наличие evidence, а не 265 принятых сценариев.

## Повторный focused review исправлений

P2 №1/№2 исправлены координатором/matrix owner и закрыты чтением новой версии: expected origin фиксирован на `http://127.0.0.1:31952`; оба metrics URLs проверяются, origin mismatch вызывает `CAPTURE_REJECTED_INTEGRITY`; theme/focus ветки сохраняют integrity status. Origin flags внесены в manifest/check/CSV notes. Повторный `node --check` exit 0. Новый сохранённый processor check содержит mapped 290, allOriginsMatch=true, origin mismatches 0, PASS 0; его увеличение не отменяет необходимость итоговой сверки всех пар после завершения capture batch. Reviewer processor не исполнял и данные не менял.
