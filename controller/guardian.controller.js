import crypto from "crypto";
import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import { Account } from "../model/account.model.js";
import { Guardian } from "../model/guardian.model.js";
import { GuardianAccount } from "../model/guardianAccount.model.js";
import { GuardianDeletionRequest } from "../model/guardianDeletionRequest.model.js";
import { User } from "../model/user.model.js";
import catchAsync from "../utils/catchAsync.js";
import { generateOTP } from "../utils/commonMethod.js";
import { createAndEmitNotification } from "../utils/notification.js";
import { sendEmail } from "../utils/sendEmail.js";
import sendResponse from "../utils/sendResponse.js";
import { emitToUser } from "../utils/socket.js";

const hashOtp = (otp) => crypto.createHash("sha256").update(otp).digest("hex");
const GUARDIAN_DELETE_OTP_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const userLabel = (user) => user?.name || user?.email || "User";

// Resolves the requester's current primary guardian and the app account
// behind it (if the protector has one), the same way accounts' removal
// flow finds who has to approve.
const findPrimaryGuardianForUser = async (userId) => {
  const guardian = await Guardian.findOne({
    user: userId,
    isPrimary: true,
    status: "accepted",
  });
  if (!guardian) return null;

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

const guardianDeletionRequestActions = (guardianId, requestId) => ({
  sendOtp: `/api/v1/guardians/${guardianId}/delete/${requestId}/send-otp`,
});

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

// Cancels a still-pending invite before the protector has responded to it.
// An already-accepted guardian can't be removed this way — that must go
// through the guardian-approval flow (requestGuardianDeletion /
// sendGuardianDeletionOtp / verifyGuardianDeletionOtp), the same
// guardian-first pattern used to remove a protected account.
export const deleteGuardian = catchAsync(async (req, res) => {
  const { id } = req.params;

  const guardian = await Guardian.findOne({ _id: id, user: req.user._id });
  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Guardian not found");
  }

  if (guardian.status !== "pending") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Use the guardian-approved removal flow"
    );
  }

  if (guardian.protectorUser) {
    const requesterName = userLabel(req.user);
    await createAndEmitNotification({
      recipient: guardian.protectorUser,
      sender: req.user._id,
      type: "guardian_invite_cancelled",
      title: "Guardian invite cancelled",
      body: `${requesterName} withdrew their guardian invite.`,
      data: { guardianId: guardian._id },
    });
  }

  await guardian.deleteOne();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Invite cancelled",
    data: null,
  });
});

// Re-notifies a still-pending invite that hasn't been responded to yet.
// Doesn't touch requestedAccounts — just pushes a fresh guardian_invite so
// there's an easy, obvious one to act on again. The client drops the
// earlier unresponded invite for this guardianId the moment this one
// arrives, so the protector only ever sees one live invite per person.
export const resendGuardianInvite = catchAsync(async (req, res) => {
  const { id } = req.params;

  const guardian = await Guardian.findOne({
    _id: id,
    user: req.user._id,
    status: "pending",
  });
  if (!guardian) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      "Pending guardian invite not found"
    );
  }

  const accounts = await Account.find({
    _id: { $in: guardian.requestedAccounts || [] },
  });

  const requesterName = userLabel(req.user);
  const guardianRole = guardian.isPrimary ? "primary" : "secondary";
  await createAndEmitNotification({
    recipient: guardian.protectorUser,
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

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Invite resent",
    data: { guardianId: guardian._id },
  });
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

// Guardian removal now runs guardian-first, mirroring account removal: the
// owner notifies their primary guardian, the guardian approves in-app
// (pushing the OTP to the owner in real time over the socket + email/push),
// and the owner enters that OTP to finish. If the guardian being removed IS
// the current primary, they end up approving their own removal — there's no
// other primary to ask, and it still stops the owner from unilaterally
// dropping their primary guardian without that guardian's own confirmation.
export const requestGuardianDeletion = catchAsync(async (req, res) => {
  const { id } = req.params;

  const guardian = await Guardian.findOne({ _id: id, user: req.user._id });
  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Guardian not found");
  }

  const primaryGuardian = await findPrimaryGuardianForUser(req.user._id);
  if (!primaryGuardian) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "A primary guardian is required to remove a guardian"
    );
  }

  const deletionRequest = await GuardianDeletionRequest.findOneAndUpdate(
    {
      guardian: guardian._id,
      user: req.user._id,
      status: { $in: ["notified", "otp_sent"] },
    },
    {
      $set: {
        guardian: guardian._id,
        user: req.user._id,
        primaryGuardian: primaryGuardian.guardian._id,
        primaryGuardianUser: primaryGuardian.protectorUser._id,
        otpHash: "",
        status: "notified",
      },
      $unset: { otpExpiresAt: "", otpSentAt: "", verifiedAt: "" },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  const requesterName = userLabel(req.user);

  await createAndEmitNotification({
    recipient: primaryGuardian.protectorUser._id,
    sender: req.user._id,
    type: "guardian_deletion_requested",
    title: "Guardian removal approval needed",
    body: `${requesterName} wants to remove ${guardian.name} as a guardian and needs your approval.`,
    data: {
      requestId: deletionRequest._id,
      guardian: {
        id: guardian._id,
        name: guardian.name,
        isPrimary: guardian.isPrimary,
      },
      requester: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
      },
      actions: guardianDeletionRequestActions(guardian._id, deletionRequest._id),
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Your primary guardian was notified to approve this removal",
    data: { requestId: deletionRequest._id },
  });
});

// Guardian-invoked. Accept both "notified" (first send) and "otp_sent"
// (guardian re-sending) so the button keeps working on repeat taps.
export const sendGuardianDeletionOtp = catchAsync(async (req, res) => {
  const { id, requestId } = req.params;

  const deletionRequest = await GuardianDeletionRequest.findOne({
    _id: requestId,
    guardian: id,
    primaryGuardianUser: req.user._id,
    status: { $in: ["notified", "otp_sent"] },
  }).populate("guardian user");

  if (!deletionRequest?.guardian) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      "No active removal request to approve for this guardian"
    );
  }

  const otp = generateOTP(6);
  deletionRequest.otpHash = hashOtp(otp);
  deletionRequest.otpExpiresAt = new Date(
    Date.now() + GUARDIAN_DELETE_OTP_WINDOW_MS
  );
  deletionRequest.otpSentAt = new Date();
  deletionRequest.status = "otp_sent";
  await deletionRequest.save();

  let emailSent = true;
  try {
    await sendEmail({
      email: deletionRequest.user.email,
      subject: "Guardian Removal OTP",
      message: `Your primary guardian approved removing ${deletionRequest.guardian.name} as a guardian. Your OTP is: ${otp}`,
    });
  } catch (error) {
    emailSent = false;
    console.error("Guardian deletion OTP email failed:", error);
  }

  await trySendPushNotification(
    [deletionRequest.user._id],
    "Guardian removal OTP",
    `Your guardian removal OTP is ${otp}`
  );

  await createAndEmitNotification({
    recipient: deletionRequest.user._id,
    sender: req.user._id,
    type: "guardian_deletion_otp_required",
    title: "Guardian removal OTP sent",
    body: `${userLabel(req.user)} approved removing ${deletionRequest.guardian.name}. Your OTP is ${otp}.`,
    data: {
      requestId: deletionRequest._id,
      guardian: {
        id: deletionRequest.guardian._id,
        name: deletionRequest.guardian.name,
      },
      guardianApprover: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
      },
      expiresAt: deletionRequest.otpExpiresAt,
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "OTP sent to the account owner",
    data: {
      requestId: deletionRequest._id,
      expiresAt: deletionRequest.otpExpiresAt,
      emailSent,
      ...(process.env.NODE_ENV !== "production" ? { debugOtp: otp } : {}),
    },
  });
});

export const verifyGuardianDeletionOtp = catchAsync(async (req, res) => {
  const { id, requestId } = req.params;
  const { otp } = req.body;

  if (!otp) {
    throw new AppError(httpStatus.BAD_REQUEST, "OTP is required");
  }

  const deletionRequest = await GuardianDeletionRequest.findOne({
    _id: requestId,
    guardian: id,
    user: req.user._id,
    status: "otp_sent",
  }).populate("guardian primaryGuardianUser");

  if (!deletionRequest?.guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Guardian removal request not found");
  }

  if (
    !deletionRequest.otpHash ||
    deletionRequest.otpHash !== hashOtp(otp) ||
    deletionRequest.otpExpiresAt?.getTime() < Date.now()
  ) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid or expired OTP");
  }

  deletionRequest.verifiedAt = new Date();
  deletionRequest.status = "deleted";
  await deletionRequest.save();

  const guardian = deletionRequest.guardian;
  const wasPrimary = guardian.isPrimary;

  await GuardianAccount.deleteMany({ guardian: guardian._id });
  await guardian.deleteOne();

  // If the deleted guardian was primary and exactly one guardian remains,
  // that guardian automatically takes over as primary rather than leaving
  // the user with no primary guardian at all.
  if (wasPrimary) {
    const remainingGuardians = await Guardian.find({ user: req.user._id });
    if (remainingGuardians.length === 1) {
      remainingGuardians[0].isPrimary = true;
      await remainingGuardians[0].save();
    }
  }

  const confirmationPayload = {
    requestId: deletionRequest._id,
    guardian: { id: guardian._id, name: guardian.name },
  };

  await Promise.all([
    createAndEmitNotification({
      recipient: req.user._id,
      sender: deletionRequest.primaryGuardianUser._id,
      type: "guardian_deletion_completed",
      title: "Guardian removed",
      body: `${guardian.name} was removed as your guardian.`,
      data: confirmationPayload,
    }),
    createAndEmitNotification({
      recipient: deletionRequest.primaryGuardianUser._id,
      sender: req.user._id,
      type: "guardian_deletion_completed",
      title: "Guardian removed",
      body: `${guardian.name} was removed as ${userLabel(req.user)}'s guardian after your approval.`,
      data: confirmationPayload,
    }),
  ]);

  emitToUser(req.user._id, "guardian-deletion:completed", confirmationPayload);
  emitToUser(
    deletionRequest.primaryGuardianUser._id,
    "guardian-deletion:completed",
    confirmationPayload
  );

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
