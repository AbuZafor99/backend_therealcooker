import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import httpStatus from "http-status";
import { User } from "../model/user.model.js";
import { Guardian } from "../model/guardian.model.js";
import { News } from "../model/news.model.js";

export const getDashboardStats = catchAsync(async (req, res) => {
  // Total Users
  const totalUsers = await User.countDocuments();
  // Total Guardians
  const totalGuardians = await Guardian.countDocuments();
  // Total News
  const totalNews = await News.countDocuments();

  // For chart data: we'll generate dummy last 30 days data
  // In real implementation, you'd aggregate from created_at
  // We'll just return sample data matching the UI
  const chartData = {
    labels: ["3 Oct", "10 Oct", "14 Oct", "20 Oct", "23 Oct", "27 Oct", "30 Oct"],
    totalUsers: [1200, 1500, 1800, 2100, 2400, 2700, 3000],
    newJoined: [50, 70, 90, 60, 80, 100, 120],
    totalGuardian: [800, 900, 1000, 1100, 1200, 1300, 1400],
  };

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Dashboard stats fetched",
    data: {
      totalUsers,
      totalGuardians,
      totalNews,
      chartData,
    },
  });
});

// (Optional) admin can get recent users
export const getRecentUsers = catchAsync(async (req, res) => {
  const users = await User.find()
    .sort({ createdAt: -1 })
    .limit(10)
    .select("name email phone createdAt");
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Recent users fetched",
    data: users,
  });
});