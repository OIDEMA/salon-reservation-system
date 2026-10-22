import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { z } from "zod";

export type InvitationEmail = {
  email: string;
  tenantName: string;
  role: string;
  expiresAt: Date;
  token: string;
};

export class InvitationEmailError extends Error {
  constructor(public readonly code: "INVITATION_EMAIL_NOT_CONFIGURED" | "INVITATION_EMAIL_FAILED") {
    super(code === "INVITATION_EMAIL_NOT_CONFIGURED"
      ? "招待メールの送信設定が完了していません。システム管理者にお問い合わせください。"
      : "招待メールを送信できませんでした。時間をおいて再度お試しください。");
    this.name = "InvitationEmailError";
  }
}

export function invitationEmailConfig(env: NodeJS.ProcessEnv = process.env) {
  const from = env.INVITATION_EMAIL_FROM?.trim();
  const region = env.AWS_REGION?.trim();
  let origin: URL;
  try {
    origin = new URL(env.APP_PUBLIC_ORIGIN ?? "");
    const local = env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if ((origin.protocol !== "https:" && !(local && origin.protocol === "http:")) || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash || !region || !z.string().email().safeParse(from).success) throw new Error();
  } catch { throw new InvitationEmailError("INVITATION_EMAIL_NOT_CONFIGURED"); }
  return { from: from!, region: region!, origin: origin.origin };
}

const roleLabels: Record<string, string> = { OWNER: "オーナー", ADMIN: "管理者", MANAGER: "店舗責任者", STAFF: "スタッフ", VIEWER: "閲覧のみ" };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

export function invitationEmailContent(input: InvitationEmail, origin: string) {
  const name = input.tenantName.replace(/[\r\n]/g, " ");
  const role = roleLabels[input.role] ?? input.role;
  const url = new URL("/accept-invitation", origin);
  url.hash = `token=${input.token}`;
  const expires = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "long", timeStyle: "short" }).format(input.expiresAt);
  const text = `${name}の予約管理アプリに招待されました。\n\n役割：${role}\n招待先：${input.email}\n有効期限：${expires}（日本時間）\n\n以下のリンクを開き、招待先と同じ確認済みメールアドレスでログインして招待を承諾してください。\n${url.href}\n\nリンクは一度だけ承諾できます。心当たりのない場合は、このメールを破棄してください。\nこのメールは自動送信です。返信は受け付けていません。`;
  const html = `<div lang="ja" style="font-family:sans-serif;line-height:1.8;color:#252525;max-width:600px;margin:auto;padding:24px"><h1 style="font-size:22px">${escapeHtml(name)}からのスタッフ招待</h1><p>予約管理アプリに招待されました。</p><p>役割：<strong>${escapeHtml(role)}</strong><br>招待先：${escapeHtml(input.email)}<br>有効期限：${escapeHtml(expires)}（日本時間）</p><p>招待先と同じ確認済みメールアドレスでログインし、招待を承諾してください。</p><p style="margin:28px 0"><a href="${escapeHtml(url.href)}" style="background:#23877d;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">招待を承諾する</a></p><p>ボタンを開けない場合は、次のURLをブラウザーで開いてください。<br><a href="${escapeHtml(url.href)}">${escapeHtml(url.href)}</a></p><p style="font-size:13px;color:#666">リンクは一度だけ承諾できます。心当たりのない場合は、このメールを破棄してください。<br>このメールは自動送信です。返信は受け付けていません。</p></div>`;
  return { subject: `【${name}】予約管理アプリへの招待`, text, html };
}

export async function sendInvitationEmail(input: InvitationEmail): Promise<void> {
  const config = invitationEmailConfig();
  const content = invitationEmailContent(input, config.origin);
  // An ambiguous network failure must not cause an automatic duplicate invitation email.
  const client = new SESv2Client({ region: config.region, maxAttempts: 1 });
  try {
    const result = await client.send(new SendEmailCommand({
      FromEmailAddress: `Beauty Gum <${config.from}>`,
      Destination: { ToAddresses: [input.email] },
      Content: { Simple: {
        Subject: { Data: content.subject, Charset: "UTF-8" },
        Body: { Text: { Data: content.text, Charset: "UTF-8" }, Html: { Data: content.html, Charset: "UTF-8" } }
      } }
    }), { abortSignal: AbortSignal.timeout(10_000) });
    if (!result.MessageId) throw new Error();
  } catch { throw new InvitationEmailError("INVITATION_EMAIL_FAILED"); }
  finally { client.destroy(); }
}
