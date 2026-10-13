import { describe, it, expect } from "vitest";
import { isDefiniteSubmitFailure } from "../submit-outcome";

const withStatus = (status: number) => Object.assign(new Error("x"), { status });

describe("isDefiniteSubmitFailure(登録されていないと言い切れる失敗か)", () => {
  it("4xx の応答=サーバーが受け付けなかった=言い切れる", () => {
    expect(isDefiniteSubmitFailure(withStatus(400))).toBe(true);
    expect(isDefiniteSubmitFailure(withStatus(422))).toBe(true);
    expect(isDefiniteSubmitFailure(withStatus(409))).toBe(true);
  });
  it("5xx は保存の後に落ちたかもしれない=言い切れない", () => {
    expect(isDefiniteSubmitFailure(withStatus(500))).toBe(false);
    expect(isDefiniteSubmitFailure(withStatus(502))).toBe(false);
  });
  it("通信が切れた・応答が読めない(status なし)=言い切れない", () => {
    expect(isDefiniteSubmitFailure(new TypeError("Failed to fetch"))).toBe(false);
    expect(isDefiniteSubmitFailure(new Error("Unexpected end of JSON input"))).toBe(false);
    expect(isDefiniteSubmitFailure("x")).toBe(false);
  });
});
