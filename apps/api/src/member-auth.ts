import type { FastifyReply, FastifyRequest } from "fastify";
import { firebaseAdminAuth } from "./auth.js";
import { MEMBER_PROJECT_ID, type MemberIdentity } from "./member-booking-domain.js";

/** Member credentials are Firebase ID tokens, never staff session cookies or shared app keys. */
export async function requireMemberIdentity(request: FastifyRequest, reply: FastifyReply): Promise<MemberIdentity | null> {
  const authorization = request.headers.authorization;
  const match = typeof authorization === "string" && authorization.length <= 8192
    ? /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization) : null;
  if (!match) { reply.code(401).send({ code: "UNAUTHENTICATED", message: "ログインが必要です。" }); return null; }
  try {
    const claims = await firebaseAdminAuth.verifyIdToken(match[1], true);
    if (claims.aud !== MEMBER_PROJECT_ID || claims.iss !== `https://securetoken.google.com/${MEMBER_PROJECT_ID}` ||
      !claims.uid || claims.firebase?.sign_in_provider === "anonymous" ||
      !(claims.email && claims.email_verified === true || claims.phone_number)) {
      reply.code(403).send({ code: "MEMBER_IDENTITY_REQUIRED", message: "本人確認済みのアカウントでログインしてください。" }); return null;
    }
    return { projectId: MEMBER_PROJECT_ID, uid: claims.uid };
  } catch {
    reply.code(401).send({ code: "UNAUTHENTICATED", message: "ログインの有効期限が切れました。もう一度ログインしてください。" }); return null;
  }
}
