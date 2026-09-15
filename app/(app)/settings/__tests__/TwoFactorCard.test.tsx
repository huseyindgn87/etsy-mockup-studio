// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

import TwoFactorCard from "../TwoFactorCard";

const OFF = { enabled: false, remainingRecoveryCodes: 0, configError: null };
const ON = { enabled: true, remainingRecoveryCodes: 7, configError: null };
const CODES = Array.from({ length: 10 }, (_, i) => `AAAA${i}-BBBB${i}`.replace(/[01]/g, "2"));

let fetchMock: ReturnType<typeof vi.fn>;
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  refreshMock.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TwoFactorCard — enable", () => {
  test("shows the QR code and key, then requires a valid code before showing recovery codes", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { secret: "JBSWY3DPEHPK3PXP", qrDataUrl: "data:image/png;base64,AAAA" }))
      .mockResolvedValueOnce(json(400, { error: "That code didn't match." }))
      .mockResolvedValueOnce(json(200, { recoveryCodes: CODES }));
    render(<TwoFactorCard status={OFF} />);

    fireEvent.click(screen.getByRole("button", { name: "Enable two-factor authentication" }));
    const qr = await screen.findByRole("img", { name: "QR code for your authenticator app" });
    expect(qr).toHaveAttribute("src", "data:image/png;base64,AAAA");
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/account/two-factor/setup");

    // Not a 6-digit code: caught client-side, no request.
    fireEvent.change(screen.getByLabelText("6-digit code"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and enable" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/6-digit code/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Server rejects a wrong code: still on the setup step.
    fireEvent.change(screen.getByLabelText("6-digit code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and enable" }));
    expect(await screen.findByText("That code didn't match.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Recovery codes" })).not.toBeInTheDocument();

    // Valid code: recovery codes shown once.
    fireEvent.change(screen.getByLabelText("6-digit code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and enable" }));
    const list = await screen.findByRole("list", { name: "Recovery codes" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(CODES);
    expect(fetchMock.mock.calls[2][0]).toBe("/api/account/two-factor/enable");
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ code: "123456" });

    fireEvent.click(screen.getByRole("button", { name: "I've saved these codes" }));
    expect(screen.queryByRole("list", { name: "Recovery codes" })).not.toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(refreshMock).toHaveBeenCalled();
  });

  test("with the server key missing, explains why and offers no Enable button", () => {
    render(<TwoFactorCard status={{ ...OFF, configError: "Two-factor authentication isn't available yet." }} />);
    expect(screen.getByText("Two-factor authentication isn't available yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable two-factor authentication" })).not.toBeInTheDocument();
  });
});

describe("TwoFactorCard — disable", () => {
  test("shows status and remaining recovery codes", () => {
    render(<TwoFactorCard status={ON} />);
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.getByText("7 of 10 recovery codes left.")).toBeInTheDocument();
  });

  test("requires the password — none entered means no request", async () => {
    render(<TwoFactorCard status={ON} />);
    fireEvent.click(screen.getByRole("button", { name: "Disable two-factor authentication" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Enter your password/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("sends the password and turns off on success", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));
    render(<TwoFactorCard status={ON} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Disable two-factor authentication" }));

    expect(await screen.findByText("Two-factor authentication is off.")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/account/two-factor/disable");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ password: "correct-password" });
    expect(screen.getByRole("button", { name: "Enable two-factor authentication" })).toBeInTheDocument();
  });

  test("a wrong password keeps 2FA on", async () => {
    fetchMock.mockResolvedValue(json(403, { error: "Password is incorrect." }));
    render(<TwoFactorCard status={ON} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Disable two-factor authentication" }));

    expect(await screen.findByText("Password is incorrect.")).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
  });
});
