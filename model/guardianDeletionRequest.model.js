import mongoose, { Schema } from "mongoose";

const guardianDeletionRequestSchema = new Schema(
  {
    guardian: {
      type: Schema.Types.ObjectId,
      ref: "Guardian",
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
      index: true,
    },
    // "notified"  -> primary guardian was alerted, no OTP issued yet
    // "otp_sent"  -> guardian approved; OTP is live for the account owner
    // "deleted"   -> OTP verified, guardian removed
    status: {
      type: String,
      enum: ["notified", "otp_sent", "deleted"],
      default: "notified",
      index: true,
    },
    otpHash: {
      type: String,
      default: "",
    },
    otpExpiresAt: {
      type: Date,
    },
    otpSentAt: {
      type: Date,
    },
    verifiedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

guardianDeletionRequestSchema.index({ user: 1, guardian: 1, status: 1 });

export const GuardianDeletionRequest = mongoose.model(
  "GuardianDeletionRequest",
  guardianDeletionRequestSchema
);
