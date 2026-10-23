const firebaseErrors: Record<string, string> = {
  "auth/invalid-email": "メールアドレスの形式が正しくありません。",
  "auth/missing-password": "パスワードを入力してください。",
  "auth/invalid-credential": "メールアドレスまたはパスワードが正しくありません。",
  "auth/user-not-found": "メールアドレスまたはパスワードが正しくありません。",
  "auth/wrong-password": "メールアドレスまたはパスワードが正しくありません。",
  "auth/user-disabled": "このアカウントは無効になっています。管理者にお問い合わせください。",
  "auth/too-many-requests": "試行回数が多すぎます。しばらく待ってから再度お試しください。",
  "auth/network-request-failed": "通信に失敗しました。ネットワーク接続を確認してください。",
  "auth/operation-not-allowed": "メールアドレスとパスワードによるログインは現在利用できません。"
};
export function loginFailureMessage(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
  return firebaseErrors[code] ?? "ログインに失敗しました。入力内容を確認して、もう一度お試しください。";
}

export class SessionRequestError extends Error {}

/** Both ordinary login and invitation registration use the existing CSRF session exchange. */
export async function createBrowserSession(idToken: string, request: typeof fetch = fetch) {
  const csrfResponse = await request("/api/session", { cache: "no-store", credentials: "same-origin" });
  const csrf: unknown = await csrfResponse.json().catch(() => null);
  if (!csrfResponse.ok || typeof csrf !== "object" || csrf === null || !("csrfToken" in csrf) || typeof csrf.csrfToken !== "string" ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(csrf.csrfToken)) {
    throw new SessionRequestError("セキュリティ確認に失敗しました。ページを再読み込みしてからお試しください。");
  }
  const response = await request("/api/session", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken, csrfToken: csrf.csrfToken }), cache: "no-store", credentials: "same-origin" });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: unknown } | null;
    if (body?.code === "EMAIL_NOT_VERIFIED") throw new SessionRequestError("メールアドレスの確認が完了していません。管理者にお問い合わせください。");
    if (body?.code === "USER_DISABLED") throw new SessionRequestError("このアカウントは無効になっています。管理者にお問い合わせください。");
    throw new SessionRequestError("ログインセッションを作成できませんでした。もう一度ログインしてください。");
  }
}
