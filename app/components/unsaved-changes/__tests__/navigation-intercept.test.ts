import { describe, expect, test } from "vitest";
import { interceptedDestination, unsavedChangesMessage, type LinkClick } from "../navigation-intercept";

function click(overrides: Partial<LinkClick> = {}): LinkClick {
  return {
    href: "http://localhost:3000/listings",
    target: "",
    download: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    currentHref: "http://localhost:3000/listings/bulk?ids=1,2",
    ...overrides,
  };
}

describe("interceptedDestination", () => {
  test("holds a plain click to another page of the app", () => {
    expect(interceptedDestination(click())).toBe("/listings");
    expect(interceptedDestination(click({ href: "http://localhost:3000/mockups?mode=new#top" }))).toBe(
      "/mockups?mode=new#top",
    );
  });

  test("lets new-tab, modified and non-primary clicks through", () => {
    expect(interceptedDestination(click({ target: "_blank" }))).toBeNull();
    expect(interceptedDestination(click({ metaKey: true }))).toBeNull();
    expect(interceptedDestination(click({ ctrlKey: true }))).toBeNull();
    expect(interceptedDestination(click({ shiftKey: true }))).toBeNull();
    expect(interceptedDestination(click({ button: 1 }))).toBeNull();
    expect(interceptedDestination(click({ download: true }))).toBeNull();
  });

  test("lets other sites and same-page hash links through", () => {
    expect(interceptedDestination(click({ href: "https://www.etsy.com/listing/1" }))).toBeNull();
    expect(
      interceptedDestination(click({ href: "http://localhost:3000/listings/bulk?ids=1,2#row-1" })),
    ).toBeNull();
  });
});

test("names how many listings have unsaved changes", () => {
  expect(unsavedChangesMessage(1)).toMatch(/^1 listing has unsaved changes/);
  expect(unsavedChangesMessage(3)).toMatch(/^3 listings have unsaved changes/);
});
