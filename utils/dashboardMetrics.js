import { User } from "../model/user.model.js";
import { Account } from "../model/account.model.js";
import { Notification } from "../model/notification.model.js";
import { SecurityAlert, OperationEvent, AvailabilitySample, IntegrationMetric, LearningProgress, ServerMetricSample } from "../model/operation.model.js";
import { percent } from "./reporting.js";
import { GUARDIAN_ALERT_TYPES } from "./notification.js";
import { loadFirebase } from "./integrationMetrics.js";
import { sampleEnvironment } from "./availability.js";
import { isAtlas } from "./databaseMetrics.js";

// Metric definitions shared by the dashboard, the analytics report and its PDF, so one number never
// has two meanings. Every range is half-open: { from, to } matches from <= t < to.

// Incidents: each SOS session and each "Alert Guardians" request records exactly one alert (keyed by
// session or share id), so counting alerts counts distinct incidents however many notifications they sent.
export const INCIDENT_TYPES = { sos: "criticalSos", guardian_alert: "elevatedGuardianPanic" };
export const PANIC_TYPES = Object.keys(INCIDENT_TYPES);
export const SEARCH_TYPES = ["phone", "account", "email", "website"];
export const SEARCH_OUTCOMES = ["verified", "fraudulent", "not_found"];
const between = ({ from, to }) => ({ $gte: from, $lt: to });
// Unlike percent(), a ratio with no denominator is unknown rather than zero.
export const ratio = (count, total) => total ? percent(count, total) : null;
const byKey = (rows, keys, field = "count") => Object.fromEntries(keys.map(key => [key, rows.find(row => row._id === key)?.[field] || 0]));
const incidentCounts = rows => {
  const counts = { criticalSos: 0, elevatedGuardianPanic: 0 };
  for (const row of rows) counts[INCIDENT_TYPES[row._id]] += row.count;
  return { total: counts.criticalSos + counts.elevatedGuardianPanic, ...counts };
};

// Unresolved incidents right now. SOS incidents resolve when the emergency is cleared; guardian
// panics have no session and stay active until an operator resolves the alert.
export async function activeIncidents() {
  const rows = await SecurityAlert.aggregate([{ $match: { type: { $in: PANIC_TYPES }, status: { $ne: "resolved" } } }, { $group: { _id: "$type", count: { $sum: 1 } } }]);
  const { total, ...counts } = incidentCounts(rows);
  return { active: total, ...counts };
}

export async function incidentActivity(range) {
  const [started, [resolved], [response]] = await Promise.all([
    SecurityAlert.aggregate([{ $match: { type: { $in: PANIC_TYPES }, createdAt: between(range) } }, { $group: { _id: "$type", count: { $sum: 1 } } }]),
    SecurityAlert.aggregate([{ $match: { type: { $in: PANIC_TYPES }, resolvedAt: between(range) } }, { $group: { _id: null, count: { $sum: 1 }, averageMs: { $avg: { $subtract: ["$resolvedAt", "$createdAt"] } } } }]),
    SecurityAlert.aggregate([{ $match: { type: { $in: PANIC_TYPES }, createdAt: between(range), firstActionAt: { $ne: null } } }, { $group: { _id: null, count: { $sum: 1 }, averageMs: { $avg: { $subtract: ["$firstActionAt", "$createdAt"] } } } }]),
  ]);
  return { ...incidentCounts(started), resolved: resolved?.count || 0, averageResolutionMs: resolved?.averageMs ?? null, averageFirstActionMs: response?.averageMs ?? null };
}

// Guardian alerts: emergency notifications stored for a guardian (not the user's own copy). Push
// results come from FCM telemetry, which only exists from when tracking started.
export async function guardianAlerts(range) {
  const [rows, [push], [first]] = await Promise.all([
    Notification.aggregate([{ $match: { type: { $in: GUARDIAN_ALERT_TYPES }, createdAt: between(range), sender: { $ne: null }, $expr: { $ne: ["$recipient", "$sender"] } } }, { $group: { _id: "$type", count: { $sum: 1 } } }]),
    IntegrationMetric.aggregate([{ $match: { service: "fcm", category: "guardian_alert", hour: between(range) } }, { $group: { _id: null, attempts: { $sum: "$attempts" }, accepted: { $sum: "$accepted" }, failed: { $sum: "$failed" }, noDevice: { $sum: "$noDevice" } } }]),
    IntegrationMetric.find({ service: "fcm" }).sort({ hour: 1 }).limit(1).select("hour").lean().then(rows => rows),
  ]);
  const counts = byKey(rows, GUARDIAN_ALERT_TYPES);
  return {
    total: counts.guardian_alert + counts.sos_emergency_active, fromSos: counts.sos_emergency_active, fromGuardianPanic: counts.guardian_alert,
    push: { trackedSince: first?.hour || null, attempts: push?.attempts || 0, accepted: push?.accepted || 0, failed: push?.failed || 0, noDevice: push?.noDevice || 0 },
  };
}

// Other security alerts (limit verification, account locks, manual) — everything that is not a panic.
export const fraudAlertCount = range => SecurityAlert.countDocuments({ type: { $nin: PANIC_TYPES }, createdAt: between(range) });
export async function fraudAlertBreakdown(range) {
  const [types, severities] = await Promise.all(["$type", "$severity"].map(field => SecurityAlert.aggregate([{ $match: { type: { $nin: PANIC_TYPES }, createdAt: between(range) } }, { $group: { _id: field, count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }])));
  return { byType: types.map(row => ({ type: row._id, count: row.count })), bySeverity: severities.map(row => ({ severity: row._id, count: row.count })) };
}

export async function alertQuality(range) {
  const [row] = await SecurityAlert.aggregate([
    { $match: { createdAt: between(range) } },
    { $group: { _id: null,
      reviewed: { $sum: { $cond: [{ $ne: ["$verdict", "unreviewed"] }, 1, 0] } },
      falsePositive: { $sum: { $cond: [{ $eq: ["$verdict", "false_positive"] }, 1, 0] } },
      responseMs: { $avg: { $cond: [{ $ifNull: ["$firstActionAt", false] }, { $subtract: ["$firstActionAt", "$createdAt"] }, null] } },
      responded: { $sum: { $cond: [{ $ifNull: ["$firstActionAt", false] }, 1, 0] } } } },
  ]);
  return { reviewed: row?.reviewed || 0, falsePositive: row?.falsePositive || 0, rate: ratio(row?.falsePositive || 0, row?.reviewed || 0), averageResponseMs: row?.responseMs ?? null, responded: row?.responded || 0 };
}

// Searches: one record per lookup the verifier processed (requests rejected by validation are not
// recorded). Only the type and outcome are stored, never the searched value.
export async function searches(range) {
  const rows = await OperationEvent.aggregate([{ $match: { kind: "verification_lookup", occurredAt: between(range) } }, { $group: { _id: { tool: "$tool", outcome: "$outcome" }, count: { $sum: 1 } } }]);
  const sum = (tools, outcomes) => rows.filter(row => (!tools || tools.includes(row._id.tool)) && (!outcomes || outcomes.includes(row._id.outcome))).reduce((total, row) => total + row.count, 0);
  const total = sum();
  return {
    total, numbers: sum(["phone", "account"]),
    byType: Object.fromEntries(SEARCH_TYPES.map(type => [type, sum([type])])),
    byOutcome: Object.fromEntries(SEARCH_OUTCOMES.map(outcome => [outcome, sum(null, [outcome])])),
    flagRate: ratio(sum(null, ["fraudulent"]), total),
    share: Object.fromEntries(SEARCH_OUTCOMES.map(outcome => [outcome, ratio(sum(null, [outcome]), total)])),
  };
}

// Activity is recorded as one marker per user per UTC day, so active-user counts follow UTC days.
export const activeUsers = async range => (await OperationEvent.distinct("user", { kind: "activity", occurredAt: between(range), user: { $ne: null } })).length;
export const newUsers = range => User.countDocuments({ role: "user", createdAt: between(range) });

export async function userActivity(range) {
  const [active, created, kycSubmitted, kycCompleted, linked] = await Promise.all([
    activeUsers(range), newUsers(range),
    User.countDocuments({ role: "user", "kyc.submittedAt": between(range) }),
    User.countDocuments({ role: "user", "kyc.verifiedAt": between(range) }),
    Account.aggregate([{ $match: { createdAt: between(range) } }, { $group: { _id: "$accountType", count: { $sum: 1 } } }]),
  ]);
  return { active, new: created, kycSubmitted, kycCompleted, accountsLinked: byKey(linked, ["bank", "wallet"]) };
}

export async function learningActivity(range) {
  const [started, [completed]] = await Promise.all([
    LearningProgress.countDocuments({ startedAt: between(range) }),
    LearningProgress.aggregate([{ $match: { completedAt: between(range) } }, { $group: { _id: null, count: { $sum: 1 }, averageMs: { $avg: "$durationMs" } } }]),
  ]);
  return { started, completed: completed?.count || 0, averageDurationMs: completed?.averageMs ?? null };
}

// Daily totals for each local calendar day in `days`.
export async function dailySeries(range, days, zone) {
  const day = field => ({ $dateToString: { format: "%Y-%m-%d", date: `$${field}`, timezone: zone } });
  const count = (Model, match, field) => Model.aggregate([{ $match: { ...match, [field]: between(range) } }, { $group: { _id: day(field), count: { $sum: 1 } } }]);
  const [active, created, incidents, fraud, lookups] = await Promise.all([
    OperationEvent.aggregate([{ $match: { kind: "activity", occurredAt: between(range), user: { $ne: null } } }, { $group: { _id: { date: day("occurredAt"), user: "$user" } } }, { $group: { _id: "$_id.date", count: { $sum: 1 } } }]),
    count(User, { role: "user" }, "createdAt"),
    count(SecurityAlert, { type: { $in: PANIC_TYPES } }, "createdAt"),
    count(SecurityAlert, { type: { $nin: PANIC_TYPES } }, "createdAt"),
    count(OperationEvent, { kind: "verification_lookup" }, "occurredAt"),
  ]);
  const value = (rows, date) => rows.find(row => row._id === date)?.count || 0;
  return days.map(date => ({ date, activeUsers: value(active, date), newUsers: value(created, date), incidents: value(incidents, date), fraudAlerts: value(fraud, date), searches: value(lookups, date) }));
}

// Platform services. States: monitored (has checks), collecting (too little data yet), not_configured,
// not_integrated (the backend never calls it) or not_monitored (used only by the mobile app).
const SERVICE_LABELS = { database: () => isAtlas() ? "MongoDB Atlas" : "MongoDB", verifier: () => "Verifier DB", fcm: () => "Firebase FCM" };
export async function platformServices(range, now = new Date()) {
  // The current minute may not have been sampled yet, so API coverage stops before it.
  const coverageEnd = new Date(Math.min(range.to, Math.floor(now / 60_000) * 60_000));
  const [checks, [coverage], fcmTraffic, firebase] = await Promise.all([
    AvailabilitySample.aggregate([{ $match: { service: { $ne: "moneykee" }, checkedAt: between(range) } }, { $sort: { checkedAt: 1 } },
      { $group: { _id: "$service", samples: { $sum: 1 }, healthy: { $sum: { $cond: ["$available", 1, 0] } }, lastCheckedAt: { $last: "$checkedAt" }, lastAvailable: { $last: "$available" },
        lastFailureAt: { $max: { $cond: ["$available", null, "$checkedAt"] } }, lastError: { $last: "$error" } } }]),
    // The API writes one heartbeat a minute while it runs, so minutes without one are downtime.
    AvailabilitySample.aggregate([
      { $match: { service: "moneykee", environment: sampleEnvironment(), checkedAt: { $gte: range.from, $lt: coverageEnd } } },
      { $group: { _id: { $dateTrunc: { date: "$checkedAt", unit: "minute" } } } },
      { $group: { _id: null, minutes: { $sum: 1 }, since: { $min: "$_id" } } },
    ]),
    IntegrationMetric.aggregate([{ $match: { service: "fcm", hour: between(range) } }, { $sort: { hour: 1 } }, { $group: { _id: null, attempts: { $sum: "$attempts" }, accepted: { $sum: "$accepted" }, failed: { $sum: "$failed" }, serviceErrors: { $sum: "$serviceErrors" }, lastSuccessAt: { $max: "$lastSuccessAt" }, lastFailureAt: { $max: "$lastFailureAt" }, lastError: { $last: "$lastError" } } }]),
    loadFirebase(),
  ]);
  const expectedMinutes = coverage ? Math.round((coverageEnd - coverage.since) / 60_000) : 0;
  const check = service => {
    const row = checks.find(item => item._id === service);
    return row ? { percent: ratio(row.healthy, row.samples), samples: row.samples, lastCheckedAt: row.lastCheckedAt, healthyNow: row.lastAvailable, lastFailureAt: row.lastFailureAt, lastError: row.lastAvailable ? null : row.lastError || null } : null;
  };
  const services = [
    { service: "api", label: "MoneyKee API", method: "Heartbeat each minute while the API runs",
      ...(coverage ? { state: expectedMinutes >= 60 ? "monitored" : "collecting", percent: expectedMinutes >= 60 ? Math.min(100, ratio(coverage.minutes, expectedMinutes)) : null, since: coverage.since, minutes: coverage.minutes, expectedMinutes } : { state: "collecting", percent: null }) },
    ...["database", "verifier"].map(service => ({ service, label: SERVICE_LABELS[service](), method: service === "database" ? "Ping each minute" : "Read of the verification records each minute", ...(check(service) ? { state: "monitored", ...check(service) } : { state: "collecting", percent: null }) })),
    { service: "fcm", label: "Firebase FCM", method: "Dry-run message validated by FCM every 15 minutes (nothing is delivered)",
      ...(!firebase ? { state: "not_configured", detail: "Firebase credentials are not available to this backend instance." } : check("fcm") ? { state: "monitored", ...check("fcm") } : { state: "collecting", percent: null }),
      traffic: fcmTraffic[0] ? { attempts: fcmTraffic[0].attempts, accepted: fcmTraffic[0].accepted, failed: fcmTraffic[0].failed, serviceErrors: fcmTraffic[0].serviceErrors, lastSuccessAt: fcmTraffic[0].lastSuccessAt, lastFailureAt: fcmTraffic[0].lastFailureAt, lastError: fcmTraffic[0].lastError || null } : null },
    { service: "sms", label: "Africa's Talking SMS", state: "not_integrated", detail: "The backend has no SMS integration; nothing to monitor." },
    { service: "maps", label: "Maps", state: "not_monitored", detail: "Maps is used only inside the mobile app; the backend makes no Maps requests." },
    ...checks.filter(row => !["database", "verifier", "fcm"].includes(row._id)).map(row => ({ service: row._id, label: row._id, method: "Configured health URL", state: "monitored", ...check(row._id) })),
  ];
  return services;
}

// CPU and memory of the backend host over a range, from this environment's minute samples.
export async function serverSummary(range) {
  const [row] = await ServerMetricSample.aggregate([
    { $match: { environment: sampleEnvironment(), checkedAt: between(range) } },
    { $group: { _id: null, samples: { $sum: 1 }, since: { $min: "$checkedAt" }, averageCpu: { $avg: "$host.cpuPercent" }, peakCpu: { $max: "$host.cpuPercent" },
      averageMemory: { $avg: { $multiply: [{ $divide: [{ $subtract: ["$host.memoryTotal", "$host.memoryFree"] }, "$host.memoryTotal"] }, 100] } },
      peakMemory: { $max: { $multiply: [{ $divide: [{ $subtract: ["$host.memoryTotal", "$host.memoryFree"] }, "$host.memoryTotal"] }, 100] } },
      averageProcessRss: { $avg: "$process.rss" } } },
  ]);
  const round = value => value == null ? null : Math.round(value * 10) / 10;
  return row ? { samples: row.samples, since: row.since, averageCpuPercent: round(row.averageCpu), peakCpuPercent: round(row.peakCpu), averageMemoryPercent: round(row.averageMemory), peakMemoryPercent: round(row.peakMemory), averageProcessRss: row.averageProcessRss ? Math.round(row.averageProcessRss) : null } : { samples: 0, since: null };
}
