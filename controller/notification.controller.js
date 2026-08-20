import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import { FCM } from "../model/fcm.model.js";
import { Guardian } from "../model/guardian.model.js";
import { Notification } from "../model/notification.model.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";

export const getNotifications = catchAsync(async (req, res) => {
  const userId = req.user._id;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  const [notifications, total] = await Promise.all([
    Notification.find({ recipient: userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Notification.countDocuments({ recipient: userId }),
  ]);

  // For guardian_invite notifications, check if the guardian was already
  // responded to so the UI can hide Accept/Reject buttons.
  const guardianInvites = notifications.filter(
    (n) => n.type === "guardian_invite" && n.data?.guardianId
  );

  if (guardianInvites.length > 0) {
    const guardianIds = guardianInvites.map((n) => n.data.guardianId);
    const guardians = await Guardian.find({
      _id: { $in: guardianIds },
    }).select("status _id");

    const respondedIds = new Set(
      guardians
        .filter((g) => g.status !== "pending")
        .map((g) => g._id.toString())
    );

    for (const n of guardianInvites) {
      if (respondedIds.has(n.data.guardianId.toString())) {
        n.data.responded = true;
      }
    }
  }

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Notifications fetched successfully",
    data: {
      notifications,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    },
  });
});

export const getUnreadCount = catchAsync(async (req, res) => {
  const count = await Notification.countDocuments({
    recipient: req.user._id,
    isRead: false,
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Unread count fetched successfully",
    data: { count },
  });
});

export const markNotificationRead = catchAsync(async (req, res) => {
  const { id } = req.params;

  const notification = await Notification.findOneAndUpdate(
    { _id: id, recipient: req.user._id },
    { $set: { isRead: true } },
    { new: true }
  );

  if (!notification) {
    throw new AppError(httpStatus.NOT_FOUND, "Notification not found");
  }

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Notification marked as read",
    data: notification,
  });
});

export const markAllNotificationsRead = catchAsync(async (req, res) => {
  await Notification.updateMany(
    { recipient: req.user._id, isRead: false },
    { $set: { isRead: true } }
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "All notifications marked as read",
    data: null,
  });
});

export const registerFcmToken = catchAsync(async (req, res) => {
  const { fcmToken } = req.body;
  if (!fcmToken || typeof fcmToken !== "string") {
    throw new AppError(httpStatus.BAD_REQUEST, "fcmToken is required");
  }

  // Matched on the token alone, not { user, fcmToken }: a device token
  // moving to a different logged-in user (log out, log in as someone else
  // on the same phone) must be reassigned in place, not duplicated —
  // otherwise the previous owner would keep getting this device's pushes.
  await FCM.findOneAndUpdate(
    { fcmToken },
    { user: req.user._id, fcmToken },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Device registered for push notifications",
    data: null,
  });
});

export const unregisterFcmToken = catchAsync(async (req, res) => {
  const { fcmToken } = req.body;
  if (!fcmToken || typeof fcmToken !== "string") {
    throw new AppError(httpStatus.BAD_REQUEST, "fcmToken is required");
  }

  await FCM.deleteOne({ user: req.user._id, fcmToken });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Device unregistered from push notifications",
    data: null,
  });
});
