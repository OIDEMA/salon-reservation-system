import { createHmac } from "node:crypto";

type InvitationTokenSource = { id: string; email: string; expiresAt: Date };

/** The secret must stay available until every outstanding invitation expires. */
export function deriveInvitationToken(invitation: InvitationTokenSource, secret = process.env.INVITATION_TOKEN_KEY ?? "") {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("INVITATION_TOKEN_KEY must contain at least 32 bytes.");
  }
  if (!invitation.id || !invitation.email || !Number.isFinite(invitation.expiresAt.getTime())) {
    throw new Error("Invalid invitation token source.");
  }
  const message = JSON.stringify([invitation.id, invitation.email.toLowerCase(), invitation.expiresAt.toISOString()]);
  return createHmac("sha256", secret).update("tenant-invitation:v1:").update(message).digest("base64url");
}
