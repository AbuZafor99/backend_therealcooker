import express from "express";
import {
  getActiveTerms,
  getAllTerms,
  updateTerms,
} from "../controller/terms.controller.js";
import { protect, isAdmin } from "../middleware/auth.middleware.js";

const router = express.Router();

// Public
router.get("/", getActiveTerms);

// Admin
router.use(protect);
router.use(isAdmin);
router.get("/all", getAllTerms);
router.put("/", updateTerms);

export default router;