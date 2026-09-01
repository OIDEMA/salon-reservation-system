import { Edit3, ImagePlus, Plus, Tags, Trash2 } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { fetchAdminCategories } from "@/lib/admin-api";

export default async function TenantCategoriesPage() {
  const categories = await fetchAdminCategories();

  return (
    <AdminShell
      active="/categories"
      title="カテゴリー管理"
      subtitle="予約画面に表示するメニュー分類とオプション分類を整理します。"
      badge={`${categories.length}分類`}
      actions={
        <button className="primaryButton" type="button">
          <Plus size={17} />
          新規登録
        </button>
      }
    >
      <div className="adminContent">
        <div className="adminTabs">
          <button className="isActive" type="button">メニューカテゴリー</button>
          <button type="button">オプションカテゴリー</button>
        </div>

        <section className="adminPanel compactPanel">
          <div className="categoryMode">
            <div>
              <Tags size={18} />
              <strong>メニューカテゴリー</strong>
            </div>
            <span className="toggleState isOn"><i />利用する</span>
          </div>
        </section>

        <section className="tablePanel">
          <table className="adminTable categoryTable">
            <thead>
              <tr>
                <th>編集</th>
                <th>カテゴリー名</th>
                <th>種別</th>
                <th>画像</th>
                <th>説明</th>
                <th>状態</th>
                <th>削除</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((category) => (
                <tr key={category.id}>
                  <td>
                    <button className="miniButton" type="button">
                      <Edit3 size={15} />
                      編集
                    </button>
                  </td>
                  <td><strong>{category.name}</strong></td>
                  <td>{category.type === "MENU" ? "メニュー" : "オプション"}</td>
                  <td>
                    <button className="imageButton" type="button">
                      <ImagePlus size={15} />
                    </button>
                  </td>
                  <td className="descriptionCell">{category.description}</td>
                  <td><span className={category.enabled ? "statusChip on" : "statusChip"}>{category.enabled ? "利用中" : "停止"}</span></td>
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
