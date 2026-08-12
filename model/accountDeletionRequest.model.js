import mongoose, { Schema } from "mongoose";

const accountDeletionRequestSchema = new Schema(
  {
    account: {
      type: Schema.Types.ObjectId,
      ref: "Account",
      required: true,
      index: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    primaryGuardian: {
      type: Schema.Types.ObjectId,
      ref: "Guardian",
      required: true,
    },
    primaryGuardianUser: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    userOtpHash: {
      type: String,
      default: "",
    },
    userOtpExpiresAt: {
      type: Date,
    },
    userVerifiedAt: {
      type: Date,
    },
    guardianOtpHash: {
      type: String,
      default: "",
    },
    guardianOtpExpiresAt: {
      type: Date,
    },
    guardianVerifiedAt: {
      type: Date,
    },
    status: {
      type: String,
      enum: ["user_otp_sent", "guardian_otp_sent", "deleted"],
      default: "user_otp_sent",
      index: true,
    },
  },
  { timestamps: true }
);

accountDeletionRequestSchema.index({ user: 1, account: 1, status: 1 });

export const AccountDeletionRequest = mongoose.model(
  "AccountDeletionRequest",
  accountDeletionRequestSchema
);
