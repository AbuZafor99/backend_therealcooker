import mongoose, { Schema } from "mongoose";

const termsSchema = new Schema(
  {
    content: {
      type: String,
      required: true,
    },
    version: {
      type: String,
      default: "1.0",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

export const Terms = mongoose.model("Terms", termsSchema);