# Выпуск локального полного QA — 01.10.2026

> Исторический отчёт конкретного выпуска 2026-10-01. Разрешения и результаты ниже не переносятся на новые пакеты. Текущие этапы и отдельный порядок публикации зафиксированы в [плане UI](UNIFIED_UI_2026-10-09/PLAN.md).

Пользователь авторизовал коммит, GitHub и VPS. Пакет подготовлен в отдельном reconcile checkout; исходный грязный рабочий проект сохранён. Remote main является предком кандидата, публикация выполняется fast-forward без переписывания истории.

## Gate до публикации

- Code health и system architect/release review: GO с проверкой backup/restore и фактического production identity.
- Полный локальный runner: 167/167 PASS; после исправления escaping launcher static: 125/125 PASS.
- Повтор release smoke: dist, навигация, dashboard, employee report, guards, diff PASS; 360 файлов соответствуют проверенному Docker manifest.
- Секрет-скан: 0 findings; tmp, runtime .env, локальные credentials и QA база не входят в коммит/образ.
- Новых SQL миграций нет. Production остаётся на существующем PostgreSQL volume; локальные fixtures на VPS не переносятся.
- Мобильная/Fold адаптация отложена пользователем. Внешняя Telegram доставка, принтеры и реальные платежные шлюзы не подтверждаются этими проверками.

## План VPS

Создать уникальный snapshot предыдущего checkout, image, release state и БД; проверить восстановление дампа в отдельной временной БД. Новый clean checkout получить из Git bundle точного опубликованного SHA, скопировать существующий серверный .env без изменения ключей, project territory-crm и volume territory-crm_pgdata. Выполнить официальный deploy-vps.sh с разовым разрешённым HTTP opt-in. Перед seed проверить отсутствие archived baseline категорий.

После запуска проверить exact commit, release fingerprint/image, health с database=postgres, неизменность .env/volume, публичные файлы по Git blob и вход/session/logout и навигацию в браузере. При откате использовать предыдущий image/checkout с тем же DB volume; не восстанавливать БД автоматически поверх текущих данных.

## Фактический результат

01.10.2026 выпуск завершён. Runtime commit `7d573fe13b636ec148e5264191a1bc3935e62ff9` опубликован в main и codex/local-full-qa-20261001; VPS clean checkout `/root/hookah-pos-release-7d573fe1` получен из verified Git bundle этого SHA.

- Snapshot `/var/backups/territory-crm/territory-crm/release-full-20261001-7d573fe1`: прежний checkout/env/image/state и dump; восстановление во временную БД PASS, проверочная БД удалена штатным cleanup.
- Archived baseline categories: 0; новых миграций нет.
- Running image `sha256:a308a63dc779df77c10d3bfe0ea920aa59af41597a18240899726ab622b908c2`; release fingerprint `3cab5438eb43becddab9340108b7d400e642e2335637d438ac8c5a1aef1c0220`, совпадает с image/container/state.
- `.env` побайтно неизменён, volume `territory-crm_pgdata` прежний. До/после: users7, orders0, payments0, guests1, reservations0, products67, venues1. Локальная QA БД не переносилась.
- Health status=ok/database=postgres, db/crm healthy; 39 публичных файлов exact Git blob PASS, актуальные CSS/app/portal revisions; 4 anonymous API routes 401.
- API platform owner: login → authoritative session/role/id → platform → logout → revoked session401 PASS.
- Реальный браузер: Bazinga вошёл как Печеников Роман Андреевич, Кальянщик; рабочий зал/10 столов, Заказы, Гости (1 запись), Задачи, Мой отчёт/обновление и выход PASS; browser error/warn logs пусты. Заказы/оплаты/смены в production не создавались.
- SaaS браузер: вход, Компании, Настройки, один aria-current=location для текущего hash, reload#settings, API доступен, выход PASS. Страница входа оставлена пользователю.
- Helper preflight исправлен на установленный docker-compose до deploy; smoke assertion проверяет app.js176 на staff root и portal.js420 на /admin. Это исправления временных проверок, продукт не менялся.

Результат записан отдельным documentation-only коммитом после выпуска. Runtime SHA остаётся указанным выше; повторное развёртывание неизменённого продуктового кода для записи отчёта не требуется.
