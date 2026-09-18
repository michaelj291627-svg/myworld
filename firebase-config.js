/**
 * Firebase configuration for "My World".
 *
 * HOW TO FILL THIS IN
 * -------------------
 * 1. Go to https://console.firebase.google.com and create a project.
 * 2. Add a Web App (</> icon). Copy the "firebaseConfig" values it shows.
 * 3. Paste them below (replace the REPLACE_ME placeholders).
 * 4. In the console, enable:
 *      - Build > Firestore Database  (Start in test mode for dev)
 *      - Build > Storage             (Start in test mode for dev)
 *
 * NOTE: These web config values are NOT secret — they are safe to commit and
 * are required in the browser. Real security comes from Firestore & Storage
 * *rules* (see firestore.rules / storage.rules and the README).
 */

// Your web app's Firebase configuration (safe to expose in the browser).
// Firebase is initialized in app.js — do not initialize it here.
export const firebaseConfig = {
  apiKey: "AIzaSyCh-XUlkE1PqKsjsDee3hj3vYGFEjU_nCw",
  authDomain: "myworld-8f2a2.firebaseapp.com",
  projectId: "myworld-8f2a2",
  storageBucket: "myworld-8f2a2.firebasestorage.app",
  messagingSenderId: "87479370461",
  appId: "1:87479370461:web:14e85f0f709e78da739134",
};
/**
 * Email(s) that get ADMIN (full read/write) access. Everyone else who registers
 * gets view-only access. To create the admin account:
 *   1. Put the admin email below (and mirror it in firestore.rules & storage.rules).
 *   2. Enable Email/Password sign-in: Firebase Console > Authentication > Sign-in method.
 *   3. Register with this exact email on the app's Register tab — that account is the admin.
 */
export const ADMIN_EMAILS = ["michaelvarghees@gmail.com"];

/** Case-insensitive check for whether an email belongs to an admin. */
export function isAdminEmail(email) {
  if (!email) return false;
  return ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(email.toLowerCase());
}

/** True once the placeholders above have been replaced with real values. */
export const isConfigured = !Object.values(firebaseConfig).some(
  (v) => typeof v === "string" && v.includes("REPLACE_ME")
);
