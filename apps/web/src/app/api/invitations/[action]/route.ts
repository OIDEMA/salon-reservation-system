import { NextResponse, type NextRequest } from "next/server";
import { sameOrigin } from "@/lib/request-security";
import { invitationErrors, invitationPreviewInput, invitationPreviewSchema, invitationRegisteredSchema, invitationRegistrationInput } from "@/lib/invitation-registration";

const bodyLimit = 8192;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
type RouteContext = { params: Promise<{ action: string }> };
function json(body: unknown, status: number) { return NextResponse.json(body, { status, headers }); }
function failure(code: keyof typeof invitationErrors) { return json({ code, message: invitationErrors[code].message }, invitationErrors[code].status); }

async function limitedJson(request: NextRequest): Promise<unknown> {
  const declaredSize = request.headers.get("content-length");
  if (declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > bodyLimit)) throw new RangeError();
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > bodyLimit) { await reader.cancel(); throw new RangeError(); }
      chunks.push(value);
    }
    const buffer = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } finally { reader.releaseLock(); }
}

export async function POST(request: NextRequest, context: RouteContext) {
  if (!sameOrigin(request)) return json({ code: "INVALID_ORIGIN", message: "アクセス元が正しくありません。" }, 403);
  const { action } = await context.params;
  if (action !== "preview" && action !== "register") return json({ code: "NOT_FOUND", message: "この操作は利用できません。" }, 404);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return failure("INVALID_INPUT");
  let body: unknown;
  try { body = await limitedJson(request); }
  catch (error) { return error instanceof RangeError ? json({ code: "PAYLOAD_TOO_LARGE", message: "入力内容が長すぎます。" }, 413) : failure("INVALID_INPUT"); }
  const input = (action === "preview" ? invitationPreviewInput : invitationRegistrationInput).safeParse(body);
  if (!input.success) return failure("INVALID_INPUT");
  try {
    const base = new URL(process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4001");
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Invalid API configuration");
    const upstream = await fetch(new URL(`/api/access/invitations/${action}`, base), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.data),
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000)
    });
    const result: unknown = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const code = typeof result === "object" && result !== null && "code" in result && typeof result.code === "string" ? result.code : "";
      return failure(Object.hasOwn(invitationErrors, code) ? code as keyof typeof invitationErrors : "INVITATION_REGISTRATION_UNAVAILABLE");
    }
    const parsed = (action === "preview" ? invitationPreviewSchema : invitationRegisteredSchema).safeParse(result);
    return parsed.success ? json(parsed.data, action === "register" ? 201 : 200) : failure("INVITATION_REGISTRATION_UNAVAILABLE");
  } catch { return failure("INVITATION_REGISTRATION_UNAVAILABLE"); }
}
