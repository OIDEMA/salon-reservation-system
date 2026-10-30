"use client";

import { Camera, ScanLine, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTenant, useTenantSlug } from "./tenant-provider";
import { tenantApiPath } from "../lib/tenant-routing";
import {
  membershipFromPointInput, membershipRedemptionLimit, membershipRequest, membershipSelectionForLookup, normalizeMembershipBarcode,
  type MembershipLookup,
} from "../lib/membership-checkout";
import type { CashMembership } from "./cash-types";

type Detector = { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> };
type DetectorConstructor = { new(options: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> };
const points = (value: number) => `${value.toLocaleString("ja-JP")} pt`;
const historyLabels = { EARN: "ポイント付与", REDEEM: "ポイント利用", REFUND: "利用ポイント返還", EARN_REVERSAL: "付与ポイント取消" };

function MembershipCamera({ onCode, onClose, onError }: {
  onCode: (code: string) => void; onClose: () => void; onError: (message: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [hint, setHint] = useState("会員証のバーコード・QRコードをカメラへ向けてください。");
  const handlers = useRef({ onCode, onClose, onError });
  handlers.current = { onCode, onClose, onError };
  useEffect(() => {
    let stopped = false; let stream: MediaStream | null = null; let timer: ReturnType<typeof setTimeout> | null = null;
    const visibility = () => { if (document.visibilityState !== "visible") handlers.current.onClose(); };
    document.addEventListener("visibilitychange", visibility);
    void (async () => {
      try {
        const Constructor = (window as typeof window & { BarcodeDetector?: DetectorConstructor }).BarcodeDetector;
        if (!Constructor || !navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");
        const supported = Constructor.getSupportedFormats ? await Constructor.getSupportedFormats() : ["code_128", "qr_code"];
        const formats = ["code_128", "qr_code"].filter((format) => supported.includes(format));
        if (!formats.length) throw new Error("unsupported");
        if (stopped) return;
        if (!formats.includes("code_128")) setHint("このブラウザではQRコードを読み取れます。バーコードは外部リーダー、または番号入力をご利用ください。");
        else if (!formats.includes("qr_code")) setHint("このブラウザでは会員証のバーコードを読み取れます。QRコードは外部リーダーをご利用ください。");
        const detector = new Constructor({ formats });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (stopped) { stream.getTracks().forEach((track) => track.stop()); return; }
        const target = video.current;
        if (!target) return;
        target.srcObject = stream;
        await target.play();
        async function detect() {
          if (stopped || !target) return;
          try {
            if (target.readyState >= 2) {
              const results = await detector.detect(target);
              if (stopped) return;
              for (const result of results) {
                try {
                  const code = normalizeMembershipBarcode(result.rawValue);
                  stopped = true; handlers.current.onCode(code); return;
                } catch { /* Other QR codes must not trigger a member lookup. */ }
              }
            }
            if (!stopped) timer = setTimeout(() => { void detect(); }, 250);
          } catch {
            if (!stopped) { handlers.current.onError("カメラで読み取れません。外部リーダー、または会員番号の入力をご利用ください。"); handlers.current.onClose(); }
          }
        }
        void detect();
      } catch (problem) {
        if (stopped) return;
        handlers.current.onError(problem instanceof Error && problem.message === "unsupported"
          ? "このブラウザはカメラ読み取りに対応していません。外部リーダー、または会員番号の入力をご利用ください。"
          : "カメラを利用できません。カメラの許可を確認するか、外部リーダー・会員番号の入力をご利用ください。");
        handlers.current.onClose();
      }
    })();
    return () => { stopped = true; if (timer) clearTimeout(timer); stream?.getTracks().forEach((track) => track.stop()); if (video.current) video.current.srcObject = null; document.removeEventListener("visibilitychange", visibility); };
  }, []);
  return <div className="membershipCamera"><video ref={video} autoPlay playsInline muted aria-label="会員証読み取り用カメラ" />
    <p>{hint}</p>
    <button type="button" className="secondaryButton" onClick={onClose}><X size={16} />カメラを閉じる</button></div>;
}

export function MembershipDetails({ lookup }: { lookup: MembershipLookup }) {
  return <div className="membershipDetails">
    <div className="membershipIdentity"><strong>{lookup.member.name} 様</strong><span>会員番号 {lookup.member.number}</span></div>
    <dl className="membershipBalances"><div><dt>現在の共通ポイント</dt><dd>{points(lookup.member.balance)}</dd></div>
      <div><dt>利用可能ポイント</dt><dd>{points(lookup.member.availablePoints)}</dd></div></dl>
    <details className="membershipHistory"><summary>この店舗のポイント履歴</summary>
      {lookup.history.length ? <ul>{lookup.history.map((entry) => <li key={entry.id}>
        <div><time>{new Date(entry.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
          <span>{historyLabels[entry.kind]} / {entry.salonName}</span></div><strong>{entry.delta > 0 ? "+" : ""}{points(entry.delta)}</strong>
      </li>)}</ul> : <p>この店舗のポイント履歴はありません。</p>}
    </details>
  </div>;
}

export function MembershipPointsInput({ id, value, limit, valid, disabled, allowRedemption, onChange }: {
  id: string; value: string; limit: number; valid: boolean; disabled: boolean; allowRedemption: boolean;
  onChange: (input: string) => void;
}) {
  return <div className="membershipDecision">
    <label className="createField" htmlFor={`${id}-points`}><span>利用ポイント</span>
      <input id={`${id}-points`} type="number" inputMode="numeric" min={0} max={allowRedemption ? limit : 0} step={100}
        value={allowRedemption ? value : "0"} disabled={disabled} readOnly={!allowRedemption}
        aria-invalid={!valid || undefined} aria-describedby={`${id}-points-help`} onChange={(event) => onChange(event.target.value)} />
      <small id={`${id}-points-help`}>1ポイント＝1円、100ポイント（100円）単位。今回の上限 {points(allowRedemption ? limit : 0)}。</small>
      {!valid && <small className="cashDifference" role="alert">利用できる範囲で、0以上の100ポイント単位で入力してください。</small>}
    </label>
    {!allowRedemption && <p className="cashNotice">入金済みのため、後からポイント値引きはできません。</p>}
    <p className="cashReceiptFootnote">読み取り・下書き保存では残高を減らしません。ポイントは会計確定時に更新します。</p>
  </div>;
}

export function MembershipConfirmation({ checkoutId, reservationId, customerId, customerName, beforePointsYen,
  value, readOnly, disabled, canLookup, canLink, allowRedemption, onChange, onPendingChange }: {
  checkoutId: string; reservationId: string; customerId?: string; customerName: string; beforePointsYen: number;
  value: CashMembership | null; readOnly: boolean; disabled: boolean; canLookup: boolean; canLink: boolean;
  allowRedemption: boolean;
  onChange: (membership: CashMembership) => void; onPendingChange: (pending: boolean) => void;
}) {
  const slug = useTenantSlug(); const { activeSalonId } = useTenant();
  const id = useId(); const [open, setOpen] = useState(false); const [barcode, setBarcode] = useState("");
  const [lookup, setLookup] = useState<MembershipLookup | null>(null); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""); const [confirmed, setConfirmed] = useState(false);
  const [pointsInput, setPointsInput] = useState(""); const [camera, setCamera] = useState(false);
  const sequence = useRef(0); const controller = useRef<AbortController | null>(null); const busyRef = useRef(false);
  const mounted = useRef(true); const scope = `${slug}:${activeSalonId ?? ""}:${checkoutId}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const pendingCallback = useRef(onPendingChange); pendingCallback.current = onPendingChange;
  const input = useRef<HTMLInputElement>(null);
  const limit = lookup ? membershipRedemptionLimit(lookup, beforePointsYen) : 0;
  const pointsValid = /^\d+$/.test(pointsInput) && Number.isSafeInteger(Number(pointsInput))
    && Number(pointsInput) >= 0 && Number(pointsInput) % 100 === 0 && Number(pointsInput) <= limit
    && (allowRedemption || Number(pointsInput) === 0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current++; controller.current?.abort(); };
  }, []);
  useEffect(() => {
    sequence.current++; controller.current?.abort(); busyRef.current = false;
    setOpen(false); setBarcode(""); setLookup(null); setBusy(false); setError(""); setConfirmed(false); setCamera(false);
    pendingCallback.current(false);
  }, [scope]);
  useEffect(() => { if (disabled) setCamera(false); }, [disabled]);
  useEffect(() => {
    if (open && lookup?.linkStatus === "LINKED" && !readOnly) pendingCallback.current(!pointsValid);
  }, [open, lookup, readOnly, pointsValid]);

  function invalidate() { sequence.current++; controller.current?.abort(); busyRef.current = false; setBusy(false); }
  function close() { invalidate(); setOpen(false); setLookup(null); setError(""); setConfirmed(false); setCamera(false); onPendingChange(false); }
  function changeBarcode(next: string) {
    invalidate(); setBarcode(next); setLookup(null); setError(""); setConfirmed(false); setCamera(false);
    if (!readOnly) onPendingChange(true);
  }
  async function runLookup(code: string, link = false) {
    if (disabled || busyRef.current || !canLookup) return;
    let normalized: string;
    try { normalized = normalizeMembershipBarcode(code); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "会員番号をご確認ください。"); return; }
    if (link && (!canLink || !confirmed || !lookup || !customerId)) return;
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    const ticket = ++sequence.current; const requestScope = scope;
    const current = () => mounted.current && ticket === sequence.current && currentScope.current === requestScope;
    const timeout = setTimeout(() => request.abort(), 15000);
    busyRef.current = true; setBusy(true); setError(""); setCamera(false);
    if (!link) { setLookup(null); setConfirmed(false); }
    if (!readOnly) onPendingChange(true);
    try {
      const result = await membershipRequest(tenantApiPath(slug, link ? `/admin/customers/${encodeURIComponent(customerId!)}/membership-link` : "/membership/lookup"),
        link ? { barcode: normalized, expectedMemberId: lookup!.member.id, confirmed: true }
          : { barcode: normalized, ...(readOnly ? { reservationId } : { checkoutId }) }, request.signal);
      if (!current()) return;
      if (result.linkStatus === "LINKED" && customerId && result.customerId !== customerId) throw new Error("予約のお客様と会員の連携先が異なります。店舗の管理者にお問い合わせください。");
      setLookup(result); setBarcode(normalized); setConfirmed(false);
      const previous = value?.accountId === result.member.id ? value : null;
      if (!readOnly && result.linkStatus === "LINKED") {
        const restored = membershipSelectionForLookup(result, previous, beforePointsYen, allowRedemption);
        setPointsInput(String(restored.value.pointsToUse)); onChange(restored.value); onPendingChange(false);
        if (restored.reset && allowRedemption) setError("保存されていた利用ポイントは最新の条件で利用できないため、0ポイントに戻しました。利用する場合は入力し直してください。");
      } else if (!readOnly) onPendingChange(true);
    } catch (problem) {
      if (current()) setError(request.signal.aborted ? "照会に時間がかかっています。通信を確認して読み取り直してください。" : problem instanceof Error ? problem.message : "会員情報を取得できませんでした。");
    } finally { clearTimeout(timeout); if (current()) { busyRef.current = false; setBusy(false); } }
  }
  function changePoints(input: string) {
    if (!lookup || disabled || busy || readOnly) return;
    setPointsInput(input);
    try {
      onChange(membershipFromPointInput(lookup, input, beforePointsYen, allowRedemption)); setError(""); onPendingChange(false);
    } catch { onPendingChange(true); }
  }

  return <section className="membershipPanel" aria-labelledby={`${id}-heading`}>
    <div className="membershipHeading"><h3 id={`${id}-heading`}>会員証・ポイント確認</h3>
      {open && <button type="button" className="miniButton" disabled={disabled || busy} onClick={close}>読み取りを閉じる</button>}</div>
    {value && !open && <div className="membershipSaved"><strong>{value.memberName} 様</strong><span>会員番号 {value.memberNumber}</span>
      <span>利用ポイント {points(value.pointsToUse)}（{value.pointsToUse.toLocaleString("ja-JP")}円）</span>
      {value.pointsAwarded !== undefined && <span>今回の付与 {points(value.pointsAwarded)}</span>}</div>}
    {!open ? <>
      {canLookup ? <button type="button" className="secondaryButton" disabled={disabled} onClick={() => {
        setOpen(true); setBarcode(value?.memberNumber ?? ""); setLookup(null); setError(""); setConfirmed(false);
        if (!readOnly) onPendingChange(true);
        setTimeout(() => input.current?.focus(), 0);
      }}><ScanLine size={18} />{value || readOnly ? "会員情報・残高を確認する" : "会員証を読み取る"}</button>
        : !value ? <p className="cashReceiptFootnote">会員情報を照会する権限がありません。</p> : null}
      {!value && readOnly && <p className="cashReceiptFootnote">この会計には会員の利用記録がありません。</p>}
    </> : <div className="membershipScan">
      <div className="membershipBarcodeRow"><label className="createField" htmlFor={`${id}-barcode`}><span>会員番号・バーコード</span>
        <input ref={input} id={`${id}-barcode`} value={barcode} maxLength={80} autoComplete="off" inputMode="numeric" placeholder="13桁の会員番号"
          disabled={disabled} onChange={(event) => changeBarcode(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void runLookup(barcode); } }} /></label>
        <button type="button" className="primaryButton" disabled={disabled || busy || !barcode.trim()} onClick={() => void runLookup(barcode)}>{busy ? "確認中…" : "会員を確認"}</button>
        <button type="button" className="secondaryButton" disabled={disabled || busy} onClick={() => {
          invalidate(); setLookup(null); setConfirmed(false); setError(""); setCamera(true); if (!readOnly) onPendingChange(true);
        }}><Camera size={17} />カメラで読み取る</button></div>
      <p className="cashReceiptFootnote">外部バーコードリーダーは入力欄を選び、読み取り後にEnterを送信してください。</p>
      {camera && <MembershipCamera onCode={(code) => { setCamera(false); setBarcode(code); void runLookup(code); }} onClose={() => setCamera(false)} onError={setError} />}
      {error && <p className="formMessage error" role="alert">{error}</p>}
      {lookup && <>
        <MembershipDetails lookup={lookup} />
        {lookup.linkStatus === "MISMATCH" ? <p className="formMessage error" role="alert">この会員は別のお客様に連携されています。会員証と予約のお客様を確認し、店舗の管理者にお問い合わせください。</p>
          : lookup.linkStatus === "UNLINKED" ? <div className="membershipLink">
            <p>この会員は予約のお客様にまだ連携されていません。</p><p>予約のお客様：<strong>{customerName} 様</strong> ／ 会員：<strong>{lookup.member.name} 様</strong></p>
            {!readOnly && canLink && customerId ? <><label className="cashCheck"><input type="checkbox" checked={confirmed} disabled={disabled || busy} onChange={(event) => setConfirmed(event.target.checked)} />会員証とご本人を確認しました</label>
              <button type="button" className="secondaryButton" disabled={disabled || busy || !confirmed} onClick={() => void runLookup(barcode, true)}>このお客様と会員を連携</button></>
              : <p className="cashReceiptFootnote">顧客情報を変更できる担当者に、本人確認と会員の連携を依頼してください。</p>}
          </div>
            : !readOnly && <MembershipPointsInput id={id} value={pointsInput} limit={limit} valid={pointsValid}
              disabled={disabled || busy} allowRedemption={allowRedemption} onChange={changePoints} />}
      </>}
    </div>}
  </section>;
}
