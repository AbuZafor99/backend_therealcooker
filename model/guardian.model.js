import mongoose, { Schema } from "mongoose";

const guardianSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
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
  },
  { timestamps: true }
);

// Indexes
guardianSchema.index({ user: 1 });

export const Guardian = mongoose.model("Guardian", guardianSchema);