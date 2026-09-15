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
