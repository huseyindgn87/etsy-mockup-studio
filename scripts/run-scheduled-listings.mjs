/**
 * Runs the scheduled-listing runner once, on demand: publishes every
 * scheduled listing that's due by calling the app's own
 * `POST /api/schedule/run`.
 *
 *   npm run schedule:run
 *
 * Needs the app running (`npm run dev`) and `SCHEDULE_RUNNER_SECRET` in
 * .env.local. `SCHEDULE_RUNNER_URL` overrides where it sends the request.
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

let res;
try {
  res = await fetch(`${base}/api/schedule/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });
} catch (err) {
  console.error(`Couldn't reach ${base} — is the app running (npm run dev)?`);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = text;
}
if (!res.ok) {
  console.error(`The runner responded ${res.status}:`, body);
  process.exit(1);
}
console.log(JSON.stringify(body, null, 2));
