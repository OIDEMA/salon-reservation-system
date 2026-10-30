export class FirebaseRealmError extends Error {
  constructor() { super("Default Firebase authentication realm required"); }
}

/** A Salon tenant is a DB scope, never an Identity Platform UID namespace. */
export async function createDefaultRealmSessionCookie<T>(claims: { firebase?: { tenant?: unknown } }, createCookie: () => Promise<T>): Promise<T> {
  if (claims.firebase?.tenant !== undefined && claims.firebase.tenant !== "") throw new FirebaseRealmError();
  return createCookie();
}
