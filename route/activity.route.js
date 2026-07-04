import express from "express";
import { getRecentActivities } from "../controller/activity.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

router.use(protect);

router.get("/recent", getRecentActivities);

export default router;
