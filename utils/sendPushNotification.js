// import { FCM } from "../module/fcm/fcm.model.js";
import { FCM } from "../model/fcm.model.js";
import admin from "./firebase.js";
import { recordIntegrationCall } from "./integrationMetrics.js";
// import User from "../models/User";

export const sendPushNotification = async (
  userIds,
  title,
  body,
  // `type` + `data` mirror the in-app Notification document (see
  // createAndEmitNotification) so the client's notificationTapHandler can
  // route a tapped push exactly the way it routes a tapped in-app item.
  // Callers that only need the plain alert text (e.g. an OTP code) can
  // leave these out — the message is then sent without a `data` block,
  // same as before.
  // `category` only labels the delivery telemetry (e.g. "guardian_alert"); it is not sent.
  { type, data, category } = {}
) => {
  let tokens = [];
  try {
    const users = await FCM.find({
      user: { $in: userIds },
      fcmToken: { $exists: true, $ne: null },
    }).select("fcmToken user");

    tokens = users
      .map((u) => u.fcmToken)
      .filter((token) => typeof token === 'string' && token.length > 0);
    const withDevice = new Set(users.filter((u) => typeof u.fcmToken === "string" && u.fcmToken).map((u) => String(u.user)));
    const noDevice = new Set(userIds.map(String).filter((id) => !withDevice.has(id))).size;

    if (!tokens.length) {
      void recordIntegrationCall("fcm", { category, noDevice });
      return;
    }

    const message = {
      notification: {
        title,
        body,
      },
      // FCM data payload values must all be strings — the object payload
      // is JSON-encoded and decoded back on the client.
      ...(type
        ? { data: { type: String(type), payload: JSON.stringify(data || {}) } }
        : {}),
      tokens,
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    void recordIntegrationCall("fcm", {
      category, noDevice, attempts: tokens.length, accepted: response.successCount, failed: response.failureCount,
      error: response.responses.find((result) => !result.success)?.error?.code,
    });

    console.log("Push sent:", response.successCount);
  } catch (error) {
    // The whole send failed (credentials, network, FCM outage) rather than individual tokens.
    void recordIntegrationCall("fcm", { category, attempts: tokens.length, failed: tokens.length, serviceError: error?.code || "send_failed" });
    console.error("FCM Error:", error);
  }
};