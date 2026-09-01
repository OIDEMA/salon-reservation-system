import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";

const firebaseApp =
  getApps()[0] ??
  initializeApp({
    credential: applicationDefault(),
    projectId: process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "salon-reserve-bg"
  });

export async function verifyFirebaseCredential(authorization?: string): Promise<DecodedIdToken> {
  const [scheme, credential] = authorization?.split(" ") ?? [];
  if (scheme?.toLowerCase() !== "bearer" || !credential) {
    throw new Error("Missing bearer credential");
  }

  const auth = getAuth(firebaseApp);
  try {
    return await auth.verifySessionCookie(credential, true);
  } catch {
    return auth.verifyIdToken(credential, true);
  }
}
