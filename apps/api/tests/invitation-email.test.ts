import assert from "node:assert/strict";
import test from "node:test";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { InvitationEmailError, invitationEmailConfig, invitationEmailContent, sendInvitationEmail, type InvitationEmail } from "../src/invitation-email.js";

const input: InvitationEmail = { email: "invitee@example.com", tenantName: "メンズジェントル", role: "ADMIN", expiresAt: new Date("2030-01-02T03:00:00Z"), token: "a".repeat(43) };
const env = { NODE_ENV: "production", INVITATION_EMAIL_FROM: "noreply@beauty-gum.jp", AWS_REGION: "ap-northeast-1", APP_PUBLIC_ORIGIN: "https://example.com" };

test("mail configuration requires a verified sender setting and a trusted HTTPS origin", () => {
  assert.deepEqual(invitationEmailConfig(env), { from: env.INVITATION_EMAIL_FROM, region: env.AWS_REGION, origin: env.APP_PUBLIC_ORIGIN });
  for (const patch of [
    { INVITATION_EMAIL_FROM: "" }, { INVITATION_EMAIL_FROM: "bad\r\nBcc:someone@example.com" }, { AWS_REGION: "" },
    { APP_PUBLIC_ORIGIN: "" }, { APP_PUBLIC_ORIGIN: "http://example.com" }, { APP_PUBLIC_ORIGIN: "http://localhost:3000" },
    { APP_PUBLIC_ORIGIN: "https://user:password@example.com" }, { APP_PUBLIC_ORIGIN: "https://example.com/evil" },
    { APP_PUBLIC_ORIGIN: "https://example.com?redirect=evil" }, { APP_PUBLIC_ORIGIN: "https://example.com#evil" }
  ]) assert.throws(() => invitationEmailConfig({ ...env, ...patch }), InvitationEmailError);
  assert.equal(invitationEmailConfig({ ...env, NODE_ENV: "development", APP_PUBLIC_ORIGIN: "http://localhost:3000" }).origin, "http://localhost:3000");
});

test("email includes matching identity, Japanese role, JST deadline and a fragment token", () => {
  const mail = invitationEmailContent(input, env.APP_PUBLIC_ORIGIN);
  assert.match(mail.subject, /メンズジェントル/);
  for (const value of [input.email, "管理者", "2030年1月2日", "12:00", `/accept-invitation#token=${input.token}`]) {
    assert(mail.text.includes(value), value); assert(mail.html.includes(value), value);
  }
  const escaped = invitationEmailContent({ ...input, tenantName: '<script>"&\r\nBcc:test' }, env.APP_PUBLIC_ORIGIN);
  assert(!escaped.html.includes("<script>")); assert(escaped.html.includes("&lt;script&gt;&quot;&amp;")); assert(!/[\r\n]/.test(escaped.subject));
});

test("SES sends only to the invitee, bounds the request and hides provider errors", async (t) => {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if(value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const sent: any[] = [];
  const send = t.mock.method(SESv2Client.prototype, "send", async (command: any, options: any) => {
    sent.push({ command, options }); return { MessageId: "message-1" };
  });
  await sendInvitationEmail(input);
  assert.equal(sent.length, 1); assert(sent[0].command instanceof SendEmailCommand);
  assert.deepEqual(sent[0].command.input.Destination, { ToAddresses: [input.email] });
  assert.equal(sent[0].command.input.FromEmailAddress, "Beauty Gum <noreply@beauty-gum.jp>");
  assert(sent[0].command.input.Content.Simple.Body.Text); assert(sent[0].command.input.Content.Simple.Body.Html);
  assert(sent[0].options.abortSignal instanceof AbortSignal);
  send.mock.mockImplementation(async () => { throw new Error(`provider error with ${input.token}`); });
  await assert.rejects(sendInvitationEmail(input), (error: unknown) => error instanceof InvitationEmailError && error.code === "INVITATION_EMAIL_FAILED" && !error.message.includes(input.token));
  send.mock.mockImplementation(async () => ({}));
  await assert.rejects(sendInvitationEmail(input), InvitationEmailError);
});
