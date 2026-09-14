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
