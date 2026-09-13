"use client";

import { CheckCircle2, Clock3, Save, Store, ToggleLeft } from "lucide-react";
import { useState } from "react";
import { useTenant } from "@/components/tenant-provider";
import type { AdminSettingsPayload } from "@/lib/admin-types";
import { tenantApiPath } from "@/lib/tenant-routing";

const days = ["月", "火", "水", "木", "金", "土", "日", "祝"];
const settingsTabs = [
  { id: "store", label: "店舗情報", icon: Store },
  { id: "reservations", label: "予約受付", icon: Clock3 },
  { id: "messages", label: "運用メッセージ", icon: CheckCircle2 }
] as const;

type SettingsTabId = (typeof settingsTabs)[number]["id"];

export function SettingsManagement({ initialData }: { initialData: AdminSettingsPayload }) {
  const { tenantSlug, updateSalonName } = useTenant();
  const [data, setData] = useState(initialData);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTabId>("store");
  if (!data.salon || !data.settings) return <section className="adminNotice">店舗情報が未登録です。</section>;
  const { salon, settings } = data;

  function setSetting<K extends keyof typeof settings>(key: K, value: (typeof settings)[K]) {
    setData({ ...data, settings: { ...settings, [key]: value } });
  }

  function moveTabFocus(event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % settingsTabs.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + settingsTabs.length) % settingsTabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = settingsTabs.length - 1;
    if (nextIndex === undefined) return;

    event.preventDefault();
    const nextTab = settingsTabs[nextIndex];
    setActiveTab(nextTab.id);
    document.getElementById(`settings-tab-${nextTab.id}`)?.focus();
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(tenantApiPath(tenantSlug, "/admin/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salonName: salon.name, timezone: salon.timezone, ...settings, storeId: undefined })
      });
      const body = (await response.json().catch(() => null)) as AdminSettingsPayload & { message?: string };
      if (!response.ok) throw new Error(body?.message ?? "設定を保存できませんでした。");
      setData(body);
      if (body.salon) updateSalonName(body.salon.id, body.salon.name);
      setMessage("基本設定を保存しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "設定を保存できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settingsForm" onSubmit={save}>
      {message ? <p className="formMessage">{message}</p> : null}

      <div className="settingsTabs" role="tablist" aria-label="基本設定の項目">
        {settingsTabs.map((tab, index) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              aria-controls={`settings-panel-${tab.id}`}
              aria-selected={isActive}
              className={isActive ? "isActive" : undefined}
              id={`settings-tab-${tab.id}`}
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => moveTabFocus(event, index)}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              type="button"
            >
              <Icon aria-hidden="true" size={18} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      <section
        aria-labelledby="settings-tab-store"
        className="adminPanel settingsTabPanel"
        hidden={activeTab !== "store"}
        id="settings-panel-store"
        role="tabpanel"
        tabIndex={0}
      >
        <div className="adminPanelTitle"><Store size={19} /><h2>店舗情報</h2></div>
        <div className="settingsGrid">
          <label className="settingField"><span>店舗ID</span><input value={settings.storeId} disabled title="店舗IDは作成後に変更できません" /></label>
          <label className="settingField"><span>店舗名</span><input value={salon.name} onChange={(event) => setData({ ...data, salon: { ...salon, name: event.target.value } })} /></label>
          <label className="settingField"><span>営業時間 開始</span><input type="time" value={settings.openTime} onChange={(event) => setSetting("openTime", event.target.value)} /></label>
          <label className="settingField"><span>営業時間 終了</span><input type="time" value={settings.closeTime} onChange={(event) => setSetting("closeTime", event.target.value)} /></label>
        </div>
        <div className="settingsLine"><span className="settingsLabel">定休日</span><div className="daySelector">{days.map((day) => <button className={settings.closedDays.includes(day) ? "dayButton isSelected" : "dayButton"} key={day} type="button" onClick={() => setSetting("closedDays", settings.closedDays.includes(day) ? settings.closedDays.filter((item) => item !== day) : [...settings.closedDays, day])}>{day}</button>)}</div></div>
      </section>

      <section
        aria-labelledby="settings-tab-reservations"
        className="adminPanel settingsTabPanel"
        hidden={activeTab !== "reservations"}
        id="settings-panel-reservations"
        role="tabpanel"
        tabIndex={0}
      >
        <div className="adminPanelTitle"><Clock3 size={19} /><h2>予約受付</h2></div>
        <div className="settingsGrid three">
          <label className="settingField"><span>最大同時受付数</span><input type="number" min="1" value={settings.maxConcurrentReservations} onChange={(event) => setSetting("maxConcurrentReservations", Number(event.target.value))} /></label>
          <label className="settingField"><span>受付可能期間</span><input value={settings.bookingWindowValue} onChange={(event) => setSetting("bookingWindowValue", event.target.value)} /></label>
          <label className="settingField"><span>予約締切（日数）</span><input type="number" min="0" value={settings.reservationCutoffDays} onChange={(event) => setSetting("reservationCutoffDays", Number(event.target.value))} /></label>
          <label className="settingField"><span>予約締切（時刻）</span><input type="time" value={settings.reservationCutoffTime} onChange={(event) => setSetting("reservationCutoffTime", event.target.value)} /></label>
          <label className="settingField"><span>キャンセル締切（日数）</span><input type="number" min="0" value={settings.cancellationCutoffDays} onChange={(event) => setSetting("cancellationCutoffDays", Number(event.target.value))} /></label>
          <label className="settingField"><span>キャンセル締切（時刻）</span><input type="time" value={settings.cancellationCutoffTime} onChange={(event) => setSetting("cancellationCutoffTime", event.target.value)} /></label>
        </div>
        <div className="toggleGrid">
          <ToggleButton label="予約受付" enabled={settings.acceptingReservations} onClick={() => setSetting("acceptingReservations", !settings.acceptingReservations)} />
          <ToggleButton label="複数メニュー予約" enabled={settings.multiMenuBooking} onClick={() => setSetting("multiMenuBooking", !settings.multiMenuBooking)} />
          <ToggleButton label="指名なし自動割当" enabled={settings.autoAssignUnspecified} onClick={() => setSetting("autoAssignUnspecified", !settings.autoAssignUnspecified)} />
          <ToggleButton label="事前質問" enabled={settings.questionsEnabled} onClick={() => setSetting("questionsEnabled", !settings.questionsEnabled)} />
        </div>
      </section>

      <section
        aria-labelledby="settings-tab-messages"
        className="adminPanel settingsTabPanel"
        hidden={activeTab !== "messages"}
        id="settings-panel-messages"
        role="tabpanel"
        tabIndex={0}
      >
        <div className="adminPanelTitle"><CheckCircle2 size={19} /><h2>運用メッセージ</h2></div>
        <div className="messageGrid">
          <label className="messageField"><span>キャンセル受付時の案内</span><textarea rows={6} value={settings.cancellationMessage} onChange={(event) => setSetting("cancellationMessage", event.target.value)} /></label>
          <label className="messageField"><span>予約前の案内</span><textarea rows={6} value={settings.preReservationMessage} onChange={(event) => setSetting("preReservationMessage", event.target.value)} /></label>
        </div>
      </section>

      <div className="stickySaveBar"><span>変更内容はこのシステム内の予約受付に反映されます。</span><button className="primaryButton" disabled={busy} type="submit"><Save size={17} />{busy ? "保存中..." : "設定を保存"}</button></div>
    </form>
  );
}

function ToggleButton({ label, enabled, onClick }: { label: string; enabled: boolean; onClick: () => void }) {
  return <button className="toggleButton" type="button" onClick={onClick}><span>{label}</span><span className={enabled ? "toggleState isOn" : "toggleState"}><i />{enabled ? "ON" : "OFF"}</span><ToggleLeft size={18} /></button>;
}
