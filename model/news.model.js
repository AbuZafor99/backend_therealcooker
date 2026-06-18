import mongoose, { Schema } from "mongoose";

const newsSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      enum: ["tips", "scam_alerts", "fraud_warnings", "alert", "warning"],
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    coverImage: {
      url: { type: String, default: "" },
      public_id: { type: String, default: "" },
    },
    author: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    isPublished: {
      type: Boolean,
      default: true,
    },
    views: {
      type: Number,
      default: 0,
    },
    readTime: {
      type: String,
      default: "8 min ago", // placeholder
    },
  },
  { timestamps: true }
);

export const News = mongoose.model("News", newsSchema);