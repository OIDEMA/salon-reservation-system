import type { PrismaClient } from "@prisma/client";

/** Create once; never reset or recycle member numbers during schema deployment. */
export async function ensureMembershipSequence(prisma: PrismaClient) {
  await prisma.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "MembershipMemberNumberSeq"
    AS bigint INCREMENT BY 1 MINVALUE 1000000000001 MAXVALUE 9999999999999
    START WITH 1000000000001 CACHE 1 NO CYCLE`);
  const rows = await prisma.$queryRaw<Array<{ increment: bigint; minimum: bigint; maximum: bigint; cycle: boolean }>>`
    SELECT seqincrement AS increment, seqmin AS minimum, seqmax AS maximum, seqcycle AS cycle
    FROM pg_sequence WHERE seqrelid = '"MembershipMemberNumberSeq"'::regclass`;
  if (rows.length !== 1 || rows[0].increment !== 1n || rows[0].minimum !== 1000000000001n ||
    rows[0].maximum !== 9999999999999n || rows[0].cycle) {
    throw new Error("The membership numbering sequence differs from the reviewed definition.");
  }
}

/** Prepare the reviewed nullable one-tenant/one-program key without accepting
 * Prisma's general data-loss flag. Existing shared bindings need manual review. */
export async function ensureTenantMembershipProgramUniqueness(prisma: PrismaClient) {
  return prisma.$transaction(async (tx) => {
    const tables = await tx.$queryRaw<Array<{ present: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_schema=current_schema() AND table_name='Tenant' AND table_type='BASE TABLE') AS present`;
    if (!tables[0]?.present) return;
    await tx.$executeRawUnsafe('LOCK TABLE "Tenant" IN SHARE ROW EXCLUSIVE MODE');
    const columns = await tx.$queryRaw<Array<{ present: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='Tenant' AND column_name='membershipProgramId') AS present`;
    // On an existing populated Tenant table, Prisma warns even though this new
    // nullable column contains only NULL. Prepare precisely this additive column
    // and its reviewed index; never bypass warnings for other schema changes.
    if (!columns[0]?.present) await tx.$executeRawUnsafe('ALTER TABLE "Tenant" ADD COLUMN "membershipProgramId" TEXT');
    const duplicates = await tx.$queryRaw<Array<{ duplicate: boolean }>>`
      SELECT true AS duplicate FROM "Tenant" WHERE "membershipProgramId" IS NOT NULL
      GROUP BY "membershipProgramId" HAVING count(*) > 1 LIMIT 1`;
    if (duplicates.length) throw new Error("Membership programs must belong to exactly one tenant; review existing shared bindings before deployment.");
    await tx.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "Tenant_membershipProgramId_key" ON "Tenant" ("membershipProgramId")');
    const indexes = await tx.$queryRaw<Array<{ valid: boolean }>>`
      SELECT i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
        AND i.indnkeyatts=1 AND i.indnatts=1 AND am.amname='btree'
        AND i.indrelid='"Tenant"'::regclass AND a.attname='membershipProgramId' AS valid
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_index i ON i.indexrelid=c.oid JOIN pg_am am ON am.oid=c.relam
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
      WHERE n.nspname=current_schema() AND c.relname='Tenant_membershipProgramId_key'`;
    if (indexes.length !== 1 || !indexes[0].valid) throw new Error("The tenant membership-program index differs from the reviewed unique definition.");
  }, { maxWait: 5000, timeout: 60000 });
}

/** Install after db push. No production rows, balances or historical awards are rewritten. */
export async function ensureMembershipInvariants(prisma: PrismaClient) {
  await ensureMembershipSequence(prisma);
  await ensureTenantMembershipProgramUniqueness(prisma);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "MembershipAccount_guard"() RETURNS trigger
      LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$ BEGIN
        IF TG_OP = 'INSERT' THEN
          -- Serialize first enrollment with tenant detach/reassignment even for
          -- trusted direct ORM callers using READ COMMITTED transactions.
          PERFORM t.id FROM "Tenant" t WHERE t."membershipProgramId"=NEW."programId" FOR SHARE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Membership program must have an owning tenant' USING ERRCODE = '23514';
          END IF;
          NEW."memberNumber" := nextval('"MembershipMemberNumberSeq"'::regclass)::text;
        ELSIF NEW.id IS DISTINCT FROM OLD.id OR NEW."memberNumber" IS DISTINCT FROM OLD."memberNumber"
          OR NEW."programId" IS DISTINCT FROM OLD."programId" OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
          OR NEW.uid IS DISTINCT FROM OLD.uid THEN
          RAISE EXCEPTION 'Membership identity is immutable' USING ERRCODE = '42501';
        END IF;
        IF NEW."memberNumber" !~ '^[0-9]{13}$' THEN
          RAISE EXCEPTION 'Invalid membership number' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$`);
    await tx.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "MembershipAccount_identity_guard"
      BEFORE INSERT OR UPDATE ON "MembershipAccount" FOR EACH ROW EXECUTE FUNCTION "MembershipAccount_guard"()`);
    await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "MembershipPointEntry_immutable_guard"() RETURNS trigger
      LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$ BEGIN
        RAISE EXCEPTION 'Membership history is append-only' USING ERRCODE = '42501';
      END $$`);
    await tx.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "MembershipPointEntry_immutable"
      BEFORE UPDATE OR DELETE ON "MembershipPointEntry" FOR EACH ROW EXECUTE FUNCTION "MembershipPointEntry_immutable_guard"()`);
    await tx.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "MembershipPointEntry_no_truncate"
      BEFORE TRUNCATE ON "MembershipPointEntry" FOR EACH STATEMENT EXECUTE FUNCTION "MembershipPointEntry_immutable_guard"()`);
    await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "MembershipPointEntry_insert_guard"() RETURNS trigger
      LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$ DECLARE original "MembershipPointEntry"%ROWTYPE; BEGIN
        IF NEW.delta = 0 OR (NEW.kind IN ('EARN','REFUND') AND NEW.delta < 0)
          OR (NEW.kind IN ('REDEEM','EARN_REVERSAL') AND NEW.delta > 0)
          OR (NEW.kind = 'REDEEM' AND mod(-NEW.delta,100) <> 0) THEN
          RAISE EXCEPTION 'Invalid membership entry' USING ERRCODE = '23514';
        END IF;
        IF NEW."checkoutId" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM "CashCheckout" c WHERE c.id=NEW."checkoutId" AND c."tenantId"=NEW."tenantId"
            AND c."salonId"=NEW."salonId" AND c."membershipAccountId"=NEW."accountId"
        ) THEN RAISE EXCEPTION 'Membership checkout mismatch' USING ERRCODE = '23514'; END IF;
        IF NEW.kind IN ('REFUND','EARN_REVERSAL') THEN
          SELECT * INTO original FROM "MembershipPointEntry" p WHERE p.id=NEW."reversalOfId"
            AND p."programId"=NEW."programId" AND p."accountId"=NEW."accountId";
          IF NOT FOUND OR original."tenantId" <> NEW."tenantId" OR original."salonId" <> NEW."salonId"
            OR original."checkoutId" IS DISTINCT FROM NEW."checkoutId" OR original.delta <> -NEW.delta
            OR (NEW.kind='REFUND' AND original.kind <> 'REDEEM')
            OR (NEW.kind='EARN_REVERSAL' AND original.kind <> 'EARN') THEN
            RAISE EXCEPTION 'Invalid membership reversal' USING ERRCODE = '23514';
          END IF;
        ELSIF NEW."reversalOfId" IS NOT NULL OR NOT EXISTS (
          SELECT 1 FROM "Tenant" t WHERE t.id=NEW."tenantId" AND t."membershipProgramId"=NEW."programId"
        ) THEN RAISE EXCEPTION 'Membership program mismatch' USING ERRCODE = '23514'; END IF;
        RETURN NEW;
      END $$`);
    await tx.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "MembershipPointEntry_valid_insert"
      BEFORE INSERT ON "MembershipPointEntry" FOR EACH ROW EXECUTE FUNCTION "MembershipPointEntry_insert_guard"()`);
    await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "MembershipCustomerLink_guard"() RETURNS trigger
      LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$ BEGIN
        IF TG_OP='UPDATE' AND (NEW."programId",NEW."accountId",NEW."tenantId",NEW."salonId",NEW."customerId")
          IS DISTINCT FROM (OLD."programId",OLD."accountId",OLD."tenantId",OLD."salonId",OLD."customerId") THEN
          RAISE EXCEPTION 'Membership link is immutable' USING ERRCODE = '42501';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM "Tenant" t WHERE t.id=NEW."tenantId" AND t."membershipProgramId"=NEW."programId") THEN
          RAISE EXCEPTION 'Membership program mismatch' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$`);
    await tx.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "MembershipCustomerLink_scope_guard"
      BEFORE INSERT OR UPDATE ON "MembershipCustomerLink" FOR EACH ROW EXECUTE FUNCTION "MembershipCustomerLink_guard"()`);
    await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "Tenant_membership_owner_guard"() RETURNS trigger
      LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$ BEGIN
        IF TG_OP='DELETE' THEN
          IF OLD."membershipProgramId" IS NOT NULL AND EXISTS (
            SELECT 1 FROM "MembershipAccount" a WHERE a."programId"=OLD."membershipProgramId"
          ) THEN RAISE EXCEPTION 'An enrolled membership program cannot lose its owning tenant' USING ERRCODE='42501'; END IF;
          RETURN OLD;
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW."membershipProgramId" IS DISTINCT FROM OLD."membershipProgramId" THEN
          IF EXISTS (SELECT 1 FROM "MembershipAccount" a WHERE a."programId"=OLD."membershipProgramId")
            OR EXISTS (SELECT 1 FROM "MembershipAccount" a WHERE a."programId"=NEW."membershipProgramId") THEN
            RAISE EXCEPTION 'An enrolled membership program cannot be reassigned to another tenant' USING ERRCODE='42501';
          END IF;
        END IF;
        RETURN NEW;
      END $$`);
    await tx.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "Tenant_membership_owner"
      BEFORE UPDATE OR DELETE ON "Tenant" FOR EACH ROW EXECUTE FUNCTION "Tenant_membership_owner_guard"()`);
    await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "CashCheckout_membership_scope_guard"() RETURNS trigger
      LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$ BEGIN
        IF NEW."membershipAccountId" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM "MembershipAccount" a JOIN "Tenant" t ON t."membershipProgramId"=a."programId"
          WHERE a.id=NEW."membershipAccountId" AND t.id=NEW."tenantId"
        ) THEN RAISE EXCEPTION 'Membership checkout must belong to the same tenant' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $$`);
    await tx.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "CashCheckout_membership_scope"
      BEFORE INSERT OR UPDATE ON "CashCheckout" FOR EACH ROW EXECUTE FUNCTION "CashCheckout_membership_scope_guard"()`);
  }, { maxWait: 5000, timeout: 60000 });
}
