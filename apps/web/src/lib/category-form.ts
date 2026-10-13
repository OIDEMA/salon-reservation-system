import type { MasterColumn, MasterField } from "@/components/master-data-manager";

export const categoryFields: MasterField[] = [
  { key: "name", label: "カテゴリー名", required: true, maxLength: 100 },
  { key: "type", label: "種別", type: "select", options: [
    { value: "MENU", label: "メニュー" }, { value: "OPTION", label: "オプション" }
  ] },
  { key: "enabled", label: "有効", type: "checkbox" },
  { key: "sortOrder", label: "表示順", type: "number", required: true },
  { key: "description", label: "説明", type: "textarea", maxLength: 1000 }
];

export const categoryColumns: MasterColumn[] = [
  { key: "name", label: "カテゴリー名" }, { key: "type", label: "種別" },
  { key: "description", label: "説明" }, { key: "enabled", label: "状態", format: "boolean" },
  { key: "sortOrder", label: "表示順" }
];

export function categoryDefaults(count: number) {
  return { name: "", type: "MENU", description: "", enabled: true, sortOrder: count };
}
