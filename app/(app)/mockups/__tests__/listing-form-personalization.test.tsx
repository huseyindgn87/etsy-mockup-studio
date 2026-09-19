// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EMPTY_PERSONALIZATION_QUESTION } from "@/lib/etsy/listing-personalization";
import ListingForm, { EMPTY_LISTING_FORM, type ListingFormValue } from "../ListingForm";

let current: ListingFormValue;

function Harness({ initial }: { initial: ListingFormValue }) {
  const [value, setValue] = useState(initial);
  return (
    <ListingForm
      value={value}
      onChange={(next) => {
        current = next;
        setValue(next);
      }}
    />
  );
}

const toggle = () => screen.getByRole("switch", { name: "Personalization" });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});
afterEach(() => vi.unstubAllGlobals());

describe("personalization switch", () => {
  test("starts off with no question fields for a non-personalized listing", () => {
    render(<Harness initial={EMPTY_LISTING_FORM} />);
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText("Choose field type")).toBeNull();
  });

  test("starts on for a listing that has a question", () => {
    const q = { ...EMPTY_PERSONALIZATION_QUESTION, questionText: "Name" };
    render(<Harness initial={{ ...EMPTY_LISTING_FORM, personalizationQuestions: [q] }} />);
    expect(toggle()).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Choose field type")).toBeInTheDocument();
  });

  test("turning it off clears every question so none is sent", () => {
    const q = { ...EMPTY_PERSONALIZATION_QUESTION, questionText: "Name" };
    render(<Harness initial={{ ...EMPTY_LISTING_FORM, personalizationQuestions: [q, q] }} />);
    fireEvent.click(toggle());
    expect(current.personalizationQuestions).toEqual([]);
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText("Choose field type")).toBeNull();
  });

  test("turning it on shows the first question slot", () => {
    render(<Harness initial={EMPTY_LISTING_FORM} />);
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Choose field type")).toBeInTheDocument();
  });
});
