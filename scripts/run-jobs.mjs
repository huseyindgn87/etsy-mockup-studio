/**
 * Runs the Etsy job worker on demand: queues due scheduled listings and works
 * the job queue once, by calling the app's own `POST /api/jobs/run`.
 *
 *   npm run jobs:run            one pass
 *   npm run jobs:run -- --watch a pass every 10 s until Ctrl-C (JOBS_WATCH_SECONDS to change)
 *
 * Needs the app running (`npm run dev`) and `SCHEDULE_RUNNER_SECRET` in
 * .env.local. `SCHEDULE_RUNNER_URL` overrides where it sends the request.
 * No hosted cron is set up — this is the local stand-in for one.
 */
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

const secret = process.env.SCHEDULE_RUNNER_SECRET;
if (!secret) {
  console.error("SCHEDULE_RUNNER_SECRET is not set — add it to .env.local (see .env.example).");
  process.exit(1);
}

const base = (process.env.SCHEDULE_RUNNER_URL || "http://localhost:3000").replace(/\/+$/, "");
const watch = process.argv.includes("--watch");
const intervalMs = Math.max(1, Number(process.env.JOBS_WATCH_SECONDS) || 10) * 1000;

async function pass() {
  let res;
  try {
    res = await fetch(`${base}/api/jobs/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    });
  } catch (err) {
    console.error(`Couldn't reach ${base} — is the app running (npm run dev)?`);
    console.error(err instanceof Error ? err.message : err);
    return false;
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    console.error(`The worker responded ${res.status}:`, body);
    return false;
  }
  console.log(`[${new Date().toISOString()}]`, JSON.stringify(body, null, 2));
  return true;
}

if (!watch) process.exit((await pass()) ? 0 : 1);
for (;;) {
  await pass();
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
