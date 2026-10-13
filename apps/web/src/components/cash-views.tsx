"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DismissibleMessage } from "@/components/dismissible-message";
import { TenantLink } from "@/components/tenant-link";
import { usePermissions, useTenant, useTenantSlug } from "@/components/tenant-provider";
import { tenantApiPath, tenantPath } from "@/lib/tenant-routing";
import type { AdminReservation } from "@/lib/admin-types";
import { cashMethodLabels, cashStatusLabels, cashYen, type CashCheckout, type CashItem, type CashPayment, type CashRegister } from "./cash-types";

async function api<T>(slug: string, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(tenantApiPath(slug, `/cash${path}`), { method, cache: "no-store",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.message ?? `処理に失敗しました (${response.status})`);
  return result as T;
}

function CashMessage({ message, dismiss }: { message: string; dismiss: () => void }) {
  return message ? <DismissibleMessage className="formMessage" role="status" message={message} onDismiss={dismiss} /> : null;
}

export function CashCheckoutCreate({ reservations, initialReservationId = "" }: { reservations: AdminReservation[]; initialReservationId?: string }) {
  const slug = useTenantSlug();
  const router = useRouter();
  const { can } = usePermissions();
  const [reservationId, setReservationId] = useState(initialReservationId);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRef("");
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !can("checkout.write")) return;
    setBusy(true); setMessage("");
    request.current ||= crypto.randomUUID();
    try {
      const checkout = await api<CashCheckout>(slug, "/checkouts", "POST", { reservationId, requestId: request.current });
      router.push(tenantPath(slug, `/checkout/${checkout.id}`)); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "会計を作成できませんでした。"); setBusy(false); }
  }
  if (!can("checkout.write")) return null;
  return <section className="adminPanel cashPanel"><h2>予約から会計を開始</h2>
      <form className="cashStartForm" onSubmit={create}><label className="createField"><span>予約</span>
        {reservations.length ? <select required disabled={busy} value={reservationId} onChange={(event) => { setReservationId(event.target.value); request.current = ""; }}>
          <option value="">予約を選択してください</option>
          {reservations.filter((reservation) => !["CANCELLED", "NO_SHOW"].includes(reservation.status)).map((reservation) => <option key={reservation.id} value={reservation.id}>{reservation.date} {reservation.startTime} / {reservation.customer.name} / {reservation.service.name}</option>)}
        </select> : <input required disabled={busy} maxLength={160} placeholder="予約番号" value={reservationId} onChange={(event) => { setReservationId(event.target.value); request.current = ""; }} />}</label><button className="primaryButton" disabled={busy || !reservationId}>{busy ? "作成中..." : "会計を開く"}</button></form>
      <CashMessage message={message} dismiss={() => setMessage("")} />
    </section>;
}

export function CashCheckoutList({ checkouts, reservations }: { checkouts: CashCheckout[]; reservations: AdminReservation[] }) {
  return <div className="cashStack"><CashCheckoutCreate reservations={reservations} />
    <section className="tablePanel"><table className="adminTable"><thead><tr><th>お客様・予約</th><th>会計金額</th><th>状態</th><th>操作</th></tr></thead><tbody>
      {checkouts.map((checkout) => <tr key={checkout.id}><td><strong>{checkout.reservationSnapshot.customerName}</strong><small>{checkout.reservationSnapshot.serviceName}</small></td><td>{cashYen(checkout.totalYen)}</td><td>{cashStatusLabels[checkout.status]}</td><td><TenantLink className="miniButton" href={`/checkout/${checkout.id}`}>詳細</TenantLink>{checkout.status !== "DRAFT" ? <TenantLink className="miniButton" href={`/checkout/${checkout.id}/receipt`}>会計控え</TenantLink> : null}</td></tr>)}
      {!checkouts.length ? <tr><td colSpan={4}>会計の記録はありません。</td></tr> : null}
    </tbody></table></section>
  </div>;
}

function editable(checkout: CashCheckout) {
  return { items: checkout.items.map(({ label, quantity, unitPriceYen, discountYen, taxRate }) => ({ label, quantity, unitPriceYen, discountYen, taxRate })),
    payments: checkout.payments.map(({ method, amountYen, reference }) => ({ method, amountYen, reference })),
    legacyPaidAcknowledged: checkout.legacyPaidAcknowledged, notes: checkout.notes };
}

export function CashCheckoutEditor({ initialCheckout, registers }: { initialCheckout: CashCheckout; registers: CashRegister[] }) {
  const slug = useTenantSlug();
  const { can } = usePermissions();
  const canEdit = can("checkout.write");
  const canRefund = can("checkout.refund");
  const [checkout, setCheckout] = useState(initialCheckout);
  const [form, setForm] = useState(() => editable(initialCheckout));
  const [sessionId, setSessionId] = useState(registers.find((register) => register.status === "OPEN")?.id ?? "");
  const [reason, setReason] = useState("");
  const [refundRecorded, setRefundRecorded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const finalizeKey = useRef("");
  const reverseKey = useRef("");
  const isDraft = checkout.status === "DRAFT";
  const dirty = JSON.stringify(form) !== JSON.stringify(editable(checkout));
  const total = form.items.reduce((sum, item) => sum + item.quantity * item.unitPriceYen - item.discountYen, 0);
  const allocated = form.payments.reduce((sum, payment) => sum + payment.amountYen, 0);
  const openRegisters = registers.filter((register) => register.status === "OPEN");
  function replace(updated: CashCheckout) { setCheckout(updated); setForm(editable(updated)); }
  function item(index: number, patch: Partial<CashItem>) { setForm((current) => ({ ...current, items: current.items.map((line, position) => position === index ? { ...line, ...patch } : line) })); }
  function payment(index: number, patch: Partial<CashPayment>) { setForm((current) => ({ ...current, payments: current.payments.map((line, position) => position === index ? { ...line, ...patch } : line) })); }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !canEdit) return; setBusy(true); setMessage("");
    try { replace(await api<CashCheckout>(slug, `/checkouts/${checkout.id}`, "PUT", { ...form, version: checkout.version })); finalizeKey.current = ""; setMessage("下書きを保存しました。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "保存できませんでした。"); }
    finally { setBusy(false); }
  }
  async function finalize() {
    if (busy || dirty || !canEdit) return; setBusy(true); setMessage(""); finalizeKey.current ||= crypto.randomUUID();
    try { replace(await api<CashCheckout>(slug, `/checkouts/${checkout.id}/finalize`, "POST", { version: checkout.version, requestId: finalizeKey.current, registerSessionId: sessionId })); setMessage("会計を確定しました。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "確定できませんでした。"); }
    finally { setBusy(false); }
  }
  async function reverse(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !canRefund) return; setBusy(true); setMessage(""); reverseKey.current ||= crypto.randomUUID();
    try { replace(await api<CashCheckout>(slug, `/checkouts/${checkout.id}/reverse`, "POST", { requestId: reverseKey.current, reason, refundRecorded, registerSessionId: sessionId })); setMessage("全額取消・返金の記録を保存しました。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "取消できませんでした。"); }
    finally { setBusy(false); }
  }
  async function reload() {
    if (busy) return; setBusy(true); setMessage("");
    try { replace(await api<CashCheckout>(slug, `/checkouts/${checkout.id}`)); finalizeKey.current = ""; reverseKey.current = ""; }
    catch (error) { setMessage(error instanceof Error ? error.message : "取得できませんでした。"); }
    finally { setBusy(false); }
  }
  async function refreshReservation() {
    if (busy || !isDraft || !canEdit) return; setBusy(true); setMessage("");
    try { replace(await api<CashCheckout>(slug, `/checkouts/${checkout.id}/refresh-reservation`, "POST", { version: checkout.version })); finalizeKey.current = ""; setMessage("最新の予約情報から明細を作り直しました。支払内訳を入力してください。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "予約情報を更新できませんでした。"); }
    finally { setBusy(false); }
  }
  return <div className="cashStack">
    <section className="adminPanel cashPanel"><div className="cashHeading"><div><h2>{checkout.reservationSnapshot.customerName}</h2><p>{checkout.reservationSnapshot.serviceName} / {checkout.reservationSnapshot.staffName}</p></div><strong>{cashStatusLabels[checkout.status]}</strong></div>
      <p className="cashNotice">店舗で受領した金額を記録します。カード・振込・事前入金は、外部で決済済みの内容を入力してください。</p>
      <CashMessage message={message} dismiss={() => setMessage("")} />
      <form className="cashStack" onSubmit={save}><fieldset disabled={busy || !isDraft || !canEdit} className="cashFields">
        <h3>明細（税込）</h3>
        {form.items.map((line, index) => <div className="cashItemRow" key={index}>
          <label className="createField"><span>内容</span><input required maxLength={160} value={line.label} onChange={(event) => item(index, { label: event.target.value })} /></label>
          <label className="createField"><span>数量</span><input required type="number" min={1} max={999} value={line.quantity} onChange={(event) => item(index, { quantity: Number(event.target.value) })} /></label>
          <label className="createField"><span>税込単価</span><input required type="number" min={0} max={100000000} value={line.unitPriceYen} onChange={(event) => item(index, { unitPriceYen: Number(event.target.value) })} /></label>
          <label className="createField"><span>明細値引</span><input required type="number" min={0} max={line.quantity * line.unitPriceYen} value={line.discountYen} onChange={(event) => item(index, { discountYen: Number(event.target.value) })} /></label>
          <label className="createField"><span>税率</span><select value={line.taxRate} onChange={(event) => item(index, { taxRate: Number(event.target.value) })}><option value={10}>10%</option><option value={8}>8%</option><option value={0}>0%</option></select></label>
          <button type="button" className="miniButton" disabled={form.items.length === 1} onClick={() => setForm((current) => ({ ...current, items: current.items.filter((_, position) => position !== index) }))}>削除</button>
        </div>)}
        <button className="secondaryButton" type="button" disabled={form.items.length >= 100} onClick={() => setForm((current) => ({ ...current, items: [...current.items, { label: "", quantity: 1, unitPriceYen: 0, discountYen: 0, taxRate: 10 }] }))}>明細を追加</button>
        <h3>支払内訳</h3>
        {checkout.legacyPaymentStatus === "PAID" ? <p className="cashNotice">この予約は入金済みです。確認済みの事前入金として記録してください。</p> : null}
        {form.payments.map((line, index) => <div className="cashPaymentRow" key={index}>
          <label className="createField"><span>方法</span><select value={line.method} onChange={(event) => payment(index, { method: event.target.value as CashPayment["method"] })}>{Object.entries(cashMethodLabels).filter(([method]) => checkout.legacyPaymentStatus !== "PAID" || method === "EXTERNAL_PREPAYMENT").map(([method, label]) => <option key={method} value={method}>{label}</option>)}</select></label>
          <label className="createField"><span>金額</span><input required min={1} max={100000000} type="number" value={line.amountYen} onChange={(event) => payment(index, { amountYen: Number(event.target.value) })} /></label>
          <label className="createField"><span>確認番号・確認内容</span><input required={line.method === "EXTERNAL_PREPAYMENT"} maxLength={160} value={line.reference} onChange={(event) => payment(index, { reference: event.target.value })} /></label>
          <button className="miniButton" type="button" onClick={() => setForm((current) => ({ ...current, payments: current.payments.filter((_, position) => position !== index) }))}>削除</button>
        </div>)}
        <button className="secondaryButton" type="button" disabled={form.payments.length >= 20} onClick={() => setForm((current) => ({ ...current, payments: [...current.payments, { method: checkout.legacyPaymentStatus === "PAID" ? "EXTERNAL_PREPAYMENT" : "CASH", amountYen: Math.max(1, total - allocated), reference: "" }] }))}>支払記録を追加</button>
        <label className="cashCheck"><input type="checkbox" checked={form.legacyPaidAcknowledged} onChange={(event) => setForm((current) => ({ ...current, legacyPaidAcknowledged: event.target.checked }))} />既存の事前入金を確認しました</label>
        <label className="createField"><span>会計メモ</span><textarea maxLength={2000} rows={3} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} /></label>
      </fieldset>
      <div className="cashMetrics"><div><span>会計金額</span><strong>{cashYen(total)}</strong></div><div><span>支払記録合計</span><strong>{cashYen(allocated)}</strong></div><div><span>差額</span><strong className={allocated !== total ? "cashDifference" : ""}>{cashYen(total - allocated)}</strong></div></div>
      {isDraft && canEdit ? <div className="masterCreateActions"><TenantLink className="secondaryButton" href="/checkout">一覧へ</TenantLink><button className="primaryButton" disabled={busy}>{busy ? "処理中..." : "下書きを保存"}</button></div> : null}
      </form>
    </section>
    {((isDraft && canEdit) || (checkout.status === "FINALIZED" && canRefund)) ? <section className="adminPanel cashPanel">
      {!can("register.read") ? <p className="cashNotice">会計の確定・取消には営業レジの選択が必要です。店舗の管理者に「レジ・日報の閲覧」権限の追加を依頼してください。</p> : null}
      <label className="createField"><span>本日の営業レジ</span><select disabled={busy} value={sessionId} onChange={(event) => { setSessionId(event.target.value); finalizeKey.current = ""; reverseKey.current = ""; }}><option value="">レジを選択してください</option>{openRegisters.map((register) => <option key={register.id} value={register.id}>{register.businessDate} / 営業中</option>)}</select></label>
      {!openRegisters.length ? <p className="cashNotice">本日の営業レジが必要です。{can("register.close") ? <TenantLink href="/register/new">レジ開店へ</TenantLink> : "店舗の管理者にお問い合わせください。"}</p> : null}
      {isDraft ? <><p>{dirty ? "変更した内容を下書き保存してから確定してください。" : "明細と受領済みの支払内訳を確認して確定してください。"}</p><button className="primaryButton" disabled={busy || dirty || allocated !== total || !sessionId} onClick={() => void finalize()} type="button">会計を確定</button></> :
        <form className="cashStack" onSubmit={reverse}><h3>全額取消・返金記録</h3><p className="cashNotice">お客様への返金を完了した内容を記録します。カード等の返金操作は決済端末・外部サービスで行ってください。</p><label className="createField"><span>取消理由</span><textarea disabled={busy} required maxLength={1000} value={reason} onChange={(event) => { setReason(event.target.value); reverseKey.current = ""; }} /></label><label className="cashCheck"><input disabled={busy} required type="checkbox" checked={refundRecorded} onChange={(event) => setRefundRecorded(event.target.checked)} />全額返金を確認しました</label><button className="secondaryButton" disabled={busy || !refundRecorded || !sessionId}>全額取消を記録</button></form>}
    </section> : checkout.status === "REVERSED" ? <section className="adminPanel cashPanel"><h3>全額取消済み</h3><p>{checkout.reversalReason}</p><p>{checkout.reversedAt ? new Date(checkout.reversedAt).toLocaleString("ja-JP") : ""}</p><TenantLink href="/checkout" className="secondaryButton">会計一覧へ</TenantLink></section> : null}
    <div className="cashFooter"><button className="secondaryButton" type="button" disabled={busy} onClick={() => void reload()}>最新の状態を取得</button>{isDraft && canEdit ? <div><button className="secondaryButton" type="button" disabled={busy} onClick={() => void refreshReservation()}>予約に合わせて下書きを作り直す</button><p className="cashReceiptFootnote">明細・値引・支払内訳を初期化します。</p></div> : !isDraft ? <TenantLink className="secondaryButton" href={`/checkout/${checkout.id}/receipt`}>会計控え・印刷</TenantLink> : null}</div>
  </div>;
}

export function CashRegisterList({ registers }: { registers: CashRegister[] }) {
  return <section className="tablePanel"><table className="adminTable"><thead><tr><th>営業日</th><th>状態</th><th>開店現金</th><th>想定現金</th><th>実査差額</th><th>操作</th></tr></thead><tbody>{registers.map((register) => <tr key={register.id}><td>{register.businessDate}</td><td>{register.status === "OPEN" ? "営業中" : "締め済み"}</td><td>{cashYen(register.openingCashYen)}</td><td>{cashYen(register.expectedCashYen)}</td><td>{register.differenceYen === null ? "—" : cashYen(register.differenceYen)}</td><td><TenantLink className="miniButton" href={`/register/${register.id}`}>詳細</TenantLink></td></tr>)}{!registers.length ? <tr><td colSpan={6}>レジの記録はありません。</td></tr> : null}</tbody></table></section>;
}

export function CashRegisterOpen() {
  const { memberships, activeSalonId } = useTenant();
  const slug = useTenantSlug(); const router = useRouter(); const key = useRef(""); const { can } = usePermissions();
  const timezone = memberships.find((membership) => membership.tenant.slug === slug)?.tenant.salons.find((salon) => salon.id === activeSalonId)?.timezone ?? "Asia/Tokyo";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [openingCashYen, setOpening] = useState(0); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !can("register.close")) return; setBusy(true); setMessage(""); key.current ||= crypto.randomUUID();
    try { const register = await api<CashRegister>(slug, "/register-sessions", "POST", { businessDate: today, openingCashYen, requestId: key.current }); router.push(tenantPath(slug, `/register/${register.id}`)); router.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "開店できませんでした。"); setBusy(false); }
  }
  if (!can("register.close")) return <p className="formMessage" role="alert">レジを開店する権限がありません。</p>;
  return <form className="adminPanel cashPanel cashStack" onSubmit={submit}><h2>レジ開店</h2><p>営業日 {today}</p><label className="createField"><span>開店時のレジ現金・釣銭</span><input disabled={busy} required type="number" min={0} max={100000000} value={openingCashYen} onChange={(event) => { setOpening(Number(event.target.value)); key.current = ""; }} /></label><CashMessage message={message} dismiss={() => setMessage("")} /><div className="masterCreateActions"><TenantLink className="secondaryButton" href="/register">キャンセル</TenantLink><button className="primaryButton" disabled={busy}>{busy ? "処理中..." : "レジを開店"}</button></div></form>;
}

export function CashRegisterDetail({ initialRegister }: { initialRegister: CashRegister }) {
  const slug = useTenantSlug(); const { can } = usePermissions(); const canClose = can("register.close"); const [register, setRegister] = useState(initialRegister);
  const [kind, setKind] = useState<"IN" | "OUT">("IN"); const [amountYen, setAmount] = useState(0); const [reason, setReason] = useState("");
  const [countedCashYen, setCounted] = useState(0); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const movementKey = useRef(""); const closeKey = useRef("");
  async function act(path: string, body: unknown) {
    if (busy || !canClose) return; setBusy(true); setMessage("");
    try { setRegister(await api<CashRegister>(slug, `/register-sessions/${register.id}${path}`, "POST", body)); setMessage(path === "/close" ? "レジを締めました。日報は固定されました。" : "入出金を記録しました。"); if (path !== "/close") { setAmount(0); setReason(""); movementKey.current = ""; closeKey.current = ""; } }
    catch (error) { setMessage(error instanceof Error ? error.message : "処理できませんでした。"); }
    finally { setBusy(false); }
  }
  async function reload() { if (busy) return; setBusy(true); setMessage(""); try { setRegister(await api<CashRegister>(slug, `/register-sessions/${register.id}`)); movementKey.current = ""; closeKey.current = ""; } catch (error) { setMessage(error instanceof Error ? error.message : "取得できませんでした。"); } finally { setBusy(false); } }
  return <div className="cashStack"><section className="adminPanel cashPanel"><div className="cashHeading"><h2>{register.businessDate}</h2><strong>{register.status === "OPEN" ? "営業中" : "締め済み"}</strong></div><div className="cashMetrics"><div><span>開店現金</span><strong>{cashYen(register.openingCashYen)}</strong></div><div><span>想定レジ現金</span><strong>{cashYen(register.expectedCashYen)}</strong></div><div><span>実査差額</span><strong className={register.differenceYen ? "cashDifference" : ""}>{register.differenceYen === null ? "未実査" : cashYen(register.differenceYen)}</strong></div></div><CashMessage message={message} dismiss={() => setMessage("")} /></section>
    <section className="tablePanel"><table className="adminTable"><thead><tr><th>日時</th><th>種別</th><th>金額</th><th>理由</th></tr></thead><tbody>{register.movements.map((movement) => <tr key={movement.id}><td>{new Date(movement.createdAt).toLocaleString("ja-JP")}</td><td>{{ IN: "入金", OUT: "出金", SALE: "会計現金", REFUND: "現金返金" }[movement.kind]}</td><td>{cashYen(movement.amountYen)}</td><td>{movement.reason}</td></tr>)}{!register.movements.length ? <tr><td colSpan={4}>現金の入出金はありません。</td></tr> : null}</tbody></table></section>
    {register.status === "OPEN" && canClose ? <div className="cashTwoPanels"><form className="adminPanel cashPanel cashStack" onSubmit={(event) => { event.preventDefault(); movementKey.current ||= crypto.randomUUID(); void act("/movements", { version: register.version, requestId: movementKey.current, kind, amountYen, reason }); }}><h3>現金の入出金</h3><label className="createField"><span>種別</span><select disabled={busy} value={kind} onChange={(event) => { setKind(event.target.value as "IN" | "OUT"); movementKey.current = ""; }}><option value="IN">入金</option><option value="OUT">出金</option></select></label><label className="createField"><span>金額</span><input disabled={busy} required type="number" min={1} max={100000000} value={amountYen} onChange={(event) => { setAmount(Number(event.target.value)); movementKey.current = ""; }} /></label><label className="createField"><span>理由</span><input disabled={busy} required maxLength={1000} value={reason} onChange={(event) => { setReason(event.target.value); movementKey.current = ""; }} /></label><button className="secondaryButton" disabled={busy}>入出金を記録</button></form>
      <form className="adminPanel cashPanel cashStack" onSubmit={(event) => { event.preventDefault(); closeKey.current ||= crypto.randomUUID(); void act("/close", { version: register.version, requestId: closeKey.current, countedCashYen, note }); }}><h3>レジ締め</h3><p>現金を実際に数えて入力してください。締めると日報が固定され、そのレジへの会計・入出金は終了します。</p><label className="createField"><span>実査現金</span><input disabled={busy} required type="number" min={0} max={100000000} value={countedCashYen} onChange={(event) => { setCounted(Number(event.target.value)); closeKey.current = ""; }} /></label><p>実査差額 {cashYen(countedCashYen - register.expectedCashYen)}</p><label className="createField"><span>締めメモ</span><textarea disabled={busy} maxLength={2000} value={note} onChange={(event) => { setNote(event.target.value); closeKey.current = ""; }} /></label><button className="primaryButton" disabled={busy}>レジを締める</button></form></div> : register.status === "CLOSED" ?
      <section className="adminPanel cashPanel cashStack"><h3>締め日報</h3><p>{register.closedAt ? new Date(register.closedAt).toLocaleString("ja-JP") : ""} / 実査 {cashYen(register.countedCashYen ?? 0)}</p>{register.closeSnapshot ? <><div className="cashMetrics"><div><span>会計 {register.closeSnapshot.salesCount}件</span><strong>{cashYen(register.closeSnapshot.salesTotalYen)}</strong></div><div><span>全額取消 {register.closeSnapshot.refundsCount}件</span><strong>{cashYen(register.closeSnapshot.refundsTotalYen)}</strong></div><div><span>正味金額</span><strong>{cashYen(register.closeSnapshot.netTotalYen)}</strong></div></div><p>値引 {cashYen(register.closeSnapshot.discountYen)} / 内税 {cashYen(register.closeSnapshot.taxYen)} / 返金内税 {cashYen(register.closeSnapshot.refundsTaxYen)}</p><table className="adminTable"><thead><tr><th>方法</th><th>会計</th><th>取消</th><th>正味</th></tr></thead><tbody>{register.closeSnapshot.paymentTotals.map((payment) => <tr key={payment.method}><td>{cashMethodLabels[payment.method as CashPayment["method"]]}</td><td>{cashYen(payment.salesYen)}</td><td>{cashYen(payment.refundsYen)}</td><td>{cashYen(payment.netYen)}</td></tr>)}</tbody></table></> : null}<p>{register.note}</p></section> : null}
    <div className="cashFooter"><TenantLink className="secondaryButton" href="/register">レジ一覧へ</TenantLink><button className="secondaryButton" disabled={busy} onClick={() => void reload()}>最新の状態を取得</button></div>
  </div>;
}

export function CashReceiptPrint() { return <button className="primaryButton cashNoPrint" type="button" onClick={() => window.print()}>会計控えを印刷</button>; }
