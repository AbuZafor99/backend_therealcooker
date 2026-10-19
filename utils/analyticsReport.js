import { reportingTimezone, reportingPeriod, previousPeriod, periodDays } from "./reportingPeriods.js";
import { activeIncidents, incidentActivity, guardianAlerts, fraudAlertCount, fraudAlertBreakdown, alertQuality, searches, userActivity, learningActivity, dailySeries, platformServices, serverSummary } from "./dashboardMetrics.js";
import { databaseMetrics } from "./databaseMetrics.js";
import { gpuStatus, hostDescription } from "./serverMetrics.js";
import { sampleEnvironment } from "./availability.js";

// One report for a calendar week (Sunday–Saturday) or month, compared with the previous full period.
// The analytics page and the PDF both render this object, so their figures always match.
const describe = period => ({ period: period.period, label: period.label, startDate: period.startDate, lastDate: period.lastDate, start: period.start, end: period.end, through: period.through, isCurrent: period.isCurrent });

export async function buildAnalyticsReport({ period = "week", date } = {}, now = new Date()) {
  const zone = reportingTimezone();
  const current = reportingPeriod({ period, date }, now, zone), previous = previousPeriod(current, now);
  const range = { from: current.start, to: current.through }, before = { from: previous.start, to: previous.end };
  const [incidentsNow, incidents, previousIncidents, guardian, previousGuardian, fraud, previousFraud, fraudBreakdown, quality, previousQuality,
    search, previousSearch, users, previousUsers, learning, daily, services, server, database] = await Promise.all([
    activeIncidents(), incidentActivity(range), incidentActivity(before), guardianAlerts(range), guardianAlerts(before),
    fraudAlertCount(range), fraudAlertCount(before), fraudAlertBreakdown(range), alertQuality(range), alertQuality(before),
    searches(range), searches(before), userActivity(range), userActivity(before), learningActivity(range),
    dailySeries(range, periodDays(current, now), zone), platformServices(range, now), serverSummary(range),
    databaseMetrics().catch(() => null),
  ]);

  // Known gaps, stated in the report instead of being filled with guesses.
  const limitations = [
    "Forward Alert is not recorded: no forward-alert event exists in the app or backend, and the app's \"Alert Security\" action does not contact the backend.",
    guardian.push.trackedSince ? `Push delivery results are recorded from ${guardian.push.trackedSince.toISOString().slice(0, 10)}; FCM "accepted" means FCM took the message, not that a device displayed it.` : "Push delivery results have not been recorded yet.",
    server.since ? `Server performance is measured from ${server.since.toISOString().slice(0, 10)} for the ${sampleEnvironment()} environment.` : "No server performance samples exist for this period.",
    "KYC submission times exist only for submissions made after submission tracking was added.",
    "Active users are counted per UTC day (one activity marker per user per day).",
  ];

  return {
    generatedAt: now, timezone: zone,
    period: describe(current), previous: describe(previous),
    incidents: { activeNow: incidentsNow, period: incidents, previous: previousIncidents },
    guardianAlerts: { period: guardian, previous: previousGuardian },
    alerts: { fraud: { period: fraud, previous: previousFraud, ...fraudBreakdown }, quality: { period: quality, previous: previousQuality } },
    searches: { period: search, previous: previousSearch },
    users: { period: users, previous: previousUsers },
    learning, daily, services,
    server: { environment: sampleEnvironment(), ...hostDescription(), gpuStatus: gpuStatus(), period: server },
    database, limitations,
  };
}
