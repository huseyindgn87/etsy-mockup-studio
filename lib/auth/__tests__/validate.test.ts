import { describe, expect, test } from "vitest";
import { isValidEmail, isValidPassword, normalizeEmail, validateRegistration } from "../validate";

describe("isValidEmail", () => {
  test("accepts a normal address", () => {
    expect(isValidEmail("seller@example.com")).toBe(true);
  });

  test.each(["not-an-email", "missing-domain@", "@missing-local.com", "no-at-sign.com", ""])(
    "rejects %s",
    (bad) => {
      expect(isValidEmail(bad)).toBe(false);
    },
  );
});

describe("isValidPassword", () => {
  test("rejects fewer than 8 characters", () => {
    expect(isValidPassword("short7c")).toBe(false);
  });

  test("accepts exactly 8 characters", () => {
    expect(isValidPassword("exactly8")).toBe(true);
  });
});

describe("normalizeEmail", () => {
  test("trims and lowercases", () => {
    expect(normalizeEmail("  Seller@Example.COM  ")).toBe("seller@example.com");
  });
});

describe("validateRegistration", () => {
  const base = {
    email: "seller@example.com",
    password: "goodpassword",
    confirmPassword: "goodpassword",
    acceptTerms: true,
  };

  test("accepts a valid registration", () => {
    const result = validateRegistration(base);
    expect(result).toEqual({ ok: true, email: "seller@example.com", password: "goodpassword" });
  });

  test("rejects an invalid email", () => {
    const result = validateRegistration({ ...base, email: "not-an-email" });
    expect(result).toEqual({ ok: false, error: "invalid_email" });
  });

  test("rejects a weak (short) password", () => {
    const result = validateRegistration({ ...base, password: "short", confirmPassword: "short" });
    expect(result).toEqual({ ok: false, error: "weak_password" });
  });

  test("rejects mismatched password confirmation", () => {
    const result = validateRegistration({ ...base, confirmPassword: "somethingElse123" });
    expect(result).toEqual({ ok: false, error: "password_mismatch" });
  });

  test("rejects a registration that hasn't accepted the Terms and Privacy Policy", () => {
    expect(validateRegistration({ ...base, acceptTerms: false })).toEqual({ ok: false, error: "terms_not_accepted" });
    expect(validateRegistration({ ...base, acceptTerms: "true" })).toEqual({ ok: false, error: "terms_not_accepted" });
    expect(validateRegistration({ ...base, acceptTerms: undefined })).toEqual({ ok: false, error: "terms_not_accepted" });
  });

  test("rejects a non-string password", () => {
    const result = validateRegistration({ ...base, password: 12345678 });
    expect(result).toEqual({ ok: false, error: "weak_password" });
  });
});
