import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { ChartDetail } from "@/components/chart-detail";
import { TenantLink } from "@/components/tenant-link";
import type { ChartDetail as ChartDetailData } from "@/components/chart-types";
import { backendFetch } from "@/lib/backend";

export default async function ChartDetailPage({ params }: {
  params: Promise<{ tenantSlug: string; chartId: string }>;
}) {
  const { tenantSlug, chartId } = await params;
  const response = await backendFetch("/api/charts/" + encodeURIComponent(chartId), undefined, tenantSlug);
  if (response.status === 404) notFound();
  if (response.status === 403) return <AdminShell active="/charts" title="電子カルテ"><div className="adminContent"><p className="formMessage error" role="alert">電子カルテを閲覧する権限がありません。店舗の管理者にお問い合わせください。</p></div></AdminShell>;
  if (!response.ok) throw new Error("電子カルテを取得できませんでした。");
  const chart = await response.json() as ChartDetailData;
  return <AdminShell active="/charts" title="施術カルテ" actions={<TenantLink className="secondaryButton" href="/charts"><ArrowLeft size={17} />カルテ一覧へ</TenantLink>}>
    <div className="adminContent"><section className="adminPanel masterCreatePanel chartDetailPanel"><ChartDetail key={chart.id} initialChart={chart} /></section></div>
  </AdminShell>;
}
