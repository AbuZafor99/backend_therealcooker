import mongoose, { Schema } from "mongoose";

const guardianAccountSchema = new Schema(
  {
    guardian: {
      type: Schema.Types.ObjectId,
      ref: "Guardian",
      required: true,
    },
    account: {
      type: Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
  },
  { timestamps: true }
);

// Composite unique index to prevent duplicate assignment
guardianAccountSchema.index({ guardian: 1, account: 1 }, { unique: true });

export const GuardianAccount = mongoose.model("GuardianAccount", guardianAccountSchema);