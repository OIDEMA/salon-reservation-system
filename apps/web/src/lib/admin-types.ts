export type AdminSalon = {
  id: string;
  name: string;
  timezone: string;
};

export type SalonSettings = {
  id?: string;
  salonId?: string;
  storeId: string;
  openTime: string;
  closeTime: string;
  closedDays: string[];
  maxConcurrentReservations: number;
  bookingWindowType?: string;
  bookingWindowValue: string;
  reservationCutoffMode: string;
  reservationCutoffHours?: number;
  reservationCutoffDays: number;
  reservationCutoffTime: string;
  cancellationCutoffMode: string;
  cancellationCutoffHours?: number;
  cancellationCutoffDays: number;
  cancellationCutoffTime: string;
  multiMenuBooking: boolean;
  autoAssignUnspecified: boolean;
  lineThemeColor: string;
  categoryDisplayMode: string;
  candidateIntervalMinutes: number;
  calendarDefaultView: string;
  calendarDisplayMode: string;
  notifyReservationEmail: boolean;
  notifyReservationLine: boolean;
  notifyCancellation: boolean;
  notifyCancellationEmail: boolean;
  notifyCancellationLine: boolean;
  cancellationMessage: string;
  friendMessage: string;
  preReservationMessage: string;
  questionsEnabled: boolean;
  paymentEnabled: boolean;
  acceptingReservations: boolean;
};

export type AdminSettingsPayload = {
  salon: AdminSalon | null;
  settings: SalonSettings | null;
};

export type AdminStaff = {
  id: string;
  name: string;
  kana: string;
  role: string;
  color: string;
  imageUrl: string | null;
  nominationFee: number;
  comment: string | null;
  allocationOrder: number;
  parallelCapacity: number;
  active: boolean;
  sortOrder: number;
};

export type AdminMenu = {
  id: string;
  name: string;
  category: string;
  imageUrl: string | null;
  description: string;
  durationMinutes: number;
  price: number;
  color: string;
  menuType: string;
  lineVisible: boolean;
  unlimitedBooking: boolean;
  sortOrder: number;
  active: boolean;
};

export type AdminCategory = {
  id: string;
  name: string;
  type: "MENU" | "OPTION" | string;
  description: string;
  imageUrl: string | null;
  enabled: boolean;
  sortOrder: number;
};

export type AdminEquipment = {
  id: string;
  name: string;
  capacity: number;
  allocationOrder: number;
  color: string;
  memo: string;
  active: boolean;
  sortOrder: number;
};

export type AdminCustomer = {
  id: string;
  name: string;
  kana: string;
  phone: string | null;
  lineDisplayName: string | null;
  tags: string[];
  visitCount: number;
  totalSpent: number;
  lastVisitAt: string | null;
  memo: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { reservations: number };
};

export type AdminCustomerDetail = AdminCustomer & {
  reservations: Array<{
    id: string;
    startsAt: string;
    endsAt: string;
    status: string;
    memo: string | null;
    service: { id: string; name: string; price: number };
    staff: { id: string; name: string } | null;
  }>;
};

export type AdminReservation = {
  id: string;
  updatedAt: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  source: string;
  isRequest: boolean;
  memo: string;
  riskScore: number;
  paymentStatus: string;
  lineMessageStatus: string;
  customer: {
    id: string;
    name: string;
    kana: string;
    phone: string | null;
    visitCount: number;
    tags: string[];
  };
  service: {
    id: string;
    name: string;
    category: string;
    durationMinutes: number;
    price: number;
  };
  staff: { id: string; name: string } | null;
};

export type AdminShift = {
  id: string;
  staffId: string | null;
  label: string;
  type: "AVAILABLE" | "OFF" | "BREAK" | "SALES_STOP" | "TRAINING" | string;
  startsAt: string;
  endsAt: string;
  staff: { id: string; name: string } | null;
};
