#!/usr/bin/env bash
set -euo pipefail

# Apply versioned PostgreSQL migrations to an already initialized CRM volume.
# Run from the project directory after `docker compose up -d db`.
command -v docker >/dev/null || { echo 'Docker is required' >&2; exit 1; }

if docker compose version >/dev/null 2>&1; then
  COMPOSE='docker compose'
elif docker-compose version >/dev/null 2>&1; then
  COMPOSE='docker-compose'
else
  echo 'Docker Compose is required' >&2
  exit 1
fi
test -f .env || { echo 'Create .env from .env.example first' >&2; exit 1; }
skip_menu_seed="${SKIP_MENU_SEED_ONCE:-}"
case "$skip_menu_seed" in
  ''|true) ;;
  *) echo 'SKIP_MENU_SEED_ONCE must be true when provided' >&2; exit 1 ;;
esac
set -a
. ./.env
set +a

$COMPOSE up -d --no-recreate db
for attempt in $(seq 1 30); do
  if $COMPOSE exec -T db pg_isready -U "${POSTGRES_USER:-crm}" -d "${POSTGRES_DB:-crm}" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

# Match scripts/migrate.js lexical ordering and keep each file atomic. A failed
# statement must not leave a partially-applied migration before the next retry.
export LC_ALL=C
for migration in migrations/*.sql; do
  test -f "$migration" || continue
  echo "Applying $migration"
  $COMPOSE exec -T db psql --single-transaction -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-crm}" -d "${POSTGRES_DB:-crm}" < "$migration"
done

echo 'CRM migrations applied'
$COMPOSE up -d --no-deps crm
if [ "$skip_menu_seed" = 'true' ]; then
  echo 'Skipping menu seed for this explicitly scoped release'
else
  $COMPOSE exec -T crm npm run db:seed-menu
  echo 'CRM menu catalog synchronized'
fi
