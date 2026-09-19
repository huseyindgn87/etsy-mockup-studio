import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/jobs/worker-route", () => ({
  handleWorkerRequest: vi.fn(async () => new Response(JSON.stringify({ slices: [] }), { status: 200 })),
}));

import { GET } from "@/app/api/jobs/cron/route";
import { handleWorkerRequest } from "@/lib/jobs/worker-route";

const SECRET = "s".repeat(40);

beforeEach(() => {
  vi.mocked(handleWorkerRequest).mockClear();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/jobs/cron", () => {
  test("uses SCHEDULE_RUNNER_SECRET to authenticate when called without authorization header", async () => {
    vi.stubEnv("SCHEDULE_RUNNER_SECRET", SECRET);
    const res = await GET(new Request("http://localhost/api/jobs/cron"));
    expect(res.status).toBe(200);
    expect(handleWorkerRequest).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(handleWorkerRequest).mock.calls[0][0] as Request;
    expect(callArgs.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
  });

  test("rejects with 503 when SCHEDULE_RUNNER_SECRET is not configured", async () => {
    vi.stubEnv("SCHEDULE_RUNNER_SECRET", "");
    const res = await GET(new Request("http://localhost/api/jobs/cron"));
    expect(res.status).toBe(503);
    expect(handleWorkerRequest).not.toHaveBeenCalled();
  });

  test("passes through when authorization header is already set", async () => {
    vi.stubEnv("SCHEDULE_RUNNER_SECRET", SECRET);
    const res = await GET(
      new Request("http://localhost/api/jobs/cron", {
        headers: { authorization: "Bearer custom-token" },
      }),
    );
    expect(res.status).toBe(200);
    expect(handleWorkerRequest).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(handleWorkerRequest).mock.calls[0][0] as Request;
    expect(callArgs.headers.get("authorization")).toBe("Bearer custom-token");
  });

  test("exports cron expression for every 2 minutes", async () => {
    const { cron } = await import("@/app/api/jobs/cron/route");
    expect(cron).toBe("*/2 * * * *");
  });
});
