# Курсор и единственный зал — production

Дата:2026-10-09. PR:https://github.com/falex2006/HOOKAH-POS/pull/15
Commit:e5dae4c4e0da4a3295fcee164e19acaee3383349. CSS417/app220.

Скрыта строка единственного зала (CSS перекрывал hidden). При двух залах вкладки работают. Стрелка курсора у кальянщика и бармена: тёмная середина, светлый округлый контур, красное свечение. Специальные формы курсора сохранены.

Проверки: focused cursor-zone QA, source/dist, syntax, header contract, independent code-health и обе CI проверки PASS. Edge локально: один зал высота0; два зала — переключение в пустой второй зал PASS; вход/выход PASS.

VPS: backup restore PASS, health/login/session/Secure/logout PASS; anonymous POS denied. Архив976файлов совпадает с Git SHA, см.CURSOR_ZONE_PRODUCTION_MANIFEST.json.

Production Edge под кальянщиком: app220, красный SVG применяется, строка зала высота0;10столов, последний низ694.73px при1389×710. Включено «Вместить». Скриншот:tmp/cursor-zone-production.jpg. Нативный курсор скриншотом не захватывается; цвет/форма проверены по SVG и computed CSS.
