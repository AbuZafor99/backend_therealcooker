import mongoose, { Schema } from "mongoose";

const accountSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    accountType: {
      type: String,
      enum: ["bank", "wallet"],
      required: true,
    },
    bankName: {
      type: String,
      required: function () {
        return this.accountType === "bank";
      },
    },
    nickname: {
      type: String,
      trim: true,
      default: "",
    },
    imageUrl: {
      type: String,
      trim: true,
      default: "",
    },
    accountNumberEncrypted: {
      type: String,
      required: true,
      trim: true,
    },
    simulatedTransferLimit: {
      type: Number,
      default: 0,
      min: 0,
    },
    isLocked: {
      type: Boolean,
      default: false,
    },
    lockedReason: {
      type: String,
      default: "",
    },
    lockedAt: {
      type: Date,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Indexes
accountSchema.index({ user: 1 });

export const Account = mongoose.model("Account", accountSchema);
