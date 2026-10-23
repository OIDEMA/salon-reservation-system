"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { invitationErrors, invitationTokenFromHash, previewInvitation, type InvitationPreview } from "@/lib/invitation-registration";
import { InvitationRegistrationForm } from "./invitation-registration-form";
import { LoginForm } from "./login-form";

const roleLabels: Record<InvitationPreview["role"], string> = { OWNER: "オーナー", ADMIN: "管理者", MANAGER: "店舗責任者", STAFF: "スタッフ", VIEWER: "閲覧のみ" };

export function AcceptInvitation() {
  const [token, setToken] = useState("");
  const [invitation, setInvitation] = useState<InvitationPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [registrationBusy, setRegistrationBusy] = useState(false);
  const [registrationResolved, setRegistrationResolved] = useState(false);
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<"register" | "login">("register");
  const [accepted, setAccepted] = useState<{ slug: string; name: string } | null>(null);

  useEffect(() => {
    let controller: AbortController;
    function load() {
      controller?.abort(); controller = new AbortController();
      const current = invitationTokenFromHash(window.location.hash);
      setToken(current); setInvitation(null); setMessage(""); setLoading(Boolean(current));
      if (!current) return;
      const signal = controller.signal;
      void previewInvitation(current, signal).then((value) => {
        if (signal.aborted) return;
        setInvitation(value); setMode(value.alreadyRegistered ? "login" : "register");
      }).catch((error) => {
        if (!signal.aborted) setMessage(error instanceof Error ? error.message : "招待を確認できませんでした。");
      }).finally(() => { if (!signal.aborted) setLoading(false); });
    }
    load(); window.addEventListener("hashchange", load);
    return () => { controller.abort(); window.removeEventListener("hashchange", load); };
  }, []);

  async function accept() {
    if (busy || accepted || !invitation) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/backend/access/invitations/accept", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }), cache: "no-store", redirect: "error" });
      const body = await response.json().catch(() => null);
      let completed = response.ok && body?.accepted === true && body?.tenant?.slug === invitation.tenant.slug;
      // A successful registration whose response was lost may already have
      // consumed this token. Confirm actual membership after login, never infer it.
      if (!completed && [409, 410].includes(response.status)) {
        const memberships = await fetch("/api/backend/me/tenants", { cache: "no-store", redirect: "error" });
        const values = await memberships.json().catch(() => null);
        completed = memberships.ok && Array.isArray(values) && values.some((value) => value?.tenant?.id === invitation.tenant.id && value?.tenant?.slug === invitation.tenant.slug);
      }
      if (!completed) {
        const code = body?.code;
        if (typeof code === "string" && Object.hasOwn(invitationErrors, code)) setMessage(invitationErrors[code as keyof typeof invitationErrors].message);
        else setMessage("招待先のメールアドレスでログインしてから、招待を承諾してください。");
        return;
      }
      setAccepted(invitation.tenant); window.history.replaceState(null, "", "/accept-invitation"); setToken("");
    } catch { setMessage("招待先のメールアドレスでログインしてから、招待を承諾してください。"); }
    finally { setBusy(false); }
  }

  return <main className="authPage"><section className="authCard">
    <h1>{accepted ? "招待を承諾しました" : "スタッフ招待"}</h1>
    {accepted ? <><p>{accepted.name} の管理画面を利用できます。</p><Link className="primaryButton" href="/select-tenant">利用する店舗を選ぶ</Link></> : <>
      {loading ? <p role="status">招待を確認しています…</p> : null}
      {!loading && !token ? <p>メールに記載された有効な招待リンクを開いてください。</p> : null}
      {invitation ? <>
        <p>{invitation.tenant.name} の「{roleLabels[invitation.role]}」として招待されています。</p>
        <p>招待先: {invitation.email}</p>
        {!invitation.alreadyRegistered && !registrationResolved ? <div className="authTabs" aria-label="アカウントの利用方法">
          <button type="button" className={mode === "register" ? "isActive" : ""} aria-pressed={mode === "register"} disabled={registrationBusy} onClick={() => setMode("register")}>新規登録</button>
          <button type="button" className={mode === "login" ? "isActive" : ""} aria-pressed={mode === "login"} disabled={registrationBusy} onClick={() => setMode("login")}>ログイン</button>
        </div> : invitation.alreadyRegistered ? <p>登録済みのアカウントでログインすると、招待を承諾できます。</p> : null}
        {mode === "register" && !invitation.alreadyRegistered ? <InvitationRegistrationForm token={token} invitation={invitation} onRecoveryLogin={accept} onBusyChange={setRegistrationBusy} onResolved={() => setRegistrationResolved(true)} onExistingAccount={() => {
          setInvitation({ ...invitation, alreadyRegistered: true }); setMode("login"); setMessage(invitationErrors.INVITATION_ACCOUNT_EXISTS.message);
        }} /> : <><LoginForm initialEmail={invitation.email} onAuthenticated={accept} />
          <button className="authSecondary" type="button" disabled={busy} onClick={() => void accept()}>{busy ? "承諾中…" : "ログイン済みのアカウントで招待を承諾"}</button>
        </>}
      </> : null}
      {!loading && !invitation ? <Link className="authResetLink" href="/login">ログイン画面を開く</Link> : null}
    </>}
    {message ? <p className="authMessage error" role="alert">{message}</p> : null}
  </section></main>;
}
