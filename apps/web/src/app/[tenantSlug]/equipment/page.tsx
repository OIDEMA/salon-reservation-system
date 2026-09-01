import { Edit3, GripVertical, Plus, Save, Trash2, Wrench } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { fetchAdminEquipment } from "@/lib/admin-api";

export default async function TenantEquipmentPage() {
  const equipment = await fetchAdminEquipment();

  return (
    <AdminShell
      active="/equipment"
      title="設備一覧"
      subtitle="ベッド、個室、ブースなど、同時受付数と割当優先度を管理します。"
      badge={`${equipment.length}設備`}
      actions={
        <>
          <button className="secondaryButton" type="button">
            <Save size={17} />
            保存
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
          <Wrench size={18} />
          収容数は同時に予約を受けられる数、割当順は自動割当時の優先順位です。
        </section>

        <section className="tablePanel">
          <table className="adminTable equipmentTable">
            <thead>
              <tr>
                <th>並び</th>
                <th>編集</th>
                <th>設備名</th>
                <th>色</th>
                <th>収容数</th>
                <th>割当順</th>
                <th>メモ</th>
                <th>状態</th>
                <th>削除</th>
              </tr>
            </thead>
            <tbody>
              {equipment.map((item) => (
                <tr key={item.id}>
                  <td><GripVertical className="dragIcon" size={18} /></td>
                  <td>
                    <button className="miniButton" type="button">
                      <Edit3 size={15} />
                      編集
                    </button>
                  </td>
                  <td><strong>{item.name}</strong></td>
                  <td><span className="menuColor" style={{ background: item.color }} /></td>
                  <td>{item.capacity}</td>
                  <td>{item.allocationOrder}</td>
                  <td className="descriptionCell">{item.memo}</td>
                  <td><span className={item.active ? "statusChip on" : "statusChip"}>{item.active ? "利用中" : "停止"}</span></td>
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
