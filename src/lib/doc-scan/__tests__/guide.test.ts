import { describe, expect, it } from "vitest";
import { scanGuide } from "../guide";

describe("「紙の範囲」の説明", () => {
  it("見つけたとき", () => {
    expect(scanGuide(true, true, false)).toContain("自動で見つけました");
  });

  it("見つからなかったときは「見つけました」と言わない", () => {
    const s = scanGuide(false, true, false);
    expect(s).toContain("見つけられませんでした");
    expect(s).toContain("正面から見た形に直します");
  });

  it("部品が読めなかったときは、形を直さず長方形で切り取ると正直に言う", () => {
    const s = scanGuide(false, false, true);
    expect(s).toContain("長方形で切り取ります");
    expect(s).not.toContain("正面から見た形に直します");
  });

  it("部品の準備中", () => {
    expect(scanGuide(false, false, false)).toContain("準備をしています");
  });
});
