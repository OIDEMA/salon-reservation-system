"use client";

import type { ReservationHistoryDetail as HistoryDetail } from "@/lib/admin-types";
import { historyAmount, historyDate } from "@/lib/reservation-history";
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
    ["指名", history.nominated === null ? "未登録" : history.nominated ? "あり" : "なし"],
    ["メニュー", history.menuText || "未登録"],
    ["予約時金額", historyAmount(history.reservationAmount)],
    ["移行元の状態", history.sourceStatus],
    ["予約経路", history.sourceRoute || "未登録"],
    ["設備", history.equipmentName || "未登録"],
    ["サロンボード予約番号", history.externalReservationId],
    ["サロンボード顧客番号", history.customerNumber || "未登録"],
    ["取得日時", historyDate(history.capturedAt)],
    ["移行日時", historyDate(history.importedAt)]
  ];
  const allowedOriginal = can("chart.read") && history.canReadOriginal;
  const hasRawData = allowedOriginal && Array.isArray(history.rawHeaders) && Array.isArray(history.rawValues) && history.rawHeaders.length === history.rawValues.length;

  return <div className="historyDetail">
    <section className="adminPanel masterCreatePanel">
      <h2>移行元の予約情報</h2>
      <p className="historyContext">サロンボードに記録されていた内容を表示しています。予約時金額は移行元の予約価格です。</p>
      <dl className="historyDetailFields">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </section>
    <section className="adminPanel masterCreatePanel">
      <h2>元データの全項目</h2>
      {hasRawData ? <div className="historyRawScroll"><table className="adminTable historyRawTable">
        <thead><tr><th>項目</th><th>内容</th></tr></thead>
        <tbody>{history.rawHeaders!.map((header, index) => <tr key={index}><th scope="row"><small>{index + 1}</small>{header || "項目名なし"}</th><td>{history.rawValues![index] || "未登録"}</td></tr>)}</tbody>
      </table></div> : <p>{allowedOriginal ? "元データの全項目を取得できませんでした。" : "元データの全項目を閲覧するには、電子カルテの閲覧権限が必要です。"}</p>}
    </section>
  </div>;
}
