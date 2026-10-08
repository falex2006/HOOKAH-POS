# Единый каркас сотрудника — 09.10.2026

## Причина и изменение

Рабочий зал использовал плоское меню app.js, а бронирования/гости/задачи/финансы — сгруппированное portal.js. Добавлена отдельная ветка employee shell для девяти операционных базовых ролей. Ссылки остаются ограничены verified permissions. Роли owner/admin/manager/developer сохраняют management shell. Данные и разрешения не менялись.

Добавлены личные задачи и сохранение доступных контрольных разделов. Orders deep link /?view=orders восстанавливает вид; при отсутствии floor используется /orders. Существующие обработчики профиля/PIN/смены сохранены. В portal header индикатор смены, а открытие/закрытие смены — в рабочем зале.

## Проверка на локальном стенде

Изолированный checkout tmp/release-fix01-06, loopback31934, memory backend, отдельный синтетический сотрудник. Production-сессия пользователя не менялась.

Edge: staff / → reservations → orders → reload → tasks → finance → clients PASS. На всех portal-переходах плоское меню, задачи доступны, нет раскрываемой группы Операции. Визуальный просмотр бронирований при текущей desktop ширине PASS. Под тестовым admin reservations сохраняет управленческие группы/поиск/шапку. Вход owner на стенде упёрся в лимит двух тестовых API-сессий, поэтому management browser проверка фактически выполнена под admin; owner covered общей веткой/контрактами, не отдельным входом браузера.

Existing checks PASS: staff-mode-navigation-contract, portal-effective-permissions-qa, header-shell-contract, sidebar-navigation-contract, local-design-contract, local-navigation-state-qa (52 cases), staff-header-actions-runtime-qa, working-tree SaaS/POS boundary. Syntax app.js/portal.js PASS. Source/dist обновлены: CSS406, portal475, app211.

## Границы

Это локальная правка; новая публикация на сервер не выполнялась. Оплаты, брони и права production не менялись. Полная матрица всех сотрудников и мобильная/Fold приёмка не заявляются. Изменение прав удаления задач не входит в этот UI fix.

Финальный review architect/code-health PASS. Новый staff-shell-parity-qa PASS:9 рабочих/4 управленческих roles, exact/empty/custom grants, orders-only/floor-only, context, active links, idempotence, сохранение действий, deep-link/history, dist parity. Правка перенесена в основной локальный проект; повторные parity/design checks PASS.
