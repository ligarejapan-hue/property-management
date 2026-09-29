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

import { agentQueryReady } from "@/lib/agent-inquiry/agent-query";

describe("画面で「探した」とみなすのは、サーバーが本当に探せる語だけ(@codex #459 R22)", () => {
  it("数字と区切りだけの語は7桁から(打ちかけの電話番号で0件にして登録を出さない)", () => {
    expect(agentQueryReady("03")).toBe(false);
    expect(agentQueryReady("03-123")).toBe(false);
    expect(agentQueryReady("０９０１２３")).toBe(false);
    expect(agentQueryReady("0312345")).toBe(true);
    expect(agentQueryReady("090-1234-5678")).toBe(true);
  });
  it("文字は2文字から", () => {
    expect(agentQueryReady("中")).toBe(false);
    expect(agentQueryReady("中野")).toBe(true);
    expect(agentQueryReady("A1")).toBe(true);
    expect(agentQueryReady("  ")).toBe(false);
  });
});
