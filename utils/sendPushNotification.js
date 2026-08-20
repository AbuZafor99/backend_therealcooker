// import { FCM } from "../module/fcm/fcm.model.js";
import { FCM } from "../model/fcm.model.js";
import admin from "./firebase.js";
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
  { type, data } = {}
) => {
  try {
    const users = await FCM.find({
      user: { $in: userIds },
      fcmToken: { $exists: true, $ne: null },
    }).select("fcmToken");

    const tokens = users
      .map((u) => u.fcmToken)
      .filter((token) => typeof token === 'string' && token.length > 0);

    if (!tokens.length) return;

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

    console.log("Push sent:", response.successCount);
  } catch (error) {
    console.error("FCM Error:", error);
  }
};