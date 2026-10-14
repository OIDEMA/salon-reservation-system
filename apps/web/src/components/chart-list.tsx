"use client";

import { useState } from "react";
import { TenantLink } from "./tenant-link";
import { usePermissions, useTenantSlug } from "./tenant-provider";
import { tenantApiPath } from "@/lib/tenant-routing";
import { chartDate, chartResponseError, type ChartSummary } from "./chart-types";

export function ChartList({ initialCharts, initialCursor, customerId, reservationId }: {
  initialCharts: ChartSummary[]; initialCursor: string | null;
  customerId?: string; reservationId?: string;
}) {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  const [charts, setCharts] = useState(initialCharts);
  const [cursor, setCursor] = useState(initialCursor);
  const [pageStarts, setPageStarts] = useState<Array<string | null>>([null]);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function loadPage(targetPage: number) {
    if (busy || targetPage < 0 || targetPage > page + 1) return;
    const start = targetPage > page ? cursor : pageStarts[targetPage];
    if (targetPage > page && !start) return;
    setBusy(true); setMessage("");
    try {
      const query = new URLSearchParams();
      if (start) query.set("cursor", start);
      if (customerId) query.set("customerId", customerId);
      if (reservationId) query.set("reservationId", reservationId);
      const response = await fetch(tenantApiPath(tenantSlug, "/charts?" + query), { cache: "no-store" });
      if (!response.ok) throw new Error(await chartResponseError(response));
      const data = await response.json() as { charts: ChartSummary[]; nextCursor: string | null };
      setCharts(data.charts);
      setCursor(data.nextCursor);
      if (targetPage > page) setPageStarts((starts) => [...starts.slice(0, targetPage), start]);
      setPage(targetPage);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "カルテの取得に失敗しました。");
    } finally { setBusy(false); }
  }

  return (
    <section className="adminPanel chartListPanel">
      {(customerId || reservationId) ? <div className="chartFilterContext">
        <span>{customerId ? "この顧客のカルテ" : "この予約のカルテ"}</span>
        {customerId && can("customer.write") ? <TenantLink href={`/customers/${encodeURIComponent(customerId)}/edit`}>顧客情報へ</TenantLink> : null}
        {reservationId && can("reservation.write") ? <TenantLink href={`/reservations/${encodeURIComponent(reservationId)}/edit`}>予約情報へ</TenantLink> : null}
        <TenantLink href="/charts">絞り込みを解除</TenantLink>
      </div> : null}
      {charts.length ? <div className="chartTableScroll"><table className="adminTable">
        <thead><tr><th>施術日時</th><th>顧客</th><th>施術・担当者</th><th>状態</th><th>写真</th><th>最終更新</th><th><span className="chartVisuallyHidden">操作</span></th></tr></thead>
        <tbody>{charts.map((chart) => <tr key={chart.id}>
          <td>{chartDate(chart.treatmentAt, chart.timezone)}</td>
          <td>{can("customer.write") ? <TenantLink href={`/customers/${encodeURIComponent(chart.customerId)}/edit`}>{chart.customerName}</TenantLink> : chart.customerName}</td>
          <td><strong>{chart.serviceName}</strong><small>{chart.staffName ?? "担当者未指定"}</small></td>
          <td><span className={`chartStatus ${chart.status === "FINALIZED" ? "isFinalized" : "isDraft"}`}>{chart.status === "FINALIZED" ? "確定済み" : "下書き"}</span><small>第{chart.currentRevisionNumber}版</small></td>
          <td>{chart.photoCount}枚</td>
          <td>{chartDate(chart.updatedAt, chart.timezone)}</td>
          <td><TenantLink className="secondaryButton" href={`/charts/${encodeURIComponent(chart.id)}`}>開く</TenantLink></td>
        </tr>)}</tbody>
      </table></div> : <p className="emptyState">カルテはまだありません。予約を選択して作成してください。</p>}
      {message ? <p className="formMessage error" role="alert">{message}</p> : null}
      <nav className="masterToolbar" aria-label="電子カルテ一覧のページ">
        <span aria-live="polite">{busy ? "読み込み中..." : `${page + 1}ページ / ${charts.length}件`}</span>
        <div className="adminActions">
          <button type="button" className="secondaryButton" disabled={busy || page === 0} onClick={() => void loadPage(page - 1)}>前へ</button>
          <button type="button" className="secondaryButton" disabled={busy || !cursor} onClick={() => void loadPage(page + 1)}>次へ</button>
        </div>
      </nav>
    </section>
  );
}
