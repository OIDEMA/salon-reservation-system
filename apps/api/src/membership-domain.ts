import { Prisma, type MembershipAccount, type MembershipPointKind } from "@prisma/client";
import { z } from "zod";

type Db = Pick<Prisma.TransactionClient, "tenant" | "membershipAccount" | "membershipCustomerLink" | "membershipPointEntry">;
type Tx = Prisma.TransactionClient;
export const MEMBERSHIP_POLICY = Object.freeze({
  version: "beautygum-20261029-v1", pointValueYen: 1, redemptionUnit: 100,
  earnYenUnit: 100, earnPoints: 5,
});
export class MembershipError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) { super(message); }
}
export function membershipAssert(value: unknown, code: string, message: string, status = 400): asserts value {
  if (!value) throw new MembershipError(code, message, status);
}
export function parseMembershipBarcode(value: string) {
  // A barcode reader can append CR/LF, but URLs and other QR schemes are not
  // interpreted as member numbers or allowed to select a network destination.
  const number = value.trim().replace(/^beautygum-demo:/, "");
  membershipAssert(/^\d{13}$/.test(number), "INVALID_MEMBER_BARCODE", "13桁の会員番号を読み取ってください。");
  return number;
}
export const membershipLookupSchema = z.object({
  barcode: z.string().max(200), reservationId: z.string().min(1).max(160).optional(), checkoutId: z.string().uuid().optional(),
}).strict().refine((input) => !(input.reservationId && input.checkoutId), "会計または予約のどちらかを指定してください。");
export const membershipLinkSchema = z.object({ barcode: z.string().max(200), expectedMemberId: z.string().uuid(), confirmed: z.literal(true) }).strict();
export const membershipEnrollmentSchema = z.object({ programId: z.string().uuid(), displayName: z.string().trim().min(1).max(80) }).strict();

export async function requireMembershipProgram(database: Pick<Db, "tenant">, tenantId: string) {
  const tenant = await database.tenant.findUnique({ where: { id: tenantId }, include: { membershipProgram: true } });
  membershipAssert(tenant?.membershipProgram?.active, "MEMBERSHIP_UNAVAILABLE", "会員システムの連携設定が必要です。管理者にご確認ください。", 503);
  return tenant.membershipProgram;
}
export async function membershipBalance(database: Pick<Db, "membershipPointEntry">, accountId: string, programId: string) {
  const [all, earned] = await Promise.all([
    database.membershipPointEntry.aggregate({ where: { accountId, programId }, _sum: { delta: true } }),
    database.membershipPointEntry.aggregate({ where: { accountId, programId, kind: { in: ["EARN", "EARN_REVERSAL"] } }, _sum: { delta: true } }),
  ]);
  const balance = all._sum.delta ?? 0;
  const qualifyingPoints = earned._sum.delta ?? 0;
  membershipAssert(Number.isSafeInteger(balance) && Number.isSafeInteger(qualifyingPoints), "MEMBERSHIP_BALANCE_UNAVAILABLE", "ポイント残高を確認できません。", 503);
  return { balance, availablePoints: Math.max(0, balance), qualifyingPoints: Math.max(0, qualifyingPoints) };
}
export function validateMembershipUse(pointsToUse: number, availablePoints: number, maxDiscountYen: number, policyVersion: string) {
  membershipAssert(policyVersion === MEMBERSHIP_POLICY.version, "MEMBERSHIP_POLICY_CHANGED", "ポイントの利用条件が変わりました。最新の会員情報を読み取ってください。", 409);
  membershipAssert(Number.isSafeInteger(pointsToUse) && pointsToUse >= 0 && pointsToUse % MEMBERSHIP_POLICY.redemptionUnit === 0,
    "MEMBERSHIP_POINTS_UNIT", "利用ポイントは100ポイント単位で入力してください。");
  membershipAssert(pointsToUse <= availablePoints, "MEMBERSHIP_POINTS_SHORTAGE", "ポイント残高が不足しています。最新の残高をご確認ください。", 409);
  membershipAssert(pointsToUse * MEMBERSHIP_POLICY.pointValueYen <= maxDiscountYen, "MEMBERSHIP_DISCOUNT_LIMIT", "利用ポイントが会計金額を超えています。");
  return pointsToUse * MEMBERSHIP_POLICY.pointValueYen;
}
async function lockAccount(tx: Tx, accountId: string) {
  await tx.$queryRaw`SELECT id FROM "MembershipAccount" WHERE id=${accountId} FOR UPDATE`;
}
export async function readCheckoutMembership(tx: Tx, input: {
  tenantId: string; salonId: string; customerId: string; accountId: string; lock?: boolean;
}) {
  const program = await requireMembershipProgram(tx, input.tenantId);
  if (input.lock) await lockAccount(tx, input.accountId);
  const account = await tx.membershipAccount.findFirst({ where: { id: input.accountId, programId: program.id, active: true } });
  membershipAssert(account, "MEMBERSHIP_ACCOUNT_UNAVAILABLE", "会員情報を確認できません。会員証を読み取り直してください。", 409);
  const link = await tx.membershipCustomerLink.findFirst({ where: {
    programId: program.id, accountId: account.id, tenantId: input.tenantId, salonId: input.salonId, customerId: input.customerId,
  } });
  membershipAssert(link, "MEMBERSHIP_CUSTOMER_MISMATCH", "会計のお客様と会員証の連携を確認してください。", 409);
  return { account, ...await membershipBalance(tx, account.id, program.id), policy: MEMBERSHIP_POLICY };
}
type CheckoutPointInput = {
  tenantId: string; salonId: string; customerId: string; accountId: string; checkoutId: string;
  pointsToUse: number; totalYen: number; policyVersion: string; actorUserId: string;
};
async function writeEntry(tx: Tx, input: {
  account: MembershipAccount; tenantId: string; salonId: string; checkoutId: string;
  kind: MembershipPointKind; delta: number; actorUserId: string; reversalOfId?: string;
}) {
  if (!input.delta) return;
  const requestId = `checkout:${input.checkoutId}:${input.kind}`;
  const old = await tx.membershipPointEntry.findUnique({ where: { requestId } });
  if (old) {
    membershipAssert(old.programId === input.account.programId && old.accountId === input.account.id &&
      old.tenantId === input.tenantId && old.salonId === input.salonId && old.checkoutId === input.checkoutId &&
      old.kind === input.kind && old.delta === input.delta && old.reversalOfId === (input.reversalOfId ?? null),
    "MEMBERSHIP_REQUEST_CONFLICT", "同じ会計に異なるポイント処理が送信されました。", 409);
    return;
  }
  await tx.membershipPointEntry.create({ data: {
    programId: input.account.programId, accountId: input.account.id, tenantId: input.tenantId, salonId: input.salonId,
    checkoutId: input.checkoutId, kind: input.kind, delta: input.delta, requestId, createdByUserId: input.actorUserId,
    reversalOfId: input.reversalOfId,
  } });
}
/** The caller must keep this in the same transaction as checkout finalization. */
export async function finalizeMembershipPoints(tx: Tx, input: CheckoutPointInput) {
  const current = await readCheckoutMembership(tx, { ...input, lock: true });
  membershipAssert(Number.isSafeInteger(input.totalYen) && input.totalYen >= 0 && input.totalYen <= 100_000_000,
    "MEMBERSHIP_AMOUNT_INVALID", "会計金額を確認してください。");
  const previous = await tx.membershipPointEntry.findMany({ where: { checkoutId: input.checkoutId, kind: { in: ["REDEEM", "EARN"] } } });
  const redeemedBefore = previous.find((entry) => entry.kind === "REDEEM");
  const requestedEarn = Math.floor(input.totalYen / MEMBERSHIP_POLICY.earnYenUnit) * MEMBERSHIP_POLICY.earnPoints;
  // On an identical retry, restore the old debit only for the validation step.
  // Any mismatched existing entry is rejected by writeEntry below.
  const availableBeforeRetry = current.availablePoints + (redeemedBefore?.accountId === current.account.id ? -redeemedBefore.delta : 0);
  validateMembershipUse(input.pointsToUse, availableBeforeRetry, input.totalYen + input.pointsToUse, input.policyVersion);
  for (const old of previous) {
    const expected = old.kind === "REDEEM" ? -input.pointsToUse : requestedEarn;
    membershipAssert(old.accountId === current.account.id && old.delta === expected, "MEMBERSHIP_REQUEST_CONFLICT", "会計のポイント処理が一致しません。", 409);
  }
  await writeEntry(tx, { ...input, account: current.account, kind: "REDEEM", delta: -input.pointsToUse });
  await writeEntry(tx, { ...input, account: current.account, kind: "EARN", delta: requestedEarn });
  return { pointsAwarded: requestedEarn, pointsUsed: input.pointsToUse, ...await membershipBalance(tx, current.account.id, current.account.programId) };
}
/** Refunds restore the original account even if it is inactive or unlinked. */
export async function reverseMembershipPoints(tx: Tx, input: {
  tenantId: string; salonId: string; accountId: string; checkoutId: string; actorUserId: string;
}) {
  await lockAccount(tx, input.accountId);
  const account = await tx.membershipAccount.findUnique({ where: { id: input.accountId } });
  membershipAssert(account, "MEMBERSHIP_ACCOUNT_UNAVAILABLE", "取消元の会員記録を確認できません。", 409);
  const originals = await tx.membershipPointEntry.findMany({ where: { checkoutId: input.checkoutId, kind: { in: ["REDEEM", "EARN"] } } });
  for (const original of originals) {
    membershipAssert(original.accountId === account.id && original.programId === account.programId && original.tenantId === input.tenantId && original.salonId === input.salonId,
      "MEMBERSHIP_REQUEST_CONFLICT", "取消元のポイント記録が一致しません。", 409);
    await writeEntry(tx, { ...input, account, kind: original.kind === "REDEEM" ? "REFUND" : "EARN_REVERSAL", delta: -original.delta, reversalOfId: original.id });
  }
  // A prior earn can already have been spent at another salon. Keep the debt
  // auditable instead of preventing the cash refund; availablePoints stays 0.
  return membershipBalance(tx, account.id, account.programId);
}

export function membershipSafeError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof MembershipError) return { status: error.statusCode, code: error.code, message: error.message };
  if (error instanceof z.ZodError) return { status: 400, code: "INVALID_INPUT", message: "入力内容を確認してください。" };
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { status: 409, code: "MEMBERSHIP_LINK_CONFLICT", message: "すでに別の会員またはお客様と連携しています。" };
  return { status: 500, code: "MEMBERSHIP_REQUEST_FAILED", message: "会員情報を確認できません。時間をおいて再試行してください。" };
}
