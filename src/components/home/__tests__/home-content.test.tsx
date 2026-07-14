import { vi, describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// next/link → plain <a>(node 環境で renderToStaticMarkup が動くように・router 無し。
// 既存 sales-sheet-list.test.tsx と同方針)。
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) =>
    createElement("a", { href }, children as never),
}));

import { HomeContent } from "../HomeContent";

describe("HomeContent", () => {
  it("現場: 現地調査マップの大カードが出て、物件/販売図面カードは出ない", () => {
    const html = renderToStaticMarkup(<HomeContent userRole="field_staff" />);
    expect(html).toContain("現地調査マップ");
    expect(html).toContain("今日の巡回はここから");
    // 「物件化の完成待ち」と部分一致しないよう、office+ カードは説明文で判定する。
    expect(html).not.toContain("物件一覧・マンション棟"); // 物件カード(office+)の説明
    expect(html).not.toContain("マイソクを作る"); // 販売図面カード(office+)の説明
  });
  it("管理者: システム管理・売却DMカードが出る", () => {
    const html = renderToStaticMarkup(<HomeContent userRole="admin" />);
    expect(html).toContain("システム管理");
    expect(html).toContain("売却DMの設定"); // 売却DMカードの説明
  });
});
