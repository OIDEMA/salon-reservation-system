import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaffImport, StaffImportLink } from "../src/components/staff-import";
import { StaffSourceDetails } from "../src/components/staff-source-details";
import { TenantProvider } from "../src/components/tenant-provider";

function render(children: ReactNode, permissions: string[], tenantSlug = "missmrs-takamatsu") {
  return renderToStaticMarkup(createElement(TenantProvider, {
    tenantSlug, memberships: [{ role: "STAFF", permissions, tenant: { id: "tenant-test", slug: tenantSlug, name: "テスト", salons: [{ id: "salon-test", name: "テスト店" }] } }], children
  }));
}
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
  assert.match(html, /現在の予約設定とは別に保存/);
  assert.match(html, /テスト&lt;script&gt;alert/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /11:00～20:00/);
  assert.match(html, /初期値を設定/);
  assert.equal(renderToStaticMarkup(createElement(StaffSourceDetails, { records: [] })), "");
});
