# UI-01.2 — независимый visual review R4

Дата: 2026-10-09. Роль: design_lead / visual_auditor. Итог этапа: **NOT ACCEPTED / INCOMPLETE; PASS 0**.

## Область и метод

Непосредственно открыты пять текущих JPG ниже через view_image; проверены их JSON before/after, URL, theme, viewport, raster, nestedScroll и текущий SHA-256. Браузером reviewer не управлял. Совпадение метрик подтверждает целостность конкретного снимка в проверенных пределах, но не является функциональным или глобальным visual PASS. Отдельно прочитан JSON отклонённого finance 1920; его bitmap не открывался и не использован для оценки финансового региона.

Evidence directory: `evidence/UI-01.2/r2/`. В таблице basename относится к JPG и одноимённому JSON.

| Непосредственно осмотренный basename | CSS viewport / raster | main scroll before = after | Что видно / классификация |
|---|---|---|---|
| owner__finance__actual__dark__long-content | 1528×780 / 1528×780 | 1812.80005 | Открытый журнал расходов: все три synthetic строки, фильтры, «Показаны 1–3 из 3», disabled pagination. REVIEWED_WITH_VISUAL_DEFECT V06. |
| owner__finance-payroll__actual__dark__empty | 1528×778 / 1528×778 | 996 | Заголовок реестра, четыре фильтра, обновление и пустое состояние «За выбранный период начислений нет». REVIEWED_LIMITED_REGION. |
| owner__finance-payroll__actual__dark__long-content | 1528×778 / 1528×778 | 996 | Заголовок/фильтры и полностью первая cancelled synthetic строка; начало следующей карточки у нижнего края. Другие строки ниже viewport, их содержимое этим кадром не проверено. REVIEWED_PARTIAL_LONG_CONTENT. |
| owner__finance-payroll__1920x1080__dark__long-content | 1920×1080 / 1920×1080 | 981.59998 | Все три cancelled synthetic строки целиком, длинные имена и модели, 0 ч, дата выплаты не указана, «Операция завершена», суммы 0 ₽ и статусы. REVIEWED_LIMITED_REGION; текущая съёмка supersedes прежнее отклонение R3-E06 именно этого файла. |
| owner__orders__1920x1080__dark__long-content | 1920×1080 / 1920×1080 | main не включён в nestedScroll; весь список before/after совпадает | Все три synthetic cancelled заказа, длинные названия столов и гостей, суммы 0 ₽, дата и кнопки «Возвраты»/«Открыть»; фильтры и KPI видны. REVIEWED_LIMITED_REGION. |

Все пять JSON: consistent true; URL stable; theme dark before/after; nestedScroll массивы совпадают. У actual finance DPR 1.25, payroll actual DPR 1.25; фактическая высота payroll 778, а не 780. У двух 1920 кадров DPR ≈1.000000015. JSON finance/payroll captureMethod: single native screenshot with nested scroll integrity; orders: documented fullPage screenshot clipped to current CSS viewport after AX observation. Не следует приписывать orders native метод только по принадлежности к R4 пакету.

## V06 — разрыв суммы в расходах

В owner finance actual dark long-content во всех трёх строках цифра «0» находится над отдельным «₽» справа. Это непосредственно видимая проблема компоновки денежного значения при длинной категории и описании. Строки читаются, но число и единица разделены переносом. Зафиксирован локальный visual defect для viewport 1528×780 и данного synthetic read sample; CSS первопричина и воспроизведение в других размерах не исследованы. Измерений ширины суммы, точного контраста и изменения кода не выполнялось.

Заголовок «Расходы и затраты» JSON y=248.2625 соответствует видимому заголовку примерно на y=252; payroll actual «Зарплатный реестр» JSON y=422.025 соответствует bitmap, payroll 1920 JSON y=412.5125 также соответствует видимому региону. Это предметная проверка расположения региона поверх сравнения nested main scroll. Полный AX текст включает скрытые/внеэкранные области; его наличие не доказывает их видимость. В bitmap этих пяти кадров lock overlay не показан.

## Payroll и orders: границы выводов

Payroll empty — реально пустой реестр normal upstream по metadata. Это не свидетельство пустоты всего tenant. Верх текущего viewport содержит нижнюю часть блока проверки табеля с предупреждением об отсутствии плановых смен; начало страницы и форма выше кадра не проверены.

Payroll long-content и finance/orders используют syntheticReadSample `ui012-r3-v1`, actionsValidated false, persistenceValidated false. Cancelled карточки не доказывают начисление, утверждение или выплату зарплаты. Кнопки начисления/обновления, возвратов и открытия заказа не выполнялись reviewer. Читаемость текущих тёмных длинных строк не переносится на light, другие роли или размеры. Для actual payroll длинное состояние покрывает только первую карточку; 1920 покрывает все три. Новых общих эквивалентностей и screenshot reuse не введено.

## Остающееся отклонение finance 1920

`owner__finance__1920x1080__dark__long-content`: JSON requested/CSS viewport 1920×1080, raster 1910×975, consistent false. URL/theme/nestedScroll stable (main 1504 до/после), но это не исправляет несоответствие raster. **CAPTURE_REJECTED_RASTER / INTEGRITY**. Bitmap не осматривался этим reviewer и не используется для оценки расположения, состава или компоновки расходов 1920. Причина в продукте или инструменте не установлена.

R3-E06 payroll 1920 для прежнего SHA остаётся историческим отклонением; текущий SHA ниже имеет независимое доказательство видимого целого реестра. Это не снимает отдельное отклонение finance 1920 и не означает общего устранения всех DOM/bitmap расхождений.

## Текущие SHA-256

| Basename | SHA-256 JPG |
|---|---|
| owner__finance__actual__dark__long-content | 9CB2A74087A1B53F13C27D3238538FD591FFACB747148C9485BA23CCB61AD0FF |
| owner__finance-payroll__actual__dark__empty | 64F213922FF60F106BF8DD02A6382927B70E1960DB6C7842D43DF6B080FABDA0 |
| owner__finance-payroll__actual__dark__long-content | 8B6CA2E9A1BFC4B63159B0BD1E97DB331E67C73AE2351B2D990A970F5696EFD1 |
| owner__finance-payroll__1920x1080__dark__long-content | 0E07380907CE66B586AAE4615251F5C5CB239B15C8FA7CBA2B9503F93FA665D0 |
| owner__orders__1920x1080__dark__long-content | 87114DD8CFB7DD84B26E7E811950921F793EC91AE6E4F195B42929B90212A307 |
| owner__finance__1920x1080__dark__long-content — JSON-only rejected | 6197C21FDEE228A95B6E37C0BD73B8AC6937574A42DB5CC6936279E30D13F83E |

## Остаток и решение

Данный review закрывает независимый осмотр только пяти перечисленных текущих bitmap. Существующие R2/R3 findings, R3-E07 manager clients requested-light rejection и непокрытые пункты матрицы остаются в своих отчётах; R4 не переоценивает их. Не закрыты finance 1920 raster integrity, скрытые payroll actual строки, остальные роли/темы/размеры/состояния, полный keyboard/reduced-motion и точный contrast/font audit, функциональные финансовые действия и persistence. Общий PASS остаётся 0. Изменён только этот отчёт; evidence, CSV, progress и продуктовый код не изменялись.

## Дополнение R4 — owner empty tenant, actual dark

Непосредственно открыты **20 новых** JPG из r2 с basename `owner__<surface>__actual__dark__empty`; для каждого прочитан JSON и текущий SHA. Payroll empty ранее осмотрен в первом разделе R4 (другой normal-upstream регион, 1528×778), в новые 20 не включён и не объявляется новым empty-tenant доказательством. Снимки нового пакета имеют CSS viewport/raster 1528×780, DPR 1.25. Credentials и происхождение настоящего empty tenant подтверждены координатором; reviewer проверяет видимый UI, а не заново аудирует БД.

**Нет empty acceptance / PASS.** Meta state empty обозначает сценарий fixture и не означает пустоту каждого экранного справочника. Видимые нулевые счётчики и сообщения ниже подтверждают только указанные регионы/фильтры. Все нижние/закрытые области, действия, доступность и прочие размеры остаются непроверенными.

| Surface — непосредственно осмотренный bitmap | Видимое состояние и классификация |
|---|---|
| floor | Нет залов в точке; стол не выбран, нет позиций, итог 0 ₽, смена закрыта. EMPTY_BUSINESS_REGION. Нижняя очередь приготовления видна лишь началом. Theme metrics staff-theme, а не dark: это staff shell, не доказательство портальной theme dark. |
| admin | За выбранную дату смен не найдено, CTA выбора даты; нижние KPI начинаются у края. EMPTY_DATE_REGION / PARTIAL_DASHBOARD, не полный empty обзор всех модулей. |
| orders | Всего 0, открытых 0, выручка 0 ₽; «По выбранным условиям заказов нет». EMPTY_FILTERED_BUSINESS_LIST. |
| clients | KPI и статусы 0, «0 гостей из 0», «Гости не найдены». EMPTY_BUSINESS_LIST. |
| reservations | На выбранную дату бронирований нет; CTA «Новая бронь» / «Показать все даты». EMPTY_DATE_LIST, все даты не открывались. |
| delivery | Очередь 0 заказов, по выбранному фильтру доставок нет; форма новой доставки с cash default/суммой 0, низ формы вне viewport. EMPTY_FILTERED_BUSINESS_LIST_WITH_FORM_DEFAULTS. |
| finance | KPI 0, ожидается 0, chart «Нет операций для этого показателя за период». EMPTY_PERIOD_REGION; нижние расходы/payroll/payments не показаны. |
| finance-categories | «0 из 0 категорий», категорий пока нет, CTA создания. EMPTY_BUSINESS_LIST. |
| finance-report | KPI 0, visible панели денег/продаж показывают отсутствие данных за дату. EMPTY_DATE_REGIONS, нижняя часть не проверена. |
| network | Одна текущая точка «UI012 Пустая Тестовая Компания». EMPTY_TENANT_WITH_REQUIRED_NONEMPTY_ENTITY; не пустой список сети и не bug. Форма добавления имеет defaults, низ вне viewport. |
| integrations | Telegram «В разработке», настройка бота недоступна. EMPTY_TENANT_WITH_STATIC_PRODUCT_DEFAULT; не empty list и не подтверждение работающей интеграции. |
| admin-staff | Четыре активных accounts (owner, manager, bartender, hookah master); карточки снизу обрезаны viewport. EMPTY_TENANT_WITH_REQUIRED_ACCOUNTS / NONEMPTY_BUSINESS_LIST. Ожидаемые четыре accounts не считаются дефектом. Empty staff list не доказан. |
| inventory | Bitmap: 0 позиций, нет последней операции, «Позиций пока нет», CTA. OBSERVED_EMPTY_BITMAP / CAPTURE_INTEGRITY_UNPROVEN: consistent false, before/after nestedScroll состав различается. Не принимается как стабильное доказательство. |
| inventory-view-stock | 0 позиций, пополнение 0, операции нет, «Позиций пока нет» и CTA. EMPTY_BUSINESS_LIST; JSON consistent true. Actual URL /inventory при meta /inventory?view=stock: зафиксирован нормализованный stock URL, поведение query не проверялось reviewer. |
| inventory-view-products | KPI 0, «Каталог пока пуст», CTA товара. EMPTY_BUSINESS_LIST. |
| inventory-view-recipes | KPI 0, «Технологических карт пока нет», CTA новой карты. EMPTY_BUSINESS_LIST_WITH_VISUAL_DEFECT V04: длинная inline search подпись, маленький native input и категория следующей строкой; ранее наблюдавшаяся компоновка сохраняется на пустом списке. |
| inventory-view-auto-orders | KPI 0, «Пополнение пока не требуется», form-request disabled. EMPTY_RECOMMENDATIONS_REGION; история заявок закрыта. |
| inventory-view-movements | Documents 0 / operations 0; открыт только Documents с «Документов пока нет». EMPTY_DOCUMENTS_REGION; отдельное пустое тело Operations не открыто. |
| inventory-view-premixes | Все KPI 0, prompt создать техкарту премикса, «Партии ещё не приготовлены». EMPTY_RECIPES_AND_BATCH_REGION_WITH_ONBOARDING_CTA. |
| inventory-view-directories | 4 цеха и 11 категорий; подцехов 0, видимый empty prompt подцехов. EMPTY_TENANT_WITH_NONEMPTY_DEFAULT_DIRECTORIES; только subworkshops list пуст. Показаны первые 5 категорий, остальные ниже внутреннего списка; публичные tobacco/alcohol каталоги закрыты и не просмотрены. |

Для 19 из этих 20 JSON consistent true, URL/theme stable и before/after nestedScroll массив совпадает. Floor theme staff-theme stable. Inventory root consistent false: before включает sidebar-nav-groups, after этого элемента нет; показанные scroll значения 0. Из этого не следует product defect или неверный tenant. Root bitmap непосредственно осмотрен, но capture integrity не принят. Stock companion independently opened и имеет consistent true; reuse root не введён.

Empty tenant сам по себе не гарантирует пустых account/default entities. Ни staff4, ни network1, ни directories4/11 не используются для закрытия empty-list coverage. В них нет выявленного fixture bug по факту непустоты. Light контраст, keyboard, создание первой записи, disabled reasons и успешное сохранение не проверены. Новые кадры за пределами точного списка 20 здесь не оценены. Общий итог остаётся **NOT ACCEPTED / INCOMPLETE; PASS 0**.

### SHA-256 непосредственно осмотренных новых empty JPG

| Surface | SHA-256 |
|---|---|
| floor | AA7CCC01BCD765151312E067D32DF52F3254DEDB8709E89254BDF13BC381EA42 |
| admin | 2992460D543A7D8211D4BF9D12A5DC3E8345032AC6B409A6119B734F486F66EC |
| orders | 91B8CE6037A62289EA59C2DF5A8F59D02C2889B33128F286599BB1770C03DADA |
| clients | 3B23C7A014E8741E16DAC56AA1DCD6B9FB6C02E7BCAC66E14F39FBF3BDE95C13 |
| reservations | F2A84B0D6B2526762BCA35CC7008823F6794EBF1732552A885D7749F193611ED |
| delivery | 274E68F78E8AFCD5047F60A3E8715061916A3B6855CC2C1E2FBB2995B56B2768 |
| finance | 89DAFC5765045E53F8FEA07CE840A04CEDE0535B6DB6A4FE59DC891E605A440C |
| finance-categories | 10DB8BFA2BBA8746D1D049DCECCED751AFDB92F2BDBEF5B9BDD4928783E7671F |
| finance-report | 52BE3792D9E7A83D98AAAFEDE3260C3ADC4D2834092AA6910B6A710DCDE7C0B5 |
| network | 1FC3C66B071C9406DF232C9736A89EB5CF2812F540E6A1D590BA297BBD1A87C9 |
| integrations | 0279D8155EEE8CED24834F1349CF36646139B28DB18B17547745FD0C8AB37E65 |
| admin-staff | C0C58A76BB25D043BE5244D684C3CA9E217B9A2E15E7272AA27989EF4D2E34FC |
| inventory | 4C036D8E187DD11B8FA5C5D82A705AEC8A54991EF435E93AEAC3D995472A0B80 |
| inventory-view-stock | 508D7A668A173F03D24EECE816278551ED29530C94C81285F7A220E792514682 |
| inventory-view-products | F5AE7841CE63175A5855B757CB49AC0FFBA0A8EEF741783A768A6F22A9A0D1BB |
| inventory-view-recipes | B15D1DC99157482C0E6AB66D737072ABBCDD889A552CB6973EAD2FBED28E140A |
| inventory-view-auto-orders | 5CE6A7DBB6BF94B28A094EEDC3DD5DBE10945AB7D0D28496278EF7437CE0AA17 |
| inventory-view-movements | CBF2C921C2BBE36EE27F676BB7F036B180A73E33C04A2F25AD88A7E7A4AD9A5F |
| inventory-view-premixes | 4FCC07A401BB3C5E358CB64784E0989A80D1D70A2A2F42554177CCC4B45EC409 |
| inventory-view-directories | B308C96331D903842CBB9E6C73A3E1769B2AD8DE888D781A3078CE1B0A285887 |

## Дополнение R4 — текущие IAB fixed baselines и policy guards

Проверены 160 индивидуальных JPG/JSON слотов: hookah_master baseline по 34 маршрутам в каждой из четырёх групп 1366×768/1920×1080 × dark/light (136); manager policy guards по пяти маршрутам в четырёх группах (20); новый manager clients 1920 light (1); owner finance 1920 dark long-content и payroll 1920 dark empty/long-content (3). Browser metadata: Codex In-app Browser. Непосредственно открыты **50 bitmap representatives**: 44 hookah разрешённых поверхностей, два guard representatives по размеру, три owner и один manager clients. Ещё **110** файлов guards визуально классифицированы по полному совпадению SHA с непосредственно осмотренным representative; индивидуальные role/route/viewport/requested theme/actual metrics сохранены в ledger ниже. Это visual equivalence композиции, а не отдельная проверка RBAC или runtime действий.

Непосредственные 11 hookah surfaces в каждой из четырёх групп: floor, admin, orders, clients, finance, finance-report, finance-payroll, admin-tasks, admin-shift-control, admin-notifications, admin-help. Guard representative: hookah_master admin-audit dark в каждом размере. Остальные 23 hookah denied surfaces перечислены в ledger. Manager guard surfaces: delivery, finance-categories, integrations, admin-permissions, admin-diagnostics. Файл `hookah_master____1366x768__dark__baseline` с пустым surface исключён из стандартных слотов и не просмотрен.

### Целостность и theme boundaries

У всех 160 выбранных JSON consistent true, before/after URL stable, nestedScroll массивы совпадают, raster = CSS viewport. Это не PASS. У 40 разрешённых hookah portal кадров metrics theme соответствует requested dark/light; четыре floor возвращают staff-theme staff-red-cursor и bitmap остаётся тёмным в обеих requested темах — E01 сохраняется. У 112 guards metrics theme содержит `portal velora-theme` либо `portal velora-theme portal-page`, не фактическую light/dark тему. В каждом размере guard JPG полностью одинаковый для requested light/dark и обеих ролей; bitmap имеет тёмный фон и светлую карточку. Поэтому guard theme slot не объявлен отдельно доказанным light/dark только по requested metadata или consistent.

Guard1366 SHA: 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590; guard1920 SHA: BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4. В каждом классе 56 слотов, один непосредственно открытый и 55 equivalence. Видна карточка Hookah POS с ограничением доступа и двумя ссылками; текст помещается, нижние бизнес регионы отсутствуют. Ссылки, keyboard и фактическая смена роли не выполнялись reviewer.

### Фактические визуальные findings

- V01 сохраняется в hookah light обеих геометрий: имена guests почти не читаются на тёмных карточках; admin paid/closed/payments KPI имеют тёмные значения на тёмной карточке; personal finance и finance#payroll сумма 0 ₽ почти белая на белом; personal report сумма 0 ₽ тёмная на тёмной карточке. В light orders status pills «Готовится»/«Готов» бледные на очень светлом фоне; light shift CTA «Закрыть смену» бледный на белом. Новых точных ratios не вычислялось.
- Help1920light «Не нашли ответ?» почти белое на белом — ранее наблюдавшийся V05/foreground problem продолжается; остальной тёмный accordion в светлом shell сам по себе не считается дефектом. В 1366 feedback регион ниже viewport и не оценён.
- Floor показывает восемь свободных столов, отсутствие selection/позиций; длинный title первого стола усечён ellipsis. Два hall labels помещаются в две строки1366/одну1920. Queue приготовления в1920 начинается снизу, все её строки не проверены;1366 ниже viewport. Sidebar floor210, portal244/примерно72header визуально подтверждаются, единый shell contract/D02 этим не закрыт.
- Orders1366 фильтры занимают две строки, названия столов примерно шесть строк; третья запись частично ниже viewport. Orders1920 все три строки615/410/307 и фильтры в одной строке видны. Это текущие реальные открытые/готовящиеся заказы, не cancelled synthetic history R4 samples.
- Clients18: первые3/4 карточки видны1366 и примерно7/8 в1920; остальные ниже viewport. Dark читаемые имена не доказывают light. Staff clients layout без manager KPI/archive сохранён.
- Tasks1366 длинная первая карточка уходит ниже viewport;1920 первая/вторая карточки целиком и начало третьей. Status select виден1920, не выполнялся. Empty соседние три колонки не являются whole-list empty. Notifications во всех четырёх группах показывают error и Retry; фокус outline заголовка не доказывает keyboard flow, retry не выполнялся.
- Hookah finance#payroll визуально показывает «Оплаты сегодня», а не owner payroll register; own URL ledger сохраняет /finance#payroll. Его нельзя использовать для оценки owner зарплатного реестра.

### Пересъёмки manager clients / owner financial regions

Текущий manager clients1920light SHA EC838408425BC831F302F6A416B60AC1CB6C2EC7DD7F385D33B67C99484355BF: непосредственно осмотрен light bitmap, JSON theme light. Прежнее R3-E07 отклонение dark при requested light относится к старому SHA и superseded текущим снимком; V01 имён на тёмных карточках сохраняется. Manager18 KPIs/archive видны, но весь list ниже viewport не осмотрен.

Текущий owner finance1920dark SHA53145D16FAE33CCF50D059F68CAF15AB59C42AB460CA61B8179313CB7FE59583: непосредственно видны «Смена и касса», раскрытые расходы, все три synthetic строки и pagination1–3 из3. Размер1920×1080, consistenttrue; прошлое raster rejection1910×975 historical для старого SHA. Здесь суммы0 ₽ помещаются в одну строку, однако это не устраняет V06 в actual1528×780.

Текущий owner payroll1920dark empty SHA489570D1AF374EA9D0A709159E65947365E848C87E7FB1325014594DD6563A7E: виден tabular validation пустого периода, фильтры и отсутствие начислений. Long-content SHA206FE62F001F849E9A8B34BD029A636205B98264249EE59ED9F48E189EADE366: все три synthetic cancelled карточки целиком видны. Оба raster1920×1080/consistenttrue, прежний R3-E06 относится к старому SHA. Эти три owner IAB bitmap визуально мягче/размытее остальных текущих снимков: оценка мелких glyph деталей ограничена; product font/paint причина не установлена. Наличие читаемого региона не подтверждает financial actions/persistence, synthetic samples остаются только visual references.

Никакого общего PASS или full-stage acceptance. Не проверены hidden/below-viewport регионы, selected table/catalog/actions, все accordion topics, whole tasks/clients, dialog/keyboard/reduced-motion/contrast/font-face и финансовые lifecycle. Новые bartender snapshots и любые файлы сверх точного ledger здесь не reviewed.

### Индивидуальный current-SHA ledger

`DIRECT` — bitmap непосредственно открыт; `SHA_EQUIVALENT_1366/1920` — собственные метаданные проверены, bitmap совпадает с guard representative указанного размера. URL приведён относительно loopback host. Theme metrics с class string честно сохранён; это не light/dark confirmation.

| Basename | Own actual URL | Requested / metrics theme | SHA-256 | Review |
|---|---|---|---|---|
| hookah_master__admin__1366x768__dark__baseline | /admin | dark / dark | 989161DBE2A216E102C68C797508B936D6431806C630719EB5D922BA43F1D421 | DIRECT |
| hookah_master__admin__1366x768__light__baseline | /admin | light / light | 9A9A86852EEB740F6118C72DA529407D9015E89C343876849BBE6109597FCD85 | DIRECT |
| hookah_master__admin__1920x1080__dark__baseline | /admin | dark / dark | 92B34E60617E351833CF17C3A3378663586017AEC74F12E9EACC3401C5F7C9AD | DIRECT |
| hookah_master__admin__1920x1080__light__baseline | /admin | light / light | 7701E313E5DE2BCB08A952F1172B65283B8D67180281DE22E4F6E605627C7EDF | DIRECT |
| hookah_master__admin-audit__1366x768__dark__baseline | /admin#audit | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | DIRECT |
| hookah_master__admin-audit__1366x768__light__baseline | /admin#audit | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-audit__1920x1080__dark__baseline | /admin#audit | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | DIRECT |
| hookah_master__admin-audit__1920x1080__light__baseline | /admin#audit | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__admin-company__1366x768__dark__baseline | /admin#company | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-company__1366x768__light__baseline | /admin#company | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-company__1920x1080__dark__baseline | /admin#company | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__admin-company__1920x1080__light__baseline | /admin#company | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__admin-diagnostics__1366x768__dark__baseline | /admin#diagnostics | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-diagnostics__1366x768__light__baseline | /admin#diagnostics | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-diagnostics__1920x1080__dark__baseline | /admin#diagnostics | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__admin-diagnostics__1920x1080__light__baseline | /admin#diagnostics | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__admin-help__1366x768__dark__baseline | /admin#help | dark / dark | 74B0F43704662059BFC6A809C823BCCA833D9387F76747D9A825993B17F0CBF8 | DIRECT |
| hookah_master__admin-help__1366x768__light__baseline | /admin#help | light / light | E12BFA816AA35F7A40F0764606A1F89665AC56E87FE1B6B09C9C95B060819B80 | DIRECT |
| hookah_master__admin-help__1920x1080__dark__baseline | /admin#help | dark / dark | A2EECC99B88C9379154F7EBDABA5CEA7931F29A69623D932136C6C946FF88F98 | DIRECT |
| hookah_master__admin-help__1920x1080__light__baseline | /admin#help | light / light | 1C7BF4E0DB8FC9F03F09CE93B21047A7FAE8A827AE35A4FC3F8D365EB3AA1AF2 | DIRECT |
| hookah_master__admin-lock-security__1366x768__dark__baseline | /admin#lock-security | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-lock-security__1366x768__light__baseline | /admin#lock-security | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-lock-security__1920x1080__dark__baseline | /admin#lock-security | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__admin-lock-security__1920x1080__light__baseline | /admin#lock-security | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__admin-loyalty__1366x768__dark__baseline | /admin#loyalty | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-loyalty__1366x768__light__baseline | /admin#loyalty | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-loyalty__1920x1080__dark__baseline | /admin#loyalty | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__admin-loyalty__1920x1080__light__baseline | /admin#loyalty | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__admin-notifications__1366x768__dark__baseline | /admin#notifications | dark / dark | F0FE2BCC8E57D82E0538877E015066D22D05A26CD47FD0E7D5546D87CEF7768C | DIRECT |
| hookah_master__admin-notifications__1366x768__light__baseline | /admin#notifications | light / light | 6A49F952EED813720F362859D3222EA7F684CDE076E9E4E46E5AA52A8FEB8549 | DIRECT |
| hookah_master__admin-notifications__1920x1080__dark__baseline | /admin#notifications | dark / dark | 20EEAB55933FC4EA6D262D9426F69CEC27CE18CCB43D3D561C72A25F5CADCB40 | DIRECT |
| hookah_master__admin-notifications__1920x1080__light__baseline | /admin#notifications | light / light | 411DFDF519C94080BAB8237A6C8CC62C84D1BEED3CFDDA6AB730FE4127CCCDC2 | DIRECT |
| hookah_master__admin-permissions__1366x768__dark__baseline | /admin#permissions | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-permissions__1366x768__light__baseline | /admin#permissions | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-permissions__1920x1080__dark__baseline | /admin#permissions | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__admin-permissions__1920x1080__light__baseline | /admin#permissions | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__admin-settings__1366x768__dark__baseline | /admin#settings | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-settings__1366x768__light__baseline | /admin#settings | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-settings__1920x1080__dark__baseline | /admin#settings | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__admin-settings__1920x1080__light__baseline | /admin#settings | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__admin-settings-dashboard-modules__1366x768__dark__baseline | /admin#settings-dashboard-modules | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-settings-dashboard-modules__1366x768__light__baseline | /admin#settings-dashboard-modules | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-settings-dashboard-modules__1920x1080__dark__baseline | /admin#settings-dashboard-modules | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__admin-settings-dashboard-modules__1920x1080__light__baseline | /admin#settings-dashboard-modules | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__admin-shift-control__1366x768__dark__baseline | /admin#shift-control | dark / dark | 19EE04B565BFC993E4056EE79FA3CA0651486643B691DB761E3CDDD5F4200DFF | DIRECT |
| hookah_master__admin-shift-control__1366x768__light__baseline | /admin#shift-control | light / light | E4F3FBE3860E8FA7702246D7072AD88BA5C992C8A78712FE33B289A161F84AEA | DIRECT |
| hookah_master__admin-shift-control__1920x1080__dark__baseline | /admin#shift-control | dark / dark | 47306B3CC4AB908CA4F3103A0F3F1963F62A9928FA55B1EE365F1730C7F6FDB2 | DIRECT |
| hookah_master__admin-shift-control__1920x1080__light__baseline | /admin#shift-control | light / light | 4791E20B1972C3ACD9427F7120828C236498AB998562E96E596E924BF5D178A1 | DIRECT |
| hookah_master__admin-staff__1366x768__dark__baseline | /admin#staff | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-staff__1366x768__light__baseline | /admin#staff | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-staff__1920x1080__dark__baseline | /admin#staff | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__admin-staff__1920x1080__light__baseline | /admin#staff | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__admin-tasks__1366x768__dark__baseline | /admin#tasks | dark / dark | B5334E9BBE948F3F929587F1ADE019CE9B1A85CDFC83A008E4CF246FF2DC732A | DIRECT |
| hookah_master__admin-tasks__1366x768__light__baseline | /admin#tasks | light / light | 27664F44277BCDA65ECEBC8E93AD0F810087796219BD935AA714D0FD27598CF0 | DIRECT |
| hookah_master__admin-tasks__1920x1080__dark__baseline | /admin#tasks | dark / dark | E09E20670AAF3BF0B6211614F1183BF0C259A4BCB5BCE1065A741B7755FD3BCE | DIRECT |
| hookah_master__admin-tasks__1920x1080__light__baseline | /admin#tasks | light / light | 41E471C6C6812F3AED034C1A94A2FB922D7DA3A3FAB042BB68E5DB243E441786 | DIRECT |
| hookah_master__admin-venue-layout-settings__1366x768__dark__baseline | /admin#venue-layout-settings | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-venue-layout-settings__1366x768__light__baseline | /admin#venue-layout-settings | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__admin-venue-layout-settings__1920x1080__dark__baseline | /admin#venue-layout-settings | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__admin-venue-layout-settings__1920x1080__light__baseline | /admin#venue-layout-settings | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__clients__1366x768__dark__baseline | /clients | dark / dark | AE82D4D33BCC11A846FF2AE3B1BE08439FBA2C8FEB18FD8120AC8D7ED1205CB8 | DIRECT |
| hookah_master__clients__1366x768__light__baseline | /clients | light / light | 07EAAB387697922597CECA1C8AE2B650F1AC8090BDEB6514D0896CCDD9E34B22 | DIRECT |
| hookah_master__clients__1920x1080__dark__baseline | /clients | dark / dark | F7761173C51FCDE8357A1AB363DC2E903AAB906C2F2F95F8882E8348B078E744 | DIRECT |
| hookah_master__clients__1920x1080__light__baseline | /clients | light / light | 2078ACD03088FB3BF40D7938180077BA4639F1BD7F665AB83C0FF1D84BD456FC | DIRECT |
| hookah_master__delivery__1366x768__dark__baseline | /delivery | dark / portal velora-theme portal-page | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__delivery__1366x768__light__baseline | /delivery | light / portal velora-theme portal-page | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__delivery__1920x1080__dark__baseline | /delivery | dark / portal velora-theme portal-page | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__delivery__1920x1080__light__baseline | /delivery | light / portal velora-theme portal-page | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__finance__1366x768__dark__baseline | /finance | dark / dark | 677026D6A5F88C1A78EE06BFB615E1D6BC310763197253B01A156036141B28EF | DIRECT |
| hookah_master__finance__1366x768__light__baseline | /finance | light / light | 989AB358AF9A9B3774F5C8112C5CD24D0B2473B3771024633BAE4160E323B4D8 | DIRECT |
| hookah_master__finance__1920x1080__dark__baseline | /finance | dark / dark | 081E1430D328DB119A905A5849C92195ABABBADE1C8E010A71BEA0B0C89FD543 | DIRECT |
| hookah_master__finance__1920x1080__light__baseline | /finance | light / light | E0BCD52C38B0D2DD58F2373BB0B2C42CC7F995EF9438DBDC7240DF0B565D310F | DIRECT |
| hookah_master__finance-categories__1366x768__dark__baseline | /finance/categories | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__finance-categories__1366x768__light__baseline | /finance/categories | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__finance-categories__1920x1080__dark__baseline | /finance/categories | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__finance-categories__1920x1080__light__baseline | /finance/categories | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__finance-payroll__1366x768__dark__baseline | /finance#payroll | dark / dark | 8D58111C209C34D19D10D633DF78CC9725C33D121DE99BF200688251F718E8DC | DIRECT |
| hookah_master__finance-payroll__1366x768__light__baseline | /finance#payroll | light / light | 9833F211E3B317A3DE7E7D8318C68EA81A016213A454D86BF5F99227B6971CFC | DIRECT |
| hookah_master__finance-payroll__1920x1080__dark__baseline | /finance#payroll | dark / dark | 080D9E1D380DA7DCF98A4DE68A26AF41B7D551E68423970F010B5F604D81CE40 | DIRECT |
| hookah_master__finance-payroll__1920x1080__light__baseline | /finance#payroll | light / light | 6AC9E2DD916A9DD344E5CA09ADC221DE4D6B541C9D6A4CB580AC54622048AD8C | DIRECT |
| hookah_master__finance-report__1366x768__dark__baseline | /finance/report | dark / dark | 27B23FA62D7C182F462BACC167547EDE92F19387BFAC5EF67C417DE209C2F39F | DIRECT |
| hookah_master__finance-report__1366x768__light__baseline | /finance/report | light / light | 20E773FBAE59711E1A39CF953F79BE76325DBCED0BF218741C1139C0198BC17F | DIRECT |
| hookah_master__finance-report__1920x1080__dark__baseline | /finance/report | dark / dark | 854CEE431C5B1CCC1F4A3D4A9AAE63BE7E44B6DB0C9602365F2CDB797F4933D9 | DIRECT |
| hookah_master__finance-report__1920x1080__light__baseline | /finance/report | light / light | 064A5B05F2A177D40882B507511ACB74B426455B209DDF16BF85B34CC5D5AAA3 | DIRECT |
| hookah_master__floor__1366x768__dark__baseline | / | dark / staff-theme staff-red-cursor | 59E4B585AA8F59BFE4FAB16A218301871C0AC2ED1E20CAC1BF20F9BA54A65FE0 | DIRECT |
| hookah_master__floor__1366x768__light__baseline | / | light / staff-theme staff-red-cursor | E1096F6F8DECC162DE7E9D7F8AB36927C305C6DADC437FD4F3BAE8CE92DA6EF1 | DIRECT |
| hookah_master__floor__1920x1080__dark__baseline | / | dark / staff-theme staff-red-cursor | 3F164E0E2685327B3F696C789CC2D8A3382E07C54567E01BC7D1D5993FDE02C0 | DIRECT |
| hookah_master__floor__1920x1080__light__baseline | / | light / staff-theme staff-red-cursor | 8DBFDD919ECE0FA71EAB0E770C9450E5CF68B9C4083143A4AB38496F38F692E7 | DIRECT |
| hookah_master__integrations__1366x768__dark__baseline | /integrations | dark / portal velora-theme portal-page | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__integrations__1366x768__light__baseline | /integrations | light / portal velora-theme portal-page | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__integrations__1920x1080__dark__baseline | /integrations | dark / portal velora-theme portal-page | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__integrations__1920x1080__light__baseline | /integrations | light / portal velora-theme portal-page | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__inventory__1366x768__dark__baseline | /inventory | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__inventory__1366x768__light__baseline | /inventory | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__inventory__1920x1080__dark__baseline | /inventory | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__inventory__1920x1080__light__baseline | /inventory | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__inventory-view-auto-orders__1366x768__dark__baseline | /inventory?view=auto-orders | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__inventory-view-auto-orders__1366x768__light__baseline | /inventory?view=auto-orders | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__inventory-view-auto-orders__1920x1080__dark__baseline | /inventory?view=auto-orders | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__inventory-view-auto-orders__1920x1080__light__baseline | /inventory?view=auto-orders | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__inventory-view-directories__1366x768__dark__baseline | /inventory?view=directories | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__inventory-view-directories__1366x768__light__baseline | /inventory?view=directories | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__inventory-view-directories__1920x1080__dark__baseline | /inventory?view=directories | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__inventory-view-directories__1920x1080__light__baseline | /inventory?view=directories | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__inventory-view-movements__1366x768__dark__baseline | /inventory?view=movements | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__inventory-view-movements__1366x768__light__baseline | /inventory?view=movements | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__inventory-view-movements__1920x1080__dark__baseline | /inventory?view=movements | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__inventory-view-movements__1920x1080__light__baseline | /inventory?view=movements | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__inventory-view-premixes__1366x768__dark__baseline | /inventory?view=premixes | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__inventory-view-premixes__1366x768__light__baseline | /inventory?view=premixes | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__inventory-view-premixes__1920x1080__dark__baseline | /inventory?view=premixes | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__inventory-view-premixes__1920x1080__light__baseline | /inventory?view=premixes | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__inventory-view-products__1366x768__dark__baseline | /inventory?view=products | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__inventory-view-products__1366x768__light__baseline | /inventory?view=products | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__inventory-view-products__1920x1080__dark__baseline | /inventory?view=products | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__inventory-view-products__1920x1080__light__baseline | /inventory?view=products | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__inventory-view-recipes__1366x768__dark__baseline | /inventory?view=recipes | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__inventory-view-recipes__1366x768__light__baseline | /inventory?view=recipes | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__inventory-view-recipes__1920x1080__dark__baseline | /inventory?view=recipes | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__inventory-view-recipes__1920x1080__light__baseline | /inventory?view=recipes | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__inventory-view-stock__1366x768__dark__baseline | /inventory?view=stock | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__inventory-view-stock__1366x768__light__baseline | /inventory?view=stock | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__inventory-view-stock__1920x1080__dark__baseline | /inventory?view=stock | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__inventory-view-stock__1920x1080__light__baseline | /inventory?view=stock | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__network__1366x768__dark__baseline | /network | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__network__1366x768__light__baseline | /network | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__network__1920x1080__dark__baseline | /network | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__network__1920x1080__light__baseline | /network | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__orders__1366x768__dark__baseline | /orders | dark / dark | 30CAE4F6247C732E0657020E72BDA77975A29D5B829FFB2D6B8E065717F8F57B | DIRECT |
| hookah_master__orders__1366x768__light__baseline | /orders | light / light | BF86E8594EF8C3282F340B7CEE2318BF4A5EF4B979EFEA7F11B439E1E5B21485 | DIRECT |
| hookah_master__orders__1920x1080__dark__baseline | /orders | dark / dark | F9E290227335EA315A3BC280AB89DA1F8C327528A9BA2A51877086FFDA914B99 | DIRECT |
| hookah_master__orders__1920x1080__light__baseline | /orders | light / light | FFD0261A9C4D0E511AF1EADDCA57AD714399BBF6139852B623A18D39B41F957C | DIRECT |
| hookah_master__reservations__1366x768__dark__baseline | /reservations | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__reservations__1366x768__light__baseline | /reservations | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| hookah_master__reservations__1920x1080__dark__baseline | /reservations | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| hookah_master__reservations__1920x1080__light__baseline | /reservations | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| manager__admin-diagnostics__1366x768__dark__baseline | /admin#diagnostics | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| manager__admin-diagnostics__1366x768__light__baseline | /admin#diagnostics | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| manager__admin-diagnostics__1920x1080__dark__baseline | /admin#diagnostics | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| manager__admin-diagnostics__1920x1080__light__baseline | /admin#diagnostics | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| manager__admin-permissions__1366x768__dark__baseline | /admin#permissions | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| manager__admin-permissions__1366x768__light__baseline | /admin#permissions | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| manager__admin-permissions__1920x1080__dark__baseline | /admin#permissions | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| manager__admin-permissions__1920x1080__light__baseline | /admin#permissions | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| manager__clients__1920x1080__light__baseline | /clients | light / light | EC838408425BC831F302F6A416B60AC1CB6C2EC7DD7F385D33B67C99484355BF | DIRECT |
| manager__delivery__1366x768__dark__baseline | /delivery | dark / portal velora-theme portal-page | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| manager__delivery__1366x768__light__baseline | /delivery | light / portal velora-theme portal-page | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| manager__delivery__1920x1080__dark__baseline | /delivery | dark / portal velora-theme portal-page | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| manager__delivery__1920x1080__light__baseline | /delivery | light / portal velora-theme portal-page | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| manager__finance-categories__1366x768__dark__baseline | /finance/categories | dark / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| manager__finance-categories__1366x768__light__baseline | /finance/categories | light / portal velora-theme | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| manager__finance-categories__1920x1080__dark__baseline | /finance/categories | dark / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| manager__finance-categories__1920x1080__light__baseline | /finance/categories | light / portal velora-theme | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| manager__integrations__1366x768__dark__baseline | /integrations | dark / portal velora-theme portal-page | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| manager__integrations__1366x768__light__baseline | /integrations | light / portal velora-theme portal-page | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| manager__integrations__1920x1080__dark__baseline | /integrations | dark / portal velora-theme portal-page | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| manager__integrations__1920x1080__light__baseline | /integrations | light / portal velora-theme portal-page | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| owner__finance__1920x1080__dark__long-content | /finance | dark / dark | 53145D16FAE33CCF50D059F68CAF15AB59C42AB460CA61B8179313CB7FE59583 | DIRECT |
| owner__finance-payroll__1920x1080__dark__empty | /finance#payroll | dark / dark | 489570D1AF374EA9D0A709159E65947365E848C87E7FB1325014594DD6563A7E | DIRECT |
| owner__finance-payroll__1920x1080__dark__long-content | /finance#payroll | dark / dark | 206FE62F001F849E9A8B34BD029A636205B98264249EE59ED9F48E189EADE366 | DIRECT |

## R4 — bartender fixed baseline and amenities checkpoint

Verdict remains **NOT ACCEPTED / INCOMPLETE; stage PASS 0**. This checkpoint supersedes the earlier statement that the new bartender files were unreviewed. Scope: all 136 current IAB baseline slots (34 routes × 1366×768 / 1920×1080 × requested dark / light) and two requested-light floor long-content slots. Every slot has its own JSON checked. 49 JPGs were opened directly: 44 permitted-route baselines, three separately hashed denied screens and two floor long-content captures. The other 89 denied screens reuse previously directly opened bitmap representatives by identical full SHA256; this proves only the common visible denied composition, not independent theme implementation or functional authorization.

All 138 current JSON pairs report consistent=true, identical before/after URL and nested scroll, and raster dimensions matching CSS viewport. No raster/scroll rejection was found in this set. These checks support capture integrity and do not constitute visual acceptance. Metadata and individual hashes are recorded below. Different hashes of delivery/inventory/reservations at 1366 light were opened separately; their denied cards match the common composition but their pixels are visibly blurred, so fine font assessment is limited. No product cause is assigned to this capture softness.

### Direct observations and existing defects

- **E01 remains:** floor uses the dark staff POS for requested light at both sizes, including the two amenities captures. Portal light baselines are visibly light elsewhere; the coordinator's own preference/API proof does not make these dark POS pixels a light-theme pass. Baseline first hall contains eight free tiles and no selected table. The 210 px POS sidebar / 68 px header differs visibly from the 244 px portal sidebar / 72 px header.
- **V01 remains:** light guests show almost black names on dark cards; light admin shift KPI values and personal report amount are dark on dark; personal finance and its payroll route show a near-white 0 ₽ on white. Dark variants have readable amounts/names. Light orders have very pale yellow status pills, and light shift close action is pale pink on white; exact contrast was not sampled in this review.
- **V05 remains:** 1920 light help shows the near-white “Не нашли ответ?” heading on white. All six topic cards, expanded first topic and feedback form are visible at 1920; feedback content below the 1366 viewport is not evaluated.
- Orders show three open rows with 615 / 410 / 307 ₽, zero revenue; first two preparing and third ready. At 1920 all three rows fit and filters occupy one line; at 1366 the last row is partly below the viewport and filters wrap. This natural viewport boundary is not evidence of missing data.
- Guests show 18 of 18, with staff layout and no owner KPI/archive controls. Only visible rows were inspected: three complete plus a partial fourth at 1366; seven complete plus a partial eighth at 1920. Remaining rows were not scrolled or assessed.
- Tasks have an occupied Open column with repeated long synthetic descriptions, three other columns “Нет задач”. This is not a globally empty task list. At 1920 first two cards are complete and next begins; at 1366 first card extends below the viewport. Task selection/status changes were not executed.
- Notifications show error text and Retry in the dark panel for both themes/sizes. The heading outline is visible; screenshot review alone does not prove keyboard navigation. Retry was not executed.
- The baseline floor preparation queue starts below the tiles at 1920; only its visible first section is evaluated. No new order, dispatch, take, payment or shift-close behavior is accepted from these baselines.

### Second hall capacities, amenities and occupied tiles

Both long-content JPGs were directly opened and checked against r4-table-amenities-fixture-proof.json (POST tables followed by GET floor). Four new free tiles correspond to the readback: Bar 2 guests, no TV/PS5; Shop 7 guests with TV; VIP 1–5 guests with PS5 + TV; Column 3 guests with PS5 + TV. The range 1–5 is visibly preserved. Both badges fit inside the VIP/Column tiles. Six earlier R2 tiles are also visible; first three occupied tiles show 307 / 410 / 615 ₽ and capacity 2, with occupied pink status and elapsed time at bottom right.

All ten tiles and their bottom rows fit in each captured viewport: three columns at 1366, two at 1920. Long names use ellipsis; no observed badge/guest-count/sum/time collision. The elapsed values are 03:16 at 1366 and 03:15 at 1920 from separate captures; this does not verify timer progression. The right pane remains unselected with total 0 and disabled order actions. No exact badge contrast or selected-tile behavior was measured. This establishes visible fixture correspondence, not empty-state or full-light acceptance.

### Scope limits

This checkpoint covers these 138 current bartender slots only. Areas below each viewport, hover/focus/error alternatives beyond the photographed notification error, modals, selected-table states, keyboard interaction and complete workflow behavior remain unverified here. Previously reviewed hookah/manager/owner evidence and unresolved defects retain their individual scope; no global role/theme/state acceptance is inferred.

### Current bartender evidence ledger

DIRECT means a JPG actually opened in this review. SHA_EQUIVALENT entries use the previously directly opened common denied bitmap at the same dimensions, while preserving their own role/route/requested-theme/measured-theme/hash metadata.

| File stem (r2) | Own route | Requested / measured theme | Raster | Full SHA256 | Bitmap review |
|---|---|---|---|---|---|
| bartender__admin__1366x768__dark__baseline | /admin | dark / dark | 1366×768 | DB15418757A02D69EB52F84021C2F689257099CCB9349B3AA0B73AD6B4518B3D | DIRECT |
| bartender__admin__1366x768__light__baseline | /admin | light / light | 1366×768 | 9CF71353E54E0807E838E814D815CC2CD6B2D2BDED56709E3CBD99C070E6B340 | DIRECT |
| bartender__admin__1920x1080__dark__baseline | /admin | dark / dark | 1920×1080 | B5C3D806BF3BA1105D5ACECB0E868576134FCFAD4CAB517D5857240FC48804CA | DIRECT |
| bartender__admin__1920x1080__light__baseline | /admin | light / light | 1920×1080 | AFE9DF0AA2D37929BB3BC8F92E8075194118F68DE412A7B0B38B28F63E987953 | DIRECT |
| bartender__admin-audit__1366x768__dark__baseline | /admin#audit | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-audit__1366x768__light__baseline | /admin#audit | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-audit__1920x1080__dark__baseline | /admin#audit | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-audit__1920x1080__light__baseline | /admin#audit | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-company__1366x768__dark__baseline | /admin#company | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-company__1366x768__light__baseline | /admin#company | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-company__1920x1080__dark__baseline | /admin#company | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-company__1920x1080__light__baseline | /admin#company | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-diagnostics__1366x768__dark__baseline | /admin#diagnostics | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-diagnostics__1366x768__light__baseline | /admin#diagnostics | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-diagnostics__1920x1080__dark__baseline | /admin#diagnostics | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-diagnostics__1920x1080__light__baseline | /admin#diagnostics | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-help__1366x768__dark__baseline | /admin#help | dark / dark | 1366×768 | 5DF672F81974442535B47304109F514EE97FD06790A2090935B29591CAD5A60D | DIRECT |
| bartender__admin-help__1366x768__light__baseline | /admin#help | light / light | 1366×768 | 774C89A1FC0E6ABED91899A0A3DB0EB27B19B14EC8A6B40D016118016A788143 | DIRECT |
| bartender__admin-help__1920x1080__dark__baseline | /admin#help | dark / dark | 1920×1080 | 8DAD4BACB11560890495CF9DABFE346229AFDFB7CAEC91DCB0D8190E02BF48DF | DIRECT |
| bartender__admin-help__1920x1080__light__baseline | /admin#help | light / light | 1920×1080 | E5575112D739320D8E3D09EC69A527944B8C9F72B5232DEAA2445D48AF1DF38F | DIRECT |
| bartender__admin-lock-security__1366x768__dark__baseline | /admin#lock-security | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-lock-security__1366x768__light__baseline | /admin#lock-security | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-lock-security__1920x1080__dark__baseline | /admin#lock-security | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-lock-security__1920x1080__light__baseline | /admin#lock-security | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-loyalty__1366x768__dark__baseline | /admin#loyalty | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-loyalty__1366x768__light__baseline | /admin#loyalty | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-loyalty__1920x1080__dark__baseline | /admin#loyalty | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-loyalty__1920x1080__light__baseline | /admin#loyalty | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-notifications__1366x768__dark__baseline | /admin#notifications | dark / dark | 1366×768 | C9F514584DBF9F8AFCE770647B083B3A689B88E2156EDAE3D577C89E7C9B7C2A | DIRECT |
| bartender__admin-notifications__1366x768__light__baseline | /admin#notifications | light / light | 1366×768 | 0A2C5B967D0E155D65131050C79C4BF4374EF2BE479B459CE8EBA6A643070895 | DIRECT |
| bartender__admin-notifications__1920x1080__dark__baseline | /admin#notifications | dark / dark | 1920×1080 | 296E03DF43CF47FA3255461BDC91DE8A1E8EA4E22A3B30493928EF69197139BA | DIRECT |
| bartender__admin-notifications__1920x1080__light__baseline | /admin#notifications | light / light | 1920×1080 | 95834B4CB8CE20FE9AF4EE4A69E2B9D817F0682C71968F5BB4BB5F61A7CA4080 | DIRECT |
| bartender__admin-permissions__1366x768__dark__baseline | /admin#permissions | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-permissions__1366x768__light__baseline | /admin#permissions | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-permissions__1920x1080__dark__baseline | /admin#permissions | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-permissions__1920x1080__light__baseline | /admin#permissions | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-settings__1366x768__dark__baseline | /admin#settings | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-settings__1366x768__light__baseline | /admin#settings | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-settings__1920x1080__dark__baseline | /admin#settings | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-settings__1920x1080__light__baseline | /admin#settings | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-settings-dashboard-modules__1366x768__dark__baseline | /admin#settings-dashboard-modules | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-settings-dashboard-modules__1366x768__light__baseline | /admin#settings-dashboard-modules | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-settings-dashboard-modules__1920x1080__dark__baseline | /admin#settings-dashboard-modules | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-settings-dashboard-modules__1920x1080__light__baseline | /admin#settings-dashboard-modules | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-shift-control__1366x768__dark__baseline | /admin#shift-control | dark / dark | 1366×768 | 111C0A8A737E758ACE84D2C170D1ECB04E93752FE681034F2DACE7172F3CF71A | DIRECT |
| bartender__admin-shift-control__1366x768__light__baseline | /admin#shift-control | light / light | 1366×768 | 51C5B780F550F61E87F4F6F7CAE159714657FB4D27F4D0C6264AD6CAF7E90E3A | DIRECT |
| bartender__admin-shift-control__1920x1080__dark__baseline | /admin#shift-control | dark / dark | 1920×1080 | 2130E186CC32F6575442278E363605FEBA017CF2AA555361DDDF1C8C4710A842 | DIRECT |
| bartender__admin-shift-control__1920x1080__light__baseline | /admin#shift-control | light / light | 1920×1080 | 0BBF75D8627878A6A32F8CDE2EA4821F5619AC095958EFC32EFA30EC63D38A48 | DIRECT |
| bartender__admin-staff__1366x768__dark__baseline | /admin#staff | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-staff__1366x768__light__baseline | /admin#staff | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-staff__1920x1080__dark__baseline | /admin#staff | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-staff__1920x1080__light__baseline | /admin#staff | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-tasks__1366x768__dark__baseline | /admin#tasks | dark / dark | 1366×768 | 5D9F60C485B36C6F8B8B89B6FA468CDAAB13E4284378658C0D4947C955D9FF53 | DIRECT |
| bartender__admin-tasks__1366x768__light__baseline | /admin#tasks | light / light | 1366×768 | BA10C142B128EA885EC761E4384D1F0E85ECAC9AF2B1307D016A5C57EC59CE4C | DIRECT |
| bartender__admin-tasks__1920x1080__dark__baseline | /admin#tasks | dark / dark | 1920×1080 | 936505AB5CC8604DF83B557CC3E4AB4601C30549E8C0C826CF3E89F337671C52 | DIRECT |
| bartender__admin-tasks__1920x1080__light__baseline | /admin#tasks | light / light | 1920×1080 | 05872EECB45EB19412CA9FA2F5E3131FBE3D4BA521C9C47F094CFC4910521542 | DIRECT |
| bartender__admin-venue-layout-settings__1366x768__dark__baseline | /admin#venue-layout-settings | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-venue-layout-settings__1366x768__light__baseline | /admin#venue-layout-settings | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__admin-venue-layout-settings__1920x1080__dark__baseline | /admin#venue-layout-settings | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__admin-venue-layout-settings__1920x1080__light__baseline | /admin#venue-layout-settings | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__clients__1366x768__dark__baseline | /clients | dark / dark | 1366×768 | 28C4304F4D30CCC65FBF5E62BB613D75480BD48E456F7B736AF6A2D5C3B094B0 | DIRECT |
| bartender__clients__1366x768__light__baseline | /clients | light / light | 1366×768 | D80C6CEFE388972983704095833844E7464D8EF670E3208DD00887A66F80B0BA | DIRECT |
| bartender__clients__1920x1080__dark__baseline | /clients | dark / dark | 1920×1080 | F59DADC8F7AFBBB33DB0AC19785EF5447F10392B8451C8E10BEBF9681A2B3C62 | DIRECT |
| bartender__clients__1920x1080__light__baseline | /clients | light / light | 1920×1080 | 1D498F78B0E0C3C58C5584DD5F119FE99194E5D68989495A795045E3DD40185E | DIRECT |
| bartender__delivery__1366x768__dark__baseline | /delivery | dark / portal velora-theme portal-page | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__delivery__1366x768__light__baseline | /delivery | light / portal velora-theme portal-page | 1366×768 | 6013D4128D16DA8A4581C8335F7B493A05750A0B9DFEF04427166398818A1FC7 | DIRECT |
| bartender__delivery__1920x1080__dark__baseline | /delivery | dark / portal velora-theme portal-page | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__delivery__1920x1080__light__baseline | /delivery | light / portal velora-theme portal-page | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__finance__1366x768__dark__baseline | /finance | dark / dark | 1366×768 | B4123F063B918BCAB4ECD1DDB26D7CDE59207DB504A5C8E6C56A6C2E029C767C | DIRECT |
| bartender__finance__1366x768__light__baseline | /finance | light / light | 1366×768 | BCFD3CB2EF02F3F58B0584D7FA6801BAE6E3A611AA84808840AD11C0D0D0EC88 | DIRECT |
| bartender__finance__1920x1080__dark__baseline | /finance | dark / dark | 1920×1080 | 2D7EA926F7878C6ED10A593836A322585E032729C5FEF4F4447211A234B1D97B | DIRECT |
| bartender__finance__1920x1080__light__baseline | /finance | light / light | 1920×1080 | C3A2AC6688BDF24D28EBC9ADE4AD4CE010EE35ACD4FE60A82B6A89A8967833D2 | DIRECT |
| bartender__finance-categories__1366x768__dark__baseline | /finance/categories | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__finance-categories__1366x768__light__baseline | /finance/categories | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__finance-categories__1920x1080__dark__baseline | /finance/categories | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__finance-categories__1920x1080__light__baseline | /finance/categories | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__finance-payroll__1366x768__dark__baseline | /finance#payroll | dark / dark | 1366×768 | 4E98E1FDAE7234D7D7845BF7B8F8E65B552DC234FDEED336B88431520AB14939 | DIRECT |
| bartender__finance-payroll__1366x768__light__baseline | /finance#payroll | light / light | 1366×768 | 5A23E675F6F387E806EC106D7CA2E1358708189215436106F795B3DF19C60D9D | DIRECT |
| bartender__finance-payroll__1920x1080__dark__baseline | /finance#payroll | dark / dark | 1920×1080 | 83E909605BEF8270184133B15DADB323A55D0FDC6FB55BC831549E73500026E9 | DIRECT |
| bartender__finance-payroll__1920x1080__light__baseline | /finance#payroll | light / light | 1920×1080 | 72A804D9D30F41689FA320A8096FDD8F2F9BC3AD7BBCC5E55994BA26FE59BED4 | DIRECT |
| bartender__finance-report__1366x768__dark__baseline | /finance/report | dark / dark | 1366×768 | C6082942050208A57A59E323E0A2E9E71C67E256BD14ECEEF101152A62BB629B | DIRECT |
| bartender__finance-report__1366x768__light__baseline | /finance/report | light / light | 1366×768 | 481CB7DF7F5C719C90C990D7165BAAAE141FCC3975F986078C03AE009E089880 | DIRECT |
| bartender__finance-report__1920x1080__dark__baseline | /finance/report | dark / dark | 1920×1080 | 968EBA6CE5A81C9F6EDABF8C366396E0106FC61FA9D7EA5CEC2F66017C0832BB | DIRECT |
| bartender__finance-report__1920x1080__light__baseline | /finance/report | light / light | 1920×1080 | B846C2FB98B8078B0167D1FEBB527DDB6E9D13B175D39DE6FB1EC3E4B9BCC4D0 | DIRECT |
| bartender__floor__1366x768__dark__baseline | / | dark / staff-theme staff-red-cursor | 1366×768 | B6A7AF67520E42768B5FC0580CCE50600C2F33C25EC7F654E0AAE59F33B816F0 | DIRECT |
| bartender__floor__1366x768__light__baseline | / | light / staff-theme staff-red-cursor | 1366×768 | 7040160E8358150E01AA36147197D6AF9DA9695BA1070917982850686CC97F56 | DIRECT |
| bartender__floor__1366x768__light__long-content | / | light / staff-theme staff-red-cursor | 1366×768 | FF8B5BF39B0E0A7D26A33C295CD75DE1D9DCD499E07B31060C34BAE959C8385F | DIRECT |
| bartender__floor__1920x1080__dark__baseline | / | dark / staff-theme staff-red-cursor | 1920×1080 | 4A479A7EFD99134370DBEC58D7AF0A726E5BDA94B4EB36480BFB21B2CA8EAFAE | DIRECT |
| bartender__floor__1920x1080__light__baseline | / | light / staff-theme staff-red-cursor | 1920×1080 | 7F09CFC2BBE4E2AC2A99E010653EFCBD959651FC38ABA7B9E3FBE176F132B533 | DIRECT |
| bartender__floor__1920x1080__light__long-content | / | light / staff-theme staff-red-cursor | 1920×1080 | 3F5476C3BA642FF8FCBA32761B7CEC0B0276051290D518B89D5FB8EB5889C006 | DIRECT |
| bartender__integrations__1366x768__dark__baseline | /integrations | dark / portal velora-theme portal-page | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__integrations__1366x768__light__baseline | /integrations | light / portal velora-theme portal-page | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__integrations__1920x1080__dark__baseline | /integrations | dark / portal velora-theme portal-page | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__integrations__1920x1080__light__baseline | /integrations | light / portal velora-theme portal-page | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__inventory__1366x768__dark__baseline | /inventory | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__inventory__1366x768__light__baseline | /inventory | light / portal velora-theme | 1366×768 | 7E3FDD36579FAADB5A513284C8272785AC648B5F60B5BEE048CB636A6F36683E | DIRECT |
| bartender__inventory__1920x1080__dark__baseline | /inventory | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__inventory__1920x1080__light__baseline | /inventory | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__inventory-view-auto-orders__1366x768__dark__baseline | /inventory?view=auto-orders | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__inventory-view-auto-orders__1366x768__light__baseline | /inventory?view=auto-orders | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__inventory-view-auto-orders__1920x1080__dark__baseline | /inventory?view=auto-orders | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__inventory-view-auto-orders__1920x1080__light__baseline | /inventory?view=auto-orders | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__inventory-view-directories__1366x768__dark__baseline | /inventory?view=directories | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__inventory-view-directories__1366x768__light__baseline | /inventory?view=directories | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__inventory-view-directories__1920x1080__dark__baseline | /inventory?view=directories | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__inventory-view-directories__1920x1080__light__baseline | /inventory?view=directories | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__inventory-view-movements__1366x768__dark__baseline | /inventory?view=movements | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__inventory-view-movements__1366x768__light__baseline | /inventory?view=movements | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__inventory-view-movements__1920x1080__dark__baseline | /inventory?view=movements | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__inventory-view-movements__1920x1080__light__baseline | /inventory?view=movements | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__inventory-view-premixes__1366x768__dark__baseline | /inventory?view=premixes | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__inventory-view-premixes__1366x768__light__baseline | /inventory?view=premixes | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__inventory-view-premixes__1920x1080__dark__baseline | /inventory?view=premixes | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__inventory-view-premixes__1920x1080__light__baseline | /inventory?view=premixes | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__inventory-view-products__1366x768__dark__baseline | /inventory?view=products | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__inventory-view-products__1366x768__light__baseline | /inventory?view=products | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__inventory-view-products__1920x1080__dark__baseline | /inventory?view=products | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__inventory-view-products__1920x1080__light__baseline | /inventory?view=products | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__inventory-view-recipes__1366x768__dark__baseline | /inventory?view=recipes | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__inventory-view-recipes__1366x768__light__baseline | /inventory?view=recipes | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__inventory-view-recipes__1920x1080__dark__baseline | /inventory?view=recipes | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__inventory-view-recipes__1920x1080__light__baseline | /inventory?view=recipes | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__inventory-view-stock__1366x768__dark__baseline | /inventory?view=stock | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__inventory-view-stock__1366x768__light__baseline | /inventory?view=stock | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__inventory-view-stock__1920x1080__dark__baseline | /inventory?view=stock | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__inventory-view-stock__1920x1080__light__baseline | /inventory?view=stock | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__network__1366x768__dark__baseline | /network | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__network__1366x768__light__baseline | /network | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__network__1920x1080__dark__baseline | /network | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__network__1920x1080__light__baseline | /network | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__orders__1366x768__dark__baseline | /orders | dark / dark | 1366×768 | D1121101C789DEBC88A71257EDB1809E59B9F7D03746EE9A06A448C04CB5D955 | DIRECT |
| bartender__orders__1366x768__light__baseline | /orders | light / light | 1366×768 | B8AAC53CA1253EA5F6AA1D94490C34374644C1ACE04F768AA26378ACD4C840A4 | DIRECT |
| bartender__orders__1920x1080__dark__baseline | /orders | dark / dark | 1920×1080 | 53B624A5B21EF7D355312A4026BD2FE6DDCFB00F7463D6967871F66162D38360 | DIRECT |
| bartender__orders__1920x1080__light__baseline | /orders | light / light | 1920×1080 | 08FDD658FC5461B38EF36A20CF266B3C9681B82CCDC3EED86605DFDF436BC7D5 | DIRECT |
| bartender__reservations__1366x768__dark__baseline | /reservations | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT_1366 |
| bartender__reservations__1366x768__light__baseline | /reservations | light / portal velora-theme | 1366×768 | 80EFFE90B40082566535EBD6FF975F64A509CA7C28EBB77DAABA3F5530D308E4 | DIRECT |
| bartender__reservations__1920x1080__dark__baseline | /reservations | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |
| bartender__reservations__1920x1080__light__baseline | /reservations | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT_1920 |

## R4 — platform owner, public login replacement and tenant platform denial

**NOT ACCEPTED / INCOMPLETE; stage PASS 0.** Current checkpoint ledger covers 229 baseline slots: platform_owner 34 business routes × four fixed groups plus actual light (170), five platform-owner SaaS overview slots, 30 public login role-intent slots, and 24 tenant-role platform denial slots. Three additional owner-intent public login keyboard-focus and three error captures were directly inspected. In this combined current ledger, 96 JPGs were actually opened; 139 slots reuse a directly opened representative by identical full SHA256. Every ledger row retains its own requested route, resulting URL, intended theme, measured theme and raster; similarity without identical SHA is not used as equivalence.

Before replacement, 20 unique public login bitmaps were directly opened (30 slots including exact equivalence) and showed remembered test login plus masked password. The coordinator subsequently confirmed late autofill between guard and screenshot, replaced all 30 after clearing fields without reload, and labelled clearedFields=true. The old hashes below are historical **SUPERSEDED_AUTOFILL_CAPTURE**, never empty/public baseline acceptance. Current replacements were reopened: 21 unique JPGs and nine identical-SHA slots. These display empty login/password placeholders. Some show password caret/focus from the clearing step; they are not asserted to be unfocused baselines. Their current actual rasters are 1366×768; previous actual login 718×764 images are superseded and cannot supply current small-viewport coverage.

### Separate SaaS palette: limited design confirmation

Read EX-07, platform.html body at line 13, platform.css scoped controls and style.css line 698. The directly opened /platform owner overview at 1366 dark/light, 1920 dark/light, actual light is a consistently dark dedicated SaaS surface: left SaaS navigation, API status, add-company action, four KPI cards and organization registry. At 1920 all three organization rows are visible, with long organization name wrapping to two lines; at 1366 the long name wraps to three lines and the third row continues at the bottom boundary. No visible row/control collision was found in the inspected fixed overview area. Lower state/settings sections and company detail/modals were not inspected.

**Design signoff for the source candidate is limited to keeping this separate fixed platform palette under EX-07.** The captures and scoped CSS support that boundary. Requested light is matrix intent, not evidence of light being applied; coordinator reports platform preferences GET404 before PATCH. This confirmation does not sign off every platform control, contrast, responsive composition or CRM/POS theme behavior, and does not extend the exception to tenant guards.

### Visible limitations / defects

- **R4-V07, actual SaaS navigation composition:** platform_owner platform actual-light 718×764 has navigation taking roughly the first 437 px before the content header. Icon controls occupy a large mostly empty area; the overview heading and add-company action appear below, while the KPI cards only begin at the viewport bottom. This is a visible density/adaptive composition problem to review under UI-03/UI-08; no product cause or full mobile failure is asserted from one screenshot. Fixed layouts do not show this arrangement.
- **R4-V08, actual root denial header overlap:** all directly opened platform_owner root/redirect actual-light staff screens show the hamburger button covering the beginning of “Рабочий зал”. Fixed screens retain the heading but wrap “Панель администратора” across three lines in the sidebar. Requested route is not the photographed business page after redirect.
- **R4-V09, Show password target:** keyboard metadata measures Show button approximately 74.85×34 px at 1366 and 1920 and actual1366; bitmap shows that control and its pink focus ring. Height34 is below STANDARD base control44. Trust checkbox18×18 is a measured glyph/control size only; full label hit area was not measured, so no checkbox hit-area failure is declared. Exact contrast, pointer behavior and form submission are unverified.
- **V10 capture provenance boundary:** late autofill was observed in superseded public images and confirmed by coordinator. Current empty-field pictures support their captured state only. A post-screenshot populated-password guard being prepared by health was not independently inspected in this checkpoint; no password text or credential value is reproduced.

### Denial and pending classification

Platform_owner business slots resolve into two distinct photographed outcomes: 110 common restricted-access portal cards (22 routes × five size/theme groups) and 60 root staff inline-denial/redirect slots (12 routes × five groups). The finance-categories1920light restricted card has a different SHA and was directly opened: visibly blurred, so fine text assessment is limited; no product font cause is asserted. The actual portal restricted card at718×764 is directly opened, its text and two links fit.

All 60 root staff slots show “Рабочее место недоступно для текущих прав”, Retry, zero task/order filters and a **“Проверяем смену…” pending header**. They do not demonstrate settled business baselines, empty tenant business lists, admin help/notification/settings content, or platform access to a tenant. Root pending remains unaccepted even when JSON consistent=true. No tenant/role/security bypass is inferred from bitmap alone.

The 24 tenant /platform captures (owner, manager, bartender, hookah_master × three size intents × two themes) share three full-SHA groups, each with eight own-role entries. Representatives at1366/1920/actual718×764 were directly opened: dark card “Нет доступа к панели владельца”, explanatory text and sign-in link fit without clipping. This records fixed visible denial appearance and each own metadata intent. It does **not** inherit SaaS EX-07 palette acceptance or prove applied tenant light theme, role-switch interactions or functional authorization.

Public login role-intent labels refer to the public page, not five authenticated role sessions. All current empty replacements contain the complete centered form at measured1366/1920. Dark imagery across requested themes belongs to its separately recorded public palette; authenticated CRM/POS light behavior is not inferred.

### Keyboard evidence limits

Three current owner-intent public login dark focus images were directly opened. Their own actionSequence records initial username focus, Tab password → Show → remember → submit, then Shift+Tab remember → Show. Seven recorded steps and their bounding boxes support this local traversal. The final pink Show outline appears at the corresponding location in all three current JPGs, with empty fields. The actual image was replaced during review: intermediate SHA DBC3696C961879472ED9F0209CE5F36DCECBEE17C9A0978AAD7AA7CEB90746AA was directly reopened and lacked the ring despite a Show-ending actionSequence; that intermediate image is REJECTED_FINAL_FOCUS_BITMAP / historical. Coordinator then repeated a fresh forward/back sequence and replaced it with SHA1337D928BCB220F359875BBF00D73D2C9F10FDE8DEE32BF06958A26FB12BA623. That current JPEG was directly reopened and does show the pink ring; its fresh sequence metadata was read. The old rejection is superseded for the current bitmap, without a product-cause claim. The actual sample is measured1366×768. This is limited observed focus traversal; it does not prove every focus state is visibly outlined, validation/error handling, password-toggle activation, login submission, theme switching or auth flow.

### Additional public login error observations

Three owner-intent dark error JPGs (1366,1920,actual measured1366) were directly opened. All show empty placeholders, unchecked remember box, complete submit button and pink “Неверный логин или пароль” message below it, fully inside the form. Own metadata records one UI submit of a nonexistent synthetic account then field clearing, with real authentication failure and no proxy auth injection. The photographed result supports that visible error state, not the general auth workflow, screen-reader announcement, corrected retry or authenticated role access.

### Current evidence ledger

DIRECT is an actually opened current JPG; SHA_EQUIVALENT names a directly opened current or earlier exact representative. Every own JSON was read for URL/raster/theme/consistency and before/after nested-scroll equality. These integrity checks support capture consistency, not acceptance. No current raster/URL/nested-scroll mismatch was found in the selected IAB set; the separate platform1366dark capture has no meta.browser field and is explicitly preserved as separate provenance.

| File stem (r2) | Requested route → resulting URL | Intended / measured theme | Measured raster | Full SHA256 | Bitmap review |
|---|---|---|---|---|---|

| bartender__login__1366x768__dark__baseline | /login → http://127.0.0.1:31952/login | dark /  | 1366×768 | 1E5C0DE1B099A34A2B0756E2C7681BF4254BD728A0E83D0CD837D5D5B29B65E4 | DIRECT |
| bartender__login__1366x768__light__baseline | /login → http://127.0.0.1:31952/login | light /  | 1366×768 | 1E5C0DE1B099A34A2B0756E2C7681BF4254BD728A0E83D0CD837D5D5B29B65E4 | SHA_EQUIVALENT bartender__login__1366x768__dark__baseline |
| bartender__login__1920x1080__dark__baseline | /login → http://127.0.0.1:31952/login | dark /  | 1920×1080 | BDE8D6AF97682D8BFD8B20EAB2E6BF4FA703C0826A4B97B35670E1F25101DD82 | DIRECT |
| bartender__login__1920x1080__light__baseline | /login → http://127.0.0.1:31952/login | light /  | 1920×1080 | 54D4E41BB0D470F8382E01EB179E5B6A0069BE3088359CCDEA73736995E5DEA8 | DIRECT |
| bartender__login__actual__dark__baseline | /login → http://127.0.0.1:31952/login | dark /  | 1366×768 | EDC6DFBC862AE2C8ACFCFFEA30038CE66D3B38B66C44B08499B76E60C2504AE1 | DIRECT |
| bartender__login__actual__light__baseline | /login → http://127.0.0.1:31952/login | light /  | 1366×768 | DBC3696C961879472ED9F0209CE5F36DCECBEE17C9A0978AAD7AA7CEB90746AA | DIRECT |
| bartender__platform__1366x768__dark__baseline | /platform → http://127.0.0.1:31952/platform | dark / portal velora-theme platform-page | 1366×768 | D1383E35569ADC744194944D1CCC407C7D0249581B45928D95CF7C48D38D4482 | DIRECT |
| bartender__platform__1366x768__light__baseline | /platform → http://127.0.0.1:31952/platform | light / portal velora-theme platform-page | 1366×768 | D1383E35569ADC744194944D1CCC407C7D0249581B45928D95CF7C48D38D4482 | SHA_EQUIVALENT bartender__platform__1366x768__dark__baseline |
| bartender__platform__1920x1080__dark__baseline | /platform → http://127.0.0.1:31952/platform | dark / portal velora-theme platform-page | 1920×1080 | 15DC802D950A41C1BFA15078B8E6BCC52E51E7BDBBBDB0BEB15D78A6ED15FF12 | DIRECT |
| bartender__platform__1920x1080__light__baseline | /platform → http://127.0.0.1:31952/platform | light / portal velora-theme platform-page | 1920×1080 | 15DC802D950A41C1BFA15078B8E6BCC52E51E7BDBBBDB0BEB15D78A6ED15FF12 | SHA_EQUIVALENT bartender__platform__1920x1080__dark__baseline |
| bartender__platform__actual__dark__baseline | /platform → http://127.0.0.1:31952/platform | dark / portal velora-theme platform-page | 718×764 | 54D930B385F6411F459D328314D596B6005598097F5CC0FA8F80C87AC4A95263 | DIRECT |
| bartender__platform__actual__light__baseline | /platform → http://127.0.0.1:31952/platform | light / portal velora-theme platform-page | 718×764 | 54D930B385F6411F459D328314D596B6005598097F5CC0FA8F80C87AC4A95263 | SHA_EQUIVALENT bartender__platform__actual__dark__baseline |
| hookah_master__login__1366x768__dark__baseline | /login → http://127.0.0.1:31952/login | dark /  | 1366×768 | DBC3696C961879472ED9F0209CE5F36DCECBEE17C9A0978AAD7AA7CEB90746AA | SHA_EQUIVALENT bartender__login__actual__light__baseline |
| hookah_master__login__1366x768__light__baseline | /login → http://127.0.0.1:31952/login | light /  | 1366×768 | 03997A2EDA8832ABBDC37AE7DB1F2CE4362C3CE5057B80A56C89B4689BA07F7C | DIRECT |
| hookah_master__login__1920x1080__dark__baseline | /login → http://127.0.0.1:31952/login | dark /  | 1920×1080 | 132693DB78E9FA6D1F46C17C5222C6E90FE1D47BE95C97A6D24A727E8D2F3141 | DIRECT |
| hookah_master__login__1920x1080__light__baseline | /login → http://127.0.0.1:31952/login | light /  | 1920×1080 | 132693DB78E9FA6D1F46C17C5222C6E90FE1D47BE95C97A6D24A727E8D2F3141 | SHA_EQUIVALENT hookah_master__login__1920x1080__dark__baseline |
| hookah_master__login__actual__dark__baseline | /login → http://127.0.0.1:31952/login | dark /  | 1366×768 | 0DAB37FC7830D982E1C7ABB30701DE2CCEEA6E27CA11F94E433E922AA6DE5976 | DIRECT |
| hookah_master__login__actual__light__baseline | /login → http://127.0.0.1:31952/login | light /  | 1366×768 | 23806168956A3EB31E441994B4ED64BEC9BB6A04C2F9A0F06104B13010431093 | DIRECT |
| hookah_master__platform__1366x768__dark__baseline | /platform → http://127.0.0.1:31952/platform | dark / portal velora-theme platform-page | 1366×768 | D1383E35569ADC744194944D1CCC407C7D0249581B45928D95CF7C48D38D4482 | SHA_EQUIVALENT bartender__platform__1366x768__dark__baseline |
| hookah_master__platform__1366x768__light__baseline | /platform → http://127.0.0.1:31952/platform | light / portal velora-theme platform-page | 1366×768 | D1383E35569ADC744194944D1CCC407C7D0249581B45928D95CF7C48D38D4482 | SHA_EQUIVALENT bartender__platform__1366x768__dark__baseline |
| hookah_master__platform__1920x1080__dark__baseline | /platform → http://127.0.0.1:31952/platform | dark / portal velora-theme platform-page | 1920×1080 | 15DC802D950A41C1BFA15078B8E6BCC52E51E7BDBBBDB0BEB15D78A6ED15FF12 | SHA_EQUIVALENT bartender__platform__1920x1080__dark__baseline |
| hookah_master__platform__1920x1080__light__baseline | /platform → http://127.0.0.1:31952/platform | light / portal velora-theme platform-page | 1920×1080 | 15DC802D950A41C1BFA15078B8E6BCC52E51E7BDBBBDB0BEB15D78A6ED15FF12 | SHA_EQUIVALENT bartender__platform__1920x1080__dark__baseline |
| hookah_master__platform__actual__dark__baseline | /platform → http://127.0.0.1:31952/platform | dark / portal velora-theme platform-page | 718×764 | 54D930B385F6411F459D328314D596B6005598097F5CC0FA8F80C87AC4A95263 | SHA_EQUIVALENT bartender__platform__actual__dark__baseline |
| hookah_master__platform__actual__light__baseline | /platform → http://127.0.0.1:31952/platform | light / portal velora-theme platform-page | 718×764 | 54D930B385F6411F459D328314D596B6005598097F5CC0FA8F80C87AC4A95263 | SHA_EQUIVALENT bartender__platform__actual__dark__baseline |
| manager__login__1366x768__dark__baseline | /login → http://127.0.0.1:31952/login | dark /  | 1366×768 | DBC3696C961879472ED9F0209CE5F36DCECBEE17C9A0978AAD7AA7CEB90746AA | SHA_EQUIVALENT bartender__login__actual__light__baseline |
| manager__login__1366x768__light__baseline | /login → http://127.0.0.1:31952/login | light /  | 1366×768 | DBC3696C961879472ED9F0209CE5F36DCECBEE17C9A0978AAD7AA7CEB90746AA | SHA_EQUIVALENT bartender__login__actual__light__baseline |
| manager__login__1920x1080__dark__baseline | /login → http://127.0.0.1:31952/login | dark /  | 1920×1080 | 1E52A782764DDD43C3263832CAF4BFB4CCE5FE7AA9EB9E0DCA8F97249A9B1F9E | DIRECT |
| manager__login__1920x1080__light__baseline | /login → http://127.0.0.1:31952/login | light /  | 1920×1080 | AF1E9EFD43BC246B49A0DB603EED8C87D7F1981CF28C6C9755B0326108888E2F | DIRECT |
| manager__login__actual__dark__baseline | /login → http://127.0.0.1:31952/login | dark /  | 1366×768 | EBEAC3F4D33B465DD9E87BB172797CAA5E209C228BB741106420E926C8AE0E8C | DIRECT |
| manager__login__actual__light__baseline | /login → http://127.0.0.1:31952/login | light /  | 1366×768 | EBEAC3F4D33B465DD9E87BB172797CAA5E209C228BB741106420E926C8AE0E8C | SHA_EQUIVALENT manager__login__actual__dark__baseline |
| manager__platform__1366x768__dark__baseline | /platform → http://127.0.0.1:31952/platform | dark / portal velora-theme platform-page | 1366×768 | D1383E35569ADC744194944D1CCC407C7D0249581B45928D95CF7C48D38D4482 | SHA_EQUIVALENT bartender__platform__1366x768__dark__baseline |
| manager__platform__1366x768__light__baseline | /platform → http://127.0.0.1:31952/platform | light / portal velora-theme platform-page | 1366×768 | D1383E35569ADC744194944D1CCC407C7D0249581B45928D95CF7C48D38D4482 | SHA_EQUIVALENT bartender__platform__1366x768__dark__baseline |
| manager__platform__1920x1080__dark__baseline | /platform → http://127.0.0.1:31952/platform | dark / portal velora-theme platform-page | 1920×1080 | 15DC802D950A41C1BFA15078B8E6BCC52E51E7BDBBBDB0BEB15D78A6ED15FF12 | SHA_EQUIVALENT bartender__platform__1920x1080__dark__baseline |
| manager__platform__1920x1080__light__baseline | /platform → http://127.0.0.1:31952/platform | light / portal velora-theme platform-page | 1920×1080 | 15DC802D950A41C1BFA15078B8E6BCC52E51E7BDBBBDB0BEB15D78A6ED15FF12 | SHA_EQUIVALENT bartender__platform__1920x1080__dark__baseline |
| manager__platform__actual__dark__baseline | /platform → http://127.0.0.1:31952/platform | dark / portal velora-theme platform-page | 718×764 | 54D930B385F6411F459D328314D596B6005598097F5CC0FA8F80C87AC4A95263 | SHA_EQUIVALENT bartender__platform__actual__dark__baseline |
| manager__platform__actual__light__baseline | /platform → http://127.0.0.1:31952/platform | light / portal velora-theme platform-page | 718×764 | 54D930B385F6411F459D328314D596B6005598097F5CC0FA8F80C87AC4A95263 | SHA_EQUIVALENT bartender__platform__actual__dark__baseline |
| owner__login__1366x768__dark__baseline | /login → http://127.0.0.1:31952/login | dark /  | 1366×768 | 8D797D085D061530B317D95D878000F0AEB4CD7970A8A46A03359AECC4C719A7 | DIRECT |
| owner__login__1366x768__dark__error | /login → http://127.0.0.1:31952/login | dark /  | 1366×768 | 4DA395A2FB1869960E52C9300DA187527EA5B95CB51353C1416520B3B568CCCC | DIRECT |
| owner__login__1366x768__dark__keyboard-focus | /login → http://127.0.0.1:31952/login | dark /  | 1366×768 | A0B9F6937E10207B2ECC54E49E903EE0E626AC1AA17AD031C393E62D3F95BF61 | DIRECT |
| owner__login__1366x768__light__baseline | /login → http://127.0.0.1:31952/login | light /  | 1366×768 | A581F392025BF807169E3F604D925BD989BB881650954E07E547D1C1BD88C902 | DIRECT |
| owner__login__1920x1080__dark__baseline | /login → http://127.0.0.1:31952/login | dark /  | 1920×1080 | 52456E6F270756E098C3CF69B8BBFC8216BFD23C9A7153B464FFAF919CD53A42 | DIRECT |
| owner__login__1920x1080__dark__error | /login → http://127.0.0.1:31952/login | dark /  | 1920×1080 | 6840A6F9331AA480D7DF31A9555C71C155067A2370A33645853147AAF7E5635E | DIRECT |
| owner__login__1920x1080__dark__keyboard-focus | /login → http://127.0.0.1:31952/login | dark /  | 1920×1080 | A62E3425DAEE8C82D644336B9BB18AA67AF81541C5A0E3648704BB2C712F8716 | DIRECT |
| owner__login__1920x1080__light__baseline | /login → http://127.0.0.1:31952/login | light /  | 1920×1080 | E5C1C25A6067191724D7FC8BB430C9A30A4B0C13F2B0C46640A0056B416B5C7B | DIRECT |
| owner__login__actual__dark__baseline | /login → http://127.0.0.1:31952/login | dark /  | 1366×768 | 16626561B8D611A3DA5D567717C0B7389939304B48360FF15D03839541404B3B | DIRECT |
| owner__login__actual__dark__error | /login → http://127.0.0.1:31952/login | dark /  | 1366×768 | 01640F69B9E924B0791F90237341FDA7E79CA6E0CEFBE76DECBE5E506F617D0D | DIRECT |
| owner__login__actual__dark__keyboard-focus | /login → http://127.0.0.1:31952/login | dark /  | 1366×768 | 1337D928BCB220F359875BBF00D73D2C9F10FDE8DEE32BF06958A26FB12BA623 | DIRECT |
| owner__login__actual__light__baseline | /login → http://127.0.0.1:31952/login | light /  | 1366×768 | 2591425CE9EC29F6BF24D20E598575B3F2BE349776A192F18BE050A81147D2D2 | DIRECT |
| owner__platform__1366x768__dark__baseline | /platform → http://127.0.0.1:31952/platform | dark / portal velora-theme platform-page | 1366×768 | D1383E35569ADC744194944D1CCC407C7D0249581B45928D95CF7C48D38D4482 | SHA_EQUIVALENT bartender__platform__1366x768__dark__baseline |
| owner__platform__1366x768__light__baseline | /platform → http://127.0.0.1:31952/platform | light / portal velora-theme platform-page | 1366×768 | D1383E35569ADC744194944D1CCC407C7D0249581B45928D95CF7C48D38D4482 | SHA_EQUIVALENT bartender__platform__1366x768__dark__baseline |
| owner__platform__1920x1080__dark__baseline | /platform → http://127.0.0.1:31952/platform | dark / portal velora-theme platform-page | 1920×1080 | 15DC802D950A41C1BFA15078B8E6BCC52E51E7BDBBBDB0BEB15D78A6ED15FF12 | SHA_EQUIVALENT bartender__platform__1920x1080__dark__baseline |
| owner__platform__1920x1080__light__baseline | /platform → http://127.0.0.1:31952/platform | light / portal velora-theme platform-page | 1920×1080 | 15DC802D950A41C1BFA15078B8E6BCC52E51E7BDBBBDB0BEB15D78A6ED15FF12 | SHA_EQUIVALENT bartender__platform__1920x1080__dark__baseline |
| owner__platform__actual__dark__baseline | /platform → http://127.0.0.1:31952/platform | dark / portal velora-theme platform-page | 718×764 | 54D930B385F6411F459D328314D596B6005598097F5CC0FA8F80C87AC4A95263 | SHA_EQUIVALENT bartender__platform__actual__dark__baseline |
| owner__platform__actual__light__baseline | /platform → http://127.0.0.1:31952/platform | light / portal velora-theme platform-page | 718×764 | 54D930B385F6411F459D328314D596B6005598097F5CC0FA8F80C87AC4A95263 | SHA_EQUIVALENT bartender__platform__actual__dark__baseline |
| platform_owner__admin__1366x768__dark__baseline | /admin → http://127.0.0.1:31952/ | dark / staff-theme | 1366×768 | DBAB0565DC874EBEE1EC0F4D2D828658561086D221498A7967E74EC47BF75522 | DIRECT |
| platform_owner__admin__1366x768__light__baseline | /admin → http://127.0.0.1:31952/ | light / staff-theme | 1366×768 | B025A8B487F40B11416BFDC57C8C7B886BC76A16EF6A7BB5390BD465EABF556D | DIRECT |
| platform_owner__admin__1920x1080__dark__baseline | /admin → http://127.0.0.1:31952/ | dark / staff-theme | 1920×1080 | F5E5C77D5BDCE8DA7CC3F4D2324BBB48606A88454521E16DC778981A166B2C52 | DIRECT |
| platform_owner__admin__1920x1080__light__baseline | /admin → http://127.0.0.1:31952/ | light / staff-theme | 1920×1080 | D192197D8A38F8ED702C304ABBA7670D20F87FDE5B6AA692EFFB7C65874A57E8 | DIRECT |
| platform_owner__admin__actual__light__baseline | /admin → http://127.0.0.1:31952/ | light / staff-theme | 718×764 | D75F41450325687C1691D5B37B74F0D06014AFA934936EB51C56CD5A7B7E7A1A | DIRECT |
| platform_owner__admin-audit__1366x768__dark__baseline | /admin#audit → http://127.0.0.1:31952/ | dark / staff-theme | 1366×768 | 8C0B8911F79E575349621CC2616280FE74A68AC2D9E548B711BDF663F5D66458 | DIRECT |
| platform_owner__admin-audit__1366x768__light__baseline | /admin#audit → http://127.0.0.1:31952/ | light / staff-theme | 1366×768 | 1086C7097B55A3A724437A17A102475AC169D7B810E75B9E2CFF06D1DB751396 | DIRECT |
| platform_owner__admin-audit__1920x1080__dark__baseline | /admin#audit → http://127.0.0.1:31952/ | dark / staff-theme | 1920×1080 | D81EB99F1DA45DC1E57E1B45E877403C2BA45F9BFB1136F45729BC34E2A4C832 | DIRECT |
| platform_owner__admin-audit__1920x1080__light__baseline | /admin#audit → http://127.0.0.1:31952/ | light / staff-theme | 1920×1080 | 66310E631300DB11AF996E55FE823824286A937AFC6F79534C22D74A0636EA1D | DIRECT |
| platform_owner__admin-audit__actual__light__baseline | /admin#audit → http://127.0.0.1:31952/ | light / staff-theme | 718×764 | C7873AB533BD47F3D7633EAF9D7BC357A717A673D0355397EFA0FF05EFBEC182 | DIRECT |
| platform_owner__admin-company__1366x768__dark__baseline | /admin#company → http://127.0.0.1:31952/ | dark / staff-theme | 1366×768 | 843B5AAF2BBB823DE95501D2585F632B18A5C12AC82D264F917DE771CC2ADDF1 | DIRECT |
| platform_owner__admin-company__1366x768__light__baseline | /admin#company → http://127.0.0.1:31952/ | light / staff-theme | 1366×768 | 4CD8EF2FFA0D4FD149EFAB6F7BEC858B5A1582FE9C3769926E475893B11E977A | DIRECT |
| platform_owner__admin-company__1920x1080__dark__baseline | /admin#company → http://127.0.0.1:31952/ | dark / staff-theme | 1920×1080 | 8C1B07B99F887D43F618F884BC3C8B1EB250DBFC563B2D6568493C02C7E6CA33 | DIRECT |
| platform_owner__admin-company__1920x1080__light__baseline | /admin#company → http://127.0.0.1:31952/ | light / staff-theme | 1920×1080 | 253D5C6BF3AC115D9B65449BB880096389E2D3C32BFD17131B2C922A08B2ABF3 | DIRECT |
| platform_owner__admin-company__actual__light__baseline | /admin#company → http://127.0.0.1:31952/ | light / staff-theme | 718×764 | 7F91414B2B8A748977833797040FF0005C72A38CE621B83038950DD419006B4C | DIRECT |
| platform_owner__admin-diagnostics__1366x768__dark__baseline | /admin#diagnostics → http://127.0.0.1:31952/ | dark / staff-theme | 1366×768 | 1B1CD41E62238D81669BD6616D97F87E99747898AA40C25A0AA34E57D6A0D16A | DIRECT |
| platform_owner__admin-diagnostics__1366x768__light__baseline | /admin#diagnostics → http://127.0.0.1:31952/ | light / staff-theme | 1366×768 | 6C88A380D744F10E617F50C24884E003591734FA37853FE9297F95F167E6D544 | DIRECT |
| platform_owner__admin-diagnostics__1920x1080__dark__baseline | /admin#diagnostics → http://127.0.0.1:31952/ | dark / staff-theme | 1920×1080 | 15A8A378505AA63CCEC540A4D346B4475A74DF03FA217FDD109C3C5D91C04CF1 | DIRECT |
| platform_owner__admin-diagnostics__1920x1080__light__baseline | /admin#diagnostics → http://127.0.0.1:31952/ | light / staff-theme | 1920×1080 | 3D9AB564AE73F1AC14CF67E847D8784653E22DB353110B4F20D1C49B39A8B602 | DIRECT |
| platform_owner__admin-diagnostics__actual__light__baseline | /admin#diagnostics → http://127.0.0.1:31952/ | light / staff-theme | 718×764 | DA6147CAF2E4D83220C8602DC8C98FB687588B0383A1BC4AFEF9F9B49CD554D3 | DIRECT |
| platform_owner__admin-help__1366x768__dark__baseline | /admin#help → http://127.0.0.1:31952/ | dark / staff-theme | 1366×768 | 6D747F4EACD8682C6B7EA510BEAC2E33D8BE48E4BB43601D46A1A09C5A4D8E6E | DIRECT |
| platform_owner__admin-help__1366x768__light__baseline | /admin#help → http://127.0.0.1:31952/ | light / staff-theme | 1366×768 | F70C51135559F8DBCC4D04D3AA80734977D7377BD5965CC8A3AFA11B0FE931FC | DIRECT |
| platform_owner__admin-help__1920x1080__dark__baseline | /admin#help → http://127.0.0.1:31952/ | dark / staff-theme | 1920×1080 | E47E4A51B0FB52C096EC22B88D7E6FF56910AAD7D3E789CF3E9254EBC6065461 | DIRECT |
| platform_owner__admin-help__1920x1080__light__baseline | /admin#help → http://127.0.0.1:31952/ | light / staff-theme | 1920×1080 | 3DCD7C92CEB9357A4C375C8AD4B96DD34ED3CC943A7B2DDD835EB58DDFCF81E4 | DIRECT |
| platform_owner__admin-help__actual__light__baseline | /admin#help → http://127.0.0.1:31952/ | light / staff-theme | 718×764 | 6E0C81C0D9FDBF3FE7ABD389018D81115ADAAC3912DE9B3225D278C38241BDBF | DIRECT |
| platform_owner__admin-lock-security__1366x768__dark__baseline | /admin#lock-security → http://127.0.0.1:31952/ | dark / staff-theme | 1366×768 | 5E86A1D5734032605FD373DA3E952C8B10BE0AC53191680DB451FAFC7B69DE4B | DIRECT |
| platform_owner__admin-lock-security__1366x768__light__baseline | /admin#lock-security → http://127.0.0.1:31952/ | light / staff-theme | 1366×768 | D2D48B15525B4D84CB5518936B52B68724A0175EDC574EF75A656BD173BD2BB1 | DIRECT |
| platform_owner__admin-lock-security__1920x1080__dark__baseline | /admin#lock-security → http://127.0.0.1:31952/ | dark / staff-theme | 1920×1080 | F91E2309D10E4CFE6B9C05EA312EB26AA00139FD41111C511C86D3B5D558FC07 | DIRECT |
| platform_owner__admin-lock-security__1920x1080__light__baseline | /admin#lock-security → http://127.0.0.1:31952/ | light / staff-theme | 1920×1080 | DBFC0E59B611258374E5611F0C469D7C8FB785E136292BD8E8D5F23B4C910DF3 | DIRECT |
| platform_owner__admin-lock-security__actual__light__baseline | /admin#lock-security → http://127.0.0.1:31952/ | light / staff-theme | 718×764 | D3D229C29B410EC67234F282845A641D502CF9F7006CEE4FD005975F87E765DC | DIRECT |
| platform_owner__admin-loyalty__1366x768__dark__baseline | /admin#loyalty → http://127.0.0.1:31952/admin#loyalty | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__admin-loyalty__1366x768__light__baseline | /admin#loyalty → http://127.0.0.1:31952/admin#loyalty | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__admin-loyalty__1920x1080__dark__baseline | /admin#loyalty → http://127.0.0.1:31952/admin#loyalty | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__admin-loyalty__1920x1080__light__baseline | /admin#loyalty → http://127.0.0.1:31952/admin#loyalty | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__admin-loyalty__actual__light__baseline | /admin#loyalty → http://127.0.0.1:31952/admin#loyalty | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | DIRECT |
| platform_owner__admin-notifications__1366x768__dark__baseline | /admin#notifications → http://127.0.0.1:31952/ | dark / staff-theme | 1366×768 | 36867CA408BF17ABC82001F7ED4EB5D4895E0A85E5BB9C1150203E92531B3B84 | DIRECT |
| platform_owner__admin-notifications__1366x768__light__baseline | /admin#notifications → http://127.0.0.1:31952/ | light / staff-theme | 1366×768 | EC5DC1BBC6A6E1E74E243EC1207F61F74D26173503F20D9C028113070758AA73 | DIRECT |
| platform_owner__admin-notifications__1920x1080__dark__baseline | /admin#notifications → http://127.0.0.1:31952/ | dark / staff-theme | 1920×1080 | F364B272BC0B1DA614C33460190CF7AE87448F0908FE5DDF8E9F1A7899FC5D32 | DIRECT |
| platform_owner__admin-notifications__1920x1080__light__baseline | /admin#notifications → http://127.0.0.1:31952/ | light / staff-theme | 1920×1080 | 2C317E32E7036FA0F94414F5E3B87C660BAC0942D514C474EEC1393B6E947FC5 | DIRECT |
| platform_owner__admin-notifications__actual__light__baseline | /admin#notifications → http://127.0.0.1:31952/ | light / staff-theme | 718×764 | 924B2FD1939CBD2873C5F586C1D9F82C083F024AF6BDDABE820A2D87090A78AE | DIRECT |
| platform_owner__admin-permissions__1366x768__dark__baseline | /admin#permissions → http://127.0.0.1:31952/admin#permissions | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__admin-permissions__1366x768__light__baseline | /admin#permissions → http://127.0.0.1:31952/admin#permissions | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__admin-permissions__1920x1080__dark__baseline | /admin#permissions → http://127.0.0.1:31952/admin#permissions | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__admin-permissions__1920x1080__light__baseline | /admin#permissions → http://127.0.0.1:31952/admin#permissions | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__admin-permissions__actual__light__baseline | /admin#permissions → http://127.0.0.1:31952/admin#permissions | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__admin-settings__1366x768__dark__baseline | /admin#settings → http://127.0.0.1:31952/ | dark / staff-theme | 1366×768 | 736D2C17784E477862AD4AC3D40F1FD8E4216E0F5B468CAC4999D5C4ADE62992 | DIRECT |
| platform_owner__admin-settings__1366x768__light__baseline | /admin#settings → http://127.0.0.1:31952/ | light / staff-theme | 1366×768 | 4597F318E84D30BD550B52E7FA13AC535D6B346E29645F3817EAA5B771617A97 | DIRECT |
| platform_owner__admin-settings__1920x1080__dark__baseline | /admin#settings → http://127.0.0.1:31952/ | dark / staff-theme | 1920×1080 | A895E339C9A82EAAFDDC2E700C6A81B0178B3DD579CE931418F0A828C334D7B8 | DIRECT |
| platform_owner__admin-settings__1920x1080__light__baseline | /admin#settings → http://127.0.0.1:31952/ | light / staff-theme | 1920×1080 | 9455D32E408E2403FBA2F3E8A44B8B9BAC643C5B54DEB6A7F1ECC9407265D0C0 | DIRECT |
| platform_owner__admin-settings__actual__light__baseline | /admin#settings → http://127.0.0.1:31952/ | light / staff-theme | 718×764 | 988C06920CCA47AABD5E60ABCD4F3FE5F48EFEA88C0A9580FC881DB039002926 | DIRECT |
| platform_owner__admin-settings-dashboard-modules__1366x768__dark__baseline | /admin#settings-dashboard-modules → http://127.0.0.1:31952/ | dark / staff-theme | 1366×768 | 4EFD39C23174114B73D42556D1E1594D95526960F96A12A033A5C571FFC54167 | DIRECT |
| platform_owner__admin-settings-dashboard-modules__1366x768__light__baseline | /admin#settings-dashboard-modules → http://127.0.0.1:31952/ | light / staff-theme | 1366×768 | 91E7E73E8545867C46972D86951AAE98FBEA4B3987DBEDE8C0552BF28C60E34D | DIRECT |
| platform_owner__admin-settings-dashboard-modules__1920x1080__dark__baseline | /admin#settings-dashboard-modules → http://127.0.0.1:31952/ | dark / staff-theme | 1920×1080 | 60B0589D43ED43ADB2A0065E02A9F4FFD81D466264F6F983935C5C9D1F428713 | DIRECT |
| platform_owner__admin-settings-dashboard-modules__1920x1080__light__baseline | /admin#settings-dashboard-modules → http://127.0.0.1:31952/ | light / staff-theme | 1920×1080 | E515EE1CBF5518B3CA941616152828B05806622CBC1F0C81F01BCC2163F4FCB0 | DIRECT |
| platform_owner__admin-settings-dashboard-modules__actual__light__baseline | /admin#settings-dashboard-modules → http://127.0.0.1:31952/ | light / staff-theme | 718×764 | C5E9BF34C6FDCB07A3B995F315189EE110BB6D80F026EBFA26C4DF2341354E56 | DIRECT |
| platform_owner__admin-shift-control__1366x768__dark__baseline | /admin#shift-control → http://127.0.0.1:31952/admin#shift-control | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__admin-shift-control__1366x768__light__baseline | /admin#shift-control → http://127.0.0.1:31952/admin#shift-control | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__admin-shift-control__1920x1080__dark__baseline | /admin#shift-control → http://127.0.0.1:31952/admin#shift-control | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__admin-shift-control__1920x1080__light__baseline | /admin#shift-control → http://127.0.0.1:31952/admin#shift-control | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__admin-shift-control__actual__light__baseline | /admin#shift-control → http://127.0.0.1:31952/admin#shift-control | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__admin-staff__1366x768__dark__baseline | /admin#staff → http://127.0.0.1:31952/admin#staff | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__admin-staff__1366x768__light__baseline | /admin#staff → http://127.0.0.1:31952/admin#staff | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__admin-staff__1920x1080__dark__baseline | /admin#staff → http://127.0.0.1:31952/admin#staff | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__admin-staff__1920x1080__light__baseline | /admin#staff → http://127.0.0.1:31952/admin#staff | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__admin-staff__actual__light__baseline | /admin#staff → http://127.0.0.1:31952/admin#staff | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__admin-tasks__1366x768__dark__baseline | /admin#tasks → http://127.0.0.1:31952/admin#tasks | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__admin-tasks__1366x768__light__baseline | /admin#tasks → http://127.0.0.1:31952/admin#tasks | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__admin-tasks__1920x1080__dark__baseline | /admin#tasks → http://127.0.0.1:31952/admin#tasks | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__admin-tasks__1920x1080__light__baseline | /admin#tasks → http://127.0.0.1:31952/admin#tasks | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__admin-tasks__actual__light__baseline | /admin#tasks → http://127.0.0.1:31952/admin#tasks | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__admin-venue-layout-settings__1366x768__dark__baseline | /admin#venue-layout-settings → http://127.0.0.1:31952/ | dark / staff-theme | 1366×768 | 736D2C17784E477862AD4AC3D40F1FD8E4216E0F5B468CAC4999D5C4ADE62992 | SHA_EQUIVALENT platform_owner__admin-settings__1366x768__dark__baseline |
| platform_owner__admin-venue-layout-settings__1366x768__light__baseline | /admin#venue-layout-settings → http://127.0.0.1:31952/ | light / staff-theme | 1366×768 | 9BD9A2FC439CE756A8924EB796791F1CAF8C3DA4FA5EDFACA5471D565D9ECB7E | DIRECT |
| platform_owner__admin-venue-layout-settings__1920x1080__dark__baseline | /admin#venue-layout-settings → http://127.0.0.1:31952/ | dark / staff-theme | 1920×1080 | AAA64A14A756E18BAE63480567230306A6CA25B86B2DB33BA8603F12A8D81418 | DIRECT |
| platform_owner__admin-venue-layout-settings__1920x1080__light__baseline | /admin#venue-layout-settings → http://127.0.0.1:31952/ | light / staff-theme | 1920×1080 | 37F2CE55670D149BD08A9BF1294542A10FE42F1C63CD031CD7E081C4CCC2A0CC | DIRECT |
| platform_owner__admin-venue-layout-settings__actual__light__baseline | /admin#venue-layout-settings → http://127.0.0.1:31952/ | light / staff-theme | 718×764 | D6A5FD85D0D5FC67875346295ED1F2815146A9E8E3AC2CB190E853AACDDA3D65 | DIRECT |
| platform_owner__clients__1366x768__dark__baseline | /clients → http://127.0.0.1:31952/clients | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__clients__1366x768__light__baseline | /clients → http://127.0.0.1:31952/clients | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__clients__1920x1080__dark__baseline | /clients → http://127.0.0.1:31952/clients | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__clients__1920x1080__light__baseline | /clients → http://127.0.0.1:31952/clients | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__clients__actual__light__baseline | /clients → http://127.0.0.1:31952/clients | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__delivery__1366x768__dark__baseline | /delivery → http://127.0.0.1:31952/delivery | dark / portal velora-theme portal-page | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__delivery__1366x768__light__baseline | /delivery → http://127.0.0.1:31952/delivery | light / portal velora-theme portal-page | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__delivery__1920x1080__dark__baseline | /delivery → http://127.0.0.1:31952/delivery | dark / portal velora-theme portal-page | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__delivery__1920x1080__light__baseline | /delivery → http://127.0.0.1:31952/delivery | light / portal velora-theme portal-page | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__delivery__actual__light__baseline | /delivery → http://127.0.0.1:31952/delivery | light / portal velora-theme portal-page | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__finance__1366x768__dark__baseline | /finance → http://127.0.0.1:31952/finance | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__finance__1366x768__light__baseline | /finance → http://127.0.0.1:31952/finance | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__finance__1920x1080__dark__baseline | /finance → http://127.0.0.1:31952/finance | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__finance__1920x1080__light__baseline | /finance → http://127.0.0.1:31952/finance | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__finance__actual__light__baseline | /finance → http://127.0.0.1:31952/finance | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__finance-categories__1366x768__dark__baseline | /finance/categories → http://127.0.0.1:31952/finance/categories | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__finance-categories__1366x768__light__baseline | /finance/categories → http://127.0.0.1:31952/finance/categories | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__finance-categories__1920x1080__dark__baseline | /finance/categories → http://127.0.0.1:31952/finance/categories | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__finance-categories__1920x1080__light__baseline | /finance/categories → http://127.0.0.1:31952/finance/categories | light / portal velora-theme | 1920×1080 | 725DC9FC60D742AA9895CC76F9141FE485AE90266C272E5AE7A7C88A1C547D07 | DIRECT |
| platform_owner__finance-categories__actual__light__baseline | /finance/categories → http://127.0.0.1:31952/finance/categories | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__finance-payroll__1366x768__dark__baseline | /finance#payroll → http://127.0.0.1:31952/finance#payroll | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__finance-payroll__1366x768__light__baseline | /finance#payroll → http://127.0.0.1:31952/finance#payroll | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__finance-payroll__1920x1080__dark__baseline | /finance#payroll → http://127.0.0.1:31952/finance#payroll | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__finance-payroll__1920x1080__light__baseline | /finance#payroll → http://127.0.0.1:31952/finance#payroll | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__finance-payroll__actual__light__baseline | /finance#payroll → http://127.0.0.1:31952/finance#payroll | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__finance-report__1366x768__dark__baseline | /finance/report → http://127.0.0.1:31952/finance/report | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__finance-report__1366x768__light__baseline | /finance/report → http://127.0.0.1:31952/finance/report | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__finance-report__1920x1080__dark__baseline | /finance/report → http://127.0.0.1:31952/finance/report | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__finance-report__1920x1080__light__baseline | /finance/report → http://127.0.0.1:31952/finance/report | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__finance-report__actual__light__baseline | /finance/report → http://127.0.0.1:31952/finance/report | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__floor__1366x768__dark__baseline | / → http://127.0.0.1:31952/ | dark / staff-theme | 1366×768 | 93215C3FBCEF9D4E333A21ADEBD01D5A09C37863DBABDFBD585A1CA721E94C14 | DIRECT |
| platform_owner__floor__1366x768__light__baseline | / → http://127.0.0.1:31952/ | light / staff-theme | 1366×768 | BCA288428CEE0601737A9160F7250B18771B3AEBA78450FBD9D4C0D6DC3BA3CD | DIRECT |
| platform_owner__floor__1920x1080__dark__baseline | / → http://127.0.0.1:31952/ | dark / staff-theme | 1920×1080 | 07EFCA66776117653EE0624B4D51A274E9F20E4CF6AE234AEFF24886AF418C5B | DIRECT |
| platform_owner__floor__1920x1080__light__baseline | / → http://127.0.0.1:31952/ | light / staff-theme | 1920×1080 | 13D373D1F883A96FF4AF13B72082B863FD6F9038FC0CC813279F4405037AD6B0 | DIRECT |
| platform_owner__floor__actual__light__baseline | / → http://127.0.0.1:31952/ | light / staff-theme | 718×764 | D170ACEB65D99F6914F8BCBA9CB581F01DDDDE5A319C9FD59322D770AEE956B0 | DIRECT |
| platform_owner__integrations__1366x768__dark__baseline | /integrations → http://127.0.0.1:31952/integrations | dark / portal velora-theme portal-page | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__integrations__1366x768__light__baseline | /integrations → http://127.0.0.1:31952/integrations | light / portal velora-theme portal-page | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__integrations__1920x1080__dark__baseline | /integrations → http://127.0.0.1:31952/integrations | dark / portal velora-theme portal-page | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__integrations__1920x1080__light__baseline | /integrations → http://127.0.0.1:31952/integrations | light / portal velora-theme portal-page | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__integrations__actual__light__baseline | /integrations → http://127.0.0.1:31952/integrations | light / portal velora-theme portal-page | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__inventory__1366x768__dark__baseline | /inventory → http://127.0.0.1:31952/inventory | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__inventory__1366x768__light__baseline | /inventory → http://127.0.0.1:31952/inventory | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__inventory__1920x1080__dark__baseline | /inventory → http://127.0.0.1:31952/inventory | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__inventory__1920x1080__light__baseline | /inventory → http://127.0.0.1:31952/inventory | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__inventory__actual__light__baseline | /inventory → http://127.0.0.1:31952/inventory | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__inventory-view-auto-orders__1366x768__dark__baseline | /inventory?view=auto-orders → http://127.0.0.1:31952/inventory?view=auto-orders | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__inventory-view-auto-orders__1366x768__light__baseline | /inventory?view=auto-orders → http://127.0.0.1:31952/inventory?view=auto-orders | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__inventory-view-auto-orders__1920x1080__dark__baseline | /inventory?view=auto-orders → http://127.0.0.1:31952/inventory?view=auto-orders | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__inventory-view-auto-orders__1920x1080__light__baseline | /inventory?view=auto-orders → http://127.0.0.1:31952/inventory?view=auto-orders | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__inventory-view-auto-orders__actual__light__baseline | /inventory?view=auto-orders → http://127.0.0.1:31952/inventory?view=auto-orders | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__inventory-view-directories__1366x768__dark__baseline | /inventory?view=directories → http://127.0.0.1:31952/inventory?view=directories | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__inventory-view-directories__1366x768__light__baseline | /inventory?view=directories → http://127.0.0.1:31952/inventory?view=directories | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__inventory-view-directories__1920x1080__dark__baseline | /inventory?view=directories → http://127.0.0.1:31952/inventory?view=directories | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__inventory-view-directories__1920x1080__light__baseline | /inventory?view=directories → http://127.0.0.1:31952/inventory?view=directories | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__inventory-view-directories__actual__light__baseline | /inventory?view=directories → http://127.0.0.1:31952/inventory?view=directories | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__inventory-view-movements__1366x768__dark__baseline | /inventory?view=movements → http://127.0.0.1:31952/inventory?view=movements | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__inventory-view-movements__1366x768__light__baseline | /inventory?view=movements → http://127.0.0.1:31952/inventory?view=movements | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__inventory-view-movements__1920x1080__dark__baseline | /inventory?view=movements → http://127.0.0.1:31952/inventory?view=movements | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__inventory-view-movements__1920x1080__light__baseline | /inventory?view=movements → http://127.0.0.1:31952/inventory?view=movements | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__inventory-view-movements__actual__light__baseline | /inventory?view=movements → http://127.0.0.1:31952/inventory?view=movements | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__inventory-view-premixes__1366x768__dark__baseline | /inventory?view=premixes → http://127.0.0.1:31952/inventory?view=premixes | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__inventory-view-premixes__1366x768__light__baseline | /inventory?view=premixes → http://127.0.0.1:31952/inventory?view=premixes | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__inventory-view-premixes__1920x1080__dark__baseline | /inventory?view=premixes → http://127.0.0.1:31952/inventory?view=premixes | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__inventory-view-premixes__1920x1080__light__baseline | /inventory?view=premixes → http://127.0.0.1:31952/inventory?view=premixes | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__inventory-view-premixes__actual__light__baseline | /inventory?view=premixes → http://127.0.0.1:31952/inventory?view=premixes | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__inventory-view-products__1366x768__dark__baseline | /inventory?view=products → http://127.0.0.1:31952/inventory?view=products | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__inventory-view-products__1366x768__light__baseline | /inventory?view=products → http://127.0.0.1:31952/inventory?view=products | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__inventory-view-products__1920x1080__dark__baseline | /inventory?view=products → http://127.0.0.1:31952/inventory?view=products | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__inventory-view-products__1920x1080__light__baseline | /inventory?view=products → http://127.0.0.1:31952/inventory?view=products | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__inventory-view-products__actual__light__baseline | /inventory?view=products → http://127.0.0.1:31952/inventory?view=products | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__inventory-view-recipes__1366x768__dark__baseline | /inventory?view=recipes → http://127.0.0.1:31952/inventory?view=recipes | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__inventory-view-recipes__1366x768__light__baseline | /inventory?view=recipes → http://127.0.0.1:31952/inventory?view=recipes | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__inventory-view-recipes__1920x1080__dark__baseline | /inventory?view=recipes → http://127.0.0.1:31952/inventory?view=recipes | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__inventory-view-recipes__1920x1080__light__baseline | /inventory?view=recipes → http://127.0.0.1:31952/inventory?view=recipes | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__inventory-view-recipes__actual__light__baseline | /inventory?view=recipes → http://127.0.0.1:31952/inventory?view=recipes | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__inventory-view-stock__1366x768__dark__baseline | /inventory?view=stock → http://127.0.0.1:31952/inventory?view=stock | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__inventory-view-stock__1366x768__light__baseline | /inventory?view=stock → http://127.0.0.1:31952/inventory?view=stock | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__inventory-view-stock__1920x1080__dark__baseline | /inventory?view=stock → http://127.0.0.1:31952/inventory?view=stock | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__inventory-view-stock__1920x1080__light__baseline | /inventory?view=stock → http://127.0.0.1:31952/inventory?view=stock | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__inventory-view-stock__actual__light__baseline | /inventory?view=stock → http://127.0.0.1:31952/inventory?view=stock | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__login__1366x768__dark__baseline | /login → http://127.0.0.1:31952/login | dark /  | 1366×768 | 7D3F8B5A4B29A67FA9ECA219D574C81E432EEE2784FDD50A75F15B0DC16B7F9D | DIRECT |
| platform_owner__login__1366x768__light__baseline | /login → http://127.0.0.1:31952/login | light /  | 1366×768 | D82289F69861FC14567992F2BB837742BB6A93CA578AC6FFD675B3FFC494428E | DIRECT |
| platform_owner__login__1920x1080__dark__baseline | /login → http://127.0.0.1:31952/login | dark /  | 1920×1080 | 52456E6F270756E098C3CF69B8BBFC8216BFD23C9A7153B464FFAF919CD53A42 | SHA_EQUIVALENT owner__login__1920x1080__dark__baseline |
| platform_owner__login__1920x1080__light__baseline | /login → http://127.0.0.1:31952/login | light /  | 1920×1080 | 52456E6F270756E098C3CF69B8BBFC8216BFD23C9A7153B464FFAF919CD53A42 | SHA_EQUIVALENT owner__login__1920x1080__dark__baseline |
| platform_owner__login__actual__dark__baseline | /login → http://127.0.0.1:31952/login | dark /  | 1366×768 | 29013A47D130BC28DA49B345A3C2F5986F462086EDE67CF703564E981EEE7C28 | DIRECT |
| platform_owner__login__actual__light__baseline | /login → http://127.0.0.1:31952/login | light /  | 1366×768 | 7D3F8B5A4B29A67FA9ECA219D574C81E432EEE2784FDD50A75F15B0DC16B7F9D | SHA_EQUIVALENT platform_owner__login__1366x768__dark__baseline |
| platform_owner__network__1366x768__dark__baseline | /network → http://127.0.0.1:31952/ | dark / staff-theme | 1366×768 | 13252BD7ECE2EAB661FB6A1F1948C473F3B4D9F3064CAE483BA4AAC11A302DA2 | DIRECT |
| platform_owner__network__1366x768__light__baseline | /network → http://127.0.0.1:31952/ | light / staff-theme | 1366×768 | 80EDB02B289C21614AAFD8DCCA758BC765C51A6085CB9CC016E6A2C8AF08233C | DIRECT |
| platform_owner__network__1920x1080__dark__baseline | /network → http://127.0.0.1:31952/ | dark / staff-theme | 1920×1080 | 38E4531D28B3E55AD3A1CD25A10A5C8F499E010078F6123E4E5FF4DD172A77F4 | DIRECT |
| platform_owner__network__1920x1080__light__baseline | /network → http://127.0.0.1:31952/ | light / staff-theme | 1920×1080 | C81B52B6CD546956AE311FCE1336CD9A4573FBB0C64A3DA5078B9468027742B3 | DIRECT |
| platform_owner__network__actual__light__baseline | /network → http://127.0.0.1:31952/ | light / staff-theme | 718×764 | 47D71E8C1732C103F2FFADC5F087787EBF1D796B8F8761D38CAB8B67249B70A1 | DIRECT |
| platform_owner__orders__1366x768__dark__baseline | /orders → http://127.0.0.1:31952/orders | dark / portal velora-theme portal-page | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__orders__1366x768__light__baseline | /orders → http://127.0.0.1:31952/orders | light / portal velora-theme portal-page | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__orders__1920x1080__dark__baseline | /orders → http://127.0.0.1:31952/orders | dark / portal velora-theme portal-page | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__orders__1920x1080__light__baseline | /orders → http://127.0.0.1:31952/orders | light / portal velora-theme portal-page | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__orders__actual__light__baseline | /orders → http://127.0.0.1:31952/orders | light / portal velora-theme portal-page | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |
| platform_owner__platform__1366x768__dark__baseline | /platform → http://127.0.0.1:31952/platform | dark / portal velora-theme platform-page | 1366×768 | E77EA6A7C075A2D6473447B20DB0BF333887699204253BF3043B944A0F1299B3 | DIRECT |
| platform_owner__platform__1366x768__light__baseline | /platform → http://127.0.0.1:31952/platform | light / portal velora-theme platform-page | 1366×768 | F221DE59461C49689531B841295497881CD4D813ABA196AF6EF7197F88233D96 | DIRECT |
| platform_owner__platform__1920x1080__dark__baseline | /platform → http://127.0.0.1:31952/platform | dark / portal velora-theme platform-page | 1920×1080 | 95BDE0FD5144248584C8AC6559644151FC8C65B52E151323C937393989C0FA2E | DIRECT |
| platform_owner__platform__1920x1080__light__baseline | /platform → http://127.0.0.1:31952/platform | light / portal velora-theme platform-page | 1920×1080 | E79EAB48752BD4A85445452D643F6D673616605905F73A1ABB26F4AB4B5AF765 | DIRECT |
| platform_owner__platform__actual__light__baseline | /platform → http://127.0.0.1:31952/platform | light / portal velora-theme platform-page | 718×764 | D2319E09EB24717782AE105AEB170BF9CF37C8309668ED62CF056B4845B93CAA | DIRECT |
| platform_owner__reservations__1366x768__dark__baseline | /reservations → http://127.0.0.1:31952/reservations | dark / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__reservations__1366x768__light__baseline | /reservations → http://127.0.0.1:31952/reservations | light / portal velora-theme | 1366×768 | 13D8C9212BDC4EF90377D56EC80539BF9BFD71ADA0282DCAB0C88C7EFA340590 | SHA_EQUIVALENT earlier guard1366 |
| platform_owner__reservations__1920x1080__dark__baseline | /reservations → http://127.0.0.1:31952/reservations | dark / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__reservations__1920x1080__light__baseline | /reservations → http://127.0.0.1:31952/reservations | light / portal velora-theme | 1920×1080 | BFAEE89B0DA38FA91F6433A9F17AD4F5B656B37C49C180C8535EFEC959470AB4 | SHA_EQUIVALENT earlier guard1920 |
| platform_owner__reservations__actual__light__baseline | /reservations → http://127.0.0.1:31952/reservations | light / portal velora-theme | 718×764 | C817DBABAC664269C5D2A0120B8B1218F0AA05516EFB39CB5155BC5A5A6A95B6 | SHA_EQUIVALENT platform_owner__admin-loyalty__actual__light__baseline |

### Superseded public autofill bitmap hashes

These original 30 public role-intent slots were examined with 20 directly opened unique representatives before replacement. Historical only; current empty replacements appear in the ledger above.

| Historical file stem | Old full SHA256 | Status |
|---|---|---|
| bartender__login__1366x768__dark__baseline | D555D472CF6748BDBB99D2FEC0811D1D3070A366287DE7D32F8F0ED1F2C1DDA0 | SUPERSEDED_AUTOFILL_CAPTURE |
| bartender__login__1366x768__light__baseline | EBA6CD49D854C46D41EAE4673F54100F42323668334639EF70DF6D612DEB50EF | SUPERSEDED_AUTOFILL_CAPTURE |
| bartender__login__1920x1080__dark__baseline | 70B25D80E10A4CFECAF48CBC94A786DD4E9E4BD0F7B961B3B912FD0E04FEC9A0 | SUPERSEDED_AUTOFILL_CAPTURE |
| bartender__login__1920x1080__light__baseline | 4D877E41F3A4459458A1E7F269E18BB06CE1FA5E4BC2751E77FE6EA6DB511296 | SUPERSEDED_AUTOFILL_CAPTURE |
| bartender__login__actual__dark__baseline | 310FB231E6A36380553413EDF23ED35A47005BFC71691AE56C9EF5E03445366B | SUPERSEDED_AUTOFILL_CAPTURE |
| bartender__login__actual__light__baseline | 310FB231E6A36380553413EDF23ED35A47005BFC71691AE56C9EF5E03445366B | SUPERSEDED_AUTOFILL_CAPTURE |
| hookah_master__login__1366x768__dark__baseline | B819F265CB2B9AE7434F4F7CA5D36525C0455DD824921CE35DFB4BBAEDADFA91 | SUPERSEDED_AUTOFILL_CAPTURE |
| hookah_master__login__1366x768__light__baseline | 5D35DBD76845A38E4EF1F5C940E053F97871248052D84E0387AF166061D3D615 | SUPERSEDED_AUTOFILL_CAPTURE |
| hookah_master__login__1920x1080__dark__baseline | 05A7A4745202689928EBFAED83FAED480A8AFDEC54048906DE77B52281918FE6 | SUPERSEDED_AUTOFILL_CAPTURE |
| hookah_master__login__1920x1080__light__baseline | 2FBC0FACA0F452663616E7D4E3DE1F64A5994855FAB5A975223DB696EBA4F60F | SUPERSEDED_AUTOFILL_CAPTURE |
| hookah_master__login__actual__dark__baseline | 023247F29094B43FAE99C942659793275195A791B7E6DD69A157B7B5632549FD | SUPERSEDED_AUTOFILL_CAPTURE |
| hookah_master__login__actual__light__baseline | BBD42362FA162C99F4E4396F0886E29EA54ED8F194D76A3FA6C0B1C4E47124CC | SUPERSEDED_AUTOFILL_CAPTURE |
| manager__login__1366x768__dark__baseline | B819F265CB2B9AE7434F4F7CA5D36525C0455DD824921CE35DFB4BBAEDADFA91 | SUPERSEDED_AUTOFILL_CAPTURE |
| manager__login__1366x768__light__baseline | B819F265CB2B9AE7434F4F7CA5D36525C0455DD824921CE35DFB4BBAEDADFA91 | SUPERSEDED_AUTOFILL_CAPTURE |
| manager__login__1920x1080__dark__baseline | 52536C4616BC5B0CF41D4327522727A42DBDBC4B2D93CF1842B6DE703DA79157 | SUPERSEDED_AUTOFILL_CAPTURE |
| manager__login__1920x1080__light__baseline | 38915CBA36587351D8369E7B1653E0D34111B3ABFE70E91B9CD4EA610F1C87E7 | SUPERSEDED_AUTOFILL_CAPTURE |
| manager__login__actual__dark__baseline | 02E91F261F758CFCB220C69EB510E59BCC2835A754463B8D7194859246BDB09E | SUPERSEDED_AUTOFILL_CAPTURE |
| manager__login__actual__light__baseline | 023247F29094B43FAE99C942659793275195A791B7E6DD69A157B7B5632549FD | SUPERSEDED_AUTOFILL_CAPTURE |
| owner__login__1366x768__dark__baseline | C1D61BEC1F6EC9A1355C60E8DB88AC73AF5A78A97472EA171FFCD084A883DD97 | SUPERSEDED_AUTOFILL_CAPTURE |
| owner__login__1366x768__light__baseline | B819F265CB2B9AE7434F4F7CA5D36525C0455DD824921CE35DFB4BBAEDADFA91 | SUPERSEDED_AUTOFILL_CAPTURE |
| owner__login__1920x1080__dark__baseline | 52536C4616BC5B0CF41D4327522727A42DBDBC4B2D93CF1842B6DE703DA79157 | SUPERSEDED_AUTOFILL_CAPTURE |
| owner__login__1920x1080__light__baseline | 52536C4616BC5B0CF41D4327522727A42DBDBC4B2D93CF1842B6DE703DA79157 | SUPERSEDED_AUTOFILL_CAPTURE |
| owner__login__actual__dark__baseline | 4DD069CAB9A126CC5AA378EFFA38BF243643A5311B460C7AD3595DD671C1A46F | SUPERSEDED_AUTOFILL_CAPTURE |
| owner__login__actual__light__baseline | 3A53EF665EAD07CCE600C77776B6D70743CDDB3074AAA3FAD9AFEC1BD8D9ADE3 | SUPERSEDED_AUTOFILL_CAPTURE |
| platform_owner__login__1366x768__dark__baseline | EBA6CD49D854C46D41EAE4673F54100F42323668334639EF70DF6D612DEB50EF | SUPERSEDED_AUTOFILL_CAPTURE |
| platform_owner__login__1366x768__light__baseline | E76C96E03455E711A1F686181E39FD930D77A1E137EF16B790C30C70918A179B | SUPERSEDED_AUTOFILL_CAPTURE |
| platform_owner__login__1920x1080__dark__baseline | 29E99F3A4BE4B39F0E7856118D6F0174CCD230F7B1E77B04F2C92775BA871226 | SUPERSEDED_AUTOFILL_CAPTURE |
| platform_owner__login__1920x1080__light__baseline | D8642E0B08AC4663B1E526CF73FCA8ABB64C5111AA04241B923797F67F27FAE1 | SUPERSEDED_AUTOFILL_CAPTURE |
| platform_owner__login__actual__dark__baseline | 310FB231E6A36380553413EDF23ED35A47005BFC71691AE56C9EF5E03445366B | SUPERSEDED_AUTOFILL_CAPTURE |
| platform_owner__login__actual__light__baseline | 310FB231E6A36380553413EDF23ED35A47005BFC71691AE56C9EF5E03445366B | SUPERSEDED_AUTOFILL_CAPTURE |

### Final coordinator checkpoint boundary

Coordinator reports 1145 current evidence hashes matching health, source 215 unchanged and controller mode normal. These are coordinator provenance statements, not an assertion that this visual reviewer directly opened all 1145 images. The independently inspected current login focus SHA 1337D928BCB220F359875BBF00D73D2C9F10FDE8DEE32BF06958A26FB12BA623 and three error frames are included above. Proposed applicability ledger: 42 groups / 198 states, not adopted, 0 accepted. Current checkpoint remains NOT ACCEPTED / INCOMPLETE, overall PASS 0. Unopened images and unproven state/flow coverage remain pending; this checkpoint does not complete UI-01.2.


## R4 reservation dialog supplement — fresh IAB tab 2

Seven current JPGs were directly opened (five matrix states plus two supplementary scenes); each own JSON was read. The fresh actual viewport is **1280×720**, distinct from earlier actual samples. Fixed long-content rasters are 1366×768 and 1920×1080. The six standard-schema captures report consistent=true; their before/after visibleText, viewport and nestedScroll match on independent JSON comparison. This supports capture stability only, not state or workflow acceptance. The Escape supplement has a different, reduced JSON schema: route/focus/sequence/snapshot, with no raster or before/after integrity fields. Its bitmap is directly reviewed, but it must not inherit the six other captures' consistency proof.

### Actually visible states

- **Actual error / step 1:** empty guest field, native validation popover “Укажите имя гостя” and the same inline pink message below Next are visible. The popover temporarily covers part of the guest helper. Modal heading, Close, phone field and Next remain visible inside the raster. Metadata records empty guest → Next; no reservation submit. This is local required-field validation evidence, not booking failure or persistence evidence.
- **Actual keyboard focus / step 1:** final Next has a clearly visible pink outline; own metadata ends on reservation-next with solid pink 1.6px outline / 2.4px offset and 44.8px height. Fresh Tab/Shift+Tab sequence records guest → phone → Next → phone → guest → phone → Next. The long single-line guest value is horizontally clipped in its input, as expected for an unexpanded text field; this frame does not prove full guest-text readability or every intermediate input focus treatment. Additional Tab reaching BODY remains unresolved browser/native-cycle evidence; no product focus-trap failure or trap PASS is asserted.
- **Long-content step 3, all three sizes:** entire modal and footer are visible. Long guest name wraps into two summary lines; selected VIP place shows capacity 1–5 and guest count 2. Deposit 0 and no-deposit helper are visible. Long comment occupies a bounded approximately 60.8px textarea with its own scrollbar; the entire comment is not visible at once. Back and Confirm remain separated and inside the raster, with no observed summary/control collision. These scenes are unsaved confirmation previews, not a completed booking.
- **Expanded custom picker / actual:** long zone heading and first long table option wrap visibly without overlapping the next option. The picker has a bounded inner scroll area, and the enclosing modal also has a scrollbar. Only the top group and first options are actually visible; lower R2/VIP options listed in AX are not visually evidenced here. Modal footer lies below the current clipped viewport and requires scrolling; this single frame does not prove footer reachability, lower-list readability, or picker keyboard behavior. DOM control rectangles for lower options extend beyond the clipped picker and must not be treated as visible rows.
- **Escape return / actual:** reservation modal is absent and “Новая бронь” has a visible pink outline. Own reduced metadata records Escape from step 1, focus id focus-reservation and 220×56px rectangle matching the visible control. This supports observed close/return focus only. It does not independently prove the preceding Back2→Back1 guest-preservation sequence, which the coordinator reports but no intermediate bitmap in this seven-scene set depicts.

No new product defect is established from these scenes. Exact contrast, complete dialog tab cycle, all scroll positions, full long-comment reading, Back-state retention and booking submission/persistence remain unproven. AX snapshots also contain lock-dialog text that is not visible in the inspected JPGs; it is not treated as evidence of a visible lock state. No new booking mutation was performed by this reviewer. Overall checkpoint remains **NOT ACCEPTED / INCOMPLETE, PASS 0**.

### Directly inspected current reservation evidence

| Evidence stem | Measured raster | SHA256 | Review scope |
| --- | --- | --- | --- |
| owner__reservations__1366x768__dark__long-content | 1366×768 | 316F9B6205F693022CF07B480ABFA197E0B5DF5440419B75F67D48C5C7535E46 | DIRECT; long-content |
| owner__reservations__1920x1080__dark__long-content | 1920×1080 | 71630AFC28BAF3ABC05AAD06174102390DE9C517AF787693722E2E5D6B56D8FB | DIRECT; long-content |
| owner__reservations__actual__dark__error | 1280×720 | C636EF16872E082E28023D50B7127B00930F4A7DFC61E47C02A5AFAA7955A761 | DIRECT; error |
| owner__reservations__actual__dark__keyboard-focus | 1280×720 | 00ACC58E432732696D24318F8E4ABBC4C261B0F08843FCF0C9B49A4EF93EE996 | DIRECT; keyboard-focus |
| owner__reservations__actual__dark__long-content | 1280×720 | 9AAFA5E39917006E3A3F5FA17CA1261AF54D7821C1B54EB169DE2048E28DEFA1 | DIRECT; long-content |
| owner-reservation-escape-return | 1280×720 visually opened; reduced JSON lacks raster field | 446B74C475CBD3C4F7C48F432AD47A3751165202C2EC3A6297C6B7A51FBDBB77 | DIRECT; Escape return, reduced integrity provenance |
| owner-reservation-step2-expanded-picker | 1280×720 | 839BA12560416A7A24C2C9E5869520DB7D7B0AC8CAA17BA08897163864398BC6 | DIRECT; long-content |


## R4 personal lock settings supplement — final browser checkpoint

Four current native 1280×720 JPGs were directly opened; each own JSON was read. Route is /admin#lock-security, owner, dark. The matrix keyboard-focus record has raster1280×720 and consistent=true; before/after visibleText and nestedScroll match. The three component JSONs use a supplementary schema without raster/consistent fields: their before/after text, URL, viewport and nestedScroll independently match, but they do not inherit matrix raster-integrity flags. All scenes show empty PIN inputs or the returned settings page; metadata reports no Save / securityPreferenceChanged=false.

- **Keyboard focus:** entire dialog fits, with empty new/repeated PIN inputs, interval trigger and Save visible. Current Close has a visible pink focus border in the JPG. Own sequence records Close → Tab new PIN → Tab repeat PIN → Shift+Tab new PIN → Shift+Tab Close. Input focus rectangles record a low-alpha pink outline; only the final Close focus bitmap is directly evidenced, so intermediate focus visibility is not accepted from metadata alone.
- **Expanded interval:** the current “Не блокировать автоматически” option is visibly highlighted, followed by “Через 1 мин”. The dialog has a visible outer scrollbar and clips lower options/Save below its current content window. Lower 5/10/15/30-minute rectangles listed in metrics are not visible in the bitmap and are not accepted as visual evidence. Scrolling all options / returning to Save remains unproven by this frame.
- **First Escape:** list is closed while the lock settings dialog remains open. Interval trigger has a visible pink focus border, matching the recorded focus label and 44px height. Own scene metadata attributes this to Escape from the actual active option.
- **Second Escape:** dialog is absent; “Настроить защиту” has a clear pink focus outline, matching focus id open-security-settings. This supports local observed close/return focus, not a complete dialog focus cycle, changed preference or PIN behavior.

**R4-V11 — undersized security controls:** Close is measured36×36px; the returned “Настроить защиту” trigger is approximately138.76×36px; interval option rows are approximately360.40×37.2px. These visible/control measurements fall below the standard44px target dimension. The interval trigger itself is44px, and both PIN inputs are48px high. This is a size finding; exact contrast and expanded hit regions were not measured. Lower clipped option rows are not individually visually accepted.

The earlier experimental Escape from a trigger with retargeting is superseded by the actual-active-option sequence above and is not asserted as a product bug. No Save, new PIN or security mutation was performed. Overall stage remains **NOT ACCEPTED / INCOMPLETE, PASS0**; browser collection is closed for this checkpoint, not completion of UI-01.2.

| Directly opened evidence stem | SHA256 |
| --- | --- |
| owner__admin-lock-security__actual__dark__keyboard-focus | 389434A30BF5A6244F2FA2E82033D5132E4C8AAEFAA26358A0BC460C7ED5CF6A |
| owner-lock-first-escape | F59B98814D626F5D46B036661E71CA6C307175BC62B8A298E323FC1B4F06E0DD |
| owner-lock-second-escape | 612C5CE2D95FBFA238AB1D1F257FDEEF2B23E6E86D23E71E7800FE51BB4AE5D9 |
| owner-lock-settings-expanded-interval | 278139A084A4730A9774AFFD9A73105C75593E4A4D569921AB5C7DF30584C0C2 |
