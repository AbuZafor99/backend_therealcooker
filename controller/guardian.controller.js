import crypto from "crypto";
import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import { Account } from "../model/account.model.js";
import { Guardian } from "../model/guardian.model.js";
import { GuardianAccount } from "../model/guardianAccount.model.js";
import { User } from "../model/user.model.js";
import catchAsync from "../utils/catchAsync.js";
import { generateOTP } from "../utils/commonMethod.js";
import { createAndEmitNotification } from "../utils/notification.js";
import { sendEmail } from "../utils/sendEmail.js";
import sendResponse from "../utils/sendResponse.js";

const hashOtp = (otp) => crypto.createHash("sha256").update(otp).digest("hex");
const GUARDIAN_DELETE_OTP_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

const trySendPushNotification = async (userIds, title, body) => {
  try {
    const { sendPushNotification } = await import(
      "../utils/sendPushNotification.js"
    );
    await sendPushNotification(userIds, title, body);
  } catch (error) {
    console.error("Push notification skipped:", error);
  }
};

const guardianInviteActions = (guardianId) => ({
  accept: `/api/v1/guardians/${guardianId}/accept`,
  reject: `/api/v1/guardians/${guardianId}/reject`,
});

const buildGuardianPayload = async (guardian) => {
  const guardianObject = guardian.toObject ? guardian.toObject() : guardian;
  const linkedAccounts = await GuardianAccount.find({
    guardian: guardianObject._id,
  }).populate("account");
  const requestedAccounts = await Account.find({
    _id: { $in: guardianObject.requestedAccounts || [] },
  });

  return {
    ...guardianObject,
    accounts: linkedAccounts.map((ga) => ga.account),
    requestedAccounts,
  };
};

// A protector is represented by ONE guardian record per requester, but can
// protect many of the requester's accounts. When the same protector is linked
// to additional accounts, merge those accounts into the existing record instead
// of creating a duplicate (or wrongly rejecting the request).
const mergeAccountsIntoGuardian = async (guardian, accounts, requester) => {
  let newAccounts = [];

  if (guardian.status === "pending") {
    // Union the newly requested accounts into the pending invite (dedup by id).
    const existingIds = new Set(
      (guardian.requestedAccounts || []).map((id) => String(id))
    );
    newAccounts = accounts.filter(
      (account) => !existingIds.has(String(account._id))
    );
    if (newAccounts.length > 0) {
      guardian.requestedAccounts = [
        ...(guardian.requestedAccounts || []),
        ...newAccounts.map((account) => account._id),
      ];
      await guardian.save();
    }
  } else {
    // Accepted: the protector already trusts this requester, so link the new
    // accounts directly (same behaviour as updateGuardianAccounts). The
    // composite unique index on GuardianAccount guards against duplicates.
    const existingLinks = await GuardianAccount.find({ guardian: guardian._id });
    const linkedIds = new Set(existingLinks.map((link) => String(link.account)));
    newAccounts = accounts.filter(
      (account) => !linkedIds.has(String(account._id))
    );
    if (newAccounts.length > 0) {
      await GuardianAccount.insertMany(
        newAccounts.map((account) => ({
          guardian: guardian._id,
          account: account._id,
        }))
      );
    }
  }

  if (newAccounts.length > 0 && guardian.protectorUser) {
    const requesterName = requester.name || requester.email;
    await createAndEmitNotification({
      recipient: guardian.protectorUser,
      sender: requester._id,
      type: "guardian_invite",
      title: "Guardian accounts updated",
      body: `${requesterName} added you to protect more of their accounts.`,
      data: {
        guardianId: guardian._id,
        requester: {
          id: requester._id,
          name: requester.name,
          email: requester.email,
        },
        accounts: newAccounts.map((account) => ({
          id: account._id,
          accountType: account.accountType,
          bankName: account.bankName,
        })),
        actions: guardianInviteActions(guardian._id),
      },
    });
  }

  return {
    addedCount: newAccounts.length,
    payload: await buildGuardianPayload(guardian),
  };
};

// Create guardian. Guardians protect all of the requester's accounts.
export const createGuardian = catchAsync(async (req, res) => {
  const { name, email, phone, relationship, isPrimary } = req.body;

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

  if (String(protectorUser._id) === String(req.user._id)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "You cannot add yourself as a guardian"
    );
  }

  const existingGuardians = await Guardian.find({
    user: req.user._id,
    status: { $in: ["pending", "accepted"] },
  });
  const shouldBePrimary = existingGuardians.length === 0 || isPrimary === true;
  const secondaryCount = existingGuardians.filter(
    (guardian) => !guardian.isPrimary
  ).length;
  if (existingGuardians.length >= 4) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "You can have 1 primary and up to 3 secondary guardians"
    );
  }
  if (!shouldBePrimary && secondaryCount >= 3) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "You can add up to 3 secondary guardians"
    );
  }

  const accounts = await Account.find({
    user: req.user._id,
    isActive: true,
  });

  // A protector can guard many of your accounts. If this protector is already
  // linked to you, merge the newly selected accounts into that record instead
  // of rejecting the request. Adding the same person to the same account twice
  // is a no-op (deduped here and by the GuardianAccount unique index).
  const existingGuardian = await Guardian.findOne({
    user: req.user._id,
    protectorUser: protectorUser._id,
    status: { $in: ["pending", "accepted"] },
  });
  if (existingGuardian) {
    if (shouldBePrimary) {
      await Guardian.updateMany(
        { user: req.user._id, _id: { $ne: existingGuardian._id } },
        { isPrimary: false }
      );
      existingGuardian.isPrimary = true;
      await existingGuardian.save();
    }
    const { addedCount, payload } = await mergeAccountsIntoGuardian(
      existingGuardian,
      accounts,
      req.user
    );
    sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message:
        addedCount > 0
          ? "Guardian updated with the selected account(s)"
          : "This guardian already protects the selected account(s)",
      // alreadyLinked lets the client show a "already a guardian for this
      // account" notice instead of the success/confirm flow.
      data: { ...payload, addedCount, alreadyLinked: addedCount === 0 },
    });
    return;
  }

  if (shouldBePrimary) {
    await Guardian.updateMany({ user: req.user._id }, { isPrimary: false });
  }

  // Create a pending invite. Account links are created only after acceptance.
  const guardian = await Guardian.create({
    user: req.user._id,
    protectorUser: protectorUser._id,
    name,
    email,
    phone,
    relationship,
    isPrimary: shouldBePrimary,
    status: "pending",
    requestedAccounts: accounts.map((account) => account._id),
  });

  const requesterName = req.user.name || req.user.email;
  const guardianRole = guardian.isPrimary ? "primary" : "secondary";
  await createAndEmitNotification({
    recipient: protectorUser._id,
    sender: req.user._id,
    type: "guardian_invite",
    title: "Guardian invite",
    body: `${requesterName} invited you to be their ${guardianRole} guardian.`,
    data: {
      guardianId: guardian._id,
      requester: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
      },
      accounts: accounts.map((account) => ({
        id: account._id,
        accountType: account.accountType,
        bankName: account.bankName,
      })),
      actions: guardianInviteActions(guardian._id),
    },
  });

  const guardianWithAccounts = await buildGuardianPayload(guardian);

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Guardian invite sent successfully",
    data: guardianWithAccounts,
  });
});

// Get all guardians of logged-in user with their accounts
export const getGuardians = catchAsync(async (req, res) => {
  const guardians = await Guardian.find({ user: req.user._id });

  const result = await Promise.all(
    guardians.map((guardian) => buildGuardianPayload(guardian))
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

  const result = await buildGuardianPayload(guardian);

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

// Direct delete is blocked — removing a guardian must go through the OTP
// flow below (sendGuardianDeletionOtp / verifyGuardianDeletionOtp) so the
// owner has to confirm with a code sent to their own email + push.
export const deleteGuardian = catchAsync(async (req, res) => {
  throw new AppError(
    httpStatus.BAD_REQUEST,
    "Use the OTP-verified guardian removal flow"
  );
});

// Switch which guardian is primary. Only one guardian can be primary at a
// time, so this demotes whichever one currently holds it.
export const makeGuardianPrimary = catchAsync(async (req, res) => {
  const { id } = req.params;

  const guardian = await Guardian.findOne({
    _id: id,
    user: req.user._id,
    status: "accepted",
  });
  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Connected guardian not found");
  }

  if (!guardian.isPrimary) {
    await Guardian.updateMany(
      { user: req.user._id, isPrimary: true, _id: { $ne: guardian._id } },
      { $set: { isPrimary: false } }
    );
    guardian.isPrimary = true;
    await guardian.save();
  }

  const result = await buildGuardianPayload(guardian);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Primary guardian updated",
    data: result,
  });
});

export const sendGuardianDeletionOtp = catchAsync(async (req, res) => {
  const { id } = req.params;

  const guardian = await Guardian.findOne({ _id: id, user: req.user._id });
  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Guardian not found");
  }

  const otp = generateOTP(6);
  guardian.deletionOtpHash = hashOtp(otp);
  guardian.deletionOtpExpiresAt = new Date(
    Date.now() + GUARDIAN_DELETE_OTP_WINDOW_MS
  );
  await guardian.save();

  let emailSent = true;
  try {
    await sendEmail({
      email: req.user.email,
      subject: "Remove Guardian OTP",
      message: `Your OTP to remove ${guardian.name} as a guardian is: ${otp}`,
    });
  } catch (error) {
    emailSent = false;
    console.error("Guardian deletion OTP email failed:", error);
  }

  // Sent at the same time as the email, not as a fallback.
  await trySendPushNotification(
    [req.user._id],
    "Remove guardian OTP",
    `Your OTP to remove ${guardian.name} is ${otp}`
  );

  // In-app notification (Notifications tab / top snackbar / socket) — the
  // email and native push above don't reach the app's own notification
  // system, so without this the OTP never shows up there.
  await createAndEmitNotification({
    recipient: req.user._id,
    sender: req.user._id,
    type: "guardian_deletion_otp_sent",
    title: "Guardian removal OTP sent",
    body: `Your OTP to remove ${guardian.name} as a guardian is ${otp}.`,
    data: {
      guardianId: guardian._id,
      guardianName: guardian.name,
      expiresAt: guardian.deletionOtpExpiresAt,
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "OTP sent",
    data: {
      guardianId: guardian._id,
      expiresAt: guardian.deletionOtpExpiresAt,
      emailSent,
      ...(process.env.NODE_ENV !== "production" ? { debugOtp: otp } : {}),
    },
  });
});

export const verifyGuardianDeletionOtp = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { otp } = req.body;

  if (!otp) {
    throw new AppError(httpStatus.BAD_REQUEST, "OTP is required");
  }

  const guardian = await Guardian.findOne({ _id: id, user: req.user._id });
  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Guardian not found");
  }

  if (
    !guardian.deletionOtpHash ||
    guardian.deletionOtpHash !== hashOtp(otp) ||
    guardian.deletionOtpExpiresAt?.getTime() < Date.now()
  ) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid or expired OTP");
  }

  await GuardianAccount.deleteMany({ guardian: guardian._id });
  await guardian.deleteOne();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Guardian removed successfully",
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

  if (guardian.status === "pending") {
    guardian.requestedAccounts = accountIds;
    await guardian.save();

    const updated = await buildGuardianPayload(guardian);
    sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Pending guardian invite accounts updated successfully",
      data: updated,
    });
    return;
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

export const acceptGuardianInvite = catchAsync(async (req, res) => {
  const { id } = req.params;

  const guardian = await Guardian.findOne({
    _id: id,
    protectorUser: req.user._id,
    status: "pending",
  }).populate("user", "name email");

  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Pending guardian invite not found");
  }

  const accounts = await Account.find({
    user: guardian.user._id,
    isActive: true,
  });
  const accountIds = accounts.map((account) => account._id);

  if (accountIds.length > 0) {
    // Only clear THIS guardian's stale links for these accounts. Scoping by
    // guardian keeps other guardians that protect the same accounts intact
    // (an account may have several guardians).
    await GuardianAccount.deleteMany({
      guardian: guardian._id,
      account: { $in: accountIds },
    });
    await GuardianAccount.insertMany(
      accountIds.map((accountId) => ({
        guardian: guardian._id,
        account: accountId,
      }))
    );
  }

  guardian.status = "accepted";
  guardian.requestedAccounts = accountIds;
  guardian.respondedAt = new Date();
  await guardian.save();

  const protectorName = req.user.name || req.user.email;
  await createAndEmitNotification({
    recipient: guardian.user._id,
    sender: req.user._id,
    type: "guardian_invite_accepted",
    title: "Guardian invite accepted",
    body: `${protectorName} accepted your guardian invite.`,
    data: {
      guardianId: guardian._id,
      protector: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
      },
      accounts: accounts.map((account) => ({
        id: account._id,
        accountType: account.accountType,
        bankName: account.bankName,
      })),
    },
  });

  const updatedGuardian = await Guardian.findById(guardian._id);
  const result = await buildGuardianPayload(updatedGuardian);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Guardian invite accepted successfully",
    data: result,
  });
});

export const rejectGuardianInvite = catchAsync(async (req, res) => {
  const { id } = req.params;

  const guardian = await Guardian.findOne({
    _id: id,
    protectorUser: req.user._id,
    status: "pending",
  }).populate("user", "name email");

  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Pending guardian invite not found");
  }

  const accounts = await Account.find({
    _id: { $in: guardian.requestedAccounts || [] },
  });
  const requesterId = guardian.user._id;
  const protectorName = req.user.name || req.user.email;

  // Build the response payload before deleting — the Flutter client parses
  // this the same way it parses acceptGuardianInvite's response, so it must
  // not be null (the guardian doc won't exist anymore once we delete it).
  guardian.status = "rejected";
  const result = await buildGuardianPayload(guardian);

  await guardian.deleteOne();

  await createAndEmitNotification({
    recipient: requesterId,
    sender: req.user._id,
    type: "guardian_invite_rejected",
    title: "Guardian invite rejected",
    body: `${protectorName} rejected your guardian invite.`,
    data: {
      guardianId: id,
      protector: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
      },
      accounts: accounts.map((account) => ({
        id: account._id,
        accountType: account.accountType,
        bankName: account.bankName,
      })),
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Guardian invite rejected successfully",
    data: result,
  });
});
