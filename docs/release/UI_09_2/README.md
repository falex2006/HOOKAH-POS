# UI-09.2 — релизный пакет интерфейса

**PREPARED_WITH_RELEASE_CONDITIONS**. Локальный кандидат подготовлен и проверен. Публикация не выполнена; `deploymentReady=false`.

- [Manifest](manifest.json): commit, tree, полный allowlist, архив/SHA256, результаты, условия выпуска.
- [Результат](RESULT.md): происхождение пакета и границы доказательств.
- [План выпуска/backup/rollback](CANDIDATE_READINESS.md).
- [Замороженные входы](inputs/manifest.json), [проверки](checks/), [независимые ревью](reviews/).
- [Архив кандидата](../../../tmp/ui092/artifacts/UI-09.2-11b81f6abea615f5aca35ad3714ae3382be388db.tar.gz).

## Проверить готовый архив

Из основной папки проекта, PowerShell:

```powershell
$release = Get-Content -Raw docs/release/UI_09_2/manifest.json | ConvertFrom-Json
node scripts/ui092-verify-archive.cjs $release.candidate.worktree $release.candidate.commit $release.archive.path
```

Проверяется точный Git commit, состав файлов, blob bytes, исполняемые биты, TAR metadata/EOF и ограниченные secret signatures. Нужен доступ к локальному commit. Проверка ничего не распаковывает и не публикует.

## Воспроизвести пакет

Для `$probe` выбрать новую свободную папку. Builder требует чистый отдельный checkout на конкретном base и проверяет все frozen hashes до записи. Пример из основной папки проекта:

```powershell
$release = Get-Content -Raw docs/release/UI_09_2/manifest.json | ConvertFrom-Json
$probe = Join-Path (Split-Path (Get-Location).Path) 'UI-09.2-repro'
git worktree add --detach $probe $release.candidate.baseCommit
if ($LASTEXITCODE -ne 0) { throw 'Checkout failed' }
node scripts/ui092-release-package.cjs $probe
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
git -C $probe add -- $release.candidate.changedFiles
if ($LASTEXITCODE -ne 0) { throw 'Stage failed' }
git -C $probe diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Whitespace check failed' }
$tree = (git -C $probe write-tree).Trim()
if ($tree -ne $release.candidate.tree) { throw 'Tree mismatch' }
foreach ($check in $release.checks.focusedScripts) {
    node (Join-Path $probe $check)
    if ($LASTEXITCODE -ne 0) { throw "Check failed: $check" }
}
```

Tree comparison подтверждает весь кандидат, включая неизменённые файлы base. Локальный повтор уже выполнен: 38 входов, 88 изменённых путей, 19 проверок, одинаковое дерево и идемпотентный sync. Node24 source/VM проверки не заменяют Node20 Docker runtime и браузерную приёмку.

## Экспорт точного commit

```powershell
git -C $release.candidate.worktree -c core.autocrlf=false archive --format=tar.gz "--output=$($release.archive.path)" $release.candidate.commit
if ($LASTEXITCODE -ne 0) { throw 'Archive failed' }
node scripts/ui092-verify-archive.cjs $release.candidate.worktree $release.candidate.commit $release.archive.path
```

`core.autocrlf=false` обязателен: первый экспорт с Windows `true` был отклонён проверкой blob bytes. Исправленный архив побайтово проверен, распакован и повторно экспортирован с одинаковым SHA256. Первоначальная ошибка сохранена в checks; ошибочный архив удалён из папки выдачи.

## Хранение и следующий этап

Архив находится в `tmp/ui092/artifacts`; до UI-09.3 его и локальный candidate commit/worktree сохранить. Frozen recipe и результаты находятся в docs/release/UI_09_2; временные QA runtime outputs в архив не включены. Main dirty WIP не превращён в commit и не опубликован. Следующий этап — отдельный запуск **UI-09.3, GPT-6.1 Sol / High**, после выполнения условий manifest.
