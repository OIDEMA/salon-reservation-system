"use client";

import { sendPasswordResetEmail } from "firebase/auth";
import Link from "next/link";
import { useState } from "react";
import { firebaseAuth, firebaseAuthReady } from "@/lib/firebase-client";
import { passwordRecoveryFeedback, type PasswordRecoveryFeedback } from "@/lib/password-recovery";

export function PasswordResetRequestForm() {
  const [email, setEmail] = useState("");
  const [feedback, setFeedback] = useState<PasswordRecoveryFeedback | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFeedback(null);

    try {
      await firebaseAuthReady;
      await sendPasswordResetEmail(firebaseAuth, email);
      setFeedback(passwordRecoveryFeedback());
    } catch (error) {
      setFeedback(passwordRecoveryFeedback(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="authForm authResetForm" onSubmit={submit}>
      <label>
        <span>メールアドレス</span>
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoFocus
        />
      </label>
      {feedback ? <p className={`authMessage ${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</p> : null}
      <button className="authSubmit" type="submit" disabled={submitting}>
        {submitting ? "送信中…" : "パスワード設定メールを送信"}
      </button>
      <Link className="authSecondary authActionLink" href="/login">ログイン画面へ戻る</Link>
    </form>
  );
}
