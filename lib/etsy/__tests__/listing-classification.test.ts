import { describe, expect, test } from "vitest";
import { howItsMadeError } from "@/lib/etsy/listing-classification";

describe("howItsMadeError", () => {
  test("allows 'Another company or person' + finished product + made-to-order + production partner (POD sellers)", () => {
    const input = {
      whoMade: "someone_else" as const,
      isSupply: false,
      whenMade: "made_to_order",
      productionPartnerIds: [123], // production partner (e.g., print shop) selected
    };

    const error = howItsMadeError(input);
    expect(error).toBeNull();
  });

  test("rejects 'Another company or person' without a production partner", () => {
    const input = {
      whoMade: "someone_else" as const,
      isSupply: false,
      whenMade: "made_to_order",
      productionPartnerIds: [],
    };

    const error = howItsMadeError(input);
    expect(error).toContain("Select at least one production partner");
  });

  test("allows 'Another company or person' + supply + made-to-order + production partner", () => {
    const input = {
      whoMade: "someone_else" as const,
      isSupply: true,
      whenMade: "made_to_order",
      productionPartnerIds: [456],
    };

    const error = howItsMadeError(input);
    expect(error).toBeNull();
  });

  test("allows 'Another company or person' + finished product + vintage year + production partner", () => {
    const input = {
      whoMade: "someone_else" as const,
      isSupply: false,
      whenMade: "2010_2019",
      productionPartnerIds: [789],
    };

    const error = howItsMadeError(input);
    expect(error).toBeNull();
  });

  test("allows 'I did' without production partner", () => {
    const input = {
      whoMade: "i_did" as const,
      isSupply: false,
      whenMade: "made_to_order",
      productionPartnerIds: [],
    };

    const error = howItsMadeError(input);
    expect(error).toBeNull();
  });

  test("allows 'A member of my shop' without production partner", () => {
    const input = {
      whoMade: "collective" as const,
      isSupply: false,
      whenMade: "made_to_order",
      productionPartnerIds: [],
    };

    const error = howItsMadeError(input);
    expect(error).toBeNull();
  });
});
