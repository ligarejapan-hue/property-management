/**
 * 謄本の名前は「1本の決まりごと」からしか作らない、を再発防止として固定する。
 *
 * 背景: 同じ1件の謄本が、画面ごとに違う名前で出ていた（添付タブ=謄本(所有者事項).pdf /
 * 添付ファイル検索=registry-auto-<受付番号>.pdf / ゴミ箱=registry.pdf / 保存名=registry.pdf）。
 * 原因は「名前の作り方」が4か所に別々に書かれていたこと。集約したあとで誰かが
 * また手書きの名前を足したら、ここで**ファイル名を名指しして**落とす。
 *
 * ⚠この走査が見るのは以下だけ（それ以上は主張しない）:
 *   (1) 対象4ファイルが共通モジュールを import していること
 *   (2) 対象4ファイルのソースに「謄本(」で始まる手書きラベルが無いこと
 *   (3) 対象4ファイルのソースに "registry.pdf" という直書きの名前が無いこと
 * 名前の中身が正しいかは registry-display-name.test.ts（純関数の総当たり）が担当する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const read = (p: string) =>
  fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

const MODULE_SPECIFIER = "@/lib/attachments/registry-display-name";

/** 謄本の名前を画面/ヘッダに出す場所。ここに足したら import も必須になる。 */
const CONSUMERS: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: "src/components/properties/attachment-tab.tsx",
    why: "物件詳細の添付タブ（表示名・download 属性）",
  },
  {
    file: "src/app/(dashboard)/admin/attachments/page.tsx",
    why: "添付ファイル検索の一覧（自動取得分のみ揃える）",
  },
  {
    file: "src/app/api/attachments/trash/route.ts",
    why: "ゴミ箱（返す fileName を伏せる）",
  },
  {
    file: "src/app/uploads/[...path]/route.ts",
    why: "配信の Content-Disposition（手元に落ちる保存名を決めるのはここ）",
  },
];

describe("謄本の名前は共通モジュールからしか作らない", () => {
  it.each(CONSUMERS)("$file は共通モジュールを import する（$why）", ({ file }) => {
    expect(read(file)).toContain(MODULE_SPECIFIER);
  });

  it.each(CONSUMERS)("$file に手書きの謄本ラベルを残さない", ({ file }) => {
    // 「謄本(所有者事項)」「謄本(全部事項)」のような手書きラベルの再発を防ぐ。
    expect(read(file)).not.toContain("謄本(");
  });

  it.each(CONSUMERS)('$file に "registry.pdf" を直書きしない', ({ file }) => {
    expect(read(file)).not.toContain("registry.pdf");
  });

  it("共通モジュール側には、名前の材料と組み立てが揃っている", () => {
    const src = read("src/lib/attachments/registry-display-name.ts");
    expect(src).toContain("export function registryDisplayName");
    expect(src).toContain("export function registryContentDisposition");
    expect(src).toContain("export function isAutoFetchedRegistry");
    expect(src).toContain("export const REGISTRY_STORED_FILE_NAME");
    expect(src).toContain("Asia/Tokyo");
  });

  it("取得プロバイダは保存名を共通の定数から取る（経路ごとに作らない）", () => {
    const src = read("src/lib/registry-fetch/official-provider.ts");
    expect(src).toContain("REGISTRY_STORED_FILE_NAME");
    // 受付番号入りの経路別ファイル名を作らない。
    expect(src).not.toMatch(/registry-(auto|recovered)-\$\{/);
  });
});
