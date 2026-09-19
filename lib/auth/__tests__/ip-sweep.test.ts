import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));

import {
  accountKey,
  checkIpLogin,
  IP_REGISTRATION_WINDOW_MS,
  IP_SWEEP_INTERVAL_MS,
  recordIpLoginFailure,
  setThrottleStore,
  takeRegistrationSlot,
} from "../throttle";
import { createMemoryThrottleStore } from "./memory-throttle-store";

const T0 = new Date("2026-09-19T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
let store: ReturnType<typeof createMemoryThrottleStore>;

beforeEach(() => {
  store = createMemoryThrottleStore();
  setThrottleStore(store);
});

describe("raw IP rows are purged once their window is over", () => {
  test("old login and sign-up IP rows go; recent ones and account rows stay", async () => {
    await recordIpLoginFailure("1.1.1.1", T0);
    await takeRegistrationSlot("2.2.2.2", T0);
    store.rows.set(accountKey("a@b.c"), {
      key: accountKey("a@b.c"),
      failures: 3,
      lockLevel: 3,
      lockedUntil: null,
      emailLocked: true,
      windowStart: T0,
    });

    const later = at(IP_REGISTRATION_WINDOW_MS + 1);
    await recordIpLoginFailure("3.3.3.3", later);
    await checkIpLogin("3.3.3.3", later);

    expect([...store.rows.keys()].sort()).toEqual([accountKey("a@b.c"), "login-ip:3.3.3.3"].sort());
  });

  test("sweeps at most once per interval", async () => {
    const stale = IP_REGISTRATION_WINDOW_MS + 1;
    await checkIpLogin("9.9.9.9", T0); // sweeps now
    await recordIpLoginFailure("1.1.1.1", T0);

    await checkIpLogin("9.9.9.9", at(IP_SWEEP_INTERVAL_MS - 1));
    expect(store.rows.has("login-ip:1.1.1.1")).toBe(true); // too soon to sweep again

    await checkIpLogin("9.9.9.9", at(stale));
    expect(store.rows.has("login-ip:1.1.1.1")).toBe(false);
  });
});
