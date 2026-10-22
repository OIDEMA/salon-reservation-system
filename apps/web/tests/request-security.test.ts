import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { rejectCrossOriginMutation, sameOrigin } from "../src/lib/request-security";

const publicOrigin = "https://reservation.example.test";

function request(headers: Record<string, string> = {}, method = "POST", url = `${publicOrigin}/api/backend/reservations`) {
  return new NextRequest(url, { method, headers });
}

test("cookie-backed writes require a matching origin", () => {
  assert.equal(sameOrigin(request({ origin: publicOrigin })), true);
  for (const origin of ["https://attacker.test", "https://other.example.test", "http://reservation.example.test", "null", ""]) {
    assert.equal(sameOrigin(request({ origin })), false, origin);
  }
});

test("missing Origin requires same-origin Referer or Fetch Metadata", () => {
  assert.equal(sameOrigin(request()), false);
  assert.equal(sameOrigin(request({ referer: `${publicOrigin}/salon/access` })), true);
  assert.equal(sameOrigin(request({ "sec-fetch-site": "same-origin" })), true);
  for (const site of ["same-site", "cross-site", "none"]) {
    assert.equal(sameOrigin(request({ "sec-fetch-site": site })), false);
    assert.equal(sameOrigin(request({ "sec-fetch-site": site, referer: `${publicOrigin}/` })), false);
  }
});

test("untrusted Referer and opaque Origin cannot use the metadata fallback", () => {
  for (const referer of ["https://attacker.test/", "https://other.example.test/", "invalid", "data:text/plain,test"]) {
    assert.equal(sameOrigin(request({ referer, "sec-fetch-site": "same-origin" })), false);
  }
  for (const origin of ["null", "https://attacker.test", ""]) {
    assert.equal(sameOrigin(request({ origin, referer: `${publicOrigin}/`, "sec-fetch-site": "same-origin" })), false);
  }
});

test("App Hosting accepts configured public origins with an internal request URL", (t) => {
  const plural = process.env.APP_PUBLIC_ORIGINS;
  const singular = process.env.APP_PUBLIC_ORIGIN;
  t.after(() => {
    if (plural === undefined) delete process.env.APP_PUBLIC_ORIGINS;
    else process.env.APP_PUBLIC_ORIGINS = plural;
    if (singular === undefined) delete process.env.APP_PUBLIC_ORIGIN;
    else process.env.APP_PUBLIC_ORIGIN = singular;
  });
  delete process.env.APP_PUBLIC_ORIGINS;
  process.env.APP_PUBLIC_ORIGIN = publicOrigin;
  const internalUrl = "http://internal:8080/api/backend/reservations";
  assert.equal(sameOrigin(request({ origin: publicOrigin }, "POST", internalUrl)), true);
  assert.equal(sameOrigin(request({ referer: `${publicOrigin}/salon/access` }, "POST", internalUrl)), true);
  process.env.APP_PUBLIC_ORIGINS = `${publicOrigin}, https://second.example.test, invalid, data:text/plain,test`;
  assert.equal(sameOrigin(request({ origin: "https://second.example.test" }, "POST", internalUrl)), true);
  assert.equal(sameOrigin(request({ origin: "null" }, "POST", internalUrl)), false);
  assert.equal(sameOrigin(request({ origin: "https://attacker.test" }, "POST", internalUrl)), false);
});

test("all proxy mutation methods reject untrusted or missing origins with 403", async () => {
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    for (const headers of [{}, { origin: "https://attacker.test" }, { origin: "null" }] as Record<string, string>[]) {
      const response = rejectCrossOriginMutation(request(headers, method));
      assert.equal(response?.status, 403, method);
      assert.equal((await response!.json()).code, "INVALID_ORIGIN");
    }
    assert.equal(rejectCrossOriginMutation(request({ origin: publicOrigin }, method)), null);
  }
});

test("read requests keep their existing behavior", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    assert.equal(rejectCrossOriginMutation(request({}, method)), null);
    assert.equal(rejectCrossOriginMutation(request({ origin: "https://attacker.test" }, method)), null);
  }
});
