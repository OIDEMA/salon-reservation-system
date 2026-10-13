"use client";

import type { ChartFormValues } from "./chart-types";

export function ChartFields({ values, onChange, disabled = false, readOnly = false, timezone = "Asia/Tokyo" }: {
  values: ChartFormValues;
  onChange: (key: keyof ChartFormValues, value: string) => void;
  disabled?: boolean;
  readOnly?: boolean;
  timezone?: string;
}) {
  const textFields: Array<{ key: keyof ChartFormValues; label: string }> = [
    { key: "performedServiceDetail", label: "実施した施術の詳細" },
    { key: "skinObservations", label: "脱毛・肌の状態" },
    { key: "productsMaterials", label: "使用した製品・材料" },
    { key: "aftercareNotes", label: "アフターケア・お伝えした内容" },
    { key: "nextVisitPlan", label: "次回来店の予定・引き継ぎ" }
  ];
  return (
    <fieldset className="masterCreateFields chartFields" disabled={disabled}>
      <label className="createField"><span>施術日時（{timezone === "Asia/Tokyo" ? "日本時間" : timezone}）</span><input readOnly={readOnly} required type="datetime-local" value={values.treatmentAt} onChange={(event) => onChange("treatmentAt", event.target.value)} /></label>
      <label className="createField"><span>施術部位（読点またはカンマ区切り）</span><input readOnly={readOnly} maxLength={2430} value={values.bodyParts} onChange={(event) => onChange("bodyParts", event.target.value)} /></label>
      <label className="createField masterFieldWide"><span>使用機器</span><input readOnly={readOnly} maxLength={200} value={values.machine} onChange={(event) => onChange("machine", event.target.value)} /></label>
      <label className="createField"><span>照射出力（J）</span><input readOnly={readOnly} maxLength={200} value={values.outputJ} onChange={(event) => onChange("outputJ", event.target.value)} /><small className="chartMuted">実施時の設定値を記録</small></label>
      <label className="createField"><span>パルス幅</span><input readOnly={readOnly} maxLength={200} value={values.pulseWidth} onChange={(event) => onChange("pulseWidth", event.target.value)} /><small className="chartMuted">実施時の設定値・単位を記録</small></label>
      {textFields.map(({ key, label }) => (
        <label key={key} className="createField masterFieldWide"><span>{label}</span><textarea readOnly={readOnly} rows={4} maxLength={key === "performedServiceDetail" ? 8000 : 4000} value={values[key]} onChange={(event) => onChange(key, event.target.value)} /></label>
      ))}
    </fieldset>
  );
}
