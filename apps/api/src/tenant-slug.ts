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
