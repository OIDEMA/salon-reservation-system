import assert from "node:assert/strict";
import test from "node:test";
import { masterPageQuerySchema, masterSearchPatterns } from "../src/master-page.js";

test("master search normalizes kana/width and treats SQL metacharacters literally", () => {
  assert.deepEqual(masterSearchPatterns("　ﾌｪｲｼｬﾙ ABC １００%_!　"), ["%ふぇいしゃる%", "%abc%", "%100!%!_!!%"]);
  assert.deepEqual(masterSearchPatterns("  "), []);
});
test("master pages have bounded defaults and reject invalid filters/pagination", () => {
  assert.deepEqual(masterPageQuerySchema.parse({}), { q: "", page: 1, pageSize: 50 });
  for (const query of [{ page: 0 }, { page: 1.2 }, { pageSize: 101 }, { pageSize: 0 },
    { q: "x".repeat(101) }, { q: "bad\0value" }, { status: "bad" }, { unknown: "value" }]) {
    assert.equal(masterPageQuerySchema.safeParse(query).success, false);
  }
});
