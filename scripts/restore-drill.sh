#!/bin/bash
set -euo pipefail

backup_file=${1:-}
identity_file=${2:-}
env_file=${3:-.env.production}
compose_file=${4:-docker-compose.prod.yml}

if [[ ! "$backup_file" =~ ^agentguard-[0-9]{8}T[0-9]{6}Z\.dump\.age$ ]]; then
  echo "Pass a backup filename such as agentguard-20261013T120000Z.dump.age (not a path)." >&2
  exit 2
fi
if [[ -z "$identity_file" || ! -f "$identity_file" ]]; then
  echo "Pass the offline age private identity file as the second argument." >&2
  exit 2
fi
if [[ ! -f "$env_file" || ! -f "$compose_file" ]]; then
  echo "Run this from the project directory and provide a valid env/Compose file." >&2
  exit 2
fi

compose() {
  docker compose --env-file "$env_file" -f "$compose_file" "$@"
}

drill_db="agentguard_restore_drill_$(date -u +%Y%m%d%H%M%S)_$$"
identity_target="/tmp/restore-age-identity-$$"
pg_user=$(compose exec -T backup printenv PGUSER | tr -d '\r')
pg_database=$(compose exec -T backup printenv PGDATABASE | tr -d '\r')
if [[ -z "$pg_user" || -z "$pg_database" ]]; then
  echo "Could not read the backup container's PostgreSQL database/user configuration." >&2
  exit 1
fi
created=0

cleanup() {
  status=$?
  trap - EXIT
  if [[ "$created" == 1 ]]; then
    compose exec -T backup dropdb --if-exists --maintenance-db="$pg_database" "$drill_db" >/dev/null 2>&1 || true
  fi
  compose exec -T backup rm -f "$identity_target" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

compose cp "$identity_file" "backup:$identity_target"
compose exec -T backup createdb --maintenance-db="$pg_database" --username="$pg_user" "$drill_db"
created=1

compose exec -T backup age --decrypt --identity "$identity_target" "/backups/$backup_file" \
  | compose exec -T backup pg_restore --exit-on-error --no-owner --no-privileges --username "$pg_user" --dbname "$drill_db"

migration_count=$(compose exec -T backup psql -X -qAt --username "$pg_user" --dbname "$drill_db" \
  -c "SELECT COUNT(*) FROM schema_migrations" | tr -d '\r')
if [[ ! "$migration_count" =~ ^[0-9]+$ ]] || (( migration_count == 0 )); then
  echo "Restore did not produce a valid AgentGuard schema." >&2
  exit 1
fi

echo "Restore drill passed: encrypted dump decrypted and restored into a disposable database ($migration_count migrations)."
