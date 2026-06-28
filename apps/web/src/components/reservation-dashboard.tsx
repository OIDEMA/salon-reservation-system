"use client";

import {
  AlertCircle,
  Bell,
  BookUser,
  Building2,
  CalendarCheck,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Columns3,
  Filter,
  LayoutDashboard,
  Plus,
  Printer,
  RefreshCw,
  Scissors,
  Search,
  Settings,
  Tags,
  UserRound,
  Users,
  Wrench,
  XCircle
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { ja } from "date-fns/locale";
import { useEffect, useMemo, useState } from "react";
import { fetchDashboard } from "@/lib/api";
import { mockDashboard } from "@/lib/mock-dashboard";
import type { DashboardData, ReservationStatus, ScheduleReservation } from "@/lib/types";

const HOUR_WIDTH = 132;
const ROW_HEIGHT = 76;
const HEADER_HEIGHT = 42;

const statusMeta: Record<ReservationStatus, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  PENDING: { label: "未確認", className: "statusPending", icon: AlertCircle },
  CONFIRMED: { label: "確定", className: "statusConfirmed", icon: CheckCircle2 },
  ARRIVED: { label: "来店", className: "statusArrived", icon: UserRound },
  COMPLETED: { label: "完了", className: "statusCompleted", icon: CheckCircle2 },
  CANCELLED: { label: "取消", className: "statusCancelled", icon: XCircle },
  NO_SHOW: { label: "無断", className: "statusCancelled", icon: XCircle },
  WAITLIST: { label: "待ち", className: "statusWaitlist", icon: Clock3 }
};

const navItems = [
  { href: "/", label: "予約表", icon: LayoutDashboard },
  { href: "/confirmation", label: "予約確認", icon: CircleAlert },
  { href: "/calendar", label: "店舗カレンダー", icon: CalendarDays },
  { href: "/reservations", label: "予約者検索", icon: Search },
  { href: "/settings", label: "基本設定", icon: Settings },
  { href: "/staff", label: "スタッフ", icon: Users },
  { href: "/menus", label: "メニュー", icon: Scissors },
  { href: "/categories", label: "カテゴリー", icon: Tags },
  { href: "/equipment", label: "設備", icon: Wrench },
  { href: "/customers", label: "顧客", icon: BookUser }
];

function toMinutes(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function formatDisplayDate(date: string) {
  return format(parseISO(`${date}T00:00:00`), "yyyy年MM月dd日 (EEE)", { locale: ja });
}

function addDays(date: string, days: number) {
  const next = parseISO(`${date}T00:00:00`);
  next.setDate(next.getDate() + days);
  return format(next, "yyyy-MM-dd");
}

function iconButtonLabel(label: string, icon: React.ReactNode) {
  return (
    <>
      {icon}
      <span>{label}</span>
    </>
  );
}

export function ReservationDashboard() {
  const [date, setDate] = useState("2026-06-28");
  const [dashboard, setDashboard] = useState<DashboardData>(mockDashboard);
  const [selectedId, setSelectedId] = useState("res-003");
  const [statusFilter, setStatusFilter] = useState<"ALL" | ReservationStatus>("ALL");
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"timeline" | "agenda">("timeline");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let ignore = false;
    setIsLoading(true);
    fetchDashboard(date)
      .then((data) => {
        if (!ignore) {
          setDashboard(data);
          if (!data.reservations.some((reservation) => reservation.id === selectedId)) {
            setSelectedId(data.reservations[0]?.id ?? "");
          }
        }
      })
      .finally(() => {
        if (!ignore) {
          setIsLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [date, selectedId]);

  const timeline = useMemo(() => {
    const start = toMinutes(dashboard.hours.start);
    const end = toMinutes(dashboard.hours.end);
    const hourCount = (end - start) / 60;
    const hours = Array.from({ length: hourCount + 1 }, (_, index) => {
      const hour = Math.floor(start / 60) + index;
      return `${String(hour).padStart(2, "0")}:00`;
    });
    return { start, end, width: hourCount * HOUR_WIDTH, hours };
  }, [dashboard.hours.end, dashboard.hours.start]);

  const filteredReservations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return dashboard.reservations.filter((reservation) => {
      const matchesStatus = statusFilter === "ALL" || reservation.status === statusFilter;
      const matchesQuery =
        normalizedQuery.length === 0 ||
        [reservation.customerName, reservation.customerKana, reservation.serviceName, reservation.memo, reservation.tags.join(" ")]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery);
      return matchesStatus && matchesQuery;
    });
  }, [dashboard.reservations, query, statusFilter]);

  const currentMinute = toMinutes("17:48") - timeline.start;
  const boardHeight = dashboard.rows.length * ROW_HEIGHT;

  return (
    <main className="appShell">
      <aside className="adminSidebar">
        <a className="adminBrand" href="/" title="SalonOps">
          <CalendarCheck size={25} />
        </a>
        <nav className="adminNav" aria-label="admin navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <a className={item.href === "/" ? "adminNavItem isActive" : "adminNavItem"} href={item.href} key={item.href} title={item.label}>
                <Icon size={21} />
                <span>{item.label}</span>
              </a>
            );
          })}
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="storeIdentity">
            <Building2 size={20} />
            <div>
              <p>{dashboard.salon.name}</p>
              <span>{dashboard.salon.plan} / {dashboard.salon.timezone}</span>
            </div>
          </div>
          <div className="noticeRail">
            {dashboard.notifications.map((notification) => (
              <button className={`noticePill ${notification.severity}`} key={notification.id} type="button">
                <Bell size={15} />
                <span>{notification.title}</span>
              </button>
            ))}
          </div>
        </header>

        <div className="contentGrid">
          <section className="mainPane">
            <div className="commandSurface">
              <div className="dateControls">
                <button className="secondaryButton" type="button" onClick={() => setDate(addDays(date, -1))}>
                  {iconButtonLabel("前日", <ChevronLeft size={18} />)}
                </button>
                <div className="dateBadge">
                  <strong>{formatDisplayDate(date)}</strong>
                  <CalendarDays size={25} />
                </div>
                <button className="secondaryButton" type="button" onClick={() => setDate(format(new Date(), "yyyy-MM-dd"))}>
                  本日
                </button>
                <button className="secondaryButton" type="button" onClick={() => setDate(addDays(date, 1))}>
                  {iconButtonLabel("翌日", <ChevronRight size={18} />)}
                </button>
              </div>

              <div className="actionCluster">
                <button className="primaryButton" type="button" onClick={() => setDate(date)}>
                  {iconButtonLabel(isLoading ? "同期中" : "更新", <RefreshCw size={18} />)}
                </button>
                <div className="segmentedControl" aria-label="view mode">
                  <button className={viewMode === "timeline" ? "isSelected" : ""} type="button" onClick={() => setViewMode("timeline")} title="時間軸">
                    <Columns3 size={17} />
                  </button>
                  <button className={viewMode === "agenda" ? "isSelected" : ""} type="button" onClick={() => setViewMode("agenda")} title="一覧">
                    <CalendarRange size={17} />
                  </button>
                </div>
                <button className="primaryButton" type="button">
                  {iconButtonLabel("印刷", <Printer size={18} />)}
                </button>
                <button className="primaryButton" type="button">
                  {iconButtonLabel("複数日程", <CalendarRange size={18} />)}
                </button>
                <a className="primaryButton" href="/confirmation">
                  {iconButtonLabel("予約確認", <AlertCircle size={18} />)}
                </a>
              </div>
            </div>

            <div className="filterBar">
              <label className="searchBox">
                <Search size={18} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="顧客・メニュー・メモを検索" />
              </label>
              <div className="filterButtons">
                {(["ALL", "PENDING", "CONFIRMED", "WAITLIST"] as const).map((status) => (
                  <button key={status} className={statusFilter === status ? "filterButton isSelected" : "filterButton"} type="button" onClick={() => setStatusFilter(status)}>
                    <Filter size={15} />
                    <span>{status === "ALL" ? "すべて" : statusMeta[status].label}</span>
                  </button>
                ))}
              </div>
              <a className="createButton" href="/reservations/new">
                {iconButtonLabel("新規予約", <Plus size={18} />)}
              </a>
            </div>

            {viewMode === "timeline" ? (
              <div className="scheduleShell">
                <div className="resourceColumn">
                  <div className="resourceHeader">予約枠</div>
                  {dashboard.rows.map((row) => (
                    <div className="resourceCell" key={row.id}>
                      <span className="resourceDot" style={{ backgroundColor: row.color }} />
                      <div>
                        <strong>{row.label}</strong>
                        <small>{row.subtitle}</small>
                      </div>
                      <em>{row.count}</em>
                    </div>
                  ))}
                </div>
                <div className="timelineScroller">
                  <div className="timelineCanvas" style={{ width: timeline.width, height: boardHeight + HEADER_HEIGHT }}>
                    <div className="timeHeader" style={{ height: HEADER_HEIGHT }}>
                      {timeline.hours.slice(0, -1).map((hour, index) => (
                        <div className="timeCell" key={hour} style={{ left: index * HOUR_WIDTH, width: HOUR_WIDTH }}>
                          {hour}
                        </div>
                      ))}
                    </div>
                    <div className="gridLayer" style={{ top: HEADER_HEIGHT, height: boardHeight }}>
                      {dashboard.rows.map((row, rowIndex) => (
                        <div className="gridRow" key={row.id} style={{ top: rowIndex * ROW_HEIGHT, height: ROW_HEIGHT }} />
                      ))}
                      {timeline.hours.map((hour, index) => (
                        <div className="hourLine" key={hour} style={{ left: index * HOUR_WIDTH }} />
                      ))}
                      {timeline.hours.slice(0, -1).map((hour, index) => (
                        <div className="halfHourLine" key={`${hour}-half`} style={{ left: index * HOUR_WIDTH + HOUR_WIDTH / 2 }} />
                      ))}
                      {dashboard.blocks.map((block) => {
                        const rowIndex = dashboard.rows.findIndex((row) => row.id === block.rowId);
                        if (rowIndex < 0) return null;
                        return (
                          <div
                            className={`scheduleBlock ${block.kind === "SALES_STOP" ? "salesStop" : ""}`}
                            key={block.id}
                            style={{
                              left: ((toMinutes(block.startTime) - timeline.start) / 60) * HOUR_WIDTH,
                              top: rowIndex * ROW_HEIGHT + 8,
                              width: ((toMinutes(block.endTime) - toMinutes(block.startTime)) / 60) * HOUR_WIDTH,
                              height: ROW_HEIGHT - 14
                            }}
                          >
                            <span>{block.startTime}-{block.endTime}</span>
                            <strong>{block.label}</strong>
                          </div>
                        );
                      })}
                      {filteredReservations.map((reservation) => {
                        const rowIndex = dashboard.rows.findIndex((row) => row.id === reservation.rowId);
                        if (rowIndex < 0) return null;
                        return (
                          <ReservationCard
                            key={reservation.id}
                            reservation={reservation}
                            selected={reservation.id === selectedId}
                            style={{
                              left: ((toMinutes(reservation.startTime) - timeline.start) / 60) * HOUR_WIDTH,
                              top: rowIndex * ROW_HEIGHT + 12,
                              width: Math.max(72, ((toMinutes(reservation.endTime) - toMinutes(reservation.startTime)) / 60) * HOUR_WIDTH - 8),
                              height: ROW_HEIGHT - 20
                            }}
                            onSelect={() => setSelectedId(reservation.id)}
                          />
                        );
                      })}
                      <div className="nowLine" style={{ left: (currentMinute / 60) * HOUR_WIDTH }}>
                        <span />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <Agenda reservations={filteredReservations} selectedId={selectedId} onSelect={setSelectedId} />
            )}
          </section>
        </div>
      </section>
    </main>
  );
}

function ReservationCard({
  reservation,
  selected,
  style,
  onSelect
}: {
  reservation: ScheduleReservation;
  selected: boolean;
  style: React.CSSProperties;
  onSelect: () => void;
}) {
  const StatusIcon = statusMeta[reservation.status].icon;
  return (
    <button className={`reservationCard ${statusMeta[reservation.status].className} ${selected ? "isSelected" : ""}`} style={style} type="button" onClick={onSelect}>
      <span className="cardTime">{reservation.startTime}-{reservation.endTime}</span>
      <strong>{reservation.customerName}</strong>
      <small>{reservation.serviceName}</small>
      <em>
        {reservation.isRequest ? "指" : "フ"}
        <StatusIcon size={12} />
      </em>
    </button>
  );
}

function StatusBadge({ status }: { status: ReservationStatus }) {
  const StatusIcon = statusMeta[status].icon;
  return (
    <span className={`statusBadge ${statusMeta[status].className}`}>
      <StatusIcon size={14} />
      {statusMeta[status].label}
    </span>
  );
}

function Agenda({
  reservations,
  selectedId,
  onSelect
}: {
  reservations: ScheduleReservation[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="agendaView">
      {reservations.map((reservation) => (
        <button key={reservation.id} className={reservation.id === selectedId ? "agendaItem isSelected" : "agendaItem"} type="button" onClick={() => onSelect(reservation.id)}>
          <span>{reservation.startTime}</span>
          <strong>{reservation.customerName}</strong>
          <em>{reservation.serviceName}</em>
          <StatusBadge status={reservation.status} />
        </button>
      ))}
    </div>
  );
}
