import { z } from "zod";
import { firebaseAdminAuth } from "../auth.js";
import { prisma } from "../database.js";

const inputSchema = z.object({
  ownerEmail: z.string().trim().email().transform((value) => value.toLowerCase()),
  ownerDisplayName: z.string().trim().min(1).max(100).optional(),
  tenantName: z.string().trim().min(1).max(100),
  tenantSlug: z
    .string()
    .trim()
    .min(3)
    .max(50)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  salonName: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(50).default("Asia/Tokyo")
});

function readInput() {
  return inputSchema.parse({
    ownerEmail: process.env.PROVISION_OWNER_EMAIL,
    ownerDisplayName: process.env.PROVISION_OWNER_DISPLAY_NAME || undefined,
    tenantName: process.env.PROVISION_TENANT_NAME,
    tenantSlug: process.env.PROVISION_TENANT_SLUG,
    salonName: process.env.PROVISION_SALON_NAME,
    timezone: process.env.PROVISION_TIMEZONE || "Asia/Tokyo"
  });
}

async function resolveOwner(email: string, displayName?: string) {
  try {
    const existing = await firebaseAdminAuth.getUserByEmail(email);
    if (existing.disabled) throw new Error("The selected Firebase user is disabled.");
    if (!existing.emailVerified) {
      throw new Error("An existing Firebase user must verify their email before tenant provisioning.");
    }
    return existing;
  } catch (error) {
    if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
    return firebaseAdminAuth.createUser({
      email,
      emailVerified: true,
      disabled: false,
      displayName
    });
  }
}

async function provision() {
  const input = readInput();
  const firebaseUser = await resolveOwner(input.ownerEmail, input.ownerDisplayName);

  const result = await prisma.$transaction(async (transaction) => {
    const user = await transaction.appUser.upsert({
      where: { firebaseUid: firebaseUser.uid },
      create: {
        firebaseUid: firebaseUser.uid,
        email: input.ownerEmail,
        displayName: input.ownerDisplayName ?? firebaseUser.displayName
      },
      update: {
        email: input.ownerEmail,
        displayName: input.ownerDisplayName ?? firebaseUser.displayName,
        disabled: false
      }
    });

    const existingTenant = await transaction.tenant.findUnique({
      where: { slug: input.tenantSlug },
      include: { memberships: true, salons: { orderBy: { createdAt: "asc" } } }
    });
    if (existingTenant) {
      const ownerMembership = existingTenant.memberships.find(
        (membership) => membership.userId === user.id && membership.role === "OWNER" && membership.status === "ACTIVE"
      );
      if (!ownerMembership || existingTenant.salons.length === 0) {
        throw new Error("The tenant slug already exists with a different owner or without a salon.");
      }
      return { created: false, tenant: existingTenant, salon: existingTenant.salons[0], user };
    }

    const tenant = await transaction.tenant.create({
      data: { name: input.tenantName, slug: input.tenantSlug }
    });
    await transaction.tenantMembership.create({
      data: { tenantId: tenant.id, userId: user.id, role: "OWNER", status: "ACTIVE" }
    });
    const salon = await transaction.salon.create({
      data: { tenantId: tenant.id, name: input.salonName, timezone: input.timezone }
    });
    await transaction.salonSettings.create({
      data: {
        tenantId: tenant.id,
        salonId: salon.id,
        storeId: input.tenantSlug,
        cancellationMessage: "",
        friendMessage: ""
      }
    });
    await transaction.auditLog.create({
      data: {
        tenantId: tenant.id,
        actorUserId: user.id,
        action: "tenant.provision",
        resource: "tenant",
        resourceId: tenant.id,
        metadata: { source: "operator-job" }
      }
    });

    return { created: true, tenant, salon, user };
  });

  console.log(
    JSON.stringify({
      created: result.created,
      tenantId: result.tenant.id,
      tenantSlug: result.tenant.slug,
      salonId: result.salon.id,
      ownerUserId: result.user.id,
      ownerEmail: result.user.email
    })
  );
}

try {
  await provision();
} catch (error) {
  console.error(error instanceof z.ZodError ? error.flatten() : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
