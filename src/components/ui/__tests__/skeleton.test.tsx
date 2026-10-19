/**
 * 読み込み中の形(UIの統一 第2回・設計書 §3)。くるくるだけの画面を減らし、何が出るかを先に見せる。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Skeleton, SkeletonRows } from "../skeleton";

describe("Skeleton", () => {
  it("灰色の帯・光がゆっくり流れる・reduced-motion では止める・読み上げない", () => {
    const html = renderToStaticMarkup(<Skeleton className="h-3 w-1/2" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("animate-pm-shimmer");
    expect(html).toContain("motion-reduce:animate-none");
    expect(html).toContain("h-3 w-1/2");
  });

  it("SkeletonRows: role=status で「読み込み中」を読み上げる・行数ぶん帯を出す", () => {
    const html = renderToStaticMarkup(<SkeletonRows rows={4} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('<span class="sr-only">読み込み中</span>');
    expect((html.match(/animate-pm-shimmer/g) ?? []).length).toBe(4);
  });

  it("label を差し替えられる", () => {
    expect(renderToStaticMarkup(<SkeletonRows label="物件を読み込み中" />)).toContain("物件を読み込み中");
  });
});

describe("物件一覧・物件詳細の初回読み込み", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("一覧(表とスマホのカード)はくるくるではなく形を出す", () => {
    const src = read("src/app/(dashboard)/properties/page.tsx");
    expect((src.match(/<SkeletonRows /g) ?? []).length).toBe(2);
  });
  it("詳細も形を出す", () => {
    const src = read("src/app/(dashboard)/properties/[id]/page.tsx");
    expect(src).toContain("<SkeletonRows ");
  });
});
