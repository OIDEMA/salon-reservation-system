import { Bell, CheckCircle2, MessageCircle, Palette, RefreshCw, Save, Store, ToggleLeft } from "lucide-react";
import type { ReactNode } from "react";
import { AdminShell } from "@/components/admin-shell";
import { fetchAdminSettings } from "@/lib/admin-api";

export default async function SettingsPage() {
  const data = await fetchAdminSettings();
  if (!data.salon || !data.settings) {
    return (
      <AdminShell
        active="/settings"
        title="基本設定"
        subtitle="店舗情報、予約受付、LINE予約画面、通知文面を一画面で管理します。"
        badge="未設定"
      >
        <div className="adminContent">
          <section className="adminNotice">店舗情報が未登録です。店舗登録機能の実装後にここから設定できます。</section>
        </div>
      </AdminShell>
    );
  }

  const { salon, settings } = data;

  return (
    <AdminShell
      active="/settings"
      title="基本設定"
      subtitle="店舗情報、予約受付、LINE予約画面、通知文面を一画面で管理します。"
      badge={salon.name}
      actions={
        <>
          <button className="secondaryButton" type="button">
            <RefreshCw size={17} />
            読み込み
          </button>
          <button className="primaryButton" type="button">
            <Save size={17} />
            登録
          </button>
        </>
      }
    >
      <div className="adminContent">
        <section className="adminPanel">
          <PanelTitle icon={<Store size={19} />} title="店舗情報" />
          <div className="settingsGrid">
            <SettingField label="店舗ID" value={settings.storeId} />
            <SettingField label="店舗名" value={salon.name} />
            <SettingField label="営業時間 開始" value={settings.openTime} />
            <SettingField label="営業時間 終了" value={settings.closeTime} />
          </div>
          <div className="settingsLine">
            <span className="settingsLabel">定休日</span>
            <div className="daySelector">
              {["月", "火", "水", "木", "金", "土", "日", "祝"].map((day) => (
                <button className={settings.closedDays.includes(day) ? "dayButton isSelected" : "dayButton"} key={day} type="button">
                  {day}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="adminPanel">
          <PanelTitle icon={<CheckCircle2 size={19} />} title="予約受付設定" />
          <div className="settingsGrid three">
            <SettingField label="最大同時受付数" value={settings.maxConcurrentReservations} unit="件" />
            <SettingField label="受付可能期間" value={settings.bookingWindowValue} />
            <SettingField label="予約締切" value={`${settings.reservationCutoffDays}日前 ${settings.reservationCutoffTime}`} />
            <SettingField label="キャンセル締切" value={`${settings.cancellationCutoffDays}日前 ${settings.cancellationCutoffTime}`} />
            <ToggleField label="複数メニュー予約" enabled={settings.multiMenuBooking} />
            <ToggleField label="指名なし自動割当" enabled={settings.autoAssignUnspecified} />
          </div>
        </section>

        <section className="adminPanel">
          <PanelTitle icon={<Palette size={19} />} title="LINE予約画面設定" />
          <div className="settingsGrid three">
            <div className="settingField">
              <label>テーマカラー</label>
              <div className="colorInput">
                <span style={{ background: settings.lineThemeColor }} />
                <input defaultValue={settings.lineThemeColor} />
              </div>
            </div>
            <SettingField label="カテゴリー初期表示" value={settings.categoryDisplayMode === "collapsed" ? "閉じた状態" : "全て表示"} />
            <SettingField label="候補枠の間隔" value={settings.candidateIntervalMinutes} unit="分" />
            <SettingField label="カレンダー初期表示" value={settings.calendarDefaultView === "week" ? "週表示" : "月表示"} />
            <SettingField label="空き時間表示" value={settings.calendarDisplayMode === "collapsed" ? "閉じた状態" : "全て表示"} />
            <ToggleField label="事前質問" enabled={settings.questionsEnabled} />
          </div>
        </section>

        <section className="adminPanel">
          <PanelTitle icon={<Bell size={19} />} title="通知設定" />
          <div className="settingsGrid three">
            <ToggleField label="予約通知メール" enabled={settings.notifyReservationEmail} />
            <ToggleField label="予約通知LINE" enabled={settings.notifyReservationLine} />
            <ToggleField label="キャンセル通知" enabled={settings.notifyCancellation} />
            <ToggleField label="キャンセル通知メール" enabled={settings.notifyCancellationEmail} />
            <ToggleField label="キャンセル通知LINE" enabled={settings.notifyCancellationLine} />
            <ToggleField label="予約受付" enabled={settings.acceptingReservations} />
          </div>
        </section>

        <section className="adminPanel">
          <PanelTitle icon={<MessageCircle size={19} />} title="自動メッセージ" />
          <div className="messageGrid">
            <MessageField label="キャンセル通知メッセージ" value={settings.cancellationMessage} />
            <MessageField label="友だち登録時メッセージ" value={settings.friendMessage} />
            <MessageField label="予約前メッセージ" value={settings.preReservationMessage} />
          </div>
        </section>

        <section className="adminPanel">
          <PanelTitle icon={<ToggleLeft size={19} />} title="決済・公開状態" />
          <div className="settingsGrid three">
            <ToggleField label="事前決済" enabled={settings.paymentEnabled} />
            <ToggleField label="予約受付/停止" enabled={settings.acceptingReservations} />
            <SettingField label="タイムゾーン" value={salon.timezone} />
          </div>
        </section>
      </div>
    </AdminShell>
  );
}

function PanelTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="adminPanelTitle">
      {icon}
      <h2>{title}</h2>
    </div>
  );
}

function SettingField({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <label className="settingField">
      <span>{label}</span>
      <div className="inputWithUnit">
        <input defaultValue={value} />
        {unit ? <em>{unit}</em> : null}
      </div>
    </label>
  );
}

function ToggleField({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <div className="settingField">
      <label>{label}</label>
      <span className={enabled ? "toggleState isOn" : "toggleState"}>
        <i />
        {enabled ? "ON" : "OFF"}
      </span>
    </div>
  );
}

function MessageField({ label, value }: { label: string; value: string }) {
  return (
    <label className="messageField">
      <span>{label}</span>
      <textarea defaultValue={value} rows={7} />
    </label>
  );
}
