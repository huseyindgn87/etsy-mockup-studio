/**
 * Shared-secret check for `POST /api/schedule/run`. Pure, so it's unit-testable.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const RUNNER_SECRET_ENV = "SCHEDULE_RUNNER_SECRET";
export const MIN_RUNNER_SECRET_LENGTH = 32;

/** The configured secret, or `null` when it's unset or too short to trust. */
export function runnerSecret(env: Record<string, string | undefined> = process.env): string | null {
  const secret = env[RUNNER_SECRET_ENV];
  return secret && secret.length >= MIN_RUNNER_SECRET_LENGTH ? secret : null;
}

/** Whether `authorization` is exactly `Bearer <secret>`, compared in constant time. */
export function isAuthorizedRunnerRequest(authorization: string | null, secret: string): boolean {
  if (!authorization || !authorization.startsWith("Bearer ")) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(authorization.slice("Bearer ".length)), digest(secret));
}
