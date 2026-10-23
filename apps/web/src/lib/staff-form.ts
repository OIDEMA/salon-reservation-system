import type { MasterColumn, MasterField } from "@/components/master-data-manager";

export function staffCommentForForm(comment: string | null) {
  // Normalize only the old system-generated note; preserve staff-entered comments.
  return comment === "サロンボードの過去予約から移行した担当（予約受付停止）。元情報は担当名の記録です。"
    ? "予約履歴の担当名を記録したスタッフです（予約受付停止）。"
    : comment;
}

export const staffFields: MasterField[] = [
  { key: "name", label: "スタッフ名", required: true, maxLength: 100 },
  { key: "kana", label: "カナ", maxLength: 100 },
  { key: "role", label: "役割", type: "select", options: [
    { value: "MANAGER", label: "管理者" }, { value: "STYLIST", label: "施術スタッフ" },
    { value: "ESTHETICIAN", label: "エステ" }, { value: "ASSISTANT", label: "補助" }, { value: "ROOM_RESOURCE", label: "設備枠" }
  ] },
  { key: "color", label: "予約表カラー", type: "color" },
  { key: "nominationFee", label: "指名料", type: "number", required: true, min: 0, max: 10_000_000 },
  { key: "allocationOrder", label: "自動割当順", type: "number", required: true, min: 1 },
  { key: "parallelCapacity", label: "同時対応数", type: "number", required: true, min: 1, max: 20 },
  { key: "active", label: "有効", type: "checkbox" },
  { key: "comment", label: "コメント", type: "textarea", maxLength: 1000 }
];

export const staffColumns: MasterColumn[] = [
  { key: "name", label: "スタッフ名" }, { key: "role", label: "役割" }, { key: "nominationFee", label: "指名料", format: "currency" },
  { key: "allocationOrder", label: "割当順" }, { key: "parallelCapacity", label: "同時対応" }, { key: "active", label: "状態", format: "boolean" }
];

export function staffDefaults(count: number) {
  return { name: "", kana: "", role: "STYLIST", color: "#18c7bd", nominationFee: 0, comment: "", allocationOrder: 1, parallelCapacity: 1, active: true, sortOrder: count };
}
