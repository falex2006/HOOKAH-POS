# UI-09.2 — результат, 2026-10-11

**PREPARED_WITH_RELEASE_CONDITIONS**. Подготовлен конкретный локальный релизный кандидат; публикация не выполнена и не разрешена этим этапом.

## Кандидат

| Поле | Значение |
| --- | --- |
| Branch | `codex/ui092-release` |
| Commit | `11b81f6abea615f5aca35ad3714ae3382be388db` |
| Base | cached `origin/main`: `2e6f557934fe29a9a227dda73277f6c3f99af939` |
| Tree | `c70e4ad4997491f4aec8588f412a492efa4a5756` |
| Изменённые пути | 88, полный список в manifest |
| Frozen inputs | 38, с SHA256 и происхождением |
| Архив | 31 916 725 байт, 1009 файлов |
| SHA256 | `ae1d4e0fe272475ba8a42d56c9a1ab3d05a7859fe557b778787408dfeff8062a` |

Список коммитов пакета: один указанный commit поверх base. Remote/GitHub SHA не обновлялся и не проверялся через fetch. Отдельный managed worktree сохранён для просмотра и следующего этапа.

## Почему реконструкция

Основная папка — старый dirty WIP на HEAD `802d5e635d99e81d1c4cd15e0f35a961d3a9f9cf`. Архивировать её целиком нельзя: туда попали бы старые backend/schema/AlphaSat изменения и временные данные. Immutable UI012 snapshot проверен по 215 hashes; UI012→UI091 изменения восьми файлов перенесены на выбранный upstream base. Сохранены upstream replay-safe migration091, schedule module и проверка обоих времён. Новые миграции, зависимости и бизнес-расчёты в пакет не добавлены.

При переносе focused UI051 обнаружил потерю принятого поведения каталога. Включены точные bounded зависимости из ранее принятого UI012/UI051/UI091: lifecycle/focus/pending/Done, order status и next step, связанные HTML/CSS. Каждый фрагмент имеет происхождение и hash. Код создания заказа и позиции, payload/error/readback не изменён этими дополнениями; это проверено независимо. Принятые frontend pending/reconciliation изменения UI071 входят в UI delta. Неизменность backend/расчётов не означает побайтовую неизменность всех frontend handlers.

`site-map.json` — принятая декларативная карта UI01.1; её historical metadata относится к исходному WIP. Канонические маршруты/права сохранены. Из server перенесено только включение `ui-dialog.js` в static allowlist. Docker COPY, source/dist sync, portal bootstrap и cache revisions `2026101101` согласованы. Дизайн-контракты и reference dependencies входят в finite allowlist, runtime пользователям не показываются.

## Выполненные проверки

- 19/19 focused scripts PASS, включая финансовые VM 36/36 и каталог 17/17. Отдельный actual validator расписания 4/4. Ни один contract не ослаблен ради прохождения; три EOF blank-line нормализации не изменили assertions.
- 36/36 syntax checks на локальном Node24, 55/55 source/dist pairs, staged/HEAD diff whitespace PASS. Проверены Docker/static dynamic dependency closure и неизменность DB/schema/migrations/packages.
- Fresh base → frozen inputs → builder: точный tree и 88 путей; повторные 19 checks PASS, sync идемпотентен.
- Git archive: точная commit annotation, 1009 blob bytes, исполняемые биты, членство, безопасные пути/metadata/EOF. Распаковка: все 1009 hashes совпали. Повторный экспорт: тот же SHA256.
- Ограниченный scanner ключей/tokens и runtime filenames: 0 findings; actual `.env`, приватные runtime данные/БД/tmp/node_modules в архиве отсутствуют. Это не универсальная сертификация поиска секретов.
- Packager negative guards 3/3; archive verifier positive/malformed fixtures 12/12 PASS. Неподходящий первый CRLF архив отклонён и не выдан.
- До итоговых записей документации все 899 tracked файлов основной папки совпали с intake и её index не изменился. Итоговая проверка допускает только PROGRESS/WORK_LOG записи этого этапа.

Полные команды, stdout/status, hashes и независимые выводы: [manifest](manifest.json), [checks](checks/), [reviews](reviews/). Старые failed checkpoints не переписаны в PASS; итоговые результаты выделены отдельно.

Автоматическая проверка отклонила удаление собственных scratch папок `tmp/ui092/repro-checkout` и `tmp/ui092/archive-extracted`. Они сохранены; в архив и allowlist кандидата не входят. Сам candidate worktree чистый и сохранён для следующего этапа.

## Условия выпуска

Свежей browser приёмки перенесённого кандидата и Node20 Docker build/runtime сейчас нет. Снимки UI091 доказывают прежний WIP; полный role×theme×state/Edge/WCAG/OS motion, прежние security findings и Fold не закрыты упаковкой. Необходимы critical desktop/roles/financial проверки кандидата, target image validation, security disposition, clean integration/CI/точный публикуемый SHA, текущий VPS/migration compatibility preflight, backup integrity/restore rehearsal и готовый откат.

[План backup/rollback](CANDIDATE_READINESS.md) подготовлен; production backup, restore, migration, push и deploy не выполнялись. Если итоговый merge меняет SHA, создать и проверить новый архив/manifest. **STOP перед UI-09.3 «GitHub и VPS», GPT-6.1 Sol / High**: требуется отдельная явная команда публикации. UI-10.1 Fold остаётся последующим отдельным этапом.
