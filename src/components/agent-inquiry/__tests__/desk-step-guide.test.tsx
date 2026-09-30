import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeskStepGuideView, DESK_GUIDE_STORAGE_KEY } from "../desk-step-guide";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("次に押す所の案内", () => {
  it("今の手順の吹き出しと「案内を消す」", () => {
    const html = renderToStaticMarkup(<DeskStepGuideView step="property" off={false} onToggle={vi.fn()} />);
    expect(html).toContain("次に物件を選びます");
    expect(html).toContain("案内を消す");
  });
  it("消しているときは「案内を出す」だけ", () => {
    const html = renderToStaticMarkup(<DeskStepGuideView step="property" off onToggle={vi.fn()} />);
    expect(html).not.toContain("次に物件を選びます");
    expect(html).toContain("案内を出す");
  });
  it("消す設定は端末ごと(localStorage・読み書きは try/catch)", () => {
    expect(DESK_GUIDE_STORAGE_KEY).toBe("pm-agent-desk-guide-off");
    const src = read("src/components/agent-inquiry/desk-step-guide.tsx");
    expect(src).toMatch(/try\s*\{[\s\S]*?localStorage\.getItem/);
    expect(src).toMatch(/try\s*\{[\s\S]*?localStorage\.setItem/);
  });
});
