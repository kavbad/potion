#!/usr/bin/env bash
# Render Postgres restore drill (2026-08-22). Runs ON potion-prod. Proves the
# dump → restore path end to end into a throwaway postgres:17 container and
# prints table/row counts for both sides. Never touches the live database
# beyond a read-only pg_dump; never prints the connection string.
#
#   bash /opt/potion/app/scripts/restore-drill.sh
set -euo pipefail
ENV_FILE=${ENV_FILE:-/opt/potion/.env.prod}
OUT=${OUT:-/opt/potion/backups}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUT"; chmod 700 "$OUT"
URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
[ -n "$URL" ] || { echo "DATABASE_URL missing in $ENV_FILE"; exit 2; }
DUMP="$OUT/drill-$STAMP.dump"
echo "1/4 dump (custom format)"
docker run --rm -e PGURL="$URL" postgres:17 sh -c 'pg_dump "$PGURL" -Fc --no-owner --no-privileges' > "$DUMP"
chmod 600 "$DUMP"; ls -l "$DUMP" | awk '{print "   size", $5, "bytes"}'
echo "2/4 scratch postgres"
docker rm -f pg-drill >/dev/null 2>&1 || true
docker run -d --name pg-drill -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=drill postgres:17 >/dev/null
for i in $(seq 1 30); do docker exec pg-drill pg_isready -U postgres -d drill >/dev/null 2>&1 && break; sleep 1; done
echo "3/4 restore"
docker cp "$DUMP" pg-drill:/tmp/drill.dump
docker exec pg-drill pg_restore -U postgres -d drill --no-owner --no-privileges --exit-on-error /tmp/drill.dump
echo "4/4 compare (tables, and rows in the tables a partner's data lives in)"
Q="select count(*) from information_schema.tables where table_schema='public'"
LIVE_T=$(docker run --rm -e PGURL="$URL" postgres:17 psql "$PGURL" -tAc "$Q" 2>/dev/null | tr -d ' ')
DRILL_T=$(docker exec pg-drill psql -U postgres -d drill -tAc "$Q" | tr -d ' ')
echo "   tables live=$LIVE_T drill=$DRILL_T"
for t in orgs api_keys policies request_logs frontiers org_incumbents learning_proposals; do
  L=$(docker run --rm -e PGURL="$URL" postgres:17 psql "$PGURL" -tAc "select count(*) from $t" 2>/dev/null | tr -d ' ' || echo '?')
  D=$(docker exec pg-drill psql -U postgres -d drill -tAc "select count(*) from $t" 2>/dev/null | tr -d ' ' || echo '?')
  printf "   %-20s live=%-8s drill=%-8s %s\n" "$t" "$L" "$D" "$([ "$L" = "$D" ] && echo ok || echo DIFF)"
done
docker rm -f pg-drill >/dev/null
echo "done: $DUMP kept (0600); scratch container removed"
