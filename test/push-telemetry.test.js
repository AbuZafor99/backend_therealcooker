import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { IntegrationMetric } from "../model/operation.model.js";
import { recordIntegrationCall } from "../utils/integrationMetrics.js";

// safelyTrack only writes while connected; pretend to be connected for these tests.
const connected = () => { const descriptor = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState"); Object.defineProperty(mongoose.connection, "readyState", { configurable: true, get: () => 1 }); return () => descriptor ? Object.defineProperty(mongoose.connection, "readyState", descriptor) : delete mongoose.connection.readyState; };

test("push outcomes are added to hourly counters without storing message content", async () => {
  const restoreState = connected(); const original = IntegrationMetric.updateOne; const calls = [];
  IntegrationMetric.updateOne = async (filter, update, options) => { calls.push({ filter, update, options }); return {}; };
  try {
    await recordIntegrationCall("fcm", { category: "guardian_alert", attempts: 3, accepted: 2, failed: 1, noDevice: 1, error: "messaging/registration-token-not-registered" });
    const { filter, update, options } = calls[0];
    assert.equal(filter.service, "fcm"); assert.equal(filter.category, "guardian_alert");
    assert.equal(filter.hour.getUTCMinutes(), 0); assert.equal(options.upsert, true);
    assert.deepEqual(update.$inc, { attempts: 3, accepted: 2, failed: 1, noDevice: 1, serviceErrors: 0 });
    assert.ok(update.$set.lastSuccessAt && update.$set.lastFailureAt);
    assert.equal(update.$set.lastError, "messaging/registration-token-not-registered");
  } finally { IntegrationMetric.updateOne = original; restoreState(); }
});

test("a lost upsert race is retried, and telemetry failures never reach the caller", async () => {
  const restoreState = connected(); const original = IntegrationMetric.updateOne; let attempts = 0;
  IntegrationMetric.updateOne = async () => { attempts++; if (attempts === 1) throw Object.assign(new Error("dup"), { code: 11000 }); return {}; };
  try {
    await recordIntegrationCall("fcm", { accepted: 1, attempts: 1 });
    assert.equal(attempts, 2);
    IntegrationMetric.updateOne = async () => { throw new Error("database down"); };
    await assert.doesNotReject(recordIntegrationCall("fcm", { serviceError: "app/network-error" }));
  } finally { IntegrationMetric.updateOne = original; restoreState(); }
});
