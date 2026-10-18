# UI-01.2 R4 — исходный read-only аудит screenshot fidelity

2026-10-09 · Независимая роль `code_health_engineer`. **Verdict: изоляция сохранена; v7 пригоден как детектор части capture inconsistencies. Fidelity проблемных кадров ещё не восстановлена и не принята. UI-01.2 не завершён.** Reviewer не запускал API, БД, браузер или services; продуктовый код и instrumentation не менял.

## Исходное состояние по файлам и hashes

- Прочитаны ignored `browser-evidence-v7.mjs`, launcher, mode и сохранённый processor-check. `node --check` v7 — exit0.
- Повторные SHA256 всех215 baseline runtime/assets/schema files: root0 mismatches, mirror0. Это сохранённый исходный dirty snapshot; pristine HEAD/весь dist не заявляются.
- Saved mode normal, targets/samples пусты; launcher сохраняет loopback backend31953 и isolated DB31954, real auth=true/demo=false, sanitized environment. Private runtime/credentials подтверждены git check-ignore; tmp status пуст. Это подтверждение файловых инвариантов, не новый runtime health check процесса/БД.
- Последний saved processor checkpoint588:578pending review,6supported theme defects,1rejected theme,2rejected raster,1rejected focus,1608business N/A и4284pending capture; PASS0. R3-E06/R3-E07 сохраняются до новой пригодной evidence и независимого review.
- В текущем saved R2 наборе не найдено captures с непустым nestedScroll одновременно before/after. Поэтому нет независимого runtime доказательства работы v7 nested detector из сохранённых кадров этого checkpoint; source проверка не подменяет такое доказательство.

## Capture chain и конкретный риск

V7 выполняет password-field boolean guard → before DOM metrics → combined AX/native screenshot → для большинства allowed pages дополнительный fullPage screenshot с document-scroll clip → after DOM metrics → поздний DOM snapshot → две последовательные файловые записи. При actual DPR>1.01 и terminal policy text используется только native combined path. Все действия находятся в поддерживаемом cua API; собственный browser driver, CDP transport или обход authentication не добавлены.

Nested detector читает DOM elements с overflow размеров, сохраняет tag/id/classes и scrollLeft/Top, сравнивает before/after списки. Он замечает итоговое изменение main981→142, которое document scroll0 не обнаруживает. При неизменном visibleText/layout size такое изменение теперь отвергает consistent. Но текущая цепочка **не локализует виновный вызов**: combined и fullPage выполнены без промежуточного measure. На allowed page первый raster всё равно отбрасывается, а его возможный side effect остаётся. Это кандидат инструментальной причины, а не установленный browser/product defect.

Before/after equality не замечает временное изменение scroll и возврат до after; actual theme, target geometry/font face/focus не входят в consistency. Поздний snapshot может отличаться от AX/screenshot. Список всех overflow nodes также включает hidden/clipped elements; изменение состава/классов может дать conservative inconsistent даже без изменения видимого кадра. Это допустимо для rejection, но не даёт оснований принимать true как полный PASS.

## Минимальные рекомендации координатору

1. Через разрешённый cua выполнить один диагностический этап на нужном allowed region: before → combined call → fresh measure → selected fullPage call → fresh measure. В каждой точке записать viewport, document/nested scroll и bounding boxes двух видимых anchors нужного региона. Это покажет, меняет ли scroll первый вызов, второй или оба. Не повторять timeout бессистемно, не менять source, permissions или guard.
2. Если allowed-page native raster отбрасывается, минимально сократить helper до поддерживаемого `getAXState({emit:false})` плюс одного выбранного screenshot; после AX также повторно проверить metrics перед screenshot. Native combined оставить там, где используется именно его bitmap. Предложение требует отдельной instrumentation правки координатором; reviewer её не реализовал.
3. Для каждого method получить контрольный актуальный screenshot и две видимые region anchors в той же геометрии. Exact JPEG width/height и стабильный текст не заменяют совпадения фактически изображённой секции/scroll. Документированный viewport screenshot без fullPage можно исследовать только если текущий cua API предоставляет такой режим. Не масштабировать старый raster для имитации точного viewport.
4. При обнаруженном scroll change/reflow/timeout сохранить rejected attempt отдельно; не overwrite пригодной history и не promote snapshot на основании повторной metadata проверки. Следующий capture запускать после обычного разрешённого возврата к нужному region/scroll и подтверждённой готовности; DOM evaluate использовать только для чтения. Требуются source-method/version и unique attempt provenance.
5. Before/after сравнивать actual theme и выбранные target boxes наряду с scroll; использовать положительную готовность именно requested region, а не только UI012 shell/отсутствие loader. Pending/error после upstream503 остаётся реальным исходом, не ошибкой nomenclature. Style/font/focus acceptance — отдельный visual/keyboard review.

Fixed policy guard fullPage timeout остаётся наблюдением coordinator; actual native guard path сохраняется как доступный инструментальный путь. Window.stop causal theory не поддержана текущим portal-session source (R3 audit); changing access gate или alternate browser driver в scope не входят. Если разрешённый инструмент не даёт пригодный кадр для нужной geometry, соответствующий capture остаётся pending/rejected.

## Граница завершения

R4 нужен для получения согласованных metrics/raster с текущим region и затем повторного design/QA review. После instrumentation изменения code health проверяет diff, новые пары/hashes и processor status transitions. Пригодность источника v7, нормальный mode file и hashes215 не доказывают исправленные R3-E06 кадры, бизнес-сценарии или полный UI PASS.

## Независимый review минимального v8 diff

`git diff --no-index` v7→v8 и `node --check browser-evidence-v8.mjs` (exit0) проверены read-only. Изменена только capture цепочка: getAXState без raster, затем ровно один выбранный screenshot — explicit nativeCapture, default fullPage/current-scroll clip или native actual policy guard. Предварительный выбрасываемый native raster убран. Password/login, document/nested scroll, before/after URL/viewport/text и actual raster dimensions guards сохранены. Это минимальное инструментальное изменение в заявленной области; продуктовый код, API, данные и browser reviewer не трогал.

По диагностике координатора первый capture после key scroll ещё менял main142→996; отдельный повторный single-native capture показал стабильные996→996 и изображение настоящего empty payroll region. Это сообщённый diagnostic outcome, не проверка long samples этим reviewer и не установленная product причина. После v8 требуется новый direct visual review именно long expense/payroll regions и текущих pair hashes; nested offsets true не превращаются в полный PASS.

P3 provenance label: fallback actual policy branch всё ещё записывает «combined AX/native», хотя v8 использует два последовательных read calls AX и single native screenshot. Владелец coordinator instrumentation; рекомендовано переименовать label на AX observation + single native policy guard screenshot. Основной explicit nativeCapture label соответствует новому алгоритму; замечание не блокирует сбор.

**Verdict v8: GO для нового контролируемого evidence collection с независимым region/raster review. UI-01.2 не завершён и UI PASS не выдан.**

## Независимый review v9 и SHA-bound state rejections

Read-only diff v8→v9 добавляет factory `captureDefaults={}` и shallow merge `{...captureDefaults,...meta}` в начале capture. Explicit role/route/viewport/theme/state сохраняют приоритет над defaults; browser/theme provenance попадает в batch metadata. Password guard, AX-only/single chosen screenshot, nested-scroll integrity и source-only DOM остаются. `node --check` v9 и processor — exit0. Мелкий fallback label из предыдущего замечания также уже исправлен на AX observation + single native policy guard.

Использование IAB вместо Edge через поддерживаемый cua browser и явную авторизацию пользователя сообщено координатором; новый внешний driver/обход доступа не вводился. В сохранённом manager delivery1920 light capture есть meta.browser и themeProof, consistent=true. Это provenance наблюдения, не автоматическое browser/session/theme acceptance. R4 manager own preferences proof: HTTP200, tenantAndPermissionsUnchanged=true; PATCH reviewer не исполнял. Source215 root/mirror вновь0/0 mismatches.

Новый processor stateRejections требует reviewed key,64-digit SHA,CAPTURE_REJECTED_STATE и точное совпадение текущих JPEG bytes; integrity rejection имеет приоритет. Все четыре current hashes подтверждены reviewer. По отдельному design review staff содержит4fixture accounts, directories4workshops+11categories, network1point, integrationsstatic unavailable card: claimed empty не установлен. Это rejection state evidence, не product empty defect и не N/A доступного business region. SHA binding не позволяет переносить отрицательное решение на будущий иной raster автоматически.

При чтении до повторного processing saved manifest/CSV ещё не содержали новые state rejections: четыре rows были pendingReview. Старые SHA R3-E06 обеих finance/payroll пар и R3-E07 managerclients уже отличаются от переснятых текущих JPEG; старый theme status ещё присутствовал в saved index. Координатор уведомлён повторить processor после завершения записи пар и сверить current hashes/status transitions. Reviewer processor не запускал и outputs не переписывал. Source matcher исправлен корректно; устаревший index не принимается за итог новой evidence.

**Verdict v9/processor change: GO для instrumentation и повторного индексирования координатором.** Новые IAB кадры требуют direct visual review; manager preference proof не заменяет light raster proof, recapture не даёт полного UI PASS. Product, services, DB и deploy reviewer не менял.

## Read-only контракт новых long-tenant столов: вместимость и PS5/TV

Прочитаны snapshot `server.js:2466–2486`, `runFloorMutation:1054–1082`, migration024, `table-minimum-schedule.js`, floor renderer `app.js:459–472` и штатный create payload `portal.js:1992`. API/БД reviewer не запускал. Повторные baseline source hashes215 — root/mirror0/0; прежние продуктовые изменения не перезаписывались.

`POST /api/floor/tables` требует permission settings и expectedVenueId. Wrapper возвращает428 при отсутствии precondition,409 при несовпадении active venue,403 без organization context и401 без valid active session. Venue принадлежность/active state и auth session проверяются под transaction lock; INSERT выбирает zone только в текущем venue. Чужой/неизвестный zone возвращает404, FK/unique conflict409. Успешный результат201 и floor_table.created audit относится к новой записи; POST не изменяет старые столы, orders/payments/stock не создаёт.

| Поле | Точный контракт / безопасное значение |
|---|---|
| expectedVenueId | Реальный active venueId подтверждённого owner long session; сверить с long fixture перед POST. Не брать из другой вкладки/tenant. |
| zoneId | UUID известного отдельного UI012 R2/R4 zone в том же long venue, подтверждённого read. Новый zone при необходимости требует собственного settings POST, name1..80. |
| name | Trimmed nonempty, не более80 символов; уникальный UI012 R4 prefix. Например «UI012 R4 Длинный тестовый стол с PS5 и телевизором у окна». |
| capacity | Integer1..100; явно передавать6. `seats` и `number` этим handler не читаются. |
| minCapacity / maxCapacity | Integers, min>=1, max>=min, max<=100. Например2/6. Handler проверяет capacity отдельно, не требует его попадания в range; безопасно следовать штатному UI payload capacity=maxCapacity. |
| minimumOrderTotal | Finite number>=0; передавать0, чтобы не создавать VIP pricing minimum. |
| minimumOrderStartTime / minimumOrderEndTime | Оба omit либо оба null. При ненулевых значениях требуются корректные разные HH:MM; overnight диапазон допускается. Для amenity/capacity visual fixture не нужен. |
| layout.amenities.playstation5 / television | Настоящие boolean true/false. POST сохраняет только эти amenities из layout. Строка "false" превращается Boolean в true; top-level PS5/TV или alias ps5 не контракт. |

Конкретный template после fresh session/zone read (переменные должны быть реальными IDs; reviewer его не исполнял):

```js
const payload = {
  expectedVenueId: ownerLongSession.user.venueId,
  zoneId: verifiedLongFixtureZone.id,
  name: 'UI012 R4 Длинный тестовый стол с PS5 и телевизором у окна',
  capacity: 6,
  minCapacity: 2,
  maxCapacity: 6,
  minimumOrderTotal: 0,
  minimumOrderStartTime: null,
  minimumOrderEndTime: null,
  layout: { amenities: { playstation5: true, television: true } }
};
```

Минимум — один новый стол с обоими badges и range2–6. При необходимости отдельного primitive coverage создать ещё два новых с PS5-only/TV-only, меняя только уникальное имя и boolean combination. Использовать только новые таблицы, не PATCH прежних eight/R2 fixtures. Потерянный POST response не повторять автоматически: сначала read по zone/name/ID, так как create не является идемпотентным.

Повторный GET /api/floor должен вернуть новую layout.amenities и min/max; renderer показывает2–6 гостей и PS5/ТВ badges. Новый actual screenshot/viewports/themes подтверждает видимые длинные labels, badges и geometry, а не только JSON. В layout editor соответствуют amenities chips PS5/TV. На момент этого исходного read новые кадры/processor ещё ожидаются; итоговая проверка v9/processor/doc outputs и215hash выполняется после их подготовки координатором.

## Предварительный read-only review v10: late autofill public login

Координатор сообщил независимое visual finding: 30 public login кадров v9 содержали synthetic login и masked password после успешного начального guard. Это обнаруженная гонка между начальным DOM observation и screenshot; v9 guard и consistent=true не доказывают пустые поля в raster. Эти кадры требуют пересъёмки и повторного прямого visual review. Reviewer браузер не открывал, поля не очищал, capture не выполнял.

Предложенный повторный Boolean guard после единственного chosen screenshot поддержан при размещении после after metrics/domSnapshot, непосредственно до первого fs.writeFile. При filled он должен бросать исключение до записи обеих частей evidence. Значения остаются внутри evaluate: в Node передаётся только Boolean, exception не содержит введённых данных. Guard одинаков до и после screenshot: `input[type=password],#login-password,#reset-password,#reset-password-confirm,#setup-password`.

Source `login.js:26,47` подтверждает Show: type меняется на text у #login-password и #setup-password; проверка только input[type=password] эти раскрытые поля пропустит. Предложенные фиксированные IDs сохраняют охват независимо от type. В прочитанных login/lock/portal source иной password→text toggle не найден. Для заявленного пустого public login дополнительно требуется scoped Boolean проверка #login-username: password-only guard пропускает заполненный username при пустом пароле. Product autocomplete/data-ignore attributes не гарантируют отсутствие позднего autofill.

**Verdict подхода: GO для минимального временного guard с указанными условиями.** Повторная проверка ловит заполнение, сохранившееся до after observation; transient fill→clear между наблюдениями остаётся ограничением. Ручное очищение, settled DOM/style, отсутствие reload и direct visual review всех 30 переснятых кадров нужны для доказательства пустого состояния. Код helper reviewer не менял; интегрированный v10, syntax/source hashes и итоговый processor ещё ожидаются. UI PASS не выдан.

## Интегрированный v10 и текущий checkpoint 1142

Read-only diff v9→v10 подтверждает только два credential guard изменения. Оба используют один expanded selector и возвращают Boolean; scoped PUBLIC_AUTH_ROLE_INTENT_ONLY добавляет #login-username. Повторный guard стоит после screenshot, after measure и domSnapshot, до первого write; при заполнении JPG/JSON не записываются. Existing files при rejected recapture не удаляются: требуется пересъёмка всех известных загрязнённых пар и повторное индексирование, а не трактовка исключения как очистки старой evidence. Single screenshot, nested/document scroll, origin/viewport и defaults semantics сохранены. `node --check browser-evidence-v10.mjs` — exit0; git check-ignore подтверждает helper вне Git. Reviewer ничего не исполнял кроме syntax read.

Source215 повторно совпал: root0/mirror0 hash mismatches. Saved CSV6480, check и manifest согласованы по текущему срезу: 1142 captures/mapped, 1126 CAPTURED_PENDING_REVIEW, 3730 PENDING_CAPTURE, 11 SUPPORTED_THEME_DEFECT, 4 CAPTURE_REJECTED_STATE, 1 CAPTURE_REJECTED_FOCUS, 1608 N_A_DENIED_BUSINESS_REGION; PASS0. NA business pairs67, baseline/keyboard NA0; saved originMatches=true. Это обновляет исторические более ранние срезы отчёта.

При отдельном чтении bytes найдено1JPEG+1measurement mismatch относительно сохранённого manifest1142; coordinator уведомлён. Сбор/пересохранение в этот момент продолжается, поэтому окончательная согласованность pair hashes ещё не установлена. Processor должен быть повторён после последней записи, затем новый index сверяется с current bytes и прямым visual review. **Verdict v10: GO instrumentation; итоговый evidence checkpoint pending до этого шага.** Полный UI PASS и завершение UI-01.2 не утверждаются.

## Финальный read-only checkpoint 1145 после остановки capture

После сообщённого coordinator завершения записи и повторного processor выполнена независимая сверка файлов, без browser/API/DB/services. Source snapshot215: root0 и mirror0 SHA256 mismatches. Все 1145 current manifest JPEG и 1145 measurement JSON сверены с указанными SHA256: mismatch0/0, missing refs0. Предыдущая временная несогласованность среза1142 устранена в актуальном index.

CSV6480, manifest и processor-check согласованы: mapped/captureFiles1145; CAPTURED_PENDING_REVIEW1129; PENDING_CAPTURE3727; SUPPORTED_THEME_DEFECT11; CAPTURE_REJECTED_STATE4; CAPTURE_REJECTED_FOCUS1; N_A_DENIED_BUSINESS_REGION1608; PASS0. Сумма статусов6480. Saved all origins match=true, raster mismatches0, deferred0. Это проверка index/bytes consistency и сохранённых origin assertions; без новых сетевых запросов она не свидетельствует о live health сервиса.

`mode.json` содержит normal, targets0, samples0. Syntax read v10 и processor: node --check exit0. Reviewer не запускал capture, processor, state controller или fixture scripts и не менял продуктовые файлы. **Final instrumentation/evidence-processing verdict: GO для текущей согласованной фиксации1145.** Отдельные pending/rejected/theme findings сохраняются; полный UI PASS и завершение UI-01.2 не выдаются. Прямой визуальный acceptance пустых public login кадров остаётся ответственностью design/QA.

## Актуальный финальный checkpoint 1151 и component supplement

Последний пакет добавил шесть matrix pairs после исторического среза1145. Независимая read-only сверка всех1151 current manifest JPEG/measurement pairs: SHA256 mismatch0/0, missing refs0. CSV6480, manifest и check согласованы: CAPTURED_PENDING_REVIEW1135, PENDING_CAPTURE3721, SUPPORTED_THEME_DEFECT11, CAPTURE_REJECTED_STATE4, CAPTURE_REJECTED_FOCUS1, N_A_DENIED_BUSINESS_REGION1608; PASS0. Mapped/captureFiles1151, deferred0, raster mismatch0, all origins match=true. Mode file normal, targets0/samples0. Сервисные запросы/processor reviewer не запускал; полный source215 повторно не читался, поскольку после предыдущей сверки заявлены только UI observations/report data, без программного diff.

Supplement `evidence/UI-01.2/r2/components-r4` содержит пять существующих JPG/JSON pairs; каждый JSON успешно разобран, каждый current JPEG SHA256 совпал с таблицами независимого UI_01_2_VISUAL_REVIEW_R4. Это отдельные supplemental observations, не дополнительные принятые matrix cases. Reservation expanded-picker имеет полную capture schema и consistent=true; четыре остальных используют сокращённую schema. У трёх lock scenes URL/nestedScroll before/after совпали, origin31952, securityPreferenceChanged=false; raster/consistent fields отсутствуют и не наследуются из matrix. Reservation Escape JSON не содержит before/after metrics/raster; ему не приписывается такая integrity проверка. Ограничения supplemental provenance прямо указаны в visual review.

**Текущий final verdict: GO для согласованной evidence фиксации1151 и существующих supplemental refs.** Counts1145/1142 выше остаются историческими; текущий checkpoint1151. Product correctness, visual acceptance, безопасность live сервиса и завершение UI-01.2 этой файловой проверкой не установлены. UI PASS не выдан.
