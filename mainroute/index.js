import express from "express";
import authRoutes from "../route/auth.route.js";
import accountRoutes from "../route/account.route.js";
import guardianRoutes from "../route/guardian.route.js";
import newsRoutes from "../route/news.route.js";
import termsRoutes from "../route/terms.route.js";
import adminRoutes from "../route/admin.route.js";
import userRoutes from "../route/user.route.js";

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/accounts", accountRoutes);
router.use("/guardians", guardianRoutes);
router.use("/news", newsRoutes);
router.use("/terms", termsRoutes);
router.use("/admin", adminRoutes);
router.use("/users", userRoutes);

export default router;