import admin from "firebase-admin";
// Firebase Admin service account key — gitignored, never commit this file.
import serviceAccount from "../moneykee-930a2-firebase-adminsdk-fbsvc-43bcd2f3a1.json" with { type: "json" };

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

export default admin;