# SaaS / Hookah POS границы

Актуальная рабочая копия пока остаётся единым приложением и репозиторием. Этот документ фиксирует логические зоны, чтобы SaaS-изменения можно было ограничивать и проверять до физического выделения.

## SaaS control plane

- Каноническая страница: `/platform` → `platform.html`, `platform.js` и изолированный `platform.css`; опубликованные копии находятся в `dist/platform.html`, `dist/platform.js`, `dist/platform.css` и `dist/platform/index.html`.
- Платформенные API: `/api/platform/plans`, `/api/platform/overview`, `/api/platform/organizations` (GET/POST/PATCH), `/api/platform/organizations/:id/subscription` (GET/PATCH), `/api/platform/organizations/:id/owners` и действия для владельцев.
- Роль: `platform_owner`; серверные маршруты платформы требуют permission `platform`.
- Таблицы: `organizations`, `organization_memberships`, `organization_subscriptions`. `migrations/011_platform_owner.sql` добавляет SaaS-роль.
- Реестр SaaS-owned файлов для CI находится в `scripts/saas-pos-boundary-contract.mjs`.
- Для точечной публикации SaaS и shared login используйте `node scripts/sync-published-assets.mjs --saas-only`; полный режим синхронизирует весь сайт и предназначен для согласованного релиза приложения.
- Управление доступом владельцев включает добавление совладельца, правку имени/логина, смену пароля с завершением его сессий и создание одноразовой ссылки восстановления. Ссылка действует 30 минут; почтовой доставки в проекте нет.
- Экран `/login` и его обработчик остаются shared, так как ими пользуются и платформенные владельцы, и POS-пользователи. Восстановление активируется токеном в URL fragment и очищает его после успеха.

## Hookah POS

К POS-only страницам, защищённым от смешивания в одном diff с SaaS UI, относятся `/`, `/orders`, `/clients`, `/reservations`, `/delivery`, `/inventory`, `/finance`, `/finance/categories`, `/finance/report` и `/integrations`, включая их опубликованные HTML-копии. Их канонические маршруты зафиксированы в `SITE_TREE.md` и `site-map.json`.

Рабочий зал, заказы, склад, меню, смены и сотрудники остаются POS-областями. Этот пакет не меняет их интерфейс или бизнес-логику.

## Shared API / auth / models

Следующие поверхности нельзя механически переносить как SaaS-only: `server.js`, `db.js`, `schema.sql`, `migrations/009_saas_foundation.sql`, `style.css`, `/login`, `app.js`, `portal.js`, `/admin`, `/network`, common assets и auth/session helpers.

Причины:

- единый `server.js` обслуживает платформенные и POS API;
- логин и сессии различают `platform_owner` и tenant-пользователей;
- `venues.organization_id`, `users.organization_id`, membership и subscription используются проверками tenant-контекста и POS квотами;
- `style.css`, `/admin` и `/network` содержат совместные платформенные и операционные настройки;
- миграция 009 добавляет организационные связи к существующим POS данным и backfill-ит их.

При изменении shared-поверхностей сохраняются внутренние CRM-ключи, имена таблиц, роли, cookie и environment variables; дополнительно запускаются относящиеся контракты SaaS и POS.

## Гарантии и пределы guard

`saas-pos-boundary-contract.mjs` запускается CI на pull request и запрещает одному diff одновременно менять выделенные SaaS UI и POS-only страницы. Неизвестные файлы по умолчанию считаются shared, поэтому не могут незаметно пройти как SaaS-owned. Shared API/auth/models могут меняться вместе с SaaS только под регрессионным покрытием.

Файловый guard не доказывает семантическую изоляцию изменения внутри `server.js`, `style.css` или модели БД. Там нужны API/RBAC/tenant/quota проверки. Сейчас проект остаётся монолитом; разносить его физически по репозиториям без предварительных версионируемых контрактов и плана миграции небезопасно.

## Следующий этап выделения

1. Вынести platform API в отдельный handler/domain module за совместимым facade `server.js`.
2. Зафиксировать versioned DTO и auth contract: проверенный `platform_owner`, tenant session, organization membership, venue context, entitlement/quota.
3. Сначала отделить SaaS UI bundle и его тесты от POS assets; общую оболочку, логин и database repositories пока держать в shared package.
4. Проверить provisioning, нескольких владельцев, сброс доступа, изоляцию двух организаций, подписки/квоты и POS smoke на общей тестовой БД.
5. Рассматривать отдельный репозиторий только при необходимости независимой сборки/релиза; переносить migrations/данные лишь с явным совместимым migration/rollback планом.
