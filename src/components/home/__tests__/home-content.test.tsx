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
  it("管理者: システム管理・DMメニューカードが出る", () => {
    // メニュー再編(2026-08-24): 「売却DM(設定へ直行)」を「DMメニュー(入口)」へ。
    const html = renderToStaticMarkup(<HomeContent userRole="admin" />);
    expect(html).toContain("システム管理");
    expect(html).toContain("DMメニュー");
    expect(html).toContain("宛名・お手紙・記録"); // DMメニューカードの説明
  });

  it("事務にも DMメニューが出る(設定は管理者のまま)", () => {
    const html = renderToStaticMarkup(<HomeContent userRole="office_staff" />);
    expect(html).toContain("DMメニュー");
    expect(html).not.toContain("利用者・権限・ログ"); // システム管理カードの説明
  });
});
