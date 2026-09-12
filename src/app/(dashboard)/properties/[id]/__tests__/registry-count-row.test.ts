/**
 * 物件基本情報の「謄本 ○件」行の配線テスト。
 * vitest は env=node(jsdom なし)のため、リポ慣行に従いソース文字列で検証する。
 * ⚠改行を LF に正規化してから比較する(手元 CRLF と CI で判定が変わる)。
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";

const src = readFileSync(resolve(__dirname, "../page.tsx"), "utf-8").replace(
  /\r\n/g,
  "\n",
);
const api = readFileSync(
  resolve(__dirname, "../../../../../lib/api-client.ts"),
  "utf-8",
).replace(/\r\n/g, "\n");

describe("物件基本情報の謄本行", () => {
  it("ApiProperty 型に registryAttachmentCounts がある(null=権限なし)", () => {
    expect(src).toMatch(
      /registryAttachmentCounts:\s*\{\s*owner:\s*number;\s*all:\s*number;\s*other:\s*number;?\s*\}\s*\|\s*null/,
    );
  });

  it("PropertyDetailResult(api-client)にも registryAttachmentCounts を載せる", () => {
    expect(api).toContain("registryAttachmentCounts");
  });

  it("謄本を見る権限が無い(null/未取得)ときは行自体を出さない", () => {
    // counts が null または undefined(mockモード)のとき行を描かない。
    // `!= null`(緩い等価)で null と undefined の両方を弾く(mockモードのクラッシュ回避)。
    expect(src).toMatch(/property\.registryAttachmentCounts\s*!=\s*null/);
  });

  it("件数(所有者事項/全部事項)を出し、ファイル名は出さない", () => {
    expect(src).toContain("所有者事項");
    expect(src).toContain("全部事項");
    // 件数の各フィールドを実際に読んでいる(件数が飾りでない)。
    expect(src).toContain("counts.owner");
    expect(src).toContain("counts.all");
    // 謄本行の描画部にファイル名/URLを持ち込んでいない。
    const field = src.slice(
      src.indexOf("function RegistryCountField"),
      src.indexOf("function OwnerField"),
    );
    expect(field.length).toBeGreaterThan(0);
    expect(field).not.toContain("fileName");
    expect(field).not.toContain("fileUrl");
  });

  it("「添付を見る」で添付タブへ切り替える(別ページに飛ばさない)", () => {
    expect(src).toContain("添付を見る");
    // BasicTab に添付タブへ切り替えるコールバックを渡す。
    expect(src).toMatch(/onOpenAttachments\s*=\s*\{\s*\(\)\s*=>\s*setActiveTab\("attachments"\)\s*\}/);
    // BasicTab はそのコールバックを受け取る。
    expect(src).toMatch(/onOpenAttachments/);
  });
});
