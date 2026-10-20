import jwt from "jsonwebtoken";
import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import { User } from "./../model/user.model.js";
import { isValidObjectId } from "mongoose";
import { can, routePermission } from "../utils/adminPermissions.js";

export const protect = async (req, res, next) => {
  const authorization = req.headers.authorization;
  const token = typeof authorization === "string" ? /^Bearer\s+(\S+)$/i.exec(authorization)?.[1] : undefined;
  if (!token) throw new AppError(httpStatus.UNAUTHORIZED, "Please log in to continue");
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] });
  } catch (err) {
    throw new AppError(httpStatus.UNAUTHORIZED, err.name === "TokenExpiredError" ? "Session expired. Please log in again." : "Invalid session. Please log in again.");
  }
  if (!decoded || typeof decoded !== "object" || !isValidObjectId(decoded._id)) throw new AppError(httpStatus.UNAUTHORIZED, "Invalid session. Please log in again.");
  // Database/service failures must remain server errors, not invalid-token errors.
  const user = await User.findById(decoded._id);
  if (!user || !user.verificationInfo?.verified || user.isBlocked) throw new AppError(httpStatus.UNAUTHORIZED, "Session is no longer valid. Please log in again.");
  req.user = user;
  next();
};

// For public endpoints: attaches the signed-in user when a valid token is sent and otherwise
// continues anonymously. It never rejects a request, so public behaviour is unchanged.
export const optionalAuth = async (req, res, next) => {
  try {
    const token = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ""))?.[1];
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] });
      if (decoded && typeof decoded === "object" && isValidObjectId(decoded._id)) {
        const user = await User.findById(decoded._id);
        if (user && user.verificationInfo?.verified && !user.isBlocked) req.user = user;
      }
    }
  } catch { /* invalid or expired token: treat as anonymous */ }
  next();
};

export const isAdmin = (req, res, next) => {
  if (req.user?.role !== "admin") {
    throw new AppError(403, "Access denied. You are not an admin.");
  }
  if (!can(req.user, routePermission(req))) throw new AppError(403, "Your admin role does not permit this action");
  next();
};

export const isDriver = (req, res, next) => {
  if (req.user?.role !== "driver") {
    throw new AppError(403, "Access denied. You are not an driver.");
  }
  next();
};
