"use client";

import {
  BookUser,
  ClipboardList,
  CreditCard,
  Calculator,
  ShieldCheck,
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
import { useTenantSlug, usePermissions } from "@/components/tenant-provider";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { adminNavigation } from "@/lib/admin-navigation";
import { tenantPath } from "@/lib/tenant-routing";

const navigationIcons = { BookUser, ClipboardList, CreditCard, Calculator, ShieldCheck, CircleAlert, CalendarClock, CalendarDays, LayoutDashboard, Scissors, Search, Settings, Tags, Users, Wrench };

type AdminShellProps = {
  active: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
};

export function AdminSidebar({ active }: { active: string }) {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();

  return (
    <aside className="adminSidebar">
      <Link className="adminBrand" href={tenantPath(tenantSlug)} title="株式会社Beauty Gum">
        <Image src="/brand/beauty-gum-logo.webp" alt="株式会社Beauty Gum" width={400} height={100} />
      </Link>
      <nav className="adminNav" aria-label="admin navigation">
        {adminNavigation.filter((item) => can(item.permission)).map((item) => {
          const Icon = navigationIcons[item.icon];
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
  );
}

export function AdminShell({ active, title, actions, children }: AdminShellProps) {
  return (
    <main className="adminShell">
      <AdminSidebar active={active} />
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
