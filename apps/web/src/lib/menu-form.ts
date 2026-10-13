import type { MasterColumn, MasterField } from "@/components/master-data-manager";

export const menuFields: MasterField[] = [
  { key: "name", label: "メニュー名", required: true, maxLength: 160 },
  { key: "category", label: "カテゴリー", required: true, maxLength: 100 },
  { key: "durationMinutes", label: "所要時間（分）", type: "number", required: true, min: 5, max: 1440 },
  { key: "price", label: "価格", type: "number", required: true, min: 0, max: 100_000_000 },
  { key: "color", label: "予約表カラー", type: "color" },
  { key: "menuType", label: "メニュー種別", maxLength: 100 },
  { key: "unlimitedBooking", label: "受付数制限なし", type: "checkbox" },
  { key: "active", label: "有効", type: "checkbox" },
  { key: "description", label: "説明", type: "textarea", maxLength: 4000 }
];

export const menuColumns: MasterColumn[] = [
  { key: "name", label: "メニュー名" }, { key: "category", label: "カテゴリー" }, { key: "durationMinutes", label: "時間" },
  { key: "price", label: "価格", format: "currency" }, { key: "color", label: "カラー", format: "color" }, { key: "active", label: "状態", format: "boolean" }
];

export function menuDefaults(count: number) {
  return { name: "", category: "通常", description: "", durationMinutes: 60, price: 0, color: "#18c7bd", menuType: "通常メニュー", lineVisible: false, unlimitedBooking: true, active: true, sortOrder: count };
}
