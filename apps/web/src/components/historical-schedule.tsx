"use client";

import type { CSSProperties } from "react";
import type { HistoricalScheduleReservation } from "@/lib/types";
import { tenantPath } from "@/lib/tenant-routing";
import { usePermissions, useTenantSlug } from "./tenant-provider";

export function historicalScheduleLabel(reservation: HistoricalScheduleReservation) {
  return `${reservation.customerName} ${reservation.startTime}${reservation.endTime ? `から${reservation.endTime}` : "。終了時刻未登録"}。${reservation.staffName || "担当未登録"}。${reservation.sourceStatus}。移行した予約履歴を開く`;
}

export function HistoricalScheduleCard({ reservation, style }: { reservation: HistoricalScheduleReservation; style: CSSProperties }) {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  if (!can("reservation.read")) return null;
  return <a
    className="reservationCard historicalReservationCard"
    style={style}
    href={tenantPath(tenantSlug, `/reservations/history/${encodeURIComponent(reservation.id)}`)}
    data-reservation-card
    data-history-card
    aria-label={historicalScheduleLabel(reservation)}
    title={historicalScheduleLabel(reservation)}
    onPointerDown={(event) => event.stopPropagation()}
  >
    <span className="cardTime">{reservation.startTime}{reservation.endTime ? `–${reservation.endTime}` : " 終了時刻未登録"}</span>
    <strong>{reservation.customerName}</strong>
    <small>{reservation.serviceName}</small>
    <em>{reservation.sourceStatus}</em>
  </a>;
}

export function HistoricalScheduleAgenda({ reservations }: { reservations: HistoricalScheduleReservation[] }) {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  if (!can("reservation.read") || !reservations.length) return null;
  return <section className="agendaView historicalAgenda" aria-label="移行した予約履歴">
    <h2>移行した予約履歴</h2>
    {reservations.map((reservation) => <a key={reservation.id} className="agendaItem historicalAgendaItem"
      href={tenantPath(tenantSlug, `/reservations/history/${encodeURIComponent(reservation.id)}`)} aria-label={historicalScheduleLabel(reservation)}>
      <span>{reservation.startTime}{reservation.endTime ? `–${reservation.endTime}` : <small>終了時刻未登録</small>}</span>
      <strong>{reservation.customerName}<small>{reservation.staffName || "担当未登録"}</small></strong>
      <em>{reservation.serviceName}</em>
      <span className="historySourceStatus">{reservation.sourceStatus}</span>
    </a>)}
  </section>;
}
