import express from "express";
import {
  register,
  login,
  logout,
  refreshToken,
  forgotPassword,
  verifyOTP,
  resetPassword,
  changePassword,
} from "../controller/auth.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

router.post("/register", register); // allow self-registration
router.post("/login", login);
router.post("/logout", protect, logout);
router.post("/refresh-token", refreshToken);
router.post("/forgot-password", forgotPassword);
router.post("/verify-otp", verifyOTP);
router.post("/reset-password", resetPassword);
router.post("/change-password", protect, changePassword);

export default router;