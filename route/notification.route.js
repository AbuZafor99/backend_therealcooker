import express from "express";
import {
  getNotifications,
  getUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
  registerFcmToken,
  unregisterFcmToken,
} from "../controller/notification.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

router.use(protect);

router.get("/", getNotifications);
router.get("/unread-count", getUnreadCount);
router.patch("/read-all", markAllNotificationsRead);
router.patch("/:id/read", markNotificationRead);
router.post("/fcm-token", registerFcmToken);
router.delete("/fcm-token", unregisterFcmToken);

export default router;
