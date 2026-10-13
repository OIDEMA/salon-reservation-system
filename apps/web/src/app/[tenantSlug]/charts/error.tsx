"use client";

import { AdminShell } from "@/components/admin-shell";
import { TenantLink } from "@/components/tenant-link";

export default function ChartError({ reset }: { reset: () => void }) {
  return <AdminShell active="/charts" title="電子カルテ"><div className="adminContent"><section className="adminPanel masterCreatePanel"><p className="formMessage error" role="alert">カルテを読み込めませんでした。通信状況を確認して再度お試しください。</p><div className="chartInlineActions"><button type="button" className="secondaryButton" onClick={reset}>再読み込み</button><TenantLink className="secondaryButton" href="/charts">カルテ一覧へ</TenantLink></div></section></div></AdminShell>;
}
