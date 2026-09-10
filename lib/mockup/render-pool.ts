/**
 * `worker_threads` pool for the batch endpoint — keeps heavy `compose` + encode
 * off the request thread and spreads it across cores. Sized to `cpus - 1`
 * (capped, so N workers × sharp stays within memory).
 *
 * Server-only: spawns `render.worker.ts` (a native-Node TS worker). Never import
 * from `lib/mockup/index.ts`. Assumes the repo source is present at runtime
 * (`process.cwd()/lib/mockup/*`), which holds for a normal `next build`; a
 * `output: "standalone"` deploy would need those files copied in.
 */

import { cpus } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { RenderJobInput, RenderJobResult } from "./render-types";

// Node loads the `.ts` worker through the ESM loader, which needs a file:// URL
// (a bare `C:\…` path is rejected on Windows).
const WORKER_URL = pathToFileURL(
  process.env.MOCKUP_RENDER_WORKER ||
    path.join(process.cwd(), "lib", "mockup", "render.worker.ts"),
);
const BOOTSTRAP_URL = pathToFileURL(
  path.join(process.cwd(), "lib", "mockup", "render-worker-bootstrap.mjs"),
).href;

function collectTransfers(job: RenderJobInput): ArrayBuffer[] {
  const t: ArrayBuffer[] = [job.mock];
  if (job.design) t.push(job.design);
  if (job.areaDesigns) for (const b of job.areaDesigns) if (b) t.push(b);
  for (const o of job.overlays) t.push(o.bytes);
  return t;
}

interface QueueItem {
  job: RenderJobInput;
  id: number;
  resolve: (r: RenderJobResult) => void;
}

export class RenderPool {
  private readonly size: number;
  private readonly workers = new Set<Worker>();
  private readonly idle: Worker[] = [];
  private readonly busy = new Map<Worker, QueueItem>();
  private readonly queue: QueueItem[] = [];
  private seq = 0;
  private successes = 0;
  private spawnFailures = 0;
  private brokenError: string | null = null;
  private closed = false;

  constructor(size: number) {
    this.size = Math.max(1, size);
  }

  run(job: RenderJobInput): Promise<RenderJobResult> {
    if (this.closed) return Promise.resolve({ ok: false, error: "render pool is closed" });
    if (this.brokenError) return Promise.resolve({ ok: false, error: this.brokenError });
    return new Promise((resolve) => {
      this.queue.push({ job, id: this.seq++, resolve });
      this.pump();
    });
  }

  private pump(): void {
    while (this.queue.length > 0) {
      let worker = this.idle.pop();
      if (!worker) {
        if (this.workers.size >= this.size) return;
        worker = this.spawn();
      }
      const item = this.queue.shift()!;
      this.busy.set(worker, item);
      worker.postMessage({ ...item.job, id: item.id }, collectTransfers(item.job));
    }
  }

  private settle(worker: Worker, result: RenderJobResult, keepWorker: boolean): void {
    const item = this.busy.get(worker);
    this.busy.delete(worker);
    if (item) item.resolve(result);
    if (keepWorker && !this.closed) {
      this.idle.push(worker);
      this.pump();
    }
  }

  private fail(message: string): void {
    this.brokenError = message;
    for (const item of this.queue.splice(0)) item.resolve({ ok: false, error: message });
    for (const [worker, item] of this.busy) {
      item.resolve({ ok: false, error: message });
      this.busy.delete(worker);
    }
  }

  private spawn(): Worker {
    const worker = new Worker(WORKER_URL, {
      execArgv: [
        "--import",
        BOOTSTRAP_URL,
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      ],
    });
    this.workers.add(worker);

    worker.on("message", (msg: RenderJobResult & { id: number }) => {
      this.successes++;
      this.settle(worker, msg, true);
    });

    worker.on("error", (err) => {
      this.workers.delete(worker);
      const i = this.idle.indexOf(worker);
      if (i >= 0) this.idle.splice(i, 1);
      this.settle(worker, { ok: false, error: `render worker crashed: ${err.message}` }, false);
      void worker.terminate().catch(() => {});

      // If workers keep dying before ever completing a job, the worker module is
      // broken (bad path, resolve hook, native dep) — stop retrying.
      this.spawnFailures++;
      if (this.successes === 0 && this.spawnFailures >= this.size) {
        this.fail(`render worker failed to start: ${err.message}`);
      } else if (!this.closed) {
        this.pump();
      }
    });

    return worker;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const item of this.queue.splice(0)) {
      item.resolve({ ok: false, error: "render pool closed before job ran" });
    }
    for (const [, item] of this.busy) {
      item.resolve({ ok: false, error: "render pool closed mid-job" });
    }
    this.busy.clear();
    await Promise.all([...this.workers].map((w) => w.terminate().catch(() => {})));
    this.workers.clear();
    this.idle.length = 0;
  }

  get workerCount(): number {
    return this.workers.size;
  }
}

let shared: RenderPool | null = null;

/** Process-wide pool. */
export function getRenderPool(): RenderPool {
  if (!shared) {
    shared = new RenderPool(Math.max(1, Math.min(4, (cpus().length || 2) - 1)));
  }
  return shared;
}
