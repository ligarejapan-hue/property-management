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
const attachmentTab = readFileSync(
  resolve(__dirname, "../../../../../components/properties/attachment-tab.tsx"),
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

  it("謄本の追加/削除後に親を再取得して件数を更新する(@codex #429 P2)", () => {
    // 添付タブは謄本を増減しても自分の一覧しか更新しない=基本情報の件数が古いまま。
    // 親から「静かな再取得」を渡し、謄本の増減時だけ呼び戻す。fetchProperty(全体再読込で
    // ページをアンマウント・一時失敗でエラー差替)ではなく refreshPropertyQuietly を使う(@codex #429 P2)。
    expect(src).toMatch(/<AttachmentTab[\s\S]{0,500}onRegistryMutated=\{refreshPropertyQuietly\}/);
    expect(src).not.toMatch(/onRegistryMutated=\{fetchProperty\}/);
    // 添付タブ側: prop を受け取り、謄本の upload/delete 成功時に呼ぶ。
    expect(attachmentTab).toContain("onRegistryMutated");
    // 謄本アップロード成功後に通知(type==="registry" のときだけ)。
    expect(attachmentTab).toMatch(/type === "registry"[\s\S]{0,40}onRegistryMutated/);
    // 謄本削除の成功時にも通知(削除対象が registry だったときだけ)。
    const del = attachmentTab.match(/const handleDelete[\s\S]*?\n {2}\};/);
    expect(del).not.toBeNull();
    expect(del![0]).toContain("onRegistryMutated");
  });
});
