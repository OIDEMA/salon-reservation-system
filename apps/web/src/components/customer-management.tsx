"use client";

import { BookOpenText, Plus, Search, Trash2, UserRoundPen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DismissibleMessage } from "@/components/dismissible-message";
import { TenantLink } from "@/components/tenant-link";
import { useTenantSlug, usePermissions } from "@/components/tenant-provider";
import type { AdminCustomerPage, AdminCustomerSummary, AdminCustomerDetail } from "@/lib/admin-types";
import { tenantApiPath } from "@/lib/tenant-routing";
import { CustomerSourceProfiles, type CustomerImportedProfile } from "./customer-source-profile";

const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });

async function responseError(response: Response) {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? `処理に失敗しました (${response.status})`;
}

export function CustomerManagement({ initialPage }: { initialPage: AdminCustomerPage }) {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  const canWrite = can("customer.write");
  const [customerPage, setCustomerPage] = useState(initialPage);
  const [requestedPage, setRequestedPage] = useState(initialPage.page);
  const [listBusy, setListBusy] = useState(false);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const detailRequestSequence = useRef(0);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<(AdminCustomerDetail & { importedProfiles?: CustomerImportedProfile[] }) | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setListBusy(true);
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ page: String(requestedPage), pageSize: String(initialPage.pageSize) });
        if (query.trim()) params.set("q", query.trim());
        const response = await fetch(tenantApiPath(tenantSlug, `/admin/customers/page?${params}`), {
          cache: "no-store", signal: controller.signal
        });
        if (!response.ok) throw new Error(await responseError(response));
        const nextPage = await response.json() as AdminCustomerPage;
        if (controller.signal.aborted) return;
        setCustomerPage(nextPage);
        setRequestedPage(nextPage.page);
      } catch (error) {
        if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "顧客一覧の取得に失敗しました。");
      } finally {
        if (!controller.signal.aborted) setListBusy(false);
      }
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, requestedPage, tenantSlug, initialPage.pageSize, refreshSequence]);

  function searchCustomers(value: string) {
    setQuery(value);
    setRequestedPage(1);
  }

  async function selectCustomer(customer: AdminCustomerSummary) {
    const requestSequence = ++detailRequestSequence.current;
    setMessage("");
    setBusy(true);
    try {
      const response = await fetch(tenantApiPath(tenantSlug, `/admin/customers/${customer.id}`), { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const detail = await response.json() as AdminCustomerDetail & { importedProfiles?: CustomerImportedProfile[] };
      if (requestSequence === detailRequestSequence.current) setSelected(detail);
    } catch (error) {
      if (requestSequence === detailRequestSequence.current) setMessage(error instanceof Error ? error.message : "顧客情報の取得に失敗しました。");
    } finally {
      if (requestSequence === detailRequestSequence.current) setBusy(false);
    }
  }

  async function deleteCustomer() {
    if (!canWrite || busy || !selected || !window.confirm(`${selected.name}さんを削除しますか？`)) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(tenantApiPath(tenantSlug, `/admin/customers/${selected.id}`), { method: "DELETE" });
      if (!response.ok) throw new Error(await responseError(response));
      setRefreshSequence((current) => current + 1);
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
            <input value={query} onChange={(event) => searchCustomers(event.target.value)} maxLength={100} placeholder={can("chart.read") ? "氏名・カナ・電話・タグ・メモで検索" : "氏名・カナ・電話・タグで検索"} />
          </label>
          {canWrite ? <TenantLink className="primaryButton" href="/customers/new">
            <Plus size={17} />新規登録
          </TenantLink> : null}
          {tenantSlug === "missmrs-takamatsu" && canWrite && can("chart.write") ? <TenantLink className="secondaryButton" href="/customers/import">顧客データを取り込む</TenantLink> : null}
        </div>
        <nav className="masterToolbar" aria-label="顧客一覧のページ">
          <span aria-live="polite">{listBusy ? "検索中..." : `${customerPage.total.toLocaleString("ja-JP")}件 / ${customerPage.page} / ${customerPage.totalPages}ページ`}</span>
          <div className="adminActions">
            <button className="secondaryButton" type="button" disabled={listBusy || customerPage.page <= 1} onClick={() => setRequestedPage(customerPage.page - 1)}>前へ</button>
            <button className="secondaryButton" type="button" disabled={listBusy || customerPage.page >= customerPage.totalPages} onClick={() => setRequestedPage(customerPage.page + 1)}>次へ</button>
          </div>
        </nav>
        <div className="customerRows" aria-busy={listBusy}>
          {customerPage.customers.map((customer) => (
            <button className={selected?.id === customer.id ? "customerRow isSelected" : "customerRow"} key={customer.id} type="button" disabled={listBusy} onClick={() => void selectCustomer(customer)}>
              <span className="customerAvatar">{customer.name.slice(0, 1)}</span>
              <span>
                <strong>{customer.name}</strong>
                <small>{customer.kana} / {customer.phone || "電話未登録"}</small>
              </span>
              <span className="customerStats">
                <strong>{customer.visitCount}回</strong>
                {can("checkout.read") && <small>{yen.format(customer.totalSpent ?? 0)}</small>}
              </span>
            </button>
          ))}
          {!listBusy && !customerPage.customers.length ? <p className="emptyState">該当する顧客はいません。</p> : null}
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
            <CustomerSourceProfiles profiles={selected.importedProfiles} />
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
