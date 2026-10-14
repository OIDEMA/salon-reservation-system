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

export type AdminStaffDetail = AdminStaff & {
  sourceRecords: Array<{ source: string; sourceStoreId: string; importedAt: string; profile: Record<string, unknown> }>;
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

export type AdminCustomerSummary = Pick<AdminCustomer,
  "id" | "name" | "kana" | "phone" | "lineDisplayName" | "tags" | "visitCount" | "lastVisitAt"
> & { totalSpent: number | null };

export type AdminCustomerPage = {
  customers: AdminCustomerSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
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

export type AdminReservationListItem = Pick<AdminReservation,
  "id" | "date" | "startTime" | "endTime" | "status" | "source"
> & {
  customer: Pick<AdminReservation["customer"], "id" | "name" | "kana" | "phone">;
  service: Pick<AdminReservation["service"], "id" | "name" | "price">;
  staff: AdminReservation["staff"];
};

export type AdminReservationPage = {
  reservations: AdminReservationListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type ReservationOption = {
  id: string;
  date: string;
  startTime: string;
  customerName: string;
  serviceName: string;
};

export type ReservationHistorySummary = {
  id: string;
  externalReservationId: string;
  startsAt: string;
  endsAt: string | null;
  durationMinutes: number | null;
  customerName: string;
  staffName: string | null;
  menuText: string | null;
  sourceStatus: string;
  normalizedStatus: string | null;
  reservationAmount: number | null;
  sourceRoute: string | null;
};

export type ReservationHistoryPage = {
  items: ReservationHistorySummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  statusOptions: string[];
};

export type ReservationHistoryDetail = ReservationHistorySummary & {
  source: string;
  sourceStoreId: string;
  canReadOriginal: boolean;
  customerKana: string | null;
  customerNumber: string | null;
  externalCustomerId: string | null;
  externalStaffId: string | null;
  nominated: boolean | null;
  equipmentName: string | null;
  capturedAt: string;
  importedAt: string;
  customerId: string | null;
  staffId: string | null;
  rawHeaders?: string[];
  rawValues?: string[];
};

export type ReservationHistoryImportFile = {
  version: 1;
  source: "SALONBOARD";
  sourceStoreId: "H000551123";
  periodFrom: string;
  periodTo: string;
  capturedAt: string;
  expectedCount: number;
  records: unknown[];
};

export type ReservationHistoryImportProgress = {
  id: string;
  source: string;
  sourceStoreId: string;
  expectedCount: number;
  chunkSize: number;
  checksum: string;
  processedCount: number;
  createdCount: number;
  skippedCount: number;
  remainingCount: number;
  completed: boolean;
  processedOffsets: number[];
  periodFrom: string;
  periodTo: string;
  monthCounts: Record<string, number>;
  statusCounts: Record<string, number>;
};

export type ReservationHistoryStaffLinkGroup = {
  key: string;
  sourceStaffName: string;
  count: number;
  staffId: string | null;
  staffName: string | null;
  role: "ESTHETICIAN" | "ROOM_RESOURCE";
  action: "LINK_EXISTING" | "CREATE_INACTIVE";
  active: boolean;
  alreadyLinkedCount: number;
};

export type ReservationHistoryStaffLinkPlan = {
  checksum: string;
  periodFrom: string;
  periodTo: string;
  totalCount: number;
  linkedCount: number;
  pendingCount: number;
  existingStaffCount: number;
  newStaffCount: number;
  groups: ReservationHistoryStaffLinkGroup[];
  ready: boolean;
  issues: string[];
};

export type ReservationHistoryStaffLinkResult = {
  totalCount: number;
  linkedCount: number;
  pendingCount: number;
  createdStaffCount: number;
  alreadyLinkedCount: number;
  completed: boolean;
};
