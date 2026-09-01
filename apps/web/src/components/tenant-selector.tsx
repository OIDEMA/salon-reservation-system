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
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [salonName, setSalonName] = useState("");

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

  async function createTenant(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const response = await fetch("/api/backend/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, slug, salonName, timezone: "Asia/Tokyo" })
    });
    const result = (await response.json().catch(() => null)) as { tenant?: { id: string }; salon?: { id: string }; message?: string } | null;
    if (!response.ok || !result?.tenant || !result.salon) {
      setMessage(result?.message ?? "テナントを作成できませんでした。");
      return;
    }
    await select(result.tenant.id, result.salon.id);
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
        <section>
          <h2>最初のテナントを作成</h2>
          <form className="authForm" onSubmit={createTenant}>
            <label><span>事業者名</span><input value={name} onChange={(event) => setName(event.target.value)} required /></label>
            <label><span>テナントID</span><input value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase())} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" minLength={3} required /></label>
            <label><span>店舗名</span><input value={salonName} onChange={(event) => setSalonName(event.target.value)} required /></label>
            <button className="authSubmit" type="submit">テナントを作成</button>
          </form>
        </section>
      )}
      {message ? <p className="authMessage">{message}</p> : null}
    </div>
  );
}
