import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ReservationCalendar } from "../src/components/reservation-calendar";
import { TenantProvider } from "../src/components/tenant-provider";
import { adjacentCalendarMonth, calendarMonth, calendarMonthDays, calendarMonthLabel, type ReservationCalendarData } from "../src/lib/reservation-calendar";

test("calendar month defaults to the Japan month and rejects malformed or repeated invalid values", () => {
  const now = new Date("2026-10-31T15:00:00Z");
  assert.equal(calendarMonth(undefined, now), "2026-11");
  for (const invalid of ["", "2026-00", "2026-13", "2026-1", "2026-10-01", "0000-01", "invalid"]) {
    assert.equal(calendarMonth(invalid, now), "2026-11");
  }
  assert.equal(calendarMonth("2024-02", now), "2024-02");
  assert.equal(calendarMonth(["2026-09", "2026-12"], now), "2026-09");
  assert.equal(calendarMonth(["invalid", "2026-09"], now), "2026-11");
});

test("previous and next months cross years without skipping short months", () => {
  assert.equal(adjacentCalendarMonth("2026-01", -1), "2025-12");
  assert.equal(adjacentCalendarMonth("2026-12", 1), "2027-01");
  assert.equal(adjacentCalendarMonth("2026-03", -1), "2026-02");
  assert.equal(adjacentCalendarMonth("2024-01", 1), "2024-02");
  assert.equal(adjacentCalendarMonth("0001-01", -1), null);
  assert.equal(adjacentCalendarMonth("9999-12", 1), null);
  assert.equal(calendarMonthLabel("2026-09"), "2026年9月");
});

test("the calendar has six Monday-first weeks with leap days and adjacent months distinguished", () => {
  const leap = calendarMonthDays("2024-02");
  assert.equal(leap.length, 42);
  assert.equal(leap[0].date, "2024-01-29");
  assert.equal(leap[0].inMonth, false);
  assert.equal(leap.at(-1)?.date, "2024-03-10");
  assert.equal(leap.filter((day) => day.inMonth).length, 29);
  assert.deepEqual(leap.find((day) => day.date === "2024-02-29"), { date: "2024-02-29", day: 29, inMonth: true });
  assert.equal(calendarMonthDays("2026-02").filter((day) => day.inMonth).length, 28);
  assert.equal(calendarMonthDays("2026-06")[0].date, "2026-06-01");
  assert.equal(calendarMonthDays("2026-01")[0].date, "2025-12-29");
});

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "test" };
const calendar: ReservationCalendarData = {
  month: "2026-10",
  days: [
    { date: "2026-10-02", reservationCount: 6, pendingCount: 2, reservations: [{ id: "visible", startTime: "10:30", customerName: "選択月の顧客" }] },
    { date: "2026-09-30", reservationCount: 1, pendingCount: 0, reservations: [{ id: "outside", startTime: "09:00", customerName: "別月の顧客" }] }
  ],
  summary: { reservationCount: 12, pendingCount: 3, revenue: 12345, occupancyRate: 15 }
};

function render(month = calendar.month) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/calendar-test/calendar">
        <SearchParamsContext.Provider value={new URLSearchParams({ month })}>
          <TenantProvider tenantSlug="calendar-test" memberships={[{ role: "VIEWER", permissions: ["reservation.read"], tenant: {
            id: "tenant-test", slug: "calendar-test", name: "テスト店舗", salons: [{ id: "salon-test", name: "テスト店舗" }]
          } }]}>
            <ReservationCalendar calendar={{ ...calendar, month }} today="2026-10-23" todayQueue={[]} />
          </TenantProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

test("read-only users can navigate within the same tenant and see the selected month data", () => {
  const html = render();
  assert.match(html, /href="\/calendar-test\/calendar\?month=2026-09"/);
  assert.match(html, /href="\/calendar-test\/calendar\?month=2026-11"/);
  assert.match(html, /<h2>2026年10月<\/h2>/);
  assert.match(html, /10:30 選択月の顧客/);
  assert.doesNotMatch(html, /別月の顧客/);
  assert.match(html, /予約件数<strong>12件<\/strong>/);
  assert.match(html, /未確認<strong>3件<\/strong>/);
  assert.match(html, /売上見込<strong>12,345円<\/strong>/);
  assert.match(html, /稼働率<strong>15%<\/strong>/);
  assert.match(html, /data-date="2026-10-23"/);
  assert.equal((html.match(/class="calendarDay(?: isToday)?"/g) ?? []).length, 42);
});

test("year-boundary navigation uses the target year and no out-of-range links are rendered", () => {
  assert.match(render("2026-12"), /href="\/calendar-test\/calendar\?month=2027-01"/);
  assert.match(render("2026-01"), /href="\/calendar-test\/calendar\?month=2025-12"/);
  assert.doesNotMatch(render("0001-01"), /calendar\?month=0000-/);
  assert.doesNotMatch(render("9999-12"), /calendar\?month=10000-/);
});
