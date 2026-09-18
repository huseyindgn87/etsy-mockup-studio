// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import RegisterPage from "../page";

describe("RegisterPage — branding", () => {
  test("shows Listhouse on a still glass card (no sheen)", () => {
    render(<RegisterPage />);
    expect(screen.getByText("Listhouse")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/etsy mockup studio/i);

    const card = screen.getByRole("main");
    expect(card).toHaveClass("rounded-card", "bg-surface", "backdrop-blur-md");
    expect(card).not.toHaveClass("entry-card");
  });

  test("both password fields keep their show/hide toggle", () => {
    render(<RegisterPage />);
    expect(screen.getAllByRole("button", { name: "Show password" })).toHaveLength(2);
  });
});

describe("RegisterPage — Terms and Privacy checkbox", () => {
  function fillForm() {
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "seller@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "goodpassword" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "goodpassword" } });
  }

  test("is unticked, required, and links to the Terms and Privacy Policy", () => {
    render(<RegisterPage />);
    const box = screen.getByRole("checkbox", { name: /I agree to the Terms and Privacy Policy/ });
    expect(box).not.toBeChecked();
    expect(box).toBeRequired();
    const label = within(box.closest("label")!);
    expect(label.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(label.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
  });

  test("submitting without ticking it shows an error and sends nothing", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<RegisterPage />);
      fillForm();
      fireEvent.submit(screen.getByRole("button", { name: "Create account" }).closest("form")!);
      expect(screen.getByText("You must agree to the Terms and Privacy Policy.")).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("once ticked, the sign-up request carries acceptTerms: true", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<RegisterPage />);
      fillForm();
      fireEvent.click(screen.getByRole("checkbox", { name: /I agree/ }));
      fireEvent.submit(screen.getByRole("button", { name: "Create account" }).closest("form")!);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/api/auth/register");
      expect(JSON.parse(init.body as string)).toMatchObject({ email: "seller@example.com", acceptTerms: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("shows the legal footer", () => {
    render(<RegisterPage />);
    const footer = screen.getByRole("navigation", { name: "Legal" });
    expect(footer).toHaveTextContent("Cookie Policy");
  });
});
