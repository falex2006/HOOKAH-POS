# UI-07.1 — Reviews

2026-10-10. **GO SCOPED WITH DOCUMENTED DEBT**. Рабочее дерево сравнивалось с immutable UI071 intake; весь унаследованный WIP не принят этим решением.

| Ответственный | Результат и доказательство |
|---|---|
| system_architect, независимый помощник | Source GO; после API/PG проверки finance/security GO scoped. Непустые replay IDs/keys, totals, captured context, tenant guards и protected backend независимо сверены. `acceptance/reports/architect-final-review.md` |
| code_health_engineer, независимый помощник | Baseline и final diff; 36/3/20, legacy74/mounted16 и focused regressions PASS. Найдены и исправлены native event-order/cleanup defects; восстановлены8 лишних CR вне scope. Final CSSc61/source/dist/UTF8 base equality PASS. `acceptance/reports/health-final.md` |
| qa_engineer / design_lead, независимый помощник | Actual-source36 PASS. Найдены/исправлены светлый контраст, inner clipping и selector regression закрывающей кнопки. Финальные39 основных v8 пар: SHA/геометрия PASS; просмотрены affected pixels, payment close7.62:1, refund close3.89:1, remove6.10:1. `acceptance/reports/designqa-visual-review.md` |
| frontend_engineer | Передан код четырёх source/dist. Координатор интегрировал context guards, native lifecycle и финальные scoped CSS/message исправления. `acceptance/reports/frontend-result.md` — исторический handoff, финальные hashes в manifest |
| Координатор, finance_domain / warehouse_domain | Реальные GUI операции, fault injection после/до upstream, API readbacks и read-only PG. 8 сверок, 6 denied403, финальный payment journal unchanged после визуальных проходов; суммы/остатки в RESULT. Серверные правила и себестоимость не менялись |

Нативные помощники использовались с независимыми областями и максимум тремя одновременно. Browser actions и интеграцию выполнял координатор. Переключение модели основного чата не заявлено.

## Решение координатора

UI-07.1 принят в указанной области. Pending-close блокируется до settlement; idle Escape очищает native state и возвращает фокус. Повтор refund/reversal сохраняет существующий ключ. Late completion не выполняет следующий mixed tender в изменившемся контексте. Суммы/stock/guest balance реально сверены, 40 финальных пар и4 отданных assets совпадают с candidate. GitHub/VPS публикации и запуска UI-07.2 нет.

Остаются явно ограниченные доказательства: forced venue/individual rights combinations — VM, session loss — actual browser/PG; earlier runtime shots имеют прежний fingerprint; movement ambiguous retry и key persistence across full reload сохраняют исходные ограничения backend/storage. Полный release, Edge/WCAG/Fold и соседние страницы не приняты. Следующие владельцы: QA/architect до production release, finance/warehouse для протоколов неопределённого результата, shell/frontend для narrow toast.

Подробности: [UI_07_1_RESULT.md](UI_07_1_RESULT.md). Безопасные документы/проверки скопированы в [acceptance](evidence/UI-07.1/acceptance/manifest.json); рабочие приватные настройки туда не входят.
