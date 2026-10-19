import test from "node:test";
import assert from "node:assert/strict";
import { reportingPeriod, previousPeriod, periodDays, startOfToday, recentDays } from "../utils/reportingPeriods.js";

const at = iso => new Date(iso);

test("weeks run Sunday 00:00 to the following Sunday and reset automatically", () => {
  // Monday 19 Oct 2026: week began Sunday 18 Oct.
  const monday = reportingPeriod({ period: "week" }, at("2026-10-19T10:00:00Z"), "UTC");
  assert.equal(monday.start.toISOString(), "2026-10-18T00:00:00.000Z");
  assert.equal(monday.end.toISOString(), "2026-10-25T00:00:00.000Z");
  assert.equal(monday.through.toISOString(), "2026-10-19T10:00:00.000Z");
  assert.deepEqual([monday.startDate, monday.lastDate, monday.isCurrent], ["2026-10-18", "2026-10-24", true]);
  // Saturday late evening is still the same week; Sunday midnight starts a new one.
  assert.equal(reportingPeriod({ period: "week" }, at("2026-10-24T23:59:59.999Z"), "UTC").startDate, "2026-10-18");
  assert.equal(reportingPeriod({ period: "week" }, at("2026-10-25T00:00:00Z"), "UTC").startDate, "2026-10-25");
  // A Sunday report covers only Sunday so far.
  assert.deepEqual(periodDays(reportingPeriod({ period: "week" }, at("2026-10-25T05:00:00Z"), "UTC"), at("2026-10-25T05:00:00Z")), ["2026-10-25"]);
});

test("months follow the calendar, including year end and leap February", () => {
  const october = reportingPeriod({ period: "month" }, at("2026-10-31T23:00:00Z"), "UTC");
  assert.equal(october.start.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(october.end.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(october.label, "October 2026");
  assert.equal(reportingPeriod({ period: "month" }, at("2026-11-01T00:00:00Z"), "UTC").startDate, "2026-11-01");
  const december = reportingPeriod({ period: "month", date: "2026-12-15" }, at("2027-02-01T00:00:00Z"), "UTC");
  assert.equal(december.end.toISOString(), "2027-01-01T00:00:00.000Z"); assert.equal(december.isCurrent, false);
  assert.equal(december.through.toISOString(), december.end.toISOString());
  assert.equal(reportingPeriod({ period: "month", date: "2028-02-10" }, at("2028-03-05T00:00:00Z"), "UTC").lastDate, "2028-02-29");
});

test("boundaries use the reporting timezone, including across daylight-saving changes", () => {
  // Johannesburg is UTC+2 with no DST: its Sunday starts at 22:00 UTC on Saturday.
  const sa = reportingPeriod({ period: "week" }, at("2026-10-24T22:30:00Z"), "Africa/Johannesburg");
  assert.equal(sa.startDate, "2026-10-25"); assert.equal(sa.start.toISOString(), "2026-10-24T22:00:00.000Z");
  assert.equal(startOfToday(at("2026-10-24T22:30:00Z"), "Africa/Johannesburg").toISOString(), "2026-10-24T22:00:00.000Z");
  // New York springs forward on 8 Mar 2026: the week starting that Sunday begins at 05:00 UTC (EST)
  // and ends the next Sunday at 04:00 UTC (EDT), so the week is one hour short.
  const ny = reportingPeriod({ period: "week", date: "2026-03-10" }, at("2026-04-01T00:00:00Z"), "America/New_York");
  assert.equal(ny.start.toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(ny.end.toISOString(), "2026-03-15T04:00:00.000Z");
});

test("previous periods chain correctly and invalid or future requests are rejected", () => {
  const now = at("2026-10-19T10:00:00Z");
  const lastWeek = previousPeriod(reportingPeriod({ period: "week" }, now, "UTC"), now);
  assert.deepEqual([lastWeek.startDate, lastWeek.lastDate, lastWeek.isCurrent], ["2026-10-11", "2026-10-17", false]);
  assert.equal(previousPeriod(reportingPeriod({ period: "month", date: "2026-01-20" }, now, "UTC"), now).label, "December 2025");
  assert.throws(() => reportingPeriod({ period: "year" }, now, "UTC"), /week or month/);
  assert.throws(() => reportingPeriod({ period: "week", date: "2026-02-30" }, now, "UTC"), /valid calendar date/);
  assert.throws(() => reportingPeriod({ period: "week", date: "2026-11-01" }, now, "UTC"), /future/);
  const recent = recentDays(7, now, "UTC");
  assert.deepEqual([recent.days[0], recent.days[6], recent.start.toISOString()], ["2026-10-13", "2026-10-19", "2026-10-13T00:00:00.000Z"]);
});
