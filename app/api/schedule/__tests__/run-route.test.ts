import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/jobs/run", () => ({
  runJobsPass: vi.fn(async () => ({ scheduledQueued: 1, slices: [{ jobId: "j1", userId: "u1", type: "scheduled_listing", outcome: "done" }], heldForBudget: [] })),
}));

import { POST as JOBS_POST } from "@/app/api/jobs/run/route";
import { POST } from "@/app/api/schedule/run/route";
import { decideRouteAccess } from "@/lib/auth/route-guard";
import { runJobsPass } from "@/lib/jobs/run";
import { isAuthorizedRunnerRequest } from "@/lib/scheduling/runner-auth";


const SECRET = "s".repeat(40);

function call(authorization?: string) {
  return POST(
    new Request("http://localhost/api/schedule/run", {
      method: "POST",
      headers: authorization ? { Authorization: authorization } : {},
    }),
  );
}

beforeEach(() => {
  vi.mocked(runJobsPass).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/schedule/run", () => {
  test("is disabled (503) until SCHEDULE_RUNNER_SECRET is set — and when it's too short", async () => {
    vi.stubEnv("SCHEDULE_RUNNER_SECRET", "");
    expect((await call(`Bearer ${SECRET}`)).status).toBe(503);
    vi.stubEnv("SCHEDULE_RUNNER_SECRET", "short");
    expect((await call("Bearer short")).status).toBe(503);
    expect(runJobsPass).not.toHaveBeenCalled();
  });

  test("401 without the right shared secret", async () => {
    vi.stubEnv("SCHEDULE_RUNNER_SECRET", SECRET);
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect((await call(SECRET)).status).toBe(401);
    expect(runJobsPass).not.toHaveBeenCalled();
  });

  test("runs a job-worker pass (which queues due schedules) and returns its result with the right secret", async () => {
    vi.stubEnv("SCHEDULE_RUNNER_SECRET", SECRET);
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ scheduledQueued: 1, slices: [{ jobId: "j1", outcome: "done" }] });
    expect(runJobsPass).toHaveBeenCalledTimes(1);
  });

  test("POST /api/jobs/run is the same worker behind the same secret", async () => {
    vi.stubEnv("SCHEDULE_RUNNER_SECRET", SECRET);
    const unauthorized = await JOBS_POST(new Request("http://localhost/api/jobs/run", { method: "POST" }));
    expect(unauthorized.status).toBe(401);
    const res = await JOBS_POST(
      new Request("http://localhost/api/jobs/run", { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } }),
    );
    expect(res.status).toBe(200);
    expect(decideRouteAccess("/api/jobs/run", false)).toEqual({ action: "next" });
    expect(decideRouteAccess("/api/jobs/abc", false)).toEqual({ action: "unauthorized" });
  });

  test("the secret comparison is exact", () => {
    expect(isAuthorizedRunnerRequest(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isAuthorizedRunnerRequest(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isAuthorizedRunnerRequest(`bearer ${SECRET}`, SECRET)).toBe(false);
    expect(isAuthorizedRunnerRequest(null, SECRET)).toBe(false);
  });

  test("the route guard lets the runner through without an app session, but nothing else under /api/schedule", () => {
    expect(decideRouteAccess("/api/schedule/run", false)).toEqual({ action: "next" });
    expect(decideRouteAccess("/api/schedule", false)).toEqual({ action: "unauthorized" });
    expect(decideRouteAccess("/api/schedule/renders/x/image-00", false)).toEqual({ action: "unauthorized" });
  });
});
