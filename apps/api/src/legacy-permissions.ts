import type { Permission } from "./permissions.js";

/** Existing routes use the same permission checks as the operations modules. */
export function legacyPermission(method: string, route: string): Permission | null {
  const write = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (route === "/api/dashboard" || route.startsWith("/api/reservations")) return write ? "reservation.write" : "reservation.read";
  if (route.startsWith("/api/admin/customers")) return write ? "customer.write" : "customer.read";
  if (route.startsWith("/api/admin/settings")) return write ? "settings.write" : "settings.read";
  if (route.startsWith("/api/admin/shifts")) return write ? "reservation.write" : "reservation.read";
  if (/^\/api\/admin\/(staff|menus|categories|equipment)(\/|$)/.test(route)) return write ? "master.write" : "master.read";
  if (route === "/api/staff" || route === "/api/services") return "reservation.read";
  return null;
}
