import express from "express";
import {
  createGuardian,
  getGuardians,
  getGuardian,
  updateGuardian,
  deleteGuardian,
  updateGuardianAccounts,
} from "../controller/guardian.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

router.use(protect);

router.route("/")
  .post(createGuardian)
  .get(getGuardians);

router.route("/:id")
  .get(getGuardian)
  .put(updateGuardian)
  .delete(deleteGuardian);

// Update accounts for a guardian
router.put("/:id/accounts", updateGuardianAccounts);

export default router;