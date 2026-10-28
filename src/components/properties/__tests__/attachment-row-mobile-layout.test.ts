/**
 * 添付の行(スマホ幅)。右の3つのアイコンに場所を取られて「種類:」欄が約90pxになり、
 * 長い種類名が切れていた(実機確認 2026-10-28・247)。スマホ幅ではアイコンを下の段の右へ回し、
 * 文字の部分を行いっぱいに使う。PC 幅(sm 以上)は1行のまま。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(process.cwd(), "src/components/properties/attachment-tab.tsx"), "utf8").replace(/\r\n/g, "\n");
const row = src.slice(src.indexOf("function AttachmentRow("), src.indexOf("// プレビュー用モーダル"));

describe("添付の行のスマホ幅の並び", () => {
  it("行は折り返せて、PC 幅では1行のまま", () => {
    expect(row).toMatch(/className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:flex-nowrap /);
  });

  it("文字の部分はスマホ幅で行いっぱい(アイコンの列を除く)", () => {
    expect(row).toMatch(/<div className="min-w-0 flex-1 basis-\[calc\(100%-2rem\)\] sm:basis-0">/);
  });

  it("3つのアイコンは1つのまとまりで、下の段の右に寄る", () => {
    const at = row.indexOf('data-testid="attachment-row-actions"');
    expect(at).toBeGreaterThan(-1);
    const group = row.slice(at, row.indexOf("</div>", at));
    expect(row.slice(at, row.indexOf(">", at))).toContain("ml-auto flex shrink-0 items-center");
    expect(group).toContain('title="プレビュー"');
    expect(group).toContain('title="ダウンロード"');
    expect(group).toContain('title="削除"');
  });
});
