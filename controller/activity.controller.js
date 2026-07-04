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

  const activities = notifications.map((n) => {
    let type = "notification";
    if (n.type?.includes("guardian")) type = "guardian";
    else if (n.type?.includes("limit")) type = "limit";
    else if (n.type?.includes("account_locked")) type = "alert";

    return {
      id: n._id,
      type,
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
