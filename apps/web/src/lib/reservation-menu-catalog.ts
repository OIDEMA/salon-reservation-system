import type { AdminCategory, AdminMenu } from "./admin-types";

export const ALL_RESERVATION_MENUS = "all";

export type ReservationMenuCategory = {
  id: string;
  label: string;
  categoryName: string | null;
};

export function reservationMenuCatalog(menus: AdminMenu[], categories: AdminCategory[]) {
  const orderedMenus = [...menus].sort((a, b) => a.sortOrder - b.sortOrder);
  const filters: ReservationMenuCategory[] = [{ id: ALL_RESERVATION_MENUS, label: "すべてのメニュー", categoryName: null }];
  const names = new Set<string>();
  for (const category of [...categories].filter((item) => item.type === "MENU").sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (names.has(category.name)) continue;
    names.add(category.name);
    filters.push({ id: `master:${category.id}`, label: category.name || "未分類", categoryName: category.name });
  }
  for (const menu of orderedMenus) {
    if (names.has(menu.category)) continue;
    names.add(menu.category);
    filters.push({ id: `fallback:${menu.category}`, label: menu.category || "未分類", categoryName: menu.category });
  }
  return { menus: orderedMenus, categories: filters };
}

function normalizedSearch(value: string) {
  return value.normalize("NFKC").toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60));
}

export function filterReservationMenus(catalog: ReturnType<typeof reservationMenuCatalog>, categoryId: string, search: string) {
  const category = catalog.categories.find((item) => item.id === categoryId);
  if (!category) return [];
  const terms = normalizedSearch(search).split(/\s+/).filter(Boolean);
  return catalog.menus.filter((menu) => {
    if (category.categoryName !== null && menu.category !== category.categoryName) return false;
    const text = normalizedSearch(`${menu.name} ${menu.category}`);
    return terms.every((term) => text.includes(term));
  });
}
