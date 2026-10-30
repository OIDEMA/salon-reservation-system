import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { ensureMembershipSequence, ensureMembershipInvariants, ensureTenantMembershipProgramUniqueness } from "../membership-invariants.js";

const maximumAttempts = 8;
const retryDelayMs = 15_000;
const referenceColumns = ["tenantId", "salonId", "id"];

function identifier(value: string) { return `"${value.replaceAll('"', '""')}"`; }

/**
 * Prisma flags any unique addition to a populated table, including this redundant
 * key containing the existing globally unique id. Create only that reviewed index
 * after verifying its uniqueness is already guaranteed. All other schema warnings
 * still stop db push; no accept-data-loss option is used.
 */
export async function ensureScopedReferenceIndex(prisma: PrismaClient, tableName: "Reservation" | "HistoricalReservation"): Promise<"created" | "already_present" | "table_absent"> {
  const referenceIndex = `${tableName}_tenantId_salonId_id_key`;
  return prisma.$transaction(async (tx) => {
    const tables = await tx.$queryRaw<Array<{ tableId: string; schemaName: string; kind: string }>>`
      SELECT c.oid::text AS "tableId", n.nspname AS "schemaName", c.relkind::text AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = ${tableName}`;
    if (!tables.length) return "table_absent";
    const table = tables[0];
    if (table.kind !== "r") throw new Error(`${tableName} must be an ordinary table before preparing its reference index.`);
    // Keep concurrent schema changes/writes out while verifying and creating the index.
    await tx.$executeRawUnsafe(`LOCK TABLE ${identifier(table.schemaName)}.${identifier(tableName)} IN SHARE ROW EXCLUSIVE MODE`);
    const columns = await tx.$queryRaw<Array<{ name: string; notNull: boolean }>>`
      SELECT attname::text AS name, attnotnull AS "notNull" FROM pg_attribute
      WHERE attrelid = ${table.tableId}::oid AND attnum > 0 AND NOT attisdropped
        AND attname IN ('tenantId', 'salonId', 'id')`;
    const primaryKeys = await tx.$queryRaw<Array<{ guaranteedUnique: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
        WHERE i.indrelid = ${table.tableId}::oid AND i.indisprimary AND i.indisunique AND i.indisvalid
          AND i.indnkeyatts = 1 AND a.attname = 'id'
      ) AS "guaranteedUnique"`;
    if (columns.length !== 3 || columns.some((column) => !column.notNull) || !primaryKeys[0]?.guaranteedUnique) {
      throw new Error(`${tableName} reference index requires non-null tenantId/salonId/id and an existing single-column id primary key.`);
    }
    // The id primary key proves every existing triple is unique; no data rewrite or
    // deduplication is permitted. An unexpected same-name index fails closed.
    const existing = await tx.$queryRaw<Array<{
      tableId: string | null; unique: boolean | null; valid: boolean | null; ready: boolean | null;
      unconditional: boolean | null; plain: boolean | null; keyCount: number | null; totalCount: number | null;
      method: string | null; columns: string[];
    }>>`
      SELECT i.indrelid::text AS "tableId", i.indisunique AS unique, i.indisvalid AS valid, i.indisready AS ready,
        (i.indpred IS NULL) AS unconditional, (i.indexprs IS NULL) AS plain,
        i.indnkeyatts::integer AS "keyCount", i.indnatts::integer AS "totalCount", am.amname AS method,
        ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, position)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.position) AS columns
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_index i ON i.indexrelid = c.oid LEFT JOIN pg_am am ON am.oid = c.relam
      WHERE n.nspname = ${table.schemaName} AND c.relname = ${referenceIndex}`;
    if (existing.length) {
      const index = existing[0];
      if (index.tableId !== table.tableId || !index.unique || !index.valid || !index.ready || !index.unconditional || !index.plain ||
        index.keyCount !== 3 || index.totalCount !== 3 || index.method !== "btree" ||
        index.columns.join(",") !== referenceColumns.join(",")) {
        throw new Error(`The existing ${tableName} reference index differs from the reviewed definition.`);
      }
      return "already_present";
    }
    await tx.$executeRawUnsafe(`CREATE UNIQUE INDEX ${identifier(referenceIndex)} ON ${identifier(table.schemaName)}.${identifier(tableName)} ("tenantId", "salonId", "id")`);
    return "created";
  }, { maxWait: 5000, timeout: 60000 });
}

export async function ensureReservationReferenceIndex(prisma: PrismaClient) {
  return ensureScopedReferenceIndex(prisma, "Reservation");
}

function runPrismaPush() {
  return new Promise<number>((resolve, reject) => {
    const child = spawn("npx", ["--no-install", "prisma", "db", "push"], { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const prisma = new PrismaClient();
  try {
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      let exitCode = 1;
      try {
        await ensureMembershipSequence(prisma);
        await ensureTenantMembershipProgramUniqueness(prisma);
        for (const tableName of ["Reservation", "HistoricalReservation"] as const) {
          const prepared = await ensureScopedReferenceIndex(prisma, tableName);
          console.log(`${tableName} reference index: ${prepared}.`);
        }
        exitCode = await runPrismaPush();
        if (exitCode === 0) await ensureMembershipInvariants(prisma);
      } catch {
        exitCode = 1;
        // Prisma/SQL diagnostics can include connection details or row values.
        console.error("Schema preparation failed; check database connectivity and the scoped primary key/index definitions.");
      }
      if (exitCode === 0 || attempt === maximumAttempts) { process.exitCode = exitCode; return; }
      console.error(`Schema deployment attempt ${attempt}/${maximumAttempts} failed; retrying in ${retryDelayMs / 1000}s.`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  } finally { await prisma.$disconnect(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
