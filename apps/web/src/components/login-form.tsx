"use client";

import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { firebaseAuth, firebaseAuthReady } from "@/lib/firebase-client";
import { createBrowserSession, loginFailureMessage, SessionRequestError } from "@/lib/login-session";

type Feedback = {
  text: string;
  tone: "error" | "success";
};

export function LoginForm({ initialEmail = "", onAuthenticated }: { initialEmail?: string; onAuthenticated?: () => Promise<void> } = {}) {
  const [email, setEmail] = useState(initialEmail);
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

      await createBrowserSession(await credential.user.getIdToken(true));
      await signOut(firebaseAuth);
      setPassword("");
      if (onAuthenticated) await onAuthenticated();
      else window.location.assign("/select-tenant");
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof SessionRequestError ? error.message : loginFailureMessage(error)
      });
    } finally {
      await signOut(firebaseAuth).catch(() => undefined);
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
          <input type={showPassword ? "text" : "password"} autoComplete="current-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required />
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
      <Link className="authResetLink" href="/password-reset">
        パスワードをお忘れの方
      </Link>
    </form>
  );
}
