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
    accountNumberEncrypted: {
      type: String,
      required: true,
      trim: true,
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