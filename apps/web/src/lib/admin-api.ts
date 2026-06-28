import { mockAdminCategories, mockAdminEquipment, mockAdminMenus, mockAdminSettings, mockAdminStaff } from "./admin-mock";
import type { AdminCategory, AdminEquipment, AdminMenu, AdminSettingsPayload, AdminStaff } from "./admin-types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4001";

async function fetchJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`${path} request failed: ${response.status}`);
    }

    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

export function fetchAdminSettings() {
  return fetchJson<AdminSettingsPayload>("/api/admin/settings", mockAdminSettings);
}

export function fetchAdminStaff() {
  return fetchJson<AdminStaff[]>("/api/admin/staff", mockAdminStaff);
}

export function fetchAdminMenus() {
  return fetchJson<AdminMenu[]>("/api/admin/menus", mockAdminMenus);
}

export function fetchAdminCategories() {
  return fetchJson<AdminCategory[]>("/api/admin/categories", mockAdminCategories);
}

export function fetchAdminEquipment() {
  return fetchJson<AdminEquipment[]>("/api/admin/equipment", mockAdminEquipment);
}
