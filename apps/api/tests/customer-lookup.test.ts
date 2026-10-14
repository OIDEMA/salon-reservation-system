import assert from "node:assert/strict";
import test from "node:test";
import { customerLookupQuerySchema, lookupCustomers, normalizedCustomerPhone, prepareCustomerLookup } from "../src/customer-lookup.js";

test("lookup normalization handles spaces, kana width and phonetic scripts", () => {
  assert.equal(prepareCustomerLookup("　 \t "), null);
  assert.deepEqual(prepareCustomerLookup(" ﾔﾏﾀﾞ ﾊﾅｺ ")?.textPatterns, ["%ヤマダハナコ%", "%やまだはなこ%"]);
  assert.deepEqual(prepareCustomerLookup("やまだ")?.textPatterns, ["%やまだ%", "%ヤマダ%"]);
  assert.deepEqual(prepareCustomerLookup("Ａｌｉｃｅ")?.textPatterns, ["%Alice%"]);
});

test("phone partial matching requires two digits and ignores formatting", () => {
  assert.equal(prepareCustomerLookup("０９０（１２３４）５６７８")?.phonePattern, "%09012345678%");
  assert.equal(prepareCustomerLookup("090-1234")?.phonePattern, "%0901234%");
  assert.equal(prepareCustomerLookup("9")?.phonePattern, null);
  assert.equal(prepareCustomerLookup("山田090")?.phonePattern, null);
  assert.equal(normalizedCustomerPhone("０９０－１２３４－５６７８"), "09012345678");
  assert.equal(normalizedCustomerPhone("09012345678"), "09012345678");
  assert.equal(normalizedCustomerPhone("山田090"), null);
});

test("LIKE wildcards are escaped and query bounds reject invalid inputs", () => {
  assert.deepEqual(prepareCustomerLookup("%_!")?.textPatterns, ["%!%!_!!%"]);
  assert.equal(customerLookupQuerySchema.safeParse({ q: "a".repeat(101) }).success, false);
  assert.equal(customerLookupQuerySchema.safeParse({ q: "a\0b" }).success, false);
  assert.deepEqual(customerLookupQuerySchema.parse({}), { q: "" });
});

test("empty queries do not read the customer table", async () => {
  const result = await lookupCustomers({ $queryRaw: async () => { throw new Error("unexpected database read"); } } as any, "tenant", "salon", "　");
  assert.deepEqual(result, { customers: [], hasMore: false });
});
