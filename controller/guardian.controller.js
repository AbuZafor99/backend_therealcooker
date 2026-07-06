import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import { Account } from "../model/account.model.js";
import { Guardian } from "../model/guardian.model.js";
import { GuardianAccount } from "../model/guardianAccount.model.js";
import { User } from "../model/user.model.js";
import catchAsync from "../utils/catchAsync.js";
import { createAndEmitNotification } from "../utils/notification.js";
import sendResponse from "../utils/sendResponse.js";

const guardianInviteActions = (guardianId) => ({
  accept: `/api/v1/guardians/${guardianId}/accept`,
  reject: `/api/v1/guardians/${guardianId}/reject`,
});

const accountLabel = (accounts) => {
  if (!accounts.length) return "your selected account";
  return accounts
    .map((account) => account.bankName || account.accountType)
    .filter(Boolean)
    .join(", ");
};

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
    const accountStr = accountLabel(newAccounts);
    await createAndEmitNotification({
      recipient: guardian.protectorUser,
      sender: requester._id,
      type: "guardian_invite",
      title: "Guardian accounts updated",
      body: `${requesterName} added you as a guardian for ${accountStr}.`,
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

  if (String(protectorUser._id) === String(req.user._id)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "You cannot add yourself as a guardian"
    );
  }

  // Resolve and validate the requested accounts up-front so we can either merge
  // them into an existing guardian or attach them to a brand-new invite.
  let accounts = [];
  const requestedAccountIds = Array.isArray(accountIds) ? accountIds : [];
  if (requestedAccountIds.length > 0) {
    accounts = await Account.find({
      _id: { $in: requestedAccountIds },
      user: req.user._id,
      isActive: true,
    });
    if (accounts.length !== requestedAccountIds.length) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "One or more accounts not found or don't belong to you"
      );
    }
  }

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

  // Create a pending invite. Account links are created only after acceptance.
  const guardian = await Guardian.create({
    user: req.user._id,
    protectorUser: protectorUser._id,
    name,
    email,
    phone,
    relationship,
    status: "pending",
    requestedAccounts: accounts.map((account) => account._id),
  });

  const requesterName = req.user.name || req.user.email;
  const accountStr = accountLabel(accounts);
  await createAndEmitNotification({
    recipient: protectorUser._id,
    sender: req.user._id,
    type: "guardian_invite",
    title: "Guardian invite",
    body: `${requesterName} invited you as a guardian for ${accountStr === "your selected account" ? "their account" : accountStr}.`,
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

  const accountIds = guardian.requestedAccounts || [];
  const accounts = await Account.find({
    _id: { $in: accountIds },
    user: guardian.user._id,
    isActive: true,
  });

  if (accounts.length !== accountIds.length) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "One or more requested accounts are no longer available"
    );
  }

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
    data: null,
  });
});
