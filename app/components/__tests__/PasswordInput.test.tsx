// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import PasswordInput from "../PasswordInput";

function renderField(onSubmit = vi.fn((e: { preventDefault(): void }) => e.preventDefault())) {
  render(
    <form onSubmit={onSubmit}>
      <label htmlFor="pw">Password</label>
      <PasswordInput id="pw" defaultValue="hunter22" />
    </form>,
  );
  return { input: screen.getByLabelText("Password") as HTMLInputElement, onSubmit };
}

describe("PasswordInput", () => {
  test("starts masked, with a \"Show password\" toggle", () => {
    const { input } = renderField();
    expect(input).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Show password" })).toBeInTheDocument();
  });

  test("clicking the toggle reveals the password and flips the aria-label", () => {
    const { input } = renderField();
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input).toHaveAttribute("type", "text");
    expect(input.value).toBe("hunter22");

    const hide = screen.getByRole("button", { name: "Hide password" });
    fireEvent.click(hide);
    expect(input).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Show password" })).toBeInTheDocument();
  });

  test("the toggle is keyboard reachable and never submits the form", () => {
    const { onSubmit } = renderField();
    const toggle = screen.getByRole("button", { name: "Show password" });

    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle).toHaveAttribute("type", "button");
    expect(toggle).not.toHaveAttribute("tabindex", "-1");
    expect(toggle).toHaveAttribute("aria-controls", "pw");

    toggle.focus();
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle); // what Enter/Space dispatch on a native button
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
