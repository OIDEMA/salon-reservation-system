"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { TenantLink } from "./tenant-link";
import { usePermissions, useTenantSlug } from "./tenant-provider";
import { ChartFields } from "./chart-fields";
import { chartDate, chartInitialValues, chartPayload, chartResponseError, type ChartDetail, type ChartFormValues, type ChartReservation } from "./chart-types";
import { tenantApiPath, tenantPath } from "@/lib/tenant-routing";

export function ChartNewForm({ initialReservation }: { initialReservation?: ChartReservation }) {
  const { can } = usePermissions();
  if (!can("chart.write")) return <p className="formMessage error" role="alert">カルテを作成する権限がありません。店舗の管理者にお問い合わせください。</p>;
  return <EditableChartNewForm initialReservation={initialReservation} />;
}

function EditableChartNewForm({ initialReservation }: { initialReservation?: ChartReservation }) {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  const canWrite = can("chart.write");
  const router = useRouter();
  const [reservation, setReservation] = useState(initialReservation);
  const [values, setValues] = useState(() => chartInitialValues(undefined, initialReservation?.startsAt, initialReservation?.timezone));
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<ChartReservation[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [existingChartId, setExistingChartId] = useState<string | null>(null);
  const [pendingReservation, setPendingReservation] = useState<ChartReservation | null>(null);

  async function search(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite || searching || busy) return;
    setSearching(true); setMessage("");
    try {
      const response = await fetch(tenantApiPath(tenantSlug, "/charts/reservation-options?query=" + encodeURIComponent(query.trim())), { cache: "no-store" });
      if (!response.ok) throw new Error(await chartResponseError(response));
      const data = await response.json() as { reservations: ChartReservation[] };
      setOptions(data.reservations); setSearched(true);
    } catch (error) { setMessage(error instanceof Error ? error.message : "予約を取得できませんでした。"); }
    finally { setSearching(false); }
  }

  function applyReservation(item: ChartReservation) {
    if (!canWrite) return;
    setReservation(item); setExistingChartId(item.chartId ?? null); setMessage("");
    setValues(chartInitialValues(undefined, item.startsAt, item.timezone));
    setPendingReservation(null);
  }

  function choose(item: ChartReservation) {
    if (!canWrite || busy) return;
    if (item.id === reservation?.id) { setPendingReservation(null); return; }
    const hasTreatmentInput = Object.entries(values).some(([key, value]) => key !== "treatmentAt" && value.trim().length > 0)
      || Boolean(reservation && values.treatmentAt !== chartInitialValues(undefined, reservation.startsAt, reservation.timezone).treatmentAt);
    if (hasTreatmentInput) { setPendingReservation(item); return; }
    applyReservation(item);
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite || busy || pendingReservation || !reservation || reservation.chartId) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(tenantApiPath(tenantSlug, "/charts"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservationId: reservation.id, ...chartPayload(values, reservation.timezone) })
      });
      if (!response.ok) {
        const errorBody = await response.json().catch(() => null) as { message?: string; chartId?: string } | null;
        if (errorBody?.chartId) setExistingChartId(errorBody.chartId);
        throw new Error(errorBody?.message ?? "カルテを作成できませんでした。");
      }
      const chart = await response.json() as ChartDetail;
      router.push(tenantPath(tenantSlug, "/charts/" + encodeURIComponent(chart.id))); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "カルテを作成できませんでした。"); setBusy(false); }
  }

  function updateField(key: keyof ChartFormValues, value: string) { if (canWrite) setValues((current) => ({ ...current, [key]: value })); }

  return <div className="chartNewContent">
    <section className="chartSection">
      <h2>予約を選択</h2>
      <form onSubmit={search} className="chartReservationSearch">
        <label className="createField"><span>顧客名で予約を検索</span><input value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} disabled={busy || searching} /></label>
        <button type="submit" className="secondaryButton" disabled={busy || searching}>{searching ? "検索中..." : "検索"}</button>
      </form>
      {searched ? <div className="chartReservationOptions">
        {options.length ? options.map((item) => <button type="button" disabled={busy} key={item.id} className={`chartReservationOption ${item.id === reservation?.id ? "isSelected" : ""}`} onClick={() => choose(item)}>
          <strong>{item.customer.name}</strong><span>{chartDate(item.startsAt, item.timezone)} · {item.service.name}</span>
          <small>{item.staff?.name ?? "担当者未指定"}{item.chartId ? " · カルテ作成済み" : ""}</small>
        </button>) : <p className="chartMuted">該当する予約がありません。</p>}
      </div> : null}
      {reservation ? <div className="chartReservationContext">
        <strong>{reservation.customer.name}</strong><span>{chartDate(reservation.startsAt, reservation.timezone)} · {reservation.service.name} · {reservation.staff?.name ?? "担当者未指定"}</span>
        {can("reservation.write") ? <TenantLink href={`/reservations/${encodeURIComponent(reservation.id)}/edit`}>予約情報へ</TenantLink> : null}
      </div> : <p className="chartMuted">予約を選択すると顧客・担当者が紐づきます。</p>}
    </section>
    {pendingReservation ? <div className="chartConfirm" role="group" aria-labelledby="chart-reservation-change-title">
      <strong id="chart-reservation-change-title">予約を変更すると入力中の施術記録はクリアされます。</strong>
      <p>{pendingReservation.customer.name} · {chartDate(pendingReservation.startsAt, pendingReservation.timezone)} · {pendingReservation.service.name} に変更しますか？</p>
      <div className="chartInlineActions"><button type="button" className="secondaryButton" disabled={busy} onClick={() => setPendingReservation(null)}>変更を取り消す</button><button type="button" className="primaryButton" disabled={busy} onClick={() => applyReservation(pendingReservation)}>入力をクリアして変更</button></div>
    </div> : null}
    {message ? <p className="formMessage error" role="alert">{message}</p> : null}
    {(existingChartId || reservation?.chartId) ? <p className="chartNotice">この予約にはカルテがあります。<TenantLink href={`/charts/${encodeURIComponent(existingChartId ?? reservation?.chartId ?? "")}`}>作成済みのカルテを開く</TenantLink></p> : <form onSubmit={create} className="masterCreateForm">
      <ChartFields values={values} onChange={updateField} disabled={busy || Boolean(pendingReservation) || !reservation} timezone={reservation?.timezone} />
      <div className="masterCreateActions"><TenantLink href="/charts" className="secondaryButton">一覧へ戻る</TenantLink><button type="submit" className="primaryButton" disabled={busy || Boolean(pendingReservation) || !reservation}>{busy ? "保存中..." : "下書きとして保存"}</button></div>
    </form>}
  </div>;
}
