# Контракт единой оболочки сотрудника

09.10.2026 · Минимальная UI-унификация между POS и операционными страницами. Контракт сохраняет действующие роли, route guards и API/RBAC; он не вводит новый режим или право.

## Источник выбора оболочки

- Текущий verified session role определяет базовую оболочку. Девять операционных base roles всегда используют employee shell на операционных страницах, даже если сессия содержит дополнительные grants: `bartender`, `hookah_master`, `senior_bartender`, `senior_hookah_master`, `cleaner`, `security`, `technician`, `other_staff`, `staff`.
- `owner`, `admin`, `manager` и `developer` сохраняют текущую management shell и сгруппированную навигацию. Переход по ссылке или наличие permission не переключают их оболочку.
- Имя custom role не является критерием оболочки. Сверять только verified session base role; отображаемые ссылки вычислять по effective permissions из той же verified session. Дополнительные grants у операционной роли могут добавить разрешённые ссылки, но не переводят её в management shell.
- Не добавлять `workspace=staff`, shell switcher или иной клиентский флаг как источник решения. Query/hash и pathname выбирают страницу/подраздел, но не идентичность или права. Текущие venue-параметры сохраняются согласно действующему контракту.

## Причина расхождения

Корень `/` использует отдельную POS-оболочку `body.staff-theme` и плоские кнопки рабочего места (`index.html:11`). Переход из неё открывает `/reservations` (`app.js:671`), а `reservations.html:13` задаёт portal shell. `portal.js:185–208, 398–404` строит сгруппированную навигацию. Поэтому одна и та же сессия операционного сотрудника видит разное меню и шапку между залом и бронированиями.

В `server.js:1047` есть operational-role predicate для восьми ролей; роль `staff` присутствует в базовых portal roles (`portal.js:51`). Контракт employee shell фиксирует полный список из девяти ролей. Custom permissions хранятся отдельно от базового role (`server.js:1352`), поэтому не использовать custom role display name как переключатель shell.

## Маршруты и права

| Маршрут / действие | Существующий guard | Employee menu link | Контракт оболочки |
|---|---|---|---|
| `/` — рабочий зал | Portal guard `orders`; фактическая работа POS дополнительно требует `floor` + `orders` (`app.js:39`) | «Зал» — `floor` | Employee role → employee shell |
| `/orders` — журнал | `orders` | «Заказы» — `orders` | Employee role → employee shell |
| `/clients` — гости | `orders` или `staff` или `staff_view` | «Гости» — существующий alias проверки clients | Employee role → employee shell |
| `/reservations` | `reservations` | «Бронирования» — `reservations` | Employee role → employee shell |
| `/finance`, `/finance/report` | `finance_read` | «Финансы» — `finance_read` | Employee role → employee shell |
| `/finance/categories`, `/finance-categories` | `finance` | Не добавлять без существующего сценария и grant | Существующий shell по base role |
| `/admin#tasks` — личные задачи | `orders` или `tasks_manage` | «Задачи» — существующий alias | Employee role → employee shell |
| Другие `/admin` hashes, `/inventory`, `/delivery`, `/network`, `/integrations` | Действующие route/API guards без изменений | Ссылки только если разрешает effective permission | Shell выбирает base role; дополнительные grants сами его не переключают |

Пункт меню не является контролем доступа. Прямой URL и API сохраняют серверные проверки. Не ослаблять route/API guards и не расширять effective permissions. Для ссылки «Заказы» использовать маршрут, который реально доступен данной сессии: корневой POS экран требует одновременно `floor` и `orders`; не отправлять пользователя с одним `orders` на неработающий POS экран.

## UI-контракт

- На перечисленных операционных страницах девять employee base roles получают единый плоский employee sidebar и согласованную employee header. Переходы между залом, заказами, гостями, бронированиями, финансами и задачами меняют контент и активный пункт, но сохраняют employee shell.
- Ссылки и действия видимы только по effective permissions. Дополнительные grants добавляют только соответствующие ссылки/действия; они не меняют базовый shell и не обходят проверку маршрута.
- Существующие шапочные handlers, venue, shift, lock/profile и содержимое страниц сохраняются. В рамках этой правки не менять формы/данные бронирований, финансов и склада.
- Для owner/admin/manager/developer сохраняются текущие management sidebar, группы, поиск и header. Никаких изменений shell при навигации между management страницами.
- При смене venue актуальное venue и permissions перечитываются по действующему session-контракту; не показывать предыдущую точку как текущую.

## Границы и приёмка

Изменения ограничить resolver/rendering оболочки, employee nav/header и поддержкой уже существующих маршрутов. Не менять role assignments, permission resolver, API/route guards, данные или management shell.

1. Каждая из девяти операционных base roles сохраняет один employee shell на `/`, `/orders`, `/clients`, `/reservations`, `/finance`, `/finance/report` и `/admin#tasks` при наличии действующего доступа.
2. Дополнительные grants у операционного пользователя могут показать допустимые пункты, но не переключают оболочку. Custom role display name не влияет на выбор.
3. Owner/admin/manager/developer сохраняют прежние management sidebar и header на тех же страницах.
4. Сессия без `reservations` не получает ссылку на бронирования и сохраняет прежний запрет при прямом открытии. Аналогично для других guards.
5. Сотрудник с `orders`, но без `floor` не направляется на корневой POS зал как на заказы; его доступный заказный маршрут остаётся функциональным. Личные задачи требуют только прежнего `orders || tasks_manage` и не открывают другие admin hashes.
6. Финансовые `finance_read` и `finance` остаются раздельными; складские read/write grants не взаимозаменяются.
7. Проверить reload, back/forward, прямой URL, текущую точку, профиль/смену/lock handlers и активный пункт без изменения данных страницы.

## Основания в коде

- `index.html:11`; `app.js:39, 58–64, 671` — POS shell, доступ к залу и переход по кнопке.
- `reservations.html:13` — portal shell на бронированиях.
- `portal-session.js:15–31` — route guards для заказов, гостей, задач, броней, финансов и admin hashes.
- `portal.js:37–64, 185–208, 398–404, 484–495` — базовые роли, permission aliases, sidebar и filtering.
- `server.js:1047, 1352` — operational role predicate и отделение custom role grants.
- `SITE_TREE.md:15, 28–50`; `scripts/sidebar-navigation-contract.mjs:5–18` — существующие отдельные оболочки и проверки management sidebar; parity контракта ранее не было.
