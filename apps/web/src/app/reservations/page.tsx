import { CalendarCheck, CheckCircle2, CreditCard, MessageCircle, Search } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { fetchDashboard } from "@/lib/api";

const yen = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0
});

export default async function ReservationSearchPage() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  const dashboard = await fetchDashboard(today);

  return (
    <AdminShell
      active="/reservations"
      title="予約者検索"
      subtitle="顧客名、来店状況、決済、LINE通知状態をまとめて確認します。"
      badge={`${dashboard.reservations.length}件`}
      actions={
        <a className="primaryButton" href="/reservations/new">
          <CalendarCheck size={17} />
          予約を作成
        </a>
      }
    >
      <div className="adminContent">
        <section className="searchPanel">
          <label className="searchBox wide">
            <Search size={18} />
            <input placeholder="顧客名・カナ・メニュー・メモで検索" />
          </label>
          <select defaultValue="ALL">
            <option value="ALL">全ステータス</option>
            <option value="PENDING">未確認</option>
            <option value="CONFIRMED">確定</option>
          </select>
          <select defaultValue={today}>
            <option value={today}>{today.replaceAll("-", "/")}</option>
          </select>
          <button className="primaryButton" type="button">検索</button>
        </section>

        <section className="metricStrip">
          <div className="metricCard red">
            <div><MessageCircle size={19} /></div>
            <span>未確認</span>
            <strong>{dashboard.summary.pendingCount}件</strong>
          </div>
          <div className="metricCard green">
            <div><CheckCircle2 size={19} /></div>
            <span>確定</span>
            <strong>{dashboard.summary.confirmedCount}件</strong>
          </div>
          <div className="metricCard amber">
            <div><CreditCard size={19} /></div>
            <span>売上見込</span>
            <strong>{yen.format(dashboard.summary.revenue)}</strong>
          </div>
        </section>

        <section className="tablePanel">
          <table className="adminTable reservationTable">
            <thead>
              <tr>
                <th>予約時間</th>
                <th>顧客名</th>
                <th>メニュー</th>
                <th>担当</th>
                <th>価格</th>
                <th>LINE</th>
                <th>決済</th>
                <th>リスク</th>
                <th>メモ</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.reservations.map((reservation) => {
                const row = dashboard.rows.find((item) => item.id === reservation.rowId);
                return (
                  <tr key={reservation.id}>
                    <td><strong>{reservation.startTime}-{reservation.endTime}</strong></td>
                    <td>
                      <strong>{reservation.customerName}</strong>
                      <small>{reservation.customerKana} / 来店{reservation.visitCount}回</small>
                    </td>
                    <td>{reservation.serviceName}</td>
                    <td>{row?.label ?? "指名なし"}</td>
                    <td>{yen.format(reservation.price)}</td>
                    <td><span className="statusChip on">{reservation.lineStatus}</span></td>
                    <td>{reservation.paymentStatus}</td>
                    <td><span className={reservation.riskScore >= 50 ? "riskBadge high" : "riskBadge"}>{reservation.riskScore}</span></td>
                    <td className="descriptionCell">{reservation.memo}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>
    </AdminShell>
  );
}
