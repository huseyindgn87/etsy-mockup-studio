// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
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
