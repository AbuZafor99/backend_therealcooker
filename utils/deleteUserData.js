import mongoose from "mongoose";
import AppError from "../errors/AppError.js";
import { User } from "../model/user.model.js";
import { Account } from "../model/account.model.js";
import { Guardian } from "../model/guardian.model.js";
import { GuardianAccount } from "../model/guardianAccount.model.js";
import { FCM } from "../model/fcm.model.js";
import { Notification } from "../model/notification.model.js";
import { EmergencySession } from "../model/emergencySession.model.js";
import { LimitIncreaseRequest } from "../model/limitIncreaseRequest.model.js";
import { AccountDeletionRequest } from "../model/accountDeletionRequest.model.js";
import { GuardianDeletionRequest } from "../model/guardianDeletionRequest.model.js";
import { PrimaryGuardianChangeRequest } from "../model/primaryGuardianChangeRequest.model.js";
import { escapeRegex } from "./reporting.js";

// Permanently removes an app user and the records that only make sense with them, in one transaction.
// Guardian links where they protected someone else are removed too, so that person is not left with a
// guardian who can never approve anything. History (alerts, cases, audit, quiz results, analytics
// events) is kept so reports and the audit trail stay accurate.
export async function deleteUserData(userId) {
  const user = await User.findOne({ _id: userId, role: "user" }).select("email");
  if (!user) throw new AppError(404, "User not found");
  if (await EmergencySession.exists({ user: user._id, status: "active" })) {
    throw new AppError(409, "This user has an active SOS emergency. End it before deleting the user.");
  }

  const session = await mongoose.startSession();
  const removed = {};
  try {
    await session.withTransaction(async () => {
      const opts = { session };
      const accountIds = (await Account.find({ user: user._id }, "_id", opts).lean()).map(row => row._id);
      // Guardians they added, plus links where they are someone else's guardian.
      // Invites are matched by email regardless of letter case.
      const sameEmail = { email: { $regex: `^${escapeRegex(user.email)}$`, $options: "i" } };
      const guardianIds = (await Guardian.find({ $or: [{ user: user._id }, { protectorUser: user._id }, sameEmail] }, "_id", opts).lean()).map(row => row._id);
      const count = async (name, work) => { removed[name] = (await work).deletedCount; };
      await count("guardianAccountLinks", GuardianAccount.deleteMany({ $or: [{ account: { $in: accountIds } }, { guardian: { $in: guardianIds } }] }, opts));
      await count("pendingLimitRequests", LimitIncreaseRequest.deleteMany({ $or: [{ user: user._id }, { guardianUser: user._id }, { guardian: { $in: guardianIds } }, { account: { $in: accountIds } }] }, opts));
      await count("pendingAccountDeletions", AccountDeletionRequest.deleteMany({ $or: [{ user: user._id }, { primaryGuardianUser: user._id }, { primaryGuardian: { $in: guardianIds } }, { account: { $in: accountIds } }] }, opts));
      await count("pendingGuardianDeletions", GuardianDeletionRequest.deleteMany({ $or: [{ user: user._id }, { primaryGuardianUser: user._id }, { guardian: { $in: guardianIds } }, { primaryGuardian: { $in: guardianIds } }] }, opts));
      await count("pendingPrimaryChanges", PrimaryGuardianChangeRequest.deleteMany({ $or: [{ user: user._id }, { currentPrimaryGuardianUser: user._id }, { currentPrimaryGuardian: { $in: guardianIds } }, { proposedPrimaryGuardian: { $in: guardianIds } }] }, opts));
      await count("guardianLinks", Guardian.deleteMany({ _id: { $in: guardianIds } }, opts));
      await count("linkedAccounts", Account.deleteMany({ _id: { $in: accountIds } }, opts));
      await count("pushTokens", FCM.deleteMany({ user: user._id }, opts));
      await count("notifications", Notification.deleteMany({ recipient: user._id }, opts));
      await count("emergencySessions", EmergencySession.deleteMany({ user: user._id }, opts));
      await count("user", User.deleteOne({ _id: user._id }, opts));
    });
  } finally {
    await session.endSession();
  }
  return removed;
}
