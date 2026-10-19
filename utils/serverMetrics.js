import os from "node:os";
import * as fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Measurements of the machine running this backend process. CPU percentages are deltas between
// consecutive calls, so the first call after start reports null rather than a guess.
const run = promisify(execFile);
const round = value => Math.round(value * 10) / 10;
let previousCpu = null, previousProcess = null;
let gpuTool; // undefined: not probed yet, false: unavailable on this host, true: nvidia-smi works

const cpuTotals = () => os.cpus().reduce((sum, { times }) => {
  sum.idle += times.idle; sum.total += times.user + times.nice + times.sys + times.idle + times.irq; return sum;
}, { idle: 0, total: 0 });

async function containerMemory() {
  if (process.platform !== "linux") return null;
  for (const [limitPath, usagePath] of [["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.current"], ["/sys/fs/cgroup/memory/memory.limit_in_bytes", "/sys/fs/cgroup/memory/memory.usage_in_bytes"]]) {
    try {
      const [limit, usage] = await Promise.all([fsp.readFile(limitPath, "utf8"), fsp.readFile(usagePath, "utf8")]);
      const memoryLimit = Number(limit.trim());
      // "max" (v2) or a sentinel larger than the host (v1) means the container has no memory limit.
      if (!Number.isFinite(memoryLimit) || memoryLimit >= os.totalmem()) return null;
      return { memoryLimit, memoryUsage: Number(usage.trim()) };
    } catch { /* not this cgroup layout */ }
  }
  return null;
}

async function gpus() {
  if (gpuTool === false) return null;
  try {
    const { stdout } = await run("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], { timeout: 3000 });
    gpuTool = true;
    return stdout.trim().split("\n").filter(Boolean).map(line => {
      const [name, utilization, used, total] = line.split(",").map(value => value.trim());
      return { name, utilizationPercent: Number(utilization), memoryUsed: Number(used) * 2 ** 20, memoryTotal: Number(total) * 2 ** 20 };
    });
  } catch (error) {
    // Only a missing tool settles the question; a transient failure is retried next minute.
    if (error.code === "ENOENT") gpuTool = false;
    return null;
  }
}
// os.freemem() on macOS counts only completely unused pages, so cached memory looks "used". There,
// reclaimable inactive and speculative pages are added back; Linux already reports MemAvailable.
async function availableMemory() {
  if (process.platform !== "darwin") return os.freemem();
  try {
    const { stdout } = await run("vm_stat", [], { timeout: 2000 });
    const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1]);
    const pages = name => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(stdout)?.[1] || 0);
    if (pageSize) return (pages("free") + pages("inactive") + pages("speculative")) * pageSize;
  } catch { /* fall back below */ }
  return os.freemem();
}

export const gpuStatus = () => gpuTool === true ? "available" : gpuTool === false ? "not_available" : "unknown";

export async function collectServerMetrics() {
  const now = Date.now(), cpu = cpuTotals(), usage = process.cpuUsage(), cores = os.cpus().length;
  let hostCpu = null, processCpu = null;
  if (previousCpu && cpu.total > previousCpu.total) hostCpu = round((1 - (cpu.idle - previousCpu.idle) / (cpu.total - previousCpu.total)) * 100);
  if (previousProcess && now > previousProcess.at) processCpu = round((usage.user + usage.system - previousProcess.used) / ((now - previousProcess.at) * 1000) / cores * 100);
  previousCpu = cpu; previousProcess = { at: now, used: usage.user + usage.system };
  let disk = null;
  // fs.statfs needs Node 18.15+; on older runtimes disk usage is simply unavailable.
  try { if (typeof fsp.statfs === "function") { const stats = await fsp.statfs(process.cwd()); disk = { total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize }; } } catch { /* not supported */ }
  const memory = process.memoryUsage();
  return {
    checkedAt: new Date(now),
    host: { cpuPercent: hostCpu, cores, loadAverage: process.platform === "win32" ? null : round(os.loadavg()[0]), memoryTotal: os.totalmem(), memoryFree: await availableMemory(), uptimeSeconds: Math.round(os.uptime()) },
    container: await containerMemory(),
    process: { cpuPercent: processCpu, rss: memory.rss, heapUsed: memory.heapUsed, uptimeSeconds: Math.round(process.uptime()) },
    disk, gpus: await gpus(),
  };
}

export const hostDescription = () => ({ platform: process.platform, arch: process.arch, cores: os.cpus().length, nodeVersion: process.version });
