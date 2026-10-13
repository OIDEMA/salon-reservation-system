import assert from "node:assert/strict";
import test from "node:test";
import { ALL_RESERVATION_MENUS, filterReservationMenus, reservationMenuCatalog } from "./reservation-menu-catalog";
import type { AdminCategory, AdminMenu } from "./admin-types";

function menu(id: string, category: string, sortOrder: number, active = true, name = id): AdminMenu {
  return { id, category, sortOrder, active, name, imageUrl: null, description: "", durationMinutes: 60, price: 5000, color: "#fff", menuType: "SERVICE", lineVisible: true, unlimitedBooking: false };
}

function category(id: string, name: string, sortOrder: number, enabled = true, type = "MENU"): AdminCategory {
  return { id, name, sortOrder, enabled, type, description: "", imageUrl: null };
}

test("46件のうち無効43件もマスタ順で探せて、予約可能な3件だけに絞られない", () => {
  const menus = Array.from({ length: 46 }, (_, index) => menu(`menu-${index}`, index < 43 ? "脱毛" : "痩身", 46 - index, index >= 43));
  const catalog = reservationMenuCatalog(menus, [category("hair", "脱毛", 1), category("body", "痩身", 2)]);
  assert.equal(catalog.menus.length, 46);
  assert.equal(catalog.menus.filter((item) => item.active).length, 3);
  assert.equal(catalog.menus[0].id, "menu-45");
  assert.equal(filterReservationMenus(catalog, "master:hair", "").length, 43);
  assert.ok(filterReservationMenus(catalog, "master:hair", "").every((item) => !item.active));
  assert.equal(filterReservationMenus(catalog, ALL_RESERVATION_MENUS, "").length, 46);
});

test("MENUカテゴリの登録順と無効・空カテゴリを保ち、メニューだけに残るカテゴリは末尾に足す", () => {
  const catalog = reservationMenuCatalog([
    menu("legacy-b", "旧カテゴリB", 20), menu("legacy-a", "旧カテゴリA", 10), menu("registered", "脱毛", 5)
  ], [category("empty", "未使用カテゴリ", 30), category("option", "オプション", 0, true, "OPTION"), category("hair", "脱毛", 10, false)]);
  assert.deepEqual(catalog.categories.map((item) => item.label), ["すべてのメニュー", "脱毛", "未使用カテゴリ", "旧カテゴリA", "旧カテゴリB"]);
  assert.deepEqual(filterReservationMenus(catalog, "master:empty", ""), []);
  assert.deepEqual(filterReservationMenus(catalog, "master:hair", "").map((item) => item.id), ["registered"]);
  assert.deepEqual(filterReservationMenus(catalog, "fallback:旧カテゴリA", "").map((item) => item.id), ["legacy-a"]);
});

test("『すべて』というマスタ名と全件フィルタを区別し、削除されたカテゴリで全件を誤表示しない", () => {
  const catalog = reservationMenuCatalog([menu("all-name", "すべて", 1), menu("hair", "脱毛", 2)], [category("all", "すべて", 1), category("duplicate-name", "すべて", 2)]);
  assert.equal(catalog.categories.filter((item) => item.categoryName === "すべて").length, 1);
  assert.deepEqual(filterReservationMenus(catalog, "master:all", "").map((item) => item.id), ["all-name"]);
  assert.equal(filterReservationMenus(catalog, ALL_RESERVATION_MENUS, "").length, 2);
  assert.deepEqual(filterReservationMenus(catalog, "master:deleted", ""), []);
});

test("名称とカテゴリを横断し、かな・カナ・全半角・複数語を扱って無効メニューも検索する", () => {
  const catalog = reservationMenuCatalog([
    menu("face", "脱毛", 10, false, "【初回】フェイシャル Aコース"),
    menu("body", "痩身", 20, true, "ボディ Aコース")
  ], [category("hair", "脱毛", 10), category("body", "痩身", 20)]);
  assert.deepEqual(filterReservationMenus(catalog, ALL_RESERVATION_MENUS, "ﾌｪｲｼｬﾙ　ａ　脱毛").map((item) => item.id), ["face"]);
  assert.deepEqual(filterReservationMenus(catalog, ALL_RESERVATION_MENUS, "ふぇいしゃる").map((item) => item.id), ["face"]);
  assert.deepEqual(filterReservationMenus(catalog, "master:body", "ふぇいしゃる"), []);
});
