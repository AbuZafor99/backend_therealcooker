import express from "express";
import {
  createNews,
  updateNews,
  deleteNews,
  getNews,
  getNewsById,
} from "../controller/news.controller.js";
import { protect, isAdmin } from "../middleware/auth.middleware.js";
import { uploadLocal } from "../middleware/multer.middleware.js";

const router = express.Router();

// Public routes
router.get("/", getNews);
router.get("/:id", getNewsById);

// Admin routes
router.use(protect);
router.use(isAdmin);

router.post("/", uploadLocal.single("coverImage"), createNews);
router.put("/:id", uploadLocal.single("coverImage"), updateNews);
router.delete("/:id", deleteNews);

export default router;