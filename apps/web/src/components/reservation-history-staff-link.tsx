"use client";

import { Link2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReservationHistoryStaffLinkPlan, ReservationHistoryStaffLinkResult } from "@/lib/admin-types";
import { applyHistoryStaffLinks, canLinkHistoryStaff, prepareHistoryStaffLinks } from "@/lib/history-staff-link";
import { usePermissions, useTenantSlug } from "./tenant-provider";
import { TenantLink } from "./tenant-link";

export function ReservationHistoryStaffLinkLink() {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  if (!canLinkHistoryStaff(tenantSlug, can)) return null;
  return <TenantLink className="secondaryButton" href="/reservations/history/staff-link"><Link2 size={17} />担当の紐付け</TenantLink>;
}

export function ReservationHistoryStaffLinkPreview({ plan }: { plan: ReservationHistoryStaffLinkPlan }) {
  return <>
    <dl className="historyStaffLinkCounts">
      <div><dt>予約履歴</dt><dd>{plan.totalCount.toLocaleString("ja-JP")}件</dd></div>
      <div><dt>紐付け済み</dt><dd>{plan.linkedCount.toLocaleString("ja-JP")}件</dd></div>
      <div><dt>未紐付け</dt><dd>{plan.pendingCount.toLocaleString("ja-JP")}件</dd></div>
    </dl>
    <p className="historyContext">過去の担当者は、予約受付を停止した状態で登録します。</p>
    <div className="historyRawScroll"><table className="adminTable historyStaffLinkTable">
      <thead><tr><th>移行元の担当</th><th>紐付け先</th><th>件数</th><th>登録内容</th><th>予約受付</th></tr></thead>
      <tbody>{plan.groups.map((group) => <tr key={group.key}>
        <td>{group.sourceStaffName || "担当名なし"}</td>
        <td>{group.staffName || group.sourceStaffName || "担当名なし"}</td>
        <td>{group.count.toLocaleString("ja-JP")}件</td>
        <td>{group.action === "CREATE_INACTIVE" ? "履歴用に登録" : "登録済みの担当に紐付け"}</td>
        <td>{group.active ? "受付中" : "受付停止"}</td>
      </tr>)}</tbody>
    </table></div>
    {plan.issues.length ? <ul className="formMessage error" role="alert">{plan.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul> : null}
  </>;
}

export function ReservationHistoryStaffLink() {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  const allowed = canLinkHistoryStaff(tenantSlug, can);
  const [plan, setPlan] = useState<ReservationHistoryStaffLinkPlan | null>(null);
  const [result, setResult] = useState<ReservationHistoryStaffLinkResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!allowed) return;
    const current = new AbortController(); controller.current = current;
    setBusy(true); setMessage("");
    prepareHistoryStaffLinks(tenantSlug, current.signal)
      .then((data) => { if (!current.signal.aborted) setPlan(data); })
      .catch((error) => { if (!current.signal.aborted) setMessage(error instanceof Error ? error.message : "担当の紐付けを確認できませんでした。"); })
      .finally(() => { if (!current.signal.aborted) setBusy(false); });
    return () => { current.abort(); controller.current?.abort(); };
  }, [allowed, tenantSlug]);

  if (!allowed) return <p className="formMessage error" role="alert">担当の紐付けには、マスタ・予約・電子カルテの編集権限が必要です。</p>;

  async function apply() {
    if (!plan?.ready || !plan.pendingCount || busy) return;
    const current = new AbortController(); controller.current?.abort(); controller.current = current;
    setBusy(true); setMessage("");
    try {
      const applied = await applyHistoryStaffLinks(tenantSlug, plan.checksum, current.signal);
      if (current.signal.aborted) return;
      setResult(applied);
      const nextPlan = await prepareHistoryStaffLinks(tenantSlug, current.signal);
      if (!current.signal.aborted) setPlan(nextPlan);
    } catch (error) {
      if (!current.signal.aborted) {
        setMessage(error instanceof Error ? error.message : "担当の紐付けを反映できませんでした。");
        try { const nextPlan = await prepareHistoryStaffLinks(tenantSlug, current.signal); if (!current.signal.aborted) setPlan(nextPlan); }
        catch { if (!current.signal.aborted) setPlan(null); }
      }
    } finally { if (!current.signal.aborted) setBusy(false); }
  }

  return <section aria-busy={busy}>
    {message ? <p className="formMessage error" role="alert">{message}</p> : null}
    {result?.completed ? <p className="formMessage success" role="status">予約履歴{result.linkedCount.toLocaleString("ja-JP")}件を担当に紐付けました。履歴用の担当・管理枠を{result.createdStaffCount}件追加しました（受付停止）。</p> : null}
    {plan ? <ReservationHistoryStaffLinkPreview plan={plan} /> : <p>{busy ? "担当と予約履歴を確認しています..." : "担当の紐付けを確認できませんでした。ページを更新してください。"}</p>}
    {plan ? <div className="adminActions historyStaffLinkActions">
      <button className="primaryButton" type="button" disabled={busy || !plan.ready || !plan.pendingCount} onClick={() => void apply()}>
        <Link2 size={17} />{busy ? "処理中..." : plan.pendingCount ? "担当の紐付けを反映" : "紐付け完了"}
      </button>
      <TenantLink className="secondaryButton" href="/reservations/history">予約履歴一覧へ</TenantLink>
    </div> : null}
  </section>;
}
