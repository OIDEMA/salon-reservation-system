"use client";

import { confirmPasswordReset, verifyPasswordResetCode } from "firebase/auth";
import Link from "next/link";
import { useEffect, useState } from "react";
import { firebaseAuth, firebaseAuthReady } from "@/lib/firebase-client";

type AuthActionFormProps = {
  mode?: string;
  oobCode?: string;
};

type ActionState = "loading" | "ready" | "error" | "success";

function firebaseErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
}

function localizedActionError(error: unknown) {
  switch (firebaseErrorCode(error)) {
    case "auth/expired-action-code":
      return "このパスワード設定リンクの有効期限が切れています。ログイン画面から再度お試しください。";
    case "auth/invalid-action-code":
      return "このパスワード設定リンクは無効か、すでに使用されています。ログイン画面から再度お試しください。";
    case "auth/user-disabled":
      return "このアカウントは無効になっています。管理者にお問い合わせください。";
    case "auth/weak-password":
      return "パスワードは8文字以上で入力してください。";
    case "auth/network-request-failed":
      return "通信に失敗しました。ネットワーク接続を確認してください。";
    default:
      return "パスワードを設定できませんでした。リンクを確認して、もう一度お試しください。";
  }
}

export function AuthActionForm({ mode, oobCode }: AuthActionFormProps) {
  const [email, setEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [state, setState] = useState<ActionState>("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;

    async function verifyAction() {
      if (mode !== "resetPassword" || !oobCode) {
        if (active) {
          setState("error");
          setMessage("パスワード設定リンクが正しくありません。ログイン画面から再度お試しください。");
        }
        return;
      }

      try {
        await firebaseAuthReady;
        const accountEmail = await verifyPasswordResetCode(firebaseAuth, oobCode);
        if (active) {
          setEmail(accountEmail);
          setState("ready");
        }
      } catch (error) {
        if (active) {
          setState("error");
          setMessage(localizedActionError(error));
        }
      }
    }

    void verifyAction();
    return () => {
      active = false;
    };
  }, [mode, oobCode]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!oobCode) return;

    if (newPassword.length < 8) {
      setState("error");
      setMessage("パスワードは8文字以上で入力してください。");
      return;
    }
    if (newPassword !== confirmation) {
      setState("error");
      setMessage("確認用パスワードが一致していません。");
      return;
    }

    setState("loading");
    setMessage("");
    try {
      await firebaseAuthReady;
      await confirmPasswordReset(firebaseAuth, oobCode, newPassword);
      setState("success");
      setMessage("パスワードを設定しました。ログイン画面からログインしてください。");
    } catch (error) {
      setState("error");
      setMessage(localizedActionError(error));
    }
  }

  if (state === "loading") {
    return <p className="authMessage">パスワード設定リンクを確認しています…</p>;
  }

  if (state === "error") {
    return (
      <>
        <p className="authMessage error" role="alert">{message}</p>
        <Link className="authSecondary authActionLink" href="/login">ログイン画面へ戻る</Link>
      </>
    );
  }

  if (state === "success") {
    return (
      <>
        <p className="authMessage success" role="status">{message}</p>
        <Link className="authSubmit authActionLink" href="/login">ログイン画面へ</Link>
      </>
    );
  }

  return (
    <form className="authForm authActionForm" onSubmit={submit}>
      <p className="authActionAccount">{email}</p>
      <label>
        <span>新しいパスワード</span>
        <input
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          required
        />
      </label>
      <label>
        <span>新しいパスワード（確認）</span>
        <input
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          required
        />
      </label>
      {message ? <p className="authMessage error" role="alert">{message}</p> : null}
      <button className="authSubmit" type="submit">パスワードを設定する</button>
    </form>
  );
}
