import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { configureEtsyClient, createMemoryRateLimitStore } from "@/lib/etsy/client";

// Only relevant to jsdom component tests; harmless for the node-environment
// unit tests, which never render anything for this to unmount.
afterEach(cleanup);

// The Etsy client's limiter state lives in Postgres; tests get an unthrottled
// in-memory store and no real waits. client.test.ts sets its own.
beforeEach(() => {
  configureEtsyClient("reset");
  configureEtsyClient({ store: createMemoryRateLimitStore({ perSecondLimit: 1_000_000 }), sleep: async () => {} });
});
