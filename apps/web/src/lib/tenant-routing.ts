export const TENANT_SLUG_HEADER = "x-tenant-slug";

const tenantSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const reservedTenantSlugs = new Set([
  "admin",
  "api",
  "brand",
  "calendar",
  "categories",
  "confirmation",
  "customers",
  "equipment",
  "favicon.ico",
  "login",
  "menus",
  "reservations",
  "select-tenant",
  "settings",
  "staff",
  "www"
]);

export function isTenantSlug(value: string) {
  return value.length >= 3 && value.length <= 50 && tenantSlugPattern.test(value) && !reservedTenantSlugs.has(value);
}

export function tenantPath(tenantSlug: string, path = "/") {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `/${encodeURIComponent(tenantSlug)}${suffix === "/" ? "" : suffix}`;
}

export function tenantApiPath(tenantSlug: string, path: string) {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `/api/${encodeURIComponent(tenantSlug)}/backend${suffix}`;
}
