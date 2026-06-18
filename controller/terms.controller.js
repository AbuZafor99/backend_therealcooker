import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import httpStatus from "http-status";
import sendResponse from "../utils/sendResponse.js";
import { Terms } from "../model/terms.model.js";

// Get active terms (public)
export const getActiveTerms = catchAsync(async (req, res) => {
  const terms = await Terms.findOne({ isActive: true }).sort({ version: -1 });
  if (!terms) {
    throw new AppError(httpStatus.NOT_FOUND, "No active terms found");
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Terms fetched successfully",
    data: terms,
  });
});

// Admin: get all terms versions
export const getAllTerms = catchAsync(async (req, res) => {
  const terms = await Terms.find().sort({ version: -1 });
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "All terms versions fetched",
    data: terms,
  });
});

// Admin: update or create new version
export const updateTerms = catchAsync(async (req, res) => {
  const { content, version } = req.body;
  if (!content) {
    throw new AppError(httpStatus.BAD_REQUEST, "Content is required");
  }

  // Deactivate all previous
  await Terms.updateMany({}, { isActive: false });

  const newTerms = await Terms.create({
    content,
    version: version || "1.0",
    updatedBy: req.user._id,
    isActive: true,
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Terms updated successfully",
    data: newTerms,
  });
});