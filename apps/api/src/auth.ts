import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";

const firebaseApp =
  getApps()[0] ??
  initializeApp({
    credential: applicationDefault(),
    projectId: process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "salon-reserve-bg"
  });

export const firebaseAdminAuth = getAuth(firebaseApp);

/** Salon tenants share the project's default Firebase user pool. Identity
 * Platform tenants have separate UID namespaces and cannot resolve DB users. */
export function assertDefaultFirebaseRealm(claims: DecodedIdToken): void {
  if (claims.firebase?.tenant !== undefined && claims.firebase.tenant !== "") {
    throw new Error("Unsupported Firebase authentication realm");
  }
}

export async function verifyFirebaseCredential(authorization?: string): Promise<DecodedIdToken> {
  const [scheme, credential] = authorization?.split(" ") ?? [];
  if (scheme?.toLowerCase() !== "bearer" || !credential) {
    throw new Error("Missing bearer credential");
  }

  let claims: DecodedIdToken;
  try {
    claims = await firebaseAdminAuth.verifySessionCookie(credential, true);
  } catch {
    claims = await firebaseAdminAuth.verifyIdToken(credential, true);
  }
  // Realm policy failure must not trigger credential-type fallback.
  assertDefaultFirebaseRealm(claims);
  return claims;
}
