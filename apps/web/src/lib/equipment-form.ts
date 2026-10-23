import type { MasterColumn, MasterField } from "@/components/master-data-manager";

export function equipmentMemoForDisplay(memo: unknown) {
  // Hide only the old system-generated note; preserve user-entered equipment notes.
  return memo === "サロンボード H000551123 の設備設定から移行。元の同時受付数・振り分け順を保持。" ? "" : memo;
}

export const equipmentFields: MasterField[] = [
  { key: "name", label: "設備名", required: true, maxLength: 120 },
  { key: "capacity", label: "同時利用数", type: "number", required: true, min: 1, max: 100 },
  { key: "allocationOrder", label: "割当順", type: "number", required: true, min: 1 },
  { key: "color", label: "予約表カラー", type: "color" },
  { key: "active", label: "有効", type: "checkbox" },
  { key: "memo", label: "メモ", type: "textarea", maxLength: 1000 }
];

export const equipmentColumns: MasterColumn[] = [
  { key: "name", label: "設備名" }, { key: "capacity", label: "同時利用数" },
  { key: "allocationOrder", label: "割当順" }, { key: "color", label: "カラー", format: "color" },
  { key: "memo", label: "メモ" }, { key: "active", label: "状態", format: "boolean" }
];

export function equipmentDefaults(count: number) {
  return { name: "", capacity: 1, allocationOrder: 1, color: "#18c7bd", memo: "", active: true, sortOrder: count };
}
