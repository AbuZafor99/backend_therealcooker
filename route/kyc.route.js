import express from "express";
import {
  createKycSession,
  dojahWebhook,
  getKycStatus,
} from "../controller/kyc.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

// Not behind protect — Dojah calls this directly, authenticated by its own
// HMAC signature instead of a user's bearer token. Must come before the
// router.use(protect) below.
router.post("/webhook", dojahWebhook);

router.use(protect);

router.post("/session", createKycSession);
router.get("/status", getKycStatus);

export default router;
