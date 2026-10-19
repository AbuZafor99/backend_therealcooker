import mongoose from "mongoose";
import { AvailabilitySample, ServerMetricSample } from "../model/operation.model.js";
import { Verification } from "../model/verification.model.js";
import { safelyTrack } from "./operations.js";
import { checkFcm } from "./integrationMetrics.js";
import { collectServerMetrics } from "./serverMetrics.js";

export const sampleEnvironment = () => process.env.NODE_ENV || "development";

// The FCM dry run is checked every 15 minutes; everything else every minute.
const FCM_EVERY_TICKS = 15;
let latestServerSample = null;
export const latestServerMetrics = () => latestServerSample;

export async function sampleAvailability({ includeFcm = false } = {}) {
  const checkedAt = new Date();
  const start = Date.now();
  let available = false;
  try { await mongoose.connection.db.admin().ping(); available = true; } catch { /* captured as outage */ }
  const databaseLatency = Date.now() - start;
  // A real read on the collection behind the public verifier lookup.
  const verifierStart = Date.now(); let verifierAvailable = false;
  try { await Verification.findOne().select("_id").maxTimeMS(5000).lean(); verifierAvailable = true; } catch { /* captured as outage */ }
  const samples = [
    { service: "moneykee", available: true, latencyMs: 0, checkedAt },
    { service: "database", available, latencyMs: databaseLatency, checkedAt },
    { service: "verifier", available: verifierAvailable, latencyMs: Date.now() - verifierStart, checkedAt },
  ];
  // Operator-configured health URLs only; no user supplied URLs or response content is retained.
  const integrations = JSON.parse(process.env.INTEGRATION_HEALTH_URLS || "{}");
  for (const [service, url] of Object.entries(integrations)) {
    if (!/^https?:\/\//.test(String(url))) continue;
    const started = Date.now(); let healthy = false;
    try { const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" }); healthy = response.ok; await response.body?.cancel(); } catch { /* captured as outage */ }
    samples.push({ service, available: healthy, latencyMs: Date.now() - started, checkedAt });
  }
  if (includeFcm) { const fcm = await checkFcm(); if (fcm) samples.push({ ...fcm, checkedAt }); }
  const environment = sampleEnvironment();
  await safelyTrack(() => AvailabilitySample.insertMany(samples.map(sample => ({ ...sample, environment }))));
}
export async function sampleServer() {
  latestServerSample = { ...await collectServerMetrics(), environment: sampleEnvironment() };
  await safelyTrack(() => ServerMetricSample.create(latestServerSample));
}
export function startAvailabilityMonitor() {
  let running = false, ticks = 0;
  const tick = async () => {
    if (running) return; running = true;
    try { await sampleAvailability({ includeFcm: ticks++ % FCM_EVERY_TICKS === 0 }); } catch (error) { console.error("Availability monitor failed:", error.message); }
    try { await sampleServer(); } catch (error) { console.error("Server metrics failed:", error.message); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(tick, 60_000); timer.unref();
  return timer;
}
