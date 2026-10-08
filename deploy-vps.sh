#!/usr/bin/env bash
set -euo pipefail
umask 077

# Run from the CRM directory on a fresh Ubuntu/Debian VPS.
# Do not put real passwords in this file; create .env before running it.
allow_http_deploy_once="${ALLOW_HTTP_DEPLOY_ONCE:-}"
unset ALLOW_HTTP_DEPLOY_ONCE
skip_menu_seed_once="${SKIP_MENU_SEED_ONCE:-}"
unset SKIP_MENU_SEED_ONCE
case "$skip_menu_seed_once" in
  ''|true) ;;
  *) echo 'SKIP_MENU_SEED_ONCE must be true when provided' >&2; exit 1 ;;
esac
command -v docker >/dev/null || { echo 'Docker is required'; exit 1; }

if docker compose version >/dev/null 2>&1; then
  COMPOSE='docker compose'
elif docker-compose version >/dev/null 2>&1; then
  COMPOSE='docker-compose'
else
  echo 'Docker Compose is required' >&2
  exit 1
fi
test -f .env || { echo 'Create .env from .env.example first'; exit 1; }
set -a
. ./.env
set +a
[ "${AUTH_REQUIRED:-}" = 'true' ] || { echo 'AUTH_REQUIRED=true is required on VPS' >&2; exit 1; }
case "${COOKIE_SECURE:-}" in
  true) ;;
  false)
    [ "$allow_http_deploy_once" = 'true' ] || {
      echo 'COOKIE_SECURE=false requires the one-time ALLOW_HTTP_DEPLOY_ONCE=true shell opt-in for this authorized HTTP-only deployment' >&2
      exit 1
    }
    echo 'WARNING: deploying with non-secure session cookies over HTTP by explicit configuration' >&2
    ;;
  *) echo 'Set COOKIE_SECURE=true, or explicitly invoke this release once with ALLOW_HTTP_DEPLOY_ONCE=true when COOKIE_SECURE=false' >&2; exit 1 ;;
esac
for secret_name in POSTGRES_PASSWORD DEMO_ADMIN_PASSWORD DEMO_OWNER_PASSWORD DEMO_STAFF_PASSWORD STAFF_PASSPORT_KEY SAAS_OWNER_PASSWORD; do
  secret_value="${!secret_name:-}"
  [ -n "$secret_value" ] || { echo "$secret_name is required" >&2; exit 1; }
  case "$secret_value" in change_*|*change_me*|*change_this*|replace-*|*replace-with*) echo "Replace placeholder in $secret_name" >&2; exit 1;; esac
done
[ -n "${SAAS_OWNER_EMAIL:-}" ] || { echo 'SAAS_OWNER_EMAIL is required' >&2; exit 1; }
case "${SAAS_OWNER_EMAIL}" in platform-owner@example.com|change_*|replace-*|replace_*|*@example.com) echo 'Replace placeholder in SAAS_OWNER_EMAIL' >&2; exit 1;; esac

$COMPOSE config --quiet
release_commit="$(git rev-parse --verify HEAD 2>/dev/null)" || { echo 'Deploy from a committed Git checkout' >&2; exit 1; }
release_branch="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
[ "$release_branch" = 'main' ] || { echo 'Deployments must come from the canonical main branch' >&2; exit 1; }
dirty_paths="$(git status --porcelain --untracked-files=all)"
[ -z "$dirty_paths" ] || { echo 'Commit or remove all untracked and modified release files before deploying' >&2; exit 1; }
project_name="${COMPOSE_PROJECT_NAME:-hookah-pos}"
[[ "$project_name" =~ ^[A-Za-z0-9._-]{1,63}$ ]] || { echo 'COMPOSE_PROJECT_NAME has an invalid format' >&2; exit 1; }
export COMPOSE_PROJECT_NAME="$project_name"
export CRM_RELEASE_ID=unreleased
exec 8>"/var/lock/$project_name-deploy.lock"
flock 8
state_dir="/var/lib/territory-crm/$project_name"
backup_dir="/var/backups/territory-crm/$project_name"
mkdir -p "$state_dir" "$backup_dir"
chmod 700 "$state_dir" "$backup_dir"
key_file="$state_dir/fingerprint.key"
if [ ! -s "$key_file" ]; then
  key_tmp="$key_file.tmp.$$"
  openssl rand -hex 32 > "$key_tmp"
  chmod 600 "$key_tmp"
  mv "$key_tmp" "$key_file"
fi
fingerprint_key="$(cat "$key_file")"
[[ "$fingerprint_key" =~ ^[A-Fa-f0-9]{64}$ ]] || { echo 'Release fingerprint key is invalid; refusing deployment' >&2; exit 1; }
config_hash="$($COMPOSE config | openssl dgst -sha256 -hmac "$fingerprint_key" | awk '{print $NF}')"
release_fingerprint="$(printf '%s:%s' "$release_commit" "$config_hash" | sha256sum | awk '{print $1}')"
export CRM_RELEASE_ID="$release_fingerprint"
state_file="$state_dir/deployed-release"
backup_label="pre-$release_fingerprint"
state_status=""
state_fingerprint=""
state_backup_label=""
if [ -f "$state_file" ]; then
  IFS='|' read -r state_status state_fingerprint state_backup_label < "$state_file" || true
  running_release=""
  container_id="$($COMPOSE ps -q crm)"
  if [ -n "$container_id" ]; then
    running_release="$(docker inspect --format '{{ index .Config.Labels "com.hookahpos.release-id" }}' "$container_id" 2>/dev/null || true)"
  fi
  if [[ "$state_fingerprint" == "$release_fingerprint" && ( "$state_status" == 'deployed' || "$state_status" == 'in-progress' ) ]]; then
    if [ "$running_release" = "$release_fingerprint" ] && $COMPOSE exec -T crm wget -qO- http://localhost:3000/api/health | grep -q '"status":"ok"'; then
      printf 'deployed|%s|%s\n' "$release_fingerprint" "${state_backup_label:-$backup_label}" > "$state_file.tmp.$$"
      chmod 600 "$state_file.tmp.$$"
      mv "$state_file.tmp.$$" "$state_file"
      echo "Release $release_commit is already deployed and healthy; skipping duplicate deployment"
      exit 0
    fi
    if [ "$state_status" = 'in-progress' ] && [ -n "$state_backup_label" ]; then
      backup_label="$state_backup_label"
    elif [ "$state_status" = 'deployed' ]; then
      backup_label="pre-$release_fingerprint-recovery-$(date -u +%Y%m%dT%H%M%S%N)"
    fi
  fi
fi
printf 'in-progress|%s|%s\n' "$release_fingerprint" "$backup_label" > "$state_file.tmp.$$"
chmod 600 "$state_file.tmp.$$"
mv "$state_file.tmp.$$" "$state_file"
$COMPOSE build --pull crm
# Stop writes before the final backup and keep CRM stopped on migration failure.
$COMPOSE stop crm
BACKUP_DIR="$backup_dir" BACKUP_LABEL="$backup_label" ./backup-postgres.sh
./verify-backup.sh "$backup_dir/crm-$backup_label.sql.gz"
SKIP_MENU_SEED_ONCE="$skip_menu_seed_once" ./migrate-vps.sh
$COMPOSE up -d --no-deps nginx
# Refresh upstream DNS after the CRM container changes.
$COMPOSE restart nginx

for attempt in $(seq 1 30); do
  container_id="$($COMPOSE ps -q crm)"
  running_release=""
  if [ -n "$container_id" ]; then
    running_release="$(docker inspect --format '{{ index .Config.Labels "com.hookahpos.release-id" }}' "$container_id" 2>/dev/null || true)"
  fi
  if [ "$running_release" = "$release_fingerprint" ] && $COMPOSE exec -T crm wget -qO- http://localhost:3000/api/health | grep -q '"status":"ok"'; then
    printf 'deployed|%s|%s\n' "$release_fingerprint" "$backup_label" > "$state_file.tmp.$$"
    chmod 600 "$state_file.tmp.$$"
    mv "$state_file.tmp.$$" "$state_file"
    echo 'CRM is healthy'
    exit 0
  fi
  sleep 2
done

$COMPOSE ps
$COMPOSE logs --tail=100 crm
echo 'CRM did not become healthy' >&2
exit 1
