import { describe, expect, test } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  TOTP_PERIOD_SECONDS,
  totpAt,
  verifyTotp,
} from "../totp";

const RFC_KEY = Buffer.from("12345678901234567890");

describe("TOTP", () => {
  // RFC 6238 Appendix B, SHA-1 column (8-digit codes).
  test.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("matches the RFC 6238 test vector at T=%i", (t, expected) => {
    expect(hotp(RFC_KEY, Math.floor(t / TOTP_PERIOD_SECONDS), 8)).toBe(expected);
  });

  test("6-digit codes are the last six digits of the RFC vectors", () => {
    expect(totpAt(base32Encode(RFC_KEY), 59_000)).toBe("287082");
  });

  test("base32 follows RFC 4648 and round-trips", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("mzxw 6ytb-oi==").toString()).toBe("foobar");
    expect(() => base32Decode("NOT*BASE32")).toThrow();
  });

  test("secrets are 160 random bits, base32-encoded", () => {
    const a = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(a);
  });

  test("verifyTotp returns the matching step within ±1 step, else null", () => {
    const secret = base32Encode(RFC_KEY);
    const now = 1_234_567_890_000;
    const step = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);

    expect(verifyTotp(secret, hotp(RFC_KEY, step), now)).toBe(step);
    expect(verifyTotp(secret, hotp(RFC_KEY, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, hotp(RFC_KEY, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, hotp(RFC_KEY, step + 2), now)).toBeNull();
    expect(verifyTotp(secret, hotp(RFC_KEY, step - 2), now)).toBeNull();
  });

  test("verifyTotp rejects malformed input", () => {
    const secret = base32Encode(RFC_KEY);
    expect(verifyTotp(secret, "", 0)).toBeNull();
    expect(verifyTotp(secret, "12345", 0)).toBeNull();
    expect(verifyTotp(secret, "1234567", 0)).toBeNull();
    expect(verifyTotp(secret, "12a456", 0)).toBeNull();
  });

  test("otpauth URI carries the secret, issuer and standard parameters", () => {
    const uri = otpauthUri({ secret: "JBSWY3DPEHPK3PXP", accountName: "a+b@example.com", issuer: "Two Words" });
    expect(uri.startsWith("otpauth://totp/Two%20Words:a%2Bb%40example.com?")).toBe(true);
    const params = new URL(uri).searchParams;
    expect(params.get("secret")).toBe("JBSWY3DPEHPK3PXP");
    expect(params.get("issuer")).toBe("Two Words");
    expect(params.get("digits")).toBe("6");
    expect(params.get("period")).toBe("30");
  });
});
