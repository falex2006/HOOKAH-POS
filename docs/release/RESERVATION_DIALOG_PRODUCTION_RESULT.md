# Бронирования — пошаговый диалог

2026-10-09. PR17:https://github.com/falex2006/HOOKAH-POS/pull/17
Commit:2786addedc26ed5afa44e19dc5fa8a225403d4b4. CSS419/portal481.

Одна CTA и список; форма в3-шаговом native dialog. Same POST/PATCH payload, финансовые действия/права сохранены. Draft/error retention, pending guards, focus/Escape, явная валидация скрытых полей, показ даты сохранённой записи. Guard tableId-only исключает reservationId/seat.

Локально: временный управляющий в memory test environment. Create future date→list→edit2→3guests→reload/list-date PASS. Blank guest/capacity6/Escape(select first)/draft reopen/focus PASS. 1366×710:dialog step2height588px/no scroll.390×844:no horizontal overflow. Три reservation QA + design/header/syntax/source-dist PASS. Architect/code health final accepted. CI exacthead c79c00658202c4bad3b705b835da98268a9f6512 обе success.

Archive978files exact Git match, manifest RESERVATION_DIALOG_PRODUCTION_MANIFEST.json. VPS postdeploy проверка следует.

Исходная отдельная особенность сервера: роль с одним разрешением reservations не получает floor/clients selectors. Эту область прав пакет не меняет.

Production итог: backup restore/health/login/session/Secure/logout PASS, anonymous POS denied. Под кальянщиком Edge1389×710:список с одной CTA, диалог открывается/закрывается и возвращает фокус; таблицы загружены (11options), CSS419 и курсор ввода с glow применяются. Скриншоты tmp/reservation-list-production.jpg и tmp/reservation-dialog-production.jpg. Тестовые production брони не создавались.
