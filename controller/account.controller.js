import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import crypto from "crypto";
import httpStatus from "http-status";
import sendResponse from "../utils/sendResponse.js";
import { Account } from "../model/account.model.js";
import { Guardian } from "../model/guardian.model.js";
import { GuardianAccount } from "../model/guardianAccount.model.js";
import { LimitIncreaseRequest } from "../model/limitIncreaseRequest.model.js";
import { User } from "../model/user.model.js";
import { generateOTP } from "../utils/commonMethod.js";
import { createAndEmitNotification } from "../utils/notification.js";
import { sendEmail } from "../utils/sendEmail.js";
import { emitToUser } from "../utils/socket.js";

const hashOtp = (otp) => crypto.createHash("sha256").update(otp).digest("hex");
const OTP_WINDOW_MS = 5 * 60 * 1000;

const parseLimit = (value, fieldName) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `${fieldName} must be a non-negative number`
    );
  }
  return parsed;
};

const getAcceptedGuardianForAccount = async (accountId) => {
  const guardianAccount = await GuardianAccount.findOne({ account: accountId })
    .populate("guardian");

  if (!guardianAccount?.guardian) return null;

  const guardian = guardianAccount.guardian;
  if (guardian.status && guardian.status !== "accepted") return null;

  let protectorUser = null;
  if (guardian.protectorUser) {
    protectorUser = await User.findById(guardian.protectorUser);
  }
  if (!protectorUser && guardian.email) {
    protectorUser = await User.findOne({ email: guardian.email });
  }

  if (!protectorUser) return null;

  return { guardian, protectorUser };
};

const limitRequestActions = (accountId, requestId) => ({
  sendOtp: `/api/v1/accounts/${accountId}/test/limit-increase-requests/${requestId}/send-otp`,
});

const accountSummary = (account) => ({
  id: account._id,
  accountType: account.accountType,
  bankName: account.bankName,
});

const trySendPushNotification = async (userIds, title, body) => {
  try {
    const { sendPushNotification } = await import("../utils/sendPushNotification.js");
    await sendPushNotification(userIds, title, body);
  } catch (error) {
    console.error("Push notification skipped:", error);
  }
};

const userLabel = (user) => user?.name || user?.email || "User";

const lockLimitRequest = async (limitRequest, reason) => {
  const account = limitRequest.account;
  const owner = limitRequest.user;
  const guardianUser = limitRequest.guardianUser;

  account.isLocked = true;
  account.lockedReason = reason;
  account.lockedAt = new Date();
  await account.save();

  limitRequest.status = "locked";
  limitRequest.lockedAt = new Date();
  await limitRequest.save();

  const lockPayload = {
    requestId: limitRequest._id,
    account: accountSummary(account),
    reason,
    user: {
      id: owner._id,
      name: owner.name,
      email: owner.email,
    },
  };

  await Promise.all([
    createAndEmitNotification({
      recipient: owner._id,
      sender: guardianUser._id,
      type: "account_locked",
      title: "Account locked",
      body: "Your account was locked after transfer limit verification failed.",
      data: lockPayload,
    }),
    createAndEmitNotification({
      recipient: guardianUser._id,
      sender: owner._id,
      type: "account_locked",
      title: "Protected account locked",
      body: `${userLabel(owner)}'s account is locked.`,
      data: lockPayload,
    }),
  ]);

  emitToUser(owner._id, "account:locked", lockPayload);
  emitToUser(guardianUser._id, "account:locked", lockPayload);

  return lockPayload;
};

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

// Temporary simulation route. Replace this trigger with the banking API webhook later.
export const simulateLimitIncrease = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { requestedLimit, currentLimit } = req.body;

  const account = await Account.findOne({
    _id: id,
    user: req.user._id,
    isActive: true,
  });
  if (!account) {
    throw new AppError(httpStatus.NOT_FOUND, "Account not found");
  }
  if (account.isLocked) {
    throw new AppError(httpStatus.FORBIDDEN, "Account is locked");
  }

  const nextLimit = parseLimit(requestedLimit, "requestedLimit");
  const previousLimit =
    currentLimit !== undefined
      ? parseLimit(currentLimit, "currentLimit")
      : account.simulatedTransferLimit || 0;

  if (nextLimit <= previousLimit) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "requestedLimit must be greater than the current limit"
    );
  }

  const guardianLink = await getAcceptedGuardianForAccount(account._id);
  if (!guardianLink) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "No accepted guardian is linked to this account"
    );
  }

  const previousAttempts = await LimitIncreaseRequest.countDocuments({
    account: account._id,
  });
  const attemptNumber = previousAttempts + 1;

  const limitRequest = await LimitIncreaseRequest.create({
    account: account._id,
    user: req.user._id,
    guardian: guardianLink.guardian._id,
    guardianUser: guardianLink.protectorUser._id,
    previousLimit,
    requestedLimit: nextLimit,
    attemptNumber,
  });

  const requesterName = req.user.name || req.user.email;
  const secondAttemptOrMore = attemptNumber >= 2;
  const notificationPayload = {
    requestId: limitRequest._id,
    attemptNumber,
    account: accountSummary(account),
    previousLimit,
    requestedLimit: nextLimit,
    expiresAt: secondAttemptOrMore
      ? new Date(limitRequest.createdAt.getTime() + OTP_WINDOW_MS)
      : null,
    requester: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
    },
    guardian: {
      id: guardianLink.protectorUser._id,
      name: guardianLink.protectorUser.name,
      email: guardianLink.protectorUser.email,
    },
    actions: secondAttemptOrMore
      ? limitRequestActions(account._id, limitRequest._id)
      : {},
  };

  if (secondAttemptOrMore) {
    await Promise.all([
      createAndEmitNotification({
        recipient: guardianLink.protectorUser._id,
        sender: req.user._id,
        type: "suspicious_limit_activity",
        title: "Suspicious activity happened",
        body: `${requesterName} tried to increase a transfer limit again.`,
        data: notificationPayload,
      }),
      createAndEmitNotification({
        recipient: req.user._id,
        sender: guardianLink.protectorUser._id,
        type: "limit_increase_otp_required",
        title: "PIN verification required",
        body: "A transfer limit change needs OTP verification.",
        data: notificationPayload,
      }),
    ]);

    emitToUser(req.user._id, "limit-increase:otp-required", notificationPayload);
  } else {
    await Promise.all([
      createAndEmitNotification({
        recipient: guardianLink.protectorUser._id,
        sender: req.user._id,
        type: "limit_increase_first_attempt",
        title: "Limit increase",
        body: `${requesterName} increased a transfer limit from ${previousLimit} to ${nextLimit}.`,
        data: notificationPayload,
      }),
      createAndEmitNotification({
        recipient: req.user._id,
        sender: guardianLink.protectorUser._id,
        type: "limit_increase_first_attempt",
        title: "Limit increase",
        body: `Your transfer limit increase from ${previousLimit} to ${nextLimit} was recorded.`,
        data: notificationPayload,
      }),
    ]);
  }

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: secondAttemptOrMore
      ? "Second limit increase simulation sent to guardian"
      : "Limit increase simulation sent to guardian",
    data: limitRequest,
  });
});

export const sendLimitIncreaseOtp = catchAsync(async (req, res) => {
  const { id, requestId } = req.params;

  const limitRequest = await LimitIncreaseRequest.findOne({
    _id: requestId,
    account: id,
    guardianUser: req.user._id,
    status: "notified",
  }).populate("account user guardian");

  if (!limitRequest) {
    throw new AppError(httpStatus.NOT_FOUND, "Pending limit request not found");
  }

  if (limitRequest.attemptNumber < 2) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "OTP can only be sent from the second limit increase attempt"
    );
  }

  const otp = generateOTP(6);
  limitRequest.otpHash = hashOtp(otp);
  limitRequest.otpExpiresAt = new Date(Date.now() + OTP_WINDOW_MS);
  limitRequest.otpSentAt = new Date();
  limitRequest.status = "otp_sent";
  await limitRequest.save();

  let emailSent = true;
  try {
    await sendEmail({
      email: limitRequest.user.email,
      subject: "Transfer Limit Verification OTP",
      message: `Your OTP for transfer limit verification is: ${otp}`,
    });
  } catch (error) {
    emailSent = false;
    console.error("Limit increase OTP email failed:", error);
  }

  await trySendPushNotification(
    [limitRequest.user._id],
    "Verification PIN",
    `Your transfer limit verification PIN is ${otp}`
  );

  await createAndEmitNotification({
    recipient: limitRequest.user._id,
    sender: req.user._id,
    type: "limit_increase_otp_sent",
    title: "Verification OTP sent",
    body: `${req.user.name || req.user.email} sent an OTP for your transfer limit verification.`,
    data: {
      requestId: limitRequest._id,
      account: accountSummary(limitRequest.account),
      previousLimit: limitRequest.previousLimit,
      requestedLimit: limitRequest.requestedLimit,
      expiresAt: limitRequest.otpExpiresAt,
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "OTP sent to user successfully",
    data: {
      requestId: limitRequest._id,
      expiresAt: limitRequest.otpExpiresAt,
      emailSent,
      ...(process.env.NODE_ENV !== "production" ? { debugOtp: otp } : {}),
    },
  });
});

export const verifyLimitIncreaseOtp = catchAsync(async (req, res) => {
  const { id, requestId } = req.params;
  const { otp } = req.body;

  if (!otp) {
    throw new AppError(httpStatus.BAD_REQUEST, "OTP is required");
  }

  const limitRequest = await LimitIncreaseRequest.findOne({
    _id: requestId,
    account: id,
    user: req.user._id,
    status: "otp_sent",
  }).populate("account guardian guardianUser");

  if (!limitRequest) {
    throw new AppError(httpStatus.NOT_FOUND, "OTP verification request not found");
  }

  if (limitRequest.attemptNumber >= 2) {
    const requestDeadline =
      new Date(limitRequest.createdAt).getTime() + OTP_WINDOW_MS;
    if (Date.now() > requestDeadline) {
      await lockLimitRequest(
        limitRequest,
        "Transfer limit OTP was not submitted within 5 minutes"
      );
      throw new AppError(httpStatus.BAD_REQUEST, "Time expired. Account locked.");
    }
  }

  const account = limitRequest.account;
  const otpExpired =
    limitRequest.otpExpiresAt && limitRequest.otpExpiresAt.getTime() < Date.now();
  const otpInvalid = !limitRequest.otpHash || limitRequest.otpHash !== hashOtp(otp);

  if (otpExpired || otpInvalid) {
    await lockLimitRequest(
      limitRequest,
      otpExpired
        ? "Transfer limit OTP expired"
        : "Transfer limit OTP verification failed"
    );

    throw new AppError(
      httpStatus.BAD_REQUEST,
      otpExpired ? "OTP expired. Account locked." : "Invalid OTP. Account locked."
    );
  }

  account.simulatedTransferLimit = limitRequest.requestedLimit;
  await account.save();

  limitRequest.status = "approved";
  limitRequest.verifiedAt = new Date();
  await limitRequest.save();

  const approvalPayload = {
    requestId: limitRequest._id,
    account: accountSummary(account),
    previousLimit: limitRequest.previousLimit,
    requestedLimit: limitRequest.requestedLimit,
  };

  await Promise.all([
    createAndEmitNotification({
      recipient: req.user._id,
      sender: limitRequest.guardianUser._id,
      type: "limit_increase_approved",
      title: "Limit increase approved",
      body: `Your transfer limit was increased to ${limitRequest.requestedLimit}.`,
      data: approvalPayload,
    }),
    createAndEmitNotification({
      recipient: limitRequest.guardianUser._id,
      sender: req.user._id,
      type: "limit_increase_approved",
      title: `${userLabel(req.user)} is safe`,
      body: `${userLabel(req.user)} submitted the OTP successfully and is safe.`,
      data: approvalPayload,
    }),
  ]);

  emitToUser(req.user._id, "limit-increase:approved", approvalPayload);
  emitToUser(limitRequest.guardianUser._id, "limit-increase:approved", approvalPayload);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Limit increase verified successfully",
    data: {
      account,
      request: limitRequest,
    },
  });
});

export const timeoutLimitIncreaseOtp = catchAsync(async (req, res) => {
  const { id, requestId } = req.params;

  const limitRequest = await LimitIncreaseRequest.findOne({
    _id: requestId,
    account: id,
    user: req.user._id,
    status: { $in: ["notified", "otp_sent"] },
  }).populate("account user guardianUser");

  if (!limitRequest) {
    throw new AppError(httpStatus.NOT_FOUND, "Pending limit request not found");
  }

  if (limitRequest.attemptNumber < 2) {
    throw new AppError(httpStatus.BAD_REQUEST, "Only suspicious attempts can time out");
  }

  const requestDeadline =
    new Date(limitRequest.createdAt).getTime() + OTP_WINDOW_MS;
  if (Date.now() < requestDeadline) {
    throw new AppError(httpStatus.BAD_REQUEST, "Verification window is still active");
  }

  const lockPayload = await lockLimitRequest(
    limitRequest,
    "Transfer limit OTP was not submitted within 5 minutes"
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Account locked after verification timeout",
    data: lockPayload,
  });
});
