"use client";

import Link from "next/link";
import { useEffect,useState } from "react";
import styles from "./access-management.module.css";

export function AcceptInvitation() {
  const [token,setToken]=useState("");const [busy,setBusy]=useState(false);const [message,setMessage]=useState("");
  const [accepted,setAccepted]=useState<{slug:string;name:string}|null>(null);
  useEffect(()=>{setToken(new URLSearchParams(window.location.hash.slice(1)).get("token")??"");},[]);
  async function accept() {
    if(busy||accepted) return;setBusy(true);setMessage("");
    try {
      const response=await fetch("/api/backend/access/invitations/accept",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token})});
      const body=await response.json().catch(()=>null);
      if(!response.ok||!body?.accepted) throw new Error(body?.message??"招待先のメールアドレスでログインしてから、この招待リンクを開き直してください。");
      setAccepted(body.tenant);window.history.replaceState(null,"","/accept-invitation");setToken("");
    } catch(error) {setMessage(error instanceof Error?error.message:"招待を承諾できませんでした。");} finally{setBusy(false);}
  }
  return <main className={styles.accept}><h1>{accepted?"招待を承諾しました":"スタッフ招待"}</h1>
    {accepted?<><p>{accepted.name} の管理画面を利用できます。</p><Link className="primaryButton" href={`/${encodeURIComponent(accepted.slug)}`}>管理画面を開く</Link></>:<>
      <p>招待先と同じ、メール確認済みのアカウントでログインしてから承諾してください。</p>
      <Link className="secondaryButton" href="/login">ログイン画面を開く</Link><p className={styles.muted}>ログイン後、この招待リンクを開き直してください。</p>
      <button className="primaryButton" disabled={busy||!token} type="button" onClick={()=>void accept()}>{busy?"承諾中...":"招待を承諾する"}</button>
      {!token?<p>有効な招待リンクを開いてください。</p>:null}</>}
    {message?<p className={styles.error} role="alert">{message}</p>:null}
  </main>;
}
