import { Notification } from "../model/notification.model.js";
import { emitToUser } from "./socket.js";

export const createAndEmitNotification = async ({
  recipient,
  sender,
  type,
  title,
  body,
  data = {},
  event = "notification:new",
}) => {
  const notification = await Notification.create({
    recipient,
    sender,
    type,
    title,
    body,
    data,
  });

  emitToUser(recipient, event, notification.toObject());

  // The socket event above only reaches a recipient with the app open and
  // connected; the push is what reaches them when it's backgrounded or
  // killed. Imported dynamically and wrapped here (not a static top-level
  // import) for the same reason the ad hoc trySendPushNotification helpers
  // in account.controller.js/guardian.controller.js do it this way:
  // utils/firebase.js statically imports the Firebase Admin service account
  // JSON, which throws if that file isn't present on this environment — a
  // static import of it here would take the whole server down at boot
  // (createAndEmitNotification is pulled in by nearly every controller)
  // instead of just silently skipping the push.
  try {
    const { sendPushNotification } = await import("./sendPushNotification.js");
    await sendPushNotification([recipient], title, body, { type, data });
  } catch (error) {
    console.error("Push notification skipped:", error);
  }

  return notification;
};
