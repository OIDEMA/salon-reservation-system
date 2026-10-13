export const adminNavigation = [
  { href: "/", label: "予約表", icon: "LayoutDashboard", permission: "reservation.read" },
  { href: "/confirmation", label: "予約確認", icon: "CircleAlert", permission: "reservation.read" },
  { href: "/calendar", label: "店舗カレンダー", icon: "CalendarDays", permission: "reservation.read" },
  { href: "/reservations", label: "予約者検索", icon: "Search", permission: "reservation.read" },
  { href: "/checkout", label: "会計", icon: "CreditCard", permission: "checkout.read" },
  { href: "/register", label: "レジ締め", icon: "Calculator", permission: "register.read" },
  { href: "/charts", label: "電子カルテ", icon: "ClipboardList", permission: "chart.read" },
  { href: "/access", label: "権限管理", icon: "ShieldCheck", permission: "access.manage" },
  { href: "/access/audit", label: "操作履歴", icon: "ClipboardList", permission: "audit.read" },
  { href: "/settings", label: "基本設定", icon: "Settings", permission: "settings.read" },
  { href: "/staff", label: "スタッフ", icon: "Users", permission: "master.read" },
  { href: "/shifts", label: "シフト", icon: "CalendarClock", permission: "reservation.read" },
  { href: "/menus", label: "メニュー", icon: "Scissors", permission: "master.read" },
  { href: "/categories", label: "カテゴリー", icon: "Tags", permission: "master.read" },
  { href: "/equipment", label: "設備", icon: "Wrench", permission: "master.read" },
  { href: "/customers", label: "顧客", icon: "BookUser", permission: "customer.read" }
] as const;

export function firstAccessibleAdminPath(membership: { role?: string; permissions?: readonly string[] }) {
  return adminNavigation.find((item) => membership.role === "OWNER" || membership.permissions?.includes(item.permission))?.href ?? null;
}
