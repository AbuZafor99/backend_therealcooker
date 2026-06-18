import express from "express";
import {
  createAccount,
  getAccounts,
  getAccount,
  updateAccount,
  deleteAccount,
} from "../controller/account.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

router.use(protect); // All routes require authentication

router.route("/")
  .post(createAccount)
  .get(getAccounts);

router.route("/:id")
  .get(getAccount)
  .put(updateAccount)
  .delete(deleteAccount);

export default router;