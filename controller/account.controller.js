import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import httpStatus from "http-status";
import sendResponse from "../utils/sendResponse.js";
import { Account } from "../model/account.model.js";
import { GuardianAccount } from "../model/guardianAccount.model.js";

// Create an account (no guardian relation yet)
export const createAccount = catchAsync(async (req, res) => {
  const { accountType, bankName, accountNumberEncrypted } = req.body;

  if (!accountType || !accountNumberEncrypted) {
    throw new AppError(httpStatus.BAD_REQUEST, "Missing required fields");
  }
  if (accountType === "bank" && !bankName) {
    throw new AppError(httpStatus.BAD_REQUEST, "Bank name is required for bank accounts");
  }

  const account = await Account.create({
    user: req.user._id,
    accountType,
    bankName,
    accountNumberEncrypted,
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Account created successfully",
    data: account,
  });
});

// Get all accounts of logged-in user (with optional guardian info)
export const getAccounts = catchAsync(async (req, res) => {
  const accounts = await Account.find({ user: req.user._id, isActive: true });

  // For each account, check if it's linked to any guardian
  const accountsWithGuardian = await Promise.all(
    accounts.map(async (acc) => {
      const guardianAccount = await GuardianAccount.findOne({ account: acc._id })
        .populate("guardian", "name email phone relationship");
      return {
        ...acc.toObject(),
        guardian: guardianAccount ? guardianAccount.guardian : null,
      };
    })
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Accounts fetched successfully",
    data: accountsWithGuardian,
  });
});

// Get single account
export const getAccount = catchAsync(async (req, res) => {
  const { id } = req.params;
  const account = await Account.findOne({ _id: id, user: req.user._id });
  if (!account) {
    throw new AppError(httpStatus.NOT_FOUND, "Account not found");
  }
  // Check guardian association
  const guardianAccount = await GuardianAccount.findOne({ account: account._id })
    .populate("guardian", "name email phone relationship");
  const result = {
    ...account.toObject(),
    guardian: guardianAccount ? guardianAccount.guardian : null,
  };
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Account fetched successfully",
    data: result,
  });
});

// Update account (only certain fields)
export const updateAccount = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { accountType, bankName, accountNumberEncrypted, isActive } = req.body;

  const account = await Account.findOne({ _id: id, user: req.user._id });
  if (!account) {
    throw new AppError(httpStatus.NOT_FOUND, "Account not found");
  }

  if (accountType) account.accountType = accountType;
  if (bankName) account.bankName = bankName;
  if (accountNumberEncrypted) account.accountNumberEncrypted = accountNumberEncrypted;
  if (isActive !== undefined) account.isActive = isActive;

  await account.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Account updated successfully",
    data: account,
  });
});

// Delete account (soft delete? we set isActive false or remove)
export const deleteAccount = catchAsync(async (req, res) => {
  const { id } = req.params;
  const account = await Account.findOne({ _id: id, user: req.user._id });
  if (!account) {
    throw new AppError(httpStatus.NOT_FOUND, "Account not found");
  }

  // Check if linked to any guardian; we can either prevent deletion or remove relation
  const guardianAccount = await GuardianAccount.findOne({ account: account._id });
  if (guardianAccount) {
    // Option: remove the relation first
    await GuardianAccount.deleteOne({ account: account._id });
  }

  await account.deleteOne();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Account deleted successfully",
    data: null,
  });
});