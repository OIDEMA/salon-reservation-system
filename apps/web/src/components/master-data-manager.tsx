"use client";

import { Edit3, Plus, Save, Trash2, X } from "lucide-react";
import { useState } from "react";
import { DismissibleMessage } from "@/components/dismissible-message";
import { useTenantSlug } from "@/components/tenant-provider";
import { tenantApiPath } from "@/lib/tenant-routing";

export type MasterField = {
  key: string;
  label: string;
  type?: "text" | "number" | "textarea" | "color" | "checkbox" | "select";
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
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

export function MasterDataManager({
  resource,
  initialItems,
  fields,
  columns,
  defaults,
  itemLabel
}: {
  resource: "staff" | "menus" | "categories" | "equipment";
  initialItems: MasterItem[];
  fields: MasterField[];
  columns: MasterColumn[];
  defaults: ItemRecord;
  itemLabel: string;
}) {
  const tenantSlug = useTenantSlug();
  const [items, setItems] = useState(initialItems);
  const [editing, setEditing] = useState<MasterItem | "new" | null>(null);
  const [form, setForm] = useState<ItemRecord>(defaults);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

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
      <div className="masterToolbar">
        <p>{items.length}件登録されています。</p>
        <button className="primaryButton" type="button" onClick={startNew}><Plus size={17} />{itemLabel}を新規登録</button>
      </div>
      {message ? <DismissibleMessage message={message} onDismiss={() => setMessage("")} /> : null}
      <section className="tablePanel">
        <table className="adminTable">
          <thead><tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}<th>操作</th></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                {columns.map((column) => {
                  const value = record(item)[column.key];
                  return <td key={column.key}>{column.format === "color" ? <><span className="menuColor" style={{ background: String(value) }} /> {String(value)}</> : formatted(value, column.format)}</td>;
                })}
                <td><div className="tableActions"><button className="miniButton" type="button" onClick={() => startEdit(item)}><Edit3 size={15} />編集</button><button className="dangerButton" disabled={busy} type="button" onClick={() => void remove(item)}><Trash2 size={15} /></button></div></td>
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
              {fields.map((field) => {
                const value = form[field.key];
                if (field.type === "checkbox") return <label className="checkboxField" key={field.key}><input type="checkbox" checked={Boolean(value)} onChange={(event) => setForm({ ...form, [field.key]: event.target.checked })} /><span>{field.label}</span></label>;
                if (field.type === "textarea") return <label className="createField" key={field.key}><span>{field.label}</span><textarea rows={6} value={String(value ?? "")} onChange={(event) => setForm({ ...form, [field.key]: event.target.value })} /></label>;
                if (field.type === "select") return <label className="createField" key={field.key}><span>{field.label}</span><select value={String(value ?? "")} onChange={(event) => setForm({ ...form, [field.key]: event.target.value })}>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
                return <label className="createField" key={field.key}><span>{field.label}</span><input required={field.required} type={field.type ?? "text"} value={String(value ?? "")} onChange={(event) => setForm({ ...form, [field.key]: field.type === "number" ? Number(event.target.value) : event.target.value })} /></label>;
              })}
              <button className="primaryButton" disabled={busy} type="submit"><Save size={17} />{busy ? "保存中..." : "保存"}</button>
            </form>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
