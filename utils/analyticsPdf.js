import PDFDocument from "pdfkit";

// Renders an analytics report (see analyticsReport.js) as an A4 PDF. Only the report object is
// used, so the PDF shows exactly the figures the analytics page shows. No personal data is included.
const COLORS = { ink: "#1a1a17", muted: "#6f6f68", line: "#e4e2dc", band: "#f6f6f3", accent: "#1d5fa7", users: "#1c5fa8", incidents: "#e24c4b", searches: "#b8741a" };
const MARGIN = 48;
const number = value => value == null ? "—" : new Intl.NumberFormat("en").format(value);
const pct = value => value == null ? "—" : `${value}%`;
function duration(ms) {
  if (ms == null) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.round(seconds % 3600 / 60)}m`;
}
function bytes(value) {
  if (value == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"]; let size = value, unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}
const stamp = (value, zone) => value ? new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—";
const titleCase = value => String(value).replaceAll("_", " ").replace(/^\w/, letter => letter.toUpperCase());

export function renderAnalyticsPdf(report) {
  const doc = new PDFDocument({ size: "A4", margin: MARGIN, bufferPages: true, info: { Title: `MoneyKee analytics — ${report.period.label}`, Author: "MoneyKee admin" } });
  const chunks = [];
  doc.on("data", chunk => chunks.push(chunk));
  const done = new Promise((resolve, reject) => { doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });
  const width = doc.page.width - MARGIN * 2, bottom = () => doc.page.height - MARGIN - 20;
  const ensure = height => { if (doc.y + height > bottom()) doc.addPage(); };
  const zone = report.timezone;

  // Header block.
  doc.rect(MARGIN, MARGIN, 34, 34).fill("#f5a524");
  doc.fillColor("#3b2a00").font("Helvetica-Bold").fontSize(13).text("MK", MARGIN, MARGIN + 11, { width: 34, align: "center" });
  doc.fillColor(COLORS.ink).fontSize(18).text("MoneyKee analytics report", MARGIN + 46, MARGIN + 1);
  doc.font("Helvetica").fontSize(10).fillColor(COLORS.muted).text(`${report.period.period === "week" ? "Week (Sunday–Saturday)" : "Calendar month"}: ${report.period.label}${report.period.isCurrent ? " (in progress)" : ""}`, MARGIN + 46, MARGIN + 22);
  doc.moveDown(1.6);
  doc.x = MARGIN;
  doc.fontSize(9).fillColor(COLORS.muted).text(`Reporting period ${report.period.startDate} to ${report.period.lastDate}${report.period.isCurrent ? `, data up to ${stamp(report.period.through, zone)}` : ""} · Timezone ${zone} · Generated ${stamp(report.generatedAt, zone)} · Compared with ${report.previous.label}`, { width });
  doc.moveDown(0.8);

  const heading = text => {
    ensure(60); doc.moveDown(0.6);
    doc.font("Helvetica-Bold").fontSize(12.5).fillColor(COLORS.ink).text(text, MARGIN, doc.y, { width });
    doc.moveTo(MARGIN, doc.y + 3).lineTo(MARGIN + width, doc.y + 3).lineWidth(1).strokeColor(COLORS.accent).stroke();
    doc.moveDown(0.6);
  };
  const note = text => { doc.font("Helvetica").fontSize(8.5).fillColor(COLORS.muted).text(text, MARGIN, doc.y, { width }); doc.moveDown(0.3); };
  // Table with a repeated header row when it continues on a new page.
  const table = (columns, rows) => {
    const widths = columns.map(column => column.width * width);
    const drawRow = (cells, header) => {
      doc.font(header ? "Helvetica-Bold" : "Helvetica").fontSize(9);
      const height = Math.max(...cells.map((cell, index) => doc.heightOfString(String(cell), { width: widths[index] - 10 }))) + 9;
      if (doc.y + height > bottom()) { doc.addPage(); if (!header) drawRow(columns.map(column => column.label), true); }
      const top = doc.y;
      if (header) doc.rect(MARGIN, top, width, height).fill(COLORS.band);
      let x = MARGIN;
      cells.forEach((cell, index) => {
        doc.fillColor(header ? COLORS.muted : COLORS.ink).font(header ? "Helvetica-Bold" : "Helvetica").fontSize(9)
          .text(String(cell), x + 5, top + 4.5, { width: widths[index] - 10, align: columns[index].align || "left" });
        x += widths[index];
      });
      doc.moveTo(MARGIN, top + height).lineTo(MARGIN + width, top + height).lineWidth(0.5).strokeColor(COLORS.line).stroke();
      doc.y = top + height; doc.x = MARGIN;
    };
    ensure(40);
    drawRow(columns.map(column => column.label), true);
    rows.forEach(row => drawRow(row, false));
    doc.moveDown(0.4);
  };
  const comparison = rows => table([{ label: "Metric", width: 0.5 }, { label: report.period.isCurrent ? "This period (so far)" : "This period", width: 0.25, align: "right" }, { label: "Previous period", width: 0.25, align: "right" }], rows);

  const { incidents, guardianAlerts: guardian, alerts, searches, users, learning } = report;
  heading("Active high-risk events (now)");
  table([{ label: "Classification", width: 0.7 }, { label: "Unresolved", width: 0.3, align: "right" }], [
    ["Critical SOS", number(incidents.activeNow.criticalSos)], ["Elevated Guardian Panic", number(incidents.activeNow.elevatedGuardianPanic)], ["Total active high-risk events", number(incidents.activeNow.active)],
  ]);
  note("A Critical SOS is a direct SOS activation; an Elevated Guardian Panic is an \"Alert Guardians\" request without SOS. Each incident counts once, however many notifications it produced.");

  heading("Incidents in this period");
  comparison([
    ["Critical SOS started", number(incidents.period.criticalSos), number(incidents.previous.criticalSos)],
    ["Elevated Guardian Panics started", number(incidents.period.elevatedGuardianPanic), number(incidents.previous.elevatedGuardianPanic)],
    ["Incidents resolved", number(incidents.period.resolved), number(incidents.previous.resolved)],
    ["Average time to resolve", duration(incidents.period.averageResolutionMs), duration(incidents.previous.averageResolutionMs)],
    ["Average time to first operator action", duration(incidents.period.averageFirstActionMs), duration(incidents.previous.averageFirstActionMs)],
  ]);

  heading("Guardian alerts");
  comparison([
    ["Guardian notifications sent", number(guardian.period.total), number(guardian.previous.total)],
    ["   from SOS activations", number(guardian.period.fromSos), number(guardian.previous.fromSos)],
    ["   from Guardian Panic requests", number(guardian.period.fromGuardianPanic), number(guardian.previous.fromGuardianPanic)],
    ["Push accepted by FCM", number(guardian.period.push.accepted), number(guardian.previous.push.accepted)],
    ["Push rejected by FCM", number(guardian.period.push.failed), number(guardian.previous.push.failed)],
    ["Guardians with no registered device", number(guardian.period.push.noDevice), number(guardian.previous.push.noDevice)],
  ]);
  note(guardian.period.push.trackedSince ? `Push results are recorded from ${guardian.period.push.trackedSince.toISOString().slice(0, 10)}. "Accepted" means FCM took the message for delivery, not that the device showed it.` : "Push results have not been recorded yet, so push figures are zero by absence of data, not confirmed zero.");

  heading("Security alerts (other than panics)");
  comparison([
    ["Security alerts raised", number(alerts.fraud.period), number(alerts.fraud.previous)],
    ["Alerts reviewed", number(alerts.quality.period.reviewed), number(alerts.quality.previous.reviewed)],
    ["False-positive rate", pct(alerts.quality.period.rate), pct(alerts.quality.previous.rate)],
    ["Average time to first action", duration(alerts.quality.period.averageResponseMs), duration(alerts.quality.previous.averageResponseMs)],
  ]);
  if (alerts.fraud.byType.length) table([{ label: "Alert type", width: 0.7 }, { label: "Count", width: 0.3, align: "right" }], alerts.fraud.byType.map(row => [titleCase(row.type), number(row.count)]));
  if (alerts.fraud.bySeverity.length) table([{ label: "Severity", width: 0.7 }, { label: "Count", width: 0.3, align: "right" }], alerts.fraud.bySeverity.map(row => [titleCase(row.severity), number(row.count)]));

  heading("Verifier searches");
  comparison([
    ["All searches", number(searches.period.total), number(searches.previous.total)],
    ["   Phone number", number(searches.period.byType.phone), number(searches.previous.byType.phone)],
    ["   Bank account number", number(searches.period.byType.account), number(searches.previous.byType.account)],
    ["   Email address", number(searches.period.byType.email), number(searches.previous.byType.email)],
    ["   Website", number(searches.period.byType.website), number(searches.previous.byType.website)],
    ["Result: verified", number(searches.period.byOutcome.verified), number(searches.previous.byOutcome.verified)],
    ["Result: flagged as fraudulent", number(searches.period.byOutcome.fraudulent), number(searches.previous.byOutcome.fraudulent)],
    ["Result: no record found", number(searches.period.byOutcome.not_found), number(searches.previous.byOutcome.not_found)],
    ["Flag rate", pct(searches.period.flagRate), pct(searches.previous.flagRate)],
  ]);
  note("Counts are lookups the verifier processed; requests rejected as invalid are not counted. Searched values are never stored.");

  heading("Users and accounts");
  comparison([
    ["Active users", number(users.period.active), number(users.previous.active)],
    ["New registrations", number(users.period.new), number(users.previous.new)],
    ["KYC submissions", number(users.period.kycSubmitted), number(users.previous.kycSubmitted)],
    ["KYC verifications completed", number(users.period.kycCompleted), number(users.previous.kycCompleted)],
    ["Bank accounts linked", number(users.period.accountsLinked.bank), number(users.previous.accountsLinked.bank)],
    ["Wallets linked", number(users.period.accountsLinked.wallet), number(users.previous.accountsLinked.wallet)],
  ]);

  heading("Learning");
  table([{ label: "Metric", width: 0.7 }, { label: "This period", width: 0.3, align: "right" }], [
    ["Modules started", number(learning.started)], ["Modules completed", number(learning.completed)], ["Average completion time", duration(learning.averageDurationMs)],
  ]);

  // Daily chart: grouped bars per day, scaled to the period's largest value.
  heading("Daily activity");
  const series = [{ key: "activeUsers", label: "Active users", color: COLORS.users }, { key: "incidents", label: "Incidents", color: COLORS.incidents }, { key: "searches", label: "Searches", color: COLORS.searches }];
  const max = Math.max(0, ...report.daily.flatMap(day => series.map(item => day[item.key])));
  if (max > 0) {
    ensure(170);
    const chartTop = doc.y + 4, chartHeight = 110, slot = width / report.daily.length, barWidth = Math.max(1.5, Math.min(10, (slot - 4) / series.length));
    doc.moveTo(MARGIN, chartTop + chartHeight).lineTo(MARGIN + width, chartTop + chartHeight).lineWidth(0.5).strokeColor(COLORS.line).stroke();
    doc.font("Helvetica").fontSize(7).fillColor(COLORS.muted).text(number(max), MARGIN, chartTop - 2, { width: 40 });
    report.daily.forEach((day, index) => {
      const groupLeft = MARGIN + index * slot + (slot - barWidth * series.length) / 2;
      series.forEach((item, position) => {
        const height = day[item.key] / max * chartHeight;
        if (height > 0) doc.rect(groupLeft + position * barWidth, chartTop + chartHeight - height, barWidth - 0.5, height).fill(item.color);
      });
      if (report.daily.length <= 7 || index % 3 === 0) doc.fillColor(COLORS.muted).fontSize(7).text(day.date.slice(5), MARGIN + index * slot, chartTop + chartHeight + 3, { width: slot, align: "center" });
    });
    let legendX = MARGIN;
    series.forEach(item => { doc.rect(legendX, chartTop + chartHeight + 16, 8, 8).fill(item.color); doc.fillColor(COLORS.ink).fontSize(8).text(item.label, legendX + 11, chartTop + chartHeight + 16); legendX += 90; });
    doc.y = chartTop + chartHeight + 32; doc.x = MARGIN;
  } else note("No activity was recorded on any day of this period.");
  table([{ label: "Date", width: 0.2 }, { label: "Active users", width: 0.16, align: "right" }, { label: "New users", width: 0.16, align: "right" }, { label: "Incidents", width: 0.16, align: "right" }, { label: "Security alerts", width: 0.16, align: "right" }, { label: "Searches", width: 0.16, align: "right" }],
    report.daily.map(day => [day.date, number(day.activeUsers), number(day.newUsers), number(day.incidents), number(day.fraudAlerts), number(day.searches)]));

  heading("Platform services");
  const stateLabel = { monitored: "Monitored", collecting: "Collecting data", not_configured: "Not configured", not_integrated: "Not integrated", not_monitored: "Not monitored" };
  table([{ label: "Service", width: 0.26 }, { label: "Status", width: 0.18 }, { label: "Availability", width: 0.16, align: "right" }, { label: "How it is measured", width: 0.4 }],
    report.services.map(service => [service.label, stateLabel[service.state] || service.state, service.percent == null ? "—" : `${service.percent}%`, service.method || service.detail || ""]));

  heading("Backend server performance");
  const server = report.server;
  if (server.period.samples) {
    table([{ label: "Metric", width: 0.6 }, { label: "Value", width: 0.4, align: "right" }], [
      ["Measured host", `${server.environment} · ${server.platform}/${server.arch} · ${server.cores} cores`],
      ["Samples (one per minute)", number(server.period.samples)],
      ["Host CPU — average / peak", `${pct(server.period.averageCpuPercent)} / ${pct(server.period.peakCpuPercent)}`],
      ["Host memory used — average / peak", `${pct(server.period.averageMemoryPercent)} / ${pct(server.period.peakMemoryPercent)}`],
      ["API process memory (RSS) — average", bytes(server.period.averageProcessRss)],
      ["GPU", server.gpuStatus === "available" ? "Monitored" : "Not available on this host"],
    ]);
    note(`Samples from ${stamp(server.period.since, zone)}. Host figures cover the whole machine running the API; the process figure is the API alone.`);
  } else note("No server performance samples were recorded for this period.");

  heading("Database (current)");
  const database = report.database;
  if (database) {
    table([{ label: "Metric", width: 0.5 }, { label: "Value", width: 0.5, align: "right" }], [
      ["Provider / version", `${database.provider}${database.version ? ` ${database.version}` : ""}`],
      ["Replica set", database.replicaSet ? `${database.replicaSet.members} members, primary ${database.replicaSet.writablePrimary ? "writable" : "not writable"}` : "—"],
      ["Data stored (uncompressed documents)", bytes(database.dataSize)],
      ["Storage used on disk (compressed)", bytes(database.storageSize)],
      ["Index size", bytes(database.indexSize)],
      ["Documents / collections", `${number(database.objects)} / ${number(database.collections)}`],
      ["Cluster disk capacity", database.filesystem ? `${bytes(database.filesystem.used)} of ${bytes(database.filesystem.total)}` : "Not reported by this cluster tier"],
      ["Database server memory", database.memory ? bytes(database.memory.residentBytes) : "Not available"],
    ]);
    if (!database.memory) note(database.memoryUnavailableReason);
  } else note("Database statistics could not be read when this report was generated.");

  heading("Notes and limitations");
  report.limitations.forEach(text => { ensure(24); doc.font("Helvetica").fontSize(9).fillColor(COLORS.ink).text(`• ${text}`, MARGIN, doc.y, { width }); doc.moveDown(0.25); });

  // Footer on every page.
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index++) {
    doc.switchToPage(range.start + index);
    // Writing inside the bottom margin would otherwise make pdfkit start a new page.
    doc.page.margins.bottom = 0;
    const y = doc.page.height - MARGIN + 6;
    doc.font("Helvetica").fontSize(8).fillColor(COLORS.muted)
      .text(`MoneyKee analytics · ${report.period.label}`, MARGIN, y, { width: width / 2, lineBreak: false })
      .text(`Page ${index + 1} of ${range.count}`, MARGIN + width / 2, y, { width: width / 2, align: "right", lineBreak: false });
  }
  doc.end();
  return done;
}
