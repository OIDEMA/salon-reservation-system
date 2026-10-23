#!/usr/bin/env node
/** Explicit migration controls; secrets and database row contents are never logged. */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(resolve(process.cwd(), "package.json"));
const { PrismaClient } = require("@prisma/client");
const modes = new Set(["inspect", "fence-source", "unfence-target", "probe-target", "analyze-target"]);
const addresses = { source: "10.90.0.3", target: "10.91.0.3" };
const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const identifier = (value) => `"${value.replaceAll('"', '""')}"`;
const failure = (code) => new Error(`MIGRATION_CONTROL_${code}`);
let phase = "configuration";
let connectionUrl;
let parsedUrl;
const clients = new Set();

function client() {
  const instance = new PrismaClient({ datasources: { db: { url: connectionUrl } }, log: [], errorFormat: "minimal" });
  clients.add(instance);
  return instance;
}

async function identity(db, expectedLocation) {
  const [value] = await db.$queryRawUnsafe(`SELECT current_database()::text AS database,
    current_user::text AS "databaseUser", host(inet_server_addr()) AS "serverAddress",
    pg_backend_pid() AS "backendPid", pg_is_in_recovery() AS "inRecovery",
    current_setting('default_transaction_read_only') AS "defaultTransactionReadOnly",
    current_setting('transaction_read_only') AS "transactionReadOnly",
    pg_has_role(current_user, (SELECT datdba FROM pg_database WHERE datname = current_database()), 'USAGE') AS "ownsDatabase"`);
  const fixture = process.env.DB_MIGRATION_CONTROL_TEST_MODE;
  if (fixture !== undefined) {
    // Test identities can only refer to a real loopback server and disposable
    // *_test database. A localhost proxy to Cloud SQL still fails serverAddress.
    if (!Object.hasOwn(addresses, fixture) || !loopback.has(parsedUrl.hostname) ||
        !loopback.has(value.serverAddress) || !value.database.endsWith("_test") || parsedUrl.pathname !== `/${value.database}`) {
      throw failure("INVALID_TEST_IDENTITY");
    }
    value.location = fixture;
  } else {
    if (value.database !== "reservation") throw failure("UNAPPROVED_DATABASE");
    value.location = Object.keys(addresses).find((location) => addresses[location] === value.serverAddress);
    if (!value.location) throw failure("UNAPPROVED_SERVER");
  }
  if (expectedLocation && value.location !== expectedLocation) throw failure("WRONG_MIGRATION_SIDE");
  if (value.inRecovery) throw failure("STANDBY_NOT_ALLOWED");
  return value;
}

async function persistentWriteProbe(db, expectRejected) {
  const probeId = `migration-probe-${randomUUID()}`;
  const rollback = new Error("EXPECTED_PROBE_ROLLBACK");
  let insertedAndRolledBack = false;
  let rejectedReadOnly = false;
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO public."Tenant" (id, slug, name, "updatedAt") VALUES ($1, $2, $3, now())`,
        probeId, probeId, "Migration rollback probe");
      const [inside] = await tx.$queryRawUnsafe(`SELECT count(*)::integer AS count FROM public."Tenant" WHERE id = $1`, probeId);
      if (inside.count !== 1) throw failure("PROBE_INSERT_NOT_VISIBLE");
      throw rollback;
    }, { maxWait: 10000, timeout: 30000 });
    throw failure("PROBE_UNEXPECTED_COMMIT");
  } catch (error) {
    if (error === rollback) insertedAndRolledBack = true;
    else if (error?.code === "P2010" && error?.meta?.code === "25006") rejectedReadOnly = true;
    else throw error;
  }
  const [outside] = await db.$queryRawUnsafe(`SELECT count(*)::integer AS count FROM public."Tenant" WHERE id = $1`, probeId);
  if (outside.count !== 0) throw failure("PROBE_ROW_PERSISTED");
  if (expectRejected ? !rejectedReadOnly : !insertedAndRolledBack) throw failure("UNEXPECTED_PROBE_RESULT");
  return { insertedAndRolledBack, rejectedReadOnly, persistedRows: 0 };
}

async function run() {
  const fileInvocation = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  const args = process.argv.slice(fileInvocation ? 2 : 1);
  const mode = args[0] ?? "inspect";
  if (args.length > 1 || !modes.has(mode)) throw failure("INVALID_MODE");
  if (!process.env.DATABASE_URL) throw failure("DATABASE_URL_REQUIRED");
  parsedUrl = new URL(process.env.DATABASE_URL);
  if (!["postgresql:", "postgres:"].includes(parsedUrl.protocol)) throw failure("INVALID_DATABASE_PROTOCOL");
  parsedUrl.searchParams.set("connection_limit", "1");
  connectionUrl = parsedUrl.toString();
  const db = client();
  phase = "identity-guard";
  const location = mode === "fence-source" ? "source" : ["unfence-target", "probe-target", "analyze-target"].includes(mode) ? "target" : undefined;
  const initial = await identity(db, location);
  if (mode === "inspect") return { mode, identity: initial };

  if (mode === "fence-source") {
    phase = "set-source-read-only";
    if (initial.defaultTransactionReadOnly !== "on") {
      await db.$executeRawUnsafe(`ALTER DATABASE ${identifier(initial.database)} SET default_transaction_read_only = on`);
    }
    phase = "terminate-prior-source-sessions";
    const terminated = await db.$queryRawUnsafe(`SELECT pg_terminate_backend(pid, 5000) AS terminated FROM pg_stat_activity
      WHERE datname = current_database() AND usename = current_user AND backend_type = 'client backend' AND pid <> pg_backend_pid()`);
    if (terminated.some((item) => item.terminated !== true)) throw failure("SESSION_TERMINATION_FAILED");
    await db.$disconnect(); clients.delete(db);
    phase = "fresh-source-read-only-check";
    const fresh = client();
    const verified = await identity(fresh, "source");
    if (verified.defaultTransactionReadOnly !== "on" || verified.transactionReadOnly !== "on") throw failure("SOURCE_STILL_WRITABLE");
    phase = "source-rejected-write-probe";
    const probe = await persistentWriteProbe(fresh, true);
    return { mode, identity: verified, terminatedSessions: terminated.length, probe };
  }
  if (mode === "unfence-target") {
    phase = "clear-target-session-read-only";
    await db.$executeRawUnsafe("SET default_transaction_read_only = off");
    phase = "clear-target-database-read-only";
    await db.$executeRawUnsafe(`ALTER DATABASE ${identifier(initial.database)} RESET default_transaction_read_only`);
    await db.$disconnect(); clients.delete(db);
    phase = "fresh-target-writable-check";
    const fresh = client();
    const verified = await identity(fresh, "target");
    if (verified.defaultTransactionReadOnly !== "off" || verified.transactionReadOnly !== "off") throw failure("TARGET_STILL_READ_ONLY");
    return { mode, identity: verified };
  }
  if (initial.defaultTransactionReadOnly !== "off" || initial.transactionReadOnly !== "off") throw failure("TARGET_STILL_READ_ONLY");
  if (mode === "analyze-target") {
    // Database ownership permits analysis of all non-shared tables. Without it,
    // PostgreSQL could merely warn and skip a table, making a count misleading.
    if (!initial.ownsDatabase) throw failure("DATABASE_OWNER_REQUIRED");
    phase = "target-analyze-inventory";
    const tables = await db.$queryRawUnsafe(`SELECT c.relname::text AS name FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'm') ORDER BY c.relname COLLATE "C"`);
    if (!tables.length) throw failure("TARGET_HAS_NO_TABLES");
    for (const [index, table] of tables.entries()) {
      phase = `target-analyze-table-${index}`;
      await db.$executeRawUnsafe(`ANALYZE public.${identifier(table.name)}`);
    }
    return { mode, identity: initial, analyzedTables: tables.length };
  }
  phase = "target-rolled-back-write-probe";
  const probe = await persistentWriteProbe(db, false);
  return { mode, identity: initial, probe };
}

try { console.log(JSON.stringify(await run())); }
catch (error) {
  const code = error instanceof Error && /^MIGRATION_CONTROL_[A-Z_]+$/.test(error.message) ? error.message : "MIGRATION_CONTROL_FAILED";
  const prismaCode = typeof error?.code === "string" && /^P\d{4}$/.test(error.code) ? error.code : undefined;
  const pgCode = typeof error?.meta?.code === "string" && /^[0-9A-Z]{5}$/.test(error.meta.code) ? error.meta.code : undefined;
  console.error(JSON.stringify({ error: code, phase, prismaCode, pgCode })); process.exitCode = 1;
} finally {
  await Promise.allSettled([...clients].map((db) => db.$disconnect()));
}
