"use client";

import { BookOpenText, Plus, Search, Trash2, UserRoundPen } from "lucide-react";
import { useMemo, useState } from "react";
import { DismissibleMessage } from "@/components/dismissible-message";
import { TenantLink } from "@/components/tenant-link";
import { useTenantSlug, usePermissions } from "@/components/tenant-provider";
import type { AdminCustomer, AdminCustomerDetail } from "@/lib/admin-types";
import { tenantApiPath } from "@/lib/tenant-routing";

const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });

async function responseError(response: Response) {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? `処理に失敗しました (${response.status})`;
}

export function CustomerManagement({ initialCustomers }: { initialCustomers: AdminCustomer[] }) {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  const canWrite = can("customer.write");
  const [customers, setCustomers] = useState(initialCustomers);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<AdminCustomerDetail | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return customers;
    return customers.filter((customer) =>
      [customer.name, customer.kana, customer.phone ?? "", customer.lineDisplayName ?? "", customer.memo ?? "", customer.tags.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(normalized)
    );
  }, [customers, query]);

  async function selectCustomer(customer: AdminCustomer) {
    setMessage("");
    setBusy(true);
    try {
      const response = await fetch(tenantApiPath(tenantSlug, `/admin/customers/${customer.id}`), { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      setSelected((await response.json()) as AdminCustomerDetail);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "顧客情報の取得に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function deleteCustomer() {
    if (!canWrite || busy || !selected || !window.confirm(`${selected.name}さんを削除しますか？`)) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(tenantApiPath(tenantSlug, `/admin/customers/${selected.id}`), { method: "DELETE" });
      if (!response.ok) throw new Error(await responseError(response));
      setCustomers((current) => current.filter((customer) => customer.id !== selected.id));
      setSelected(null);
      setMessage("顧客情報を削除しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "顧客情報の削除に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="customerWorkspace">
      <section className="customerListPanel">
        <div className="customerToolbar">
          <label className="searchBox wide">
            <Search size={18} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="氏名・カナ・電話・タグ・メモで検索" />
          </label>
          {canWrite ? <TenantLink className="primaryButton" href="/customers/new">
            <Plus size={17} />新規登録
          </TenantLink> : null}
        </div>
        <div className="customerRows">
          {filtered.map((customer) => (
            <button className={selected?.id === customer.id ? "customerRow isSelected" : "customerRow"} key={customer.id} type="button" onClick={() => void selectCustomer(customer)}>
              <span className="customerAvatar">{customer.name.slice(0, 1)}</span>
              <span>
                <strong>{customer.name}</strong>
                <small>{customer.kana} / {customer.phone || "電話未登録"}</small>
              </span>
              <span className="customerStats">
                <strong>{customer.visitCount}回</strong>
                {can("checkout.read") && <small>{yen.format(customer.totalSpent)}</small>}
              </span>
            </button>
          ))}
          {!filtered.length ? <p className="emptyState">該当する顧客はいません。</p> : null}
        </div>
      </section>

      <section className="customerDetailPanel">
        {message ? <DismissibleMessage message={message} onDismiss={() => setMessage("")} /> : null}
        {selected ? (
          <div className="customerDetail">
            <div className="detailPanelHeader">
              <div><span>Customer</span><h2>{selected.name}</h2><p>{selected.kana} / {selected.phone || "電話未登録"}</p></div>
              {canWrite ? <div className="adminActions">
                <TenantLink className="secondaryButton" href={"/customers/" + encodeURIComponent(selected.id) + "/edit"}><UserRoundPen size={17} />編集</TenantLink>
                <button className="dangerButton large" type="button" disabled={busy} onClick={() => void deleteCustomer()}><Trash2 size={17} />削除</button>
              </div> : null}
            </div>
            <div className="customerMetricGrid">
              <div><span>来店回数</span><strong>{selected.visitCount}回</strong></div>
              {can("checkout.read") && <div><span>会計済み累計</span><strong>{yen.format(selected.totalSpent)}</strong></div>}
              <div><span>最終来店</span><strong>{selected.lastVisitAt ? new Date(selected.lastVisitAt).toLocaleDateString("ja-JP") : "未来店"}</strong></div>
            </div>
            <div className="tagList">{selected.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
            {can("chart.read") && <article className="karteBox"><BookOpenText size={18} /><div><strong>顧客メモ</strong><p>{selected.memo || "まだ記録がありません。"}</p></div></article>}
            {can("chart.read") && <TenantLink className="secondaryButton" href={`/charts?customerId=${encodeURIComponent(selected.id)}`}>施術カルテを確認</TenantLink>}
            <h3 className="subsectionTitle">予約・来店履歴</h3>
            <div className="historyList">
              {selected.reservations.map((reservation) => (
                <article key={reservation.id}>
                  <time>{new Date(reservation.startsAt).toLocaleString("ja-JP")}</time>
                  <strong>{reservation.service.name}</strong>
                  <span>{reservation.staff?.name ?? "指名なし"} / {reservation.status}</span>
                  <em>{yen.format(reservation.service.price)}</em>
                  {can("chart.write") && <TenantLink className="miniButton" href={`/charts/new?reservationId=${encodeURIComponent(reservation.id)}`}>施術カルテ</TenantLink>}
                </article>
              ))}
              {!selected.reservations.length ? <p className="emptyState">予約履歴はありません。</p> : null}
            </div>
          </div>
        ) : (
          <div className="detailEmpty"><UserRoundPen size={42} /><h2>{busy ? "読み込み中..." : "顧客を選択してください"}</h2><p>顧客情報、カルテ、予約履歴を確認できます。</p></div>
        )}
      </section>
    </div>
  );
}
