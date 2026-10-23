#!/usr/bin/env node
/**
 * Read-only migration evidence. Run from the API image's /app directory, with
 * DATABASE_URL injected as a secret. No row values or connection strings leave
 * PostgreSQL: only counts, hashes, schema names, and allowlisted server metadata.
 *
 * Freeze every writer before comparing two outputs. Sequence state is not MVCC;
 * this script checks that it did not change during its snapshot, but cannot prove
 * that an independently running client will not write after the snapshot ends.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "package.json"));
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ log: [], errorFormat: "minimal" });
const identifier = (value) => `"${value.replaceAll('"', '""')}"`;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = (value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
let phase = "initialization";

async function fingerprint(tx, query) {
  // Hash values in PostgreSQL, so schema definitions/defaults cannot leak via
  // diagnostics or stdout. The sorted multiset retains duplicate rows.
  return tx.$queryRawUnsafe(`WITH row_hashes AS MATERIALIZED (
    SELECT encode(sha256(convert_to(row_to_json(source.*)::text, 'UTF8')), 'hex') AS digest
    FROM (${query}) source
  ) SELECT count(*)::text AS count,
    encode(sha256(convert_to(coalesce(string_agg(digest, '' ORDER BY digest COLLATE "C"), ''), 'UTF8')), 'hex') AS checksum
    FROM row_hashes`);
}

async function sequenceStates(tx, sequences) {
  const states = [];
  for (const sequence of sequences) {
    const [state] = await tx.$queryRawUnsafe(`SELECT last_value::text AS "lastValue", is_called AS "isCalled" FROM public.${identifier(sequence.name)}`);
    states.push({ name: sequence.name, ...state });
  }
  return states;
}

async function inspect() {
  phase = "configuration";
  if (!process.env.DATABASE_URL) throw new Error("INSPECTION_DATABASE_URL_REQUIRED");
  const minimumTables = Number(process.env.DB_INSPECTION_MIN_TABLES ?? 1);
  if (!Number.isInteger(minimumTables) || minimumTables < 1) throw new Error("INSPECTION_INVALID_MINIMUM_TABLES");
  return prisma.$transaction(async (tx) => {
    phase = "snapshot-settings";
    await tx.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
    await tx.$executeRawUnsafe("SET LOCAL bytea_output = 'hex'");
    await tx.$executeRawUnsafe("SET LOCAL extra_float_digits = 3");
    await tx.$executeRawUnsafe("SET LOCAL DateStyle = 'ISO, YMD'");
    await tx.$executeRawUnsafe("SET LOCAL IntervalStyle = 'iso_8601'");
    // Fail rather than silently fingerprint only the rows visible under RLS.
    await tx.$executeRawUnsafe("SET LOCAL row_security = off");
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10min'");
    phase = "database-identity";
    const [identity] = await tx.$queryRawUnsafe(`SELECT current_database()::text AS database,
      current_user::text AS "databaseUser", inet_server_addr()::text AS "serverAddress",
      current_setting('server_version') AS "serverVersion",
      pg_database_size(current_database())::text AS "databaseBytes",
      pg_is_in_recovery() AS "inRecovery",
      current_setting('default_transaction_read_only') AS "defaultTransactionReadOnly",
      current_setting('transaction_read_only') AS "inspectionTransactionReadOnly",
      current_setting('transaction_isolation') AS "inspectionIsolation",
      current_setting('server_encoding') AS encoding,
      (SELECT datcollate::text FROM pg_database WHERE datname = current_database()) AS collation,
      (SELECT datctype::text FROM pg_database WHERE datname = current_database()) AS ctype,
      (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl,
      CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn()::text ELSE pg_current_wal_flush_lsn()::text END AS "walPosition",
      pg_last_xact_replay_timestamp()::text AS "lastReplayTimestamp",
      transaction_timestamp()::text AS "snapshotAt"`);
    if (process.env.DB_INSPECTION_EXPECTED_DATABASE && identity.database !== process.env.DB_INSPECTION_EXPECTED_DATABASE) throw new Error("INSPECTION_UNEXPECTED_DATABASE");
    if (process.env.DB_INSPECTION_REQUIRE_PRIMARY === "1" && (identity.inRecovery || identity.defaultTransactionReadOnly !== "off")) throw new Error("INSPECTION_PRIMARY_NOT_WRITABLE");

    phase = "table-inventory";
    const tables = await tx.$queryRawUnsafe(`SELECT c.relname::text AS name, c.relkind::text AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname COLLATE "C"`);
    if (tables.length < minimumTables) throw new Error("INSPECTION_TOO_FEW_TABLES");
    phase = "sequence-inventory";
    const sequences = await tx.$queryRawUnsafe(`SELECT c.relname::text AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY c.relname COLLATE "C"`);
    phase = "sequence-start-state";
    const beforeSequences = await sequenceStates(tx, sequences);
    const tableEvidence = [];
    for (const table of tables) {
      phase = `table-fingerprint-${tableEvidence.length}`;
      // Only row hashes are sorted/aggregated; bytea, JSON, nulls, arrays, and
      // every other column participate in the original row hash. Buckets bound
      // aggregate memory for large tables while preserving multiplicity.
      const buckets = await tx.$queryRawUnsafe(`WITH row_hashes AS MATERIALIZED (
        SELECT encode(sha256(convert_to(row_to_json(source.*)::text, 'UTF8')), 'hex') AS digest
        FROM public.${identifier(table.name)} source
      ), buckets AS (SELECT left(digest, 2) AS bucket, count(*)::text AS count,
        encode(sha256(convert_to(string_agg(digest, '' ORDER BY digest COLLATE "C"), 'UTF8')), 'hex') AS checksum
        FROM row_hashes GROUP BY left(digest, 2))
        SELECT bucket, count, checksum FROM buckets ORDER BY bucket COLLATE "C"`);
      tableEvidence.push({ name: table.name, kind: table.kind,
        count: buckets.reduce((total, bucket) => total + BigInt(bucket.count), 0n).toString(),
        checksum: hash(buckets) });
    }
    const definitions = {
      columns: `SELECT c.relname, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) AS type,
        a.attnotnull, a.attidentity, a.attgenerated, a.attcollation::regcollation::text AS collation,
        pg_get_expr(d.adbin, d.adrelid) AS expression
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped`,
      constraints: `SELECT c.relname, k.conname, k.contype, k.convalidated, k.condeferrable, k.condeferred,
        pg_get_constraintdef(k.oid, false) AS definition
        FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`,
      indexes: `SELECT t.relname AS table_name, c.relname, i.indisunique, i.indisprimary, i.indisvalid, i.indisready,
        pg_get_indexdef(i.indexrelid) AS definition
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public'`,
      enums: `SELECT t.typname, e.enumsortorder::text, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public'`,
      sequences: `SELECT c.relname, format_type(s.seqtypid, -1) AS type, s.seqstart::text, s.seqincrement::text,
        s.seqmax::text, s.seqmin::text, s.seqcache::text, s.seqcycle
        FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`,
      views: `SELECT c.relname, c.relkind, pg_get_viewdef(c.oid, false) AS definition FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')`,
      triggers: `SELECT c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid, false) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
      functions: `SELECT p.proname, p.prokind, pg_get_function_identity_arguments(p.oid) AS arguments,
        pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')`,
      policies: `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, p.polname, p.polcmd,
        p.polpermissive, p.polroles::text, pg_get_expr(p.polqual, p.polrelid) AS qualifier,
        pg_get_expr(p.polwithcheck, p.polrelid) AS check_expression
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_policy p ON p.polrelid = c.oid
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
    };
    const schema = {};
    for (const [name, query] of Object.entries(definitions)) {
      phase = `schema-${name}`;
      schema[name] = (await fingerprint(tx, query))[0];
    }
    phase = "schema-integrity";
    const [integrity] = await tx.$queryRawUnsafe(`SELECT
      (SELECT count(*)::integer FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT k.convalidated) AS "unvalidatedConstraints",
      (SELECT count(*)::integer FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND (NOT i.indisvalid OR NOT i.indisready)) AS "invalidIndexes"`);
    phase = "sequence-end-state";
    const afterSequences = await sequenceStates(tx, sequences);
    if (json(beforeSequences) !== json(afterSequences)) throw new Error("INSPECTION_SEQUENCE_CHANGED_DURING_SNAPSHOT");
    phase = "complete";
    return { formatVersion: 1, algorithm: "sha256-row-json-sorted-256-buckets-v1", identity,
      tableCount: tableEvidence.length, tables: tableEvidence, dataChecksum: hash(tableEvidence),
      schema, schemaChecksum: hash(schema), integrity, sequences: afterSequences,
      sequenceChecksum: hash(afterSequences), sequencesStableDuringSnapshot: true };
  }, { maxWait: 10000, timeout: 15 * 60 * 1000 });
}

try { console.log(json(await inspect())); }
catch (error) {
  // Prisma errors can embed row data, SQL arguments, or connection details.
  const code = error instanceof Error && /^INSPECTION_[A-Z_]+$/.test(error.message) ? error.message : "INSPECTION_FAILED";
  const prismaCode = typeof error?.code === "string" && /^P\d{4}$/.test(error.code) ? error.code : undefined;
  const pgCode = typeof error?.meta?.code === "string" && /^[0-9A-Z]{5}$/.test(error.meta.code) ? error.meta.code : undefined;
  console.error(JSON.stringify({ error: code, phase, prismaCode, pgCode })); process.exitCode = 1;
} finally { await prisma.$disconnect(); }
