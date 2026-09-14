"use client";

import { BookOpenText, Plus, Save, Search, Trash2, UserRoundPen, X } from "lucide-react";
import { useMemo, useState } from "react";
import { DismissibleMessage } from "@/components/dismissible-message";
import { useTenantSlug } from "@/components/tenant-provider";
import type { AdminCustomer, AdminCustomerDetail } from "@/lib/admin-types";
import { tenantApiPath } from "@/lib/tenant-routing";

type CustomerForm = {
  name: string;
  kana: string;
  phone: string;
  lineDisplayName: string;
  tags: string;
  memo: string;
};

const emptyForm: CustomerForm = { name: "", kana: "", phone: "", lineDisplayName: "", tags: "", memo: "" };
const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });

function toForm(customer: AdminCustomer): CustomerForm {
  return {
    name: customer.name,
    kana: customer.kana,
    phone: customer.phone ?? "",
    lineDisplayName: customer.lineDisplayName ?? "",
    tags: customer.tags.join(", "),
    memo: customer.memo ?? ""
  };
}

async function responseError(response: Response) {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? `処理に失敗しました (${response.status})`;
}

export function CustomerManagement({ initialCustomers }: { initialCustomers: AdminCustomer[] }) {
  const tenantSlug = useTenantSlug();
  const [customers, setCustomers] = useState(initialCustomers);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<AdminCustomerDetail | null>(null);
  const [form, setForm] = useState<CustomerForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
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
    setEditingId(null);
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

  function startCreate() {
    setSelected(null);
    setForm(emptyForm);
    setEditingId("new");
    setMessage("");
  }

  function startEdit() {
    if (!selected) return;
    setForm(toForm(selected));
    setEditingId(selected.id);
    setMessage("");
  }

  async function saveCustomer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingId) return;
    setBusy(true);
    setMessage("");
    const isNew = editingId === "new";
    try {
      const response = await fetch(tenantApiPath(tenantSlug, isNew ? "/admin/customers" : `/admin/customers/${editingId}`), {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          kana: form.kana.trim() || form.name.trim(),
          phone: form.phone.trim() || null,
          lineDisplayName: form.lineDisplayName.trim() || null,
          tags: form.tags.split(/[,、]/).map((tag) => tag.trim()).filter(Boolean),
          memo: form.memo.trim() || null
        })
      });
      if (!response.ok) throw new Error(await responseError(response));
      const saved = (await response.json()) as AdminCustomer;
      setCustomers((current) => isNew ? [{ ...saved, _count: { reservations: 0 } }, ...current] : current.map((item) => item.id === saved.id ? { ...item, ...saved } : item));
      setEditingId(null);
      setMessage("顧客情報を保存しました。");
      await selectCustomer(saved);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "顧客情報の保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function deleteCustomer() {
    if (!selected || !window.confirm(`${selected.name}さんを削除しますか？`)) return;
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
          <button className="primaryButton" type="button" onClick={startCreate}>
            <Plus size={17} />新規登録
          </button>
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
                <small>{yen.format(customer.totalSpent)}</small>
              </span>
            </button>
          ))}
          {!filtered.length ? <p className="emptyState">該当する顧客はいません。</p> : null}
        </div>
      </section>

      <section className="customerDetailPanel">
        {message ? <DismissibleMessage message={message} onDismiss={() => setMessage("")} /> : null}
        {editingId ? (
          <form className="customerForm" onSubmit={saveCustomer}>
            <div className="detailPanelHeader">
              <div><span>Customer</span><h2>{editingId === "new" ? "顧客を登録" : "顧客情報を編集"}</h2></div>
              <button className="iconOnlyButton" type="button" onClick={() => setEditingId(null)}><X size={18} /></button>
            </div>
            <div className="createFieldGrid two">
              <label className="createField"><span>氏名</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <label className="createField"><span>カナ</span><input value={form.kana} onChange={(event) => setForm({ ...form, kana: event.target.value })} /></label>
              <label className="createField"><span>電話番号</span><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
              <label className="createField"><span>表示名</span><input value={form.lineDisplayName} onChange={(event) => setForm({ ...form, lineDisplayName: event.target.value })} /></label>
            </div>
            <label className="createField"><span>タグ（カンマ区切り）</span><input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="要注意, VIP, 新規" /></label>
            <label className="createField"><span>カルテ・顧客メモ</span><textarea rows={10} value={form.memo} onChange={(event) => setForm({ ...form, memo: event.target.value })} /></label>
            <button className="primaryButton" disabled={busy} type="submit"><Save size={17} />{busy ? "保存中..." : "保存"}</button>
          </form>
        ) : selected ? (
          <div className="customerDetail">
            <div className="detailPanelHeader">
              <div><span>Customer</span><h2>{selected.name}</h2><p>{selected.kana} / {selected.phone || "電話未登録"}</p></div>
              <div className="adminActions">
                <button className="secondaryButton" type="button" onClick={startEdit}><UserRoundPen size={17} />編集</button>
                <button className="dangerButton large" type="button" onClick={() => void deleteCustomer()}><Trash2 size={17} />削除</button>
              </div>
            </div>
            <div className="customerMetricGrid">
              <div><span>来店回数</span><strong>{selected.visitCount}回</strong></div>
              <div><span>累計売上</span><strong>{yen.format(selected.totalSpent)}</strong></div>
              <div><span>最終来店</span><strong>{selected.lastVisitAt ? new Date(selected.lastVisitAt).toLocaleDateString("ja-JP") : "未来店"}</strong></div>
            </div>
            <div className="tagList">{selected.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
            <article className="karteBox"><BookOpenText size={18} /><div><strong>カルテ・顧客メモ</strong><p>{selected.memo || "まだ記録がありません。"}</p></div></article>
            <h3 className="subsectionTitle">予約・来店履歴</h3>
            <div className="historyList">
              {selected.reservations.map((reservation) => (
                <article key={reservation.id}>
                  <time>{new Date(reservation.startsAt).toLocaleString("ja-JP")}</time>
                  <strong>{reservation.service.name}</strong>
                  <span>{reservation.staff?.name ?? "指名なし"} / {reservation.status}</span>
                  <em>{yen.format(reservation.service.price)}</em>
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
