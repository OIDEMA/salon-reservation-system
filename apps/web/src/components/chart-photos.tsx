"use client";

import { useId, useRef, useState } from "react";
import { useTenantSlug } from "./tenant-provider";
import { chartDate, chartPhotoMetadata, type ChartPhoto, type ChartPhotoMetadata } from "./chart-types";
import { tenantApiPath } from "@/lib/tenant-routing";

function photoLabel(photo: ChartPhoto) {
  return `${photo.phase === "BEFORE" ? "施術前" : "施術後"}${photo.bodyPart ? ` · ${photo.bodyPart}` : ""}`;
}

function PhotoCaption({ photo, timezone }: { photo: ChartPhoto; timezone: string }) {
  return <>
    {photo.bodyPart ? <strong>{photo.bodyPart}</strong> : null}
    <span>{photo.capturedAt ? "撮影" : "登録"}：{chartDate(photo.capturedAt ?? photo.createdAt, timezone)}</span>
    {photo.note ? <p className="chartPhotoNote">{photo.note}</p> : null}
  </>;
}

export function ChartPhotoGallery({ chartId, photos, timezone, onDelete, disabled = false }: {
  chartId: string; photos: ChartPhoto[]; timezone: string;
  onDelete?: (photoId: string) => void; disabled?: boolean;
}) {
  const tenantSlug = useTenantSlug();
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<ChartPhoto | null>(null);
  const [expandedFailed, setExpandedFailed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const photoUrl = (photoId: string) => tenantApiPath(tenantSlug, `/charts/${encodeURIComponent(chartId)}/photos/${encodeURIComponent(photoId)}`);

  function openPhoto(photo: ChartPhoto) {
    setExpanded(photo); setExpandedFailed(false); dialog.current?.showModal();
  }

  function closePhoto() { dialog.current?.close(); }

  return <>
    <div className="chartPhotoGroups">{(["BEFORE", "AFTER"] as const).map((phase) => {
      const group = photos.filter((photo) => photo.phase === phase);
      return <section className="chartPhotoGroup" key={phase}><h4>{phase === "BEFORE" ? "施術前" : "施術後"}</h4>
        {group.length ? <div className="chartPhotos">{group.map((photo, index) => <figure className="chartPhoto" key={photo.id}>
          {failed[photo.id] ? <div className="chartPhotoError"><p role="status">写真を読み込めませんでした。</p><button type="button" className="secondaryButton" onClick={() => setFailed((current) => ({ ...current, [photo.id]: false }))}>再読み込み</button></div> : <button type="button" className="chartPhotoPreview" onClick={() => openPhoto(photo)} aria-label={`${photoLabel(photo)}の記録写真 ${index + 1} を拡大`}>
            <img src={photoUrl(photo.id)} alt={`${photoLabel(photo)}の記録写真 ${index + 1}`} width={photo.width} height={photo.height} loading="lazy" onError={() => setFailed((current) => ({ ...current, [photo.id]: true }))} />
            <span>写真を拡大</span>
          </button>}
          <figcaption><PhotoCaption photo={photo} timezone={timezone} /></figcaption>
          {onDelete ? <button type="button" className="secondaryButton" disabled={disabled} onClick={() => onDelete(photo.id)} aria-label={`${photoLabel(photo)}の記録写真 ${index + 1} を削除`}>削除</button> : null}
        </figure>)}</div> : <p className="chartMuted">写真はありません。</p>}
      </section>;
    })}</div>
    <dialog ref={dialog} className="chartPhotoDialog" aria-labelledby={titleId} onClose={() => { setExpanded(null); setExpandedFailed(false); }} onClick={(event) => { if (event.target === event.currentTarget) closePhoto(); }}>
      <div className="chartPhotoDialogContent">
        <div className="chartPhotoDialogHeader"><h3 id={titleId}>{expanded ? photoLabel(expanded) : "記録写真"}</h3><button type="button" className="secondaryButton" autoFocus onClick={closePhoto}>閉じる</button></div>
        {expanded ? <>
          {expandedFailed ? <div className="chartPhotoError"><p role="alert">写真を読み込めませんでした。ログイン状態と通信環境をご確認ください。</p><button type="button" className="secondaryButton" onClick={() => setExpandedFailed(false)}>再読み込み</button></div> : <img className="chartPhotoExpanded" src={photoUrl(expanded.id)} alt={`${photoLabel(expanded)}の記録写真`} width={expanded.width} height={expanded.height} onError={() => setExpandedFailed(true)} />}
          <div className="chartPhotoDialogCaption"><PhotoCaption photo={expanded} timezone={timezone} /></div>
        </> : null}
      </div>
    </dialog>
  </>;
}

export function ChartPhotoUpload({ disabled, photoCount, timezone, onUpload }: {
  disabled: boolean; photoCount: number; timezone: string;
  onUpload: (file: File, phase: ChartPhoto["phase"], metadata: ChartPhotoMetadata) => Promise<boolean>;
}) {
  const [phase, setPhase] = useState<ChartPhoto["phase"]>("BEFORE");
  const [bodyPart, setBodyPart] = useState("");
  const [note, setNote] = useState("");
  const [capturedAt, setCapturedAt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const input = useRef<HTMLInputElement>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !file || photoCount >= 10) return;
    setMessage("");
    try {
      const metadata = chartPhotoMetadata({ bodyPart, note, capturedAt }, timezone);
      if (await onUpload(file, phase, metadata)) {
        setFile(null); setNote("");
        if (input.current) input.current.value = "";
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "写真の内容をご確認ください。"); }
  }

  return <form onSubmit={save}>
    <fieldset className="chartUpload" disabled={disabled || photoCount >= 10}>
      <legend>記録写真を追加</legend>
      <label className="createField"><span>撮影時点</span><select value={phase} onChange={(event) => setPhase(event.target.value as ChartPhoto["phase"])}><option value="BEFORE">施術前</option><option value="AFTER">施術後</option></select></label>
      <label className="createField"><span>撮影部位（任意）</span><input maxLength={120} value={bodyPart} placeholder="例：あご、両わき、ひざ下" onChange={(event) => setBodyPart(event.target.value)} /></label>
      <label className="createField"><span>撮影日時（{timezone === "Asia/Tokyo" ? "日本時間" : timezone}・任意）</span><input type="datetime-local" value={capturedAt} onChange={(event) => setCapturedAt(event.target.value)} /></label>
      <label className="createField"><span>写真</span><input ref={input} type="file" required accept="image/jpeg,image/png,image/webp" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setMessage(""); }} /></label>
      <label className="createField chartUploadWide"><span>脱毛の状態・気づいた点（任意）</span><textarea rows={3} maxLength={1000} value={note} placeholder="毛量、毛の太さ、肌の赤みなど" onChange={(event) => setNote(event.target.value)} /></label>
      <small className="chartMuted">JPEG・PNG・WebP／1枚5 MB以下／10枚まで（現在{photoCount}枚）</small>
      {message ? <p className="formMessage error chartUploadWide" role="alert">{message}</p> : null}
      <div className="chartUploadActions"><button type="submit" className="primaryButton" disabled={disabled || !file || photoCount >= 10}>写真を保存</button></div>
    </fieldset>
  </form>;
}
