// ============================================================
// Lumio config — paste your Firebase web-app values here.
// Firebase console → Project settings → General → Your apps → Web app
// ============================================================
export const FIREBASE_CONFIG = {
  apiKey: "PASTE_YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:0000000000000000",
};

// Region where the Cloud Functions are deployed (functions/index.js uses the same one).
export const FUNCTIONS_REGION = "europe-west1";

// Idle learning: after this many ms without any activity, Lumio starts learning.
export const LEARN_IDLE_MS = 4000;
// Hard cap on learning fetches per user per hour (client and server both enforce it).
export const LEARN_MAX_PER_HOUR = 30;
