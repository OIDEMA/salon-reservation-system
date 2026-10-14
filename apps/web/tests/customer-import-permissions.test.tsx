import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomerImport } from "../src/components/customer-import";
import { CustomerSourceProfiles, type CustomerImportedProfile } from "../src/components/customer-source-profile";
import { TenantProvider } from "../src/components/tenant-provider";

function render(children: ReactNode, permissions: string[], tenantSlug = "missmrs-takamatsu") {
  return renderToStaticMarkup(createElement(TenantProvider, {
    tenantSlug, memberships: [{ role: "STAFF", permissions, tenant: { id: "tenant-test", slug: tenantSlug, name: "テスト", salons: [{ id: "salon-test", name: "テスト店" }] } }], children
  }));
}

test("移行ファイル選択には顧客とカルテの書込権限・正しい店舗が必要", () => {
  for (const permissions of [["customer.read"], ["customer.write"], ["chart.write"]]) {
    const denied = render(createElement(CustomerImport), permissions);
    assert.match(denied, /取り込む権限がありません/);
    assert.doesNotMatch(denied, /type="file"/);
  }
  assert.doesNotMatch(render(createElement(CustomerImport), ["customer.write", "chart.write"], "other-test"), /type="file"/);
  assert.match(render(createElement(CustomerImport), ["customer.write", "chart.write"]), /type="file"/);
});

test("移行前の実績を区別して表示し、元メモはカルテ閲覧権限で保護する", () => {
  const profile: CustomerImportedProfile = {
    source: "SALONBOARD", sourceStoreId: "H000551123", externalCustomerId: "customer-test",
    importedAt: "2026-10-14T00:00:00Z", capturedAt: null, customerNumber: "TEST-001",
    gender: "女性", occupation: null, sourceVisitCount: 12, sourceLastVisitDate: "2026-10-01", sourceLastVisitDateRaw: "2026/10/01",
    phone: null, phone2: null, email: "synthetic@example.invalid", mobileEmail: null, birthDate: null, address: null, postalCode: null,
    profile: { "お客様メモ": "テストの観察内容<script>alert(1)</script>" }
  };
  const element = createElement(CustomerSourceProfiles, { profiles: [profile] });
  const basic = render(element, ["customer.read"]);
  assert.match(basic, /移行前の来店回数/);
  assert.match(basic, /12回/);
  assert.match(basic, /synthetic@example.invalid/);
  assert.doesNotMatch(basic, /観察内容/);
  const chart = render(element, ["customer.read", "chart.read"]);
  assert.match(chart, /観察内容&lt;script&gt;/);
  assert.doesNotMatch(chart, /<script>/);
});
