#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
tmp_parent="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
tmp="$(mktemp -d "$tmp_parent/territory-migrate-vps-qa.XXXXXX")"
tmp_resolved="$(cd "$tmp" && pwd -P)"
case "$tmp_resolved" in
  "$tmp_parent"/territory-migrate-vps-qa.*) ;;
  *) echo 'Refusing to use an unexpected QA temp path' >&2; exit 1 ;;
esac

cleanup() {
  if [[ -n "${tmp_resolved:-}" && -d "$tmp_resolved" ]]; then
    local current_parent current_path
    current_parent="$(cd "$(dirname "$tmp_resolved")" && pwd -P)"
    current_path="$(cd "$tmp_resolved" && pwd -P)"
    if [[ "$current_parent" == "$tmp_parent" && "$current_path" == "$tmp_parent"/territory-migrate-vps-qa.* ]]; then
      rm -rf -- "$current_path"
    else
      echo 'Refusing to remove QA files outside the expected temporary directory' >&2
    fi
  fi
}
trap cleanup EXIT

mkdir -p "$tmp_resolved/bin" "$tmp_resolved/migrations"
cp "$root_dir/migrate-vps.sh" "$tmp_resolved/migrate-vps.sh"
printf 'POSTGRES_USER=qa\nPOSTGRES_DB=qa\n' > "$tmp_resolved/.env"
printf "SELECT 'FAIL_ONCE';\n" > "$tmp_resolved/migrations/001_failure_once.sql"
printf 'SELECT 2;\n' > "$tmp_resolved/migrations/002_after_failure.sql"

cat > "$tmp_resolved/bin/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$LOG_FILE"
case "$*" in
  'compose version') exit 0 ;;
  'compose exec -T db pg_isready '*) exit 0 ;;
  'compose exec -T db psql '*)
    sql="$(cat)"
    if [[ "$sql" == *FAIL_ONCE* && ! -e "$FAILURE_FLAG" ]]; then
      touch "$FAILURE_FLAG"
      exit 42
    fi
    exit 0 ;;
  *) exit 0 ;;
esac
FAKE_DOCKER
chmod +x "$tmp_resolved/bin/docker"

run_migrator() (
  cd "$tmp_resolved"
  PATH="$tmp_resolved/bin:$PATH" LOG_FILE=.qa-log FAILURE_FLAG=.qa-failed bash ./migrate-vps.sh
)

set +e
first_output="$(run_migrator 2>&1)"
first_status=$?
set -e
[[ $first_status -ne 0 ]] || { echo 'Injected migration failure unexpectedly succeeded' >&2; exit 1; }
[[ "$first_output" == *'Applying migrations/001_failure_once.sql'* ]] || { echo 'First migration was not reached' >&2; exit 1; }
[[ "$first_output" != *'Applying migrations/002_after_failure.sql'* ]] || { echo 'Runner continued after a failed migration' >&2; exit 1; }
first_log="$(cat "$tmp_resolved/.qa-log")"
[[ "$(printf '%s\n' "$first_log" | grep -c '^compose exec -T db psql ' || true)" -eq 1 ]] || { echo 'Runner did not stop after its first failed psql call' >&2; exit 1; }
[[ "$first_log" != *'compose up -d --no-deps crm'* && "$first_log" != *'npm run db:seed-menu'* ]] || { echo 'Runner started CRM or seed after a failed migration' >&2; exit 1; }
if printf '%s\n' "$first_log" | grep '^compose exec -T db psql ' | grep -vq -- '--single-transaction'; then
  echo 'A migration psql call omitted --single-transaction' >&2
  exit 1
fi

retry_output="$(run_migrator 2>&1)"
retry_log="$(cat "$tmp_resolved/.qa-log")"
[[ "$retry_output" == *'Applying migrations/001_failure_once.sql'* && "$retry_output" == *'Applying migrations/002_after_failure.sql'* ]] || { echo 'Retry did not run migrations in lexical order' >&2; exit 1; }
[[ "$retry_output" == *'CRM migrations applied'* && "$retry_output" == *'CRM menu catalog synchronized'* ]] || { echo 'Successful retry did not complete the post-migration steps' >&2; exit 1; }
[[ "$(printf '%s\n' "$retry_log" | grep -c '^compose exec -T db psql ' || true)" -eq 3 ]] || { echo 'Unexpected psql invocation count across failure and retry' >&2; exit 1; }
if printf '%s\n' "$retry_log" | grep '^compose exec -T db psql ' | grep -vq -- '--single-transaction'; then
  echo 'A retry migration psql call omitted --single-transaction' >&2
  exit 1
fi

printf '%s\n' 'MIGRATE VPS RUNNER FAILURE/RETRY QA: PASS (fake Docker/psql; stop-on-error, retry ordering, per-file transaction flag, no CRM/seed after failure)'
