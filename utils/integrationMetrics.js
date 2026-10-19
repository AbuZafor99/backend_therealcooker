import { IntegrationMetric } from "../model/operation.model.js";
import { safelyTrack } from "./operations.js";

// Firebase is optional per environment: utils/firebase.js throws at import when the service account
// file is absent, so it is loaded lazily and a missing configuration is reported, not fatal.
let firebase;
export const loadFirebase = () => (firebase ??= import("./firebase.js").then(module => module.default).catch(() => null));

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "timeout" })), ms).unref())]);

// Adds one outbound call's outcome to the current hour's counters. Fire-and-forget: telemetry must
// never delay or fail the request that sent the notification.
export function recordIntegrationCall(service, { category = "general", attempts = 0, accepted = 0, failed = 0, noDevice = 0, serviceError, error } = {}) {
  const now = new Date(), hour = new Date(Math.floor(now / 3_600_000) * 3_600_000);
  const set = {};
  if (accepted > 0) set.lastSuccessAt = now;
  if (failed > 0 || serviceError) { set.lastFailureAt = now; set.lastError = String(serviceError || error || "failed").slice(0, 120); }
  const update = { $inc: { attempts, accepted, failed, noDevice, serviceErrors: serviceError ? 1 : 0 }, ...(Object.keys(set).length ? { $set: set } : {}) };
  const write = () => IntegrationMetric.updateOne({ service, category, hour }, update, { upsert: true });
  // Two first writes in the same hour can race on the unique index; the retry lands as an update.
  return safelyTrack(() => write().catch(err => err?.code === 11000 ? write() : Promise.reject(err)));
}

// Validates a message with FCM without delivering it (dry run to a topic nobody subscribes to).
// Proves the credentials are accepted and the FCM API responds; it says nothing about device delivery.
export async function checkFcm() {
  const admin = await loadFirebase();
  if (!admin) return null;
  const started = Date.now();
  try {
    await withTimeout(admin.messaging().send({ topic: "moneykee-health-check", data: { check: "1" } }, true), 10_000);
    return { service: "fcm", available: true, latencyMs: Date.now() - started };
  } catch (error) {
    return { service: "fcm", available: false, latencyMs: Date.now() - started, error: String(error?.code || error?.name || "error").slice(0, 120) };
  }
}
