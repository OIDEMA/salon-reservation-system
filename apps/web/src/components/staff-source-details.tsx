import type { AdminStaffDetail } from "@/lib/admin-types";

function ProfileValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return <span>未登録</span>;
  if (typeof value === "boolean") return <span>{value ? "はい" : "いいえ"}</span>;
  if (Array.isArray(value)) return <ul>{value.map((item, index) => <li key={index}><ProfileValue value={item} /></li>)}</ul>;
  if (typeof value === "object") return <dl>{Object.entries(value).map(([label, item]) => <div key={label}><dt>{label}</dt><dd><ProfileValue value={item} /></dd></div>)}</dl>;
  return <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{String(value)}</span>;
}
export function StaffSourceDetails({ records }: { records: AdminStaffDetail["sourceRecords"] }) {
  if (!records?.length) return null;
  return <section className="adminPanel masterCreatePanel">
    <h2>スタッフの詳細情報</h2>
    {records.map((record, index) => <details key={index}>
      <summary>詳細を見る</summary>
      <ProfileValue value={record.profile.sourceProfile} />
    </details>)}
  </section>;
}
