import express from "express";
import {
  getDashboardStats,
  getRecentUsers,
} from "../controller/admin.controller.js";
import { protect, isAdmin } from "../middleware/auth.middleware.js";

const router = express.Router();

router.use(protect, isAdmin);

router.get("/dashboard/stats", getDashboardStats);
router.get("/dashboard/recent-users", getRecentUsers);

export default router;