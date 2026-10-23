import { z } from "zod";

export const invitationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const invitationPreviewInput = z.object({ token: invitationTokenSchema }).strict();
export const invitationRegistrationInput = z.object({
  token: invitationTokenSchema,
  displayName: z.string().trim().min(1).max(100).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  password: z.string().min(8).max(128)
}).strict();
const tenantSchema = z.object({ id: z.string().min(1).max(150), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), name: z.string().min(1).max(200) });
export const invitationPreviewSchema = z.object({
  email: z.string().email().max(254), tenant: tenantSchema,
  role: z.enum(["OWNER", "ADMIN", "MANAGER", "STAFF", "VIEWER"]), alreadyRegistered: z.boolean()
});
export const invitationRegisteredSchema = z.object({ registered: z.literal(true), tenant: tenantSchema });
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

export const invitationErrors = {
  INVITATION_ACCOUNT_EXISTS: { status: 409, message: "このメールアドレスは登録済みです。既存のパスワードでログインして、招待を承諾してください。" },
  INVITATION_UNAVAILABLE: { status: 410, message: "この招待は期限切れ、取消済み、または承諾済みです。管理者に確認してください。" },
  INVITATION_RATE_LIMIT: { status: 429, message: "試行回数が多すぎます。しばらく待ってから再度お試しください。" },
  INVALID_INPUT: { status: 400, message: "入力内容を確認してください。お名前は100文字以内、パスワードは8〜128文字で入力してください。" },
  INVITATION_REGISTRATION_UNAVAILABLE: { status: 503, message: "処理結果を確認できませんでした。登録操作を繰り返さず、ログインをお試しください。ログインできない場合は管理者にお問い合わせください。" }
} as const;

export class InvitationRequestError extends Error {
  constructor(readonly code: keyof typeof invitationErrors) { super(invitationErrors[code].message); }
}

export function invitationTokenFromHash(hash: string) {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  const token = invitationTokenSchema.safeParse(value);
  return token.success ? token.data : "";
}

export function validateInvitationRegistration(input: { token: string; displayName: string; password: string; confirmation: string }) {
  if (input.password !== input.confirmation) throw new Error("確認用パスワードが一致しません。");
  const parsed = invitationRegistrationInput.safeParse({ token: input.token, displayName: input.displayName, password: input.password });
  if (!parsed.success) throw new InvitationRequestError("INVALID_INPUT");
  return parsed.data;
}

async function publicInvitationRequest(action: "preview" | "register", input: unknown, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(`/api/invitations/${action}`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input), cache: "no-store", credentials: "same-origin", signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new InvitationRequestError("INVITATION_REGISTRATION_UNAVAILABLE");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : "";
    throw new InvitationRequestError(Object.hasOwn(invitationErrors, code) ? code as keyof typeof invitationErrors : "INVITATION_REGISTRATION_UNAVAILABLE");
  }
  return body;
}

export async function previewInvitation(token: string, signal?: AbortSignal): Promise<InvitationPreview> {
  const result = invitationPreviewSchema.safeParse(await publicInvitationRequest("preview", invitationPreviewInput.parse({ token }), signal));
  if (!result.success) throw new InvitationRequestError("INVITATION_REGISTRATION_UNAVAILABLE");
  return result.data;
}

export async function registerInvitation(input: { token: string; displayName: string; password: string; confirmation: string }) {
  const result = invitationRegisteredSchema.safeParse(await publicInvitationRequest("register", validateInvitationRegistration(input)));
  if (!result.success) throw new InvitationRequestError("INVITATION_REGISTRATION_UNAVAILABLE");
  return result.data;
}
