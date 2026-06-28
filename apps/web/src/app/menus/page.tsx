import { Download, Edit3, FileUp, Plus, Scissors, Trash2 } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { fetchAdminMenus } from "@/lib/admin-api";

const yen = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0
});

export default async function MenusPage() {
  const menus = await fetchAdminMenus();

  return (
    <AdminShell
      active="/menus"
      title="メニュー管理"
      subtitle="LINE表示、カテゴリ、所要時間、価格、説明文を予約受付に直結する粒度で整えます。"
      badge={`${menus.length}件`}
      actions={
        <>
          <button className="secondaryButton" type="button">
            <FileUp size={17} />
            CSVアップロード
          </button>
          <button className="secondaryButton" type="button">
            <Download size={17} />
            CSVダウンロード
          </button>
          <button className="primaryButton" type="button">
            <Plus size={17} />
            新規登録
          </button>
        </>
      }
    >
      <div className="adminContent">
        <div className="adminTabs">
          <button className="isActive" type="button">メニュー管理</button>
          <button type="button">オプション管理</button>
          <button type="button">メニューグループ新規登録</button>
        </div>

        <section className="adminNotice">
          <Scissors size={18} />
          メニューの表示順・LINE表示・予約数制限は、予約導線の離脱率に直結します。
        </section>

        <section className="tablePanel">
          <table className="adminTable menuTable">
            <thead>
              <tr>
                <th>編集</th>
                <th>画像</th>
                <th>カテゴリー</th>
                <th>コース名</th>
                <th>価格</th>
                <th>説明</th>
                <th>時間</th>
                <th>種別</th>
                <th>LINE</th>
                <th>無制限</th>
                <th>削除</th>
              </tr>
            </thead>
            <tbody>
              {menus.map((menu) => (
                <tr key={menu.id}>
                  <td>
                    <button className="miniButton" type="button">
                      <Edit3 size={15} />
                      編集
                    </button>
                  </td>
                  <td>
                    <span className="menuColor" style={{ background: menu.color }} />
                  </td>
                  <td><span className="categoryPill">{menu.category}</span></td>
                  <td>
                    <strong>{menu.name}</strong>
                  </td>
                  <td>{yen.format(menu.price)}</td>
                  <td className="descriptionCell">{menu.description}</td>
                  <td>{menu.durationMinutes}分</td>
                  <td>{menu.menuType}</td>
                  <td><span className={menu.lineVisible ? "statusChip on" : "statusChip"}>{menu.lineVisible ? "表示" : "非表示"}</span></td>
                  <td><span className={menu.unlimitedBooking ? "statusChip on" : "statusChip"}>{menu.unlimitedBooking ? "ON" : "OFF"}</span></td>
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
