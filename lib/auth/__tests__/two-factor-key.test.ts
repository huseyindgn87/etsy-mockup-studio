import { afterEach, describe, expect, test, vi } from "vitest";
import { encryptToken } from "@/lib/etsy/token-crypto";
import {
  decryptTwoFactorSecret,
  encryptTwoFactorSecret,
  getTwoFactorKey,
  TwoFactorKeyError,
} from "../two-factor-key";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("TWO_FACTOR_ENCRYPTION_KEY", () => {
  test("a missing key throws a clear, actionable error", () => {
    vi.stubEnv("TWO_FACTOR_ENCRYPTION_KEY", "");
    expect(() => getTwoFactorKey()).toThrow(TwoFactorKeyError);
    expect(() => getTwoFactorKey()).toThrow(/Missing TWO_FACTOR_ENCRYPTION_KEY.*openssl rand -base64 32.*\.env\.local/);
  });

  test("a too-short key is rejected", () => {
    vi.stubEnv("TWO_FACTOR_ENCRYPTION_KEY", "short");
    expect(() => getTwoFactorKey()).toThrow(/at least 32 characters/);
  });

  test("secrets are encrypted (not stored in plain text) and round-trip", () => {
    vi.stubEnv("TWO_FACTOR_ENCRYPTION_KEY", "test-two-factor-key-0123456789abcdef");
    const sealed = encryptTwoFactorSecret("JBSWY3DPEHPK3PXP");
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(sealed.split(".")).toHaveLength(3);
    expect(encryptTwoFactorSecret("JBSWY3DPEHPK3PXP")).not.toBe(sealed); // random IV
    expect(decryptTwoFactorSecret(sealed)).toBe("JBSWY3DPEHPK3PXP");
  });

  test("uses its own key — a secret sealed under a different key (e.g. the Etsy one) won't open", () => {
    vi.stubEnv("TWO_FACTOR_ENCRYPTION_KEY", "test-two-factor-key-0123456789abcdef");
    const sealedWithEtsyKey = encryptToken("JBSWY3DPEHPK3PXP", "a-different-etsy-session-secret-0123456789");
    expect(() => decryptTwoFactorSecret(sealedWithEtsyKey)).toThrow();
  });
});
