import { createHash, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { deriveInvitationToken } from "./invitation-token.js";
import { sendTextEmail, SesMailError } from "./ses-mail.js";
import { reservationNotificationEmail, reservationNotificationSchema } from "./reservation-notification.js";
import { checkoutNotificationEmail, checkoutNotificationSchema } from "./checkout-notification.js";

const MAX_ATTEMPTS = 12;
const RESERVATION_EVENT = "reservation.created";
const INVITATION_EVENT = "invitation.created";
const DEFAULT_BASE_URL = "https://salon-reserve.beauty-gum.jp";

const invitationPayload = z.object({
  invitationId: z.string().min(1),
  tenantName: z.string().min(1),
  role: z.string().min(1),
  expiresAt: z.string().datetime()
}).strict();

type SendText = typeof sendTextEmail;
type Dependencies = {
  send?: SendText;
  now?: () => Date;
  baseUrl?: string;
};

function cleanLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim();
}

function japanDateTime(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(date);
}

function publicBaseUrl(configured?: string): string {
  const url = new URL(configured ?? process.env.PUBLIC_BASE_URL ?? DEFAULT_BASE_URL);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid public email URL configuration");
  }
  return url.origin;
}

async function claimNext(database: PrismaClient): Promise<string | null> {
  const rows = await database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH candidate AS (
      SELECT "id" FROM "EmailOutbox"
      WHERE "availableAt" <= NOW() AND "attempts" < ${MAX_ATTEMPTS}
        AND ("status" = 'PENDING' OR ("status" = 'PROCESSING' AND "lockedUntil" < NOW()))
      ORDER BY "availableAt", "createdAt", "id"
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE "EmailOutbox" AS outbox
    SET "status" = 'PROCESSING', "attempts" = outbox."attempts" + 1,
        "lockedUntil" = NOW() + INTERVAL '10 minutes', "updatedAt" = NOW()
    FROM candidate WHERE outbox."id" = candidate."id"
    RETURNING outbox."id"
  `);
  return rows[0]?.id ?? null;
}

async function deliver(database: PrismaClient, id: string, send: SendText, baseUrl: string, now: Date): Promise<"sent" | "skipped"> {
  const item = await database.emailOutbox.findUnique({ where: { id } });
  if (!item || item.status !== "PROCESSING") throw new Error("Outbox claim was lost");
  const recipient = z.string().email().max(254).parse(item.recipientEmail);
  let subject: string;
  let text: string;

  if (item.eventType === RESERVATION_EVENT) {
    const payload = reservationNotificationSchema.parse(item.payload);
    if (item.eventKey !== `${RESERVATION_EVENT}:${payload.reservationId}` || !item.salonId) throw new Error("Invalid reservation outbox scope");
    ({ subject, text } = reservationNotificationEmail(payload, baseUrl));
  } else if (item.eventType === "checkout.finalized" || item.eventType === "checkout.reversed") {
    const payload = checkoutNotificationSchema.parse(item.payload);
    if (item.eventType !== payload.eventType || item.eventKey !== `${payload.eventType}:${payload.checkoutId}` ||
      item.tenantId !== payload.tenantId || item.salonId !== payload.salonId) throw new Error("Invalid checkout outbox scope");
    ({ subject, text } = checkoutNotificationEmail(payload, baseUrl));
  } else if (item.eventType === INVITATION_EVENT) {
    const payload = invitationPayload.parse(item.payload);
    if (item.eventKey !== `${INVITATION_EVENT}:${payload.invitationId}` || item.salonId) throw new Error("Invalid invitation outbox scope");
    const invitation = await database.tenantInvitation.findFirst({
      where: { id: payload.invitationId, tenantId: item.tenantId, email: recipient }
    });
    if (!invitation || invitation.revokedAt || invitation.acceptedAt || invitation.expiresAt <= now) {
      await database.emailOutbox.update({ where: { id }, data: { status: "SKIPPED", lockedUntil: null, lastErrorCode: null } });
      return "skipped";
    }
    if (invitation.expiresAt.toISOString() !== payload.expiresAt) throw new Error("Invalid invitation expiry");
    const token = deriveInvitationToken({ id: invitation.id, email: invitation.email, expiresAt: invitation.expiresAt });
    const expectedHash = createHash("sha256").update(token).digest();
    const storedHash = Buffer.from(invitation.tokenHash, "hex");
    if (storedHash.length !== expectedHash.length || !timingSafeEqual(storedHash, expectedHash)) {
      throw new Error("Invalid invitation token hash");
    }
    const acceptUrl = new URL(`/accept-invitation#token=${encodeURIComponent(token)}`, baseUrl).href;
    subject = `[SalonOps] ${cleanLine(payload.tenantName)}へのアカウント招待`;
    text = [
      `${cleanLine(payload.tenantName)}の管理アカウントへ招待されています。`,
      `役割: ${cleanLine(payload.role)}`,
      `有効期限: ${japanDateTime(invitation.expiresAt)}`,
      `招待を承諾: ${acceptUrl}`,
      "招待先と同じ確認済みメールアドレスでログインしてください。"
    ].join("\n");
  } else {
    throw new Error("Unsupported outbox event type");
  }

  const result = await send({ to: recipient, subject, text });
  if (!result.messageId) throw new Error("SES returned no message id");
  await database.emailOutbox.update({ where: { id }, data: {
    status: "SENT", sentAt: new Date(), lockedUntil: null, providerMessageId: result.messageId,
    lastErrorCode: null
  } });
  return "sent";
}

function retryDelayMs(attempts: number): number {
  return Math.min(60, 2 ** Math.min(attempts - 1, 6)) * 60_000;
}

export async function processEmailOutbox(database: PrismaClient, dependencies: Dependencies = {}): Promise<{ sent: number; skipped: number; retried: number; failed: number }> {
  const now = dependencies.now ?? (() => new Date());
  const send = dependencies.send ?? sendTextEmail;
  const baseUrl = publicBaseUrl(dependencies.baseUrl);
  await database.emailOutbox.updateMany({ where: {
    status: "PROCESSING", attempts: { gte: MAX_ATTEMPTS }, lockedUntil: { lt: now() }
  }, data: { status: "FAILED", lockedUntil: null, lastErrorCode: "MAX_ATTEMPTS" } });
  const summary = { sent: 0, skipped: 0, retried: 0, failed: 0 };
  for (let processed = 0; processed < 100; processed++) {
    const id = await claimNext(database);
    if (!id) break;
    try {
      const outcome = await deliver(database, id, send, baseUrl, now());
      summary[outcome]++;
    } catch (error) {
      const item = await database.emailOutbox.findUnique({ where: { id }, select: { attempts: true } });
      const attempts = item?.attempts ?? MAX_ATTEMPTS;
      const terminal = attempts >= MAX_ATTEMPTS || error instanceof z.ZodError ||
        error instanceof SesMailError && !error.retryable ||
        error instanceof Error && (error.message.startsWith("Invalid ") || error.message.startsWith("Unsupported "));
      const code = error instanceof z.ZodError ? "INVALID_OUTBOX_PAYLOAD" :
        error instanceof SesMailError ? error.code :
        error instanceof Error && error.message.startsWith("Invalid invitation token") ? "INVITATION_KEY_MISMATCH" :
        error instanceof Error && (error.message.startsWith("Invalid ") || error.message.startsWith("Unsupported ")) ? "INVALID_OUTBOX_SCOPE" : "SEND_FAILED";
      await database.emailOutbox.update({ where: { id }, data: {
        status: terminal ? "FAILED" : "PENDING", lockedUntil: null, lastErrorCode: code,
        availableAt: terminal ? now() : new Date(now().getTime() + retryDelayMs(attempts))
      } });
      summary[terminal ? "failed" : "retried"]++;
    }
  }
  return summary;
}
