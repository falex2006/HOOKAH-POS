# Кадрирование дымового фона на ПК — 2026-10-01

> Историческое основание и проверка отдельного изменения от 2026-10-01. Описанные приёмка и значения относятся к этому пакету; текущие общие правила задают [VISUAL_PAGE_RULES.md](../../VISUAL_PAGE_RULES.md) и [DESIGN_TOKENS.md](../../DESIGN_TOKENS.md). Повторная визуальная приёмка здесь не заявляется.

## Причина и решение

Одобренный MP4 содержит watermark у нижней границы. При desktop aspect ratio обычный `object-fit:cover` оставлял эту часть кадра видимой. На ширине от901px video и PNG texture увеличены в1.2раза с общей точкой привязки `50% 0`; существующий backdrop `overflow:hidden` отсекает нижнюю часть. Форма, логотип и auth controller не масштабируются. Сам MP4 и PNG не изменены.

Общий фон применяется к входу и PIN-блокировке. Cache revision auth-smoke.css=2, lock.js=22; исходные страницы, dist и динамическое подключение стиля блокировки согласованы. До900px новая media rule не действует; мобильная компоновка и её QA отложены пользователем.

## Приёмка

- CUA на локальном preview31921: default1170×764,1024×768,1280×720,1920×1080. Watermark отсутствует, video paused=false, computed transform=matrix(1.2,0,0,1.2,0,0); карточка сохраняет381.6×584.95px.
- PIN-блокировка синтетического сотрудника: общий crop, CSSrev2, video проигрывается, watermark отсутствует. Реальные учётные записи не использованы.
- Первые screenshot сразу после viewport resize оказались устаревшими; заменены стабильными raw captures `tmp/smoke-crop/final-1280x720.png` и `final-1920x1080.png` с JSON фактических DOM размеров. Эти proof files не включаются в Git/release.
- Crop/login/lock/design/brand/static-boundary contracts и smoke runtime/assets HTTP QA — PASS. Fallback/reduced-motion проверены существующими runtime и CSS contracts; системная настройка ОС не переключалась.
- Независимые code_health и design/frontend/QA/release reviews приняты. Только локальные файлы и коммит. GitHub/VPS не обновлены, пользовательский dirty checkout и preview31907 сохранены.
