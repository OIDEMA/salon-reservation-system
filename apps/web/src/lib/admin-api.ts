import type { AdminCategory, AdminCustomer, AdminCustomerPage, AdminEquipment, AdminMenu, AdminSettingsPayload, AdminStaff, AdminStaffDetail } from "./admin-types";
import { redirect } from "next/navigation";
import { backendFetch, backendJson } from "./backend";

export function fetchAdminSettings() {
  return backendJson<AdminSettingsPayload>("/api/admin/settings");
}

export function fetchAdminStaff() {
  return backendJson<AdminStaff[]>("/api/admin/staff");
}

export async function fetchAdminStaffDetail(tenantSlug: string, staffId: string) {
  const response = await backendFetch(`/api/admin/staff/${encodeURIComponent(staffId)}`, undefined, tenantSlug);
  if (response.status === 404) return null;
  if (response.status === 403) redirect(`/${encodeURIComponent(tenantSlug)}/access-denied`);
  if (!response.ok) throw new Error(`Staff detail request failed: ${response.status}`);
  return await response.json() as AdminStaffDetail;
}

export function fetchAdminStaffNextSort() {
  return backendJson<{ sortOrder: number }>("/api/admin/staff/next-sort");
}

export function fetchAdminMenus() {
  return backendJson<AdminMenu[]>("/api/admin/menus");
}

export function fetchAdminCategories() {
  return backendJson<AdminCategory[]>("/api/admin/categories");
}

export function fetchAdminEquipment() {
  return backendJson<AdminEquipment[]>("/api/admin/equipment");
}

export function fetchAdminCustomers() {
  return backendJson<AdminCustomer[]>("/api/admin/customers");
}

export function fetchAdminCustomerPage() {
  return backendJson<AdminCustomerPage>("/api/admin/customers/page");
}

export function fetchReservationCatalog(tenantSlug?: string) {
  return backendJson<{ menus: AdminMenu[]; categories: AdminCategory[]; staff: AdminStaff[] }>("/api/reservation-catalog", undefined, tenantSlug);
}
