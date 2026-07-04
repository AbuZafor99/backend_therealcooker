import express from "express";
import {
  createAccount,
  getAccounts,
  getAccount,
  updateAccount,
  deleteAccount,
  simulateLimitIncrease,
  sendLimitIncreaseOtp,
  verifyLimitIncreaseOtp,
  timeoutLimitIncreaseOtp,
} from "../controller/account.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

router.use(protect); // All routes require authentication

router.route("/")
  .post(createAccount)
  .get(getAccounts);

router.post("/:id/test/increase-limit", simulateLimitIncrease);
router.post(
  "/:id/test/limit-increase-requests/:requestId/send-otp",
  sendLimitIncreaseOtp
);
router.post(
  "/:id/test/limit-increase-requests/:requestId/verify-otp",
  verifyLimitIncreaseOtp
);
router.post(
  "/:id/test/limit-increase-requests/:requestId/timeout",
  timeoutLimitIncreaseOtp
);

router.route("/:id")
  .get(getAccount)
  .put(updateAccount)
  .delete(deleteAccount);

export default router;
