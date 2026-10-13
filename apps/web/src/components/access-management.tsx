"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TenantLink } from "@/components/tenant-link";
import { useTenantSlug } from "@/components/tenant-provider";
import { tenantApiPath, tenantPath } from "@/lib/tenant-routing";
import styles from "./access-management.module.css";

export const capabilityLabels: Record<string, string> = {
  "reservation.read": "予約の閲覧", "reservation.write": "予約の登録・変更",
  "customer.read": "顧客の閲覧", "customer.write": "顧客の登録・変更",
  "master.read": "スタッフ・メニュー・設備の閲覧", "master.write": "スタッフ・メニュー・設備の変更",
  "settings.read": "設定の閲覧", "settings.write": "設定の変更",
  "checkout.read": "会計の閲覧", "checkout.write": "会計の確定", "checkout.refund": "返金処理",
  "register.read": "レジの閲覧", "register.close": "レジ締め",
  "chart.read": "カルテの閲覧", "chart.write": "カルテの記録", "access.manage": "スタッフ権限の管理", "audit.read": "操作履歴の閲覧"
};
export const roleLabels: Record<string, string> = { OWNER: "オーナー", ADMIN: "管理者", MANAGER: "店舗責任者", STAFF: "スタッフ", VIEWER: "閲覧のみ" };
const readPermissions = Object.keys(capabilityLabels).filter((permission) => permission.endsWith(".read") && permission !== "audit.read");
const defaults: Record<string, string[]> = {
  OWNER: Object.keys(capabilityLabels), ADMIN: Object.keys(capabilityLabels),
  MANAGER: Object.keys(capabilityLabels).filter((permission) => permission !== "access.manage"),
  STAFF: [...readPermissions, "reservation.write", "customer.write", "checkout.write", "chart.write"], VIEWER: readPermissions
};

export type AccessMember = { userId: string; role: string; status: string; useCustomPermissions: boolean; permissions: string[]; effectivePermissions: string[]; salonIds: string[]; user: { id: string; email: string | null; displayName: string | null; disabled: boolean } };
type Invitation = { id: string; email: string; role: string; expiresAt: string; acceptedAt: string | null; revokedAt: string | null };
export type AccessData = { actorUserId: string; actorRole: string; actorPermissions: string[]; actorSalonIds: string[]; salons: Array<{ id: string; name: string }>; members: AccessMember[]; invitations: Invitation[] };
export type AuditData = { records: Array<{ id: string; createdAt: string; action: string; resource: string; resourceId: string | null; ipAddress: string | null; actor: { displayName: string | null; email: string | null } | null }>; nextCursor: string | null };

async function responseBody(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message ?? "処理に失敗しました。");
  return body;
}

export function AccessManagement({ data }: { data: AccessData }) {
  const tenantSlug = useTenantSlug();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function revoke(invitation: Invitation) {
    if (busy || !window.confirm(`${invitation.email} 宛の招待を取り消しますか？`)) return;
    setBusy(true); setMessage("");
    try { await responseBody(await fetch(tenantApiPath(tenantSlug, `/access/invitations/${encodeURIComponent(invitation.id)}`), { method: "DELETE" })); router.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "取消に失敗しました。"); }
    finally { setBusy(false); }
  }
  return <div className={styles.stack}>
    <div className={styles.toolbar}><TenantLink className="primaryButton" href="/access/invitations/new">スタッフを招待</TenantLink>
      {data.actorPermissions.includes("audit.read") ? <TenantLink className="secondaryButton" href="/access/audit">操作履歴</TenantLink> : null}</div>
    {message ? <p role="alert" className={styles.error}>{message}</p> : null}
    <section className="adminPanel"><h2>ログインできるスタッフ</h2><p className={styles.muted}>施術担当の名簿とは別に、管理画面へのログインと操作権限を設定します。</p>
      <div className={styles.scroll}><table className={styles.table}><thead><tr><th>スタッフ</th><th>役割・状態</th><th>利用できる店舗</th><th>操作</th></tr></thead><tbody>
        {data.members.map((member) => <tr key={member.userId}><td>{member.user.displayName || member.user.email || "名前未登録"}<br /><span className={styles.muted}>{member.user.email}</span></td>
          <td>{roleLabels[member.role]}<br /><span className={styles.muted}>{member.status === "ACTIVE" && !member.user.disabled ? "利用中" : "利用停止"}</span></td>
          <td>{member.role === "OWNER" || !member.salonIds.length ? "全店舗" : member.salonIds.map((id) => data.salons.find((salon) => salon.id === id)?.name ?? "範囲外の店舗").join("・")}</td>
          <td>{member.userId === data.actorUserId ? "自分" : member.role === "OWNER" && data.actorRole !== "OWNER" ? "オーナーが管理" : <TenantLink className="miniButton" href={`/access/members/${encodeURIComponent(member.userId)}/edit`}>権限を編集</TenantLink>}</td></tr>)}
      </tbody></table></div></section>
    <section className="adminPanel"><h2>招待履歴</h2><div className={styles.scroll}><table className={styles.table}><thead><tr><th>招待先</th><th>役割</th><th>有効期限</th><th>状態</th></tr></thead><tbody>
      {data.invitations.map((invitation) => <tr key={invitation.id}><td>{invitation.email}</td><td>{roleLabels[invitation.role]}</td><td>{new Date(invitation.expiresAt).toLocaleString("ja-JP")}</td>
        <td>{invitation.acceptedAt ? "承諾済み" : invitation.revokedAt ? "取消済み" : new Date(invitation.expiresAt) <= new Date() ? "期限切れ" : <button className="miniButton" type="button" disabled={busy} onClick={() => void revoke(invitation)}>招待を取り消す</button>}</td></tr>)}
    </tbody></table></div>{!data.invitations.length ? <p className={styles.muted}>招待はありません。</p> : null}</section>
  </div>;
}

export function AccessAssignmentForm({ data, member }: { data: AccessData; member?: AccessMember }) {
  const tenantSlug = useTenantSlug(); const router = useRouter();
  const [role, setRole] = useState(member?.role ?? "STAFF");
  const [status, setStatus] = useState(member?.status ?? "ACTIVE");
  const [custom, setCustom] = useState(member?.useCustomPermissions ?? false);
  const [permissions, setPermissions] = useState(member?.permissions ?? defaults.STAFF);
  const [salonIds, setSalonIds] = useState<string[]>(member?.salonIds ?? data.actorSalonIds);
  const [email, setEmail] = useState(""); const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [inviteLink, setInviteLink] = useState("");
  const self = member?.userId === data.actorUserId;
  const basePermissions = role === "OWNER" ? defaults.OWNER : custom ? permissions : defaults[role];
  const permitted = role === "VIEWER" ? basePermissions.filter((permission)=>permission.endsWith(".read")) : basePermissions;
  const checkedPermissions = [...new Set(permitted.flatMap((permission)=>[permission,
    permission.endsWith(".write") ? permission.replace(/\.write$/, ".read") : permission==="checkout.refund" ? "checkout.read" : permission==="register.close" ? "register.read" : permission]))];
  function toggle(values: string[], value: string) { return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]; }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || self || inviteLink) return; setBusy(true); setMessage("");
    try {
      const assignment = { role, useCustomPermissions: role === "OWNER" ? false : custom, permissions: custom ? permissions : [], salonIds: role === "OWNER" ? [] : salonIds };
      const body = await responseBody(await fetch(tenantApiPath(tenantSlug, member ? `/access/members/${encodeURIComponent(member.userId)}` : "/access/invitations"), {
        method: member ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(member ? { ...assignment, status } : { ...assignment, email, expiresInDays: days })
      }));
      if (member) { router.push(tenantPath(tenantSlug, "/access")); router.refresh(); }
      else setInviteLink(new URL(body.acceptPath, window.location.origin).href);
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存に失敗しました。"); }
    finally { setBusy(false); }
  }
  async function copyLink() { try { await navigator.clipboard.writeText(inviteLink); setMessage("招待リンクをコピーしました。"); } catch { setMessage("リンクを選択してコピーしてください。"); } }
  return <form className="masterCreateForm" onSubmit={save}>
    {message ? <p role="status">{message}</p> : null}
    {self ? <p className={styles.error}>自分の権限は変更できません。他のオーナーに依頼してください。</p> : null}
    <fieldset disabled={busy || self || !!inviteLink} className={styles.fieldset}>
      {!member ? <><label className={styles.field}><span>招待先メールアドレス</span><input type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label className={styles.field}><span>招待の有効期間</span><select value={days} onChange={(event) => setDays(Number(event.target.value))}>{[1,3,7].map((value) => <option key={value} value={value}>{value}日間</option>)}</select></label></> : <p>{member.user.displayName || member.user.email}</p>}
      <label className={styles.field}><span>役割</span><select value={role} onChange={(event) => { setRole(event.target.value); setCustom(false); setPermissions(defaults[event.target.value]); }}>
        {Object.entries(roleLabels).filter(([value]) => data.actorRole === "OWNER" || value !== "OWNER").map(([value,label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      {member ? <label className={styles.field}><span>利用状態</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="ACTIVE">利用中</option><option value="SUSPENDED">利用停止</option></select></label> : null}
      <div><h3>利用できる店舗</h3>{role === "OWNER" ? <p className={styles.muted}>オーナーは全店舗を利用できます。</p> : <>
        <label className={styles.check}><input type="checkbox" checked={!salonIds.length} disabled={data.actorRole !== "OWNER" && !!data.actorSalonIds.length} onChange={(event) => setSalonIds(event.target.checked ? [] : data.salons.map((salon) => salon.id))} />全店舗</label>
        <div className={styles.checks}>{data.salons.map((salon) => <label key={salon.id} className={styles.check}><input type="checkbox" checked={!salonIds.length || salonIds.includes(salon.id)} onChange={() => {
          const current = salonIds.length ? salonIds : data.salons.map((item) => item.id); const next = toggle(current,salon.id); if (next.length) setSalonIds(next);
        }} />{salon.name}</label>)}</div><p className={styles.muted}>少なくとも1店舗を選択してください。</p></> }</div>
      <div><h3>操作できる機能</h3><label className={styles.check}><input type="checkbox" checked={custom} disabled={role === "OWNER"} onChange={(event) => { setCustom(event.target.checked); if (event.target.checked) setPermissions(defaults[role].filter((permission) => data.actorPermissions.includes(permission))); }} />操作権限を個別に設定</label>
        <div className={styles.checks}>{Object.entries(capabilityLabels).map(([permission,label]) => <label key={permission} className={styles.check}><input type="checkbox" checked={checkedPermissions.includes(permission)}
          disabled={!custom || role === "OWNER" || !data.actorPermissions.includes(permission) || permission === "access.manage" && role !== "ADMIN" || role === "VIEWER" && !permission.endsWith(".read")}
          onChange={() => setPermissions(toggle(permissions,permission))} />{label}</label>)}</div>
        <p className={styles.muted}>変更・返金・レジ締めを許可すると、同じ機能の閲覧も許可されます。オーナーは常にすべての権限を持ちます。</p></div>
    </fieldset>
    {inviteLink ? <div className={styles.linkBox}><strong>招待リンクを発行しました</strong><p className={styles.muted}>このリンクを招待先の本人に渡してください。同じ確認済みメールアドレスでログインすると一度だけ承諾できます。</p>
      <label className={styles.field}><span>招待リンク</span><textarea readOnly rows={3} value={inviteLink} onFocus={(event) => event.target.select()} /></label><button className="secondaryButton" type="button" onClick={() => void copyLink()}>リンクをコピー</button></div> : null}
    <div className="masterCreateActions"><TenantLink className="secondaryButton" href="/access" onClick={(event) => { if (busy) event.preventDefault(); }}>{inviteLink ? "一覧へ戻る" : "キャンセル"}</TenantLink>
      {!inviteLink ? <button className="primaryButton" type="submit" disabled={busy || self}>{busy ? "保存中..." : member ? "権限を保存" : "招待リンクを発行"}</button> : null}</div>
  </form>;
}

export function AuditManagement({ initialData }: { initialData: AuditData }) {
  const tenantSlug = useTenantSlug(); const [data,setData] = useState(initialData); const [action,setAction] = useState(""); const [busy,setBusy] = useState(false); const [message,setMessage] = useState("");
  async function load(more: boolean) {
    if (busy) return; setBusy(true); setMessage("");
    try { const query = new URLSearchParams(); if(action.trim()) query.set("action",action.trim()); if(more && data.nextCursor) query.set("cursor",data.nextCursor);
      const next = await responseBody(await fetch(`${tenantApiPath(tenantSlug,"/access/audit")}?${query}`,{cache:"no-store"})) as AuditData;
      setData(more ? {...next,records:[...data.records,...next.records]} : next);
    } catch(error) { setMessage(error instanceof Error ? error.message : "取得に失敗しました。"); } finally {setBusy(false);}
  }
  return <section className="adminPanel"><div className={styles.toolbar}><label className={styles.field}><span>操作名で検索</span><input value={action} maxLength={120} onChange={(event)=>setAction(event.target.value)} placeholder="例: checkout、reservation" /></label><button className="primaryButton" type="button" disabled={busy} onClick={()=>void load(false)}>検索</button></div>
    {message ? <p role="alert">{message}</p> : null}<p className={styles.muted}>操作者・操作内容・対象・日時を確認できます。</p>
    <div className={styles.scroll}><table className={styles.table}><thead><tr><th>日時</th><th>操作者</th><th>操作</th><th>対象</th><th>接続元</th></tr></thead><tbody>{data.records.map((record)=><tr key={record.id}><td>{new Date(record.createdAt).toLocaleString("ja-JP")}</td><td>{record.actor?.displayName || record.actor?.email || "システム"}</td><td>{record.action}</td><td>{record.resource}<br/><span className={styles.muted}>{record.resourceId}</span></td><td>{record.ipAddress || "—"}</td></tr>)}</tbody></table></div>
    {!data.records.length ? <p className={styles.muted}>該当する操作履歴はありません。</p> : null}{data.nextCursor ? <button className="secondaryButton" type="button" disabled={busy} onClick={()=>void load(true)}>続きを表示</button> : null}
  </section>;
}
