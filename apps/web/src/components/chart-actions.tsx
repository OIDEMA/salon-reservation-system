"use client";

import { Plus } from "lucide-react";
import { TenantLink } from "./tenant-link";
import { usePermissions } from "./tenant-provider";

export function ChartCreateLink({ reservationId }: { reservationId?: string }) {
  const { can } = usePermissions();
  if (!can("chart.write")) return null;
  const href = reservationId ? `/charts/new?reservationId=${encodeURIComponent(reservationId)}` : "/charts/new";
  return <TenantLink className="primaryButton" href={href}><Plus size={17} />カルテを作成</TenantLink>;
}
