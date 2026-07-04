import mongoose, { Schema } from "mongoose";

const fcmSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    fcmToken: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { timestamps: true }
);

fcmSchema.index({ user: 1, fcmToken: 1 }, { unique: true });

export const FCM = mongoose.model("FCM", fcmSchema);
