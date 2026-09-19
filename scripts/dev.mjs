/**
 * Dev server with integrated schedule runner watcher.
 * Runs both "next dev" and "jobs:run --watch" in the same terminal.
 * Pass through any arguments to next dev.
 */
import { spawn } from "child_process";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

const secret = process.env.SCHEDULE_RUNNER_SECRET;
if (!secret) {
  console.error("Warning: SCHEDULE_RUNNER_SECRET not set — schedule runner disabled.");
  console.error("Add it to .env.local to enable automatic job processing (see .env.example).\n");
}

const nextArgs = ["dev", ...process.argv.slice(2)];
const nextProc = spawn("npx", nextArgs, { stdio: "inherit" });

if (secret) {
  setTimeout(() => {
    console.log("\n[dev] Starting schedule runner watcher (polling every 10s)...\n");
    const jobsArgs = ["run", "jobs:run", "--", "--watch"];
    const jobsProc = spawn("npm", jobsArgs, { stdio: "inherit" });

    const cleanup = () => {
      nextProc.kill();
      jobsProc.kill();
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }, 1000);
}

process.on("SIGINT", () => {
  nextProc.kill();
  process.exit(0);
});
