import mongoose from "mongoose";

// Database size and health from commands the connected user may run. Cached for five minutes so
// dashboard refreshes do not repeat them. Data size, storage used and server memory are kept
// separate: they measure different things and none substitutes for another.
const TTL = 5 * 60_000;
let cache = null;

export const isAtlas = () => /\.mongodb\.net(?:[:/]|$)/.test(String(process.env.MONGO_URI || "").replace(/^mongodb(\+srv)?:\/\/[^@]*@/, ""));
const positive = value => typeof value === "number" && value > 0 ? value : null;

async function measure() {
  const db = mongoose.connection.db, started = Date.now();
  const [stats, hello, build, status] = await Promise.all([
    db.command({ dbStats: 1 }),
    db.admin().command({ hello: 1 }),
    db.admin().command({ buildInfo: 1 }).catch(() => null),
    db.admin().command({ serverStatus: 1, repl: 0, metrics: 0, locks: 0, wiredTiger: 0, opcounters: 0, opcountersRepl: 0, network: 0, asserts: 0 }).catch(() => null),
  ]);
  const residentMb = positive(status?.mem?.resident);
  return {
    provider: isAtlas() ? "MongoDB Atlas" : "MongoDB", database: db.databaseName, version: build?.version || null,
    replicaSet: hello.setName ? { name: hello.setName, members: hello.hosts?.length ?? null, writablePrimary: Boolean(hello.isWritablePrimary) } : null,
    dataSize: stats.dataSize, storageSize: stats.storageSize, indexSize: stats.indexSize, objects: stats.objects, collections: stats.collections,
    // Only dedicated clusters report the volume's size; shared tiers omit it.
    filesystem: positive(stats.fsTotalSize) ? { used: stats.fsUsedSize, total: stats.fsTotalSize } : null,
    connections: status?.connections && typeof status.connections.current === "number" ? { current: status.connections.current, available: status.connections.available ?? null } : null,
    memory: residentMb ? { residentBytes: residentMb * 2 ** 20 } : null,
    memoryUnavailableReason: residentMb ? null : status ? "The database server reports no memory figures to this connection (Atlas shared tiers return zero); cluster memory needs Atlas Admin API access." : "serverStatus is not permitted for this database user.",
    cpuUnavailableReason: "Cluster CPU is only exposed by the Atlas Admin API (monitoring) or the Atlas UI.",
    pingMs: Date.now() - started, checkedAt: new Date(),
  };
}

export async function databaseMetrics() {
  if (cache && Date.now() - cache.at < TTL) return cache.value;
  const value = await measure();
  cache = { at: Date.now(), value };
  return value;
}
