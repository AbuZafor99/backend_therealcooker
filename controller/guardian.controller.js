import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import httpStatus from "http-status";
import sendResponse from "../utils/sendResponse.js";
import { Guardian } from "../model/guardian.model.js";
import { Account } from "../model/account.model.js";
import { GuardianAccount } from "../model/guardianAccount.model.js";
import { User } from "../model/user.model.js";

// Create guardian with selected accountIds
export const createGuardian = catchAsync(async (req, res) => {
  const { name, email, phone, relationship, accountIds } = req.body;

  if (!name || !email || !phone) {
    throw new AppError(httpStatus.BAD_REQUEST, "Missing required fields");
  }

  // The protector must already be a registered user on the platform
  const protectorUser = await User.findOne({ email });
  if (!protectorUser) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Protector must have an active account"
    );
  }

  // Create guardian
  const guardian = await Guardian.create({
    user: req.user._id,
    name,
    email,
    phone,
    relationship,
  });

  // Link accounts if provided
  if (accountIds && Array.isArray(accountIds) && accountIds.length > 0) {
    // Verify that all accountIds belong to this user and are not already linked to another guardian
    const accounts = await Account.find({
      _id: { $in: accountIds },
      user: req.user._id,
    });
    if (accounts.length !== accountIds.length) {
      throw new AppError(httpStatus.BAD_REQUEST, "One or more accounts not found or don't belong to you");
    }

    // Check if any of these accounts are already linked to another guardian
    const linked = await GuardianAccount.find({ account: { $in: accountIds } });
    if (linked.length > 0) {
      // Option: either throw error or allow re-assignment (we'll remove old links)
      // For simplicity, we'll remove old links and assign to new guardian
      await GuardianAccount.deleteMany({ account: { $in: accountIds } });
    }

    // Create junction entries
    const entries = accountIds.map((accountId) => ({
      guardian: guardian._id,
      account: accountId,
    }));
    await GuardianAccount.insertMany(entries);
  }

  // Populate guardian with accounts via the junction collection
  const linkedAccounts = await GuardianAccount.find({ guardian: guardian._id })
    .populate("account");

  const guardianWithAccounts = {
    ...guardian.toObject(),
    accounts: linkedAccounts.map((ga) => ga.account),
  };

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Guardian created and accounts linked successfully",
    data: guardianWithAccounts,
  });
});

// Get all guardians of logged-in user with their accounts
export const getGuardians = catchAsync(async (req, res) => {
  const guardians = await Guardian.find({ user: req.user._id });

  // Populate accounts via junction
  const result = await Promise.all(
    guardians.map(async (g) => {
      const accounts = await GuardianAccount.find({ guardian: g._id })
        .populate("account");
      return {
        ...g.toObject(),
        accounts: accounts.map(ga => ga.account),
      };
    })
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Guardians fetched successfully",
    data: result,
  });
});

// Get single guardian with accounts
export const getGuardian = catchAsync(async (req, res) => {
  const { id } = req.params;
  const guardian = await Guardian.findOne({ _id: id, user: req.user._id });
  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Guardian not found");
  }

  const accounts = await GuardianAccount.find({ guardian: guardian._id })
    .populate("account");

  const result = {
    ...guardian.toObject(),
    accounts: accounts.map(ga => ga.account),
  };

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Guardian fetched successfully",
    data: result,
  });
});

// Update guardian info
export const updateGuardian = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, relationship } = req.body;

  const guardian = await Guardian.findOne({ _id: id, user: req.user._id });
  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Guardian not found");
  }

  if (name) guardian.name = name;
  if (email) guardian.email = email;
  if (phone) guardian.phone = phone;
  if (relationship) guardian.relationship = relationship;

  await guardian.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Guardian updated successfully",
    data: guardian,
  });
});

// Delete guardian (cascade removes junction entries)
export const deleteGuardian = catchAsync(async (req, res) => {
  const { id } = req.params;
  const guardian = await Guardian.findOne({ _id: id, user: req.user._id });
  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Guardian not found");
  }

  // Remove junction entries
  await GuardianAccount.deleteMany({ guardian: guardian._id });
  // Delete guardian
  await guardian.deleteOne();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Guardian deleted successfully",
    data: null,
  });
});

// Add/remove accounts to an existing guardian
export const updateGuardianAccounts = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { accountIds } = req.body; // array of account IDs to link

  if (!accountIds || !Array.isArray(accountIds)) {
    throw new AppError(httpStatus.BAD_REQUEST, "accountIds array required");
  }

  const guardian = await Guardian.findOne({ _id: id, user: req.user._id });
  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Guardian not found");
  }

  // Verify accounts belong to user
  const accounts = await Account.find({
    _id: { $in: accountIds },
    user: req.user._id,
  });
  if (accounts.length !== accountIds.length) {
    throw new AppError(httpStatus.BAD_REQUEST, "One or more accounts not found");
  }

  // Remove existing links for this guardian
  await GuardianAccount.deleteMany({ guardian: guardian._id });

  // Create new links
  if (accountIds.length > 0) {
    const entries = accountIds.map((accountId) => ({
      guardian: guardian._id,
      account: accountId,
    }));
    await GuardianAccount.insertMany(entries);
  }

  // Return updated guardian with accounts
  const updated = await Guardian.findById(guardian._id);
  const updatedAccounts = await GuardianAccount.find({ guardian: guardian._id })
    .populate("account");

  const result = {
    ...updated.toObject(),
    accounts: updatedAccounts.map(ga => ga.account),
  };

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Guardian accounts updated successfully",
    data: result,
  });
});