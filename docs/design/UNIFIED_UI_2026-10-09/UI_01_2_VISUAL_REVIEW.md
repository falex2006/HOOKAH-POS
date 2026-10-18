# UI-01.2 — визуальное ревью частичной исходной базы

2026-10-09 · `design_lead` / `visual_auditor`. **Вердикт: NOT ACCEPTED / INCOMPLETE.** Это ревью реально осмотренных локальных JPG и выбранных raw DOM JSON, а не приёмка всех ролей, маршрутов и состояний. Продуктовые файлы, CSS, права и данные этим исполнителем не изменялись. Браузер контролировал координатор; аудитор использовал `view_image` для локальных файлов.

Основание: UI-01.2 в PROMPTS, STANDARD v1.0, COMPONENT_CATALOG C01–C18, EXCEPTIONS EX-01–08, ROUTE_ROLE_MATRIX, UI_01_2_COVERAGE_PLAN. Геометрия цели и новые токены остаются кандидатами; исходное отклонение не объявляется исправленным. Среда координатора — loopback `127.0.0.1:31952`, изолированный PostgreSQL fixture; provenance и auth относятся к отчёту среды, а не доказываются сходством изображения.

## Граница доказательств

На момент ревью в evidence/UI-01.2 находятся 72 JPG: owner/dark, включая публичный login. Все 72 фактически открыты через `view_image`; классификация каждого ниже. Ревью различает видимое содержимое и доказанную приёмку: даже settled содержимое не получает PASS из-за неполноты состояний и проблем соответствия raster/DOM. Старые неудачные попытки частично перезаписаны; их первоначальные loading/login изображения не являются текущими эталонами. Повторный проход после `/login` потребовал новой сессии: экран входа нельзя включать внутрь непрерывного role batch без учёта изменения auth.

Координатор сообщил об остановке CUA: timeout batch, reset kernel, затем `Unable to load browser` / request-header policy и `Statsig timeout` при инвентаризации Edge. Пересъёмка и продолжение keyboard/theme/role прохода недоступны. Это **BLOCKED_ENV**, не отказ бизнес-прав и не неисправность продукта.

Нет снимков manager, hookah_master, bartender, platform_owner, светлой темы, dialog/wizard/PIN, самостоятельного keyboard прохода, контролируемой ошибки, полного empty/no-results и long-content сценария. Длинные fixture названия в baseline дают частичные наблюдения переноса, но не заменяют матрицу состояний. Отсутствие снимка не означает N/A. Ни одной запрещённой role×route пары это ревью не подтверждает.

## Качество привязки screenshot к измерениям

1. Нативные размеры JPG проверены чтением image metadata. Например, `owner__orders__1366x768__dark__baseline.jpg` имеет **1366×740**, тогда как его JSON сообщает `innerWidth=1366`, `innerHeight=768`. У floor 1366 JPG sidebar визуально около 150px, а JSON сообщает 210px; изображение похоже на масштабированную компоновку большего viewport. Причина capture scaling/момента съёмки не установлена. Нельзя трактовать bitmap px как CSS px или объявлять доказанным viewport по имени файла. Индекс ниже сохраняет реальные размеры raster отдельно; `browserZoom` в JSON остаётся `unknown`.
2. В controls/headings/smallText есть элементы, отсутствующие на bitmap: скрытый PIN «Выйти из системы», ссылки закрытых групп и элементы ниже первого экрана. Поэтому общий минимум всех rect не является hit-area видимых контролов. Аудитор использовал только элементы, визуально присутствующие на соответствующем снимке; для повторной автоматизации нужен доказанный visibility фильтр, включая закрытые details, aria-hidden/opacity ancestors и границы viewport.
3. Несколько admin hash filenames показывают предыдущую область: `admin-tasks` — роли, `admin-loyalty` — задачи, `admin-venue-layout-settings` — company, `admin-lock-security` — layout. Это несогласованность capture/route-ready; источник не даёт права назвать соответствующую целевую страницу проверенной или обвинить продукт в сломанном роутинге.
4. Присутствующее pending состояние не равно settled baseline. Staff, permissions, directories, payroll, notifications и shift-control имеют видимые loading подписи. Без recorded pending trigger они также не закрывают плановый loading сценарий со стабильностью и поведением.

## Подтверждённые наблюдения и следующий владелец

| ID / компоненты | Наблюдение и фактическое основание | Ограничение / владелец |
|---|---|---|
| D02 / C01 | Raw DOM 1920 dark: floor sidebar/contentX **210px**, orders/clients/reservations **280px**; header **68px** у всех. На JPG 1920 виден тот же переход между рабочей и управленческой оболочкой. Raw DOM 1366: floor 210, orders 245.95; header 68. | Разница ширины подтверждена для owner; исторический header 68↔72 этим пакетом не воспроизведён. Синхронный переход с контрольными кадрами, остальные роли и темы не проверены; system_architect + UI-03.1. EX-07 сохраняет контурные различия, кандидат 210 не автоматически задаёт management width. |
| D09 / C03/C07 | На settled floor 1920 видны tabs «Гости» **42.51×21.6**, «Заметки» **63.9×21.6**; density range **128×32**. На orders — sidebar «Выйти» **215.2×32**, search **235×42**. Это rect соответствующих элементов в JSON. | Меньше цели 44px; focus/hover/реальная расширенная hit-area вне rect не проверены. Не использовать скрытый PIN как минимальный control. frontend + UI-02.2. |
| D17 / C02/C15/C16 | Floor 1920 «2 гостя» computed **11px / 12.1px / 400**, portal header роль **10px / 11.5px / 400**. Финансовая подпись «0 заказов без полной оплаты» визуально очень мелкая; source `.dashboard-revenue-pending-details small` задаёт 9px. В admin heading raw computed есть промежуточные 760/720. | 9px именно этой подписи отдельным computed замером не подтверждены; mode menu не раскрывался. Static face source 400/500/600/700/800 не доказывает фактически выбранный glyph face или synthesis; JSON fontFaceInventory не доступен. Полная D17 остаётся непроверенной; design_lead/frontend UI-02.2. |
| UI012-V01 / C04/C05 | На recipes во всех трёх осмотренных размерах label поиска, узкий input с обрезанным placeholder и label «Категория» слиты в одну строку; select растянут следующей строкой. В отличие от соседних складских фильтров отсутствует ясная группировка поля. | Воспроизвести owner → inventory?view=recipes, сравнить фильтры. Это видимый исходный дефект формы, связь с историческим CSS D01 без проверки причины не утверждается. frontend, UI-06.1/02.2. |
| UI012-V02 / C02/C09 | На audit и diagnostics 1366 в строке фильтров «Экспорт CSV» выступает за правую границу панели и уходит к краю снимка. | Видимое clipping/overflow observation; масштаб raster/DOM надо восстановить перед точной геометрией. frontend, UI-08.3/06.1. |
| C15/EX-06 | Settled floor показывает 8 свободных столов, панель «Стол не выбран», отдельное приготовление и закрытую смену. Длинный первый стол обрезан ellipsis; header tenant/user тоже ellipsis без явного наложения на соседние действия. POS CTA «Панель администратора» переносится на 3 строки при узком sidebar. | Продуктовая работоспособность заказа/tooltip полного названия не проверена. Перенос CTA — кандидат полировки, не доказанный RBAC дефект. design_lead/UI-05.1. |
| C09/C14/C16 | Orders — 0 и no-results текст; clients — 12 карточек; stock/recipes/auto-orders/movements/premixes — предметные empty сообщения; reservations — нет брони именно на выбранную дату. Суммы имеют ₽, unknown средний чек отображён «—». | Empty конкретного периода/фильтра не равен empty всей БД. Скриншот не подтверждает расчёты или сохранение. QA/доменные владельцы. |
| C17/EX-05 | Существующие brand gradients и красно-оранжевые selected/CTA видны; их назначение — выбранный раздел/основное действие. Новые декоративные решения не вводились. | Контраст белого текста на каждом участке gradient, composited поверхностей, reduced-motion, курсор и fallback не измерены. Не объявлять контраст PASS; UI-02.2. |

У resolved baseline header/контролов нельзя переносить PASS на невидимые состояния. Необычная плотность empty reservations и крупный page heading фиксируются как кандидаты последующей миграции, без немедленного продуктового изменения.

## Компоненты и допустимый reuse при продолжении

C01–C09, C13–C17 частично видимы; C10 только pending staff shell, ни table 5 columns, ни сохранение cards scale не проверены. C11/C12 диалоги не открывались; C18 только login, PIN/top layer и возврат фокуса отсутствуют. Login не содержит бизнес-таблицы/зал (C09/C15 N/A для этой поверхности), но формы, focus, error/pending применимы. Нельзя считать C11/C12/C18 N/A глобально по отсутствию снимка.

Сохранять все 180 role×route и 6480 state ячеек. Общую доказанную denied поверхность допустимо переиспользовать только для одинакового final UI/viewport/theme с отдельным исходом сессии и маршрута каждой роли; четыре denied business-content состояния N/A лишь после baseline+keyboard отказа. Auth failure, service failure и denied_expected разделять. Owner public login может быть общей формой только с явно записанным публичным сценарием; он не доказывает последующее разрешение других ролей. Actual можно ссылать на совпадающий viewport только после измерения совпадения; здесь native actual и именованные файлы различаются.

Статичная integrations placeholder «В разработке» не имеет подключённой формы: её business-data empty/loading и submit error могут оказаться N/A после точной source/runtime проверки отсутствующего региона, но shell auth/loading остаётся самостоятельным сценарием. Не скрывать под N/A notifications denied API, manager payroll denied API и собственные employee payments.

Для завершения нужны восстановленный CUA, положительное page-specific settled состояние после navigation/hash, fonts готовность, синхронная запись viewport+bitmap с известным zoom, отдельные role/theme/state/focus проверки и raw contrast пары. Владельцы: координатор/QA — полнота evidence; system_architect — shell/routes/denied; design_lead — итоговое визуальное подтверждение. Следующий UI-подэтап этим ревью не принимается.

## Индекс фактически осмотренных JPG

В каждой строке `baseline` — метка capture, а не PASS. `OBSERVED_CONTENT` означает, что виден целевой settled контент; для приёмки остаются оговорённые выше ограничения. `PENDING_CAPTURE` и `MISMATCH_CAPTURE` не закрывают baseline целевой области. Native raster размеры не равны автоматически CSS viewport.

| JPG / raw JSON с тем же basename | Native raster | Классификация / видимое состояние |
|---|---|---|
| [owner__admin__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__admin__1366x768__dark__baseline.jpg) | 1366×740 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__admin__1920x1080__dark__baseline.jpg](evidence/UI-01.2/owner__admin__1920x1080__dark__baseline.jpg) | 1920×1080 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__admin__actual__dark__baseline.jpg](evidence/UI-01.2/owner__admin__actual__dark__baseline.jpg) | 1528×828 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__admin-audit__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__admin-audit__1366x768__dark__baseline.jpg) | 1366×768 | OBSERVED_WITH_DEFECT — журнал / UI012-V02 clipping; фрагмент |
| [owner__admin-company__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__admin-company__1366x768__dark__baseline.jpg) | 1366×768 | INITIAL_FORM_CAPTURE — поля ещё пустые, loaded company не подтверждена |
| [owner__admin-diagnostics__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__admin-diagnostics__1366x768__dark__baseline.jpg) | 1366×768 | OBSERVED_WITH_DEFECT — журнал / UI012-V02 clipping; фрагмент |
| [owner__admin-help__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__admin-help__1366x768__dark__baseline.jpg) | 1366×768 | OBSTRUCTED_CAPTURE — help частично перекрыт notification-center |
| [owner__admin-lock-security__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__admin-lock-security__1366x768__dark__baseline.jpg) | 1366×768 | MISMATCH_CAPTURE — показана схема зала |
| [owner__admin-loyalty__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__admin-loyalty__1366x768__dark__baseline.jpg) | 1366×768 | MISMATCH_CAPTURE — показаны задачи, не loyalty |
| [owner__admin-notifications__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__admin-notifications__1366x768__dark__baseline.jpg) | 1366×768 | PENDING_CAPTURE — видимое loading, baseline не подтверждён |
| [owner__admin-permissions__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__admin-permissions__1366x768__dark__baseline.jpg) | 1366×768 | PENDING_CAPTURE — видимое loading, baseline не подтверждён |
| [owner__admin-settings__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__admin-settings__1366x768__dark__baseline.jpg) | 1366×768 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__admin-settings-dashboard-modules__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__admin-settings-dashboard-modules__1366x768__dark__baseline.jpg) | 1366×768 | OBSERVED_FRAGMENT — switches, прокрученное содержимое |
| [owner__admin-shift-control__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__admin-shift-control__1366x768__dark__baseline.jpg) | 1366×768 | PENDING_CAPTURE — видимое loading, baseline не подтверждён |
| [owner__admin-staff__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__admin-staff__1366x768__dark__baseline.jpg) | 1366×768 | PENDING_CAPTURE — видимое loading, baseline не подтверждён |
| [owner__admin-tasks__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__admin-tasks__1366x768__dark__baseline.jpg) | 1366×768 | MISMATCH_CAPTURE — показаны роли и права, не задачи |
| [owner__admin-venue-layout-settings__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__admin-venue-layout-settings__1366x768__dark__baseline.jpg) | 1366×768 | MISMATCH_CAPTURE — показана company форма |
| [owner__clients__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__clients__1366x768__dark__baseline.jpg) | 1366×740 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__clients__1920x1080__dark__baseline.jpg](evidence/UI-01.2/owner__clients__1920x1080__dark__baseline.jpg) | 1920×1080 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__clients__actual__dark__baseline.jpg](evidence/UI-01.2/owner__clients__actual__dark__baseline.jpg) | 1528×828 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__delivery__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__delivery__1366x768__dark__baseline.jpg) | 1366×740 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__delivery__1920x1080__dark__baseline.jpg](evidence/UI-01.2/owner__delivery__1920x1080__dark__baseline.jpg) | 1920×1080 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__delivery__actual__dark__baseline.jpg](evidence/UI-01.2/owner__delivery__actual__dark__baseline.jpg) | 1528×828 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__finance__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__finance__1366x768__dark__baseline.jpg) | 1366×768 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__finance__1920x1080__dark__baseline.jpg](evidence/UI-01.2/owner__finance__1920x1080__dark__baseline.jpg) | 1920×1080 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__finance__actual__dark__baseline.jpg](evidence/UI-01.2/owner__finance__actual__dark__baseline.jpg) | 1528×828 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__finance-categories__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__finance-categories__1366x768__dark__baseline.jpg) | 1366×740 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__finance-categories__1920x1080__dark__baseline.jpg](evidence/UI-01.2/owner__finance-categories__1920x1080__dark__baseline.jpg) | 1920×1080 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__finance-categories__actual__dark__baseline.jpg](evidence/UI-01.2/owner__finance-categories__actual__dark__baseline.jpg) | 1528×828 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__finance-payroll__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__finance-payroll__1366x768__dark__baseline.jpg) | 1366×768 | PENDING_CAPTURE — видимое loading, baseline не подтверждён |
| [owner__finance-report__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__finance-report__1366x768__dark__baseline.jpg) | 1366×740 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__finance-report__1920x1080__dark__baseline.jpg](evidence/UI-01.2/owner__finance-report__1920x1080__dark__baseline.jpg) | 1920×1080 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__finance-report__actual__dark__baseline.jpg](evidence/UI-01.2/owner__finance-report__actual__dark__baseline.jpg) | 1528×828 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__floor__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__floor__1366x768__dark__baseline.jpg) | 1366×768 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__floor__1920x1080__dark__baseline.jpg](evidence/UI-01.2/owner__floor__1920x1080__dark__baseline.jpg) | 1920×1080 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__floor__actual__dark__baseline.jpg](evidence/UI-01.2/owner__floor__actual__dark__baseline.jpg) | 1528×828 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__integrations__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__integrations__1366x768__dark__baseline.jpg) | 1366×740 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__integrations__1920x1080__dark__baseline.jpg](evidence/UI-01.2/owner__integrations__1920x1080__dark__baseline.jpg) | 1920×1080 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__integrations__actual__dark__baseline.jpg](evidence/UI-01.2/owner__integrations__actual__dark__baseline.jpg) | 1528×828 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__inventory__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__inventory__1366x768__dark__baseline.jpg) | 1366×768 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__inventory__1920x1080__dark__baseline.jpg](evidence/UI-01.2/owner__inventory__1920x1080__dark__baseline.jpg) | 1920×1080 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__inventory__actual__dark__baseline.jpg](evidence/UI-01.2/owner__inventory__actual__dark__baseline.jpg) | 1528×828 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__inventory-view-auto-orders__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-auto-orders__1366x768__dark__baseline.jpg) | 1366×768 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__inventory-view-auto-orders__1920x1080__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-auto-orders__1920x1080__dark__baseline.jpg) | 1920×1080 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__inventory-view-auto-orders__actual__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-auto-orders__actual__dark__baseline.jpg) | 1528×828 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__inventory-view-directories__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-directories__1366x768__dark__baseline.jpg) | 1366×768 | PENDING_CAPTURE — видимое loading, baseline не подтверждён |
| [owner__inventory-view-movements__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-movements__1366x768__dark__baseline.jpg) | 1366×740 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__inventory-view-movements__1920x1080__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-movements__1920x1080__dark__baseline.jpg) | 1920×1080 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__inventory-view-movements__actual__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-movements__actual__dark__baseline.jpg) | 1528×828 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__inventory-view-premixes__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-premixes__1366x768__dark__baseline.jpg) | 1366×768 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__inventory-view-premixes__1920x1080__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-premixes__1920x1080__dark__baseline.jpg) | 1920×1080 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__inventory-view-premixes__actual__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-premixes__actual__dark__baseline.jpg) | 1528×828 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__inventory-view-products__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-products__1366x768__dark__baseline.jpg) | 1366×740 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__inventory-view-products__1920x1080__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-products__1920x1080__dark__baseline.jpg) | 1920×1080 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__inventory-view-products__actual__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-products__actual__dark__baseline.jpg) | 1528×828 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__inventory-view-recipes__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-recipes__1366x768__dark__baseline.jpg) | 1366×768 | OBSERVED_WITH_DEFECT — UI012-V01 фильтры |
| [owner__inventory-view-recipes__1920x1080__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-recipes__1920x1080__dark__baseline.jpg) | 1920×1080 | OBSERVED_WITH_DEFECT — UI012-V01 фильтры |
| [owner__inventory-view-recipes__actual__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-recipes__actual__dark__baseline.jpg) | 1528×828 | OBSERVED_WITH_DEFECT — UI012-V01 фильтры |
| [owner__inventory-view-stock__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-stock__1366x768__dark__baseline.jpg) | 1366×740 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__inventory-view-stock__1920x1080__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-stock__1920x1080__dark__baseline.jpg) | 1920×1080 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__inventory-view-stock__actual__dark__baseline.jpg](evidence/UI-01.2/owner__inventory-view-stock__actual__dark__baseline.jpg) | 1528×828 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__login__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__login__1366x768__dark__baseline.jpg) | 1366×768 | PUBLIC_AUTH_SURFACE — публичная форма, не role access |
| [owner__login__actual__dark__baseline.jpg](evidence/UI-01.2/owner__login__actual__dark__baseline.jpg) | 1528×828 | PUBLIC_AUTH_SURFACE — публичная форма, не role access |
| [owner__network__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__network__1366x768__dark__baseline.jpg) | 1366×740 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__network__1920x1080__dark__baseline.jpg](evidence/UI-01.2/owner__network__1920x1080__dark__baseline.jpg) | 1920×1080 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__network__actual__dark__baseline.jpg](evidence/UI-01.2/owner__network__actual__dark__baseline.jpg) | 1528×828 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__orders__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__orders__1366x768__dark__baseline.jpg) | 1366×740 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__orders__1920x1080__dark__baseline.jpg](evidence/UI-01.2/owner__orders__1920x1080__dark__baseline.jpg) | 1920×1080 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__orders__actual__dark__baseline.jpg](evidence/UI-01.2/owner__orders__actual__dark__baseline.jpg) | 1528×828 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__reservations__1366x768__dark__baseline.jpg](evidence/UI-01.2/owner__reservations__1366x768__dark__baseline.jpg) | 1366×740 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__reservations__1920x1080__dark__baseline.jpg](evidence/UI-01.2/owner__reservations__1920x1080__dark__baseline.jpg) | 1920×1080 | OBSERVED_CONTENT — целевое содержимое / предметное empty |
| [owner__reservations__actual__dark__baseline.jpg](evidence/UI-01.2/owner__reservations__actual__dark__baseline.jpg) | 1528×828 | OBSERVED_CONTENT — целевое содержимое / предметное empty |

Итог координатора после пересборки captures.json: 72 уникальных capture пары, 12 несоответствий raster; CSV 6480 строк: 72 CAPTURED_NOT_ACCEPTED, 6408 BLOCKED_ENV_BROWSER, PASS 0. Эти числа — состояние реестра координатора; визуальный итог остаётся INCOMPLETE.
