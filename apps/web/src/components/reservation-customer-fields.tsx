"use client";

import { Search, UserCheck, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { usePermissions, useTenantSlug } from "./tenant-provider";
import type { ReservationCustomer, ReservationCustomerInput } from "@/lib/reservation-customer";
import { tenantApiPath } from "@/lib/tenant-routing";

type SearchResult = {
  query: string;
  status: "loading" | "done" | "error";
  customers: ReservationCustomer[];
  hasMore: boolean;
  message?: string;
};

export function ReservationCustomerFields({ value, onChange, disabled = false }: {
  value: ReservationCustomerInput;
  onChange: (value: ReservationCustomerInput) => void;
  disabled?: boolean;
}) {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  const canLookup = can("customer.read");
  const resultId = useId();
  const [query, setQuery] = useState("");
  const [retry, setRetry] = useState(0);
  const [composing, setComposing] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const searchTerm = query.trim();
  const searching = canLookup && !value.customerId && !composing && Boolean(searchTerm);
  const currentResult = searching && result?.query === searchTerm ? result : null;

  useEffect(() => {
    if (!searching) return;
    const controller = new AbortController();
    setResult({ query: searchTerm, status: "loading", customers: [], hasMore: false });
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(tenantApiPath(tenantSlug, `/admin/customers/lookup?q=${encodeURIComponent(searchTerm)}`), {
          cache: "no-store", signal: controller.signal
        });
        if (!response.ok) throw new Error(response.status === 403 ? "顧客を検索する権限がありません。" : "顧客の検索に失敗しました。もう一度お試しください。");
        const data = await response.json() as { customers: ReservationCustomer[]; hasMore: boolean };
        if (!controller.signal.aborted) setResult({ query: searchTerm, status: "done", ...data });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ query: searchTerm, status: "error", customers: [], hasMore: false,
          message: error instanceof Error ? error.message : "顧客の検索に失敗しました。" });
      }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [searching, searchTerm, tenantSlug, retry]);

  function updateField(field: "name" | "kana" | "phone", text: string) {
    onChange({ ...value, [field]: text });
    setQuery(text);
  }

  function chooseCustomer(customer: ReservationCustomer) {
    onChange({ customerId: customer.id, name: customer.name, kana: customer.kana, phone: customer.phone ?? "" });
    setQuery("");
    setResult(null);
  }

  return (
    <div className="reservationCustomerFields">
      <div className="createFieldGrid three">
        <label className="createField">
          <span>顧客名</span>
          <input value={value.name} onChange={(event) => updateField("name", event.target.value)} onFocus={() => { if (!value.customerId && value.name.trim()) setQuery(value.name); }}
            onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
            placeholder="顧客名" required autoComplete="off" disabled={disabled} readOnly={Boolean(value.customerId)} aria-describedby={canLookup ? resultId : undefined} />
        </label>
        <label className="createField">
          <span>カナ</span>
          <input value={value.kana} onChange={(event) => updateField("kana", event.target.value)} onFocus={() => { if (!value.customerId && value.kana.trim()) setQuery(value.kana); }}
            onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
            placeholder="顧客名（カナ）" autoComplete="off" disabled={disabled} readOnly={Boolean(value.customerId)} aria-describedby={canLookup ? resultId : undefined} />
        </label>
        <label className="createField">
          <span>電話番号</span>
          <input value={value.phone} onChange={(event) => updateField("phone", event.target.value)} onFocus={() => { if (!value.customerId && value.phone.trim()) setQuery(value.phone); }}
            onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
            placeholder="090-0000-0000" inputMode="tel" autoComplete="off" disabled={disabled} readOnly={Boolean(value.customerId)} aria-describedby={canLookup ? resultId : undefined} />
        </label>
      </div>
      {value.customerId ? (
        <div className="reservationCustomerSelected" id={resultId}>
          <span><UserCheck size={17} />登録済みのお客様を選択しています。</span>
          <button type="button" disabled={disabled} onClick={() => { onChange({ name: "", kana: "", phone: "" }); setQuery(""); setResult(null); }}><X size={15} />選択を解除</button>
        </div>
      ) : canLookup ? (
        <div className="reservationCustomerLookup" id={resultId}>
          <p className="reservationCustomerHint"><Search size={15} />顧客名・カナ・電話番号を入力すると登録済みのお客様を検索します。</p>
          {searching && (!currentResult || currentResult.status === "loading") ? <p role="status">検索中...</p> : null}
          {currentResult?.status === "error" ? <div className="reservationCustomerError" role="alert"><p>{currentResult.message}</p><button className="secondaryButton" type="button" disabled={disabled} onClick={() => setRetry((current) => current + 1)}>再検索</button></div> : null}
          {currentResult?.status === "done" ? <>
            {currentResult.customers.length ? <div className="reservationCustomerResults" role="group" aria-label="登録済み顧客の候補">
              {currentResult.customers.map((customer) => <button key={customer.id} type="button" disabled={disabled} onClick={() => chooseCustomer(customer)}>
                <span><strong>{customer.name}</strong><small>{customer.kana}</small></span>
                <span>{customer.phone || "電話番号未登録"}</span>
              </button>)}
            </div> : <p role="status">該当する登録顧客はいません。新規のお客様はそのまま入力してください。</p>}
            {currentResult.hasMore ? <p role="status">候補が多いため、名前や電話番号を追加して絞り込んでください。</p> : null}
          </> : null}
        </div>
      ) : null}
    </div>
  );
}
