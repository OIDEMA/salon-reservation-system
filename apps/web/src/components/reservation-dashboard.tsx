"use client";

import {
  AlertCircle,
  Bell,
  Building2,
  CalendarRange,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Columns3,
  Filter,
  Plus,
  Printer,
  RefreshCw,
  Search,
  UserRound,
  XCircle
} from "lucide-react";
import { format, isValid, parseISO } from "date-fns";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { DismissibleMessage } from "@/components/dismissible-message";
import { AdminSidebar } from "@/components/admin-shell";
import { fetchDashboard } from "@/lib/api";
import { useTenantSlug, usePermissions } from "@/components/tenant-provider";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { HistoricalScheduleAgenda, HistoricalScheduleCard } from "@/components/historical-schedule";
import { buildScheduleLayout, scheduleCardKey, scheduleRowAcceptsNewReservation, SCHEDULE_HOUR_WIDTH, SCHEDULE_LANE_HEIGHT } from "@/lib/schedule-layout";
import { TimelineReservationEditor, type TimelineEditorValue } from "@/components/timeline-reservation-editor";
import { historyScheduleDate, historyScheduleDuration, moveHistorySchedule, scheduleDragDelta, scheduleDragStarted, scheduleDropSlot, scheduleMoveStart, ScheduleUpdateError, type HistoryScheduleChange } from "@/lib/schedule-drag";
import type { AdminMenu } from "@/lib/admin-types";
import { tenantApiPath, tenantPath } from "@/lib/tenant-routing";
import { createEmptyDashboard, type DashboardData, type ReservationStatus, type ScheduleReservation, type HistoricalScheduleReservation } from "@/lib/types";

const HOUR_WIDTH = SCHEDULE_HOUR_WIDTH;
const ROW_HEIGHT = SCHEDULE_LANE_HEIGHT;
const HEADER_HEIGHT = 42;

type TimelineInteraction = (
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
    }
  | {
      mode: "history-move";
      pointerId: number;
      reservation: HistoricalScheduleReservation;
      rowIndex: number;
      startMinutes: number;
      durationMinutes: number;
      originClientX: number;
      originClientY: number;
      moved: boolean;
    }) & { context: string; validDrop: boolean };

type HistoryMoveUndo = { tenantSlug: string; id: string; change: HistoryScheduleChange };

const statusMeta: Record<ReservationStatus, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  PENDING: { label: "未確認", className: "statusPending", icon: AlertCircle },
  CONFIRMED: { label: "確定", className: "statusConfirmed", icon: CheckCircle2 },
  ARRIVED: { label: "来店", className: "statusArrived", icon: UserRound },
  COMPLETED: { label: "完了", className: "statusCompleted", icon: CheckCircle2 },
  CANCELLED: { label: "取消", className: "statusCancelled", icon: XCircle },
  NO_SHOW: { label: "無断", className: "statusCancelled", icon: XCircle },
  WAITLIST: { label: "待ち", className: "statusWaitlist", icon: Clock3 }
};

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
  const { can } = usePermissions();
  const canRead = can("reservation.read");
  const canWrite = can("reservation.write");
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const today = format(new Date(), "yyyy-MM-dd");
  const date = validDateParam(searchParams.get("date")) ?? today;
  const [dashboard, setDashboard] = useState<DashboardData>(() => createEmptyDashboard(date));
  const [selectedId, setSelectedId] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | ReservationStatus>("ALL");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [viewMode, setViewMode] = useState<"timeline" | "agenda">("timeline");
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [menus, setMenus] = useState<AdminMenu[]>([]);
  const [editor, setEditor] = useState<TimelineEditorValue | null>(null);
  const [interaction, setInteraction] = useState<TimelineInteraction | null>(null);
  const [pendingMove, setPendingMove] = useState<Extract<TimelineInteraction, { mode: "history-move" }> | null>(null);
  const [scheduleMessage, setScheduleMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isSavingSchedule, setIsSavingSchedule] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<TimelineInteraction | null>(null);
  const suppressHistoryClick = useRef(false);
  const savingScheduleRef = useRef(false);
  const [historyUndo, setHistoryUndo] = useState<HistoryMoveUndo | null>(null);
  const context = `${tenantSlug}:${date}:${viewMode}:${appliedQuery}:${statusFilter}`;
  const contextRef = useRef(context);
  contextRef.current = context;

  function updateInteraction(next: TimelineInteraction | null) {
    interactionRef.current = next;
    setInteraction(next);
  }

  function cancelInteraction() {
    if (interactionRef.current?.mode === "history-move" && interactionRef.current.moved) suppressHistoryClick.current = true;
    updateInteraction(null);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) { if (event.key === "Escape") cancelInteraction(); }
    function onViewportChange() { cancelInteraction(); }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("blur", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("blur", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, []);

  useEffect(() => { cancelInteraction(); setHistoryUndo(null); }, [context, canWrite]);
  useEffect(() => { setHistoryUndo(null); }, [tenantSlug]);

  function changeDate(nextDate: string) {
    const nextSearchParams = new URLSearchParams(searchParams.toString());
    nextSearchParams.set("date", nextDate);
    router.push(`${pathname}?${nextSearchParams.toString()}`, { scroll: false });
  }

  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();
    if (!canRead) {
      setDashboard(createEmptyDashboard(date));
      return;
    }
    setIsLoading(true);
    setLoadError("");
    updateInteraction(null);
    setEditor(null);
    fetchDashboard(date, tenantSlug, { q: appliedQuery, status: statusFilter }, controller.signal)
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
      controller.abort();
    };
  }, [date, refreshKey, tenantSlug, appliedQuery, statusFilter, canRead]);

  useEffect(() => {
    if (!canRead || !canWrite) {
      setMenus([]);
      setEditor(null);
      updateInteraction(null);
      return;
    }
    let ignore = false;
    fetch(tenantApiPath(tenantSlug, "/services"), { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response));
        return response.json() as Promise<AdminMenu[]>;
      })
      .then((data) => { if (!ignore) setMenus(data); })
      .catch(() => { if (!ignore) setMenus([]); });
    return () => { ignore = true; };
  }, [canRead, canWrite, tenantSlug]);

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

  // Date and search/status filters are resolved by the API. Only the selected
  // day's bounded source cards are loaded, separately from live reservations.
  const filteredReservations = dashboard.reservations;
  const historicalReservations = dashboard.historicalReservations ?? [];
  const baselineLayout = useMemo(() => buildScheduleLayout(dashboard.rows, dashboard.reservations, historicalReservations,
    timeline.start, timeline.end), [dashboard, historicalReservations, timeline.start, timeline.end]);
  const displayInteraction = interaction?.context === context ? interaction : pendingMove?.context === context ? pendingMove : null;
  const scheduleLayout = useMemo(() => {
    const active = displayInteraction?.mode !== "create" && displayInteraction?.moved && displayInteraction.validDrop ? displayInteraction : null;
    const rowId = active ? dashboard.rows[active.rowIndex]?.id : null;
    const live = active && active.mode !== "history-move" && rowId ? dashboard.reservations.map((item) => item.id === active.reservation.id
      ? { ...item, rowId, startTime: toTime(active.startMinutes), endTime: toTime(active.startMinutes + active.durationMinutes) } : item) : dashboard.reservations;
    const history = active?.mode === "history-move" && rowId ? historicalReservations.map((item) => item.id === active.reservation.id
      ? { ...item, rowId, startTime: toTime(active.startMinutes), endTime: item.endTime === null ? null : toTime(active.startMinutes + active.durationMinutes) } : item) : historicalReservations;
    return buildScheduleLayout(dashboard.rows, live, history, timeline.start, timeline.end,
      active ? new Map(baselineLayout.rows.map((row) => [row.row.id, row.height])) : undefined);
  }, [dashboard, displayInteraction, historicalReservations, baselineLayout, timeline.start, timeline.end]);

  const now = new Date();
  const currentMinute = now.getHours() * 60 + now.getMinutes() - timeline.start;
  const showNowLine = date === today && currentMinute >= 0 && currentMinute <= timeline.end - timeline.start;
  const boardHeight = scheduleLayout.height;

  function pointerSlot(clientX: number, clientY: number, allowInactiveSelection = false) {
    const element = gridRef.current;
    if (!element || dashboard.rows.length === 0) return null;
    return scheduleDropSlot(clientX, clientY, element.getBoundingClientRect(), scheduleLayout.rows,
      timeline.start, timeline.end, HOUR_WIDTH, dashboard.hours.stepMinutes, allowInactiveSelection);
  }

  function updateInteractionPosition(current: TimelineInteraction, clientX: number, clientY: number): TimelineInteraction {
    const slot = pointerSlot(clientX, clientY, current.mode === "history-move");
    if (current.mode === "create") return slot ? { ...current, currentMinutes: slot.minutes, rowIndex: slot.rowIndex, validDrop: true } : { ...current, validDrop: false };
    const moved = current.moved || scheduleDragStarted(current.originClientX, current.originClientY, clientX, clientY);
    if (!slot) return { ...current, moved, validDrop: false };
    const delta = scheduleDragDelta(current.originClientX, clientX, HOUR_WIDTH, dashboard.hours.stepMinutes);
    if (current.mode === "move" || current.mode === "history-move") {
      const originalStart = toMinutes(current.reservation.startTime);
      const startMinutes = scheduleMoveStart(originalStart, delta, timeline.start,
        Math.min(1439, timeline.end - current.durationMinutes), dashboard.hours.stepMinutes);
      if (startMinutes === null) return { ...current, moved, validDrop: false };
      return { ...current, rowIndex: slot.rowIndex, startMinutes, moved, validDrop: true };
    }
    const originalDuration = toMinutes(current.reservation.endTime) - toMinutes(current.reservation.startTime);
    return { ...current, durationMinutes: clamp(originalDuration + delta, dashboard.hours.stepMinutes, timeline.end - current.startMinutes), moved, validDrop: true };
  }

  function handleGridPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!canWrite || isLoading || dashboard.date !== date || event.button !== 0 || isSavingSchedule || (event.target as HTMLElement).closest("[data-reservation-card]")) return;
    const slot = pointerSlot(event.clientX, event.clientY);
    if (!slot) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setScheduleMessage(null);
    updateInteraction({
      mode: "create",
      context, validDrop: true,
      pointerId: event.pointerId,
      rowIndex: slot.rowIndex,
      anchorMinutes: slot.minutes,
      currentMinutes: slot.minutes
    });
  }

  function handleGridPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const current = interactionRef.current;
    if (!canWrite || !current || current.context !== contextRef.current || current.pointerId !== event.pointerId || current.mode !== "create") return;
    updateInteraction(updateInteractionPosition(current, event.clientX, event.clientY));
  }

  function finishGridInteraction(event: React.PointerEvent<HTMLDivElement>) {
    const current = interactionRef.current;
    if (!canWrite || !current || current.context !== contextRef.current || current.pointerId !== event.pointerId || current.mode !== "create") return;
    const finalInteraction = updateInteractionPosition(current, event.clientX, event.clientY);
    updateInteraction(null);
    if (finalInteraction.mode !== "create" || !finalInteraction.validDrop) return;
    const startMinutes = Math.min(finalInteraction.anchorMinutes, finalInteraction.currentMinutes);
    const endMinutes = Math.max(finalInteraction.anchorMinutes, finalInteraction.currentMinutes) + dashboard.hours.stepMinutes;
    const row = dashboard.rows[finalInteraction.rowIndex];
    if (!scheduleRowAcceptsNewReservation(row)) return;
    setEditor({
      kind: "create",
      date,
      startTime: toTime(startMinutes),
      durationMinutes: endMinutes - startMinutes,
      rowId: row.id
    });
  }

  function startReservationInteraction(event: React.PointerEvent<HTMLElement>, reservation: ScheduleReservation) {
    if (event.button !== 0 || isSavingSchedule || isLoading || dashboard.date !== date) return;
    setSelectedId(reservation.id);
    if (!canWrite) return;
    const slot = pointerSlot(event.clientX, event.clientY, true);
    if (!slot) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setScheduleMessage(null);
    const startMinutes = toMinutes(reservation.startTime);
    const durationMinutes = toMinutes(reservation.endTime) - startMinutes;
    const resizing = Boolean((event.target as HTMLElement).closest("[data-resize-handle]"));
    updateInteraction(
      resizing
        ? {
            mode: "resize",
            context, validDrop: true,
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
            context, validDrop: true,
            pointerId: event.pointerId,
            reservation,
            rowIndex: slot.rowIndex,
            startMinutes,
            durationMinutes,
            originClientX: event.clientX,
            originClientY: event.clientY,
            moved: false
          }
    );
  }

  function moveReservationInteraction(event: React.PointerEvent<HTMLElement>) {
    const current = interactionRef.current;
    if (!canWrite || !current || current.context !== contextRef.current || current.pointerId !== event.pointerId || current.mode === "create") return;
    event.preventDefault();
    const next = updateInteractionPosition(current, event.clientX, event.clientY);
    if (next.mode === "history-move" && next.moved) suppressHistoryClick.current = true;
    updateInteraction(next);
  }

  function startHistoryInteraction(event: React.PointerEvent<HTMLAnchorElement>, reservation: HistoricalScheduleReservation) {
    suppressHistoryClick.current = false;
    if (!canWrite || event.button !== 0 || savingScheduleRef.current || isLoading || dashboard.date !== date) return;
    const slot = pointerSlot(event.clientX, event.clientY, true);
    if (!slot) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setScheduleMessage(null);
    updateInteraction({ mode: "history-move", context, validDrop: true, pointerId: event.pointerId, reservation,
      rowIndex: slot.rowIndex, startMinutes: toMinutes(reservation.startTime), durationMinutes: historyScheduleDuration(reservation) ?? 30,
      originClientX: event.clientX, originClientY: event.clientY, moved: false });
  }

  async function saveHistoryMove(current: Extract<TimelineInteraction, { mode: "history-move" }>) {
    if (!canWrite || !current.validDrop || current.context !== contextRef.current || savingScheduleRef.current) return;
    const row = dashboard.rows[current.rowIndex];
    if (!row || (row.type !== "staff" && row.type !== "resource" && row.id !== "unassigned")) return;
    if (current.startMinutes === toMinutes(current.reservation.startTime) && row.id === current.reservation.rowId) return;
    const previous: HistoryScheduleChange = { date: historyScheduleDate(current.reservation.startsAt), startTime: current.reservation.startTime,
      staffId: current.reservation.rowId === "unassigned" ? null : current.reservation.rowId, expectedVersion: 0 };
    savingScheduleRef.current = true;
    setIsSavingSchedule(true);
    setPendingMove(current);
    try {
      const result = await moveHistorySchedule(tenantSlug, current.reservation.id, {
        date, startTime: toTime(current.startMinutes), staffId: row.id === "unassigned" ? null : row.id,
        expectedVersion: current.reservation.scheduleVersion ?? 0
      });
      if (current.context === contextRef.current) {
        setDashboard((previousDashboard) => ({ ...previousDashboard, historicalReservations: previousDashboard.historicalReservations.map((item) => item.id === result.id
          ? { ...item, ...result, startTime: toTime(current.startMinutes), endTime: item.endTime === null ? null : toTime(current.startMinutes + current.durationMinutes) } : item) }));
        setHistoryUndo({ tenantSlug, id: current.reservation.id, change: { ...previous, expectedVersion: result.scheduleVersion } });
        setScheduleMessage({ type: "success", text: "予約枠を移動しました。" });
        setRefreshKey((value) => value + 1);
      }
    } catch (error) {
      if (current.context === contextRef.current) {
        setScheduleMessage({ type: "error", text: error instanceof Error ? error.message : "予約枠を移動できませんでした。" });
        if (error instanceof ScheduleUpdateError && error.status === 409) { setHistoryUndo(null); setRefreshKey((value) => value + 1); }
      }
    } finally { savingScheduleRef.current = false; setPendingMove(null); setIsSavingSchedule(false); }
  }

  async function undoHistoryMove() {
    const undo = historyUndo;
    if (!canWrite || !undo || undo.tenantSlug !== tenantSlug || savingScheduleRef.current) return;
    const startedContext = context;
    savingScheduleRef.current = true;
    setIsSavingSchedule(true);
    try {
      await moveHistorySchedule(tenantSlug, undo.id, undo.change);
      if (startedContext === contextRef.current) {
        setHistoryUndo(null); setScheduleMessage({ type: "success", text: "予約枠を移動前に戻しました。" }); setRefreshKey((value) => value + 1);
      }
    } catch (error) {
      if (startedContext === contextRef.current) {
        setScheduleMessage({ type: "error", text: error instanceof Error ? error.message : "元に戻せませんでした。" });
        if (error instanceof ScheduleUpdateError && error.status === 409) { setHistoryUndo(null); setRefreshKey((value) => value + 1); }
      }
    } finally { savingScheduleRef.current = false; setIsSavingSchedule(false); }
  }

  async function saveTimelineChange(current: Extract<TimelineInteraction, { mode: "move" | "resize" }>) {
    if (!canWrite || !current.validDrop || current.context !== contextRef.current || savingScheduleRef.current) return;
    const row = dashboard.rows[current.rowIndex];
    if (!scheduleRowAcceptsNewReservation(row)) return;
    const unchanged =
      current.startMinutes === toMinutes(current.reservation.startTime) &&
      current.durationMinutes === toMinutes(current.reservation.endTime) - toMinutes(current.reservation.startTime) &&
      row.id === current.reservation.rowId;
    if (unchanged) return;

    savingScheduleRef.current = true;
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
      if (current.context === contextRef.current) {
        setHistoryUndo(null);
        setScheduleMessage({ type: "success", text: "予約日時を更新しました。" });
        setRefreshKey((value) => value + 1);
      }
    } catch (error) {
      if (current.context === contextRef.current) setScheduleMessage({ type: "error", text: error instanceof Error ? error.message : "予約日時を更新できませんでした。" });
    } finally {
      savingScheduleRef.current = false;
      setIsSavingSchedule(false);
    }
  }

  function finishReservationInteraction(event: React.PointerEvent<HTMLElement>) {
    const current = interactionRef.current;
    if (!canWrite || !current || current.context !== contextRef.current || current.pointerId !== event.pointerId || current.mode === "create") return;
    event.preventDefault();
    event.stopPropagation();
    const finalInteraction = updateInteractionPosition(current, event.clientX, event.clientY);
    updateInteraction(null);
    if (finalInteraction.mode === "create") return;
    if (finalInteraction.mode === "history-move") {
      if (finalInteraction.moved) { suppressHistoryClick.current = true; if (finalInteraction.validDrop) void saveHistoryMove(finalInteraction); }
      return;
    }
    if (finalInteraction.moved) { if (finalInteraction.validDrop) void saveTimelineChange(finalInteraction); return; }
    setEditor({ kind: "edit", date, startTime: finalInteraction.reservation.startTime,
      durationMinutes: toMinutes(finalInteraction.reservation.endTime) - toMinutes(finalInteraction.reservation.startTime),
      rowId: finalInteraction.reservation.rowId, reservation: finalInteraction.reservation });
  }

  if (!canRead) return <p className="formMessage error" role="alert">予約表を閲覧する権限がありません。</p>;

  return (
    <main className="appShell">
      <AdminSidebar active="/" />

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
                <input className="dashboardDateInput" aria-label="予約表の日付" type="date" value={date} onChange={(event) => { const selectedDate = validDateParam(event.target.value); if (selectedDate) changeDate(selectedDate); }} />
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
              <form className="dashboardSearch" onSubmit={(event) => { event.preventDefault(); setAppliedQuery(query.trim()); }}>
                <label className="searchBox">
                  <Search size={18} />
                  <input aria-label="予約表を検索" value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} placeholder="顧客・担当・メニュー・予約番号を検索" />
                </label>
                <button className="secondaryButton" type="submit" disabled={isLoading}>検索</button>
              </form>
              <div className="filterButtons">
                {(["ALL", "PENDING", "CONFIRMED", "WAITLIST"] as const).map((status) => (
                  <button key={status} className={statusFilter === status ? "filterButton isSelected" : "filterButton"} type="button" onClick={() => setStatusFilter(status)}>
                    <Filter size={15} />
                    <span>{status === "ALL" ? "すべて" : statusMeta[status].label}</span>
                  </button>
                ))}
              </div>
              {canWrite ? <a className="createButton" href={tenantPath(tenantSlug, "/reservations/new")}>
                {iconButtonLabel("新規予約", <Plus size={18} />)}
              </a> : null}
            </div>

            {loadError ? <div className="adminNotice">{loadError}</div> : null}
            {!loadError && !dashboard.salon ? <div className="adminNotice">店舗情報が未登録です。基本設定から店舗を登録してください。</div> : null}
            {dashboard.historicalHasMore ? <div className="adminNotice">この日の移行履歴は表示上限を超えています。<a href={tenantPath(tenantSlug, "/reservations/history")}>予約履歴一覧</a>で検索してください。</div> : null}
            {canWrite && viewMode === "timeline" && dashboard.salon ? (
              <div className="timelineHelp">
                <span>空き枠をクリック／ドラッグして予約登録</span>
                <span>予約をドラッグして移動</span>
                <span>右端をドラッグして時間変更</span>
              </div>
            ) : null}
            {scheduleMessage ? (
              <DismissibleMessage
                className={`timelineMessage ${scheduleMessage.type === "error" ? "isError" : "isSuccess"}`}
                message={scheduleMessage.text}
                onDismiss={() => setScheduleMessage(null)}
                role={scheduleMessage.type === "error" ? "alert" : "status"}
              />
            ) : null}

            {canWrite && historyUndo?.tenantSlug === tenantSlug ? <div className="historyMoveUndo">
              <button className="secondaryButton" type="button" disabled={isSavingSchedule || isLoading} onClick={() => void undoHistoryMove()}>直前の予約枠の移動を元に戻す</button>
            </div> : null}
            {isSavingSchedule ? <p className="timelineSaving" role="status">予約枠を保存しています…</p> : null}
            {viewMode === "timeline" ? (
              <div className={`scheduleShell ${interaction ? "isInteracting" : ""}`}>
                <div className="resourceColumn">
                  <div className="resourceHeader">予約枠</div>
                  {scheduleLayout.rows.map(({ row, height }) => (
                    <div className={`resourceCell ${row.active === false ? "isInactive" : ""}`} style={{ height }} key={row.id}>
                      <span className="resourceDot" style={{ backgroundColor: row.color }} />
                      <div>
                        <strong>{row.label}</strong>
                        <small>{row.active === false ? "予約受付停止" : row.subtitle}</small>
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
                      style={{ top: HEADER_HEIGHT, height: boardHeight, cursor: canWrite ? undefined : "default", touchAction: canWrite ? undefined : "auto" }}
                      onPointerDown={canWrite ? handleGridPointerDown : undefined}
                      onPointerMove={canWrite ? handleGridPointerMove : undefined}
                      onPointerUp={canWrite ? finishGridInteraction : undefined}
                      onPointerCancel={cancelInteraction}
                      onLostPointerCapture={cancelInteraction}
                    >
                      {scheduleLayout.rows.map(({ row, top, height }) => (
                        <div className={`gridRow ${row.active === false ? "isInactive" : ""}`} key={row.id} style={{ top, height }} />
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
                              top: (scheduleLayout.rows[interaction.rowIndex]?.top ?? 0) + 7,
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
                              top: scheduleLayout.rows[rowIndex].top + 8,
                              width: ((toMinutes(block.endTime) - toMinutes(block.startTime)) / 60) * HOUR_WIDTH,
                              height: scheduleLayout.rows[rowIndex].height - 14
                            }}
                          >
                            <span>{block.startTime}-{block.endTime}</span>
                            <strong>{block.label}</strong>
                          </div>
                        );
                      })}
                      {filteredReservations.map((reservation) => {
                        const activeInteraction = interaction && (interaction.mode === "move" || interaction.mode === "resize") && interaction.moved && interaction.reservation.id === reservation.id ? interaction : null;
                        const rowIndex = activeInteraction?.rowIndex ?? dashboard.rows.findIndex((row) => row.id === reservation.rowId);
                        if (rowIndex < 0) return null;
                        const cardLayout = scheduleLayout.cards.get(scheduleCardKey("reservation", reservation.id));
                        const startMinutes = activeInteraction?.startMinutes ?? toMinutes(reservation.startTime);
                        const durationMinutes = activeInteraction?.durationMinutes ?? toMinutes(reservation.endTime) - toMinutes(reservation.startTime);
                        return (
                          <ReservationCard
                            key={reservation.id}
                            reservation={reservation}
                            editable={canWrite}
                            selected={reservation.id === selectedId}
                            dragging={Boolean(activeInteraction)}
                            style={{
                              left: activeInteraction ? ((startMinutes - timeline.start) / 60) * HOUR_WIDTH : cardLayout?.left,
                              top: scheduleLayout.rows[rowIndex].top + (cardLayout?.lane ?? 0) * ROW_HEIGHT + 12,
                              width: activeInteraction ? Math.max(72, (durationMinutes / 60) * HOUR_WIDTH - 8) : cardLayout?.width,
                              height: ROW_HEIGHT - 20
                            }}
                            displayStartTime={toTime(startMinutes)}
                            displayEndTime={toTime(startMinutes + durationMinutes)}
                            onPointerDown={(event) => startReservationInteraction(event, reservation)}
                            onPointerMove={moveReservationInteraction}
                            onPointerUp={finishReservationInteraction}
                            onPointerCancel={cancelInteraction}
                            onKeyboardOpen={() => {
                              setSelectedId(reservation.id);
                              if (!canWrite || isLoading || dashboard.date !== date) return;
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
                      {historicalReservations.map((reservation) => {
                        const active = displayInteraction?.mode === "history-move" && displayInteraction.moved && displayInteraction.reservation.id === reservation.id ? displayInteraction : null;
                        const rowId = active?.validDrop ? dashboard.rows[active.rowIndex]?.id : reservation.rowId;
                        const row = scheduleLayout.rows.find((layout) => layout.row.id === rowId);
                        const placement = scheduleLayout.cards.get(scheduleCardKey("history", reservation.id));
                        if (!row || !placement) return null;
                        const preview = active?.validDrop ? { ...reservation, startTime: toTime(active.startMinutes),
                          endTime: reservation.endTime === null ? null : toTime(active.startMinutes + active.durationMinutes) } : reservation;
                        return <HistoricalScheduleCard key={`history:${reservation.id}`} reservation={preview} editable={canWrite}
                          dragging={Boolean(active)} invalidDrop={Boolean(active && !active.validDrop)}
                          onPointerDown={(event) => startHistoryInteraction(event, reservation)} onPointerMove={moveReservationInteraction}
                          onPointerUp={finishReservationInteraction} onPointerCancel={cancelInteraction}
                          onClick={(event) => { if (event.detail !== 0 && suppressHistoryClick.current) { event.preventDefault(); suppressHistoryClick.current = false; } }}
                          style={{ left: placement.left, width: placement.width, top: row.top + placement.lane * ROW_HEIGHT + 7, height: ROW_HEIGHT - 14 }} />;
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
              <>
                <Agenda reservations={filteredReservations} selectedId={selectedId} onSelect={setSelectedId} />
                <HistoricalScheduleAgenda reservations={historicalReservations} />
              </>
            )}
          </section>
        </div>
      </section>
      {canWrite && editor ? (
        <TimelineReservationEditor
          key={`${editor.kind}-${editor.reservation?.id ?? "new"}-${editor.startTime}-${editor.rowId}`}
          value={editor}
          menus={menus}
          rows={dashboard.rows}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            setHistoryUndo(null);
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
  editable,
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
  editable: boolean;
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
      style={{ ...style, cursor: editable ? undefined : "default", touchAction: editable ? undefined : "auto" }}
      role="button"
      tabIndex={0}
      data-reservation-card
      aria-label={`${reservation.customerName} ${displayStartTime}から${displayEndTime}${editable ? "。クリックで編集、ドラッグで移動" : "。予約を選択"}`}
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
      {editable ? <span className="reservationResizeHandle" data-resize-handle title="ドラッグして所要時間を変更" aria-hidden="true" /> : null}
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
