import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// Only relevant to jsdom component tests; harmless for the node-environment
// unit tests, which never render anything for this to unmount.
afterEach(cleanup);
