"use client";

import type { ReservationHistoryDetail as HistoryDetail } from "@/lib/admin-types";
import { historyAmount, historyDate } from "@/lib/reservation-history";
import { TenantLink } from "./tenant-link";
import { usePermissions } from "./tenant-provider";

export function ReservationHistoryDetail({ history }: { history: HistoryDetail }) {
  const { can } = usePermissions();
  if (!can("reservation.read")) return <p className="formMessage error" role="alert">予約履歴を閲覧する権限がありません。</p>;
  const rows = [
    ["予約日時", historyDate(history.startsAt)],
    ["終了日時", historyDate(history.endsAt)],
    ["所要時間", history.durationMinutes === null ? "未登録" : `${history.durationMinutes}分`],
    ["顧客名", history.customerName],
    ["カナ", history.customerKana || "未登録"],
    ["担当", history.staffName || "担当未登録"],
    ["担当の紐付け", history.staffId ? "紐付け済み" : "未紐付け"],
    ["指名", history.nominated === null ? "未登録" : history.nominated ? "あり" : "なし"],
    ["メニュー", history.menuText || "未登録"],
    ["予約時金額", historyAmount(history.reservationAmount)],
    ["状態", history.sourceStatus],
    ["予約経路", history.sourceRoute || "未登録"],
    ["設備", history.equipmentName || "未登録"],
    ["予約番号", history.externalReservationId],
    ["顧客番号", history.customerNumber || "未登録"]
  ];
  const allowedOriginal = can("chart.read") && history.canReadOriginal;
  const hasRawData = allowedOriginal && Array.isArray(history.rawHeaders) && Array.isArray(history.rawValues) && history.rawHeaders.length === history.rawValues.length;

  const boardDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(history.scheduleOverride?.startsAt ?? history.startsAt));

  return <div className="historyDetail">
    <div className="adminActions"><TenantLink className="secondaryButton" href={`/?date=${encodeURIComponent(boardDate)}`}>予約表で確認</TenantLink></div>
    {history.scheduleOverride ? <section className="adminPanel masterCreatePanel">
      <h2>予約表の表示位置</h2>
      <dl className="historyDetailFields">
        <div><dt>予約日時</dt><dd>{historyDate(history.scheduleOverride.startsAt)}</dd></div>
        <div><dt>終了日時</dt><dd>{historyDate(history.scheduleOverride.endsAt)}</dd></div>
        <div><dt>担当</dt><dd>{history.scheduleOverride.staffName || "指名なし"}</dd></div>
      </dl>
      <p className="historyContext">予約表で変更した日時と担当です。</p>
    </section> : null}
    <section className="adminPanel masterCreatePanel">
      <h2>予約の記録</h2>
      <dl className="historyDetailFields">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </section>
    <section className="adminPanel masterCreatePanel">
      <h2>詳細情報</h2>
      {hasRawData ? <div className="historyRawScroll"><table className="adminTable historyRawTable">
        <thead><tr><th>項目</th><th>内容</th></tr></thead>
        <tbody>{history.rawHeaders!.map((header, index) => <tr key={index}><th scope="row"><small>{index + 1}</small>{header || "項目名なし"}</th><td>{history.rawValues![index] || "未登録"}</td></tr>)}</tbody>
      </table></div> : <p>{allowedOriginal ? "詳細情報を取得できませんでした。" : "詳細情報を閲覧するには、電子カルテの閲覧権限が必要です。"}</p>}
    </section>
  </div>;
}
