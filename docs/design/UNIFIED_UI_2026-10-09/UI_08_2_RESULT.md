# UI-08.2 — Сеть, интеграции, вход и платформа

2026-10-10. **ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT**, только локально.

## Изменения

- Сеть и интеграции используют существующие семантические токены, обе темы, читаемые статусы и действия44px. Длинные названия/адреса переносятся. Список сети и статус Telegram различают loading/error/retry и игнорируют устаревшие/отсоединённые ответы. Telegram остаётся «В разработке» по реальному ответу сервера; подключение не объявлено готовым.
- Платформа сохраняет отдельную оболочку и API. Светлая/тёмная схема переключается в footer sidebar перед «Выйти», хранится отдельно от tenant preferences. Таблица длинных компаний прокручивается локально вместо сжатия текста до нескольких букв. Старый тёмный градиент модальных окон перекрыт семантической поверхностью без анимации; заголовки, поиск, тарифы и статусы читаемы в светлой теме.
- Окно владельца перемещено из inert detail в sibling с сохранением IDs/fields. Owner/password/create/detail формы не закрываются и не отправляются повторно при pending; controls восстанавливаются до success close/reset. Ошибка сохраняет черновик. GET detail и clipboard используют generation guards; поздний ответ не рисует закрытую/другую компанию и не меняет новое окно восстановления.
- Вход сохраняет fixed-dark C18 и прежний auth/trusted-device/reset/setup процесс. Поля и toggle приведены к читаемым семантическим цветам и44px; login.js не менялся.

## Проверено

7/7 focused suites PASS;18 actual-source platform VM групп PASS (duplicate/error retention/success reset, pending/Escape, stale detail, native confirmations cancel/error, clipboard close/reopen).23 scope guards PASS: protected8 exact, portal вне двух renderers exact, API/verifyRole/delete form+handler exact, login/network/integrationsHTML unchanged, CSS вне scoped блока сохранён кроме трёх разрешённых login цветовых подстановок. Три старых test harness адаптированы под реальный async/DOM lifecycle с сохранением исходных assertions; оригиналы в intake. Syntax5 и scoped diff PASS. После JS-free CSS исправлений guard повторно PASS.

**46 текущих JPEG/JSON пар**:1366×768,1920×1080 и фактический910×764; обе темы платформы/сети/интеграций, fixed-dark login; ограниченный390×844, editor/password/delete shells, read error/retry и owner-denied platform. Все шесть SHA каждой пары совпадают с текущими исходниками; metadata.image задаёт точный файл. Page overflow0. Raster может масштабироваться либо отличаться на1px от CSS viewport инструментом. Не заявлены полный WCAG/Edge/Fold и все состояния/роли×темы. Старый logout оболочки32/37px и owner-status10px — унаследованный долг.

**53 исторические functional пары** сохраняют собственные SHA до последних CSS поправок: реальные pending с Escape, errors/retry/success/reopen, invalid login, network edit и nonempty-delete rejection. JavaScript после них не изменён; их pixels не выданы за финальный CSS. Снимки имеют JFIF bytes при историческом расширении.png; формат обозначен явно. Два промежуточных кадра и orphan images исключены из архива.

Изолированная PostgreSQL hookah_ui012: **49 API/PG checks PASS**. Пять tenant ролей получили20 ожидаемых403 на platform GET list/detail/PATCH/DELETE. Реальные владельцы двух организаций видят взаимно исключающие сети; injected organization query не расширяет выборку; cross-tenant PATCH404 с неизменённым readback. DELETE wrong-confirm400/nonempty409. Только специально созданная пустая UI082 fixture удалена через API200→GET404, PG absence+single audit. Полный server/delete контракт не менялся.

GUI изменил имя временного владельца, тестовый тариф Starter→Growth (billing0) и адрес временной точки: **3 PATCH200, каждый ровно один раз**; три последующих API readback и три read-only PG readback совпадают. **12 журналов заказов, денег и склада точно равны before**, финансовых/складских действий не было. HTTP/source/dist шести assets плюс platform/index.html совпадают; hashes — в final-check.json/manifest.

## Ограничения и долг

- Полная desktop приёмка UI-09.1, публикация UI-09.3, Fold UI-10.1 остаются отдельными. Узкая portal оболочка сохраняет прежний правый отступ. Это scoped acceptance, не полная приёмка продукта.
- Новые credentials/password-save/create/reset-link не вводились и не выдавались через GUI: computer-use policy требует передачи пользователю новых credentials. Их pending/reset/stale сценарии доказаны VM, shells — screenshots; успех routine login существующими credentials и invalid-login error действительно наблюдались.
- Инструмент не предоставил управляемый native confirm в GUI; увиден защищённый DELETE409 для специально созданной непустой компании. GUI cancel не заявлен; cancellation подтверждена actual-source VM. Удаление пустой fixture выполнено отдельно API в изолированном тестовом workflow.
- Старый checkbox «Главный владелец» в owner form не включается в исходный payload. Реальная передача статуса остаётся отдельным действием с confirm. Это прежний бизнес-разрыв, не скрыто исправленный в визуальном этапе. Memory/demo credential fallback, все auth/lock и platform owner business actions не переприняты.

## Завершение

Независимые architect,security,health,QA дали scoped GO: [REVIEWS](UI_08_2_REVIEWS.md). Allowlist archive и точные SHA: [manifest](evidence/UI-08.2/acceptance/manifest.json). Private configs/credentials/raw logs не включены. Собственные31973/31974 остановлены после проверки PID/command line/listener; IAB9/10 закрыты, viewport reset, обе исходные темыdark восстановлены. PostgreSQL31954 сохранён. Dirty WIP/HEAD сохранены; commit/GitHub/VPS нет.

**Следующий UI-08.3 «Завершение эффектов и очистка каскада», GPT-6 Luna / Medium. Не начат.**17/22 подэтапов закрыты;4 до публикации плюс отдельный Fold.
