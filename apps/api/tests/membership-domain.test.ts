import assert from "node:assert/strict";
import test from "node:test";
import {
  MEMBERSHIP_POLICY, MembershipError, membershipEnrollmentSchema, membershipLinkSchema,
  membershipLookupSchema, membershipSafeError, parseMembershipBarcode, validateMembershipUse,
} from "../src/membership-domain.js";

test("membership reader accepts exactly a numeric card or the existing demo QR", () => {
  const number = "1000000000001";
  for (const value of [number, `beautygum-demo:${number}`, `${number}\r\n`]) assert.equal(parseMembershipBarcode(value), number);
  for (const value of ["", "123456789012", "12345678901234", "１０００００００００００１", `https://elsewhere.example/${number}`, `coupon:${number}`, `beautygum-demo: ${number}`, `${number}\n1000000000002`]) {
    assert.throws(() => parseMembershipBarcode(value), (error) => error instanceof MembershipError && error.code === "INVALID_MEMBER_BARCODE");
  }
});

test("100-point units use only the current pre-award balance and eligible yen amount", () => {
  assert.equal(validateMembershipUse(200, 250, 9800, MEMBERSHIP_POLICY.version), 200);
  assert.equal(validateMembershipUse(0, 0, 0, MEMBERSHIP_POLICY.version), 0);
  for (const points of [-100, 1, 99, 101, 100.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateMembershipUse(points, 10000, 9800, MEMBERSHIP_POLICY.version), (error) => error instanceof MembershipError && error.code === "MEMBERSHIP_POINTS_UNIT");
  }
  assert.throws(() => validateMembershipUse(300, 250, 9800, MEMBERSHIP_POLICY.version), (error) => error instanceof MembershipError && error.code === "MEMBERSHIP_POINTS_SHORTAGE");
  assert.throws(() => validateMembershipUse(1000, 5000, 999, MEMBERSHIP_POLICY.version), (error) => error instanceof MembershipError && error.code === "MEMBERSHIP_DISCOUNT_LIMIT");
  assert.throws(() => validateMembershipUse(100, 5000, 1000, "old-policy"), (error) => error instanceof MembershipError && error.code === "MEMBERSHIP_POLICY_CHANGED");
});

test("reception requests cannot attach another identity, balance, or alternative API URL", () => {
  const programId = "00000000-0000-4000-8000-000000000001";
  assert.deepEqual(membershipEnrollmentSchema.parse({ programId, displayName: " 確認用会員 " }), { programId, displayName: "確認用会員" });
  for (const field of ["uid", "projectId", "memberNumber", "points", "balance", "active"]) {
    assert.throws(() => membershipEnrollmentSchema.parse({ programId, displayName: "確認用会員", [field]: "forged" }));
  }
  assert.throws(() => membershipLookupSchema.parse({ barcode: "1000000000001", reservationId: "one", checkoutId: programId }));
  assert.throws(() => membershipLookupSchema.parse({ barcode: "1000000000001", serverUrl: "https://other.example" }));
  assert.throws(() => membershipLinkSchema.parse({ barcode: "1000000000001", expectedMemberId: programId, confirmed: false }));
});

test("safe membership errors never return unexpected database diagnostics", () => {
  assert.deepEqual(membershipSafeError(new MembershipError("MEMBERSHIP_UNAVAILABLE", "連携設定が必要です。", 503)),
    { code: "MEMBERSHIP_UNAVAILABLE", message: "連携設定が必要です。", status: 503 });
  const safe = membershipSafeError(new Error("private database URL or customer details"));
  assert.equal(safe.status, 500);
  assert(!safe.message.includes("private"));
  assert.equal(membershipSafeError(membershipEnrollmentSchema.safeParse({}).error).code, "INVALID_INPUT");
});
