"use client";

import { GoogleAuthProvider, signInWithEmailAndPassword, signInWithPopup, signOut } from "firebase/auth";
import { Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { useRef, useState } from "react";
import { firebaseAuth, firebaseAuthReady } from "@/lib/firebase-client";
import { loginFailureMessage, loginWithBrowserSession, SessionRequestError } from "@/lib/login-session";
import { safeStaffHandoffReturnTo } from "@/lib/staff-handoff";

type Feedback = {
  text: string;
  tone: "error" | "success";
};

export type LoginFormProps = { initialEmail?: string; onAuthenticated?: () => Promise<void>; returnTo?: string | null };

export function LoginForm({ initialEmail = "", onAuthenticated, returnTo }: LoginFormProps = {}) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [submitting, setSubmitting] = useState<"password" | "google" | null>(null);
  const submittingRef = useRef(false);

  async function authenticate(method: "password" | "google") {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(method);
    setFeedback(null);
    try {
      await loginWithBrowserSession(async () => {
        await firebaseAuthReady;
        return method === "google" ? signInWithPopup(firebaseAuth, new GoogleAuthProvider()) : signInWithEmailAndPassword(firebaseAuth, email, password);
      }, () => signOut(firebaseAuth));
      setPassword("");
      if (onAuthenticated) await onAuthenticated();
      else window.location.assign(safeStaffHandoffReturnTo(returnTo) ?? "/select-tenant");
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof SessionRequestError ? error.message : loginFailureMessage(error, method)
      });
    } finally {
      submittingRef.current = false;
      setSubmitting(null);
    }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void authenticate("password");
  }

  return (
    <form className="authForm" onSubmit={submit}>
      <button className="authGoogle" type="button" disabled={Boolean(submitting)} aria-busy={submitting === "google"} onClick={() => void authenticate("google")}>
        <Image src="/brand/google-g.png" width={20} height={20} alt="" aria-hidden="true" />
        <span>Googleでログイン</span>
      </button>
      <div className="authDivider" aria-hidden="true">または</div>
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
      <button className="authSubmit" type="submit" disabled={Boolean(submitting)}>
        {submitting === "password" ? "処理中…" : "ログイン"}
      </button>
      <Link className="authResetLink" href="/password-reset">
        パスワードをお忘れの方
      </Link>
    </form>
  );
}
