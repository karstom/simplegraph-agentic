// simplegraph-agentic: filesystem safety for concurrent (multi-agent) writers.
//
// The graph is plain markdown mutated by short-lived MCP server processes —
// one per agent session. When two sessions share a checkout, two processes
// race on the same files with nothing to serialize them. Two hazards follow:
//
//   1. Torn reads: a reader observing a file mid-write sees a truncated node.
//   2. Lost updates: two read-modify-write cycles interleave and one is
//      silently dropped — worst case, a REGRESSED_N_TIMES increment vanishes,
//      exactly the signal the graph exists to preserve.
//
// atomicWriteFileSync closes (1): write a temp file, then rename over the
// target (rename is atomic within a filesystem, so readers see only the old
// or the new file, never a partial one).
//
// withGraphLock closes (2): a coarse advisory lock, one per graph root, held
// across the whole read-modify-write. Writes are infrequent and small, so a
// single graph-wide lock is simpler and safer than per-file locking with no
// meaningful contention cost.

import * as fs from "fs";
import * as path from "path";

/** Block the current thread for `ms` without a busy-spin (Atomics.wait). */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  // No other thread will ever notify index 0, so this always waits the full ms.
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * Atomically replace `fullPath` with `content`. The temp file is created in
 * the same directory so the rename stays within one filesystem (cross-device
 * rename would fall back to a non-atomic copy). The temp name carries the pid
 * so concurrent writers never collide on it.
 */
export function atomicWriteFileSync(fullPath: string, content: string): void {
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(fullPath)}.${process.pid}.${lockNonce()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, fullPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* temp already gone */ }
    throw e;
  }
}

// A per-write nonce so a single process issuing back-to-back writes to the
// same file never reuses a temp name. Deterministic (no Math.random) — a
// monotonic counter is enough to disambiguate within a process.
let _nonce = 0;
function lockNonce(): number {
  return _nonce++;
}

const LOCK_NAME = ".sg.lock";
// A lock older than this is presumed abandoned (holder crashed) and stolen.
// Graph writes complete in milliseconds, so seconds of slack is generous.
const STALE_LOCK_MS = 10_000;
// How long a writer waits for a contended lock before giving up.
const ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_MS = 25;

interface LockInfo { pid: number; time: number; }

function readLockInfo(lockPath: string): LockInfo | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8").trim().split(/\s+/);
    const pid = parseInt(raw[0], 10);
    const time = parseInt(raw[1], 10);
    if (Number.isNaN(pid) || Number.isNaN(time)) return null;
    return { pid, time };
  } catch {
    return null;
  }
}

/**
 * Run `fn` while holding the graph's advisory lock. The lock is a file created
 * with O_EXCL (an atomic "create only if absent"). On contention we retry with
 * a short sleep; a lock whose recorded timestamp is older than STALE_LOCK_MS is
 * treated as abandoned and removed so one crashed process can't wedge the graph
 * forever. The lock is always released in `finally`, including on throw.
 */
export function withGraphLock<T>(graphRoot: string, fn: () => T): T {
  const lockPath = path.join(graphRoot, LOCK_NAME);
  fs.mkdirSync(graphRoot, { recursive: true });
  const deadline = nowMs() + ACQUIRE_TIMEOUT_MS;

  for (;;) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(lockPath, "wx"); // wx = O_CREAT | O_EXCL: fails if it exists
      fs.writeSync(fd, `${process.pid} ${nowMs()}`);
      fs.closeSync(fd);
      break; // acquired
    } catch (e) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;

      // Someone holds it. Steal it if it's stale, otherwise wait and retry.
      const info = readLockInfo(lockPath);
      if (info && nowMs() - info.time > STALE_LOCK_MS) {
        try { fs.unlinkSync(lockPath); } catch { /* another writer stole it first */ }
        continue;
      }
      if (nowMs() > deadline) {
        throw new Error(
          `Could not acquire graph lock at ${lockPath} within ${ACQUIRE_TIMEOUT_MS}ms ` +
          `(held by pid ${info?.pid ?? "?"}). Another agent may be writing; retry shortly.`
        );
      }
      sleepSync(RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* already released/stolen */ }
  }
}

// Wall-clock read for lock timestamps only — never committed, never part of
// node content, so this does not affect the seed pipeline's determinism.
function nowMs(): number {
  return Date.now();
}
