"use client";

import { useEffect, useState } from "react";

type Salon = { id: string; name: string; timezone: string };
type Membership = {
  role: string;
  tenant: { id: string; slug: string; name: string; salons: Salon[] };
};

export function TenantSelector() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch("/api/backend/me/tenants", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("テナント情報を取得できませんでした。");
        setMemberships((await response.json()) as Membership[]);
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "テナント情報を取得できませんでした。"))
      .finally(() => setLoading(false));
  }, []);

  async function select(tenantId: string, salonId: string) {
    setMessage("");
    const response = await fetch("/api/tenant-selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, salonId })
    });
    if (!response.ok) {
      setMessage("テナントを選択できませんでした。");
      return;
    }
    window.location.assign("/");
  }

  async function logout() {
    await fetch("/api/session", { method: "DELETE" });
    window.location.assign("/login");
  }

  if (loading) return <p className="authMessage">テナント情報を読み込んでいます…</p>;

  return (
    <div className="tenantSelector">
      {memberships.length > 0 ? (
        <section>
          <h2>利用する店舗を選択</h2>
          <div className="tenantCards">
            {memberships.flatMap((membership) =>
              membership.tenant.salons.map((salon) => (
                <button key={`${membership.tenant.id}-${salon.id}`} type="button" onClick={() => select(membership.tenant.id, salon.id)}>
                  <strong>{membership.tenant.name}</strong>
                  <span>{salon.name}</span>
                  <small>{membership.role} / {salon.timezone}</small>
                </button>
              ))
            )}
          </div>
        </section>
      ) : (
        <section className="tenantEmptyState">
          <h2>利用可能な店舗がありません</h2>
          <p>このアカウントにはテナントが割り当てられていません。管理者へお問い合わせください。</p>
          <button className="authSecondary" type="button" onClick={logout}>別のアカウントでログイン</button>
        </section>
      )}
      {message ? <p className="authMessage">{message}</p> : null}
    </div>
  );
}
