# Независимая проверка ролей и общего каркаса POS

Дата: 11.10.2026. Роль: `system_architect`. Проверен текущий локальный worktree `pos-employee-workspace` на реальном сервере `http://127.0.0.1:35397` с отдельной disposable PostgreSQL БД. Продуктовые файлы этим аудитом не изменялись. Сервер оставлен работающим для общей приёмки.

## Результат

**Live browser role/shell audit: PASS.** Шесть изолированных Chromium/Chrome contexts, viewport 1366×768; дополнительная серия — пять contexts на соседних маршрутах. В обеих сериях ноль `pageerror` и ноль попыток изменяющих API-запросов; в основной серии также зафиксировано ноль ответов сервера 5xx. Тестовый перехватчик разрешал только GET/HEAD на `/api/`; запрещённые запросы не потребовались. Аутентификация использовала private fixture в ignored `tmp`, секреты не записаны в документацию.

| Роль | Queue API | Допустимые направления | Проверенное отображение |
|---|---|---|---|
| owner | 200 | bar, hookah | Рабочий POS и management shell на административных страницах |
| manager | 200 | bar, hookah | Рабочий POS и management shell на административных страницах |
| bartender | 200 | bar | Только разрешённый фильтр и строки станции; worker shell |
| hookah_master | 200 | hookah | Только разрешённый фильтр и строки станции; worker shell |
| cleaner | 403 | нет | Явный отказ доступа к залу/заказам, нет плиток, кнопки приготовления, счётчика и очереди; доступная навигация — «Финансы» |
| foreign owner | 200 | bar, hookah в своём venue | Не видит локальные столы/заказы; локальный order summary возвращает 404 |

Список станций проверен в ответе реального API и в отрисованных строках. Для owner/manager поочерёдно включены bar/hookah filters; в каждом фильтре все видимые строки принадлежали выбранной станции. Worker не получает второй фильтр и не видит management shortcut.

## UI → API → права → повторное отображение → QA

| Сценарий | API / права | Сохранение и повторное отображение | Evidence |
|---|---|---|---|
| Открытие рабочего зала | GET `/api/session`, `/api/floor`, `/api/orders?withPricing=1`; `floor + orders` | Реальные данные своего tenant; права берутся из authoritative session | Все шесть contexts; cleaner — явный access message, без ложной пустой очереди |
| Приготовление | GET `/api/preparation/queue`; `orders` и разрешённая station либо `tasks_manage` | Локальный вид на `/`; station filters из effective permissions, queued/in_progress строки из API | Все разрешённые фильтры и каждой строки `data-station`; denied role не монтирует очередь |
| Заказы | Существующий `/` с `?view=orders`; `orders` | Пункт меню, URL, `body.dataset.staffView`, заголовок и `aria-current` согласованы; reload сохраняет view | owner/manager/bartender/hookah_master/foreign; denied cleaner проверен отдельно |
| Возврат в зал | Существующий `/`, без `view=orders` | Удаляется preparation view; заголовок «Рабочий зал», активен соответствующий пункт | Те же рабочие contexts после orders/reload |
| Гости → Заказы | `/clients` → `/?view=orders` | Каноническая worker ссылка открывает рабочие заказы с нужным view | bartender и hookah_master |
| Рабочие соседние страницы | `/clients`, `/admin#tasks`, `/finance` | Worker сохраняет `employee-portal`, без management groups и запрещённых staffing/settings/diagnostics links | bartender/hookah_master на трёх маршрутах; cleaner на `/finance` |
| Административные соседние страницы | Те же маршруты | owner/manager сохраняют management shell, не переходят в worker portal | Два изолированных contexts, все три маршрута |
| Tenant isolation | GET `/api/orders?scope=all`, `/api/floor`, `/api/orders/:localId/summary` | Данные чужого venue не появляются в API или локальных плитках | foreign: orders/floor 200 без локальных IDs; summary 404 |

## Соответствие исходному контракту

Основные tenant/role/route ограничения из `CONTRACT.md` соблюдены: новый публичный маршрут и новые RBAC-права не введены; bar/hookah остаются станциями, финансовые API и persisted execution не подменены интерфейсом. Существующие worker и management shells на соседних страницах сохранены.

Исходные формулировки `CONTRACT.md` приведены к итоговой реализации после сверки:

- Объединённая кнопка отправляет snapshot всех подходящих `new` строк. Диалог нужен для строк с неизвестным направлением; обязательного выбора всех фиксированных bar/hookah строк нет. Snapshot IDs/venue/access и последовательные station POST остаются необходимыми.
- «Готовые заказы» вычисляются строже, чем один `order.status=ready`: активный заказ должен содержать строки, и у всех строк `preparationStatus=ready` (`pos-workspace.js`, `isReady`). Это предотвращает ложную готовность после добавления новых позиций.
- Третий счётчик называется «Открытые счета» и считает активные orders. Он не означает просьбу гостя об оплате и не выводится из ready. `awaiting_payment` остаётся настоящим статусом стола.

Текущий `app.js` выполняет coordinated reread session/floor/orders/preparation каждые 30 секунд и по focus/visibility, с singleflight и актуализацией после mutation. WebSocket/realtime отсутствуют. Результат этого аудита не заменяет отдельную проверку гонок и отказов refresh. Отсутствующие API-функции в контракте описаны как будущие расширения, без обещания их реализации в UI.

## Статические проверки и границы приёмки

На момент независимого запуска:

| Проверка | Результат | Причина / владелец |
|---|---|---|
| `scripts/sidebar-navigation-contract.mjs` | FAIL, baseline debt | Regex ожидает отсутствующую уже в HEAD сигнатуру `normalizeManagementSidebar`. `portal.js` и данный тест этим diff не изменены. Координатор решает отдельное устранение долга. |
| `scripts/header-shell-contract.mjs` | FAIL, до финальной синхронизации | `dist/index.html` не совпадает с source. Нужен итоговый published-assets sync и повтор проверки координатором. |
| `scripts/staff-shell-parity-qa.mjs` | Runtime assertions PASS; общий запуск FAIL до sync | По разрешению координатора mock дополнен настоящим удалением class и `refreshPosWorkspace`; добавлены проверки выхода из preparation view и четырёх refresh. Существующие assertions сохранены. Теперь запуск проходит runtime assertions и останавливается на `app.js: published parity`. Нужен итоговый sync и повтор. |

Эти результаты не обозначают успешную финальную сборку: координатор должен зафиксировать результаты после интеграции. Реальные роли и маршруты проверены независимо от статических mock assertions.

Аудит намеренно read-only: dispatch/PATCH preparation/payment/close, login/PIN, отзыв прав в живой сессии, concurrency/stale response, мобильный режим, Edge, печать и полная визуальная приёмка обеих тем здесь не подтверждаются. Основной координатор выполняет отдельные mutation/UI acceptance проверки. Точные количества заказов не закреплены: во время аудита координатор изменял свои fixture orders. Проверялись разрешения, направления, маршруты и отсутствие tenant leakage.

Воспроизведение без reset/reseed: `node tmp/full-local-qa/pos-workspace-role-qa.cjs` и `node tmp/full-local-qa/pos-workspace-role-routes-qa.cjs`. Эти ignored helpers читают готовый private manifest, создают отдельные browser contexts и сохраняют только sanitized evidence в `pos-role-qa-results.json` / `pos-role-routes-qa-results.json`. Public screenshots и private manifest не смешиваются.
