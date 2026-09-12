import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { firebaseAdminAuth } from "@/lib/firebase-admin";
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

  try {
    const user = await firebaseAdminAuth.getUserByEmail(parsed.data.email);
    return NextResponse.json({ needsPasswordSetup: !user.passwordHash });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "auth/user-not-found") {
      // Keep unknown accounts indistinguishable from accounts that already have a password.
      return NextResponse.json({ needsPasswordSetup: false });
    }

    console.error("Unable to determine password setup status", error);
    return NextResponse.json(
      { code: "AUTH_STATUS_UNAVAILABLE", message: "アカウントの状態を確認できませんでした。" },
      { status: 503 }
    );
  }
}
