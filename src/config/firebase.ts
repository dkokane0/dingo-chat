import { cert, getApps, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { env } from "./env.js";

const existing = getApps()[0];
let serviceAccount: ServiceAccount | undefined;
if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try { serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON) as ServiceAccount; }
  catch { throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must contain valid JSON"); }
}
const app = existing ?? initializeApp({
  ...(env.FIREBASE_PROJECT_ID ? { projectId: env.FIREBASE_PROJECT_ID } : {}),
  ...(serviceAccount ? { credential: cert(serviceAccount) } : {})
});
export const firestore = getFirestore(app);
if (env.FIRESTORE_EMULATOR_HOST) firestore.settings({ host: env.FIRESTORE_EMULATOR_HOST, ssl: false });
