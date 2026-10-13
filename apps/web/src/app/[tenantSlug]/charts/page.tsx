import { AdminShell } from "@/components/admin-shell";
import { ChartCreateLink } from "@/components/chart-actions";
import { ChartList } from "@/components/chart-list";
import type { ChartSummary } from "@/components/chart-types";
import { backendFetch } from "@/lib/backend";

export default async function ChartsPage({ params, searchParams }: {
  params: Promise<{ tenantSlug: string }>;
  searchParams: Promise<{ customerId?: string | string[]; reservationId?: string | string[] }>;
}) {
  const { tenantSlug } = await params;
  const filters = await searchParams;
  const customerId = typeof filters.customerId === "string" ? filters.customerId : undefined;
  const reservationId = typeof filters.reservationId === "string" ? filters.reservationId : undefined;
  const query = new URLSearchParams();
  if (customerId) query.set("customerId", customerId);
  if (reservationId) query.set("reservationId", reservationId);
  const response = await backendFetch("/api/charts?" + query, undefined, tenantSlug);
  if (response.status === 403) return <AdminShell active="/charts" title="電子カルテ"><div className="adminContent"><p className="formMessage error" role="alert">電子カルテを閲覧する権限がありません。店舗の管理者にお問い合わせください。</p></div></AdminShell>;
  if (!response.ok) throw new Error("電子カルテを取得できませんでした。");
  const data = await response.json() as { charts: ChartSummary[]; nextCursor: string | null };
  const listKey = JSON.stringify([tenantSlug, customerId, reservationId, data.nextCursor, data.charts.map(({ id, version, updatedAt }) => [id, version, updatedAt])]);
  return <AdminShell active="/charts" title="電子カルテ" actions={<ChartCreateLink reservationId={reservationId} />}>
    <div className="adminContent"><ChartList key={listKey} initialCharts={data.charts} initialCursor={data.nextCursor} customerId={customerId} reservationId={reservationId} /></div>
  </AdminShell>;
}
