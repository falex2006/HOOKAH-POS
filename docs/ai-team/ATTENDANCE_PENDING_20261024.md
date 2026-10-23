# U2: отправка действий посещаемости

Пакет поверхe1da0520, только staff-attendance-ui.js/dist и компонентная QA/документация. Код здоровья baseline самостоятельно подтвердил MASTER: run блокировал только clicked button, поэтому противоположное решение и программный повтор submit оставались доступны, поля можно было изменить после отправки. RED12 несовпадений на390/1440 (шесть проверок поведения на каждой ширине); сохранены12baseline-снимков. Это не12 независимых первопричин.

## Минимальное исправление

Одна мутация на экземпляр attendance view. На время запроса сохраняются disabled состояния всех native controls текущего content и временно блокируются; finally восстанавливает прежние значения только подключённым исходным узлам. Повтор run, manual refresh, переключение вкладки и openOverview не запускают конкурирующее действие/перерисовку. Внутренний refresh единственной успешной мутации проходит прежний hasUnsavedInput guard: другой незавершённый черновик не удаляется. После ошибки ключ идемпотентности прежнего body сохраняется для повтора. Никаких новых API, изменений body/прав/серверной идемпотентности/БД/расчётов и CSS.

## Проверка

`scripts/staff-attendance-pending-browser-qa.cjs`: actual mounted JS/CSS с синтетическим API, source20/dist20 PASS390/1440. Opposite native decisionclick RED→singleflight, forced selfsubmit ignored, note/reason/policy inputs disabled pending и восстанавливаются после503 с прежним текстом. Retry того же body сохраняет requestKey. Синтетический success start→GET readback показывает активную отметку; policy success не перечитывает страницу поверх другого grant draft. Две разные формы сериализуются в одном view, параллельные независимые saves не обещаются. Dispose/remount с поздним ответом не меняет новый текст; старый ответ также не разблокирует новый pending запрос. Priority14, domain/access/recovery21 unit tests, syntax/parity/diff PASS. Точный последний компонентный terminal83196exit0.

Baseline использует frozen JS e1da05204e7882d4e36a2e027c11b625d2ed0a7e через git show; текущее рабочее дерево для RED не переставляется. Корректная фикстура воспроизводит section.portal-content из admin.html. Первоначальный main#page-content наследовал globalmain min-width700px: его mobile clipping был дефектом fixture, не продукта. Эти прежние изображения сохранены отдельно fixture-v1-baseline, не являются proof адаптивности. Новая snapshot-проверка измеряет сам attendance-page, его scrollWidth и границы, поскольку bodyoverflowhidden скрывал проблему от проверки ширины документа. Финальные baseline/source/dist имеют исправленный container.

Root осмотрел corrected decision-pending390, error1440 и сохранённый grant draft390. MASTER независимо прочитал diff/run/load, проверил состояния в браузерной suite и лично просмотрел updated390 snapshots; final bounded GO. Subagent reviews недоступны из-за usage-limit и не заявляются успешными. Гипотеза shared-content cleanup после remount была опровергнута: mount заменяет дочерний content; дополнительной продуктовой правки ради неё нет. На время разработки новый busy-container дал второй spinner поверх note — этот побочный эффект удалён, aria-busy остался только у отправляющей кнопки как ранее.

## Границы остатка

Синтетические мутации не являются реальными attendance writes, UI→PostgreSQL, RBAC/tenant, подтверждением выплаты или всей исходной UI-цели. Реальные close/approval/grant/start/end lifecycle и другие ошибки/права требуют отдельного согласованного gate. Полный portal/shell/theme-resolver и физический Fold здесь не проверены. Источники evidence: tmp/attendance-pending/{baseline,source,dist}/report.json и снимки. Production, GitHub, VPS не менялись; лояльность paused, payroll приоритет, интеграция MASTER/PAYROLL.
