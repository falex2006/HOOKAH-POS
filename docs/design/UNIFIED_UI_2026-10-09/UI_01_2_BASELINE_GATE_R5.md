# UI-01.2 — действующий gate R5

2026-10-09. **SCOPE ADOPTED / STAGE NOT ACCEPTED.** Решение координатора D-UI012-R5, `docs/ai-team/DECISIONS.md`.

Введён контракт [R4 gate](UI_01_2_BASELINE_GATE_R4.md) с обязательствами **1 080 baseline slots + 42 appearance groups / 198 visual-state obligations** из `UI_01_2_REPRESENTATIVES_R4.json`. Старый proposed документ остаётся историей; его checklist и ограничения применяются через этот current gate. Подписи о введении scope: system_architect и QA в [CONTRACT R5](UI_01_2_CONTRACT_R5.md), design в [VISUAL REVIEW R5](UI_01_2_VISUAL_REVIEW_R5.md). Это не подписи завершения этапа.

Основание — PLAN: исходная визуальная база в UI-01.2, полный обход системы в UI-09.1. Заменено только расширенное требование принять все 6 480 exhaustive route×state cases до начала визуальных миграций. Все IDs и фактические pending/rejected/defect statuses сохранены. Обязательные distinct visual states не переносятся в backlog; реальная роль, own-session/route bridge, bitmap/current SHA, requested/actual theme, измеренная геометрия, узкий region N_A и независимая проверка остаются обязательными. Никакая equivalence этим решением автоматически не утверждается.

Допускается terminal access restriction с независимо просмотренным permission-inapplicable ghost pending shell control как `CHECKED_BASELINE_DEFECT_PERMISSION_INAPPLICABLE_PENDING_CONTROL`, только после own-role/session/source proof и назначения defect owner. Это явно уточняет старое R3 правило «любой pending shift incomplete». Обычный непроверенный pending или реально ожидающее чтение остаются REQUIRED_PENDING; весь shell не становится N_A. Platform root finding пока кандидат до reconcile этих условий; CSV не изменён на принятый outcome.

Приёмка UI-01.2 требует закрытия всех 1 080/198 obligations честными reviewed outcomes и отдельных design/QA/architect signoffs по фактическому материалу. Документированный исходный дефект допускается как материал базы; это не product correctness PASS и не разрешение release. Текущий outcome: **INCOMPLETE**, см. [checkpoint R5](UI_01_2_CHECKPOINT_R5.md).
