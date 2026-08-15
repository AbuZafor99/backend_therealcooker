import { Guardian } from "../model/guardian.model.js";
import { Notification } from "../model/notification.model.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";

export const getRecentActivities = catchAsync(async (req, res) => {
  const userId = req.user._id;

  // Fetch last 5 notifications for this user
  const notifications = await Notification.find({ recipient: userId })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();

  // Same as getNotifications — mark guardian_invite items already responded
  // to so the Accept/Reject buttons here behave the same as on the
  // Notifications tab instead of staying visible forever.
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

  const activities = notifications.map((n) => {
    let type = "notification";
    if (n.type?.includes("guardian")) type = "guardian";
    else if (n.type?.includes("limit")) type = "limit";
    else if (
      n.type?.includes("account_locked") ||
      n.type?.includes("sos_emergency")
    )
      type = "alert";

    return {
      id: n._id,
      type,
      // Exact notification type + its payload, so the app can navigate to
      // the right screen on tap the same way it does from the Notifications
      // tab — `type` above stays the coarse bucket used for the icon.
      rawType: n.type,
      data: n.data || {},
      title: n.title,
      description: n.body,
      createdAt: n.createdAt,
    };
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Recent activities fetched successfully",
    data: activities,
  });
});
