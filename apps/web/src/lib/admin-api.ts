import type { AdminCategory, AdminCustomer, AdminEquipment, AdminMenu, AdminSettingsPayload, AdminStaff } from "./admin-types";
import { backendJson } from "./backend";

export function fetchAdminSettings() {
  return backendJson<AdminSettingsPayload>("/api/admin/settings");
}

export function fetchAdminStaff() {
  return backendJson<AdminStaff[]>("/api/admin/staff");
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
