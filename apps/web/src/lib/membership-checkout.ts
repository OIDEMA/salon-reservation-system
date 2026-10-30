import type { CashMembership } from "../components/cash-types";

export type MembershipHistory = {
  id: string; kind: "EARN" | "REDEEM" | "REFUND" | "EARN_REVERSAL";
  delta: number; createdAt: string; salonName: string; checkoutId: string | null;
};
export type MembershipLookup = {
  member: { id: string; number: string; name: string; balance: number; availablePoints: number; qualifyingPoints: number };
  linkStatus: "LINKED" | "UNLINKED" | "MISMATCH";
  customerId: string | null;
  policy: { version: string; pointValueYen: 1; redemptionUnit: 100; earnYenUnit: number; earnPoints: number };
  history: MembershipHistory[];
};

function invalid(): never { throw new Error("会員情報を確認できませんでした。もう一度読み取ってください。"); }
function row(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid(); }
function text(value: unknown, limit = 200): string { return typeof value === "string" && value.length > 0 && value.length <= limit ? value : invalid(); }
function integer(value: unknown, minimum = Number.MIN_SAFE_INTEGER): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : invalid(); }

export function normalizeMembershipBarcode(value: string): string {
  const barcode = value.trim();
  if (!/^(?:beautygum-demo:)?[0-9]{13}$/.test(barcode)) throw new Error("会員証の13桁の番号、または会員証のQRコードを読み取ってください。");
  return barcode;
}

export function readMembershipLookup(value: unknown): MembershipLookup {
  const result = row(value); const member = row(result.member); const policy = row(result.policy);
  const memberNumber = text(member.number, 13);
  if (!/^[0-9]{13}$/.test(memberNumber) || !["LINKED", "UNLINKED", "MISMATCH"].includes(String(result.linkStatus))
    || policy.pointValueYen !== 1 || policy.redemptionUnit !== 100 || !Array.isArray(result.history)) return invalid();
  const customerId = result.customerId === null ? null : text(result.customerId);
  if (result.linkStatus === "LINKED" && !customerId) return invalid();
  return {
    member: { id: text(member.id), number: memberNumber, name: text(member.name), balance: integer(member.balance),
      availablePoints: integer(member.availablePoints, 0), qualifyingPoints: integer(member.qualifyingPoints, 0) },
    linkStatus: result.linkStatus as MembershipLookup["linkStatus"], customerId,
    policy: { version: text(policy.version, 100), pointValueYen: 1, redemptionUnit: 100,
      earnYenUnit: integer(policy.earnYenUnit, 1), earnPoints: integer(policy.earnPoints, 1) },
    history: result.history.map((entry) => {
      const item = row(entry); const createdAt = text(item.createdAt);
      if (!["EARN", "REDEEM", "REFUND", "EARN_REVERSAL"].includes(String(item.kind)) || !Number.isFinite(Date.parse(createdAt))) return invalid();
      return { id: text(item.id), kind: item.kind as MembershipHistory["kind"], delta: integer(item.delta), createdAt,
        salonName: text(item.salonName), checkoutId: item.checkoutId === null ? null : text(item.checkoutId) };
    }),
  };
}

export function membershipRedemptionLimit(lookup: MembershipLookup, beforePointsYen: number): number {
  if (!Number.isSafeInteger(beforePointsYen) || beforePointsYen <= 0) return 0;
  const limit = Math.min(lookup.member.balance, lookup.member.availablePoints, beforePointsYen);
  return Math.max(0, Math.floor(limit / 100) * 100);
}

export function membershipChoice(lookup: MembershipLookup, decision: "USE" | "SKIP", points: number, beforePointsYen: number): CashMembership {
  if (lookup.linkStatus !== "LINKED") throw new Error("お客様と会員の連携を確認してからポイントを選択してください。");
  const limit = membershipRedemptionLimit(lookup, beforePointsYen);
  if (!["USE", "SKIP"].includes(decision) || !Number.isSafeInteger(points) || (decision === "SKIP" ? points !== 0 : points < 100 || points % 100 !== 0 || points > limit)) {
    throw new Error(`利用ポイントは100ポイント単位で、${limit.toLocaleString("ja-JP")}ポイント以内を指定してください。`);
  }
  return { accountId: lookup.member.id, memberNumber: lookup.member.number, memberName: lookup.member.name,
    decision, pointsToUse: points, policyVersion: lookup.policy.version };
}

export function membershipFromPointInput(lookup: MembershipLookup, input: string, beforePointsYen: number, allowRedemption = true): CashMembership {
  if (!/^[0-9]+$/.test(input) || !Number.isSafeInteger(Number(input)) || !allowRedemption && Number(input) !== 0) {
    throw new Error("利用ポイントは0以上の100ポイント単位で入力してください。");
  }
  const amount = Number(input);
  return membershipChoice(lookup, amount === 0 ? "SKIP" : "USE", amount, beforePointsYen);
}

export function membershipSelectionForLookup(lookup: MembershipLookup, previous: CashMembership | null,
  beforePointsYen: number, allowRedemption = true): { value: CashMembership; reset: boolean } {
  const matches = previous?.accountId === lookup.member.id;
  if (matches && previous.policyVersion === lookup.policy.version) {
    try {
      if (previous.decision !== "USE" && previous.decision !== "SKIP" || previous.decision === "SKIP" && previous.pointsToUse !== 0 || previous.decision === "USE" && previous.pointsToUse < 100) throw new Error();
      return { value: membershipFromPointInput(lookup, String(previous.pointsToUse), beforePointsYen, allowRedemption), reset: false };
    } catch { /* A stale, excessive or prepaid redemption is never restored. */ }
  }
  return { value: membershipChoice(lookup, "SKIP", 0, beforePointsYen), reset: Boolean(matches) };
}

export function membershipDraftFields(value: CashMembership | null | undefined) {
  return value ? { membershipAccountId: value.accountId, pointUseDecision: value.decision,
    pointsToUse: value.pointsToUse, pointPolicyVersion: value.policyVersion } : {};
}

export async function membershipRequest(url: string, payload: unknown, signal?: AbortSignal): Promise<MembershipLookup> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store", signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } catch (problem) {
    if (signal?.aborted) throw problem;
    throw new Error("会員システムに接続できません。通信を確認してもう一度お試しください。");
  }
  if (!response.ok) {
    const messages: Record<number, string> = {
      400: "会員番号と対象のお客様をご確認ください。", 401: "ログインの有効期限が切れました。もう一度ログインしてください。",
      403: "この会員情報を確認・変更する権限がありません。店舗の担当者にご確認ください。",
      404: "会員が見つかりません。会員番号と入会状況をご確認ください。",
      409: "会員の連携状況が変わったか、別のお客様に連携されています。最新の内容を読み取り直してください。",
      422: "会員番号と登録内容をご確認ください。", 429: "照会が集中しています。少し待ってからお試しください。",
      503: "会員・ポイント機能の接続設定が完了していません。店舗の管理者にお問い合わせください。",
    };
    throw new Error(messages[response.status] ?? "会員情報を取得できませんでした。もう一度お試しください。");
  }
  try { return readMembershipLookup(await response.json()); }
  catch { return invalid(); }
}
