import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function at(date: string, time: string) {
  return new Date(`${date}T${time}:00.000+09:00`);
}

async function main() {
  const date = "2026-06-28";
  await prisma.notification.deleteMany();
  await prisma.shift.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.salonSettings.deleteMany();
  await prisma.equipment.deleteMany();
  await prisma.menuCategory.deleteMany();
  await prisma.service.deleteMany();
  await prisma.staff.deleteMany();
  await prisma.salon.deleteMany();

  const salon = await prisma.salon.create({
    data: {
      name: "Boneedz丸亀店",
      timezone: "Asia/Tokyo"
    }
  });

  await prisma.salonSettings.create({
    data: {
      salonId: salon.id,
      storeId: "14805",
      openTime: "09:00",
      closeTime: "22:00",
      closedDays: ["月"],
      maxConcurrentReservations: 7,
      bookingWindowValue: "1ヶ月先",
      reservationCutoffDays: 1,
      reservationCutoffTime: "21:30",
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
        "いつも当店をご利用いただきありがとうございます。\n\n・ご予約の予定時間から15分から30分経過しても来店されていない。\n・事前にお電話等でキャンセルの連絡を承っている場合。\n\n上記事項により、以下のご予約に関しましてキャンセル扱いとなりましたので通知いたします。",
      friendMessage: "お客様情報の登録を行います。\n1分程度で完了しますのでご協力お願いいたします。",
      preReservationMessage: "ご予約前に体調・既往歴・ご希望を確認いたします。",
      questionsEnabled: false,
      paymentEnabled: false,
      acceptingReservations: true
    }
  });

  const staff = await Promise.all([
    prisma.staff.create({ data: { salonId: salon.id, name: "野崎光誠", kana: "ノザキ コウセイ", role: "STYLIST", color: "#16a34a", imageUrl: "https://placehold.co/160x180/ef4444/ffffff?text=Nozaki", nominationFee: 0, allocationOrder: 2, parallelCapacity: 1, sortOrder: 1 } }),
    prisma.staff.create({ data: { salonId: salon.id, name: "前田和樹", kana: "マエダ カズキ", role: "STYLIST", color: "#22c55e", imageUrl: "https://placehold.co/160x180/dc2626/ffffff?text=Maeda", nominationFee: 0, allocationOrder: 1, parallelCapacity: 1, sortOrder: 2 } }),
    prisma.staff.create({ data: { salonId: salon.id, name: "濵田　浩司", kana: "ハマダ コウジ", role: "STYLIST", color: "#0ea5e9", imageUrl: "https://placehold.co/160x180/b91c1c/ffffff?text=Hamada", nominationFee: 0, allocationOrder: 2, parallelCapacity: 1, sortOrder: 3 } }),
    prisma.staff.create({ data: { salonId: salon.id, name: "新宮明日香", kana: "シングウ アスカ", role: "STYLIST", color: "#ec4899", imageUrl: "https://placehold.co/160x180/f43f5e/ffffff?text=Shingu", nominationFee: 0, allocationOrder: 1, parallelCapacity: 1, sortOrder: 4 } }),
    prisma.staff.create({ data: { salonId: salon.id, name: "森田直美", kana: "モリタ ナオミ", role: "MANAGER", color: "#0f766e", imageUrl: "https://placehold.co/160x180/e11d48/ffffff?text=Morita", nominationFee: 0, allocationOrder: 1, parallelCapacity: 1, sortOrder: 5 } }),
    prisma.staff.create({ data: { salonId: salon.id, name: "白井駿", kana: "シライ シュン", role: "STYLIST", color: "#14b8a6", imageUrl: "https://placehold.co/160x180/be123c/ffffff?text=Shirai", nominationFee: 0, allocationOrder: 1, parallelCapacity: 1, sortOrder: 6 } }),
    prisma.staff.create({ data: { salonId: salon.id, name: "山本翔瑛", kana: "ヤマモト ショウエイ", role: "STYLIST", color: "#2563eb", imageUrl: "https://placehold.co/160x180/dc2626/ffffff?text=Yamamoto", nominationFee: 0, allocationOrder: 1, parallelCapacity: 1, sortOrder: 7 } }),
    prisma.staff.create({ data: { salonId: salon.id, name: "大久保宏隆(トレーナー)", kana: "オオクボ ヒロタカ", role: "ASSISTANT", color: "#f59e0b", imageUrl: "https://placehold.co/160x180/7f1d1d/ffffff?text=Okubo", nominationFee: 0, allocationOrder: 1, parallelCapacity: 1, sortOrder: 8 } }),
    prisma.staff.create({ data: { salonId: salon.id, name: "大久保宏隆(整体)", kana: "オオクボ ヒロタカ", role: "STYLIST", color: "#a855f7", imageUrl: "https://placehold.co/160x180/7e22ce/ffffff?text=Okubo", nominationFee: 0, allocationOrder: 1, parallelCapacity: 1, sortOrder: 9 } }),
    prisma.staff.create({ data: { salonId: salon.id, name: "エステ", kana: "エステ", role: "ROOM_RESOURCE", color: "#9333ea", nominationFee: 0, allocationOrder: 1, parallelCapacity: 1, sortOrder: 10 } })
  ]);

  const staffByName = Object.fromEntries(staff.map((member) => [member.name, member]));

  await prisma.menuCategory.createMany({
    data: [
      { salonId: salon.id, name: "パーソナルトレーニング", type: "MENU", description: "30分・60分のトレーニング枠", sortOrder: 1 },
      { salonId: salon.id, name: "整体", type: "MENU", description: "骨盤・猫背矯正、もみほぐし", sortOrder: 2 },
      { salonId: salon.id, name: "もみほぐし", type: "MENU", description: "疲労回復とリラクゼーション", sortOrder: 3 },
      { salonId: salon.id, name: "エステ", type: "MENU", description: "フェイシャル、ボディ、ハーブ蒸し", sortOrder: 4 },
      { salonId: salon.id, name: "イベントチケット", type: "OPTION", description: "感謝祭など期間限定メニュー", sortOrder: 5 }
    ]
  });

  await prisma.equipment.createMany({
    data: [
      { salonId: salon.id, name: "トレーニングブース A", capacity: 2, allocationOrder: 1, color: "#16a34a", memo: "パーソナルトレーニング優先", sortOrder: 1 },
      { salonId: salon.id, name: "整体ベッド 1", capacity: 1, allocationOrder: 1, color: "#0f766e", memo: "整体・もみほぐし", sortOrder: 2 },
      { salonId: salon.id, name: "整体ベッド 2", capacity: 1, allocationOrder: 2, color: "#0ea5e9", memo: "混雑時の自動割当", sortOrder: 3 },
      { salonId: salon.id, name: "エステ個室", capacity: 1, allocationOrder: 1, color: "#9333ea", memo: "フェイシャル/ボディ専用", sortOrder: 4 }
    ]
  });

  const services = await Promise.all([
    prisma.service.create({ data: { salonId: salon.id, name: "３０分パーソナルトレーニング", category: "パーソナルトレーニング", durationMinutes: 30, price: 0, color: "#16a34a", description: "30分コースのご利用になります", sortOrder: 1 } }),
    prisma.service.create({ data: { salonId: salon.id, name: "６０分パーソナルトレーニング", category: "パーソナルトレーニング", durationMinutes: 60, price: 0, color: "#16a34a", description: "60分コースのご利用になります", sortOrder: 2 } }),
    prisma.service.create({ data: { salonId: salon.id, name: "【整体】30分", category: "整体", durationMinutes: 30, price: 5000, color: "#0f766e", description: "部分的に矯正、もみほぐし、ストレッチ。トレーニング前後のケアにおすすめ", sortOrder: 3 } }),
    prisma.service.create({ data: { salonId: salon.id, name: "【整体】60分", category: "整体", durationMinutes: 60, price: 10000, color: "#0f766e", description: "骨盤、猫背矯正など歪みを取りながらもみほぐしします", sortOrder: 4 } }),
    prisma.service.create({ data: { salonId: salon.id, name: "【整体】90分", category: "整体", durationMinutes: 90, price: 22000, color: "#0f766e", description: "骨盤、猫背矯正、小顔矯正など全身の矯正ともみほぐし", sortOrder: 5 } }),
    prisma.service.create({ data: { salonId: salon.id, name: "【もみほぐしのみ】30分", category: "もみほぐし", durationMinutes: 30, price: 4000, color: "#2563eb", description: "部分的なもみほぐし、ストレッチ。疲労回復、リラクゼーション効果", sortOrder: 6 } }),
    prisma.service.create({ data: { salonId: salon.id, name: "【もみほぐしのみ】60分", category: "もみほぐし", durationMinutes: 60, price: 8000, color: "#2563eb", description: "全身もみほぐし、ストレッチ。疲労回復、リラクゼーション効果", sortOrder: 7 } }),
    prisma.service.create({ data: { salonId: salon.id, name: "【エステ】フェイシャルケア", category: "エステ", durationMinutes: 60, price: 10000, color: "#9333ea", description: "顔からデコルテまでのオイルマッサージ、美白、くすみ取り、肌質改善", sortOrder: 8 } }),
    prisma.service.create({ data: { salonId: salon.id, name: "【エステ】ボディケア", category: "エステ", durationMinutes: 120, price: 20000, color: "#9333ea", description: "全身オイルマッサージ、美容液導入、疲労回復、リラクゼーション", sortOrder: 9 } }),
    prisma.service.create({ data: { salonId: salon.id, name: "【エステ】ハーブ蒸し", category: "エステ", durationMinutes: 30, price: 3000, color: "#9333ea", description: "4種類のハーブから選択。美肌効果、疲労回復など", sortOrder: 10 } }),
    prisma.service.create({ data: { salonId: salon.id, name: "整体チケット", category: "イベントチケット", durationMinutes: 30, price: 1000, color: "#d97706", description: "感謝祭イベント 3月末まで", menuType: "限定メニュー", sortOrder: 11 } }),
    prisma.service.create({ data: { salonId: salon.id, name: "エステチケット", category: "イベントチケット", durationMinutes: 30, price: 1000, color: "#d97706", description: "感謝祭イベント 3月末まで。3つのコースから選択", menuType: "限定メニュー", sortOrder: 12 } })
  ]);

  const serviceByName = Object.fromEntries(services.map((service) => [service.name, service]));
  const customerSeed = [
    ["岡本 大典", "オカモト ダイスケ", ["VIP", "店販見込み"], 12, 184000],
    ["河田 優", "カワダ ユウ", ["新規", "未確認"], 0, 0],
    ["大谷 靖代", "オオタニ ヤスヨ", ["要確認", "カラー"], 3, 42900],
    ["矢野 佐", "ヤノ タスク", ["電話"], 1, 6600],
    ["野村 真里", "ノムラ マリ", ["常連", "未確認"], 8, 81200],
    ["インスタ、館内清掃", "タスク", ["社内"], 0, 0],
    ["原様　体験", "ハラ", ["高単価", "新規"], 0, 0],
    ["小畑 営", "オバタ エイ", ["送信失敗"], 2, 13200],
    ["田中 佐", "タナカ サエ", ["VIP", "決済済"], 15, 211000],
    ["多田 羅", "タダ ラ", ["カラー相談"], 4, 35200]
  ] as const;

  const customers = await Promise.all(
    customerSeed.map(([name, kana, tags, visitCount, totalSpent]) =>
      prisma.customer.create({
        data: {
          salonId: salon.id,
          name,
          kana,
          tags: [...tags],
          visitCount,
          totalSpent,
          lineDisplayName: name
        }
      })
    )
  );
  const customerByName = Object.fromEntries(customers.map((customer) => [customer.name, customer]));

  await prisma.reservation.createMany({
    data: [
      { salonId: salon.id, staffId: staffByName["野崎光誠"].id, customerId: customerByName["岡本 大典"].id, serviceId: serviceByName["６０分パーソナルトレーニング"].id, startsAt: at(date, "12:30"), endsAt: at(date, "13:30"), status: "CONFIRMED", source: "LINE", isRequest: true, riskScore: 8, paymentStatus: "AUTHORIZED", lineMessageStatus: "READ", memo: "トレーニング前後の整体提案あり。" },
      { salonId: salon.id, staffId: staffByName["野崎光誠"].id, customerId: customerByName["河田 優"].id, serviceId: serviceByName["【整体】30分"].id, startsAt: at(date, "14:30"), endsAt: at(date, "15:00"), status: "PENDING", source: "MINI_APP", isRequest: true, riskScore: 52, paymentStatus: "UNPAID", lineMessageStatus: "SENT", memo: "初回来店。確認メッセージ未読。" },
      { salonId: salon.id, staffId: staffByName["野崎光誠"].id, customerId: customerByName["大谷 靖代"].id, serviceId: serviceByName["【整体】60分"].id, startsAt: at(date, "15:30"), endsAt: at(date, "16:30"), status: "PENDING", source: "LINE", isRequest: true, riskScore: 68, paymentStatus: "UNPAID", lineMessageStatus: "QUEUED", memo: "薬剤履歴要確認。17時以降NG。" },
      { salonId: salon.id, staffId: staffByName["森田直美"].id, customerId: customerByName["矢野 佐"].id, serviceId: serviceByName["３０分パーソナルトレーニング"].id, startsAt: at(date, "11:00"), endsAt: at(date, "11:30"), status: "PENDING", source: "PHONE", isRequest: true, riskScore: 35, paymentStatus: "UNPAID", lineMessageStatus: "NOT_SENT", memo: "電話予約。LINE連携案内。" },
      { salonId: salon.id, staffId: staffByName["森田直美"].id, customerId: customerByName["野村 真里"].id, serviceId: serviceByName["６０分パーソナルトレーニング"].id, startsAt: at(date, "11:30"), endsAt: at(date, "12:30"), status: "PENDING", source: "LINE", isRequest: true, riskScore: 44, paymentStatus: "AUTHORIZED", lineMessageStatus: "SENT", memo: "前回 6/1 来店。" },
      { salonId: salon.id, staffId: staffByName["森田直美"].id, customerId: customerByName["インスタ、館内清掃"].id, serviceId: serviceByName["整体チケット"].id, startsAt: at(date, "12:30"), endsAt: at(date, "13:30"), status: "CONFIRMED", source: "WEB", isRequest: false, riskScore: 0, paymentStatus: "UNPAID", lineMessageStatus: "NOT_SENT", memo: "SNS投稿とフロアリセット。" },
      { salonId: salon.id, staffId: staffByName["森田直美"].id, customerId: customerByName["原様　体験"].id, serviceId: serviceByName["【整体】90分"].id, startsAt: at(date, "13:30"), endsAt: at(date, "15:00"), status: "CONFIRMED", source: "MINI_APP", isRequest: false, riskScore: 12, paymentStatus: "AUTHORIZED", lineMessageStatus: "READ", memo: "初回体験。写真許諾確認。" },
      { salonId: salon.id, staffId: staffByName["森田直美"].id, customerId: customerByName["小畑 営"].id, serviceId: serviceByName["【もみほぐしのみ】30分"].id, startsAt: at(date, "15:00"), endsAt: at(date, "15:30"), status: "PENDING", source: "LINE", isRequest: true, riskScore: 58, paymentStatus: "UNPAID", lineMessageStatus: "FAILED", memo: "LINE送信失敗。電話確認推奨。" },
      { salonId: salon.id, staffId: staffByName["森田直美"].id, customerId: customerByName["田中 佐"].id, serviceId: serviceByName["【もみほぐしのみ】30分"].id, startsAt: at(date, "17:00"), endsAt: at(date, "17:30"), status: "CONFIRMED", source: "LINE", isRequest: true, riskScore: 6, paymentStatus: "PAID", lineMessageStatus: "READ", memo: "事前決済済み。" },
      { salonId: salon.id, staffId: staffByName["山本翔瑛"].id, customerId: customerByName["多田 羅"].id, serviceId: serviceByName["【エステ】ハーブ蒸し"].id, startsAt: at(date, "12:30"), endsAt: at(date, "13:00"), status: "CONFIRMED", source: "LINE", isRequest: false, riskScore: 18, paymentStatus: "UNPAID", lineMessageStatus: "READ", memo: "ハーブ種類を来店時に確認。" }
    ]
  });

  await prisma.shift.createMany({
    data: [
      { salonId: salon.id, staffId: staffByName["野崎光誠"].id, startsAt: at(date, "09:00"), endsAt: at(date, "10:00"), type: "OFF", label: "シフト時間外" },
      { salonId: salon.id, staffId: staffByName["野崎光誠"].id, startsAt: at(date, "12:00"), endsAt: at(date, "12:30"), type: "SALES_STOP", label: "販売停止" },
      { salonId: salon.id, staffId: staffByName["野崎光誠"].id, startsAt: at(date, "17:00"), endsAt: at(date, "17:30"), type: "SALES_STOP", label: "販売停止" },
      { salonId: salon.id, staffId: staffByName["野崎光誠"].id, startsAt: at(date, "18:00"), endsAt: at(date, "20:00"), type: "OFF", label: "シフト時間外" },
      { salonId: salon.id, staffId: staffByName["森田直美"].id, startsAt: at(date, "09:00"), endsAt: at(date, "11:00"), type: "OFF", label: "シフト時間外" },
      { salonId: salon.id, staffId: staffByName["森田直美"].id, startsAt: at(date, "18:00"), endsAt: at(date, "20:00"), type: "OFF", label: "シフト時間外" },
      { salonId: salon.id, staffId: staffByName["山本翔瑛"].id, startsAt: at(date, "09:00"), endsAt: at(date, "10:00"), type: "OFF", label: "シフト時間外" },
      { salonId: salon.id, staffId: staffByName["山本翔瑛"].id, startsAt: at(date, "14:00"), endsAt: at(date, "20:00"), type: "OFF", label: "シフト時間外" },
      { salonId: salon.id, staffId: staffByName["エステ"].id, startsAt: at(date, "09:00"), endsAt: at(date, "10:00"), type: "OFF", label: "シフト時間外" },
      { salonId: salon.id, staffId: staffByName["エステ"].id, startsAt: at(date, "18:00"), endsAt: at(date, "20:00"), type: "OFF", label: "シフト時間外" }
    ]
  });

  await prisma.notification.createMany({
    data: [
      { salonId: salon.id, kind: "reservation", title: "未確認の予約があります", body: "5件の予約確認が未完了です。", severity: "danger" },
      { salonId: salon.id, kind: "notice", title: "新着のお知らせがあります", body: "LINE配信テンプレートの審査結果が届いています。", severity: "warning" }
    ]
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
