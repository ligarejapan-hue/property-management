/**
 * Excel まとめ取込の画面。vitest は env=node なので、表示専用部品は SSR で、
 * 画面の約束(保護の印・保存経路)はソースで確かめる。
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildPasteDraft } from "@/lib/paste-import/build-draft";
import { ExcelLeadTable, type ExcelLeadRow } from "@/components/import/excel-lead-table";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/import/paste/excel",
  useSearchParams: () => new URLSearchParams(),
}));

import ExcelLeadImportPage from "../page";

const dir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(dir, "../page.tsx"), "utf8").replace(/\r\n/g, "\n");

const mk = (over: Partial<ExcelLeadRow>): ExcelLeadRow => {
  const text = "お名前：山田　太郎\n物件所在地：東京都港区1-1\n物件種別：戸建";
  return {
    sheetName: "HOME4U",
    rowNumber: 3,
    text,
    draft: buildPasteDraft(text),
    ownerNote: "Excel取込: HOME4U 3行目\n見込度: C",
    status: "ready",
    reasons: [],
    registeredPropertyId: null,
    ...over,
  };
};

describe("Excel まとめ取込の画面", () => {
  it("★画面の最上位に PII 保護の印が付いている", () => {
    const html = renderToStaticMarkup(createElement(ExcelLeadImportPage));
    expect(html.startsWith("<div data-pii-protected")).toBe(true);
  });

  it("★保存は既存の登録API(1行ずつ)だけを通る(別の保存経路を作らない)", () => {
    expect(source).toContain('fetch("/api/import/paste/commit"');
    expect(source).toContain("excelLeadCommitBody(row)");
    // 下見 API は読むだけ
    expect(source).toContain('fetch("/api/import/paste/excel"');
  });

  it("まとめて登録するのは「登録できる」行だけ", () => {
    expect(source).toMatch(/r\.status === "ready" && results\[excelLeadRowKey\(r\)\] === undefined/);
  });

  it("貼り付け画面からこの画面へ行ける", () => {
    const paste = readFileSync(join(dir, "../../page.tsx"), "utf8");
    expect(paste).toContain('href="/import/paste/excel"');
  });
});

describe("ExcelLeadTable", () => {
  it("状態ごとの表示: 登録できる / 要確認(理由つき) / 登録済み(物件へのリンク)", () => {
    const html = renderToStaticMarkup(createElement(ExcelLeadTable, {
      rows: [
        mk({}),
        mk({ rowNumber: 4, status: "review", reasons: ["同じ名前の所有者がすでにいます"] }),
        mk({ rowNumber: 5, status: "registered", registeredPropertyId: "p-9" }),
      ],
      results: {},
    }));
    expect(html).toContain("登録できる");
    expect(html).toContain("要確認");
    expect(html).toContain("同じ名前の所有者がすでにいます");
    expect(html).toContain('href="/properties/p-9"');
    expect(html).toContain("HOME4U 4行目");
  });

  it("要確認の行は、貼り付ける文章と所有者の備考に写すメモを見せる", () => {
    const html = renderToStaticMarkup(createElement(ExcelLeadTable, {
      rows: [mk({ status: "review", reasons: ["物件種別が分かりません"] })],
      results: {},
    }));
    expect(html).toContain("「貼り付けて物件化」で確かめて登録する");
    expect(html).toContain("お名前：山田　太郎");
    expect(html).toContain("見込度: C");
    expect(html).toContain('href="/import/paste"');
  });

  it("登録の結果を行に出す(成功は物件へのリンク・失敗は理由)", () => {
    const html = renderToStaticMarkup(createElement(ExcelLeadTable, {
      rows: [mk({}), mk({ rowNumber: 4 })],
      results: {
        "HOME4U#3": { kind: "created", propertyId: "new-1" },
        "HOME4U#4": { kind: "failed", message: "メールアドレスの形式が正しくありません" },
      },
    }));
    expect(html).toContain('href="/properties/new-1"');
    expect(html).toContain("登録しました");
    expect(html).toContain("メールアドレスの形式が正しくありません");
  });
});
