# UI-04.2 — обычные редакторы и бронирования

Дата: 2026-10-10. **ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT.** UI-04.1 принят ранее. GitHub/VPS не публиковались.

Пакет переносит четыре ordinary редактора — название зоны, объект зала, точку сети, существующую задачу — и новую/редактируемую трёхшаговую бронь. Это ограниченная миграция; остальные portal формы не объявляются перенесёнными. Пилот «Новая задача» UI-04.1 сохраняется. Бронь остаётся списком с одной CTA и шагами «Гость → Визит → Подтверждение».

## Реализация и контракты

- Отдельный helper ordinary editors использует shared `HOOKAH_UI.open`, explicit preserve/block, entity-keyed Map только текущего render. Ошибка API оставляет форму и ввод; закрытие/повторное открытие сохраняет ввод того же объекта; успех/смена verified user/venue/role очищает draft. API выполняется внутри awaited onSubmit, не после разрушения формы. Context/connected-anchor/permissions guard запрещает устаревший UI.
- Бронь монтирует прежнюю форму в shared shell и паркует её обратно при закрытии. Ступени, guest match/client id, вместимость, минимум, summary и payload принадлежат reservation module. Final domain validation раскрывает ошибочный шаг перед focus. Select Escape обрабатывается первым. Pending блокирует поля, шаги, submit, закрытие; ошибка сохраняет edit identity/ввод/шаг.
- Узкое необходимое исключение scope: `ui-dialog.js` получил optional `mount`, `validateMounted` и `onPending` для существующей domain формы, передачу result в onClose и очистку per-open persistent listeners. Владелец решения — system_architect. Default generated-field path/adapters/API не заменены. Не создаются общий form builder или финансовый workflow; full PIN/mixed stack относится к UI-04.3.
- Geometry shared medium640px, bounded viewport, fixed head/footer и scroll body; controls каталога, без новых декоративных эффектов. Refresh места44px; primary форма использует semantic fill.
- Исправлен воспроизведённый browser focus после readback: rerender удалял opener и фокус попадал BODY. Success-only callback после awaited load фокусирует актуальный heading в проверенном контексте. Новый temporary tabindex остаётся до once blur cleanup; существующий tabindex сохраняется. Четыре actual Chromium saved/readback capture подтвердили heading focus по сообщению координатора.
- Исправлена inherited required-блокировка пустого расписания объекта: обе time поля optional, blank отправляет прежний `null/null`; сервер по-прежнему отвергает неполную/одинаковую пару. Числовые coercions, Boolean amenities и expectedVenueId сохранены.

## Границы API/безопасности

Source boundary checker сравнил immutable intake: financial/seating/prepayment/application-reversal/refund handler region и legacy portalAction совпадают; reservation request fields/coercions и reservationId/action=seat list-load совпадают с нормализацией только line endings. Required deposit остаётся требованием, не платежом. Tenant/API guards, role restrictions, routes/БД/idempotency/финансовые расчёты не расширены.

tableId-only по-прежнему выбирает available place и открывает New, исключая reservationId/action=seat; module loader awaited, query считается consumed только после successful open. reservationId раскрывает существующую запись; seat вызывает прежний order action. Async context drift и detached pending completion закрывают context-changed без stale success. Auth/PIN не обходятся. Существующий долг reservations-only роли: GET clients/floor dependencies требуют прав, отсутствующие selector API этим UI не добавляются.

## Проверки и фактические границы доказательств

| Проверка | Подтверждённое состояние |
|---|---|
| Architect source review | SOURCE GO bounded roster/mounted lifecycle/payload/query/RBAC; notes tmp/ui042/architect-notes.md |
| Ordinary extracted-helper | PASS preserve/entity isolation/Boolean false/success+context cleanup/awaited callback/concurrent+detached+module drift; heading lifetime/blur cleanup+existing tabindex |
| Network extracted callback | PASS actual onSubmit PATCH await/exact trim payload/error retention/retry/readback/post-load focus; прежние select/archive/cancel/focus checks сохранены |
| Table schedule extracted callback + server normalizer | PASS optional controls/null-null payload/partial+equal rejection/overnight acceptance/expectedVenue+amenities |
| Focused reservation source/VM | QA note фиксирует PASS wizard/form/polish/async contracts: steps/validation/focus/dropdown/draft/pending/query/context/lifecycle. Это controlled VM, не browser persistence |
| Final opening/layout evidence | PASS98 JPG/JSON пар /294 current source bindings /86 открытых окон /2 pending; обе темы1366×768,1920×1080,actual1228×764,narrow390×844. Независимый pixel review GO |
| Дополнительные final captures | Четыре ошибки и повторные открытия, четыре H1 readback focus; управляющий: guest validation, error/draft step3, pending8s с двумя кадрами >6s, Escape/Enter не закрывают и не дублируют PATCH; success focus стабильной CTA после обоих GET |
| Manager/affected roles | Реальные manager POST201/PATCH200 и reload; hookah_master/bartender задачи без create/edit и явный denial бронирований. Фактическая worker тема dark; оба desktop theme для owner. Это не полный role×route аудит |
| Real API→readback/reload | PASS20 принятых POST/PATCH /7 конечных объектов. Повторные resave учитываются отдельно; 409 table_already_reserved остаётся реальным серверным отказом. paid0/receipts[] у тестовых броней, платежей/возвратов нет. clientId:null означает ручного гостя: backend сохраняет/разрешает guestId, null не заявляется persisted identity |
| Production/PIN full stack/Fold | Не подтверждены; production не публиковалась; PIN stack UI-04.3, Fold UI-10.1 |

Замороженные acceptance source SHA256:
- portal.js 89701EB9536407EBF55EC1761FA97451D91F9CAF9EBCFFE8DED7CB3BA5C66FF6
- style.css 0BBAC105FABC07BAC10F6057E7C38E2FEA94231DDBE6F14BB65B49B79ECEE689
- ui-dialog.js 4FA41BD5BF917F4DD9550BC55F1DDCAB1DFE275BF2F81E4E141603453EF969EB

Before/diagnostic/прежние SHA не перепривязываются к final. Actual viewport является1228×764, не произвольным названием экрана. Narrow regression не означает Fold/full mobile acceptance. Source VM/browser/proxy delivery/auth/API log/readback/actual DB persistence имеют разные границы; итоговый collector должен сохранить эти различия. Не утверждать auth/RBAC/API persisted result по картинкам.

## Завершение и следующий этап

Все относящиеся source, focused, browser, API/readback и независимые review gates закрыты. Подробные результаты: [проверки](evidence/UI-04.2/checks/checks.json), [API readback](evidence/UI-04.2/api-readback.json), [ревью](UI_04_2_REVIEWS.md), [manifest](evidence/UI-04.2/manifest.json). Финальные source сохранены отдельным историческим снимком; UI-04.3 не перепривязывает старые кадры.

Пользователь теперь явно разрешил автоматически продолжить UI-04.3 после **полного принятия UI-04.2**. Это разрешение переопределяет старое PROMPTS «следующий подэтап автоматически не начинать». Следующий этап: UI-04.3 «PIN и стек окон», рекомендованы GPT-6.1 Sol / High. Это рекомендация; фактическое переключение модели не заявляется. До закрытия текущего acceptance gate следующий этап не запускать.


## Ограничения и уборка

Данные только в disposable UI012 PostgreSQL/auth на31953; proxy31961 вводил контролируемые faults до записи или задержку ответа после реальной записи. Сценарий action=seat подтверждён source/VM, без фактического создания заказа. Client selection identity подтверждён VM, manual guest — реальным API. Старые диагностические кадры не входят в98 final. PIN/native полный стек, production и Fold не приняты этим пакетом. Тестовые faults возвращены в normal, исходные owner/manager preferences восстановлены; viewport reset, собственная вкладка и proxy остановлены. Прежние preview/backend и пользовательский Edge сохранены.
