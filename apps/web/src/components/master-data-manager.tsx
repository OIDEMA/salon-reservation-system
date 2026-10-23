"use client";

import { Edit3, Plus, Save, Search, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { MasterPage, MasterResource } from "@/lib/master-page-types";
import { DismissibleMessage } from "@/components/dismissible-message";
import { TenantLink } from "@/components/tenant-link";
import { useTenantSlug, usePermissions } from "@/components/tenant-provider";
import { tenantApiPath, tenantPath } from "@/lib/tenant-routing";
import { equipmentMemoForDisplay } from "@/lib/equipment-form";

export type MasterField = {
  key: string;
  label: string;
  type?: "text" | "number" | "textarea" | "color" | "checkbox" | "select";
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
};

export type MasterColumn = {
  key: string;
  label: string;
  format?: "currency" | "boolean" | "color";
};

type MasterItem = { id: string };
type ItemRecord = Record<string, unknown>;

function record(item: MasterItem) {
  return item as unknown as ItemRecord;
}

function formatted(value: unknown, format?: MasterColumn["format"]) {
  if (format === "currency") return `${Number(value ?? 0).toLocaleString("ja-JP")}円`;
  if (format === "boolean") return value ? "有効" : "無効";
  return String(value ?? "");
}

async function responseError(response: Response) {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? `処理に失敗しました (${response.status})`;
}

function MasterFields({ fields, form, onChange }: {
  fields: MasterField[];
  form: ItemRecord;
  onChange: (key: string, value: unknown) => void;
}) {
  return fields.map((field) => {
    const value = form[field.key];
    if (field.type === "checkbox") return <label className="checkboxField" key={field.key}><input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(field.key, event.target.checked)} /><span>{field.label}</span></label>;
    if (field.type === "textarea") return <label className="createField masterFieldWide" key={field.key}><span>{field.label}</span><textarea rows={6} maxLength={field.maxLength} value={String(value ?? "")} onChange={(event) => onChange(field.key, event.target.value)} /></label>;
    if (field.type === "select") return <label className="createField" key={field.key}><span>{field.label}</span><select required={field.required} value={String(value ?? "")} onChange={(event) => onChange(field.key, event.target.value)}>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
    if (field.type === "color") return <label className="createField" key={field.key}><span>{field.label}</span><span className="colorValue"><input className="masterColorPicker" aria-label={field.label} required={field.required} type="color" value={String(value ?? "")} onChange={(event) => onChange(field.key, event.target.value)} /><span className="colorCode" aria-hidden="true">{String(value ?? "")}</span></span></label>;
    return <label className="createField" key={field.key}><span>{field.label}</span><input required={field.required} min={field.min} max={field.max} maxLength={field.maxLength} type={field.type ?? "text"} value={String(value ?? "")} onChange={(event) => onChange(field.key, field.type === "number" ? event.target.value === "" && field.required ? "" : Number(event.target.value) : event.target.value)} /></label>;
  });
}

type MasterDataFormProps = {
  resource: "staff" | "menus" | "categories" | "equipment";
  fields: MasterField[];
  initialValues: ItemRecord;
  itemId?: string;
  itemLabel: string;
  returnHref: string;
};

function MasterDataForm({ resource, fields, initialValues, itemId, itemLabel, returnHref }: MasterDataFormProps) {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  const canWrite = can("master.write");
  const router = useRouter();
  const [form, setForm] = useState<ItemRecord>(initialValues);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const payload = itemId
        ? Object.fromEntries(fields.map((field) => [field.key, form[field.key] ?? ""]))
        : form;
      const path = itemId ? `/admin/${resource}/${encodeURIComponent(itemId)}` : `/admin/${resource}`;
      const response = await fetch(tenantApiPath(tenantSlug, path), {
        method: itemId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(await responseError(response));
      router.push(tenantPath(tenantSlug, returnHref));
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${itemLabel}を保存できませんでした。`);
      setBusy(false);
    }
  }

  return (
    <form className="masterCreateForm" onSubmit={save}>
      {message ? <DismissibleMessage message={message} onDismiss={() => setMessage("")} role="alert" /> : null}
      <fieldset className="masterCreateFields" disabled={!canWrite || busy}>
        <MasterFields fields={fields} form={form} onChange={(key, value) => setForm((current) => ({ ...current, [key]: value }))} />
      </fieldset>
      <div className="masterCreateActions">
        <TenantLink className="secondaryButton" href={returnHref} aria-disabled={busy} onClick={(event) => { if (busy) event.preventDefault(); }}>{canWrite ? "キャンセル" : "一覧に戻る"}</TenantLink>
        {canWrite ? <button className="primaryButton" disabled={busy} type="submit"><Save size={17} />{busy ? "保存中..." : "保存"}</button> : null}
      </div>
    </form>
  );
}

export function MasterDataCreateForm({ defaults, ...props }: Omit<MasterDataFormProps, "initialValues" | "itemId"> & { defaults: ItemRecord }) {
  return <MasterDataForm {...props} initialValues={defaults} />;
}

export function MasterDataEditForm(props: MasterDataFormProps & { itemId: string }) {
  return <MasterDataForm key={props.itemId} {...props} />;
}

export function MasterDataManager({ resource, initialPage, columns, itemLabel, createHref, editBaseHref,
  searchPlaceholder = "キーワードで検索", typeOptions
}: {
  resource: MasterResource;
  initialPage: MasterPage;
  columns: MasterColumn[];
  itemLabel: string;
  createHref: string;
  editBaseHref: string;
  searchPlaceholder?: string;
  typeOptions?: Array<{ value: string; label: string }>;
}) {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  const canWrite = can("master.write");
  const [result, setResult] = useState(initialPage);
  const [requestedPage, setRequestedPage] = useState(initialPage.page);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [listBusy, setListBusy] = useState(false);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const requestSequence = useRef(0);
  const initialRequest = useRef(true);
  const hasFilters = Boolean(query.trim() || status || type);

  useEffect(() => {
    // SSR already obtained the first bounded page. Subsequent interactions use
    // the same endpoint, without fetching the entire booking catalog again.
    if (initialRequest.current) { initialRequest.current = false; return; }
    const sequence = ++requestSequence.current;
    const controller = new AbortController();
    setListBusy(true);
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ page: String(requestedPage), pageSize: String(initialPage.pageSize) });
        if (query.trim()) params.set("q", query.trim());
        if (status) params.set("status", status);
        if (type) params.set("type", type);
        const response = await fetch(tenantApiPath(tenantSlug, `/admin/${resource}/page?${params}`), {
          cache: "no-store", signal: controller.signal
        });
        if (!response.ok) throw new Error(await responseError(response));
        const nextPage = await response.json() as MasterPage;
        if (controller.signal.aborted || sequence !== requestSequence.current) return;
        setResult(nextPage);
        setRequestedPage(nextPage.page);
      } catch (error) {
        if (!controller.signal.aborted && sequence === requestSequence.current) {
          setMessage(error instanceof Error ? error.message : `${itemLabel}一覧を取得できませんでした。`);
        }
      } finally {
        if (!controller.signal.aborted && sequence === requestSequence.current) setListBusy(false);
      }
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, status, type, requestedPage, resource, tenantSlug, initialPage.pageSize, itemLabel, refreshSequence]);

  async function remove(item: MasterItem) {
    if (!canWrite || busy || listBusy) return;
    const name = String(record(item).name ?? itemLabel);
    if (!window.confirm(`${name}を削除しますか？ 予約履歴がある項目は無効化されます。`)) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(tenantApiPath(tenantSlug, `/admin/${resource}/${encodeURIComponent(item.id)}`), { method: "DELETE" });
      if (!response.ok) throw new Error(await responseError(response));
      const removed = await response.json() as { deactivated?: boolean };
      setRefreshSequence((current) => current + 1);
      setMessage(removed.deactivated ? `${itemLabel}を無効化しました。` : `${itemLabel}を削除しました。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${itemLabel}を削除できませんでした。`);
    } finally {
      setBusy(false);
    }
  }

  return <div className="masterManager">
    <div className="masterToolbar hasSearch">
      <div className="masterToolbarSummary">
        <div className="searchBox masterSearch">
          <Search size={18} aria-hidden="true" />
          <input type="search" aria-label={`${itemLabel}を検索`} maxLength={100} placeholder={searchPlaceholder} value={query}
            onChange={(event) => { setQuery(event.target.value); setRequestedPage(1); }} />
          {query ? <button className="masterSearchClear" type="button" aria-label="検索をクリア" onClick={() => { setQuery(""); setRequestedPage(1); }}><X size={16} aria-hidden="true" /></button> : null}
        </div>
        <label className="createField"><select aria-label="状態で絞り込み" value={status}
          onChange={(event) => { setStatus(event.target.value); setRequestedPage(1); }}>
          <option value="">すべての状態</option><option value="ACTIVE">有効</option><option value="INACTIVE">無効</option>
        </select></label>
        {typeOptions ? <label className="createField"><select aria-label="種別で絞り込み" value={type}
          onChange={(event) => { setType(event.target.value); setRequestedPage(1); }}>
          <option value="">すべての種別</option>{typeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label> : null}
      </div>
      {canWrite ? <TenantLink className="primaryButton" href={createHref}><Plus size={17} />{itemLabel}を新規登録</TenantLink> : null}
    </div>
    {message ? <DismissibleMessage message={message} onDismiss={() => setMessage("")} /> : null}
    <nav className="masterToolbar" aria-label={`${itemLabel}一覧のページ`}>
      <span aria-live="polite">{listBusy ? "検索中..." : `${result.page} / ${result.totalPages}ページ`}</span>
      <div className="adminActions">
        <button className="secondaryButton" type="button" disabled={listBusy || busy || result.page <= 1} onClick={() => setRequestedPage(result.page - 1)}>前へ</button>
        <button className="secondaryButton" type="button" disabled={listBusy || busy || result.page >= result.totalPages} onClick={() => setRequestedPage(result.page + 1)}>次へ</button>
      </div>
    </nav>
    <section className="tablePanel" aria-busy={listBusy}>
      <table className="adminTable">
        <thead><tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}{canWrite ? <th>操作</th> : null}</tr></thead>
        <tbody>
          {!listBusy && result.items.length === 0 ? <tr><td colSpan={columns.length + (canWrite ? 1 : 0)}><div className="emptyState">{hasFilters ? `検索に一致する${itemLabel}がありません。` : `${itemLabel}はまだ登録されていません。`}</div></td></tr> : null}
          {result.items.map((item) => <tr key={item.id}>
            {columns.map((column) => {
              const value = resource === "equipment" && column.key === "memo"
                ? equipmentMemoForDisplay(item[column.key])
                : item[column.key];
              return <td key={column.key}>{column.format === "color" ? <span className="colorValue"><span className="menuColor" aria-hidden="true" style={{ background: String(value) }} /><span className="colorCode">{String(value)}</span></span> : formatted(value, column.format)}</td>;
            })}
            {canWrite ? <td><div className="tableActions"><TenantLink className="miniButton" href={`${editBaseHref}/${encodeURIComponent(item.id)}/edit`}><Edit3 size={15} />編集</TenantLink><button className="dangerButton" disabled={busy || listBusy} type="button" onClick={() => void remove(item)}><Trash2 size={15} /></button></div></td> : null}
          </tr>)}
        </tbody>
      </table>
    </section>
  </div>;
}
