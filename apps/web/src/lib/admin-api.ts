import type { AdminCategory, AdminEquipment, AdminMenu, AdminSettingsPayload, AdminStaff } from "./admin-types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4001";

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`${path} request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export function fetchAdminSettings() {
  return fetchJson<AdminSettingsPayload>("/api/admin/settings");
}

export function fetchAdminStaff() {
  return fetchJson<AdminStaff[]>("/api/admin/staff");
}

export function fetchAdminMenus() {
  return fetchJson<AdminMenu[]>("/api/admin/menus");
}

export function fetchAdminCategories() {
  return fetchJson<AdminCategory[]>("/api/admin/categories");
}

export function fetchAdminEquipment() {
  return fetchJson<AdminEquipment[]>("/api/admin/equipment");
}
