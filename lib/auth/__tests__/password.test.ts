import { describe, expect, test } from "vitest";
import { hashPassword, verifyPassword } from "../password";

describe("password hashing", () => {
  test("never stores the plaintext password — the hash doesn't contain it", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toContain("correct horse battery staple");
  });

  test("produces a bcrypt hash at cost 12", async () => {
    const hash = await hashPassword("hunter22");
    // bcrypt format: $2<a|b|y>$<cost>$<22-char salt><31-char hash>
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
  });

  test("two hashes of the same password differ (random salt per hash)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  test("verifyPassword accepts the correct password", async () => {
    const hash = await hashPassword("hunter22");
    expect(await verifyPassword("hunter22", hash)).toBe(true);
  });

  test("verifyPassword rejects an incorrect password", async () => {
    const hash = await hashPassword("hunter22");
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });
});
