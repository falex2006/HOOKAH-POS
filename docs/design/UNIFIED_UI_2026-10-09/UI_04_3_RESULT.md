# UI-04.3 — PIN и стек окон

Дата: 2026-10-10. **ACCEPTED_SCOPED_WITH_DOCUMENTED_DEBT.** UI-04.2 завершён ранее; автоматический переход выполнен по прямому разрешению пользователя. Локальный пакет, GitHub/VPS не публиковались.

## Исправление

Воспроизведён D05: естественная автоблокировка поверх native окна настроек показывала прежний PIN ниже browser top layer; поле PIN не получало фокус. Теперь PIN — native modal dialog с доступным именем и viewport scroll. Нижние native/shared/POS окна и черновики сохраняются. PIN удерживает Tab/Escape, перехватывает нижние click/submit и возвращается наверх при позднем открытии native окна или внешнем закрытии собственной поверхности. Рабочие окна не пересоздаются.

Общий владелец scroll lease для PIN/shared не позволяет завершению ожидающего API разблокировать прокрутку страницы. После успешного PIN фокус возвращается в актуальный рабочий контекст; если редактор уже завершён, используется устойчивый heading. Временный tabindex сохраняется до blur. Ответы прошлого lock cycle игнорируются через epoch.

Разблокировка использует прежний POST /api/session/unlock с прежними четырьмя цифрами и серверными ограничениями. Успех привязан к текущим token/user/org/venue/role и ответу сервера. Неверный PIN401 остаётся на блокировке, authentication401 переводит на login. Сигнал другой вкладки дополнительно проверяет живую сессию через GET /api/session; GET подтверждает сессию, не является отдельным доказательством проверки PIN. Серверная политика, RBAC, БД, финансовые обработчики и API payload не изменены.

## Проверки

| Проверка | Результат и граница |
|---|---|
| Focused suite | PASS: 11 syntax, 6 contracts, saved evidence, scoped diff, 2 source/dist mirrors |
| Actual-source VM | 25 PASS PIN lifecycle; shared default74 / mounted16 PASS; stale token/role/venue, epoch, noPIN/network/503 — контролируемые VM, не live outage |
| Saved browser evidence | PASS36 JPG/JSON /108 current-source bindings;25 locked /11 unlocked. Baseline/candidate отдельно diagnostic, старые кадры не перепривязывались |
| Owner layout | Dark/light1366×768,1920×1080,actual1280×720 DPR1.25,narrow390×844. Narrow — ограниченная регрессия, не full mobile/Fold |
| Реальный браузер | Natural60s PIN поверх native/shared/legacy POS;18 Tab/Escape, сохранённый task/POS draft, peer unlock, pending response under PIN и возврат фокуса |
| Реальные роли | Owner, manager, hookah_master, bartender на собственных синтетических аккаунтах. Hookah rate429 и logout, manager/bartender valid PIN. Это не полный role×route аудит |
| Реальный backend | 21 success200,5 invalid_pin401,1 authentication_required401 после точного expiry собственной сессии,1 throttle429. Повторные matrix unlock учитываются отдельно |
| API/readback | Один task POST201 + явный PATCH200, один конечный объект с exact persisted fields; delay18s ответа после записи. Нижняя форма завершается один раз под PIN. Заказы/платежи/возвраты не записывались |
| Harness | Три явно обозначенных кадра late-native / неожиданного PIN close / resume: собственная тестовая страница с настоящим lock.js и backend. Это воспроизводящий fixture, не штатный business route |
| Независимое ревью | Architect/security, health и QA scoped GO; QA отдельно просмотрел17 current JPG |

Исходный PIN card около768px высотой прокручивается на actual720 и desktop768; проверены горизонтальные границы, scrollability и доступность выхода через Tab. Не заявляется видимость всех контролов без прокрутки. Прежний overflow окна настроек PIN остаётся визуальным долгом. Финансовые окна, вся mobile/Fold матрица и полный security аудит этим этапом не принимаются. Старый изолированный PostgreSQL browser runner не запускался и не перенастраивался; его assertions обновлены и syntax проверен.

## Источники и доказательства

- lock.js SHA256: 38275889e013d61c1779c17027c8ac13f39294546db1c22f6a2c53bd8e7b2ef9.
- ui-dialog.js: c384626fd53db3ac049b788b4dfe127af0530ac98dd2fda776c5a0f288b172c8.
- style.css: 0bbac105fabc07bac10f6057e7c38e2fea94231ddbe6f14bb65b49b79ecee689 — прежняя принятая UI-04.2 версия; app/server также неизменны.

[Проверки](evidence/UI-04.3/checks/checks.json), [API proof](evidence/UI-04.3/provenance/api-proof.json), [ревью](UI_04_3_REVIEWS.md), [manifest](evidence/UI-04.3/provenance/manifest.json). Credentials и runtime config не включены в evidence.

## Уборка и продолжение

Own proxy31962 остановлен, собственная вкладка закрыта, viewport override сброшен, fault mode normal. Исходная тема собственного owner восстановлена; пользовательские Edge/preview31952/31957 и UI012 backend31953 не менялись. Синтетические аккаунты и task сохранены в disposable UI012 для воспроизведения. Ошибка начального входа manager была исправлена в test fixture: восстановлено соответствующее исходной роли membership, без расширения прав продукта.

Следующий плановый пакет — UI-05.1 «Рабочий зал, заказ и приготовление», рекомендован GPT-6.1 Sol / High. Он не запущен: разрешение на автоматическое продолжение покрывало один переход UI-04.2→UI-04.3. Переключение модели текстом не заявляется.
