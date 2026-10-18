#!/usr/bin/env bash
set -euo pipefail

project_dir=${HOOKAH_PROJECT_DIR:-/opt/hookah-pos}
case "$project_dir" in
  /*) ;;
  *) echo 'HOOKAH_PROJECT_DIR must be an absolute path' >&2; exit 2 ;;
esac

cd "$project_dir"
docker compose exec -T nginx nginx -t
docker compose exec -T nginx nginx -s reload
