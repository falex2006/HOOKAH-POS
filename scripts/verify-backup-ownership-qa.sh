#!/usr/bin/env bash
set -euo pipefail

# Behavioral shell test: Docker is replaced; no PostgreSQL is contacted.
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
tmp_parent="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
tmp="$(mktemp -d "$tmp_parent/verify-backup-ownership-qa.XXXXXX")"
tmp_resolved="$(cd "$tmp" && pwd -P)"
case "$tmp_resolved" in
  "$tmp_parent"/verify-backup-ownership-qa.*) ;;
  *) echo 'Unexpected QA temporary path' >&2; exit 1 ;;
esac
cleanup() {
  [[ -d "$tmp_resolved" ]] || return 0
  local actual
  actual="$(cd "$tmp_resolved" && pwd -P)"
  if [[ "$actual" == "$tmp_resolved" && "$actual" == "$tmp_parent"/verify-backup-ownership-qa.* ]]; then
    rm -rf -- "$actual"
  else
    echo 'Refusing cleanup outside QA temporary directory' >&2
    return 1
  fi
}
trap cleanup EXIT
mkdir -p "$tmp_resolved/bin"
# Git's Windows checkout may use CRLF; production Git text is LF.
sed 's/\r$//' "$root_dir/verify-backup.sh" > "$tmp_resolved/verify-backup.sh"
printf 'SELECT 1;\n' | gzip > "$tmp_resolved/backup.sql.gz"
cat > "$tmp_resolved/bin/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$QA_LOG"
case "$*" in
  'compose version') exit 0 ;;
  'compose exec -T db createdb '*)
    [[ "$QA_SCENARIO" != collision ]] || exit 42
    exit 0 ;;
  'compose exec -T db dropdb '*)
    [[ "$QA_SCENARIO" != cleanup_failure && "$QA_SCENARIO" != restore_cleanup_failure ]] || exit 44
    exit 0 ;;
  'compose exec -T db psql '*)
    if [[ "$*" == *' -Atqc '* ]]; then
      if [[ "$QA_SCENARIO" == missing_tables ]]; then printf 'f\n'; else printf 't\n'; fi
    else
      cat >/dev/null
      [[ "$QA_SCENARIO" != restore_failure && "$QA_SCENARIO" != restore_cleanup_failure ]] || exit 43
    fi
    exit 0 ;;
  *) echo 'Unexpected fake Docker call' >&2; exit 99 ;;
esac
FAKE_DOCKER
chmod +x "$tmp_resolved/bin/docker"

run_case() {
  local scenario="$1" expected_status="$2" expected_drops="$3" expected_pass="$4"
  local database="crm_restore_check_qa_owned" status output log drops
  [[ "$scenario" != invalid_name ]] || database='invalid-name'
  log="$tmp_resolved/$scenario.log"
  : > "$log"
  set +e
  output="$(PATH="$tmp_resolved/bin:$PATH" QA_LOG="$log" QA_SCENARIO="$scenario" POSTGRES_USER=qa RESTORE_TEST_DB="$database" bash "$tmp_resolved/verify-backup.sh" "$tmp_resolved/backup.sql.gz" 2>&1)"
  status=$?
  set -e
  [[ "$status" -eq "$expected_status" ]] || { echo "$scenario: wrong exit status $status" >&2; exit 1; }
  drops="$(grep -c '^compose exec -T db dropdb ' "$log" || true)"
  [[ "$drops" -eq "$expected_drops" ]] || { echo "$scenario: wrong cleanup count $drops" >&2; exit 1; }
  if [[ "$expected_pass" == true ]]; then
    [[ "$output" == *'BACKUP RESTORE TEST: PASS'* ]] || { echo "$scenario: missing PASS" >&2; exit 1; }
  else
    [[ "$output" != *'BACKUP RESTORE TEST: PASS'* ]] || { echo "$scenario: false PASS" >&2; exit 1; }
  fi
  if [[ "$scenario" == collision ]]; then
    ! grep -q '^compose exec -T db psql ' "$log" || { echo 'Restore ran after failed creation' >&2; exit 1; }
  fi
  if [[ "$scenario" == invalid_name ]]; then
    [[ ! -s "$log" ]] || { echo 'Invalid name reached Docker' >&2; exit 1; }
  fi
  if grep '^compose exec -T db dropdb ' "$log" | grep -vq ' crm_restore_check_qa_owned$'; then
    echo 'Cleanup targeted a database not owned by the test' >&2; exit 1
  fi
}

run_case collision 42 0 false
run_case restore_failure 43 1 false
run_case restore_cleanup_failure 43 1 false
run_case missing_tables 1 1 false
run_case success 0 1 true
# Explicit cleanup fails; EXIT trap retries only the owned database.
run_case cleanup_failure 44 2 false
run_case invalid_name 2 0 false
echo 'VERIFY BACKUP OWNERSHIP QA: PASS (7 fake-Docker scenarios; no live database)'
