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

  return notification;
};
