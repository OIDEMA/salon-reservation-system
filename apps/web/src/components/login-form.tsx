"use client";

import { sendPasswordResetEmail, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { firebaseAuth, firebaseAuthReady } from "@/lib/firebase-client";

type Feedback = {
  text: string;
  tone: "error" | "success";
};

type ErrorPayload = {
  code?: string;
  message?: string;
};

const firebaseErrorMessages: Record<string, string> = {
  "auth/invalid-email": "メールアドレスの形式が正しくありません。",
  "auth/missing-password": "パスワードを入力してください。",
  "auth/invalid-credential": "メールアドレスまたはパスワードが正しくありません。",
  "auth/user-not-found": "メールアドレスまたはパスワードが正しくありません。",
  "auth/wrong-password": "メールアドレスまたはパスワードが正しくありません。",
  "auth/user-disabled": "このアカウントは無効になっています。管理者にお問い合わせください。",
  "auth/too-many-requests": "試行回数が多すぎます。しばらく待ってから再度お試しください。",
  "auth/network-request-failed": "通信に失敗しました。ネットワーク接続を確認してください。",
  "auth/operation-not-allowed": "メールアドレスとパスワードによるログインは現在利用できません。",
  "auth/weak-password": "パスワードの強度が不足しています。"
};

function firebaseErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
}

function localizedFirebaseError(error: unknown) {
  const code = firebaseErrorCode(error);
  return firebaseErrorMessages[code] ?? "ログインに失敗しました。入力内容を確認して、もう一度お試しください。";
}

function localizedApiError(payload: ErrorPayload | null) {
  switch (payload?.code) {
    case "INVALID_ORIGIN":
      return "アクセス元が正しくありません。現在のページからもう一度お試しください。";
    case "INVALID_CSRF_TOKEN":
      return "セキュリティ確認に失敗しました。ページを再読み込みしてからお試しください。";
    case "EMAIL_NOT_VERIFIED":
      return "メールアドレスの確認が完了していません。管理者にお問い合わせください。";
    case "USER_DISABLED":
      return "このアカウントは無効になっています。管理者にお問い合わせください。";
    default:
      return payload?.message ?? "ログインセッションを作成できませんでした。";
  }
}

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFeedback(null);
    try {
      await firebaseAuthReady;
      const credential = await signInWithEmailAndPassword(firebaseAuth, email, password);
      if (!credential.user.emailVerified) {
        await signOut(firebaseAuth);
        setFeedback({ tone: "error", text: "メールアドレスの確認が完了していません。管理者にお問い合わせください。" });
        return;
      }

      const [{ csrfToken }, idToken] = await Promise.all([
        fetch("/api/session", { cache: "no-store" }).then((response) => response.json()) as Promise<{ csrfToken: string }>,
        credential.user.getIdToken(true)
      ]);
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, csrfToken })
      });
      await signOut(firebaseAuth);
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as ErrorPayload | null;
        throw new Error(localizedApiError(result));
      }
      window.location.assign("/select-tenant");
    } catch (error) {
      const code = firebaseErrorCode(error);
      if (["auth/invalid-credential", "auth/wrong-password", "auth/missing-password"].includes(code)) {
        try {
          const statusResponse = await fetch("/api/auth/password-status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email })
          });
          const status = (await statusResponse.json().catch(() => null)) as { needsPasswordSetup?: boolean } | null;
          if (statusResponse.ok && status?.needsPasswordSetup) {
            await firebaseAuthReady;
            await sendPasswordResetEmail(firebaseAuth, email);
            setFeedback({
              tone: "success",
              text: "パスワード設定メールを送信しました。メールをご確認ください。"
            });
            return;
          }
        } catch {
          // Fall through to the regular localized login error when status lookup fails.
        }
      }
      setFeedback({
        tone: "error",
        text: error instanceof Error && !firebaseErrorCode(error) ? error.message : localizedFirebaseError(error)
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function requestPasswordReset() {
    if (!email) {
      setFeedback({ tone: "error", text: "パスワードを再設定するメールアドレスを入力してください。" });
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    try {
      await firebaseAuthReady;
      await sendPasswordResetEmail(firebaseAuth, email);
      setFeedback({ tone: "success", text: "パスワード再設定メールを送信しました。メールをご確認ください。" });
    } catch (error) {
      setFeedback({ tone: "error", text: localizedFirebaseError(error) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="authForm" onSubmit={submit}>
      <label>
        <span>メールアドレス</span>
        <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
      </label>
      <label>
        <span>パスワード</span>
        <div className="passwordInput">
          <input type={showPassword ? "text" : "password"} autoComplete="current-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} />
          <button
            className="passwordToggle"
            type="button"
            aria-label={showPassword ? "パスワードを隠す" : "パスワードを表示"}
            aria-pressed={showPassword}
            onClick={() => setShowPassword((current) => !current)}
          >
            {showPassword ? <EyeOff size={19} aria-hidden="true" /> : <Eye size={19} aria-hidden="true" />}
          </button>
        </div>
      </label>
      {feedback ? <p className={`authMessage ${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</p> : null}
      <button className="authSubmit" type="submit" disabled={submitting}>
        {submitting ? "処理中…" : "ログイン"}
      </button>
      <button className="authResetLink" type="button" disabled={submitting} onClick={() => void requestPasswordReset()}>
        パスワードをお忘れですか？
      </button>
    </form>
  );
}
