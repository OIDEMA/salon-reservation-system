"use client";

import { sendPasswordResetEmail, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { useState } from "react";
import { firebaseAuth, firebaseAuthReady } from "@/lib/firebase-client";

export function LoginForm() {
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
      const credential = await signInWithEmailAndPassword(firebaseAuth, email, password);
      if (!credential.user.emailVerified) {
        await signOut(firebaseAuth);
        setMessage("アカウントが利用可能になっていません。管理者へお問い合わせください。");
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

  async function requestPasswordSetup() {
    if (!email) {
      setMessage("管理者から案内されたメールアドレスを入力してください。");
      return;
    }

    setSubmitting(true);
    setMessage("");
    try {
      await firebaseAuthReady;
      await sendPasswordResetEmail(firebaseAuth, email);
      setMessage("パスワード設定メールを送信しました。メールが届かない場合は管理者へお問い合わせください。");
    } catch {
      setMessage("パスワード設定メールを送信できませんでした。管理者へお問い合わせください。");
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
        <input type="password" autoComplete="current-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required />
      </label>
      {message ? <p className="authMessage">{message}</p> : null}
      <button className="authSubmit" type="submit" disabled={submitting}>
        {submitting ? "処理中…" : "ログイン"}
      </button>
      <button className="authSecondary" type="button" disabled={submitting} onClick={requestPasswordSetup}>初回ログイン・パスワード再設定</button>
    </form>
  );
}
