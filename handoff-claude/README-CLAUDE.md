# Передача Hookah POS для работы в Claude

Исходная версия проекта: `0837bf43` (снимок зафиксированного коммита). Архив не включает `.env`, Git-историю, зависимости и локальные незакоммиченные изменения.

## Запуск на Windows с Docker Desktop

1. Установить и запустить Docker Desktop с поддержкой Linux containers.
2. Распаковать `hookah-pos-0837bf43.zip` в отдельную папку, например `C:\HookahPOS-Claude`.
3. Открыть Claude Desktop/Claude Code с доступом к этой распакованной папке. Приложить этот README или попросить Claude выполнить шаги ниже в терминале.
4. В PowerShell из папки проекта создать локальную конфигурацию для тестовой копии:

```powershell
Copy-Item .env.example .env
```

5. Для изоляции от других локальных проектов открыть `.env` и задать:

```dotenv
COMPOSE_PROJECT_NAME=hookah-pos-claude
POSTGRES_VOLUME_NAME=hookah-pos-claude_pgdata
NGINX_HTTP_PORT=45637
COOKIE_SECURE=false
AUTH_REQUIRED=true
DEMO_ADMIN_PASSWORD=ClaudeLocal-ChangeMe-1
DEMO_OWNER_PASSWORD=ClaudeLocal-ChangeMe-2
DEMO_STAFF_PASSWORD=ClaudeLocal-ChangeMe-3
POSTGRES_PASSWORD=ClaudeLocal-ChangeMe-4
```

Это временные локальные пароли только для личной тестовой машины. Не использовать их на VPS или в production и никому не отправлять файл `.env`.

6. Запустить сборку и сервисы:

```powershell
docker compose up -d --build
```

7. Дождаться статуса `healthy`:

```powershell
docker compose ps
```

Открыть <http://localhost:45637>. Если вход включён, использовать одну из учётных записей demo, настроенных в `.env` (логин `admin`, `owner` или `staff` и соответствующий заданный пароль). Если Claude меняет конфигурацию или код — останавливать и запускать контейнер заново при необходимости:

```powershell
docker compose down
docker compose up -d --build
```

## Остановка и данные

Остановить контейнеры, сохранив локальную БД:

```powershell
docker compose down
```

Полностью удалить только тестовую БД этой копии:

```powershell
docker compose down -v
```

Последняя команда удаляет данные локальной тестовой БД `hookah-pos-claude_pgdata`. Перед запуском убедиться, что в `.env` сохранены именно `COMPOSE_PROJECT_NAME=hookah-pos-claude` и `POSTGRES_VOLUME_NAME=hookah-pos-claude_pgdata`.

## Инструкция Claude

Работай только с распакованной локальной копией. Не подключайся к внешним production-сервисам, не публикуй сайт и не загружай реальные клиентские/сотруднические данные. Сначала изучи README и структуру проекта, затем выполняй локальные изменения. Сохраняй изменения так, чтобы их можно было вернуть в виде ZIP или diff. Не включай `.env`, базу данных, пароли, токены, `node_modules` и другие локальные данные в передаваемый результат. Перед возвратом перечисли изменённые файлы, цель каждой правки и команды проверки.
