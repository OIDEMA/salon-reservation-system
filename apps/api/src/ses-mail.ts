import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { fromWebToken, type FromWebTokenInit } from "@aws-sdk/credential-provider-web-identity";

export const SES_REGION = "ap-northeast-1";
export const SES_FROM_EMAIL = "noreply@beauty-gum.jp";
const SES_AWS_ACCOUNT = "243110548344";
const WEB_IDENTITY_AUDIENCE = "sts.amazonaws.com";
const CREDENTIAL_REFRESH_MARGIN_MS = 5 * 60_000;

export type TextEmail = { to: string; subject: string; text: string };
export type SesTextMessage = TextEmail & { from: typeof SES_FROM_EMAIL };
export type TextEmailTransport = (message: SesTextMessage) => Promise<{ messageId: string }>;
type AwsCredentials = Awaited<ReturnType<ReturnType<typeof fromWebToken>>>;

export class SesMailError extends Error {
  constructor(public readonly code: "INVALID_MESSAGE" | "NOT_CONFIGURED" | "AUTH_FAILED" | "SEND_FAILED" | "MESSAGE_REJECTED", public readonly retryable: boolean) {
    super(code);
    this.name = "SesMailError";
  }
}
function validateMessage(input: TextEmail): TextEmail {
  const to = typeof input.to === "string" ? input.to.trim() : "";
  if (to.length > 254 || !/^[^\s@<>"(),;:\\]+@[^\s@<>"(),;:\\]+\.[^\s@<>"(),;:\\]+$/.test(to)) {
    throw new SesMailError("INVALID_MESSAGE", false);
  }
  if (typeof input.subject !== "string" || !input.subject.trim() || input.subject.length > 160 || /[\x00-\x1f\x7f]/.test(input.subject)) {
    throw new SesMailError("INVALID_MESSAGE", false);
  }
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 10_000 || input.text.includes("\0")) {
    throw new SesMailError("INVALID_MESSAGE", false);
  }
  return { to, subject: input.subject, text: input.text };
}

/** Metadata tokens are signed for the Cloud Run service identity, never persisted or logged. */
export async function googleIdentityToken(fetcher: typeof fetch = fetch): Promise<string> {
  const url = new URL("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity");
  url.searchParams.set("audience", WEB_IDENTITY_AUDIENCE);
  let response: Response;
  try {
    response = await fetcher(url, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5000) });
  } catch {
    throw new SesMailError("AUTH_FAILED", true);
  }
  if (!response.ok) throw new SesMailError("AUTH_FAILED", true);
  const token = (await response.text()).trim();
  if (!token || token.length > 32_768) throw new SesMailError("AUTH_FAILED", true);
  return token;
}

export function googleWebIdentityCredentials(options: {
  roleArn: string;
  identityToken?: () => Promise<string>;
  roleAssumerWithWebIdentity?: FromWebTokenInit["roleAssumerWithWebIdentity"];
  now?: () => number;
}): () => Promise<AwsCredentials> {
  const { roleArn, identityToken = googleIdentityToken, roleAssumerWithWebIdentity, now = Date.now } = options;
  if (!new RegExp(`^arn:aws:iam::${SES_AWS_ACCOUNT}:role/[A-Za-z0-9+=,.@_/-]{1,128}$`).test(roleArn)) {
    throw new SesMailError("NOT_CONFIGURED", false);
  }
  let cached: AwsCredentials | undefined;
  let pending: Promise<AwsCredentials> | undefined;
  return async () => {
    if (cached?.expiration && cached.expiration.getTime() - now() > CREDENTIAL_REFRESH_MARGIN_MS) return cached;
    if (!pending) {
      pending = (async () => {
        try {
          const credentials = await fromWebToken({
            roleArn,
            webIdentityToken: await identityToken(),
            roleSessionName: "salon-reserve-email",
            durationSeconds: 3600,
            clientConfig: { region: SES_REGION },
            roleAssumerWithWebIdentity
          })();
          if (!credentials.accessKeyId || !credentials.secretAccessKey || !credentials.sessionToken || !credentials.expiration) {
            throw new SesMailError("AUTH_FAILED", true);
          }
          cached = credentials;
          return credentials;
        } catch {
          throw new SesMailError("AUTH_FAILED", true);
        }
      })().finally(() => { pending = undefined; });
    }
    return pending;
  };
}

type SesClient = { send(command: SendEmailCommand): Promise<{ MessageId?: string }> };

export function sesTextTransport(client: SesClient): TextEmailTransport {
  return async (message) => {
    const result = await client.send(new SendEmailCommand({
      FromEmailAddress: message.from,
      Destination: { ToAddresses: [message.to] },
      Content: { Simple: {
        Subject: { Data: message.subject, Charset: "UTF-8" },
        Body: { Text: { Data: message.text, Charset: "UTF-8" } }
      } }
    }));
    if (!result.MessageId) throw new SesMailError("SEND_FAILED", true);
    return { messageId: result.MessageId };
  };
}

let productionTransport: TextEmailTransport | undefined;
function defaultTransport(): TextEmailTransport {
  if (productionTransport) return productionTransport;
  const roleArn = process.env.AWS_SES_ROLE_ARN;
  if (!roleArn) throw new SesMailError("NOT_CONFIGURED", false);
  const client = new SESv2Client({
    region: SES_REGION,
    credentials: googleWebIdentityCredentials({ roleArn })
  });
  productionTransport = sesTextTransport(client);
  return productionTransport;
}

/** SES acknowledgement is acceptance, not proof of inbox delivery. */
export async function sendTextEmail(input: TextEmail, deps: { transport?: TextEmailTransport } = {}): Promise<{ messageId: string }> {
  const message = validateMessage(input);
  try {
    const response = await (deps.transport ?? defaultTransport())({ ...message, from: SES_FROM_EMAIL });
    if (!response.messageId) throw new SesMailError("SEND_FAILED", true);
    return response;
  } catch (error) {
    if (error instanceof SesMailError) throw error;
    const errorName = error instanceof Error ? error.name : "";
    if (errorName === "MessageRejected" || errorName === "BadRequestException") {
      throw new SesMailError("MESSAGE_REJECTED", false);
    }
    throw new SesMailError("SEND_FAILED", true);
  }
}
