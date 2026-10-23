#!/usr/bin/env bash
set -euo pipefail

# This runner always creates its own empty PostgreSQL container. It accepts no
# external database URL and exposes no host port. Tests keep their localhost /
# *_test safety guards by sharing only the PostgreSQL network namespace.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
run_suffix="${BUILD_ID:-local-$$}"
postgres_container="reservation-pg16-test-${run_suffix}"
test_image="reservation-db-integration:${run_suffix}"
cleanup() {
  docker rm --force "$postgres_container" >/dev/null 2>&1 || true
  docker image rm "$test_image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker pull postgres:16-bookworm
docker image inspect postgres:16-bookworm --format '{{json .RepoDigests}}'
docker run --detach --name "$postgres_container" \
  --env POSTGRES_USER=reservation_test \
  --env POSTGRES_PASSWORD=disposable-integration-only \
  --env POSTGRES_DB=reservation_test \
  postgres:16-bookworm -c jit=off >/dev/null
# Production Cloud SQL reports pg_jit_available() = false. The official Docker
# image includes LLVM, so disable JIT to match the production execution mode.
for attempt in $(seq 1 60); do
  # The image starts a temporary Unix-socket-only server during initialization.
  # Wait for TCP so a ready check cannot race that temporary server's shutdown.
  if docker exec "$postgres_container" pg_isready --host=127.0.0.1 --username=reservation_test --dbname=reservation_test >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 60 ]]; then echo "Disposable PostgreSQL did not become ready." >&2; exit 1; fi
  sleep 1
done
docker exec "$postgres_container" psql --host=127.0.0.1 --username=reservation_test --dbname=reservation_test --no-align --tuples-only \
  --command="SELECT version(), current_setting('jit') AS jit;"

# Reuse the production image construction, adding only tests to this disposable
# local image. No registry push and no production credentials are involved.
{ cat apps/api/Dockerfile; printf '\nCOPY tests ./tests\n'; } | docker build --pull --file=- --tag "$test_image" apps/api
test_database_url='postgresql://reservation_test:disposable-integration-only@127.0.0.1:5432/reservation_test?schema=public'
docker run --rm --network="container:$postgres_container" \
  --mount "type=bind,source=$repo_root/scripts/db-migration-inspect.mjs,target=/app/db-migration-inspect.mjs,readonly" \
  --mount "type=bind,source=$repo_root/scripts/db-migration-control.mjs,target=/app/db-migration-control.mjs,readonly" \
  --env "DATABASE_URL=$test_database_url" \
  --env "OPERATIONS_TEST_DATABASE_URL=$test_database_url" \
  --env "CUSTOMER_IMPORT_TEST_DATABASE_URL=$test_database_url" \
  --env "STAFF_IMPORT_TEST_DATABASE_URL=$test_database_url" \
  --env "HISTORY_IMPORT_TEST_DATABASE_URL=$test_database_url" \
  --env "HISTORY_STAFF_LINK_TEST_DATABASE_URL=$test_database_url" \
  --env "HISTORY_SCHEDULE_TEST_DATABASE_URL=$test_database_url" \
  --env "DASHBOARD_HISTORY_TEST_DATABASE_URL=$test_database_url" \
  --env API_DISABLE_LISTEN=1 \
  --env GOOGLE_CLOUD_PROJECT=salon-reserve-bg \
  --env DB_INSPECTION_EXPECTED_DATABASE=reservation_test \
  --env DB_INSPECTION_REQUIRE_PRIMARY=1 \
  --env DB_INSPECTION_MIN_TABLES=33 \
  "$test_image" bash -euc '
    npm run prisma:deploy
    # Import suites use the same historical tenant slug and assert global table
    # counts. Files must run serially; concurrency within each suite is retained.
    integration_status=0
    node --import tsx --test --test-concurrency=1 src/chart-routes.integration.test.ts tests/*.integration.test.ts || integration_status=$?
    node db-migration-inspect.mjs
    node --input-type=module <<'"'"'NODE'"'"'
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const inspect = () => JSON.parse(execFileSync(process.execPath, ["db-migration-inspect.mjs"], { encoding: "utf8" }));
try {
  // A column named source must not shadow the record alias in row_to_json.
  await db.$executeRawUnsafe(`CREATE TABLE public."MigrationFingerprintFixture" (id serial PRIMARY KEY, source text NOT NULL, text_value text, binary_value bytea, json_value jsonb)`);
  await db.$executeRawUnsafe(`INSERT INTO public."MigrationFingerprintFixture" (source, text_value, binary_value, json_value) VALUES ($1, $2, decode($3, $$hex$$), $4::jsonb)`, "synthetic-source", "synthetic-test-only", "001122ff", JSON.stringify({ sample: true }));
  const first = inspect();
  const repeat = inspect();
  assert.equal(first.dataChecksum, repeat.dataChecksum);
  assert.equal(first.schemaChecksum, repeat.schemaChecksum);
  assert.equal(first.sequenceChecksum, repeat.sequenceChecksum);
  assert.equal(first.identity.inspectionTransactionReadOnly, "on");
  assert.equal(first.identity.inspectionIsolation, "repeatable read");
  await db.$executeRawUnsafe(`UPDATE public."MigrationFingerprintFixture" SET binary_value = decode($1, $$hex$$)`, "001122fe");
  const changed = inspect();
  assert.notEqual(first.dataChecksum, changed.dataChecksum);
  assert.equal(first.schemaChecksum, changed.schemaChecksum);
  assert.equal(first.tables.find(t => t.name === "MigrationFingerprintFixture").count, changed.tables.find(t => t.name === "MigrationFingerprintFixture").count);
  await db.$executeRawUnsafe(`UPDATE public."MigrationFingerprintFixture" SET binary_value = decode($1, $$hex$$)`, "001122ff");
  assert.equal(first.dataChecksum, inspect().dataChecksum);
  await db.$executeRawUnsafe(`ALTER SEQUENCE public."MigrationFingerprintFixture_id_seq" RESTART WITH 42`);
  assert.notEqual(first.sequenceChecksum, inspect().sequenceChecksum);
  console.log("Migration inspector passed: source-column handling, stable full snapshots, bytea-only change detection, unchanged counts, and sequence-state changes.");
} finally {
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS public."MigrationFingerprintFixture"`);
  await db.$disconnect();
}
NODE
    node --input-type=module <<'"'"'NODE_CONTROL'"'"'
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
const inspect = () => JSON.parse(execFileSync(process.execPath, ["db-migration-inspect.mjs"], { encoding: "utf8" }));
const control = (mode, fixture) => {
  const env = { ...process.env };
  if (fixture === undefined) delete env.DB_MIGRATION_CONTROL_TEST_MODE;
  else env.DB_MIGRATION_CONTROL_TEST_MODE = fixture;
  const result = spawnSync(process.execPath, ["db-migration-control.mjs", mode], { encoding: "utf8", env });
  return { status: result.status, output: JSON.parse(result.status === 0 ? result.stdout : result.stderr) };
};
const successful = (mode, fixture) => {
  const result = control(mode, fixture);
  assert.equal(result.status, 0, JSON.stringify(result.output));
  return result.output;
};
const baseline = inspect();
for (const mode of ["inspect", "fence-source", "unfence-target", "probe-target", "analyze-target"]) {
  const denied = control(mode);
  assert.equal(denied.status, 1);
  assert.equal(denied.output.error, "MIGRATION_CONTROL_UNAPPROVED_DATABASE");
}
assert.equal(control("fence-source", "target").output.error, "MIGRATION_CONTROL_WRONG_MIGRATION_SIDE");
assert.equal(control("unfence-target", "source").output.error, "MIGRATION_CONTROL_WRONG_MIGRATION_SIDE");
assert.equal(control("probe-target", "source").output.error, "MIGRATION_CONTROL_WRONG_MIGRATION_SIDE");
assert.equal(control("analyze-target", "source").output.error, "MIGRATION_CONTROL_WRONG_MIGRATION_SIDE");
assert.equal(control("fence-source", "invalid").output.error, "MIGRATION_CONTROL_INVALID_TEST_IDENTITY");
const old = new PrismaClient();
let fenced = false;
try {
  const [before] = await old.$queryRawUnsafe("SELECT pg_backend_pid() AS pid");
  const fence = successful("fence-source", "source"); fenced = true;
  assert.equal(fence.identity.defaultTransactionReadOnly, "on");
  assert.equal(fence.identity.transactionReadOnly, "on");
  assert.equal(fence.probe.rejectedReadOnly, true);
  assert.equal(fence.probe.persistedRows, 0);
  assert(fence.terminatedSessions >= 1);
  await old.$disconnect();
  const fresh = new PrismaClient();
  try {
    const [remaining] = await fresh.$queryRawUnsafe("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE pid = $1", before.pid);
    assert.equal(remaining.count, 0);
    const [state] = await fresh.$queryRawUnsafe("SELECT current_setting($1) AS state", "default_transaction_read_only");
    assert.equal(state.state, "on");
  } finally { await fresh.$disconnect(); }
  assert.equal(control("probe-target", "target").output.error, "MIGRATION_CONTROL_TARGET_STILL_READ_ONLY");
  assert.equal(control("analyze-target", "target").output.error, "MIGRATION_CONTROL_TARGET_STILL_READ_ONLY");
  const repeated = successful("fence-source", "source");
  assert.equal(repeated.probe.rejectedReadOnly, true);
  assert.equal(successful("unfence-target", "target").identity.defaultTransactionReadOnly, "off"); fenced = false;
  const probe = successful("probe-target", "target");
  assert.equal(probe.probe.insertedAndRolledBack, true);
  assert.equal(probe.probe.persistedRows, 0);
  assert.equal(successful("analyze-target", "target").analyzedTables, baseline.tableCount);
  const after = inspect();
  assert.equal(after.dataChecksum, baseline.dataChecksum);
  assert.equal(after.schemaChecksum, baseline.schemaChecksum);
  assert.equal(after.sequenceChecksum, baseline.sequenceChecksum);
  console.log("Migration controls passed: production and side guards, old-session termination, fresh read-only rejection, idempotent fencing, target unfencing, rollback-only write, target statistics refresh, and unchanged full fingerprints.");
} finally {
  await old.$disconnect();
  if (fenced) successful("unfence-target", "target");
}
NODE_CONTROL
    exit "$integration_status"
  '
