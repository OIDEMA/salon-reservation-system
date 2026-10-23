"use client";

import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { firebaseAuth, firebaseAuthReady } from "@/lib/firebase-client";
import { InvitationRequestError, registerInvitation, validateInvitationRegistration, type InvitationPreview } from "@/lib/invitation-registration";
import { createBrowserSession, loginFailureMessage, SessionRequestError } from "@/lib/login-session";
import { LoginForm } from "./login-form";

export function InvitationRegistrationForm({ token, invitation, onExistingAccount, onRecoveryLogin, onBusyChange, onResolved }: {
  token: string; invitation: InvitationPreview; onExistingAccount: () => void; onRecoveryLogin: () => Promise<void>;
  onBusyChange?: (busy: boolean) => void; onResolved?: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [created, setCreated] = useState(false);
  const [uncertain, setUncertain] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || created || uncertain) return;
    const input = { token, displayName, password, confirmation };
    try { validateInvitationRegistration(input); }
    catch (error) { setMessage(error instanceof Error ? error.message : "入力内容を確認してください。"); return; }
    setBusy(true); onBusyChange?.(true); setMessage("");
    let accountCreated = false;
    try {
      await registerInvitation(input);
      accountCreated = true; setCreated(true); onResolved?.();
      window.history.replaceState(null, "", "/accept-invitation");
      setPassword(""); setConfirmation("");
      await firebaseAuthReady;
      const credential = await signInWithEmailAndPassword(firebaseAuth, invitation.email, input.password);
      if (!credential.user.emailVerified) throw new SessionRequestError("メールアドレスの確認状態を確認できません。管理者にお問い合わせください。");
      await createBrowserSession(await credential.user.getIdToken(true));
      await signOut(firebaseAuth);
      window.location.assign("/select-tenant");
    } catch (error) {
      if (error instanceof InvitationRequestError && error.code === "INVITATION_ACCOUNT_EXISTS") {
        setPassword(""); setConfirmation(""); onExistingAccount();
      } else if (!accountCreated && error instanceof InvitationRequestError && error.code === "INVITATION_REGISTRATION_UNAVAILABLE") {
        setPassword(""); setConfirmation(""); setUncertain(true); onResolved?.(); setMessage(error.message);
      } else {
        setMessage(error instanceof InvitationRequestError || error instanceof SessionRequestError ? error.message : loginFailureMessage(error));
      }
    } finally { await signOut(firebaseAuth).catch(() => undefined); setBusy(false); onBusyChange?.(false); }
  }

  if (created || uncertain) return <section>
    <p className="authMessage" role="status">{created ? "アカウント登録が完了しました。" : "登録結果の確認が必要です。"}{busy ? " ログインしています…" : " 下のフォームからログインしてください。"}</p>
    {message ? <p className="authMessage error" role="alert">{message}</p> : null}
    {!busy ? <LoginForm initialEmail={invitation.email} onAuthenticated={uncertain ? onRecoveryLogin : undefined} /> : null}
  </section>;

  return <form className="authForm" onSubmit={submit}>
    <label><span>メールアドレス（招待先）</span><input type="email" value={invitation.email} readOnly autoComplete="username" /></label>
    <label><span>お名前</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" maxLength={100} required disabled={busy} /></label>
    <label><span>パスワード</span><div className="passwordInput">
      <input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} maxLength={128} required disabled={busy} aria-describedby="invitation-password-help" />
      <button type="button" className="passwordToggle" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "パスワードを隠す" : "パスワードを表示"} aria-pressed={showPassword}>
        {showPassword ? <EyeOff size={19} aria-hidden="true" /> : <Eye size={19} aria-hidden="true" />}
      </button>
    </div></label>
    <p id="invitation-password-help" className="authMessage">8〜128文字で設定してください。</p>
    <label><span>パスワード（確認）</span><input type={showPassword ? "text" : "password"} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" minLength={8} maxLength={128} required disabled={busy} /></label>
    {message ? <p className="authMessage error" role="alert">{message}</p> : null}
    <button className="authSubmit" type="submit" disabled={busy}>{busy ? "登録しています…" : "アカウントを登録してログイン"}</button>
  </form>;
}
