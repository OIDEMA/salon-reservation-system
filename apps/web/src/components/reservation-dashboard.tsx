"use client";

import {
  AlertCircle,
  Bell,
  BookUser,
  Building2,
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
import { format, isValid, parseISO } from "date-fns";
import { ja } from "date-fns/locale";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchDashboard } from "@/lib/api";
import { LogoutButton } from "@/components/logout-button";
import { useTenantSlug } from "@/components/tenant-provider";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { TimelineReservationEditor, type TimelineEditorValue } from "@/components/timeline-reservation-editor";
import type { AdminMenu } from "@/lib/admin-types";
import { tenantApiPath, tenantPath } from "@/lib/tenant-routing";
import { createEmptyDashboard, type DashboardData, type ReservationStatus, type ScheduleReservation } from "@/lib/types";

const HOUR_WIDTH = 132;
const ROW_HEIGHT = 76;
const HEADER_HEIGHT = 42;

type TimelineInteraction =
  | {
      mode: "create";
      pointerId: number;
      rowIndex: number;
      anchorMinutes: number;
      currentMinutes: number;
    }
  | {
      mode: "move";
      pointerId: number;
      reservation: ScheduleReservation;
      rowIndex: number;
      startMinutes: number;
      durationMinutes: number;
      grabOffsetMinutes: number;
      originClientX: number;
      originClientY: number;
      moved: boolean;
    }
  | {
      mode: "resize";
      pointerId: number;
      reservation: ScheduleReservation;
      rowIndex: number;
      startMinutes: number;
      durationMinutes: number;
      originClientX: number;
      originClientY: number;
      moved: boolean;
    };

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

function toTime(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

async function responseError(response: Response) {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? `処理に失敗しました (${response.status})`;
}

function formatDisplayDate(date: string) {
  return format(parseISO(`${date}T00:00:00`), "yyyy年MM月dd日 (EEE)", { locale: ja });
}

function addDays(date: string, days: number) {
  const next = parseISO(`${date}T00:00:00`);
  next.setDate(next.getDate() + days);
  return format(next, "yyyy-MM-dd");
}

function validDateParam(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = parseISO(value);
  return isValid(parsed) && format(parsed, "yyyy-MM-dd") === value ? value : null;
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
  const tenantSlug = useTenantSlug();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const today = format(new Date(), "yyyy-MM-dd");
  const date = validDateParam(searchParams.get("date")) ?? today;
  const [dashboard, setDashboard] = useState<DashboardData>(() => createEmptyDashboard(date));
  const [selectedId, setSelectedId] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | ReservationStatus>("ALL");
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"timeline" | "agenda">("timeline");
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [menus, setMenus] = useState<AdminMenu[]>([]);
  const [editor, setEditor] = useState<TimelineEditorValue | null>(null);
  const [interaction, setInteraction] = useState<TimelineInteraction | null>(null);
  const [scheduleMessage, setScheduleMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isSavingSchedule, setIsSavingSchedule] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  function changeDate(nextDate: string) {
    const nextSearchParams = new URLSearchParams(searchParams.toString());
    nextSearchParams.set("date", nextDate);
    router.push(`${pathname}?${nextSearchParams.toString()}`, { scroll: false });
  }

  useEffect(() => {
    let ignore = false;
    setIsLoading(true);
    setLoadError("");
    fetchDashboard(date, tenantSlug)
      .then((data) => {
        if (!ignore) {
          setDashboard(data);
          setSelectedId((current) => data.reservations.some((reservation) => reservation.id === current) ? current : data.reservations[0]?.id ?? "");
        }
      })
      .catch(() => {
        if (!ignore) {
          setDashboard(createEmptyDashboard(date));
          setSelectedId("");
          setLoadError("予約データを取得できませんでした。APIとデータベースの状態を確認してください。");
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
  }, [date, refreshKey, tenantSlug]);

  useEffect(() => {
    let ignore = false;
    fetch(tenantApiPath(tenantSlug, "/services"), { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response));
        return response.json() as Promise<AdminMenu[]>;
      })
      .then((data) => { if (!ignore) setMenus(data); })
      .catch(() => { if (!ignore) setMenus([]); });
    return () => { ignore = true; };
  }, [tenantSlug]);

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

  const now = new Date();
  const currentMinute = now.getHours() * 60 + now.getMinutes() - timeline.start;
  const showNowLine = date === today && currentMinute >= 0 && currentMinute <= timeline.end - timeline.start;
  const boardHeight = dashboard.rows.length * ROW_HEIGHT;

  function pointerSlot(clientX: number, clientY: number) {
    const element = gridRef.current;
    if (!element || dashboard.rows.length === 0) return null;
    const bounds = element.getBoundingClientRect();
    const x = clamp(clientX - bounds.left, 0, timeline.width - 1);
    const y = clamp(clientY - bounds.top, 0, Math.max(0, boardHeight - 1));
    const rawMinutes = timeline.start + (x / HOUR_WIDTH) * 60;
    const step = dashboard.hours.stepMinutes;
    return {
      minutes: clamp(Math.floor(rawMinutes / step) * step, timeline.start, timeline.end - step),
      rowIndex: clamp(Math.floor(y / ROW_HEIGHT), 0, dashboard.rows.length - 1)
    };
  }

  function updateInteractionPosition(current: TimelineInteraction, clientX: number, clientY: number): TimelineInteraction {
    const slot = pointerSlot(clientX, clientY);
    if (!slot) return current;
    if (current.mode === "create") return { ...current, currentMinutes: slot.minutes, rowIndex: slot.rowIndex };
    if (current.mode === "move") {
      const startMinutes = clamp(
        slot.minutes - current.grabOffsetMinutes,
        timeline.start,
        timeline.end - current.durationMinutes
      );
      return {
        ...current,
        rowIndex: slot.rowIndex,
        startMinutes,
        moved: current.moved || Math.hypot(clientX - current.originClientX, clientY - current.originClientY) > 4
      };
    }
    const endMinutes = clamp(slot.minutes + dashboard.hours.stepMinutes, current.startMinutes + dashboard.hours.stepMinutes, timeline.end);
    return {
      ...current,
      durationMinutes: endMinutes - current.startMinutes,
      moved: current.moved || Math.hypot(clientX - current.originClientX, clientY - current.originClientY) > 4
    };
  }

  function handleGridPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || isSavingSchedule || (event.target as HTMLElement).closest("[data-reservation-card]")) return;
    const slot = pointerSlot(event.clientX, event.clientY);
    if (!slot) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setScheduleMessage(null);
    setInteraction({
      mode: "create",
      pointerId: event.pointerId,
      rowIndex: slot.rowIndex,
      anchorMinutes: slot.minutes,
      currentMinutes: slot.minutes
    });
  }

  function handleGridPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!interaction || interaction.pointerId !== event.pointerId || interaction.mode !== "create") return;
    setInteraction(updateInteractionPosition(interaction, event.clientX, event.clientY));
  }

  function finishGridInteraction(event: React.PointerEvent<HTMLDivElement>) {
    if (!interaction || interaction.pointerId !== event.pointerId || interaction.mode !== "create") return;
    const finalInteraction = updateInteractionPosition(interaction, event.clientX, event.clientY);
    if (finalInteraction.mode !== "create") return;
    const startMinutes = Math.min(finalInteraction.anchorMinutes, finalInteraction.currentMinutes);
    const endMinutes = Math.max(finalInteraction.anchorMinutes, finalInteraction.currentMinutes) + dashboard.hours.stepMinutes;
    const row = dashboard.rows[finalInteraction.rowIndex];
    setInteraction(null);
    if (!row) return;
    setEditor({
      kind: "create",
      date,
      startTime: toTime(startMinutes),
      durationMinutes: endMinutes - startMinutes,
      rowId: row.id
    });
  }

  function startReservationInteraction(event: React.PointerEvent<HTMLElement>, reservation: ScheduleReservation) {
    if (event.button !== 0 || isSavingSchedule) return;
    const slot = pointerSlot(event.clientX, event.clientY);
    if (!slot) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedId(reservation.id);
    setScheduleMessage(null);
    const startMinutes = toMinutes(reservation.startTime);
    const durationMinutes = toMinutes(reservation.endTime) - startMinutes;
    const resizing = Boolean((event.target as HTMLElement).closest("[data-resize-handle]"));
    setInteraction(
      resizing
        ? {
            mode: "resize",
            pointerId: event.pointerId,
            reservation,
            rowIndex: dashboard.rows.findIndex((row) => row.id === reservation.rowId),
            startMinutes,
            durationMinutes,
            originClientX: event.clientX,
            originClientY: event.clientY,
            moved: false
          }
        : {
            mode: "move",
            pointerId: event.pointerId,
            reservation,
            rowIndex: slot.rowIndex,
            startMinutes,
            durationMinutes,
            grabOffsetMinutes: clamp(slot.minutes - startMinutes, 0, Math.max(0, durationMinutes - dashboard.hours.stepMinutes)),
            originClientX: event.clientX,
            originClientY: event.clientY,
            moved: false
          }
    );
  }

  function moveReservationInteraction(event: React.PointerEvent<HTMLElement>) {
    if (!interaction || interaction.pointerId !== event.pointerId || interaction.mode === "create") return;
    event.preventDefault();
    setInteraction(updateInteractionPosition(interaction, event.clientX, event.clientY));
  }

  async function saveTimelineChange(current: Extract<TimelineInteraction, { mode: "move" | "resize" }>) {
    const row = dashboard.rows[current.rowIndex];
    if (!row) return;
    const unchanged =
      current.startMinutes === toMinutes(current.reservation.startTime) &&
      current.durationMinutes === toMinutes(current.reservation.endTime) - toMinutes(current.reservation.startTime) &&
      row.id === current.reservation.rowId;
    if (unchanged) return;

    setIsSavingSchedule(true);
    try {
      const response = await fetch(tenantApiPath(tenantSlug, `/reservations/${current.reservation.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          startTime: toTime(current.startMinutes),
          durationMinutes: current.durationMinutes,
          staffId: row.id === "unassigned" ? null : row.id,
          isRequest: row.id !== "unassigned"
        })
      });
      if (!response.ok) throw new Error(await responseError(response));
      setScheduleMessage({ type: "success", text: "予約日時を更新しました。" });
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setScheduleMessage({ type: "error", text: error instanceof Error ? error.message : "予約日時を更新できませんでした。" });
    } finally {
      setIsSavingSchedule(false);
    }
  }

  function finishReservationInteraction(event: React.PointerEvent<HTMLElement>) {
    if (!interaction || interaction.pointerId !== event.pointerId || interaction.mode === "create") return;
    event.preventDefault();
    event.stopPropagation();
    const finalInteraction = updateInteractionPosition(interaction, event.clientX, event.clientY);
    if (finalInteraction.mode === "create") return;
    setInteraction(null);
    if (finalInteraction.moved) {
      void saveTimelineChange(finalInteraction);
      return;
    }
    setEditor({
      kind: "edit",
      date,
      startTime: finalInteraction.reservation.startTime,
      durationMinutes: toMinutes(finalInteraction.reservation.endTime) - toMinutes(finalInteraction.reservation.startTime),
      rowId: finalInteraction.reservation.rowId,
      reservation: finalInteraction.reservation
    });
  }

  return (
    <main className="appShell">
      <aside className="adminSidebar">
        <a className="adminBrand" href={tenantPath(tenantSlug)} title="株式会社Beauty Gum">
          <Image src="/brand/beauty-gum-logo.webp" alt="株式会社Beauty Gum" width={400} height={100} />
        </a>
        <nav className="adminNav" aria-label="admin navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <a
                className={item.href === "/" ? "adminNavItem isActive" : "adminNavItem"}
                href={tenantPath(tenantSlug, item.href)}
                key={item.href}
                title={item.label}
              >
                <Icon size={21} />
                <span>{item.label}</span>
              </a>
            );
          })}
        </nav>
        <LogoutButton />
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="storeIdentity">
            <Building2 size={20} />
            <div>
              <p>{dashboard.salon?.name ?? "店舗未設定"}</p>
            </div>
          </div>
          <div className="topbarTools">
            <div className="noticeRail">
              {dashboard.notifications.map((notification) => (
                <button className={`noticePill ${notification.severity}`} key={notification.id} type="button">
                  <Bell size={15} />
                  <span>{notification.title}</span>
                </button>
              ))}
            </div>
            <TenantSwitcher />
          </div>
        </header>

        <div className="contentGrid">
          <section className="mainPane">
            <div className="commandSurface">
              <div className="dateControls">
                <button className="secondaryButton" type="button" onClick={() => changeDate(addDays(date, -1))}>
                  {iconButtonLabel("前日", <ChevronLeft size={18} />)}
                </button>
                <div className="dateBadge">
                  <strong>{formatDisplayDate(date)}</strong>
                  <CalendarDays size={25} />
                </div>
                <button className="secondaryButton" type="button" onClick={() => changeDate(today)}>
                  本日
                </button>
                <button className="secondaryButton" type="button" onClick={() => changeDate(addDays(date, 1))}>
                  {iconButtonLabel("翌日", <ChevronRight size={18} />)}
                </button>
              </div>

              <div className="actionCluster">
                <button className="primaryButton" type="button" onClick={() => setRefreshKey((current) => current + 1)}>
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
                <a className="primaryButton" href={tenantPath(tenantSlug, "/confirmation")}>
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
              <a className="createButton" href={tenantPath(tenantSlug, "/reservations/new")}>
                {iconButtonLabel("新規予約", <Plus size={18} />)}
              </a>
            </div>

            {loadError ? <div className="adminNotice">{loadError}</div> : null}
            {!loadError && !dashboard.salon ? <div className="adminNotice">店舗情報が未登録です。基本設定から店舗を登録してください。</div> : null}
            {viewMode === "timeline" && dashboard.salon ? (
              <div className="timelineHelp">
                <span>空き枠をクリック／ドラッグして予約登録</span>
                <span>予約をドラッグして移動</span>
                <span>右端をドラッグして時間変更</span>
              </div>
            ) : null}
            {scheduleMessage ? (
              <div className={`timelineMessage ${scheduleMessage.type === "error" ? "isError" : "isSuccess"}`} role="status">
                {scheduleMessage.text}
              </div>
            ) : null}

            {viewMode === "timeline" ? (
              <div className={`scheduleShell ${interaction ? "isInteracting" : ""}`}>
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
                    <div
                      className="gridLayer"
                      ref={gridRef}
                      style={{ top: HEADER_HEIGHT, height: boardHeight }}
                      onPointerDown={handleGridPointerDown}
                      onPointerMove={handleGridPointerMove}
                      onPointerUp={finishGridInteraction}
                      onPointerCancel={() => setInteraction(null)}
                    >
                      {dashboard.rows.map((row, rowIndex) => (
                        <div className="gridRow" key={row.id} style={{ top: rowIndex * ROW_HEIGHT, height: ROW_HEIGHT }} />
                      ))}
                      {timeline.hours.map((hour, index) => (
                        <div className="hourLine" key={hour} style={{ left: index * HOUR_WIDTH }} />
                      ))}
                      {timeline.hours.slice(0, -1).map((hour, index) => (
                        <div className="halfHourLine" key={`${hour}-half`} style={{ left: index * HOUR_WIDTH + HOUR_WIDTH / 2 }} />
                      ))}
                      {interaction?.mode === "create" ? (() => {
                        const startMinutes = Math.min(interaction.anchorMinutes, interaction.currentMinutes);
                        const endMinutes = Math.max(interaction.anchorMinutes, interaction.currentMinutes) + dashboard.hours.stepMinutes;
                        return (
                          <div
                            className="slotSelection"
                            style={{
                              left: ((startMinutes - timeline.start) / 60) * HOUR_WIDTH,
                              top: interaction.rowIndex * ROW_HEIGHT + 7,
                              width: ((endMinutes - startMinutes) / 60) * HOUR_WIDTH,
                              height: ROW_HEIGHT - 14
                            }}
                          >
                            <strong>{toTime(startMinutes)}–{toTime(endMinutes)}</strong>
                            <span>予約を登録</span>
                          </div>
                        );
                      })() : null}
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
                        const activeInteraction = interaction?.mode !== "create" && interaction?.reservation.id === reservation.id ? interaction : null;
                        const rowIndex = activeInteraction?.rowIndex ?? dashboard.rows.findIndex((row) => row.id === reservation.rowId);
                        if (rowIndex < 0) return null;
                        const startMinutes = activeInteraction?.startMinutes ?? toMinutes(reservation.startTime);
                        const durationMinutes = activeInteraction?.durationMinutes ?? toMinutes(reservation.endTime) - toMinutes(reservation.startTime);
                        return (
                          <ReservationCard
                            key={reservation.id}
                            reservation={reservation}
                            selected={reservation.id === selectedId}
                            dragging={Boolean(activeInteraction)}
                            style={{
                              left: ((startMinutes - timeline.start) / 60) * HOUR_WIDTH,
                              top: rowIndex * ROW_HEIGHT + 12,
                              width: Math.max(72, (durationMinutes / 60) * HOUR_WIDTH - 8),
                              height: ROW_HEIGHT - 20
                            }}
                            displayStartTime={toTime(startMinutes)}
                            displayEndTime={toTime(startMinutes + durationMinutes)}
                            onPointerDown={(event) => startReservationInteraction(event, reservation)}
                            onPointerMove={moveReservationInteraction}
                            onPointerUp={finishReservationInteraction}
                            onPointerCancel={() => setInteraction(null)}
                            onKeyboardOpen={() => {
                              setSelectedId(reservation.id);
                              setEditor({
                                kind: "edit",
                                date,
                                startTime: reservation.startTime,
                                durationMinutes: toMinutes(reservation.endTime) - toMinutes(reservation.startTime),
                                rowId: reservation.rowId,
                                reservation
                              });
                            }}
                          />
                        );
                      })}
                      {showNowLine ? (
                        <div className="nowLine" style={{ left: (currentMinute / 60) * HOUR_WIDTH }}>
                          <span />
                        </div>
                      ) : null}
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
      {editor ? (
        <TimelineReservationEditor
          key={`${editor.kind}-${editor.reservation?.id ?? "new"}-${editor.startTime}-${editor.rowId}`}
          value={editor}
          menus={menus}
          rows={dashboard.rows}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            setScheduleMessage({ type: "success", text: editor.kind === "create" ? "予約を登録しました。" : "予約を更新しました。" });
            setRefreshKey((value) => value + 1);
          }}
        />
      ) : null}
    </main>
  );
}

function ReservationCard({
  reservation,
  selected,
  dragging,
  style,
  displayStartTime,
  displayEndTime,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onKeyboardOpen
}: {
  reservation: ScheduleReservation;
  selected: boolean;
  dragging: boolean;
  style: React.CSSProperties;
  displayStartTime: string;
  displayEndTime: string;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  onKeyboardOpen: () => void;
}) {
  const StatusIcon = statusMeta[reservation.status].icon;
  return (
    <div
      className={`reservationCard ${statusMeta[reservation.status].className} ${selected ? "isSelected" : ""} ${dragging ? "isDragging" : ""}`}
      style={style}
      role="button"
      tabIndex={0}
      data-reservation-card
      aria-label={`${reservation.customerName} ${displayStartTime}から${displayEndTime}。クリックで編集、ドラッグで移動`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onKeyboardOpen(); } }}
    >
      <span className="cardTime">{displayStartTime}-{displayEndTime}</span>
      <strong>{reservation.customerName}</strong>
      <small>{reservation.serviceName}</small>
      <em>
        {reservation.isRequest ? "指" : "フ"}
        <StatusIcon size={12} />
      </em>
      <span className="reservationResizeHandle" data-resize-handle title="ドラッグして所要時間を変更" aria-hidden="true" />
    </div>
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
