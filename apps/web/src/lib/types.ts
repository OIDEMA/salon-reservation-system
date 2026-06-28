export type ReservationStatus = "PENDING" | "CONFIRMED" | "ARRIVED" | "COMPLETED" | "CANCELLED" | "NO_SHOW" | "WAITLIST";

export type ScheduleRow = {
  id: string;
  type: "unassigned" | "staff" | "resource" | string;
  label: string;
  subtitle: string;
  color: string;
  count: number;
};

export type ScheduleReservation = {
  id: string;
  rowId: string;
  startTime: string;
  endTime: string;
  customerName: string;
  customerKana: string;
  serviceName: string;
  category: string;
  price: number;
  status: ReservationStatus;
  source: string;
  isRequest: boolean;
  riskScore: number;
  lineStatus: string;
  paymentStatus: string;
  memo: string;
  visitCount: number;
  tags: string[];
};

export type ScheduleBlock = {
  id: string;
  rowId: string;
  startTime: string;
  endTime: string;
  label: string;
  kind: string;
};

export type DashboardData = {
  date: string;
  salon: {
    id: string;
    name: string;
    timezone: string;
    plan: string;
  };
  hours: {
    start: string;
    end: string;
    stepMinutes: number;
  };
  rows: ScheduleRow[];
  reservations: ScheduleReservation[];
  blocks: ScheduleBlock[];
  notifications: Array<{
    id: string;
    severity: string;
    title: string;
    body: string;
  }>;
  queue: ScheduleReservation[];
  suggestions: Array<{
    id: string;
    title: string;
    impact: string;
    priority: string;
  }>;
  summary: {
    revenue: number;
    pendingCount: number;
    confirmedCount: number;
    occupancyRate: number;
    waitlistCount: number;
    noShowRiskCount: number;
    lineReadRate: number;
    averageTicket: number;
  };
};
