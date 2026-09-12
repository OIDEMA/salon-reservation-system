"use client";

import { sendPasswordResetEmail } from "firebase/auth";
import Link from "next/link";
import { useState } from "react";
import { firebaseAuth, firebaseAuthReady } from "@/lib/firebase-client";

type Feedback = {
  text: string;
  tone: "error" | "success";
};

function firebaseErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
}

function localizedResetError(error: unknown) {
  switch (firebaseErrorCode(error)) {
    case "auth/invalid-email":
      return "メールアドレスの形式が正しくありません。";
    case "auth/user-not-found":
      return "このメールアドレスのアカウントが見つかりません。入力内容を確認してください。";
    case "auth/user-disabled":
      return "このアカウントは無効になっています。管理者にお問い合わせください。";
    case "auth/too-many-requests":
      return "試行回数が多すぎます。しばらく待ってから再度お試しください。";
    case "auth/network-request-failed":
      return "通信に失敗しました。ネットワーク接続を確認してください。";
    default:
      return "パスワード再設定メールを送信できませんでした。入力内容を確認して、もう一度お試しください。";
  }
}

export function PasswordResetRequestForm() {
  const [email, setEmail] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFeedback(null);

    try {
      await firebaseAuthReady;
      await sendPasswordResetEmail(firebaseAuth, email);
      setFeedback({ tone: "success", text: "パスワード再設定メールを送信しました。メールをご確認ください。" });
    } catch (error) {
      setFeedback({ tone: "error", text: localizedResetError(error) });
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
        {submitting ? "送信中…" : "リセットメールを送信"}
      </button>
      <Link className="authSecondary authActionLink" href="/login">ログイン画面へ戻る</Link>
    </form>
  );
}
