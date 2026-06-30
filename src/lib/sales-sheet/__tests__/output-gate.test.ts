import { describe, it, expect, vi, beforeEach } from "vitest";

// render-gate を spy 化し、output の render 関数がゲート(gate.run)経由で走ることを確認する。
const { runSpy } = vi.hoisted(() => ({ runSpy: vi.fn() }));

vi.mock("../render-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../render-gate")>();
  return {
    ...actual,
    createRenderGate: () => ({ run: runSpy, active: () => 0, queued: () => 0 }),
  };
});

// 実 chromium を起動しない最小スタブ。
vi.mock("playwright", () => ({
  chromium: {
    executablePath: () => "/fake/chromium",
    launch: async () => ({
      newPage: async () => ({
        route: async () => {},
        setContent: async () => {},
        pdf: async () => Buffer.from("PDF"),
      }),
      newContext: async () => ({
        newPage: async () => ({
          route: async () => {},
          setContent: async () => {},
          locator: () => ({ count: async () => 0 }),
          screenshot: async () => Buffer.from("PNG"),
        }),
        close: async () => {},
      }),
      close: async () => {},
    }),
  },
}));

import { renderHtmlToPdf, renderHtmlToImage } from "../output";

beforeEach(() => {
  runSpy.mockReset();
  runSpy.mockImplementation((fn: () => unknown) => fn());
});

describe("output.ts: PDF/PNG 出力は同時実行ゲート(gate.run)経由で実行される", () => {
  it("renderHtmlToPdf は gate.run を通る", async () => {
    const buf = await renderHtmlToPdf("<html></html>");
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(Buffer.from(buf).toString()).toBe("PDF");
  });

  it("renderHtmlToImage は gate.run を通る", async () => {
    const buf = await renderHtmlToImage("<html></html>");
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(Buffer.from(buf).toString()).toBe("PNG");
  });
});
