import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "./database.js";
import { requireOperationContext } from "./operations-support.js";

export const masterResources = ["staff", "menus", "categories", "equipment"] as const;
export type MasterResource = typeof masterResources[number];
export const masterPageQuerySchema = z.object({
  q: z.string().trim().max(100).refine((value) => !value.includes("\0")).default(""),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  type: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50)
}).strict();
export type MasterPageQuery = z.infer<typeof masterPageQuerySchema>;

const configurations = {
  staff: { table: "Staff", search: ["name", "kana", "role"], status: "active", type: "role",
    columns: ["id", "name", "kana", "role", "nominationFee", "allocationOrder", "parallelCapacity", "active", "sortOrder"] },
  menus: { table: "Service", search: ["name", "category", "menuType"], status: "active", type: "category",
    columns: ["id", "name", "category", "durationMinutes", "price", "color", "active", "sortOrder"] },
  categories: { table: "MenuCategory", search: ["name", "type", "description"], status: "enabled", type: "type",
    columns: ["id", "name", "type", "description", "enabled", "sortOrder"] },
  equipment: { table: "Equipment", search: ["name", "memo"], status: "active", type: null,
    columns: ["id", "name", "capacity", "allocationOrder", "color", "memo", "active", "sortOrder"] }
} as const;
const katakana = Array.from({ length: 0x30f6 - 0x30a1 + 1 }, (_, index) => String.fromCharCode(0x30a1 + index)).join("");
const hiragana = [...katakana].map((character) => String.fromCharCode(character.charCodeAt(0) - 0x60)).join("");

/** Match literal terms with the former UI's kana/width normalization, in SQL. */
export function masterSearchPatterns(value: string): string[] {
  const normalized = value.normalize("NFKC").toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60));
  return normalized.trim().split(/\s+/).filter(Boolean)
    .map((term) => `%${term.replace(/[!%_]/g, (character) => `!${character}`)}%`);
}

// Identifiers come exclusively from the fixed configurations above. All user
// values, including LIKE patterns, offsets and limits, are bound parameters.
const identifier = (value: string) => Prisma.raw(`"${value}"`);
export async function masterPage(database: PrismaClient, resource: MasterResource,
  scope: { tenantId: string; salonId: string }, query: MasterPageQuery) {
  const config = configurations[resource];
  const clauses = [Prisma.sql`"tenantId" = ${scope.tenantId}`, Prisma.sql`"salonId" = ${scope.salonId}`];
  if (query.status) clauses.push(Prisma.sql`${identifier(config.status)} = ${query.status === "ACTIVE"}`);
  if (query.type && config.type) clauses.push(Prisma.sql`${identifier(config.type)}::text = ${query.type}`);
  for (const pattern of masterSearchPatterns(query.q)) {
    clauses.push(Prisma.sql`(${Prisma.join(config.search.map((column) => Prisma.sql`
      translate(lower(normalize(coalesce(${identifier(column)}::text, ''), NFKC)), ${katakana}, ${hiragana})
        LIKE ${pattern} ESCAPE '!'
    `), " OR ")})`);
  }
  const where = Prisma.join(clauses, " AND ");
  return database.$transaction(async (tx) => {
    const counts = await tx.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
      SELECT count(*) AS total FROM ${identifier(config.table)} WHERE ${where}
    `);
    const total = Number(counts[0].total);
    const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
    const page = Math.min(query.page, totalPages);
    const items = await tx.$queryRaw<Array<{ id: string } & Record<string, unknown>>>(Prisma.sql`
      SELECT ${Prisma.join(config.columns.map(identifier))} FROM ${identifier(config.table)}
      WHERE ${where} ORDER BY "sortOrder" ASC, "createdAt" ASC, "id" ASC
      LIMIT ${query.pageSize} OFFSET ${(page - 1) * query.pageSize}
    `);
    return { items, total, page, pageSize: query.pageSize, totalPages };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export function registerMasterPageRoutes(server: FastifyInstance) {
  for (const resource of masterResources) {
    server.get(`/api/admin/${resource}/page`, async (request, reply) => {
      const context = await requireOperationContext(request, reply, "master.read");
      if (!context) return;
      const query = masterPageQuerySchema.parse(request.query);
      if (resource === "equipment" && query.type) {
        return reply.code(400).send({ code: "INVALID_INPUT", message: "設備には種別の絞り込みを指定できません。" });
      }
      const result = await masterPage(prisma, resource,
        { tenantId: context.tenant.id, salonId: context.salon.id }, query);
      return reply.header("Cache-Control", "private, no-store").send(result);
    });
  }
}
