// ============================================================
// Lumio config — Firebase web-app values for project lumio-949e8.
// These are public web settings. Security comes from the Firestore rules and Auth, not from hiding them.
// ============================================================
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBkSr4hN8GQridgJRJoheeUtW_QskYKw5Q",
  authDomain: "lumio-949e8.firebaseapp.com",
  projectId: "lumio-949e8",
  storageBucket: "lumio-949e8.firebasestorage.app",
  messagingSenderId: "199773458113",
  appId: "1:199773458113:web:15025528035a87eb1fce40",
};

// Idle learning: after this many ms without any activity, Lumio starts learning.
export const LEARN_IDLE_MS = 4000;
// Hard cap on learning fetches per user per hour (client and server both enforce it).
export const LEARN_MAX_PER_HOUR = 30;
