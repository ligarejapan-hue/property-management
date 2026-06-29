import { describe, it, expect } from "vitest";
import { buildCreateRequest } from "../SaleLandSheetButton";

describe("buildCreateRequest", () => {
  it("POSTs the override values as JSON to the sales-sheets/new endpoint", () => {
    const { url, init } = buildCreateRequest("prop-1", {
      price: "3,480万円",
      access: "東急田園都市線「駒沢大学」駅 徒歩8分",
    });
    expect(url).toBe("/api/properties/prop-1/sales-sheets/new");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      price: "3,480万円",
      access: "東急田園都市線「駒沢大学」駅 徒歩8分",
    });
  });

  it("serializes an empty form as an empty object body", () => {
    const { init } = buildCreateRequest("p2", {});
    expect(JSON.parse(init.body as string)).toEqual({});
  });
});
