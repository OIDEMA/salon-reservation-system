import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Plus } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { TenantLink } from "@/components/tenant-link";
import { adjacentCalendarMonth, calendarMonthDays, calendarMonthLabel, type ReservationCalendarData } from "@/lib/reservation-calendar";
import type { ScheduleReservation } from "@/lib/types";

const weekDays = ["月", "火", "水", "木", "金", "土", "日"];

export function ReservationCalendar({ calendar, today, todayQueue }: {
  calendar: ReservationCalendarData;
  today: string;
  todayQueue: ScheduleReservation[];
}) {
  const previous = adjacentCalendarMonth(calendar.month, -1);
  const next = adjacentCalendarMonth(calendar.month, 1);
  const days = new Map(calendar.days.map((day) => [day.date, day]));

  return (
    <AdminShell
      active="/calendar"
      title="店舗カレンダー"
      actions={
        <>
          {previous ? <TenantLink className="secondaryButton" href={`/calendar?month=${previous}`}>
            <ChevronLeft size={17} />前月
          </TenantLink> : null}
          {next ? <TenantLink className="secondaryButton" href={`/calendar?month=${next}`}>
            <ChevronRight size={17} />翌月
          </TenantLink> : null}
          <button className="primaryButton" type="button"><Plus size={17} />予定登録</button>
        </>
      }
    >
      <div className="calendarLayout">
        <section className="monthPanel" aria-label={calendarMonthLabel(calendar.month)}>
          <div className="calendarMonthHeading"><h2>{calendarMonthLabel(calendar.month)}</h2></div>
          <div className="calendarWeekHeader">
            {weekDays.map((day) => <span key={day}>{day}</span>)}
          </div>
          <div className="calendarMonthGrid">
            {calendarMonthDays(calendar.month).map((day) => {
              const bookings = day.inMonth ? days.get(day.date) : undefined;
              return (
                <article className={day.date === today ? "calendarDay isToday" : "calendarDay"} data-date={day.date} key={day.date}>
                  <div className="calendarDayHead">
                    <strong><time dateTime={day.date}>{day.day}</time></strong>
                    {!day.inMonth ? <span>対象外</span> : null}
                  </div>
                  {bookings && bookings.reservationCount > 0 ? (
                    <div className="dayReservations">
                      <span>{bookings.reservationCount}件</span>
                      <small>{bookings.pendingCount}件未確認</small>
                      {bookings.reservations.map((reservation) => (
                        <em key={reservation.id}>{reservation.startTime} {reservation.customerName}</em>
                      ))}
                    </div>
                  ) : day.inMonth ? <p className="emptyDay">空き</p> : null}
                </article>
              );
            })}
          </div>
        </section>

        <aside className="monthSide">
          <section className="adminPanel">
            <div className="adminPanelTitle"><CalendarDays size={19} /><h2>月間サマリー</h2></div>
            <div className="summaryRows">
              <span>予約件数<strong>{calendar.summary.reservationCount}件</strong></span>
              <span>未確認<strong>{calendar.summary.pendingCount}件</strong></span>
              <span>売上見込<strong>{calendar.summary.revenue.toLocaleString("ja-JP")}円</strong></span>
              <span>稼働率<strong>{calendar.summary.occupancyRate}%</strong></span>
            </div>
          </section>
          <section className="adminPanel">
            <div className="adminPanelTitle"><Clock3 size={19} /><h2>本日の確認順</h2></div>
            <div className="miniTimeline">
              {todayQueue.map((reservation) => (
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
