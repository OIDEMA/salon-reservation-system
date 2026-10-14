import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";

export const CUSTOMER_LOOKUP_LIMIT = 20;

export const customerLookupQuerySchema = z.object({
  q: z.string().trim().max(100, "検索語は100文字以内で入力してください。")
    .refine((value) => !value.includes("\0"), "検索語を確認してください。")
    .optional().default("")
});

export type CustomerLookupRow = { id: string; name: string; kana: string; phone: string | null };
export type CustomerLookupInput = { textPatterns: string[]; phonePattern: string | null };

export function normalizedCustomerPhone(value: string): string | null {
  const normalized = value.normalize("NFKC").trim();
  const digits = normalized.replace(/[^0-9]/g, "");
  return /^[0-9+\-()\s.ー−‐‑–—]+$/.test(normalized) && digits.length >= 2 ? digits : null;
}

/** Escape LIKE metacharacters so a search always means literal partial matching. */
function containsPattern(value: string) {
  return `%${value.replace(/[!%_]/g, (character) => `!${character}`)}%`;
}

export function prepareCustomerLookup(value: string): CustomerLookupInput | null {
  const normalized = value.normalize("NFKC").trim();
  const text = normalized.replace(/\s/g, "");
  if (!text) return null;
  const katakana = text.replace(/[\u3041-\u3096]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 0x60));
  const hiragana = text.replace(/[\u30a1-\u30f6]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60));
  const digits = normalizedCustomerPhone(normalized);
  return {
    textPatterns: [...new Set([text, katakana, hiragana])].map(containsPattern),
    phonePattern: digits === null ? null : containsPattern(digits)
  };
}

/** Exact normalized-phone equality is separate from autocomplete partial matching. */
export async function registeredCustomerPhoneExists(database: Pick<PrismaClient, "$queryRaw">, tenantId: string, salonId: string, phone: string) {
  const digits = normalizedCustomerPhone(phone);
  if (digits === null) return false;
  const rows = await database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Customer"
    WHERE "tenantId" = ${tenantId} AND "salonId" = ${salonId}
      AND regexp_replace(normalize(coalesce("phone", ''), NFKC), '[^0-9]', '', 'g') = ${digits}
    LIMIT 1
  `);
  return rows.length > 0;
}

export async function lookupCustomers(database: Pick<PrismaClient, "$queryRaw">, tenantId: string, salonId: string, query: string) {
  const input = prepareCustomerLookup(query);
  if (!input) return { customers: [] as CustomerLookupRow[], hasMore: false };
  const textMatches = input.textPatterns.map((pattern) => Prisma.sql`
    regexp_replace(normalize("name", NFKC), '[[:space:]]', '', 'g') ILIKE ${pattern} ESCAPE '!'
    OR regexp_replace(normalize("kana", NFKC), '[[:space:]]', '', 'g') ILIKE ${pattern} ESCAPE '!'
  `);
  const phoneMatch = input.phonePattern === null ? Prisma.sql`FALSE` : Prisma.sql`
    regexp_replace(normalize(coalesce("phone", ''), NFKC), '[^0-9]', '', 'g') LIKE ${input.phonePattern} ESCAPE '!'
  `;
  // PostgreSQL 16's NFKC normalization matches stored half-width kana and digits.
  // Every value is a bound parameter, including scope, LIKE patterns and limit.
  const rows = await database.$queryRaw<CustomerLookupRow[]>(Prisma.sql`
    SELECT "id", "name", "kana", "phone"
    FROM "Customer"
    WHERE "tenantId" = ${tenantId} AND "salonId" = ${salonId}
      AND (${Prisma.join(textMatches, " OR ")} OR ${phoneMatch})
    ORDER BY "lastVisitAt" DESC NULLS LAST, "kana" ASC, "id" ASC
    LIMIT ${CUSTOMER_LOOKUP_LIMIT + 1}
  `);
  return { customers: rows.slice(0, CUSTOMER_LOOKUP_LIMIT), hasMore: rows.length > CUSTOMER_LOOKUP_LIMIT };
}
