# FIX-02 — приёмочные доказательства

Дата: 08.10.2026. Роль: независимый code_health_engineer/QA. Продуктовый код этим агентом не менялся; обновлены связанные QA обвязки и добавлены VM/static регрессии. Production не изменялась.

## Автоматические проверки

Каждая команда `node scripts/<имя>` ниже завершилась exit0:

| Suite | Проверенный контракт |
| --- | --- |
| portal-effective-permissions-qa.mjs | Авторитетные/пустые права; bootstrap до portal; singleflight; grant/revoke и reload; 401/503/malformed; stale token; поздний onload после ошибки; canonical finance routes; hash deny; root/dist bootstrap/initial CSS gate; Docker/static allowlist |
| portal-api-auth-qa.mjs | 401 cleanup, старый401 не очищает новый токен; success/403/demo/storage failure |
| portal-context-refresh-qa.mjs | Отбрасывание старого ответа точки; coalesced shift read; loading/partial errors |
| staff-session-recovery-runtime-qa.mjs | Авторитетная сессия, отказ/повтор, read timeout, отсутствие повторной мутации |
| staff-catalog-load-state-contract.mjs | Каталог loading/empty/error/retry, stale revision guard, реальные ID, escaping |
| staff-mode-navigation-contract.mjs | Навигация по permissions, manager read-only, custom personnel grant, отсутствие возврата доступа по названию роли, root/dist |
| staff-header-actions-runtime-qa.mjs | Смена loading/open/closed/error/retry, guards, payload, повторные действия |
| staff-observer-stability-runtime-qa.mjs | Стабильность observer, ограниченные DOM изменения |
| session-authority-qa.mjs | Приоритет persisted session; DB outage/revocation не принимают старый memory token |
| portal-action-keyboard-qa.mjs | Modal keyboard/focus/escape и custom-select focusout |
| staff-effective-permissions-qa.mjs | Выдача/отзыв, пустой доступ, ошибка/recovery, singleflight, очистка чувствительного состояния |
| staff-ui-management-policy-qa.mjs | 84 случая разрешённой/запрещённой управленческой навигации по серверным правам |

Итого: **12 suites PASS**. Первые11 проверены этим агентом; координатор повторил все12 после последней правки active hash заголовка, в19:00 местного времени, все exit0. Команда дополнительной suite: `node scripts/staff-ui-management-policy-qa.mjs`,84 случая входят в12 suites и не прибавляются как отдельные suites.

`node --check app.js`, `node --check portal.js`, `node --check portal-session.js`, `node --check login.js` и `git diff --check` выполнены успешно. Предупреждения Git о LF/CRLF не являются ошибками. Последующие изменения требуют повторной проверки затронутых файлов.

Адаптации старых тестов ограничены зависимостями реальных handlers: revision counter, hasPortalPermission, localStorage.getItem, staff list/permission decorator. Assertions сохранены; ожидание hardcoded role-list заменено исполнением актуального permission helper с deny/allow случаями. Найденные при review canonical finance route, поздний onload после503 и stale401 исправлены координатором и защищены регрессиями.

## Edge — сведения координатора

Браузерные проверки выполнены координатором через CUA в подключённом Edge, не данным агентом. Среда локальная, данные синтетические. Снимки: `output/qa/fix02/*.png`.

Наличие файлов независимо проверено: `bartender-guests-1366.png`, `hookah-guests-1366.png`, `live-revoke-1366.png`, `manager-readonly-1366.png`, `owner-effective-card-1920.png`, `owner-inventory-1920.png`, `owner-policy-1920.png`, `scoped-admin-1366.png`. Их визуальное толкование принадлежит браузерному проходу координатора.

| Сценарий | Состояние |
| --- | --- |
| Бармен1366: Гости через меню и прямой адрес | PASS |
| Бармен: прямой /admin#staff без кадровых прав | PASS, доступ закрыт |
| Owner API выдаёт бармену orders/inventory/staff/settings; та же заблокированная вкладка | PASS, открывает персонал и разрешённые ссылки автоматически |
| Owner API отзывает до finance_read; та же страница | PASS, автоматически закрывается |
| Рабочий экран при finance_read | PASS, финансовая навигация остаётся, зал скрыт |
| Возврат исходного personal[] (наследование базы) | PASS, зал и Гости возвращаются; исходное значение восстановлено и проверено |
| Owner1920: главная, роли, пояснение effective policy | PASS |
| Owner: карточка сотрудника | PASS, точные backend permissions и доступность classic globals расширений |
| Owner: склад | PASS, загрузился |
| Кальянщик1366: зал и Гости | PASS, снимок сохранён |
| Управляющий1366: склад | PASS, «Только просмотр» |
| Управляющий: персонал и /admin#permissions | PASS, нет добавления/редактирования; прямой редактор прав закрыт |
| Ограниченный admin orders/reservations | PASS, отсутствуют ссылки склада/финансов/персонала; прямой склад закрыт |
| Недоступность сервера при открытом складе owner | PASS: координатор остановил собственный локальный сервер без reload страницы; Edge автоматически показал «Не удалось проверить доступ…» |
| Восстановление после ошибки | PASS: сервер перезапущен, нажато «Повторить», снова видны заголовок «Позиции» и12 позиций |

## Границы

Полная регрессия проекта не запускалась. Все сочетания custom/system ролей в браузере не перебраны. Предыдущие **926 PostgreSQL assertions FIX-01** и новые VM проверки дополняют браузер, но926 здесь повторно не запускались. Иные baseline failures аудита этим пакетом не объявляются исправленными. Fold отложен; выпуск на сервер и GitHub не выполнялся.

В просмотренном коде и прошедшем автоматическом наборе открытых блокеров FIX-02 не осталось. Координатор завершил указанные сценарии всех5 ролей, контролируемую недоступность сервера и восстановление. Остальная полная матрица приложения не запускалась.

Очистка завершена по сообщению координатора: исходный personal[] бармена восстановлен и проверен; две собственные браузерные вкладки закрыты, viewport сброшен. Локальный сервер оставлен работающим (сессия13507). Выход owner подтверждён появлением страницы login. Для scoped admin кнопка выхода нажата и стала disabled перед закрытием вкладки; отдельное подтверждение завершения logout не получено, поэтому успешный серверный logout этой учётки здесь не заявляется. Production не затронута.
