"use client";

import { AlertCircle, CalendarCheck, CheckCircle2, Clock3, CreditCard, MessageCircle, Phone, Send, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import type { AdminMenu, AdminStaff } from "@/lib/admin-types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4001";

const sourceOptions = [
  { value: "PHONE", label: "電話" },
  { value: "LINE", label: "LINE" },
  { value: "MINI_APP", label: "ミニアプリ" },
  { value: "WEB", label: "Web" },
  { value: "WALK_IN", label: "来店" }
];

const statusOptions = [
  { value: "CONFIRMED", label: "確定" },
  { value: "PENDING", label: "未確認" },
  { value: "WAITLIST", label: "待ち" }
];

const lineOptions = [
  { value: "NOT_SENT", label: "未送信" },
  { value: "QUEUED", label: "送信待ち" },
  { value: "SENT", label: "送信済み" }
];

const paymentOptions = [
  { value: "UNPAID", label: "未決済" },
  { value: "AUTHORIZED", label: "仮決済" },
  { value: "PAID", label: "決済済み" }
];

const yen = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0
});

type ReservationCreateFormProps = {
  menus: AdminMenu[];
  staff: AdminStaff[];
  defaultDate: string;
};

type FormMessage = {
  type: "success" | "error";
  text: string;
};

function timeOptions() {
  return Array.from({ length: 27 }, (_, index) => {
    const totalMinutes = 9 * 60 + index * 30;
    const hour = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  });
}

function addMinutes(time: string, minutes: number) {
  const [hour, minute] = time.split(":").map(Number);
  const totalMinutes = hour * 60 + minute + minutes;
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
}

export function ReservationCreateForm({ menus, staff, defaultDate }: ReservationCreateFormProps) {
  const activeMenus = useMemo(() => menus.filter((menu) => menu.active), [menus]);
  const activeStaff = useMemo(() => staff.filter((member) => member.active), [staff]);
  const categories = useMemo(() => ["すべて", ...Array.from(new Set(activeMenus.map((menu) => menu.category)))], [activeMenus]);

  const [customerName, setCustomerName] = useState("");
  const [customerKana, setCustomerKana] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [startTime, setStartTime] = useState("13:00");
  const [selectedMenuId, setSelectedMenuId] = useState(activeMenus[0]?.id ?? "");
  const [selectedStaffId, setSelectedStaffId] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(String(activeMenus[0]?.durationMinutes ?? 60));
  const [source, setSource] = useState("PHONE");
  const [status, setStatus] = useState("CONFIRMED");
  const [lineMessageStatus, setLineMessageStatus] = useState("NOT_SENT");
  const [paymentStatus, setPaymentStatus] = useState("UNPAID");
  const [memo, setMemo] = useState("");
  const [category, setCategory] = useState("すべて");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<FormMessage | null>(null);
  const [createdReservationId, setCreatedReservationId] = useState("");

  const selectedMenu = activeMenus.find((menu) => menu.id === selectedMenuId) ?? activeMenus[0];
  const selectedStaff = activeStaff.find((member) => member.id === selectedStaffId);
  const filteredMenus = category === "すべて" ? activeMenus : activeMenus.filter((menu) => menu.category === category);
  const numericDuration = Math.max(1, Number(durationMinutes) || selectedMenu?.durationMinutes || 60);
  const endTime = addMinutes(startTime, numericDuration);

  function selectMenu(menu: AdminMenu) {
    setSelectedMenuId(menu.id);
    setDurationMinutes(String(menu.durationMinutes));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setCreatedReservationId("");

    if (!customerName.trim()) {
      setMessage({ type: "error", text: "顧客名を入力してください。" });
      return;
    }

    if (!selectedMenu) {
      setMessage({ type: "error", text: "メニューを選択してください。" });
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/reservations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          date,
          startTime,
          durationMinutes: numericDuration,
          serviceId: selectedMenu.id,
          serviceName: selectedMenu.name,
          staffId: selectedStaffId || undefined,
          customerName: customerName.trim(),
          customerKana: customerKana.trim() || undefined,
          customerPhone: customerPhone.trim() || undefined,
          source,
          status,
          paymentStatus,
          lineMessageStatus,
          isRequest: Boolean(selectedStaffId),
          memo: memo.trim() || undefined
        })
      });

      const result = (await response.json().catch(() => null)) as { id?: string; message?: string } | null;

      if (!response.ok) {
        throw new Error(result?.message ?? `予約作成に失敗しました: ${response.status}`);
      }

      setCreatedReservationId(result?.id ?? "");
      setMessage({ type: "success", text: "予約を作成しました。" });
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "予約作成に失敗しました。" });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="reservationCreateLayout" onSubmit={handleSubmit}>
      <section className="reservationFormStack">
        <article className="adminPanel createFormPanel">
          <div className="adminPanelTitle">
            <UserRound size={18} />
            <h2>顧客情報</h2>
          </div>
          <div className="createFieldGrid three">
            <label className="createField">
              <span>顧客名</span>
              <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="顧客名" required />
            </label>
            <label className="createField">
              <span>カナ</span>
              <input value={customerKana} onChange={(event) => setCustomerKana(event.target.value)} placeholder="顧客名（カナ）" />
            </label>
            <label className="createField">
              <span>電話番号</span>
              <input value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} placeholder="090-0000-0000" inputMode="tel" />
            </label>
          </div>
        </article>

        <article className="adminPanel createFormPanel">
          <div className="adminPanelTitle">
            <CalendarCheck size={18} />
            <h2>予約日時</h2>
          </div>
          <div className="createFieldGrid four">
            <label className="createField">
              <span>日付</span>
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </label>
            <label className="createField">
              <span>開始</span>
              <select value={startTime} onChange={(event) => setStartTime(event.target.value)}>
                {timeOptions().map((time) => (
                  <option key={time} value={time}>{time}</option>
                ))}
              </select>
            </label>
            <label className="createField">
              <span>所要時間</span>
              <input type="number" min="5" step="5" value={durationMinutes} onChange={(event) => setDurationMinutes(event.target.value)} />
            </label>
            <label className="createField">
              <span>終了</span>
              <input value={endTime} readOnly />
            </label>
          </div>
        </article>

        <article className="adminPanel createFormPanel">
          <div className="adminPanelTitle">
            <Clock3 size={18} />
            <h2>メニュー</h2>
          </div>
          <div className="adminTabs createCategoryTabs">
            {categories.map((item) => (
              <button key={item} className={category === item ? "isActive" : ""} type="button" onClick={() => setCategory(item)}>
                {item}
              </button>
            ))}
          </div>
          <div className="menuChoiceGrid">
            {filteredMenus.map((menu) => (
              <button key={menu.id} className={selectedMenu?.id === menu.id ? "menuChoice isSelected" : "menuChoice"} type="button" onClick={() => selectMenu(menu)}>
                <span className="menuColor" style={{ background: menu.color }} />
                <strong>{menu.name}</strong>
                <small>{menu.durationMinutes}分 / {yen.format(menu.price)}</small>
              </button>
            ))}
          </div>
        </article>

        <article className="adminPanel createFormPanel">
          <div className="adminPanelTitle">
            <CheckCircle2 size={18} />
            <h2>担当と状態</h2>
          </div>
          <div className="staffChoiceGrid">
            <button className={selectedStaffId === "" ? "staffChoice isSelected" : "staffChoice"} type="button" onClick={() => setSelectedStaffId("")}>
              <span className="resourceDot" style={{ background: "#334155" }} />
              <strong>指名なし</strong>
              <small>自動割当</small>
            </button>
            {activeStaff.map((member) => (
              <button key={member.id} className={selectedStaffId === member.id ? "staffChoice isSelected" : "staffChoice"} type="button" onClick={() => setSelectedStaffId(member.id)}>
                <span className="resourceDot" style={{ background: member.color }} />
                <strong>{member.name}</strong>
                <small>{member.role} / 指名料 {member.nominationFee.toLocaleString("ja-JP")}円</small>
              </button>
            ))}
          </div>
          <div className="createFieldGrid four stateFields">
            <label className="createField">
              <span>経路</span>
              <select value={source} onChange={(event) => setSource(event.target.value)}>
                {sourceOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="createField">
              <span>予約状態</span>
              <select value={status} onChange={(event) => setStatus(event.target.value)}>
                {statusOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="createField">
              <span>LINE</span>
              <select value={lineMessageStatus} onChange={(event) => setLineMessageStatus(event.target.value)}>
                {lineOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="createField">
              <span>決済</span>
              <select value={paymentStatus} onChange={(event) => setPaymentStatus(event.target.value)}>
                {paymentOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
        </article>

        <article className="adminPanel createFormPanel">
          <div className="adminPanelTitle">
            <AlertCircle size={18} />
            <h2>メモ</h2>
          </div>
          <label className="createField">
            <span>共有メモ</span>
            <textarea value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="例: 前回カラー履歴あり。17時以降NG。" />
          </label>
        </article>
      </section>

      <aside className="createSummaryRail">
        <section className="panelSection createSummaryCard">
          <span className="eyebrow">Reservation Preview</span>
          <h2>{customerName || "顧客名未入力"}</h2>
          <div className="summarySlot">
            <CalendarCheck size={18} />
            <strong>{date}</strong>
            <span>{startTime}-{endTime}</span>
          </div>
          <div className="summaryRows">
            <span>メニュー<strong>{selectedMenu?.name ?? "未選択"}</strong></span>
            <span>担当<strong>{selectedStaff?.name ?? "指名なし"}</strong></span>
            <span>価格<strong>{selectedMenu ? yen.format(selectedMenu.price) : "-"}</strong></span>
            <span>状態<strong>{statusOptions.find((option) => option.value === status)?.label}</strong></span>
          </div>
          {message ? (
            <div className={message.type === "success" ? "formResult isSuccess" : "formResult isError"} role="status" aria-live="polite">
              {message.type === "success" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
              <span>{message.text}</span>
            </div>
          ) : null}
          {createdReservationId ? <small className="createdId">ID: {createdReservationId}</small> : null}
          <button className="createSubmitButton" type="submit" disabled={isSubmitting}>
            <CalendarCheck size={22} />
            <span>{isSubmitting ? "作成中" : "予約を作成"}</span>
          </button>
          <div className="createSubActions">
            <a href="/">
              <Clock3 size={15} />
              予約表
            </a>
            <a href="/confirmation">
              <MessageCircle size={15} />
              確認
            </a>
            <a href="/reservations">
              <Phone size={15} />
              検索
            </a>
            <a href={source === "LINE" ? "/confirmation" : "/reservations"}>
              <Send size={15} />
              通知
            </a>
            <a href="/reservations">
              <CreditCard size={15} />
              決済
            </a>
          </div>
        </section>
      </aside>
    </form>
  );
}
