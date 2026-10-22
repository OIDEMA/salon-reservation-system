import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { sameOrigin } from "@/lib/request-security";

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email()
});

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { code: "INVALID_ORIGIN", message: "アクセス元が正しくありません。" },
      { status: 403 }
    );
  }

  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { code: "INVALID_EMAIL", message: "メールアドレスの形式が正しくありません。" },
      { status: 400 }
    );
  }

  // Retain the old response shape for already-loaded clients without looking up
  // accounts. Initial password setup and recovery share /password-reset.
  return NextResponse.json(
    { needsPasswordSetup: false },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
