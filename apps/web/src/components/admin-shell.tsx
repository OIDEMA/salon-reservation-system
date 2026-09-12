"use client";

import {
  BookUser,
  CircleAlert,
  CalendarClock,
  CalendarDays,
  LayoutDashboard,
  Scissors,
  Search,
  Settings,
  Tags,
  Users,
  Wrench
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { LogoutButton } from "@/components/logout-button";
import { useTenantSlug } from "@/components/tenant-provider";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { tenantPath } from "@/lib/tenant-routing";

const navItems = [
  { href: "/", label: "予約表", icon: LayoutDashboard },
  { href: "/confirmation", label: "予約確認", icon: CircleAlert },
  { href: "/calendar", label: "店舗カレンダー", icon: CalendarDays },
  { href: "/reservations", label: "予約者検索", icon: Search },
  { href: "/settings", label: "基本設定", icon: Settings },
  { href: "/staff", label: "スタッフ", icon: Users },
  { href: "/shifts", label: "シフト", icon: CalendarClock },
  { href: "/menus", label: "メニュー", icon: Scissors },
  { href: "/categories", label: "カテゴリー", icon: Tags },
  { href: "/equipment", label: "設備", icon: Wrench },
  { href: "/customers", label: "顧客", icon: BookUser }
];

type AdminShellProps = {
  active: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
};

export function AdminShell({ active, title, actions, children }: AdminShellProps) {
  const tenantSlug = useTenantSlug();

  return (
    <main className="adminShell">
      <aside className="adminSidebar">
        <Link className="adminBrand" href={tenantPath(tenantSlug)} title="株式会社Beauty Gum">
          <Image src="/brand/beauty-gum-logo.webp" alt="株式会社Beauty Gum" width={400} height={100} />
        </Link>
        <nav className="adminNav" aria-label="admin navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                className={item.href === active ? "adminNavItem isActive" : "adminNavItem"}
                href={tenantPath(tenantSlug, item.href)}
                key={item.href}
                title={item.label}
              >
                <Icon size={21} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <LogoutButton />
      </aside>

      <section className="adminWorkspace">
        <header className="adminTopbar">
          <h1>{title}</h1>
          <div className="adminTopbarControls">
            <TenantSwitcher />
            {actions ? <div className="adminActions">{actions}</div> : null}
          </div>
        </header>
        {children}
      </section>
    </main>
  );
}
