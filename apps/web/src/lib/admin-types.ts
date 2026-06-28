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
  salon: AdminSalon;
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
