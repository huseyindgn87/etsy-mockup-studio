// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { refreshMock, signOutMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  signOutMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));
vi.mock("next-auth/react", () => ({ signOut: signOutMock }));

import SettingsForm, { type EtsyConnectionStatus, type SettingsUser } from "../SettingsForm";
import type { TwoFactorStatus } from "../TwoFactorCard";

const TWO_FACTOR_OFF: TwoFactorStatus = { enabled: false, remainingRecoveryCodes: 0, configError: null };

const USER: SettingsUser = { email: "seller@example.com", firstName: null, lastName: null, theme: "light" };
const NOT_CONNECTED: EtsyConnectionStatus = { connected: false, shopName: null, configError: null };
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

beforeEach(() => {
  refreshMock.mockReset();
  signOutMock.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

describe("SettingsForm — appearance", () => {
  test("offers exactly Light and Dark", () => {
    render(<SettingsForm user={USER} etsy={NOT_CONNECTED} twoFactor={TWO_FACTOR_OFF} />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.closest("label")?.textContent)).toEqual(["Light", "Dark"]);
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
    expect(screen.queryByText(/system/i)).not.toBeInTheDocument();
  });

  test("saving Dark PATCHes it to the account, applies it, and refreshes the server layout", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { profile: { theme: "dark" } }));
    render(<SettingsForm user={USER} etsy={NOT_CONNECTED} twoFactor={TWO_FACTOR_OFF} />);

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    save();

    await screen.findByText("Dark theme saved.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/account/profile");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toMatchObject({ theme: "dark" });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(refreshMock).toHaveBeenCalled();
  });

  test("a failed save doesn't apply the theme", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: "Boom." }));
    render(<SettingsForm user={USER} etsy={NOT_CONNECTED} twoFactor={TWO_FACTOR_OFF} />);

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    save();

    await screen.findByText("Boom.");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe("SettingsForm — email", () => {
  test("changing the email without the current password shows an error and never calls the API", async () => {
    render(<SettingsForm user={USER} etsy={NOT_CONNECTED} twoFactor={TWO_FACTOR_OFF} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "new@example.com" } });
    expect(screen.getByLabelText("Current password", { selector: "#emailCurrentPassword" })).toBeInTheDocument();

    save();

    expect(
      await screen.findByText("Enter your current password to change your email."),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("sends the current password along with the new email", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { email: "new@example.com" }));
    render(<SettingsForm user={USER} etsy={NOT_CONNECTED} twoFactor={TWO_FACTOR_OFF} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Current password", { selector: "#emailCurrentPassword" }), {
      target: { value: "correct-password" },
    });

    save();

    await screen.findByText("Email updated.");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/account/email");
    expect(JSON.parse(init.body)).toEqual({ newEmail: "new@example.com", currentPassword: "correct-password" });
  });

  test("shows the server's wrong-password error", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "Current password is incorrect." }));
    render(<SettingsForm user={USER} etsy={NOT_CONNECTED} twoFactor={TWO_FACTOR_OFF} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Current password", { selector: "#emailCurrentPassword" }), {
      target: { value: "nope" },
    });

    save();
    expect(await screen.findByText("Current password is incorrect.")).toBeInTheDocument();
  });
});

describe("SettingsForm — password", () => {
  test("every password field has a show/hide toggle", () => {
    render(<SettingsForm user={USER} etsy={NOT_CONNECTED} twoFactor={TWO_FACTOR_OFF} />);
    const passwordCard = screen.getByRole("region", { name: "Password" });
    expect(within(passwordCard).getAllByRole("button", { name: "Show password" })).toHaveLength(3);
  });

  test("mismatched confirmation is caught before any request", async () => {
    render(<SettingsForm user={USER} etsy={NOT_CONNECTED} twoFactor={TWO_FACTOR_OFF} />);
    fireEvent.change(screen.getByLabelText("Current password", { selector: "#currentPassword" }), {
      target: { value: "correct-password" },
    });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "long-enough-1" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "long-enough-2" } });

    save();
    expect(await screen.findByText("New passwords don't match.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("SettingsForm — Etsy connection and log out", () => {
  test("connected: shop name, green Connected, red Disconnect posting back to /settings", () => {
    render(
      <SettingsForm user={USER} etsy={{ connected: true, shopName: "GHCollectiveUS", configError: null }}
        twoFactor={TWO_FACTOR_OFF}
      />,
    );
    const card = screen.getByRole("region", { name: "Etsy connection" });
    expect(within(card).getByText("GHCollectiveUS")).toBeInTheDocument();
    expect(within(card).getByText("Connected")).toHaveClass("text-green-700");

    const disconnect = within(card).getByRole("button", { name: "Disconnect" });
    expect(disconnect).toHaveClass("text-red-700");
    const form = disconnect.closest("form")!;
    expect(form).toHaveAttribute("action", "/api/auth/etsy/logout");
    expect(form.querySelector("input[name=returnTo]")).toHaveValue("/settings");
  });

  test("not connected: no Disconnect, a Connect link instead", () => {
    render(<SettingsForm user={USER} etsy={NOT_CONNECTED} twoFactor={TWO_FACTOR_OFF} />);
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect Etsy shop" })).toHaveAttribute("href", "/api/auth/etsy/login");
  });

  test("Log out signs out in a single click", () => {
    render(<SettingsForm user={USER} etsy={NOT_CONNECTED} twoFactor={TWO_FACTOR_OFF} />);
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledWith({ redirect: true, callbackUrl: "/login" });
  });

  test("with nothing changed, Save makes no requests", async () => {
    render(<SettingsForm user={USER} etsy={NOT_CONNECTED} twoFactor={TWO_FACTOR_OFF} />);
    save();
    expect(await screen.findByText("No changes to save.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
