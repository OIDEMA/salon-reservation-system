"use client";

import { CheckCircle2, UserCheck, UserX, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTenantSlug } from "@/components/tenant-provider";
import { tenantApiPath } from "@/lib/tenant-routing";

export function ReservationStatusActions({ reservationId }: { reservationId: string }) {
  const tenantSlug = useTenantSlug();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function update(status: string) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(tenantApiPath(tenantSlug, `/reservations/${reservationId}/status`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? "状態を更新できませんでした。");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "状態を更新できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="quickActions statusQuickActions">
        <button disabled={busy} type="button" onClick={() => void update("CONFIRMED")}><CheckCircle2 size={17} /><span>確認済み</span></button>
        <button disabled={busy} type="button" onClick={() => void update("ARRIVED")}><UserCheck size={17} /><span>来店</span></button>
        <button disabled={busy} type="button" onClick={() => void update("COMPLETED")}><CheckCircle2 size={17} /><span>施術完了</span></button>
        <button disabled={busy} type="button" onClick={() => void update("CANCELLED")}><XCircle size={17} /><span>取消</span></button>
        <button disabled={busy} type="button" onClick={() => void update("NO_SHOW")}><UserX size={17} /><span>無断</span></button>
      </div>
      {message ? <p className="formMessage error">{message}</p> : null}
    </>
  );
}
