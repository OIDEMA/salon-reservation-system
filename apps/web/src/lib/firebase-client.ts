"use client";

import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, inMemoryPersistence, setPersistence } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "AIzaSyDbFdE8AqI9DrTHtQdkKEN92TZ57lmv-rw",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "salon-reserve-bg.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "salon-reserve-bg",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "1:42401528382:web:593b5bb1e23940f3052f6f",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "42401528382"
};

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const firebaseAuth = getAuth(app);
// Firebase uses the Auth instance's language code when generating email
// action links and localized templates (including password reset emails).
firebaseAuth.languageCode = "ja";
export const firebaseAuthReady = setPersistence(firebaseAuth, inMemoryPersistence);
