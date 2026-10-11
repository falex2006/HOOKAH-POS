# MT-03 — общие компоненты управленческой темы

Дата: 2026-10-11. Статус: общая основа реализована локально; перенос отдельных страниц — MT-04, выпуск — MT-05.

## Реализация

- management-theme.css: семантические цвета и поверхности, фирменный градиент #ff516e → #ff9a3d, общая геометрия кнопок, поля и тонкий focus, существующие custom-select, панели, таблицы, статусы, окна и обратная связь. Тёмная и светлая схемы; scoped reduced-motion.
- management-theme.js: оформление включается после обычной проверки server session, существующего route gate и роли owner/admin/manager. Значения localStorage не предоставляют права. Отдельные DOM-ветви маркируются data-management-theme="mt"; глобальные body/html не маркируются.
- Окна получают тему от конкретного разрешённого инициатора. Ticket отзывается при смене контекста, маршрута и блокировке экрана. Shared UI, legacy portalAction и обе реализации tray уведомлений подключены без изменения их контрактов focus/pending/draft/scroll/inert.
- Подключение в 11 управленческих HTML, серверный whitelist и Docker COPY; штатная source/dist синхронизация и cache revision 2026101107.
- Перед интеграцией принят актуальный origin/main b4984208, merge baseline 12b74933. Правки параллельной фирменной плитки Opera сохранены.

## Границы

Рабочее место сотрудника `/`, зал/столы, `/admin#staff`, permissions, profile/lock окна и встроенный редактор зала не получают тему. Смешанные панели настроек разделяются по DOM-ветвям: даже скрытый #floor-editor исключён.

Это общая основа, а не завершённое оформление всех страниц. В MT-04 необходима классификация нестандартных окон/обратной связи каждого экрана. Native directory-editor пока не маркируется; portalNotice без доказанного managementTicket сохраняет исходное оформление. Нельзя заменять отсутствие origin разрешением по одному URL.

## Проверки и доказательства

[Code health review](MT03_HEALTH_REVIEW.md): source/diff PASS, блокирующих замечаний не осталось.

- node --check: management-theme.js, portal.js, ui-dialog.js, notification-center.js, scripts/sync-published-assets.mjs, server.js — PASS. git diff --check — PASS.
- Побайтовая сверка source/dist для management-theme.js/css, portal.js, portal-session.js, ui-dialog.js, notification-center.js — PASS. Source и aliases управленческих HTML синхронизированы штатным скриптом. У index/login/platform нет содержательных изменений.
- In-app browser, desktop 1440×900, localhost:31934, обычная проверенная owner session. Backend in-memory без PostgreSQL и без подключения клиентской базы. Временные локальные настройки светлой схемы возвращены в dark.
- Склад: loading использует `—`, подтверждённый пустой склад — 0; редактор позиции и существующий custom-select открываются в теме. Записи не сохранялись.
- Shared окно «Новая бронь»: marker mt, тонкая граница focus, отмена убирает окно и возвращает focus на «Новая бронь»; бронь не создавалась.
- Панель уведомлений: marker mt, desktop aria-modal=false. Найден и исправлен пропущенный hook в отдельном legacy openNotificationPanel в portal.js.
- Отрицательные сценарии: `/`, `/admin#staff`, `/admin#venue-layout-settings` — 0 markers; hidden floor-editor и company-layout-note не маркируются; открытый профиль сотрудника без marker.
- Console warn/error на просмотренных сценариях отсутствуют. Светлые sidebar active-group и search wrapper проверены после исправления общих surfaces.

Снимки: tmp/mt03-qa/inventory-editor.png, inventory-light.png, shared-reservation-dialog.png, notifications.png, category-dialog.png. Временные файлы не включаются в коммит.

Не заявляются: runtime admin/manager (gate проверен по исходникам), все нестандартные окна и notice callers, lock/reduced-motion runtime, полная WCAG, screen reader, финансовые/складские write-сценарии, PostgreSQL, mobile/Fold, дополнительные разрешения и production.

## Следующий этап

MT-04: последовательно применить основу к главной владельца/управляющего/администратора, складу/меню/техкартам, финансам/отчётам и остальным разрешённым управленческим экранам. Сопоставлять нестандартные окна и сообщения по MT-01 каталогу, сохранить точность показателей и существующие права. Общий выпуск на GitHub и сервер — после MT-05.