#!/bin/sh
# ============================================================================
# AmisiBiz clean-room migration + RLS verification chain.
#
# Rebuilds a database from nothing and carries it through the whole chain a
# fresh deploy would see, then proves the behaviour the security model claims:
#
#   fresh DB
#     -> migrations 1..7 (legacy shapes)
#     -> foreign-table probe (PRE-remediation evidence: what the old blanket
#        grants let the runtime role reach)
#     -> fixtures/phase1-legacy-fixture.sql (legacy ids, legacy role labels)
#     -> migrations 8..10 (Phase 1: UUID identity, RBAC catalog, RLS + grants)
#     -> POST probes (that reachability gone)
#     -> prisma/scripts/phase01-migration-checks.sql   (structural battery)
#     -> prisma/scripts/rls-behavior-battery.sql       (behaviour, as amisibiz_app)
#     -> migration 11 ABORT probe (legacy text planId must be refused loudly)
#     -> operator resolves the legacy label -> migration 11 applies
#     -> rls-behavior-battery.sql again (Phase 1 regression on top of 11)
#     -> prisma/scripts/phase02-migration-checks.sql   (Phase 2 battery)
#     -> any migration newer than 11 that the working tree carries, in deploy
#        order, with the behaviour battery re-run on top of it
#
# Everything here runs against a DISPOSABLE database only. It never touches the
# shared Supabase project: this script speaks raw psql precisely because
# `prisma migrate deploy` resolves DIRECT_URL from apps/web/.env, which points at
# production (docs/RUNBOOK.md §5).
#
# Usage:
#   sh scripts/db/cleanroom-chain.sh [dbname]
#
# Environment (defaults suit the local throwaway cluster described in
# docs/RUNBOOK.md §5):
#   PGHOST=localhost  PGPORT=55499  PGUSER=postgres  DB=p37_chain  LOGDIR=.tmp
#   PGBIN=/c/Program Files/PostgreSQL/18/bin   (added to PATH when it exists)
# ============================================================================
set -eu

DB="${1:-${DB:-p37_chain}}"
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-55499}"
PGUSER="${PGUSER:-postgres}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$ROOT/apps/web/prisma/migrations"
SCRIPTS="$ROOT/apps/web/prisma/scripts"
FIXTURE="$SCRIPTS/fixtures/phase1-legacy-fixture.sql"
LOGDIR="${LOGDIR:-$ROOT/.tmp}"

[ -d "$LOGDIR" ] || mkdir -p "$LOGDIR"
[ -d "${PGBIN:-}" ] && PATH="$PGBIN:$PATH"

PSQL="psql -h $PGHOST -p $PGPORT -U $PGUSER -q"
PHASE11="$MIG/20261019000000_phase02_provider_administration_plans_and_suspension_gates"

echo "=== 1. fresh database: $DB (host $PGHOST:$PGPORT as $PGUSER)"
$PSQL -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB WITH (FORCE);"
$PSQL -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB;"

apply() { # apply() <migration-dir-name>
    echo "--- applying $1"
    $PSQL -d "$DB" -v ON_ERROR_STOP=1 -1 -f "$MIG/$1/migration.sql" >/dev/null
}

echo "=== 2. legacy migrations (1..7)"
for m in $(ls -1 "$MIG" | grep '^2'); do
    case $m in
        # 8..10 are the Phase 1 migrations (applied after the fixture), 11 is
        # probed separately below, and 12 (the Phase 05-era portal-linkage
        # migration, still uncommitted) belongs AFTER 11 like any real deploy.
        # Skipping it here is what keeps step 2 honest as "migrations 1..7".
        20261018000000* | 20261018000001* | 20261018000002* | 20261019000000* | 20261020000000*) continue ;;
    esac
    apply "$m"
done

echo "=== 3. foreign table standing in for the other application"
$PSQL -d "$DB" -v ON_ERROR_STOP=1 -c "
CREATE TABLE public.other_app_data (id serial PRIMARY KEY, tenant_id text, payload text);
INSERT INTO public.other_app_data (tenant_id, payload) VALUES ('tenant_aaa', 'foreign row');
CREATE SEQUENCE public.other_app_data_id_seq_2;
COMMENT ON TABLE public.other_app_data IS 'AmisERP-shaped table sharing the project.'"
echo "--- PRE-remediation reachability (the leak Phase 1 closes):"
$PSQL -d "$DB" -Atc "SET ROLE amisibiz_app; SELECT 'pre: other_app_data rows='||count(*) FROM public.other_app_data;" \
    || echo "pre: already unreachable"
$PSQL -d "$DB" -Atc "SET ROLE amisibiz_app; SELECT 'pre: sequence usage='||has_sequence_privilege('amisibiz_app','public.other_app_data_id_seq','USAGE');" \
    || echo "pre: sequence probe skipped"

echo "=== 4. legacy fixture (text ids, legacy role labels)"
$PSQL -d "$DB" -v ON_ERROR_STOP=1 -1 -f "$FIXTURE" >/dev/null

echo "=== 5. Phase 1 migrations (8..10)"
apply 20261018000000_uuid_identity_and_role_alignment
apply 20261018000001_rbac_catalog_support_access_and_status_history
apply 20261018000002_rls_enforcement_storage_and_grants

echo "=== 6. POST-remediation probes (must all be denied/invisible)"
$PSQL -d "$DB" -Atc "SET ROLE amisibiz_app; SELECT 'post: REACHABLE (FAIL) rows='||count(*) FROM public.other_app_data;" \
    || echo "post: other_app_data denied -> $( $PSQL -d "$DB" -Atc "SET ROLE amisibiz_app; SELECT 1 FROM public.other_app_data;" 2>&1 | tail -1 )"
$PSQL -d "$DB" -Atc "SET ROLE amisibiz_app; SELECT 'post: sequence usage='||has_sequence_privilege('amisibiz_app','public.other_app_data_id_seq','USAGE');"

echo "=== 7. structural battery (phase01-migration-checks.sql)"
$PSQL -d "$DB" -q -f "$SCRIPTS/phase01-migration-checks.sql" > "$LOGDIR/cleanroom_phase1_checks.log" 2>&1 \
    || echo "phase01 checks exited non-zero — inspect $LOGDIR/cleanroom_phase1_checks.log"
echo "--- PASS lines: $(grep -c 'PASS' "$LOGDIR/cleanroom_phase1_checks.log")"
grep -n 'FAIL' "$LOGDIR/cleanroom_phase1_checks.log" || echo "--- phase01 checks: no FAIL lines"

echo "=== 8. behaviour battery as amisibiz_app (rls-behavior-battery.sql)"
$PSQL -d "$DB" -q -f "$SCRIPTS/rls-behavior-battery.sql" > "$LOGDIR/cleanroom_rls_battery.log" 2>&1 \
    || echo "rls battery exited non-zero — inspect $LOGDIR/cleanroom_rls_battery.log"
echo "--- PASS lines: $(grep -c 'PASS' "$LOGDIR/cleanroom_rls_battery.log")"
grep -n 'FAIL' "$LOGDIR/cleanroom_rls_battery.log" || echo "--- rls battery: no FAIL lines"

echo "=== 9. ABORT probe: migration 11 must refuse a non-UUID planId"
$PSQL -d "$DB" -Atc "SELECT 'legacy text plan ids present='||count(*) FROM \"Tenant\" WHERE \"planId\"='starter';"
if $PSQL -d "$DB" -v ON_ERROR_STOP=1 -1 -f "$PHASE11/migration.sql" >/dev/null 2>"$LOGDIR/cleanroom_phase2_abort.txt"; then
    echo "ABORT probe: FAIL (migration applied over legacy text plan ids)"
    exit 1
else
    echo "ABORT probe: migration 11 stopped -> $(grep -m1 ERROR "$LOGDIR/cleanroom_phase2_abort.txt" || tail -1 "$LOGDIR/cleanroom_phase2_abort.txt")"
fi
echo "--- state after the aborted transaction (one transaction; nothing partial):"
$PSQL -d "$DB" -Atc "SELECT 'plan table exists='||count(*) FROM pg_tables WHERE tablename='Plan' AND schemaname='public';"
$PSQL -d "$DB" -Atc "SELECT 'planId still text='||count(*) FROM \"Tenant\" WHERE \"planId\"='starter';"
$PSQL -d "$DB" -Atc "SELECT 'permission catalog still='||count(*) FROM \"Permission\";"

echo "=== 10. operator resolves the legacy label, then migration 11 applies"
$PSQL -d "$DB" -v ON_ERROR_STOP=1 -c "UPDATE \"Tenant\" SET \"planId\" = NULL WHERE \"planId\" = 'starter';"
apply 20261019000000_phase02_provider_administration_plans_and_suspension_gates
$PSQL -d "$DB" -Atc "SELECT 'plans='||count(*) FROM \"Plan\";"
$PSQL -d "$DB" -Atc "SELECT 'permission catalog='||count(*) FROM \"Permission\";"
$PSQL -d "$DB" -Atc "SELECT 'role matrix='||count(*) FROM \"RolePermission\";"
$PSQL -d "$DB" -Atc "SELECT 'planId type='||data_type FROM information_schema.columns WHERE table_name='Tenant' AND column_name='planId';"

echo "=== 11. behaviour battery again — Phase 1 regression on top of migration 11"
$PSQL -d "$DB" -q -f "$SCRIPTS/rls-behavior-battery.sql" > "$LOGDIR/cleanroom_rls_battery_after11.log" 2>&1 \
    || echo "rls battery exited non-zero — inspect $LOGDIR/cleanroom_rls_battery_after11.log"
echo "--- PASS lines: $(grep -c 'PASS' "$LOGDIR/cleanroom_rls_battery_after11.log")"
grep -n 'FAIL' "$LOGDIR/cleanroom_rls_battery_after11.log" || echo "--- phase1 battery: no FAIL lines"

echo "=== 12. Phase 2 battery (phase02-migration-checks.sql)"
$PSQL -d "$DB" -q -f "$SCRIPTS/phase02-migration-checks.sql" > "$LOGDIR/cleanroom_phase2_battery.log" 2>&1 \
    || echo "phase2 battery exited non-zero — inspect $LOGDIR/cleanroom_phase2_battery.log"
echo "--- PASS lines: $(grep -c 'PASS' "$LOGDIR/cleanroom_phase2_battery.log")"
grep -n 'FAIL\|ERROR' "$LOGDIR/cleanroom_phase2_battery.log" || echo "--- phase2 battery: no FAIL/ERROR lines"

echo "=== 13. later migrations, in deploy order, when they exist"
# The committed chain ends at 11. Anything after it (today: the uncommitted
# `20261020000000_phase05_portal_linkage`) is applied only if the working tree
# carries it, so this script stays truthful about a fresh clone.
for m in $(ls -1 "$MIG" | grep '^2' | sort); do
    case $m in
        20261020000000* | 2026102*)
            case $m in
                20261018000000* | 20261018000001* | 20261018000002* | 20261019000000*) continue ;;
            esac
            apply "$m"
            ;;
    esac
done
$PSQL -d "$DB" -Atc "SELECT 'catalog after later migrations='||count(*) FROM \"Permission\";"
$PSQL -d "$DB" -q -f "$SCRIPTS/rls-behavior-battery.sql" > "$LOGDIR/cleanroom_rls_battery_after_latest.log" 2>&1 \
    || echo "rls battery exited non-zero — inspect $LOGDIR/cleanroom_rls_battery_after_latest.log"
echo "--- PASS lines after the latest migration: $(grep -c 'PASS' "$LOGDIR/cleanroom_rls_battery_after_latest.log")"
grep -n 'FAIL' "$LOGDIR/cleanroom_rls_battery_after_latest.log" || echo "--- battery after latest: no FAIL lines"

echo "=== chain complete: $DB"
echo "--- logs in $LOGDIR/cleanroom_*.log"
