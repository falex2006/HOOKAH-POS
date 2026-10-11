# MT-05 — общая приёмка

2026-10-11. Локальная приёмка готового пакета: PASS в заявленных границах. Выпуск завершён; production receipt ниже.

## Объём

Управленческие страницы MT-01–04; исходная верхняя панель восстановлена по решению пользователя. Рабочее место, персонал, зал и профиль исключены из темы. Две отдельные правки пустого зала и даты включены. Мобильные/Fold и другие размеры исключены пользователем.

## Доказательства

- Независимые source health, architecture/release и QA reports: MT05_FINAL_HEALTH.md, MT05_STATIC_QA.md, MT05_RELEASE_GATE.md, MT05_FIXES_REVIEW.md.
- Один общий desktop проход использует предыдущие MT03/MT04 evidence без повторения всей матрицы. Syntax, source/dist и статические контракты PASS. Два старых assertions navigation/company дают одинаковый FAIL на baseline12b74933: они не являются регрессиями темы и не входят в зелёные CI gates.
- PR33, head9e25c267: CRM contracts и AI team contracts SUCCESS. Финальный merge допускается только с актуальными зелёными gates.
- Дополнительное обычное session окружение localhost31932 с PostgreSQL на объявленном loopback31930, synthetic MT05 organization. Никаких клиентских данных. Существующий QA config согласован с credential собственного declared container без изменения пароля; initial auth/config failure устранён. Setup regression31931 не завершился из-за иного пароля; broad regression suite не заявляется.
- PostgreSQL login/session API owner/admin/manager/bartender PASS. Browser owner dashboard/payroll: схем нет, корректное готовое состояние без прежнего in-memory error; editor открыт/закрыт без сохранения. Admin inventory form→API→success message→reload→повторный API read новой синтетической позиции PASS. Manager /admin:17 roots, header unmarked. Bartender floor:0 roots, контактная подсказка, нет ссылки настройки.
- Header: legacy transparent bell/border0, header unmarked, page roots сохранены; notification panel отдельно themed. Native browser UI не менялся. Шестизначный год отклоняется, валидная дата восстанавливает загрузку; владелец с settings получает ссылку настройки зала.
- Снимки tmp/mt05-qa: payroll-postgres.png, manager-postgres.png, header-restored.png, date-invalid.png, floor-empty-owner.png. Временные файлы и credentials не публикуются.

## Выпуск и ограничения

Сохранить existing Compose project/volume/env, canonical clean main точного merged SHA; SKIP_MENU_SEED_ONCE=true, guarded backup и restore rehearsal. После health проверить публичные assets, реальный read-only owner и равенство guest/taxonomy/stock hashes. Не сбрасывать/восстанавливать клиентскую БД.

Полная WCAG/screen-reader/reduced-motion и все92 состояния не заявляются. Backend бизнес-правила и миграции diff не меняет; полный business E2E не повторялся для presentation-only stage. Payroll financial approval/write не выполнялись. Production завершение отдельно от локального PASS.
## Production receipt — 2026-10-11

- PR33 merged после обеих зелёных CI workflows на head3859433c. Runtime canonical main: 0faade7cdd353816258bd800b9fb34de3f919b0f, clean checkout /root/hookah-pos-release-0faade7c. Release label da24a7f4a7a2fa6006829dfde3ca831b43ee0e8972e2b4fb0825f0e13eec92d5.
- Guarded deploy завершился успешно: build, остановка записи, backup с restore rehearsal, существующие миграции, SKIP_MENU_SEED_ONCE=true и healthy restart. Подготовительный wrapper исправлен для фактического docker-compose; первый отказ произошёл до deploy. Новых миграций пакет не добавляет.
- .env побайтово сохранён; Compose project hookah-pos и volume territory-crm_pgdata сохранены. Перед/после full-row counts/hashes совпали: guests3, departments8, subdepartments12, product_categories35 включая архив, products71, ingredients85. Production fixtures, DB reset/restore и переписывание каталога не выполнялись.
- Public HTTPS с проверкой существующего сертификата: health ok/postgres. SHA256 публичных app.js/portal.js/management-theme.js/css/ui-dialog.js совпадают с Git blobs опубликованного main. Рабочие CRLF Windows объясняют различие локального файлового SHA; canonical Git blobs сравнены побайтово.
- Обычная существующая owner session в Edge: recipes, /admin, finance#payroll и floor загружены после обновления. Header unmarked, bell transparent/border0, management script rev2. Payroll готовое пустое состояние без ошибки owner_only. Зал:10 столов, theme roots0. Финальный warn/error journal пуст.
- Новый production login/logout не выполнялся: использована открытая реальная owner session; стандартный credential-based post-deploy-acceptance.sh не запускался без актуального пароля. Его read-only health/page/session покрытия проверены публичным HTTPS и живой Edge session; fresh login всех четырёх ролей выполнен в isolated PostgreSQL QA. Сохранения/финансовые операции production не тестировались.

MT-01–MT-05 завершены в согласованных desktop границах. Эта запись не является заявлением полной mobile/WCAG/business acceptance продукта. Последующие изменения дизайна ведутся отдельным пакетом. Receipt/plan обновления являются документационными и не требуют повторного развёртывания приложения.
