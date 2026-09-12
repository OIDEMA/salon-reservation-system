import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Plus } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { fetchDashboardServer } from "@/lib/server-dashboard";

const weekDays = ["日", "月", "火", "水", "木", "金", "土"];

export default async function TenantCalendarPage() {
  const now = new Date();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(now);
  const [year, monthNumber] = today.split("-").map(Number);
  const monthIndex = monthNumber - 1;
  const dashboard = await fetchDashboardServer(today);
  const month = buildMonth(year, monthIndex);
  const reservationsByDay = new Map<string, typeof dashboard.reservations>();
  reservationsByDay.set(today, dashboard.reservations);

  return (
    <AdminShell
      active="/calendar"
      title="店舗カレンダー"
      actions={
        <>
          <button className="secondaryButton" type="button">
            <ChevronLeft size={17} />
            前月
          </button>
          <button className="secondaryButton" type="button">
            <ChevronRight size={17} />
            翌月
          </button>
          <button className="primaryButton" type="button">
            <Plus size={17} />
            予定登録
          </button>
        </>
      }
    >
      <div className="calendarLayout">
        <section className="monthPanel">
          <div className="calendarWeekHeader">
            {weekDays.map((day) => <span key={day}>{day}</span>)}
          </div>
          <div className="calendarMonthGrid">
            {month.map((day) => {
              const key = toDateKey(day.date);
              const reservations = reservationsByDay.get(key) ?? [];
              const pending = reservations.filter((reservation) => reservation.status === "PENDING").length;
              return (
                <article className={key === today ? "calendarDay isToday" : "calendarDay"} key={key}>
                  <div className="calendarDayHead">
                    <strong>{day.date.getDate()}</strong>
                    {!day.inMonth ? <span>対象外</span> : null}
                  </div>
                  {reservations.length > 0 ? (
                    <div className="dayReservations">
                      <span>{reservations.length}件</span>
                      <small>{pending}件未確認</small>
                      {reservations.slice(0, 3).map((reservation) => (
                        <em key={reservation.id}>{reservation.startTime} {reservation.customerName}</em>
                      ))}
                    </div>
                  ) : (
                    <p className="emptyDay">空き</p>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <aside className="monthSide">
          <section className="adminPanel">
            <div className="adminPanelTitle">
              <CalendarDays size={19} />
              <h2>月間サマリー</h2>
            </div>
            <div className="summaryRows">
              <span>予約件数<strong>{dashboard.reservations.length}件</strong></span>
              <span>未確認<strong>{dashboard.summary.pendingCount}件</strong></span>
              <span>売上見込<strong>{dashboard.summary.revenue.toLocaleString("ja-JP")}円</strong></span>
              <span>稼働率<strong>{dashboard.summary.occupancyRate}%</strong></span>
            </div>
          </section>
          <section className="adminPanel">
            <div className="adminPanelTitle">
              <Clock3 size={19} />
              <h2>当日の確認順</h2>
            </div>
            <div className="miniTimeline">
              {dashboard.queue.map((reservation) => (
                <div key={reservation.id}>
                  <strong>{reservation.startTime}</strong>
                  <span>{reservation.customerName}</span>
                  <em>risk {reservation.riskScore}</em>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </AdminShell>
  );
}

function buildMonth(year: number, monthIndex: number) {
  const first = new Date(year, monthIndex, 1);
  const start = new Date(year, monthIndex, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      date,
      inMonth: date.getMonth() === monthIndex
    };
  });
}

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
