import mongoose, { Schema } from "mongoose";

const limitIncreaseRequestSchema = new Schema(
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
    guardian: {
      type: Schema.Types.ObjectId,
      ref: "Guardian",
      required: true,
    },
    guardianUser: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    previousLimit: {
      type: Number,
      required: true,
      min: 0,
    },
    requestedLimit: {
      type: Number,
      required: true,
      min: 0,
    },
    attemptNumber: {
      type: Number,
      required: true,
      min: 1,
    },
    status: {
      type: String,
      enum: ["notified", "otp_sent", "approved", "locked"],
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
    lockedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

limitIncreaseRequestSchema.index({ account: 1, createdAt: -1 });
limitIncreaseRequestSchema.index({ guardianUser: 1, status: 1 });

export const LimitIncreaseRequest = mongoose.model(
  "LimitIncreaseRequest",
  limitIncreaseRequestSchema
);
