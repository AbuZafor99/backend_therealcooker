import mongoose, { Schema } from "mongoose";

const guardianSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    protectorUser: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
    phone: {
      type: String,
      required: true,
    },
    relationship: {
      type: String,
      enum: ["parent", "spouse", "sibling", "other"],
      default: "other",
    },
    isPrimary: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ["pending", "accepted"],
      default: "pending",
    },
    requestedAccounts: [
      {
        type: Schema.Types.ObjectId,
        ref: "Account",
      },
    ],
    respondedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

// Indexes
guardianSchema.index({ user: 1 });
guardianSchema.index({ protectorUser: 1 });
guardianSchema.index({ user: 1, protectorUser: 1, status: 1 });

export const Guardian = mongoose.model("Guardian", guardianSchema);
