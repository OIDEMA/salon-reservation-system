import { AlertCircle, CalendarCheck, CheckCircle2, CircleDollarSign, Clock3, Command, CreditCard, MessageCircle, Plus, Send, Sparkles, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { AdminShell } from "@/components/admin-shell";
import { TenantLink } from "@/components/tenant-link";
import { fetchDashboardServer } from "@/lib/server-dashboard";
import type { ReservationStatus, ScheduleReservation } from "@/lib/types";

const statusMeta: Record<ReservationStatus, { label: string; className: string }> = {
  PENDING: { label: "未確認", className: "statusPending" },
  CONFIRMED: { label: "確定", className: "statusConfirmed" },
  ARRIVED: { label: "来店", className: "statusArrived" },
  COMPLETED: { label: "完了", className: "statusCompleted" },
  CANCELLED: { label: "取消", className: "statusCancelled" },
  NO_SHOW: { label: "無断", className: "statusCancelled" },
  WAITLIST: { label: "待ち", className: "statusWaitlist" }
};

const currency = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0
});

type ConfirmationPageProps = {
  searchParams?: Promise<{
    reservation?: string;
  }>;
};

export default async function TenantConfirmationPage({ searchParams }: ConfirmationPageProps) {
  const params = await searchParams;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  const dashboard = await fetchDashboardServer(today);
  const selectedReservation =
    dashboard.reservations.find((reservation) => reservation.id === params?.reservation) ??
    dashboard.queue[0] ??
    dashboard.reservations.find((reservation) => reservation.status === "PENDING") ??
    dashboard.reservations[0];

  return (
    <AdminShell
      active="/confirmation"
      title="予約確認センター"
      subtitle="未確認予約、LINE送信、決済確認、当日リスクをこの画面でまとめて処理します。"
      badge={`${dashboard.summary.pendingCount}件未確認`}
      actions={
        <>
          <TenantLink className="secondaryButton" href="/">
            <CalendarCheck size={17} />
            予約表へ
          </TenantLink>
          <button className="primaryButton" type="button">
            <MessageCircle size={17} />
            一括LINE再送
          </button>
        </>
      }
    >
      <div className="confirmationContent">
        <section className="confirmationHero">
          <ReservationDetail reservation={selectedReservation} />
          <QueueSection reservations={dashboard.queue} selectedId={selectedReservation?.id} />
        </section>

        <section className="confirmationGrid">
          <article className="panelSection">
            <div className="panelTitle">
              <Sparkles size={18} />
              <h3>自動提案</h3>
            </div>
            <div className="suggestionList">
              {dashboard.suggestions.map((suggestion) => (
                <article key={suggestion.id} className={`suggestionItem ${suggestion.priority}`}>
                  <strong>{suggestion.title}</strong>
                  <span>{suggestion.impact}</span>
                </article>
              ))}
            </div>
          </article>

          <article className="panelSection compactCreate">
            <div className="panelTitle">
              <Command size={18} />
              <h3>即時登録</h3>
            </div>
            <div className="quickForm">
              <input placeholder="顧客名" />
              <input placeholder="メニュー" />
              <div className="formPair">
                <input placeholder="開始 13:00" />
                <input placeholder="分数 60" />
              </div>
              <TenantLink href="/reservations/new">
                <Plus size={17} />
                <span>予約を作成</span>
              </TenantLink>
            </div>
          </article>
        </section>
      </div>
    </AdminShell>
  );
}

function ReservationDetail({ reservation }: { reservation?: ScheduleReservation }) {
  if (!reservation) {
    return (
      <section className="panelSection confirmationDetail">
        <h2>確認対象がありません</h2>
      </section>
    );
  }

  return (
    <section className="panelSection confirmationDetail">
      <div className="panelHeader">
        <div>
          <span className="eyebrow">Reservation</span>
          <h2>{reservation.customerName}</h2>
        </div>
        <StatusBadge status={reservation.status} />
      </div>

      <div className="detailGrid">
        <DetailItem label="時間" value={`${reservation.startTime}-${reservation.endTime}`} icon={<Clock3 size={16} />} />
        <DetailItem label="単価" value={currency.format(reservation.price)} icon={<CircleDollarSign size={16} />} />
        <DetailItem label="経路" value={reservation.source} icon={<Send size={16} />} />
        <DetailItem label="来店" value={`${reservation.visitCount}回`} icon={<UserRound size={16} />} />
      </div>
      <p className="memoBox">{reservation.memo}</p>
      <div className="tagList">
        {reservation.tags.map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
      </div>
      <div className="quickActions">
        <button type="button">
          <MessageCircle size={17} />
          <span>LINE送信</span>
        </button>
        <button type="button">
          <CheckCircle2 size={17} />
          <span>確認済み</span>
        </button>
        <button type="button">
          <CreditCard size={17} />
          <span>決済</span>
        </button>
      </div>
    </section>
  );
}

function QueueSection({ reservations, selectedId }: { reservations: ScheduleReservation[]; selectedId?: string }) {
  return (
    <section className="panelSection confirmationQueue">
      <div className="panelTitle">
        <AlertCircle size={18} />
        <h3>未確認キュー</h3>
      </div>
      <div className="queueList">
        {reservations.map((reservation) => (
          <TenantLink
            key={reservation.id}
            className={reservation.id === selectedId ? "queueItem isSelected" : "queueItem"}
            href={`/confirmation?reservation=${reservation.id}`}
          >
            <span>{reservation.startTime}</span>
            <strong>{reservation.customerName}</strong>
            <em>{reservation.riskScore}</em>
          </TenantLink>
        ))}
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: ReservationStatus }) {
  return <span className={`statusBadge ${statusMeta[status].className}`}>{statusMeta[status].label}</span>;
}

function DetailItem({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <div className="detailItem">
      <span>{icon}{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
