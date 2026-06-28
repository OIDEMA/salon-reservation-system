import { Edit3, GripVertical, Plus, Save, Trash2, Users } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { fetchAdminStaff } from "@/lib/admin-api";

const roleLabel: Record<string, string> = {
  MANAGER: "管理者",
  STYLIST: "施術スタッフ",
  ESTHETICIAN: "エステ",
  ASSISTANT: "補助",
  ROOM_RESOURCE: "設備枠"
};

export default async function StaffPage() {
  const staff = await fetchAdminStaff();

  return (
    <AdminShell
      active="/staff"
      title="スタッフリスト"
      subtitle="基本就業時間、指名料、予約割当順、同時対応数をスタッフ単位で管理します。"
      badge={`${staff.length}名`}
      actions={
        <>
          <button className="secondaryButton" type="button">
            <Save size={17} />
            ソート確定
          </button>
          <button className="primaryButton" type="button">
            <Plus size={17} />
            新規登録
          </button>
        </>
      }
    >
      <div className="adminContent">
        <section className="adminNotice">
          <Users size={18} />
          メニューとスタッフを連携すると、予約受付時に担当可能なスタッフだけが候補に表示されます。
        </section>

        <section className="tablePanel">
          <table className="adminTable staffTable">
            <thead>
              <tr>
                <th>並び</th>
                <th>編集</th>
                <th>基本就業時間</th>
                <th>画像</th>
                <th>スタッフ名</th>
                <th>指名料</th>
                <th>コメント</th>
                <th>割当順</th>
                <th>同時対応</th>
                <th>削除</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((member) => (
                <tr key={member.id}>
                  <td>
                    <GripVertical className="dragIcon" size={18} />
                  </td>
                  <td>
                    <button className="miniButton" type="button">
                      <Edit3 size={15} />
                      編集
                    </button>
                  </td>
                  <td>
                    <button className="purpleButton" type="button">基本就業時間</button>
                  </td>
                  <td>
                    <div className="staffPhoto" style={{ borderColor: member.color }}>
                      {member.imageUrl ? <img alt="" src={member.imageUrl} /> : <span>{member.name.slice(0, 2)}</span>}
                    </div>
                  </td>
                  <td>
                    <strong>{member.name}</strong>
                    <small>{member.kana} / {roleLabel[member.role] ?? member.role}</small>
                  </td>
                  <td>{member.nominationFee.toLocaleString("ja-JP")}円</td>
                  <td className="mutedCell">{member.comment || "未登録"}</td>
                  <td>{member.allocationOrder}</td>
                  <td>{member.parallelCapacity}</td>
                  <td>
                    <button className="dangerButton" type="button" title="削除">
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </AdminShell>
  );
}
