#!/bin/bash
set -euo pipefail

: "${PGHOST:=postgres}"
: "${PGPORT:=5432}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required}"
: "${BACKUP_DIRECTORY:=/backups}"
: "${BACKUP_INTERVAL_SECONDS:=86400}"
: "${BACKUP_RETENTION_DAYS:=14}"
: "${BACKUP_RETRY_SECONDS:=300}"
: "${BACKUP_HEALTH_WINDOW_MINUTES:=1560}"

is_positive_integer() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    0) return 1 ;;
    *) return 0 ;;
  esac
}

if ! is_positive_integer "$BACKUP_INTERVAL_SECONDS"; then
  echo "Invalid BACKUP_INTERVAL_SECONDS; expected a positive integer." >&2
  exit 2
fi
if ! is_positive_integer "$BACKUP_RETENTION_DAYS"; then
  echo "Invalid BACKUP_RETENTION_DAYS; expected a positive integer." >&2
  exit 2
fi
if ! is_positive_integer "$BACKUP_RETRY_SECONDS"; then
  echo "Invalid BACKUP_RETRY_SECONDS; expected a positive integer." >&2
  exit 2
fi
if ! is_positive_integer "$BACKUP_HEALTH_WINDOW_MINUTES"; then
  echo "Invalid BACKUP_HEALTH_WINDOW_MINUTES; expected a positive integer." >&2
  exit 2
fi

umask 077
mkdir -p "$BACKUP_DIRECTORY"
temporary_path=""
cleanup() {
  if [[ -n "$temporary_path" ]]; then
    rm -f -- "$temporary_path"
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

while :; do
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  final_path="$BACKUP_DIRECTORY/agentguard-$timestamp.dump.age"
  temporary_path="$final_path.partial"

  if pg_dump --format=custom --no-owner --no-privileges --dbname="$PGDATABASE" \
    | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$temporary_path" - \
    && test -s "$temporary_path"; then
    mv "$temporary_path" "$final_path"
    temporary_path=""
    find "$BACKUP_DIRECTORY" -maxdepth 1 -type f -name 'agentguard-*.dump.age' -mtime "+$BACKUP_RETENTION_DAYS" -delete
    date -u +%s > /tmp/agentguard-backup-success
    printf '{"level":"info","event":"postgres_backup_succeeded","file":"%s"}\n' "$(basename "$final_path")"
    sleep "$BACKUP_INTERVAL_SECONDS"
  else
    rm -f "$temporary_path"
    temporary_path=""
    echo '{"level":"error","event":"postgres_backup_failed"}' >&2
    sleep "$BACKUP_RETRY_SECONDS"
  fi
done
