"use client";

import { UserRound } from "lucide-react";
import { useTenant } from "@/components/tenant-provider";
import { TenantSwitcher } from "@/components/tenant-switcher";

export function TenantAccountControls() {
  const { currentUser } = useTenant();
  const name = currentUser?.displayName?.trim();
  const email = currentUser?.email?.trim();

  return (
    <div className="tenantAccountControls">
      <TenantSwitcher />
      {currentUser ? (
        <div className="loginUser" aria-label="ログインユーザー" title={[name, email].filter(Boolean).join("\n")}>
          <span className="loginUserIcon"><UserRound aria-hidden="true" size={18} /></span>
          <div className="loginUserDetails">
            <strong>{name || email || "ログイン中"}</strong>
            {name && email && name !== email ? <span>{email}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
