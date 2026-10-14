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
    <h2>移行元のスタッフ情報</h2>
    <p>サロンボードから取得した設定です。現在の予約設定とは別に保存しています。</p>
    {records.map((record, index) => <details key={index}>
      <summary>サロンボードの元情報</summary>
      <ProfileValue value={record.profile.sourceProfile} />
      <p>{record.profile.unconfirmedDefaults && typeof record.profile.unconfirmedDefaults === "object" && "nominationFee" in record.profile.unconfirmedDefaults ? "指名料と予約表カラーは" : "予約表カラーは"}移行元で確認できていないため、初期値を設定しています。</p>
    </details>)}
  </section>;
}
