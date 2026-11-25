import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { KeyBoxInfo } from "../key-box-info";
import { UpcomingViewingsView } from "../upcoming-viewings";
import type { UpcomingViewing } from "@/lib/api-client";

describe("キーボックスの表示(2026-11-26 発注者)", () => {
  it("どちらも未入力(null・undefined・空白だけ)なら何も出さない", () => {
    expect(renderToStaticMarkup(<KeyBoxInfo location={null} code={null} />)).toBe("");
    expect(renderToStaticMarkup(<KeyBoxInfo />)).toBe("");
    expect(renderToStaticMarkup(<KeyBoxInfo location="  " code="" />)).toBe("");
  });

  it("設置場所と解除番号を出す", () => {
    const html = renderToStaticMarkup(<KeyBoxInfo location="玄関横のメーターボックス内" code="1234" />);
    expect(html).toContain('data-testid="key-box-info"');
    expect(html).toContain("キーボックス");
    expect(html).toContain("玄関横のメーターボックス内");
    expect(html).toContain("解除番号");
    expect(html).toContain("1234");
  });

  it("片方だけでも出す(無い方の言葉は出さない)", () => {
    const onlyCode = renderToStaticMarkup(<KeyBoxInfo code="0000" />);
    expect(onlyCode).toContain("解除番号");
    expect(onlyCode).toContain("0000");
    const onlyLoc = renderToStaticMarkup(<KeyBoxInfo location="門扉の内側" />);
    expect(onlyLoc).toContain("門扉の内側");
    expect(onlyLoc).not.toContain("解除番号");
  });

  it("値は文字として出す(HTML として解釈しない)", () => {
    const html = renderToStaticMarkup(<KeyBoxInfo location={'<script>alert("x")</script>'} code="<b>9</b>" />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;9&lt;/b&gt;");
  });

  it("今日・明日の内見に物件のキーボックスを出す", () => {
    const v: UpcomingViewing = {
      id: "v1", scheduledAt: "2026-11-26T01:00:00.000Z", viewingType: "guided", version: 1, attendant: null,
      inquiry: {
        id: "i1", contactName: null, agent: { companyName: "架空不動産", branchName: null },
        property: {
          id: "p1", name: "架空ハイツ", roomNo: "101", town: "架空市本町", propertyType: "apartment_unit", adPermissions: {},
          keyBoxLocation: "集合ポスト下", keyBoxCode: "5678",
        },
      },
    };
    const html = renderToStaticMarkup(<UpcomingViewingsView viewings={[v]} />);
    expect(html).toContain("集合ポスト下");
    expect(html).toContain("5678");
  });

  it("受付の窓の登録フォーム・反響の詳細・物件の反響タブがこの部品を使う", () => {
    const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), "utf8");
    for (const rel of ["../inquiry-form.tsx", "../inquiry-detail.tsx", "../../properties/agent-inquiry-tab.tsx"]) {
      expect(read(rel)).toContain("<KeyBoxInfo");
    }
  });
});
