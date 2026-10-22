export type PasswordRecoveryFeedback = { text: string; tone: "error" | "success" };

const accepted: PasswordRecoveryFeedback = {
  tone: "success",
  text: "対象のアカウントがある場合は、パスワード設定メールを送信しました。メールをご確認ください。届かない場合は、迷惑メールフォルダーや入力内容を確認し、管理者にお問い合わせください。"
};

export function passwordRecoveryFeedback(error?: unknown): PasswordRecoveryFeedback {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
  // Account existence and disabled status must not be disclosed in recovery.
  if (error === undefined || ["auth/user-not-found", "auth/user-disabled"].includes(code)) return { ...accepted };
  switch (code) {
    case "auth/invalid-email":
      return { tone: "error", text: "メールアドレスの形式が正しくありません。" };
    case "auth/too-many-requests":
      return { tone: "error", text: "試行回数が多すぎます。しばらく待ってから再度お試しください。" };
    case "auth/network-request-failed":
      return { tone: "error", text: "通信に失敗しました。ネットワーク接続を確認してください。" };
    default:
      return { tone: "error", text: "パスワード設定メールを送信できませんでした。時間をおいて、もう一度お試しください。" };
  }
}
