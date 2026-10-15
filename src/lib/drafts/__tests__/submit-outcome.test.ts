import { describe, it, expect } from "vitest";
import { hasFieldShape, hasImportResultShape, httpError, isDefiniteSubmitFailure } from "../submit-outcome";

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

describe("httpError", () => {
  it("status を持ち、4xx は登録されていないと言い切れる", () => {
    const e = httpError("住所を入力してください", 422);
    expect(e.message).toBe("住所を入力してください");
    expect(e.status).toBe(422);
    expect(isDefiniteSubmitFailure(e)).toBe(true);
  });
  it("5xx は言い切れない", () => {
    expect(isDefiniteSubmitFailure(httpError("x", 500))).toBe(false);
  });
});

describe("hasImportResultShape(成功の返事が取り込みの結果の形か・@codex P2)", () => {
  const shape = { numbers: ["successCount", "errorCount"], arrays: ["parseErrors"], objects: ["summary"] } as const;
  const ok = { jobId: "ij-1", successCount: 1, errorCount: 0, parseErrors: [], summary: {} };
  it("取り込みの番号と決まった欄がそろっていれば結果として扱う", () => {
    expect(hasImportResultShape(ok, shape)).toBe(true);
    expect(hasImportResultShape({ jobId: "ij-1" }, {})).toBe(true);
  });
  it("空の返事・番号なし・空の番号は分からない扱い", () => {
    expect(hasImportResultShape({}, shape)).toBe(false);
    expect(hasImportResultShape(null, {})).toBe(false);
    expect(hasImportResultShape(undefined, {})).toBe(false);
    expect(hasImportResultShape("ok", {})).toBe(false);
    expect(hasImportResultShape({ ...ok, jobId: "" }, shape)).toBe(false);
    expect(hasImportResultShape({ ...ok, jobId: 1 }, shape)).toBe(false);
  });
  it("数の欄が数でない・配列が配列でない・まとまりが無いときも分からない扱い", () => {
    expect(hasImportResultShape({ ...ok, successCount: "1" }, shape)).toBe(false);
    expect(hasImportResultShape({ ...ok, errorCount: undefined }, shape)).toBe(false);
    expect(hasImportResultShape({ ...ok, parseErrors: null }, shape)).toBe(false);
    expect(hasImportResultShape({ ...ok, summary: null }, shape)).toBe(false);
    expect(hasImportResultShape({ ...ok, summary: [] }, shape)).toBe(false);
  });
});

describe("hasFieldShape(入れ子の中身・@codex P2)", () => {
  const shape = { numbers: ["confidence"], arrays: ["owners", "warnings"] } as const;
  it("決まった欄がそろえば true(番号は問わない)", () => {
    expect(hasFieldShape({ confidence: 0.9, owners: [], warnings: [] }, shape)).toBe(true);
  });
  it("空のまとまり・配列・null は false", () => {
    expect(hasFieldShape({}, shape)).toBe(false);
    expect(hasFieldShape([], {})).toBe(false);
    expect(hasFieldShape(null, {})).toBe(false);
    expect(hasFieldShape({ confidence: 0.9, owners: [], warnings: null }, shape)).toBe(false);
  });
});
