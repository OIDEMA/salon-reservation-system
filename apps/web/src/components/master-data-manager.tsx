"use client";

import { Edit3, Plus, Save, Search, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DismissibleMessage } from "@/components/dismissible-message";
import { TenantLink } from "@/components/tenant-link";
import { useTenantSlug } from "@/components/tenant-provider";
import { tenantApiPath, tenantPath } from "@/lib/tenant-routing";

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

function normalizeSearch(value: unknown) {
  return String(value ?? "").normalize("NFKC").toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60));
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
  const router = useRouter();
  const [form, setForm] = useState<ItemRecord>(initialValues);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
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
      <fieldset className="masterCreateFields" disabled={busy}>
        <MasterFields fields={fields} form={form} onChange={(key, value) => setForm((current) => ({ ...current, [key]: value }))} />
      </fieldset>
      <div className="masterCreateActions">
        <TenantLink className="secondaryButton" href={returnHref} aria-disabled={busy} onClick={(event) => { if (busy) event.preventDefault(); }}>キャンセル</TenantLink>
        <button className="primaryButton" disabled={busy} type="submit"><Save size={17} />{busy ? "保存中..." : "保存"}</button>
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

export function MasterDataManager({
  resource,
  initialItems,
  fields,
  columns,
  defaults,
  itemLabel,
  createHref,
  editBaseHref,
  searchKeys,
  searchPlaceholder = "キーワードで検索"
}: {
  resource: "staff" | "menus" | "categories" | "equipment";
  initialItems: MasterItem[];
  fields: MasterField[];
  columns: MasterColumn[];
  defaults: ItemRecord;
  itemLabel: string;
  createHref?: string;
  editBaseHref?: string;
  searchKeys?: string[];
  searchPlaceholder?: string;
}) {
  const tenantSlug = useTenantSlug();
  const [items, setItems] = useState(initialItems);
  const [editing, setEditing] = useState<MasterItem | "new" | null>(null);
  const [form, setForm] = useState<ItemRecord>(defaults);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const searchEnabled = Boolean(searchKeys?.length);
  const searchTerms = normalizeSearch(query).trim().split(/\s+/).filter(Boolean);
  const filteredItems = searchEnabled && searchTerms.length > 0
    ? items.filter((item) => {
      const text = normalizeSearch(searchKeys!.map((key) => record(item)[key] ?? "").join(" "));
      return searchTerms.every((term) => text.includes(term));
    })
    : items;

  function startNew() {
    setForm(defaults);
    setEditing("new");
    setMessage("");
  }

  function startEdit(item: MasterItem) {
    setForm({ ...record(item) });
    setEditing(item);
    setMessage("");
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const isNew = editing === "new";
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(tenantApiPath(tenantSlug, isNew ? `/admin/${resource}` : `/admin/${resource}/${editing.id}`), {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });
      if (!response.ok) throw new Error(await responseError(response));
      const saved = (await response.json()) as MasterItem;
      setItems((current) => isNew ? [...current, saved] : current.map((item) => item.id === saved.id ? saved : item));
      setEditing(null);
      setMessage(`${itemLabel}を保存しました。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${itemLabel}を保存できませんでした。`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: MasterItem) {
    const name = String(record(item).name ?? itemLabel);
    if (!window.confirm(`${name}を削除しますか？ 予約履歴がある項目は無効化されます。`)) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(tenantApiPath(tenantSlug, `/admin/${resource}/${item.id}`), { method: "DELETE" });
      if (!response.ok) throw new Error(await responseError(response));
      const result = (await response.json()) as { deleted?: boolean; deactivated?: boolean };
      if (result.deleted) setItems((current) => current.filter((currentItem) => currentItem.id !== item.id));
      else if (result.deactivated) setItems((current) => current.map((currentItem) => currentItem.id === item.id ? { ...currentItem, active: false } : currentItem));
      setMessage(result.deactivated ? `${itemLabel}を無効化しました。` : `${itemLabel}を削除しました。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${itemLabel}を削除できませんでした。`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="masterManager">
      <div className={`masterToolbar${searchEnabled ? " hasSearch" : ""}`}>
        {searchEnabled ? (
          <div className="masterToolbarSummary">
            <div className="searchBox masterSearch">
              <Search size={18} aria-hidden="true" />
              <input type="search" aria-label={`${itemLabel}を検索`} placeholder={searchPlaceholder} value={query} onChange={(event) => setQuery(event.target.value)} />
              {query ? <button className="masterSearchClear" type="button" aria-label="検索をクリア" onClick={() => setQuery("")}><X size={16} aria-hidden="true" /></button> : null}
            </div>
            <p role="status">{searchTerms.length > 0 ? `${filteredItems.length}件 / 全${items.length}件` : `${items.length}件登録されています。`}</p>
          </div>
        ) : <p>{items.length}件登録されています。</p>}
        {createHref ? <TenantLink className="primaryButton" href={createHref}><Plus size={17} />{itemLabel}を新規登録</TenantLink> : <button className="primaryButton" type="button" onClick={startNew}><Plus size={17} />{itemLabel}を新規登録</button>}
      </div>
      {message ? <DismissibleMessage message={message} onDismiss={() => setMessage("")} /> : null}
      <section className="tablePanel">
        <table className="adminTable">
          <thead><tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}<th>操作</th></tr></thead>
          <tbody>
            {filteredItems.length === 0 ? <tr><td colSpan={columns.length + 1}><div className="emptyState">{searchTerms.length > 0 ? `検索に一致する${itemLabel}がありません。キーワードを変更してください。` : `${itemLabel}はまだ登録されていません。`}</div></td></tr> : null}
            {filteredItems.map((item) => (
              <tr key={item.id}>
                {columns.map((column) => {
                  const value = record(item)[column.key];
                  return <td key={column.key}>{column.format === "color" ? <><span className="menuColor" style={{ background: String(value) }} /> {String(value)}</> : formatted(value, column.format)}</td>;
                })}
                <td><div className="tableActions">{editBaseHref ? <TenantLink className="miniButton" href={`${editBaseHref}/${encodeURIComponent(item.id)}/edit`}><Edit3 size={15} />編集</TenantLink> : <button className="miniButton" type="button" onClick={() => startEdit(item)}><Edit3 size={15} />編集</button>}<button className="dangerButton" disabled={busy} type="button" onClick={() => void remove(item)}><Trash2 size={15} /></button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {editing ? (
        <div className="drawerBackdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setEditing(null); }}>
          <aside className="editDrawer masterDrawer">
            <div className="detailPanelHeader"><div><span>Master data</span><h2>{editing === "new" ? `${itemLabel}を登録` : `${itemLabel}を編集`}</h2></div><button className="iconOnlyButton" type="button" onClick={() => setEditing(null)}><X size={18} /></button></div>
            <form className="masterForm" onSubmit={save}>
              <MasterFields fields={fields} form={form} onChange={(key, value) => setForm((current) => ({ ...current, [key]: value }))} />
              <button className="primaryButton" disabled={busy} type="submit"><Save size={17} />{busy ? "保存中..." : "保存"}</button>
            </form>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
