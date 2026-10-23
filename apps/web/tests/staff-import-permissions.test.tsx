import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaffImport, StaffImportLink } from "../src/components/staff-import";
import { StaffSourceDetails } from "../src/components/staff-source-details";
import { TenantProvider } from "../src/components/tenant-provider";
import { staffCommentForForm } from "../src/lib/staff-form";

function render(children: ReactNode, permissions: string[], tenantSlug = "missmrs-takamatsu") {
  return renderToStaticMarkup(createElement(TenantProvider, {
    tenantSlug, memberships: [{ role: "STAFF", permissions, tenant: { id: "tenant-test", slug: tenantSlug, name: "テスト", salons: [{ id: "salon-test", name: "テスト店" }] } }], children
  }));
}
test("旧定型コメントだけを中立化し、手入力のコメントは保持する", () => {
  assert.equal(staffCommentForForm("サロンボードの過去予約から移行した担当（予約受付停止）。元情報は担当名の記録です。"), "予約履歴の担当名を記録したスタッフです（予約受付停止）。");
  for (const comment of [null, "", "接客メモ", "移行元のお客様へ確認済み", "サロンボードの過去予約から移行した担当（予約受付停止）。元情報は担当名の記録です。追記あり"]) {
    assert.equal(staffCommentForForm(comment), comment);
  }
});
test("スタッフ移行はマスタ編集権限と正しい移行先を要求する", () => {
  for (const permission of [[], ["master.read"], ["access.write"]]) {
    assert.doesNotMatch(render(createElement(StaffImport), permission), /type="file"/);
    assert.equal(render(createElement(StaffImportLink), permission), "");
  }
  assert.doesNotMatch(render(createElement(StaffImport), ["master.write"], "other-test"), /type="file"/);
  assert.equal(render(createElement(StaffImportLink), ["master.write"], "other-test"), "");
  assert.match(render(createElement(StaffImport), ["master.write"]), /type="file"/);
  assert.match(render(createElement(StaffImportLink), ["master.write"]), /href="\/missmrs-takamatsu\/staff\/import"/);
});
test("取得元の設定は現在の予約設定と区別し、HTMLを実行せず表示する", () => {
  const html = renderToStaticMarkup(createElement(StaffSourceDetails, { records: [{ source: "SALONBOARD", sourceStoreId: "H000551123", importedAt: "2026-10-14T00:00:00Z",
    profile: { sourceProfile: { "スタッフ紹介": "テスト<script>alert(1)</script>", "対応メニュー": ["脱毛", "痩身"], "基本シフト": { "月": "11:00～20:00", "火": null } } }
  }] }));
  assert.match(html, /スタッフの詳細情報/);
  assert.match(html, /テスト&lt;script&gt;alert/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /11:00～20:00/);
  assert.doesNotMatch(html, /初期値を設定|現在の予約設定とは別に保存/);
  assert.equal(renderToStaticMarkup(createElement(StaffSourceDetails, { records: [] })), "");
});

test("スタッフ詳細の内部メタデータだけを非表示にし、プロフィールと元データは保持する", () => {
  const sourceProfile = {
    migrationStatusReason: "移行元の対応メニュー登録あり",
    "スタッフ紹介": "接客を担当しています。",
    "対応メニュー": ["脱毛", "痩身"],
    "補足": [{ migrationStatusReason: "ユーザー指定・移行元の対応メニュー登録なしにより予約受付停止", "受付について": "個別に確認してください。" }],
    "お知らせ": "移行元のお客様への確認メモ"
  };
  const original = structuredClone(sourceProfile);
  const html = renderToStaticMarkup(createElement(StaffSourceDetails, { records: [{
    source: "SALONBOARD", sourceStoreId: "H000551123", importedAt: "2026-10-14T00:00:00Z", profile: { sourceProfile }
  }] }));
  assert.doesNotMatch(html, /migrationStatusReason|移行元の対応メニュー登録あり|ユーザー指定・移行元の対応メニュー登録なしにより予約受付停止/);
  for (const value of ["スタッフ紹介", "接客を担当しています。", "対応メニュー", "脱毛", "痩身", "受付について", "個別に確認してください。", "移行元のお客様への確認メモ"]) {
    assert.ok(html.includes(value));
  }
  assert.deepEqual(sourceProfile, original);
});
