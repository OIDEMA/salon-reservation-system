export type DashboardReservationStatus =
  | "PENDING"
  | "CONFIRMED"
  | "ARRIVED"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW"
  | "WAITLIST";

export type DashboardData = ReturnType<typeof buildDemoDashboard>;

const staffRows = [
  { id: "unassigned", type: "unassigned", label: "指名なし", subtitle: "自動割当待ち", color: "#334155", count: 2 },
  { id: "staff-nogizaki", type: "staff", label: "野崎 光哉", subtitle: "Stylist / 指名 1", color: "#16a34a", count: 4 },
  { id: "staff-morita", type: "staff", label: "森田 直美", subtitle: "Top stylist / 指名 1", color: "#0f766e", count: 5 },
  { id: "staff-yamamoto", type: "staff", label: "山本 翔英", subtitle: "Colorist / 指名 1", color: "#2563eb", count: 2 },
  { id: "room-esthe", type: "resource", label: "エステ", subtitle: "個室 / 指名 1", color: "#9333ea", count: 2 }
] as const;

export function buildDemoDashboard(date = "2026-06-28") {
  const reservations = [
    {
      id: "res-001",
      rowId: "staff-nogizaki",
      startTime: "12:30",
      endTime: "13:30",
      customerName: "岡本 大典",
      customerKana: "オカモト ダイスケ",
      serviceName: "カット + 眉メンテ",
      category: "Hair",
      price: 8800,
      status: "CONFIRMED" as DashboardReservationStatus,
      source: "LINE",
      isRequest: true,
      riskScore: 8,
      lineStatus: "READ",
      paymentStatus: "AUTHORIZED",
      memo: "前回と同じ長さ。店販提案あり。",
      visitCount: 12,
      tags: ["VIP", "店販見込み"]
    },
    {
      id: "res-002",
      rowId: "staff-nogizaki",
      startTime: "14:30",
      endTime: "15:00",
      customerName: "河田 優",
      customerKana: "カワダ ユウ",
      serviceName: "前髪カット",
      category: "Hair",
      price: 3300,
      status: "PENDING" as DashboardReservationStatus,
      source: "MINI_APP",
      isRequest: true,
      riskScore: 52,
      lineStatus: "SENT",
      paymentStatus: "UNPAID",
      memo: "初回来店。確認メッセージ未読。",
      visitCount: 0,
      tags: ["新規", "未確認"]
    },
    {
      id: "res-003",
      rowId: "staff-nogizaki",
      startTime: "15:30",
      endTime: "16:30",
      customerName: "大谷 靖代",
      customerKana: "オオタニ ヤスヨ",
      serviceName: "カラー + トリートメント",
      category: "Color",
      price: 15400,
      status: "PENDING" as DashboardReservationStatus,
      source: "LINE",
      isRequest: true,
      riskScore: 68,
      lineStatus: "QUEUED",
      paymentStatus: "UNPAID",
      memo: "薬剤履歴要確認。17時以降NG。",
      visitCount: 3,
      tags: ["要確認", "カラー"]
    },
    {
      id: "res-004",
      rowId: "staff-morita",
      startTime: "11:00",
      endTime: "11:30",
      customerName: "矢野 佐",
      customerKana: "ヤノ タスク",
      serviceName: "メンズカット",
      category: "Hair",
      price: 6600,
      status: "PENDING" as DashboardReservationStatus,
      source: "PHONE",
      isRequest: true,
      riskScore: 35,
      lineStatus: "NOT_SENT",
      paymentStatus: "UNPAID",
      memo: "電話予約。LINE連携案内。",
      visitCount: 1,
      tags: ["電話"]
    },
    {
      id: "res-005",
      rowId: "staff-morita",
      startTime: "11:30",
      endTime: "12:30",
      customerName: "野村 真里",
      customerKana: "ノムラ マリ",
      serviceName: "リタッチカラー",
      category: "Color",
      price: 9900,
      status: "PENDING" as DashboardReservationStatus,
      source: "LINE",
      isRequest: true,
      riskScore: 44,
      lineStatus: "SENT",
      paymentStatus: "AUTHORIZED",
      memo: "前回 6/1 来店。",
      visitCount: 8,
      tags: ["常連", "未確認"]
    },
    {
      id: "res-006",
      rowId: "staff-morita",
      startTime: "12:30",
      endTime: "13:30",
      customerName: "インスタ、館内清掃",
      customerKana: "タスク",
      serviceName: "運営業務",
      category: "Operation",
      price: 0,
      status: "CONFIRMED" as DashboardReservationStatus,
      source: "WEB",
      isRequest: false,
      riskScore: 0,
      lineStatus: "NOT_SENT",
      paymentStatus: "UNPAID",
      memo: "SNS投稿とフロアリセット。",
      visitCount: 0,
      tags: ["社内"]
    },
    {
      id: "res-007",
      rowId: "staff-morita",
      startTime: "13:30",
      endTime: "15:00",
      customerName: "原様　体験",
      customerKana: "ハラ",
      serviceName: "髪質改善 体験",
      category: "Treatment",
      price: 22000,
      status: "CONFIRMED" as DashboardReservationStatus,
      source: "MINI_APP",
      isRequest: false,
      riskScore: 12,
      lineStatus: "READ",
      paymentStatus: "AUTHORIZED",
      memo: "初回体験。写真許諾確認。",
      visitCount: 0,
      tags: ["高単価", "新規"]
    },
    {
      id: "res-008",
      rowId: "staff-morita",
      startTime: "15:00",
      endTime: "15:30",
      customerName: "小畑 営",
      customerKana: "オバタ エイ",
      serviceName: "前髪メンテ",
      category: "Hair",
      price: 3300,
      status: "PENDING" as DashboardReservationStatus,
      source: "LINE",
      isRequest: true,
      riskScore: 58,
      lineStatus: "FAILED",
      paymentStatus: "UNPAID",
      memo: "LINE送信失敗。電話確認推奨。",
      visitCount: 2,
      tags: ["送信失敗"]
    },
    {
      id: "res-009",
      rowId: "staff-morita",
      startTime: "17:00",
      endTime: "17:30",
      customerName: "田中 佐",
      customerKana: "タナカ サエ",
      serviceName: "カット",
      category: "Hair",
      price: 6600,
      status: "CONFIRMED" as DashboardReservationStatus,
      source: "LINE",
      isRequest: true,
      riskScore: 6,
      lineStatus: "READ",
      paymentStatus: "PAID",
      memo: "事前決済済み。",
      visitCount: 15,
      tags: ["VIP", "決済済"]
    },
    {
      id: "res-010",
      rowId: "staff-yamamoto",
      startTime: "12:30",
      endTime: "13:00",
      customerName: "多田 羅",
      customerKana: "タダ ラ",
      serviceName: "カラー相談",
      category: "Color",
      price: 4400,
      status: "CONFIRMED" as DashboardReservationStatus,
      source: "LINE",
      isRequest: false,
      riskScore: 18,
      lineStatus: "READ",
      paymentStatus: "UNPAID",
      memo: "ブリーチ相談。履歴写真あり。",
      visitCount: 4,
      tags: ["カラー相談"]
    }
  ];

  const blocks = [
    { id: "block-001", rowId: "staff-nogizaki", startTime: "09:00", endTime: "10:00", label: "シフト時間外", kind: "OFF" },
    { id: "block-002", rowId: "staff-nogizaki", startTime: "12:00", endTime: "12:30", label: "販売停止", kind: "SALES_STOP" },
    { id: "block-003", rowId: "staff-nogizaki", startTime: "17:00", endTime: "17:30", label: "販売停止", kind: "SALES_STOP" },
    { id: "block-004", rowId: "staff-nogizaki", startTime: "18:00", endTime: "20:00", label: "シフト時間外", kind: "OFF" },
    { id: "block-005", rowId: "staff-morita", startTime: "09:00", endTime: "11:00", label: "シフト時間外", kind: "OFF" },
    { id: "block-006", rowId: "staff-morita", startTime: "18:00", endTime: "20:00", label: "シフト時間外", kind: "OFF" },
    { id: "block-007", rowId: "staff-yamamoto", startTime: "09:00", endTime: "10:00", label: "シフト時間外", kind: "OFF" },
    { id: "block-008", rowId: "staff-yamamoto", startTime: "14:00", endTime: "20:00", label: "シフト時間外", kind: "OFF" },
    { id: "block-009", rowId: "room-esthe", startTime: "09:00", endTime: "10:00", label: "シフト時間外", kind: "OFF" },
    { id: "block-010", rowId: "room-esthe", startTime: "18:00", endTime: "20:00", label: "シフト時間外", kind: "OFF" }
  ];

  const pendingCount = reservations.filter((reservation) => reservation.status === "PENDING").length;
  const confirmedCount = reservations.filter((reservation) => reservation.status === "CONFIRMED").length;
  const revenue = reservations.reduce((total, reservation) => total + reservation.price, 0);

  return {
    date,
    salon: {
      id: "salon-boneedz",
      name: "Boneedz丸亀店",
      timezone: "Asia/Tokyo",
      plan: "Growth"
    },
    hours: {
      start: "09:00",
      end: "20:00",
      stepMinutes: 30
    },
    rows: staffRows,
    reservations,
    blocks,
    notifications: [
      { id: "note-001", severity: "danger", title: "未確認の予約があります", body: `${pendingCount}件の予約確認が未完了です。` },
      { id: "note-002", severity: "warning", title: "新着のお知らせがあります", body: "LINE配信テンプレートの審査結果が届いています。" }
    ],
    queue: reservations
      .filter((reservation) => reservation.status === "PENDING")
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 5),
    suggestions: [
      {
        id: "sg-001",
        title: "15:00の30分枠を小畑様から河田様へ確認",
        impact: "+3,300円 / 未確認リスク -18%",
        priority: "high"
      },
      {
        id: "sg-002",
        title: "山本さんの13:00-14:00にカラー相談待ちを自動提案",
        impact: "空き時間 60分を収益化",
        priority: "medium"
      },
      {
        id: "sg-003",
        title: "送信失敗の小畑様へSMS代替通知",
        impact: "来店率改善",
        priority: "high"
      }
    ],
    summary: {
      revenue,
      pendingCount,
      confirmedCount,
      occupancyRate: 72,
      waitlistCount: 3,
      noShowRiskCount: reservations.filter((reservation) => reservation.riskScore >= 50).length,
      lineReadRate: 81,
      averageTicket: Math.round(revenue / Math.max(1, reservations.filter((reservation) => reservation.price > 0).length))
    }
  };
}
