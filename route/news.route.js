import express from "express";
import {
  createNews,
  updateNews,
  deleteNews,
  getNews,
  getNewsById,
} from "../controller/news.controller.js";
import { protect, isAdmin } from "../middleware/auth.middleware.js";
import { upload } from "../middleware/multer.middleware.js";

const router = express.Router();

// Public routes
router.get("/", getNews);
router.get("/:id", getNewsById);

// Admin routes
router.use(protect);
router.use(isAdmin);

router.post("/", upload.single("coverImage"), createNews);
router.put("/:id", upload.single("coverImage"), updateNews);
router.delete("/:id", deleteNews);

export default router;