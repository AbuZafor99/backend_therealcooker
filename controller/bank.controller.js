import mongoose from "mongoose";
import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import { Bank } from "../model/bank.model.js";
import { uploadOnCloudinary, deleteFromCloudinary } from "../utils/commonMethod.js";
import { Account } from "../model/account.model.js";

const reply = (res, data, message, statusCode = 200) => sendResponse(res, { statusCode, success: true, message, data });
const normalizeName = value => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
const bankId = value => {
  if (!mongoose.isValidObjectId(value)) throw new AppError(400, "Invalid bank ID");
  return value;
};
const validateImage = file => {
  if (file && !["image/png", "image/jpeg", "image/webp"].includes(file.mimetype)) {
    throw new AppError(400, "Logo must be a PNG, JPEG, or WebP image");
  }
};

export const listPublicBanks = catchAsync(async (_req, res) => {
  const banks = await Bank.find({ isActive: true }).select("name logo.url sortOrder").sort({ sortOrder: 1, name: 1 }).lean();
  reply(res, banks, "Banks fetched");
});

export const listAdminBanks = catchAsync(async (_req, res) => {
  const banks = await Bank.find().sort({ sortOrder: 1, name: 1 }).lean();
  reply(res, banks, "Banks fetched");
});

export const createBank = catchAsync(async (req, res) => {
  const name = normalizeName(req.body.name);
  if (!name || name.length > 120) throw new AppError(400, "Bank name must be 1 to 120 characters");
  if (!req.file) throw new AppError(400, "Bank logo is required");
  validateImage(req.file);
  const nameKey = name.toLocaleLowerCase("en");
  if (await Bank.exists({ nameKey })) throw new AppError(409, "A bank with this name already exists");
  const sortOrder = req.body.sortOrder === undefined ? 0 : Number(req.body.sortOrder);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999) throw new AppError(400, "Sort order must be between 0 and 9999");
  const uploaded = await uploadOnCloudinary(req.file.buffer, { folder: "moneykee/banks", resource_type: "image" });
  const bank = await Bank.create({ name, nameKey, logo: { url: uploaded.secure_url, publicId: uploaded.public_id }, sortOrder });
  reply(res, bank, "Bank created", 201);
});

export const updateBank = catchAsync(async (req, res) => {
  const bank = await Bank.findById(bankId(req.params.id));
  if (!bank) throw new AppError(404, "Bank not found");
  if (req.body.name !== undefined) {
    const name = normalizeName(req.body.name);
    if (!name || name.length > 120) throw new AppError(400, "Bank name must be 1 to 120 characters");
    const nameKey = name.toLocaleLowerCase("en");
    if (nameKey !== bank.nameKey && await Bank.exists({ nameKey })) throw new AppError(409, "A bank with this name already exists");
    bank.name = name;
    bank.nameKey = nameKey;
  }
  if (req.body.isActive !== undefined) {
    if (!["true", "false", true, false].includes(req.body.isActive)) throw new AppError(400, "Invalid bank status");
    bank.isActive = req.body.isActive === "true" || req.body.isActive === true;
  }
  if (req.body.sortOrder !== undefined) {
    const order = Number(req.body.sortOrder);
    if (!Number.isInteger(order) || order < 0 || order > 9999) throw new AppError(400, "Sort order must be between 0 and 9999");
    bank.sortOrder = order;
  }
  if (req.file) {
    validateImage(req.file);
    const uploaded = await uploadOnCloudinary(req.file.buffer, { folder: "moneykee/banks", resource_type: "image" });
    bank.logo = { url: uploaded.secure_url, publicId: uploaded.public_id };
  }
  await bank.save();
  reply(res, bank, "Bank updated");
});

// Removes a bank from the catalog so it can no longer be chosen in the app. Accounts already linked
// to it keep their bank name; the logo file is removed from Cloudinary afterwards.
export const deleteBank = catchAsync(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new AppError(400, "Invalid bank ID");
  const bank = await Bank.findByIdAndDelete(req.params.id);
  if (!bank) throw new AppError(404, "Bank not found");
  const linkedAccounts = await Account.countDocuments({ bankName: bank.name });
  await deleteFromCloudinary(bank.logo?.publicId);
  sendResponse(res, { statusCode: 200, success: true, message: "Bank deleted successfully", data: { id: bank._id, name: bank.name, linkedAccounts } });
});
