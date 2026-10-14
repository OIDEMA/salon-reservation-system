"use client";

import { usePermissions } from "./tenant-provider";

export type CustomerImportedProfile = {
  source: string; sourceStoreId: string; externalCustomerId: string;
  importedAt: string; capturedAt: string | null;
  customerNumber: string | null; gender: string | null; occupation: string | null;
  sourceVisitCount: number | null; sourceLastVisitDate: string | null; sourceLastVisitDateRaw: string | null;
  phone: string | null; phone2: string | null; email: string | null; mobileEmail: string | null;
  birthDate: string | null; address: string | null; postalCode: string | null;
  profile?: Record<string, string>;
};

export function CustomerSourceProfiles({ profiles }: { profiles?: CustomerImportedProfile[] }) {
  const { can } = usePermissions();
  if (!profiles?.length) return null;
  return <div>{profiles.map((source) => {
    const contacts: Array<[string, string | null]> = [
      ["お客様番号", source.customerNumber], ["電話番号2", source.phone2],
      ["メール（PC）", source.email], ["メール（携帯）", source.mobileEmail],
      ["誕生日", source.birthDate], ["性別", source.gender], ["職業", source.occupation],
      ["住所", source.address], ["郵便番号", source.postalCode]
    ];
    const notes = ["初回来店日", "来店きっかけ", "要注意チェック", "血液型", "お客様メモ", "その他1", "その他2", "その他3"];
    return <section key={`${source.sourceStoreId}:${source.externalCustomerId}`} className="karteBox">
      <div><h3>サロンボードから移行した情報</h3>
        <dl>{contacts.map(([label, value]) => value ? <div key={label}><dt>{label}</dt><dd>{value}</dd></div> : null)}
          {source.sourceVisitCount !== null ? <div><dt>移行前の来店回数</dt><dd>{source.sourceVisitCount}回</dd></div> : null}
          {source.sourceLastVisitDateRaw ? <div><dt>移行前の最終来店</dt><dd>{source.sourceLastVisitDateRaw}</dd></div> : null}
          {can("chart.read") ? notes.map((label) => source.profile?.[label] ? <div key={label}><dt>{label}</dt><dd style={{ whiteSpace: "pre-wrap" }}>{source.profile[label]}</dd></div> : null) : null}
        </dl>
      </div>
    </section>;
  })}</div>;
}
