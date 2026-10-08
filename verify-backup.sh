#!/usr/bin/env bash
set -euo pipefail

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi
}

backup_file="${1:-}"
if [[ -z "$backup_file" || ! -f "$backup_file" ]]; then
  echo "Usage: $0 /path/to/crm-YYYYmmddTHHMMSSZ.sql.gz" >&2
  exit 2
fi

gzip -t "$backup_file"
db_user="${POSTGRES_USER:-crm}"
test_db="${RESTORE_TEST_DB:-crm_restore_check_$(date -u +%Y%m%d%H%M%S)}"
# Keep the generated database name safe for use as a PostgreSQL identifier.
if [[ ! "$test_db" =~ ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ ]]; then
  echo "RESTORE_TEST_DB must be a simple PostgreSQL identifier" >&2
  exit 2
fi

created=false
cleanup() {
  [ "$created" = true ] || return 0
  compose exec -T db dropdb --if-exists -U "$db_user" "$test_db" >/dev/null 2>&1 || true
}
trap cleanup EXIT

compose exec -T db createdb -U "$db_user" "$test_db"
created=true
gzip -dc "$backup_file" | compose exec -T db psql -v ON_ERROR_STOP=1 -U "$db_user" -d "$test_db" >/dev/null

check="$(compose exec -T db psql -U "$db_user" -d "$test_db" -Atqc "SELECT (to_regclass('public.users') IS NOT NULL AND to_regclass('public.orders') IS NOT NULL AND to_regclass('public.order_items') IS NOT NULL AND to_regclass('public.payments') IS NOT NULL);")"
if [[ "$(echo "$check" | tr -d '[:space:]')" != "t" ]]; then
  echo "Restore verification failed: required tables are missing" >&2
  exit 1
fi

compose exec -T db dropdb -U "$db_user" "$test_db"
created=false
echo "BACKUP RESTORE TEST: PASS ($backup_file)"
