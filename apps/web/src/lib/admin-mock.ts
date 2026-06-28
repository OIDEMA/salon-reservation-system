import type { AdminCategory, AdminEquipment, AdminMenu, AdminSettingsPayload, AdminStaff } from "./admin-types";

export const mockAdminSettings: AdminSettingsPayload = {
  salon: {
    id: "salon-boneedz",
    name: "Boneedz丸亀店",
    timezone: "Asia/Tokyo"
  },
  settings: {
    storeId: "14805",
    openTime: "09:00",
    closeTime: "22:00",
    closedDays: ["月"],
    maxConcurrentReservations: 7,
    bookingWindowType: "month",
    bookingWindowValue: "1ヶ月先",
    reservationCutoffMode: "previous_day",
    reservationCutoffHours: 0,
    reservationCutoffDays: 1,
    reservationCutoffTime: "21:30",
    cancellationCutoffMode: "previous_day",
    cancellationCutoffHours: 0,
    cancellationCutoffDays: 1,
    cancellationCutoffTime: "21:30",
    multiMenuBooking: true,
    autoAssignUnspecified: true,
    lineThemeColor: "#ff0000",
    categoryDisplayMode: "collapsed",
    candidateIntervalMinutes: 30,
    calendarDefaultView: "week",
    calendarDisplayMode: "collapsed",
    notifyReservationEmail: true,
    notifyReservationLine: false,
    notifyCancellation: true,
    notifyCancellationEmail: true,
    notifyCancellationLine: false,
    cancellationMessage:
      "いつも当店をご利用いただきありがとうございます。\n\nご予約の予定時間から15分から30分経過しても来店されていない場合、または事前にキャンセルの連絡を承っている場合、キャンセル扱いとして通知いたします。",
    friendMessage: "お客様情報の登録を行います。\n1分程度で完了しますのでご協力お願いいたします。",
    preReservationMessage: "ご予約前に体調・既往歴・ご希望を確認いたします。",
    questionsEnabled: false,
    paymentEnabled: false,
    acceptingReservations: true
  }
};

export const mockAdminStaff: AdminStaff[] = [
  { id: "staff-nozaki", name: "野崎光誠", kana: "ノザキ コウセイ", role: "STYLIST", color: "#16a34a", imageUrl: "https://placehold.co/160x180/ef4444/ffffff?text=Nozaki", nominationFee: 0, comment: "", allocationOrder: 2, parallelCapacity: 1, active: true, sortOrder: 1 },
  { id: "staff-maeda", name: "前田和樹", kana: "マエダ カズキ", role: "STYLIST", color: "#22c55e", imageUrl: "https://placehold.co/160x180/dc2626/ffffff?text=Maeda", nominationFee: 0, comment: "", allocationOrder: 1, parallelCapacity: 1, active: true, sortOrder: 2 },
  { id: "staff-hamada", name: "濵田　浩司", kana: "ハマダ コウジ", role: "STYLIST", color: "#0ea5e9", imageUrl: "https://placehold.co/160x180/b91c1c/ffffff?text=Hamada", nominationFee: 0, comment: "", allocationOrder: 2, parallelCapacity: 1, active: true, sortOrder: 3 },
  { id: "staff-shingu", name: "新宮明日香", kana: "シングウ アスカ", role: "STYLIST", color: "#ec4899", imageUrl: "https://placehold.co/160x180/f43f5e/ffffff?text=Shingu", nominationFee: 0, comment: "", allocationOrder: 1, parallelCapacity: 1, active: true, sortOrder: 4 },
  { id: "staff-morita", name: "森田直美", kana: "モリタ ナオミ", role: "MANAGER", color: "#0f766e", imageUrl: "https://placehold.co/160x180/e11d48/ffffff?text=Morita", nominationFee: 0, comment: "", allocationOrder: 1, parallelCapacity: 1, active: true, sortOrder: 5 },
  { id: "staff-shirai", name: "白井駿", kana: "シライ シュン", role: "STYLIST", color: "#14b8a6", imageUrl: "https://placehold.co/160x180/be123c/ffffff?text=Shirai", nominationFee: 0, comment: "", allocationOrder: 1, parallelCapacity: 1, active: true, sortOrder: 6 },
  { id: "staff-yamamoto", name: "山本翔瑛", kana: "ヤマモト ショウエイ", role: "STYLIST", color: "#2563eb", imageUrl: "https://placehold.co/160x180/dc2626/ffffff?text=Yamamoto", nominationFee: 0, comment: "", allocationOrder: 1, parallelCapacity: 1, active: true, sortOrder: 7 },
  { id: "staff-trainer-okubo", name: "大久保宏隆(トレーナー)", kana: "オオクボ ヒロタカ", role: "ASSISTANT", color: "#f59e0b", imageUrl: "https://placehold.co/160x180/7f1d1d/ffffff?text=Okubo", nominationFee: 0, comment: "", allocationOrder: 1, parallelCapacity: 1, active: true, sortOrder: 8 },
  { id: "staff-seitai-okubo", name: "大久保宏隆(整体)", kana: "オオクボ ヒロタカ", role: "STYLIST", color: "#a855f7", imageUrl: "https://placehold.co/160x180/7e22ce/ffffff?text=Okubo", nominationFee: 0, comment: "", allocationOrder: 1, parallelCapacity: 1, active: true, sortOrder: 9 },
  { id: "room-esthe", name: "エステ", kana: "エステ", role: "ROOM_RESOURCE", color: "#9333ea", imageUrl: null, nominationFee: 0, comment: "", allocationOrder: 1, parallelCapacity: 1, active: true, sortOrder: 10 }
];

export const mockAdminMenus: AdminMenu[] = [
  { id: "menu-training-30", name: "３０分パーソナルトレーニング", category: "パーソナルトレーニング", imageUrl: null, description: "30分コースのご利用になります", durationMinutes: 30, price: 0, color: "#16a34a", menuType: "通常メニュー", lineVisible: true, unlimitedBooking: true, sortOrder: 1, active: true },
  { id: "menu-training-60", name: "６０分パーソナルトレーニング", category: "パーソナルトレーニング", imageUrl: null, description: "60分コースのご利用になります", durationMinutes: 60, price: 0, color: "#16a34a", menuType: "通常メニュー", lineVisible: true, unlimitedBooking: true, sortOrder: 2, active: true },
  { id: "menu-seitai-30", name: "【整体】30分", category: "整体", imageUrl: null, description: "部分的に矯正、もみほぐし、ストレッチ。トレーニング前後のケアにおすすめ", durationMinutes: 30, price: 5000, color: "#0f766e", menuType: "通常メニュー", lineVisible: true, unlimitedBooking: true, sortOrder: 3, active: true },
  { id: "menu-seitai-60", name: "【整体】60分", category: "整体", imageUrl: null, description: "骨盤、猫背矯正など歪みを取りながらもみほぐしします", durationMinutes: 60, price: 10000, color: "#0f766e", menuType: "通常メニュー", lineVisible: true, unlimitedBooking: true, sortOrder: 4, active: true },
  { id: "menu-seitai-90", name: "【整体】90分", category: "整体", imageUrl: null, description: "骨盤、猫背矯正、小顔矯正など全身の矯正ともみほぐし", durationMinutes: 90, price: 22000, color: "#0f766e", menuType: "通常メニュー", lineVisible: true, unlimitedBooking: true, sortOrder: 5, active: true },
  { id: "menu-momi-30", name: "【もみほぐしのみ】30分", category: "もみほぐし", imageUrl: null, description: "部分的なもみほぐし、ストレッチ。疲労回復、リラクゼーション効果", durationMinutes: 30, price: 4000, color: "#2563eb", menuType: "通常メニュー", lineVisible: true, unlimitedBooking: true, sortOrder: 6, active: true },
  { id: "menu-momi-60", name: "【もみほぐしのみ】60分", category: "もみほぐし", imageUrl: null, description: "全身もみほぐし、ストレッチ。疲労回復、リラクゼーション効果", durationMinutes: 60, price: 8000, color: "#2563eb", menuType: "通常メニュー", lineVisible: true, unlimitedBooking: true, sortOrder: 7, active: true },
  { id: "menu-esthe-face", name: "【エステ】フェイシャルケア", category: "エステ", imageUrl: null, description: "顔からデコルテまでのオイルマッサージ、美白、くすみ取り、肌質改善", durationMinutes: 60, price: 10000, color: "#9333ea", menuType: "通常メニュー", lineVisible: true, unlimitedBooking: true, sortOrder: 8, active: true },
  { id: "menu-esthe-body", name: "【エステ】ボディケア", category: "エステ", imageUrl: null, description: "全身オイルマッサージ、美容液導入、疲労回復、リラクゼーション", durationMinutes: 120, price: 20000, color: "#9333ea", menuType: "通常メニュー", lineVisible: true, unlimitedBooking: true, sortOrder: 9, active: true },
  { id: "menu-herb", name: "【エステ】ハーブ蒸し", category: "エステ", imageUrl: null, description: "4種類のハーブから選択。美肌効果、疲労回復など", durationMinutes: 30, price: 3000, color: "#9333ea", menuType: "通常メニュー", lineVisible: true, unlimitedBooking: true, sortOrder: 10, active: true },
  { id: "menu-ticket-seitai", name: "整体チケット", category: "イベントチケット", imageUrl: null, description: "感謝祭イベント 3月末まで", durationMinutes: 30, price: 1000, color: "#d97706", menuType: "限定メニュー", lineVisible: true, unlimitedBooking: true, sortOrder: 11, active: true },
  { id: "menu-ticket-esthe", name: "エステチケット", category: "イベントチケット", imageUrl: null, description: "感謝祭イベント 3月末まで。3つのコースから選択", durationMinutes: 30, price: 1000, color: "#d97706", menuType: "限定メニュー", lineVisible: true, unlimitedBooking: true, sortOrder: 12, active: true }
];

export const mockAdminCategories: AdminCategory[] = [
  { id: "cat-training", name: "パーソナルトレーニング", type: "MENU", description: "30分・60分のトレーニング枠", imageUrl: null, enabled: true, sortOrder: 1 },
  { id: "cat-seitai", name: "整体", type: "MENU", description: "骨盤・猫背矯正、もみほぐし", imageUrl: null, enabled: true, sortOrder: 2 },
  { id: "cat-momihogushi", name: "もみほぐし", type: "MENU", description: "疲労回復とリラクゼーション", imageUrl: null, enabled: true, sortOrder: 3 },
  { id: "cat-esthe", name: "エステ", type: "MENU", description: "フェイシャル、ボディ、ハーブ蒸し", imageUrl: null, enabled: true, sortOrder: 4 },
  { id: "cat-ticket", name: "イベントチケット", type: "OPTION", description: "感謝祭など期間限定メニュー", imageUrl: null, enabled: true, sortOrder: 5 }
];

export const mockAdminEquipment: AdminEquipment[] = [
  { id: "eq-training", name: "トレーニングブース A", capacity: 2, allocationOrder: 1, color: "#16a34a", memo: "パーソナルトレーニング優先", active: true, sortOrder: 1 },
  { id: "eq-bed-1", name: "整体ベッド 1", capacity: 1, allocationOrder: 1, color: "#0f766e", memo: "整体・もみほぐし", active: true, sortOrder: 2 },
  { id: "eq-bed-2", name: "整体ベッド 2", capacity: 1, allocationOrder: 2, color: "#0ea5e9", memo: "混雑時の自動割当", active: true, sortOrder: 3 },
  { id: "eq-esthe", name: "エステ個室", capacity: 1, allocationOrder: 1, color: "#9333ea", memo: "フェイシャル/ボディ専用", active: true, sortOrder: 4 }
];
