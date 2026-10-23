import assert from "node:assert/strict";
import { test } from "node:test";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  SES_FROM_EMAIL, SES_REGION, SesMailError,
  googleIdentityToken, googleWebIdentityCredentials, sendTextEmail, sesTextTransport,
  type SesTextMessage
} from "../src/ses-mail.js";

const roleArn = "arn:aws:iam::243110548344:role/salon-reservation-email";

test("Google metadata request uses the STS audience and metadata header", async () => {
  let requests = 0;
  const token = await googleIdentityToken((async (url, init) => {
    requests++;
    const target = new URL(String(url));
    assert.equal(target.hostname, "metadata.google.internal");
    assert.equal(target.searchParams.get("audience"), "sts.amazonaws.com");
    assert.equal(new Headers(init?.headers).get("Metadata-Flavor"), "Google");
    return new Response("signed.google.jwt\n");
  }) as typeof fetch);
  assert.equal(requests, 1);
  assert.equal(token, "signed.google.jwt");
});

test("metadata failures never expose token response text", async () => {
  await assert.rejects(() => googleIdentityToken((async () => new Response("secret-token", { status: 403 })) as typeof fetch),
    (error: unknown) => error instanceof SesMailError && error.code === "AUTH_FAILED" && !error.message.includes("secret-token"));
});

test("AWS web identity credentials are assumed once, reused, and refreshed before expiry", async () => {
  let now = Date.parse("2026-10-23T00:00:00Z");
  let tokenCalls = 0;
  let assumeCalls = 0;
  const provider = googleWebIdentityCredentials({
    roleArn,
    now: () => now,
    identityToken: async () => { tokenCalls++; return "signed.google.jwt"; },
    roleAssumerWithWebIdentity: async (params) => {
      assumeCalls++;
      assert.equal(params.RoleArn, roleArn);
      assert.equal(params.WebIdentityToken, "signed.google.jwt");
      assert.equal(params.RoleSessionName, "salon-reserve-email");
      return { accessKeyId: "temporary-access", secretAccessKey: "temporary-secret", sessionToken: "temporary-session",
        expiration: new Date(now + 3_600_000) };
    }
  });
  const [first, second] = await Promise.all([provider(), provider()]);
  assert.equal(first, second);
  assert.equal(tokenCalls, 1);
  assert.equal(assumeCalls, 1);
  now += 3_000_000;
  assert.equal(await provider(), first);
  now += 400_000;
  const refreshed = await provider();
  assert.notEqual(refreshed, first);
  assert.equal(tokenCalls, 2);
  assert.equal(assumeCalls, 2);
  assert.equal(SES_REGION, "ap-northeast-1");
});

test("wrong AWS account role is rejected before any token fetch", () => {
  assert.throws(() => googleWebIdentityCredentials({ roleArn: "arn:aws:iam::111122223333:role/other" }),
    (error: unknown) => error instanceof SesMailError && error.code === "NOT_CONFIGURED");
});

test("SES API command contains only a UTF-8 plain text message", async () => {
  let command: SendEmailCommand | undefined;
  const transport = sesTextTransport({ send: async (value) => { command = value; return { MessageId: "ses-message-id" }; } });
  const result = await sendTextEmail({ to: "admin@example.com", subject: "新しい予約", text: "日本時間 13:00" }, { transport });
  assert.deepEqual(result, { messageId: "ses-message-id" });
  assert.equal(command?.input.FromEmailAddress, SES_FROM_EMAIL);
  assert.deepEqual(command?.input.Destination?.ToAddresses, ["admin@example.com"]);
  assert.equal(command?.input.Content?.Simple?.Subject?.Charset, "UTF-8");
  assert.equal(command?.input.Content?.Simple?.Body?.Text?.Data, "日本時間 13:00");
  assert.equal(command?.input.Content?.Simple?.Body?.Html, undefined);
});

test("validation and transport errors do not reveal recipient or message content", async () => {
  let calls = 0;
  const transport = async (_: SesTextMessage) => { calls++; throw new Error("secret-token and admin@example.com"); };
  await assert.rejects(() => sendTextEmail({ to: "admin@example.com", subject: "bad\r\nBcc: other@example.com", text: "private" }, { transport }),
    (error: unknown) => error instanceof SesMailError && error.code === "INVALID_MESSAGE" && !error.message.includes("admin@example.com"));
  assert.equal(calls, 0);
  await assert.rejects(() => sendTextEmail({ to: "admin@example.com", subject: "予約", text: "private" }, { transport }),
    (error: unknown) => error instanceof SesMailError && error.code === "SEND_FAILED" && error.retryable && !error.message.includes("secret-token"));
  assert.equal(calls, 1);
});

test("SES rejection is a non-retryable sanitized error", async () => {
  const rejected = new Error("recipient admin@example.com");
  rejected.name = "MessageRejected";
  await assert.rejects(() => sendTextEmail({ to: "admin@example.com", subject: "予約", text: "body" },
    { transport: async () => { throw rejected; } }),
    (error: unknown) => error instanceof SesMailError && error.code === "MESSAGE_REJECTED" && !error.retryable &&
      !error.message.includes("admin@example.com"));
});

test("PDF is attached as binary with explicit MIME, attachment disposition and base64 transfer", async () => {
  let command: SendEmailCommand | undefined;
  const content = Buffer.from("%PDF-1.7\nattachment test\n%%EOF\n");
  await sendTextEmail({ to: "customer@example.com", subject: "領収書PDF", text: "添付をご確認ください。",
    attachments: [{ fileName: "receipt-test.pdf", contentType: "application/pdf", content }] },
  { transport: sesTextTransport({ send: async (value) => { command = value; return { MessageId: "pdf-test" }; } }) });
  assert.deepEqual(command?.input.Content?.Simple?.Attachments, [{ FileName: "receipt-test.pdf", ContentType: "application/pdf",
    RawContent: content, ContentDisposition: "ATTACHMENT", ContentTransferEncoding: "BASE64" }]);
  assert.deepEqual(command?.input.Destination, { ToAddresses: ["customer@example.com"] });
});

test("invalid PDF, oversized attachment and unsafe filename are rejected before sending", async () => {
  const valid = { fileName: "receipt-test.pdf", contentType: "application/pdf" as const, content: Buffer.from("%PDF-1.7\n%%EOF") };
  for (const attachment of [{ ...valid, fileName: "a.pdf\r\nBcc: other@example.com" }, { ...valid, fileName: "../receipt.pdf" },
    { ...valid, content: Buffer.from("not a pdf") }, { ...valid, content: Buffer.alloc(4 * 1024 * 1024 + 1) }]) {
    let sends = 0;
    await assert.rejects(() => sendTextEmail({ to: "customer@example.com", subject: "PDF", text: "body", attachments: [attachment] },
      { transport: async () => { sends++; return { messageId: "unexpected" }; } }),
    (error: unknown) => error instanceof SesMailError && error.code === "INVALID_MESSAGE");
    assert.equal(sends, 0);
  }
});
