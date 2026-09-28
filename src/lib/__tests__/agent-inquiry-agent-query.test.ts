import { describe, it, expect } from "vitest";
import { classifyAgentQuery } from "@/lib/agent-inquiry/agent-query";

describe("業者検索語の振り分け(設計 §2.2-1)", () => {
  it.each([
    ["0312345", { type: "digits", digits: "0312345" }],
    ["03-1234-5", { type: "digits", digits: "0312345" }],
    ["０９０－１２３４－５", { type: "digits", digits: "09012345" }],
    ["090 1234 5678", { type: "digits", digits: "09012345678" }],
  ])("数字7桁以上 → 数字照合 %s", (q, want) => {
    expect(classifyAgentQuery(q)).toEqual(want);
  });
  it.each([
    ["031234", { type: "text", text: "031234" }],
    ["○○不動産", { type: "text", text: "○○不動産" }],
    ["  新宿  ", { type: "text", text: "新宿" }],
    ["不動産03", { type: "text", text: "不動産03" }],
  ])("それ以外 → 文字検索 %s", (q, want) => {
    expect(classifyAgentQuery(q)).toEqual(want);
  });
  it.each(["", " ", "あ"])("1文字以下は検索しない %j", (q) => {
    expect(classifyAgentQuery(q)).toEqual({ type: "none" });
  });
});
