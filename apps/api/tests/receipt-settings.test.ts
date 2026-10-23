import assert from "node:assert/strict";
import test from "node:test";
import { invoiceRegistrationNumberSchema, receiptIssuerNameSchema, receiptSettingsInputSchema } from "../src/receipt-settings.js";

test("receipt issuer settings preserve omitted keys and normalize explicit blanks to null", () => {
  assert.deepEqual(receiptSettingsInputSchema.parse({}), {});
  for (const value of [null, "", "   ", "\t\n"]) {
    assert.deepEqual(receiptSettingsInputSchema.parse({ receiptIssuerName: value }), { receiptIssuerName: null });
    assert.deepEqual(receiptSettingsInputSchema.parse({ invoiceRegistrationNumber: value }), { invoiceRegistrationNumber: null });
  }
  assert.deepEqual(receiptSettingsInputSchema.parse({ invoiceRegistrationNumber: " t1234567890123 " }), { invoiceRegistrationNumber: "T1234567890123" });
  assert.deepEqual(receiptSettingsInputSchema.parse({ receiptIssuerName: " 株式会社 テスト " }), { receiptIssuerName: "株式会社 テスト" });
});

test("formal issuer name accepts at most 300 characters and rejects control characters", () => {
  assert.equal(receiptIssuerNameSchema.parse("あ".repeat(300)).length, 300);
  for (const value of ["", "   ", "あ".repeat(301), "事業者\n名称", "事業者\r名称", "事業者\t名称", "事業者\u0000名称", "\n事業者名", "事業者\u007f名", "事業者\u0085名", "事業者\u2028名", 123, {}, []]) {
    assert.equal(receiptIssuerNameSchema.safeParse(value).success, false, JSON.stringify(value));
  }
});

test("registration numbers accept only an ASCII T prefix and exactly 13 ASCII digits", () => {
  assert.equal(invoiceRegistrationNumberSchema.parse(" t1234567890123 "), "T1234567890123");
  for (const value of ["", "T123456789012", "T12345678901234", "1234567890123", "A1234567890123", "Ｔ1234567890123", "T１２３４５６７８９０１２３", "T1234567 90123", "T123456789012x", "T1234567890123\nBcc:bad", 1234567890123, {}, []]) {
    assert.equal(invoiceRegistrationNumberSchema.safeParse(value).success, false, JSON.stringify(value));
  }
});
