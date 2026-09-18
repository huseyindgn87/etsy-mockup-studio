// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { signInMock, pushMock, refreshMock } = vi.hoisted(() => ({
  signInMock: vi.fn(),
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock("next-auth/react", () => ({ signIn: signInMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/app/components/Turnstile", () => ({
  default: ({ onToken }: { onToken: (token: string) => void }) => (
    <button type="button" onClick={() => onToken("turnstile-token")}>
      Pass human check
    </button>
  ),
}));

import LoginPage from "../page";

beforeEach(() => {
  signInMock.mockReset().mockResolvedValue({ error: null });
  pushMock.mockReset();
  refreshMock.mockReset();
});

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "seller@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "goodpassword" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("LoginPage", () => {
  test("the \"Keep me signed in\" checkbox is unchecked by default", () => {
    render(<LoginPage />);
    const checkbox = screen.getByRole("checkbox", { name: "Keep me signed in" });
    expect(checkbox).not.toBeChecked();
  });

  test("the password field has a show/hide toggle that doesn't submit the form", () => {
    render(<LoginPage />);
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toBeInTheDocument();
    expect(signInMock).not.toHaveBeenCalled();
  });

  test("signing in without checking it sends rememberMe: false", async () => {
    render(<LoginPage />);
    fillAndSubmit();

    await waitFor(() => expect(signInMock).toHaveBeenCalled());
    expect(signInMock).toHaveBeenCalledWith("credentials", {
      email: "seller@example.com",
      password: "goodpassword",
      rememberMe: false,
      redirect: false,
    });
  });

  test("checking it sends rememberMe: true", async () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep me signed in" }));
    fillAndSubmit();

    await waitFor(() => expect(signInMock).toHaveBeenCalled());
    expect(signInMock).toHaveBeenCalledWith("credentials", {
      email: "seller@example.com",
      password: "goodpassword",
      rememberMe: true,
      redirect: false,
    });
  });
});

describe("LoginPage — two-factor step", () => {
  function requireTwoFactorThen(result: { error: string | null; code?: string }) {
    signInMock
      .mockReset()
      .mockResolvedValueOnce({ error: "CredentialsSignin", code: "two_factor_required" })
      .mockResolvedValueOnce(result);
  }

  test("asks for a 6-digit code when the account has 2FA, and doesn't navigate yet", async () => {
    requireTwoFactorThen({ error: null });
    render(<LoginPage />);
    fillAndSubmit();

    expect(await screen.findByRole("heading", { name: "Two-factor authentication" })).toBeInTheDocument();
    expect(screen.getByLabelText("Authentication code")).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });

  test("signs in with email, password and the code together", async () => {
    requireTwoFactorThen({ error: null });
    render(<LoginPage />);
    fillAndSubmit();

    fireEvent.change(await screen.findByLabelText("Authentication code"), { target: { value: "123 456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/"));
    expect(signInMock).toHaveBeenLastCalledWith("credentials", {
      email: "seller@example.com",
      password: "goodpassword",
      rememberMe: false,
      code: "123456",
      redirect: false,
    });
  });

  test("accepts a recovery code instead", async () => {
    requireTwoFactorThen({ error: null });
    render(<LoginPage />);
    fillAndSubmit();

    fireEvent.click(await screen.findByRole("button", { name: "Use a recovery code instead" }));
    fireEvent.change(screen.getByLabelText("Recovery code"), { target: { value: "ABCDE-FGHJK" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(signInMock).toHaveBeenLastCalledWith(
      "credentials",
      expect.objectContaining({ recoveryCode: "ABCDE-FGHJK" }),
    );
    expect(signInMock.mock.lastCall![1]).not.toHaveProperty("code");
  });

  test("a wrong code stays on the code step with an error", async () => {
    requireTwoFactorThen({ error: "CredentialsSignin", code: "invalid_two_factor_code" });
    render(<LoginPage />);
    fillAndSubmit();

    fireEvent.change(await screen.findByLabelText("Authentication code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/didn't work/i);
    expect(screen.getByLabelText("Authentication code")).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });

  test("a wrong password never reaches the code step", async () => {
    signInMock.mockReset().mockResolvedValue({ error: "CredentialsSignin" });
    render(<LoginPage />);
    fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect email or password.");
    expect(screen.queryByLabelText("Authentication code")).not.toBeInTheDocument();
  });
});

describe("LoginPage — branding", () => {
  test("shows Listhouse on a still glass card (no sheen)", () => {
    render(<LoginPage />);
    expect(screen.getByText("Listhouse")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/etsy mockup studio/i);

    const card = screen.getByRole("main");
    expect(card).toHaveClass("rounded-card", "bg-surface", "backdrop-blur-md");
    expect(card).not.toHaveClass("entry-card");
  });
});

describe("LoginPage — brute-force limits", () => {
  test("a lock says when to try again and then asks for the human check", async () => {
    const until = new Date(Date.now() + 3 * 60_000);
    signInMock.mockReset().mockResolvedValueOnce({ error: "CredentialsSignin", code: `account_locked:${until.getTime()}` });
    render(<LoginPage />);
    fillAndSubmit();

    const clock = until.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      `Too many failed attempts. Try again at ${clock} (in 3 minutes).`,
    );
    expect(screen.getByRole("button", { name: "Pass human check" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  });

  test("the human-check token is sent with the next attempt, once", async () => {
    signInMock
      .mockReset()
      .mockResolvedValueOnce({ error: "CredentialsSignin", code: "human_check_required" })
      .mockResolvedValueOnce({ error: null });
    render(<LoginPage />);
    fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent("Complete the human check below, then try again.");
    fireEvent.click(screen.getByRole("button", { name: "Pass human check" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "goodpassword" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/"));
    expect(signInMock).toHaveBeenLastCalledWith(
      "credentials",
      expect.objectContaining({ turnstileToken: "turnstile-token" }),
    );
  });

  test("3 wrong 2FA codes send the user back to sign in again", async () => {
    const until = Date.now() + 3 * 60_000;
    signInMock
      .mockReset()
      .mockResolvedValueOnce({ error: "CredentialsSignin", code: "two_factor_required" })
      .mockResolvedValueOnce({ error: "CredentialsSignin", code: `account_locked:${until}` });
    render(<LoginPage />);
    fillAndSubmit();
    fireEvent.change(await screen.findByLabelText("Authentication code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent(/Too many failed attempts\. Try again at/);
  });

  test("the IP limit and the email-verification lock each have their own message", async () => {
    signInMock
      .mockReset()
      .mockResolvedValueOnce({ error: "CredentialsSignin", code: `rate_limited:${Date.now() + 10 * 60_000}` })
      .mockResolvedValueOnce({ error: "CredentialsSignin", code: "email_verification_locked" });
    render(<LoginPage />);
    fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Too many failed sign-in attempts from this network\. Try again at .* \(in 10 minutes\)\./,
    );

    fillAndSubmit();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/locked after too many failed sign-in attempts.*verifying by email/),
    );
    expect(document.body.textContent).not.toMatch(/seller@example\.com.*(exist|not found)/i);
  });
});
