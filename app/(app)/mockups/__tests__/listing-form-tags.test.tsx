// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});
afterEach(() => vi.unstubAllGlobals());

describe("tags Delete all", () => {
  test("clears every tag", () => {
    render(<Harness initial={{ ...EMPTY_LISTING_FORM, tags: ["one", "two", "three"] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
    expect(current.tags).toEqual([]);
    expect(screen.queryByRole("button", { name: "Delete all" })).toBeNull();
  });

  test("is hidden when there are no tags", () => {
    render(<Harness initial={EMPTY_LISTING_FORM} />);
    expect(screen.queryByRole("button", { name: "Delete all" })).toBeNull();
  });
});
