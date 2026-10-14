import assert from "node:assert/strict";
import test from "node:test";
import { reservationCustomerPayload } from "./reservation-customer";

test("登録済み顧客は電話番号が同じ別顧客がいても選択した顧客IDで予約する", () => {
  const first = reservationCustomerPayload({ customerId: "customer-a", name: "顧客A", kana: "コキャクエー", phone: "090-1234-5678" });
  const second = reservationCustomerPayload({ customerId: "customer-b", name: "顧客B", kana: "コキャクビー", phone: "090-1234-5678" });
  assert.equal(first.customerId, "customer-a");
  assert.equal(second.customerId, "customer-b");
  assert.equal(first.customerPhone, second.customerPhone);
});

test("電話番号が未登録の顧客でも選択した顧客IDを予約に送る", () => {
  const result = reservationCustomerPayload({ customerId: "customer-without-phone", name: "電話なし顧客", kana: "", phone: "" });
  assert.equal(result.customerId, "customer-without-phone");
  assert.equal(result.customerName, "電話なし顧客");
  assert.equal(result.customerPhone, undefined);
});

test("手入力の新規顧客はIDを指定せず入力値を整える", () => {
  const result = reservationCustomerPayload({ name: "  山田 花子  ", kana: "  ヤマダ ハナコ  ", phone: "  090-1234-5678  " });
  assert.equal(result.customerId, undefined);
  assert.equal(result.customerName, "山田 花子");
  assert.equal(result.customerKana, "ヤマダ ハナコ");
  assert.equal(result.customerPhone, "090-1234-5678");
  assert.doesNotMatch(JSON.stringify(result), /customerId/);
});

test("任意項目が空白だけの場合はカナと電話番号を送らない", () => {
  const result = reservationCustomerPayload({ name: "顧客名", kana: " \t ", phone: "  " });
  assert.equal(result.customerKana, undefined);
  assert.equal(result.customerPhone, undefined);
  assert.doesNotMatch(JSON.stringify(result), /customerKana|customerPhone/);
});
