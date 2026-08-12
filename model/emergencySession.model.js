import mongoose, { Schema } from "mongoose";

const emergencySessionSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "resolved"],
      default: "active",
      index: true,
    },
    eventLocation: {
      latitude: Number,
      longitude: Number,
    },
    lastKnownLocation: {
      latitude: Number,
      longitude: Number,
    },
    lockedAccounts: [
      {
        type: Schema.Types.ObjectId,
        ref: "Account",
      },
    ],
    userClearOtpHash: {
      type: String,
      default: "",
    },
    userClearOtpExpiresAt: {
      type: Date,
    },
    userClearOtpSentAt: {
      type: Date,
    },
    clearedByRole: {
      type: String,
      enum: ["user", "primary_guardian", ""],
      default: "",
    },
    clearedByUser: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    clearedByGuardian: {
      type: Schema.Types.ObjectId,
      ref: "Guardian",
    },
    clearanceHistory: [
      {
        role: {
          type: String,
          enum: ["user", "primary_guardian"],
          required: true,
        },
        clearedByUser: {
          type: Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        clearedByGuardian: {
          type: Schema.Types.ObjectId,
          ref: "Guardian",
        },
        clearedAt: {
          type: Date,
          required: true,
        },
      },
    ],
    activatedAt: {
      type: Date,
      default: Date.now,
    },
    resolvedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

emergencySessionSchema.index({ user: 1, status: 1, createdAt: -1 });

export const EmergencySession = mongoose.model(
  "EmergencySession",
  emergencySessionSchema
);
