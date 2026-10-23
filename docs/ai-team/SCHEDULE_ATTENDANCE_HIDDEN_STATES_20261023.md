# Локальная приёмка скрытых UI-состояний

Основание и границы: `C:/Users/ADMIN/Documents/ChatGPT/HOOKAH CRM 2/docs/ai-team/POST_RELEASE_COORDINATION_20261023.md`. База — совместный выпуск `17d93081`. Исходная широкая goal остаётся paused; новая цель не создаётся, её завершение не заявляется.

## Остаток этого этапа

- Сверить matrix с существующими schedule load-errors/browser/roles/discard/lifecycle и attendance priority/API/recovery проверками. Не считать исторический PASS доказательством текущего скрытого состояния.
- Проверить реальные mounted UI-модули в изолированном компонентном браузере при 1440/390: loading, empty, denied, transient error/retry; редактор графика cancel/keep/discard/reopen, черновик правил посещаемости refresh/cancel/reopen.
- Сохранить скриншоты и осмотреть их; проверку полного shell/ролей/API/БД/reload отметить отдельно от компонентной. Встроенный browser tool сейчас возвращает disabled; его ограничения не обходить. Изолированный Playwright QA не использует сохранённую пользовательскую сессию.
- Исправлять только воспроизведённые UI-дефекты в staff-schedule-ui/staff-attendance-ui и синхронных dist, добавить относящуюся регрессию. Shared server/portal/style и period validators — по согласованию; guestphone принадлежит лояльности.
- Если для полного сценария понадобится PostgreSQL, заранее согласовать слот с PAYROLL, единственным владельцем общего PG-прогона. VPS-запросы/тесты/релиз запрещены в этом этапе.
- Финал: code-health baseline/diff, syntax/source-dist/relevant contracts, журнал «сценарий → доказательство → остаток»; передать MASTER, без автоматической публикации.

## Уже имеющееся доказательство

Schedule load-errors browser покрывает access/employees/list 503 и повтор на1440, но использует отдельный ранее подготовленный PG runtime; не запускался заново здесь. Schedule discard/lifecycle — извлечённые production методы, не визуальное доказательство. Attendance priority — unit/static решение self-view и assets parity. Shared-help browser проверял справку attendance/schedule через read-only component harness; это не приёмка management/self data states или записи в БД. Полумесячная payroll-приёмка — отдельная работа PAYROLL.

## Зафиксированный результат 2026-10-24

Подтверждены и исправлены: повтор загрузки графика был спрятан в «Ещё»; короткие мобильные названия видов переносились внутри слов из-за CSS specificity; ошибка GET посещаемости не имела alert-семантики; старый ответ access/employees после повторного монтирования перезаписывал новый UI. Добавлены прямой retry, scoped mobile CSS, role=alert, идентичность монтирования и alive-guard. Для actual schedule_unavailable/неизвестных 5xx отображается понятное сообщение без технического кода. Shared portal/server/style, права, БД и payroll-логика не менялись.

Компонентный браузер final assets: 34 снимка/наблюдения390/1440, без document/dialog overflow и pageerror; loading/empty/denied/503retry, guard keep/discard/reopen, attendance dirty refresh/discard/reopen; второй мобильный discard-action доступен прокруткой. Baseline retry4failures, tab-wordwrap1failure и stale-remount4failures сохранены отдельно; после исправлений0. Дополнительно проверен повторный pointer click во время held retry — только один access GET. Это синтетические API и явный component theme root; не доказательство portal auth или theme resolver. Отдельный визуальный аудитор посмотрел actual-PG reloaded390/1440 и ключевые component snapshots, блокирующих визуальных дефектов не выявил.

Actual PostgreSQL browser PASS23 в эксклюзивном слоте, session92051 terminal exit0: обычный login тестового owner, запись day_off через UI → SQL → reload, attendance policy через UI → SQL → reload при390/1440, manager403 без делегирования, отдельный owner другого tenant не видит сохранённую policy. Первые два сбоя были ошибками QA-фикстуры: reload возвращал текущую неделю и first() выбирал скрытый адаптивный дубликат. Продукт ради них не менялся. Runner создавал свежую orders_qa_* БД, удалил её и проверил отсутствие; lock отсутствует. Слот возвращён PAYROLL, новых PG-запусков нет.

ВАЖНО: PG23 относится к assets ДО финальных nonce/copy изменений. Их SHA256 в `tmp/staff-worktime-postgres/tested-assets-before-remount-fix.json`; final PG recheck остаётся PENDING до согласования следующего слота. На final assets подтверждены component34, syntax, source/dist4pairs, discard, lifecycle9, attendance-priority14, graphite и runner42guards. Code-health final GO для локального frozen handoff; это не финальный release gate.

Evidence: `tmp/staff-worktime-hidden-states/report.json`, baseline-report.json, tabs-baseline-report.json, remount-baseline-report.json; `tmp/staff-worktime-postgres/report.json`; `tmp/staff-worktime-pg-run.log` и sanitized runner log. Private runtime config/node_modules не входят в пакет.

## Дальнейшие границы

U1: согласованный final PG recheck замороженных assets; расширенные custom ACL, все ошибки API, все schedule planning/attendance mutations этим этапом полностью не закрыты. U2: остальные конкретные hidden-state gaps исходной AUDIT_COMPLETION_MATRIX (контакты гостей/guestphone — владелец лояльность, setup — по отдельному runtime). Широкая цель не complete. Не считать скрытый адаптивный элемент дефектом и не повторять уже принятые сценарии без причины.

Новая правка пользователя, переданная MASTER: после фиксации этого пакета отдельно проверить персонал — двойная рамка переключателя видов и резкий обрезанный orange search focus; scoped staff-only, все3вида1440/390, mouse/keyboard focus и поиск, без global theme/POS и без публикации. Этот пакет не перезаписывать.
