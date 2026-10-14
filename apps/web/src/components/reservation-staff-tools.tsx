"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { TenantLink } from "./tenant-link";
import { usePermissions } from "./tenant-provider";

export const staffRoleLabels: Record<string, string> = {
  MANAGER: "管理者", STYLIST: "施術スタッフ", ESTHETICIAN: "エステ", ASSISTANT: "補助", ROOM_RESOURCE: "設備枠"
};

export function ReservationStaffTools({ empty, disabled = false }: { empty: boolean; disabled?: boolean }) {
  const { can } = usePermissions();
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  return (
    <div className="reservationStaffTools">
      {empty ? <p role="status">選択できるスタッフがいません。有効なスタッフを登録してください。</p> : null}
      <div className="reservationStaffActions">
        {can("master.read") ? <TenantLink href="/staff" target="_blank" rel="noopener noreferrer">スタッフ一覧</TenantLink> : null}
        {can("master.write") ? <TenantLink href="/staff/new" target="_blank" rel="noopener noreferrer">スタッフを登録</TenantLink> : null}
        <button className="secondaryButton" type="button" disabled={disabled || refreshing} onClick={() => startTransition(() => router.refresh())}>
          <RefreshCw size={15} />{refreshing ? "更新中..." : "スタッフを更新"}
        </button>
      </div>
    </div>
  );
}
