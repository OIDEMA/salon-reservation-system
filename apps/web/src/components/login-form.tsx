"use client";

import { createUserWithEmailAndPassword, sendEmailVerification, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { useState } from "react";
import { firebaseAuth, firebaseAuthReady } from "@/lib/firebase-client";

export function LoginForm() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage("");
    try {
      await firebaseAuthReady;
      if (mode === "signup") {
        const credential = await createUserWithEmailAndPassword(firebaseAuth, email, password);
        await sendEmailVerification(credential.user);
        await signOut(firebaseAuth);
        setMode("login");
        setMessage("確認メールを送信しました。メール内のリンクを開いてからログインしてください。");
        return;
      }

      const credential = await signInWithEmailAndPassword(firebaseAuth, email, password);
      if (!credential.user.emailVerified) {
        await sendEmailVerification(credential.user);
        await signOut(firebaseAuth);
        setMessage("メールアドレスが未確認です。確認メールを再送しました。");
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
        const result = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(result?.message ?? "ログインセッションを作成できませんでした。");
      }
      window.location.assign("/select-tenant");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "認証に失敗しました。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="authForm" onSubmit={submit}>
      <div className="authTabs">
        <button className={mode === "login" ? "isActive" : ""} type="button" onClick={() => setMode("login")}>ログイン</button>
        <button className={mode === "signup" ? "isActive" : ""} type="button" onClick={() => setMode("signup")}>新規登録</button>
      </div>
      <label>
        <span>メールアドレス</span>
        <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
      </label>
      <label>
        <span>パスワード</span>
        <input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required />
      </label>
      {message ? <p className="authMessage">{message}</p> : null}
      <button className="authSubmit" type="submit" disabled={submitting}>
        {submitting ? "処理中…" : mode === "login" ? "ログイン" : "アカウントを作成"}
      </button>
    </form>
  );
}
